# 0005 — Add per-change diff review using VS Code APIs

## Status

Proposed

## Context

Tauren currently lets users inspect file edits after they have already been written to disk. The session diff system in `src/diff/sessionDiffTracker.ts` and `src/diff/sessionDiffViewer.ts` records baselines and opens a multi-file diff of everything a session has changed, which is useful for end-of-turn review. However, it does not pause the agent before a change is applied, and it does not let the user reject or redirect an individual edit before the model moves on to the next step.

In Pi's terminal UI, the `pi-show-diffs` extension solves this problem with a strict pre-apply gate. It intercepts file-modifying tool calls before they touch disk, computes the proposed before-and-after file contents in memory, and asks the user to approve, reject, or steer the model with feedback. Running that terminal extension inside Tauren is awkward because it renders a terminal-styled diff modal inside the narrow Custom UI Surface instead of using VS Code's native editor area.

Tauren can provide a native equivalent by combining Pi's pre-tool interception hooks with VS Code's built-in diff editor, editor toolbar actions, and input controls. Because Tauren now supports multiple `AgentClient` backends, including the in-process Pi SDK backend (`PiSdkClient`) and the VM-isolated Docker Sandboxes backend (`SbxClient`), the review mechanism should work across both without duplicating UI code or leaking VS Code dependencies into Pi extensions.

## Decision

Tauren will add an opt-in per-change diff review mode controlled by a new Tauren configuration setting. When the setting is enabled, each proposed file change pauses before the tool writes to disk and opens in a native VS Code diff editor. From that diff editor, the user can accept the change, reject it, or steer the model with written feedback.

### Strict pre-apply interception

Per-change review uses a strict pre-apply gate rather than post-apply rollback. Intercepting a change before disk mutation avoids leaving partial writes on disk, avoids triggering file watchers or language servers on rejected edits, and keeps `src/diff/sessionDiffTracker.ts` accurate because only accepted edits are ever written.

A shared inline Pi extension in `@tauren/shared` (`shared/src/review/`) will listen to Pi's `tool_call` event for `edit`, `write`, and `hashline_edit`. When per-change review is enabled for the session, the extension computes the proposed before-and-after text in memory from the current file on disk and the tool arguments, then invokes a transport-independent `ChangeReviewHandler` callback and awaits its decision. Because this hook uses `tool_call` instead of replacing tool definitions, it stays compatible with `src/sdk/workspaceMutationGuard.ts` and with other extensions that inspect or wrap tools.

The handler returns one of four decisions:

- **Accept (`approve`):** The `tool_call` listener returns normally, so Pi executes the tool and writes the file as usual.
- **Accept and auto-approve session (`approve_session`):** The `tool_call` listener allows the current edit and sets a session-local auto-approve flag so remaining edits in that session proceed without opening further diff tabs until the user re-enables review or starts a new session.
- **Reject (`reject`):** The `tool_call` listener returns `{ block: true, reason }`, so the file is never modified and Pi reports the rejection back to the model as a tool error.
- **Steer (`steer` with feedback):** The `tool_call` listener returns `{ block: true, reason }` and queues the user's feedback into the active run with `pi.sendUserMessage(..., { deliverAs: 'steer' })`. Steering therefore stops the proposed edit from landing on disk and immediately directs the model's next turn.

If preview computation fails because the tool arguments are already invalid (for example, a non-matching `oldText` in `edit` or a stale tag in `hashline_edit`), the extension skips the review UI and lets the tool fail through its normal error path. That avoids asking the user to review an edit that cannot succeed anyway.

### Native VS Code diff UI and tab-close behavior

Tauren will render each pending change with stable VS Code APIs rather than proposed APIs such as `editorInsets`, because Marketplace extensions cannot ship proposed APIs. A dedicated review controller in `src/diff/changeReviewController.ts` and virtual document provider in `src/diff/changeReviewViewer.ts` will manage the diff tabs under a dedicated URI scheme (`tauren-review:`).

When a review request arrives, the viewer registers the in-memory `before` and `after` documents under `tauren-review:` URIs that preserve the target file's path and extension so VS Code applies normal syntax highlighting. It then opens a diff tab with `vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title)`.

