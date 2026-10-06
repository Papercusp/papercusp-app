/**
 * condition-object.ts — P-001 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * THE GAP THIS CLOSES. Work-items already carry complete ownership (`taken_by`,
 * `taken_at`, `expires_at` lease, `last_released_by`). Conditions already carry
 * keyed identity and an open/resolve lifecycle (`conditionKey`, 12 producers:
 * `green-stall:<slug>`, `main-behind-staging:<slug>`, `single-primary:<verdict>`,
 * `release-trigger-freeze:<slug>`, …). The two have never been JOINED, so a
 * condition has no row to own — and what cannot be owned gets re-filed by every
 * agent that notices it.
 *
 * Live cost, measured 2026-08-02/03: the `single-primary:no-primary` condition
 * was filed as SIX separate `kind=bug severity=major` work-items by six agents
 * inside ~2h15m (EI-19379911903391487, EI-19380641261443842, EI-19386236606467341,
 * EI-19388226125029209, EI-19388269294151851, EI-19388315447021730), plus a
 * seventh its own author retracted as a duplicate. None saw the others. Five are
 * still open.
 *
 * ⚠ THE WRITE SIDE ALREADY EXISTED — AND HAD NEVER ONCE BEEN USED. `work_items:link`
 * has shipped `rel:'about'` with a polymorphic `target_kind`/`target_ref` for
 * months, and its own guidance names "an event key" as a target. Measured before
 * writing this module: of 34,504 `coord_links` rows in this workspace, the
 * dst_kind histogram is topic/plan_item/issue/feature/plan/file — **zero** rows
 * with `dst_kind='event'`, ever.
 *
 * The reason is the reason this file is a READ and not a writer. `work_items:tag`
 * once wrote topic edges to `coord_links` that NEITHER claim-spec evaluator read
 * (EI-18654138087054247): it returned ok:true, round-tripped through
 * `work_items:get`, and the item still failed admission because the field the
 * claim path reads stayed NULL. An edge nobody reads is not a place. So the
 * missing half was never the ability to write the link — it was a resolver that
 * answers, from a condition key alone, "does this already have an owner?"
 *
 * WHAT IS DELIBERATELY NOT HERE. No new table, no new rel, no new object kind:
 * `rel='about'` and `kind='event'` are both existing vocabulary
 * (`LINK_RELS` in agent-tools/work_items/link.ts; `EVENT_SUBSCRIPTION_KIND` in
 * agent-tools/coordination/event-subscriptions.ts, whose migration-568 subscription
 * CHECK already admits 'event'). This module is a read over rows the substrate
 * can already store.
 *
 * SINGLETON-ness is NOT enforced here — a link edge cannot enforce it, and a
 * QUERY-based uniqueness check races (WI-6986 implemented exactly that and
 * duplicated "40 of 88 open rows" under a cross-machine race). Uniqueness lands
 * in P-002 as a PARTIAL UNIQUE INDEX, which Postgres serializes and a query
 * cannot. Until then this resolver reports what it finds, including duplicates,
 * via `duplicates` — reporting the mess honestly rather than pretending it is
 * resolved.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from '../agent-tools/coordination/log';
import { WORK_ITEM_TAG_SRC_KIND } from '../agent-tools/coordination/coupled-topic-sources';
import { EVENT_SUBSCRIPTION_KIND } from '../agent-tools/coordination/event-subscriptions';
import type { Sql } from 'postgres';
import { pgTimestampToIsoOrNull } from '../pg-timestamp';
import {
  assessCriticalClaimProgressLease,
  CRITICAL_CLAIM_PROGRESS_LEASE_MS,
} from '../agent-tools/work_items/release-force-guard';
// The dependency-free leaf, NOT ../release-checkpoint-launch: that module's static graph
// reaches release-checkpoint-config.ts's module-scope SELECT, and this file is imported by
// pot tool modules that must load without database I/O (WI-10005170).
import { CHECKPOINT_RUN_LOCK_STALE_MS } from '../release-checkpoint-lock';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { linkWorkItem, readWorkItemClaimHoldProvenance, unlinkWorkItem } from '../work-items';
import {
  classifyExternalConditionReachability,
  readEventConditionReachability,
  type ExternalConditionReachability,
} from '../external-condition-reachability';

/**
 * The rel that joins a work-item to the condition it concerns. Existing
 * vocabulary — `about` is defined in LINK_RELS as "this item concerns a target
 * (a topic, event key, or object)", which is exactly this edge.
 */
