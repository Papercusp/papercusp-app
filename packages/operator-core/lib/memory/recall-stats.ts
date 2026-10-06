/**
 * memory_recall_stats writer + health aggregate (EI-366 / consume-edges
 * P-031, migration 240).
 *
 * Records what each memory recall actually returned, so the Learning tab
 * can tell "no relevant memory" (healthy zero) from "index degraded"
 * (zero-hit-rate spiking, top-score distribution collapsing, fragments
 * leaking back in). The surfaces that write here: the memory:search tool
 * (pull), the generic pre-turn injection helper (push), and — per
 * memory-delivery-unification-2026-07-12 P-005 — each distinct injection PORT
 * (D-006), so per-entry-point recall quality is measurable separately (an
 * initialize prime that returns junk is a different regression from a
 * turn-start delta that does). The surface column is free-text (no CHECK), so
 * adding a port needs no migration — just a member here.
 *
 * Writes are FIRE-AND-FORGET — recall telemetry must never slow or fail a
 * turn. Callers invoke `recordRecallStats` without awaiting; all failures
 * are swallowed (one warn per process).
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { parseEnvelope, payloadSha256 } from '../turn-provenance/turn-provenance';
import { detectPossibleSecrets } from './secret-detect';
import type { MemoryEntry, ScoreScale, SearchLegStats } from './backend';
// The funnel's leg-attribution shape lives with the GATES (recall-admission),
// not with the telemetry writer — see `admittedByLeg` there for why.
import type { AdmittedByLeg } from './recall-admission';

/**
 * Upper bound of an RRF score at the PRODUCTION fusion defaults
 * (`(1 + lexWeight) / (k + 1)` = 2/61), i.e. an entry ranked 1st in BOTH legs.
 * Used only by `classifyLegacyScoreScale` — live rows carry their scale
 * explicitly and must never be classified by value.
 */
export const RRF_SCORE_CEILING = 2 / 61;

/**
 * Lowest score an admitted COSINE hit can carry: the relevance floor applied on
 * admission. Observed minimum on the live table is 0.50.
 *
 * ⚠ DELIBERATELY NOT `MEMORY_INJECTION_COSINE_FLOOR`, and it must NOT be "fixed"
 * to track it. That constant is the LIVE admission contract and moved 0.45 → 0.58
 * on 2026-08-02 (P-050 / D-058). This one is a CLASSIFIER BOUNDARY over HISTORICAL
 * rows — it separates the RRF scale (bounded by 2/61) from the cosine scale for
 * rows written before migration 705 recorded `score_scale` explicitly. Those rows
 * were admitted under the OLD 0.45 floor, so raising this to 0.58 would classify
 * every legacy cosine hit in [0.45, 0.58) as 'unknown' and silently drop it from
 * comparisons. The two values describe different times and are expected to diverge.
 */
export const COSINE_ADMISSION_FLOOR = 0.45;

/**
 * Best-effort scale for a row written BEFORE migration 705 (`score_scale IS
 * NULL`). A transition aid, deliberately confined to this one function.
 *
 * This is an INFERENCE, and the only reason it is defensible is that the live
 * distribution is almost perfectly bimodal — measured over 45,069 rows / 30d
 * before it was written: 32,547 at <= 0.032787 (rrf), 12,517 at >= 0.50
 * (cosine), and just 5 rows (0.011%) anywhere in the 13x-wide gap between. The
 * separation is structural, not lucky: RRF is bounded above by 2/61 while an
 * admitted cosine hit is floored at ~0.45.
 *
 * It is nonetheless valid ONLY while k=60 / lexWeight=1 hold (raising lexWeight
 * to 2 lifts the RRF ceiling to 3/61 and starts eating into the gap), which is
 * exactly why new rows record the scale instead of relying on this. Returns
 * 'unknown' inside the gap rather than guessing — an unknown row is excluded
 * from comparisons, which is the safe direction.
 */
export function classifyLegacyScoreScale(topScore: number | null | undefined): ScoreScale {
  if (typeof topScore !== 'number' || !Number.isFinite(topScore)) return 'unknown';
  if (topScore <= RRF_SCORE_CEILING) return 'rrf';
  if (topScore >= COSINE_ADMISSION_FLOOR) return 'cosine';
  return 'unknown';
}

/**
 * The SHAPE of a recall query — what was ASKED, recorded alongside what came
 * back (migration 706 / P-041).
 *
 * Shape rather than the query text itself: the questions this has to answer
 * ("how much recall traffic is machine boilerplate", "how often is the query a
 * near-empty prompt", "how often is it a repeat") are all answerable without
 * carrying prompt content into a retained telemetry table.
 */
export interface RecallQueryShape {
  /**
   * Chars actually handed to the backend — turn-origin envelope INCLUDED,
   * because that is what got embedded. Sitting exactly at a caller's clamp
   * (turn-start clamps to 1000) is itself the truncation signal.
   */
  chars: number;
  /** sha256 of the ENVELOPE-STRIPPED, CRLF-normalized query — see below. */
  sha256: string;
  /** The origin CLAIMED by the envelope; null when there was none. */
  origin: string | null;
}

/**
 * Derive the recorded shape of one recall query.
 *
 * ⚠ THE ENVELOPE IS STRIPPED BEFORE HASHING, and that is the whole reason this
 * function exists rather than an inline `sha256(query)` at each call site.
 * Machine-injected turns arrive prefixed with `⟦turn-origin:<origin>
 * nonce:<hex>⟧`, the nonce is freshly minted per turn, and the turn-start path
 * embeds the raw prompt verbatim — so hashing the raw text would make every
 * machine-injected query unique BY CONSTRUCTION. The duplicate rate would read
 * 0.0% however identical the real prompts were, and 0% duplicates reads as
 * healthy. That is the same structural blindness as judging query quality by an
 * RRF `top_score` (D-015): a metric that cannot detect the thing it is for.
 *
 * The envelope is not discarded, it is RECORDED (`origin`) — but as the
 * envelope's CLAIM only. The ledger-corroborated verdict (turn-provenance's
 * `classify`) needs a filesystem read and has no place on a fire-and-forget
 * telemetry path; nothing here is adversarial and nothing gates on it.
 *
 * `parseEnvelope`/`payloadSha256` are imported rather than re-implemented on
 * purpose: a second copy of the envelope regex would silently misclassify every
 * row the day the envelope format changes.
 */
export function describeRecallQuery(query: string): RecallQueryShape {
  const envelope = parseEnvelope(query);
  return {
    chars: query.length,
    sha256: payloadSha256(envelope ? envelope.payload : query),
    origin: envelope?.origin ?? null,
  };
}

/**
 * The generic surfaces (`search` pull, `injection` push) plus the per-port
 * labels the launch/injection ports stamp (memory-delivery-unification P-005 /
 * D-006). `session.port` flows straight through as the surface, so these MUST
 * stay in sync with the `port` values the ports pass (launch-profile /
 * claim-port / the initialize + compact + turn-start callers). An unknown
 * string still records fine (free-text column) — the union is the documented
 * set, not a DB constraint.
 */
export type RecallSurface =
  | 'search'
  | 'injection'
  | 'initialize'
  | 'compact'
  | 'turn-start'
  | 'brief'
  | 'orient'
  | 'claim'
  | 'create';

/**
 * One pool's contribution to a multi-pool (push-path) recall — migration 703 /
 * context-injection-audit-2026-07-28 P-026.
 *
 * `limit` and `scopes` are recorded rather than inferred at read time, and that
 * is the whole point of the shape. A saturation test (`hits === limit`) computed
 * against TODAY's constant is wrong for every row written before the constant
 * was retuned — and P-032/P-033 exist specifically to retune them. Likewise a
 * pool that returns zero because it was queried under a scope key nothing writes
 * to is indistinguishable, after the fact, from a pool that simply held nothing
 * relevant — unless the scope it actually queried was captured at the time.
 */
export interface RecallPoolStats {
  /** This pool's results (post score-floor, pre policy filtering). */
  entries: readonly MemoryEntry[];
  /** The per-pool budget in effect for THIS call. */
  limit: number;
  /** The scope keys actually queried for this pool. */
  scopes: readonly string[];
}

/**
 * The filter stages between "what the index returned" and "what the agent got",
 * in pipeline order — migration 758 / P-002.
 *
 * Named rather than positional so a stage inserted later cannot silently shift
 * every historical row's meaning.
 */
export type AdmissionStage =
  /** knowledge-pack rows whose pack is disabled for the hive. */
  | 'pack'
  /** memory_feedback: the user deleted this fact (or a re-extraction of it). */
  | 'feedback'
  /** the user pool's workspace scoping — a `project` hit from another workspace. */
  | 'workspace'
  /** already surfaced this session-epoch (or inside the wall-clock window). */
  | 'dedup'
  /** the owner's Jev filter (setting On) judged it irrelevant to the message (jev-memory-gate.ts). */
  | 'jev'
  /** near-duplicate collapse — the same fact stored under several ids. */
  | 'nearDuplicate'
  /** did not fit the char budget. */
  | 'budget';

