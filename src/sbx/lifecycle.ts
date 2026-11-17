import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PROTOCOL_VERSION, Requests, type InitializeResult, type MessageConnection } from '@tauren/shared/sbx/protocol';
import { composeSandboxCommand } from './commandComposition';
import { defaultCommandProvider, packagedSandboxKits, runCommandProvider, type CommandProviderConfiguration, type CommandProviderResult } from './commandProvider';
import { resolveSandboxPaths, type SandboxPathOptions, type SandboxPaths } from './configuration';
import { validateSandboxHandshake } from './handshake';
import { bounded, runHostCommand, SandboxLifecycleError, throwIfCancelled, type CommandRunner, type CommandOptions } from './process';
import { buildSshArguments, SbxSshTransport } from './sshTransport';
import { SbxControl } from './sbxControl';

export { SandboxLifecycleError } from './process';
export interface SandboxLifecycleOptions extends SandboxPathOptions {
  extensionDirectory: string;
  workspaceTrusted: boolean;
  clientVersion: string;
  expectedPiVersion: string;
  /** Server package has an independent release version, not extension version. */
  expectedServerVersion: string;
  provider?: CommandProviderConfiguration;
  /** Executable paths are injected host configuration, never shell strings. */
  sbxExecutable?: string;
  sshExecutable?: string;
  sshArgs?: string[];
  /** Default server install path is fixed by the mixin; Node is discovered over SSH. */
  serverPath?: string;
  runCommand?: CommandRunner;
  /** Register reverse UI/event handlers before initialize can emit SDK events. */
  configureConnection?: (connection: MessageConnection) => void;
  commandProvider?: (workspace: string, signal?: AbortSignal) => Promise<CommandProviderResult>;
  /** Version-specific decoder seam; default deliberately rejects unknown shapes. */
  decodeInspection?: typeof import('./sbxControl').parseSandboxInspection;
  timeouts?: { command?: number; startup?: number; handshake?: number; shutdown?: number; probeInterval?: number };
  onDiagnostic?: (text: string) => void;
}

const locks = new Map<string, Promise<void>>();
/** Process-wide per-name queue covers lookup through create/start, including clients
 * with separate lifecycle instances. Failures release the queue; never cache a
 * successful lookup forever, since users can stop/remove sandboxes externally.
 */
async function exclusive<T>(name: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(name, queued);
  try {
    await bounded(previous, 2_147_483_647, signal, 'Waiting for sandbox provisioning');
    throwIfCancelled(signal);
    return await operation();
  } finally {
    release();
    // Even a cancelled queued waiter must not let later callers pass the owner.
    void queued.then(() => { if (locks.get(name) === queued) locks.delete(name); });
  }
}

/** One Tauren client owns one server pipe. Disposing it never stops/removes the VM. */
export class SandboxSession {
  constructor(readonly name: string, readonly paths: SandboxPaths, readonly handshake: InitializeResult, private readonly transport: SbxSshTransport) {}
  get connection(): MessageConnection { return this.transport.connection; }
  dispose(): Promise<void> { return this.transport.dispose(); }
}

/** Provisioning plus one concrete SSH server connection. Host command execution
 * and providers remain injectable, not the transport. No VS Code imports or
 * AgentClient mapping: settings/trust and UI ownership belong to later integration.
 */
export class SandboxLifecycle {
  constructor(private readonly options: SandboxLifecycleOptions) {}

