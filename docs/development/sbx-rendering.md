# SBX rendering and interaction flows

Tauren renders Pi data in its own UI rather than displaying Pi's terminal screen.
This document maps how conversation content, native session views and Pi extension
UI reach that UI, and how user actions return to Pi. It covers the sandbox adapter
and the existing host/browser rendering code that consumes `AgentClient`.

**The sandbox adapter is implemented, but users cannot select it through the
backend settings yet.** The sandbox-to-adapter paths below are exercised by tests.
The continuation from `AgentClient` through Tauren's session manager and webview
is the existing native rendering path, not a claim that sandbox selection is
already connected in the production UI. Kward-specific surfaces are outside this
Pi rendering map. Session discovery and some host-file
operations still need sandbox-specific integration, called out where relevant.

## Boundaries and notation

There are three execution locations, not two. The sandbox executes Pi and Pi
extensions. The VS Code extension host executes `SbxClient`, controllers and UI
hosts. The webview executes browser code that creates DOM elements. Only the
first boundary uses SSH JSON-RPC; the second uses VS Code webview messages.

```text
Sandbox: Pi SDK + extensions
       ⇄ Content-Length-framed JSON-RPC over SSH stdin/stdout
Host: SbxClient → Tauren controllers and extension UI hosts
       ⇄ webview.postMessage / vscode.postMessage
Browser: Tauren webview controllers → DOM
```

Method labels use `Class.method()` where the implementation belongs to a class.
A label prefixed `function` is a standalone function, and a label such as
`registerServer → chat.prompt handler` identifies a callback registered inside a
function rather than inventing a class method. `ctx.ui.*` is Pi's extension-facing
API. Arrow labels name wire messages, not local function calls.

### Source map

| Responsibility | Source |
|---|---|
| Sandbox RPC registration and SDK events | `sandbox-server/src/server.ts`: `registerServer()` |
| Sandbox runtime query/control handlers | `sandbox-server/src/runtimeControls.ts`: `registerRuntimeControls()` |
| Sandbox session handlers | `sandbox-server/src/sessionControls.ts`: `registerSessionControls()` |
| Sandbox extension UI context and components | `sandbox-server/src/extensionUi/remoteExtensionUi.ts`: `RemoteExtensionUi` |
| Host AgentClient implementation | `src/sbx/sbxClient.ts`: `SbxClient` |
| Host validation of RPC responses | `src/sbx/clientValidation.ts` |
| Host remote extension UI bridge | `src/extensionUi/sbxExtensionUi.ts`: `SbxExtensionUiBridge`, `RemoteSurface` |
| Per-conversation orchestration | `src/taurenChatController.ts`: `TaurenChatController` |
| Active/background conversations and UI hosts | `src/sessions/taurenSessionManager.ts`: `TaurenSessionManager` |
| VS Code/webview boundary | `src/taurenChatViewProvider.ts`: `TaurenChatViewProvider` |
| Browser composition and state dispatch | `src/webview/main.ts`: standalone functions |
| Wire method names and DTOs | `shared/src/sbx/contract.ts`, imported through `@tauren/shared/sbx/protocol` |

## What the shared library does

`shared/` supplies code, not a fourth process or a message relay. Sandbox and host
import separate copies in their respective module formats. The library contains
rendering helpers, TUI facades, completion helpers, session projections and the
wire contract. It does not decorate browser events before sending them to Pi.

TUI components are converted into display data beside the code that created
them. `renderComponentContent()` in `shared/src/rendering/renderContent.ts`
extracts ANSI-styled text lines and typed text/image blocks. Facade helpers in
`shared/src/extensionUi/facades.ts` supply dimensions, redraw callbacks, theme and
keybinding behavior to extension factories.

A JSON-RPC request sends a method name and parameters, not the function to run.
For `ui.render`, the host sends a surface ID and dimensions, and the sandbox runs
its registered handler and replies with display data. For `ui.select`, the sandbox
sends a title and choices, and the host runs its registered handler and replies
with the user’s selection. Component instances, factories, and callbacks stay in
the process that created them.

```text
Sandbox extension component
  → function renderComponentContent(component, dimensions) [shared rendering helper]
  → data: lines and text/image blocks
  ── JSON-RPC ──► Host RemoteSurface cache
                  → function renderComponentContent(proxy, dimensions)
                    calls proxy[renderContentProvider]() [local symbol hook]
                  → existing host UI → webview DOM
```

Tauren defines the symbol-keyed `[renderContentProvider]()` method on its
host-side `RemoteSurface` proxy. The method returns the cached lines and image
blocks, so the renderer can display images without rebuilding the component
tree on the host. The sandbox sends the render data that the proxy caches.

Other shared helpers also serve the in-process SDK backend, where there is no
SSH boundary. The production
`createConfiguredAgentClient()` function selects `PiSdkClient` or `KwardClient`,
not `SbxClient`. The in-process Pi path joins the same host rendering code:

