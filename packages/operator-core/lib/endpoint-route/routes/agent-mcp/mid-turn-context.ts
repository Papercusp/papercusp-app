/**
 * POST /api/agent-mcp/mid-turn-context
 *
 * Plan: context-injection-audit-2026-07-28 (P-015, decision D-026).
 *
 * THE GAP THIS CLOSES. Recall used to be delivered at exactly one boundary —
 * UserPromptSubmit (turn-start-memory.ts, its sibling in this directory). A turn
 * that submits one prompt and then makes fifty tool calls therefore got ONE
 * injection and then nothing: the agent could spend twenty greps re-deriving a
 * fact that was already in memory, because no boundary after the prompt ever
 * asked. This endpoint is that missing boundary — the PostToolBatch hook
 * (posttoolbatch-midturn-context.sh) calls it after a batch of tool calls
 * resolves and injects what comes back as `additionalContext`.
 *
 * ⚠ POST-tool, not PRE-tool, and that is D-027 rather than an accident: firing
 * after the batch makes the tool RESULTS visible, so an empty/failed search — the
 * strongest "this agent is stuck and about to re-derive something" signal there
 * is — can be weighted in rather than guessed at. A PreToolUse variant of this
 * file existed briefly and was deleted; if you find yourself moving it back,
 * read D-027 first.
 *
 * WHY THIS IS A SIBLING AND NOT NEW MACHINERY. D-026 audited the Phase-7
 * matchers and ruled that their SELECTION logic is sound but their DELIVERY leg
 * targets the wrong boundary (the ambient-push rail delivers at WAKE, not per
 * tool call). The one rail that is live and carrying traffic today is the hook
 * `additionalContext` channel. So P-015 bridges onto THAT, reusing the same
 * admission pipeline turn-start already runs. No parallel matcher set, no second
 * dedup, no new transport.
 *
 * THE THREE THINGS THAT MAKE THIS CHEAP:
 *
 *  1. DEDUP IS FREE. `session.port` is free-text (injection.ts) and the epoch
 *     ledger is PORT-AGNOSTIC by D-006, so passing port 'mid-turn' inherits the
 *     existing guarantee: anything already surfaced this epoch by the initialize
 *     prelude, turn-start, an orient recall, or a claim port is never re-paid.
 *     A fifty-call turn cannot restate the same memory fifty times. This is why
 *     P-017 needs no dedup of its own — do NOT build a second one.
 *  2. THE BUDGET IS AN ORDER OF MAGNITUDE SMALLER than turn-start's. See
 *     MID_TURN_BUDGET_CHARS below; the arithmetic is in its comment.
 *  3. THE COST GUARDS below stop a burst of tool calls from each buying an embed,
 *     and the host-wide named-resource admission guard caps all operator workers
 *     together (EI-21270032782365521).
 *
 * Body: { owner, tool, toolInput, workspace?, harness? } — the hook passes
 * harness/workspace from its launch env so this endpoint does no session-registry
 * resolution on the hot path. The QUERY is derived here, server-side, from the
 * tool call: the hook stays a dumb transport (the property that made the
 * turn-start hook 76 lines and lets this logic be fixed without reinstalling a
 * script on every box).
 *
 * Fail-soft by contract, exactly like turn-start: every failure path returns
 * `{ ok: true, text: '' }`. A hook must never surface an error into a turn.
 * `auth: 'loopback'` — the hook runs on this box.
 */
import { defineTool } from '@papercusp/agent-mcp';
// Pure module, zero static imports of its own — see corpus-recall.ts. Imported
// statically (not dynamically like everything else in the handler) precisely
// because it drags nothing behind it, and because clampToBudget must stay a
// pure sync function its tests can call directly.
import { CORPUS_BLOCK_HEADING } from '../../../memory/corpus-recall';
import { recordInjectionCoverage } from '../../../memory/injection-delivery-coverage';
import { takePendingFailureLoopHint, type FailureLoopHint } from '../../../failure-loop-circuit-breaker';

/**
 * Query clamp — embed the head of a long command, not a pasted heredoc.
 * Exported so offline replays (memory/bench/jev-live-drop-quality.ts) rebuild
 * the exact query this handler sends, instead of keeping a second copy.
 */
export const QUERY_CLAMP = 1_000;

/**
 * The mid-turn budget (chars). DELIBERATELY an order of magnitude under
 * turn-start's 4000, and the reason is arithmetic rather than taste: this fires
 * per TOOL CALL, so a fifty-call turn at the turn-start budget would inject
 * ~200k chars — precisely the context bloat the owner warned against in the same
 * message that asked for mid-turn delivery. At this budget the same fifty-call
 * turn costs ~17k chars WORST case, and in practice far less because the epoch
 * dedup means most calls return empty.
 *
 * The shape this buys is a TEASER, not a briefing: a line or two plus enough
 * handle for the agent to go get the detail if it wants it. That is the correct
 * shape for an interruption — it must be cheap enough to ignore.
 *
 * ⚠ SCOPE (D-060 / WI-6857): this bounds the MEM0 HALF ONLY. The P-008 corpus
 * pointer section carries its own CORPUS_BUDGET_CHARS (corpus-recall.ts) and is
 * NOT re-clamped here — see clampToBudget for why. So the arithmetic above is
 * no longer the whole cost: a recall that carries a full pointer section costs
 * ~2.2k chars, not ~350. The bound that matters is MAX_PER_MIN below (recalls,
 * not tool calls), which caps this channel at ~26k chars/min worst case — and
 * far less in practice, because the per-epoch surfaced-refs ledger means a
 * pointer is delivered ONCE, not on every batch that would rank it.
 */
const MID_TURN_BUDGET_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_MID_TURN_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 350;
})();

/**
 * Inner cost ceiling: max recalls per session per rolling minute. The epoch ledger
 * dedups what we SHOW but not what we SPEND — every call is still an embed plus
 * a pgvector query. This process-local guard caps one session without ever
 * delaying the FIRST call of a burst, which is the one that matters (the
 * acceptance case is "fires early, on the first grep for the symptom" — a
 * time-based floor would have suppressed exactly that). The outer
 * `withMidTurnMemoryAdmission` semaphore below is what bounds all SO_REUSEPORT
 * workers together; neither guard is a substitute for the other.
 */
