/**
 * tool-call-log.ts — the bare tool-call log surface
 * (deterministic-context-carry-2026-07-14 P-013, plan D-004).
 *
 * A DETERMINISTIC renderer over the tool ledger (harness_shared.agent_activity,
 * the rows the per-CLI hooks already report): one ~10–15-token line per call —
 * normalized tool name + primary target + ✓/✗ outcome — with consecutive
 * same-tool-same-outcome runs collapsed, and a constant-budget aging ladder:
 * over-budget SUCCESS lines fold (oldest first) into a per-tool-counts +
 * top-K-touched-set decay line, while ERROR lines out-age successes (they stay
 * itemized until errors alone exceed the budget). Older GENERATIONS (prior
 * compaction windows) decay the same way one rung further: gen-1 keeps errors
 * itemized over a decayed success summary; gen-2+ is counts + touched-set only.
 *
 * Pure + dependency-free (no I/O): the store read lives in
 * tool-call-log-store.ts, the agent surface in agent-tools/activity/tool-log.ts,
 * and the Phase-4 carry-doc builder (P-009) consumes these functions directly.
 * No LLM anywhere — same-input ⇒ same-output, per D-002/D-004.
 */

/** The slice of an agent_activity row this renderer reads. */
export interface ToolCallRow {
  id?: string | number | null;
  toolName?: string | null;
  /** 'pre' | 'post' — the hook reports both; post carries the outcome. */
  phase?: string | null;
  /** Correlates a pre/post pair (the CLI's per-call id). */
  toolUseId?: string | null;
  /** 'ok' | 'error' | null (MCP-tool posts are often null). */
  status?: string | null;
  /** The server-derived one-liner ('▶ cmd' / '✎ file' / '👁 file' / '· name'). */
  summary?: string | null;
  /** The stored jsonb detail ({ command } / { file } / capped raw input). */
  detail?: unknown;
  /** Only kind='tool' rows render; lifecycle/todos rows are skipped. */
  kind?: string | null;
  createdAt?: string | null;
}

/** One rendered log line plus the metadata the budget fold needs. */
export interface ToolCallLine {
  text: string;
  isError: boolean;
  /** How many raw calls this line covers (>1 for a collapsed run). */
  calls: number;
}

export const DEFAULT_MAX_LINES = 40;
export const DEFAULT_TOP_K = 8;
const TARGET_CLIP = 48;
const RUN_TARGETS_SHOWN = 3;

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** 'mcp__papercusp-su__coord_send' → 'coord_send'; native names pass through. */
export function normalizeToolName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  const m = n.match(/^mcp__.+?__(.+)$/);
  return m ? m[1] : n || '?';
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Last two path segments — 'a/b/c/d.ts' → 'c/d.ts' (enough to disambiguate
 *  same-named files without paying for the whole path). */
function shortPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** Drop the ubiquitous 'cd <dir> && ' / 'cd <dir>; ' lead-in so a shell target
 *  spends its budget on the actual command. */
function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^\s*cd\s+[^;&|]+(?:&&|;)\s*/, '');
}

/**
 * The call's primary target: the edited/read file, the shell command (cd-prefix
 * stripped), or the summary with its display glyph removed. Null when the tool
 * name alone is the whole story (most MCP tools).
 */
export function primaryTarget(row: ToolCallRow): string | null {
  const d = row.detail;
  if (d && typeof d === 'object') {
    const rec = d as Record<string, unknown>;
    if (typeof rec.file === 'string' && rec.file.trim()) return clip(shortPath(rec.file.trim()), TARGET_CLIP);
    if (typeof rec.command === 'string' && rec.command.trim()) {
      return clip(stripCdPrefix(rec.command), TARGET_CLIP);
    }
  }
  const s = (row.summary ?? '').trim();
  // Server-derived summaries are '<glyph> <target>'; the '· <name>' form is
  // just the tool name again — no extra information, so no target.
  const m = s.match(/^([▶✎👁🔎⊕])\s+(.+)$/u);
  if (m) {
    const t = m[1] === '▶' ? stripCdPrefix(m[2]) : m[2];
    return clip(t, TARGET_CLIP);
  }
  return null;
}

