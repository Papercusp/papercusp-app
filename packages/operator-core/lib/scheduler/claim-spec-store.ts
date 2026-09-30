/**
 * Per-bee claim-spec store + the get_next service entry point
 * (hybrid-bee-scheduler-work-stealing-2026-06-22 — the spec-handoff layer that makes get_next usable).
 *
 *   setClaimSpec  — the Queen validates (validateClaimSpec) + stores a bee's versioned claim spec
 *                   (mig 555 `cup_claim_specs`, renamed from mig 372 `bee_claim_specs`), upserting and bumping the revision.
 *   getClaimSpec  — loads a bee's effective spec; defaults only on confirmed absence.
 *                   Invalid stored policy and authority read failures propagate.
 *   getNextForBee — the bee's get_next: load the bee's spec → getNextWorkItem(spec, bee, opts).
 *
 * Keyed by the bee's session/owner id (`cupId` — the identity a tool ctx resolves via actor-identity
 * and the id the Queen addresses a bee by). The store fns take an optional `sql` (dependency-injected
 * for tests); production passes getOrgPg().sql.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, isIdOnlySelector, type ClaimSpec } from './claim-spec';
import { buildP2pLaneFence } from './p2p-lane-fence';
import { getNextWorkItem, type GetNextResult } from './get-next';
import { releaseWorkItem, type OrgSql, type WorkItem } from '../work-items';
import { planItemLaneBlockReason, type PlanItemLaneBlock } from './plan-item-lane-guard';
import { maybeEmitFleetIdleDrain } from './fleet-idle-drain';
import { matchesWorkItemClaimSpec } from './claim-spec-match';
import { resolveClaimSpecWorkspace } from './claim-spec-workspace';
import { recordClaimAttempt } from '../orchestrator/claim-audit';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { ALL_TERMINAL_STATUSES } from '../work-item-blocking';
import { RESOURCE_GOVERNOR_PARK_OWNER } from '../resource-governor/queue';
export { resolveClaimSpecWorkspace } from './claim-spec-workspace';

/**
 * EI-18694186565089433: the revision is stored TWICE — the `cup_claim_specs.revision`
 * COLUMN (bumped atomically by setClaimSpec's upsert) and a `revision` field embedded
 * inside the `spec` JSONB itself (carried forward verbatim by the read-edit-write
 * pattern setClaimSpec's own validation forces on every caller). Only the column is
 * bumped on write, so the embedded copy is permanently one write behind the moment
 * any caller round-trips a spec — every reader of the embedded field (formatSpecRef
 * call sites included) then cites a stale revision while the column, and every
 * OTHER reader of the column, correctly reports the current one. Confirmed live:
 * scheduler:set_claim_spec returned revision 6 (the column) while every following
 * scheduler:get_claim_spec read reported spec.revision 5 (the embedded copy).
 *
 * Fix direction (a) from the bug (preferred over syncing the two copies): the
 * column is the single source of truth, so EVERY read of a validated spec object
 * stamps the column's revision onto the returned spec before handing it to a
 * caller — the embedded field can then never be observed as stale, because it is
 * always overwritten with the authoritative value at the read boundary. Call this
 * at every construction site that returns a `ClaimSpec` (getClaimSpec,
 * getClaimSpecRecord, resolveFleetClaimSpec) so a caller reading EITHER
 * `record.revision` or `record.spec.revision` sees the same, current number.
 */
function withColumnRevision(spec: ClaimSpec, columnRevision: number): ClaimSpec {
  return spec.revision === columnRevision ? spec : { ...spec, revision: columnRevision };
}

export interface SetClaimSpecResult {
  ok: boolean;
  errors: string[];
  revision?: number;
  /** WI-1564: set when the write is suspicious but not invalid — e.g. a
   *  hive-scoped spec landing under the legacy 'default' workspace partition,
   *  which the federation outbox-drain does not serve (the row strands). */
  warning?: string;
}

/**
 * EI-11796: this bee's still-active claims before self-selection. A parked
 * item retains `taken_by` (and may carry `_claimHold`), so looking only at the
 * claimable pool lets a member accumulate a second lane after parking the first.
 * The unified work_items view covers both feature- and issue-family claims; use
 * the resolved workspace plus the legacy default partition because the two claim
 * families can legitimately live in different partitions while the workspace
 * routing flag is being migrated.
 *
 * EI-12095: returns the held ids (not just a count) so a concurrency-blocked
 * miss can name exactly what to release/complete — see get_next.ts's
 * buildMissDiagnosis, which special-cases this BEFORE running the pool/floor
 * diagnosis (a caller at/over its concurrency limit never reaches the claim
 * query at all, so a floor-admissibility report is actively misleading).
 *
 * EI-21895667973178286: excludes rows claim_hold_by the resource-governor
 * (`payload.claim_hold_by = RESOURCE_GOVERNOR_PARK_OWNER`). Those rows are NOT
 * work — they are durable admission-queue bookkeeping the governor mints for a
 * bee's OWN inference-call/spawn admission (title 'Queued agent admission' /
 * 'Queued inference admission'), reusing `taken_by` purely as a lease marker.
 * Counting them meant a freshly spawned bee's FIRST scheduler:get_next could
 * refuse before evaluating any lane — under the default cap of 1 the bee
 * arrived already "holding" its own admission receipt and could never claim
 * real work. WI-1250584 fixed the terminal-status half of this same
 * mis-count (a governor receipt left in 'done'/'dropped'); this fixes the
 * still-active half (a receipt in 'wip' for an in-flight admission).
 */
