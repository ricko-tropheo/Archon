import { hostname } from 'node:os';
import { getRunArtifactsDirForRoot } from '@archon/paths';
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
import { readActiveNodeGroups } from '@archon/workflows/active-node-groups';
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

type RunningRecoveryState =
  | 'recover'
  | 'refuse_live_owner'
  | 'refuse_unknown_identity'
  | 'refuse_live_children';

/**
 * A running run is recoverable only when its owner is on this host/user, its PID
 * start identity is absent, and the owner's process group has no survivors. A
 * node child can outlive a SIGKILLed owner; checking the group prevents a resume
 * from duplicating that node. Live/reused owners, remote/other-user owners, and
 * any owner whose child lifecycle cannot be proven stopped stay refused.
 */
async function runningOwnerRecoveryState(
  run: WorkflowRun,
  groupHasLiveMembers: (pgid: number) => Promise<boolean>
): Promise<RunningRecoveryState> {
  const owner = readExecutionOwner(run.metadata);
  if (!owner?.startIdentity) return 'refuse_unknown_identity';
  if (owner.host !== hostname()) return 'refuse_live_owner';
  if (owner.uid !== process.getuid?.()) return 'refuse_live_owner';
  const observation = await readProcessStartIdentity(owner.pid);
  if (observation.status === 'unavailable') return 'refuse_unknown_identity';
  if (observation.status === 'observed') return 'refuse_live_owner';
  if (owner.processGroupId === undefined) return 'refuse_unknown_identity';
  if (await groupHasLiveMembers(owner.processGroupId)) return 'refuse_live_children';

  // The owner's own group does not contain node subprocesses (Archon runs each
  // node in its own session). A start marker is written before each spawn; a
  // missing/invalid pgid or a live marked group means the interrupted node may
  // still be running, so recovery stays refused.
  if (!run.output_root) return 'refuse_unknown_identity';
  const active = readActiveNodeGroups(getRunArtifactsDirForRoot(run.output_root, run.id));
  for (const group of active) {
    if (!group.valid || group.pgid === null) return 'refuse_unknown_identity';
    if (await groupHasLiveMembers(group.pgid)) return 'refuse_live_children';
  }
  return 'recover';
}

const RUNNING_RESUME_REFUSAL =
  "Cannot resume run with status 'running'. Only failed or paused runs can be resumed.";

async function recoverRunningRun(ctx: OperationContext, run: WorkflowRun): Promise<WorkflowRun> {
  const recovery = await runningOwnerRecoveryState(run, ctx.processGroupHasLiveMembers);
  if (recovery === 'refuse_live_owner') {
    throw new ResumeRefusedError(RUNNING_RESUME_REFUSAL);
  }
  if (recovery === 'refuse_unknown_identity') {
    throw new ResumeRefusedError(
      `Cannot resume running run '${run.id}': its execution owner or child lifecycle cannot be proven stopped.`
    );
  }
  if (recovery === 'refuse_live_children') {
    throw new ResumeRefusedError(
      `Cannot resume running run '${run.id}': the recorded owner is gone but its process group still has live members. ` +
        'Stop the orphaned node process (or abandon the run) before resuming.'
    );
  }
  const owner = readExecutionOwner(run.metadata);
  const message =
    `Previous execution owner (host ${owner?.host ?? 'unknown'}, ` +
    `pid ${String(owner?.pid ?? 'unknown')}) is gone. ` +
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
    return recoverRunningRun(ctx, run);
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