export const CONDITION_LINK_REL = 'about' as const;

/** Hard cap on rows returned by one resolve, so a pathological key cannot flood a caller. */
export const CONDITION_OBJECT_ROW_CAP = 200;

const CHECKPOINT_AWAIT_GLOBAL_EVENT_KEYS = [
  'release:green',
  'green-checkpoint:red',
  'green-checkpoint:inconclusive',
  'green-checkpoint:held',
] as const;

/**
 * Is a condition claimed, and is that claim still worth anything?
 *
 * EXPLICIT, never inferred from nulls by the caller. The distinction that earns
 * the enum is `held` vs `lease-expired`: both have a non-null `takenBy`, and a
 * reader that treats "someone is on it" as `takenBy != null` will report a dead
 * agent's abandoned lease as live ownership — which is worse than reporting no
 * owner at all, because it suppresses the next agent from picking it up. A
 * `hold-blocked` row is a deliberate claim exclusion, using the same attributed
 * provenance that `claim-hold-guard.ts` enforces, even when it is unassigned.
 */
export type ConditionClaimState = 'no-object' | 'claimable' | 'held' | 'lease-expired' | 'hold-blocked';

/** One work-item linked to a condition key. */
export interface ConditionWorkItemRow {
  workItem: string;
  title: string | null;
  status: string | null;
  takenBy: string | null;
  takenAt: string | null;
  /** Genuine item-scoped progress, distinct from the holder's process heartbeat. */
  lastProgressAt: string | null;
  expiresAt: string | null;
  /** Latest capped deadline from a pending same-holder checkpoint outcome await relevant to this condition. */
  checkpointAwaitCreatedAt?: string | null;
  checkpointAwaitExpiresAt?: string | null;
  /** Persisted work-item payload used to apply the claim-hold guard's provenance predicate. */
  payload?: unknown;
}

/** The resolved ownership of one condition key. */
export interface ConditionObject {
  conditionKey: string;
  /** The canonical (oldest open) linked work-item, or null when nothing is linked. */
  workItem: string | null;
  title: string | null;
  claimState: ConditionClaimState;
  takenBy: string | null;
  takenAt: string | null;
  /** Genuine item-scoped progress used by critical-claim recovery. */
  lastProgressAt: string | null;
  /** Effective condition-owner lease deadline (stored expiry or read-only derived expiry). */
  expiresAt: string | null;
  /**
   * Additional open work-items linked to the SAME key beyond the canonical one.
   * Empty once P-002's partial unique index lands; non-empty today is the
   * duplicate-filing problem this plan exists to remove, reported rather than hidden.
   */
  duplicates: readonly string[];
  /** Authoritative where the existing event ledger or live owning object proves it. */
  reachability?: ExternalConditionReachability;
}

/**
 * PURE. Decide a condition's claim state from its linked rows.
 *
 * Split out from the query on purpose: this is the part with the interesting
 * edge cases (expired lease, lease with no expiry, duplicate rows) and it is
 * unit-testable with no database at all.
 *
 * `nowMs` is injected rather than read from the clock so the lease-expiry
 * boundary is testable — a test that has to sleep to cross a real deadline is a
 * test that will be flaky in CI.
 */