const MAX_PER_MIN = (() => {
  const raw = Number(process.env.PAPERCUSP_MID_TURN_MAX_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 12;
})();

const RATE_WINDOW_MS = 60_000;

/**
 * In-process only, and that is correct for this INNER per-session limiter.
 * Losing it on restart costs at most a few extra embeds. Cross-process capacity
 * is a different invariant and is enforced by the existing named-resource
 * store immediately around the optional recall build. Keyed by session owner.
 */
const recentCalls = new Map<string, { at: number[]; lastQuery: string }>();

/** Keep the map from growing without bound across a long-lived operator. */
function pruneRateState(now: number): void {
  if (recentCalls.size < 512) return;
  for (const [key, state] of recentCalls) {
    if (state.at.every((t) => now - t > RATE_WINDOW_MS)) recentCalls.delete(key);
  }
}

/**
 * Returns false when this call should be skipped WITHOUT doing any work.
 * Two guards, in order of cheapness:
 *   - identical consecutive query ⇒ nothing can have changed, skip for free.
 *     (`ls` then `ls` then `ls`, or a retry loop on one failing command.)
 *   - more than MAX_PER_MIN recalls in the trailing minute ⇒ over the ceiling.
 */
function admitCall(owner: string, query: string, now: number): boolean {
  const state = recentCalls.get(owner);
  if (!state) {
    recentCalls.set(owner, { at: [now], lastQuery: query });
    return true;
  }
  if (state.lastQuery === query) return false;
  const fresh = state.at.filter((t) => now - t <= RATE_WINDOW_MS);
  if (fresh.length >= MAX_PER_MIN) {
    state.at = fresh;
    return false;
  }
  fresh.push(now);
  state.at = fresh;
  state.lastQuery = query;
  return true;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Why a derive can miss, and which of the two kinds it was. The distinction is
 * the whole point (plan `codex-context-injection-parity-2026-08-09`, D-005 §3b):
 * a caller that only learns "no query" cannot tell a vocabulary gap from a tool
 * that genuinely carried no signal, and those need opposite responses.
 */
export type DeriveMiss = 'unknown-tool' | 'no-signal';

export interface DerivedQuery {
  /** The recall query. Empty exactly when `miss` is non-null. */
  query: string;
  /** null = a real signal was derived. */
  miss: DeriveMiss | null;
  /**
   * The tool the miss is ABOUT, when that is not the tool that was called.
   * `tools:invoke` and OMP XD-device writes produce this: both dispatch, so an
   * unmapped INNER tool must be reported under the inner name or the drift alarm
   * names a dispatcher that is perfectly well mapped and points nobody at the
   * real gap (WI-37589 / P-014).
   */
  missTool?: string;
}

/** The tool_input as an object, or null — a JSON string is parsed, anything else rejected. */
function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
}

type ToolQuerySpec = {
  /** Argument field names, in the order they contribute to the query. */
  readonly fields: readonly string[];
  /**
   * Separator between field values. ⚠ PER-TOOL CONTRACT, NOT STYLE. Claude's
   * `Bash` has always joined command+description with an em-dash and the
   * pattern/path tools with a space; those strings are embedded, so changing a
   * separator changes retrieval. D-003 proved claude equivalence across the
   * seam cut-over — these preserve it exactly.
   */
  readonly join?: string;
  /**
   * `tool_input` is a raw non-JSON string rather than a JSON object. Codex's
   * `apply_patch` / `exec` arrive as `custom_tool_call` with a freeform `input`
   * (a patch body beginning `*** Begin Patch\n*** Update File: <path>`), which
   * is dense recall signal but will never parse as JSON.
   */
  readonly freeform?: boolean;
};

/**
 * THE SHARED TOOL VOCABULARY — ONE registry, every client, no per-client fork.
 *
 * D-001 invariant 6: this endpoint is client-agnostic BY CONTRACT. That is why
 * this is a flat tool→fields map and NOT a switch on `client`: tool names are
 * globally distinct across the three TUIs, so one lookup serves all of them and
 * there is no client branch to drift.
 *
 * ── WHY THIS EXISTS (D-005) ──
 * This map used to be a `switch` over Claude's four PascalCase tool names with
 * `default: return ''`. Because the handler drops an empty derive BEFORE both
 * the recall and the stats write, mid-turn context was not merely degraded for
 * codex and omp — it was STRUCTURALLY IMPOSSIBLE, and not even recorded as a
 * miss. Widening the vocabulary fixes today's clients; `DeriveMiss` (above) is
 * what stops the next vocabulary drift from being silent again.
 *
 * ── PROVENANCE: MEASURED, NOT GUESSED ──
 * Every name below was read off real sessions, never inferred from Claude's
 * shape (the plan's standing rule — P-003 "no speculative event names").
 *   • codex — 4,131 `function_call` / `custom_tool_call` records across 61
 *     rollouts in ~/.codex/sessions: exec_command 3034 (cmd/workdir/
 *     justification), write_stdin 539, apply_patch 336 (freeform), exec 145
 *     (freeform), view_image 47 (path), wait 24, update_plan 3.
 *   • codex GOAL EXTENSION (`get_goal` / `update_goal` / `create_goal`) —
 *     measured 2026-08-09 from the SHIPPED BINARY, not from rollouts, because
 *     rollouts cannot supply them: they postdate the census above and appear
 *     ZERO times in all 61. `get_goal` was nonetheless observed live twice
 *     (context_injection_coverage, client=codex port=mid-turn
 *     outcome='unknown-tool'), which is what surfaced the drift.
 *     Source: codex-cli 0.146.0, `codex-linux-x64/.../bin/codex`, serde
 *     struct/field strings + the tool-parameter descriptions —
 *     `struct UpdateGoalArgs with 1 element` (`status`, and the binary's own
 *     prose is exclusively `update_goal` with status "complete"/"blocked");
 *     `struct CreateGoalRequest with 2 elements` (`objective` — "Required. The
 *     concrete objective to start pursuing" — and `token_budget`); `get_goal`
 *     documented as a pure read ("Get the current goal for this thread...").
 *     ⚠ Read the BINARY, not a rollout, when adding a codex tool: a rollout
 *     shows only what a model happened to call, whereas the binary IS the
 *     schema. Grepping rollouts for these names DOES hit two files, but both
 *     hits are inside `custom_tool_call_output` TEXT (a script that printed
 *     codex's tool list) — not calls. That false positive is what made an
 *     earlier draft of this entry map `update_goal` to a nonexistent free-text
 *     field; see the omissions below.
 *   • omp — tool-call records in ~/.omp: read 1771, grep 443, find 402,
 *     bash 181 (command), edit 168, search 116, write 68, ast_grep 14, glob 4;
 *     field names confirmed against the shipped schemas in
 *     @oh-my-pi/pi-coding-agent/src/{tools,commands}.
 *   • claude — Bash/Grep/Glob/Read were byte-identical across the D-003 seam
 *     cut-over. WIDENED 2026-08-09 (WI-37587) with Edit/Write/ToolSearch/
 *     WebSearch/WebFetch, every field name read off the live tool schemas.
 *     Measured from context_injection_coverage on the day: 957 claude NATIVE
 *     calls/day were deriving nothing — Edit 581, ToolSearch 256, Write 69,
 *     AskUserQuestion 24, WebSearch 9, Artifact 5, WebFetch 3, TaskCreate 3,
 *     Monitor 3, TaskUpdate 2, Skill 1, TaskStop 1.
 *     ⚠ THE LESSON THAT FOUND THIS: the drift detector had only ever been
 *     pointed at codex. Pointed at EVERY client it reported claude — ~100% of
 *     traffic — as the biggest gap by three orders of magnitude (3,381
 *     unknown-tool calls vs codex's 3). An alarm whose output is ~100% noise
 *     is functionally OFF: the real codex signal (n=2) was findable only by
 *     filtering to client='codex'. Query the detector across ALL clients
 *     before concluding a client is fine.
 *
 * ── DELIBERATE OMISSIONS (absence here is a decision, not an oversight) ──
 *   • codex `write_stdin` (539 calls): `chars` is raw stdin typed at an
 *     interactive process — routinely passwords and tokens. The derived query
 *     is EMBEDDED and (flag permitting) persisted to memory_recall_query_text,
 *     so admitting it would copy credentials into a second place for weak
 *     signal. `detectPossibleSecrets` guards the text table but not the embed.
 *   • codex `wait` / `list_mcp_resources`, omp `yield` / `submit_result` /
 *     `report_finding` / `irc`: no investigation signal to carry.
 *   • claude `Edit` / `Write` map `file_path` ONLY. `old_string`, `new_string`
 *     and `content` are FILE BODIES — unbounded, and credential-bearing on the
 *     same argument as `write_stdin` above. `file_path` alone mirrors `Read`.
 *   • claude `AskUserQuestion` / `Artifact` / `Skill` / `Monitor` /
 *     `TaskCreate` / `TaskUpdate` / `TaskStop`: considered and judged to carry
 *     no INVESTIGATION signal — they address the human or manage bookkeeping
 *     rather than interrogating the codebase.
 *   • codex `get_goal`: a pure read that takes NO arguments at all.
 *   • codex `update_goal`: its ONLY argument is `status`, a closed enum whose
 *     admissible values are "complete" and "blocked". Embedding the word
 *     "complete" as a recall query is retrieval NOISE, not signal — it matches
 *     on a token that carries no topic. Mapping it to `status` would be worse
 *     than leaving it here, and mapping it to a free-text field it does not
 *     have would be worse still: a wrong field name derives '' and classifies
 *     'no-signal', which is INDISTINGUISHABLE from this deliberate omission —
 *     i.e. a guessed mapping silently converts a working drift alarm into
 *     permanent quiet. That asymmetry is why an unmeasured tool must be left
 *     unmapped (loudly 'unknown-tool') rather than mapped on a guess.
 * These are known tools with no fields, so they classify as 'no-signal' rather
 * than 'unknown-tool' — the alarm must not read a deliberate omission as drift.
 */
export const TOOL_QUERY_VOCABULARY: Readonly<Record<string, ToolQuerySpec>> = {
  // ── claude (PascalCase) ──
  // The description is the agent's own words for what it is doing — often a
  // better recall signal than the command's flags.
  //
  // ⚠ These four were frozen during the seam cut-over by D-003's equivalence
  // proof — a METHODOLOGICAL freeze ("prove claude UNCHANGED before any new
  // client lands"), NOT a standing ban on widening. That migration shipped, so
  // the entries below it are a deliberate, measured widening (WI-37587).
  Bash: { fields: ['command', 'description'], join: ' — ' },
  Grep: { fields: ['pattern', 'path', 'glob'] },
  Glob: { fields: ['pattern', 'path'] },
  Read: { fields: ['file_path'] },
  // Edit/Write carry the SAME `file_path` signal as Read and were simply never
  // added. Measured 957 claude native calls/day deriving nothing, of which
  // Edit alone was 581 — see WI-37587.
  // ⚠ `old_string` / `new_string` / `content` are DELIBERATELY excluded: they
  // are FILE BODIES — unbounded, and credential-bearing on exactly the
  // `write_stdin` precedent below (the derived query is EMBEDDED, and
  // detectPossibleSecrets guards the text table but not the embed).
  Edit: { fields: ['file_path'] },
  Write: { fields: ['file_path'] },
  // A literal search query the agent typed — the strongest signal class here.
  ToolSearch: { fields: ['query'] },
  WebSearch: { fields: ['query'] },
  WebFetch: { fields: ['url', 'prompt'], join: ' — ' },
  // Known-and-considered, no investigation signal; see DELIBERATE OMISSIONS.
  AskUserQuestion: { fields: [] },
  Artifact: { fields: [] },
  Skill: { fields: [] },
  Monitor: { fields: [] },
  TaskCreate: { fields: [] },
  TaskUpdate: { fields: [] },
  TaskStop: { fields: [] },

  // ── codex (snake_case) ──
  exec_command: { fields: ['cmd', 'workdir', 'justification'], join: ' — ' },
  apply_patch: { fields: [], freeform: true },
  exec: { fields: [], freeform: true },
  view_image: { fields: ['path'] },
  update_plan: { fields: ['plan'] },
  wait: { fields: [] },
  list_mcp_resources: { fields: [] },
  write_stdin: { fields: [] }, // credential-shaped; see DELIBERATE OMISSIONS
  // ── codex goal extension (0.146.0; postdates the rollout census above) ──
  // `objective` is the agent's own statement of what it is trying to achieve —
  // the same class of signal as claude's `description` and `update_plan.plan`.
  // ⚠ SCHEMA-MEASURED, NOT YET OBSERVED LIVE (unlike `get_goal`, which the
  // drift alarm caught twice). If a real `create_goal` call ever derives ''
  // here, suspect this field name FIRST — a wrong name looks exactly like the
  // deliberate omissions below, so it will not re-raise the alarm.
  create_goal: { fields: ['objective'] },
  get_goal: { fields: [] }, // no arguments at all; see DELIBERATE OMISSIONS
  update_goal: { fields: [] }, // `status` enum only; see DELIBERATE OMISSIONS

  // ── omp (lowercase) — `read`/`edit`/`write` key on `path`, not claude's
  //    `file_path`, so both spellings are accepted rather than assumed ──
  bash: { fields: ['command', 'description'], join: ' — ' },
  read: { fields: ['path', 'file_path'] },
  grep: { fields: ['pattern', 'path', 'glob'] },
  glob: { fields: ['pattern', 'path'] },
  find: { fields: ['pattern', 'path', 'glob'] },
  search: { fields: ['pattern', 'path', 'query'] },
  edit: { fields: ['path', 'file_path'] },
  write: { fields: ['path', 'file_path'] },
  ast_grep: { fields: ['pattern', 'path'] },
  ast_edit: { fields: ['pattern', 'path'] },
  yield: { fields: [] },
  submit_result: { fields: [] },
  report_finding: { fields: [] },
};

/** The one MCP tool whose signal is not in its OWN arguments — see {@link PAPERCUSP_TOOL_VOCABULARY}. */
const TOOLS_INVOKE = 'tools:invoke';

/**
 * THE PAPERCUSP MCP VOCABULARY — keyed by the tool's REAL colon name (WI-37589).
 *
 * Separate from the table above for one structural reason, not for tidiness: a
 * client mangles these names (`dev:pg_query` -> `mcp__papercusp-su__dev_pg_query`,
 * every ':' -> '_'), so the key an incoming call arrives under is NOT the key
 * `tools:invoke` carries for the same tool. Keying on the colon form and
 * resolving BOTH spellings to it is what lets the recursion below share one
 * table with direct calls instead of maintaining two.
 *
 * ── WHY THIS EXISTS ──
 * Measured 2026-08-09 (context_injection_coverage, workspace papercusp-workspace,
 * outcome='unknown-tool'): 79 distinct `mcp__papercusp-su__*` tools, 2,424
 * calls/day deriving NOTHING — i.e. after WI-37587 fixed claude's NATIVE tools,
 * the MCP namespace was still ~97% of the remaining drift-alarm noise. An alarm
 * whose output is ~100% noise is functionally OFF: a genuine future drift event
 * is unfindable in it.
 *
 * ── PROVENANCE: FIELD NAMES MEASURED FROM REAL CALLS, NOT FROM SCHEMAS ──
 * Every field below was read off `harness_shared.tool_invocations.args_json`
 * over a 3-day window — the keys agents ACTUALLY pass, ranked by frequency —
 * not from the `defineTool` schema. That distinction matters here: a schema
 * lists every OPTIONAL arg, so it cannot tell you which ones callers really
 * populate, and it cannot tell you which carry signal at all.
 *
 * ── WHY NOT DERIVE THIS FROM THE TOOL REGISTRY (the obvious idea; REFUTED) ──
 * WI-37589 proposed auto-deriving the vocabulary from `defineTool` schemas so it
 * could never drift. Measuring the population refutes it: the registry supplies
 * field NAMES but not the signal-vs-bookkeeping judgement, which is the whole
 * problem. Auto-derivation would map `work_items:get` -> `id` and embed
 * "WI-37589" as a recall query, `plans:get` -> `slug`, `coord:ack` -> `msg_id`.
 * Those are not weak signals, they are ANTI-signals: opaque identifiers that
 * retrieve on token overlap with unrelated records. A generic prefix-probe over
 * {query, sql, command, ...} fails the same way from the other side — it is a
 * guess about names, and a WRONG name derives '' and classifies 'no-signal',
 * indistinguishable from a deliberate omission (see the asymmetry above).
 *
 * ── THE TAIL IS DELIBERATELY LEFT LOUD ──
 * These entries cover ~2,364 of the 2,424 measured calls (~97.5%). The residue
 * is ~60 calls/day across ~40 tools called once each. That residue stays
 * 'unknown-tool' ON PURPOSE: with the floor at ~60/day a genuinely new tool
 * arriving at 100+/day is now VISIBLE, which is the alarm doing its job. A
 * blanket `mcp__*` -> no-signal rule would have silenced the floor AND the
 * signal together, permanently.
 *
 * ⚠ EVERY `fields: []` HERE IS A NO-SIGNAL DECLARATION, NOT AN UNMEASURED ONE.
 * It carries none of the guessed-field-name risk, because there is no field
 * name in it to be wrong. It says only "this tool was looked at and carries no
 * INVESTIGATION signal" — bookkeeping the agent is writing, not a question it
 * is asking. Recalling on an agent's own checkpoint/completion prose would also
 * be circular: that text is downstream of the work, not a search for it.
 */
export const PAPERCUSP_TOOL_VOCABULARY: Readonly<Record<string, ToolQuerySpec>> = {
  // ── SIGNAL: the agent is interrogating the system ──
  // The richest recall signal anywhere in this file: an agent's actual SQL.
  'dev:pg_query': { fields: ['sql', 'describe'] },
  // Exact analogue of claude's `Bash` — same two fields, same em-dash join.
  'capability:bash': { fields: ['command', 'description'], join: ' — ' },
  'capability:read': { fields: ['file_path'] },
  'capability:git': { fields: ['args'] },
  'testing:run': { fields: ['files', 'testNamePattern'] },
  'build:typecheck': { fields: ['project', 'files'] },
  'dev:pipeline_position': { fields: ['path'] },
  // A literal search query the agent typed — the strongest signal class.
  'tools:find': { fields: ['query', 'intent'] },
  'docs:search': { fields: ['query'] },
  'search:fulltext': { fields: ['query'] },
  'memory:search': { fields: ['query'] },
  'sessions:search': { fields: ['query'] },
  'work_items:search': { fields: ['query'] },
  'fleet:invariant': { fields: ['description', 'sql'], join: ' — ' },
  // `title`/`description` are the agent's own words for the problem it is
  // looking at. `script` and `body` are deliberately NOT here — unbounded
  // bodies, on the same argument that excludes claude's `new_string`.
  'code:run': { fields: ['title', 'description'] },
  'improvements:capture': { fields: ['title'] },
  'work_items:create': { fields: ['title'] },

  // ── NO SIGNAL: bookkeeping the agent WRITES, not a question it asks ──
  'loop:checkpoint': { fields: [] },
  'loop:status': { fields: [] },
  'loop:arm': { fields: [] },
  'loop:end': { fields: [] },
  // ⚠ `intent` IS strong signal — and is deliberately dropped anyway: orient
  // ALREADY runs its own memory recall on that exact string, so deriving it
  // here would re-embed the same query and inject the same records twice.
  'coord:orient': { fields: [] },
  'coord:send': { fields: [] },
  'coord:inbox': { fields: [] },
  'coord:presence': { fields: [] },
  'coord:glance': { fields: [] },
  'coord:thread': { fields: [] },
  'coord:read': { fields: [] },
  'coord:ack': { fields: [] },
  'coord:whoami': { fields: [] },
  'coord:ask-owner': { fields: [] },
  'work_items:get': { fields: [] },
  'work_items:checkpoint': { fields: [] },
  'work_items:complete': { fields: [] },
  'work_items:comment': { fields: [] },
  'work_items:list': { fields: [] },
  'work_items:claim': { fields: [] },
  'work_items:claim_next': { fields: [] },
  'work_items:claimable': { fields: [] },
  'work_items:release': { fields: [] },
  'work_items:set_state': { fields: [] },
  'work_items:update': { fields: [] },
  'work_items:link': { fields: [] },
  'plans:get': { fields: [] },
  'plans:get-item': { fields: [] },
  'plans:items': { fields: [] },
  'plans:list': { fields: [] },
  'plans:new': { fields: [] },
  'plans:add-item': { fields: [] },
  'plans:add-decision': { fields: [] },
  'plans:set-decision-body': { fields: [] },
  'plans:set-status': { fields: [] },
  'plans:set-now': { fields: [] },
  'facts:assert': { fields: [] },
  'facts:list': { fields: [] },
  'facts:retract': { fields: [] },
  'memory:remember': { fields: [] },
  'sessions:read': { fields: [] },
  'sessions:timeline': { fields: [] },
  'session:request-compaction': { fields: [] },
  'scheduler:get_next': { fields: [] },
  'state:read': { fields: [] },
  'mode:set': { fields: [] },
  'locks:list': { fields: [] },
  'locks:queue': { fields: [] },
  'fleet:leader-brief': { fields: [] },
  'fleet:status': { fields: [] },
  'fleet:wind-down': { fields: [] },
  'db:migrate': { fields: [] },
  'db:next-migration': { fields: [] },
  'conversations:get': { fields: [] },
  'conversations:post': { fields: [] },
  'activity:recent': { fields: [] },
  'journal:recent': { fields: [] },
  'release:deploy': { fields: [] },
  'gateway:status': { fields: [] },
  // `capability:bash_output` reads a job's log; `filter` is a bare regex like
  // "ERROR". A lone regex retrieves on a token that carries no topic — the
  // same argument that keeps codex's `update_goal.status` unmapped.
  'capability:bash_output': { fields: [] },
  // Handled by RECURSION, not by fields — see deriveQueryDetailed. Present so
  // the name resolves to a KNOWN tool rather than falling through to the alarm.
  [TOOLS_INVOKE]: { fields: [] },
};

/**
 * Mangled spelling -> colon name, built from the table above so it cannot drift.
 *
 * ⚠ TWO SPELLINGS PER TOOL — THE CLIENTS DO NOT MANGLE ALIKE (EI-21905492455933253):
 *   - claude / omp mangle ':' ONLY        -> `session_request-compaction`
 *   - codex mangles '-' AS WELL AS ':'    -> `session_request_compaction`
 * Registering only the first made every DECLARED tool whose colon name contains a
 * HYPHEN unresolvable from codex: `specFor` missed, and the call was classified
 * `unknown-tool` — i.e. the drift alarm fired on tools sitting in this very table.
 * Measured before the fix (context_injection_coverage, port='mid-turn',
 * outcome='unknown-tool', 3 days): `mcp__papercusp_su__session_request_compaction`
 * 4,760 calls, `mcp__papercusp_su__fleet_leader_brief` 170.
 *
 * No recall was being lost — every hyphenated entry above is a `fields: []`
 * no-signal declaration, and both outcomes derive '' — so the cost was precision:
 * ~1.6k/day of false drift signal in the alarm that WI-37587 and WI-37589 were both
 * filed to de-noise, plus a trap primed for whoever first adds a SIGNAL-bearing
 * hyphenated tool (it would derive nothing for codex, and per this file's own
 * asymmetry a missing mapping is indistinguishable from a deliberate omission, so
 * it would never re-raise the alarm).
 *
 * Inverting a mangled name in general is AMBIGUOUS (`work_items_get` could be
 * `work_items:get` or `work:items_get`), which is exactly why this is built
 * FORWARD from the declared set instead of parsed. A collision would make one
 * of two declared tools silently unreachable, so it throws at module load
 * rather than resolving to whichever happened to be inserted last. That guard is
 * also what makes registering a SECOND spelling safe rather than reckless: a
 * hyphen-free name yields two identical spellings, which is a same-value re-set,
 * while two DIFFERENT tools colliding on the codex spelling still throws.
 */
const MANGLED_TO_COLON: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const register = (mangled: string, colon: string): void => {
    const prior = map.get(mangled);
    if (prior && prior !== colon) {
      throw new Error(`mid-turn vocabulary: '${prior}' and '${colon}' mangle to the same '${mangled}'`);
    }
    map.set(mangled, colon);
  };
  for (const colon of Object.keys(PAPERCUSP_TOOL_VOCABULARY)) {
    register(colon.replace(/:/g, '_'), colon); // claude / omp
    register(colon.replace(/[:-]/g, '_'), colon); // codex mangles '-' too
  }
  return map;
})();