The user interacts with the open diff tab through native VS Code controls:

- **Editor toolbar actions (`editor/title`):** Contributed commands for **Accept Change**, **Reject Change**, **Steer Change**, and **Auto-Approve Session** appear in the diff tab's top-right toolbar when `isInDiffEditor` is true and the active resource uses the `tauren-review` scheme.
- **Keyboard shortcuts:** The same commands can be bound to scoped keybindings active while the review diff editor has focus.
- **Steering input:** Invoking **Steer Change** opens `vscode.window.showInputBox` (pre-labeled with the target file path) so the user can type steering instructions without leaving the keyboard. If the user cancels the input box, the diff tab stays open and the pending review remains active.

Closing a pending review diff tab manually counts as approval. When `vscode.window.tabGroups.onDidChangeTabs` reports that a tracked `tauren-review:` diff tab was closed while its decision is still unresolved, the review controller resolves that request as `approve` and lets the tool apply the change. This matches a low-friction workflow where the user inspects the diff and dismisses the tab to move on.

Explicit cancellation must never fall into the tab-close approval path. When the user aborts generation from the Chat Lane, when a session is disposed, or when a remote backend disconnects, the review controller first marks the pending request as cancelled, resolves it as rejected/aborted so no file write occurs, and only then closes the diff tab programmatically.

### Backend portability across `PiSdkClient` and `SbxClient`

The review UI lives once in the VS Code extension host, and every backend that supports pre-tool interception delegates to it through a shared `AgentClient` option. `PiClientOptions` in `src/pi/types.ts` will gain an optional `changeReview` capability object supplying the host `reviewChange(request, signal)` handler and a `isEnabled()` check.

The two Pi-backed clients wire this contract differently because their Pi runtimes execute in different processes:

- **In-process Pi SDK (`PiSdkClient`):** `src/sdk/piSdkClient.ts` passes the shared inline review extension through `resourceLoaderOptions.extensionFactories` when calling `createAgentSessionServices()`. The extension reads the live Tauren setting and invokes the host `reviewChange` handler directly in memory.
- **Docker Sandboxes (`SbxClient` and `sandbox-server`):** `sandbox-server/src/server.ts` registers the exact same shared inline review extension in its own `createAgentSessionServices()` call. Instead of touching VS Code directly, the server's handler sends a new reverse JSON-RPC request (`review.change`, declared in `shared/src/sbx/contract.ts`) from the sandbox server to the host over the existing SSH JSON-RPC channel. The host `SbxClient` handles `review.change` by calling the same VS Code `ChangeReviewController` and returning the serialized decision.

To avoid a JSON-RPC round trip on every tool call when the feature is disabled, the host sends the initial `perChangeReviewEnabled` boolean during `initialize` (or immediately after handshake) and pushes updates via a `review.setConfig` host-to-server notification whenever the user toggles the setting. The sandbox server also advertises `review.change` in its `initialize` capabilities so the host can detect older servers cleanly.

`KwardClient` does not support per-change diff review in this change because Kward owns its tool execution loop and does not currently expose a pre-tool interception hook. If Kward adds a pre-tool hook later, `KwardClient` can call the same `PiClientOptions.changeReview` handler without changing the VS Code UI.

### Queueing, background sessions, and `pi-show-diffs` coexistence

A model turn can emit several `edit` or `write` tool calls in parallel or in quick succession. The host `ChangeReviewController` will serialize review prompts per session through a FIFO queue so that only one diff tab opens at a time for a given session, preventing competing tabs from stealing focus from each other.

Background sessions should not interrupt the user while they are working in another session. If a review request arrives for a session that is not the currently visible session in the Chat Lane, the controller queues the request, posts a Toast or status indicator naming the session waiting for review, and opens the diff tab when the user switches to that session or clicks the notification action.

If a user also has the third-party `pi-show-diffs` extension enabled in `~/.pi/agent` with manual approval turned on, both `pi-show-diffs` and Tauren's inline extension would fire on `tool_call` and prompt twice for the same edit. When Tauren's per-change review setting is enabled and startup resources report `pi-show-diffs` as loaded, Tauren will show a warning Toast advising the user to disable `pi-show-diffs` or set it to auto-approve while using Tauren's native diff review.