export function resolveConditionObject(
  conditionKey: string,
  rows: readonly ConditionWorkItemRow[],
  nowMs: number,
): ConditionObject {
  if (rows.length === 0) {
    return {
      conditionKey,
      workItem: null,
      title: null,
      claimState: 'no-object',
      takenBy: null,
      takenAt: null,
      lastProgressAt: null,
      expiresAt: null,
      duplicates: [],
      reachability: classifyExternalConditionReachability({ registration: 'unmeasured' }, new Date(nowMs).toISOString()),
    };
  }

  // Prefer an active hold or a genuinely HELD row as the canonical one: a
  // deliberate claim exclusion or an active owner must not be masked by an
  // older unheld duplicate. Among protected rows the caller's ordering (oldest
  // first) stands, so the canonical item is stable across calls.
  const protectedRow = rows.find((r) => {
    const state = claimStateOf(r, nowMs);
    return state === 'hold-blocked' || state === 'held';
  });
  const canonical = protectedRow ?? rows[0];
  const duplicates = rows.filter((r) => r.workItem !== canonical.workItem).map((r) => r.workItem);

  return {
    conditionKey,
    workItem: canonical.workItem,
    title: canonical.title,
    claimState: claimStateOf(canonical, nowMs),
    takenBy: canonical.takenBy,
    takenAt: canonical.takenAt,
    lastProgressAt: canonical.lastProgressAt,
    expiresAt: effectiveConditionLeaseExpiresAt(canonical, nowMs),
    duplicates,
    reachability: classifyExternalConditionReachability(
      { liveResolver: true, registration: 'live' },
      new Date(nowMs).toISOString(),
    ),
  };
}

/**
 * PURE. Resolve the condition-owner lease deadline without changing the work-item row.
 *
 * Migration 866 deliberately removed the generic issue-family `expires_at` writer:
 * ordinary issue claims do not have a lease. A condition link is a narrower singleton
 * coordination surface, though, and a claimed condition owner must not hold that key
 * forever merely because its issue-family row has no stored expiry. Reuse the shared
 * critical-claim progress lease for this read-only fallback, and let newer genuine item
 * progress extend a legacy stored expiry that predates it. Missing progress and claim
 * anchors remain unmeasured (and therefore fail closed as held) unless the same holder
 * has a pending checkpoint await scoped to this pipeline's outcome keys. A pipeline-scoped
 * key is already a precise condition match; a global outcome key needs an exact runId filter
 * so a wait for another co-hosted pipeline cannot extend this claim. The await supplies a
 * temporary, bounded lease extension; no generic issue row is mutated or assigned an expiry
 * by this policy.
 */
export function effectiveConditionLeaseExpiresAt(
  row: ConditionWorkItemRow,
  nowMs: number,
): string | null {
  if (!row.takenBy) return null;
  let baseExpiry = row.expiresAt;
  const progressLease = assessCriticalClaimProgressLease({
    takenAt: row.takenAt,
    lastProgressAt: row.lastProgressAt,
    nowMs,
    leaseMs: CRITICAL_CLAIM_PROGRESS_LEASE_MS,
  });
  if (progressLease.anchorMs !== null) {
    const progressExpiry = new Date(progressLease.anchorMs + progressLease.leaseMs).toISOString();
    const storedExpiryMs = baseExpiry ? Date.parse(baseExpiry) : Number.NaN;
    if (!Number.isFinite(storedExpiryMs) || Date.parse(progressExpiry) > storedExpiryMs) {
      baseExpiry = progressExpiry;
    }
  }

  // A pending checkpoint await on this pipeline's outcome keys proves the same
  // holder is waiting for the relevant gate result. Its timeout may be longer than
  // the ordinary progress lease, but the effective condition lease is bounded both
  // by that await's own deadline and by CHECKPOINT_RUN_LOCK_STALE_MS from creation.
  const awaitCreatedAtMs = row.checkpointAwaitCreatedAt ? Date.parse(row.checkpointAwaitCreatedAt) : NaN;
  if (!Number.isFinite(awaitCreatedAtMs) || awaitCreatedAtMs > nowMs) return baseExpiry;
  const awaitCapMs = awaitCreatedAtMs + CHECKPOINT_RUN_LOCK_STALE_MS;
  const awaitDeadlineMs = row.checkpointAwaitExpiresAt
    ? Math.min(awaitCapMs, Date.parse(row.checkpointAwaitExpiresAt))
    : awaitCapMs;
  if (!Number.isFinite(awaitDeadlineMs) || awaitDeadlineMs <= nowMs) return baseExpiry;
  if (!baseExpiry) return new Date(awaitDeadlineMs).toISOString();
  const baseExpiryMs = Date.parse(baseExpiry);
  if (!Number.isFinite(baseExpiryMs) || awaitDeadlineMs <= baseExpiryMs) return baseExpiry;
  return new Date(awaitDeadlineMs).toISOString();
}

