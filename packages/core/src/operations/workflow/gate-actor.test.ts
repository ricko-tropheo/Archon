import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  answeredBySchema,
  type ApprovalContext,
  type WorkflowRun,
  workflowWaitContextSchema,
} from '@archon/workflows/schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { RunActionForbiddenError } from '../run-authorization';
import { createWorkflowOperations, type WorkflowOperations } from '../workflow-operations';

const roots = trackTempRoots();
const cli = { via: 'cli' } as const;
const operator: RunActor = { kind: 'operator' };
const admin: RunActor = { kind: 'user', userId: 'admin' };
const intruder: RunActor = { kind: 'user', userId: 'intruder' };
const unidentified: RunActor = { kind: 'unidentified' };

let store: IWorkflowStore;
let operations: WorkflowOperations;
const roles = new Map<string, 'admin' | 'member'>();

function approvalContext(): ApprovalContext {
  return {
    nodeId: 'gate',
    message: 'Approve the hypothesis?',
    type: 'approval',
    pauseId: 'gate-1',
  };
}

async function setup(): Promise<void> {
  roles.clear();
  roles.set('admin', 'admin');
  store = await createFileWorkflowStore({
    root: roots(await mkdtemp(join(tmpdir(), 'gate-actor-'))),
  });
  operations = createWorkflowOperations({
    getUserRole: async userId => roles.get(userId),
    store: {
      ...store,
      deleteWorkflowRun: async () => {
        throw new Error('unused');
      },
    },
    hostStore: {
      isolation: {
        getById: async () => null,
        findActiveByWorkflow: async () => null,
        listActive: async () => [],
        create: async () => {
          throw new Error('unused');
        },
        updateStatus: async () => {},
        withWorktreeRegistration: async () => {
          throw new Error('Unexpected worktree removal');
        },
        markWorktreeDestroyed: async () => {},
        updateMetadata: async () => undefined,
        countActiveByCodebase: async () => 0,
      },
    },
    requestDetachedRunStop: async () => {
      throw new Error('unused');
    },
    isRunOwnedByThisProcess: () => false,
    isRunOwnerAnswering: async () => false,
    reclaimContainerEnv: async () => {},
    reclaimRunWorktree: async () => ({ warnings: [] }),
  });
}

async function runningRun(): Promise<WorkflowRun> {
  const run = await store.createWorkflowRun({
    workflow_name: 'investigate',
    user_message: '',
    origin: { userId: 'starter' },
  });
  await store.claimPendingWorkflowRun(run.id);
  return run;
}

async function pausedAttention(): Promise<string> {
  const run = await runningRun();
  await store.pauseWorkflowRunForWait(
    run.id,
    {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-11-01T00:00:00.000Z',
      message: 'Review the hypothesis',
      pauseId: 'ask-1',
      form: 'approval',
    },
    { kind: 'started', stepName: 'ask' }
  );
  return run.id;
}

async function pausedGate(): Promise<string> {
  const run = await runningRun();
  await store.pauseWorkflowRun(run.id, approvalContext());
  return run.id;
}

async function eventsOf(id: string) {
  return store.listWorkflowEvents(id);
}

function answeredByOf(
  events: Awaited<ReturnType<typeof eventsOf>>,
  eventType: 'approval_received' | 'wait_answered'
): unknown {
  return events.find(event => event.event_type === eventType)?.data.answeredBy;
}