  async open(signal?: AbortSignal, sessionFile?: string): Promise<SandboxSession> {
    throwIfCancelled(signal);
    for (const value of Object.values(this.options.timeouts ?? {})) {
      if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error('Sandbox timeouts must be positive supported milliseconds');
    }
    const paths = await resolveSandboxPaths(this.options);
    const run = this.options.runCommand ?? runHostCommand;
    const control = new SbxControl(run, this.options.sbxExecutable ?? 'sbx', this.options.decodeInspection);
    const commandOptions: CommandOptions = { timeoutMs: this.options.timeouts?.command ?? 120_000, signal };
    await exclusive(`${this.options.sbxExecutable ?? 'sbx'}:${paths.sandboxName}`, async () => {
      throwIfCancelled(signal);
      await control.checkPrerequisites(commandOptions);
      const existing = await control.lookup(paths.sandboxName, commandOptions);
      throwIfCancelled(signal);
      if (existing) {
        await control.assertWorkspace(existing, paths.workspace);
        // SSH automatically starts a stopped sandbox. Do not run -d on adoption:
        // that permanently changes the user's sandbox auto-stop policy.
      } else {
        if (!this.options.workspaceTrusted) throw new SandboxLifecycleError('prerequisite', 'Trust the workspace before creating its sandbox');
        const kits = packagedSandboxKits(this.options.extensionDirectory);
        let response: CommandProviderResult;
        if (this.options.commandProvider) response = await this.options.commandProvider(paths.workspace, signal);
        else if (this.options.provider) {
          const result = await runCommandProvider(this.options.provider, { workspace: paths.workspace, workspaceTrusted: true, signal });
          response = result.response;
          if (result.stderr) this.options.onDiagnostic?.(result.stderr);
        } else response = defaultCommandProvider(kits.sandboxKitDirectory);
        throwIfCancelled(signal);
        const command = await composeSandboxCommand(response, { ...paths, serverMixinDirectory: kits.serverMixinDirectory });
        // Filesystem mutation happens only after path/provider checks and trust.
        await mkdir(paths.sessionDirectory, { recursive: true, mode: 0o700 });
        const confirmedPaths = await resolveSandboxPaths(this.options);
        if (confirmedPaths.workspace !== paths.workspace || confirmedPaths.sessionDirectory !== paths.sessionDirectory) {
          throw new SandboxLifecycleError('incompatible', 'Sandbox paths changed during directory creation; retry after resolving symlinks');
        }
        throwIfCancelled(signal);
        await run({ ...command, cwd: paths.workspace }, commandOptions);
        // Inspect again rather than treating create's stdout as readiness. It may
        // have raced an external creator; never adopt on name alone.
        const created = await control.lookup(paths.sandboxName, commandOptions);
        if (!created) throw new SandboxLifecycleError('command', `SBX did not create ${paths.sandboxName}`);
        await control.assertWorkspace(created, paths.workspace);
      }
    }, signal);
    throwIfCancelled(signal);
    const nodePath = await this.waitForSsh(paths.sandboxName, run, signal);
    let transport: SbxSshTransport | undefined;
    try {
      transport = await SbxSshTransport.open({ sandboxName: paths.sandboxName,
        launch: { workspace: paths.workspace, sessionDirectory: paths.sessionDirectory, nodePath,
          serverPath: this.options.serverPath ?? '/home/agent/.tauren/server/dist/main.js' },
        executable: this.options.sshExecutable, args: this.options.sshArgs,
        timeoutMs: this.options.timeouts?.startup ?? 30_000,
        shutdownTimeoutMs: this.options.timeouts?.shutdown ?? 5_000, signal });
      throwIfCancelled(signal);
      this.options.configureConnection?.(transport.connection);
      const result = await bounded(transport.connection.sendRequest(Requests.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientVersion: this.options.clientVersion,
        workspace: paths.workspace, sessionDirectory: paths.sessionDirectory, ...(sessionFile ? { sessionFile } : {})
      }), this.options.timeouts?.handshake ?? 30_000, signal, 'Sandbox server handshake');
      const handshake = validateSandboxHandshake(result, { ...paths, serverVersion: this.options.expectedServerVersion, piVersion: this.options.expectedPiVersion });
      return new SandboxSession(paths.sandboxName, paths, handshake, transport);
    } catch (error) {
      const diagnostics = transport?.stderr.trim();
      await transport?.dispose(false);
      throwIfCancelled(signal);
      if (error instanceof SandboxLifecycleError) throw error;
      throw new SandboxLifecycleError(transport ? 'server' : 'ssh',
        `${transport ? 'Sandbox server handshake failed; check its installed server kit and Pi' : 'Could not launch sandbox SSH server; run sbx login and sbx setup ssh'}${diagnostics ? `: ${diagnostics}` : ''}`,
        { cause: error });
    }
  }

  /** Successful remote Node discovery proves SSH readiness and starts stopped VMs.
   * Retry only this read-only probe, never creation or prompts. The global startup
   * budget bounds retries, backoff, and each command; stderr is preserved on failure.
   */
  private async waitForSsh(name: string, run: CommandRunner, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + (this.options.timeouts?.startup ?? 30_000);
    let last: unknown;
    do {
      throwIfCancelled(signal);
      try {
        const result = await run({ executable: this.options.sshExecutable ?? 'ssh', args: [
          ...(this.options.sshArgs ?? []), ...buildSshArguments(name, 'command -v node', Math.max(1, deadline - Date.now()))
        ] }, { timeoutMs: Math.max(1, deadline - Date.now()), signal });
        const node = result.stdout.trim();
        if (!path.posix.isAbsolute(node) || node.includes('\n') || node.includes('\r') || node.includes('\0')) {
          throw new SandboxLifecycleError('incompatible', 'Sandbox Node executable must resolve to one absolute POSIX path');
        }
        return node;
      } catch (error) {
        if (error instanceof SandboxLifecycleError && ['cancelled', 'incompatible', 'prerequisite'].includes(error.kind)) throw error;
        last = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await bounded(new Promise(resolve => setTimeout(resolve, Math.min(remaining, this.options.timeouts?.probeInterval ?? 100))), remaining + 1, signal);
    } while (Date.now() < deadline);
    throw new SandboxLifecycleError('ssh', `Sandbox SSH was not ready before the startup deadline. Run sbx login and sbx setup ssh, then verify ssh ${name}.sbx. ${last instanceof Error ? last.message : ''}`, { cause: last });
  }
}