/**
 * Resolve a spec for a tool name in EITHER spelling.
 *
 * ⚠ The `mcp__` guard is load-bearing, not decoration. Stripping the server
 * prefix off any name would let a THIRD-PARTY MCP tool collide with this file's
 * lowercase omp entries — `mcp__some-server__read` would resolve to omp's
 * `read: { fields: ['path','file_path'] }` and derive from fields it does not
 * have. That is the "a wrong mapping is worse than none" failure, so the
 * papercusp table is consulted ONLY for mcp-prefixed names, and the bare
 * lowercase client tools can never reach it.
 */
function specFor(tool: string): ToolQuerySpec | undefined {
  const direct = TOOL_QUERY_VOCABULARY[tool];
  if (direct) return direct;
  // `tools:invoke` hands us the inner tool under its real colon name.
  const byColon = PAPERCUSP_TOOL_VOCABULARY[tool];
  if (byColon) return byColon;
  if (!tool.startsWith('mcp__')) return undefined;
  // Prefix is `mcp__<server>__`; a server name may contain '-' but never '__'.
  const end = tool.indexOf('__', 'mcp__'.length);
  if (end < 0) return undefined;
  const colon = MANGLED_TO_COLON.get(tool.slice(end + 2));
  return colon ? PAPERCUSP_TOOL_VOCABULARY[colon] : undefined;
}

