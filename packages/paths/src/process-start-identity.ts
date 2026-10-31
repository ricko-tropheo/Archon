import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWindowsProcessIdentity } from './windows-process-identity';

const execFileAsync = promisify(execFile);

/**
 * What a process-start probe settled. `absent` is the only observation that proves
 * the recorded owner no longer exists; `unavailable` must be treated as unknown.
 */
export type ProcessStartObservation =
  | { status: 'observed'; identity: string }
  | { status: 'absent' }
  | { status: 'unavailable'; code: string | number | null };

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function errorCode(error: unknown): string | number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (typeof error.code === 'string' || typeof error.code === 'number')
  ) {
    return error.code;
  }
  return null;
}

/**
 * Read a stable process-start identity for `pid` on this host.
 *
 * POSIX uses `ps -o lstart=` (macOS and Linux); Windows uses the existing
 * PowerShell creation-ticks probe. The identity is intentionally opaque: callers
 * compare it, never parse it.
 */
export async function readProcessStartIdentity(pid: number): Promise<ProcessStartObservation> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unavailable', code: 'INVALID_PID' };
  }

  if (process.platform === 'win32') {
    const identity = await readWindowsProcessIdentity(pid);
    if (identity.status === 'observed') {
      return { status: 'observed', identity: `windows:${identity.creationTicks}` };
    }
    if (identity.status === 'absent') return { status: 'absent' };
    return { status: 'unavailable', code: identity.code };
  }

  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 5_000,
    });
    const identity = normalize(stdout);
    return identity.length > 0
      ? { status: 'observed', identity: `ps:${identity}` }
      : { status: 'absent' };
  } catch (error) {
    const code = errorCode(error);
    // `ps -p <missing>` exits 1 with no process row. Any other failure leaves
    // the process's existence unknown; never turn that into proof of death.
    if (code === 1 || code === '1') return { status: 'absent' };
    return { status: 'unavailable', code };
  }
}
