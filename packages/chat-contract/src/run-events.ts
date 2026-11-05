import { z } from 'zod';

const id = z.string().min(1);
export const chatAuthoredOutcomeSchema = z.enum(['succeeded', 'failed', 'unavailable']);
export const chatApprovalDecisionSchema = z.object({ id, label: z.string().optional() });
export const chatRunEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow_started'),
    runId: id,
    conversationId: id,
    workflowName: id,
  }),
  z.object({
    type: z.literal('node_state'),
    runId: id,
    nodeId: id,
    nodeName: id,
    state: z.enum(['running', 'completed', 'failed', 'skipped']),
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
    /**
     * A bounded excerpt of the node's live agent output. Present on the periodic
     * progress projection so a chat surface can show work in progress without a
     * new event variant; a surface that does not know the field still sees an
     * ordinary running node.
     */
    progress: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('approval_pending'),
    runId: id,
    nodeId: id,
    message: z.string(),
    decisions: z.array(chatApprovalDecisionSchema),
    pauseId: id.optional(),
    authoredOutcome: chatAuthoredOutcomeSchema.optional(),
    /** Present so a surface that missed `workflow_started` can seed its run state. */
    conversationId: id.optional(),
    workflowName: id.optional(),
  }),
  z.object({
    type: z.literal('terminal'),
    runId: id,
    status: z.enum(['completed', 'failed', 'cancelled']),
    error: z.string().optional(),
    authoredOutcome: chatAuthoredOutcomeSchema.optional(),
    totalCostUsd: z.number().nonnegative().optional(),
    /** Present so a surface that missed `workflow_started` can still close out a run. */
    conversationId: id.optional(),
    workflowName: id.optional(),
  }),
]);
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
