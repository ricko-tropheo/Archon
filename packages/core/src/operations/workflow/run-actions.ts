import { hostname } from 'node:os';
import { readProcessStartIdentity } from '@archon/paths/process-start-identity';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  attentionForm,
  readExecutionOwner,
  readWorkflowWaitContext,
  pausedAttentionWait,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import { executionClaim, type IWorkflowStore } from '@archon/workflows/store';
import {
  signalWorkflowWaitRequestSchema,
  type SignalWorkflowWaitRequest,
} from '../../schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { getLog, type OperationContext } from './context';

export interface WorkflowStatusData {
  runs: DashboardWorkflowRun[];
}

/** Resume refused; the run is unchanged. The message states why. */
export class ResumeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefusedError';
  }
}

export async function signalWorkflowWait(
  ctx: OperationContext,
  runId: string,
  request: SignalWorkflowWaitRequest,
  actor: RunActor
): Promise<{ signaled: boolean }> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_signal_lookup_failed');
  await ctx.assertMayAct(run, actor, 'signal');
  const wait = readWorkflowWaitContext(run.metadata?.wait);
  const { event, occurrence, resumeAt, payload } = signalWorkflowWaitRequestSchema.parse(request);
  if (
    wait?.kind !== 'event' ||
    wait.event !== event ||
    (occurrence !== undefined && wait.pauseId !== occurrence) ||
    (resumeAt !== undefined && wait.resumeAt !== resumeAt)
  )
    return { signaled: false };
  return ctx.store.signalWorkflowWait(runId, wait, payload);
}

export async function deleteWorkflowRun(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<void> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_delete_lookup_failed');
  await ctx.assertMayAct(run, actor, 'delete');
  if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status))
    throw new Error(`Cannot delete workflow in '${run.status}' status — cancel it first`);
  await ctx.store.deleteWorkflowRun(runId);
}

/** List running and paused workflow runs, optionally scoped to one codebase. */
export async function getWorkflowStatus(
  ctx: OperationContext,
  options?: { codebaseId?: string }
): Promise<WorkflowStatusData> {
  const { runs } = await ctx.store.listWorkflowRuns({
    status: ['running', 'paused'],
    limit: 50,
    ...(options?.codebaseId ? { codebaseId: options.codebaseId } : {}),
  });
  return { runs };
}

/**
 * True only when the recorded owner of a running run is on this host and user and
 * its PID is absent. A live or reused PID, a remote host, another user, or an
 * unreadable identity all stay refused: the engine must never guess ownership.
 */
async function runningOwnerIsProvablyGone(run: WorkflowRun): Promise<boolean> {
  const owner = readExecutionOwner(run.metadata);
  if (!owner?.startIdentity) return false;
  if (owner.host !== hostname()) return false;
  if (owner.uid !== process.getuid?.()) return false;
  const observation = await readProcessStartIdentity(owner.pid);
  return observation.status === 'absent';
}

const RUNNING_RESUME_REFUSAL =
  "Cannot resume run with status 'running'. Only failed or paused runs can be resumed.";

/**
 * Validate that a run can be resumed and return it.
 * Does NOT execute the workflow — callers decide whether to run.
 *
 * A `running` run is recoverable only when its recorded owner is proven gone on
 * this host and user. The recovery uses the ordinary supported failure transition
 * (`failWorkflowRun` with the interrupted execution claim), leaving completed node
 * results intact so the subsequent resume replays them and reruns only the
 * interrupted node. Live, remote, other-user, reused-PID, and identity-less owners
 * keep the existing refusal.
 */
export async function resumeWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<WorkflowRun> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_resume_lookup_failed');
  await ctx.assertMayAct(run, actor, 'resume');
  if (run.status === 'running') {
    if (!(await runningOwnerIsProvablyGone(run))) {
      throw new ResumeRefusedError(RUNNING_RESUME_REFUSAL);
    }
    const message =
      `Previous execution owner (host ${readExecutionOwner(run.metadata)?.host ?? 'unknown'}, ` +
      `pid ${String(readExecutionOwner(run.metadata)?.pid ?? 'unknown')}) is gone. ` +
      'Archon recovered the interrupted run; resume replays completed nodes and reruns the interrupted node.';
    try {
      const recovered = await ctx.store.failWorkflowRun(run.id, message, {
        exitReason: 'not_finalized',
        expectedExecutionClaim: executionClaim(run.metadata),
      });
      if (recovered.failed) {
        return await ctx.getRunOrThrow(run.id, 'operations.workflow_resume_recovery_lookup_failed');
      }
    } catch (error) {
      getLog().warn(
        { err: error as Error, runId: run.id },
        'operations.workflow_resume_owner_recovery_failed'
      );
    }
    const current = await ctx.getRunOrThrow(
      run.id,
      'operations.workflow_resume_recovery_lookup_failed'
    );
    if (current.status === 'failed' || current.status === 'paused') return current;
    throw new ResumeRefusedError(RUNNING_RESUME_REFUSAL);
  }
  if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
    throw new ResumeRefusedError(
      `Cannot resume run with status '${run.status}'. Only failed or paused runs can be resumed.`
    );
  }
  // A bare resume continues a message-form wait with empty text, which keeps waits from
  // before answers continuable. Any other form has no answer to continue with.
  const wait = pausedAttentionWait(run);
  if (wait !== undefined && wait.answer === undefined && attentionForm(wait) !== 'message') {
    throw new ResumeRefusedError(
      `Run ${run.id} is waiting for an answer to its '${attentionForm(wait)}' attention wait. ` +
        'Answer it with answer instead of resuming it.'
    );
  }
  return run;
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter: workflow_name is required; scope_key narrows to one conversation (or
 * other scope), node_id narrows to one node within that scope. Omitting both
 * scope_key and node_id deletes every row for the workflow across all scopes.
 *
 * Returns the row count deleted.
 */
export async function resetWorkflowNodeSessions(
  ctx: OperationContext,
  filter: Parameters<IWorkflowStore['deleteWorkflowNodeSessions']>[0]
): Promise<{ deleted: number }> {
  try {
    return await ctx.store.deleteWorkflowNodeSessions(filter);
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, ...filter },
      'operations.workflow_reset_node_sessions_failed'
    );
    throw new Error(`Failed to reset workflow node sessions: ${err.message}`);
  }
}
