/**
 * Centralized pre-turn memory-injection helper.
 *
 * Returns a markdown block to splice into a chat route's system prompt.
 * Caller pattern:
 *
 *   const block = await buildMemoryContextBlock({
 *     userId: sessionUser.id,
 *     workspaceId,
 *     queryContext: lastFewUserMessages,
 *   });
 *   if (block) sections.push(block);
 *
 * Same shape used by operator-converse today. Designed so other chat
 * routes can adopt the exact same behavior with a 1-line call.
 *
 * `queryContext` also accepts the structured `RecallQuery`
 * (`{ userText, agentSignals? }`, P-042/F-J) for callers that have grounded
 * agent context — a claimed work-item, the tool-call trajectory, the active
 * file — rather than only a human utterance. A bare string stays correct for
 * every caller that genuinely has just user text; see ./recall-query.
 *
 * Best-effort: any failure (mem0 unavailable, PG down, embedder
 * misconfigured, no hits) returns null and the caller's prompt is
 * unaffected. Never throws.
 */

import { getOrgPg } from '@papercusp/db-org';
import { isIdentityPackageHit, packageRecallEligibility, shapeIdentityPackageHits,
  wearerPackageResourcesOrEmpty } from '../blueprint/package-memory-visibility';
import { getSessionBriefAmbientExcludedRefs } from '../session-brief';
import { getMemoryBackend, type MemoryEntry, type SearchLegStats } from './backend';
// Type-only: erased at build, so `recall-stats` stays a dynamic import on the
// telemetry path (see the writer below) rather than being pulled in eagerly.
import type { CorpusAdmissionDropReason, CorpusAdmissionStats, RecallAdmissionStats } from './recall-stats';
import { pushSearchFloors } from './push-search-floors';
export { MEMORY_INJECTION_COSINE_FLOOR, MEMORY_INJECTION_LEX_FLOOR, pushSearchFloors } from './push-search-floors';
export type { PushSearchFloors } from './push-search-floors';
import { admittedByLeg, collapseNearDuplicates } from './recall-admission';
// P-003. Pure — no I/O, no PG, and its two imports are type-only, so this stays
// a static import while the SNAPSHOT read (which does pull the search graph)
// remains dynamic below, beside the rest of the corpus leg's dynamic imports.
import { assessCorpusCoverageGate, CORPUS_GATE_SOURCES, type CorpusGateDecision } from './corpus-coverage-gate';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from './workspace-scope-recall';
import { bumpLastSurfacedSql, recentlySurfacedIds } from './bump-last-surfaced';
import { alreadySurfacedIds, currentSessionEpoch, stampSurfaced } from './session-epoch-ledger';
import { hiveScopeKey, potSlugFromScope, resolvePotSlugsForHarnesses } from './hive-scope';
import { lexicalQueryText, retrievalQueryText, toRecallQuery, type RecallQueryInput } from './recall-query';
import { memoryTierOf } from './two-tier';
import { jevFunnelEntry, jevMemoryBudgetMs, runJevMemoryGate } from './jev-memory-gate';
import { annotateSupersededMemory } from './temporal-render';
import { systemDistinctId } from '../flag-distinct-id';
import {
  MEMORY_INJECT_TIMEOUT_MS,
  MemoryTimeoutError,
  isMemoryDegraded,
  noteMemoryFailure,
  withMemoryTimeout,
  createMemoryWorkDeadline,
  type MemoryWorkDeadline,
} from './op-deadline';

// P-016: Mirrors EPHEMERAL_BENCHMARK_SLUG_RE in harness/improvements/watchdog.ts.
// Inlined here to avoid pulling that module's heavy @papercusp/db-org transitive
// imports into injection.ts (which is mocked with a partial db-org stub in tests).
const EPHEMERAL_SLUG_RE =
  /(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]/i;

/**
 * Memory injection is a best-effort enhancement — never load-bearing —
 * and it must never *hang*. `buildOperatorPrompt` awaits this helper
 * inline, so a slow/stuck embedder (e.g. the local BGE ONNX model
 * downloading on first use when no OpenAI key is set) would otherwise
 * block the entire operator turn — the failure mode observed 2026-05-21
 * where operator-converse emitted only SSE heartbeats and never
 * produced a turn.
 *
 * Every store call here is bounded by MEMORY_INJECT_TIMEOUT_MS. The first
 * timeout drops the whole process into a degraded mode so later turns skip
 * the store instantly instead of paying the timeout on every turn. The
 * deadline/latch primitive is shared with the explicit memory tools
 * (./op-deadline, B1) so a hang on EITHER path quiets this hot per-turn path;
 * the latch resets on restart and the backend's poison-cache handles
 * client-level recovery.
 */

export interface MemoryInjectionInput {
  /** Shared with prompt preparation and both recall legs; phases cannot reset it. */
  deadline?: MemoryWorkDeadline;
  /**
   * Epoch ms after which the caller's client stops waiting for the response (a
   * hook's wall, measured from when the request arrived). Jev waits only for what
   * is left of it (jev-memory-gate: jevMemoryWaitMs). Absent: no client wall.
   */
  respondByMs?: number;
  /**
   * Whether the caller still waits on this build (injection-block-cache
   * MemoryBlockBuildContext). Read when Jev's time is set: once it is false the
   * build answers nobody, so `respondByMs` no longer bounds Jev and only the
   * build's own deadline does. Absent: treated as waiting.
   */
  callerWaiting?: () => boolean;
  /**
   * Per-user memory scope. Omit (or pass null) on workspace-bearer
   * routes that don't have a session user — the helper will then
   * inject only the harness/workspace pools.
   */
  userId?: string | null;
  workspaceId: string;
  /**
   * Harness slugs whose shared memory should be pulled into recall.
   * Agent inside one harness: pass `[currentSlug]`. Operator chat
   * (no specific harness): pass every harness the session user has
   * access to. Omit/[] to skip the harness pool entirely.
   */
  harnessSlugs?: readonly string[];
  /**
   * Hive pools to pull (`hive:<slug>` scope — knowledge-packs P-004). Usually
   * OMITTED: the helper resolves the owning hives from `harnessSlugs` via the
   * registry (member `hive_slug` / `harness_kind:'hive'` home). Pass
   * explicitly to skip that lookup or to recall a hive with no harness in
   * scope; pass `[]` to suppress the hive pull entirely.
   */
  potSlugs?: readonly string[];
  /**
   * What to recall against. A bare string is the recent user-turn content
   * concatenated — the historical form, still correct for any caller that has
   * only user text (every chat route). An empty query returns null.
   *
   * P-042 (F-J) widened this to the structured `RecallQuery`
   * (`{ userText, agentSignals? }`) so the human's words and the agent's
   * grounded context stop being forced through one string. Passing the object
   * form is behavior-identical TODAY — `agentSignals` is carried but does not
   * yet reach retrieval (P-043 populates it, P-044 routes it to the lexical
   * leg), which is what keeps this item revertable on its own.
   */
  queryContext: RecallQueryInput;
  /**
   * TOTAL hits admitted across ALL pools (user + harness + hive), not a
   * per-pool limit. F-C (context-injection-audit-2026-07-28 P-033 / D-011)
   * deleted the per-pool quotas: every pool now competes for every slot on
   * ONE ranking, so there is a single ceiling rather than three reservations.
   * Defaults to INJECTION_TOTAL_LIMIT.
   */
  limit?: number;
  /**
   * Opt into closed validity windows. Default false keeps ordinary recall
   * current-only; opted-in rows are visibly marked by the shared renderer.
   */
  includeSuperseded?: boolean;
  /** Defaults to "Operator memory (relevant entries)". */
  heading?: string;
  /**
   * WARM-SESSION dedup (memory-delivery-unification-2026-07-12 P-002,
   * D-002/D-006): when set, re-injection is suppressed per SESSION EPOCH
   * (session identity + compaction generation) via the port-agnostic
   * `memory_session_surfaced` ledger, INSTEAD of the chat path's 2-minute
   * wall-clock watermark — an injected fact stays in a warm session's
   * context until compaction, so mid-epoch re-injection is pure waste,
   * while an epoch bump (post-compaction) re-primes everything. Omit on
   * chat paths (watermark behavior unchanged).
   */
  session?: {
    /** Stable per-launch session identity (the su SID / uiClientId). */
    sessionId: string;
    /** Compaction generation; omitted ⇒ resolved from the epoch table. */
    epoch?: number;
    /** Which injection moment this is (initialize/turn-start/compact/brief/claim/create). */
    port?: string;
    /** Active work-item scope for pointer disambiguation on ports without signals. */
    currentWorkItemId?: string | null;
    /**
     * WHICH TUI is receiving this injection — 'claude' | 'codex' | 'omp'
     * (migration 770 / codex-context-injection-parity-2026-08-09 P-005).
     *
     * Recorded on memory_recall_stats.client and used for NOTHING ELSE: it must
     * never select behaviour. The server side is client-agnostic by contract
     * (D-001 invariant 6) — the whole design is one endpoint per port with a
     * per-client adapter on the CLIENT side, so branching on this value here
     * would re-introduce exactly the fork that invariant forbids.
     *
     * Omitted ⇒ NULL ⇒ 'unattributed', which is honest and stays distinguishable
     * from a real client. It exists to make "which clients actually receive
     * per-turn injection" a query instead of an archaeology exercise.
     */
    client?: string;
  };
  /**
   * Per-call assembly budget override (chars). D-004 (memory-delivery-
   * unification): mid-epoch moments (turn-start, the claim/create ports) are
   * high-precision/LOW-VOLUME — injected lines compound in a warm session —
   * so they pass a small budget (~3-4k) instead of the global 16k default.
   */
  budgetChars?: number;
  /**
   * P-005 telemetry override: the recall-stats `surface` label for this call,
   * for a port that has NO dedup session to carry `session.port` — the Mug/cup
   * brief ('brief'), whose long-lived loop must NOT permanently dedup (no
   * compaction epoch to reset it). When set it wins over `session?.port`;
   * otherwise the surface is `session?.port ?? 'injection'`. Telemetry only —
   * never affects recall/dedup.
   */
  telemetrySurface?: string;
  /**
   * Latency opt-in for a port whose build runs under a hard deadline: overlap
   * the hybrid backend's `cosine-gated` lexical leg with its cosine leg instead
   * of running them in series (`SearchOptionsCommon.overlapGatedLexical`).
   * The recalled set is unchanged; the cost is one discarded lexical query on a
   * call whose cosine set is empty. Turn-start sets it (WI-10004485: the gate
   * closed on 0.4% of its recalls while the serial leg cost p50 386 ms of the
   * 2 s build deadline); ports with a materially higher empty-cosine rate keep
   * the strict sequence.
   */
  overlapGatedLexical?: boolean;
}

