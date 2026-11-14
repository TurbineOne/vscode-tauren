import { spawn } from 'node:child_process';
import path from 'node:path';

/** Configured as data, not a shell command string. Workspace settings UI is wired
 * separately; all callers must supply the current workspace trust decision.
 */
export interface CommandProviderConfiguration { executable: string; args: string[] }
export interface CommandProviderResult { version: 1; argv: string[] }
export interface ProviderExecutionOptions {
  workspace: string;
  workspaceTrusted: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/** Validate one JSON response, rejecting banners, extra objects and unsupported
 * versions. Method-specific SBX argv validation belongs to commandComposition.
 */
export function parseCommandProviderResponse(stdout: string): CommandProviderResult {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error('Sandbox command provider must print one JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sandbox command provider response');
  const result = value as Record<string, unknown>;
  if (result.version !== 1) throw new Error('Unsupported sandbox command provider response version');
  if (Object.keys(result).some(key => key !== 'version' && key !== 'argv') || !Array.isArray(result.argv)
    || result.argv.length < 2 || !result.argv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'))) {
    throw new Error('Sandbox command provider argv must be an array of nonempty strings');
  }
  return { version: 1, argv: [...result.argv] as string[] };
}

/** Run a host provider directly, never through shell parsing. Trust is checked
 * before spawning because even a JSON-producing workspace command executes code.
 * Bound stdout/stderr and lifetime; do not echo provider output that may contain
 * secrets. Successful stderr remains available for deliberate diagnostic handling.
 */
export async function runCommandProvider(configuration: CommandProviderConfiguration, options: ProviderExecutionOptions): Promise<{
  response: CommandProviderResult; stderr: string;
}> {
  if (!options.workspaceTrusted) throw new Error('Trust this workspace before running its sandbox command provider');
  if (!configuration || typeof configuration.executable !== 'string' || !configuration.executable.trim()
    || configuration.executable.includes('\0') || !Array.isArray(configuration.args)
    || !configuration.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Error('Sandbox command provider requires an executable and an argument array');
  }
  if (!options.workspace.startsWith('/') || options.workspace.includes('\0')) throw new Error('Provider cwd must be an absolute workspace');
  if (options.signal?.aborted) throw new Error('Sandbox command provider cancelled');
  const timeout = options.timeoutMs ?? 30_000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid provider execution limits');
  return new Promise((resolve, reject) => {
    const child = spawn(configuration.executable, configuration.args, {
      cwd: options.workspace, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
      // A misbehaving provider may leave a descendant holding inherited pipes.
      // Do not wait for those pipes indefinitely after the provider is stopped.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abort = () => stop('Sandbox command provider cancelled');
    const timer = setTimeout(() => stop('Sandbox command provider timed out'), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (target: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > limit) stop('Sandbox command provider output limit exceeded');
      else target.push(data);
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    child.once('error', () => { failure ??= new Error('Could not start sandbox command provider'); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Sandbox command provider failed (${signal ?? code})`)); return; }
      try { resolve({ response: parseCommandProviderResponse(Buffer.concat(stdout).toString('utf8')), stderr: Buffer.concat(stderr).toString('utf8') }); }
      catch (error) { reject(error); }
    });
    if (options.signal?.aborted) abort();
  });
}

/** Resolve the stable installed resource layout without importing VS Code. */
export function packagedSandboxKits(extensionDirectory: string): { sandboxKitDirectory: string; serverMixinDirectory: string } {
  if (!path.posix.isAbsolute(extensionDirectory) || extensionDirectory.includes('\0')) throw new Error('Extension directory must be absolute');
  return { sandboxKitDirectory: path.join(extensionDirectory, 'resources/generated-sbx-sandbox'),
    serverMixinDirectory: path.join(extensionDirectory, 'resources/generated-sbx-kit') };
}

/** Built-in provider selects the packaged default Pi sandbox kit. Composition
 * adds the independent server mixin and Tauren-owned mounts/env for all providers.
 */
export function defaultCommandProvider(sandboxKitDirectory: string): CommandProviderResult {
  if (!sandboxKitDirectory.startsWith('/') || sandboxKitDirectory.includes('\0')) throw new Error('Default sandbox kit path must be absolute');
  return { version: 1, argv: ['sbx', '--no-input', 'create', sandboxKitDirectory] };
}
