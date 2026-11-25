import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PROTOCOL_VERSION, Requests, ResponseError, type InitializeResult, type MessageConnection } from '@tauren/shared/sbx/protocol';
import { composeSandboxCommand, type ComposedSandboxCommand } from './commandComposition';
import {
  defaultCommandProvider,
  packagedSandboxKits,
  runCommandProvider,
  type CommandProviderConfiguration,
  type CommandProviderResult
} from './commandProvider';
import {
  canonicalDirectory,
  resolveExistingWorkspace,
  resolveStorageRoot,
  type SandboxPathOptions,
  type SandboxPaths
} from './configuration';
import { validateSandboxHandshake } from './handshake';
import { bounded, runHostCommand, SandboxLifecycleError, throwIfCancelled, type CommandRunner, type CommandOptions } from './process';
import { buildSshArguments, SbxSshTransport } from './sshTransport';
import { SbxControl } from './sbxControl';

export { SandboxLifecycleError } from './process';

/** Check for SBX's private clone layout before resolving Node on the remote PATH. */
export const SBX_READINESS_COMMAND = 'if [ -d /run/sandbox/source ]; then printf "tauren:clone\\n"; else command -v node; fi';
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
  /** Initial per-change diff review setting sent during handshake when configured. */
  perChangeReviewEnabled?: boolean;
  /** Version-specific decoder seam; default deliberately rejects unknown shapes. */
  decodeInspection?: typeof import('./sbxControl').parseSandboxInspection;
  timeouts?: { command?: number; startup?: number; handshake?: number; shutdown?: number; probeInterval?: number };
  onDiagnostic?: (text: string) => void;
}

const locks = new Map<string, Promise<void>>();
/** Process-wide per-key queue covers lookup through create/start, including clients
 * with separate lifecycle instances. Failures release the queue; never cache a
 * successful lookup forever, since users can stop/remove sandboxes externally.
 */
async function exclusive<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(key, queued);
  try {
    await bounded(previous, 2_147_483_647, signal, 'Waiting for sandbox provisioning');
    throwIfCancelled(signal);
    return await operation();
  } finally {
    release();
    // Even a cancelled queued waiter must not let later callers pass the owner.
    void queued.then(() => { if (locks.get(key) === queued) locks.delete(key); });
  }
}

