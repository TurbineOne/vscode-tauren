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

// A negative lookahead enforces the true end (unlike $, which accepts a final newline).
const validName = /^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/;

/**
 * Derive an ASCII, lowercase basename identity, replacing runs of other characters
 * with hyphens, trimming edge hyphens, and truncating to 63 characters. Equal
 * basenames intentionally share an identity; use an explicit override to separate
 * them. Overrides must already match [a-z0-9][a-z0-9-]* (at most 63 characters).
 */
export function normalizeSandboxName(workspace: string, override?: string): string {
  if (override !== undefined) {
    if (!validName.test(override)) {
      throw new Error('Sandbox name must match [a-z0-9][a-z0-9-]* and contain 1–63 characters; overrides are not normalized.');
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
function validateHostPath(value: string, label: string): void {
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
async function canonicalDirectory(value: string): Promise<string> {
  try {
    const canonical = await fs.realpath(value);
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
      const entry = await fs.lstat(value);
      // Another client may have created this directory after realpath returned
      // ENOENT. Retry the now-existing directory, but never bless a dangling link.
      if (entry.isDirectory()) return canonicalDirectory(value);
      throw new Error(`Cannot resolve directory symlink: ${value}`);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw statError;
      }
    }
    const parent = path.posix.dirname(value);
    if (parent === value) {
      throw error;
    }
    return path.posix.join(await canonicalDirectory(parent), path.posix.basename(value));
  }
}

/**
 * Resolve canonical host paths without creating directories or depending on VS Code.
 * The workspace must exist. Storage may not exist yet; its closest existing parent
 * and any existing name/sessions symlinks are resolved before containment checks.
 * Only sessions equal to or below the workspace are forbidden (not the reverse).
 * Hosts must use POSIX paths; colons cannot be represented safely in SBX mounts.
 */
export async function resolveSandboxPaths(options: SandboxPathOptions): Promise<SandboxPaths> {
  if (process.platform === 'win32') {
    throw new Error('SBX host paths currently require a POSIX host; Windows hosts are unsupported.');
  }
  validateHostPath(options.workspace, 'Workspace');
  const workspace = await fs.realpath(options.workspace);
  validateHostPath(workspace, 'Canonical workspace');
  if (!(await fs.stat(workspace)).isDirectory()) {
    throw new Error(`Workspace must be an existing directory: ${options.workspace}`);
  }
  const sandboxName = normalizeSandboxName(workspace, options.sandboxName);
  const requestedRoot = expandStorageRoot(options.storageRoot ?? '~/.tauren', options.homeDirectory ?? os.homedir());
  validateHostPath(requestedRoot, 'Storage root');
  const storageRoot = await canonicalDirectory(requestedRoot);
  const sessionDirectory = await canonicalDirectory(path.posix.join(storageRoot, sandboxName, 'sessions'));
  const relative = path.posix.relative(workspace, sessionDirectory);
  if (!relative || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))) {
    throw new Error('Sandbox session directory must be outside the workspace (not equal to it or a descendant).');
  }
  return { workspace, storageRoot, sandboxName, sessionDirectory };
}
