/**
 * condition-bridge.ts — P-003 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * The reconciler that turns a CONDITION into a claimable OBJECT: when an
 * actionable condition opens, mint (at most) one owning work-item; when it
 * resolves, release the key so a future occurrence can mint a fresh one.
 *
 * ONE bridge, not per-watchdog wiring. There are 12 `conditionKey` producers
 * (`green-stall:<slug>`, `main-behind-staging:<slug>`, `single-primary:<verdict>`,
 * `release-trigger-freeze:<slug>`, ...). Wiring each to file its own work-item is
 * how the ad-hoc versions got built four times already (see D-002) and how they
 * drifted. Every producer inherits this one instead.
 *
 * ── WHY THE RACE IS SAFE, AND WHY THAT IS THE POINT ────────────────────────────
 * Two hosts can observe the same condition open simultaneously. The claim here is
 * deliberately optimistic — create, then try to take the key — because migration
 * 741's PARTIAL UNIQUE INDEX serializes the winner in Postgres. The loser gets a
 * unique violation, stands down, and adopts the winner's item.
 *
 * That is the whole thesis of D-002 stated as code: WI-6986 implemented this same
 * dedup as a QUERY ("is there already one?") and raced, duplicating "40 of 88 open
 * rows" cross-machine. A check-then-act cannot be made safe by checking harder; a
 * unique index needs no check at all.
 *
 * ── OPENNESS IS `status`, NEVER `closed_ts` ───────────────────────────────────
 * See D-010 and condition-object.ts's header. `closed_ts` is NULL on 100% of
 * `closed` rows and 77-99% of the other terminals — it is a best-effort precision
 * stamp, not a lifecycle field. Every terminal test here derives from
 * `ANY_FAMILY_TERMINAL_STATES`; no status vocabulary is re-listed.
 *
 * ── SELF-HEALING ──────────────────────────────────────────────────────────────
 * Release is a write, and writes can be missed (a crash between settling an item
 * and clearing its key). So `acquireConditionOwner` FIRST clears the key from any
 * already-terminal row holding it. A missed release therefore costs one extra
 * cycle, not a permanently unownable condition — which is the failure mode D-010
 * was written to eliminate, restated at the layer that can actually violate it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { createWorkItem, setWorkItemState } from '../work-items';
import { resolveWorkItemPot } from '../pot-membership';
import { findConditionObject, linkWorkItemToCondition, type ConditionObject } from './condition-object';

// The condition-key opt-in CATALOG lives in the zero-import leaf './actionable-conditions'
// (P-013/D-012 of gate-verdict-liveness-and-repair-reliability-2026-08-31): the
// work-items-admission layer needs the alarm-prefix set for the stop-the-line claim floor,
// and this module imports work-items.ts — so admission importing THIS module would cycle.
// Re-exported in full so every existing `from './condition-bridge'` importer keeps working
// unchanged — the CLAIM_STATES_ALLOWLIST re-export precedent (work-items.ts / EI-11300).
import { actionableConditionFor, isActionableConditionKey } from './actionable-conditions';
export {
  ACTIONABLE_CONDITIONS,
  ACTIONABLE_CONDITION_PREFIXES,
  GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX,
  actionableConditionFor,
  isActionableConditionKey,
  type ActionableCondition,
} from './actionable-conditions';

/**
 * Which harness owns this condition — or null when it cannot be established.
 *
 * FAIL-CLOSED on purpose: returning null makes the caller SKIP the condition,
 * which costs one un-owned condition. Guessing instead costs a work-item filed
 * into a harness that does not exist, which nothing surfaces and nobody sees.
 */
export function resolveConditionHarness(
  conditionKey: string,
  ambientHarness?: string | null,
): string | null {
  const key = conditionKey.trim();
  const entry = actionableConditionFor(key);
  if (!entry) return null;
  if (entry.harnessFrom === 'ambient') return ambientHarness?.trim() || null;
  const suffix = key.slice(entry.prefix.length).trim();
  // A suffix carrying further ':' segments is not a bare slug — don't guess.
  return suffix && !suffix.includes(':') ? suffix : ambientHarness?.trim() || null;
}