function classifyProviderError(error: unknown): SandboxLifecycleError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Sandbox command provider cancelled') {
    return new SandboxLifecycleError('cancelled', message, { cause: error });
  }
  if (message === 'Sandbox command provider timed out') {
    return new SandboxLifecycleError('timeout', message, { cause: error });
  }
  if (message === 'Could not start sandbox command provider' || message.startsWith('Trust this workspace')) {
    return new SandboxLifecycleError('prerequisite', message, { cause: error });
  }
  if (message.startsWith('Sandbox command provider failed') || message === 'Sandbox command provider output limit exceeded') {
    return new SandboxLifecycleError('command', message, { cause: error });
  }
  return new SandboxLifecycleError('incompatible', message, { cause: error });
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
    const workspace = await resolveExistingWorkspace(this.options.workspace);
    const storageRoot = await resolveStorageRoot(this.options.storageRoot, this.options.homeDirectory);
    const kits = packagedSandboxKits(this.options.extensionDirectory);
    const run = this.options.runCommand ?? runHostCommand;
    const defaultExecutable = this.options.sbxExecutable ?? 'sbx';
    const commandOptions: CommandOptions = { timeoutMs: this.options.timeouts?.command ?? 120_000, signal };
    const hasExternalProvider = Boolean(this.options.commandProvider || this.options.provider);

    const { composed, paths } = await exclusive(`${defaultExecutable}:workspace:${workspace}`, async () => {
      throwIfCancelled(signal);
      if (hasExternalProvider && !this.options.workspaceTrusted) {
        throw new SandboxLifecycleError('prerequisite', 'Trust the workspace before running its sandbox command provider');
      }
      const initialControl = new SbxControl(run, defaultExecutable, this.options.decodeInspection);
      await initialControl.checkPrerequisites(commandOptions);
      throwIfCancelled(signal);

      let response: CommandProviderResult;
      let resolvedCommand;
      try {
        if (this.options.commandProvider) {
          response = await this.options.commandProvider(workspace, signal);
        } else if (this.options.provider) {
          const result = await runCommandProvider(this.options.provider, {
            workspace,
            workspaceTrusted: this.options.workspaceTrusted,
            timeoutMs: this.options.timeouts?.command,
            signal
          });
          response = result.response;
          if (result.stderr) this.options.onDiagnostic?.(result.stderr);
        } else {
          response = defaultCommandProvider(kits.sandboxKitDirectory);
        }
        throwIfCancelled(signal);
        resolvedCommand = await composeSandboxCommand(response, {
          workspace,
          storageRoot,
          homeDirectory: this.options.homeDirectory,
          sandboxName: this.options.sandboxName,
          ...kits
        });
      } catch (error) {
        throwIfCancelled(signal);
        if (error instanceof SandboxLifecycleError) throw error;
        throw classifyProviderError(error);
      }

      const sbxExecutable = this.options.sbxExecutable ?? resolvedCommand.executable;
      await exclusive(`${sbxExecutable}:name:${resolvedCommand.sandboxName}`, async () => {
        throwIfCancelled(signal);
        const control = new SbxControl(run, sbxExecutable, this.options.decodeInspection);
        if (sbxExecutable !== defaultExecutable) {
          await control.checkPrerequisites(commandOptions);
          throwIfCancelled(signal);
        }
        const existing = await control.lookup(resolvedCommand.sandboxName, commandOptions);
        throwIfCancelled(signal);
        if (existing) {
          await control.assertWorkspace(existing, resolvedCommand.workspace);
          if (this.options.workspaceTrusted) {
            await this.ensureHostDirectories(resolvedCommand);
          }
          // SSH automatically starts a stopped sandbox. Do not run -d on adoption:
          // that permanently changes the user's sandbox auto-stop policy.
        } else {
          if (!this.options.workspaceTrusted) {
            throw new SandboxLifecycleError('prerequisite', 'Trust the workspace before creating its sandbox');
          }
          // Filesystem mutation happens only after path/provider checks and trust.
          await this.ensureHostDirectories(resolvedCommand);
          throwIfCancelled(signal);
          await run({ executable: sbxExecutable, args: resolvedCommand.args, cwd: resolvedCommand.workspace }, commandOptions);
          // Inspect again rather than treating create's stdout as readiness. It may
          // have raced an external creator; never adopt on name alone.
          const created = await control.lookup(resolvedCommand.sandboxName, commandOptions);
          if (!created) throw new SandboxLifecycleError('command', `SBX did not create ${resolvedCommand.sandboxName}`);
          await control.assertWorkspace(created, resolvedCommand.workspace);
        }
      }, signal);

      return {
        composed: resolvedCommand,
        paths: {
          workspace: resolvedCommand.workspace,
          storageRoot,
          sandboxName: resolvedCommand.sandboxName,
          sessionDirectory: resolvedCommand.sessionDirectory
        }
      };
    }, signal);

    throwIfCancelled(signal);
    const nodePath = await this.waitForSsh(paths.sandboxName, run, signal);
    const serverPath = this.options.serverPath ?? '/home/agent/.tauren/server/dist/main.js';
    let transport: SbxSshTransport | undefined;
    try {
      transport = await SbxSshTransport.open({
        sandboxName: paths.sandboxName,
        launch: {
          workspace: paths.workspace,
          sessionDirectory: paths.sessionDirectory,
          env: composed.env,
          nodePath,
          serverPath
        },
        executable: this.options.sshExecutable,
        args: this.options.sshArgs,
        timeoutMs: this.options.timeouts?.startup ?? 30_000,
        shutdownTimeoutMs: this.options.timeouts?.shutdown ?? 5_000,
        signal
      });
      throwIfCancelled(signal);
      this.options.configureConnection?.(transport.connection);
      const result = await bounded(transport.connection.sendRequest(Requests.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: this.options.clientVersion,
        workspace: paths.workspace,
        sessionDirectory: paths.sessionDirectory,
        ...(sessionFile ? { sessionFile } : {}),
        ...(this.options.perChangeReviewEnabled !== undefined
          ? { perChangeReviewEnabled: this.options.perChangeReviewEnabled }
          : {})
      }), this.options.timeouts?.handshake ?? 30_000, signal, 'Sandbox server handshake');
      const handshake = validateSandboxHandshake(result, {
        ...paths,
        serverVersion: this.options.expectedServerVersion,
        piVersion: this.options.expectedPiVersion
      });
      return new SandboxSession(paths.sandboxName, paths, handshake, transport);
    } catch (error) {
      await transport?.dispose(false);
      const diagnostics = transport?.stderr.trim();
      throwIfCancelled(signal);
      if (error instanceof SandboxLifecycleError) throw error;
      if (transport && diagnostics?.includes(`Cannot find module '${serverPath}'`)) {
        throw new SandboxLifecycleError(
          'server',
          `Sandbox server handshake failed because "${paths.sandboxName}" does not contain the Tauren server at ${serverPath}. Docker Sandboxes only installs kit files when creating a sandbox, so an existing sandbox created outside Tauren cannot run the server. Remove it with "sbx rm ${paths.sandboxName}" so Tauren can recreate it, or set "tauren.sbx.sandboxName" to use a separate sandbox.`,
          { cause: error }
        );
      }
      const detail = diagnostics || (error instanceof ResponseError ? error.message : '');
      throw new SandboxLifecycleError(transport ? 'server' : 'ssh',
        `${transport ? 'Sandbox server handshake failed; check its installed server kit and Pi' : 'Could not launch sandbox SSH server; run sbx login and sbx setup ssh'}${detail ? `: ${detail}` : ''}`,
        { cause: error });
    }
  }

  /** Create missing host session and agent directories before launching SBX so
   * mounted leaf directories exist with host-user ownership rather than requiring
   * the sandbox server to mkdir under root-owned parent paths.
   */
  private async ensureHostDirectories(resolvedCommand: ComposedSandboxCommand): Promise<void> {
    const agentDirectory = resolvedCommand.env.PI_CODING_AGENT_DIR;
    const directories = agentDirectory && agentDirectory !== resolvedCommand.sessionDirectory
      ? [resolvedCommand.sessionDirectory, agentDirectory]
      : [resolvedCommand.sessionDirectory];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const confirmedWorkspace = await resolveExistingWorkspace(this.options.workspace);
    const confirmedSessions = await canonicalDirectory(resolvedCommand.sessionDirectory, 'Session directory');
    const confirmedAgent = agentDirectory !== undefined
      ? await canonicalDirectory(agentDirectory, 'Agent directory')
      : undefined;
    if (confirmedWorkspace !== resolvedCommand.workspace
      || confirmedSessions !== resolvedCommand.sessionDirectory
      || confirmedAgent !== agentDirectory) {
      throw new SandboxLifecycleError('incompatible', 'Sandbox paths changed during directory creation; retry after resolving symlinks');
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
          ...(this.options.sshArgs ?? []), ...buildSshArguments(name, SBX_READINESS_COMMAND, Math.max(1, deadline - Date.now()))
        ] }, { timeoutMs: Math.max(1, deadline - Date.now()), signal });
        const node = result.stdout.trim();
        if (node === 'tauren:clone') {
          throw new SandboxLifecycleError('incompatible', 'This sandbox uses a private clone. Select or create a sandbox with a direct workspace mount.');
        }
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
