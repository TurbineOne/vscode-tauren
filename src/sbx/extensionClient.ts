import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentClientOptions } from '../agent/types';
import { getSbxSettings } from '../settings/taurenSettings';
import { packagedSandboxKits } from './commandProvider';
import { resolveSandboxPaths } from './configuration';
import { SbxClient } from './sbxClient';

/** SBX needs a real project mount. Never substitute the Pi home-directory fallback. */
function requireWorkspace(workspace: string | undefined): string {
  if (!workspace) throw new Error('Open a local workspace folder before using Docker Sandboxes.');
  return workspace;
}

/** Resolve the same store for discovery and the client, without starting a VM. */
export function resolveSbxWorkspace(workspace: string | undefined) {
  return resolveSandboxPaths({ ...getSbxSettings(), workspace: requireWorkspace(workspace) });
}

/** Use the installed mixin's manifest, not the extension package version, to
 * check the server and Pi release lines at initialize. */
export function createSbxExtensionClient(options: AgentClientOptions, extensionDirectory: string,
  workspace: string | undefined, onDiagnostic: (message: string) => void): SbxClient {
  const cwd = requireWorkspace(workspace);
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting Docker Sandboxes.');
  const { serverMixinDirectory } = packagedSandboxKits(extensionDirectory);
  let manifest: { extensionVersion: string; serverVersion: string; piSdkVersion: string };
  try {
    const value = JSON.parse(readFileSync(path.join(serverMixinDirectory, 'build-manifest.json'), 'utf8'));
    if (!value || !['extensionVersion', 'serverVersion', 'piSdkVersion'].every(key => typeof value[key] === 'string' && value[key])) {
      throw new Error('Invalid manifest');
    }
    manifest = value;
  } catch (cause) {
    throw new Error('Tauren’s Docker Sandboxes kit is missing or invalid. Reinstall the extension or rebuild its sandbox kits.', { cause });
  }
  return new SbxClient({ ...options, cwd, lifecycle: {
    ...getSbxSettings(), extensionDirectory, workspace: cwd, workspaceTrusted: true,
    clientVersion: manifest.extensionVersion, expectedServerVersion: manifest.serverVersion,
    expectedPiVersion: manifest.piSdkVersion, onDiagnostic
  }, showCredentialDocumentation: async url => {
    const open = 'Open Credential Documentation';
    const selected = await vscode.window.showInformationMessage(
      'Docker Sandboxes manages model credentials on the host. Tauren does not store or send them.', open);
    if (selected === open) await vscode.env.openExternal(vscode.Uri.parse(url));
  } });
}
