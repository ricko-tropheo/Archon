import { ChildRunRedirectError } from '@archon/core/operations/workflow-operations';
import { isApprovalContext } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowPlatform, WorkflowCommandSurface } from '@archon/workflows/deps';
import { getApprovalDecisions } from '@archon/workflows/schemas/dag-node';
import type { ChatRunEvent } from '@archon/chat-contract';
import { parseRunUsage } from '@archon/workflows/schemas/run-usage';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import * as workflowDb from '@archon/core/db/workflows';
import * as conversationDb from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import type { ChatSupervisor } from './supervisor';
import { formatFinalMessage } from './final-message';
import { PROGRESS_INTERVAL_MS, ProgressRelay, type ProgressUpdate } from './progress-relay';

type WorkflowStarted = Extract<ChatRunEvent, { type: 'workflow_started' }>;
/** A chat run event before routing supplies the platform conversation id. */
type ProjectedRunEvent =
  | Exclude<ChatRunEvent, WorkflowStarted>
  | Omit<WorkflowStarted, 'conversationId'>;

/** The run's recorded total cost, when it is a usable amount. */
export function runTotalCostUsd(run: WorkflowRun): number | undefined {
  const cost = run.metadata.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export function projectRunEvent(event: WorkflowEmitterEvent): ProjectedRunEvent | undefined {
  const runId = event.runId;
  switch (event.type) {
    case 'workflow_started':
      return { type: 'workflow_started', runId, workflowName: event.workflowName };
    case 'node_started':
    case 'node_suspended':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'running',
      };
    case 'node_skipped_prior_success':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'completed',
      };
    case 'node_completed':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'completed',
        durationMs: event.duration,
      };
    case 'node_failed':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'failed',
        error: event.error,
      };
    case 'node_skipped':
      return {
        type: 'node_state',
        runId,
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        state: 'skipped',
      };
    case 'approval_pending':
      return {
        type: 'approval_pending',
        runId,
        nodeId: event.nodeId,
        message: event.message,
        decisions: getApprovalDecisions(event),
        pauseId: event.pauseId,
      };
    case 'workflow_completed':
      return { type: 'terminal', runId, status: 'completed' };
    case 'workflow_failed':
      return { type: 'terminal', runId, status: 'failed', error: event.error };
    case 'workflow_cancelled':
      return { type: 'terminal', runId, status: 'cancelled', error: event.reason };
    case 'loop_iteration_started':
    case 'loop_iteration_completed':
    case 'loop_iteration_failed':
    case 'workflow_artifact':
    case 'provider_event':
    case 'container_lifecycle':
    case 'run_attention_changed':
      return undefined;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function applyRunDetails(
  run: WorkflowRun,
  routed: ChatRunEvent,
  platform: string,
  platforms: ReadonlyMap<string, WorkflowCommandSurface>
): void {
  if (routed.type === 'approval_pending' || routed.type === 'terminal')
    routed.authoredOutcome = run.outcome ?? undefined;
  const approval = run.metadata.approval;
  if (
    routed.type === 'approval_pending' &&
    isApprovalContext(approval) &&
    approval.type === 'child_workflow' &&
    approval.childRunId &&
    approval.nodeId === routed.nodeId &&
    approval.pauseId === routed.pauseId
  ) {
    const surface = platforms.get(platform);
    if (!surface) throw new Error(`Chat platform ${platform} is unavailable`);
    routed.message = new ChildRunRedirectError(
      run.id,
      [approval.childRunId],
      routed.nodeId,
      'approve'
    ).messageFor(surface);
  }
  if (routed.type === 'terminal') {
    const cost = runTotalCostUsd(run);
    if (cost !== undefined) routed.totalCostUsd = cost;
  }
}

export interface ChatRunEventOptions {
  /** Test seam for the live-progress interval. Defaults to one minute. */
  progressIntervalMs?: number;
}

