const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

/** Resolve the installed package in both real consumers, not relative source paths. */
test('local consumers resolve CommonJS and ESM shared package exports', async () => {
  const root = path.resolve(__dirname, '../..');
  for (const [cwd, mode] of [[root, 'commonjs'], [path.join(root, 'sandbox-server'), 'module']]) {
    const code = mode === 'module'
      ? "import { PiAutocompleteRegistry } from '@tauren/shared/completion/piAutocompleteRegistry'; console.log(new PiAutocompleteRegistry().getCapabilities().triggerCharacters[0]);"
      : "const { PiAutocompleteRegistry } = require('@tauren/shared/completion/piAutocompleteRegistry'); console.log(new PiAutocompleteRegistry().getCapabilities().triggerCharacters[0]);";
    assert.equal(execFileSync(process.execPath, [`--input-type=${mode}`, '-e', code], { cwd, encoding: 'utf8' }).trim(), '@');
  }
});

/** Existing helpers stay dependency-free; protocol needs only its declared JSON-RPC dependency. */
test('packed shared helpers and protocol contain both formats and work outside the checkout', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tauren-shared-package-'));
  try {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { 'vscode-jsonrpc': '8.2.1' });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }))[0];
    assert.ok(packed.files.some(file => file.path === 'dist/esm/package.json'));
    assert.ok(!packed.files.some(file => file.path.startsWith('src/')));
    const installed = path.join(directory, 'node_modules/@tauren/shared');
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(directory, packed.filename), '--strip-components=1', '-C', installed]);
    writeFileSync(path.join(directory, 'check.cjs'), "require('@tauren/shared/rendering/piSdkRendering'); require('@tauren/shared/sessions/sessionSummaryParser');");
    writeFileSync(path.join(directory, 'check.mjs'), "import '@tauren/shared/rendering/piSdkRendering'; import '@tauren/shared/sessions/sessionSummaryParser';");
    for (const file of ['check.cjs', 'check.mjs']) execFileSync(process.execPath, [file], { cwd: directory });
    // Nested resolution is sufficient: neither consumer needs a direct dependency.
    cpSync(path.dirname(require.resolve('vscode-jsonrpc/package.json')),
      path.join(installed, 'node_modules/vscode-jsonrpc'), { recursive: true });
    const check = `
      const assert = MODE_ASSERT;
      MODE_IMPORT
      assert.equal(protocol.PROTOCOL_VERSION, 1);
      assert.equal(protocol.Requests.prompt.method, 'chat.prompt');
      assert.equal(typeof protocol.createProtocolConnection, 'function');
      assert.throws(() => protocol.assertProtocolVersion(0), protocol.ResponseError);
      const cancellation = new protocol.CancellationTokenSource();
      cancellation.cancel();
      assert.equal(cancellation.token.isCancellationRequested, true);
      cancellation.dispose();
    `;
    writeFileSync(path.join(directory, 'protocol.cjs'), check
      .replace('MODE_ASSERT', "require('node:assert/strict')")
      .replace('MODE_IMPORT', "const protocol = require('@tauren/shared/sbx/protocol');"));
    writeFileSync(path.join(directory, 'protocol.mjs'), check
      .replace('const assert = MODE_ASSERT;', "import assert from 'node:assert/strict';")
      .replace('MODE_IMPORT', "import * as protocol from '@tauren/shared/sbx/protocol';"));
    for (const file of ['protocol.cjs', 'protocol.mjs']) execFileSync(process.execPath, [file], { cwd: directory });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
