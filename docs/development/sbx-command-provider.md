# Sandbox command providers

Tauren uses a structured JSON specification to configure and create Docker
Sandboxes without parsing shell commands or scraping a flat CLI array. The
helpers in `src/sbx/` execute a configured command provider, validate its
Version 1 JSON output (matching the `pi-sbx command` specification), apply
Tauren's server mixin and any user overrides, and construct the final
`sbx create` argument vector.

## Command provider execution

A command provider is configured as an executable and an argument array rather
than a shell command string, so Tauren never passes workspace settings through a
shell:

```json
{ "executable": "pi-sbx", "args": ["command"] }
```

`runCommandProvider()` verifies that the workspace is trusted before spawning a
provider, because running a workspace-configured command executes host code. It
runs the executable with the canonical workspace as its working directory,
closes standard input, and caps combined output at 1 MiB and execution time at
30 seconds by default. Concurrent provider calls for the same workspace are
serialized so that idempotent staging steps, such as initializing a sandbox
state directory on first use, do not race when session discovery and client
startup run at the same time. If a provider fails, Tauren reports the exit
status without echoing output that might contain sensitive host details, while
stderr from a successful run is returned separately for diagnostics.

## Version 1 JSON specification

A provider must write exactly one JSON object to stdout with `version` set to
`1`, matching the `pi-sbx command` contract:

```json
{
  "version": 1,
  "command": ["sbx", "create"],
  "agent": "/home/alice/.pi-sbx/cache/base-kits/76e9e67a28516823282169237f390ccc2a54f76b466b719da55567f3fa08f897",
  "workspaces": [
    "/home/alice/src/my-project",
    "/home/alice/.pi-sbx/sandboxes/my-project/agents",
    "/home/alice/.pi-sbx/sandboxes/my-project/sessions",
    "/home/alice/skills/custom-skill:ro"
  ],
  "options": {
    "kit": [
      "/home/alice/.pi-sbx/kit"
    ],
    "name": "my-project",
    "env": {
      "PI_CODING_AGENT_DIR": "/home/alice/.pi-sbx/sandboxes/my-project/agents",
      "PI_CODING_AGENT_SESSION_DIR": "/home/alice/.pi-sbx/sandboxes/my-project/sessions"
    }
  }
}
```

Each top-level field has a single role in the `sbx create` invocation:

- `version`: Must be the integer `1`. Other versions are rejected so that future
  schema changes fail explicitly instead of being misinterpreted.
- `command`: Must describe `sbx create`, using either `"sbx"` or an absolute
  POSIX path whose basename is `sbx`.
- `agent`: Names the base sandbox kit passed as the first positional operand to
  `sbx create`. When `agent` is `"@tauren/bundled-pi-kit"`, Tauren replaces it
  with the installed standalone Pi sandbox kit directory.
- `workspaces`: Lists positional mount operands in order. When nonempty,
  `workspaces[0]` must be the writable primary workspace matching the open
  Tauren workspace, followed by additional mounts `SOURCE[:TARGET][:ro]`. When
  `workspaces` is empty, as in Tauren's static default provider, Tauren supplies
  the primary workspace and resolved session directory.
- `options`: Maps `sbx create` long option names (without leading `--`) to
  boolean, string, finite number, string-array, or string-map values.

## How provider values override Tauren defaults

Values returned by the command provider take precedence over the defaults that
Tauren would otherwise generate, so external harnesses such as `pi-sbx` control
their own sandbox identity, agent configuration, and session store. Both client
provisioning (`SandboxLifecycle`) and host session discovery
(`resolveSbxWorkspace`) evaluate the same provider specification so that chat
connections, the Session List Lane, Trace Origin, and session deletion all agree
on the active paths:

- **Sandbox name (`options.name`)**: Used as the sandbox identity unless the
  user sets a nonempty `tauren.sbx.sandboxName` override in VS Code. When
  neither is set, Tauren derives a lowercase hyphenated name from the workspace
  basename. Explicit and provider-supplied names must match
  `[a-zA-Z0-9][a-zA-Z0-9_.-]*` within 63 characters and must not end with
  `.sbx`.
- **Session directory (`options.env.PI_CODING_AGENT_SESSION_DIR`)**: Used as the
  host and sandbox session store instead of `<storageRoot>/<name>/sessions`. The
  resolved directory must be an absolute POSIX path outside the workspace. If
  `workspaces` already mounts that directory writable at the same path, Tauren
  keeps the mount in place; otherwise, Tauren inserts the session mount
  immediately after the primary workspace.
- **Agent directory and environment (`options.env`)**: Non-credential
  environment entries such as `PI_CODING_AGENT_DIR` are preserved in
  `sbx create` and are also passed explicitly when launching the per-connection
  server over SSH, because SSH commands do not automatically inherit container
  creation environment variables. Environment variable names that look like
  credentials are rejected because credential injection belongs to Docker
  Sandboxes.
- **Mixin kits (`options.kit`)**: Provider mixins are preserved in order, and
  Tauren appends its packaged server mixin (`resources/generated-sbx-kit`) so
  that every sandbox receives the Tauren RPC server.

Tauren also enforces `--no-input` on `sbx create` because creation runs without
an interactive terminal, and it rejects `clone: true` because editor links and
session diffs require a direct workspace mount.

## Constructing the argument vector

`buildSbxCreateArgv()` converts the composed Version 1 specification into a
literal argument array for `spawn` or `execFile`:

1. Start with `spec.command`, `spec.agent`, and all entries of
   `spec.workspaces`.
2. Visit each entry of `spec.options` and prepend `--` to its key:
   - `true` appends `["--<key>"]`, while `false`, `null`, and `undefined` are
     omitted.
   - A `string` or `number` appends `["--<key>", String(value)]`.
   - A `string[]` repeats `["--<key>", item]` for each element in order.
   - A `Record<string, string>` repeats `["--<key>", "<subKey>=<subValue>"]` for
     each entry.

## Tests

The command-provider, composition, configuration, and lifecycle unit suites run
without Docker Sandboxes or a model provider after compilation:

```sh
npx mocha --ui tdd --timeout 15000 'out/test/suite/sbx*.test.js'
```