/** Normalize either spelling to the colon name, for the recursion's own guard. */
function colonNameFor(tool: string): string {
  if (PAPERCUSP_TOOL_VOCABULARY[tool]) return tool;
  if (!tool.startsWith('mcp__')) return tool;
  const end = tool.indexOf('__', 'mcp__'.length);
  return end < 0 ? tool : (MANGLED_TO_COLON.get(tool.slice(end + 2)) ?? tool);
}

/**
 * OMP exposes an MCP dynamic-device call as a native `write` to an `xd://`
 * path. Unlike an ordinary file write, its `content` is a JSON argument
 * envelope and the path names the actual tool. Keeping the outer write shape
 * turns every such call into the generic device path as a recall query (D-012).
 *
 * The Papercusp XD spelling is flattened —
 * `xd://mcp__papercusp_su_tools_invoke`, not the usual
 * `mcp__papercusp-su__tools_invoke` — so it cannot use `specFor`'s standard
 * server separator. Resolve the suffix FORWARD through the existing vocabulary
 * instead of guessing where underscores belong. Unknown suffixes stay loud.
 *
 * `content` is accepted only when it decodes to an object. A truncated or
 * malformed body becomes an empty argument object, never raw query text. That
 * preserves the body/secret boundary: the resolved inner tool's allow-list is
 * still the only thing that can admit fields into the embedder.
 */