```text
Host PiSdkClient.bindRuntime() → SDK AgentSession.subscribe() callback
  → function mapSdkSessionEventToAgentEvent() → PiSdkRenderer.enrichEvent()
  → PiSdkClient.emitEvent() → AgentClientManager.getClient() subscriber
  → native transcript path below

Host PiSdkClient.bindRuntime() → function createSdkExtensionUiContext()
  → ExtensionUi callbacks → native dialog, widget, footer and custom UI hosts
```

## Conversation rendering

### 1. User prompts, images and steering

The Composer first updates Tauren's local conversation state, then sends a prompt
through `AgentClient`. For the sandbox adapter, the prompt and optional image
payload become `chat.prompt`. Pi handles input hooks, extension commands and its
own steering/follow-up queues; Tauren does not introduce another queue.

```text
Browser ComposerController.handleSubmit()
  ── submit {text, streamingBehavior?} ──► TaurenChatViewProvider.handleWebviewMessage()
    → TaurenSessionManager.handleWebviewMessage() → TaurenChatController.handleWebviewMessage()
    → TaurenChatController.handleSubmitMessage() → ChatSession.beginSubmit()
    → AgentClient.prompt(text, behavior, images) → SbxClient.prompt()
Sandbox registerServer → chat.prompt handler ◄── chat.prompt ──┘
  → SDK AgentSession.prompt(..., source: 'rpc')
  → input hooks / commands / model loop
  ── acceptance response ──► SbxClient.prompt() resolves
  ── agent.event ──► streaming path below
```

Images are attached separately on the host and consumed at submission; they are
not fields in the browser's `submit` message. The acceptance response does not
mean generation has finished. Stop invokes
`SbxClient.abort()` and `chat.abort`; the server aborts generation and relevant
SDK operations. Images supplied with prompts remain SDK content rather than
remote webview URLs.

### 2. Assistant text, thinking and ordinary transcript entries

Ordinary conversation rendering uses Pi-compatible events, not the extension UI
bridge. The server subscribes to SDK events, the adapter validates their sequence
and known fields, and Tauren's existing controller maps them into transcript state.
The browser then renders that state using its own message components.

```text
Sandbox SDK AgentSession event
  → function bindRuntime() inside registerServer(): SDK subscription callback
  → PiSdkRenderer.enrichEvent()
  ── agent.event {sequence, event} ──► Host SbxClient.installConnection() handler
                                      → function validateEventEnvelope()
                                      → SbxClient.onEvent() subscribers
                                      → AgentClientManager.getClient() event listener
                                      → TaurenChatController.handleAgentEvent()
                                      → AgentRuntimeEventHandler.handleEvent()
                                      → ChatSession state mutations
                                      → StatePublisher.schedule() / flush()
                                      → TaurenChatController.getStateMessage()
                                      → TaurenSessionManager.handleSessionState()
                                      → TaurenSessionManager.postActiveState()
Browser function parseWebviewStateMessage() ◄── state with messages or messagePatch
  → function scheduleRender() → function render()
  → MessageListController.renderMessageList()
  → functions createMessageElement() / updateMessageBodyElement()
  → text / thinking / activity DOM
```

The adapter does not translate assistant deltas a second time. The controller's
existing mapping code interprets them. Agent lifecycle, retry and compaction events
also update busy indicators and activity entries through this path; they are not
custom remote surfaces.

### 3. Tool activity and custom tool/message renderers

Pi extension render callbacks execute inside the sandbox, even though their
output appears in Tauren's native transcript. `PiSdkRenderer` turns those callbacks'
components into presentation fields attached to events or restored messages.
Original tool arguments, results and SDK message content remain available too.
Transcript presentation fields contain text (`body`, optional `expandedBody` and
`code`), not the normalized image blocks used by interactive surfaces. Tool images
are extracted separately from the original SDK result content:

```text
Sandbox tool result ── agent.event or session.getMessages response ──► host
  → function formatToolExecutionActivity() → function extractToolResultImages()
  → activity.images in webview state
Browser function createActivityElement() → function createImageListElement()
  → function createDataImageElement() → image DOM
```

```text
Sandbox tool start/update/end or custom message
  → PiSdkRenderer.enrichEvent() / PiSdkRenderer.renderCustomMessage()
  → extension renderCall() / renderResult() / message renderer executes beside Pi
  → functions renderComponentText() → renderComponentContent() [shared]
  → text snapshots: taurenRenderedTool / taurenRenderedMessage
  ── agent.event or session.getMessages response ──► Host SbxClient
                                                    → existing transcript mapping
                                                    → native tool/message entry
  Browser transcript renderer ◄── webview state ─────┘
```

This is distinct from `ctx.ui.custom()`: a rendered tool entry does not acquire an
interactive remote component identity. Unsupported or failing custom rendering
must leave ordinary SDK content available for the transcript's fallback display.

