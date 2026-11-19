# Sandbox AgentClient adapter

`SbxClient` lets Tauren control Pi inside a Docker Sandbox through the same
`AgentClient` interface that its chat orchestration already uses. The adapter,
implemented in `src/sbx/sbxClient.ts`, sends requests to a server inside the
sandbox over SSH. Pi remains responsible for running the agent and storing its
conversation history, while Tauren remains responsible for displaying that
history and handling user interactions. This document explains how the adapter
preserves that division when starting sessions, handling failures, and presenting
Pi extension UI.

The adapter is implemented internally, but users cannot select it yet because
backend settings and client creation are not connected to it. It uses the
existing `SandboxLifecycle` service and its concrete per-client SSH connection,
rather than introducing another transport implementation. For details of sandbox
creation and the server connection, see
[Sandbox lifecycle and SSH transport](./sbx-lifecycle.md).

## Starting a session and making requests

The adapter opens one server connection when it first needs to make a request,
so constructing a client does not immediately start a server. If several calls
arrive during startup, they wait for the same initialization promise instead of
opening competing connections. Before initialization begins, the adapter uses
`configureConnection` to install event handlers and the extension UI bridge.
This ordering matters because Pi extensions can request user interaction during
their `session_start` handlers, before initialization has returned.

The adapter checks both what the server supports and what it actually returns,
because TypeScript request types cannot validate data received from another
process. The server advertises supported operations during initialization, and
the adapter rejects an ordinary request if its method is absent from that list.
`src/sbx/clientValidation.ts` then validates responses and known event fields
before Tauren uses them. Ordinary adapter requests wait up to 120 seconds by
default, with an override available through `requestTimeoutMs`, so an unanswered
request cannot wait indefinitely.

Most operations translate the `AgentClient` method into a server request without
changing Pi's behavior. For example, model selection, runtime settings, session
tree navigation, and history retrieval all run against Pi inside the sandbox.
The adapter does not add Kward-specific optional APIs, so callers must continue
to treat those APIs as backend-dependent rather than assuming every client
provides them.

Prompt submission preserves Pi's distinction between accepting work and
finishing it. A successful `prompt()` response means that the server accepted
the prompt, including any images, not that Pi has finished generating a reply.
Callers must follow the subsequent Pi events to observe progress and completion.
When Pi is already busy, Pi also decides how steering and follow-up prompts are
handled, rather than Tauren adding a separate prompt queue.

Composer Suggestions also use Pi's server-side completion state rather than a
second implementation in Tauren. The host sends completion requests and receives
handles that identify suggestions held by the server. Applying a suggestion
sends its handle back to that server, so the host does not need to recreate the
completion logic. If a caller cancels a completion request, the adapter sends
cancellation over JSON-RPC, the request protocol used on the SSH connection.

## Receiving events and reporting errors

The adapter passes Pi events through without rendering their contents a second
time, because the server has already attached Tauren's tool and custom-message
presentation data. Existing controller code can therefore process assistant
updates and tool results in the same Pi-compatible form it already understands.
The sandbox changes where those events originate, not how the controller must
interpret them.

Invalid incoming events close the connection, but exceptions in Tauren's event
listeners do not. Each event carries a sequence number that must be a JavaScript
safe integer and strictly greater than the previous number on that connection.
If this check or another event validation check fails, the adapter reports an
error and closes the connection rather than continuing to process invalid data.
If a listener instead throws while processing a valid event, the adapter reports
that failure but leaves the connection open. This distinction prevents a bug in
one host subscriber from unnecessarily disconnecting an otherwise usable server.

Server diagnostics are reported outside the conversation event stream, so
callers can display operational problems without treating them as conversation
messages. Error-level diagnostics go to the adapter's error listeners, while
informational messages and warnings go to the lifecycle's `onDiagnostic`
callback. Exceptions thrown by error listeners are caught as well, so reporting
an error does not itself close the connection.

## Preserving history and recovering from disconnection

Pi's persisted session is the source of truth for the conversation, so reopening
a session requires its actual file path rather than a host transcript cache.
After initialization, the adapter requests `getState()` and remembers the
persisted session path that Pi reports. It refreshes that path after a successful
session replacement, such as switching, importing, forking, or cloning. To reopen
a session in a new client, callers must provide an explicit `sessionFile`.
The adapter rejects `resumeLastSession` rather than implicitly choosing a session
on the caller's behalf.

Restoring the visible Transcript likewise requires reading Pi's history rather
than replaying a locally stored copy. Each `getMessages()` call fetches that
history afresh, including custom messages rendered by the server. Tauren can keep
rendered transcript state in memory for display, but the adapter neither persists
that state nor treats it as the authoritative conversation record.

An unexpected disconnection stops outstanding operations and requires an
explicit recovery decision from the caller. Pending requests are rejected, UI
associated with the connection is cleared, and subsequent requests fail until
the caller invokes `reconnect()`. Reconnection starts a new server connection
using the remembered session path, after which the caller must use
`getMessages()` to restore the Transcript. It does not replay failed requests or
interrupted prompts, and it does not continue interrupted generation. Callers
must therefore distinguish restoring saved history from resuming unfinished
work.

Closing a client releases its server connection without stopping or removing
the sandbox itself. `dispose()` begins that cleanup, while `closeSession()` lets
the caller await it. This keeps one client's cleanup from terminating another
client that uses the same sandbox. The existing session manager still decides
how long idle or background sessions remain open, so this adapter does not run a
separate idle timer.

## Moving files between the host and sandbox

Exports explicitly transfer their contents to the host, because a path returned
by the sandbox need not exist on the host filesystem. The server returns the
exported HTML over JSON-RPC, and the adapter writes it locally. If the caller
supplies an output path, the adapter resolves it on the host, relative to the
configured workspace when needed. Otherwise, it uses the server's export basename
to create a file in that workspace. In either case, the returned path identifies
the host file, not a remote file that the caller might be unable to open.

