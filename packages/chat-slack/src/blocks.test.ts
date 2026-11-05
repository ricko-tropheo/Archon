import { describe, expect, test } from 'bun:test';
import { descriptor } from './descriptor';

import {
  buildApprovalBlocks,
  buildAttentionNoticeBlocks,
  buildClosedApprovalBlocks,
  buildSettledNoticeBlocks,
  parseApprovalValue,
  buildApprovalResolutionBlocks,
  buildStatusBlocks,
  formatCostFooter,
  REACTION_FAILURE,
  REACTION_RUNNING,
  REACTION_SUCCESS,
  type RunSnapshot,
} from './blocks';

describe('formatCostFooter', () => {
  test('returns null when neither cost nor tokens are present', () => {
    expect(formatCostFooter({})).toBeNull();
  });

  test('returns null when cost is undefined and tokens are zero', () => {
    expect(formatCostFooter({ tokens: { input: 0, output: 0 } })).toBeNull();
  });

  test('formats cost only', () => {
    expect(formatCostFooter({ cost: 0.0234 })).toBe('_cost: $0.0234_');
  });

  test('formats tokens from input+output sum', () => {
    expect(formatCostFooter({ tokens: { input: 1500, output: 500 } })).toBe('_2.0k tokens_');
  });

  test('formats tokens using explicit total when provided', () => {
    expect(formatCostFooter({ tokens: { input: 0, output: 0, total: 12345 } })).toBe(
      '_12.3k tokens_'
    );
  });

  test('formats millions with M suffix', () => {
    expect(formatCostFooter({ tokens: { input: 1_200_000, output: 800_000 } })).toBe(
      '_2.0M tokens_'
    );
  });

  test('combines cost, tokens, and stopReason', () => {
    expect(
      formatCostFooter({
        cost: 0.1234,
        tokens: { input: 5000, output: 7500 },
        stopReason: 'end_turn',
      })
    ).toBe('_cost: $0.1234 · 12.5k tokens · stop: end_turn_');
  });

  test('drops non-finite cost', () => {
    expect(formatCostFooter({ cost: Number.NaN })).toBeNull();
    expect(formatCostFooter({ cost: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('buildApprovalBlocks', () => {
  test('renders every declared choice and actionable fallback with exact IDs', () => {
    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: 'r1',
      nodeId: 'review',
      message: 'Choose',
      decisions: [
        { id: 'approve', label: 'Ship it' },
        { id: 'revise', label: 'Try again' },
        { id: 'cancel' },
      ],
    });
    const actions = blocks.find(block => block.type === 'actions');
    expect(actions).toMatchObject({
      elements: [
        { text: { text: 'Ship it' }, action_id: 'respond:0' },
        { text: { text: 'Try again' }, action_id: 'respond:1' },
        { text: { text: 'cancel' }, action_id: 'respond:2' },
      ],
    });
    expect(fallbackText).toContain('/archon-workflow respond r1 revise [text]');
    expect(fallbackText).toContain('Try again (revise)');
    expect(fallbackText).not.toContain('reject');
  });

  test('renders all 26 decisions across bounded action blocks', () => {
    const decisions = Array.from({ length: 26 }, (_, i) => ({
      id: i === 0 ? 'approve' : `choice-${String(i)}`,
    }));
    const { blocks } = buildApprovalBlocks({
      runId: 'r1',
      nodeId: 'review',
      message: 'Choose',
      decisions,
    });
    const actions = blocks.filter(block => block.type === 'actions');
    expect(actions).toHaveLength(2);
    for (const block of actions) expect(block.elements.length).toBeLessThanOrEqual(25);
    expect(
      actions
        .flatMap(block => block.elements)
        .map(element => ('action_id' in element ? element.action_id : undefined))
    ).toEqual(decisions.map((_, i) => `respond:${String(i)}`));
    expect(
      actions
        .flatMap(block => block.elements)
        .map(element =>
          'value' in element && typeof element.value === 'string'
            ? parseApprovalValue(element.value)?.decision
            : undefined
        )
    ).toEqual(decisions.map(d => d.id));
  });

  test('a 256-character decision ID fits the Slack action transport', () => {
    const decision = 'a'.repeat(256);
    const { blocks } = buildApprovalBlocks({
      runId: 'r1',
      nodeId: 'review',
      message: 'Choose',
      decisions: [{ id: 'approve' }, { id: decision }],
    });
    const actions = blocks.filter(block => block.type === 'actions');
    expect(actions).toHaveLength(1);
    for (const element of actions.flatMap(block => block.elements)) {
      if ('action_id' in element) expect(element.action_id?.length).toBeLessThanOrEqual(255);
    }
    expect(actions[0]?.elements[1]).toMatchObject({
      value: JSON.stringify({ runId: 'r1', nodeId: 'review', decision }),
    });
  });

  test('oversized decision values render commands without invalid controls', () => {
    const decision = 'a'.repeat(2001);
    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: 'r1',
      nodeId: 'review',
      message: 'Choose',
      decisions: [{ id: 'approve' }, { id: decision }],
    });
    expect(blocks.some(block => block.type === 'actions')).toBe(false);
    expect(fallbackText).toContain(`/archon-workflow respond r1 ${decision} [text]`);
    expect(blocks).toEqual([]);
  });

  test('produces section + actions block with both buttons', () => {
    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: 'a1b2c3d4-deadbeef',
      nodeId: 'review-step',
      message: 'Approve the migration?',
      decisions: [{ id: 'approve' }, { id: 'reject' }],
    });

    expect(fallbackText).toContain('Approval needed for run a1b2c3d4');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
    });
    const sectionText = (blocks[0] as { text: { text: string } }).text.text;
    expect(sectionText).toContain('Approval needed');
    expect(sectionText).toContain('Approve the migration?');
    expect(sectionText).toContain('a1b2c3d4');

    const actions = blocks[1] as {
      type: string;
      block_id?: string;
      elements: Array<{ type: string; action_id: string; style?: string }>;
    };
    expect(actions.type).toBe('actions');
    expect(actions.block_id).toBe('approval:0');
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0]?.action_id).toBe('respond:0');
    expect(actions.elements[0]?.style).toBe('primary');
    expect(actions.elements[1]?.action_id).toBe('respond:1');
    expect(actions.elements[1]?.style).toBe('danger');
  });
});