/**
 * Cap the number of harness pools fanned out per turn. Each pool is
 * an independent mem0.search() (= one embed + one pgvector query).
 * 20 is fine on local pgvector; if a workspace exceeds this we slice
 * and log a warning — the optimization path (embed once + custom
 * SQL with IN()) is documented in the memory-harness-scope plan.
 */
const MAX_HARNESS_FANOUT = 20;

/**
 * The TOTAL hits admitted across every pool — the block's one ceiling.
 * F-C (context-injection-audit-2026-07-28 P-033, D-011).
 *
 * This REPLACES the three per-pool quotas (user 6 + harness 3 + hive 3), which
 * P-033 found were allocated INVERSELY to where knowledge lives: 6 slots to the
 * 487-memory CROSS-PROJECT personal pool, 3 to the 770-memory on-topic harness
 * pool. 12 is exactly that old sum, deliberately — F-C changes WHO gets the
 * slots, never HOW MANY exist, so the block cannot grow. (P-033 explicitly
 * forbids the tempting fix of raising the harness quota; the quota is deleted,
 * not retuned.)
 *
 * The quotas could only be deleted by ALSO collapsing the three per-pool
 * searches into one multi-scope search — see the fan-out below for why.
 */
/** Exported so the P-002 guard probes at production's own ceiling, not a copy. */
export const INJECTION_TOTAL_LIMIT = 12;

/**
 * A memory entry with the optional body that should be shown in the injected
 * block. Keep this separate from `text`: retrieval ordering and near-duplicate
 * collapse must continue to operate on the stored body, while the staleness
 * banner is a display-time warning only.
 */
type InjectionMemoryEntry = MemoryEntry & { injectionText?: string };

/**
 * Fold the nightly anchor-sweep verdict into the pre-turn display path.
 *
 * This mirrors the explicit `memory:search` consumer: the feature flag is the
 * same default-on kill switch, the verdict is loaded only for returned ids,
 * and every failure returns the original entries. The helper's banner rides a
 * display-only field so the warning changes what the agent sees without
 * changing rank, feedback filtering, or near-duplicate identity.
 */
async function applyStoredMemoryStaleness(
  entries: MemoryEntry[],
  workspaceId: string,
): Promise<InjectionMemoryEntry[]> {
  if (entries.length === 0) return entries;
  try {
    const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
    if (!(await getFlag(FLAGS.MEMORY_STALENESS_IN_RECALL, systemDistinctId()))) return entries;

    const ids = entries.map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return entries;

    const { loadMemoryStaleness, applyMemoryStaleness } = await import('./recall-staleness');
    const { sql } = getOrgPg();
    const verdicts = await withMemoryTimeout(
      loadMemoryStaleness(sql, ids),
      'memory staleness',
      MEMORY_INJECT_TIMEOUT_MS,
    );
    const rows = applyMemoryStaleness(
      entries.map((entry) => ({ ...entry, memory: entry.text })),
      verdicts,
    );

    return rows.map((row, index) => {
      if (!row.staleness || typeof row.memory !== 'string') return entries[index]!;
      return { ...entries[index]!, injectionText: row.memory };
    });
  } catch {
    // Anchor verdicts are advisory hygiene. A flag, table, PG, or timeout
    // failure must never suppress an otherwise healthy memory injection.
    return entries;
  }
}

/**
 * Watermark window for the pre-turn dedup (docs-and-memory-as-projections D-006):
 * a memory surfaced within this window is NOT re-injected this turn, so a stable
 * fact stops being paid for turn-over-turn within a session. Long enough to span
 * back-to-back turns; short enough that a memory re-surfaces after a real pause.
 * Tunable via env; evaluated at call time so tests can flip it.
 */
function reinjectWindowMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_REINJECT_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
}


/**
 * PUSH-path diversity re-rank λ (context-injection-audit-2026-07-28 P-034 / F-D,
 * D-014). The redundancy lever on the owner's standing constraint: inject
 * relevant information WITHOUT bloating the context.
 *
 * Nothing anywhere else in this ranking chain penalizes REDUNDANCY — mem0's
 * fusion, the cosine floor, the recency decay and RRF all optimize relevance
 * alone. With ~10 hits admitted per injection, a scope holding many near-copies
 * of one fact (repetitive checkpoints, "grounds fact X" observations, loop
 * notes — exactly what this system writes most of) spends the whole block on
 * paraphrases of its single best hit and starves the 2nd/3rd distinct fact. MMR
 * demotes a near-copy by its similarity to what is already selected.
 *
 * Why this fix is BUDGET-NEUTRAL and needs no new ceiling: the pass never adds
 * or drops entries, and INJECTION_TOTAL_LIMIT still decides how many are
 * admitted. It changes WHICH of the floor-passing candidates fill those slots —
 * the same "change who gets the slots, never how many exist" posture F-C took
 * (D-011). It also composes with the char budget, which truncates in RENDER
 * order (D-011): a demoted near-copy is now the entry that gets truncated.
 *
 * λ=0.7 leans relevance-first: with the trigram-Jaccard similarity proxy a
 * genuine near-duplicate scores ~0.5+ against an unrelated hit's ~0.1, so 0.7
 * moves a redundant hit a few ranks — enough to lose a slot to a distinct fact,
 * not enough to let a weakly-relevant novelty outrank a strong on-topic hit.
 * λ=1 is an exact no-op; PAPERCUSP_MEMORY_MMR=0 kill-switches it outright.
 * P-038's measurement window is where to tune this, NOT a priori — and note
 * D-008's lesson before reaching for it: on this path the natural constant to
 * retune is usually not the one governing the behavior.
 */
const MEMORY_INJECTION_DIVERSITY_LAMBDA = 0.7;

function injectDiversityLambda(): number | undefined {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DIVERSITY_LAMBDA);
  if (Number.isFinite(raw)) return raw >= 1 ? undefined : raw;
  return MEMORY_INJECTION_DIVERSITY_LAMBDA;
}

/**
 * Injected-block character budget (knowledge-packs P-011 / D-008). ~4k tokens
 * by default (≈4 chars/token). Lines are admitted in priority order — user
 * pool → harness pools → hive-organic → hive-pack — and assembly stops at the
 * budget, so a hive carrying many packs can't crowd the user's own facts out
 * of the turn. Env-tunable; `<= 0` disables the cap.
 */
function injectBudgetChars(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 16_000;
}

/**
 * Per-entry ceiling on a rendered memory line's TEXT (WI-6870). Before this, the
 * admission loop's `lines.length > 0` first-entry exemption let ONE oversized memory
 * (measured 4,901 chars against a 4,000 budget) consume the ENTIRE budget by itself —
 * every other candidate then starved and the turn got a single memory plus a "learnings
 * withheld" notice. Clamping each entry here makes that exemption harmless: no single
 * line can ever be large enough to blow a normal budget on its own, so budget admission
 * can now be enforced strictly (see `admit` below) without a "let the first one through
 * no matter what" escape hatch. Mirrors the corpus leg's `CORPUS_TEASER_MAX_CHARS`
 * (corpus-recall.ts), sized larger because this pool renders full sentences rather than
 * resolve-on-demand pointers.
 *
 * HALVED 900 -> 450 on 2026-08-09 (P-024 / D-090, owner-chosen lever). D-089 measured
 * the real constraint: reach is the QUOTIENT of the budget and the per-entry cost, not
 * either number alone. Median cost per ADMITTED entry was 909 chars — this clamp plus
 * the `- {scope}{id} ` prefix rendered below — against a 4,000-char turn-start budget,
 * so 4000/909 = ~4.4 slots, exactly the observed admitted count (avg 8.4 returned ->
 * 3.8 admitted, 45.1% admit rate, n=23 turn-start rows 17:16-18:15Z).
 *
 * Two levers reach ~8.8 slots and they are NOT equivalent in cost:
 *   - PAPERCUSP_TURN_START_BUDGET_CHARS 4000 -> 8000: ~2x the context spend.
 *   - MAX_ENTRY_CHARS 900 -> 450 (this one): the SAME spend, more entries.
 * The asymmetry favors the clamp: a clamped line keeps scope + id + lede and says
 * "memory:search for the rest", so it stays RECOVERABLE; an entry dropped for budget is
 * invisible to the agent and unrecoverable. The owner was given all three options
 * (clamp / raise budget / wait for more data) against the D-089 measurement and picked
 * the clamp, declining the other two [owner 2026-08-09].
 *
 * ⚠ Do NOT "fix" a reach shortfall by raising the turn-start budget instead — that
 * trades context cost for the same slot count. And do NOT touch MID_TURN_BUDGET_CHARS
 * (D-073): the mid-turn port is governed separately and was explicitly excluded.
 * ⚠ The setting is thinner than the mechanism: 450 rests on n=23 over ~1h in ONE
 * workspace (su-39431's stated caveat, adopted here rather than overridden). The
 * QUOTIENT model is solid; 450-vs-600-vs-300 is not settled. The A/B metric is the
 * ADMITTED rate, never %budget (D-077). Nothing in the admission telemetry measures
 * whether a delivered memory was USEFUL — only that it was delivered — so a reach win
 * is not automatically a quality win.
 */
const MAX_ENTRY_CHARS = 450;

/**
 * Phase telemetry (EI-12962): the injection measured ~10.7s of a ~11s prompt
 * build on a COLD operator process (available() ~5s + first-embed ~4s) vs
 * ~1.5s warm (probe 2026-07-16, hybrid-pg, 7-scope fan-out). Log the per-phase
 * split whenever a call is slow enough to matter, so a cold-start regression
 * (or a warmup that stopped covering the real path) is visible in the operator
 * log instead of re-derived by hand. `postMs` = totalMs − the stamped legs
 * (feedback/dedup/flags/assembly).
 */
const SLOW_INJECTION_LOG_MS = 750;