export const ADMISSION_STAGES: readonly AdmissionStage[] = [
  'pack',
  'feedback',
  'workspace',
  'dedup',
  'jev',
  'nearDuplicate',
  'budget',
];

/**
 * ONE CLAUSE per stage, for rendering beside a live count where a human reads it
 * (the agent dossier's injection rows, WI-37549).
 *
 * Deliberately short where `ADMISSION_STAGE_DESIGN_INTENT` below is long: that
 * one is the argument you read BEFORE filing a loss as a defect; this one is what
 * makes a bare number legible at a glance — "8 — did not fit the char budget"
 * rather than "8". Neither replaces the other.
 *
 * It lives HERE, beside the stage list it must cover, and is shipped to the UI
 * on the wire by `derivePushedContext` rather than re-typed in the client. A
 * hand-copied gloss in a component is how a count and its explanation drift
 * apart, which is the failure the design-intent text below exists to prevent —
 * and this module imports `@papercusp/flags/server`, so the client cannot import
 * the vocabulary directly even if it wanted to.
 *
 * Phrased as the reason a row was DROPPED, so it reads correctly after a count:
 * `${n} — ${ADMISSION_STAGE_SHORT_WHY[stage]}`.
 */
export const ADMISSION_STAGE_SHORT_WHY: Record<AdmissionStage, string> = {
  pack: 'belongs to a knowledge pack disabled for this hive',
  feedback: 'the user deleted this fact, so it is not re-surfaced',
  workspace: 'scoped to another workspace (a cross-workspace correctness boundary)',
  dedup: 'already surfaced in this session-epoch',
  jev: 'judged irrelevant to the message by Jev (Settings: On)',
  nearDuplicate: 'the same fact under another id, collapsed after ranking',
  budget: 'did not fit the char budget, cut after ranking',
};

/**
 * WHY each stage drops what it drops — the DESIGNED loss, next to the metric.
 *
 * This exists because the funnel reports WHAT was lost and never WHY, and a bare
 * large number reads as a defect. Three work-items in the context-injection lane
 * filed a deliberate design behaviour as a bug off these counters
 * (context-injection-retrieval-reach-and-visibility-2026-08-03 D-063, D-073,
 * D-074). The failure is systematic, not careless: the stages tuned MOST
 * aggressively produce the MOST alarming numbers, so the funnel indicts exactly
 * the stages someone already thought hardest about.
 *
 * ⚠ TWO RULES BEFORE YOU FILE A LOSS AS A DEFECT (D-076):
 *
 * 1. SPLIT BY SURFACE FIRST. Never aggregate `dropped` across ports. `mid-turn`
 *    is ~91% of recalls and ~89% of returned rows, so it sets any workspace-wide
 *    aggregate by itself — and its budget is an order of magnitude smaller than
 *    every other port's ON PURPOSE. An aggregate over sub-populations with
 *    deliberately different targets will always indict whichever one was designed
 *    to be most aggressive. That is arithmetic, not evidence.
 * 2. READ THE INTENT BELOW (and the writer it names). A loss is a defect only if
 *    it CONTRADICTS its own design intent.
 *
 * Corollary worth stating plainly: an acceptance criterion phrased "make metric X
 * move off zero" is suspect on its face. Zero may be the specification — see
 * `AdmittedByLeg.lexicalOnly`, whose zero is structural.
 */
export const ADMISSION_STAGE_DESIGN_INTENT: Record<AdmissionStage, string> = {
  pack: 'Configuration, not relevance: the row belongs to a knowledge pack disabled for this hive. Nonzero is expected wherever packs are off; it says nothing about retrieval quality.',
  feedback:
    'CORRECT BY CONSTRUCTION — the user deleted this fact. This loss must never be "fixed"; a zero here where deletions exist would mean deletions are not being honoured. Higher is not worse.',
  workspace:
    'A correctness boundary, not a filter to relax: a `project` hit leaking from another workspace. Reducing this loss means leaking cross-workspace memory.',
  dedup:
    'Already surfaced in this session-epoch. THE ONE STAGE WHERE A HIGH VALUE IS GENUINELY DIAGNOSTIC — but of the EPOCH, not of the filter. Sustained ~60% means the epoch is not advancing (the P-022 cutover orphaned the bump for 6 days; D-072), not that dedup is too aggressive. Residual loss on a live epoch is genuine within-epoch repeats and is correct. Check `memory_session_epochs` for organic bumps before touching anything here.',
  jev:
    'Opt-in precision filter (plan jev-decision-model-integration-2026-09-29, D-013): nonzero ONLY where the owner set Jev to On and stored a key; zero everywhere else is the specification. It drops a floor-admitted memory Jev judges irrelevant to the message (P(yes) < 0.3) and fails OPEN on any timeout, error or malformed answer, so it can remove noise but never blocks a turn. The loss is the feature; judge it against the weekly precision monitor, not by its size.',
  nearDuplicate:
    'The same fact stored under several ids, collapsed after ranking. Correct dedup; the loss is the feature.',
  budget:
    'Deliberately aggressive, and PER-PORT — this is the stage that has caused the most false defect reports. `mid-turn` runs ~350 chars against a 16,000-char global default because that port is a per-tool-call interruption that "must be cheap enough to ignore" (mid-turn-context.ts); its low admit rate is the design working (D-073). DO NOT raise MID_TURN_BUDGET_CHARS off an aggregate — it taxes every agent on ~89% of all retrieval volume. ⚠ This text used to name turn-start as the port that was NOT deliberately tightened; it IS (4,000 vs the 16,000 default, "D-004 small budget", turn-start-memory.ts) — EVERY port here is tightened, so "untightened" is never the argument (D-077). Reopen a budget only when a stated PREMISE of its decision changed, and A/B it — %budget falls by construction when you raise the budget, so it cannot validate the change; read the admitted rate.',
};

/**
 * The admission funnel for one push-path recall — what the index returned
 * against what actually reached the agent, and where the rest went.
 */
export interface RecallAdmissionStats {
  /** What the index gave back (mirrors hit_count, carried so the funnel reads standalone). */
  returned: number;
  /** Lines that actually reached the agent. */
  admitted: number;
  /** The char budget cut the block. */
  truncated: boolean;
  /**
   * Chars actually SPENT by the admitted lines, against `budgetChars` below.
   * Absent = not recorded by that caller (never 0 — a recall that admitted
   * nothing records spent: 0 explicitly, same doctrine as `dropped`).
   *
   * ⚠ WHY THIS EXISTS, because its absence made a whole question unanswerable
   * (D-081): `truncated` is TRUE in two situations that call for OPPOSITE fixes
   * and are otherwise indistinguishable —
   *   (a) the budget was genuinely exhausted (spent ≈ budgetChars) → the budget
   *       is the binding constraint, and raising it delivers more;
   *   (b) every remaining entry was individually too large for the space left
   *       (spent well under budgetChars) → the ENTRY CLAMP is the binding
   *       constraint, raising the budget buys little, and the real lever is
   *       MAX_ENTRY_CHARS (injection.ts) or the packing.
   * Utilization (spent / budgetChars) is the only field that separates them.
   * Read it BEFORE proposing any budget change, and note that D-077 already
   * requires such a change be argued on the admitted rate rather than on
   * %budget, which falls by construction when the budget is raised.
   *
   * ⚠ UTILIZATION CAN EXCEED 1.0, and that is CORRECT — not a bad write. The
   * ALWAYS-EMIT-ONE-ROW contract in injection.ts `admit()` skips the budget
   * check while `lines.length === 0`, so a single oversized first entry is
   * admitted whatever its length (mid-turn passes a ~350 budget against lines
   * clamped to 900, which is the WI-7163 case). So there are THREE readings,
   * not two:
   *   spent ≈ budgetChars → budget-bound (case a above)
   *   spent ≪ budgetChars → clamp-bound (case b above)
   *   spent >  budgetChars → the one-row exemption fired; this recall delivered
   *                          exactly one entry and the budget never applied.
   * Do not "fix" the third by tightening `admit()` — WI-6870 did, and mid-turn
   * silently delivered NOTHING until WI-7163 restored it.
   */
  spent?: number;
  /**
   * The budget those lines were packed against, carried so a historical row
   * stays interpretable after the constant moves. Per-port and deliberately
   * tightened everywhere (see `ADMISSION_STAGE_DESIGN_INTENT.budget`), so a
   * funnel row without it cannot be compared across ports at all — mid-turn's
   * ~350 and turn-start's 4,000 are the same `truncated: true` otherwise.
   */
  budgetChars?: number;
  /**
   * Per stage. EVERY stage is recorded even at zero: "this filter ran and
   * removed nothing" and "this filter never ran" are different facts and only
   * the first is a healthy zero — the same reason `LegRunStats.ran` exists.
   *
   * ⚠ A LARGE VALUE HERE IS NOT EVIDENCE OF A DEFECT. Several of these stages are
   * deliberately lossy and one (`feedback`) is loss-CORRECT by construction. Read
   * `ADMISSION_STAGE_DESIGN_INTENT` before acting on any of these counters, and
   * split by surface first — an aggregate across ports is dominated by `mid-turn`
   * (~91% of recalls), whose budget is intentionally an order of magnitude
   * smaller than every other port's. Three work-items have already been filed
   * against designed behaviour off these numbers (D-063, D-073, D-074).
   */
  dropped: Record<AdmissionStage, number>;
  /** See `AdmittedByLeg.lexicalOnly` — its zero on the push path is structural. */
  byLeg: AdmittedByLeg;
  /**
   * The independent transcript/work-item corpus leg on this SAME recall row.
   * `null` means it did not run or faulted before returning a typed outcome;
   * absence means an older caller that predates this measurement.
   */
  corpus?: CorpusAdmissionStats | null;
  /**
   * The Jev memory filter's part in this recall (WI-10004485). Absent when the
   * filter was Off, never reached (no candidates), or faulted.
   */
  jev?: JevFunnelEntry;
}