### 4. Restored history and reconnect

Persisted Pi history is the source for restored transcript entries. The adapter
remembers the actual session-file path returned by Pi and passes it back when
explicitly reconnecting. It does not restore an authoritative local transcript
cache or resend an interrupted prompt.

```text
Host SbxClient.reconnect()
  → SandboxLifecycle.open(signal, sessionFile)
Sandbox function initialize() inside registerServer() ◄── initialize {sessionFile}
  → SDK SessionManager.open() and runtime binding
Host caller separately requests history restoration:
  SessionHistoryController.adoptReplacedSession()
  or SessionHistoryController.restoreInitialSessionHistory() on initial restore
  → SbxClient.getMessages()
Sandbox getMessages handler ◄── session.getMessages ──┘
  → SDK session.messages
  → PiSdkRenderer.renderCustomMessage() for restored custom messages
  ── {messages} ──► function formatAgentMessages()
                     → ChatSession.replaceMessages() → published state
Browser MessageListController.renderMessageList() ◄── webview state ──┘
```

Reconnection creates a new server process. Existing custom widgets and component
state are not serialized for the host to recreate; extension startup hooks can
create new UI as the runtime binds. Restored custom messages rerun their renderers,
but restored tool results use native `formatRestoredToolResultActivity()` instead
of rerunning custom tool render callbacks. Restored assistant thinking blocks are
not rebuilt from history by the current transcript formatter.

### 5. Markdown, code highlighting and transcript images

Markdown and syntax highlighting are host/browser presentation work, not a second
Pi rendering request. Markdown becomes browser DOM, while code highlighting is
requested asynchronously from extension-host Shiki. Plain text remains readable
when highlighting fails.

```text
Sandbox message/tool content ── events/history ──► Host transcript state
Browser functions renderMarkdownInto() / renderCodeActivityBody()
  ◄── webview state ──┘
  → functions requestCodeHighlightsIn() / requestCodeHighlight()
  ── highlightCode ──► TaurenChatViewProvider.handleCodeHighlightRequest()
                        → ShikiCodeRenderer.highlightCode()
  ◄── highlightCodeResult ───────────────────┘
  → function handleCodeHighlightMessage() updates DOM; plain-text fallback remains
```

Message image data and normalized extension image blocks are displayed by the
appropriate browser renderer. Workspace-file references and remote Markdown image
URLs follow Tauren's separate path and image policies; sending a path in a tool
result does not automatically make a sandbox-only file readable by VS Code.

## Pi extension UI rendering

### 6. Notifications

A notification is UI intent, not a TUI component. No component rendering helper
is needed to carry a message and severity to Tauren's notification callback.

```text
Sandbox extension ctx.ui.notify(message, type)
  → RemoteExtensionUi.context.notify()
  ── ui.notify ──► Host SbxExtensionUiBridge notification handler
                   → ExtensionUi.notify()
                   → TaurenChatViewProvider.showNotification()
                   → vscode.window.showInformationMessage(),
                     showWarningMessage() or showErrorMessage()
```

### 7. Status text

Status updates change per-session host state and are rendered beneath the
Composer. Clearing a status uses `null` on the wire, which the host converts back
to the `undefined` value expected by `ExtensionUi.setStatus()`.

```text
Sandbox ctx.ui.setStatus(key, text)
  → RemoteExtensionUi.context.setStatus()
  ── ui.status / ui.clearStatuses ──► SbxExtensionUiBridge
                                      → ExtensionUi.setStatus() / clearStatuses()
                                      → TaurenSessionManager status state
Browser function syncExtensionStatus() ◄── webview state ── postState()
  → status DOM
```

### 8. Selection, confirmation and input prompts

Host-native dialogs exchange plain values, not remotely rendered TUI components.
The server sends the title and choices or placeholder, and Tauren's prompt host
resolves the pending request after browser interaction.

```text
Sandbox ctx.ui.select() / confirm() / input()
  → RemoteExtensionUi.dialog()
  ── ui.select / ui.confirm / ui.input ──► SbxExtensionUiBridge reverse handler
                                          → ExtensionUi.select/confirm/input()
                                          → TaurenSessionManager.openExtensionPromptForSession()
Browser ExtensionPromptController.handleHostMessage() ◄── extensionPromptShow
  → ExtensionPromptController.createChoiceList() / createConfirmActions() / createInputForm()
  → user acts → ExtensionPromptController.answer() / cancel()
  ── extensionPromptAnswer / extensionPromptCancel ──► TaurenSessionManager.handleWebviewMessage()
                                                       → TaurenSessionManager.resolvePendingExtensionPrompt()
Sandbox RemoteExtensionUi.dialog() ◄── RPC result: string / boolean / null
  → selected value or SDK dismissal value
```

