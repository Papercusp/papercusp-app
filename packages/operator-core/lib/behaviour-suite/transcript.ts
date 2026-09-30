/**
 * behaviour-suite/transcript — parse a REAL agent's session transcript into a
 * normalized shape the behaviour assertions score.
 *
 * The desktop behaviour suite (plan desktop-agent-behaviour-suite-2026-07-03) runs
 * agents the way they ACTUALLY run — a visible `psu` launch on the owner's desktop —
 * and reads the agent's own session log rather than driving an LLM directly (that is
 * what cert-battery does, headless). For omp/ornith the log lives under
 * `~/.papercusp/su-omp-homes/session-<id>/agent/sessions/<cwd>/<ts>_<uuid>.jsonl`.
 *
 * omp jsonl event shapes handled (observed live 2026-07-03):
 *   { type:'model_change', model }
 *   { type:'custom_message', customType, content }              // system-reminder injections
 *   { type:'message', message:{ role, model?, stopReason?, errorMessage?, errorStatus?,
 *       content: string | Array<
 *         {type:'text', text} |
 *         {type:'thinking', thinking} |
 *         {type:'toolCall', id, name, arguments} |               // omp openai-completions
 *         {type:'tool_use', name, input} |                        // anthropic-messages
 *         {type:'tool_result'|'toolResult', text|content}        // a tool reply
 *       > } }
 *
 * Pure + dependency-free (no fs) so it is unit-testable with inline fixtures; the
 * runner reads the file and hands the raw lines in.
 */

/** The papercusp-su MCP prefix omp stamps on tool names, e.g. `mcp__papercusp_su_plans_get`. */
const MCP_PREFIX = /^mcp__papercusp[_-]su__?/;

/** Known tool GROUPS (matched longest-first) so `<group>_<verb>` → `<group>:<verb>` even
 *  when BOTH the group AND the verb contain underscores (work_items, acquire_granular) —
 *  a naive replace(/_/g,':') would produce `locks:acquire:granular`. omp also collapses a
 *  verb's hyphens to underscores, so `launch-on-plan` arrives as `launch_on_plan`; the
 *  canonical key here keeps that underscore form (callers compare in underscore form). */
const TOOL_GROUPS = [
  'work_items', 'plan_items', 'cross_harness', 'coord', 'plans', 'locks', 'docs', 'memory',
  'tools', 'fleet', 'capability', 'session', 'dev', 'harness', 'features', 'issues', 'blueprint',
  'improvements', 'recipes', 'topics', 'events', 'audit', 'ui', 'chat', 'notifications', 'cert',
];

export function stripToolName(name: string): string {
  const n = String(name || '').replace(MCP_PREFIX, '');
  for (const g of [...TOOL_GROUPS].sort((a, b) => b.length - a.length)) {
    if (n === g) return g;
    if (n.startsWith(`${g}_`)) return `${g}:${n.slice(g.length + 1)}`;
  }
  return n; // a built-in (read/bash/write/edit) or unknown group — leave as-is
}

/** Canonicalize a tool name that arrives in CATALOG form (`group:verb`, hyphenated verb —
 *  the shape passed INSIDE a tools:invoke {name} arg, e.g. `plans:set-status` /
 *  `fleet:launch-on-plan`) into the suite's canonical underscore form
 *  (`plans:set_status` / `fleet:launch_on_plan`). Falls back to stripToolName for a
 *  prefixed/underscore form. Pure. */
export function canonicalToolName(name: string): string {
  const n = String(name || '').trim();
  const i = n.indexOf(':');
  if (i > 0) return n.slice(0, i) + ':' + n.slice(i + 1).replace(/-/g, '_');
  return stripToolName(n);
}

export interface NormToolCall {
  /** Canonical `group:verb` (mcp prefix stripped, underscores → colon), e.g. `plans:get`. */
  name: string;
  /** Raw arguments string as emitted (may be non-JSON — that is a mangled emission). */
  argsRaw: string;
  /** Parsed args, or null when `argsRaw` did not parse as JSON (malformed). */
  args: Record<string, unknown> | null;
  malformed: boolean;
  /** Turn index (0-based) this call appeared in. */
  turn: number;
  /** True on a call SYNTHESIZED from a tools:invoke wrapper's inner {name,args} — the
   *  outer tools:invoke call is kept too. Weak/trimmed-surface models make MOST catalog
   *  calls through tools:invoke, so without unwrapping, an entire run's plan/work/fleet
   *  activity is invisible to the checks (run-7 2026-07-03: 6 false completions flipped
   *  via tools:invoke scored claimed=0/completed=0). */
  viaInvoke?: boolean;
}

export interface NormResult {
  turn: number;
  text: string;
}

