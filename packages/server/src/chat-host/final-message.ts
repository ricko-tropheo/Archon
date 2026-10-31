/**
 * The conversation-visible result of a finished chat-dispatched run.
 *
 * Run events already carry progress, gates and the terminal status. They do not
 * carry the run's output or its aggregate usage, so a chat user could see that a
 * workflow completed without ever seeing what it produced. This module formats
 * that follow-up once, for every chat platform; the host sends it through the
 * platform's ordinary `sendMessage` path after the terminal run event.
 */
export interface FinalMessageInput {
  workflowName: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: string;
  error?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: { input?: number; output?: number; total?: number };
  /** The platform's workflow command prefix, e.g. `/archon-workflow `. */
  commandPrefix?: string;
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function statsLine(input: FinalMessageInput): string | undefined {
  const parts: string[] = [];
  if (input.durationMs !== undefined) parts.push(`elapsed ${formatElapsed(input.durationMs)}`);
  if (input.tokens) {
    const summed = (input.tokens.input ?? 0) + (input.tokens.output ?? 0);
    const total = input.tokens.total ?? summed;
    if (total > 0) parts.push(`${formatTokens(total)} tokens`);
  }
  if (input.costUsd !== undefined) parts.push(`cost $${input.costUsd.toFixed(4)}`);
  return parts.length > 0 ? `_${parts.join(' · ')}_` : undefined;
}

/**
 * The follow-up message for a chat-dispatched run, or undefined when there is
 * nothing useful to add (a cancellation is already confirmed by the Cancel
 * control and its action result).
 */
export function formatFinalMessage(input: FinalMessageInput): string | undefined {
  if (input.status === 'cancelled') return undefined;

  const header =
    input.status === 'completed'
      ? `✅ **${input.workflowName}** completed · run \`${shortRunId(input.runId)}\``
      : `❌ **${input.workflowName}** failed · run \`${shortRunId(input.runId)}\``;
  const lines = [header];

  const stats = statsLine(input);
  if (stats) lines.push(stats);

  if (input.status === 'failed') {
    if (input.error) lines.push('', input.error);
    if (input.commandPrefix) {
      lines.push(
        '',
        `Resume: \`${input.commandPrefix}resume ${input.runId}\``,
        `Stop: \`${input.commandPrefix}abandon ${input.runId}\``
      );
    }
    return lines.join('\n');
  }

  const output = input.output?.trim();
  if (output) lines.push('', output);
  return lines.join('\n');
}
