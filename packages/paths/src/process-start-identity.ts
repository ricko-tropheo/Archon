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

/**
 * Read the POSIX process group id for `pid`, or null on Windows / when it cannot
 * be observed. A recovery may inspect the group to prove no node child survived
 * the owner; an unreadable group is treated as unknown, never as gone.
 */
export async function readProcessGroupId(pid: number): Promise<number | null> {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      timeout: 5_000,
    });
    const value = Number(normalize(stdout));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when the POSIX process group has a live (non-zombie) member. A failed
 * inspection returns true: the caller must refuse recovery when it cannot prove
 * the group is empty.
 */
export async function processGroupHasLiveMembers(pgid: number): Promise<boolean> {
  if (process.platform === 'win32' || !Number.isSafeInteger(pgid) || pgid <= 0) return true;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
      timeout: 5_000,
    });
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const fields = /^\s*(\d+)\s+(\S+)/.exec(line);
      if (!fields) return true;
      if (Number(fields[1]) === pgid && !fields[2].startsWith('Z')) return true;
    }
    return false;
  } catch {
    return true;
  }
}