export async function buildMemoryContextBlock(input: MemoryInjectionInput): Promise<string | null> {
  const ownsDeadline = !input.deadline;
  const deadline = input.deadline ?? createMemoryWorkDeadline(MEMORY_INJECT_TIMEOUT_MS);
  input = { ...input, deadline };
  const marks: Array<[string, number]> = [];
  const t0 = Date.now();
  let corpus: CorpusLegResult | null = null;
  try {
    // P-008 / D-037 — the SECOND retrieval leg (session transcripts +
    // work-items). Started HERE, before the mem0 leg is awaited, so the two
    // run CONCURRENTLY: they read different stores under different budgets and
    // share nothing, so the corpus leg adds no latency to the critical path
    // unless it is the slower of the two (and it carries its own 2s bound).
    //
    // It is composed at the END rather than merged into the mem0 ranking on
    // purpose. The corpora sit in incompatible vector spaces (memory =
    // harrier@1024, prose surfaces = gemma@768), so their scores can never
    // join the one comparable ranking F-C/D-011 built — merging them could
    // only be done by a fixed priority, which D-011 names "a quota under
    // another name". See ./corpus-recall.
    const corpusP = deadline.run(() => startCorpusLeg(input), 'corpus leg').catch((error) => {
      if (!(error instanceof MemoryTimeoutError)) return null;
      return emptyCorpusLeg('Related context (matched excerpts)', false, 0, null, {
        outcome: 'timed-out', selected: 0, dropped: emptyCorpusDrops(),
        sessionDedup: 0, legs: null, retrievalDepth: 0, rerank: 'nothing-to-reorder',
      });
    });
    let memoryTimedOut = false;
    let renderedMemory: string | null | undefined;
    const memoryBlock = await deadline.run(
      () => buildBlockInner(input, (label, ms) => marks.push([label, ms]), corpusP, (block) => { renderedMemory = block; }), 'memory leg',
    ).catch((error) => {
      if (!(error instanceof MemoryTimeoutError)) throw error;
      // Scheduling the joint telemetry row may still be awaiting the slower
      // corpus. It must not erase memory that was already safely rendered.
      memoryTimedOut = renderedMemory === undefined;
      if (memoryTimedOut) noteMemoryFailure(error);
      return renderedMemory ?? null;
    });
    // Settled HERE rather than inside the composer (P-001): the leg's own
    // health is a fact about this injection, not about how the block was
    // assembled, and the `finally` below has to be able to report it. The await
    // point is unchanged, so the two legs still overlap exactly as before.
    corpus = await corpusP.catch(() => null);
    noteCorpusLegHealth(corpus);
    const block = composeWithCorpus(memoryBlock, corpus);
    if (!memoryTimedOut) return block;
    const notice = '⚠ Memory retrieval was DEGRADED this turn (memory leg: timed-out) — recover missing recall with memory:search.';
    return block ? `${block}\n\n${notice}` : notice;
  } finally {
    if (ownsDeadline) deadline.close();
    const totalMs = Date.now() - t0;
    if (totalMs > SLOW_INJECTION_LOG_MS) {
      const stamped = marks.reduce((s, [, v]) => s + v, 0);
      console.log(
        `[memory-injection] phases totalMs=${totalMs} ${marks
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')} postMs=${Math.max(0, totalMs - stamped)}${describeCorpusLeg(corpus)}`,
      );
    }
  }
}

/** What the corpus leg hands back to the composer. */
interface CorpusLegResult {
  heading: string;
  lines: string[];
  refs: string[];
  /**
   * P-001 — FALSE on a completed (`outcome: 'ok'`) search means BM25-ONLY: no query vector, so
   * every line below it is a lexical match and nothing semantic was reachable.
   * `recallCorpusContext` has always computed this; the injection path dropped
   * it on the floor, which left injection unable to tell "semantic ran and
   * these are its best matches" from "semantic was absent and these are
   * lexical scraps" — the two cases that must NOT be read the same way.
   *
   * P-002 records it per-leg; P-003 gates degradation on it. Here it only has
   * to survive the trip.
   */
  embedderAvailable: boolean;
  /** Candidates the engine returned, BEFORE pure-core selection. Paired with
   *  `lines.length` it separates "retrieval found nothing" from "retrieval
   *  found plenty and selection rejected all of it". */
  candidateCount: number;
  /**
   * P-003 — what this leg's retrieval was ENTITLED to claim, given the state of
   * the indexes it read. `null` when the gate could not be evaluated (the leg
   * faulted before fusion); that is treated as no-decision, never as health.
   */
  gate: CorpusGateDecision | null;
  outcome: CorpusAdmissionStats['outcome'];
  /** Lines selected before the coverage gate and cross-moment dedup. */
  selected: number;
  dropped: Record<CorpusAdmissionDropReason, number>;
  sessionDedup: number;
  legs: Record<string, unknown> | null;
  retrievalDepth: number;
  rerank: string;
}

const emptyCorpusDrops = (): Record<CorpusAdmissionDropReason, number> => ({
  'ambient-excluded': 0,
  'self-session': 0,
  'out-of-scope': 0,
  'no-term-overlap': 0,
  'duplicate-ref': 0,
  'not-novel': 0,
  'cap-exhausted': 0,
  'budget-exhausted': 0,
});

const countCorpusDrops = (
  dropped: readonly { reason: CorpusAdmissionDropReason }[],
): Record<CorpusAdmissionDropReason, number> => {
  const counts = emptyCorpusDrops();
  for (const drop of dropped) counts[drop.reason] += 1;
  return counts;
};

/**
 * A leg that RAN and admitted nothing — distinct from `null`, which means the
 * leg never ran (no query text, or it faulted). The composer treats both the
 * same, deliberately; the observability path must not.
 */
function emptyCorpusLeg(
  heading: string,
  embedderAvailable: boolean,
  candidateCount: number,
  gate: CorpusGateDecision | null = null,
  telemetry: Pick<
    CorpusLegResult,
    'outcome' | 'selected' | 'dropped' | 'sessionDedup' | 'legs' | 'retrievalDepth' | 'rerank'
  > = {
    outcome: 'ok',
    selected: 0,
    dropped: emptyCorpusDrops(),
    sessionDedup: 0,
    legs: null,
    retrievalDepth: 0,
    rerank: 'nothing-to-reorder',
  },
): CorpusLegResult {
  return { heading, lines: [], refs: [], embedderAvailable, candidateCount, gate, ...telemetry };
}

/** One compact suffix for the phases log — never a second log site. */
function describeCorpusLeg(corpus: CorpusLegResult | null): string {
  if (!corpus) return ' corpus=absent';
  // P-003: `corpusGate` is the difference between "admitted 0 because the corpus
  // had nothing" and "admitted 0 because the gate suppressed a section it could
  // not stand behind" — two states that are otherwise identical on this line.
  // `unevaluated` says the gate itself did not run; it never reads as healthy.
  const gate = corpus.gate;
  return (
    ` corpus=ran corpusEmbedder=${corpus.embedderAvailable ? 'yes' : 'no'}` +
    ` corpusCandidates=${corpus.candidateCount} corpusAdmitted=${corpus.lines.length}` +
    ` corpusGate=${gate ? gate.verdict : 'unevaluated'}` +
    (gate && gate.reasons.length > 0 ? ` corpusGateWhy=${gate.reasons.join(',')}` : '')
  );
}

/**
 * Degradation is THROTTLED, not latched — the same reasoning `recall-stats`
 * documents for its capture warn: a one-shot warn is how a persistent failure
 * hides, because the single line scrolls away and silence then reads as health.
 * A cold embedder recovers on its own and must not spam every turn; one that
 * never recovers must keep saying so.
 */
const CORPUS_DEGRADED_WARN_WINDOW_MS = 5 * 60_000;
let _corpusDegradedWarnedAt = 0;
let _corpusDegradedSinceWarn = 0;

/**
 * Under the test runner this diagnostic is SILENT unless a suite opts in (see
 * `_resetCorpusLegHealthForTests`). This is not test-shyness — it is the same guard every
 * sibling diagnostic in `lib/memory/` already carries (`session-extraction-llm.ts`,
 * `anthropic-judge.ts`, `embed-exhaustion-alert.ts`), and it is load-bearing:
 *
 * `vitest-fail-on-console` turns ANY unexpected `console.warn` into a test failure, and there is
 * no embedder in a unit-test environment — so `embedderAvailable` is false by CONFIGURATION, not
 * by degradation. Without this guard the warn fires from deep inside `buildClaimRecallBlock` /
 * `buildLaunchMemoryBlock` and reds every suite that transitively builds a memory block, in files
 * that never mention memory. Measured 2026-08-03: it red-pinned the fleet gate via four unrelated
 * files at once — get_next.warning, get_next.divergence-recheck, work-items-urgent, and
 * mid-turn-context.p018-acceptance (EI/gate run a7f247ce).
 *
 * Production behaviour is UNCHANGED — outside the runner the warn fires exactly as before.
 */
const warnSuppressedByTestRunner = (): boolean =>
  Boolean(process.env.VITEST || process.env.NODE_ENV === 'test') && !_corpusWarnOptedInByTest;
let _corpusWarnOptedInByTest = false;

function noteCorpusLegHealth(corpus: CorpusLegResult | null): void {
  // Disabled, empty-query and failed legs never reached fusion. Their absent
  // query vector cannot establish that lexical retrieval ran.
  if (!corpus || corpus.outcome !== 'ok' || corpus.embedderAvailable) return;
  if (warnSuppressedByTestRunner()) return;
  _corpusDegradedSinceWarn += 1;
  const now = Date.now();
  if (now - _corpusDegradedWarnedAt < CORPUS_DEGRADED_WARN_WINDOW_MS) return;
  const alsoSuppressed = _corpusDegradedSinceWarn - 1;
  console.warn(
    `[memory-injection] corpus leg ran BM25-ONLY (no query vector) — ` +
      `candidates=${corpus.candidateCount} admitted=${corpus.lines.length}` +
      (alsoSuppressed > 0 ? ` — +${alsoSuppressed} more since last warn` : '') +
      `; re-warns at most once/${CORPUS_DEGRADED_WARN_WINDOW_MS / 60_000}min`,
  );
  _corpusDegradedWarnedAt = now;
  _corpusDegradedSinceWarn = 0;
}

/**
 * Test hook: reset the degradation throttle so a suite can assert re-warn behavior — and, by
 * calling it, OPT THAT SUITE IN to the warn actually being emitted under the runner.
 *
 * The two are deliberately one call rather than two: the only reason to reset this throttle is to
 * make assertions about the warn, so every caller wants both. Coupling them means the suite that
 * asserts on the diagnostic (`injection.test.ts`, which calls this from a file-global beforeEach)
 * keeps working untouched, while every OTHER suite — which never calls this — stays silent and
 * cannot be red-pinned by a warn it never asked about. Opt-in is per module registry, and vitest
 * isolates those per test FILE, so this cannot leak from one suite into another.
 */
export function _resetCorpusLegHealthForTests(): void {
  _corpusDegradedWarnedAt = 0;
  _corpusDegradedSinceWarn = 0;
  _corpusWarnOptedInByTest = true;
}

/**
 * P-003 — evaluate the coverage gate for one corpus recall.
 *
 * Everything expensive is already paid for elsewhere: the coverage numbers come
 * from the samples the twice-hourly alarm persists, read through
 * `loadCoverageSnapshotCached` (one indexed DISTINCT ON, TTL-memoised, never a
 * live COUNT scan). The sources asked about are `CORPUS_GATE_SOURCES`, pinned
 * by test against the leg's own list — see the note on that constant for why it
 * is a pinned copy rather than an import.
 *
 * FAIL-OPEN, and the direction is deliberate: a gate that cannot be evaluated
 * returns `null`, which renders the section exactly as it does today. The
 * alternative — treating an unreadable gate as grounds to suppress — would let
 * a PG hiccup silently delete a working feature, which is a strictly worse
 * failure than the one this item exists to fix.
 *
 * Note this is NOT the same as `unknown` COVERAGE. An unknown coverage sample
 * is evidence the gate HAS and acts on (it degrades, per the search-side rule
 * that absence of evidence is not health); `null` here means the gate never
 * ran at all.
 */