/** PURE. Is this status settled? Derived from the shared SSOT, never re-listed. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && ANY_FAMILY_TERMINAL_STATES.includes(status);
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

export interface ConditionOwnerSpec {
  /** Work-item title (usually the condition's own alarm summary). */
  title: string;
  /** Body text — what opened, the evidence, what to do. */
  summary?: string;
  harness: string;
  workspaceId?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
}

export interface AcquireResult {
  conditionKey: string;
  /** The work-item that owns the condition after this call. */
  workItem: string | null;
  /** True when THIS call minted it. False = adopted an existing owner (incl. losing a race). */
  created: boolean;
  /** Set when we minted an item, lost the claim race, and stood down. */
  lostRaceTo?: string;
  /**
   * Set when standing down FAILED to settle the row we had optimistically
   * minted — i.e. a duplicate is now open, and this is its id.
   *
   * Reported rather than swallowed. The stand-down close is the one write that
   * keeps a lost race from becoming the very duplicate this module exists to
   * prevent, so a caller must be able to see that it did not happen instead of
   * inferring success from the absence of a throw. See the actor note on
   * {@link CONDITION_BRIDGE_ACTOR} for how this failed silently for real.
   */
  duplicateLeftOpen?: string;
  /**
   * Set when nothing was written, and WHY:
   *   • `not-actionable`      — the key is not opted in.
   *   • `unresolved-harness`  — the storage harness could not be resolved, so
   *     minting was REFUSED (D-001). See {@link unresolvedHarness}.
   *
   * ⚠ A caller must check this before reading {@link workItem}. On
   * `unresolved-harness`, `workItem: null` means "could not determine", NOT
   * "nobody owns this condition" — treating the two as the same is precisely how
   * a degraded read became a positive unowned verdict for an owned condition.
   */
  skipped?: 'not-actionable' | 'unresolved-harness';
  /**
   * Detail for `skipped: 'unresolved-harness'` — the slug we could not resolve
   * and which failure mode it was. Present so the refusal is diagnosable from
   * the RESULT rather than only from a log line the caller may not be reading.
   */
  unresolvedHarness?: {
    requested: string;
    reason: 'no-workspace' | 'pot-unresolved' | 'pot-lookup-failed';
    error?: string;
  };
}

/**
 * The principal this module writes lifecycle transitions as.
 *
 * ⚠ NOT COSMETIC — its absence was a live, silent defect (found by
 * `condition-bridge.integration.test.ts`, P-008). The completion-integrity gate
 * (`setIssueState`, WI-1403) REJECTS any terminal transition that carries no
 * `by`, by THROWING. Both of this module's closes ran without one, and both
 * wrapped the call in `.catch(() => undefined)` — so on every real database:
 *
 *   • a lost race never dropped the row it had optimistically minted, leaving a
 *     permanently-open duplicate; the exact failure D-002 exists to prevent,
 *     reintroduced in the path that prevents it.
 *   • `releaseConditionOwner({ settle: true })` never settled anything, and
 *     still returned `settled: true` — so the reconciler leaked one
 *     permanently-open work-item per condition EPISODE (D-011's leak, reported
 *     as fixed) and D-020's marker gate was guarding a write that never ran.
 *
 * Neither was visible to a unit test: a faked store has no completion gate to
 * trip. `system:` prefix matches the existing convention (RECONCILER_SYSTEM_ACTOR
 * = 'system:plan-item-reconcile') so these closes stay attributable to a named
 * system actor rather than becoming anonymous flips — which is precisely what
 * the gate is there to forbid.
 */
export const CONDITION_BRIDGE_ACTOR = 'system:condition-bridge' as const;

/**
 * Settle a work-item, reporting whether it ACTUALLY settled.
 *
 * The durable fix for the class, not just the two call sites: a lifecycle write
 * that can be refused must never be asserted successful by a caller that
 * discarded its outcome. `.catch(() => undefined)` at a call site whose result
 * feeds a `settled: true` is how a hard, loud, correct rejection became a
 * silent lie for the life of this module.
 */