Cancellation and timeout travel through the RPC cancellation token to an
`AbortSignal` on the host dialog. Disconnect disposes the bridge and aborts pending
interactions, so the browser prompt does not keep waiting on a server that has
disappeared. If the prompt host is unavailable, the session manager can fall back
to VS Code Quick Pick/input APIs. Those existing fallback callbacks do not honor
the supplied abort signal, so cancellation can settle RPC without dismissing a
fallback VS Code dialog.

### 9. Editor dialog

The editor uses Tauren's native multiline editor dialog. Its text is returned to
the extension as a normal RPC result, unlike custom UI's arbitrary completion
values, which stay inside the sandbox.

```text
Sandbox ctx.ui.editor(title, prefill) → RemoteExtensionUi.dialog()
  ── ui.editor ──► SbxExtensionUiBridge → ExtensionUi.editor(..., {signal})
                   → TaurenSessionManager.openExtensionEditorForSession()
Browser ExtensionEditorDialogController.handleHostMessage() ◄── extensionEditorShow
  → user edits → ExtensionEditorDialogController.save() / cancel()
  ── extensionEditorSave / extensionEditorCancel ──► TaurenSessionManager
                                                    → resolve editor promise
Sandbox extension ◄── ui.editor result: text / null ──┘
```

The host's optional dialog signal allows cancellation to hide the editor. This
extends the host-side interface without sending an `AbortSignal` as JSON.

### 10. String widgets

String-array widgets need no interactive sandbox component after creation. The
server sends their lines, key and placement directly, and the existing host widget
renderer displays them above or below the Composer.

```text
Sandbox ctx.ui.setWidget(key, stringLines, options)
  → RemoteExtensionUi.setWidget()
  ── ui.widget {key, placement, content: lines} ──► SbxExtensionUiBridge
                                                  → ExtensionUi.setWidget()
                                                  → ExtensionWidgetHost.setWidget()
Browser function syncExtensionWidgets() ◄── webview state ── host onChange/postState
  → function renderExtensionWidgetContainer() → text/image block DOM
```

Removing the widget sends null content; `ui.clearWidgets` clears all extension
widgets. Component widgets use the render request described in the next section.

### 11. Component widgets and footer

The sandbox runs widget and footer factories and stores their components under
opaque surface IDs. The host supplies a local `RemoteSurface` proxy to its
existing widget or footer host, so those hosts can keep their synchronous rendering
API while actual rendering happens asynchronously over RPC.

```text
Sandbox ctx.ui.setWidget(factory) / ctx.ui.setFooter(factory)
  → RemoteExtensionUi.setWidget() / setFooter()
  → create real component and surface ID
  ── ui.widget {key, placement, content: {surfaceId}} / ui.footer {surfaceId}
     ──► SbxExtensionUiBridge notification handlers
                                                    → ExtensionUi.setWidget/setFooter()
                                                    → ExtensionWidgetHost / ExtensionFooterHost
                                                    → local RemoteSurface proxy
Host proxy render → remote render cycle below
Browser function syncExtensionWidgets() / syncExtensionStatus()
  ◄── webview state ◄── ExtensionWidgetHost.getEntries() / ExtensionFooterHost.getEntry()
```

Footer data callbacks such as status and branch information stay beside Pi in
`RemoteFooterData`. The host is not asked to reconstruct that SDK callback context.
The current `ExtensionFooterHost.render()` displays only the first text line;
additional lines and normalized footer image blocks are not displayed. Component
widgets, by contrast, use image-aware `renderComponentContent()`. Widgets have no
keyboard-input route. `RemoteFooterData` currently receives no provider-count
callback from the server, so its available-provider count is zero.

### 12. Custom interactive UI

`ctx.ui.custom()` keeps both the real component and its completion callback
inside the sandbox. The host displays only a remote surface and forwards input.
An arbitrary object passed to `done(value)` is never serialized to Tauren.

```text
Sandbox ctx.ui.custom(factory, options) → RemoteExtensionUi.custom()
  → factory creates real component; save done(value) locally
  ── ui.custom {surfaceId, options} ──► SbxExtensionUiBridge reverse handler
                                       → ExtensionUi.custom(proxyFactory, options)
                                       → ExtensionCustomUiHost.custom()
Browser CustomUiController.handleHostMessage() → renderNow()
  ◄── customUiShow / customUiRender
  → CustomUiController.handleKeydown() / postTextInput() / handlePaste()
  ── customUiInput ──► TaurenSessionManager.handleWebviewMessage()
                        → ExtensionCustomUiHost.handleInput()
                        → RemoteSurface.handleInput()
Sandbox component.handleInput() ◄── ui.surfaceInput ── SbxExtensionUiBridge.request()
  → extension calls done(value)
  → resolve SDK promise locally and cancel outstanding host custom request
Browser hides surface ◄── host cancellation / customUiHide ── ExtensionCustomUiHost
```