/**
 * One recall's Jev filter record, written by jev-memory-gate `jevFunnelEntry`. The
 * per-port skip rate is the share of a waiting port's recalls with
 * `skipped: 'no-time'`; the timeout rate of the calls actually made is in
 * decision_model_calls (consumer `memory-injection`), whose rows on a waiting port
 * are exactly the calls On would wait on. Together they are On's fail-open rate.
 */
export interface JevFunnelEntry {
  readonly effective: 'shadow' | 'on';
  /** What the caller could give Jev, net of its response margin, rounded. Absent: no bound. */
  readonly budgetMs?: number;
  /** No call was made: On would have had too little time left to wait. */
  readonly skipped?: 'no-time';
  /**
   * On only. In Log only the answer lands after this row is written, so its
   * outcome is read from decision_model_calls instead.
   */
  readonly outcome?: 'answered' | 'inconclusive';
  readonly reason?: string;
  /** The answer was reused from an earlier identical call; no request went out. */
  readonly cached?: true;
  /**
   * Whether a caller still waited on the build when Jev's time was set. False: a
   * background (stale-while-revalidate) rebuild or an already-answered caller, so
   * the client wall did not bound Jev. Absent: the caller did not say.
   */
  readonly callerWaiting?: boolean;
  /** What was left of the client wall, ms, whether or not it applied (negative: already past). Absent: no wall. */
  readonly wallLeftMs?: number;
  /** What was left of the build's own deadline, ms. Absent: unbounded. */
  readonly deadlineLeftMs?: number;
}

export type CorpusAdmissionDropReason =
  | 'ambient-excluded'
  | 'self-session'
  | 'out-of-scope'
  | 'no-term-overlap'
  | 'duplicate-ref'
  | 'not-novel'
  | 'cap-exhausted'
  | 'budget-exhausted';

/** Admission funnel for the independently ranked corpus excerpt leg. */
export interface CorpusAdmissionStats {
  outcome: 'ok' | 'timed-out' | 'disabled' | 'no-query' | 'failed';
  /** Search candidates before pure-core selection. */
  returned: number;
  /** Lines surviving pure-core selection, before gate and session dedup. */
  selected: number;
  /** Lines that actually reached the composed agent context. */
  admitted: number;
  /** Pure-core selection losses; every reason is present even at zero. */
  dropped: Record<CorpusAdmissionDropReason, number>;
  /** Coverage-gate verdict and how many selected lines it suppressed. */
  gate: { verdict: string; reasons: string[]; dropped: number } | null;
  /** Selected lines removed by the cross-moment surfaced-ref ledger. */
  sessionDedup: number;
  /** False means the search was BM25-only. */
  embedderAvailable: boolean;
  /** Raw search-leg execution report; null means fusion never ran. */
  legs: Record<string, unknown> | null;
  retrievalDepth: number;
  /** Whether stage-1 reranking actually ran, rather than merely being enabled. */
  rerank: string;
}

interface RecallStatsCommon {
  /** The documented set (RecallSurface) OR any port string — free-text column. */
  surface: RecallSurface | (string & {});
  /**
   * WHICH TUI received this recall (migration 770 / codex-context-injection-
   * parity-2026-08-09 P-005). 'claude' | 'codex' | 'omp' — typed loosely on
   * purpose, matching the free-text column: a new client must never be able to
   * fail a write (see 583-drop-memory-recall-stats-surface-check.sql for the
   * hours this table already lost to a stale CHECK).
   *
   * Supply it on any INJECTION-path write. Omitting it records NULL, which
   * every coverage read treats as UNATTRIBUTED and excludes — deliberately, so
   * "we never asked" stays distinguishable from "a client got nothing".
   *
   * ⚠ This is the column that makes THIS PLAN'S OWN WORK falsifiable. Injection
   * was Claude-only for months and nothing reported it, because this table
   * records what the injector DID and cannot record a call never made. A client
   * ABSENT from a per-client coverage query is the alarm condition.
   */
  client?: 'claude' | 'codex' | 'omp' | (string & {}) | null;
  /** Workspace this recall ran for. Migration 290 added the column; nothing
   *  ever wrote it (0 of 56,841 rows) until P-026 — see the migration note. */
  workspaceId?: string | null;
  /** Pot/hive slug this recall ran for. Same dead-column history as workspaceId. */
  potSlug?: string | null;
  /**
   * The scale `entries[].score` is on (migration 705 / P-036) — read off the
   * backend that produced them (`backend.scoreScale`, or `lexicalScoreScale`
   * when the caller took the embed-free fallback leg).
   *
   * Supply it. Omitting it records NULL, which every scale-aware reader treats
   * as 'unknown' and EXCLUDES from percentiles rather than pooling with a
   * labelled row — the scores are silently unusable, not merely unlabelled.
   */
  scoreScale?: ScoreScale | null;
  /**
   * The query text this recall ran on (migration 706 / P-041) — pass it RAW,
   * exactly as handed to the backend. Only its SHAPE is stored
   * (`describeRecallQuery`); the text itself never reaches the table.
   *
   * Supply it. Omitting it records NULLs, and a NULL query row is excluded from
   * every query-quality measurement — which is the pre-P-041 state where the
   * table could say in detail what came BACK and nothing at all about what was
   * ASKED, and no query-side defect was measurable.
   */
  query?: string | null;
  /**
   * Session this recall ran for (push path: `session.sessionId`). Null on the
   * pull path, which has no session identity on its ctx.
   *
   * Load-bearing for the duplicate measurement specifically: "the same query as
   * last turn" is only defined WITHIN a session, and this table interleaves
   * every concurrent agent on the box. Lagging by created_at across sessions
   * compares one agent's turn to a different agent's — a number that means
   * nothing while looking like a rate.
   */
  sessionId?: string | null;
  /**
   * Per-LEG provenance (migration 758 / P-002) — what each retrieval leg did on
   * this call, as reported by the backend's `onLegStats` seam.
   *
   * Omitting it records NULL, which reads as "this path has no legs to report"
   * (the pull path, a single-leg backend). That is deliberately the same posture
   * as `pools`: a NULL is a shape statement, not a missing measurement.
   */
  legs?: SearchLegStats | null;
  /**
   * The ADMISSION FUNNEL (migration 758 / P-002) — what reached the agent.
   *
   * ⚠ This row is written BEFORE the filter chain runs, so `hit_count` here can
   * only ever mean "what the index returned". Without this field nothing in the
   * system records what was actually DELIVERED, and the two diverge by design —
   * six filter stages sit between them. Supply it wherever the delivered block
   * is known.
   */
  admission?: RecallAdmissionStats | null;
}

/**
 * Either a FLAT result set (the pull path — one scope, no fan-out) or a
 * PER-POOL breakdown (the push path — user + harness + hive, each with its own
 * budget). Deliberately a discriminated union with `never` arms rather than two
 * optional fields: when `pools` is supplied the flat totals are DERIVED from it,
 * so `hit_count` can never drift from the sum of the pool counts. A caller
 * cannot supply both and cannot supply a breakdown that disagrees with itself.
 */
export type RecallStatsInput =
  | (RecallStatsCommon & {
      /** The recall's result set (post score-floor, pre per-call caps). */
      entries: readonly MemoryEntry[];
      pools?: never;
    })
  | (RecallStatsCommon & {
      /** Per-pool breakdown; the flat columns are derived from it. */
      pools: Readonly<Record<string, RecallPoolStats>>;
      entries?: never;
    });

/** Results whose metadata carries entityType — entity-store leakage (the
 *  EI-366 junk class). Always 0 after the canonical-store segregation fix;
 *  non-zero is the regression canary the health card surfaces. */
export function countFragmentHits(entries: readonly MemoryEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (typeof e.metadata?.entityType === 'string') n += 1;
  }
  return n;
}

