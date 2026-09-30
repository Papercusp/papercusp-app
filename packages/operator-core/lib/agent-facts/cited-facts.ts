/**
 * PROSE fact citations — the unguarded twin of the declared `assumptions` channel.
 *
 * ── WHY THIS EXISTS (EI-19465127338264010) ──────────────────────────────────
 *
 * Work-items routinely state their load-bearing inputs as prose references to a
 * `facts:assert` key — "Map=fact pot-backend-rename-map", "per fact
 * bg-host-restart-hold". Facts decay; work-items do not. So a long-lived item
 * accumulates citations to authorities that no longer resolve, and it still
 * READS as fully specified — which is strictly worse than citing nothing,
 * because the next agent to claim it spends real time chasing an authority that
 * cannot be produced. The filing item was one step from escalating a fabricated
 * owner-gated blocker on exactly this.
 *
 * MEASURED on the live corpus (2026-08-03, papercusp-workspace, non-terminal
 * items, this file's exact pattern): 229 of 18,232 items carry at least one
 * citation, spanning **152 distinct keys — of which only 15 still resolve
 * live.** 129 have decayed but are still RECOVERABLE (a row survives, carrying
 * the body); 8 are gone entirely.
 *
 * ⚠ An earlier note on the filing item put this at "22 of 25 dangling". That is
 * SUPERSEDED and was wrong in the direction that matters: it measured a much
 * narrower slice, and it framed the population as mostly UNRECOVERABLE when in
 * fact ~94% of dead citations can still be produced on demand. The corrected
 * shape is what this module is built around — see "WHY IT REPORTS RECOVERY".
 *
 * ── WHY THE DECAY IS NOT (MAINLY) THE TTL ───────────────────────────────────
 *
 * The filing blamed the 7d default TTL. Whole-table census that day: 3082 rows /
 * 2003 retracted / 465 expired / 252 cap-evicted / 614 live. RETRACTION
 * dominates, and cap-eviction (50 per scope) has no time guarantee at all — a
 * fact can die minutes after it is written. That is why the fix here is a READ-
 * side lens and not "extend the TTL on citation": no TTL protects against
 * retraction or eviction. (Eviction sets `retracted_at` alongside `evicted_at` —
 * store.ts — so an evicted fact resolves as `retracted` here, never as live.)
 *
 * ── WHY IT REPORTS RECOVERY, NOT JUST ABSENCE ───────────────────────────────
 *
 * The filing's own case (both keys gone without trace) is the MINORITY, and by a
 * wide margin: of the 137 cited keys that no longer resolve live, only **8** have
 * no row at all — the other **129** still hold retracted/expired/superseded rows
 * carrying their BODY. `foldFacts` filters those out, so
 * they are invisible to every ordinary surface — but they are perfectly readable
 * by key. So this lens hands the decayed authority's excerpt back inline rather
 * than merely warning that it is gone: the reader gets what they were about to
 * go looking for, in the same round-trip.
 *
 * ── WHY THIS IS NOT {@link resolveAssumptions} ──────────────────────────────
 *
 * That function answers a deliberately DIFFERENT question, and reusing it here
 * would emit false alarms. It resolves a CLOSER'S OWN declared keys against the
 * closer's scope set, most-specific-first (D-079 R2) — correct there, because a
 * bare key almost always means the one THEY asserted. A prose citation has no
 * such author: whoever wrote the summary may be long gone, and the fact may sit
 * under any agent's owner scope. Measured on the live corpus, ~15% of cited
 * key/scope pairs live in `owner`/`work_item`/`role` scopes that a work-item's
 * selector set does not cover — so selector-bound resolution would report
 * present-and-readable facts as DANGLING. A false alarm is a bug in the alarm,
 * so the question asked here is by KEY across every scope in the workspace, and
 * the preference is LIVE-first rather than specific-first.
 *
 * The two share what should be shared: the condition vocabulary
 * ({@link AssumptionCondition}), the citation grammar ({@link factCitationRef}),
 * the excerpt budget, and the fail-OPEN discipline below.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  FACT_PROVENANCE_QUOTE_CHARS,
  FACTS_PER_SCOPE_CAP,
  factCitationRef,
  type FactScope,
} from './store';
import type { AssumptionCondition } from './assumptions';

/**
 * The citation pattern, and it is TIGHT ON PURPOSE.
 *
 * The obvious pattern — `fact[: ]+(\w+)` — is a NOISE MACHINE, because it fires
 * on the ordinary English phrase "the fact that". Measured over the live corpus
 * before this was written, its top "keys" were `that` (75 items), `before` (23),
 * `with` (19), `rather` (17), `asserted` (17): ~90% false positives, i.e. a
 * permanent false-alarm generator, which is worse than no detector.
 *
 * Requiring **>= 3 hyphen-separated segments** — the shape of every real
 * `facts:assert` slug — measured **100% precision at full corpus scale**: all
 * 152 matches were genuine fact keys, with no English-word noise. That was
 * checked where it can actually fail, on the 8 keys that resolve to NOTHING
 * (`429-hard-proof`, `loop-wake-walls`, `stale-verdict-is-not-a-verdict`, …) —
 * a noise word would land in exactly that bucket and inflate the one count this
 * lens reports as unrecoverable. Every one of the 8 is a real slug.
 *
 * The leading `\b` additionally prevents "artifact: foo-bar-baz" from matching
 * (there is no word boundary inside "artifact", so `\bfact` cannot match its
 * tail) — measured, that guard removes exactly one live false positive
 * (`end-to-end`, from "artifact end-to-end") and drops no genuine citation.
 *
 * The `i` flag is safe despite `[a-z0-9]` then also matching uppercase: run
 * case-sensitively against the same corpus the key set is identical (152 both
 * ways), so it is not absorbing camelCase tails into bogus keys.
 *
 * PURE, and deliberately conservative: this lens must under-report rather than
 * cry wolf.
 */
