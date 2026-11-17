import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createProtocolConnection, Requests, type MessageConnection } from '@tauren/shared/sbx/protocol';
import { buildServerLaunchCommand, type ServerLaunchOptions } from '@tauren/shared/ssh/serverLaunch';

export interface SshTransportOptions {
  sandboxName: string;
  launch: ServerLaunchOptions;
  /** Local executable and prefix argv, also usable with a Node fixture. Never a shell command. */
  executable?: string;
  args?: string[];
  signal?: AbortSignal;
  /** Local spawn deadline and SSH ConnectTimeout; initialize has a separate lifecycle deadline. */
  timeoutMs?: number;
  shutdownTimeoutMs?: number;
}

const STDERR_LIMIT = 16 * 1024;

/** Shared SSH policy for finite readiness probes and the live protocol channel. */
export function buildSshArguments(sandboxName: string, remoteCommand: string, connectTimeoutMs = 10_000): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/.test(sandboxName)) throw new Error('Invalid sandbox name');
  duration(connectTimeoutMs, 10_000);
  if (remoteCommand.includes('\0')) throw new Error('SSH remote command must not contain NUL');
  return ['-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(connectTimeoutMs / 1000))}`,
    `${sandboxName}.sbx`, remoteCommand];
}

function duration(value: number | undefined, fallback: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error('SSH timeouts must be finite positive milliseconds');
  }
  return value ?? fallback;
}

/** One SSH child and one framed, bidirectional protocol connection. No handshake
 * is sent here: callers install reverse handlers and initialize after open.
 * Disposing either this owner or its connection also tears down the local child.
 */
export class SbxSshTransport {
  readonly connection: MessageConnection;
  private stderrTail = '';
  private closed = false;
  private closing = false;
  private disposal?: Promise<void>;
  private readonly subscriptions: { dispose(): void }[] = [];

  /** Bounded diagnostic tail. SSH stderr is never fed to the protocol reader. */
  get stderr(): string { return this.stderrTail; }

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly destination: string,
    private readonly shutdownTimeoutMs: number
  ) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', this.onStderr);
    child.on('error', this.onChildError);
    child.on('close', this.onChildClose);
    child.stdin.on('error', this.onStreamError);
    child.stdout.on('error', this.onStreamError);
    child.stderr.on('error', this.onStreamError);
    this.connection = createProtocolConnection(child.stdout, child.stdin);
    this.subscriptions.push(
      this.connection.onError(([error]) => this.fail(`Protocol error: ${error.message}`)),
      this.connection.onClose(() => this.fail('SSH protocol stream closed')),
      this.connection.onDispose(() => {
        if (!this.closing) this.fail('SSH protocol connection disposed; check server framing and SSH diagnostics');
      })
    );
    // Listen before any caller can issue requests, even if stdout is silent.
    this.connection.listen();
  }

  private readonly onStderr = (text: string): void => {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_LIMIT);
  };
  private readonly onChildError = (error: Error): void => {
    this.fail(`Cannot run SSH for ${this.destination}: ${error.message}. Check the SSH executable and sandbox availability.`);
  };
  private readonly onStreamError = (error: Error): void => {
    this.fail(`SSH stdio error for ${this.destination}: ${error.message}`);
  };
  private readonly onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.closed = true;
    if (!this.closing) this.fail(`SSH to ${this.destination} exited (code ${code}, signal ${signal}). Check sandbox availability and remote Node/server paths.`);
  };

  private fail(message: string): void {
    if (this.closing) return;
    this.onStderr(`\n${message}\n`);
    void this.beginDisposal(false);
  }

  /** Open on the child spawn event, not first stdout (the server awaits initialize). */
  static async open(options: SshTransportOptions): Promise<SbxSshTransport> {
    const timeoutMs = duration(options.timeoutMs, 10_000);
    const shutdownTimeoutMs = duration(options.shutdownTimeoutMs, 1_000);
    const command = buildServerLaunchCommand(options.launch);
    if (options.signal?.aborted) throw new Error('SSH startup aborted');
    const destination = `${options.sandboxName}.sbx`;
    const child = spawn(options.executable ?? 'ssh', [
      ...(options.args ?? []), ...buildSshArguments(options.sandboxName, command, timeoutMs)
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const transport = new SbxSshTransport(child, destination, shutdownTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.off('spawn', onSpawn);
          child.off('error', onError);
          child.off('close', onClose);
          options.signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve();
        };
        const onSpawn = (): void => finish();
        const onError = (error: Error): void => finish(new Error(`SSH startup failed for ${destination}: ${error.message}. Check the SSH executable. ${transport.stderr}`));
        const onClose = (): void => finish(new Error(`SSH exited before spawning for ${destination}. ${transport.stderr}`));
        const onAbort = (): void => finish(new Error(`SSH startup aborted for ${destination}`));
        const timer = setTimeout(() => finish(new Error(`SSH spawn timed out for ${destination}`)), timeoutMs);
        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.once('close', onClose);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
      return transport;
    } catch (error) {
      await transport.beginDisposal(false);
      throw error;
    }
  }

  /** Idempotent bounded shutdown: RPC, stdin EOF, SIGTERM, then SIGKILL.
   * Pending requests are always rejected by connection disposal, including when
   * the remote server ignores shutdown or the connection was disposed separately.
   */
  dispose(graceful = true): Promise<void> { return this.beginDisposal(graceful); }

  private beginDisposal(graceful: boolean): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    // Defer work so reentrant connection callbacks see the same disposal promise.
    this.disposal = Promise.resolve().then(async () => {
      try {
        if (graceful && !this.closed) {
          await this.boundedShutdown();
        }
        this.connection.dispose();
        this.child.stdin.end();
        if (!this.closed && graceful) await this.waitForClose();
        if (!this.closed) {
          this.child.kill('SIGTERM');
          await this.waitForClose();
        }
        if (!this.closed) {
          this.child.kill('SIGKILL');
          await this.waitForClose();
        }
      } finally {
        this.connection.dispose();
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.child.off('error', this.onChildError);
        this.child.off('close', this.onChildClose);
        this.child.stdin.off('error', this.onStreamError);
        this.child.stdout.off('error', this.onStreamError);
        this.child.stderr.off('error', this.onStreamError);
        this.child.stderr.off('data', this.onStderr);
      }
    });
    // Reject pending requests immediately on unexpected EOF, malformed frames or exit.
    if (!graceful) this.connection.dispose();
    return this.disposal;
  }

  private async boundedShutdown(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.connection.sendRequest(Requests.shutdown, null),
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            this.onStderr(`\nSSH shutdown timed out for ${this.destination}; closing the local SSH child.\n`);
            resolve();
          }, this.shutdownTimeoutMs);
        })
      ]);
    } catch (error) {
      this.onStderr(`\nSSH shutdown for ${this.destination}: ${String(error)}\n`);
    } finally { clearTimeout(timer); }
  }

  private waitForClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        this.child.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, this.shutdownTimeoutMs);
      this.child.once('close', done);
    });
  }
}