// Warn THROTTLE, not a one-shot latch. A single warn-then-permanent-silence
// (the old `_warned` boolean) is how a persistent write failure hides: when a
// stale surface CHECK silently rejected every per-port write for hours
// (memory-delivery-unification P-005), the ONE log line scrolled away and the
// black-hole was invisible until a live probe forced it out. Re-warn at most
// once per window, and carry the count swallowed since the last warn, so an
// ongoing breakage keeps surfacing instead of going quiet after line one.
const RECALL_STATS_WARN_WINDOW_MS = 5 * 60_000;
let _lastWarnedAt = 0;
let _suppressedSinceWarn = 0;

// Retrieval and its telemetry deliberately share the org SQL handle: the row
// must land in the same database as the recall it describes.  Do not let that
// turn into an unbounded fan-out on the shared connection pool, though.  A
// burst of fire-and-forget INSERTs can otherwise occupy the pool ahead of the
// next retrieval query and make the observer create the deadline it records.
//
// Serialize per Sql handle rather than globally so independent org databases
// cannot head-of-line block one another. Every caller still receives its own
// promise and every recall still executes one write; this bounds CONCURRENCY,
// not fidelity. Weak keys also let a throwaway/test database disappear without
// a process-lifetime registry entry.
const recallStatsWriteTails = new WeakMap<Sql, Promise<void>>();

function enqueueRecallStatsWrite(sql: Sql, write: () => Promise<void>): Promise<void> {
  const previous = recallStatsWriteTails.get(sql) ?? Promise.resolve();
  // Yield one event-loop turn between telemetry writes. Without this handoff a
  // settled INSERT schedules its successor in the same microtask drain, so a
  // long FIFO can repeatedly reclaim a small org pool ahead of the feedback /
  // dedup queries on the next recall. Concurrency=1 alone prevents a stampede;
  // the macrotask handoff supplies fairness to the path being measured.
  const current = previous
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(write);
  recallStatsWriteTails.set(sql, current);
  const clearIfTail = (): void => {
    if (recallStatsWriteTails.get(sql) === current) recallStatsWriteTails.delete(sql);
  };
  void current.then(clearIfTail, clearIfTail);
  return current;
}

/** Finite scores only — a non-numeric or NaN score is absent, not zero. */
function finiteScores(entries: readonly MemoryEntry[]): number[] {
  return entries
    .map((e) => e.score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
}

/**
 * The PRE-FUSION COSINE similarity of each entry — the number the relevance
 * floor is actually applied to, on a single scale (0..1), for every path
 * (migration 771 / WI-37403).
 *
 * ⚠ THIS IS NOT `finiteScores`, and the difference is the whole point.
 * `entries[].score` means different things on different paths: on a fused push
 * recall it is a post-fusion RRF value computed from RANKS, bounded above by
 * 2/61 = 0.0328 and carrying NO information about how similar anything was; on
 * an unfused cosine recall it IS the similarity. Pooling those into one column
 * is what already produced a false "99.9% of injections are below the 0.58
 * floor" report (2026-07-28) — the floor was fine, the scales were not.
 *
 * Two sources, in priority order, both yielding a genuine cosine similarity:
 *   1. `retrieval.cosineScore` — stamped by `fuse()` at the last moment before
 *      it overwrites `score` with the RRF sum. Present on every fused hit the
 *      cosine leg returned; ABSENT on a lexical-only admit, which has no cosine
 *      score to report and must not contribute one.
 *   2. `entry.score` when the caller declares `scoreScale === 'cosine'` — the
 *      unfused paths (mem0's backend, and any single-leg cosine backend), where
 *      the native score already IS the similarity.
 *
 * Anything else contributes NOTHING rather than a guess: a lexical/RRF scale
 * score is not a cosine, and inferring one from its VALUE is the same
 * classify-by-magnitude mistake `classifyLegacyScoreScale` is confined to.
 */
export function cosineScoresOf(
  entries: readonly MemoryEntry[],
  scoreScale: ScoreScale | null | undefined,
): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const stamped = (e.retrieval as { cosineScore?: unknown } | undefined)?.cosineScore;
    if (typeof stamped === 'number' && Number.isFinite(stamped)) {
      out.push(stamped);
      continue;
    }
    if (scoreScale === 'cosine' && typeof e.score === 'number' && Number.isFinite(e.score)) {
      out.push(e.score);
    }
  }
  return out;
}

/** The `pools` jsonb payload: per pool, what it returned against what it was allowed. */
function poolsPayload(
  pools: Readonly<Record<string, RecallPoolStats>>,
): Record<string, { hits: number; top: number | null; limit: number; scopes: string[] }> {
  const out: Record<string, { hits: number; top: number | null; limit: number; scopes: string[] }> = {};
  for (const [name, pool] of Object.entries(pools)) {
    const scores = finiteScores(pool.entries);
    out[name] = {
      hits: pool.entries.length,
      top: scores.length > 0 ? Math.max(...scores) : null,
      limit: pool.limit,
      // Bounded: a fan-out is capped at MAX_HARNESS_FANOUT upstream, but this
      // row must stay small whatever a future caller passes.
      scopes: pool.scopes.slice(0, 16).map(String),
    };
  }
  return out;
}

/**
 * Hard ceiling on stored query text. The mid-turn caller already clamps its
 * derived query upstream, so this is a floor-of-last-resort against a future
 * caller passing something unbounded into a retained table — not a substitute
 * for the caller's own clamp.
 */
export const QUERY_TEXT_MAX_CHARS = 4000;

/**
 * Persist the retrieval query TEXT for a bounded window (migration 771 /
 * WI-37403). Separate from the stats insert and separately guarded — see the
 * call site for why the stats row must never be collateral to this write.
 *
 * Three refusals, all of which record NOTHING rather than something partial:
 *
 * 1. THE KILL SWITCH (`MEMORY_RECALL_QUERY_TEXT`, default ON). This is the one
 *    thing here that stores agent-authored text in a table, so it must be
 *    stoppable without a deploy. Fail-CLOSED on a flag-read error — the
 *    opposite posture from the retention prunes, which fail-safe by continuing
 *    to DELETE. The asymmetry is deliberate: the risky direction for a prune is
 *    stopping, and for a capture it is starting.
 *
 * 2. CREDENTIAL-SHAPED CONTENT. The mid-turn query is derived from raw Bash
 *    command lines, which routinely carry connection strings and API keys — a
 *    live scan of the memory corpus found 16 real passwords already at rest
 *    (EI-10371). `detectPossibleSecrets` is high-confidence-only (vendor
 *    prefixes and structural shapes, no entropy heuristics), so a refusal here
 *    is nearly always a real credential. Skipping the row loses one sample of
 *    telemetry; storing it copies a secret into a second place.
 *
 * 3. EMPTY TEXT. Nothing to measure, and a zero-length row would read as a real
 *    empty query in exactly the reads this exists to serve.
 */
export async function recordRecallQueryText(
  sql: Sql,
  statsId: string | number,
  query: string,
): Promise<void> {
  try {
    const text = query.trim();
    if (!text) return;
    let enabled: boolean;
    try {
      enabled = await getFlag(FLAGS.MEMORY_RECALL_QUERY_TEXT, 'system:memory-recall-stats');
    } catch {
      return; // fail CLOSED — never capture text we could not confirm we may capture
    }
    if (!enabled) return;
    if (detectPossibleSecrets(text).matched) return;
    await sql`
      INSERT INTO harness_shared.memory_recall_query_text (stats_id, query_text)
      VALUES (${statsId}, ${text.slice(0, QUERY_TEXT_MAX_CHARS)})
      ON CONFLICT (stats_id) DO NOTHING
    `;
  } catch {
    /* swallow — the SHAPE columns on the stats row are the durable record;
       this is the best-effort window on top of them. */
  }
}