export const CITED_FACT_KEY_RE = /\bfact[: ]+([a-z0-9]+(?:-[a-z0-9]+){2,})/gi;

/** Longest plausible slug; anything longer is prose that happened to hyphenate. */
const MAX_KEY_CHARS = 120;

/**
 * How many distinct citations one item's lens will resolve. Bounded because the
 * resolve is a DB read on a read path. Measured on the live corpus: the busiest
 * single item cites **2** keys, the mean is 1.07, and **no** item exceeds this
 * cap — so 10 is a ~5x safety valve, and an item that trips it is prose which
 * defeated the pattern rather than a real citation list.
 */
export const MAX_CITED_FACT_KEYS = 10;

/** Extract distinct cited fact keys from prose. PURE — no I/O, unit-tested without PG. */
export function extractCitedFactKeys(
  texts: readonly (string | null | undefined)[],
): { keys: string[]; truncated: boolean } {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    // A fresh lastIndex per scan: the shared /g literal is stateful across calls.
    CITED_FACT_KEY_RE.lastIndex = 0;
    for (const m of text.matchAll(CITED_FACT_KEY_RE)) {
      const key = (m[1] ?? '').toLowerCase();
      if (key && key.length <= MAX_KEY_CHARS) seen.add(key);
    }
  }
  const all = Array.from(seen);
  return { keys: all.slice(0, MAX_CITED_FACT_KEYS), truncated: all.length > MAX_CITED_FACT_KEYS };
}

/** One prose citation, resolved against the ledger. */
export interface CitedFact {
  key: string;
  condition: AssumptionCondition;
  /** The absolute versioned ref this resolved to; null when nothing was found. */
  ref: string | null;
  scope: FactScope | null;
  scopeRef: string | null;
  versionId: number | null;
  /**
   * The cited authority's body, quoted. PRESENT EVEN WHEN DECAYED — that is the
   * point (see the header): a retracted/expired fact is filtered out of every
   * fold but still readable by key, so the reader gets the authority inline
   * instead of a dead end.
   */
  excerpt?: string;
  /** The key resolved in more than one scope; `ref` names the one chosen. */
  otherScopes?: number;
  /**
   * The row was CAP-EVICTED (50-per-scope), not withdrawn by its author.
   *
   * Load-bearing, because eviction sets `retracted_at` alongside `evicted_at`
   * (store.ts) — so without this flag an evicted fact is indistinguishable from a
   * deliberate retraction, and the lens would report an INTENT that nobody had.
   * Telling a reader an authority "was withdrawn" when a cap quietly dropped it
   * is the same species of confident-but-wrong claim this whole module exists to
   * stop, so the two are kept apart.
   */
  evicted?: true;
}

