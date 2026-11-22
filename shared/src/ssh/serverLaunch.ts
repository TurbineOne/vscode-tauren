import path from 'node:path';

export interface ServerLaunchOptions {
  /** Absolute Node executable and built server entrypoint inside the remote machine. */
  nodePath: string;
  serverPath: string;
  workspace: string;
  sessionDirectory: string;
  /** Additional remote environment variables, such as PI_CODING_AGENT_DIR from a command provider. */
  env?: Record<string, string>;
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;
const credentialKeyPattern = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Quote one argument for the POSIX login shell used by SSH remote commands.
 * Local spawn argv does not prevent the remote shell from interpreting a command;
 * single quotes, including embedded quotes, must be escaped independently.
 */
export function quoteRemoteArgument(value: string): string {
  if (value.includes('\0')) throw new Error('Remote arguments must not contain NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `buildServerLaunchCommand` builds the remote shell command string passed to
 * `ssh -T <destination>` so that the server starts with an explicit working
 * directory and environment instead of relying on shell startup files or SSH
 * environment forwarding (`SendEnv`). The command changes into
 * `options.workspace` with `cd` and passes `PI_CODING_AGENT_SESSION_DIR` along
 * with any non-credential variables from `options.env` directly through `env`,
 * using `options.sessionDirectory` even if `options.env` also defines
 * `PI_CODING_AGENT_SESSION_DIR`. The client still sends `workspace` and
 * `sessionDirectory` in the `initialize` request so that the server can verify
 * them after startup rather than trusting the initial shell state alone.
 *
 * The command launches Node with `exec` so that the per-connection server
 * process replaces the remote shell instead of running as a child underneath
 * it. Because no intermediate shell stays alive, closing standard input or
 * sending a termination signal over SSH reaches the server process directly.
 */
export function buildServerLaunchCommand(options: ServerLaunchOptions): string {
  for (const name of ['nodePath', 'serverPath', 'workspace', 'sessionDirectory'] as const) {
    const value = options[name];
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.includes('\0')) {
      throw new Error(`${name} must be an absolute remote POSIX path`);
    }
  }
  const assignments: string[] = [];
  if (options.env !== undefined) {
    if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)) {
      throw new Error('Remote environment must be an object');
    }
    for (const [key, value] of Object.entries(options.env)) {
      if (key === 'PI_CODING_AGENT_SESSION_DIR') continue;
      if (!envNamePattern.test(key) || typeof value !== 'string' || value.includes('\0')) {
        throw new Error(`Invalid remote environment assignment for ${key}`);
      }
      if (credentialKeyPattern.test(key)) {
        throw new Error('Remote launch must not supply credential environment values');
      }
      assignments.push(quoteRemoteArgument(`${key}=${value}`));
    }
  }
  assignments.push(quoteRemoteArgument(`PI_CODING_AGENT_SESSION_DIR=${options.sessionDirectory}`));
  return `cd ${quoteRemoteArgument(options.workspace)} && exec env ${assignments.join(' ')} ${quoteRemoteArgument(options.nodePath)} ${quoteRemoteArgument(options.serverPath)}`;
}
