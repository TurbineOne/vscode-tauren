import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SandboxLifecycleError, type CommandRunner, type CommandOptions } from './process';

export interface InspectedSandbox { name: string; workspace: string }

/** Narrow, fail-closed adapter for SBX's version-sensitive JSON output. A name
 * match is never sufficient adoption evidence. Unknown schemas must be captured
 * and explicitly supported, not guessed via case-insensitive field searches.
 */
export function parseSandboxInspection(output: string, name: string): InspectedSandbox {
  const record = parseJson(output);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return incompatibleSchema();
  const value = record as Record<string, unknown>;
  if (value.name !== name || typeof value.workspace !== 'string' || !path.posix.isAbsolute(value.workspace)) return incompatibleSchema();
  return { name, workspace: value.workspace };
}
function parseJson(output: string): unknown {
  try { return JSON.parse(output); }
  catch { return incompatibleSchema(); }
}
function incompatibleSchema(): never {
  throw new SandboxLifecycleError('incompatible', 'Unsupported SBX JSON inspection schema. Capture sbx --version and sbx inspect NAME --json; Tauren will not adopt a sandbox without verified workspace metadata.');
}

/** Keep all SBX CLI assumptions at one injectable boundary. Lookup differentiates
 * absence via the list, not by treating arbitrary inspect errors as "not found".
 */
export class SbxControl {
  constructor(private readonly run: CommandRunner, private readonly executable = 'sbx',
    private readonly decodeInspection = parseSandboxInspection) {}
  async checkPrerequisites(options: CommandOptions): Promise<void> {
    const result = await this.run({ executable: this.executable, args: ['--version'] }, options);
    const version = /^(?:sbx(?: version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(result.stdout.trim());
    if (!version || Number(version[1]) !== 0 || Number(version[2]) < 51) {
      throw new SandboxLifecycleError('prerequisite', 'Tauren requires stable SBX 0.51 or newer 0.x. Install a supported SBX release and run sbx login and sbx setup ssh.');
    }
  }
  async lookup(name: string, options: CommandOptions): Promise<InspectedSandbox | undefined> {
    const result = await this.run({ executable: this.executable, args: ['ls', '--json'] }, options);
    const list = parseJson(result.stdout);
    if (!Array.isArray(list) || !list.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.name === 'string')) return incompatibleSchema();
    const matches = list.filter(item => item.name === name);
    if (!matches.length) return undefined;
    if (matches.length !== 1) return incompatibleSchema();
    return this.decodeInspection((await this.run({ executable: this.executable, args: ['inspect', name, '--json'] }, options)).stdout, name);
  }
  async assertWorkspace(sandbox: InspectedSandbox, workspace: string): Promise<void> {
    let source: string;
    try { source = await realpath(sandbox.workspace); }
    catch (cause) { throw new SandboxLifecycleError('incompatible', 'Existing sandbox workspace is missing or cannot be resolved; select another name or recreate it explicitly.', { cause }); }
    if (source !== workspace) throw new SandboxLifecycleError('incompatible', `Sandbox ${sandbox.name} belongs to another workspace. Select a different sandbox name; Tauren will not remove or replace it.`);
  }
}