Imports currently require a path that the sandbox can read, rather than
performing the reverse of the export transfer. The adapter sends the import path
to the server without uploading the file. Callers must therefore ensure that the
file is visible inside the sandbox before requesting an import. The broader
file-access integration still needs review, particularly for clone-mode
workspaces, where host edits do not automatically appear in the sandbox's
separate copy.

## Configuring credentials

Credential configuration belongs to Docker Sandboxes rather than to a Pi login
flow running through Tauren. Consequently, `loginWithApiKey`, `loginWithOAuth`,
and `logoutAuthProvider` all invoke the required host callback
`showCredentialDocumentation` with Docker's credential guidance URL instead of
sending authentication changes to the server. The adapter does not inspect or
forward the supplied API key or invoke the supplied OAuth callbacks. Users must
follow the Docker Sandboxes guidance rather than expecting these methods to
update sandbox credentials.

The host must present that guidance because the adapter itself does not depend
on VS Code or open a popup. When this backend is connected to Tauren's settings,
the integration must supply the callback that makes the guidance visible. To
report whether a provider is ready, the adapter uses sanitized server results
rather than reading credentials from the host.

## Presenting Pi extension UI

The extension UI bridge lets Pi extensions remain inside the sandbox while
Tauren presents their interfaces through its existing UI hosts.
`SbxExtensionUiBridge`, implemented in `src/extensionUi/sbxExtensionUi.ts`, routes
server requests to the per-session `ExtensionUi` supplied by Tauren. The existing
hosts still display Widgets, the Footer, the Composer, and Custom UI Surfaces.
The bridge registers host handlers before Pi starts. For example, a `ui.select`
request names the host handler and supplies the title and choices. The host
shows a prompt and returns the selection. In the other direction, `ui.render`
names a sandbox handler and supplies a surface ID and dimensions. Neither
request carries a function. Component factories, components, and custom UI
`done(value)` results stay with Pi.

### Dialogs and cancellation

Dialogs require requests from the server to the host, because Pi must wait for
the user's answer before proceeding. Selection, confirmation, text input, and
editor requests therefore use cancellation signals that the host can observe.
A request timeout, disconnection, or disposal cancels the associated interaction,
so a server that is no longer waiting cannot leave its dialog open. Editor host
methods accept optional cancellation options for this purpose without changing
how existing in-process SDK callers use them.

### Rendering remote components

Remote components use a local cache to satisfy Tauren's synchronous rendering
interface while their actual rendering takes place asynchronously in the
sandbox. A local proxy returns its most recent lines and content blocks
immediately, then requests an updated render from the server using the current
layout dimensions. When the response arrives, it updates the cache and asks the
host to redraw. Repeated invalidations are combined while a render is in
progress, and responses that arrive after the surface has closed are ignored.
This lets existing UI hosts render remote components without becoming
asynchronous themselves.

The shared `renderContentProvider` symbol preserves both text and images through
that cache. It is a hook through which existing UI hosts can obtain normalized
content blocks directly, rather than reconstructing image components from text
or trying to transfer component code. Before accepting a render response, the
bridge validates its structure, including image MIME types and dimensions, so
remote content must match the format those hosts expect.

Interaction still reaches the real component in the sandbox, even though the
host displays a cached rendering. The proxy sends input, focus changes, and
layout dimensions to the server, and server invalidations request another host
render. Surface and input requests wait up to 30 seconds by default, which is
separate from the adapter's 120-second default for ordinary agent requests.

### Input ordering and cleanup

Terminal input interception must wait for a server response because an extension
can transform an input or consume it before the rest of Tauren sees it. The
optional `ExtensionUi.onTerminalInputAsync` hook makes that wait possible. The
session manager awaits remote handlers in input arrival order and applies their
transformations or consume results before proceeding. The existing synchronous
SDK hook remains unchanged, so local SDK extensions do not have to adopt an
asynchronous interface.

UI notifications update host-visible state without requiring a user response,
so the bridge handles them separately from dialogs and input requests. These
notifications update statuses, Widgets, and the Footer, change tool expansion,
and modify Composer contents. On disposal, the bridge clears the UI it created,
unregisters handlers, cancels pending requests, and ignores stale notifications.
As a result, reconnecting does not leave UI from the previous connection active.

## Verifying the adapter

The focused tests exercise the adapter's protocol and UI behavior without
requiring a running Docker Sandbox or a model service. Compile first, then run:

```sh
npm run compile
npx mocha --ui tdd --timeout 25000 \
  out/test/suite/sbxClient.test.js \
  out/test/suite/sbxClientValidation.test.js \
  out/test/suite/sbxExtensionUi.test.js
```

The adapter tests run the real standalone server and SDK with deterministic,
offline extensions, so they check actual session behavior rather than a fake SDK
session. A local fixture executable stands in for SSH while exercising the
concrete SSH transport. Separate fixture-server tests supply malformed responses
and events, terminate processes, and exercise request cancellation and disposal.
UI tests use paired connections with the real message framing. These fixtures
make the suite independent of an SBX installation and credentials while still
covering Tauren's request handling and cleanup.

These tests do not establish that the backend is ready for users, because they
do not exercise the complete deployed environment. Production SBX inspection
compatibility remains the verification gap described in
[Sandbox lifecycle and SSH transport](./sbx-lifecycle.md). Packaged end-to-end
behavior and VS Code layout and interaction also require separate verification,
including Extension Host and manual checks when backend selection is integrated.
Passing the focused suite should not be treated as evidence that those remaining
checks have passed.