Host dismissal goes the other way: it disposes the proxy, sends `ui.dispose`, and
returns null for the host custom request. Server cleanup releases the real
component and settles the extension's pending custom UI call.

### 13. Render requests, invalidation, layout and images

The same render cycle serves component widgets, footer and custom UI. The host
requests dimensions, receives display data and redraws using its existing UI host.
A proxy returns its previous cache immediately because the host component API is
synchronous; a completed RPC requests another render with the new content. The
footer consumes only the returned first text line, as described above.

```text
Host RemoteSurface[renderContentProvider](width, cells)
  → RemoteSurface.fetch()
Sandbox RemoteExtensionUi ui.render handler ◄── ui.render {surfaceId, dimensions}
  → update component terminal dimensions
  → function renderComponentContent(realComponent, width, dimensions)
  ── {lines, blocks} ──► RemoteSurface validates and caches
                         → tui.requestRender()
                         → existing custom/widget/footer host renders cache
Browser DOM ◄── customUiRender or widget/footer state ──┘

Sandbox component requests redraw
  → RemoteExtensionUi.invalidate()
  ── ui.invalidate {surfaceId} ──► RemoteSurface.invalidate() → fetch again
```

Layout changes begin in the browser's measured terminal dimensions and return
through the existing UI host to the next `ui.render` request:

```text
Browser CustomUiController.postDimensions() / function scheduleExtensionWidgetDimensionsPost()
  / function scheduleExtensionFooterDimensionsPost()
  ── customUiDimensions / extensionWidgetDimensions / extensionFooterDimensions ──► Host
     TaurenSessionManager.handleWebviewMessage()
       → ExtensionCustomUiHost.updateDimensions() / ExtensionWidgetHost.updateDimensions()
         / ExtensionFooterHost.updateDimensions()
       → RemoteSurface render cycle → ui.render → sandbox dimensions
```
 ANSI remains display
data, and typed image blocks retain image data and cell geometry. The browser
renders those replies using Tauren’s own code.

### 14. Surface focus, attachment and disposal

Custom UI focus and attachment determine whether the sandbox component should
receive input. These state updates are reversible; disposal permanently releases
the component. Background-session retention therefore does not require destroying
all its UI whenever another conversation becomes active.

```text
Host TaurenSessionManager custom UI attachment changes
  → ExtensionCustomUiHost.setAttached() → proxy.focused setter
Sandbox RemoteExtensionUi ui.setSurfaceState handler ◄── ui.setSurfaceState
  → function setComponentFocused(realComponent, attached && focused)

Host proxy.dispose() / bridge.dispose()
Sandbox RemoteExtensionUi ui.dispose handler ◄── ui.dispose {surfaceId}
  → remove surface and dispose real component
```

Each connection has its own surface IDs and bridge registrations. Disconnect
cancels pending dialogs and requests, clears the bridge's host UI, and rejects late
results instead of allowing an old surface to update a new connection.

### 15. Terminal input interception

Terminal interception is an awaited request/result path because Pi handlers can
consume or transform input before subsequent handlers see it. It is separate from
a custom component's own `handleInput()` method.

```text
Sandbox ctx.ui.onTerminalInput(handler)
  → RemoteExtensionUi retains callback
  ── ui.terminalInputSubscription ──► SbxExtensionUiBridge
                                      → ExtensionUi.onTerminalInputAsync()
Browser Ctrl+O ── extensionTerminalInput ──► TaurenSessionManager.dispatchTerminalInput()
                                               → awaited bridge interceptor
Sandbox RemoteExtensionUi ui.terminalInput handler ◄── ui.terminalInput {input}
  → run local callbacks in order
  ── {consume, input?} ──► host continues/transforms/stops its handler chain
```

The existing synchronous hook remains available to the in-process SDK backend.
The asynchronous host hook avoids pretending that an RPC Promise is a synchronous
SDK return value, and the session manager preserves input arrival order. This is
not interception of every browser key: current dispatch covers Ctrl+O and Escape
during busy abort. A transformed value feeds later interceptors, not the Composer
or Custom UI Surface, and consume cannot undo a browser action already performed.

### 16. Composer mutations and tool expansion

Extension requests to replace or append Composer text are host UI intent. They do
not transfer an editor instance or mirror every browser keystroke into Pi.
Tool expansion state is explicitly reported back because sandbox renderers may
choose different presentation depending on it.

```text
Sandbox ctx.ui.setEditorText() / pasteToEditor()
  ── ui.setEditorText / ui.pasteToEditor ──► SbxExtensionUiBridge
                                           → ExtensionUi methods
                                           → TaurenSessionManager Composer update
Browser Composer text ◄── host state/Composer message ──┘

Sandbox ctx.ui.setToolsExpanded()
  ── ui.setToolsExpanded ──► bridge → ExtensionUi.setToolsExpanded()
Browser Ctrl+O ── setToolsExpanded ──► TaurenSessionManager.setToolsExpandedForSession()
Host SbxExtensionUiBridge.sendExpanded() reads ExtensionUi.getToolsExpanded()
  ── ui.toolsExpanded ──► RemoteExtensionUi stores state for later renderers
```