const OMP_XD_MCP_PREFIX = 'xd://mcp__';
const OMP_XD_PAPERCUSP_PREFIX = `${OMP_XD_MCP_PREFIX}papercusp_su_`;
const MAX_QUERY_DERIVE_DEPTH = 4;

type NormalizedXdCall = {
  tool: string;
  input: Record<string, unknown>;
};

function normalizeOmpXdCall(tool: string, input: unknown): NormalizedXdCall | null {
  if (tool !== 'write') return null;
  const outer = asRecord(input);
  if (!outer) {
    // The OMP hook clamps the WHOLE outer argument JSON at 400 chars. If that
    // cut lands inside `content`, JSON.parse fails; falling through to the
    // generic known-tool fallback would then embed the raw truncated blob.
    // Recognise only the explicit path field and fail closed.
    return typeof input === 'string' && /"path"\s*:\s*"xd:\/\/mcp__/.test(input)
      ? { tool: TOOLS_INVOKE, input: {} }
      : null;
  }
  const path = str(outer.path);
  if (!path.startsWith(OMP_XD_MCP_PREFIX)) return null;

  const deviceName = path.slice('xd://'.length);
  const mangled = path.startsWith(OMP_XD_PAPERCUSP_PREFIX) ? path.slice(OMP_XD_PAPERCUSP_PREFIX.length) : '';
  return {
    tool: (mangled && MANGLED_TO_COLON.get(mangled)) || deviceName,
    input: asRecord(outer.content) ?? {},
  };
}

/**
 * Derive the recall query from the tool call, and say WHY when there is none.
 *
 * The tools worth reading are the ones that signal INVESTIGATION — a command, a
 * search pattern, a path — because those are the moments where an agent is
 * about to re-derive something it may already know. A tool we have no sensible
 * reading for yields '' and the call is dropped before any embed (see the
 * handler), which is why an unknown tool costs nothing rather than embedding a
 * blob of JSON.
 */
export function deriveQueryDetailed(tool: string, input: unknown): DerivedQuery {
  return deriveQueryAtDepth(tool, input, 0);
}

function deriveQueryAtDepth(tool: string, input: unknown, depth: number): DerivedQuery {
  const xdCall = normalizeOmpXdCall(tool, input);
  if (xdCall) {
    if (depth >= MAX_QUERY_DERIVE_DEPTH) return { query: '', miss: 'no-signal' };
    const inner = deriveQueryAtDepth(xdCall.tool, xdCall.input, depth + 1);
    return inner.miss === 'unknown-tool' && !inner.missTool ? { ...inner, missTool: xdCall.tool } : inner;
  }

  const spec = specFor(tool);
  // Not in the vocabulary at all. Either a client we have not mapped or a new
  // tool on one we have — the case that must stay VISIBLE, because it is the
  // one that silently zeroed codex and omp for the life of this endpoint.
  if (!spec) return { query: '', miss: 'unknown-tool' };

  const done = (text: string): DerivedQuery => (text ? { query: text, miss: null } : { query: '', miss: 'no-signal' });

  // ── `tools:invoke` DISPATCHES: the signal is the INNER call, never its own args ──
  // Measured 2026-08-09 it is the single biggest miss in the whole vocabulary
  // (423 calls/day, 17% of the MCP namespace), and its own two arguments are
  // `name` + `args`. Reading THOSE would embed the literal string
  // "dev:pg_query" plus a JSON blob — so the only correct reading is to ask the
  // inner tool's own entry, which is why this recurses rather than listing
  // fields. An inner tool we do not know stays 'unknown-tool' and is reported
  // UNDER ITS OWN NAME (`missTool`), because "tools:invoke is unmapped" would
  // be both false and un-actionable.
  if (colonNameFor(tool) === TOOLS_INVOKE) {
    const io = asRecord(input);
    if (!io) return { query: '', miss: 'no-signal' };
    const innerName = str(io.name);
    if (!innerName) return { query: '', miss: 'no-signal' };
    // A dispatch through a dispatch is not a shape this system produces; treat
    // it as no-signal rather than recursing, so a malformed or hostile payload
    // cannot drive unbounded recursion on a path that must never cost a turn.
    if (colonNameFor(innerName) === TOOLS_INVOKE) return { query: '', miss: 'no-signal' };
    if (depth >= MAX_QUERY_DERIVE_DEPTH) return { query: '', miss: 'no-signal' };
    const inner = deriveQueryAtDepth(innerName, io.args, depth + 1);
    return inner.miss === 'unknown-tool' ? { ...inner, missTool: innerName } : inner;
  }

  // The hook clamps tool_input to a string before sending, so accept either the
  // structured object (unit tests, future callers) or that clamped JSON text.
  let io: Record<string, unknown>;
  if (typeof input === 'string') {
    // A freeform tool never carries JSON; the raw body IS the signal.
    if (spec.freeform) return done(input.trim());
    try {
      io = JSON.parse(input) as Record<string, unknown>;
    } catch {
      // A clamped/truncated blob is still usable as raw query text — but only
      // for a tool we recognise, so an unmapped tool cannot smuggle a JSON blob
      // into the embedder.
      return done(input.trim());
    }
  } else {
    if (spec.freeform) return done(str(input));
    io = (input ?? {}) as Record<string, unknown>;
  }

  const parts: string[] = [];
  for (const field of spec.fields) {
    const value = str(io[field]);
    if (value) parts.push(value);
  }
  return done(parts.join(spec.join ?? ' '));
}

