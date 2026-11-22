import path from 'node:path';
import {
  buildSbxCreateArgv,
  validateCommandProviderSpec,
  type PiSbxCommandSpecV1
} from './commandProvider';
import {
  canonicalDirectory,
  containsPath,
  isValidSandboxName,
  normalizeSandboxName,
  resolveExistingWorkspace,
  resolveStorageRoot,
  validateHostPath
} from './configuration';

export interface SandboxCommandConfiguration {
  workspace: string;
  serverMixinDirectory: string;
  sandboxKitDirectory?: string;
  storageRoot?: string;
  homeDirectory?: string;
  /** Optional explicit sandbox name override (tauren.sbx.sandboxName). Overrides options.name when defined. */
  sandboxName?: string;
  /** Optional fallback session directory when options.env.PI_CODING_AGENT_SESSION_DIR is not set. */
  sessionDirectory?: string;
}

export interface SandboxCommand {
  executable: string;
  args: string[];
}

export interface ComposedSandboxCommand extends SandboxCommand {
  sandboxName: string;
  workspace: string;
  sessionDirectory: string;
  env: Record<string, string>;
  spec: PiSbxCommandSpecV1;
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;
const credentialKeyPattern = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

interface ParsedMount {
  source: string;
  target: string;
  explicitTarget?: string;
  readOnly: boolean;
}

function validateExecutableAndSubcommand(command: string[]): string {
  const executable = command[0];
  if (path.posix.basename(executable) !== 'sbx' || (executable !== 'sbx' && !path.posix.isAbsolute(executable))) {
    throw new Error('Provider executable must be sbx or an absolute path to sbx');
  }
  if (command.length !== 2 || command[1] !== 'create') {
    throw new Error('Provider command must describe sbx create');
  }
  return executable;
}

async function resolveAgentKit(rawAgent: string, mixin: string, sandboxKitDirectory?: string): Promise<string> {
  if (rawAgent.includes('${') || rawAgent.includes('@@@@') || rawAgent.startsWith('-')) {
    throw new Error('Provider kit must be literal, not a placeholder or flag');
  }
  const agent = rawAgent === '@tauren/bundled-pi-kit'
    ? await canonicalDirectory(sandboxKitDirectory ?? '', 'Bundled sandbox kit directory')
    : (path.posix.isAbsolute(rawAgent) ? await canonicalDirectory(rawAgent, 'Agent kit directory') : rawAgent);
  if (path.posix.isAbsolute(agent) && agent === mixin) {
    throw new Error('Server mixin cannot be the main sandbox kit');
  }
  return agent;
}

function resolveSandboxIdentity(workspace: string, providerName: string | undefined, overrideName: string | undefined): string {
  if (overrideName !== undefined) {
    if (!isValidSandboxName(overrideName)) throw new Error('Invalid sandbox name');
    return overrideName;
  }
  if (providerName !== undefined && providerName !== null) {
    if (!isValidSandboxName(providerName)) throw new Error('Invalid sandbox name');
    return providerName;
  }
  return normalizeSandboxName(workspace);
}

async function resolveSandboxEnvironment(
  rawEnv: Record<string, string> | undefined,
  workspace: string,
  sandboxName: string,
  config: SandboxCommandConfiguration
): Promise<{ env: Record<string, string>; sessionDirectory: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv ?? {})) {
    if (!envNamePattern.test(key)) {
      throw new Error(`Invalid provider environment variable name: ${key}`);
    }
    if (credentialKeyPattern.test(key)) {
      throw new Error('Provider must not supply credential environment values');
    }
    env[key] = value;
  }

  let sessionDirectory: string;
  if (Object.hasOwn(env, 'PI_CODING_AGENT_SESSION_DIR')) {
    sessionDirectory = await canonicalDirectory(env.PI_CODING_AGENT_SESSION_DIR, 'Session directory');
  } else if (config.sessionDirectory !== undefined) {
    sessionDirectory = await canonicalDirectory(config.sessionDirectory, 'Session directory');
  } else {
    const storageRoot = await resolveStorageRoot(config.storageRoot, config.homeDirectory);
    sessionDirectory = await canonicalDirectory(path.posix.join(storageRoot, sandboxName, 'sessions'), 'Session directory');
  }
  if (containsPath(workspace, sessionDirectory)) {
    throw new Error('Session directory must be outside workspace');
  }
  if (Object.hasOwn(env, 'PI_CODING_AGENT_DIR')) {
    env.PI_CODING_AGENT_DIR = await canonicalDirectory(env.PI_CODING_AGENT_DIR, 'Agent directory');
  }
  env.PI_CODING_AGENT_SESSION_DIR = sessionDirectory;
  return { env, sessionDirectory };
}

async function resolveMixinKits(rawKits: string[] | undefined, mixin: string): Promise<string[]> {
  const normalizedKits: string[] = [];
  const seenKits = new Set<string>();
  for (const item of rawKits ?? []) {
    if (item.includes('${') || item.includes('@@@@') || item.startsWith('-')) {
      throw new Error('Provider mixin kit must be literal, not a placeholder or flag');
    }
    const normalized = path.posix.isAbsolute(item) ? await canonicalDirectory(item, 'Mixin kit directory') : item;
    if (normalized === mixin) {
      throw new Error('Provider must omit Tauren server mixin');
    }
    if (seenKits.has(normalized)) {
      throw new Error('Repeated provider mixin');
    }
    seenKits.add(normalized);
    normalizedKits.push(normalized);
  }
  return [...normalizedKits, mixin];
}

