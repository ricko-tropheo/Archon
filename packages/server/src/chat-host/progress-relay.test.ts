import { describe, expect, test } from 'bun:test';
import {
  PROGRESS_MAX_CHARS,
  PROGRESS_MAX_LINES,
  PROGRESS_MAX_TOTAL_CHARS,
  ProgressRelay,
  normalizeProgress,
  type ProgressUpdate,
} from './progress-relay';

function harness(intervalMs = 60_000) {
  const flushes: ProgressUpdate[] = [];
  let pending: (() => void) | undefined;
  const relay = new ProgressRelay(update => flushes.push(update), {
    intervalMs,
    schedule: ((fn: () => void) => {
      pending = fn;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    cancel: (() => undefined) as typeof clearTimeout,
  });
  return {
    relay,
    flushes,
    tick(): void {
      const flush = pending;
      pending = undefined;
      flush?.();
    },
  };
}

describe('progress relay', () => {
  test('coalesces blocks and releases one node-labelled excerpt per interval', () => {
    const { relay, flushes, tick } = harness();
    relay.record('run', 'plan', 'plan', 'Reading the spec.');
    relay.record('run', 'plan', 'plan', 'Drafting the plan.');
    expect(flushes).toHaveLength(0);
    tick();
    expect(flushes).toEqual([
      {
        runId: 'run',
        nodeId: 'plan',
        nodeName: 'plan',
        text: 'Reading the spec.\nDrafting the plan.',
      },
    ]);
    // A quiet run emits nothing.
    tick();
    expect(flushes).toHaveLength(1);
  });

  test('redacts credential-shaped text before it can reach a chat thread', () => {
    expect(
      normalizeProgress(
        'using xoxb-1234567890-abcdef and ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
          'with Bearer abcdefghijklmnop and sk-abcdefghijklmnopqrstuvwxyz123456'
      )
    ).toBe('using [redacted] and [redacted] with [redacted] and [redacted]');
  });

  test('redacts a credential split across provider chunks', () => {
    const { relay, flushes, tick } = harness();
    relay.record('run', 'node', 'Node', '-----BEGIN RSA PRIVATE KEY-----');
    relay.record('run', 'node', 'Node', 'MIIEowIBAAKCAQEA-----END RSA PRIVATE KEY-----');
    tick();
    const text = flushes[0]?.text ?? '';
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
  });

  test('caps lines and characters per message', () => {
    const { relay, flushes, tick } = harness();
    for (let index = 0; index < 10; index++) {
      relay.record('run', 'node', 'Node', `line-${index} ${'x'.repeat(220)}`);
    }
    tick();
    const update = flushes[0];
    expect(update).toBeDefined();
    expect(update?.text.length).toBeLessThanOrEqual(PROGRESS_MAX_CHARS);
    expect(update?.text.split('\n').length).toBeLessThanOrEqual(PROGRESS_MAX_LINES);
    // Only the newest lines survive the line cap.
    expect(update?.text).not.toContain('line-0 ');
    expect(update?.text).toContain('line-9 ');

    const second = harness();
    for (let index = 0; index < 2; index++) {
      second.relay.record('run', 'node', 'Node', `line-${index}`);
    }
    second.tick();
    expect(second.flushes[0]?.text).toBe('line-0\nline-1');
    expect(PROGRESS_MAX_LINES).toBe(3);
  });

  test('stops at a hard lifetime budget', () => {
    const { relay, flushes, tick } = harness();
    for (let index = 0; index < 100; index++) {
      relay.record('run', 'node', 'Node', 'y'.repeat(PROGRESS_MAX_CHARS));
      tick();
    }
    const total = flushes.reduce((sum, update) => sum + update.text.length, 0);
    expect(total).toBeLessThanOrEqual(PROGRESS_MAX_TOTAL_CHARS);
    expect(total).toBeGreaterThan(0);
  });

  test('forget flushes the tail and drops the run', () => {
    const { relay, flushes, tick } = harness();
    relay.record('run', 'node', 'Node', 'final line');
    relay.forget('run');
    expect(flushes).toHaveLength(1);
    tick();
    expect(flushes).toHaveLength(1);
  });
});