async function settleWorkItem(id: string, state: 'done' | 'dropped', opts: { harness?: string; reason: string }): Promise<boolean> {
  try {
    await setWorkItemState(id, state, {
      harness: opts.harness,
      by: CONDITION_BRIDGE_ACTOR,
      completionRef: opts.reason,
    });
    return true;
  } catch {
    // Still non-throwing: a failed settle must not abort the sweep (the key
    // release below is the load-bearing half). The difference is that the
    // failure is now RETURNED instead of discarded.
    return false;
  }
}

/**
 * Clear `condition_key` from any row holding it that has already SETTLED.
 *
 * The self-heal described in the header. Returns how many rows were released, so
 * a caller can log a missed release rather than let it pass silently — a nonzero
 * count here means some earlier release did not run, which is worth knowing.
 */
export async function releaseStaleConditionKeys(conditionKey: string, workspaceId?: string): Promise<number> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET condition_key = NULL
     WHERE condition_key = ${conditionKey}
       AND status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[])
       AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
    RETURNING feature_id`;
  return rows.length;
}

/**
 * The harness this condition's work-item will ACTUALLY be stored under.
 *
 * ⚠ NOT the harness the caller passed, and that gap was a live bug
 * (EI-19407969585168294). `createIssue` homes every issue to a real Pot via
 * `resolveWorkItemPot`, so a MEMBER harness is normalized to its hive home
 * before the row lands: the bridge asked for `oddsmith` and the row appeared as
 * `harness:oddsmith-hive`. Ownership was then read back with the UN-normalized
 * slug, so `acquireConditionOwner` could never see the row it had just created —
 * it re-minted on every tick, lost the key race to the incumbent, and stood
 * down, forever. Measured live on `green-stall:oddsmith`: one healthy owner
 * (WI-7321) and three doomed re-mints in ~50 minutes.
 *
 * Resolving it ONCE here, inside the bridge, is what keeps the read and the
 * write in agreement for every producer — rather than asking each of the 12
 * condition producers to pre-normalize and leaving the trap armed for the 13th.
 *
 * ⚠ FAILS CLOSED — it used to fail OPEN, and that is what produced 29,645 junk
 * rows (EI-19930875455827867, D-001). The old body returned the caller's own
 * slug on any failure, with the rationale "the behavior is exactly what it was
 * before this function existed." That rationale is wrong in a way worth naming,
 * because it sounds conservative: restoring the PRE-FIX behavior restores the
 * PRE-FIX BUG, in the one code path that had already proven it. Measured
 * consequence — `reconcileConditions` forwarded `workspaceId: undefined`, so
 * `resolveWorkItemPot` could not resolve a Pot, so this silently returned the
 * member slug `oddsmith`; the ownership read was then scoped to `oddsmith` and
 * missed the incumbent stored as `oddsmith-hive`, while `createIssue` normalized
 * the NEW row to the Pot home anyway. Every tick therefore minted a row, lost
 * the claim race to the incumbent it could not see, and dropped its own row —
 * ~190/hour, 45.3% of the whole work_items table.
 *
 * So an unresolvable harness is now a REFUSAL the caller must handle, not a
 * plausible-looking string it cannot distinguish from a real answer. The two
 * failure modes are reported separately because they need different responses: a
 * THROW means the Pot lookup is broken (infrastructure), an empty result means
 * this harness genuinely has no Pot home (data).
 */
export type StoredConditionHarness =
  | { ok: true; harness: string; normalized: boolean }
  | {
      ok: false;
      requested: string;
      reason: 'no-workspace' | 'pot-unresolved' | 'pot-lookup-failed';
      error?: string;
    };

export async function resolveStoredConditionHarness(
  harness: string,
  workspaceId?: string,
): Promise<StoredConditionHarness> {
  // ⚠ THE WORKSPACE CHECK MUST COME FIRST, and it is the whole fix. Delegating to
  // `resolveWorkItemPot` and testing its result for emptiness looks like the
  // obvious guard and is INERT on the exact path that caused this incident:
  // `resolveWorkItemPot` opens with
  //
  //     if (!ws || ws === '*') return args.rawSlug?.trim() || null;   // :125
  //
  // so with no concrete workspace it hands back the RAW SLUG — non-null,
  // non-empty, indistinguishable from a successfully normalized answer. That is a
  // deliberate fail-open in ITS contract ("no per-workspace Pot set to enforce
  // against") and it is useless as a signal for OURS. Production forwarded
  // `workspaceId: undefined`, so an emptiness test would have returned
  // `ok: true, harness: 'oddsmith'` and changed nothing.
  //
  // Worth stating plainly because it nearly happened twice: the 29,645-row bug
  // WAS an inert fix (D-022, inert because its only caller passed `{}`), and the
  // natural repair is a second inert fix layered on the first. A guard that
  // delegates its decision to a function documented to fail open cannot fail
  // closed. So decide it HERE, on the input we actually hold.
  //
  // This is also D-001 read literally — "REFUSE to mint when it cannot resolve a
  // WORKSPACE" — rather than generalized to "a harness", which is what invited the
  // inert version.
  const ws = workspaceId?.trim();
  if (!ws || ws === '*') return { ok: false, requested: harness, reason: 'no-workspace' };

  try {
    const pot = await resolveWorkItemPot({ rawSlug: harness, workspaceId: ws });
    const slug = pot?.trim();
    if (!slug) return { ok: false, requested: harness, reason: 'pot-unresolved' };
    return { ok: true, harness: slug, normalized: slug !== harness };
  } catch (err) {
    // Includes PotMembershipError — an explicit slug that is not a real Pot in a
    // workspace that HAS a platform Pot. Refusing is right: we would otherwise
    // store under a slug the Pot set rejects.
    return {
      ok: false,
      requested: harness,
      reason: 'pot-lookup-failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The work-item currently HOLDING this key — read from the `condition_key`
 * COLUMN, which is the thing the partial unique index actually enforces.
 *
 * WHY NOT `findConditionObject`. That resolves ownership from the append-only
 * `about` LINK, and ownership is WRITTEN to two places (the column, then the
 * link) while being READ from only one. Any row holding the key without a link
 * — a failed best-effort link write, or a hand-adopted key, which D-020 made
 * SAFE and therefore attractive — is invisible to the link read while still
 * blocking the index. The condition then cannot be owned at all, and each tick
 * mints and discards a work-item, forever.
 *
 * So the ADOPT decision reads the enforcement point and the link read stays for
 * the richer claim state (who holds it, is the lease live). The column is
 * current ownership; the link is history. Asking the enforcement point whether
 * something is enforced needs no second opinion.
 */
export async function findConditionKeyHolder(
  conditionKey: string,
  opts: { harnessSlug?: string; workspaceId?: string } = {},
): Promise<string | null> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE condition_key = ${conditionKey}
       AND (status IS NULL OR status <> ALL(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       AND (${opts.harnessSlug ?? null}::text IS NULL OR harness_slug = ${opts.harnessSlug ?? null})
       AND (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null})
     ORDER BY created_ts
     LIMIT 1`;
  return rows[0]?.feature_id ?? null;
}

