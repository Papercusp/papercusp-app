/**
 * recall-canary.ts — the memory recall canary RUN path (EI-10047).
 *
 * Known-item retrieval against the LIVE memory stack, READ-ONLY: sample real,
 * stable memories from the canonical store, derive deterministic queries from
 * their own content, freeze the (query → expected-id) pairs with a measured
 * baseline, then replay them on a schedule through `getMemoryBackend()` — the
 * exact backend/config the live memory:* tools serve — and alert when
 * recall@10 drops more than {@link RECALL_CANARY_ALERT_DROP} below baseline.
 *
 * Complementary to precision-monitor.ts, NOT overlapping: the precision bench
 * seeds a fixture corpus into an isolated bench schema (it detects code-path
 * regressions and floor drift), so it stays green while the LIVE deployment
 * silently degrades — the 2026-07-12 incident class: a schema migration the
 * store code didn't expect made every per-query search swallow a PG 42703 and
 * return nothing, detectable only by its sub-second latency. This canary hits
 * the live store, so that failure shows up as zeroHitRate ≈ 1 the next run.
 *
 * Read-only contract: the canary NEVER writes to the memory store — no
 * remember, no seeding, no bench schema. Its only writes are its own
 * bookkeeping tables (migration 580). Alert fires once per degraded episode
 * (state transition on the recorded run status, stateless across restarts)
 * and resolves on the next healthy run, mirroring embed-exhaustion-alert.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

import type { MemoryBackend, MemoryEntry, ScoreScale } from '../backend';
import { admitRecallHits, MEMORY_TEXT_CAP } from '../recall-admission';
import {
  loadLatestRecallCanarySet,
  recordRecallCanaryRun,
  saveRecallCanarySet,
  type RecallCanaryPair,
  type RecallCanaryRunMetrics,
  type RecallCanarySet,
  type RecallCanaryStatus,
} from './recall-canary-read';

/** Target number of frozen probe pairs. */
export const RECALL_CANARY_TARGET_PAIRS = 25;
/** Alert when recall@10 drops more than this below the frozen baseline (EI-10047: >5pt). */
export const RECALL_CANARY_ALERT_DROP = 0.05;
/** zeroHitRate at/above this is degraded outright — the swallowed-error blackout smell. */
export const RECALL_CANARY_ZERO_HIT_DEGRADED = 0.5;
/** Reseed (status 'decayed') when this fraction of targets no longer exists. */
export const RECALL_CANARY_DECAY_MISSING_FRAC = 0.4;
/** Sampling floor: memory bodies shorter than this can't yield a stable query. */
const MIN_BODY_CHARS = 120;
/** Sampling floor: only memories at least this old (churn-stable known items). */
const MIN_AGE_DAYS = 7;
/** Candidate pool to sample before query derivation filters it down. */
const CANDIDATE_POOL = 120;
/** Spread the set across pools — at most this many pairs per scope. */
const MAX_PAIRS_PER_SCOPE = 10;
const SEARCH_LIMIT = 10;
const SEARCH_CONCURRENCY = 4;

const CONDITION_KEY = 'memory-live-recall-canary:degraded';

/**
 * Derive the deterministic probe query for one memory body, or null when the
 * body is too thin to probe. Pure — exported for tests.
 *
 * - `fragment`: ~10 consecutive words starting 25% into the body (skips
 *   provenance prefixes and headers; exercises the full hybrid path with a
 *   phrase the lexical leg can also see).
 * - `keyword`: the 6 longest distinct words in original order (no exact
 *   phrase — leans on the semantic/embedding leg).
 */