interface CitedRow {
  id: string | number;
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  retracted: boolean;
  superseded: boolean;
  expired: boolean;
  evicted: boolean;
}

function excerptOf(body: string): string {
  const b = body.trim();
  return b.length <= FACT_PROVENANCE_QUOTE_CHARS ? b : `${b.slice(0, FACT_PROVENANCE_QUOTE_CHARS)}…`;
}

function conditionOf(r: CitedRow): AssumptionCondition {
  if (r.retracted) return 'retracted';
  if (r.expired) return 'lapsed';
  if (r.superseded) return 'superseded';
  return 'live';
}

/** A live row is what the reader actually wants; rank it first, then newest. PURE. */
function pickRow(rows: readonly CitedRow[]): CitedRow | undefined {
  const live = rows.filter((r) => !r.retracted && !r.expired && !r.superseded);
  const pool = live.length > 0 ? live : rows;
  return pool.reduce<CitedRow | undefined>(
    (best, r) => (best === undefined || Number(r.id) > Number(best.id) ? r : best),
    undefined,
  );
}

/** Group rows by key and choose one per key. PURE — the whole selection rule, testable without PG. */
export function selectCitedFacts(keys: readonly string[], rows: readonly CitedRow[]): CitedFact[] {
  return keys.map((key) => {
    const matching = rows.filter((r) => r.key === key);
    const chosen = pickRow(matching);
    if (!chosen) {
      return { key, condition: 'dangling' as const, ref: null, scope: null, scopeRef: null, versionId: null };
    }
    const scopes = new Set(matching.map((r) => `${r.scope}\x00${(r.scope_ref ?? '').trim()}`));
    return {
      key,
      condition: conditionOf(chosen),
      ref: factCitationRef({
        scope: chosen.scope,
        scopeRef: chosen.scope_ref,
        key: chosen.key,
        id: Number(chosen.id),
      }),
      scope: chosen.scope,
      scopeRef: chosen.scope_ref,
      versionId: Number(chosen.id),
      excerpt: excerptOf(chosen.body),
      ...(scopes.size > 1 ? { otherScopes: scopes.size - 1 } : {}),
      ...(chosen.evicted ? { evicted: true as const } : {}),
    };
  });
}

/**
 * Resolve prose citations against the ledger, BY KEY across every scope.
 *
 * FAILS OPEN, exactly as {@link resolveAssumptions} does and for a stronger
 * reason: this decorates a read rather than gating a write, so a ledger blip
 * must never make a work-item look under-specified. Every entry comes back
 * `unresolved` — never `dangling` — and {@link citedFactsWarning} then omits the
 * field entirely, because "I could not ask" is not a finding about the item.
 */
