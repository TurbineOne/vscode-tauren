# Sandbox lifecycle and SSH transport

`SandboxLifecycle` (`src/sbx/lifecycle.ts`) is a VS Code-independent service. It
provisions or adopts one named sandbox, then opens one per-client SDK server
connection through the concrete `SbxSshTransport`. Command execution, providers
and inspection decoding can be supplied by the caller; there is no interchangeable
transport interface or factory. Tauren’s **Docker Sandboxes** backend uses this
service through `SbxClient`. See [Sandbox AgentClient adapter](./sbx-client.md)
for configuration, session discovery, and reconnection.

## Ownership and sequence

1. `SandboxLifecycle.open()` (`src/sbx/lifecycle.ts`) canonicalizes the open
   workspace and fallback storage root with helpers in `src/sbx/configuration.ts`.
2. `SandboxLifecycle.open()` uses the module-private `exclusive()` queue in
   `lifecycle.ts` to serialize provider resolution, lookup, and creation across
   lifecycle instances in the same extension-host process.
   This prevents two concurrent Tauren sessions from racing sandbox creation or
   staging side effects before either finishes provisioning, though it does not
   coordinate separate OS processes or terminal commands.
3. Inside that queue, `SandboxLifecycle.open()` verifies `workspaceTrusted`
   whenever an external command provider is configured, checks `sbx --version`
   through `SbxControl.checkPrerequisites()` (`src/sbx/sbxControl.ts`), and
   evaluates the command provider (`commandProvider`, `runCommandProvider()`, or
   `defaultCommandProvider()` in `src/sbx/commandProvider.ts`).
   `composeSandboxCommand()` (`src/sbx/commandComposition.ts`) then resolves the
   effective sandbox name, session directory, environment assignments (such as
   `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`), workspace mounts,
   and Tauren server mixin, so both new and adopted sandboxes use the exact
   paths defined by the provider.
4. `SbxControl.lookup()` lists sandboxes with `sbx ls --json` and inspects a
   matching name with `sbx inspect NAME --json`, using `parseSandboxInspection()`
   or the supplied decoder. An inspect failure is reported as an error rather
   than treated as absence.
5. `SandboxLifecycle.open()` calls `SbxControl.assertWorkspace()` to adopt an
   existing sandbox only when its primary workspace matches, rejecting any
   sandbox associated with another workspace. In a trusted workspace, it also
   ensures the resolved host session directory and any configured
   `PI_CODING_AGENT_DIR` exist before connecting, because the in-sandbox server
   cannot create directories under root-owned host mount parents. When no
   sandbox exists yet:
   1. `SandboxLifecycle.open()` checks `workspaceTrusted` before mutating host
      storage or creating sandbox resources.
   2. It calls Node's `mkdir()` for the resolved host session directory and any
      configured `PI_CODING_AGENT_DIR`, then re-verifies the canonical
      workspace, session, and agent paths so symlink changes during creation
      fail closed.
   3. The supplied `runCommand`, defaulting to `runHostCommand()`
      (`src/sbx/process.ts`), executes the composed `sbx create` command
      directly as an executable and argument vector without a local shell.
   4. `SbxControl.lookup()` and `SbxControl.assertWorkspace()` inspect and
      validate the created sandbox again, because command exit status alone does
      not prove workspace association or server readiness.
6. `SandboxLifecycle.waitForSsh()` establishes SSH readiness and locates Node
   with `command -v node`, retrying within the startup budget. It uses
   `buildSshArguments()` (`src/sbx/sshTransport.ts`) and the same command runner. A successful creation command does not prove SSH is ready;
   this short-lived probe proves an authenticated remote command can execute and
   discovers the absolute Node path without guessing an image-specific location.
   It is separate from the eventual long-lived protocol connection. Connecting
   starts stopped sandboxes automatically. Do not use `sbx run -d` for adoption:
   that changes their auto-stop policy permanently. Node must resolve to a single
   absolute path.