async function assessCorpusGate(
  workspaceId: string,
  res: {
    embedderAvailable: boolean;
    legs: import('@papercusp/search').SearchLegs | null;
    retrievalDepth: number;
  },
): Promise<CorpusGateDecision | null> {
  try {
    const { sql } = getOrgPg();
    const { loadCoverageSnapshotCached, assessSearchCoverage } = await import('../search/coverage-gate');
    const snapshot = await loadCoverageSnapshotCached(sql, workspaceId);
    return assessCorpusCoverageGate({
      coverage: assessSearchCoverage(CORPUS_GATE_SOURCES, snapshot),
      embedderAvailable: res.embedderAvailable,
      legs: res.legs,
      retrievalDepth: res.retrievalDepth,
    });
  } catch {
    return null;
  }
}

/**
 * Kick off the P-008 corpus leg. Everything it touches is behind a DYNAMIC
 * import on purpose: `corpus-recall-io` pulls `@papercusp/search` and the
 * search-source registry, and this module is loaded in tests against a partial
 * `@papercusp/db-org` stub (see the EPHEMERAL_SLUG_RE note at the top) — a
 * static import would drag that whole graph into every injection test.
 *
 * Never throws and never rejects: a corpus fault degrades to "no pointer
 * section", exactly like every other best-effort leg on this path.
 */
function startCorpusLeg(input: MemoryInjectionInput): Promise<CorpusLegResult | null> {
  const deadline = input.deadline!;
  return (async (): Promise<CorpusLegResult | null> => {
    try {
      const query = toRecallQuery(input.queryContext);
      const queryText = retrievalQueryText(query);
      if (!queryText.trim()) return null;

      const declaredWorkItemId =
        query.agentSignals?.workItem?.id?.trim() || input.session?.currentWorkItemId?.trim() || null;

      const { recallCorpusContext } = await import('./corpus-recall-io');
      const { CORPUS_BLOCK_HEADING } = await import('./corpus-recall');

      // Cross-moment dedup (migration 712): a warm session must not be handed
      // the same pointer every turn. The compaction `epoch` is resolved here
      // and shared with the mem0 ledger's meaning, so one epoch bump re-primes
      // memories AND pointers together.
      const sessionId = input.session?.sessionId?.trim() || null;
      let ambientExcludedRefs: ReadonlySet<string> | undefined;
      if (sessionId) {
        const fence = await deadline.run(() => getSessionBriefAmbientExcludedRefs(sessionId), 'ambient fence');
        // A missing/legacy row is an available empty fence. A read or parse
        // failure is different: fail closed so a blind session never receives
        // an unreviewed corpus pointer while its exclusion policy is unknown.
        if (!fence.available) {
          return emptyCorpusLeg(CORPUS_BLOCK_HEADING, false, 0, null, {
            outcome: 'failed',
            selected: 0,
            dropped: emptyCorpusDrops(),
            sessionDedup: 0,
            legs: null,
            retrievalDepth: 0,
            rerank: 'nothing-to-reorder',
          });
        }
        ambientExcludedRefs = fence.refs;
      }
      let epoch = 0;
      if (sessionId) {
        try {
          const { sql } = getOrgPg();
          epoch = input.session?.epoch ?? (await deadline.run(() => currentSessionEpoch(sql, sessionId), 'corpus epoch'));
        } catch {
          /* no epoch ⇒ no dedup, never a blocked leg */
        }
      }

      const res = await deadline.run(() => recallCorpusContext({
        signal: deadline.signal,
        queryText,
        workspaceId: input.workspaceId,
        harnessSlugs: input.harnessSlugs ?? [],
        declaredWorkItemId,
        ambientExcludedRefs,
        // ⚠ This value is the caller's coord ownerId (`su-xxxx…`), NOT a native
        // transcript session id — `session.sessionId` is the per-agent epoch-dedup
        // identity, as claim-port.ts spells out. It used to be passed as
        // `excludeSessionId` and compared against hits' native uuids, which are a
        // different identity space, so the self-session filter never once fired in
        // production (EI-19460887729945170). The corpus leg now resolves the owner's
        // whole session chain, which is the unit this always meant.
        excludeOwnerId: sessionId,
      }), 'corpus retrieval');
      // P-003: what is this retrieval ENTITLED to claim? Evaluated from the
      // coverage samples the alarm already persists — one indexed read,
      // TTL-memoised, fail-open to `unknown` (never to healthy).
      //
      // Evaluated even when an enabled search admitted nothing: an empty section under a
      // degraded index and an empty section under a healthy one are different
      // facts, and the observability path must be able to tell them apart.
      // Disabled retrieval made no claim about this index. Loading coverage
      // for it can consume the shared prompt budget after memory is rendered.
      const gate = res.outcome === 'disabled' ? null
        : await deadline.run(() => assessCorpusGate(input.workspaceId, res), 'corpus coverage');
      const baseTelemetry = {
        outcome: res.outcome ?? 'ok',
        selected: res.lines.length,
        dropped: countCorpusDrops(res.dropped),
        sessionDedup: 0,
        legs: (res.legs as Record<string, unknown> | null | undefined) ?? null,
        retrievalDepth: res.retrievalDepth ?? 0,
        rerank: res.rerank ?? 'nothing-to-reorder',
      } satisfies Pick<
        CorpusLegResult,
        'outcome' | 'selected' | 'dropped' | 'sessionDedup' | 'legs' | 'retrievalDepth' | 'rerank'
      >;

      // P-001: a leg that ran and admitted nothing still reports HOW it ran.
      // Returning bare `null` here erased the one fact that explains an empty
      // section — whether the semantic half was even available.
      if (res.lines.length === 0) {
        return emptyCorpusLeg(CORPUS_BLOCK_HEADING, res.embedderAvailable, res.candidateCount, gate, baseTelemetry);
      }

      // P-003 SIT OUT. The narrow case (see `assessCorpusCoverageGate`): the
      // vector index has no selectivity left AND the lexical leg contributed
      // nothing, so every line below came from a search whose result the query
      // did not influence. Suppressed rather than marked, because there is no
      // sound line here to protect — marking would leave the agent holding
      // arbitrary pointers plus a caveat it cannot act on.
      //
      // Returned as an EMPTY leg, not `null`: the leg ran, and the health path
      // must keep saying so. `gate` rides along, so a suppressed turn is
      // diagnosable rather than merely absent.
      if (gate?.verdict === 'sit-out') {
        return emptyCorpusLeg(CORPUS_BLOCK_HEADING, res.embedderAvailable, res.candidateCount, gate, baseTelemetry);
      }

      // Suppression runs POST-selection: a handle ref only exists once the
      // candidates are ranked and collapsed, so the alternative would be a
      // second search. The cost of this ordering is at most an under-full
      // section, never a wrong one.
      let lines = res.lines;
      let sessionDedup = 0;
      if (sessionId) {
        try {
          const { sql } = getOrgPg();
          const { alreadySurfacedRefs, stampSurfacedRefs } = await import('./corpus-surfaced-ledger');
          const seen = await deadline.run(() => alreadySurfacedRefs(
            sql,
            sessionId,
            epoch,
            lines.map((l) => l.handle.ref),
          ), 'corpus dedup');
          if (seen.size > 0) {
            const before = lines.length;
            lines = lines.filter((l) => !seen.has(l.handle.ref));
            sessionDedup = before - lines.length;
          }
          if (lines.length > 0 && !deadline.signal.aborted) {
            void stampSurfacedRefs(
              sql,
              sessionId,
              epoch,
              lines.map((l) => l.handle.ref),
              input.session?.port ?? 'injection',
            ).catch(() => undefined);
          }
        } catch {
          /* dedup is hygiene — a failure delivers a duplicate, never nothing */
        }
      }
      if (lines.length === 0) {
        return emptyCorpusLeg(CORPUS_BLOCK_HEADING, res.embedderAvailable, res.candidateCount, gate, {
          ...baseTelemetry,
          sessionDedup,
        });
      }

      return {
        heading: CORPUS_BLOCK_HEADING,
        lines: lines.map((l) => l.line),
        refs: lines.map((l) => l.handle.ref),
        embedderAvailable: res.embedderAvailable,
        candidateCount: res.candidateCount,
        gate,
        ...baseTelemetry,
        sessionDedup,
      };
    } catch {
      return null;
    }
  })();
}

/**
 * Compose the mem0 block with the corpus matched-excerpt section.
 *
 * Three cases, and the third is the one that matters: the corpus leg can have
 * something to say when the mem0 leg has NOTHING — a turn about a work-item
 * nobody wrote a memory for is precisely P-008's motivating case — so a null
 * memory block must not swallow it. With the flag off (or no excerpts) the
 * return value is byte-identical to the pre-P-008 block.
 */
/**
 * Outcomes where the corpus leg never got to say what it knows. A recall that
 * ends in one of these has LOST context; one that ends 'ok'/'no-query'/
 * 'disabled' searched fine and had nothing to say. Those are not the same
 * event and must not render the same way — telling an agent its context is
 * degraded when retrieval was simply empty trains it to ignore the marker.
 */
const CORPUS_DEGRADED_OUTCOMES: ReadonlySet<CorpusAdmissionStats['outcome']> = new Set(['timed-out', 'failed']);

function composeWithCorpus(memoryBlock: string | null, corpus: CorpusLegResult | null): string | null {
  if (!corpus || corpus.lines.length === 0) {
    // EI-16220: a leg that TIMED OUT or FAULTED produces no lines — so the
    // gate's own notice, which the block below attaches TO those lines, is
    // structurally unreachable on exactly the turns that lost the most. The
    // turn is then silently context-poor and the agent cannot tell, which is
    // how a confident-but-uninformed answer gets produced. Measured
    // 2026-09-05 over 7 days of harness_shared.memory_recall_stats: 11.77% of
    // this workspace's recalls (18,580 of 157,902) ended 'timed-out', every
    // one of them silently.
    //
    // Emitting one line converts an unknown-unknown into a known-degraded the
    // agent can act on, and `memory:search` is the recovery the rest of this
    // module already points at for budget-dropped entries.
    if (corpus && CORPUS_DEGRADED_OUTCOMES.has(corpus.outcome)) {
      const marker =
        `⚠ Memory retrieval was DEGRADED this turn (corpus leg: ${corpus.outcome}) — ` +
        'context you would normally have is MISSING, not absent. ' +
        'Recover it on demand with memory:search before relying on recall.';
      return memoryBlock ? `${memoryBlock}\n\n${marker}` : marker;
    }
    return memoryBlock;
  }
  // P-003: the degradation notice leads the section rather than trailing it.
  // A caveat after the pointers is read after they have already been believed —
  // and on a truncated block it may not be read at all, since this section sits
  // at the END of the injected block and is the first thing a char budget cuts.
  const notice = corpus.gate?.notice;
  const body = notice ? `${notice}\n\n${corpus.lines.join('\n')}` : corpus.lines.join('\n');
  if (!memoryBlock) return `## ${corpus.heading}\n\n${body}`;
  return `${memoryBlock}\n\n### ${corpus.heading}\n\n${body}`;
}