Expansion synchronization is not a command to redraw every existing tool card.
The session manager stores the value and the bridge reports it on subsequent UI
requests. `RemoteExtensionUi.context.getEditorText()` likewise returns an empty
string rather than maintaining a live copy of the browser's Composer.

## Native session and runtime views

The following paths render ordinary Pi state using Tauren's own components. They
do not call `ctx.ui.custom()` merely because a Pi extension originally contributed
a command, model or message to that state.

### 17. Session List Lane, search and selection

Session-list rendering currently reads host-side session discovery, not the
sandbox's `sessions.list` method. This distinction matters because rendering the
lane is implemented, but selecting an SBX store instead of the local Pi store
still requires integration. `SbxClient` does not currently expose the server's
list or origin-tracing operations.

```text
Browser /resume or lane action → host command routing
  → host SessionViewController.showSessions() → refreshSessionsNow()
  → TaurenChatViewProvider.listSessionsWithPerf()
  → functions listAgentSessions() → listPiSessions() [host filesystem]
  → rows, current-session identity and search state → published webview state
Browser SessionViewController.renderSessions() → Session List Lane DOM
  → user selects row ── selectSession ──► TaurenSessionManager.handleWebviewMessage()
     → activateSession() if already open
     → otherwise createSession({sessionFile}) → new controller/client → history path
```

The first `SessionViewController` is the host class in
`src/sessions/sessionViewController.ts`; the second is the browser class in
`src/webview/sessions/sessionView.ts`. Session-list text indexing and origin
search remain host-file operations. On the server, `registerSessionControls()`
already implements scoped `sessions.list` and `sessions.traceOrigin`, but there is
no production arrow from those handlers to this lane yet.

### 18. Session Tree Lane, labels and navigation

The Session Tree Lane queries the live client rather than scanning transcript
DOM or displaying a Pi extension component. The server projects Pi's session tree
into Tauren row data using a shared pure helper, and the browser renders the rows.

```text
Host SessionViewController.refreshTree() → SbxClient.getSessionTree()
Sandbox registerSessionControls → session.getTree handler ◄── session.getTree
  → SDK SessionManager.getTree() / getLeafId()
  → function flattenPiSessionTree() [shared session projection]
  ── tree row DTOs ──► host SessionViewController publishes tree state
Browser SessionViewController.renderTree()
  → SessionTreeController.render() → Session Tree Lane DOM
  → label/navigation action ── webview message ──► host SessionViewController
     → setTreeEntryLabel() / navigateTree()
     → SbxClient.setTreeEntryLabel() / navigateTree()
Sandbox label/navigation handlers ◄── session.setTreeEntryLabel / session.navigateTree
  → SDK session changes
  ── label acknowledgment ──► host SessionViewController.setTreeEntryLabel()
                               → update local row → SessionViewController.refreshTree()
  ── navigation result ──► host SessionViewController.navigateTree()
                            → update Composer when editorText is supplied
                            → SessionHistoryController.adoptReplacedSession()
                            → SbxClient.getMessages() → replace transcript
```

Folding and selection presentation belong to the browser tree controller. Persisted
labels and navigation belong to Pi, so the host rereads the tree/history instead
of treating a row's appearance as the saved session state.

### 19. New conversation, rename and background switching

A new Tauren conversation is a new controller/client, not a replacement of every
existing runtime. `TaurenSessionManager` retains running background conversations,
selects which state reaches the visible webview and attaches the appropriate
custom UI. This host coordination is why two clients can share a sandbox while
retaining independent transcripts and server connections.

```text
Browser New session ── newSession ──► TaurenSessionManager.handleWebviewMessage()
  → createSession() → new TaurenChatController → AgentClientManager.getClient()
  → SbxClient first API call → SandboxLifecycle.open() → separate sandbox server
  → metadata/history state → TaurenSessionManager.postActiveState()
Browser function render() ◄── active webview state ──┘

Host rename action → SbxClient.setSessionName()
Sandbox registerSessionControls → session.setName handler ◄── session.setName
  → SDK AgentSession.setSessionName()
  ── acknowledgment ──► host metadata/list refresh → native session title/list row
```

Selecting an already-open conversation calls `TaurenSessionManager.activateSession()`
and changes the visible state without reconnecting that conversation. Running
background sessions retain their connections under existing retention rules.

### 20. Fork, clone, switch and import

Session mutations change Pi's persisted conversation, then reuse the history
rendering path. The host does not manufacture the replacement transcript from the
currently visible messages.

