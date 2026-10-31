// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import {
  activeNodeGroupPgidPath,
  beginActiveNodeGroup,
} from '@archon/workflows/active-node-groups';
import { EXECUTION_CLAIM_METADATA_KEY } from '@archon/workflows/store';
import {
  operator,
  mockGetWorkflowRun,
  mockFailWorkflowRun,
  mockProcessGroupHasLiveMembers,
  mockReadProcessStartIdentity,
  EMPTY_COUNTS,
  mockListWorkflowRuns,
  mockDeleteWorkflowNodeSessions,
  mockLogger,
  makePausedRun,
  makeDashboardRun,
  getWorkflowStatus,
  resumeWorkflow,
  resetWorkflowNodeSessions,
} from './test-harness';

describe('getWorkflowStatus', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockClear();
  });

  test('returns running and paused runs', async () => {
    const runs = [
      makeDashboardRun({ status: 'running', active_nodes: ['plan', 'implement'] }),
      makeDashboardRun({ id: 'run-2', status: 'paused' }),
    ];
    mockListWorkflowRuns.mockResolvedValueOnce({
      runs,
      total: 2,
      counts: { ...EMPTY_COUNTS, all: 2, running: 1, paused: 1 },
    });

    const result = await getWorkflowStatus();

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.active_nodes).toEqual(['plan', 'implement']);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
  });

  test('passes an explicit codebase scope to the active-run query', async () => {
    mockListWorkflowRuns.mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await getWorkflowStatus({ codebaseId: 'cb-project-a' });

    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
      codebaseId: 'cb-project-a',
    });
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
  });

  test('returns run when status is resumable', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await resumeWorkflow('run-1', operator);
    expect(run.id).toBe('run-1');
  });

  test('throws on non-resumable status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  test('throws wrapped message and logs when DB throws', async () => {
    mockGetWorkflowRun.mockRejectedValueOnce(new Error('connection reset'));

    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      'Failed to look up workflow run run-1: connection reset'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      'operations.workflow_resume_lookup_failed'
    );
  });
});