async function parseWorkspaceMount(mount: string): Promise<ParsedMount> {
  const parts = mount.split(':');
  if (parts.length > 3 || !parts[0] || parts.some(part => !part)
    || (parts.length === 3 && (parts[2] !== 'ro' || parts[1] === 'ro'))) {
    throw new Error('Invalid workspace mount');
  }
  const source = await canonicalDirectory(parts[0], 'Workspace mount source');
  const readOnly = parts[1] === 'ro' || parts[2] === 'ro';
  let explicitTarget: string | undefined;
  if (parts[1] && parts[1] !== 'ro') {
    validateHostPath(parts[1], 'Workspace mount target');
    explicitTarget = path.posix.normalize(parts[1]);
  }
  return { source, target: explicitTarget ?? source, explicitTarget, readOnly };
}

function overlapsEither(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

async function resolveWorkspaceMounts(
  rawWorkspaces: string[],
  workspace: string,
  sessionDirectory: string
): Promise<string[]> {
  if (rawWorkspaces.length === 0) {
    return [workspace, sessionDirectory];
  }
  const primary = await parseWorkspaceMount(rawWorkspaces[0]);
  if (primary.readOnly || primary.source !== workspace || primary.target !== workspace) {
    throw new Error('Provider primary workspace must match the open Tauren workspace and be writable');
  }

  const sources = new Set<string>();
  const targets = new Set<string>();
  const extraWorkspaces: string[] = [];
  let hasSessionMount = false;

  for (const rawMount of rawWorkspaces.slice(1)) {
    const mount = await parseWorkspaceMount(rawMount);
    if (overlapsEither(mount.source, workspace) || overlapsEither(mount.target, workspace)) {
      throw new Error('Provider workspace conflicts with Tauren primary workspace');
    }
    if (mount.source === sessionDirectory || mount.target === sessionDirectory) {
      if (mount.source !== sessionDirectory || mount.target !== sessionDirectory || mount.readOnly) {
        throw new Error('Session directory mount must map the resolved session directory to itself and be writable');
      }
      if (hasSessionMount) {
        throw new Error('Repeated additional workspace source or target');
      }
      hasSessionMount = true;
      sources.add(mount.source);
      targets.add(mount.target);
      extraWorkspaces.push(sessionDirectory);
      continue;
    }
    if (overlapsEither(mount.source, sessionDirectory) || overlapsEither(mount.target, sessionDirectory)) {
      throw new Error('Provider workspace conflicts with session directory mount');
    }
    if (sources.has(mount.source) || targets.has(mount.target)) {
      throw new Error('Repeated additional workspace source or target');
    }
    if ([...targets].some(existing => overlapsEither(existing, mount.target))) {
      throw new Error('Overlapping additional workspace targets');
    }
    sources.add(mount.source);
    targets.add(mount.target);
    extraWorkspaces.push(`${mount.source}${mount.explicitTarget ? `:${mount.explicitTarget}` : ''}${mount.readOnly ? ':ro' : ''}`);
  }

  return hasSessionMount
    ? [workspace, ...extraWorkspaces]
    : [workspace, sessionDirectory, ...extraWorkspaces];
}

function buildComposedOptions(
  rawOptions: PiSbxCommandSpecV1['options'],
  kits: string[],
  sandboxName: string,
  env: Record<string, string>
): PiSbxCommandSpecV1['options'] {
  const composedOptions: PiSbxCommandSpecV1['options'] = {};
  for (const [key, value] of Object.entries(rawOptions)) {
    if (key === 'kit' || key === 'name' || key === 'env' || key === 'no-input' || key === 'clone') {
      continue;
    }
    if (value === undefined || value === null || value === false) {
      continue;
    }
    composedOptions[key] = Array.isArray(value)
      ? [...value]
      : (typeof value === 'object' ? { ...value } : value);
  }
  composedOptions.kit = kits;
  composedOptions.name = sandboxName;
  composedOptions.env = env;
  composedOptions['no-input'] = true;
  return composedOptions;
}

/** Compose a Version 1 command provider specification with Tauren's server mixin
 * and resolved configuration without invoking SBX or a shell. Values defined by
 * the provider, including options.name and PI_CODING_AGENT_SESSION_DIR, override
 * Tauren's generated defaults unless an explicit Tauren override is configured.
 */
export async function composeSandboxCommand(
  response: PiSbxCommandSpecV1,
  config: SandboxCommandConfiguration
): Promise<ComposedSandboxCommand> {
  const spec = validateCommandProviderSpec(response);
  const executable = validateExecutableAndSubcommand(spec.command);
  if (spec.options.clone !== undefined && spec.options.clone !== null && spec.options.clone !== false) {
    throw new Error('Tauren requires a direct workspace mount for Docker Sandboxes. Remove --clone from the command provider.');
  }

  const workspace = await resolveExistingWorkspace(config.workspace);
  const mixin = await canonicalDirectory(config.serverMixinDirectory, 'Server mixin directory');
  const agent = await resolveAgentKit(spec.agent, mixin, config.sandboxKitDirectory);
  const sandboxName = resolveSandboxIdentity(workspace, spec.options.name, config.sandboxName);
  const { env, sessionDirectory } = await resolveSandboxEnvironment(spec.options.env, workspace, sandboxName, config);
  const kits = await resolveMixinKits(spec.options.kit, mixin);
  const workspaces = await resolveWorkspaceMounts(spec.workspaces, workspace, sessionDirectory);

  const composedSpec: PiSbxCommandSpecV1 = {
    version: 1,
    command: [executable, 'create'],
    agent,
    workspaces,
    options: buildComposedOptions(spec.options, kits, sandboxName, env)
  };

  const [resolvedExecutable, ...args] = buildSbxCreateArgv(composedSpec);
  return {
    executable: resolvedExecutable,
    args,
    sandboxName,
    workspace,
    sessionDirectory,
    env: { ...env },
    spec: composedSpec
  };
}
