import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface SandboxPathOptions {
  workspace: string;
  storageRoot?: string;
  sandboxName?: string;
  homeDirectory?: string;
}

export interface SandboxPaths {
  workspace: string;
  storageRoot: string;
  sandboxName: string;
  sessionDirectory: string;
}

// Matches pi-sbx command's ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ within a 63-character
// SSH host label. A negative lookahead rejects trailing newlines, and accidental
// .sbx SSH suffixes are rejected.
const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}(?![\s\S])/;

export function isValidSandboxName(name: string): boolean {
  return validName.test(name) && !/\.sbx$/i.test(name);
}

/** Lexical containment for canonical absolute POSIX paths. */
export function containsPath(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

/**
 * Derive an ASCII, lowercase basename identity, replacing runs of other characters
 * with hyphens, trimming edge hyphens, and truncating to 63 characters. Equal
 * basenames intentionally share an identity; use an explicit override to separate
 * them. Overrides must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (1–63 characters, without
 * a .sbx suffix).
 */
export function normalizeSandboxName(workspace: string, override?: string): string {
  if (override !== undefined) {
    if (!isValidSandboxName(override)) {
      throw new Error('Sandbox name must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (1–63 characters, without a .sbx suffix); overrides are not normalized.');
    }
    return override;
  }
  const name = path.posix.basename(workspace).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!name) {
    throw new Error('Workspace basename produces an empty sandbox name; specify a valid sandboxName override.');
  }
  return name;
}

/** Validate host paths without shell expansion: SBX mount paths are POSIX only. */
export function validateHostPath(value: string, label: string): void {
  if (process.platform === 'win32') {
    throw new Error('SBX host paths currently require a POSIX host; Windows hosts are unsupported.');
  }
  if (!value || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty absolute POSIX path without NUL characters.`);
  }
  if (/^[a-z]:/i.test(value) || value.startsWith('\\')) {
    throw new Error(`${label}: Windows host paths are unsupported; use an absolute POSIX host path.`);
  }
  if (value.includes(':')) {
    throw new Error(`${label} must not contain colons (ambiguous SBX POSIX mount syntax).`);
  }
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute POSIX host path.`);
  }
}

/** Expand only the current user's ~ or ~/ prefix; never expand shell expressions. */
function expandStorageRoot(value: string, homeDirectory: string): string {
  if (value === '~' || value.startsWith('~/')) {
    validateHostPath(homeDirectory, 'Home directory');
    return value === '~' ? homeDirectory : `${homeDirectory}/${value.slice(2)}`;
  }
  if (value.startsWith('~')) {
    throw new Error('Storage root supports only ~ or ~/ expansion, not ~other users.');
  }
  return value;
}

/**
 * Resolve existing symlinks, retaining a nonexistent suffix without creating it.
 * Dangling symlinks and non-directory ancestors are errors, not missing parents.
 */
export async function canonicalDirectory(value: string, label = 'Path'): Promise<string> {
  validateHostPath(value, label);
  const normalized = path.posix.normalize(value);
  try {
    const canonical = await fs.realpath(normalized);
    validateHostPath(canonical, 'Canonical path');
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new Error(`Expected a directory: ${value}`);
    }
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // lstat distinguishes an absent component from an existing dangling symlink.
    try {
      const entry = await fs.lstat(normalized);
      // Another client may have created this directory after realpath returned
      // ENOENT. Retry the now-existing directory, but never bless a dangling link.
      if (entry.isDirectory()) return canonicalDirectory(normalized, label);
      throw new Error(`Cannot resolve directory symlink: ${value}`);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statError;
      }
    }
    const parent = path.posix.dirname(normalized);
    if (parent === normalized) {
      throw error;
    }
    return path.posix.join(await canonicalDirectory(parent, label), path.posix.basename(normalized));
  }
}

/** Canonicalize an existing POSIX workspace directory. */
export async function resolveExistingWorkspace(workspace: string): Promise<string> {
  validateHostPath(workspace, 'Workspace');
  const resolved = await fs.realpath(workspace);
  validateHostPath(resolved, 'Canonical workspace');
  if (!(await fs.stat(resolved)).isDirectory()) {
    throw new Error(`Workspace must be an existing directory: ${workspace}`);
  }
  return resolved;
}

/** Expand ~ on the host and canonicalize existing storage-root parents without creating directories. */
export async function resolveStorageRoot(storageRoot?: string, homeDirectory?: string): Promise<string> {
  const requestedRoot = expandStorageRoot(storageRoot ?? '~/.tauren', homeDirectory ?? os.homedir());
  validateHostPath(requestedRoot, 'Storage root');
  return canonicalDirectory(requestedRoot, 'Storage root');
}

/**
 * Resolve canonical host paths without creating directories or depending on VS Code.
 * The workspace must exist. Storage may not exist yet; its closest existing parent
 * and any existing name/sessions symlinks are resolved before containment checks.
 * Only sessions equal to or below the workspace are forbidden (not the reverse).
 * Hosts must use POSIX paths; colons cannot be represented safely in SBX mounts.
 */
export async function resolveSandboxPaths(options: SandboxPathOptions): Promise<SandboxPaths> {
  const workspace = await resolveExistingWorkspace(options.workspace);
  const sandboxName = normalizeSandboxName(workspace, options.sandboxName);
  const storageRoot = await resolveStorageRoot(options.storageRoot, options.homeDirectory);
  const sessionDirectory = await canonicalDirectory(path.posix.join(storageRoot, sandboxName, 'sessions'), 'Session directory');
  if (containsPath(workspace, sessionDirectory)) {
    throw new Error('Sandbox session directory must be outside the workspace (not equal to it or a descendant).');
  }
  return { workspace, storageRoot, sandboxName, sessionDirectory };
}