/** String-only view of {@link deriveQueryDetailed}, for callers that only need
 *  the query. '' means "no signal", whatever the reason. */
export function deriveQuery(tool: string, input: unknown): string {
  return deriveQueryDetailed(tool, input).query;
}

/**
 * Enforce the mid-turn budget HERE, at the endpoint. This is not belt-and-braces:
 * `buildMemoryContextBlock` does NOT enforce `budgetChars` for the first row.
 * Its `admit()` reads
 *
 *     if (spent + line.length > budget && lines.length > 0) return false;
 *
 * — the `&& lines.length > 0` deliberately lets the FIRST row through whole,
 * whatever its size, so that a caller with a small budget gets *something* rather
 * than null. Correct for turn-start (4000 chars, one injection per turn). NOT
 * correct here: measured against the P-018 acceptance case, the top-ranked record
 * is ~3,700 chars — over 10x this endpoint's 350 — and this fires per tool BATCH,
 * so the docstring arithmetic above ("~17k worst case for fifty calls") would have
 * been wrong by an order of magnitude in exactly the direction the owner warned
 * about. The epoch dedup bounds the REPEAT of one record, not the size of fifty
 * distinct ones.
 *
 * Fixing it in injection.ts was not an option: that file is the P-041 retrieval
 * baseline and is gated by D-022, and every other caller depends on the
 * always-emit-one-row behavior. So the clamp lives at the one call site whose
 * contract is a TEASER.
 *
 * The clamp keeps the head, which is where the value is: the block opens with the
 * heading, then `- [scope] (id=…) <the memory's first sentence>`. So a clipped
 * teaser still carries the scope, the id (the handle for `memory:search`), and the
 * lede — which is the entire intended shape of an interruption cheap enough to
 * ignore.
 */
export function clampToBudget(block: string, budget: number = MID_TURN_BUDGET_CHARS): string {
  if (!block) return '';
  // WI-6857 CUT 2. The clamp is a REPAIR for an UNENFORCED budget, not a policy
  // — so it must apply to the leg whose budget is unenforced, and only that one.
  // `composeWithCorpus` (injection.ts) appends the P-008 corpus excerpt section
  // AFTER the mem0 block, so a whole-block clamp at 350 deleted that section on
  // EVERY call: measured 21/21 live calls returning 398-403 chars, which is this
  // budget plus the suffix below, never the excerpts. The corpus leg has no
  // first-row exemption (WI-6870 removed it) and enforces CORPUS_BUDGET_CHARS
  // strictly, so it arrives already bounded and a second clamp here would only
  // re-truncate a section that is already the right size — and truncate it
  // mid-line, leaving evidence that reads as a complete claim but is incomplete.
  const at = block.lastIndexOf(`\n\n### ${CORPUS_BLOCK_HEADING}`);
  if (at >= 0) return `${clampSection(block.slice(0, at), budget)}${block.slice(at)}`;
  // Corpus-only block (the mem0 leg had nothing — P-008's motivating case, so it
  // must not be clamped away either): composeWithCorpus renders it at `##`.
  if (block.startsWith(`## ${CORPUS_BLOCK_HEADING}`)) return block;
  return clampSection(block, budget);
}

/**
 * The failure intervention and the worn post-tool rules each have their own
 * bounded budget and must survive every memory-recall early return. Keep
 * composition here, at the shared delivery seam, rather than teaching the
 * memory pipeline about failure-loop state or identity rules.
 */
export function composeMidTurnContextText(memoryBlock: string, failureHint: string, ruleContext: string): string {
  const parts = [failureHint.trim(), ruleContext.trim(), clampToBudget(memoryBlock).trim()].filter(Boolean);
  return parts.join('\n\n');
}

/** The post-tool rule sink's share of the port's 1.5s hook wall. */
const POST_TOOL_RULE_BUDGET_MS = 1000;

/**
 * The wearer's `post-tool` sync rules due for this batch (portable-identity-
 * packages P-011, D-023): the one context sink whose client hook is this port.
 * Their budget is the sink evaluator's aggregate one, charged to the durable
 * hook turn, so it is not clamped again here. The wall covers the wearer and
 * worn-rule reads as well as the evaluation, because `respond` waits on this and
 * a slow read must not cost the batch its recall too. Never throws.
 */
async function postToolRuleContextText(ownerId: string, workspace: Promise<string>, tools: string[]): Promise<string> {
  if (tools.length === 0) return '';
  try {
    const [{ evaluateHookContextSink }, { withBoundedTimeout }, workspaceId] = await Promise.all([
      import('../../../agent-identities/sync-hook-rules'),
      import('../../../bounded-timeout'),
      workspace,
    ]);
    const bounded = await withBoundedTimeout(
      (signal) => evaluateHookContextSink({ ownerId, workspaceId, sink: 'post-tool', tools, signal }),
      { fallback: { text: '', result: null }, timeoutMs: POST_TOOL_RULE_BUDGET_MS, label: 'mid-turn:post-tool-rules' },
    );
    return bounded.value.text;
  } catch {
    return '';
  }
}

async function resolveFailureLoopHintText(hint: FailureLoopHint): Promise<string> {
  try {
    // Lazy by design: ordinary PostToolBatch requests never load the insight
    // reader, recipe search, or DB path.
    const { buildFailureLoopHintText } = await import('../../../failure-loop-hints');
    return await buildFailureLoopHintText(hint);
  } catch {
    return '';
  }
}