describe('buildApprovalResolutionBlocks', () => {
  test('approved variant includes actor and original message, no buttons', () => {
    const { blocks } = buildApprovalResolutionBlocks({
      runId: 'a1b2c3d4-x',
      nodeId: 'review',
      decision: 'approve',
      actorUserId: 'U123ALICE',
      originalMessage: 'Approve the migration?',
      outcomeNote: 'workflow resumed',
    });

    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain('Approved');
    expect(text).toContain('<@U123ALICE>');
    expect(text).toContain('Approve the migration?');
    expect(text).toContain('workflow resumed');
  });

  test('rejected variant uses red x and Rejected label', () => {
    const { blocks } = buildApprovalResolutionBlocks({
      runId: 'a1b2c3d4-x',
      nodeId: 'review',
      decision: 'reject',
      actorUserId: 'U123BOB',
      originalMessage: 'Approve?',
    });
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain('Rejected');
    expect(text).toContain(':x:');
  });
});

describe('buildStatusBlocks', () => {
  const startedAt = 1_000_000;

  function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
      runId: 'a1b2c3d4-zzzz',
      workflowName: 'assist',
      startedAt,
      status: 'running',
      nodes: [],
      ...overrides,
    };
  }

  test('running snapshot includes Cancel button and elapsed time', () => {
    const { blocks } = buildStatusBlocks(snapshot(), startedAt + 12_345);
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('Workflow running');
    expect(header).toContain('`assist`');
    expect(header).toContain('`a1b2c3d4`');
    expect(header).toContain('12s');

    const last = blocks[blocks.length - 1] as {
      type: string;
      block_id?: string;
      elements?: Array<{ action_id: string }>;
    };
    expect(last.type).toBe('actions');
    expect(last.block_id).toBe('run-controls:a1b2c3d4-zzzz');
    expect(last.elements?.[0]?.action_id).toBe('cancel:a1b2c3d4-zzzz');
  });

  test('renders node list with state glyphs', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        nodes: [
          { nodeId: 'a', nodeName: 'plan', state: 'completed', durationMs: 4000 },
          { nodeId: 'b', nodeName: 'review', state: 'running' },
          { nodeId: 'c', nodeName: 'apply', state: 'pending' },
          { nodeId: 'd', nodeName: 'verify', state: 'failed', error: 'boom' },
          { nodeId: 'e', nodeName: 'cleanup', state: 'skipped' },
        ],
      }),
      startedAt + 5000
    );
    const nodeBlock = blocks[1] as { text: { text: string } };
    const text = nodeBlock.text.text;
    expect(text).toContain(':white_check_mark: `plan`');
    expect(text).toContain('4s');
    expect(text).toContain(':hourglass_flowing_sand: `review`');
    expect(text).toContain(':white_circle: `apply`');
    expect(text).toContain(':x: `verify`');
    expect(text).toContain('boom');
    expect(text).toContain(':fast_forward: `cleanup`');
  });

  test('terminal completed snapshot drops Cancel button and shows total cost', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        status: 'completed',
        totalCostUsd: 0.123,
      }),
      startedAt + 1000
    );
    expect(blocks.find(b => (b as { type: string }).type === 'actions')).toBeUndefined();
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('Workflow completed');
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('total cost: $0.1230');
  });

  test('terminal snapshot labels execution and contradictory authored outcome separately', () => {
    const { blocks, fallbackText } = buildStatusBlocks(
      snapshot({
        status: 'completed',
        authoredOutcome: 'failed',
      }),
      startedAt + 1000
    );
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('*Execution status:* `completed`');
    expect(header).toContain('*Authored outcome:* `failed`');
    expect(fallbackText).toContain('authored outcome: failed');
  });

  test('paused snapshot labels execution and authored outcome separately', () => {
    const { blocks, fallbackText } = buildStatusBlocks(
      snapshot({
        status: 'paused',
        authoredOutcome: 'succeeded',
      }),
      startedAt + 1000
    );
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('Workflow paused');
    expect(header).toContain('*Execution status:* `paused`');
    expect(header).toContain('*Authored outcome:* `succeeded`');
    expect(fallbackText).toContain('authored outcome: succeeded');
  });

  test('distinguishes an unavailable authored outcome from an undeclared outcome', () => {
    const { blocks, fallbackText } = buildStatusBlocks(
      snapshot({
        status: 'completed',
        authoredOutcome: 'unavailable',
      }),
      startedAt + 1000
    );
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('*Authored outcome:* unavailable — failed to read persisted run');
    expect(fallbackText).toContain('authored outcome: unavailable — failed to read persisted run');
  });

  test('terminal snapshot keeps the existing presentation when outcome is null', () => {
    const withoutOutcome = buildStatusBlocks(snapshot({ status: 'completed' }), startedAt + 1000);
    expect(withoutOutcome.fallbackText).toBe(':white_check_mark: Workflow completed (assist)');
    expect((withoutOutcome.blocks[0] as { text: { text: string } }).text.text).not.toContain(
      'Authored outcome'
    );
  });

  test('terminal failed snapshot shows reason', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        status: 'failed',
        failureReason: 'Type error in plan node',
      }),
      startedAt + 1000
    );
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('reason: Type error in plan node');
  });

  test('terminal failed snapshot offers Resume and Abandon instead of Cancel', () => {
    const { blocks } = buildStatusBlocks(snapshot({ status: 'failed' }), startedAt + 1000);
    const actions = blocks.find(b => (b as { type: string }).type === 'actions') as {
      elements: Array<{ action_id: string; text: { text: string } }>;
    };
    expect(actions.elements.map(element => element.text.text)).toEqual(['Resume', 'Abandon']);
    expect(actions.elements.map(element => element.action_id)).toEqual([
      'resume:a1b2c3d4-zzzz',
      'abandon:a1b2c3d4-zzzz',
    ]);
    expect(JSON.stringify(blocks)).not.toContain('cancel:a1b2c3d4-zzzz');
  });

  test('terminal cancelled snapshot also surfaces reason', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        status: 'cancelled',
        failureReason: 'user clicked cancel',
      }),
      startedAt + 1000
    );
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('reason: user clicked cancel');
  });
});