export function subscribeChatRunEvents(
  plugins: ReadonlyMap<string, ChatSupervisor>,
  platforms: ReadonlyMap<string, IWorkflowPlatform>,
  options: ChatRunEventOptions = {}
): () => void {
  const log = createLogger('server.chat-events');
  const emitter = getWorkflowEventEmitter();
  let stopped = false;
  // Routing reads the DB in emission order; delivery runs on one chain per
  // plugin so a stalled plugin's runEvent never delays another plugin's events.
  let routing = Promise.resolve();
  const deliveries = new Map<string, Promise<void>>();
  // Provider events name a node by its persisted step name; node_started is the
  // only event that carries the display name.
  const nodeNames = new Map<string, Map<string, string>>();

  const fail =
    (runId: string, eventType: string) =>
    (error: unknown): void => {
      log.warn({ err: error, eventType, workflowRunId: runId }, 'chat.run_event_failed');
    };

  const route = (
    runId: string,
    build: (run: WorkflowRun, platformConversationId: string) => ChatRunEvent | undefined,
    original?: WorkflowEmitterEvent
  ): Promise<void> => {
    const work = routing.then(async () => {
      if (stopped) return;
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return;
      const id = run.parent_conversation_id ?? run.conversation_id;
      if (!id) return;
      const conversation = await conversationDb.getConversationById(id);
      if (!conversation?.platform_conversation_id) return;
      const platform = conversation.platform_type;
      const plugin = plugins.get(platform);
      if (!plugin?.plugin.descriptor.capabilities.runEvents) return;
      const routed = build(run, conversation.platform_conversation_id);
      if (!routed) return;
      applyRunDetails(run, routed, platform, platforms);
      const delivery = (deliveries.get(platform) ?? Promise.resolve())
        .then(async () => {
          if (stopped) return;
          await plugin.runEvent(routed);
          if (routed.type !== 'terminal' || original === undefined) return;
          const surface = platforms.get(platform);
          if (surface === undefined) return;
          const usage = parseRunUsage(run.metadata);
          const duration =
            original.type === 'workflow_completed'
              ? original.duration
              : run.completed_at !== null
                ? run.completed_at.getTime() - run.started_at.getTime()
                : Date.now() - run.started_at.getTime();
          const message = formatFinalMessage({
            workflowName: run.workflow_name,
            runId: run.id,
            status: routed.status,
            ...(original.type === 'workflow_completed' && original.output !== undefined
              ? { output: original.output }
              : {}),
            ...(original.type === 'workflow_failed' ? { error: original.error } : {}),
            ...(original.type === 'workflow_cancelled' ? { error: original.reason } : {}),
            durationMs: duration,
            ...(runTotalCostUsd(run) !== undefined ? { costUsd: runTotalCostUsd(run) } : {}),
            ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
            ...(surface.formatWorkflowCommand !== undefined
              ? { commandPrefix: surface.formatWorkflowCommand('') }
              : {}),
          });
          if (message !== undefined) {
            await surface.sendMessage(conversation.platform_conversation_id, message);
          }
        })
        .catch(fail(runId, routed.type));
      deliveries.set(platform, delivery);
    });
    routing = work.catch(fail(runId, 'routing'));
    return work;
  };

  const relay = new ProgressRelay(
    (update: ProgressUpdate) => {
      void route(update.runId, () => ({
        type: 'node_state',
        runId: update.runId,
        nodeId: update.nodeId,
        nodeName: update.nodeName,
        state: 'running',
        progress: update.text,
      })).catch(fail(update.runId, 'progress'));
    },
    { intervalMs: options.progressIntervalMs ?? PROGRESS_INTERVAL_MS }
  );

  const unsubscribe = emitter.subscribe(event => {
    if (event.type === 'workflow_started') {
      nodeNames.set(event.runId, new Map());
    }
    if (event.type === 'node_started' || event.type === 'node_suspended') {
      const names = nodeNames.get(event.runId) ?? new Map<string, string>();
      names.set(event.nodeId, event.nodeName);
      nodeNames.set(event.runId, names);
    }
    if (event.type === 'provider_event') {
      if (event.event.type !== 'agent_message_chunk') return;
      const nodeName = nodeNames.get(event.runId)?.get(event.stepName) ?? event.stepName;
      relay.record(event.runId, event.stepName, nodeName, event.event.text);
      return;
    }
    if (
      event.type === 'workflow_completed' ||
      event.type === 'workflow_failed' ||
      event.type === 'workflow_cancelled'
    ) {
      relay.forget(event.runId);
      nodeNames.delete(event.runId);
    }
    const projected = projectRunEvent(event);
    if (!projected) return;
    void route(
      event.runId,
      (run, conversationId) => {
        if (projected.type === 'workflow_started') return { ...projected, conversationId };
        if (projected.type === 'approval_pending')
          return { ...projected, conversationId, workflowName: run.workflow_name };
        if (projected.type === 'terminal')
          return { ...projected, conversationId, workflowName: run.workflow_name };
        return projected;
      },
      event
    ).catch(fail(event.runId, event.type));
  });
  return () => {
    stopped = true;
    relay.close();
    unsubscribe();
  };
}