/** Insert one stats row. Never throws; never load-bearing. */
async function recordRecallStatsNow(sql: Sql, input: RecallStatsInput): Promise<void> {
  try {
    // A per-pool input DERIVES its flat totals, so hit_count/top_score/scores keep
    // exactly the meaning they have always had and cannot disagree with `pools`.
    const entries: readonly MemoryEntry[] = input.pools
      ? Object.values(input.pools).flatMap((p) => [...p.entries])
      : input.entries;
    const scores = finiteScores(entries);
    const topScore = scores.length > 0 ? Math.max(...scores) : null;
    const pools = input.pools ? JSON.stringify(poolsPayload(input.pools)) : null;
    // Migration 758 / P-002. Both stay NULL when the caller has nothing to say,
    // so a pull-path row is distinguishable from a push-path row that lost its
    // breakdown — the same nullability contract `pools` carries.
    const legs = input.legs ? JSON.stringify(input.legs) : null;
    const admission = input.admission ? JSON.stringify(input.admission) : null;
    // P-041 / migration 706: the query's SHAPE. A caller that passes no query
    // records NULLs and is excluded from query-quality reads, rather than
    // contributing a zero-length row that would read as a real empty query.
    const q = typeof input.query === 'string' ? describeRecallQuery(input.query) : null;
    // Migration 771 / WI-37403: the PRE-FUSION cosine, in its OWN columns.
    // NULL (not 0, not []) when this recall produced no cosine similarity at
    // all — a lexical-only fallback, or a backend with no cosine leg. An empty
    // ARRAY means "measured, and there were none", which is a different fact.
    const cosineScores = cosineScoresOf(entries, input.scoreScale);
    const topCosine = cosineScores.length > 0 ? Math.max(...cosineScores) : null;
    const rows = await sql`
      INSERT INTO harness_shared.memory_recall_stats
        (surface, hit_count, top_score, scores, fragment_count, pools, workspace_id, pot_slug, score_scale,
         query_chars, query_sha256, query_origin, session_id, legs, admission, client,
         top_cosine_score, cosine_scores)
      VALUES (
        ${input.surface},
        ${entries.length},
        ${topScore},
        ${JSON.stringify(scores)}::text::jsonb,
        ${countFragmentHits(entries)},
        ${pools}::text::jsonb,
        ${input.workspaceId ?? null},
        ${input.potSlug ?? null},
        ${input.scoreScale ?? null},
        ${q ? q.chars : null},
        ${q ? q.sha256 : null},
        ${q ? q.origin : null},
        ${input.sessionId ?? null},
        ${legs}::text::jsonb,
        ${admission}::text::jsonb,
        ${input.client ?? null},
        ${topCosine},
        ${cosineScores.length > 0 ? JSON.stringify(cosineScores) : null}::text::jsonb
      )
      RETURNING id
    `;
    // The query TEXT, on a bounded window, as a SEPARATE statement (migration
    // 771). Deliberately not part of the INSERT above and deliberately not
    // inside its try: this write is the one that can be refused (flag off,
    // credential-shaped text) and the one touching the newest table, and the
    // stats row must never be collateral. That is not hypothetical caution —
    // this table already black-holed every write for hours once when a stale
    // CHECK rejected them (583-drop-memory-recall-stats-surface-check.sql).
    const statsId = rows?.[0]?.id;
    if (statsId !== undefined && typeof input.query === 'string') {
      await recordRecallQueryText(sql, statsId as string | number, input.query);
    }
  } catch (err) {
    _suppressedSinceWarn += 1;
    const now = Date.now();
    if (now - _lastWarnedAt >= RECALL_STATS_WARN_WINDOW_MS) {
      const alsoSuppressed = _suppressedSinceWarn - 1;
      console.warn(
        `[memory-recall-stats] capture failed (surface='${input.surface}')` +
          (alsoSuppressed > 0 ? ` — +${alsoSuppressed} more since last warn` : '') +
          `; re-warns at most once/${RECALL_STATS_WARN_WINDOW_MS / 60_000}min:`,
        (err as Error).message,
      );
      _lastWarnedAt = now;
      _suppressedSinceWarn = 0;
    }
  }
}

/**
 * Queue one stats row behind earlier telemetry for this SQL handle. Callers on
 * the recall path should still call WITHOUT awaiting: the returned promise is
 * for teardown/tests and preserves the one-call/one-row completion contract.
 */
export function recordRecallStats(sql: Sql, input: RecallStatsInput): Promise<void> {
  return enqueueRecallStatsWrite(sql, () => recordRecallStatsNow(sql, input));
}

/** Test hook: reset the warn throttle so a suite can assert re-warn behavior. */
export function _resetRecallStatsWarnThrottleForTests(): void {
  _lastWarnedAt = 0;
  _suppressedSinceWarn = 0;
}

/*
 * A row's EFFECTIVE score scale in SQL is the recorded label when present
 * (migration 705 onward), else the legacy value-based classification:
 *
 *   CASE WHEN score_scale IS NOT NULL THEN score_scale
 *        WHEN top_score IS NULL       THEN 'unknown'
 *        WHEN top_score <= ${RRF_SCORE_CEILING}      THEN 'rrf'
 *        WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
 *        ELSE 'unknown' END
 *
 * It is written out inline in each query below rather than shared as a nested
 * `sql` fragment. A helper returning sql`…` reads better but INVOKES the tagged
 * template, which is indistinguishable from a query to a call-counting test
 * double — it silently consumed a response and made a mocked aggregate return
 * zeros, i.e. read as perfectly healthy. The duplicated text is three lines;
 * the NUMBERS stay single-sourced through the two constants above, which is
 * where drift would actually be dangerous.
 */

export interface RecallHealth {
  /** Recalls recorded in the trailing 7 days (both surfaces). */
  recalls7d: number;
  /** Of those, how many returned nothing. */
  zeroHit7d: number;
  /** zeroHit7d / recalls7d (0 when no recalls recorded). */
  zeroHitRate7d: number;
  /**
   * Median top_score across non-empty recalls, 7d (null when none) — computed
   * over `topScoreScale` ONLY. See that field: this is NOT a percentile over
   * every recall in the window, and deliberately so.
   */
  topScoreP50: number | null;
  /** 90th percentile top_score, same single-scale population as topScoreP50. */
  topScoreP90: number | null;
  /**
   * WHICH scale the two percentiles above are on (P-036) — the dominant scale
   * in the window, by scored-row count. Null when no scored rows.
   *
   * Percentiles are single-scale because a percentile over MIXED scales is not
   * a weak number, it is a meaningless one: rrf tops out at 0.033 while cosine
   * starts at 0.50, so a blended median reports the workload MIX (which path
   * ran more often) rather than retrieval quality, and shifts by 25x when the
   * mix shifts with retrieval unchanged. Render this next to the number; a
   * bare score with no scale is exactly the ambiguity D-001 had to retract.
   */
  topScoreScale: ScoreScale | null;
  /** Scored rows behind the percentiles (i.e. rows on `topScoreScale`). */
  topScoreSamples: number;
  /** Scored rows in the window per scale — the mix the percentiles exclude. */
  scaleMix: Record<string, number>;
  /** Entity-fragment results that leaked into recalls, 7d — regression canary. */
  fragmentHits7d: number;
}

/** Percentile + mix columns shared by the window aggregates below. */
function scaleAggregate(
  perScale: Array<Record<string, unknown>>,
): Pick<RecallHealth, 'topScoreP50' | 'topScoreP90' | 'topScoreScale' | 'topScoreSamples' | 'scaleMix'> {
  const scaleMix: Record<string, number> = {};
  for (const s of perScale) scaleMix[String(s.scale)] = Number(s.scored ?? 0);
  // Dominant = most scored rows. 'unknown' can never be dominant: its rows are
  // of INDETERMINATE scale, so a percentile over them is the same mixing bug.
  const ranked = perScale
    .filter((s) => String(s.scale) !== 'unknown' && Number(s.scored ?? 0) > 0)
    .sort((a, b) => Number(b.scored ?? 0) - Number(a.scored ?? 0));
  const top = ranked[0];
  return {
    topScoreP50: top?.p50 == null ? null : Number(top.p50),
    topScoreP90: top?.p90 == null ? null : Number(top.p90),
    topScoreScale: top ? (String(top.scale) as ScoreScale) : null,
    topScoreSamples: top ? Number(top.scored ?? 0) : 0,
    scaleMix,
  };
}