export async function resolveCitedFacts(
  keys: readonly string[],
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<CitedFact[]> {
  if (keys.length === 0) return [];
  let rows: CitedRow[];
  try {
    const sql = inject ?? getOrgPg().sql;
    const ws = opts.workspaceId ?? activeWorkspaceId();
    rows = await sql<CitedRow[]>`
      SELECT id, scope, scope_ref, key, body,
             (retracted_at IS NOT NULL) AS retracted,
             (superseded_at IS NOT NULL) AS superseded,
             (expires_at <= now()) AS expired,
             (evicted_at IS NOT NULL) AS evicted
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws}
         AND source_hive IS NULL
         AND key = ANY(${keys as string[]}::text[])
       ORDER BY id DESC`;
  } catch {
    return keys.map((key) => ({
      key,
      condition: 'unresolved' as const,
      ref: null,
      scope: null,
      scopeRef: null,
      versionId: null,
    }));
  }
  return selectCitedFacts(keys, rows);
}

/** The warn-only report surfaced on a read. */
export interface CitedFactsReport {
  cited: CitedFact[];
  /** Cited keys with NO row at all — the authority is genuinely unrecoverable. */
  dangling: number;
  /** Cited keys whose fact decayed but whose BODY is still quoted above. */
  decayed: number;
  /** More citations were found than the resolve cap; `cited` is the first slice. */
  truncated?: boolean;
  note: string;
}

const DECAYED: ReadonlySet<AssumptionCondition> = new Set(['lapsed', 'retracted', 'superseded']);

/**
 * Build the report — or `undefined` when there is nothing worth saying.
 *
 * WARN-ONLY, mirroring `checkpointStale`'s precedent on the same tool: a
 * citation that still resolves LIVE is not a problem, and emitting a field for
 * it would make the field's presence meaningless. `unresolved` entries are never
 * counted as a finding (see {@link resolveCitedFacts}) — collapsing "the ledger
 * says no" into "the ledger could not be consulted" is the exact conflation
 * {@link isDanglingCondition} exists to prevent, one layer down. PURE.
 */
export function citedFactsWarning(
  cited: readonly CitedFact[],
  opts: { truncated?: boolean } = {},
): CitedFactsReport | undefined {
  const dangling = cited.filter((c) => c.condition === 'dangling').length;
  const decayed = cited.filter((c) => DECAYED.has(c.condition)).length;
  if (dangling === 0 && decayed === 0) return undefined;

  const parts: string[] = [
    `This item's prose cites ${cited.length} fact key(s) as its authority; ${dangling + decayed} no longer resolve live.`,
  ];
  if (decayed > 0) {
    // The three decay paths mean DIFFERENT things for trust, and flattening them
    // into one "stale" would hand the reader a false intent — see CitedFact.evicted.
    const withdrawn = cited.filter((c) => c.condition === 'retracted' && !c.evicted).length;
    const evicted = cited.filter((c) => c.evicted).length;
    const lapsed = cited.filter((c) => c.condition === 'lapsed').length;
    const superseded = cited.filter((c) => c.condition === 'superseded').length;
    const how: string[] = [];
    if (withdrawn > 0) how.push(`${withdrawn} RETRACTED (deliberately withdrawn — the body is quoted, but its author judged it wrong; do not act on it without re-establishing the claim)`);
    if (evicted > 0) how.push(`${evicted} CAP-EVICTED (dropped by the ${FACTS_PER_SCOPE_CAP}-per-scope cap, NOT withdrawn — no one judged it wrong, it simply aged out of the scope)`);
    if (lapsed > 0) how.push(`${lapsed} EXPIRED (TTL lapsed; nobody disputed it)`);
    if (superseded > 0) how.push(`${superseded} SUPERSEDED (a NEWER version of this key exists — read that one)`);
    parts.push(
      `${decayed} DECAYED — filtered out of every fact fold, so they read as missing everywhere else, but the body SURVIVES and is quoted in \`excerpt\` here: ${how.join('; ')}.`,
    );
  }
  if (dangling > 0) {
    parts.push(
      `${dangling} DANGLING — no row under any scope, so that authority is unrecoverable. Do NOT treat the citation as specification, and do NOT escalate its absence as a contested directive: it more likely decayed than was withdrawn.`,
    );
  }
  parts.push(
    `A governing ruling belongs in a plan DECISION (plans:add-decision — no TTL, addressable as <slug>#D-NNN), never a fact: facts decay by four paths (expiry, retraction, supersession and a ${FACTS_PER_SCOPE_CAP}-per-scope cap eviction with no time guarantee).`,
  );
  return {
    cited: [...cited],
    dangling,
    decayed,
    ...(opts.truncated ? { truncated: true as const } : {}),
    note: parts.join(' '),
  };
}
