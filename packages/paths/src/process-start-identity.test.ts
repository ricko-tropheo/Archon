import { describe, expect, test } from 'bun:test';
import { readProcessStartIdentity } from './process-start-identity';

describe('readProcessStartIdentity', () => {
  test('observes the current process', async () => {
    const observation = await readProcessStartIdentity(process.pid);
    expect(observation.status).toBe('observed');
    if (observation.status === 'observed') {
      expect(observation.identity.length).toBeGreaterThan(0);
    }
  });

  test('reports a missing pid as absent', async () => {
    const observation = await readProcessStartIdentity(999_999);
    expect(observation.status).toBe('absent');
  });

  test('rejects an invalid pid as unavailable', async () => {
    expect(await readProcessStartIdentity(0)).toEqual({
      status: 'unavailable',
      code: 'INVALID_PID',
    });
    expect(await readProcessStartIdentity(-1)).toEqual({
      status: 'unavailable',
      code: 'INVALID_PID',
    });
  });

  test('the observed identity is stable across reads', async () => {
    const first = await readProcessStartIdentity(process.pid);
    const second = await readProcessStartIdentity(process.pid);
    expect(second).toEqual(first);
  });
});