/** The char clamp itself, applied to ONE section. PURE. */
function clampSection(section: string, budget: number): string {
  if (section.length <= budget) return section;
  const cut = section.slice(0, budget);
  // Prefer a word boundary, but never sacrifice most of the budget to find one.
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()} … (clipped — memory:search the id above for the rest)`;
}

/** One tool call as the PostToolBatch hook ships it (clamped, see the script). */
export interface BatchCall {
  tool?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

/**
 * Fold a resolved batch into ONE recall query.
 *
 * Two things make a batch a better signal than a single pre-dispatch call, and
 * both come from firing AFTER the tools ran (D-027):
 *   - the RESULTS are visible, so an empty/failed search — the strongest "this
 *     agent is stuck and about to re-derive something" signal there is — can be
 *     weighted in rather than guessed at;
 *   - several calls in one batch describe the agent's actual line of enquiry
 *     better than any one of them alone.
 * Later calls come first: the batch's tail is the freshest intent.
 */
export interface DerivedBatch {
  query: string;
  /** Tool names absent from TOOL_QUERY_VOCABULARY — the drift signal. */
  unknownTools: readonly string[];
  /** Known tools that carried no signal — expected quiet, NOT drift. */
  noSignalTools: readonly string[];
}

export function deriveBatchQueryDetailed(calls: BatchCall[]): DerivedBatch {
  const parts: string[] = [];
  const unknown = new Set<string>();
  const noSignal = new Set<string>();
  for (const call of [...calls].reverse()) {
    const tool = (call.tool ?? '').trim();
    const { query: q, miss, missTool } = deriveQueryDetailed(tool, call.toolInput);
    // `missTool` names the INNER tool of a `tools:invoke` dispatch. Reporting
    // the dispatcher instead would put a mapped tool in the drift list and
    // point nobody at the tool that is actually unmapped (WI-37589).
    if (miss === 'unknown-tool') unknown.add(missTool || tool || '(empty)');
    else if (miss === 'no-signal') noSignal.add(tool);
    if (!q) continue;
    const response = str(call.toolResponse);
    // An empty-looking result is signal, not noise — say so in the query.
    const barren = !response || /no matches|not found|no files found|^\s*$/i.test(response);
    parts.push(barren ? `${q} (no result)` : q);
  }
  return {
    query: parts.join(' · '),
    unknownTools: [...unknown],
    noSignalTools: [...noSignal],
  };
}

/** String-only view, for callers that only need the query. */
export function deriveBatchQuery(calls: BatchCall[]): string {
  return deriveBatchQueryDetailed(calls).query;
}

/**
 * The SINGLE-call form (a direct caller / probe — the hook sends a batch),
 * lifted into the batch shape so the handler has ONE coverage code path
 * instead of two that can drift apart.
 */
function singleCallDetail(tool: string, input: unknown): DerivedBatch {
  const { query, miss, missTool } = deriveQueryDetailed(tool, input);
  return {
    query,
    // An empty tool name still has to be countable, or the most likely
    // malformed-payload case is the one that stays invisible. `missTool` is the
    // `tools:invoke` inner-name case — see deriveBatchQueryDetailed.
    unknownTools: miss === 'unknown-tool' ? [missTool || tool || '(empty)'] : [],
    noSignalTools: miss === 'no-signal' ? [tool] : [],
  };
}

/**
 * A path-shaped token, for removal from the COSINE query only.
 *
 * Two shapes, and the second condition is what keeps it honest: ≥2 slashes
 * (`apps/operator-vite/src`, `/home/x/y`), OR exactly one slash plus a file
 * extension (`memory/injection.ts`). A single-slash token with no extension is
 * LEFT ALONE, because that is where the false positives live — `and/or`,
 * `input/output`, `24/7` are prose an agent really does type into a Grep
 * pattern or a Bash description, and stripping them would delete meaning from
 * the very query this is protecting.
 *
 * ⚠ THE DELIMITER CLASSES ARE SHELL-SHAPED, NOT WHITESPACE (WI-37403). The
 * boundaries used to be `(?:^|\s)` … `(?=\s|$)`, which is right for prose and
 * wrong for the dominant input on this port: a Bash `tool_input`, where paths
 * sit against punctuation constantly — `$(readlink -f /a/b/c);`, `"/a/b/c"`,
 * `grep -n x pkg/lib/f.ts|head`, `2>/dev/null`. A whitespace-only boundary
 * fails to match every one of those, so the path stayed in the cosine query and
 * pulled the vector exactly as D-041 describes.
 *
 * MEASURED (2026-08-09, replayed against real commands from the session that
 * found this): `B=$(readlink -f /home/linuxbrew/.linuxbrew/bin/codex); echo bin`
 * was NOT stripped, and that call injected two memories whose only relationship
 * to the task was the token `linuxbrew` — one about a Mac VM's bash version, one
 * about dev-launcher PATH exports, while the agent was enumerating codex hook
 * events. Same shape observed for `maxdepth` and `readlink /proc`.
 *
 * Lookbehind/lookahead (not consumption) so the delimiter itself survives the
 * replace; the token shape above is UNCHANGED, so every false-positive guard it
 * encodes still holds — `and/or`, `24/7`, `input/output`, `a b/c thing` are all
 * verified unchanged by this widening.
 */
const COSINE_PATH_TOKEN_RE =
  /(?<=^|[\s"'`(=,;:|&<>])(?:~?\/?(?:[\w.@*[\]-]+\/){2,}[\w.@*[\]-]*|[\w.@*[\]-]+\/[\w.@*[\]-]*\.[A-Za-z][\w]{0,5})(?=[\s"'`),;:|&\]]|$)/g;

/**
 * Split the derived text into the two per-leg queries (P-044 / F-L, motivated by
 * D-041's live measurement).
 *
 * The derived text is the LEXICAL leg's query unchanged — that leg is
 * token-matching and embed-free, and identifiers are precisely what it is for,
 * so this endpoint's lexical input is byte-identical to what it has always sent.
 * What changes is the COSINE query: it loses the path tokens.
 *
 * WHY, measured rather than assumed (D-041): replaying the WI-6512
 * investigation, batch one carried `apps/operator-vite/src` TWICE plus a full
 * component path against four content words, and the record that answered the
 * question was retrievable only by a query naming its literal id. The cosine leg
 * embeds its query as ONE vector, so those tokens were not inert padding — they
 * were pulling the vector toward "files under apps/operator-vite" and away from
 * the problem the agent was actually stuck on.
 *
 * ⚠ THE FALLBACK IS LOAD-BEARING, not defensive garnish. A batch of nothing but
 * `Read` calls strips to the empty string, and `buildMemoryContextBlock` gates
 * on the COSINE text being non-empty — so returning '' there would silently
 * disable mid-turn recall for every path-only batch, a much larger regression
 * than the dilution this fixes. When there is no prose to protect, there is also
 * nothing to dilute, so keeping the full text costs nothing.
 */
export function splitLegQueries(derived: string): { cosine: string; lexical: string } {
  const lexical = derived;
  const stripped = derived.replace(COSINE_PATH_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  // Then sweep the DEBRIS the strip leaves behind, per segment (WI-6857).
  //
  // The strip is per-token, so a call whose whole query was a path collapses to
  // nothing — but `deriveBatchQuery`'s ` · ` separators stay, and so does the
  // `(no result)` marker it appends to a barren call. Measured on the WI-6512
  // replay's batch 63: the emitted cosine query was
  // `session history (no result) · · agents running`, ~28% of it residue. This
  // function ALREADY judged both to be non-prose — `hasWords` discounted them
  // when deciding whether to fall back — and then embedded them anyway.
  //
  // The lexical leg keeps both: `(no result)` is real signal (D-027) and that
  // leg token-matches, so a marker costs it nothing. It is only in the COSINE
  // leg, where the whole query becomes ONE vector, that a bare separator and
  // the generic tokens "no"/"result" are pull without meaning.
  const cosine = stripped
    .split('·')
    .map((seg) =>
      seg
        .replace(/\(no result\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((seg) => /[A-Za-z0-9]/.test(seg))
    .join(' · ');
  return { cosine: cosine || lexical, lexical };
}

const midTurnContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/mid-turn-context',
  auth: 'loopback',
  async handler(req) {
    let body: {
      owner?: string;
      /** Private detector key carried separately from the public injection owner. */
      detectorSessionKey?: string;
      toolCalls?: BatchCall[];
      // Single-call form, kept for a direct caller / probe. The hook sends a batch.
      tool?: string;
      toolInput?: unknown;
      workspace?: string;
      harness?: string;
      cwd?: string;
      /** Which TUI is asking — 'claude' | 'codex' | 'omp'. Recorded only (P-005). */
      client?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: true, text: '' });
    }
    const owner = (body.owner ?? '').trim();
    if (!owner) return Response.json({ ok: false, error: 'owner required' }, { status: 400 });

    // Drain before any query/admission branch. A repeated-failure advisory is
    // orthogonal to memory recall, so it must still be delivered when this
    // batch has no recall signal, is a duplicate, or the recall lane is full.
    // EI-22762647123007262: signed/client-less MCP calls may attribute the
    // detector to a private session key while the hook still uses the public
    // owner for memory recall. Keep the two identities as separate request
    // fields; the owner fallback preserves legacy callers that predate the
    // detector-session transport field.
    const detectorSessionKey = (body.detectorSessionKey ?? owner).trim();
    const pendingFailureHint = takePendingFailureLoopHint(detectorSessionKey);
    const failureHintText = pendingFailureHint ? resolveFailureLoopHintText(pendingFailureHint) : Promise.resolve('');
    // P-011: the worn post-tool rules start here too, for the same reason — no
    // recall early return below may drop them.
    const batchTools = (Array.isArray(body.toolCalls) && body.toolCalls.length
      ? body.toolCalls.map((call) => call?.tool)
      : [body.tool])
      .map((tool) => (typeof tool === 'string' ? tool.trim() : ''))
      .filter(Boolean);
    // Resolved once, for the rules and the recall alike.
    const workspaceIdResolved = (async () => {
      const workspace = (body.workspace ?? '').trim();
      if (workspace && workspace !== '*') return workspace;
      const { activeWorkspaceId } = await import('../../../workspace-registry');
      return activeWorkspaceId();
    })();
    // Awaited inside the try below; an early throw there must not leave it unhandled.
    workspaceIdResolved.catch(() => undefined);
    const ruleContextText = postToolRuleContextText(owner, workspaceIdResolved, batchTools);
    const respond = async (memoryBlock = ''): Promise<Response> => {
      const [failureHint, ruleContext] = await Promise.all([failureHintText, ruleContextText]);
      return Response.json({
        ok: true,
        text: composeMidTurnContextText(memoryBlock, failureHint, ruleContext),
      });
    };

    try {
      // P-005 / D-005 §3b — derive DETAILED so a miss can leave a TRACE.
      // This used to compute a bare string and `return` on empty, recording
      // nothing, which is precisely why "the hook fired but the server derived
      // no query" was indistinguishable from "the hook never fired" and let
      // codex/omp sit structurally zeroed on this port without a fault.
      const detail =
        Array.isArray(body.toolCalls) && body.toolCalls.length
          ? deriveBatchQueryDetailed(body.toolCalls)
          : singleCallDetail((body.tool ?? '').trim(), body.toolInput);
      const derived = detail.query.slice(0, QUERY_CLAMP);

      // Resolved BEFORE the first coverage write, not at the recall site, so a
      // miss row and a recall row for the same session key on the same
      // workspace. Split keys would make per-workspace coverage unreadable.
      const workspaceId = await workspaceIdResolved;

      const coverage = {
        port: 'mid-turn' as const,
        client: typeof body.client === 'string' ? body.client : '',
        workspaceId,
      };
      // Recorded even when OTHER calls in the batch DID carry signal: a tool we
      // cannot read is vocabulary drift whether or not this particular batch
      // happened to succeed around it. Never awaited — telemetry must not cost
      // the turn.
      if (detail.unknownTools.length || detail.noSignalTools.length) {
        void recordInjectionCoverage([
          ...detail.unknownTools.map((tool) => ({
            ...coverage,
            outcome: 'unknown-tool' as const,
            tool,
          })),
          ...detail.noSignalTools.map((tool) => ({
            ...coverage,
            outcome: 'no-signal' as const,
            tool,
          })),
        ]);
      }

      // No signal in this tool call — drop before spending anything. The
      // difference from before is that the drop is now RECORDED above.
      if (!derived) return respond();
      // P-044: one derived signal, two per-leg queries. See splitLegQueries().
      const { cosine: query, lexical: lexicalQuery } = splitLegQueries(derived);
      // The cost guards key on the FULL derived text, not the stripped cosine
      // half — two batches that differ only in which files were read are
      // genuinely different questions for the lexical leg, and collapsing them
      // here would suppress the second one's recall entirely.
      if (!admitCall(owner, derived, Date.now())) return respond();
      pruneRateState(Date.now());

      let harness = (body.harness ?? '').trim();
      // EI-18893248175645463, mid-turn half (P-038). PAPERCUSP_HARNESS_SLUG is
      // only exported for harness-scoped spawns, so an operator/superuser-scope
      // session never sends `harness` — and BOTH the harness AND hive pools
      // (hive resolution fans out FROM harnessSlugs) went empty for that
      // session's whole lifetime. Measured over 7d before this fix: 44.8% of
      // mid-turn recalls queried the harness pool with ZERO scopes, and in
      // exactly those the user pool alone filled all 12 slots — which is what
      // made this surface read as 100% "saturated" and look like a fusion-ceiling
      // failure (F-B) when the ceiling was working fine and the other two pools
      // were simply never asked. Same fallback the turn-start sibling uses, on
      // the CLIENT's cwd (loopback hook, so its cwd is the session's).
      if (!harness && typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const { detectHarnessSlugSync } = await import('../../../memory/detect-harness-slug');
          harness = detectHarnessSlugSync({ cwd: body.cwd.trim() }).slug ?? '';
        } catch {
          /* best-effort — an empty harness just stays a bare-session pull */
        }
      }

      const { withMidTurnMemoryAdmission } = await import('../../../memory/mid-turn-admission');
      const admitted = await withMidTurnMemoryAdmission(async () => {
        const [{ buildMemoryContextBlock }, { getSessionUserOrDefault }, { resolveClaimedWorkItemIdForOwner }] =
          await Promise.all([
            import('../../../memory/injection'),
            import('../../../auth'),
            import('../../../memory/agent-signals'),
          ]);
        const [user, currentWorkItemId] = await Promise.all([
          getSessionUserOrDefault().catch(() => null),
          resolveClaimedWorkItemIdForOwner({ ownerId: owner, workspaceId }).catch(() => undefined),
        ]);
        // ⚠ P-006 / D-046's human-turn tail is DELIBERATELY NOT WIRED HERE either —
        // this is the mirror of the turn-start call site, and it is held back for the
        // same measured reason (plan decision D-047). If it is ever wired, compose it
        // AFTER admitCall: the cost guards above key on the tool-derived query alone,
        // and a tail that shifts as ingest lands would perturb the
        // "identical consecutive query ⇒ skip" guard.
        return (
          (await buildMemoryContextBlock({
            userId: user?.id ?? null,
            workspaceId,
            harnessSlugs: harness ? [harness] : [],
            // P-044: `userText` is the de-diluted prose the cosine leg embeds;
            // `lexicalText` is the full derived signal, identifiers and all, for
            // the leg that actually wins on them. When the strip finds no prose to
            // protect the two are the same string and nothing changes.
            queryContext: { userText: query, lexicalText: lexicalQuery },
            // Free-text port; the epoch ledger is port-agnostic (D-006), so this
            // inherits turn-start's dedup instead of needing one of its own.
            // P-005 / migration 770: recorded on memory_recall_stats, never
            // branched on — this endpoint stays client-agnostic (D-001 inv. 6).
            // No client sent ⇒ NULL ⇒ unattributed, which is the honest reading.
            session: {
              sessionId: owner,
              port: 'mid-turn',
              currentWorkItemId,
              ...(typeof body.client === 'string' && body.client ? { client: body.client } : {}),
            },
            budgetChars: MID_TURN_BUDGET_CHARS,
            heading: 'Possibly relevant (mid-turn)',
          })) ?? ''
        );
      });
      if (!admitted.admitted) return respond();
      const block = admitted.value;

      // The recall RAN. Separate "returned context" from "found nothing
      // relevant": the second is healthy quiet, and an alarm that cannot tell
      // it from a dead hook is the false alarm D-005 §3 exists to prevent.
      void recordInjectionCoverage([{ ...coverage, outcome: block ? 'recalled' : 'no-recall' }]);

      // The budget is advisory inside buildMemoryContextBlock; see clampToBudget.
      return respond(block);
    } catch {
      return respond();
    }
  },
});

export default [midTurnContext];
