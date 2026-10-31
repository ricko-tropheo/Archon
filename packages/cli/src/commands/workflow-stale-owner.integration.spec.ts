import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
const tempRoots = trackTempRoots();

function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 20_000): Promise<T> {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  })();
}

test.skipIf(process.platform === 'win32')(
  'SIGKILL during a node resumes replaying completed nodes and rerunning the interrupted node once',
  async () => {
    const root = tempRoots(mkdtempSync(join(tmpdir(), 'archon-stale-owner-')));
    const project = join(root, 'project');
    const archonHome = join(root, 'home');
    mkdirSync(join(project, '.archon', 'workflows'), { recursive: true });
    writeFileSync(
      join(project, '.archon', 'workflows', 'stale-owner.yaml'),
      `name: stale-owner
description: SIGKILL recovery fixture
worktree:
  enabled: false
nodes:
  - id: first
    bash: echo first >> "$ARTIFACTS_DIR/count"; echo first
  - id: hold
    depends_on: [first]
    bash: |
      echo "$WORKFLOW_ID" > run-id
      echo "$ARTIFACTS_DIR" > artifacts-dir
      if [ -f "$ARTIFACTS_DIR/resume-now" ]; then
        echo resumed >> "$ARTIFACTS_DIR/count"
      else
        echo hold >> "$ARTIFACTS_DIR/count"
        echo $$ > hold.pid
        exec sleep 30
      fi
  - id: last
    depends_on: [hold]
    bash: echo last >> "$ARTIFACTS_DIR/count"; echo last
`,
      'utf8'
    );
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: project });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: project });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: project });
    Bun.spawnSync(['git', 'add', '.'], { cwd: project });
    Bun.spawnSync(['git', 'commit', '-qm', 'fixture'], { cwd: project });

    const env = {
      ...process.env,
      ARCHON_HOME: archonHome,
      ARCHON_TELEMETRY_DISABLED: '1',
    };
    // --detach makes the owner a process-group leader whose node subprocesses
    // are recorded without a lifeline; SIGKILL leaves those children alive.
    const launch = spawnSync(
      process.execPath,
      [cliPath, 'workflow', 'run', 'stale-owner', 'go', '--no-worktree', '--detach', '--json'],
      { cwd: project, env, encoding: 'utf8' }
    );
    expect(launch.status).toBe(0);
    const runId = (JSON.parse(launch.stdout) as { runId: string }).runId;
    const ownerPid = await waitFor(() => {
      const detail = spawnSync(process.execPath, [cliPath, 'workflow', 'get', runId, '--json'], {
        cwd: project,
        env,
        encoding: 'utf8',
      });
      const run = JSON.parse(detail.stdout) as {
        metadata?: { execution_owner?: { pid?: number } };
      };
      return run.metadata?.execution_owner?.pid;
    }, 'the detached owner to stamp its pid');
    const artifacts = await waitFor(() => {
      const path = join(project, 'artifacts-dir');
      return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
    }, 'the held node to publish its artifacts dir');
    const holdPid = Number(
      await waitFor(() => {
        const path = join(project, 'hold.pid');
        return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
      }, 'the held node to publish its pid')
    );

    // A live owner cannot be recovered by a second process.
    const liveResume = spawnSync(process.execPath, [cliPath, 'workflow', 'resume', runId], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    expect(liveResume.status).not.toBe(0);
    expect(`${liveResume.stdout}${liveResume.stderr}`).toContain(
      "Cannot resume run with status 'running'"
    );

    process.kill(ownerPid, 'SIGKILL');
    await Bun.sleep(500);
    // The detached owner left the node child alive; this is the orphan case.
    expect(() => process.kill(holdPid, 0)).not.toThrow();

    const before = spawnSync(process.execPath, [cliPath, 'workflow', 'get', runId, '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    expect(JSON.parse(before.stdout).status).toBe('running');

    // The owner is dead but the node child is still alive. Recovery must refuse
    // rather than start a second execution of the interrupted node.
    const orphaned = spawnSync(process.execPath, [cliPath, 'workflow', 'resume', runId], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    process.stderr.write(
      `DEBUG orphaned status=${String(orphaned.status)} stderr=${orphaned.stderr}\n`
    );
    expect(orphaned.status).not.toBe(0);
    expect(`${orphaned.stdout}${orphaned.stderr}`).toContain(
      'process group still has live members'
    );

    try {
      process.kill(holdPid, 'SIGKILL');
    } catch {
      // The held node already exited.
    }
    await waitFor(() => {
      try {
        process.kill(holdPid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, 'the orphaned node child to exit');
    await Bun.sleep(250);

    writeFileSync(join(artifacts, 'resume-now'), '');
    const resume = spawnSync(process.execPath, [cliPath, 'workflow', 'resume', runId], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(resume.status).toBe(0);

    const counts = readFileSync(join(artifacts, 'count'), 'utf8').trim().split('\n');
    expect(counts.filter(line => line === 'first')).toHaveLength(1);
    expect(counts.filter(line => line === 'hold')).toHaveLength(1);
    expect(counts.filter(line => line === 'resumed')).toHaveLength(1);
    expect(counts.filter(line => line === 'last')).toHaveLength(1);
    const after = spawnSync(process.execPath, [cliPath, 'workflow', 'get', runId, '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    expect(JSON.parse(after.stdout).status).toBe('completed');
    const logs = spawnSync(
      process.execPath,
      [cliPath, 'workflow', 'logs', runId, '--format', 'text'],
      { cwd: project, env, encoding: 'utf8' }
    );
    expect(logs.stdout).toContain('[first] Skipped (prior_success)');
  },
  90_000
);