/** One-roundtrip trailing-window aggregate for the memory-health card. */
export async function readRecallHealth(sql: Sql): Promise<RecallHealth> {
  const rows = (await sql`
    WITH scoped AS (
      SELECT hit_count, fragment_count, top_score,
             CASE
               WHEN score_scale IS NOT NULL THEN score_scale
               WHEN top_score IS NULL THEN 'unknown'
               WHEN top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
               WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
               ELSE 'unknown'
             END AS scale
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - interval '7 days'
    ),
    per_scale AS (
      SELECT scale,
             count(*)::int AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score) AS p90
        FROM scoped WHERE top_score IS NOT NULL GROUP BY scale
    )
    SELECT
      (SELECT count(*) FROM scoped)::int                            AS recalls,
      (SELECT count(*) FROM scoped WHERE hit_count = 0)::int        AS zero_hits,
      (SELECT coalesce(sum(fragment_count), 0) FROM scoped)::int    AS fragment_hits,
      (SELECT coalesce(jsonb_agg(to_jsonb(per_scale)), '[]'::jsonb) FROM per_scale) AS per_scale
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const recalls = Number(r.recalls ?? 0);
  const zeroHit = Number(r.zero_hits ?? 0);
  return {
    recalls7d: recalls,
    zeroHit7d: zeroHit,
    zeroHitRate7d: recalls > 0 ? zeroHit / recalls : 0,
    ...scaleAggregate(Array.isArray(r.per_scale) ? (r.per_scale as Array<Record<string, unknown>>) : []),
    fragmentHits7d: Number(r.fragment_hits ?? 0),
  };
}

/** Per-surface slice of the same trailing-window aggregate. */
export interface RecallSurfaceHealth extends RecallHealth {
  surface: string;
}

/**
 * The SAME 7-day aggregate as readRecallHealth, segmented per surface
 * (orient-recall-quality-2026-07-12 P-006). With every entry point stamping its
 * own surface (search / orient / initialize / turn-start / claim / create / …,
 * P-001 + memory-delivery P-005), the blended aggregate can hide a
 * single-surface regression — e.g. orient's zero-hit-rate spiking (intent
 * queries too narrow, index degraded for short statements) while chat search
 * stays healthy. One GROUP BY roundtrip, busiest surfaces first. Consumed by
 * the memory-health read (knowledge-read.ts); the drift ALERTING for live
 * retrieval stays with the recall canary (recall-canary.ts) — this is the
 * observability slice, not a third alert system.
 */
/** One pool's trailing-window recall health (migration 703 / P-026). */
export interface RecallPoolHealth {
  /** Surface the pool was recalled under (turn-start, orient, …). */
  surface: string;
  /** Pool name as the writer stamped it (user | harness | hive). */
  pool: string;
  /** Recalls in the window where this pool participated. */
  recalls: number;
  /** Of those, how many returned NOTHING from this pool. */
  zeroHit: number;
  /** zeroHit / recalls. THE gate-2 detector: a pool keyed on a scope nothing
   *  writes to sits at 1.0 while the blended surface zero-hit-rate reads 0.0. */
  zeroHitRate: number;
  /** Of those, how many returned exactly the pool's own budget. */
  saturated: number;
  /** saturated / recalls. THE gate-4 detector: a top-K selector that always
   *  fills its budget is sizing the result by the limit, not by relevance. */
  saturationRate: number;
  /** Median hits contributed by this pool. */
  hitsP50: number | null;
  /** Median of this pool's OWN top score — not maskable by a sibling pool.
   *  Single-scale: see `scoreScale`, which is part of this row's identity. */
  topScoreP50: number | null;
  /** The scale `topScoreP50` is on (P-036). Part of the GROUP BY key, not a
   *  decoration: the same surface+pool appears once PER SCALE, because
   *  medianing a pool's rrf rows together with its cosine rows reports the
   *  backend mix rather than the pool's retrieval quality. */
  scoreScale: ScoreScale;
  /** Distinct scope keys this pool was queried under in the window. A pool
   *  whose scope set CHANGED mid-window is the unmigrated-rename signature. */
  scopes: string[];
  /** Of `recalls`, how many ASKED this pool under an EMPTY scope list.
   *
   *  ⚠ Not derivable from `scopes`, and that is the whole point (D-035). That
   *  field aggregates DISTINCT scope keys across the entire group, so a pool
   *  queried with no scope on 70% of its recalls and one scope on the other 30%
   *  still presents a perfectly healthy non-empty scope array. Only a row-level
   *  count can see it. */
  emptyScope: number;
  /** emptyScope / recalls. THE gate-3 detector.
   *
   *  Why this cannot be folded into `zeroHitRate`: a pool that returned nothing
   *  BECAUSE IT WAS ASKED FOR NOTHING and a pool that was asked correctly and
   *  genuinely held nothing relevant are indistinguishable in any hit-count
   *  aggregate — and they have OPPOSITE remedies (pass the scope vs. fix the
   *  scope key / fill the corpus). Measured live 2026-08-01: `turn-start/harness`
   *  sat at 68.8% empty-scope, under the 0.85 zero-hit gate and therefore
   *  invisible to gate-2; `initialize/harness` was the mirror image at 98.8%
   *  zero-hit with 0% empty-scope — same alarm, different bug. */
  emptyScopeRate: number;
  /** Active memories REACHABLE by this slice's recalls — the recall-weighted
   *  mean, over the window, of the corpus behind the scope keys each recall
   *  actually asked under. `null` when the slice asked under no scope at all
   *  (unknown, not zero — that is gate-3's signal, not gate-2's).
   *
   *  ⚠ This is gate-2's POWER TERM, and it exists because `zeroHitRate` alone
   *  confounds a starved pool with a healthy pool asked a specific question.
   *  Measured 2026-08-19, ONE scope (`hive:papercusp`, 58 active memories,
   *  0% empty-scope) read 0.000 zero-hit on `initialize` (n=19,125) and 0.874
   *  on `mid-turn` (n=207,390) — a 0.000→0.874 span driven purely by the
   *  surface's query specificity, with the corpus held constant. The 0.85 gate
   *  therefore sits INSIDE the normal band for a small corpus, which is how
   *  EI-19920080383279759 stayed CRITICAL for 11 days on a false alarm.
   *  Above a few hundred memories, sparsity can no longer explain a near-total
   *  blackout, so the raw rate becomes trustworthy again — see
   *  `effectiveZeroHitGate` in learning-slo.ts for how the bar is scaled. */
  corpusActive: number | null;
}

/**
 * Per-POOL slice of the trailing window (context-injection-audit-2026-07-28
 * P-026). The sibling of readRecallHealthBySurface, one level down.
 *
 * readRecallHealthBySurface can only see a surface's BLENDED result, and the
 * push path concatenates three independently-budgeted pools before it is
 * recorded — so a pool contributing nothing on every single call reads as a
 * perfectly healthy surface as long as the other two fill the block. That is
 * not hypothetical: it is exactly how a harness pool orphaned by an unmigrated
 * slug rename stayed invisible while its surface reported a 0.0% zero-hit rate.
 *
 * `saturationRate` is the same argument for the budget: a pool that returns
 * exactly its limit on ~every call is not answering "what is relevant", it is
 * answering "what is the limit" — and comparing hits against the limit STORED
 * ON THE ROW keeps that true across constant retunes.
 *
 * Rows written before migration 703 have `pools IS NULL` and are excluded, so
 * the counts here are honestly smaller than the surface aggregate's until the
 * window rolls past the deploy. One GROUP BY roundtrip.
 */
export async function readRecallHealthByPool(
  sql: Sql,
  opts: { days?: number; hours?: number; surface?: string } = {},
): Promise<RecallPoolHealth[]> {
  // `hours` (EI-<gate-3-recency>) is the finer-grained sibling of `days` — a
  // caller that wants a RECENT sub-window (hours) rather than the default
  // trailing week passes it directly; days is still floored/×24'd for the
  // existing callers so their numeric window is byte-identical to before.
  const hours =
    Number.isFinite(opts.hours) && (opts.hours as number) > 0
      ? (opts.hours as number)
      : (Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.floor(opts.days as number) : 7) * 24;
  // Parameterized, not a conditional sql`` fragment — see readRecallQueryHealth
  // for why: the `${cond ? sql`…` : sql``}` idiom invokes the tagged template in
  // BOTH branches, issuing a phantom call that a call-counting test double
  // cannot distinguish from a real query and leaving an unawaited promise that
  // surfaces as an unhandled rejection outside any test.
  const poolSurfaceFilter = opts.surface ?? null;
  const rows = (await sql`
    WITH corpus AS (
      -- Active memories per SCOPE KEY — gate-2's denominator (RecallPoolHealth
      -- .corpusActive). Small: one row per distinct scope, ~60 on this box.
      -- ⚠ D-013 / WI-9355: row_kind = 'memory' is MANDATORY. Entity-graph rows
      -- share this table and outnumber real memories ~7:1, so a count that
      -- omits it over-reports the corpus ~8x — which would silently relax the
      -- very gate this column exists to tighten.
      SELECT user_id AS scope_key, count(*)::int AS n
      FROM harness_shared.memory_canonical
      WHERE row_kind = 'memory' AND state = 'active' AND user_id IS NOT NULL
      GROUP BY user_id
    ),
    exploded AS (
      SELECT
        s.surface,
        p.key                                   AS pool,
        (p.value ->> 'hits')::int               AS hits,
        (p.value ->> 'limit')::int              AS budget,
        (p.value ->> 'top')::double precision   AS top,
        -- Every pool top came from the same backend call as the row's
        -- top_score, so the row-level scale governs them all (P-036).
        CASE
          WHEN s.score_scale IS NOT NULL THEN s.score_scale
          WHEN s.top_score IS NULL THEN 'unknown'
          WHEN s.top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
          WHEN s.top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
          ELSE 'unknown'
        END                                     AS scale,
        p.value -> 'scopes'                     AS scopes,
        -- D-035 / gate-3: was this pool asked under NO scope at all? Counted
        -- per ROW here because the scope_keys aggregate below cannot express
        -- it — see RecallPoolHealth.emptyScope. A missing scopes key and an
        -- explicit [] are the same condition (asked for nothing), so coalesce
        -- rather than letting NULL fall out of the count.
        jsonb_array_length(coalesce(p.value -> 'scopes', '[]'::jsonb)) = 0
                                                AS empty_scope,
        -- Active memories THIS recall could reach: the sum over the scope keys
        -- it actually asked under. Summed (not averaged) because a recall asks
        -- all of its keys at once, so their corpora pool. NULL — not 0 — when
        -- it asked under NO scope: that is "unknown", and conflating it with a
        -- real empty corpus would let gate-3's population drag gate-2's
        -- denominator toward zero and re-tighten the bar on exactly the rows
        -- that were never queried at all.
        rc.row_corpus                           AS row_corpus
      FROM harness_shared.memory_recall_stats s
      CROSS JOIN LATERAL jsonb_each(s.pools) AS p(key, value)
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(sk.scope) = 0 THEN NULL
                    ELSE sum(coalesce(c.n, 0))::int END      AS row_corpus
        FROM jsonb_array_elements_text(coalesce(p.value -> 'scopes', '[]'::jsonb)) AS sk(scope)
        LEFT JOIN corpus c ON c.scope_key = sk.scope
      ) rc ON true
      WHERE s.pools IS NOT NULL
        AND s.created_at >= now() - make_interval(hours => ${hours}::int)
        AND (${poolSurfaceFilter}::text IS NULL OR s.surface = ${poolSurfaceFilter}::text)
    )
    SELECT
      surface,
      pool,
      scale,
      count(*)::int                                          AS recalls,
      count(*) FILTER (WHERE hits = 0)::int                  AS zero_hits,
      count(*) FILTER (WHERE budget > 0 AND hits >= budget)::int AS saturated,
      count(*) FILTER (WHERE empty_scope)::int                AS empty_scope,
      -- Recall-WEIGHTED: avg over rows, so a slice whose scope set is dominated
      -- by one busy key is described by THAT key's corpus, not by the unweighted
      -- mean of every key it ever touched. Measured 2026-08-19: initialize/harness
      -- spans 26 distinct scope keys of which 21 hold nothing, so an unweighted
      -- median reads 0 while ~all of its 30k recalls ask a 1,975-memory scope.
      -- ⚠ THE BLEND IS REAL AND MEASURED INERT — do not "fix" it without
      -- re-measuring first (EI-20883740453844956, investigated 2026-08-19).
      -- This GROUP BY is (surface, pool, scale), which is COARSER than the
      -- scope key row_corpus is derived from, so one group can average
      -- heterogeneous corpora. Measured over BOTH the current 7d window and
      -- the 2026-08-01 incident window, every group is either homogeneous
      -- (min = max) or straddling with a zeroHitRate so far from the bar that
      -- avg / min / max imply the SAME verdict: NOT ONE live verdict changes
      -- under any of the three estimators. The obvious hardening — judge by
      -- min(row_corpus) to fail toward silence — was designed, calibrated
      -- against the aug-01 true positive (initialize/harness, 1.0000 zero at a
      -- uniform 1,975 corpus: fires under all three), and DROPPED as dead
      -- complexity: it adds a required field to this exported interface and a
      -- second corpus estimator to reason about, and moves no verdict.
      -- It becomes material only if a group ever straddles a knee (100 / 500,
      -- see effectiveZeroHitGate) AND its rate lands BETWEEN the two implied
      -- bars. That conjunction is the thing to re-measure — not the spread.
      -- Sub-case, also measured: a recall asking a scope that EXISTS but holds
      -- nothing (row_corpus = 0) is a guaranteed zero-hit and is counted as a
      -- retrieval miss. Confirmed at exactly 1.0000 zero-hit — and 0.8% of one
      -- group (244/29,252 initialize/harness), moving its rate 0.3964 to 0.3916.
      avg(row_corpus)                                        AS corpus_active,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY hits)      AS hits_p50,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top)
        FILTER (WHERE top IS NOT NULL)                       AS top_p50,
      coalesce(
        jsonb_agg(DISTINCT sc.scope) FILTER (WHERE sc.scope IS NOT NULL),
        '[]'::jsonb
      )                                                      AS scope_keys
    FROM exploded
    LEFT JOIN LATERAL jsonb_array_elements_text(scopes) AS sc(scope) ON true
    GROUP BY surface, pool, scale
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const zeroHit = Number(r.zero_hits ?? 0);
    const saturated = Number(r.saturated ?? 0);
    const emptyScope = Number(r.empty_scope ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      pool: String(r.pool ?? 'unknown'),
      scoreScale: (r.scale ? String(r.scale) : 'unknown') as ScoreScale,
      recalls,
      zeroHit,
      zeroHitRate: recalls > 0 ? zeroHit / recalls : 0,
      saturated,
      saturationRate: recalls > 0 ? saturated / recalls : 0,
      hitsP50: r.hits_p50 == null ? null : Number(r.hits_p50),
      topScoreP50: r.top_p50 == null ? null : Number(r.top_p50),
      scopes: Array.isArray(r.scope_keys) ? (r.scope_keys as unknown[]).map(String) : [],
      emptyScope,
      emptyScopeRate: recalls > 0 ? emptyScope / recalls : 0,
      corpusActive: r.corpus_active == null ? null : Number(r.corpus_active),
    };
  });
}

