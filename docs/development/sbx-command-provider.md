# Sandbox command providers

`src/sbx/` contains VS Code-independent configuration/provider/composition helpers.
These do not create sandboxes or connect an AgentClient. Lifecycle and settings UI
integration are separate work; existing SDK/Kward behavior is unchanged.

## Identity and paths

`resolveSandboxPaths()` canonicalizes an existing POSIX workspace and storage root
(default `~/.tauren`), deriving `<root>/<name>/sessions` without creating it. Only
current-user `~`/`~/` expansion is supported. Existing symlinks, including session
path components, are resolved before containment checks. The effective store may
not equal or descend from the workspace. Colons are rejected because SBX workspace
operands use them as delimiters; Windows host paths are currently unsupported.

The default name is the canonical workspace basename, lowercased, non-ASCII/
non-alphanumeric runs replaced with `-`, edge hyphens trimmed, and length limited
to 63. Different parent paths with equal basenames intentionally collide. An
explicit override must already match `[a-z0-9][a-z0-9-]*` within 63 characters.

## Provider execution

A configured command is data, not a shell string:

```json
{ "executable": "/absolute/path/to/provider", "args": ["--profile", "development"] }
```

`runCommandProvider()` checks `workspaceTrusted` before spawning, uses the workspace
as cwd, closes stdin, and uses `shell: false`. The future VS Code caller must supply
the actual workspace trust decision. Default bounds are 30 seconds and 1 MiB of
combined stdout/stderr. Cancellation, timeout and output overflow stop the provider.
Failures do not echo arbitrary output; successful stderr is returned separately
for deliberate diagnostic handling. A provider is trusted host code, not a security
sandbox, and must not create/attach a sandbox or print credentials.

Stdout must be exactly one JSON object:

```json
{ "version": 1, "argv": ["sbx", "create", "/absolute/path/to/pi-sandbox-kit"] }
```

`defaultCommandProvider()` supplies Tauren's generated standalone sandbox path;
`packagedSandboxKits()` resolves both installed kit paths. Third-party providers
supply their own compatible main Pi kit, extra mixins and optional workspaces.
They must omit Tauren's primary workspace, session store/mount/environment and
server mixin. A matching name is accepted once; conflicting/repeated names fail.

## Supported argv grammar

The documented CLI shape is `sbx create MAIN_KIT [WORKSPACES...]` or
`sbx run -d MAIN_KIT [WORKSPACES...]`. This targets the SBX 0.51-era create/run
interface; exact binary-version acceptance belongs to lifecycle prerequisite
checks. Unit tests verify our strict subset, not every CLI version's options.

Accepted executable: `sbx` or an absolute executable path whose basename is `sbx`.
`--no-input` may appear once before the subcommand or among its options. Supported
separate-token options:

| Options | Values | Repeatable |
|---|---|---|
| `--name` | resolved name | No |
| `--kit` | mixin reference | Yes, distinct |
| `--env`, `-e` | explicit `KEY=VALUE` | Yes, distinct keys |
| `--publish`, `-p` | SBX port specification | Yes |
| `--cpus` | nonnegative integer | No |
| `--memory`, `-m` | integer, optional k/m/g/t suffix | No |
| `--clone` | none | No |
| `--detach`, `-d` | none; run only and required | No |

Aliases count as the same option for duplicate checks. Unknown flags, short flag
clusters, `--flag=value`, bare `--`, agent arguments, env-file/mount/volume options,
and inherited bare environment keys are intentionally unsupported. Sensitive
credential-like environment keys are rejected; credential injection belongs to
SBX. This is not an exhaustive secret detector: trusted providers must honor the
no-credentials contract.

The first positional is the main sandbox kit; later positionals are additional
absolute workspace operands `PATH[:TARGET][:ro]`. Sources are canonicalized and
checked for controlled-path conflicts, duplicate sources/targets, and overlapping
targets. Options may follow positionals but option/value pairs are retained.
Relative mount paths are not accepted. Shell metacharacters/spaces remain literal
argv data; no placeholders are expanded.

`composeSandboxCommand()` returns `{ executable, args }`, always adding
`--no-input`, the resolved name if omitted, the independent Tauren server mixin,
explicit session environment, and primary workspace/store operands ahead of other
provider workspaces. The lifecycle caller must execute this argv directly with
no shell and invoke the provider only for new sandbox creation.

## Tests

The three `src/test/suite/sbx*.test.ts` suites are included in root `npm test`.
After compilation they can run without VS Code or SBX:

```sh
npx mocha --ui tdd --timeout 15000 'out/test/suite/sbx*.test.js'
```

They exercise canonical paths, collisions and symlinks; exact create/run argv;
provider malformed responses/failures/bounds; workspace trust; and literal
metacharacter arguments with real temporary provider subprocesses.
