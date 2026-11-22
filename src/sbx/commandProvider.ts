import { spawn } from 'node:child_process';
import path from 'node:path';

/** Configured as data, not a shell command string. Workspace settings UI is wired
 * separately; all callers must supply the current workspace trust decision.
 */
export interface CommandProviderConfiguration {
  executable: string;
  args: string[];
}

export type CommandProviderOptionValue =
  | boolean
  | string
  | number
  | string[]
  | Record<string, string>
  | null
  | undefined;

export interface PiSbxCommandSpecV1 {
  version: 1;
  command: string[];
  agent: string;
  workspaces: string[];
  options: {
    kit?: string[];
    name?: string;
    env?: Record<string, string>;
    [flag: string]: CommandProviderOptionValue;
  };
}

export type CommandProviderResult = PiSbxCommandSpecV1;

export interface ProviderExecutionOptions {
  workspace: string;
  workspaceTrusted: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const topLevelKeys = new Set(['version', 'command', 'agent', 'workspaces', 'options']);
const longOptionFlag = /^[A-Za-z0-9][A-Za-z0-9-]*(?![\s\S])/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptySafeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isSafeString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function cloneStringMap(value: unknown, errorLabel: string): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid sandbox command provider ${errorLabel}`);
  }
  const record: Record<string, string> = {};
  for (const [subKey, subVal] of Object.entries(value)) {
    if (!isNonEmptySafeString(subKey) || subKey.includes('=') || !isSafeString(subVal)) {
      throw new Error(`Invalid sandbox command provider ${errorLabel} entry: ${subKey}`);
    }
    record[subKey] = subVal;
  }
  return record;
}

function validateOptionValue(key: string, optionValue: unknown): CommandProviderOptionValue {
  if (optionValue === null || typeof optionValue === 'boolean') {
    return optionValue;
  }
  if (key === 'kit') {
    if (!Array.isArray(optionValue) || !optionValue.every(isNonEmptySafeString)) {
      throw new Error('Sandbox command provider options.kit must be an array of nonempty strings');
    }
    return [...optionValue];
  }
  if (key === 'name') {
    if (!isNonEmptySafeString(optionValue)) {
      throw new Error('Sandbox command provider options.name must be a nonempty string');
    }
    return optionValue;
  }
  if (key === 'env') {
    return cloneStringMap(optionValue, 'environment');
  }
  if (typeof optionValue === 'number') {
    if (!Number.isFinite(optionValue)) {
      throw new Error(`Invalid sandbox command provider numeric option: ${key}`);
    }
    return optionValue;
  }
  if (typeof optionValue === 'string') {
    if (!isSafeString(optionValue)) {
      throw new Error(`Invalid sandbox command provider string option: ${key}`);
    }
    return optionValue;
  }
  if (Array.isArray(optionValue)) {
    if (!optionValue.every(isNonEmptySafeString)) {
      throw new Error(`Invalid sandbox command provider array option: ${key}`);
    }
    return [...optionValue];
  }
  if (isPlainObject(optionValue)) {
    return cloneStringMap(optionValue, `map option ${key}`);
  }
  throw new Error(`Invalid sandbox command provider option value for ${key}`);
}

function validateOptionsObject(rawOptions: unknown): PiSbxCommandSpecV1['options'] {
  if (!isPlainObject(rawOptions)) {
    throw new Error('Sandbox command provider options must be an object');
  }
  const options: PiSbxCommandSpecV1['options'] = {};
  for (const [key, optionValue] of Object.entries(rawOptions)) {
    if (!longOptionFlag.test(key)) {
      throw new Error(`Invalid sandbox command provider option key: ${key}`);
    }
    if (optionValue !== undefined) {
      options[key] = validateOptionValue(key, optionValue);
    }
  }
  return options;
}

/** Validate a decoded Version 1 command provider specification and return a defensive copy. */
export function validateCommandProviderSpec(value: unknown): PiSbxCommandSpecV1 {
  if (!isPlainObject(value)) {
    throw new Error('Invalid sandbox command provider response');
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported sandbox command provider response version: ${String(value.version)}`);
  }
  const keys = Object.keys(value);
  if (keys.length !== topLevelKeys.size || keys.some(key => !topLevelKeys.has(key))) {
    throw new Error('Invalid sandbox command provider response: expected version, command, agent, workspaces, and options');
  }
  if (!Array.isArray(value.command) || value.command.length < 2 || !value.command.every(isNonEmptySafeString)) {
    throw new Error('Sandbox command provider command must be an array of nonempty strings');
  }
  if (!isNonEmptySafeString(value.agent)) {
    throw new Error('Sandbox command provider agent must be a nonempty string');
  }
  if (!Array.isArray(value.workspaces) || !value.workspaces.every(isNonEmptySafeString)) {
    throw new Error('Sandbox command provider workspaces must be an array of nonempty strings');
  }

  return {
    version: 1,
    command: [...value.command],
    agent: value.agent,
    workspaces: [...value.workspaces],
    options: validateOptionsObject(value.options)
  };
}