function outcomeGlyph(status: string | null | undefined): string {
  if (status === 'ok') return '✓';
  if (status === 'error') return '✗';
  return '·'; // unknown — the row carried no outcome (typical for MCP posts)
}

/* ------------------------------------------------------------------ */
/* Dedupe + line rendering                                             */
/* ------------------------------------------------------------------ */

/**
 * Reduce the raw pre/post row stream (OLDEST FIRST) to one row per call:
 * kind='tool' only, the post row wins its pre (matched by toolUseId; a pre with
 * no post — the call never completed — survives with its unknown outcome).
 */
export function dedupeToolCalls(rows: ToolCallRow[]): ToolCallRow[] {
  const postSeen = new Set<string>();
  for (const r of rows) {
    if (r.phase === 'post' && r.toolUseId) postSeen.add(r.toolUseId);
  }
  return rows.filter((r) => {
    if ((r.kind ?? 'tool') !== 'tool') return false;
    if (r.phase === 'pre') return !(r.toolUseId && postSeen.has(r.toolUseId));
    return true;
  });
}

/** '<name> <target?> <✓|✗|·>' — the ~10–15-token per-call unit. */
export function formatToolCallLine(row: ToolCallRow): ToolCallLine {
  const name = normalizeToolName(row.toolName);
  const target = primaryTarget(row);
  const glyph = outcomeGlyph(row.status);
  return {
    text: target ? `${name} ${target} ${glyph}` : `${name} ${glyph}`,
    isError: row.status === 'error',
    calls: 1,
  };
}

/**
 * Render deduped calls (OLDEST FIRST) to lines, collapsing a consecutive run of
 * the same tool with the same outcome into one '×N' line listing up to
 * RUN_TARGETS_SHOWN distinct targets. ERROR calls never collapse — each failed
 * call keeps its own line (the signal worth the tokens).
 */
export function collapseToolCallRuns(calls: ToolCallRow[]): ToolCallLine[] {
  const lines: ToolCallLine[] = [];
  let i = 0;
  while (i < calls.length) {
    const head = calls[i];
    if (head.status === 'error') {
      lines.push(formatToolCallLine(head));
      i += 1;
      continue;
    }
    const name = normalizeToolName(head.toolName);
    let j = i;
    while (
      j < calls.length &&
      calls[j].status !== 'error' &&
      normalizeToolName(calls[j].toolName) === name &&
      (calls[j].status ?? null) === (head.status ?? null)
    ) {
      j += 1;
    }
    const run = calls.slice(i, j);
    if (run.length === 1) {
      lines.push(formatToolCallLine(head));
    } else {
      const targets: string[] = [];
      for (const c of run) {
        const t = primaryTarget(c);
        if (t && !targets.includes(t)) targets.push(t);
      }
      const shown = targets.slice(0, RUN_TARGETS_SHOWN);
      const more = targets.length - shown.length;
      const targetPart = shown.length
        ? ` (${shown.join(', ')}${more > 0 ? `, +${more}` : ''})`
        : '';
      lines.push({
        text: `${name} ×${run.length}${targetPart} ${outcomeGlyph(head.status)}`,
        isError: false,
        calls: run.length,
      });
    }
    i = j;
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Decay (the aging-ladder rung)                                       */
/* ------------------------------------------------------------------ */

export interface ToolCallDecay {
  /** Per-tool call counts, most-called first: [{ tool, n, errors }]. */
  counts: Array<{ tool: string; n: number; errors: number }>;
  /** The top-K most-touched distinct targets (files/commands), by frequency. */
  topTargets: string[];
  totalCalls: number;
}

/** Aggregate deduped calls to per-tool counts + the top-K touched-set. */
export function decayToolCalls(calls: ToolCallRow[], topK = DEFAULT_TOP_K): ToolCallDecay {
  const byTool = new Map<string, { n: number; errors: number }>();
  const byTarget = new Map<string, number>();
  for (const c of calls) {
    const name = normalizeToolName(c.toolName);
    const agg = byTool.get(name) ?? { n: 0, errors: 0 };
    agg.n += 1;
    if (c.status === 'error') agg.errors += 1;
    byTool.set(name, agg);
    const t = primaryTarget(c);
    if (t) byTarget.set(t, (byTarget.get(t) ?? 0) + 1);
  }
  // Deterministic order: count desc, then name asc.
  const counts = [...byTool.entries()]
    .map(([tool, v]) => ({ tool, ...v }))
    .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool));
  const topTargets = [...byTarget.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([t]) => t);
  return { counts, topTargets, totalCalls: calls.length };
}

