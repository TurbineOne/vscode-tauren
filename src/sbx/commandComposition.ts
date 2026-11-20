import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { type CommandProviderResult, parseCommandProviderResponse } from './commandProvider';

export interface SandboxCommandConfiguration {
  sandboxName: string;
  workspace: string;
  sessionDirectory: string;
  serverMixinDirectory: string;
}
export interface SandboxCommand { executable: string; args: string[] }

// Deliberately supported CLI subset, not a generic SBX/shell parser. Unknown
// option arity must fail rather than accidentally turning its value into a mount.
const valueOptions = new Map([
  ['--name', '--name'], ['--kit', '--kit'], ['--env', '--env'], ['-e', '--env'],
  ['--publish', '--publish'], ['-p', '--publish'], ['--cpus', '--cpus'],
  ['--memory', '--memory'], ['-m', '--memory']
]);
const booleanOptions = new Map([['--detach', '--detach'], ['-d', '--detach']]);
const repeatable = new Set(['--kit', '--env', '--publish']);

/** Lexical containment for canonical absolute host/VM paths. */
function contains(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}
function absolute(value: string): string {
  if (!path.posix.isAbsolute(value) || value.includes('\0') || value.includes(':')) {
    throw new Error('SBX workspace and kit paths must be absolute POSIX paths without colons');
  }
  return path.posix.normalize(value);
}
/** Follow existing symlinks without requiring lifecycle-owned paths to exist. */
async function canonical(value: string): Promise<string> {
  const normalized = absolute(value);
  try { return await realpath(normalized); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(normalized);
    if (parent === normalized) throw error;
    return path.join(await canonical(parent), path.basename(normalized));
  }
}

/** Compose a creation command without invoking SBX. The provider supplies MAIN_KIT
 * and optional additional workspaces, but omits Tauren's project/store/mixin/env.
 * Preserve option/value pairs and insert the project as the first workspace even
 * when the provider placed options after positionals. No shell is involved.
 */
export async function composeSandboxCommand(response: CommandProviderResult, config: SandboxCommandConfiguration): Promise<SandboxCommand> {
  const { argv } = parseCommandProviderResponse(JSON.stringify(response));
  const executable = argv[0];
  if (path.basename(executable) !== 'sbx' || (executable !== 'sbx' && !path.isAbsolute(executable))) {
    throw new Error('Provider executable must be sbx or an absolute path to sbx');
  }
  let index = 1;
  const hadNoInput = argv[index] === '--no-input';
  if (hadNoInput) index++;
  const command = argv[index++];
  if (command !== 'create' && command !== 'run') throw new Error('Provider must describe sbx create or sbx run -d');
  if (!/^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/.test(config.sandboxName)) throw new Error('Invalid sandbox name');
  const workspace = await canonical(config.workspace);
  const sessions = await canonical(config.sessionDirectory);
  const mixin = await canonical(config.serverMixinDirectory);
  if (contains(workspace, sessions)) throw new Error('Session directory must be outside workspace');
  const options: string[] = [];
  const positionals: string[] = [];
  const seen = new Set<string>(hadNoInput ? ['--no-input'] : []);
  const envKeys = new Set<string>();
  const kits = new Set<string>();
  let hasName = false;
  let detached = false;
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--no-input') {
      if (seen.has('--no-input')) throw new Error('Repeated --no-input');
      seen.add('--no-input'); continue;
    }
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    if (token === '--clone') {
      throw new Error('Tauren requires a direct workspace mount for Docker Sandboxes. Remove --clone from the command provider.');
    }
    const option = valueOptions.get(token) ?? booleanOptions.get(token);
    if (!option) throw new Error(`Unsupported SBX provider option: ${token}`);
    if (seen.has(option) && !repeatable.has(option)) throw new Error(`Repeated SBX provider option: ${option}`);
    seen.add(option);
    if (booleanOptions.has(token)) {
      if (option === '--detach') {
        if (command !== 'run') throw new Error('detach applies only to sbx run');
        detached = true;
      }
      options.push(token); continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${token}`);
    if (option === '--name') {
      if (value !== config.sandboxName) throw new Error('Provider sandbox name conflicts with Tauren');
      hasName = true;
    }
    if (option === '--env') {
      const equal = value.indexOf('=');
      const key = equal < 0 ? value : value.slice(0, equal);
      if (key === 'PI_CODING_AGENT_SESSION_DIR') throw new Error('Provider must omit Tauren session environment');
      if (equal < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Provider environment requires explicit KEY=VALUE');
      if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) throw new Error('Provider must not supply credential environment values');
      if (envKeys.has(key)) throw new Error('Repeated provider environment assignment');
      envKeys.add(key);
    }
    if (option === '--kit') {
      const kit = path.isAbsolute(value) ? await canonical(value) : value;
      if (kit === mixin) throw new Error('Provider must omit Tauren server mixin');
      if (kits.has(kit)) throw new Error('Repeated provider mixin');
      kits.add(kit);
    }
    if (option === '--cpus' && !/^\d+$/.test(value)) throw new Error('Invalid CPU count');
    if (option === '--memory' && !/^\d+[kmgt]?$/i.test(value)) throw new Error('Invalid memory size');
    options.push(token, value);
  }
  if (command === 'run' && !detached) throw new Error('Provider sbx run must specify -d or --detach');
  const mainKit = positionals.shift();
  if (!mainKit || mainKit.includes('\0')) throw new Error('Provider must supply a main sandbox kit');
  if (mainKit.includes('${') || mainKit.includes('@@@@')) throw new Error('Provider kit must be literal, not a placeholder');
  if (path.isAbsolute(mainKit) && await canonical(mainKit) === mixin) throw new Error('Server mixin cannot be the main sandbox kit');
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const mount of positionals) {
    const parts = mount.split(':');
    if (parts.length > 3 || !parts[0] || parts.some(part => !part) || (parts.length === 3 && parts[2] !== 'ro')) throw new Error('Invalid additional workspace');
    const source = await canonical(parts[0]);
    const target = parts[1] && parts[1] !== 'ro' ? absolute(parts[1]) : source;
    if (parts.length === 3 && parts[1] === 'ro') throw new Error('Invalid additional workspace target');
    // A provider must not sneak the controlled mounts back in under another
    // spelling/target, or expose the store through a broader additional mount.
    if (contains(source, workspace) || contains(workspace, source) || contains(source, sessions) || contains(sessions, source)
      || contains(target, workspace) || contains(workspace, target) || contains(target, sessions) || contains(sessions, target)) {
      throw new Error('Provider workspace conflicts with Tauren-owned workspace/session mounts');
    }
    if (sources.has(source) || targets.has(target)) throw new Error('Repeated additional workspace source or target');
    if ([...targets].some(existing => contains(existing, target) || contains(target, existing))) {
      throw new Error('Overlapping additional workspace targets');
    }
    sources.add(source); targets.add(target);
  }
  return { executable, args: ['--no-input', command, ...options,
    ...(!hasName ? ['--name', config.sandboxName] : []), '--kit', config.serverMixinDirectory,
    '--env', `PI_CODING_AGENT_SESSION_DIR=${sessions}`, mainKit, workspace, sessions, ...positionals] };
}