/** Validate one JSON response, rejecting banners, extra objects and unsupported
 * versions. Semantic SBX checks and Tauren composition belong to commandComposition.
 */
export function parseCommandProviderResponse(stdout: string): PiSbxCommandSpecV1 {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error('Sandbox command provider must print one JSON object'); }
  return validateCommandProviderSpec(value);
}

/** Convert a Version 1 specification into an argv array suitable for execFile/spawn. */
export function buildSbxCreateArgv(spec: PiSbxCommandSpecV1): string[] {
  if (spec.version !== 1) {
    throw new Error(`Unsupported pi-sbx command spec version: ${String(spec.version)}`);
  }

  const argv: string[] = [...spec.command, spec.agent, ...spec.workspaces];

  for (const [key, value] of Object.entries(spec.options)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    const flag = `--${key}`;
    if (value === true) {
      argv.push(flag);
    } else if (typeof value === 'string' || typeof value === 'number') {
      argv.push(flag, String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        argv.push(flag, String(item));
      }
    } else {
      for (const [subKey, subVal] of Object.entries(value)) {
        argv.push(flag, `${subKey}=${subVal}`);
      }
    }
  }

  return argv;
}

const providerQueues = new Map<string, Promise<void>>();

async function serializeWorkspaceProvider<T>(workspace: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const previous = providerQueues.get(workspace) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  providerQueues.set(workspace, queued);
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(new Error('Sandbox command provider cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
    if (signal?.aborted) throw new Error('Sandbox command provider cancelled');
    return await work();
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    release();
    void queued.then(() => { if (providerQueues.get(workspace) === queued) providerQueues.delete(workspace); });
  }
}

/** Run a host provider directly, never through shell parsing. Trust is checked
 * before spawning because even a JSON-producing workspace command executes code.
 * Bound stdout/stderr and lifetime; do not echo provider output that may contain
 * secrets. Successful stderr remains available for deliberate diagnostic handling.
 */
export async function runCommandProvider(configuration: CommandProviderConfiguration, options: ProviderExecutionOptions): Promise<{
  response: PiSbxCommandSpecV1; stderr: string;
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
  return serializeWorkspaceProvider(options.workspace, options.signal, () => new Promise((resolve, reject) => {
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
  }));
}

/** Resolve the stable installed resource layout without importing VS Code. */
export function packagedSandboxKits(extensionDirectory: string): { sandboxKitDirectory: string; serverMixinDirectory: string } {
  if (!path.posix.isAbsolute(extensionDirectory) || extensionDirectory.includes('\0')) throw new Error('Extension directory must be absolute');
  return { sandboxKitDirectory: path.join(extensionDirectory, 'resources/generated-sbx-sandbox'),
    serverMixinDirectory: path.join(extensionDirectory, 'resources/generated-sbx-kit') };
}

/** Built-in provider selects the packaged default Pi sandbox kit. Composition
 * adds the independent server mixin and Tauren-owned defaults when omitted.
 */
export function defaultCommandProvider(sandboxKitDirectory: string): PiSbxCommandSpecV1 {
  if (!sandboxKitDirectory.startsWith('/') || sandboxKitDirectory.includes('\0')) throw new Error('Default sandbox kit path must be absolute');
  return {
    version: 1,
    command: ['sbx', 'create'],
    agent: sandboxKitDirectory,
    workspaces: [],
    options: { 'no-input': true }
  };
}