export function deriveCanaryQuery(text: string, style: 'fragment' | 'keyword'): string | null {
  const words = text
    .replace(/\[[^\]]*\]/g, ' ') // bracketed provenance/tags carry no recall signal
    .replace(/[#*`>_|]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length < 16) return null;
  if (style === 'fragment') {
    const start = Math.floor(words.length * 0.25);
    return words.slice(start, start + 10).join(' ');
  }
  const seen = new Set<string>();
  const distinct = words.filter((w) => {
    const k = w.toLowerCase();
    if (w.length < 5 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (distinct.length < 4) return null;
  const top = new Set(
    [...distinct].sort((a, b) => b.length - a.length).slice(0, 6),
  );
  return distinct.filter((w) => top.has(w)).join(' ');
}

export interface CanaryCandidate {
  id: string;
  scope: string;
  text: string;
}

/**
 * Sample stable live memories: active, non-entity, long enough, old enough.
 * `ORDER BY md5(id::text)` = deterministic spread, so consecutive reseeds pick
 * a similar population and baselines stay comparable. Read-only.
 *
 * The `::text` cast is load-bearing, not decorative: `memory_canonical.id` is
 * `uuid`, and `md5()` has no `uuid` overload — the un-cast form threw
 * `function md5(uuid) does not exist` (PG 42883) on EVERY call. Because this
 * runs inside `runRecallCanary`'s outer try/catch (never-throw contract for
 * the scheduled step), the failure was swallowed to a console log nobody
 * reads and surfaced nowhere durable: the routine fired daily from
 * 2026-07-14 onward with zero rows ever written to
 * harness_shared.memory_live_recall_canary_run — the live memory-recall
 * degradation alert this canary exists to provide was never actually armed —
 * a "registered + wired + flag-ON but silently never executes" sibling of the
 * bash-substitution seeder class (EI-18749575523514756), found by that bug's
 * sibling sweep. Fixed 2026-07-27.
 */
export async function sampleCanaryCandidates(
  sql: Sql,
  poolSize: number = CANDIDATE_POOL,
): Promise<CanaryCandidate[]> {
  const rows = (await sql`
    SELECT id, payload->>'user_id' AS scope, payload->>'data' AS text
      FROM harness_shared.memory_canonical
     WHERE state = 'active'
       AND NOT (payload ? 'entityType')
       AND payload->>'user_id' IS NOT NULL
       AND length(coalesce(payload->>'data', '')) >= ${MIN_BODY_CHARS}
       AND created_at < now() - make_interval(days => ${MIN_AGE_DAYS})
     ORDER BY md5(id::text)
     LIMIT ${poolSize}
  `) as Array<{ id: string; scope: string; text: string }>;
  return rows.map((r) => ({ id: String(r.id), scope: String(r.scope), text: String(r.text) }));
}

/** Build up to `target` probe pairs, alternating styles, capped per scope. Pure. */
export function buildCanaryPairs(
  candidates: CanaryCandidate[],
  target: number = RECALL_CANARY_TARGET_PAIRS,
): RecallCanaryPair[] {
  const pairs: RecallCanaryPair[] = [];
  const perScope = new Map<string, number>();
  for (const c of candidates) {
    if (pairs.length >= target) break;
    if ((perScope.get(c.scope) ?? 0) >= MAX_PAIRS_PER_SCOPE) continue;
    const style: 'fragment' | 'keyword' = pairs.length % 3 === 2 ? 'keyword' : 'fragment';
    const query = deriveCanaryQuery(c.text, style) ?? deriveCanaryQuery(c.text, 'fragment');
    if (!query) continue;
    pairs.push({ memoryId: c.id, scope: c.scope, query, style });
    perScope.set(c.scope, (perScope.get(c.scope) ?? 0) + 1);
  }
  return pairs;
}

export interface PairMeasurement {
  scored: number;
  /** Target found in what the CONSUMER receives (post-admission). The number r@10 is built on. */
  hits: number;
  /** Probes where the CONSUMER received NOTHING — retrieval empty OR the gates ate it all. */
  zeroHits: number;
  /** Probes where the BACKEND returned nothing. The diagnostic that says WHICH layer went dark. */
  retrievalZeroHits: number;
  /** Target present in the RAW backend rows, before the consumer's gates. */
  retrievalHits: number;
  latencyP50Ms: number | null;
}

type SearchFn = (query: string, opts: { scope: string; limit: number }) => Promise<MemoryEntry[]>;

/**
 * Replay pairs through `search` (read-only), bounded concurrency, then run the results through
 * the CONSUMER-ADMISSION GATES (EI-10666).
 *
 * Why both numbers: `retrievalZeroHits` is what this canary used to measure — the backend
 * returning nothing. But a hit the backend returns and the consumer's gates then discard never
 * reaches an agent, and scoring that as a HIT is how the canary would have reported GREEN
 * straight through EI-10372 (backend returned 5, orient's floor dropped all 5, every agent's
 * fold was empty). So the ALARM reads `zeroHits` (what the consumer got) and the DIAGNOSTIC
 * keeps `retrievalZeroHits` (which layer went dark) — you need both to know where to look.
 *
 * `degraded` REGIME-SCOPES the relevance floor and must reflect what a consumer would actually
 * see right now (the EI-9031 marker). Passing `degraded: true` unconditionally would floor
 * healthy RRF scores (rank-1 ≈ 0.016 < 0.05) and re-create EI-10372 inside the canary itself.
 */
export async function measureCanaryPairs(
  search: SearchFn,
  pairs: readonly RecallCanaryPair[],
  opts: { degraded?: boolean; scoreScale?: ScoreScale | null } = {},
): Promise<PairMeasurement> {
  let hits = 0;
  let zeroHits = 0;
  let retrievalZeroHits = 0;
  let retrievalHits = 0;
  const latencies: number[] = [];
  const queue = [...pairs];
  async function worker(): Promise<void> {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const t0 = Date.now();
      const results = await search(p.query, { scope: p.scope, limit: SEARCH_LIMIT });
      latencies.push(Date.now() - t0);
      const top = results.slice(0, SEARCH_LIMIT);
      if (top.length === 0) retrievalZeroHits += 1;
      if (top.some((e) => e.id === p.memoryId)) retrievalHits += 1;

      // The same gates orient runs, from the same module — never a re-implementation.
      // Truncate exactly as the fold does: the char budget is charged against the capped text.
      const { admitted } = admitRecallHits(
        top.map((e) => ({ id: e.id, memory: e.text?.slice(0, MEMORY_TEXT_CAP), score: e.score })),
        { degraded: opts.degraded, scoreScale: opts.scoreScale },
      );
      if (admitted.length === 0) zeroHits += 1;
      if (admitted.some((e) => e.id === p.memoryId)) hits += 1;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, pairs.length || 1) }, () => worker()),
  );
  latencies.sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;
  return { scored: pairs.length, hits, zeroHits, retrievalZeroHits, retrievalHits, latencyP50Ms: p50 };
}

/** Test/seam injection — swap PG, the live backend, the flag, and the alert route. */
export interface RecallCanaryDeps {
  flag?: (installSlug: string) => Promise<boolean>;
  sql?: Sql;
  // 'searchLexical' is OPTIONAL on MemoryBackend and stays optional here — the
  // P-010 lexical-leg probe feature-tests it (`backend.searchLexical?.`), so a
  // backend without a lexical leg is still a valid canary backend.
  backend?: Pick<MemoryBackend, 'name' | 'search' | 'searchLexical' | 'scoreScale' | 'lexicalScoreScale'>;
  sample?: (sql: Sql) => Promise<CanaryCandidate[]>;
  /** Override the active-target check (map of id to its current recall scope). */
  verifyTargets?: (sql: Sql, ids: string[]) => Promise<Map<string, string | null>>;
  loadSet?: typeof loadLatestRecallCanarySet;
  saveSet?: typeof saveRecallCanarySet;
  record?: typeof recordRecallCanaryRun;
  /** Previous run's status (alert dedupe); default reads the latest run row. */
  prevStatus?: (sql: Sql, workspaceId: string) => Promise<RecallCanaryStatus | null>;
  /**
   * EI-10666: is a consumer's recall in the DEGRADED regime right now? This REGIME-SCOPES the
   * relevance floor exactly as it is scoped for orient — the floor is what can silently eat an
   * entire fold, and it only applies to a degraded response. Defaults to the live embedder
   * cooldown check (the same signal that stamps `degraded` on a memory:search response).
   */
  degradedRegime?: () => Promise<boolean> | boolean;
  notify?: (n: { title: string; body: string; conditionKey: string; workspaceId: string }) => Promise<void>;
  resolve?: (n: { conditionKey: string; workspaceId: string }) => Promise<void>;
  log?: (m: string) => void;
}

export type RecallCanaryOutcome =
  | { ran: false; skipReason: 'flag-off' }
  | { ran: false; skipReason: 'failed'; error: string }
  | { ran: true; status: RecallCanaryStatus; metrics: RecallCanaryRunMetrics; rowId: number };

async function defaultVerifyTargets(sql: Sql, ids: string[]): Promise<Map<string, string | null>> {
  const rows = (await sql`
    SELECT id, payload->>'user_id' AS scope FROM harness_shared.memory_canonical
     WHERE id = ANY(${ids as unknown as string[]}) AND state = 'active'
  `) as Array<{ id: string; scope: string | null }>;
  return new Map(rows.map((r) => [String(r.id), r.scope == null ? null : String(r.scope)]));
}

async function defaultPrevStatus(sql: Sql, workspaceId: string): Promise<RecallCanaryStatus | null> {
  try {
    const rows = (await sql`
      SELECT status FROM harness_shared.memory_live_recall_canary_run
       WHERE workspace_id = ${workspaceId} AND status IN ('ok', 'degraded')
       ORDER BY ran_at DESC LIMIT 1
    `) as Array<{ status: string }>;
    return rows.length > 0 ? (String(rows[0].status) as RecallCanaryStatus) : null;
  } catch {
    return null;
  }
}

async function defaultNotify(n: { title: string; body: string; conditionKey: string; workspaceId: string }): Promise<void> {
  const [{ notifyAttention }, { broadcastSevereEvent }] = await Promise.all([
    import('../../attention-notify'),
    import('../../severe-event-broadcast'),
  ]);
  await notifyAttention({
    kind: 'intervention',
    title: n.title,
    body: n.body,
    importance: 'urgent',
    workspaceId: n.workspaceId,
    data: { conditionKey: n.conditionKey },
  });
  await broadcastSevereEvent({
    summary: n.title,
    body: n.body,
    category: 'severe-event',
    conditionKey: n.conditionKey,
  });
}

async function defaultResolve(n: { conditionKey: string; workspaceId: string }): Promise<void> {
  const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
  await broadcastSevereEventResolved({
    conditionKey: n.conditionKey,
    summary: 'Memory recall canary recovered',
    body: 'A subsequent canary run scored at/above the alert threshold; the live-recall degradation condition cleared.',
  });
}

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(3);
}