export async function getActiveClaimsForBee(
  args: { cupId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<{ id: string; kind: string }[]> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const workspaces = [...new Set([args.workspaceId ?? DEFAULT_COORD_WORKSPACE, DEFAULT_COORD_WORKSPACE])];
  // NOTE: harness_shared.work_items's unified item id lives in `feature_id` (not `id` —
  // there is no `id` column on this table) and its family/kind in `item_kind` (`kind` is a
  // separate, unrelated legacy column that is null for issue-family rows). Aliased below so
  // every caller of this function sees the { id, kind } shape its name promises.
  const rows = (await sql`
    SELECT feature_id AS id, item_kind AS kind
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaces}::text[])
       AND taken_by = ${args.cupId}
       AND status NOT IN ${sql([...ALL_TERMINAL_STATUSES])}
       AND payload->>'claim_hold_by' IS DISTINCT FROM ${RESOURCE_GOVERNOR_PARK_OWNER}`) as Array<{
    id: string;
    kind: string;
  }>;
  return rows;
}

/** Thin count-only projection of {@link getActiveClaimsForBee} — kept for callers (and tests)
 *  that only need the number, so the shared query stays in one place. */
export async function countActiveClaimsForBee(
  args: { cupId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<number> {
  return (await getActiveClaimsForBee(args, sqlOverride)).length;
}

/**
 * EI-11796: one active/held lane is the fail-closed default when a spec names no limit.
 * Exported so no consumer re-spells `?? 1` and silently drifts from the others.
 */
export const DEFAULT_MAX_CONCURRENT_CLAIMS = 1;

/** The verdict {@link evaluateClaimConcurrency} returns — what every surface must report FROM. */
export type ClaimConcurrencyVerdict = {
  /** True ⇒ `scheduler:get_next` WILL refuse this bee. Never re-derive this comparison. */
  blocked: boolean;
  activeClaims: number;
  maxConcurrentClaims: number;
  /** The held item ids, so a refusal/alert can name exactly what to release. */
  heldIds: string[];
};

/**
 * EI-19313376980892266 — THE ONE ORACLE for "is this bee at its concurrency cap".
 *
 * The principle CLAUDE.md already states for `work_items:claimable` ("wrapping the SAME
 * oracle scheduler:get_next runs, so it can't diverge from what the queue actually
 * serves") applied to the concurrency limit, which previously had FOUR consumers and
 * THREE behaviours:
 *
 *   - getNextWorkItem (below)      — enforced, its own copy of the rule
 *   - get_next.ts buildMissDiagnosis — enforced, a SECOND independent copy
 *   - fleet:leader-brief            — never consulted it at all; branched on the brief's
 *                                     own `load` (workItemIds) instead
 *   - work_items:claim              — no check whatsoever
 *
 * The live cost of that divergence (2026-08-02, one leader session): a PARKED item keeps
 * `taken_by`, so it counts in {@link getActiveClaimsForBee} but drops out of the brief's
 * `load`. `load === 0 && activeClaims >= 1` is therefore a REACHABLE state, and in it the
 * brief reported five members `idle_with_claimable` — telling the leader to wake members
 * the scheduler was structurally refusing. Three wakes and five member turns were spent
 * demanding work that could not be taken. Both surfaces were internally consistent; they
 * simply answered from different sources.
 *
 * PURE on purpose: `computeBenchSuggestion` is a pure function and must stay one (it is
 * unit-tested without a database), so the DB read lives in {@link readClaimConcurrency}
 * and the DECISION lives here, where every caller shares it.
 */
export function evaluateClaimConcurrency(args: {
  /** Either the held rows (preferred — yields `heldIds`) or a bare count. */
  activeClaims: readonly { id: string }[] | number;
  /** The resolved spec's limit; nullish ⇒ {@link DEFAULT_MAX_CONCURRENT_CLAIMS}. */
  maxConcurrentClaims?: number | null;
}): ClaimConcurrencyVerdict {
  const maxConcurrentClaims = args.maxConcurrentClaims ?? DEFAULT_MAX_CONCURRENT_CLAIMS;
  const heldIds = typeof args.activeClaims === 'number' ? [] : args.activeClaims.map((c) => c.id);
  const activeClaims = typeof args.activeClaims === 'number' ? args.activeClaims : args.activeClaims.length;
  return {
    blocked: activeClaims >= maxConcurrentClaims,
    activeClaims,
    maxConcurrentClaims,
    heldIds,
  };
}

/**
 * Async companion to {@link evaluateClaimConcurrency}: read this bee's real held claims
 * and return the shared verdict. Any surface that reports on, or gates, a claim MUST go
 * through this rather than counting rows it happens to have in hand.
 */
export async function readClaimConcurrency(
  args: { cupId: string; workspaceId?: string; maxConcurrentClaims?: number | null },
  sqlOverride?: OrgSql,
): Promise<ClaimConcurrencyVerdict> {
  const activeClaims = await getActiveClaimsForBee({ cupId: args.cupId, workspaceId: args.workspaceId }, sqlOverride);
  return evaluateClaimConcurrency({
    activeClaims,
    maxConcurrentClaims: args.maxConcurrentClaims,
  });
}

/**
 * Batched {@link readClaimConcurrency} — ONE query for many bees, keyed by cupId.
 *
 * EI-19313376980892266: `fleet:leader-brief` must answer "is this member at capacity"
 * from the same rows the scheduler reads (`taken_by`), not from the presence layer's
 * `load`/`claims` — that mismatch is the whole bug. Doing it per-member would be one
 * query per member on a hot leader path, so the READ is batched here while the DECISION
 * stays in the shared pure {@link evaluateClaimConcurrency}.
 *
 * A cupId with no held rows is still present in the returned map, with a `blocked:false`
 * verdict — so a caller can never mistake "absent from the map" for "not blocked".
 *
 * EI-21902965465306743: this predicate had DRIFTED from {@link getActiveClaimsForBee}'s —
 * it kept the pre-WI-1250584/pre-EI-21895667973178286 literal terminal-status list
 * (`'passed','deprecated','resolved','closed'` — missing the unified `'done'`/`'dropped'`
 * spellings) and carried NO `claim_hold_by` exclusion at all. That meant a member whose
 * held item had already terminated as `done`/`dropped`, or whose only "claim" was a
 * resource-governor admission receipt, still read as `blocked:true` here even though the
 * SAME member's own `scheduler:get_next` (via `getActiveClaimsForBee`, already carrying
 * both fixes) would happily admit it — leader-brief's `contextPressure`/bench-suggestion
 * surfaces could disagree with the member's actual claimability for exactly the class of
 * row this file's own EI-19313376980892266 doc comment set out to eliminate divergence
 * on. Reuse the identical predicate so the two queries cannot drift again.
 */
export async function readClaimConcurrencyBatch(
  args: { cupIds: readonly string[]; workspaceId?: string; maxConcurrentClaims?: number | null },
  sqlOverride?: OrgSql,
): Promise<Map<string, ClaimConcurrencyVerdict>> {
  const cupIds = [...new Set(args.cupIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, ClaimConcurrencyVerdict>();
  if (cupIds.length === 0) return out;

  const sql = sqlOverride ?? getOrgPg().sql;
  const workspaces = [...new Set([args.workspaceId ?? DEFAULT_COORD_WORKSPACE, DEFAULT_COORD_WORKSPACE])];
  // Same predicate as getActiveClaimsForBee — a PARKED/held row retains taken_by and so
  // counts here, which is exactly the row the presence layer's `load` can omit. Kept
  // identical to getActiveClaimsForBee's WHERE clause on purpose (EI-21902965465306743) —
  // do not hand-edit one without the other.
  const rows = (await sql`
    SELECT feature_id AS id, taken_by AS cup_id
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaces}::text[])
       AND taken_by = ANY(${cupIds}::text[])
       AND status NOT IN ${sql([...ALL_TERMINAL_STATUSES])}
       AND payload->>'claim_hold_by' IS DISTINCT FROM ${RESOURCE_GOVERNOR_PARK_OWNER}`) as Array<{
    id: string;
    cup_id: string;
  }>;

  const heldByCup = new Map<string, { id: string }[]>();
  for (const row of rows) {
    const list = heldByCup.get(row.cup_id) ?? [];
    list.push({ id: row.id });
    heldByCup.set(row.cup_id, list);
  }
  for (const cupId of cupIds) {
    out.set(
      cupId,
      evaluateClaimConcurrency({
        activeClaims: heldByCup.get(cupId) ?? [],
        maxConcurrentClaims: args.maxConcurrentClaims,
      }),
    );
  }
  return out;
}

/**
 * WI-1564 (LIVE-1 D5 failure): resolve the workspace partition a claim-spec
 * write/read should use from the caller's identity. The bug class: a tool
 * handler that omits `workspaceId` falls back to DEFAULT_COORD_WORKSPACE
 * ('default') — but the federation outbox-drain only serves the BOOTED
 * (workspace, hive) handles, so a hive-scoped row under 'default' NEVER
 * drains/federates (137 rows stranded as of 2026-07-02). Both the writer
 * (scheduler:set_claim_spec) and the reader (scheduler:get_next) MUST resolve
 * through this one helper so write+read+capture always agree on the partition.
 *
 * Returns the ident workspace when concrete; `undefined` (⇒ the store's
 * legacy 'default') for a null/'*'/empty ident — un-scoped callers keep
 * today's local-only behavior rather than guessing a volatile registry
 * default (the EI-1460 strand class).
 */
/** Queen: validate + store a bee's claim spec (upsert; revision bumps unless the spec carries a higher one). */
export async function setClaimSpec(
  args: {
    cupId: string;
    workspaceId?: string;
    spec: unknown;
    updatedBy?: string;
    /** P-016 (cross-machine-coord-parity): the hive HOME slug this spec federates
     *  under. Set ⇒ the spec rides that hive's peer-log (mig-438 WHEN gate) so a
     *  remote bee's get_next sees it; null/omitted ⇒ operator-scope, local-only
     *  (today's behavior). Resolved by the caller via the same shared-hive scope
     *  rule coord:send uses. */
    potSlug?: string | null;
  },
  sqlOverride?: OrgSql,
): Promise<SetClaimSpecResult> {
  const v = validateClaimSpec(args.spec);
  if (!v.ok || !v.spec) return { ok: false, errors: v.errors };
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const potSlug = args.potSlug ?? null;
  // WI-1564: hive-scoped + 'default' partition = the strand combo. The write
  // still proceeds (fail-soft; local get_next reads under the same default),
  // but LOUDLY — the outbox capture rides ('default', hive), which no booted
  // drain handle serves, so the spec never federates.
  const strandWarning =
    potSlug !== null && ws === DEFAULT_COORD_WORKSPACE
      ? `hive-scoped claim spec stored under the '${DEFAULT_COORD_WORKSPACE}' workspace partition — ` +
        `the federation outbox-drain only serves booted (workspace, hive) handles, so this spec will ` +
        `NOT federate to peers (WI-1564). Thread the caller's workspaceId (resolveClaimSpecWorkspace).`
      : undefined;
  // The id-pin tripwire (mig 389): record whether this spec selects on `id` ALONE — a static
  // pin (a fixed wave), as opposed to a property-filtered standing lane. Denormalized so
  // over-reliance is a one-line COUNT, keeping the describe-by-property discipline visible.
  const idOnly = isIdOnlySelector(v.spec);

  // L9 (cross-machine-coord-parity-and-trust-2026-07-01 P-058, audit D-013):
  // TOMBSTONE ON SCOPE-DOWNGRADE. cup_claim_specs is keyed (workspace_id, bee_id)
  // with no hive component, so a plain upsert that RE-HOMES a bee's spec to a
  // different hive scope (H_old → H_new, or H_old → NULL/operator-local) re-homes
  // the LOCAL row but STRANDS the stale row on H_old's peers: the UPDATE capture
  // trigger (mig 438) federates only to the NEW scope, and a downgrade to NULL
  // fails its `NEW.harness_slug IS NOT NULL` gate entirely — so H_old's bees keep
  // reading the dead spec via get_next forever. On a genuine scope change, DELETE
  // the old-scope row FIRST: its DELETE capture trigger (WHEN OLD.harness_slug IS
  // NOT NULL) federates a tombstone to H_old's peers, who then drop the stale row.
  // Then insert fresh under the new scope (revision preserved-and-bumped). The
  // common same-scope path is untouched — still the in-place ON CONFLICT bump.
  // (The audit also suggested widening the PK to include harness_slug; it is
  // redundant here — the (ws,bee_id) PK already makes a cross-scope duplicate
  // impossible and bee_ids are globally unique — and dropping a live federated
  // table's PK is unjustified risk for this LOW item; the tombstone is the real
  // strand fix.)
  const prior = (await sql`
    SELECT harness_slug, revision FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.cupId} LIMIT 1`) as {
    harness_slug: string | null;
    revision: number;
  }[];
  const priorScope = prior[0]?.harness_slug ?? null;
  const scopeChange = priorScope !== null && priorScope !== potSlug;

  if (scopeChange) {
    // Atomic: the tombstone (DELETE→old scope) + the re-insert (→new scope) commit
    // together, so a bee never observes a no-spec window mid-re-home.
    const nextRev = Math.max(prior[0]!.revision + 1, v.spec.revision);
    // EI-18694186565089433: stamp the COMPUTED nextRev into the stored spec's own
    // embedded `revision` field — never the client-submitted v.spec.revision, which
    // is only the optimistic-concurrency precondition, not the value that actually
    // lands. Without this the embedded copy is born stale on the very first write
    // after a scope change (the column jumps to nextRev; the JSONB keeps whatever
    // the caller sent).
    const specToStore = withColumnRevision(v.spec, nextRev);
    const rows = (await sql.begin(async (tx) => {
      await tx`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${ws} AND bee_id = ${args.cupId}`;
      return (await tx`
        INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec, revision, id_only, updated_by, harness_slug, updated_at)
        VALUES (${ws}, ${args.cupId}, ${JSON.stringify(specToStore)}::text::jsonb, ${nextRev}, ${idOnly}, ${args.updatedBy ?? null}, ${potSlug}, now())
        RETURNING revision`) as { revision: number }[];
    })) as unknown as { revision: number }[];
    return { ok: true, errors: [], revision: rows[0]?.revision, ...(strandWarning ? { warning: strandWarning } : {}) };
  }

  // EI-18694186565089433: on a re-steer (ON CONFLICT), the REVISION column is
  // computed atomically in SQL via GREATEST(...) — the client-submitted
  // v.spec.revision may lose that race. Stamp the SAME GREATEST-computed value
  // into the embedded spec's `revision` field, in the SAME statement (jsonb_set
  // on EXCLUDED.spec), so the two copies can never diverge no matter which
  // concurrent writer's bump actually wins. The plain (non-conflict) INSERT path
  // needs no stamping: a brand-new row's embedded revision already equals the
  // column value it's inserted with (both are v.spec.revision, verbatim).
  const rows = (await sql`
    INSERT INTO harness_shared.cup_claim_specs (workspace_id, bee_id, spec, revision, id_only, updated_by, harness_slug, updated_at)
    VALUES (${ws}, ${args.cupId}, ${JSON.stringify(v.spec)}::text::jsonb, ${v.spec.revision}, ${idOnly}, ${args.updatedBy ?? null}, ${potSlug}, now())
    ON CONFLICT (workspace_id, bee_id) DO UPDATE SET
      spec = jsonb_set(
        EXCLUDED.spec,
        '{revision}',
        to_jsonb(GREATEST(harness_shared.cup_claim_specs.revision + 1, EXCLUDED.revision))
      ),
      revision = GREATEST(harness_shared.cup_claim_specs.revision + 1, EXCLUDED.revision),
      id_only = EXCLUDED.id_only,
      updated_by = EXCLUDED.updated_by,
      harness_slug = EXCLUDED.harness_slug,
      updated_at = now()
    RETURNING revision`) as { revision: number }[];
  return { ok: true, errors: [], revision: rows[0]?.revision, ...(strandWarning ? { warning: strandWarning } : {}) };
}

export interface ClearClaimSpecResult {
  ok: boolean;
  errors: string[];
  /** true when a per-bee (or fleet-sentinel) row existed and was deleted; false when
   *  there was nothing to clear (the call is idempotent). */
  cleared: boolean;
}

/**
 * EI-12830: DELETE a bee's per-bee claim-spec row so it falls back to FLEET
 * inheritance (getClaimSpec resolution: bee spec → fleet spec → DEFAULT_CLAIM_SPEC).
 *
 * The bug this fixes: setClaimSpec could only WRITE/overwrite a bee's spec, never
 * remove it. Once ANY per-bee spec was ever set on a member (e.g. an initial
 * per-member dispatch at fleet formation), that member was PERMANENTLY cut off from a
 * later fleet-level `scheduler:set_claim_spec { fleet }` re-steer — every future
 * fleet-spec bump was invisible to it (a per-bee spec always WINS over the fleet
 * spec), so it kept pulling against its own stale cohort forever, reporting a scoped
 * miss (windDown:true) even while the leader believed it had re-steered the whole
 * fleet.
 *
 * The DELETE's federation capture trigger (mig 438, WHEN OLD.harness_slug IS NOT
 * NULL) fires a TOMBSTONE to the hive's peers so a remote bee drops the stale row
 * too — the same tombstone mechanism setClaimSpec uses on a scope downgrade. Also
 * valid on a `fleet:<slug>` sentinel key (fleetSpecBeeKey) to retire a whole fleet
 * lane back to DEFAULT_CLAIM_SPEC. Reads under the SAME caller-resolved workspace
 * partition as setClaimSpec/getClaimSpec (WI-1564).
 */
export async function clearClaimSpec(
  args: {
    cupId: string;
    workspaceId?: string;
    /**
     * Optional compare-and-delete guard for automatic lifecycle cleanup. A caller
     * that first READ a stale spec must never erase a concurrent re-steer that
     * landed before its DELETE. Interactive `scheduler:set_claim_spec { clear:true }`
     * intentionally omits this guard and keeps its explicit unconditional semantics.
     */
    expectedHead?: { specId: string; revision: number };
  },
  sqlOverride?: OrgSql,
): Promise<ClearClaimSpecResult> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const expectedHead = args.expectedHead;
  // Keep these as two complete statements. The org SQL tag executes a tagged
  // template; invoking it to build an interpolated "fragment" would issue a
  // separate query before this DELETE rather than compose one atomic guard.
  const rows = (
    expectedHead
      ? await sql`
        DELETE FROM harness_shared.cup_claim_specs
         WHERE workspace_id = ${ws} AND bee_id = ${args.cupId}
           AND spec->>'specId' = ${expectedHead.specId}
           AND revision = ${expectedHead.revision}
        RETURNING bee_id`
      : await sql`
        DELETE FROM harness_shared.cup_claim_specs
         WHERE workspace_id = ${ws} AND bee_id = ${args.cupId}
        RETURNING bee_id`
  ) as { bee_id: string }[];
  return { ok: true, errors: [], cleared: rows.length > 0 };
}

/**
 * The sentinel `bee_id` a FLEET-level claim spec is stored under (fleet-scheduler-
 * hardening-2026-07-03 P-002). Reuses `cup_claim_specs` (né `bee_claim_specs`) unchanged — the sentinel can
 * never collide with a real session/owner id (those are `su-<uuid>`/spawn ids) and
 * never claims anything (it is only ever a spec KEY, not a `taken_by`).
 */
export function fleetSpecBeeKey(fleetSlug: string): string {
  return `fleet:${fleetSlug}`;
}

/**
 * Load a bee's claim spec, or DEFAULT_CLAIM_SPEC when none is set.
 *
 * Fleet inheritance (fleet-scheduler-hardening-2026-07-03 P-002): when the bee has NO
 * per-bee spec, fall back to its FLEET's spec (the `fleet:<slug>` sentinel row) via the
 * durable membership fact (fleet_membership_events — stamped at boot by bootstrap-su,
 * WI-1893). This is what makes a fleet RELAUNCH work without the leader hand-authoring
 * N per-bee specs: fresh ownerIds inherit the lane the moment they join the fleet.
 * Resolution order: bee spec → fleet spec → DEFAULT_CLAIM_SPEC. A per-bee spec always
 * WINS over the fleet spec (the leader's targeted re-steer of one member sticks).
 * The record-returning resolver retains fleet membership when the fleet sentinel is
 * missing so get_next can fail closed during a membership transition. This bare helper
 * preserves the confirmed-absence default, but shares the strict reader for errors:
 * launch/re-steer callers must not overwrite authored policy with fabricated defaults.
 */
export async function getClaimSpec(
  args: { cupId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ClaimSpec> {
  return (await getClaimSpecRecord(args, sqlOverride)).spec;
}

/**
 * WI-6007: wire the (fully-built, zero-writer) `harness_shared.claim_audit` detector
 * into the ONE place that knows the RESOLVED claim-spec provenance — getNextForBee.
 * Motivating incident (WI-5995): a p2p-titled bug was served to two fleet members
 * whose claim spec rev 8 explicitly excludes `*p2p*`; proving which spec/revision
 * actually admitted it took a full SQL + JS-evaluator investigation and still could
 * only be INFERRED, never read straight off the row. This closes that gap: after
 * this lands, `SELECT feature_id, detail FROM harness_shared.claim_audit WHERE
 * feature_id='<id>' ORDER BY attempt_ts DESC` answers it in one query.
 *
 * Pure observability — best-effort ONLY (per the ticket's explicit scope: never
 * throw into the claim path, never change admission behavior). Errors are
 * swallowed here so a claim_audit hiccup (PG blip, schema drift) can never fail or
 * delay a real claim.
 */
async function auditClaimAttempt(args: {
  workspaceId?: string;
  harnessSlug: string;
  featureId: string;
  claimerId: string;
  outcome: 'won' | 'lost';
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordClaimAttempt({
      workspaceId: args.workspaceId ?? DEFAULT_COORD_WORKSPACE,
      harnessSlug: args.harnessSlug,
      feature_id: args.featureId,
      claimer_pubkey: args.claimerId,
      outcome: args.outcome,
      detail: JSON.stringify(args.detail).slice(0, 2000),
    });
  } catch {
    /* best-effort observability only — never let an audit-write failure touch the claim path */
  }
}

/**
 * WI-7316: deliver one post-claim plan-lane bounce to the caller's `onPlanLaneBlocked` hook.
 *
 * Extracted from the bounce path — and exported — for one reason: the only claim this code makes
 * that could be WRONG is that a caller-supplied callback cannot break the shared claim path. That
 * matters because the release + audit that follow it are what keep a bounced row claimable by the
 * next agent; a throw escaping here would strand the row claimed-but-unreleased for its whole
 * lease. Inline in getNextForBee that claim is unreachable by any test that does not stand up a
 * real claim against PG, so it would have shipped asserted-but-unverified. Here it is three lines
 * and a unit test.
 */
export function notifyPlanLaneBlocked(
  onPlanLaneBlocked: ((block: PlanItemLaneBlock & { workItemId: string }) => void) | undefined,
  block: PlanItemLaneBlock,
  workItemId: string,
): void {
  try {
    onPlanLaneBlocked?.({ ...block, workItemId });
  } catch {
    /* observability only — never in the admission decision */
  }
}

/** The bee's get_next: claim the next work-item per the bee's stored spec (the global floors always apply). */
export async function getNextForBee(args: {
  cupId: string;
  workspaceId?: string;
  harness: string;
  heldPaths?: string[];
  /** Live paths held by peers; used only for soft placement down-ranking. */
  contendedPaths?: string[];
  swarmId?: string;
  excludeRedundant?: boolean;
  states?: string[];
  /** WI-2796: caller has/coordinates a live ≥2-machine rig — see crossMachineRigExclusionSql. */
  rigAvailable?: boolean;
  /** Abort the in-flight claim transaction when the scheduler caller's deadline fires. */
  signal?: AbortSignal;
  /** SCHEDULER_SPEC_CLAIM kill-switch: when true, ignore the bee's stored spec and use the
   *  DEFAULT ordering (== work_items:claim_next) — a no-breakage degrade. */
  ignoreStoredSpec?: boolean;
  /** P-006 (fleet-leader-frictions-six-improvements-2026-07-10, WI-3763): on a genuine
   *  miss, ALSO check whether the caller's fleet is fully idle and, if so, push
   *  `fleet:drained:<slug>` (see fleet-idle-drain.ts). OPT-IN (default false) — this is
   *  a live-fleet-context side effect meaningful only from the real self-pull tool
   *  surface fleet members are steered to use (scheduler:get_next, per the su fleet-
   *  member operating baseline); leaving it off by default keeps getNextForBee
   *  side-effect-free for every other caller (notably the many unit tests that
   *  exercise its miss path directly, unmocked PG and all). */
  checkIdleDrainOnMiss?: boolean;
  /**
   * Use a small scheduler-only transactional pool for the spec/concurrency/claim path.
   * The public scheduler:get_next tool enables this; direct library callers retain the
   * injected/shared-client behavior they had before.
   */
  useDedicatedClaimPool?: boolean;
  /**
   * WI-7316: observe each row this loop claimed, found plan-lane-blocked, and released.
   *
   * That bounce is deliberately invisible in the RETURN value — the row is never served —
   * so a caller that ends up at the `return null` below cannot tell an honestly-drained
   * lane from one where every candidate was bounced by a plan item stuck on a sticky
   * `blocked` token whose blocked-by edges have all resolved. The audit row added by P-011
   * records the bounce durably, but a durable ledger cannot answer the caller in the
   * response it is reading RIGHT NOW, which is where the wind-down decision is made.
   *
   * Callback rather than a widened return type: the miss is `null` at three call sites and
   * a hundred tests, and none of them should have to change to let ONE caller
   * (scheduler:get_next) annotate its own miss. Invoked at most MAX_PLAN_LANE_ATTEMPTS
   * times, synchronously, before the release; throwing from it must never break the claim
   * path, so it is called defensively.
   */
  onPlanLaneBlocked?: (block: PlanItemLaneBlock & { workItemId: string }) => void;
}): Promise<(GetNextResult & { specSource: ClaimSpecRecord['source'] }) | null> {
  const claimSql = args.useDedicatedClaimPool
    ? (getLongLivedAdminPool('scheduler-claim', { max: 2, prepare: false }) as unknown as OrgSql)
    : undefined;
  // EI-8579: resolve via getClaimSpecRecord (not the bare getClaimSpec) so the caller can
  // tell WHICH row answered — a bee with neither a per-bee nor an inherited fleet spec
  // (source:'default') is silently drawing plain oldest-first ordering, which can hand it
  // owner-deferred work (e.g. a paused/de-scoped category) a curated spec would exclude.
  // scheduler:get_next surfaces this as an advisory `warning` so a self-pulling agent with
  // no spec learns to set one, instead of claimHold-parking deferred rows one at a time.
  const resolvedRecord = await getClaimSpecRecord({ cupId: args.cupId, workspaceId: args.workspaceId }, claimSql);
  // WI-4770: membership changes are not an authorization to widen into the
  // default backlog. A fleet/leader transition can briefly have no valid
  // inherited sentinel while the leader rebinds the intended lane. Keep that
  // window fail-closed even when the scheduler kill-switch asks us to ignore
  // stored specs; only an explicit per-bee or valid fleet spec may pull.
  // (An explicitly-LEFT agent carries no fleetSlug marker — getClaimSpecRecord
  // treats a settled leave as solo, so DEFAULT_CLAIM_SPEC pulls resume there.)
  if (resolvedRecord.source === 'default' && resolvedRecord.fleetSlug) {
    // WI-6007 point 4: record the fail-closed refusal too. There is no candidate
    // work-item here (the refusal fires before any row is selected), so feature_id
    // uses a sentinel naming the fleet whose sentinel spec was missing/invalid —
    // never a real work-item id — so it can't collide with a genuine claim row.
    await auditClaimAttempt({
      workspaceId: args.workspaceId,
      harnessSlug: args.harness,
      featureId: `fleet-scope-refusal:${resolvedRecord.fleetSlug}`,
      claimerId: args.cupId,
      outcome: 'lost',
      detail: {
        source: resolvedRecord.source,
        fleetSlug: resolvedRecord.fleetSlug,
        reason: 'fail-closed: membership names a fleet with no valid spec sentinel (WI-4770 transition guard)',
      },
    });
    return null;
  }
  const resolvedPullRecord: ClaimSpecRecord = args.ignoreStoredSpec
    ? { source: 'default', spec: DEFAULT_CLAIM_SPEC, revision: null, updatedBy: null, updatedAt: null }
    : resolvedRecord;

  // EI-20185650623647293: a missing spec used to send every self-puller through the
  // unbounded default backlog, whose deterministic oldest-first head was often another
  // fleet's p2p/federation work. Apply the shared fence only to the default-source
  // effective pull; an explicitly authored bee/fleet spec remains authoritative.
  const record = effectiveClaimSpecRecord(resolvedPullRecord);

  // EI-11796: one active/held lane is the fail-closed default. The limit is
  // intentionally read from the resolved spec, not from prompt compliance:
  // parked claims remain assigned, and a fresh get_next must not hand the same
  // member another item unless its leader explicitly authored concurrency > 1.
  // EI-19313376980892266: this comparison used to live here AND (independently) in
  // get_next.ts's miss diagnosis, and nowhere else — the two other surfaces that report
  // on claims (fleet:leader-brief, work_items:claim) never applied it. All four now share
  // evaluateClaimConcurrency so they cannot answer differently.
  const concurrency = await readClaimConcurrency(
    {
      cupId: args.cupId,
      workspaceId: args.workspaceId,
      maxConcurrentClaims: record.spec.limits?.maxConcurrentClaims,
    },
    claimSql,
  );
  if (concurrency.blocked) return null;

  // WI-3667: the global floors (claimFloorsWhereSql) enforce EXPLICIT `blocks` dep
  // edges + the coarse plan-WIDE reserved-lane floor, but nothing checks a linked
  // plan-item's own resolved effectiveStatus (blocked-by graph / cycles / the
  // `blocked` stored token) — that computation is JS-side (plan-parser), not a SQL
  // predicate the claim query can enforce inline. Loop the atomic claim: on a hit,
  // check the linked plan-item lane; if it's blocked/needs-human, release (never
  // surfaced to the caller — the claim/release round-trip is invisible) and try the
  // next row. Bounded so a pathological run of blocked plan-linked rows can't spin
  // forever.
  //
  // EI-9108 (2026-07-10 incident: WI-3503/P-401 claimed via scheduler:get_next while
  // its 7-deep blockedBy chain was still open): on retry-budget exhaustion this used to
  // FAIL OPEN — serve the last (still-confirmed-blocked) claim rather than starve the
  // caller. That is exactly the harm WI-3667 exists to prevent: a caller that reaches
  // exhaustion has, by construction, just proven the row IS plan-lane-blocked (the
  // `blocked` check right above ran on THIS row), so "serve it anyway" was a guaranteed
  // hand-out of confirmed-bad work, not a courtesy fallback. Now it releases the last
  // row too and reports NO claimable item (fail CLOSED) — a caller reading `null` here
  // retries shortly or helps unblock the backlog (per work_items:claim_next's own
  // drained-vs-pending contract), which is a far safer outcome than executing a plan
  // item the plan's own dependency graph says isn't ready. A backlog where 5 CONSECUTIVE
  // ranked candidates are each individually blocked is the genuinely pathological case
  // this budget guards against; failing closed there is a temporary under-supply, not a
  // correctness bug — a peer's plan-item lane check (`plans:items`) remains the
  // authoritative backstop for surfacing why nothing was eligible.
  const MAX_PLAN_LANE_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_PLAN_LANE_ATTEMPTS; attempt += 1) {
    const result = await getNextWorkItem(
      record.spec,
      {
        assignee: args.cupId,
        heldPaths: args.heldPaths,
        contendedPaths: args.contendedPaths,
      },
      {
        harness: args.harness,
        ...(claimSql ? { client: claimSql } : {}),
        // WI-5261: thread the caller's already-resolved workspace through explicitly —
        // getNextWorkItem's tiers otherwise re-derive it via activeWorkspaceId(), which
        // depends on the AsyncLocalStorage request-scope still being intact this deep into
        // the call chain (a dropped scope silently falls to 'default' and the claim query
        // matches nothing, deterministically). args.workspaceId is already resolved above
        // via resolveClaimSpecWorkspace by every caller (scheduler:get_next's tool handler).
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
        ...(args.swarmId ? { swarmId: args.swarmId } : {}),
        ...(args.excludeRedundant ? { excludeRedundant: true } : {}),
        ...(args.states ? { states: args.states } : {}),
        ...(args.rigAvailable ? { rigAvailable: true } : {}),
        ...('fleetSlug' in record && record.fleetSlug ? { fleetSlug: record.fleetSlug } : {}),
        signal: args.signal,
      },
    );
    if (!result) {
      // P-006: this IS "the claim-spec view is empty" — when the caller opted in,
      // check whether its fleet is ALSO fully idle and, if so, push
      // fleet:drained:<slug> instead of leaving the leader to burn-down-watch
      // fleet:assignments. Fire-and-forget; never blocks or throws into this miss.
      if (args.checkIdleDrainOnMiss) maybeEmitFleetIdleDrain(args.cupId, args.workspaceId);
      return null;
    }
    // P-016 hard fleet-scope boundary: tier 3 is the shared issue-family
    // fallback. It historically preserved only kind/id leaves, so a title/plan/
    // tag-constrained spec could receive an adjacent issue outside its view.
    // Validate the complete spec after the atomic claim and quarantine any
    // mismatch before it reaches the member. The release cooldown prevents the
    // bounded retry from selecting the same row immediately.
    if (result.workItem.family === 'issue' && !matchesWorkItemClaimSpec(result.workItem, record.spec)) {
      // EI-15019: this claim+release round-trip is INTERNAL — the row was
      // pool-claimable before the claim and stays pool-claimable after the release
      // (tier 3's SQL narrows only by kind/id, never by title/tags/paths, so a spec
      // with e.g. a WI-3268 title-glob exclusion can only be enforced here, AFTER the
      // atomic claim). No observer outside this call ever saw the row as unavailable,
      // so re-announcing it on the broad `work-item:claimable` key adds no information
      // — it only wakes every live awaiter for nothing. Live incident: a harness:null
      // operator-scope bug (EI-128, oldest-open + a `*p2p*`-glob-excluded title) got
      // claimed and quarantine-released here every ~3-4min by different fleet members
      // whose spec excludes p2p work, broadcasting to all 7 live awaiters each time.
      // `claim:released:<id>` (the targeted, id-scoped key) still always fires.
      await releaseWorkItem(result.workItem.id, {
        harness: args.harness,
        expectedAssignee: args.cupId,
        announceClaimable: false,
      });
      continue;
    }
    const blocked = await planItemLaneBlockReason(result.workItem);
    if (!blocked) {
      await auditClaimAttempt({
        workspaceId: args.workspaceId,
        harnessSlug: args.harness,
        featureId: result.workItem.id,
        claimerId: args.cupId,
        outcome: 'won',
        detail: {
          source: record.source,
          specId: result.claimedUnder.specId,
          revision: result.claimedUnder.revision,
          // `record` is `ClaimSpecRecord | { source: 'default'; spec: ClaimSpec }` (the
          // narrower literal on the ignoreStoredSpec:true branch, which carries no
          // fleetSlug) — narrow with an `in` check rather than widening the literal's type.
          fleetSlug: 'fleetSlug' in record ? record.fleetSlug : undefined,
          // Coarse proxy for "which SQL tier admitted this row" — getNextWorkItem does not
          // return a first-class tier number, and threading one through would be a much
          // larger change than this detector-only ticket scopes for. issue-family rows are
          // served ONLY by tier 3; feature-family rows by tiers 1/2.
          tier: result.workItem.family === 'issue' ? 'issue-tier3' : 'feature-tier1-2',
          lockAwarePlacement: {
            peerHeldPathCount: args.contendedPaths?.length ?? 0,
            selectedConflict: workItemConflictsWithPaths(result.workItem, args.contendedPaths ?? []),
          },
        },
      });
      return { ...result, specSource: record.source };
    }
    // Confirmed blocked (whether this is attempt 1 or the last) — always release; NEVER
    // serve a row we just confirmed is plan-lane-blocked (EI-9108).
    // EI-14837 (completes the EI-15019 class — see the spec-mismatch release above): this
    // is the SIBLING internal claim-then-release round-trip. A plan-lane-blocked row is not
    // genuinely claimable by ANYONE (the lane block is universal, not spec-scoped), so it
    // was un-claimable before the claim AND after the release — nothing observable changed.
    // Re-announcing the broad `work-item:claimable` key here only wakes every live awaiter
    // for a pick the next claimant re-bounces, an N-member spurious wake storm per tick
    // (the exact symptom EI-14837 reported). Suppress the broad co-fire; the targeted
    // `claim:released:<id>` still fires, and the real re-announce arrives via the
    // unblock/requeue path (reason 'unblocked'/'requeued') when the lane genuinely clears.
    //
    // P-011 (work-item-dependency-edges-2026-08-02): AUDIT the bounce. This round-trip is
    // deliberately invisible to the caller — the row is never returned — so until now it
    // left NO trace anywhere: no counter, no log, no ledger row. That made the plan's own
    // closing question ("has the lane guard demoted to a backstop now that the dependency
    // floor does the work pre-claim?") unanswerable, because the quantity it asks about was
    // never recorded. A guard whose cost cannot be measured cannot be shown to have stopped
    // costing anything.
    //
    // 'lost' is the existing outcome for a non-competitive refusal (see the fail-closed
    // fleet-scope refusal above) — this is not a race that was lost to another claimer, so
    // `reason` is what distinguishes it. Best-effort and swallow-on-error like every other
    // call here: pure observability, never in the admission decision.
    // WI-7316: tell the CALLER about the bounce, not just the ledger. Same verdict the audit
    // row below records, delivered in time to annotate the miss this loop is about to return.
    // Defensive: a caller-supplied callback must never be able to break the shared claim path
    // (the audit + release below MUST still run), so a throw here is swallowed exactly like
    // every other observability call in this function.
    notifyPlanLaneBlocked(args.onPlanLaneBlocked, blocked, result.workItem.id);
    await auditClaimAttempt({
      workspaceId: args.workspaceId,
      harnessSlug: args.harness,
      featureId: result.workItem.id,
      claimerId: args.cupId,
      outcome: 'lost',
      detail: {
        source: record.source,
        reason: 'plan-lane-blocked',
        // The lane guard's own verdict — which plan item held the row, and why. Without
        // this the count says churn happened but not which of the guard's three distinct
        // jobs (blocked-by graph, terminal-lane residue, owner-gate prose) produced it,
        // and only the FIRST is the one the dependency floor is expected to take over.
        planSlug: blocked.planSlug,
        itemId: blocked.itemId,
        effectiveStatus: blocked.effectiveStatus,
        laneReason: blocked.reason,
        family: result.workItem.family,
      },
    });
    await releaseWorkItem(result.workItem.id, {
      harness: args.harness,
      expectedAssignee: args.cupId,
      announceClaimable: false,
    });
  }
  return null;
}

function workItemConflictsWithPaths(item: WorkItem, contendedPaths: string[]): boolean {
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const itemPaths = Array.isArray(payload.paths)
    ? payload.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const normalize = (p: string) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return itemPaths.some((rawItemPath) => {
    const itemPath = normalize(rawItemPath);
    return contendedPaths.some((rawHeldPath) => {
      const heldPath = normalize(rawHeldPath);
      return itemPath === heldPath || itemPath.startsWith(`${heldPath}/`) || heldPath.startsWith(`${itemPath}/`);
    });
  });
}

/**
 * EI-7678: the READ counterpart to setClaimSpec — a bee's/fleet's claim spec was write-only
 * from the tool surface (verifying a live spec meant grepping source for the zod grammar, or a
 * raw `cup_claim_specs` query). Full record, not just the resolved spec: which row actually
 * answered (a per-bee spec, an inherited fleet spec, or neither ⇒ DEFAULT_CLAIM_SPEC), plus its
 * revision/updatedBy/updatedAt/harnessSlug so a leader can confirm a re-steer actually landed
 * before relying on it.
 */
export interface ClaimSpecRecord {
  /** Which row answered: a per-bee spec always wins; 'fleet' when inherited via membership;
   *  'fleet' also identifies a direct fleet-sentinel read; 'default' when neither a per-bee
   *  nor a fleet spec exists (DEFAULT_CLAIM_SPEC applies). */
  source: 'cup' | 'fleet' | 'default';
  spec: ClaimSpec;
  revision: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** The federation hive scope the row rides (null ⇒ operator-scope/local-only). Absent on 'default'. */
  harnessSlug?: string | null;
  /**
   * Set when `source === 'fleet'`: the fleet slug whose spec this bee inherited.
   * Also set on a default record while the bee's latest membership fact still
   * NAMES a fleet whose sentinel is missing/invalid (mid-transition). That marker
   * is a fail-closed transition guard; it is not permission to use
   * DEFAULT_CLAIM_SPEC. An explicit leave (latest fact: no fleet) settles the
   * transition — no marker, and ordinary solo DEFAULT_CLAIM_SPEC pulls resume.
   */
  fleetSlug?: string;
}

/**
 * Apply the safety boundary for an unscoped self-pull without mutating the shared
 * DEFAULT_CLAIM_SPEC object. Explicit per-bee and inherited fleet specs remain the
 * authored source of truth; a p2p fleet opts into that lane by authoring its own spec.
 *
 * Keep the baseline spec id/revision unchanged so claim provenance still identifies
 * the historical default ordering, while the effective filter prevents a spec-less
 * single-box caller from repeatedly drawing the p2p/federation lane (EI-201856...).
 */
function effectiveClaimSpecRecord(record: ClaimSpecRecord): ClaimSpecRecord {
  if (record.source !== 'default') return record;
  return {
    ...record,
    spec: {
      ...record.spec,
      view: {
        ...record.spec.view,
        filter: buildP2pLaneFence(),
      },
    },
  };
}

/**
 * Load the full claim-spec RECORD for a bee (or, via `fleetSpecBeeKey`, a fleet sentinel) —
 * mirrors getClaimSpec's resolution order (bee spec → fleet spec → DEFAULT_CLAIM_SPEC) but
 * returns the row metadata instead of silently collapsing to just the resolved spec, so a
 * caller can tell an explicit override from an inherited or absent one.
 * This record authorizes claims: only confirmed absence may use the default. A failed
 * membership/spec read or malformed stored policy must propagate, never widen authority.
 */
export async function getClaimSpecRecord(
  args: { cupId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ClaimSpecRecord> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  // A direct scheduler:get_claim_spec fleet read deliberately passes the fleet
  // sentinel (`fleet:<slug>`) as cupId so the store can reuse its point lookup.
  // Preserve that target identity in the returned record: treating the sentinel
  // as an ordinary cup makes the read report source:'cup' and drops fleetSlug,
  // which is indistinguishable from a per-member override to callers.
  const directFleetSlug = args.cupId.startsWith('fleet:') ? args.cupId.slice('fleet:'.length) || undefined : undefined;
  const rows = (await sql`
    SELECT spec, revision, updated_by, updated_at, harness_slug
      FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.cupId} LIMIT 1`) as Array<{
    spec: unknown;
    revision: number;
    updated_by: string | null;
    updated_at: string;
    harness_slug: string | null;
  }>;
  if (rows.length > 0) {
    const row = rows[0]!;
    const v = validateClaimSpec(row.spec);
    if (!v.ok || !v.spec) {
      throw Object.assign(
        new Error(
          `Invalid stored claim spec for ${args.cupId}; repair this target with scheduler:set_claim_spec before retrying: ${v.errors.join('; ')}`,
        ),
        { code: 'invalid_claim_spec' },
      );
    }
    return {
      source: directFleetSlug ? 'fleet' : 'cup',
      spec: withColumnRevision(v.spec, row.revision),
      revision: row.revision,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      harnessSlug: row.harness_slug,
      ...(directFleetSlug ? { fleetSlug: directFleetSlug } : {}),
    };
  }
  // No per-bee row — try the fleet the bee belongs to (same inheritance getClaimSpec applies).
  // Keep the membership slug when the latest fact NAMES a fleet whose sentinel is
  // absent/invalid: a caller must not turn that mid-rebind window into a
  // generic-backlog claim (WI-4770). An explicit leave (latest fact fleet_slug=null)
  // is NOT that window: the membership store's contract reads it as "explicitly in
  // no fleet", and the admission seams (resolveFleetScopeContext) already treat the
  // agent as unscoped — so no marker is set and ordinary solo DEFAULT_CLAIM_SPEC
  // pulls resume. (This branch used to resurrect the prior fleet from event history
  // on a leave, which permanently fail-closed every ex-member's self-select while
  // their by-id claims stayed wide open — observed live 2026-07-17: a wound-down
  // scratch fleet's leader could never pull again, with a miss diagnosis reporting
  // hundreds of ready items.)
  let transitionFleetSlug = directFleetSlug;
  if (!directFleetSlug) {
    const { latestFleetMembership } = await import('../fleet-membership-store');
    const membership = await latestFleetMembership(ws, args.cupId, sql);
    if (membership?.fleetSlug) {
      transitionFleetSlug = membership.fleetSlug;
      const frows = (await sql`
        SELECT spec, revision, updated_by, updated_at, harness_slug
          FROM harness_shared.cup_claim_specs
         WHERE workspace_id = ${ws} AND bee_id = ${fleetSpecBeeKey(membership.fleetSlug)} LIMIT 1`) as Array<{
        spec: unknown;
        revision: number;
        updated_by: string | null;
        updated_at: string;
        harness_slug: string | null;
      }>;
      if (frows.length > 0) {
        const frow = frows[0]!;
        const fv = validateClaimSpec(frow.spec);
        if (!fv.ok || !fv.spec) {
          throw Object.assign(
            new Error(
              `Invalid stored claim spec for ${fleetSpecBeeKey(membership.fleetSlug)}; repair this fleet with scheduler:set_claim_spec before retrying: ${fv.errors.join('; ')}`,
            ),
            { code: 'invalid_claim_spec' },
          );
        }
        return {
          source: 'fleet',
          spec: withColumnRevision(fv.spec, frow.revision),
          revision: frow.revision,
          updatedBy: frow.updated_by,
          updatedAt: frow.updated_at,
          harnessSlug: frow.harness_slug,
          fleetSlug: membership.fleetSlug,
        };
      }
    }
  }
  return {
    source: 'default',
    spec: DEFAULT_CLAIM_SPEC,
    revision: null,
    updatedBy: null,
    updatedAt: null,
    ...(transitionFleetSlug ? { fleetSlug: transitionFleetSlug } : {}),
  };
}

/**
 * A fleet claim-spec resolved from a caller-supplied `spec` string through one of its
 * legitimate namespaces.
 */
export interface ResolvedFleetClaimSpec {
  record: ClaimSpecRecord;
  /** The fleet slug the record actually resolved under (the sentinel `bee_id` sans its
   *  `fleet:` prefix) — always populated, regardless of which namespace matched. */
  fleetSlug: string;
  /** Which namespace the caller's `spec` value matched. */
  matchedBy: 'fleet-slug' | 'spec-id' | 'revision-shorthand';
}

/**
 * EI-18672834165659298: resolve a caller-supplied `spec` string against the namespaces a
 * fleet claim-spec is legitimately addressed by — the FLEET SLUG (the sentinel `bee_id` key,
 * `fleet:<slug>`, per {@link fleetSpecBeeKey}) and the spec's own `specId` (the value stamped
 * into every claim-spec payload, printed by scheduler:get_claim_spec, and quoted in
 * get_next's own refusal text — "does not match p2p-release-lane@12" — making the specId the
 * MORE discoverable value and therefore the one callers are likeliest to pass here). A strict
 * `revN` shorthand is also accepted when exactly ONE live fleet spec in the workspace carries
 * revision N. Revision numbers are not globally unique, so an ambiguous shorthand fails closed.
 *
 * Trying the fleet-slug namespace FIRST preserves today's common-case query shape (one
 * indexed point lookup); the specId fallback only fires when that misses, so it costs
 * nothing on the well-formed path.
 *
 * Returns `null` when NEITHER namespace matches — the caller MUST treat that as an error
 * (surface it + {@link listFleetClaimSpecCandidates}), never silently degrade to
 * DEFAULT_CLAIM_SPEC. Before this fix, work_items:claimable passed an unresolved specId
 * straight to getClaimSpecRecord as a fake cupId, which fell through to
 * `{ source:'default', spec: DEFAULT_CLAIM_SPEC }` — reporting the WHOLE issue-family
 * backlog (1023 items in the field report) as "claimable" under a 10-item fleet lane, a
 * silent safe→unsafe scope widening.
 */
export async function resolveFleetClaimSpec(
  args: { spec: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ResolvedFleetClaimSpec | null> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  // Callers commonly pass the full sentinel identifier returned by fleet-facing
  // surfaces (`fleet:<slug>`), while the fleet-slug namespace itself is the
  // suffix. Normalize only this lookup; specId and revN keep their exact input
  // semantics below.
  const requestedFleetSlug = args.spec.startsWith('fleet:') ? args.spec.slice('fleet:'.length) : args.spec;

  type Row = {
    bee_id: string;
    spec: unknown;
    revision: number;
    updated_by: string | null;
    updated_at: string;
    harness_slug: string | null;
  };
  // matchedBy is set by each call site below (it knows which lookup produced the row);
  // this just builds the common record shape once validation passes.
  const toRecord = (row: Row, fleetSlug: string): Omit<ResolvedFleetClaimSpec, 'matchedBy'> | null => {
    const v = validateClaimSpec(row.spec);
    if (!v.ok || !v.spec) return null;
    return {
      fleetSlug,
      record: {
        source: 'fleet',
        spec: withColumnRevision(v.spec, row.revision),
        revision: row.revision,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
        harnessSlug: row.harness_slug,
        fleetSlug,
      },
    };
  };

  // 1) literal fleet-slug lookup — the sentinel row keyed `fleet:<spec>`.
  const bySlugRows = (await sql`
    SELECT bee_id, spec, revision, updated_by, updated_at, harness_slug
      FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${fleetSpecBeeKey(requestedFleetSlug)} LIMIT 1`) as Row[];
  if (bySlugRows.length > 0) {
    const resolved = toRecord(bySlugRows[0]!, requestedFleetSlug);
    if (resolved) return { ...resolved, matchedBy: 'fleet-slug' };
  }

  // 2) specId lookup — the value stamped into the spec's own payload (spec->>'specId'),
  // scoped to fleet-sentinel rows only (bee_id LIKE 'fleet:%') so this can never resolve a
  // bare bee's per-agent spec by accident.
  const bySpecIdRows = (await sql`
    SELECT bee_id, spec, revision, updated_by, updated_at, harness_slug
      FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws}
       AND bee_id LIKE 'fleet:%'
       AND spec->>'specId' = ${args.spec}
     ORDER BY revision DESC LIMIT 1`) as Row[];
  if (bySpecIdRows.length > 0) {
    const row = bySpecIdRows[0]!;
    const fleetSlug = row.bee_id.slice('fleet:'.length);
    const resolved = toRecord(row, fleetSlug);
    if (resolved) return { ...resolved, matchedBy: 'spec-id' };
  }

  // 3) strict revision shorthand (`rev47`) — a convenience printed by plan/fleet
  // reconciliation surfaces. A revision is only an identity when it is UNIQUE in this
  // workspace. Query at most two rows so ambiguity is detected without materializing the
  // fleet catalog; two matches deliberately return null and let the caller surface candidates.
  const revisionMatch = /^rev(\d+)$/i.exec(args.spec);
  const revision = revisionMatch ? Number(revisionMatch[1]) : Number.NaN;
  if (Number.isSafeInteger(revision) && revision >= 0) {
    const byRevisionRows = (await sql`
      SELECT bee_id, spec, revision, updated_by, updated_at, harness_slug
        FROM harness_shared.cup_claim_specs
       WHERE workspace_id = ${ws}
         AND bee_id LIKE 'fleet:%'
         AND revision = ${revision}
       ORDER BY updated_at DESC LIMIT 2`) as Row[];
    if (byRevisionRows.length === 1) {
      const row = byRevisionRows[0]!;
      const fleetSlug = row.bee_id.slice('fleet:'.length);
      const resolved = toRecord(row, fleetSlug);
      if (resolved) return { ...resolved, matchedBy: 'revision-shorthand' };
    }
  }

  return null;
}

/**
 * The candidate fleet claim-spec identifiers (slug + specId) under a workspace — for an
 * "unrecognized `spec`" error message so a caller sees what WOULD have matched instead of
 * guessing again (EI-18672834165659298, option 2: "error with the candidates, never fall
 * back").
 *
 * EI-21857753284071679: pass `revision` whenever the caller's `spec` was a `revN` shorthand
 * that {@link resolveFleetClaimSpec} rejected as AMBIGUOUS. Without it, this defaults to the
 * `limit` most-recently-updated fleet specs across ALL revisions — a window that can (and,
 * measured live, does: 3 fleets sat at revision 13 workspace-wide, only 1 of them within the
 * top 20 by recency) silently EXCLUDE the very rows that caused the ambiguity. A caller then
 * reads the returned `candidates` as "the whole match set" — sees one revision-13 row, no
 * others — and reasonably concludes the ambiguity error is itself a bug, when the omitted
 * rows are why resolution correctly refused to guess. `revision` switches the query to an
 * unbounded scan filtered to that exact revision (still ordered by recency, and still capped
 * by `limit` as a sanity ceiling, not a recency window) so the full match set — the actual
 * reason resolution failed closed — is always what gets shown.
 */
export async function listFleetClaimSpecCandidates(
  args: { workspaceId?: string; limit?: number; revision?: number },
  sqlOverride?: OrgSql,
): Promise<Array<{ fleetSlug: string; specId: string | null; revision: number }>> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const limit = args.limit ?? 20;
  const rows =
    Number.isSafeInteger(args.revision) && (args.revision as number) >= 0
      ? ((await sql`
    SELECT bee_id, spec->>'specId' AS spec_id, revision
      FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws} AND bee_id LIKE 'fleet:%' AND revision = ${args.revision as number}
     ORDER BY updated_at DESC LIMIT ${limit}`) as Array<{ bee_id: string; spec_id: string | null; revision: number }>)
      : ((await sql`
    SELECT bee_id, spec->>'specId' AS spec_id, revision
      FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${ws} AND bee_id LIKE 'fleet:%'
     ORDER BY updated_at DESC LIMIT ${limit}`) as Array<{ bee_id: string; spec_id: string | null; revision: number }>);
  return rows.map((r) => ({
    fleetSlug: r.bee_id.slice('fleet:'.length),
    specId: r.spec_id,
    revision: Number(r.revision),
  }));
}

/** The claim-spec head (specId@revision) a bee is running under — the live-execution view's
 *  per-run spec column (P-001). */
export interface ClaimSpecHead {
  specId: string;
  revision: number;
}

/**
 * Batch-load the running spec HEAD (specId@revision) for a set of bees, keyed by cupId — the
 * spec-join behind the live-execution view (P-001, {@link import('./bee-runs').listBeeRuns}).
 * A bee with no stored spec is ABSENT from the map (⇒ DEFAULT ordering / no Queen-authored
 * spec). `bee_id` is globally unique (it is the claim's `taken_by`), so this joins by `bee_id`
 * regardless of workspace by default; pass `workspaceId` to scope. When a bee somehow has rows
 * in multiple workspaces, the highest revision wins.
 */
export async function getClaimSpecHeadsForBees(
  beeIds: string[],
  workspaceId?: string,
  sqlOverride?: OrgSql,
): Promise<Map<string, ClaimSpecHead>> {
  const map = new Map<string, ClaimSpecHead>();
  if (beeIds.length === 0) return map;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT DISTINCT ON (bee_id) bee_id, spec->>'specId' AS spec_id, revision
      FROM harness_shared.cup_claim_specs
     WHERE bee_id = ANY(${beeIds})
       ${workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``}
     ORDER BY bee_id, revision DESC`) as Array<{ bee_id: string; spec_id: string | null; revision: number }>;
  for (const r of rows) {
    if (r.spec_id) map.set(r.bee_id, { specId: r.spec_id, revision: Number(r.revision) });
  }
  return map;
}
