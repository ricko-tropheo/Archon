import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';

/**
 * Environment variable a node subprocess uses to publish its process-group id
 * before executing its body. The marker is written before the spawn, so a dead
 * owner can never leave a started node without either a start marker or a pgid.
 */
export const ACTIVE_NODE_GROUP_ENV = 'ARCHON_ACTIVE_NODE_GROUP_FILE';

export interface ActiveNodeGroup {
  executionId: string;
  nodePath: string;
  pgid: number | null;
  valid: boolean;
}

function groupsDir(artifactsDir: string): string {
  return join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'active-node-groups');
}

export function activeNodeGroupPgidPath(artifactsDir: string, executionId: string): string {
  return join(groupsDir(artifactsDir), `${executionId}.pgid`);
}

/** Write the start marker synchronously, before the node subprocess can spawn. */
export function beginActiveNodeGroup(
  artifactsDir: string,
  executionId: string,
  nodePath: string
): void {
  const dir = groupsDir(artifactsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${executionId}.json`),
    `${JSON.stringify({ executionId, nodePath, startedAt: new Date().toISOString() })}\n`,
    'utf8'
  );
}

/** Remove the markers after a node settles; a crash leaves them for recovery. */
export function clearActiveNodeGroup(artifactsDir: string, executionId: string): void {
  const dir = groupsDir(artifactsDir);
  rmSync(join(dir, `${executionId}.json`), { force: true });
  rmSync(activeNodeGroupPgidPath(artifactsDir, executionId), { force: true });
}

/** Read every active marker. A corrupt or pgid-less marker is returned as invalid. */
export function readActiveNodeGroups(artifactsDir: string): ActiveNodeGroup[] {
  const dir = groupsDir(artifactsDir);
  if (!existsSync(dir)) return [];
  const groups: ActiveNodeGroup[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const executionId = name.slice(0, -'.json'.length);
    let nodePath = executionId;
    let valid = true;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        nodePath?: unknown;
      };
      if (typeof parsed.nodePath === 'string' && parsed.nodePath.length > 0) {
        nodePath = parsed.nodePath;
      } else {
        valid = false;
      }
    } catch {
      valid = false;
    }
    let pgid: number | null = null;
    try {
      const value = Number(
        readFileSync(activeNodeGroupPgidPath(artifactsDir, executionId), 'utf8').trim()
      );
      pgid = Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch {
      pgid = null;
    }
    groups.push({ executionId, nodePath, pgid, valid });
  }
  return groups;
}
