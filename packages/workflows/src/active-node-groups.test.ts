import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeNodeGroupPgidPath,
  beginActiveNodeGroup,
  clearActiveNodeGroup,
  readActiveNodeGroups,
} from './active-node-groups';

describe('active node group markers', () => {
  test('a start marker without a pgid is visible as unknown', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'archon-active-group-'));
    beginActiveNodeGroup(artifacts, 'exec-1', 'node-1');
    expect(readActiveNodeGroups(artifacts)).toEqual([
      { executionId: 'exec-1', nodePath: 'node-1', pgid: null, valid: true },
    ]);
  });

  test('the subprocess pgid is read back and cleared after completion', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'archon-active-group-'));
    beginActiveNodeGroup(artifacts, 'exec-1', 'node-1');
    writeFileSync(activeNodeGroupPgidPath(artifacts, 'exec-1'), '4242\n');
    expect(readActiveNodeGroups(artifacts)).toEqual([
      { executionId: 'exec-1', nodePath: 'node-1', pgid: 4242, valid: true },
    ]);
    clearActiveNodeGroup(artifacts, 'exec-1');
    expect(readActiveNodeGroups(artifacts)).toEqual([]);
  });

  test('a corrupt marker is invalid rather than silently ignored', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'archon-active-group-'));
    beginActiveNodeGroup(artifacts, 'exec-1', 'node-1');
    writeFileSync(join(artifacts, '.archon', 'active-node-groups', 'exec-1.json'), '{');
    const [marker] = readActiveNodeGroups(artifacts);
    expect(marker?.valid).toBe(false);
  });
});