async function buildBlockInner(
  input: MemoryInjectionInput,
  mark: (label: string, ms: number) => void,
  corpusP: Promise<CorpusLegResult | null> = Promise.resolve(null),
  onRendered: (block: string | null) => void = () => {},
): Promise<string | null> {
  const deadline = input.deadline!;
  const rendered = (block: string | null) => { onRendered(block); return block; };
  // P-042 (F-J): normalize the accepted forms ONCE, here, so the three readers
  // below share one query object. P-044 (F-L) then splits what is ISSUED into
  // two texts, one per fusion leg: `queryText` (the user text) is embedded by
  // the cosine leg, and `lexText` (user text + the agent's identifiers) is
  // token-matched by the lexical leg. `lexText` is undefined when there are no
  // signals, which makes this path byte-identical to pre-P-044 for every caller
  // that carries none.
  //
  // The emptiness gate deliberately tests the EFFECTIVE retrieval text rather
  // than `userText` directly: today they are the same string (so this is
  // bit-identical to the pre-P-042 gate), and after P-044 it keeps asking the
  // question that actually matters — "is there anything to search with" — instead
  // of silently skipping a turn that has agent signals but no human utterance,
  // which is precisely the machine-injected turn Phase 11 exists to fix.
  const query = toRecallQuery(input.queryContext);
  const queryText = retrievalQueryText(query);
  const lexText = lexicalQueryText(query);
  if (!queryText.trim()) return rendered(null);

  const backend = getMemoryBackend();
  const earlyTotalLimit = input.limit ?? INJECTION_TOTAL_LIMIT;
  const earlyHarnessSlugs = (input.harnessSlugs ?? [])
    .filter((slug) => typeof slug === 'string' && slug.length > 0)
    .filter((slug) => !EPHEMERAL_SLUG_RE.test(slug))
    .slice(0, MAX_HARNESS_FANOUT);
  // An implicit hive set is resolved only after availability succeeds. On an
  // early degraded/unavailable exit no hive was queried, so omit that pool
  // rather than fabricating an empty one; explicit potSlugs remain truthful.
  const earlyPotSlugs = (input.potSlugs ?? [])
    .filter((slug) => typeof slug === 'string' && slug.length > 0)
    .slice(0, MAX_HARNESS_FANOUT);
  let earlyStatsSchedule: Promise<void> | null = null;
  const writeEarlyZeroRecallStats = (): Promise<void> => {
    if (earlyStatsSchedule) return earlyStatsSchedule;
    earlyStatsSchedule = (async () => {
      try {
        const { sql } = getOrgPg();
        const { recordRecallStats } = await import('./recall-stats');
        // Join only the SCHEDULING boundary. The insert itself stays
        // fire-and-forget, so telemetry can never delay or fail a turn.
        void recordRecallStats(sql, {
          surface: input.telemetrySurface ?? input.session?.port ?? 'injection',
          client: input.session?.client ?? null,
          workspaceId: input.workspaceId ?? null,
          potSlug: earlyHarnessSlugs[0] ?? null,
          scoreScale: backend.scoreScale ?? null,
          query: queryText,
          sessionId: input.session?.sessionId ?? null,
          pools: {
            ...(input.userId ? { user: { entries: [], limit: earlyTotalLimit, scopes: [input.userId] } } : {}),
            ...(earlyHarnessSlugs.length > 0
              ? {
                  harness: {
                    entries: [],
                    limit: earlyTotalLimit,
                    scopes: earlyHarnessSlugs.map((slug) => `harness:${slug}`),
                  },
                }
              : {}),
            ...(earlyPotSlugs.length > 0
              ? {
                  hive: {
                    entries: [],
                    limit: earlyTotalLimit,
                    scopes: earlyPotSlugs.map(hiveScopeKey),
                  },
                }
              : {}),
          },
          legs: null,
          admission: {
            returned: 0,
            admitted: 0,
            truncated: false,
            dropped: { pack: 0, feedback: 0, workspace: 0, dedup: 0, jev: 0, nearDuplicate: 0, budget: 0 },
            byLeg: { cosineOnly: 0, lexicalOnly: 0, both: 0 },
          },
        });
      } catch (error) {
        if (process.env.PAPERCUSP_P006_RECALL_STATS_STRICT === 'on') {
          throw new Error(
            `[P-006 recall-stats-strict] ${JSON.stringify({
              phase: 'early-zero',
              query: queryText,
              workspaceId: input.workspaceId ?? null,
            })}`,
            { cause: error },
          );
        }
        /* swallow — telemetry never blocks a turn */
      }
    })();
    return earlyStatsSchedule;
  };
  if (isMemoryDegraded()) {
    await writeEarlyZeroRecallStats();
    return null;
  }
  const tAvail = Date.now();
  try {
    const avail = await deadline.run(() => backend.available(), 'available()', MEMORY_INJECT_TIMEOUT_MS);
    if (!avail.ok) {
      await writeEarlyZeroRecallStats();
      return null;
    }
  } catch (err) {
    noteMemoryFailure(err);
    await writeEarlyZeroRecallStats();
    return null;
  } finally {
    mark('availableMs', Date.now() - tAvail);
  }

  const totalLimit = input.limit ?? INJECTION_TOTAL_LIMIT;

  // P-016: exclude ephemeral/benchmark harness scopes from production recall
  // injection so benchmark memories don't pollute the pre-turn prompt.
  let harnessSlugs = (input.harnessSlugs ?? [])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .filter((s) => !EPHEMERAL_SLUG_RE.test(s));
  if (harnessSlugs.length > MAX_HARNESS_FANOUT) {
    console.warn(
      `[memory-injection] harnessSlugs (${harnessSlugs.length}) exceeds MAX_HARNESS_FANOUT (${MAX_HARNESS_FANOUT}); slicing.`,
    );
    harnessSlugs = harnessSlugs.slice(0, MAX_HARNESS_FANOUT);
  }

  // Hive pools (knowledge-packs P-004): resolve the owning hives from the
  // harness slugs unless the caller pinned them. Best-effort — a registry
  // hiccup degrades to "no hive pull", never blocks the turn.
  let potSlugs: string[] = [];
  if (input.potSlugs !== undefined) {
    potSlugs = input.potSlugs.filter((s) => typeof s === 'string' && s.length > 0);
  } else if (harnessSlugs.length > 0) {
    const tHive = Date.now();
    try {
      potSlugs = await deadline.run(
        () => resolvePotSlugsForHarnesses(input.workspaceId, harnessSlugs),
        'hive-resolve',
        MEMORY_INJECT_TIMEOUT_MS,
      );
    } catch (err) {
      noteMemoryFailure(err);
      potSlugs = [];
    } finally {
      mark('hiveResolveMs', Date.now() - tHive);
    }
  }
  if (potSlugs.length > MAX_HARNESS_FANOUT) potSlugs = potSlugs.slice(0, MAX_HARNESS_FANOUT);

  // The store holds only STABLE facts now — user + harness + hive scopes
  // (D-005: the deprecated `workspace:`/`shared` scope is drained, so there is
  // no workspace pull).
  //
  // `ranked` holds the merged result in RELEVANCE order; the three arrays are
  // the same entries PARTITIONED by pool (same object references, so the
  // filters below shrink both views coherently). Attribution comes from each
  // entry's own scope, not from which call returned it.
  let ranked: InjectionMemoryEntry[] = [];
  let userResults: MemoryEntry[] = [];
  let harnessHits: Array<{ hit: MemoryEntry; slug: string }> = [];
  let hiveHits: Array<{ hit: MemoryEntry; slug: string }> = [];
  // P-002 / migration 758: what each retrieval LEG did on this call. Stays null
  // when the backend has no legs to report (a single-leg store), which is a
  // shape statement rather than a missing measurement — see RecallStatsInput.legs.
  let legStats: SearchLegStats | null = null;
  const userScopes = input.userId ? [input.userId] : [];
  const harnessScopes = harnessSlugs.map((slug) => `harness:${slug}`);
  const hiveScopes = potSlugs.map(hiveScopeKey);
  let statsSchedule: Promise<void> | null = null;
  const writeRecallStatsSnapshot = (
    entries: {
      user: readonly MemoryEntry[];
      harness: readonly MemoryEntry[];
      hive: readonly MemoryEntry[];
    },
    admission: RecallAdmissionStats,
  ): Promise<void> => {
    if (statsSchedule) return statsSchedule; // exactly one row per attempted recall
    statsSchedule = (async () => {
      try {
        // P-009: the corpus search was already started beside this mem0 leg.
        // The outer builder already joins this SAME promise before returning,
        // so joining it here adds no corpus latency. It does guarantee that a
        // completed build has actually invoked the writer rather than merely
        // leaving an untracked async continuation behind.
        const corpus = await corpusP.catch(() => null);
        admission.corpus = corpus
          ? {
              outcome: corpus.outcome,
              returned: corpus.candidateCount,
              selected: corpus.selected,
              admitted: corpus.lines.length,
              dropped: corpus.dropped,
              gate: corpus.gate
                ? {
                    verdict: corpus.gate.verdict,
                    reasons: [...corpus.gate.reasons],
                    dropped: corpus.gate.verdict === 'sit-out' ? corpus.selected : 0,
                  }
                : null,
              sessionDedup: corpus.sessionDedup,
              embedderAvailable: corpus.embedderAvailable,
              legs: corpus.legs,
              retrievalDepth: corpus.retrievalDepth,
              rerank: corpus.rerank,
            }
          : null;
        const { sql } = getOrgPg();
        const { recordRecallStats } = await import('./recall-stats');
        // Join only scheduling; the queued insert remains fire-and-forget.
        void recordRecallStats(sql, {
          surface: input.telemetrySurface ?? input.session?.port ?? 'injection',
          client: input.session?.client ?? null,
          workspaceId: input.workspaceId ?? null,
          potSlug: harnessSlugs[0] ?? null,
          scoreScale: backend.scoreScale ?? null,
          query: queryText,
          sessionId: input.session?.sessionId ?? null,
          pools: {
            ...(userScopes.length > 0
              ? { user: { entries: entries.user, limit: totalLimit, scopes: userScopes } }
              : {}),
            ...(harnessScopes.length > 0
              ? { harness: { entries: entries.harness, limit: totalLimit, scopes: harnessScopes } }
              : {}),
            ...(hiveScopes.length > 0
              ? { hive: { entries: entries.hive, limit: totalLimit, scopes: hiveScopes } }
              : {}),
          },
          legs: legStats,
          admission,
        });
      } catch (error) {
        if (process.env.PAPERCUSP_P006_RECALL_STATS_STRICT === 'on') {
          throw new Error(
            `[P-006 recall-stats-strict] ${JSON.stringify({
              phase: 'snapshot',
              query: queryText,
              workspaceId: input.workspaceId ?? null,
            })}`,
            { cause: error },
          );
        }
        /* swallow — telemetry never blocks a turn */
      }
    })();
    return statsSchedule;
  };
  try {
    // P-002: read the admission contract from the ONE exported constructor the
    // recurrence guard also calls, so the guard cannot drift from this path.
    // F-B (D-010): `fusionMode` makes the limit a CEILING here, not a target.
    const { minScore, minLexScore, fusionMode } = pushSearchFloors();
    // F-D (P-034, D-014): the redundancy penalty — see injectDiversityLambda().
    const diversityLambda = injectDiversityLambda();

    const tSearch = Date.now();

    // F-C (P-033, D-011) — ONE search over the UNION of the pools, replacing the
    // three quota'd per-pool searches.
    //
    // This is not merely a consolidation: it is what makes a quota-free block
    // POSSIBLE. Removing the per-pool reservations needs some rule for who gets
    // the block, and the intended rule is relevance — but the score that comes
    // back cannot express relevance ACROSS calls. hybrid-fusion.ts computes RRF
    // (`1/(k+cosRank) + lexWeight/(k+lexRank)`), a function of RANK WITHIN ONE
    // CALL: two pools' rank-1 hits both score ~0.0328 however (ir)relevant they
    // actually are. Worse, the pools weren't even on the same COSINE scale — the
    // user pool took mem0's entity-BOOSTED single-scope path while harness/hive
    // took the EI-12962 batched plain-cosine path. So with separate calls there
    // was nothing sound to sort on, and any cross-pool ordering was a fixed
    // priority — a quota under another name.
    //
    // A multi-scope search fixes that at the root (mem0-backend.ts): it embeds
    // ONCE and fans out per-scope pgvector queries with that SAME vector, then
    // merges and sorts by cosine desc — ONE globally-comparable ranking. fuse()
    // then computes RRF over that global order and HybridBackend slices to
    // `limit` GLOBALLY. Every pool now competes for every slot.
    //
    // ⚠ `limit` here is a TOTAL, not per-pool. SearchOptions' own doc says limit
    // is per-scope and the merged result is "NOT globally truncated" — true of
    // Mem0Backend, NOT of HybridBackend (which slices the fused list). Production
    // is hybrid, so on this path it is one ceiling.
    //
    // The EI-12992 caller-side shared embed is GONE, not lost: the backend does
    // that single embed internally for a multi-scope pull, so the plumbing here
    // was redundant. This also drops the user pool's separate embed round-trip
    // (~200-450ms) off the critical path. Accepted cost (D-011): the user pool
    // joins the batched path and forgoes mem0's entity-graph boost when other
    // pools are in play — the boost is precisely what made its scores
    // incomparable, so keeping it is incompatible with one ranked block. A
    // user-ONLY injection is a single scope and still keeps it.
    const scopes = [
      ...(input.userId ? [input.userId] : []),
      ...harnessSlugs.map((slug) => `harness:${slug}`),
      ...potSlugs.map(hiveScopeKey),
    ];
    // P-007 / D-021: the wearer (the su owner id carried as the session id) may
    // recall its applied exact-version pack rows; fails closed to none.
    const wearer = input.session?.sessionId?.trim() || null;
    let pinnedPackResources: ReadonlySet<string> = new Set();
    if (wearer && scopes.length > 0) {
      try {
        pinnedPackResources = await deadline.run(
          () => wearerPackageResourcesOrEmpty(getOrgPg().sql, { workspaceId: input.workspaceId, ownerId: wearer }),
          'package eligibility', MEMORY_INJECT_TIMEOUT_MS);
      } catch {
        pinnedPackResources = new Set();
      }
    }
    const doSearch = async (): Promise<MemoryEntry[]> =>
      scopes.length === 0
        ? []
        : backend.search(queryText, {
            signal: deadline.signal,
            scope: scopes,
            limit: totalLimit,
            ...(input.includeSuperseded ? { includeSuperseded: true } : {}),
            ...packageRecallEligibility(pinnedPackResources),
            minScore,
            minLexScore,
            fusionMode,
            ...(input.overlapGatedLexical ? { overlapGatedLexical: true } : {}),
            // P-002 / migration 758: capture what each LEG did. Assigning to the
            // outer `legStats` is safe against the fan-out concern the option's
            // doc raises — this is ONE search call, not a per-scope loop, so
            // there is exactly one invocation to receive.
            onLegStats: (s) => {
              legStats = s;
            },
            // P-044 (F-L): the identifier-bearing text goes to the LEXICAL leg
            // only. Omitted when there are no agent signals, so the two legs
            // then share one query exactly as before.
            ...(lexText !== undefined ? { lexicalQuery: lexText } : {}),
            ...(diversityLambda !== undefined ? { diversify: { lambda: diversityLambda } } : {}),
          });

    ranked = await deadline.run(doSearch, 'search', MEMORY_INJECT_TIMEOUT_MS).finally(() => {
      const searchMs = Date.now() - tSearch;
      mark('searchMs', searchMs);
      if (searchMs > SLOW_INJECTION_LOG_MS) {
        console.log(`[memory-injection] search-detail scopes=${scopes.length} searchMs=${searchMs}`);
      }
    });
    // D-021: exact-version dedupe, pinned boost and provenance, before the
    // pool partition below shares these entries by reference.
    ranked = shapeIdentityPackageHits(ranked, pinnedPackResources);
    const tStaleness = Date.now();
    try {
      ranked = await deadline.run(() => applyStoredMemoryStaleness(ranked, input.workspaceId), 'staleness');
    } finally {
      mark('stalenessMs', Date.now() - tStaleness);
    }

    // Partition the ONE ranked result by pool, by each entry's own scope. The
    // entries are shared by reference with `ranked`, so the filters below shrink
    // both views together and the relevance order is recoverable at render time.
    const hiveScopeSet = new Set(potSlugs.map(hiveScopeKey));
    for (const hit of ranked) {
      const scope = hit.scope ?? '';
      if (hiveScopeSet.has(scope)) {
        hiveHits.push({ hit, slug: potSlugFromScope(scope) ?? scope });
      } else if (scope.startsWith('harness:')) {
        harnessHits.push({ hit, slug: scope.slice('harness:'.length) });
      } else {
        // The per-owner pool (input.userId). An unrecognized scope also lands
        // here rather than being dropped — same posture as before F-C, where
        // the user pool was whatever the user-scoped call returned.
        userResults.push(hit);
      }
    }
  } catch (err) {
    noteMemoryFailure(err);
    if (!(err instanceof MemoryTimeoutError) && process.env.NODE_ENV !== 'test') {
      console.warn('[memory-injection] search failed:', (err as Error).message);
    }
    // The main admission funnel below cannot be built after a failed search,
    // but the failure is still a recall outcome. Record its empty pools once;
    // otherwise the telemetry table systematically erases precisely the slow
    // or failed searches it is meant to reveal.
    await writeRecallStatsSnapshot(
      { user: [], harness: [], hive: [] },
      {
        returned: 0,
        admitted: 0,
        truncated: false,
        dropped: { pack: 0, feedback: 0, workspace: 0, dedup: 0, jev: 0, nearDuplicate: 0, budget: 0 },
        byLeg: { cosineOnly: 0, lexicalOnly: 0, both: 0 },
      },
    );
    return null;
  }

  // Recall telemetry (EI-366 / migration 240): record what the index returned
  // for this turn — zero hits INCLUDED (the zero-hit-rate is the signal) —
  // before any policy filtering below. Fire-and-forget.
  //
  // P-026 / migration 703: record it PER POOL. This block is the only place the
  // three pools still exist separately — everything downstream is concatenated —
  // so a flat hit_count recorded here is information destroyed at the one point
  // it was still available. hit_count=6 cannot distinguish "6 user + 0 harness"
  // from "3 user + 3 harness", which is precisely how a harness pool that
  // returned zero on every call (orphaned by an unmigrated slug rename) hid
  // behind a surface reporting a 0.0% zero-hit rate. Each pool also carries the
  // budget and the scope keys IN EFFECT FOR THIS CALL, so saturation stays
  // computable after the constants are retuned and a pool queried under a slug
  // nothing writes to is distinguishable from a pool with nothing relevant.
  //
  // ⚠ F-C (P-033, D-011) CHANGED WHAT THE STORED `limit` MEANS. The per-pool
  // quotas are gone, so every pool records the SHARED total ceiling. D-007's
  // contract still holds — read the row's OWN stored limit, never today's
  // constants — but a pool at `limit` no longer means "it hit its private
  // quota"; it means THIS POOL ALONE FILLED THE ENTIRE BLOCK. Any saturation
  // measurement (P-038) must read it that way.
  //
  // ⚠ P-002 / migration 758 CHANGED WHEN THIS ROW IS WRITTEN, and the reason is
  // the whole point of the item. The write used to happen HERE, inline, before a
  // single filter had run — so the row could only ever say what the INDEX
  // returned. Six stages sit between that and what the agent actually receives
  // (packs, feedback, workspace scope, dedup, near-duplicate collapse, budget),
  // and NOTHING recorded the other end: a recall logged as 12 hits that
  // delivered 2 lines was indistinguishable from one that delivered 12.
  //
  // So the row is now assembled here and WRITTEN IN A `finally` at the end of
  // the function. Two properties are preserved exactly, and both are load-bearing:
  //   * EXACTLY ONE row per recall, on EVERY exit path including the several
  //     `return null`s below — a `finally` plus the `written` latch, not a call
  //     at each return, because a new early return added later would silently
  //     stop recording rather than fail.
  //   * ZERO HITS ARE STILL RECORDED. The zero-hit rate is the signal this table
  //     was built for (EI-366); dropping empty recalls would make the index look
  //     healthiest exactly when it is worst.
  // Fire-and-forget as before — telemetry never blocks or fails a turn.
  const funnel: RecallAdmissionStats = {
    returned: userResults.length + harnessHits.length + hiveHits.length,
    admitted: 0,
    truncated: false,
    dropped: { pack: 0, feedback: 0, workspace: 0, dedup: 0, jev: 0, nearDuplicate: 0, budget: 0 },
    byLeg: { cosineOnly: 0, lexicalOnly: 0, both: 0 },
  };
  /** Live count across the three pools — the funnel's per-stage deltas read off this. */
  const surviving = (): number => userResults.length + harnessHits.length + hiveHits.length;
  // ⚠ SNAPSHOT THE PRE-FILTER POOLS. The three pool variables are REASSIGNED by
  // the filters below, so a deferred write that read them live would silently
  // redefine `hit_count`, `scores` and `pools` from "what the index returned" to
  // "what survived" — changing the meaning of three columns under every
  // historical comparison without touching a single query. The funnel is the NEW
  // measurement; the old columns must keep the meaning they were built with.
  // Cheap: these hold existing references, nothing is cloned.
  const preFilterUser = [...userResults];
  const preFilterHarness = harnessHits.map(({ hit }) => hit);
  const preFilterHive = hiveHits.map(({ hit }) => hit);
  /**
   * Entries whose line actually reached the block — the `byLeg` input. Declared
   * out here so the deferred writer closes over it; it stays empty on every
   * early-return path, which is the honest reading (nothing was delivered).
   */
  const admittedEntries: MemoryEntry[] = [];
  const writeRecallStats = (): Promise<void> => {
    return writeRecallStatsSnapshot({ user: preFilterUser, harness: preFilterHarness, hive: preFilterHive }, funnel);
  };

  try {
    if (userResults.length + harnessHits.length + hiveHits.length === 0) return rendered(null);

    // knowledge-packs P-009: a DISABLED pack's rows stay stored but stop being
    // recalled. One settings read per hive in scope (usually 1); best-effort —
    // a settings hiccup means no filtering, never a blocked turn.
    {
      const tPack = Date.now();
      try {
        if (hiveHits.length > 0) {
          const before = surviving();
          try {
            const { disabledPacksFor } = await import('../knowledge-packs/manage');
            const slugs = [...new Set(hiveHits.map(({ slug }) => slug))];
            const disabledBySlug = new Map(
              await deadline.run(() => Promise.all(
                slugs.map(async (slug) => [slug, new Set(await deadline.run(() => disabledPacksFor(input.workspaceId, slug), 'pack lookup'))] as const),
              ), 'packs'),
            );
            hiveHits = hiveHits.filter(({ hit, slug }) => {
              const m = hit.metadata ?? {};
              const packId = m.source === 'pack' && typeof m.pack_id === 'string' ? m.pack_id : undefined;
              return !(packId && disabledBySlug.get(slug)?.has(packId));
            });
          } catch {
            /* best-effort — never load-bearing */
          }
          funnel.dropped.pack = before - surviving();
        }
      } finally {
        mark('packMs', Date.now() - tPack);
      }
    }
    if (userResults.length + harnessHits.length + hiveHits.length === 0) return rendered(null);

    // memory_feedback consumer (EI-366 / consume-edges P-031): the push path
    // DROPS anything the user deleted — tombstoned ids (the lexical projection
    // has no per-delete reconciliation, so deleted facts can ghost back through
    // that leg) and re-extractions of deleted content. Injecting content the
    // user deleted is worse than a missed recall; memory:search still finds it
    // on demand (demoted, not hidden). Best-effort like the dedup below.
    {
      const tFeedback = Date.now();
      const before = surviving();
      try {
        const { sql } = getOrgPg();
        const { loadFeedbackSignals, isFeedbackSuppressed } = await import('./feedback-rerank');
        const signals = await deadline.run(() => loadFeedbackSignals(sql), 'feedback');
        if (signals.deletedIds.size > 0 || signals.deletedTexts.size > 0) {
          userResults = userResults.filter((h) => !isFeedbackSuppressed(h, signals));
          harnessHits = harnessHits.filter(({ hit }) => !isFeedbackSuppressed(hit, signals));
          hiveHits = hiveHits.filter(({ hit }) => !isFeedbackSuppressed(hit, signals));
        }
      } catch {
        /* hygiene, never load-bearing */
      } finally {
        mark('feedbackMs', Date.now() - tFeedback);
      }
      funnel.dropped.feedback = before - surviving();
    }

    // data-scoping-audit P-006 / D-004 / D-012 (dark cutover): workspace-scope the per-owner
    // USER pool — drop a `project` hit explicitly tagged with a DIFFERENT workspace; keep
    // owner-tier (user/feedback/reference) + legacy NULL-workspace rows. The harness/hive
    // pools are already correctly scoped. Conservative + NULL-safe; OFF = today's behavior.
    {
      const tWorkspace = Date.now();
      try {
        if (userResults.length > 0 && (await deadline.run(() => isMemoryWorkspaceScopedRecallOn(), 'workspace policy'))) {
          const before = surviving();
          userResults = userResults.filter((h) => keepUserPoolHitForWorkspace(h, input.workspaceId));
          funnel.dropped.workspace = before - surviving();
        }
      } finally {
        mark('workspaceMs', Date.now() - tWorkspace);
      }
    }
    if (userResults.length + harnessHits.length + hiveHits.length === 0) return rendered(null);

    // D-006 — the pre-turn dedup: drop any memory surfaced within the recent
    // watermark window so a stable fact is delivered ONCE, not re-injected
    // turn-over-turn. Best-effort: a query failure returns an empty set (no
    // filtering), so the injection degrades to its prior behavior, never breaks.
    const candidateIds = [
      ...userResults.map((h) => h.id),
      ...harnessHits.map(({ hit }) => hit.id),
      ...hiveHits.map(({ hit }) => hit.id),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    // (ids are always present on neutral entries; the filter guards legacy/odd rows)
    // P-002: a warm session (input.session) dedups against its session-epoch
    // ledger; the chat path keeps the wall-clock watermark. Same best-effort
    // posture either way: a failed read = no filtering, never a broken inject.
    let sessionEpoch: number | null = null;
    {
      const tDedup = Date.now();
      try {
        if (candidateIds.length > 0) {
          try {
            const { sql } = getOrgPg();
            let suppressed: Set<string>;
            if (input.session?.sessionId) {
              const session = input.session;
              sessionEpoch = session.epoch ?? (await deadline.run(() => currentSessionEpoch(sql, session.sessionId), 'memory epoch'));
              suppressed = await deadline.run(() => alreadySurfacedIds(sql, session.sessionId, sessionEpoch!, candidateIds), 'memory dedup');
            } else {
              suppressed = await deadline.run(() => recentlySurfacedIds(sql, candidateIds, reinjectWindowMs()), 'memory dedup');
            }
            if (suppressed.size > 0) {
              const before = surviving();
              userResults = userResults.filter((h) => !(h.id && suppressed.has(h.id)));
              harnessHits = harnessHits.filter(({ hit }) => !(hit.id && suppressed.has(hit.id)));
              hiveHits = hiveHits.filter(({ hit }) => !(hit.id && suppressed.has(hit.id)));
              funnel.dropped.dedup = before - surviving();
            }
          } catch {
            /* swallow — dedup is hygiene, never load-bearing */
          }
        }
      } finally {
        mark('dedupMs', Date.now() - tDedup);
      }
    }
    if (userResults.length + harnessHits.length + hiveHits.length === 0) return rendered(null);

    // Jev, the owner's opt-in filter (plan jev-decision-model-integration-2026-09-29;
    // the switch is jev-settings.ts, D-008; the operating point is D-013). Effective
    // Off (the default, and whenever no key is stored) makes zero Jev calls, so this
    // block is byte-identical to the pre-Jev system (D-009). Log only fires one
    // request and does not wait for it; the decision ledger records every P(yes).
    // On waits under the client's hard bound and drops what Jev judges irrelevant;
    // any inconclusive answer keeps every candidate (fail open, D-002). Jev only
    // filters: it never reorders and never adds (D-001).
    {
      const tJev = Date.now();
      try {
        const pooled: MemoryEntry[] = [
          ...userResults,
          ...harnessHits.map(({ hit }) => hit),
          ...hiveHits.map(({ hit }) => hit),
        ];
        // What Jev may use: the smaller of what is left of the client's wall and of
        // this build's own deadline, which ends first on turn-start. A wait sized
        // from the wall alone was cut off by the deadline (jevMemoryBudgetMs).
        // The wall counts only while someone still waits on this build. A
        // stale-while-revalidate rebuild answers nobody, yet sized from the wall it
        // skipped Jev with budgets down to -2,175 ms while its own deadline still
        // had time (WI-10004485 step D, staging, 2026-10-01).
        const jevNow = Date.now();
        const deadlineLeftMs = deadline.remainingMs();
        const callerWaiting = input.callerWaiting?.();
        const wallApplies = input.respondByMs !== undefined && callerWaiting !== false;
        const budgetMs = jevMemoryBudgetMs(jevNow, {
          ...(wallApplies ? { respondByMs: input.respondByMs } : {}),
          deadlineRemainingMs: deadlineLeftMs,
        });
        const verdict = await deadline.run(() => runJevMemoryGate({
          workspaceId: input.workspaceId,
          message: queryText,
          candidates: pooled.map((hit) => ({ id: hit.id, text: hit.text })),
          // On waits only where the port's wall can afford it (JEV_MEMORY_NO_WAIT_PORTS),
          // and only for what is left (jevMemoryWaitMs).
          ...(input.session?.port ? { port: input.session.port } : {}),
          ...(budgetMs !== undefined ? { budgetMs } : {}),
          // The same label memory_recall_stats.surface records for this recall.
          surface: input.telemetrySurface ?? input.session?.port ?? 'injection',
        }), 'admission');
        const jevEntry = jevFunnelEntry(verdict, budgetMs, {
          ...(callerWaiting !== undefined ? { callerWaiting } : {}),
          ...(input.respondByMs !== undefined ? { wallLeftMs: input.respondByMs - jevNow } : {}),
          deadlineLeftMs,
        });
        if (jevEntry) funnel.jev = jevEntry;
        if (verdict.effective === 'on' && verdict.outcome === 'answered') {
          const drop = new Set(pooled.filter((_, i) => verdict.keep[i] === false));
          if (drop.size > 0) {
            const before = surviving();
            userResults = userResults.filter((h) => !drop.has(h));
            harnessHits = harnessHits.filter(({ hit }) => !drop.has(hit));
            hiveHits = hiveHits.filter(({ hit }) => !drop.has(hit));
            funnel.dropped.jev = before - surviving();
          }
        }
      } catch {
        /* never load-bearing: a Jev fault injects exactly today's set */
      } finally {
        mark('jevMs', Date.now() - tJev);
      }
    }
    if (userResults.length + harnessHits.length + hiveHits.length === 0) return rendered(null);

    // Two-tier marker (self-learning-frontier P-022 / FB-08, D-006): with the
    // transfer harness armed, probationary entries are visibly marked — STILL
    // injected (admission is free); the marker just shows the trust level until
    // a student-transfer test promotes them. Flag dark (the D-001 default) ⇒
    // byte-identical output. Best-effort: a flags hiccup means no markers.
    let tierMarkers = false;
    const tTierFlag = Date.now();
    try {
      const { FLAGS } = await import('@papercusp/flags');
      const { getFlag } = await import('@papercusp/flags/server');
      tierMarkers = await deadline.run(() => getFlag(FLAGS.TRANSFER_HARNESS, 'memory-injection'), 'tier policy');
    } catch {
      /* never load-bearing */
    } finally {
      mark('tierFlagMs', Date.now() - tTierFlag);
    }

    const tRender = Date.now();
    const fmtScope = (entry: MemoryEntry, slug?: string): string => {
      const kind = entry.kind ?? 'unknown';
      const tier = tierMarkers && memoryTierOf(entry) === 'probationary' ? ' · probationary' : '';
      if (slug) return `[${kind}${tier} @ ${slug}]`;
      return `[${kind}${tier}]`;
    };

    // Phase 5 P-020: surface memory_id alongside each entry so the agent
    // can call memory:forget when a user correction contradicts an
    // injected memory. Suffix-style to keep the existing `[kind] <text>`
    // format backward-compatible.
    const fmtId = (h: { id?: string }): string => (typeof h.id === 'string' && h.id ? ` (id=${h.id})` : '');

    // Assembly under the P-011 budget, in RELEVANCE order — F-C (P-033, D-011).
    //
    // This used to render strictly by POOL (user → harness → hive-organic →
    // hive-pack), which mattered because the char budget truncates in render
    // order: the render order IS the real allocator. That made it a second quota
    // on top of the per-pool item quotas, and the worse of the two — with the item
    // quotas gone, a pool-ordered render would let the user pool (the 487-memory
    // CROSS-PROJECT one P-033 blames for the oddsmith contamination) consume the
    // whole block before the harness pool rendered a line. So the two had to move
    // together: the single ranked search now supplies one comparable ordering, and
    // the budget cut follows it.
    //
    // ONE exception is PRESERVED: hive-PACK rows still yield first. Packs are the
    // most numerous and least turn-specific, and that is a trust-tier judgment
    // recorded before this plan — independent of pool quotas, so F-C does not
    // overturn it.
    const isPackHit = (hit: MemoryEntry): boolean =>
      hit.metadata?.source === 'pack' && typeof hit.metadata?.pack_id === 'string';

    const budget = input.budgetChars && input.budgetChars > 0 ? input.budgetChars : injectBudgetChars();
    let spent = 0;
    const lines: string[] = [];
    const surfacedIds: string[] = [];
    const admit = (line: string, id?: string): boolean => {
      // The `&& lines.length > 0` is the ALWAYS-EMIT-ONE-ROW contract, and it is
      // load-bearing across modules — do not "tighten" it again without reading
      // mid-turn-context.ts:174-190, which documents this exact clause and depends on it:
      // a caller with a small budget must get SOMETHING rather than null.
      //
      // WI-6870 removed it, reasoning that MAX_ENTRY_CHARS (above) already keeps any single
      // line well under a normal budget so strict enforcement could no longer starve the
      // other candidates (measured: one 4,901-char memory against a 4,000 budget). That is
      // true for a NORMAL budget and false for a small one: the mid-turn endpoint passes
      // MID_TURN_BUDGET_CHARS = 350, so a line clamped to 900 STILL overflows and the first
      // row was rejected — buildMemoryContextBlock returned nothing and mid-turn context
      // injection silently delivered NOTHING (WI-7163; caught by the P-018 acceptance
      // replay, which red-pinned the green gate).
      //
      // MAX_ENTRY_CHARS is the real fix for WI-6870's starvation case and is retained; this
      // exemption is bounded by it, so the 4,901-char scenario cannot recur through here.
      // Small-budget callers clamp themselves — see mid-turn-context.ts `clampToBudget()`,
      // which truncates keeping the HEAD precisely so scope + id + lede survive.
      // NOTE: the corpus leg (corpus-recall.ts) is deliberately STRICT and stays that way —
      // its no-first-entry-exemption behavior is pinned by corpus-recall.test.ts (WI-6870).
      if (spent + line.length > budget && lines.length > 0) return false;
      lines.push(line);
      spent += line.length;
      if (id) surfacedIds.push(id);
      return true;
    };
    // Walk the ONE ranked result in relevance order, keeping only entries that
    // survived the filters above (identity, not id — the filters preserve object
    // references, and not every legacy row carries an id). Each pool keeps its own
    // label: the hive pool is tagged `@ hive:<slug>` so an agent can tell
    // shared-Hive knowledge from its harness's own pool.
    const survivingHive = new Map(hiveHits.map(({ hit, slug }) => [hit, slug]));
    const survivingHarness = new Map(harnessHits.map(({ hit, slug }) => [hit, slug]));
    const survivingUser = new Set(userResults);
    // P-002: each row carries its ENTRY so an ADMITTED line can be attributed back
    // to the leg that produced it (`MemoryEntry.retrieval`). Attribution has to
    // happen over the admitted set, not the candidate set — a leg that offers
    // candidates and never lands one is contributing nothing, and that is exactly
    // what a pre-filter count cannot show.
    type RenderRow = { line: string; id?: string; text: string; entry: MemoryEntry };
    const mainRows: RenderRow[] = [];
    const packRows: RenderRow[] = [];
    for (const hit of ranked) {
      const row = (label?: string): RenderRow => {
        const fullText = hit.text ?? '';
        const displayText = hit.injectionText ?? fullText;
        const annotatedText = annotateSupersededMemory(displayText, hit.metadata);
        // WI-6870: clamp the RENDERED text to MAX_ENTRY_CHARS so a single oversized memory
        // can't blow the whole budget by itself. Dedup below still compares the FULL text
        // (not this clamped copy), so two distinct long entries that happen to share a
        // >900-char prefix are never mistaken for near-duplicates.
        const boundedText =
          annotatedText.length > MAX_ENTRY_CHARS
            ? `${annotatedText.slice(0, MAX_ENTRY_CHARS)}… (truncated — memory:search for the rest)`
            : annotatedText;
        return {
          line: `- ${fmtScope(hit, label)}${fmtId(hit)} ${boundedText}`,
          id: hit.id,
          text: fullText,
          entry: hit,
        };
      };
      if (survivingHive.has(hit)) {
        const slug = survivingHive.get(hit)!;
        (isPackHit(hit) ? packRows : mainRows).push(row(`hive:${slug}`));
      } else if (survivingHarness.has(hit)) {
        // D-021: identity-package rows keep the pack trust tier in any pool.
        (isIdentityPackageHit(hit) ? packRows : mainRows).push(row(survivingHarness.get(hit)!));
      } else if (survivingUser.has(hit)) {
        mainRows.push(row());
      }
    }
    deadline.signal.throwIfAborted();
    const renderedRows = [...mainRows, ...packRows];
    // P-008 (WI-4538): collapse near-duplicate memories (the SAME fact stored under multiple ids
    // — the id-based dedups above can't see it) BEFORE the budget, so a dupe never consumes a
    // slot a distinct fact needed. Order is preserved, so post-F-C the highest-RELEVANCE copy of
    // each cluster survives (it was the highest-priority-POOL copy before D-011).
    const { kept: dedupedRendered } = collapseNearDuplicates(renderedRows, (r) => r.text);
    funnel.dropped.nearDuplicate = renderedRows.length - dedupedRendered.length;
    let truncated = false;
    for (const { line, id, entry } of dedupedRendered) {
      // WI-6870: skip-and-continue instead of a hard break. A `break` here discarded every
      // remaining (lower-ranked but possibly SMALLER) entry once ONE entry didn't fit —
      // measured mean 849 chars (21%) of the budget left on the table per turn, worst case
      // 2,675 (67%). The result stays in relevance order (admitted entries are pushed in
      // `dedupedRendered`'s rank order); this only lets a later, smaller entry fill space a
      // single earlier oversized one would otherwise have wasted.
      if (!admit(line, id)) {
        truncated = true;
        funnel.dropped.budget += 1;
        continue;
      }
      admittedEntries.push(entry);
    }
    // P-002: the delivered end of the funnel. `admitted` counts CONTENT lines, so
    // it is taken from admittedEntries rather than `lines` — the withheld-notice
    // row appended below is a marker, not a recalled memory, and counting it would
    // report a block that delivered nothing as having delivered one.
    funnel.admitted = admittedEntries.length;
    funnel.truncated = truncated;
    // D-081: `truncated` alone cannot say WHICH constraint bound — an exhausted
    // budget and a remainder of individually-oversized entries both set it, and
    // they call for opposite fixes. Recording what was actually spent against the
    // budget it was spent from makes utilization readable, which is the only way
    // to tell "raise the budget" from "the MAX_ENTRY_CHARS clamp is the ceiling".
    // Set HERE, beside the other delivered-end fields and before the
    // `lines.length === 0` early return below, so a block that admitted nothing
    // still records spent: 0 rather than going silently absent.
    funnel.spent = spent;
    funnel.budgetChars = budget;
    // Attributed on the STATIC path, deliberately — never inside the deferred
    // writer, whose failures are swallowed (see `admittedByLeg`'s note).
    funnel.byLeg = admittedByLeg(admittedEntries);
    mark('renderMs', Date.now() - tRender);
    if (lines.length === 0) return rendered(null);
    if (truncated) {
      lines.push(
        '- (more learnings withheld this turn — the memory budget is full; memory:search pulls the rest on demand)',
      );
    }

    // Phase 5 P-021: stamp last_surfaced_at on every memory we surfaced — this is
    // ALSO the dedup watermark the next turn reads. Fire-and-forget: bumpLastSurfacedSql
    // is fully defensive and its outcome doesn't affect the block we return.
    // (Only ACTUALLY-injected ids are stamped — a budget-dropped memory must not
    // be dedup-suppressed next turn.)
    if (surfacedIds.length > 0) {
      const session = input.session;
      const epochForStamp = sessionEpoch;
      void (async () => {
        try {
          const { sql } = getOrgPg();
          // last_surfaced_at stays stamped for EVERY path — it feeds the
          // Layer-3 "recently used" pickers, not just the chat dedup.
          await bumpLastSurfacedSql(sql, surfacedIds);
          // P-002: warm sessions ALSO stamp the port-agnostic epoch ledger so
          // every later injection moment of this epoch dedups against it.
          if (session?.sessionId) {
            await stampSurfaced(
              sql,
              session.sessionId,
              epochForStamp ?? (await currentSessionEpoch(sql, session.sessionId)),
              surfacedIds,
              session.port ?? 'injection',
            );
          }
        } catch {
          /* swallow — never load-bearing */
        }
      })();
    }

    const heading = input.heading ?? 'Operator memory (relevant entries)';
    return rendered(`## ${heading}\n\n${lines.join('\n')}`);
  } finally {
    // ONE row per recall, on EVERY exit path — the several `return null`s above,
    // the delivered-block return, and any throw. A `finally` rather than a call
    // at each return so that an early return added later cannot silently stop
    // recording; the `statsWritten` latch keeps it to exactly one.
    await writeRecallStats();
  }
}

/**
 * Convenience: pull the last N user-turn contents joined with newlines.
 * Matches the contract operator-converse already uses (default N=3).
 */
export function lastUserContext(messages: ReadonlyArray<{ role: string; content: string }>, count = 3): string {
  return messages
    .filter((m) => m.role === 'user')
    .slice(-count)
    .map((m) => m.content)
    .join('\n');
}
