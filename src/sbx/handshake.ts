import { PROTOCOL_VERSION, type InitializeResult } from '@tauren/shared/sbx/protocol';
import { SandboxLifecycleError } from './process';

/** Stable patches may differ; release-line changes and prereleases may not. */
export function compatibleRuntimeVersion(actual: string, expected: string): boolean {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const a = semver.exec(actual), e = semver.exec(expected);
  return !!a && !!e && (a[4] || e[4] ? actual === expected : a[1] === e[1] && a[2] === e[2]);
}

/** Validate untrusted initialize output, not merely its compile-time request type.
 * The server checks its own loaded Pi; the host also checks the actual handshake
 * versions before adopting this connection. Session history remains server-owned.
 */
export function validateSandboxHandshake(value: unknown, expected: {
  workspace: string; sessionDirectory: string; serverVersion: string; piVersion: string;
}): InitializeResult {
  const fail = (detail: string): never => { throw new SandboxLifecycleError('incompatible',
    `Incompatible sandbox server: ${detail}. Update Tauren's server kit or select a compatible sandbox; existing sandboxes are never removed automatically.`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid initialize response');
  const result = value as Record<string, unknown>;
  if (result.protocolVersion !== PROTOCOL_VERSION) return fail('protocol version mismatch');
  if (typeof result.serverVersion !== 'string' || !compatibleRuntimeVersion(result.serverVersion, expected.serverVersion)) return fail('server version mismatch');
  if (typeof result.piVersion !== 'string' || !compatibleRuntimeVersion(result.piVersion, expected.piVersion)) return fail('Pi SDK version mismatch');
  if (result.workspace !== expected.workspace || result.sessionDirectory !== expected.sessionDirectory) return fail('workspace or session directory mismatch');
  if (!Array.isArray(result.capabilities) || !result.capabilities.every(item => typeof item === 'string')) return fail('invalid capabilities');
  return result as unknown as InitializeResult;
}
