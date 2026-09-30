/**
 * Incremental display projection of the converse <say> envelope. Shared by
 * desktop and portal: protocol tags never become markdown/HTML to render.
 * The default retains desktop's tagged-only behavior. allowPlainText also
 * supports chat backends/history that already supply ordinary display text.
 */
const SAY_OPEN = '<say>';
const SAY_CLOSE = '</say>';
const CONTROL_NAMES = ['say', 'set_mode', 'sleep', 'spawn', 'handoff', 'handoff_to_mug', 'handoff_to_queen', 'delegate_deep', 'report', 'continue'];

function trailingClosePrefixLength(value: string): number {
  const lower = value.toLowerCase();
  for (let length = Math.min(value.length, SAY_CLOSE.length - 1); length > 0; length -= 1) {
    if (lower.endsWith(SAY_CLOSE.slice(0, length))) return length;
  }
  return 0;
}

export class SayStreamProjector {
  private raw = '';
  private emittedLength = 0;
  private projectedText = '';
  private closed = false;
  private mode: 'undecided' | 'tagged' | 'plain';

  constructor(options: { allowPlainText?: boolean } = {}) {
    this.mode = options.allowPlainText ? 'undecided' : 'tagged';
  }

  push(chunk: string): string {
    if (!chunk || this.closed) return '';
    this.raw += chunk;
    const lower = this.raw.toLowerCase();
    if (this.mode === 'undecided') {
      const head = lower.trimStart();
      if (!head || CONTROL_NAMES.some((name) => `<${name}>`.startsWith(head))) return '';
      this.mode = CONTROL_NAMES.some((name) =>
        head.startsWith(`<${name}>`) || head.startsWith(`<${name} `) || head.startsWith(`<${name}/`),
      ) ? 'tagged' : 'plain';
    }

    let safeBody: string;
    if (this.mode === 'plain') {
      safeBody = this.raw;
    } else {
      const openAt = lower.indexOf(SAY_OPEN);
      if (openAt < 0) return '';
      const contentStart = openAt + SAY_OPEN.length;
      const closeAt = lower.indexOf(SAY_CLOSE, contentStart);
      const body = this.raw.slice(contentStart, closeAt >= 0 ? closeAt : undefined);
      safeBody = closeAt >= 0 ? body : body.slice(0, body.length - trailingClosePrefixLength(body));
      if (closeAt >= 0) this.closed = true;
    }
    if (safeBody.length <= this.emittedLength) return '';
    const delta = safeBody.slice(this.emittedLength);
    this.emittedLength = safeBody.length;
    this.projectedText = safeBody;
    return delta;
  }

  get text(): string { return this.projectedText; }
  get complete(): boolean { return this.closed; }
}

/** Normalize old persisted assistant rows without rewriting conversation data. */
export function projectSayText(raw: string): string {
  const projector = new SayStreamProjector({ allowPlainText: true });
  projector.push(raw);
  return projector.text;
}