describe('reaction name constants', () => {
  test('are stable Slack emoji names', () => {
    expect(REACTION_RUNNING).toBe('arrows_counterclockwise');
    expect(REACTION_SUCCESS).toBe('white_check_mark');
    expect(REACTION_FAILURE).toBe('x');
  });
});

test('approval and recovery hints follow the descriptor prefix', () => {
  const original = descriptor.workflowCommand.prefix;
  descriptor.workflowCommand.prefix = '/test-workflow ';
  try {
    expect(
      buildApprovalBlocks({
        runId: 'run',
        nodeId: 'review',
        message: 'Choose',
        decisions: [{ id: 'approve' }],
      }).fallbackText
    ).toBe(
      'Approval needed for run run\nChoose\napprove: /test-workflow respond run approve [text]'
    );
    const recovery = buildStatusBlocks(
      {
        runId: 'run',
        workflowName: 'assist',
        startedAt: 0,
        nodes: [],
        status: 'paused',
        approvalDeliveryFailed: true,
      },
      0
    );
    expect(recovery.fallbackText).toContain('`/test-workflow get run`');
    expect(recovery.fallbackText).toContain('`/test-workflow respond`');
    expect(JSON.stringify(recovery.blocks)).toContain('`/test-workflow get run`');
    expect(JSON.stringify(recovery.blocks)).toContain('`/test-workflow respond`');
  } finally {
    descriptor.workflowCommand.prefix = original;
  }
});