```text
Host LocalSlashCommandController.handleForkSlashCommand() / handleCloneSlashCommand()
  / handleImportSlashCommand(), or host SessionViewController.switchSession()
  → functions in src/sessions/sessionClientActions.ts or AgentClient directly
  → SbxClient.getForkMessages() [fork choices], fork() / clone() / switchSession()
    / importFromJsonl()
Sandbox registerSessionControls handlers ◄── session.getForkMessages / session.fork
  / session.clone / session.switch / session.importJsonl
  → SDK session/runtime operation and extension rebind where needed
  ── cancellation/selected text/result ──► host session action
     → SessionHistoryController.adoptReplacedSession()
     → getState() + getMessages() → native transcript and Composer state
```

List-item actions can use a temporary client via `withSessionClient()` rather than
the active conversation's client. That factory must also select SBX before this is
a supported production sandbox workflow. Import paths must be visible inside the
sandbox; a host file picker alone does not transfer a file.

### 21. Compaction and summaries

Compaction uses both a request result and runtime events. The result describes
Pi's compaction summary; start/end events update native activities and busy state.
Automatic compaction uses the same event rendering path without a user request.

```text
Host local compact action → SbxClient.compact(customInstructions)
Sandbox registerSessionControls → session.compact handler ◄── session.compact
  → SDK AgentSession.compact()
  ── agent.event compaction lifecycle ──► AgentRuntimeEventHandler.handleEvent()
                                         → ChatSession activity/busy state
  ── compaction result ──► host action/history refresh
Browser native transcript and indicators ◄── webview state ──┘
```

Restored compaction and branch summaries are formatted by
`formatAgentMessages()` into native transcript entries. They are not reconstructed
as custom interactive extension surfaces.

### 22. HTML export and sharing

HTML export is a file-rendering path rather than sidebar DOM rendering. The server
asks Pi to generate the document and returns its HTML so the host does not have
to assume the sandbox's output file is accessible locally.

```text
Host LocalSlashCommandController.handleExportSlashCommand()
  → function exportSessionHtml() → SbxClient.exportHtml()
Sandbox registerSessionControls → session.exportHtml handler ◄── session.exportHtml
  → SDK AgentSession.exportToHtml() → read generated HTML
  ── {path, html} ──► SbxClient.exportHtml() writes host output file
                      → function exportSessionHtml() optionally applies Tauren skin
                      → host open/share operation
```

Exported HTML can use Pi's renderer or Tauren's share styling. It is not executable
UI streamed from a Pi extension into the sidebar. Sharing subsequently consumes
the generated host file through the existing host share workflow.

### 23. Models, accounting, commands and startup resources

Metadata queries supply several native views at once: model controls, context
usage, command suggestions and the startup resource display. The metadata state
class projects backend data into Tauren's webview model rather than exposing SDK
objects directly to browser code.

```text
Host SessionMetadataRefreshController.refreshSessionMeta()
  → SbxClient.getState() / getSessionStats() / getAvailableModels()
    / getCommands() / getStartupResources()
Sandbox registerRuntimeControls handlers ◄── runtime.getState / runtime.getSessionStats
  / runtime.getAvailableModels / runtime.getCommands / runtime.getStartupResources
  → SDK session, modelRuntime, resourceLoader and settingsManager
  ── DTO responses ──► SessionMetadataState.getWebviewState()
                        → TaurenChatController.getStateMessage()
Browser model/Composer controls and MessageListController.createEmptyStateElement()
  / function createStartupResourcesElement() ◄── webview state
```

The data may describe resources contributed by Pi extensions, but the resulting
resource list is a native Tauren view. Choosing a model or thinking level invokes
`LocalSlashCommandController.setModel()` or `setThinkingLevel()`, then
`SbxClient.setModel()` or `setThinkingLevel()` and the corresponding
`runtime.setModel` or `runtime.setThinkingLevel` server handler. Refreshed metadata
updates the visible controls.

### 24. Settings and credential guidance

The Settings Face renders host-projected settings and provider readiness. Runtime
settings mutations go to Pi, while Tauren-only appearance settings remain local.
This separation prevents the sandbox from becoming the authority for VS Code UI
preferences.

```text
Browser SettingsPaneController.syncForRender() / renderSection()
  ◄── settings/auth state ── host metadata and settings projection
  → user edits setting ── updateSetting ──► TaurenChatController.updateSetting()
     → SbxClient.updateRuntimeSetting()
Sandbox registerRuntimeControls → runtime.updateSetting handler ◄── runtime.updateSetting
  → SDK live mutation / SettingsManager persistence
  ── {applied, message?} ──► refreshed native Settings Face

Host SbxClient.getAuthProviders() ── auth.getProviders ──► sandbox readiness query
  ◄── sanitized readiness ── registerRuntimeControls handler
Host SbxClient.loginWithApiKey() / loginWithOAuth() / logoutAuthProvider()
  → supplied showCredentialDocumentation(url) callback; no credential RPC
```

