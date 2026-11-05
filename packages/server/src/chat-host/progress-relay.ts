/**
 * A bounded relay for live agent text. Providers emit a block of text per
 * `agent_message_chunk`; forwarding every block would flood a chat thread, so
 * the relay coalesces blocks per run and releases at most one short message per
 * interval. A hard byte budget stops a runaway stream even if it never stops.
 */
export const PROGRESS_INTERVAL_MS = 60_000;
export const PROGRESS_MAX_LINES = 3;
export const PROGRESS_MAX_CHARS = 600;
export const PROGRESS_MAX_TOTAL_CHARS = 20_000;

export interface ProgressUpdate {
  runId: string;
  nodeId: string;
  nodeName: string;
  text: string;
}

interface Buffered {
  nodeId: string;
  nodeName: string;
  lines: string[];
  chars: number;
  totalChars: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Known credential shapes. Progress is free text from a model, so it may quote a
 * tool command or an environment line; redact recognised secrets before the text
 * ever leaves the server.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
];

export function redactProgress(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

export function normalizeProgress(text: string): string {
  return redactProgress(text).replace(/\s+/g, ' ').trim();
}

export interface ProgressRelayOptions {
  intervalMs?: number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}

export class ProgressRelay {
  private readonly buffers = new Map<string, Buffered>();
  private readonly intervalMs: number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;

  constructor(
    private readonly onFlush: (update: ProgressUpdate) => void,
    options: ProgressRelayOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }

  record(runId: string, nodeId: string, nodeName: string, text: string): void {
    const clean = normalizeProgress(text);
    if (clean === '') return;
    const buffer = this.buffers.get(runId) ?? {
      nodeId,
      nodeName,
      lines: [],
      chars: 0,
      totalChars: 0,
    };
    this.buffers.set(runId, buffer);
    if (buffer.totalChars >= PROGRESS_MAX_TOTAL_CHARS) return;
    buffer.nodeId = nodeId;
    buffer.nodeName = nodeName;
    buffer.lines.push(clean);
    buffer.chars += clean.length;
    // Keep only the newest few lines and never exceed the per-message budget.
    while (buffer.lines.length > PROGRESS_MAX_LINES) {
      buffer.chars -= buffer.lines.shift()?.length ?? 0;
    }
    while (buffer.chars > PROGRESS_MAX_CHARS && buffer.lines.length > 1) {
      buffer.chars -= buffer.lines.shift()?.length ?? 0;
    }
    if (buffer.chars > PROGRESS_MAX_CHARS) {
      const line = buffer.lines[0] ?? '';
      const cut = line.slice(0, Math.max(0, PROGRESS_MAX_CHARS - 1)) + '…';
      buffer.lines[0] = cut;
      buffer.chars = cut.length;
    }
    if (buffer.timer === undefined) {
      buffer.timer = this.schedule(() => this.flush(runId), this.intervalMs);
      buffer.timer.unref?.();
    }
  }

  /** Release one run's buffered text, if any. */
  flush(runId: string): void {
    const buffer = this.buffers.get(runId);
    if (!buffer) return;
    if (buffer.timer !== undefined) {
      this.cancel(buffer.timer);
      buffer.timer = undefined;
    }
    const text = buffer.lines.join('\n').trim();
    buffer.lines = [];
    buffer.chars = 0;
    if (text === '') return;
    // The lifetime budget is a hard cap, including the message that crosses it.
    const remaining = PROGRESS_MAX_TOTAL_CHARS - buffer.totalChars;
    if (remaining <= 0) return;
    const bounded = text.slice(0, remaining);
    buffer.totalChars += bounded.length;
    this.onFlush({ runId, nodeId: buffer.nodeId, nodeName: buffer.nodeName, text: bounded });
  }

  /** A terminal run has nothing left to stream; release and forget it. */
  forget(runId: string): void {
    this.flush(runId);
    const buffer = this.buffers.get(runId);
    if (buffer?.timer !== undefined) this.cancel(buffer.timer);
    this.buffers.delete(runId);
  }

  close(): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.timer !== undefined) this.cancel(buffer.timer);
    }
    this.buffers.clear();
  }
}