describe('Slack entity escaping', () => {
  test('status cards escape node names, errors, and failure reasons', () => {
    const { blocks } = buildStatusBlocks(
      {
        runId: 'run',
        workflowName: 'assist',
        startedAt: 0,
        status: 'failed',
        failureReason: '<!everyone> because',
        nodes: [
          { nodeId: 'plan', nodeName: '<!here>plan', state: 'failed', error: '<!channel> boom' },
        ],
      },
      1
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('&lt;!here&gt;plan');
    expect(text).toContain('&lt;!channel&gt; boom');
    expect(text).toContain('&lt;!everyone&gt; because');
    expect(text).not.toContain('<!here>');
    expect(text).not.toContain('<!channel>');
  });

  test('approval and closed-approval messages are escaped', () => {
    const approval = buildApprovalBlocks({
      runId: 'run',
      nodeId: 'gate',
      message: '<!channel> review this',
      decisions: [{ id: 'approve' }],
    });
    expect(JSON.stringify(approval.blocks)).toContain('&lt;!channel&gt; review this');
    const closed = buildClosedApprovalBlocks({
      runId: 'run',
      terminalStatus: 'completed',
      originalMessage: '<!here> closed',
    });
    expect(JSON.stringify(closed.blocks)).toContain('&lt;!here&gt; closed');
    const resolved = buildApprovalResolutionBlocks({
      runId: 'run',
      nodeId: 'gate',
      decision: '<!channel>choose',
      actorUserId: 'U123ALICE',
      originalMessage: '<!channel> resolved',
      outcomeNote: '<!here> note',
    });
    const resolvedText = JSON.stringify(resolved.blocks);
    expect(resolvedText).toContain('Selected &lt;!channel&gt;choose');
    expect(resolvedText).toContain('&lt;!channel&gt; resolved');
    expect(resolvedText).toContain('&lt;!here&gt; note');
    expect(resolvedText).not.toContain('<!channel>');
    expect(resolvedText).toContain('<@U123ALICE>');
  });

  test('approval resolution stays under the Slack section limit', () => {
    const { blocks } = buildApprovalResolutionBlocks({
      runId: 'run',
      nodeId: 'gate',
      decision: 'approve',
      actorUserId: 'U123ALICE',
      originalMessage: 'x'.repeat(2900),
      outcomeNote: 'y'.repeat(500),
    });
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain('Approved');
  });

  test('notice headers escape the workflow name and keep the actor mention', () => {
    const notice = {
      type: 'gate' as const,
      runId: 'run',
      workflowName: '<!here>assist',
      nodeId: 'gate',
      pauseId: 'pause',
      message: 'Choose',
      gateType: 'approval' as const,
      decisions: [{ id: 'approve' }],
    };
    const attentionText = JSON.stringify(buildAttentionNoticeBlocks(notice).blocks);
    expect(attentionText).toContain('&lt;!here&gt;assist');
    expect(attentionText).not.toContain('<!here>');

    const settledText = JSON.stringify(
      buildSettledNoticeBlocks(notice, 'run', 'Done', 'U123ALICE').blocks
    );
    expect(settledText).toContain('&lt;!here&gt;assist');
    expect(settledText).toContain('<@U123ALICE>');
  });

  test('attention and settled notices are escaped', () => {
    const notice = {
      type: 'gate' as const,
      runId: 'run',
      workflowName: 'assist',
      nodeId: 'gate',
      pauseId: 'pause',
      message: '<!channel> choose',
      gateType: 'approval' as const,
      decisions: [{ id: 'approve' }],
    };
    expect(JSON.stringify(buildAttentionNoticeBlocks(notice).blocks)).toContain(
      '&lt;!channel&gt; choose'
    );
    const settled = buildSettledNoticeBlocks(undefined, 'run', '<!here> done');
    expect(JSON.stringify(settled.blocks)).toContain('&lt;!here&gt; done');

    const withActor = buildSettledNoticeBlocks(
      notice,
      'run',
      '<!here> done',
      'U123ALICE',
      '<!channel> note'
    );
    const withActorText = JSON.stringify(withActor.blocks);
    expect(withActorText).toContain('&lt;!here&gt; done');
    expect(withActorText).toContain('&lt;!channel&gt; note');
    expect(withActorText).toContain('<@U123ALICE>');
    expect(withActorText).not.toContain('&lt;@U123ALICE&gt;');
  });
});