describe('resetWorkflowNodeSessions', () => {
  beforeEach(() => {
    mockDeleteWorkflowNodeSessions.mockClear();
    mockDeleteWorkflowNodeSessions.mockImplementation(() => Promise.resolve({ deleted: 0 }));
  });

  test('passes workflow_name only when scope and node are absent', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 3 });
    const result = await resetWorkflowNodeSessions({ workflow_name: 'feature-dev' });
    expect(result).toEqual({ deleted: 3 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({ workflow_name: 'feature-dev' });
  });

  test('forwards scope and node filters', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 1 });
    const result = await resetWorkflowNodeSessions({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
    expect(result).toEqual({ deleted: 1 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  test('wraps DB errors with a descriptive message', async () => {
    mockDeleteWorkflowNodeSessions.mockRejectedValueOnce(new Error('connection refused'));
    await expect(resetWorkflowNodeSessions({ workflow_name: 'feature-dev' })).rejects.toThrow(
      'Failed to reset workflow node sessions: connection refused'
    );
  });
});

describe('resumeWorkflow stale-owner recovery', () => {
  const claim = 'claim-1';

  function runningRun(owner: Record<string, unknown>): ReturnType<typeof makePausedRun> {
    return makePausedRun({
      status: 'running',
      metadata: {
        [EXECUTION_CLAIM_METADATA_KEY]: claim,
        execution_owner: owner,
      },
    });
  }

  function withActiveNode(
    run: ReturnType<typeof makePausedRun>,
    pgid: number | null | 'none'
  ): ReturnType<typeof makePausedRun> {
    const root = mkdtempSync(join(tmpdir(), 'archon-active-node-'));
    if (pgid !== 'none') {
      const artifacts = getRunArtifactsDirForRoot(root, run.id);
      mkdirSync(artifacts, { recursive: true });
      beginActiveNodeGroup(artifacts, 'exec-1', 'node');
      if (pgid !== null) {
        writeFileSync(activeNodeGroupPgidPath(artifacts, 'exec-1'), `${String(pgid)}\n`);
      }
    }
    return { ...run, output_root: root };
  }

  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockFailWorkflowRun.mockReset();
    mockFailWorkflowRun.mockResolvedValue({ failed: true });
    mockProcessGroupHasLiveMembers.mockReset();
    mockProcessGroupHasLiveMembers.mockResolvedValue(false);
  });

  test('refuses a live owner without touching the run', async () => {
    const observed = await mockReadProcessStartIdentity(process.pid);
    if (observed.status !== 'observed') throw new Error('test host cannot observe its own start');
    mockGetWorkflowRun.mockResolvedValueOnce(
      runningRun({
        host: hostname(),
        pid: process.pid,
        uid: process.getuid?.(),
        startIdentity: observed.identity,
      })
    );
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot resume run with status 'running'"
    );
    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
  });

  test.each([
    [
      'a remote host',
      { host: 'another-host', pid: 4242, startIdentity: 'ps:remote' },
      "Cannot resume run with status 'running'",
    ],
    [
      'another user',
      { host: hostname(), pid: 4242, uid: 999_999, startIdentity: 'ps:other' },
      "Cannot resume run with status 'running'",
    ],
    [
      'a missing start identity',
      { host: hostname(), pid: 4242 },
      'child lifecycle cannot be proven stopped',
    ],
    [
      'a mismatched process start identity',
      { host: hostname(), pid: process.pid, uid: process.getuid?.(), startIdentity: 'ps:wrong' },
      "Cannot resume run with status 'running'",
    ],
    [
      'a missing process group identity',
      { host: hostname(), pid: 999_999, uid: process.getuid?.(), startIdentity: 'ps:dead' },
      'child lifecycle cannot be proven stopped',
    ],
  ])('refuses %s', async (_label, owner, expected) => {
    mockGetWorkflowRun.mockResolvedValueOnce(runningRun(owner));
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(expected);
    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
  });

  test('refuses a dead owner when its process group still has a live node child', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      runningRun({
        host: hostname(),
        pid: 999_999,
        uid: process.getuid?.(),
        startIdentity: 'ps:dead',
        processGroupId: 4242,
      })
    );
    mockProcessGroupHasLiveMembers.mockResolvedValueOnce(true);
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      'process group still has live members'
    );
    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
  });

  test('refuses a dead owner whose recorded node group is still live', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      withActiveNode(
        runningRun({
          host: hostname(),
          pid: 999_999,
          uid: process.getuid?.(),
          startIdentity: 'ps:dead',
          processGroupId: 4242,
        }),
        5555
      )
    );
    mockProcessGroupHasLiveMembers.mockImplementation(async pgid => pgid === 5555);
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      'process group still has live members'
    );
    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
  });

  test('refuses a dead owner whose node group identity is unreadable', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      withActiveNode(
        runningRun({
          host: hostname(),
          pid: 999_999,
          uid: process.getuid?.(),
          startIdentity: 'ps:dead',
          processGroupId: 4242,
        }),
        null
      )
    );
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      'child lifecycle cannot be proven stopped'
    );
    expect(mockFailWorkflowRun).not.toHaveBeenCalled();
  });

  test('recovers a proven-dead owner through the supported failure transition', async () => {
    mockGetWorkflowRun
      .mockResolvedValueOnce(
        withActiveNode(
          runningRun({
            host: hostname(),
            pid: 999_999,
            uid: process.getuid?.(),
            startIdentity: 'ps:dead',
            processGroupId: 4242,
          }),
          'none'
        )
      )
      .mockResolvedValueOnce(
        makePausedRun({ status: 'failed', metadata: { error: 'owner gone' } })
      );
    const run = await resumeWorkflow('run-1', operator);
    expect(run.status).toBe('failed');
    expect(mockFailWorkflowRun).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('Previous execution owner'),
      { exitReason: 'not_finalized', expectedExecutionClaim: claim }
    );
  });

  test('refuses when the recovery transition loses to a new running owner', async () => {
    mockGetWorkflowRun
      .mockResolvedValueOnce(
        withActiveNode(
          runningRun({
            host: hostname(),
            pid: 999_999,
            uid: process.getuid?.(),
            startIdentity: 'ps:dead',
            processGroupId: 4242,
          }),
          'none'
        )
      )
      .mockResolvedValueOnce(
        runningRun({ host: hostname(), pid: 888_888, startIdentity: 'ps:new' })
      );
    mockFailWorkflowRun.mockResolvedValueOnce({ failed: false });
    await expect(resumeWorkflow('run-1', operator)).rejects.toThrow(
      "Cannot resume run with status 'running'"
    );
  });

  test('returns a run another caller already made failed', async () => {
    mockGetWorkflowRun
      .mockResolvedValueOnce(
        withActiveNode(
          runningRun({
            host: hostname(),
            pid: 999_999,
            uid: process.getuid?.(),
            startIdentity: 'ps:dead',
            processGroupId: 4242,
          }),
          'none'
        )
      )
      .mockResolvedValueOnce(
        makePausedRun({ status: 'failed', metadata: { error: 'owner gone' } })
      );
    mockFailWorkflowRun.mockResolvedValueOnce({ failed: false });
    await expect(resumeWorkflow('run-1', operator)).resolves.toMatchObject({ status: 'failed' });
  });
});
