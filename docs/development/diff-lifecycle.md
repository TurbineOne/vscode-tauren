# Diff Lifecycle

Tauren's session diff system tracks file changes by session. It is separate from Git and exists to make agent work reviewable.

## Main files

- `src/diff/sessionDiffController.ts` owns controller integration, session-file binding, snapshot restore/save, refresh dedupe, and state posting.
- `src/diff/sessionDiffTracker.ts` owns changed-line baselines, net line diff stats, reconstructed per-file snapshot diffs, and edit/write fallback diffs.
- `src/diff/sessionDiffViewer.ts` owns read-only virtual snapshot documents and the VS Code multi-file diff adapter.
- `src/diff/sessionDiffUri.ts` owns Tauren diff URI helpers.
- `src/diff/sessionDiffStorage.ts` owns storage and file-watcher helpers.
- `shared/src/review/types.ts`, `shared/src/review/preview.ts`, and `shared/src/review/extension.ts` own the transport-independent per-change review types, in-memory preview builder, and inline Pi `tool_call` extension.
- `src/diff/changeReviewUri.ts`, `src/diff/changeReviewViewer.ts`, and `src/diff/changeReviewController.ts` own the `tauren-review:` virtual document scheme, native VS Code diff tab adapter, and per-session FIFO review state machine.

## Why not just Git diff

Git diff answers: "What differs from Git history?"

Tauren session diff answers: "What changed during this session?"

Those are related but not identical, especially with background sessions, resumed sessions, generated files, or unrelated local edits.

## Tracking model

The tracker maintains per-session baselines and reconstructs diffs from observed file state. Tool edit/write records provide fallback detail when available.

The viewer presents those snapshots through read-only virtual documents so VS Code can display a normal diff UI.

## Per-change pre-apply review

When the `tauren.review.perChangeDiffEnabled` setting is enabled in VS Code settings or Tauren's Settings Face, Tauren gates each proposed `edit`, `write`, or `hashline_edit` tool call before Pi writes to disk. The shared inline Pi extension in `shared/src/review/extension.ts` intercepts `tool_call`, computes the proposed before-and-after text in memory (reusing Pi's `createEditToolDefinition` with dry-run operations for `edit` calls), and waits for a decision from `ChangeReviewController`. Because rejected changes never touch disk, `SessionDiffTracker` continues to reflect only edits that were actually applied.

Each pending change opens in a native VS Code diff tab under the `tauren-review:` URI scheme, which preserves the target file path for syntax highlighting and scopes the toolbar commands to review tabs. From the diff editor toolbar, the user can accept the change, reject it, steer the model with feedback via an input box (which blocks the edit and queues a `steer` message), or enable session-scoped auto-approve for the rest of the current session. Closing a pending diff tab manually counts as approval so users can inspect a diff and dismiss it quickly. Explicit generation aborts, session disposal, and controller shutdown instead cancel the pending review before closing the tab so no write occurs.

Requests within a session open one at a time in FIFO order, and requests from inactive background sessions wait until that session becomes active in the Chat Lane while Tauren shows a warning Toast. If `pi-show-diffs` is also loaded when `tauren.review.perChangeDiffEnabled` is enabled, Tauren shows a one-time warning Toast because both extensions hook `tool_call`. Per-change review works with both the bundled Pi SDK backend (`PiSdkClient`) and the Docker Sandboxes backend (`SbxClient` and `sandbox-server`, which bridge the same shared inline extension over `review.change` and `review.setConfig`). `KwardClient` does not support per-change review because Kward owns its tool execution loop and does not expose a pre-tool hook.

## Contributor guidance

- Keep Git integration separate from session-diff tracking.
- Do not replace the sidebar counter or session changes view with raw `git diff`.
- Keep the current VS Code diff adapter isolated so a future custom annotated diff UI can replace it later.
- Add tests for tracker behavior when changing diff reconstruction logic.

## Verification

For diff changes, verify:

- fresh session edits,
- resumed sessions,
- write tool output,
- edit tool output,
- deleted or renamed files where applicable,
- background session changes,
- unsupported or generated files,
- per-change diff review with `tauren.review.perChangeDiffEnabled` toggled live, accepting via toolbar and via closing the diff tab, rejecting, steering with feedback, aborting mid-review, and handling multi-edit turns.
