# Release Process

This page captures the practical release flow for Tauren contributors.

## Before release

1. Review `CHANGELOG.md` and move relevant Unreleased entries into the release section.
2. Run compile and tests.
3. Package the extension.
4. Install the VSIX locally and smoke test the sidebar.
5. If publishing to Open VSX, set `OVSX_PAT` to an Open VSX personal access token in the release shell. Keep the token in a secure local secret store or environment configuration; never commit it.

Verify the token can publish to Tauren's Open VSX namespace before the first release and whenever the token changes:

```sh
npx --yes ovsx verify-pat kaiwood
```

The release script also performs this check before it changes any release files.

## Useful commands

Compile everything:

```sh
npm run compile
```

Run tests:

```sh
npm test
```

Verify the generated sandbox kits and run the real SDK server from an extracted
VSIX, outside the checkout:

```sh
npm run test:sandbox-package
```

This builds Tauren's extension-host SDK runtime and the sandbox server adapter,
then collects a real VSIX. The server mixin bundles server/shared/JSON-RPC code,
not a second SDK runtime, SDK assets, Jiti, or extension peer shims. Its
`dist/sandboxPi.js` resolver loads the sandbox's existing Pi public SDK through
the first `pi` on `PATH`. The separate generated default Pi descriptor is retained;
production kits remain v2 and shell-test kits remain v3.

The test provisions an independent installed Pi tree outside the checkout and
exposes its correct CLI through a symlink on an isolated test `PATH`. It verifies
missing/incompatible Pi rejection, the actual loaded SDK version in the handshake,
and offline tools/UI, persistence and HTML export. Standalone development tests
continue using the server's pinned SDK normally. The extracted-VSIX gate passes;
it requires `unzip` and the VSIX packaging tool, with no external model calls.
For an already-built artifact, avoid packaging again:

```sh
TAUREN_TEST_VSIX=/absolute/path/tauren.vsix node --test scripts/sandbox-package.test.js
```

Release preflight runs the local extracted-artifact test against its preflight
VSIX. To test the packaged backend in a real VM, run the separate gate on a
host with Docker Sandboxes, OpenSSH, `sbx login`, and `sbx setup ssh`:

```sh
npm run test:sandbox-package:sbx
# Or test an existing artifact:
TAUREN_TEST_VSIX=/absolute/path/tauren.vsix npm run test:sandbox-package:sbx
```

The gate targets stable SBX 0.51 or later within 0.x and records the version it
runs against. That range is an admission check, not a list of verified releases.
The test uses disposable sandboxes and offline model responses. Missing SBX or
an incompatible inspection response fails the gate rather than skipping it.
See [sandbox lifecycle](./sbx-lifecycle.md#sbx-compatibility-limitation) for the
inspection schema that still needs a live capture. The v3 shell-kit transport
tests and the source-kit installation probe are separate checks.

The release script runs the real-SBX gate on the versioned VSIX before committing,
tagging, or publishing. GitHub, VS Code Marketplace, and Open VSX receive that
same archive. Run `npm run test:all` and complete the manual checks below before
releasing. Record the tested SBX version and platform; do not infer parity from
fixture tests.

Build and install a local VSIX:

```sh
npm run install:local
```

Publish a release to GitHub, the VS Code Marketplace, and Open VSX:

```sh
npm run publish -- <version>
```

For example:

```sh
npm run publish -- 1.10.0
```

To create a GitHub release with the VSIX attached without publishing to the VS Code Marketplace or Open VSX, pass `--github-only`:

```sh
npm run publish -- 1.10.0 --github-only
```

This mode still runs the release checks and pushes the release commit and tag. It does not require Marketplace credentials or `OVSX_PAT`. Without the flag, the script publishes to all three destinations. `npm run release` is an alias and accepts the same arguments.

## Manual checks

At minimum, verify:

- sidebar opens,
- Pi starts and model metadata refreshes,
- a prompt streams text,
- Stop works during a response,
- session list opens,
- session diff opens after a file edit,
- settings open,
- extension custom UI still renders if the release touched bridge code.

For Docker Sandboxes, check the Session List Lane and Session Tree Lane, tool
rendering, extension UI, and Session Changes in the Extension Host. Confirm that
`/reload` after a disconnect restores history without replaying a prompt. Repeat
the relevant checks with the in-process Pi and Kward backends.

## Documentation checks

For docs changes:

```sh
npm run docs:build
git diff --check
```

The docs site is deployed to GitHub Pages by `.github/workflows/docs.yml` after changes are pushed to `main`.