/**
 * Seed (or reseed) the frozen canary set against the current live backend and
 * return the saved set. The measured recall of the fresh pairs IS the baseline.
 */
export async function seedRecallCanarySet(
  sql: Sql,
  backend: Pick<MemoryBackend, 'name' | 'search' | 'searchLexical' | 'scoreScale' | 'lexicalScoreScale'>,
  workspaceId: string,
  deps: Pick<RecallCanaryDeps, 'sample' | 'saveSet'> = {},
  degraded = false,
): Promise<{ set: RecallCanarySet; measured: PairMeasurement }> {
  const candidates = await (deps.sample ?? sampleCanaryCandidates)(sql);
  const pairs = buildCanaryPairs(candidates);
  if (pairs.length === 0) throw new Error('recall canary: no eligible live memories to sample');
  const measured = await measureCanaryPairs((q, o) => backend.search(q, o), pairs, {
    degraded,
    scoreScale: backend.scoreScale,
  });
  const baselineRAt10 = measured.scored > 0 ? measured.hits / measured.scored : 0;
  const saved = await (deps.saveSet ?? saveRecallCanarySet)(sql, workspaceId, {
    backend: backend.name,
    pairs,
    baselineRAt10,
  });
  return {
    set: {
      id: saved.id,
      version: saved.version,
      backend: backend.name,
      pairs,
      baselineRAt10,
      createdAt: new Date().toISOString(),
    },
    measured,
  };
}

