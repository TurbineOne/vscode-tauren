const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/** npm's production listing can include dev dependencies of linked packages.
 * Use the lockfile to exclude those packages without touching bundled assets.
 */
function developmentPackagePaths(lock) {
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error('Packaging requires a package-lock.json with a packages map.');
  }
  const installed = Object.entries(lock.packages).filter(([name]) => name.startsWith('node_modules/'));
  const runtime = installed.filter(([, entry]) => entry.dev !== true).map(([name]) => name);
  return installed.filter(([, entry]) => entry.dev === true).map(([name]) => {
    if (!/^(?:node_modules\/(?:@[\w.-]+\/)?[\w.-]+\/)*node_modules\/(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
      || name.split('/').some(part => part === '.' || part === '..')) {
      throw new Error(`Unexpected package path in lockfile: ${name}`);
    }
    if (runtime.some(other => other.startsWith(`${name}/`))) {
      throw new Error(`Cannot exclude ${name}: it contains a runtime dependency.`);
    }
    return name;
  });
}

function packageVsix(output) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tauren-vsix-'));
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const baseIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    const ignoreFile = path.join(directory, 'vscodeignore');
    const exclusions = developmentPackagePaths(lock).map(name => `${name}/**`);
    fs.writeFileSync(ignoreFile, `${baseIgnore.trimEnd()}\n\n${exclusions.join('\n')}\n`);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(npx, ['--yes', '@vscode/vsce', 'package', '--out', output, '--ignoreFile', ignoreFile], {
      cwd: root, stdio: 'inherit', shell: process.platform === 'win32'
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  // Accept just an output path, so VSCE options cannot override the filter.
  const [option, output, ...extra] = process.argv.slice(2);
  if (option !== '--out' || !output || extra.length) {
    console.error('Usage: npm run package:vsix -- --out <file.vsix>');
    process.exitCode = 1;
  } else {
    process.exitCode = packageVsix(path.resolve(output));
  }
}

module.exports = { developmentPackagePaths };