### Configuration

Tauren will add a single boolean setting, `tauren.review.perChangeDiffEnabled`, defaulting to `false`. It will be registered in `package.json`, `src/settings/settingsRegistry.ts`, and `src/settings/taurenSettings.ts` so users can toggle it from either VS Code settings or Tauren's Settings Face with immediate live effect. Toggling the setting off while a diff tab is already open does not retroactively abort that open review; it simply stops intercepting subsequent tool calls.

## Consequences

### Positive

- Users get a native VS Code side-by-side or inline diff view with full syntax highlighting, theme integration, and keyboard navigation before any agent edit touches disk.
- Closing a diff tab acts as a fast approval path, keeping the review loop lightweight when changes look right.
- Rejecting or steering prevents unwanted disk writes and keeps `SessionDiffTracker` and Git working trees clean.
- Sharing the inline Pi extension and preview generator in `@tauren/shared` gives `PiSdkClient` and `SbxClient` identical interception behavior while keeping VS Code APIs strictly on the host.

### Negative

- Strict pre-apply gating pauses tool execution until the user responds, so long autonomous turns require either turning the setting off or clicking **Auto-Approve Session**.
- Supporting `edit`, `write`, and `hashline_edit` requires computing a faithful in-memory preview of each tool's transformation. Any future built-in file-editing tool added by Pi must be added to the preview helper to participate in review.
- Enabling per-change review over SBX requires updating both the extension host and the `sandbox-server` protocol contract, which adds one reverse request (`review.change`) and one notification (`review.setConfig`) to `shared/src/sbx/contract.ts`.

### Deferred scope