/** '39 calls: Bash×21(1✗) Read×14 Edit×4 · touched: a.ts, b.ts' */
export function formatDecayLine(decay: ToolCallDecay): string {
  const tools = decay.counts
    .map((c) => `${c.tool}×${c.n}${c.errors ? `(${c.errors}✗)` : ''}`)
    .join(' ');
  const touched = decay.topTargets.length ? ` · touched: ${decay.topTargets.join(', ')}` : '';
  return `${decay.totalCalls} calls: ${tools}${touched}`;
}

/* ------------------------------------------------------------------ */
/* Budgeted + generational rendering                                   */
/* ------------------------------------------------------------------ */

export interface RenderToolCallLogOptions {
  /** Line budget for the itemized portion (default 40). */
  maxLines?: number;
  /** Touched-set size on a decay line (default 8). */
  topK?: number;
}

/**
 * Render one window's ledger rows (OLDEST FIRST) within a constant line budget.
 * Over budget, the OLDEST SUCCESS lines fold into a leading decay line first —
 * error lines out-age successes and fold only when errors alone still exceed
 * the budget (then oldest errors fold too, keeping the newest).
 */
export function renderToolCallLog(rows: ToolCallRow[], opts: RenderToolCallLogOptions = {}): string {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const calls = dedupeToolCalls(rows);
  if (calls.length === 0) return '';
  const lines = collapseToolCallRuns(calls);
  if (lines.length <= maxLines) return lines.map((l) => l.text).join('\n');

  // Fold oldest-first, successes before errors, until the itemized remainder
  // (+1 for the decay line itself) fits the budget.
  const keep = new Array<boolean>(lines.length).fill(true);
  let kept = lines.length;
  const budget = Math.max(1, maxLines - 1);
  for (const errorsToo of [false, true]) {
    for (let i = 0; i < lines.length && kept > budget; i += 1) {
      if (!keep[i]) continue;
      if (lines[i].isError && !errorsToo) continue;
      keep[i] = false;
      kept -= 1;
    }
    if (kept <= budget) break;
  }
  // Decay the calls behind the folded lines (positionally: walk lines and
  // calls together — each line covers `calls` consecutive deduped calls).
  const foldedCalls: ToolCallRow[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const span = calls.slice(cursor, cursor + lines[i].calls);
    cursor += lines[i].calls;
    if (!keep[i]) foldedCalls.push(...span);
  }
  const decayLine = `[aged] ${formatDecayLine(decayToolCalls(foldedCalls, opts.topK))}`;
  return [decayLine, ...lines.filter((_, i) => keep[i]).map((l) => l.text)].join('\n');
}

/**
 * The generational ladder (plan D-004: constant budget, degrade by decay):
 * `generations[0]` is the NEWEST window (this context), older windows follow.
 *   gen-0 — itemized (budgeted) lines;
 *   gen-1 — errors still itemized (they out-age successes one rung), successes
 *           decayed to counts + touched-set;
 *   gen-2+ — one decay line per generation, errors as counts only.
 */
export function renderAgedToolCallLog(
  generations: ToolCallRow[][],
  opts: RenderToolCallLogOptions = {},
): string {
  const blocks: string[] = [];
  for (let g = 0; g < generations.length; g += 1) {
    const calls = dedupeToolCalls(generations[g]);
    if (calls.length === 0) continue;
    if (g === 0) {
      blocks.push(renderToolCallLog(generations[g], opts));
      continue;
    }
    const label = `[gen-${g}]`;
    if (g === 1) {
      const successes = calls.filter((c) => c.status !== 'error');
      const errors = calls.filter((c) => c.status === 'error');
      const parts = [`${label} ${formatDecayLine(decayToolCalls(successes, opts.topK))}`];
      for (const e of errors) parts.push(`${label} ${formatToolCallLine(e).text}`);
      blocks.push(parts.join('\n'));
    } else {
      blocks.push(`${label} ${formatDecayLine(decayToolCalls(calls, opts.topK))}`);
    }
  }
  return blocks.join('\n');
}