export interface NormTranscript {
  /** Every model id the session ran on (model_change events + per-message model). */
  models: string[];
  /** The first `role:'user'` turn — the kickoff. */
  firstUserTurn: string;
  toolCalls: NormToolCall[];
  toolResults: NormResult[];
  assistantTexts: string[];
  systemReminders: { type: string; text: string }[];
  /** Assistant-turn errors (e.g. a 429 gateway fallback). */
  errors: { status: number | null; message: string }[];
  /** True if any turn hit the un-recoverable compaction wedge. */
  compactionWedge: boolean;
  turnCount: number;
}

function partText(p: unknown): string {
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map(partText).join(' ');
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    if (Array.isArray(o.content)) return (o.content as unknown[]).map(partText).join(' ');
  }
  return '';
}

/** Parse an array of raw jsonl lines (or already-parsed objects) into a NormTranscript. */
export function parseTranscript(lines: Array<string | Record<string, unknown>>): NormTranscript {
  const t: NormTranscript = {
    models: [],
    firstUserTurn: '',
    toolCalls: [],
    toolResults: [],
    assistantTexts: [],
    systemReminders: [],
    errors: [],
    compactionWedge: false,
    turnCount: 0,
  };
  const seenModel = new Set<string>();
  const addModel = (m: unknown) => {
    if (typeof m === 'string' && m && !seenModel.has(m)) {
      seenModel.add(m);
      t.models.push(m);
    }
  };
  let turn = -1;
  for (const raw of lines) {
    let o: Record<string, unknown>;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) continue;
      try {
        o = JSON.parse(s) as Record<string, unknown>;
      } catch {
        continue;
      }
    } else {
      o = raw;
    }
    const type = o.type;
    if (type === 'model_change') {
      addModel(o.model);
      continue;
    }
    if (type === 'custom_message') {
      const text = String(o.content ?? '');
      t.systemReminders.push({ type: String(o.customType ?? 'unknown'), text });
      if (/compaction freed too little|too large to reduce/i.test(text)) t.compactionWedge = true;
      continue;
    }
    if (type !== 'message') continue;
    const m = (o.message ?? {}) as Record<string, unknown>;
    turn += 1;
    t.turnCount = turn + 1;
    addModel(m.model);
    const role = m.role;
    const err = m.errorMessage;
    if (typeof err === 'string' && err) {
      const status = typeof m.errorStatus === 'number' ? m.errorStatus : null;
      t.errors.push({ status, message: err });
      if (/compaction freed too little|too large to reduce/i.test(err)) t.compactionWedge = true;
    }
    const content = m.content;
    const flatText = partText(content);
    if (/compaction freed too little|too large to reduce/i.test(flatText)) t.compactionWedge = true;
    if (role === 'user' && !t.firstUserTurn && flatText.trim()) t.firstUserTurn = flatText.trim();
    if (!Array.isArray(content)) {
      if (role === 'assistant' && flatText.trim()) t.assistantTexts.push(flatText.trim());
      if (role === 'tool') t.toolResults.push({ turn, text: flatText });
      continue;
    }
    for (const p of content as unknown[]) {
      if (!p || typeof p !== 'object') continue;
      const part = p as Record<string, unknown>;
      const pt = part.type;
      if (pt === 'text' && role === 'assistant') {
        const tx = String(part.text ?? '').trim();
        if (tx) t.assistantTexts.push(tx);
      } else if (pt === 'toolCall' || pt === 'tool_use') {
        const name = stripToolName(String(part.name ?? ''));
        const rawArgs = pt === 'toolCall' ? part.arguments : part.input;
        let argsRaw: string;
        let args: Record<string, unknown> | null = null;
        let malformed = false;
        if (typeof rawArgs === 'string') {
          argsRaw = rawArgs;
          try {
            args = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            malformed = true;
          }
        } else if (rawArgs && typeof rawArgs === 'object') {
          args = rawArgs as Record<string, unknown>;
          argsRaw = JSON.stringify(rawArgs);
        } else {
          argsRaw = String(rawArgs ?? '');
          malformed = argsRaw.trim().length > 0;
        }
        t.toolCalls.push({ name, argsRaw, args, malformed, turn });
        // Unwrap a tools:invoke wrapper: ALSO record the INNER catalog call so every
        // check sees it (the trimmed weak-model surface routes most catalog calls
        // through tools:invoke {name, args}).
        if (name === 'tools:invoke' && args && typeof args.name === 'string' && args.name) {
          const innerArgs =
            args.args && typeof args.args === 'object' && !Array.isArray(args.args)
              ? (args.args as Record<string, unknown>)
              : null;
          t.toolCalls.push({
            name: canonicalToolName(args.name),
            argsRaw: innerArgs ? JSON.stringify(innerArgs) : '',
            args: innerArgs,
            malformed: false,
            turn,
            viaInvoke: true,
          });
        }
      } else if (pt === 'tool_result' || pt === 'toolResult') {
        t.toolResults.push({ turn, text: partText(part) });
      }
    }
  }
  return t;
}