describe('gate actor audit', () => {
  test('an admin answering a run someone else started records the admin, not the starter', async () => {
    await setup();
    const id = await pausedAttention();

    await operations.answerWorkflow(id, { choose: ['approve'], text: '' }, admin, cli);

    const run = await store.getWorkflowRun(id);
    expect(run?.user_id).toBe('starter');
    expect(run?.metadata.wait).toMatchObject({
      answer: { decision: 'approve', text: '' },
      answeredVia: 'cli',
      answeredAt: expect.any(String),
      answeredBy: { kind: 'user', userId: 'admin' },
    });
    expect(answeredByOf(await eventsOf(id), 'wait_answered')).toEqual({
      kind: 'user',
      userId: 'admin',
    });
  });

  test('an admin approving a run someone else started records the admin, not the starter', async () => {
    await setup();
    const id = await pausedGate();

    await operations.approveWorkflow(id, 'ship it', admin, cli);

    const run = await store.getWorkflowRun(id);
    expect(run?.user_id).toBe('starter');
    expect(run?.metadata.approval).toMatchObject({
      resolved: 'approved',
      answeredVia: 'cli',
      answeredAt: expect.any(String),
      answeredBy: { kind: 'user', userId: 'admin' },
    });
    expect(answeredByOf(await eventsOf(id), 'approval_received')).toEqual({
      kind: 'user',
      userId: 'admin',
    });
  });

  test('forbidden actors produce no answered event and no persisted answer', async () => {
    await setup();
    const attention = await pausedAttention();
    const gate = await pausedGate();

    await expect(
      operations.answerWorkflow(attention, { choose: ['approve'], text: '' }, intruder, cli)
    ).rejects.toBeInstanceOf(RunActionForbiddenError);
    await expect(operations.approveWorkflow(gate, 'ship it', intruder, cli)).rejects.toBeInstanceOf(
      RunActionForbiddenError
    );

    expect(
      (await eventsOf(attention)).filter(event => event.event_type === 'wait_answered')
    ).toHaveLength(0);
    expect(
      (await eventsOf(gate)).filter(event => event.event_type === 'approval_received')
    ).toHaveLength(0);
    expect((await store.getWorkflowRun(attention))?.metadata.wait).not.toHaveProperty('answer');
    expect((await store.getWorkflowRun(gate))?.metadata.approval).not.toHaveProperty('resolved');
  });

  test('unidentified actors keep the existing refusal and write nothing', async () => {
    await setup();
    const id = await pausedAttention();
    expect(answeredBySchema.safeParse({ kind: 'unidentified' }).success).toBe(true);

    await expect(
      operations.answerWorkflow(id, { choose: ['approve'], text: '' }, unidentified, cli)
    ).rejects.toBeInstanceOf(RunActionForbiddenError);
    expect((await eventsOf(id)).filter(event => event.event_type === 'wait_answered')).toHaveLength(
      0
    );
    expect((await store.getWorkflowRun(id))?.metadata.wait).not.toHaveProperty('answer');
  });

  test('approval and attention audit events carry the same actor shape', async () => {
    await setup();
    const attention = await pausedAttention();
    const gate = await pausedGate();
    await operations.answerWorkflow(attention, { choose: ['approve'], text: '' }, admin, cli);
    await operations.approveWorkflow(gate, 'ship it', admin, cli);

    const attentionActor = answeredByOf(await eventsOf(attention), 'wait_answered');
    const approvalActor = answeredByOf(await eventsOf(gate), 'approval_received');
    expect(attentionActor).toEqual({ kind: 'user', userId: 'admin' });
    expect(approvalActor).toEqual(attentionActor);
    expect(answeredBySchema.parse(attentionActor)).toEqual(answeredBySchema.parse(approvalActor));
  });

  test('an actorless legacy answer stays readable and its event omits answeredBy', async () => {
    await setup();
    const id = await pausedAttention();

    await store.answerAttentionWait(id, {
      pauseId: 'ask-1',
      answer: { decision: 'approve', text: '' },
      answeredVia: 'cli',
      answeredAt: '2026-11-01T00:05:00.000Z',
    });

    const run = await store.getWorkflowRun(id);
    expect(workflowWaitContextSchema.safeParse(run?.metadata.wait).success).toBe(true);
    expect(run?.metadata.wait).not.toHaveProperty('answeredBy');
    expect(answeredByOf(await eventsOf(id), 'wait_answered')).toBeUndefined();
  });

  test('CLI operator answers audit as the operator actor', async () => {
    await setup();
    const id = await pausedGate();
    await operations.approveWorkflow(id, 'ok', operator, cli);
    expect((await store.getWorkflowRun(id))?.metadata.approval).toMatchObject({
      answeredBy: { kind: 'operator' },
    });
  });
});