- **Inline editing of the proposed `after` buffer:** Backing the right-hand URI with a writable `FileSystemProvider` and applying user edits in `tool_result` (matching `pi-show-diffs`'s inline edit mode) is deliberately deferred to a follow-up change so the initial release stays focused on Accept, Reject, and Steer.
- **Line-level comment threads:** Replacing or augmenting `showInputBox` with VS Code's `CommentController` API for multi-line review comments is deferred until the core pre-apply loop is proven in daily use.

## Implementation Plan

Implement the feature in small, independently verifiable increments. Keep existing `SessionDiffTracker` and `SessionDiffViewer` behavior unchanged throughout.

### ~~1. Shared review types, preview builder, and inline Pi extension~~ — Completed

- ~~Create `shared/src/review/types.ts` defining `ChangeReviewRequest`, `ChangeReviewDecision`, `ChangeReviewConfig`, and `ChangeReviewHandler`.~~
- ~~Create `shared/src/review/preview.ts` to compute in-memory `beforeText`, `afterText`, `isNewFile`, and normalized relative/absolute paths for `edit`, `write`, and `hashline_edit` tool inputs. Skip review cleanly when the target arguments cannot produce a valid preview.~~
- ~~Create `shared/src/review/extension.ts` exporting `createPerChangeReviewExtension(options)` as a Pi `ExtensionFactory`. Intercept `tool_call`, check the live enabled and session auto-approve flags, invoke `ChangeReviewHandler` with an `AbortSignal`, and map the returned decision to allow, `{ block: true, reason }`, or `{ block: true, reason }` plus `pi.sendUserMessage(..., { deliverAs: 'steer' })`.~~
- ~~**Test gate:** Unit tests in `shared/test/` verify preview generation for `edit` (normal match, fuzzy/line-ending match, invalid match skip) and `write` (new file, overwrite), plus extension decision mapping for `approve`, `approve_session`, `reject`, `steer`, and abort cancellation.~~

### ~~2. Tauren setting and host VS Code diff review service~~ — Completed

- ~~Add `tauren.review.perChangeDiffEnabled` (default `false`, live-immediate) to `package.json`, `src/settings/settingsRegistry.ts`, and `src/settings/taurenSettings.ts`.~~
- ~~Add `src/diff/changeReviewViewer.ts` implementing a `TextDocumentContentProvider` for the `tauren-review:` URI scheme, opening diffs via `vscode.diff`, and closing tabs programmatically via `vscode.window.tabGroups.close` without triggering user-close approval.~~
- ~~Add `src/diff/changeReviewController.ts` owning per-session FIFO queueing, active review tracking, `onDidChangeTabs` detection (resolving manual user tab closes as `approve`), explicit abort/dispose cancellation (resolving as rejected without writing to disk), and background-session deferral.~~
- ~~Contribute `tauren.review.accept`, `tauren.review.reject`, `tauren.review.steer`, and `tauren.review.approveSession` commands in `package.json` with `editor/title` menu entries gated on `isInDiffEditor && resourceScheme == tauren-review`. Wire `tauren.review.steer` to `vscode.window.showInputBox`.~~
- ~~**Test gate:** Extension tests in `src/test/suite/` verify FIFO queueing, Accept/Reject/Steer resolution, manual tab close resolving to `approve`, programmatic abort closing the tab as cancelled/rejected, and cancelling the Steer input box leaving the review pending.~~

### ~~3. Wire `PiSdkClient` and Tauren chat controller~~ — Completed

- ~~Extend `PiClientOptions` in `src/pi/types.ts` with the optional `changeReview` bridge (handler, live enabled getter, and session-abort cancellation wiring).~~
- ~~Update `src/sdk/piSdkClient.ts` to pass `createPerChangeReviewExtension(...)` into `createAgentSessionServices({ ..., resourceLoaderOptions: { extensionFactories } })`. Ensure `abort()` and `dispose()` abort any in-flight review signal immediately so the session never hangs waiting on a closed or aborted turn.~~
- ~~Update `src/taurenChatViewProvider.ts` and `src/taurenChatController.ts` to instantiate `ChangeReviewController`, connect active-session visibility changes, propagate live setting changes, and emit a one-time warning Toast if `pi-show-diffs` is detected while `tauren.review.perChangeDiffEnabled` is true.~~
- ~~**Test gate:** Offline SDK integration tests in `src/test/suite/piSdkIntegration.test.ts` drive real `edit` and `write` tool calls through `PiSdkClient` and verify that Accept writes the file, manual tab close writes the file, Reject leaves the file untouched, Steer blocks the write and delivers the steering message, and `abort()` unblocks a pending review without writing.~~

### 4. Extend SBX protocol, `sandbox-server`, and `SbxClient`

- Add `review.change` (`RequestType<ChangeReviewRequest, ChangeReviewDecision, void>`) and `review.setConfig` (`NotificationType<ChangeReviewConfig>`) to `shared/src/sbx/contract.ts`, plus optional initial `perChangeReviewEnabled` config in `InitializeParams` (or immediately post-initialize).
- Update `sandbox-server/src/server.ts` to register `createPerChangeReviewExtension(...)` in `createAgentSessionServices()`, forward review requests to the host over `review.change` with cooperative `CancellationToken` support, advertise `review.change` in `initialize` capabilities, and cancel pending reviews on `chat.abort`, `shutdown`, or EOF.
- Update `src/sbx/sbxClient.ts` and `src/sbx/extensionClient.ts` to register the `review.change` request handler delegating to `ChangeReviewController`, forward live `tauren.review.perChangeDiffEnabled` changes via `review.setConfig`, and cancel active diff tabs if the SSH connection drops.
- **Test gate:** Standalone `sandbox-server` tests (`npm run test:sandbox-server`) verify `review.change` round trips, `review.setConfig` live toggling, cancellation on `chat.abort` and EOF, and payload validation. Host `src/test/suite/sbxClient.test.ts` verifies `SbxClient` routing of `review.change` to the host handler and disconnect cleanup.

### 5. Documentation, changelog, and manual verification

- Update `docs/development/diff-lifecycle.md` and `sandbox-server/docs/protocol.md` to document the pre-apply review flow and the new SBX wire methods.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md`.
- Manually verify in the VS Code Extension Host with both the bundled Pi SDK backend and the SBX backend: enabling and disabling the setting live, accepting via button and via closing the diff tab, rejecting, steering with feedback, aborting mid-review, and handling multi-edit turns.