/** PURE. Has this condition-owner lease lapsed? An unanchored claim fails closed. */
export function leaseExpired(row: ConditionWorkItemRow, nowMs: number): boolean {
  const expiresAt = effectiveConditionLeaseExpiresAt(row, nowMs);
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}

/** PURE. Does the row carry attributed claim-hold provenance enforced by the claim guard? */
export function claimHoldBlocked(row: ConditionWorkItemRow): boolean {
  return readWorkItemClaimHoldProvenance(row.payload).attributed;
}

/** PURE. The claim state of a single linked row (never `no-object` — the row exists). */
export function claimStateOf(row: ConditionWorkItemRow, nowMs: number): ConditionClaimState {
  if (claimHoldBlocked(row)) return 'hold-blocked';
  if (!row.takenBy) return 'claimable';
  return leaseExpired(row, nowMs) ? 'lease-expired' : 'held';
}

/**
 * Resolve ownership for one or more condition keys.
 *
 * Batched by design — the gate cells (P-004) fold several keys at once
 * (`green-stall:<slug>`, `main-behind-staging:<slug>`), and a per-key round-trip
 * inside a cell read is exactly the serial-fs/per-slug-open anti-pattern the
 * performance docs call out.
 *
 * Only NON-TERMINAL items count: a resolved condition that re-opens must mint a
 * fresh object rather than resurrecting the settled one, and a finished
 * work-item must never read as a live owner.
 *
 * ⚠ OPENNESS IS `status`, NEVER `closed_ts`. This originally filtered on
 * `closed_ts IS NULL`, which is wrong and would have been invisible in testing.
 * Measured live 2026-08-03: `closed_ts` is NULL on 77.4% of `done` rows, 98.8%
 * of `resolved`, 91.5% of `dropped` and **100% of `closed`** — over 13,000
 * terminal rows carry no close stamp at all. `directive-effect.ts` states the
 * real contract in code (`toMs(row.closed_ts) ?? toMs(row.updated_ts)`,
 * "closed_ts is the precise stamp; updated_ts is the fallback"): it is a
 * best-effort precision timestamp, not an openness predicate.
 *
 * The consequence had it shipped was not a bad read — it was a permanent one.
 * P-002's singleton index would treat those terminal rows as live owners, so
 * once a condition resolved without a close stamp its key could never be
 * re-minted: a UNIQUE violation on every future attempt, and that condition
 * would be unownable forever.
 *
 * The terminal set is DERIVED from `ANY_FAMILY_TERMINAL_STATES`, never re-listed
 * here. Hand-copying that union is a documented drift bug in this repo
 * (EI-18653071581558556: a stale copy scored 15 of 17 finished units as stranded,
 * ~88% phantoms). A NULL status is treated as non-terminal — unknown means
 * "possibly still live", so we report it as the owner rather than mint a duplicate.
 */
