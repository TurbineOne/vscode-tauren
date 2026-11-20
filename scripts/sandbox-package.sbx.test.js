// This opt-in gate uses a real SBX host. It must fail, not skip, when prerequisites are missing.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const exec = promisify(execFile);

/** Run bounded host commands without a shell. Keep command output out of failure
 * messages: host tooling may print credentials or other sensitive configuration.
 */
async function run(executable, args, { cwd = root, timeoutMs = 120_000, env = process.env } = {}) {
  try {
    return await exec(executable, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${path.basename(executable)} failed (${error.killed ? 'deadline exceeded' : error.code ?? error.signal ?? 'unknown error'}).`);
  }
}

test('packaged Tauren backend on real Docker Sandboxes', { timeout: 1_800_000 }, async t => {
  const sbx = process.env.SBX_PATH || 'sbx';
  const ssh = process.env.SSH_PATH || 'ssh';
  let version;
  try {
    version = (await run(sbx, ['--version'], { timeoutMs: 5000 })).stdout.trim();
    await run(ssh, ['-V'], { timeoutMs: 5000 });
    await run(sbx, ['ls', '--json'], { timeoutMs: 20_000 });
  } catch (error) {
    throw new Error('Real SBX tests require sbx and OpenSSH on the host, sbx login, and sbx setup ssh.', { cause: error });
  }
  const match = /^(?:sbx(?: version)?\s+)?v?0\.(\d+)\.(\d+)(?:\s|$)/.exec(version);
  assert(match && Number(match[1]) >= 51, 'Expected stable SBX 0.51 or newer within 0.x');
  t.diagnostic(`SBX version under test: 0.${match[1]}.${match[2]}`);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tauren-packaged-sbx-'));
  try {
    const archive = process.env.TAUREN_TEST_VSIX
      ? path.resolve(process.env.TAUREN_TEST_VSIX) : path.join(directory, 'tauren.vsix');
    if (!process.env.TAUREN_TEST_VSIX) {
      await run(process.execPath, ['scripts/package-vsix.js', '--out', archive], { timeoutMs: 600_000 });
    }
    const { stdout } = await run('unzip', ['-Z1', archive]);
    const members = stdout.trimEnd().split(/\r?\n/);
    assert.equal(new Set(members).size, members.length, 'VSIX has duplicate members');
    assert(members.every(member => member && !/[\\\x00-\x1f]/.test(member) && !path.posix.isAbsolute(member)
      && !/^[A-Za-z]:/.test(member) && !member.split('/').some(part => part === '..' || part === '.')), 'Unsafe VSIX member');
    const listing = await run('unzip', ['-Z', '-l', archive]);
    assert(!/^l[rwxstST-]{9}\s/m.test(listing.stdout), 'VSIX contains symlinks');
    await run('unzip', ['-q', archive, '-d', directory]);
    const extension = path.join(directory, 'extension');
    for (const file of ['out/sbx/sbxClient.js', 'resources/generated-sbx-kit/spec.yaml',
      'resources/generated-sbx-kit/files/home/.tauren/server/dist/main.js', 'resources/generated-sbx-sandbox/spec.yaml']) {
      assert((await fs.stat(path.join(extension, file))).isFile(), `Missing VSIX file: ${file}`);
    }
    const { exercisePackagedSandbox } = require('./test-helpers/packaged-sbx-scenarios');
    await exercisePackagedSandbox({ extension, run, sbx, ssh, t });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