/**
 * One scheduled canary tick: flag gate → (seed set if absent/stale) → verify
 * targets still exist → replay read-only → record → alert on the ok→degraded
 * transition, resolve on degraded→ok. Every failure is a non-fatal `failed`
 * outcome — monitoring must never wedge the routine.
 */
export async function runRecallCanary(
  input: { workspaceId: string; installSlug: string },
  deps: RecallCanaryDeps = {},
): Promise<RecallCanaryOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`[memory-live-recall-canary] ${m}`));
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.MEMORY_LIVE_RECALL_CANARY, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  try {
    let sql = deps.sql;
    if (!sql) {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql;
    }
    let backend = deps.backend;
    if (!backend) {
      const { getMemoryBackend } = await import('../backend');
      backend = getMemoryBackend();
    }

    // EI-10666: the regime a CONSUMER is in right now — it scopes the relevance floor below.
    // Fail-soft to the healthy regime: assuming `degraded` would floor healthy RRF scores
    // (rank-1 ≈ 0.016 < 0.05) and alarm on every run.
    let degradedRegime = false;
    try {
      if (deps.degradedRegime) degradedRegime = await deps.degradedRegime();
      else {
        const { isOpenAiEmbedInCooldown } = await import('../configure');
        degradedRegime = isOpenAiEmbedInCooldown();
      }
    } catch { /* unknown ⇒ healthy regime (never invent a degradation) */ }

    let set = await (deps.loadSet ?? loadLatestRecallCanarySet)(sql, input.workspaceId);
    let seededNote: string | null = null;

    // A backend flip invalidates the set (its targets/baseline belong to the
    // old store) — reseed rather than raise a false degradation alarm.
    if (set && set.backend !== backend.name) {
      seededNote = `backend changed ${set.backend} → ${backend.name}; reseeded`;
      set = null;
    }

    if (!set) {
      const { set: fresh, measured } = await seedRecallCanarySet(
        sql, backend, input.workspaceId, deps, degradedRegime,
      );
      const metrics: RecallCanaryRunMetrics = {
        setVersion: fresh.version,
        backend: backend.name,
        pairsTotal: fresh.pairs.length,
        pairsScored: measured.scored,
        pairsMissing: 0,
        hits: measured.hits,
        rAt10: fresh.baselineRAt10,
        baselineRAt10: fresh.baselineRAt10,
        delta: 0,
        zeroHitRate: measured.scored > 0 ? measured.zeroHits / measured.scored : null,
        retrievalZeroHitRate: measured.scored > 0 ? measured.retrievalZeroHits / measured.scored : null,
        retrievalRAt10: measured.scored > 0 ? measured.retrievalHits / measured.scored : null,
        latencyP50Ms: measured.latencyP50Ms,
        status: 'seeded',
        notes: seededNote ?? `seeded v${fresh.version} (${fresh.pairs.length} pairs)`,
      };
      const rowId = await (deps.record ?? recordRecallCanaryRun)(sql, input.workspaceId, metrics);
      log(`seeded set v${fresh.version}: baseline r@10=${fmt(fresh.baselineRAt10)} (${fresh.pairs.length} pairs)`);
      return { ran: true, status: 'seeded', metrics, rowId };
    }

    // Targets forgotten since freeze are excluded from scoring (natural churn,
    // not degradation). A target moved to a different recall scope also
    // invalidates the frozen comparison: replaying its old scope would count
    // an intentional pool move as retrieval loss and compare a changed cohort
    // against the original baseline. Reseed the whole set without alerting.
    const activeScopes = await (deps.verifyTargets ?? defaultVerifyTargets)(
      sql,
      set.pairs.map((p) => p.memoryId),
    );
    const living = set.pairs.filter((p) => activeScopes.get(p.memoryId) === p.scope);
    const missing = set.pairs.filter((p) => !activeScopes.has(p.memoryId)).length;
    const scopeChanged = set.pairs.filter(
      (p) => activeScopes.has(p.memoryId) && activeScopes.get(p.memoryId) !== p.scope,
    ).length;
    if (
      scopeChanged > 0 ||
      living.length === 0 ||
      missing / set.pairs.length > RECALL_CANARY_DECAY_MISSING_FRAC
    ) {
      const { set: fresh } = await seedRecallCanarySet(
        sql, backend, input.workspaceId, deps, degradedRegime,
      );
      const metrics: RecallCanaryRunMetrics = {
        setVersion: set.version,
        backend: backend.name,
        pairsTotal: set.pairs.length,
        pairsScored: 0,
        pairsMissing: missing,
        hits: 0,
        rAt10: null,
        baselineRAt10: set.baselineRAt10,
        delta: null,
        zeroHitRate: null,
        retrievalZeroHitRate: null,
        retrievalRAt10: null,
        latencyP50Ms: null,
        status: 'decayed',
        notes: scopeChanged > 0
          ? `set v${set.version} invalidated (${scopeChanged}/${set.pairs.length} active targets changed scope); reseeded v${fresh.version}`
          : `set v${set.version} decayed (${missing}/${set.pairs.length} targets gone); reseeded v${fresh.version}`,
      };
      const rowId = await (deps.record ?? recordRecallCanaryRun)(sql, input.workspaceId, metrics);
      log(
        scopeChanged > 0
          ? `set v${set.version} invalidated after scope changes; reseeded v${fresh.version}`
          : `set v${set.version} decayed; reseeded v${fresh.version}`,
      );
      return { ran: true, status: 'decayed', metrics, rowId };
    }

    const prev = await (deps.prevStatus ?? defaultPrevStatus)(sql, input.workspaceId);
    const measured = await measureCanaryPairs((q, o) => backend.search(q, o), living, {
      degraded: degradedRegime,
      scoreScale: backend.scoreScale,
    });
    // EI-10666: r@10 and zeroHitRate are measured AT THE CONSUMER (post-admission) — what an
    // agent actually receives. The retrieval-level pair is kept as the DIAGNOSTIC that says
    // which layer went dark.
    const rAt10 = measured.scored > 0 ? measured.hits / measured.scored : null;
    const zeroHitRate = measured.scored > 0 ? measured.zeroHits / measured.scored : null;
    const retrievalZeroHitRate =
      measured.scored > 0 ? measured.retrievalZeroHits / measured.scored : null;
    const retrievalRAt10 = measured.scored > 0 ? measured.retrievalHits / measured.scored : null;
    const delta = rAt10 == null ? null : rAt10 - set.baselineRAt10;

    // P-010 (memory-pg-lexical-own-injection-2026-07-13): probe the LEXICAL
    // leg directly on the same pairs. A blind lexical leg (schema drift, an
    // ILIKE/tokenizer regression, an empty leg after a backend flip) can hide
    // behind a fused product the cosine leg still carries — so it is measured
    // separately, RETRIEVAL-level (no admission gates: lexical scores are not
    // on the cosine scale). Feature-tested; a probe failure reads as blind
    // only if the fused product proves the store itself is serving rows.
    let lexMeasured: PairMeasurement | null = null;
    const lexSearch = backend.searchLexical?.bind(backend);
    if (lexSearch) {
      try {
        lexMeasured = await measureCanaryPairs((q, o) => lexSearch(q, o), living, {
          degraded: degradedRegime,
          scoreScale: backend.lexicalScoreScale,
        });
      } catch {
        lexMeasured = null;
      }
    }
    const lexRetrievalRAt10 =
      lexMeasured && lexMeasured.scored > 0 ? lexMeasured.retrievalHits / lexMeasured.scored : null;
    // BLIND = the lexical leg retrieved NOTHING for every probe while the
    // fused product still returned rows (store demonstrably non-empty).
    const lexBlind =
      lexSearch != null &&
      retrievalZeroHitRate != null &&
      retrievalZeroHitRate < 1 &&
      (lexMeasured == null ||
        (lexMeasured.scored > 0 && lexMeasured.retrievalZeroHits === lexMeasured.scored));

    const blackout = zeroHitRate != null && zeroHitRate >= RECALL_CANARY_ZERO_HIT_DEGRADED;
    const dropped = delta != null && delta < -RECALL_CANARY_ALERT_DROP;
    const status: RecallCanaryStatus = blackout || dropped || lexBlind ? 'degraded' : 'ok';

    // WHICH LAYER: the store returned rows and the consumer still got nothing ⇒ the gates ate
    // it (the EI-10372 shape). Naming the layer is the whole point of carrying both numbers —
    // "recall is dark" sends you to the store; this says whether the store was ever the problem.
    const decisionSideBlackout =
      blackout && retrievalZeroHitRate != null && retrievalZeroHitRate < zeroHitRate!;

    const metrics: RecallCanaryRunMetrics = {
      setVersion: set.version,
      backend: backend.name,
      pairsTotal: set.pairs.length,
      pairsScored: measured.scored,
      pairsMissing: missing,
      hits: measured.hits,
      rAt10,
      baselineRAt10: set.baselineRAt10,
      delta,
      zeroHitRate,
      retrievalZeroHitRate,
      retrievalRAt10,
      latencyP50Ms: measured.latencyP50Ms,
      status,
      notes: [
        // Lexical-leg visibility on every run (P-010): the leg's retrieval
        // r@10, or the blindness verdict.
        lexBlind
          ? 'LEXICAL LEG BLIND: zero lexical retrieval across all probes while the fused product served rows'
          : lexRetrievalRAt10 != null
            ? `lex r@10 ${fmt(lexRetrievalRAt10)}`
            : null,
        !blackout
          ? null
          : decisionSideBlackout
            ? 'zero-hit blackout DOWNSTREAM of retrieval — the store returned rows and the ' +
              'consumer-admission gates (relevance floor / budget) discarded them'
            : 'zero-hit blackout at RETRIEVAL — swallowed-store-error smell',
      ]
        .filter(Boolean)
        .join('; ') || null,
    };
    const rowId = await (deps.record ?? recordRecallCanaryRun)(sql, input.workspaceId, metrics);

    // Alert on the transition INTO degraded; resolve on the transition out.
    // State lives in the run rows, so restarts never re-fire or drop an edge.
    if (status === 'degraded' && prev !== 'degraded') {
      const body =
        `Live memory recall dropped on the canary set (v${set.version}, backend ${backend.name}): ` +
        `recall@10 ${fmt(rAt10)} vs baseline ${fmt(set.baselineRAt10)} (Δ ${fmt(delta)}), ` +
        `zero-hit rate ${fmt(zeroHitRate)} over ${measured.scored} probes ` +
        `(AT THE CONSUMER — post floor/budget; at retrieval it was ${fmt(retrievalZeroHitRate)}). ` +
        (decisionSideBlackout
          ? 'DECISION-SIDE BLACKOUT: the store RETURNED rows and the consumer-admission gates ' +
            'discarded them, so agents received an EMPTY recall fold while the backend looked ' +
            'healthy (the EI-10372 shape). Do not go looking at the store — check the relevance ' +
            'floor and its degraded-regime scoping in lib/memory/recall-admission.ts, and the ' +
            `embedder degradation that scoped it (degraded regime: ${degradedRegime}).`
          : blackout
            ? 'Most probes returned NOTHING FROM THE STORE — check for swallowed store errors (schema drift / migration mismatch, the PG 42703 class) and embedder/sidecar health.'
            : lexBlind
              ? 'LEXICAL LEG BLIND (P-010 probe): searchLexical retrieved nothing for every probe ' +
                'while the fused product still served rows — the exact-identifier recall column is ' +
                'dark. Check canonical-store lexicalSearch (tokenizer/ILIKE/schema drift) and the ' +
                'lexical leg wiring in the active hybrid backend.'
              : 'Check recent migrations, embedder config, and the memory backend selection.');
      await (deps.notify ?? defaultNotify)({
        title: 'Memory recall degraded — live canary below baseline',
        body,
        conditionKey: CONDITION_KEY,
        workspaceId: input.workspaceId,
      }).catch((e) => log(`alert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`));
    } else if (status === 'ok' && prev === 'degraded') {
      await (deps.resolve ?? defaultResolve)({
        conditionKey: CONDITION_KEY,
        workspaceId: input.workspaceId,
      }).catch((e) => log(`resolve failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`));
    }

    log(
      `run #${rowId} ${status}: r@10=${fmt(rAt10)} baseline=${fmt(set.baselineRAt10)} ` +
        `Δ=${fmt(delta)} zeroHit=${fmt(zeroHitRate)} (retrieval ${fmt(retrievalZeroHitRate)}) ` +
        `scored=${measured.scored} missing=${missing} degradedRegime=${degradedRegime}`,
    );
    return { ran: true, status, metrics, rowId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`canary failed (non-fatal): ${error}`);
    return { ran: false, skipReason: 'failed', error };
  }
}