/** A surface's rows whose DECLARED scale disagrees with their own values. */
export interface RecallScaleContradiction {
  surface: string;
  /** The scale the writer stamped on the row (`score_scale`). */
  declaredScale: string;
  /** Labelled, scored rows for this surface+scale in the window. */
  rows: number;
  /** Of those, how many sit in a range that scale cannot produce. */
  contradicting: number;
  /** contradicting / rows. */
  contradictionRate: number;
  /** Range of the offending values, for the finding body. */
  minOffending: number | null;
  maxOffending: number | null;
}

/**
 * Rows whose `score_scale` LABEL contradicts the value it labels (P-037 gate-5).
 *
 * WHY THIS IS THE RIGHT SCORE-SIDE ALARM, and the two obvious alternatives are
 * not. P-037 asks for "per-surface score distribution against the correct
 * scale". The tempting readings both fail:
 *
 *   • An absolute threshold on `top_score` is the D-001 error itself — 0.03 is
 *     broken retrieval on the cosine scale and a perfect rank-1 hit on rrf.
 *     That comparison is what this whole audit had to retract.
 *   • An "unlabelled rate" alarm looks appealing (migration 705 gave every
 *     writer a label) but MEASURED FALSE on 2026-08-01: `search` sat at 96.8%
 *     unlabelled purely because `Mem0Backend.scoreScale` was committed and NOT
 *     yet deployed — the release checkout carried an older submodule pin. An
 *     alarm on that fires a critical at every pending pin, which is precisely
 *     the false-positive class this plan exists to stop. Those rows are also
 *     not even uninterpretable: `classifyLegacyScoreScale` resolves them by
 *     range.
 *
 * A CONTRADICTION, by contrast, cannot be explained by deploy lag, by workload
 * mix, or by a legacy row: it means the discriminator that every downstream
 * reader trusts is lying, silently re-enabling the D-001 mixing bug for all of
 * them. It reads 0 across every surface today, so it is quiet by construction
 * and fires only on a genuine regression.
 *
 * Only LABELLED, SCORED rows participate — an unlabelled row has nothing to
 * contradict, and including it would smuggle the rejected alarm back in.
 * 'lexical' and 'unknown' are excluded as declared scales: lexical is ordering-
 * only with no defined admissible band, and 'unknown' is the absence of a claim.
 */