/**
 * Try to take `conditionKey` for an existing work-item.
 *
 * Returns false when another row already holds it (the unique index refused us).
 * The `condition_key IS NULL` guard keeps this idempotent: re-claiming a key we
 * already hold is a no-op rather than an error.
 */
export async function claimConditionKey(
  workItemId: string,
  conditionKey: string,
  workspaceId?: string,
): Promise<boolean> {
  const sql = getOrgPg().sql;
  try {
    const rows = await sql<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET condition_key = ${conditionKey}
       WHERE feature_id = ${workItemId}
         AND condition_key IS NULL
         AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
      RETURNING feature_id`;
    return rows.length > 0;
  } catch (err) {
    // Expected under a cross-host race — the index did its job.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Ensure an actionable condition has exactly one owning work-item.
 *
 * Idempotent: calling it repeatedly while the condition stays open adopts the
 * existing owner and writes nothing.
 */
export async function acquireConditionOwner(
  conditionKey: string,
  spec: ConditionOwnerSpec,
): Promise<AcquireResult> {
  const key = conditionKey.trim();
  if (!isActionableConditionKey(key)) {
    return { conditionKey: key, workItem: null, created: false, skipped: 'not-actionable' };
  }

  // 0. The harness the row will actually be STORED under — resolved once and
  //    used for every read AND the create below, so they cannot disagree.
  //    See resolveStoredConditionHarness: they did disagree, and it cost a
  //    doomed work-item per tick.
  const resolved = await resolveStoredConditionHarness(spec.harness, spec.workspaceId);
  if (!resolved.ok) {
    // FAIL CLOSED (D-001). Minting on this path is what produced 29,645 rows:
    // every read would be scoped to the un-normalized slug and miss an incumbent
    // that `createIssue` normalizes into a collision with anyway.
    //
    // Refusing OUTRIGHT would be its own bug though — it would report "no owner"
    // for a condition that may be perfectly well owned. So first ask the question
    // that is still soundly answerable: the unique index is keyed
    // (workspace_id, harness_slug, condition_key), so within one workspace this
    // key has at most one live holder REGARDLESS of the harness it was stored
    // under. A harness-UNSCOPED read therefore finds the incumbent that the
    // wrong-slug read never could, and adopting it is a true positive rather than
    // a guess. Note this read cannot return a settled row: findConditionKeyHolder
    // already excludes terminal states.
    const incumbent = await findConditionKeyHolder(key, { workspaceId: spec.workspaceId });
    if (incumbent) return { conditionKey: key, workItem: incumbent, created: false };
    // Genuinely undetermined: no incumbent found AND no trustworthy harness to
    // mint under. `skipped` is what stops a caller reading this as "unowned".
    return {
      conditionKey: key,
      workItem: null,
      created: false,
      skipped: 'unresolved-harness',
      unresolvedHarness: {
        requested: resolved.requested,
        reason: resolved.reason,
        ...(resolved.error ? { error: resolved.error } : {}),
      },
    };
  }
  const harness = resolved.harness;

  // 1. Self-heal a missed release BEFORE looking for an owner, or a settled row
  //    would look like a live one and this condition could never be re-owned.
  await releaseStaleConditionKeys(key, spec.workspaceId);

  // 2. Already owned? Adopt it. The COLUMN is asked first because it is the
  //    enforcement point — a holder invisible here is a holder the unique index
  //    will nonetheless refuse us, which is precisely the state that produces an
  //    unownable condition. The link read remains as the second opinion for a
  //    row that carries the association but (somehow) not the key.
  const holder = await findConditionKeyHolder(key, { harnessSlug: harness, workspaceId: spec.workspaceId });
  if (holder) return { conditionKey: key, workItem: holder, created: false };
  const existing = await findConditionObject(key, { harnessSlug: harness });
  if (existing.workItem) return { conditionKey: key, workItem: existing.workItem, created: false };

  // 3. Mint, then try to take the key. Deliberately optimistic — see the header.
  const item = await createWorkItem({
    kind: 'bug',
    title: spec.title,
    summary: spec.summary,
    harness,
    severity: spec.severity ?? 'major',
    workspaceId: spec.workspaceId,
    // Admission (work-queue-admission-and-bulk-dedup-2026-08-24 P-002): auto, not
    // pending. The CONDITION KEY is already a stronger duplicate guarantee than the
    // promoter's similarity score — an exact key, checked immediately above
    // (`findConditionObject`), so a second reporter of the same condition adopts the
    // incumbent instead of minting. Holding an INCIDENT item for a ≤30-minute promoter
    // tick would delay exactly the class where delay costs most, to re-answer a
    // question the key has already answered exactly.
    admission: 'auto',
    admittedBy: 'bypass:condition-key',
    // Stamp the mint so `releaseConditionOwner` can tell an INCIDENT item (safe to
    // auto-settle) from a hand-filed ROOT-CAUSE item that merely holds the same key.
    // See BRIDGE_MINT_MARKER.
    payload: { [BRIDGE_MINT_MARKER]: { conditionKey: key, mintedAt: new Date().toISOString() } },
  } as Parameters<typeof createWorkItem>[0]);

  const won = await claimConditionKey(item.id, key, spec.workspaceId);
  if (!won) {
    // A peer won the race. Stand down: settle our row so it does not become the
    // very duplicate this plan exists to prevent, and adopt the winner.
    //
    // The winner is resolved from the COLUMN first for the same reason as step 2,
    // and it matters MORE here: we know a row holds the key (that is why we
    // lost), so a link-only read that returns null would report `workItem: null`
    // — "nobody owns this" — at the exact moment the index proved somebody does.
    const winner =
      (await findConditionKeyHolder(key, { harnessSlug: harness, workspaceId: spec.workspaceId })) ??
      (await findConditionObject(key, { harnessSlug: harness })).workItem;
    const droppedOk = await settleWorkItem(item.id, 'dropped', {
      harness,
      reason: `superseded by ${winner ?? 'the concurrent owner'} — lost the condition-key claim race for '${key}'`,
    });
    return {
      conditionKey: key,
      workItem: winner,
      created: false,
      lostRaceTo: winner ?? undefined,
      ...(droppedOk ? {} : { duplicateLeftOpen: item.id }),
    };
  }

  // 4. Record the durable association too. The link is append-only history; the
  //    column is current ownership. Best-effort: a failed link must not orphan a
  //    successful claim (the claim is the load-bearing half).
  await linkWorkItemToCondition(item.id, key, { harness }).catch(() => undefined);

  return { conditionKey: key, workItem: item.id, created: true };
}

/**
 * Payload key stamping an item the BRIDGE MINTED (EI-19395923444306887).
 *
 * The distinction it encodes is the whole point, and it is not visible from the
 * `condition_key` column alone:
 *
 *   - an INCIDENT item (bridge-minted) means "this condition is open right now".
 *     Its lifetime IS the condition's, so auto-settling it on resolve is correct.
 *   - a ROOT-CAUSE item (hand-filed) means "this detector/subsystem is defective".
 *     It OUTLIVES the condition, so auto-settling it is destructive.
 *
 * A condition resolving is not the same event as the bug being fixed:
 * `single-primary:no-primary` clearing means a background primary is running
 * again, and says nothing about the guard defect that let the alarm fail to stand
 * down. Without this marker, `releaseConditionOwner({ settle: true })` closes
 * WHATEVER row holds the key — so backfilling `condition_key` onto a hand-filed
 * root-cause bug (an attractive cleanup, with ~6 `single-primary:no-primary`
 * filings sitting there inviting it) would let a transient recovery silently
 * close a documented bug on the reconciler's 5-minute cadence.
 *
 * Stamping makes that adoption SAFE rather than merely forbidden, which is the
 * better property: the idea is genuinely attractive and will be re-proposed, and
 * a documented prohibition only works on people who read the document.
 */
export const BRIDGE_MINT_MARKER = '_bridge';

export interface ReleaseResult {
  conditionKey: string;
  released: string | null;
  /** True when the owning item was also settled by this call. */
  settled: boolean;
  /**
   * Set when `settle: true` was asked for but deliberately NOT honored. Today the
   * only reason is `not-bridge-minted`: the key was released (so the next
   * occurrence mints fresh) while the hand-filed item it was on stays OPEN.
   *
   * Reported rather than silent — a caller that asked to settle and did not gets
   * to see why, instead of inferring it from `settled: false`.
   */
  settleSkipped?: 'not-bridge-minted';
}

/**
 * The condition resolved — release its key so a future occurrence mints fresh.
 *
 * `settle` closes the owning work-item as well. Default false: a condition
 * clearing does not always mean the work is finished (a gate that goes green on
 * its own may still deserve a post-mortem), so releasing the KEY and settling the
 * ITEM are kept separate decisions.
 *
 * ⚠ `settle: true` is HONORED ONLY for an item the bridge minted. A hand-filed
 * root-cause bug that holds this key is released but left OPEN, reported as
 * `settleSkipped: 'not-bridge-minted'`. See {@link BRIDGE_MINT_MARKER} — the key
 * releasing and the bug being fixed are different events.
 */
export async function releaseConditionOwner(
  conditionKey: string,
  opts: { harness?: string; workspaceId?: string; settle?: boolean; reason?: string } = {},
): Promise<ReleaseResult> {
  const key = conditionKey.trim();
  // Same normalization as the acquire path — a release scoped to the caller's
  // un-normalized harness would fail to find the very row the bridge stored.
  //
  // ⚠ Deliberately does NOT fail closed the way `acquireConditionOwner` does, and
  // the asymmetry is the whole point. Refusing to RELEASE would leave the key held
  // by a row nothing will ever clear, making the condition permanently unownable —
  // strictly worse than acquiring a duplicate, and the exact state this module
  // exists to prevent. So when the harness cannot be resolved we WIDEN to a
  // workspace-scoped, harness-UNSCOPED read (sound: the key has at most one live
  // holder per workspace) rather than NARROW to a slug we know may be wrong.
  let harness: string | undefined;
  if (opts.harness) {
    const resolvedHarness = await resolveStoredConditionHarness(opts.harness, opts.workspaceId);
    harness = resolvedHarness.ok ? resolvedHarness.harness : undefined;
  }
  // COLUMN first (the enforcement point), link second. A holder with no link is
  // exactly the row that must be released here: leaving its key in place is what
  // makes the condition permanently unownable.
  const owner =
    (await findConditionKeyHolder(key, { harnessSlug: harness, workspaceId: opts.workspaceId })) ??
    (await findConditionObject(key, { harnessSlug: harness })).workItem;
  if (!owner) {
    // Still sweep terminal holders — a settled row may hold the key even when no
    // LIVE owner exists, and leaving it there blocks the next occurrence.
    await releaseStaleConditionKeys(key, opts.workspaceId);
    return { conditionKey: key, released: null, settled: false };
  }
  const current = { workItem: owner };

  // Settle ONLY an item the bridge itself minted. A hand-filed root-cause bug can
  // legitimately hold this key (adopting one instead of minting a duplicate is the
  // obvious cleanup), and closing it because the CONDITION cleared would destroy a
  // documented finding on a 5-minute cadence — see BRIDGE_MINT_MARKER.
  let settled = false;
  let settleSkipped: ReleaseResult['settleSkipped'];
  if (opts.settle) {
    if (await isBridgeMinted(current.workItem, opts.workspaceId)) {
      // `settled` is what the close ACTUALLY did — never an assumption. Asserting
      // it while discarding the outcome is what hid this module's own defect.
      settled = await settleWorkItem(current.workItem, 'done', {
        harness,
        reason: opts.reason ?? `condition '${key}' resolved`,
      });
    } else {
      // Release the key below (so the next occurrence mints fresh) but leave the
      // item OPEN. Fails SAFE: an unreadable payload reads as not-bridge-minted, so
      // the failure mode is a stale-open incident item, never a destroyed bug report.
      settleSkipped = 'not-bridge-minted';
    }
  }

  const sql = getOrgPg().sql;
  await sql`
    UPDATE harness_shared.work_items
       SET condition_key = NULL
     WHERE condition_key = ${key}
       AND (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null})`;

  return { conditionKey: key, released: current.workItem, settled, ...(settleSkipped ? { settleSkipped } : {}) };
}

/**
 * Was this work-item MINTED by the bridge (as opposed to hand-filed and merely
 * holding the key)?
 *
 * FAILS SAFE to `false`: an unreadable payload, a missing row, or a store error
 * all read as "not bridge-minted", so the worst outcome is an incident item left
 * open for a human to close — never a hand-filed root-cause bug auto-closed by a
 * transient recovery. The asymmetry is deliberate; the two errors are not
 * comparable in cost.
 */
export async function isBridgeMinted(workItem: string, workspaceId?: string): Promise<boolean> {
  try {
    const sql = getOrgPg().sql;
    const rows = await sql<{ minted: boolean }[]>`
      SELECT (payload -> ${BRIDGE_MINT_MARKER}) IS NOT NULL AS minted
        FROM harness_shared.work_items
       WHERE feature_id = ${workItem}
         AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null})
       LIMIT 1`;
    return rows[0]?.minted === true;
  } catch {
    return false;
  }
}

/** One condition as the bridge sees it. */
export interface ConditionState {
  conditionKey: string;
  open: boolean;
  title: string;
  summary?: string;
  harness: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
}

export interface ReconcileSummary {
  acquired: AcquireResult[];
  released: ReleaseResult[];
  skipped: number;
}

/**
 * Reconcile a batch of condition states — the tick body.
 *
 * Fail-soft per condition: one bad key must not abort the sweep, or a single
 * malformed condition would stop every other condition from being owned.
 *
 * ── WHY RESOLVE MUST SETTLE THE ITEM, NOT JUST RELEASE THE KEY ────────────────
 * `releaseConditionOwner` defaults `settle:false` — releasing the KEY and closing
 * the ITEM are separate decisions for a caller that wants a post-mortem. For THIS
 * caller they are not separable, and defaulting them apart is a work-item leak:
 *
 *   open -> mint WI-A ; resolve -> release key, WI-A STAYS OPEN ;
 *   re-open -> mint WI-B ; resolve -> ... WI-B stays open ; ...
 *
 * i.e. one permanently-open work-item per EPISODE — which is exactly the
 * duplicate-filing problem this plan exists to eliminate, reintroduced through
 * the exit path. It bites hardest on a flapping condition, and the actionable set
 * contains a measured flapper: `main-behind-staging:papercusp` resolved 15:45Z and
 * re-opened 18:30Z on 2026-08-02 alone (40 alarms). P-003's own text is explicit —
 * "condition opens -> upsert the singleton work-item; condition resolves -> CLOSE
 * IT" — so the singleton guarantee is only true if the close actually happens.
 *
 * That `settle: true` is SAFE here only because the close is scoped to items the
 * bridge minted ({@link BRIDGE_MINT_MARKER}). The two constraints read as opposites
 * and are not: this caller must close the INCIDENT item it created, and must never
 * close a hand-filed ROOT-CAUSE item that happens to hold the same key. The marker
 * is what makes "always settle on resolve" and "never auto-close someone's bug
 * report" simultaneously true.
 */
export async function reconcileConditions(
  states: readonly ConditionState[],
  opts: { workspaceId?: string } = {},
): Promise<ReconcileSummary> {
  const out: ReconcileSummary = { acquired: [], released: [], skipped: 0 };
  for (const s of states) {
    const entry = actionableConditionFor(s.conditionKey);
    if (!entry) {
      out.skipped += 1;
      continue;
    }
    try {
      if (s.open) {
        out.acquired.push(
          await acquireConditionOwner(s.conditionKey, {
            title: s.title,
            summary: s.summary,
            harness: s.harness,
            severity: s.severity ?? entry.severity,
            workspaceId: opts.workspaceId,
          }),
        );
      } else {
        out.released.push(
          await releaseConditionOwner(s.conditionKey, {
            harness: s.harness,
            workspaceId: opts.workspaceId,
            settle: true,
            reason: `condition '${s.conditionKey}' resolved — closed by the condition bridge`,
          }),
        );
      }
    } catch {
      // Swallow per-condition; the next tick retries. Nothing here is the last
      // chance to act on a condition.
    }
  }
  return out;
}

export type { ConditionObject };