export async function findConditionObjects(
  conditionKeys: readonly string[],
  opts: {
    harnessSlug?: string;
    /** Test seam for the targeted query; production leaves this unset. */
    sql?: Sql;
    /** Test seam for deterministic await/lease deadline comparisons. */
    nowMs?: number;
  } = {},
): Promise<ReadonlyMap<string, ConditionObject>> {
  const out = new Map<string, ConditionObject>();
  const keys = [...new Set(conditionKeys.map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return out;

  const now = opts.nowMs ?? Date.now();
  // Absent the PG fast path, report `no-object` rather than throwing: a cell
  // that cannot resolve ownership must still render, and "no owner" is the
  // correct, non-misleading answer when we cannot see the store.
  if (!opts.sql && !coordHasPgFastPath()) {
    for (const k of keys) out.set(k, resolveConditionObject(k, [], now));
    return out;
  }

  const byKey = new Map<string, ConditionWorkItemRow[]>();
  try {
    const sql = opts.sql ?? coordSql();
    const rows = await sql<
      {
        condition_key: string;
        work_item: string;
        title: string | null;
        status: string | null;
        taken_by: string | null;
        taken_at: string | null;
        last_progress_at: string | null;
        expires_at: string | null;
        payload: unknown;
        checkpoint_await_created_at: Date | string | null;
        checkpoint_await_expires_at: Date | string | null;
      }[]
    >`
      SELECT l.dst_ref     AS condition_key,
             w.feature_id  AS work_item,
             w.title       AS title,
             w.status      AS status,
             w.taken_by    AS taken_by,
             w.taken_at    AS taken_at,
             w.last_progress_at AS last_progress_at,
             w.expires_at  AS expires_at,
             w.payload     AS payload,
             checkpoint_await.created_at AS checkpoint_await_created_at,
             checkpoint_await.expires_at AS checkpoint_await_expires_at
        FROM harness_shared.coord_links l
        JOIN harness_shared.work_items w
          ON w.feature_id = l.src_ref
         AND w.workspace_id = l.workspace_id
        -- Await and work-item rows may use different workspace partitions. The
        -- subscriber id is globally unique, so correlate on the holder only.
        LEFT JOIN LATERAL (
          SELECT a.created_at,
                 a.effective_expires_ts AS expires_at
            FROM harness_shared.event_awaits_effective a
           WHERE a.subscriber_id = w.taken_by
             AND (
               (
                 a.event_key = ANY(${[...CHECKPOINT_AWAIT_GLOBAL_EVENT_KEYS]}::text[])
                 -- A global outcome key can belong to any co-hosted pipeline, so it
                 -- protects this condition only when the wait names its exact run.
                 AND jsonb_typeof(a.payload_filter -> 'runId') = 'string'
                 AND length(a.payload_filter ->> 'runId') >= 4
               )
               -- A pipeline-scoped outcome key already pins the wait to this
               -- condition; generic events:await waits on these exact keys count too.
               OR a.event_key = ANY(ARRAY[
                 'release:green:' || split_part(l.dst_ref, ':', 2),
                 'green-checkpoint:red:' || split_part(l.dst_ref, ':', 2),
                 'green-checkpoint:inconclusive:' || split_part(l.dst_ref, ':', 2),
                 'green-checkpoint:held:' || split_part(l.dst_ref, ':', 2)
               ])
             )
             AND a.fired_at IS NULL
             AND a.cancelled_at IS NULL
             AND a.superseded_at IS NULL
             AND (a.effective_expires_ts IS NULL OR a.effective_expires_ts > to_timestamp(${now}::double precision / 1000.0))
             AND a.created_at <= to_timestamp(${now}::double precision / 1000.0)
             AND a.created_at + ${CHECKPOINT_RUN_LOCK_STALE_MS} * INTERVAL '1 millisecond'
                   > to_timestamp(${now}::double precision / 1000.0)
             AND (l.dst_ref LIKE 'green-stall:%' OR l.dst_ref LIKE 'gate-red-streak:%')
           ORDER BY LEAST(
             COALESCE(
               a.effective_expires_ts,
               a.created_at + ${CHECKPOINT_RUN_LOCK_STALE_MS} * INTERVAL '1 millisecond'
             ),
             a.created_at + ${CHECKPOINT_RUN_LOCK_STALE_MS} * INTERVAL '1 millisecond'
           ) DESC
           LIMIT 1
        ) checkpoint_await ON true
       WHERE l.workspace_id = ${coordWorkspaceId()}
         AND l.src_kind = ${WORK_ITEM_TAG_SRC_KIND}
         AND l.dst_kind = ${EVENT_SUBSCRIPTION_KIND}
         AND l.rel = ${CONDITION_LINK_REL}
         AND l.dst_ref = ANY(${keys}::text[])
         AND (w.status IS NULL OR w.status <> ALL(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
         AND (${opts.harnessSlug ?? null}::text IS NULL OR w.harness_slug = ${opts.harnessSlug ?? null})
       ORDER BY l.dst_ref, w.created_ts
       LIMIT ${CONDITION_OBJECT_ROW_CAP}`;
    for (const r of rows) {
      if (!r?.condition_key || !r?.work_item) continue;
      const list = byKey.get(r.condition_key);
      const row: ConditionWorkItemRow = {
        workItem: r.work_item,
        title: r.title ?? null,
        status: r.status ?? null,
        takenBy: r.taken_by ?? null,
        takenAt: pgTimestampToIsoOrNull(r.taken_at),
        lastProgressAt: pgTimestampToIsoOrNull(r.last_progress_at),
        expiresAt: pgTimestampToIsoOrNull(r.expires_at),
        checkpointAwaitCreatedAt: pgTimestampToIsoOrNull(r.checkpoint_await_created_at),
        checkpointAwaitExpiresAt: pgTimestampToIsoOrNull(r.checkpoint_await_expires_at),
        payload: r.payload ?? null,
      };
      if (list) list.push(row);
      else byKey.set(r.condition_key, [row]);
    }
  } catch {
    // Same reasoning as the fast-path guard: degrade to `no-object`, never throw
    // into a cell read.
    for (const k of keys) out.set(k, resolveConditionObject(k, [], now));
    return out;
  }

  await Promise.all(
    keys.map(async (k) => {
      const object = resolveConditionObject(k, byKey.get(k) ?? [], now);
      if (object.workItem) {
        out.set(k, object);
        return;
      }
      out.set(k, { ...object, reachability: await readEventConditionReachability(k) });
    }),
  );
  return out;
}

/** Convenience single-key form of {@link findConditionObjects}. */
export async function findConditionObject(
  conditionKey: string,
  opts: { harnessSlug?: string } = {},
): Promise<ConditionObject> {
  const map = await findConditionObjects([conditionKey], opts);
  return map.get(conditionKey) ?? resolveConditionObject(conditionKey, [], Date.now());
}

/**
 * Attach a work-item to the condition it concerns.
 *
 * A thin, deliberate wrapper over the existing `linkWorkItem` rather than a
 * second write path: `coord_links_edge_uq` already makes the edge idempotent on
 * (workspace, src, dst, rel), so re-linking is a no-op and callers need no
 * exists-check.
 */
export async function linkWorkItemToCondition(
  workItemId: string,
  conditionKey: string,
  opts: { harness?: string; by?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const key = conditionKey.trim();
  if (!key) return { error: 'conditionKey must be a non-empty string' };
  return linkWorkItem(workItemId, { kind: EVENT_SUBSCRIPTION_KIND, ref: key }, CONDITION_LINK_REL, opts);
}

/** Detach a work-item from a condition (idempotent). */
export async function unlinkWorkItemFromCondition(
  workItemId: string,
  conditionKey: string,
  opts: { harness?: string } = {},
): Promise<{ ok: true } | { error: string }> {
  const key = conditionKey.trim();
  if (!key) return { error: 'conditionKey must be a non-empty string' };
  return unlinkWorkItem(workItemId, { kind: EVENT_SUBSCRIPTION_KIND, ref: key }, CONDITION_LINK_REL, opts);
}