export async function readRecallScaleContradictions(
  sql: Sql,
  opts: { days?: number } = {},
): Promise<RecallScaleContradiction[]> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.floor(opts.days as number) : 7;
  const rows = (await sql`
    WITH labelled AS (
      SELECT surface,
             score_scale,
             top_score,
             -- rrf is bounded ABOVE by (1+lexWeight)/(k+1); cosine is floored
             -- BELOW on admission. A value on the wrong side of its own
             -- label's bound is arithmetically impossible for that scale.
             CASE
               WHEN score_scale = 'rrf'    AND top_score > ${RRF_SCORE_CEILING}      THEN true
               WHEN score_scale = 'cosine' AND top_score < ${COSINE_ADMISSION_FLOOR} THEN true
               ELSE false
             END AS contradicts
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - make_interval(days => ${days}::int)
         AND score_scale IN ('rrf', 'cosine')
         AND top_score IS NOT NULL
    )
    SELECT surface,
           score_scale,
           count(*)::int                                    AS rows_n,
           count(*) FILTER (WHERE contradicts)::int         AS contradicting,
           min(top_score) FILTER (WHERE contradicts)        AS min_offending,
           max(top_score) FILTER (WHERE contradicts)        AS max_offending
      FROM labelled
     GROUP BY surface, score_scale
    HAVING count(*) FILTER (WHERE contradicts) > 0
     ORDER BY count(*) FILTER (WHERE contradicts) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const total = Number(r.rows_n ?? 0);
    const contradicting = Number(r.contradicting ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      declaredScale: String(r.score_scale ?? 'unknown'),
      rows: total,
      contradicting,
      contradictionRate: total > 0 ? contradicting / total : 0,
      minOffending: r.min_offending == null ? null : Number(r.min_offending),
      maxOffending: r.max_offending == null ? null : Number(r.max_offending),
    };
  });
}

/**
 * The length under which a query is counted "short" by
 * `readRecallQueryHealth`. 40 is not arbitrary and not a threshold anything
 * acts on: it is exactly the `MIN_PROMPT_CHARS` gate that P-035 (F-E) DELETED,
 * so the bucket answers a specific historical question — how much traffic that
 * gate was silently dropping.
 *
 * ⚠ DESCRIPTIVE ONLY. This must never become a gate again. The gate was deleted
 * because prompt length does not predict recall signal (it dropped the owner's
 * 23-char question while a 40-char pleasantry sailed through), and relevance is
 * now decided by the relevance floor. A high "short query" rate is a fact about
 * the traffic mix, NOT evidence that short prompts should be skipped.
 */
export const SHORT_QUERY_CHARS = 40;

/** Per-surface shape of what was ASKED in the window (migration 706 / P-041). */
export interface RecallQueryHealth {
  surface: string;
  /** Rows in the window that recorded a query shape (pre-706 rows excluded). */
  recalls: number;
  /** Of those, how many carried a turn-origin envelope — i.e. the query text
   *  was a relayed machine-injected prompt rather than something typed. */
  machineOrigin: number;
  /** machineOrigin / recalls. */
  machineOriginRate: number;
  /** Claimed origins → count. `(no-envelope)` covers the rest; see the note on
   *  `readRecallQueryHealth` — its meaning is surface-dependent. */
  originMix: Record<string, number>;
  /** Median query length (chars actually embedded). */
  charsP50: number | null;
  /** 10th-percentile query length — where the near-empty tail lives. */
  charsP10: number | null;
  /** Queries shorter than SHORT_QUERY_CHARS — descriptive, never a gate. */
  shortQueries: number;
  /** shortQueries / recalls. */
  shortQueryRate: number;
  /** Rows that HAVE a predecessor in the same session+surface, i.e. rows for
   *  which "is this a repeat" is even a defined question. */
  repeatEligible: number;
  /** Of those, how many repeated the previous query's hash exactly. */
  repeats: number;
  /** repeats / repeatEligible (0 when nothing is eligible). */
  repeatRate: number;
}

/**
 * Per-surface aggregate of the QUERY side of recall (P-041 / migration 706) —
 * the sibling of readRecallHealthBySurface, on the other half of the call.
 *
 * Everything else in this module measures what a recall RETURNED. That side is
 * structurally incapable of answering whether the QUERY was any good: the push
 * path's `top_score` is an RRF rank, so something is always rank 1 and the
 * number is identical for a precise question and for the word "continue"
 * (D-015). This is the read that makes query quality visible at all.
 *
 * ⚠ THE REPEAT RATE EXCLUDES SESSION-LESS ROWS, DELIBERATELY. Postgres treats
 * NULLs as equal in a PARTITION BY, so lagging over `session_id` with the pull
 * path's NULLs included would silently lump every session-less recall on the
 * box into ONE partition and compare one agent's query against an unrelated
 * agent's — manufacturing both false repeats and false non-repeats at a rate
 * that would look entirely plausible. `repeatEligible` is reported alongside
 * `repeats` so the denominator is never guessed at.
 *
 * ⚠ `originMix`'s `(no-envelope)` bucket is SURFACE-DEPENDENT and must not be
 * read as "human-typed" globally. On `turn-start` the query IS the submitted
 * prompt, so no envelope does mean owner-typed. On a surface that builds its
 * own query (orient, claim, brief, the cup-wake dossier) there was never an
 * envelope to carry, and the absence says nothing about a human.
 */
export async function readRecallQueryHealth(
  sql: Sql,
  opts: { days?: number; surface?: string } = {},
): Promise<RecallQueryHealth[]> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.floor(opts.days as number) : 7;
  // The optional surface filter is a PARAMETER, not a conditional sql`` fragment.
  // The house idiom `${cond ? sql`AND x = ${v}` : sql``}` invokes the tagged
  // template in BOTH branches — including the empty one — so it issues an extra
  // call that a call-counting test double cannot distinguish from a real query,
  // and (worse) the resulting promise is never awaited, surfacing as an
  // unhandled rejection that fails the suite from outside any test. One
  // parameterized predicate has neither problem and plans identically here.
  const surfaceFilter = opts.surface ?? null;
  const rows = (await sql`
    WITH scoped AS (
      SELECT surface, session_id, query_chars, query_sha256, query_origin, created_at, id
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - make_interval(days => ${days}::int)
         AND query_sha256 IS NOT NULL
         AND (${surfaceFilter}::text IS NULL OR surface = ${surfaceFilter}::text)
    ),
    -- Sequenced ONLY over rows that carry a session. See the doc comment: a
    -- NULL session_id would form one giant cross-agent partition.
    seq AS (
      SELECT surface, query_sha256,
             lag(query_sha256) OVER (PARTITION BY session_id, surface ORDER BY created_at, id) AS prev_sha
        FROM scoped WHERE session_id IS NOT NULL
    ),
    repeats AS (
      SELECT surface,
             count(*) FILTER (WHERE prev_sha IS NOT NULL)::int                       AS eligible,
             count(*) FILTER (WHERE prev_sha IS NOT NULL AND prev_sha = query_sha256)::int AS repeated
        FROM seq GROUP BY surface
    ),
    origins AS (
      SELECT surface, coalesce(query_origin, '(no-envelope)') AS origin, count(*)::int AS n
        FROM scoped GROUP BY surface, coalesce(query_origin, '(no-envelope)')
    )
    SELECT
      s.surface,
      count(*)::int                                                   AS recalls,
      count(*) FILTER (WHERE s.query_origin IS NOT NULL)::int          AS machine_origin,
      count(*) FILTER (WHERE s.query_chars < ${SHORT_QUERY_CHARS})::int AS short_queries,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY s.query_chars)       AS chars_p50,
      percentile_cont(0.1) WITHIN GROUP (ORDER BY s.query_chars)       AS chars_p10,
      coalesce((SELECT jsonb_object_agg(o.origin, o.n) FROM origins o WHERE o.surface = s.surface), '{}'::jsonb) AS origin_mix,
      coalesce((SELECT r.eligible FROM repeats r WHERE r.surface = s.surface), 0)  AS repeat_eligible,
      coalesce((SELECT r.repeated FROM repeats r WHERE r.surface = s.surface), 0)  AS repeat_count
    FROM scoped s
    GROUP BY s.surface
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const machineOrigin = Number(r.machine_origin ?? 0);
    const shortQueries = Number(r.short_queries ?? 0);
    const repeatEligible = Number(r.repeat_eligible ?? 0);
    const repeats = Number(r.repeat_count ?? 0);
    const mixRaw = (r.origin_mix ?? {}) as Record<string, unknown>;
    const originMix: Record<string, number> = {};
    for (const [k, v] of Object.entries(mixRaw)) originMix[k] = Number(v ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      recalls,
      machineOrigin,
      machineOriginRate: recalls > 0 ? machineOrigin / recalls : 0,
      originMix,
      charsP50: r.chars_p50 == null ? null : Number(r.chars_p50),
      charsP10: r.chars_p10 == null ? null : Number(r.chars_p10),
      shortQueries,
      shortQueryRate: recalls > 0 ? shortQueries / recalls : 0,
      repeatEligible,
      repeats,
      repeatRate: repeatEligible > 0 ? repeats / repeatEligible : 0,
    };
  });
}

export async function readRecallHealthBySurface(sql: Sql): Promise<RecallSurfaceHealth[]> {
  // Segmenting by surface does NOT segment by scale — measured on the live
  // table, a single surface carries both scales on the same day (2026-07-28
  // `search`: 17 rrf-scale rows alongside 94 cosine-scale). So this aggregate
  // needs the same per-scale split as the global one; grouping by surface alone
  // would still blend.
  const rows = (await sql`
    WITH scoped AS (
      SELECT surface, hit_count, fragment_count, top_score,
             CASE
               WHEN score_scale IS NOT NULL THEN score_scale
               WHEN top_score IS NULL THEN 'unknown'
               WHEN top_score <= ${RRF_SCORE_CEILING} THEN 'rrf'
               WHEN top_score >= ${COSINE_ADMISSION_FLOOR} THEN 'cosine'
               ELSE 'unknown'
             END AS scale
        FROM harness_shared.memory_recall_stats
       WHERE created_at >= now() - interval '7 days'
    ),
    per_scale AS (
      SELECT surface, scale,
             count(*)::int AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score) AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY top_score) AS p90
        FROM scoped WHERE top_score IS NOT NULL GROUP BY surface, scale
    )
    SELECT
      s.surface,
      count(*)::int                                AS recalls,
      count(*) FILTER (WHERE s.hit_count = 0)::int AS zero_hits,
      coalesce(sum(s.fragment_count), 0)::int      AS fragment_hits,
      coalesce(
        (SELECT jsonb_agg(to_jsonb(p)) FROM per_scale p WHERE p.surface = s.surface),
        '[]'::jsonb
      )                                            AS per_scale
    FROM scoped s
    GROUP BY s.surface
    ORDER BY count(*) DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const recalls = Number(r.recalls ?? 0);
    const zeroHit = Number(r.zero_hits ?? 0);
    return {
      surface: String(r.surface ?? 'unknown'),
      recalls7d: recalls,
      zeroHit7d: zeroHit,
      zeroHitRate7d: recalls > 0 ? zeroHit / recalls : 0,
      ...scaleAggregate(Array.isArray(r.per_scale) ? (r.per_scale as Array<Record<string, unknown>>) : []),
      fragmentHits7d: Number(r.fragment_hits ?? 0),
    };
  });
}