7. `SandboxLifecycle.open()` calls `SbxSshTransport.open()`
   (`src/sbx/sshTransport.ts`) directly to
   spawn `ssh -T … NAME.sbx REMOTE_COMMAND` and launch this client's server.
   `SbxSshTransport` uses `buildServerLaunchCommand()`
   (`shared/src/ssh/serverLaunch.ts`), passing the resolved workspace, session
   directory, and provider environment assignments such as `PI_CODING_AGENT_DIR`,
   and opens `createProtocolConnection()` (`shared/src/sbx/connection.ts`).
   `SandboxLifecycle.open()` invokes the caller's `configureConnection` hook to
   register reverse request/event handlers before
   sending `Requests.initialize`, since SDK startup can itself emit extension UI
   requests. It bounds the request with `bounded()` and calls
   `validateSandboxHandshake()` (`src/sbx/handshake.ts`) to validate:
   - Protocol version.
   - Independent server package version compatibility (not the extension version).
   - Actual loaded Pi SDK release-line compatibility.
   - Effective workspace.
   - Effective session directory.
   - Capability-list structure.
   On success, `SandboxLifecycle.open()` returns a `SandboxSession` owning that
   transport. If initialization or validation fails, its catch path calls
   `transport.dispose(false)`; `SbxSshTransport` disposes the protocol connection
   and its SSH child non-gracefully, rejecting pending calls. Connection-bound handlers
   can no longer receive messages. This is not a general cleanup hook for external
   resources: `configureConnection` returns no disposer, so any UI/subscriptions
   allocated outside the connection must be owned and cleaned up by the caller.

The SSH arguments preserve configured host-key verification and multiplexing
settings, and use BatchMode and ConnectTimeout. Tauren does not force multiplexing
on or off; SSH follows the user's configuration. The shared launch builder
quotes the remote shell command independently of local argv. Explicit cwd/session
environment and `/home/agent/.tauren/server/dist/main.js` follow the kit contract.
No shell parses host arguments; no credentials are forwarded.

## SBX compatibility limitation

The CLI adapter targets stable SBX **0.51+ within 0.x**. Docker documents list JSON
as an array (since 0.48), inspect JSON, configured mount reporting in 0.51, and SSH
auto-start.

`sbxControl.ts` isolates a deliberately narrow provisional decoder accepting
`{ "name": "…", "workspace": "/absolute/primary/source" }`. This is a fixture
contract, **not a verified assertion about production SBX output**. Unknown shapes
fail closed before adoption or server launch; there is no fallback to name-only
adoption, guessing arbitrary mount fields, or treating remote `pwd` as host mount
proof. A version-specific decoder can be injected when an installation's schema
has been verified. Before claiming real-SBX lifecycle readiness, capture sanitized:

```sh
sbx --version
sbx ls --json
sbx inspect NAME --json
```

Verify direct, clone-mode and mountless cases, then codify exact primary-source,
target and clone semantics. Until then the production inspection boundary remains
an explicit step-9 verification gap. Do not mark it complete based on fixtures.

CLI references used: Docker docs commit
`a0442378fca4987b1235614ec917b4138b5d5e5d`, automation/usage/SSH integration pages
and generated `sbx_ls`/`sbx_inspect` references; docker/sbx-releases issue #732
confirms the JSON schema is undocumented.

## Connection lifetime and errors

`sshTransport.ts` listens immediately and returns on spawn, not first stdout: the
server awaits initialize before speaking. `@tauren/shared/sbx/protocol` owns the
canonical Content-Length framing via `vscode-jsonrpc`, shared as CJS/ESM, including
one JSON-RPC error-class identity inside each runtime. Notifications and reverse
requests use the same bidirectional channel. `configureConnection` installs host
handlers before initialization can emit extension UI events.

Unexpected process/stream exit or malformed frames disposes the connection,
rejects pending requests and tears down its local SSH child. A bounded stderr tail
stays separate from protocol stdout. Graceful disposal sends shutdown, ends stdin
after acknowledgment/deadline, then escalates local process termination as needed.
It is idempotent and never stops or removes the sandbox or another client's pipe.

Default finite-command timeout is 120 seconds, startup/probe and handshake budgets
are each 30 seconds, shutdown stages are each bounded by 5 seconds. Finite commands
cap combined stdout/stderr at 1 MiB. Cancellation is checked at mutation boundaries
and propagates through running commands, queued opens, probes and handshake.
Committed creation is not rolled back on cancellation. Errors distinguish missing
prerequisites, incompatible metadata/runtime, command failure, timeout, cancellation,
SSH readiness, and server handshake failure. No prompt is replayed automatically.

## Tests

After compilation, fixture tests need no actual SBX, SSH daemon or model service:

```sh
npx mocha --ui tdd --timeout 20000 'out/test/suite/sbx*.test.js'
```

Lifecycle fixtures spawn Node processes for CLI/probe behavior and exercise the
concrete SSH transport with a local Node executable standing in for the SSH
executable. No alternate transport implementation is injected. SSH transport
fixtures also use real framed child-process streams,
including fragmentation/UTF-8, reverse calls, silent startup, stderr, malformed
frames, failed processes, pending-call rejection and bounded independent disposal.
These establish Tauren-owned behavior, not production inspect-schema compatibility
or packaged sandbox end-to-end readiness. Real SSH gates remain separate.
