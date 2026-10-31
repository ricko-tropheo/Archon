import { describe, expect, test } from 'bun:test';
import { formatFinalMessage } from './final-message';

describe('formatFinalMessage', () => {
  test('a completed run carries its output, usage and elapsed time', () => {
    const message = formatFinalMessage({
      workflowName: 'agent-pipeline-poc',
      runId: '2eb8d556b7d021b29868e2a40e2ca572',
      status: 'completed',
      output: '# Implementation brief\n\nVerdict: **approve**',
      durationMs: 62_000,
      costUsd: 0.0234,
      tokens: { input: 10_100, output: 2_200 },
    });
    expect(message).toContain('✅ **agent-pipeline-poc** completed');
    expect(message).toContain('run `2eb8d556`');
    expect(message).toContain('_elapsed 1m 2s · 12.3k tokens · cost $0.0234_');
    expect(message).toContain('# Implementation brief');
    expect(message).toContain('Verdict: **approve**');
  });

  test('a failed run names the error and both recovery commands', () => {
    const message = formatFinalMessage({
      workflowName: 'agent-pipeline-poc',
      runId: 'run-123456789',
      status: 'failed',
      error: 'node review failed: deadline exceeded',
      durationMs: 400_000,
      commandPrefix: '/archon-workflow ',
    });
    expect(message).toContain('❌ **agent-pipeline-poc** failed');
    expect(message).toContain('node review failed: deadline exceeded');
    expect(message).toContain('Resume: `/archon-workflow resume run-123456789`');
    expect(message).toContain('Stop: `/archon-workflow abandon run-123456789`');
  });

  test('a cancellation adds no duplicate message', () => {
    expect(
      formatFinalMessage({
        workflowName: 'agent-pipeline-poc',
        runId: 'run',
        status: 'cancelled',
        error: 'cancelled by owner',
      })
    ).toBeUndefined();
  });
});
