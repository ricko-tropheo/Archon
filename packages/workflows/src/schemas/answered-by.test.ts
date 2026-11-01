import { describe, expect, test } from 'bun:test';
import { waitAnsweredEvent } from '../store/attention-writes';
import {
  answeredBySchema,
  approvalContextSchema,
  workflowWaitContextSchema,
  type WorkflowAttentionWaitContext,
} from './workflow-run';

const attentionWait: WorkflowAttentionWaitContext = {
  owner: 'node',
  nodeId: 'ask',
  kind: 'attention',
  waitingSince: '2026-11-01T00:00:00.000Z',
  message: 'Review the hypothesis',
  pauseId: 'ask-1',
  form: 'approval',
};

describe('answeredBy audit shape', () => {
  test('accepts the three resolved actor kinds and rejects raw platform ids', () => {
    expect(answeredBySchema.safeParse({ kind: 'operator' }).success).toBe(true);
    expect(answeredBySchema.safeParse({ kind: 'user', userId: 'archon-user' }).success).toBe(true);
    expect(answeredBySchema.safeParse({ kind: 'unidentified' }).success).toBe(true);
    expect(answeredBySchema.safeParse({ kind: 'user' }).success).toBe(false);
    expect(answeredBySchema.safeParse({ kind: 'user', userId: '' }).success).toBe(false);
    expect(answeredBySchema.safeParse({ platformUserId: 'U123' }).success).toBe(false);
  });

  test('a new attention answer carries answeredBy on the wait and event', () => {
    const answered: WorkflowAttentionWaitContext = {
      ...attentionWait,
      answer: { decision: 'approve', text: '' },
      answeredVia: 'slack',
      answeredAt: '2026-11-01T00:05:00.000Z',
      answeredBy: { kind: 'user', userId: 'admin' },
    };
    expect(workflowWaitContextSchema.parse(answered)).toMatchObject({
      answeredBy: { kind: 'user', userId: 'admin' },
    });
    expect(waitAnsweredEvent('run-1', answered).data).toMatchObject({
      via: 'slack',
      occurrence: 'ask-1',
      answeredBy: { kind: 'user', userId: 'admin' },
    });
  });

  test('an actorless wait and event written by an older build stay readable', () => {
    const legacy: WorkflowAttentionWaitContext = {
      ...attentionWait,
      answer: { decision: 'approve', text: '' },
      answeredVia: 'cli',
      answeredAt: '2026-11-01T00:05:00.000Z',
    };
    expect(workflowWaitContextSchema.parse(legacy)).toMatchObject({ answeredVia: 'cli' });
    expect(workflowWaitContextSchema.parse(legacy)).not.toHaveProperty('answeredBy');
    expect(waitAnsweredEvent('run-1', legacy).data).not.toHaveProperty('answeredBy');
  });

  test('an actorless gate resolved by an older build stays readable', () => {
    const legacy = {
      nodeId: 'gate',
      message: 'Approve?',
      type: 'approval' as const,
      pauseId: 'gate-1',
      resolved: 'approved' as const,
      answeredVia: 'api',
      answeredAt: '2026-11-01T00:05:00.000Z',
    };
    expect(approvalContextSchema.parse(legacy)).toMatchObject({ resolved: 'approved' });
    expect(approvalContextSchema.parse(legacy)).not.toHaveProperty('answeredBy');
  });
});