The adapter's credential methods never forward keys or OAuth callbacks. The
production controller still has a general credential-entry flow that can ask for
a secret before invoking a client, so presenting SBX guidance before that prompt
remains part of backend UI integration. Do not describe the current Settings Face
as an already-wired sandbox credential popup.

### 25. Composer suggestions and application

Composer suggestions keep extension callbacks beside Pi while the browser manages
the menu. The sandbox returns labels and opaque handles; applying a handle runs
the registered provider's insertion logic there and returns text/cursor data.

```text
Browser SuggestionMenuController.sync() ── requestComposerCompletions ──►
  TaurenChatViewProvider.requestComposerCompletions()
  → manager/controller → SbxClient.getComposerCompletions()
Sandbox registerServer → completion.get handler ◄── completion.get
  → PiAutocompleteRegistry.complete() → registered provider.getSuggestions()
  ── items + capabilities ──► host → composerCompletionsResult
     → SuggestionMenuController.handleHostMessage() → menu DOM
Browser selection ── applyComposerCompletion ──► TaurenChatViewProvider.applyComposerCompletion()
  → SbxClient.applyComposerCompletion()
Sandbox PiAutocompleteRegistry.apply() → provider.applyCompletion() ◄── completion.apply
  ── text/cursor result ──► host → composerCompletionApplied
     → SuggestionMenuController.handleHostMessage() → Composer text/selection

Sandbox provider registration/change ── completion.capabilities ──► SbxClient
Host SbxClient.getComposerCompletionCapabilities() ── completion.getCapabilities ──► registry
```

Cancellation, request revisions and registry generations prevent stale insertion
results from being treated as current suggestions. `requestFileSuggestions()`
looks up local files on the host without calling the sandbox.

### 26. Session Changes and file references

Session Changes currently combines host workspace reads with session-specific
snapshots and recorded tool edits. It is not a remote-rendered Pi TUI and is not
implemented by substituting Git diff. Sandbox-only and clone-mode paths still need
an explicit host-file integration audit before they can be treated as local files.

```text
Sandbox tool edit/write data ── agent.event ──► host tool activity/session tracking
Host SessionDiffController.addToolExecution() / refresh()
  → SessionDiffTracker baseline and snapshot reconstruction [host files/session JSONL]
  → session diff counters → published state → Browser Changes controls
Browser requests changes ── host message ──► SessionDiffViewer.showSessionChanges()
  → read-only virtual snapshot documents → VS Code native diff editor
```

File-link and local-image resolution also execute on the host. A local Markdown
image request sends `resolveLocalImage` to
`TaurenChatViewProvider.handleLocalImageRequest()`, which reads an allowed host
workspace file and returns `resolveLocalImageResult`. There is no sandbox file-fetch
RPC in that route. Origin tracing, deletion, search indexing, prompt attachments
and ready scripts retain their own host filesystem assumptions as well.

### 27. Diagnostics, errors and disconnect presentation

Diagnostics and failures have different presentation routes, so a server log is
not automatically a transcript entry. Error notifications reach client error
listeners; informational and warning diagnostics use the configured diagnostic
callback. Ordinary RPC failures propagate to the requesting action's existing
lane, settings, notification or transcript error handling.

```text
Sandbox registerServer diagnostic callback ── server.diagnostic ──► SbxClient handler
  → onError listeners for errors, lifecycle.onDiagnostic for info/warnings
Host AgentClientManager error listener → TaurenChatController error handling
  → native error/activity state or configured notification
Browser corresponding native UI ◄── published state / host notification

Sandbox SDK extension_error / retry events ── agent.event ──►
  AgentRuntimeEventHandler.handleEvent() → native transcript activity

SSH exit / malformed frames → SbxSshTransport disposes connection
  → SbxClient clears bridge UI and reports disconnect
  → explicit SbxClient.reconnect() + history restoration, never prompt replay
```

Tauren's performance diagnostics view is not a consolidated sandbox server-log
viewer. Stderr remains transport diagnostics rather than text to parse as JSON-RPC
or automatically append to a conversation.

## Limits and navigation

This map describes supported data paths and their current limitations, not a
claim of complete sandbox UI integration. Unsupported terminal-only APIs such as
custom editor replacement, terminal title/header control and runtime theme
replacement remain deliberate compatibility limits of the Tauren bridge. Pi's
whole terminal application is never captured and forwarded as a screen.

Use [Sandbox AgentClient Adapter](./sbx-client.md) for adapter behavior,
[Sandbox Lifecycle and SSH Transport](./sbx-lifecycle.md) for startup and cleanup,
[Webview](./webview.md) for browser structure, [Sessions](./sessions.md) for retention,
and [Diff Lifecycle](./diff-lifecycle.md) for baseline ownership. The complete wire
method inventory is in `shared/src/sbx/contract.ts`; adding a new user-visible path
should update both that implementation and the relevant sequence in this document.
