import { spawn } from 'node:child_process';

export type SandboxFailureKind = 'prerequisite' | 'incompatible' | 'timeout' | 'cancelled' | 'command' | 'ssh' | 'server';
/** Structured category lets the later VS Code adapter present an actionable error. */
export class SandboxLifecycleError extends Error {
  constructor(readonly kind: SandboxFailureKind, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'SandboxLifecycleError';
  }
}
export interface HostCommand { executable: string; args: string[]; cwd?: string }
export interface CommandOptions { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number }
export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (command: HostCommand, options?: CommandOptions) => Promise<CommandResult>;

/** Execute finite host commands with literal argv, closed stdin and bounded output.
 * Timeout/cancellation also destroy inherited pipes: grandchildren must not keep
 * this wait alive after the owned process exits. No sandbox is stopped or removed.
 */
export const runHostCommand: CommandRunner = async (command, options = {}) => {
  throwIfCancelled(options.signal);
  const timeout = options.timeoutMs ?? 120_000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid host command limits');
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: command.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      if (error) {
        child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); reject(error);
      } else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const cancel = () => finish(new SandboxLifecycleError('cancelled', 'Sandbox startup cancelled'));
    const timer = setTimeout(() => finish(new SandboxLifecycleError('timeout', `${command.executable} command timed out`)), timeout);
    const collect = (chunks: Buffer[], data: Buffer) => {
      size += data.length;
      if (size > limit) finish(new SandboxLifecycleError('command', 'Host command exceeded its output limit'));
      else chunks.push(data);
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    child.once('error', error => finish(new SandboxLifecycleError('prerequisite', `Cannot execute ${command.executable}: ${error.message}`, { cause: error })));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new SandboxLifecycleError('command', `${command.executable} failed (${signal ?? code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
};

/** Check before every mutation boundary, including after an awaited lookup. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SandboxLifecycleError('cancelled', 'Sandbox startup cancelled');
}

/** Bound asynchronous waits and detach abort/timer resources on every outcome.
 * Cancellation of shared provisioning is caller-specific; its owner retains the
 * name lock until the actual operation settles, preventing a second create race.
 */
export async function bounded<T>(work: PromiseLike<T>, timeoutMs: number, signal?: AbortSignal, description = 'Sandbox startup'): Promise<T> {
  throwIfCancelled(signal);
  let timer: NodeJS.Timeout | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SandboxLifecycleError('timeout', `${description} timed out`)), timeoutMs);
      cancel = () => reject(new SandboxLifecycleError('cancelled', 'Sandbox startup cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    })]);
  } finally { clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
}
