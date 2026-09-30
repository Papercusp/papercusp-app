/**
 * burn-alert.ts — WI-41147 leg c: the STATED WALL. When an account's burn verdict ACTION
 * transitions to/from `throttle`/`shed`, that fact must never be silent: it is asserted as a
 * standing fact (folded into every orient until it clears) and broadcast on the severe-event
 * coord rail (condition-lifecycle keyed, so a recovery annotates the alarm resolved).
 *
 * SEAM DISCIPLINE (the settled WI-41147 design): the alert fires from the observation WRITE
 * path only — every window write flows through {@link recordAccountWindowWithBurnAlert} —
 * NEVER from the `accounts:status` READ path (a read-path alert fires once per read). The
 * transition edge is detected by diffing the PERSISTED `rate.lastBurnAction` stamp
 * (`accountBurnTransition`), not by re-evaluating pre/post verdicts in context: the persisted
 * stamp survives the stale-gate window, so a re-probe of a still-burning account whose reading
 * aged out does NOT re-alarm none→shed every probe cycle.
 *
 * DELIBERATELY UN-GATED by ACCOUNT_BURN_GOVERNOR: the flag gates ENFORCEMENT (selection +
 * concurrency shed); visibility of a pool burning toward its wall must survive the owner
 * turning enforcement off — knowing is not acting.
 *
 * Fail-soft throughout: an alert failure must never break the observation write that carries
 * it (the write is the durable half).
 */
import type { AccountPool, BurnTransition } from '../deployment/account-pool';
import type { BurnVerdict } from './burn-governor';

const FACT_TTL_SEC = 6 * 3600;
const FACT_CREATED_BY = 'system:burn-governor';

const factKey = (accountId: string): string => `account-burn:${accountId}`;

/**
 * The ONE aggregate fold key (P-001 of memory-fold-pollution-and-cap-eviction-2026-09-02).
 *
 * ⚠ DO NOT GO BACK TO A FACT PER ACCOUNT. Measured 2026-09-02: the per-account form wrote
 * 4,819 of the workspace scope's 4,875 daily facts (98.9%) across 14 keys, each re-asserted
 * every 1.9–8.9 minutes. `foldFacts()` is `ORDER BY updated_at DESC LIMIT 12`, so keys
 * rewritten that fast are permanently the newest rows and won **11 of the 12** workspace fold
 * slots outright — the standing-fact fold every agent receives at orient was delivering
 * account telemetry instead of standing conclusions (visibility horizon: 13 minutes). The same
 * churn drove the cap eviction that destroyed ~2 OTHER authors' verified facts per own row.
 *
 * One aggregate key costs ONE fold slot and ONE cap seat however many accounts burn. No detail
 * is lost: per-account state stays in `accounts:status` (rows[].burn) and in the per-account
 * severe-event broadcast below, which is EDGE-triggered and therefore never crowds the fold.
 *
 * ⚠ And do NOT "fix" the seat cost with `subjectVolatile:true` — see D-001: it unconditionally
 * clamps ttlSec to 15min and would silently lapse an ACTIVE wall out of every orient on any
 * observation gap, which is a correctness regression wearing a capacity fix's clothes.
 */
const AGGREGATE_FACT_KEY = 'account-burn';

/** At most this many account ids are listed per disposition before the line elides the rest.
 *  The fact body cap (1200 chars) REFUSES an over-length write rather than clipping it, so an
 *  unbounded id list would turn a large pool into a silent alert outage. */
const AGGREGATE_MAX_IDS_LISTED = 10;

/** Who is burning right now, split by DISPOSITION — the aggregate line's raw input. */
export interface BurnAggregate {
  /** Accounts in the pool, burning or not — the denominator. */
  total: number;
  /** Burning because papercusp PROJECTS their 7d window exhausts; they still serve. */
  projected: string[];
  /** Burning because the provider's own 7d meter reads exhausted; they cannot serve. */
  measured: string[];
}

const elide = (ids: string[]): string =>
  ids.length <= AGGREGATE_MAX_IDS_LISTED
    ? ids.join(', ')
    : `${ids.slice(0, AGGREGATE_MAX_IDS_LISTED).join(', ')} +${ids.length - AGGREGATE_MAX_IDS_LISTED} more`;

/**
 * Render the single aggregate fold line.
 *
 * Keeps this file's standing reader-contract (P-001 of WI-41147): no verdict travels without
 * its DISPOSITION, so a pacing projection can never be inherited as a measured capacity wall.
 * The aggregate states the two dispositions SEPARATELY rather than summing them, because a
 * combined count would erase exactly the distinction that contract exists to protect.
 */
export function renderBurnAggregateBody(agg: BurnAggregate): string {
  const burning = agg.projected.length + agg.measured.length;
  const parts = [`${burning} of ${agg.total} accounts burning.`];
  if (agg.measured.length > 0) {
    parts.push(
      `MEASURED WALL — the provider's own 7d meter is exhausted; these cannot serve until their window resets: ${elide(agg.measured)}.`,
    );
  }
  if (agg.projected.length > 0) {
    parts.push(
      `PACING PROJECTION — THIS IS PAPERCUSP PACING ITSELF, NOT A PROVIDER WALL: these accounts still serve requests right now, and the verdict projects where their 7d window is heading. Do not read it as "we are at capacity", and do not remedy it by throttling the fleet: ${elide(agg.projected)}.`,
    );
  }
  parts.push('(burn governor WI-41147; verify: accounts:status → rows[].burn.disposition.)');
  return parts.join(' ');
}

/**
 * Record one account's observed usage window into the pool projection AND state any burn-verdict
 * wall it implies — the ONE wrapper every observation write seam (the `accounts:probe-capacity`
 * tool, the live-traffic window projector) calls instead of hand-composing
 * `updateAccountPool(recordAccountWindow(...))`. Returns the updated pool plus the transition
 * (null when the verdict action did not change), so callers can surface it in their own results.
 */
export async function recordAccountWindowWithBurnAlert(
  accountId: string,
  w: { utilization?: number; windowResetAt?: number; utilization7d?: number; windowResetAt7d?: number },
  now: number,
  ws?: string,
): Promise<{ pool: AccountPool; transition: BurnTransition | null }> {
  const [{ updateAccountPool }, { recordAccountWindow, accountBurnTransition, accountBurnVerdict }] =
    await Promise.all([import('../deployment/account-pool-store'), import('../deployment/account-pool')]);
  let transition: BurnTransition | null = null;
  let action: 'none' | 'throttle' | 'shed' | undefined;
  let verdict: BurnVerdict | null = null;
  const pool = await updateAccountPool((p) => {
    const next = recordAccountWindow(p, accountId, w, now);
    // Captured inside the mutator so the diff sees the exact pre-write row the transaction
    // read (a snapshot loaded before the txn could race a peer's write). On a txn retry the
    // capture re-runs and the final attempt wins.
    transition = accountBurnTransition(p, next, accountId, now);
    const row = next.accounts.find((a) => a.id === accountId);
    action = row?.rate.lastBurnAction ?? undefined;
    // The verdict BEHIND that stamped action, from the same authority `recordAccountWindow`
    // stamped it with (the reading is fresh by construction, so the stale gate cannot interfere).
    // Captured for the message writers so they can state the DISPOSITION — a pacing projection
    // vs a measured wall — without a second evaluation that could disagree (P-001).
    verdict = row ? accountBurnVerdict(row.rate, now) : null;
    return next;
  }, ws);
  // The aggregate is computed from the POST-WRITE POOL, not from this one account: the single
  // fold line must be correct after ANY account's write, and it must retract only when the LAST
  // burning account recovers. Reading it here (rather than inside the mutator) keeps it off the
  // txn-retry path, and reuses the `accountBurnVerdict` authority already imported above so the
  // aggregate cannot disagree with the per-account verdict stamped alongside it.
  const aggregate: BurnAggregate = { total: pool.accounts.length, projected: [], measured: [] };
  for (const row of pool.accounts) {
    const rowAction = row.rate?.lastBurnAction;
    if (rowAction !== 'throttle' && rowAction !== 'shed') continue;
    const rowVerdict = accountBurnVerdict(row.rate, now);
    if (rowVerdict?.disposition === 'pacing-projection') aggregate.projected.push(row.id);
    else aggregate.measured.push(row.id);
  }
  await stateBurnWall(accountId, action, verdict, transition, ws, aggregate).catch(() => {});
  return { pool, transition };
}

/**
 * The never-silent half. Two independent legs:
 *  - FACT: ONE aggregate `account-burn` line for the whole pool, re-asserted on EVERY
 *    observation write — the upsert refreshes the TTL, so the standing fact lives exactly as
 *    long as the condition is being OBSERVED and expires honestly when observations stop. It
 *    retracts when the LAST burning account recovers.
 *  - BROADCAST: severe-event rail, on the TRANSITION edge only (throttle/shed escalations and
 *    de-escalations broadcast the new level; recovery to none broadcasts resolved). Keyed by
 *    conditionKey so coord:inbox annotates stale alarms resolved. Still PER-ACCOUNT, and
 *    deliberately so — an edge-triggered broadcast costs nothing in the fold.
 *
 * ⚠ THE FACT LEG RUNS BEFORE THE HEALTHY-AND-UNCHANGED EARLY RETURN, and must stay there.
 * The aggregate covers the WHOLE POOL, so a write for a HEALTHY account still has to refresh
 * the shared line's TTL while OTHER accounts burn. Returning early on this one account's
 * health — which was correct while the fact was per-account — would let the aggregate lapse
 * out of every orient after 6h of healthy-account writes with a wall still standing.
 */
async function stateBurnWall(
  accountId: string,
  action: 'none' | 'throttle' | 'shed' | undefined,
  verdict: BurnVerdict | null,
  transition: BurnTransition | null,
  ws?: string,
  aggregate?: BurnAggregate,
): Promise<void> {
  if (action === undefined) return; // unknown account — the write was a no-op

  if (aggregate) {
    const { assertFact, retractFact } = await import('../agent-facts/store');
    if (aggregate.projected.length + aggregate.measured.length > 0) {
      await assertFact({
        scope: 'workspace',
        key: AGGREGATE_FACT_KEY,
        body: renderBurnAggregateBody(aggregate),
        createdBy: FACT_CREATED_BY,
        // 6h, deliberately UNCHANGED (D-001): long enough that an active wall survives a gap
        // between observation writes, and honest expiry when observations stop altogether.
        ttlSec: FACT_TTL_SEC,
        ...(ws ? { workspaceId: ws } : {}),
      }).catch((e) => {
        console.warn(
          `[burn-alert] aggregate fact assert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    } else if (transition?.to === 'none') {
      // The burning set is empty AND this write is the recovery edge — i.e. the LAST burning
      // account just cleared, so the shared line comes down. Gated on the transition, not on
      // emptiness alone: a healthy pool writes observations constantly, and retracting on
      // every one of them would issue a pointless store round-trip per write and break this
      // seam's "a healthy, unchanged account states NOTHING" contract.
      await retractFact({
        scope: 'workspace',
        key: AGGREGATE_FACT_KEY,
        ...(ws ? { workspaceId: ws } : {}),
        retractedBy: FACT_CREATED_BY,
        reason: `every account recovered to none — no wall asserted (last was '${accountId}', from ${transition.from})`,
      }).catch(() => {});
    }
  }

  const burning = action === 'throttle' || action === 'shed';
  if (!burning && !transition) return; // healthy and unchanged — nothing further to state

  // P-001: EVERY surface leads with the DISPOSITION, so a reader can never inherit a pacing
  // projection as a measured capacity wall. The broadcasts below render their verdict from
  // `transition.label`; the standing fact renders the pool's dispositions in
  // `renderBurnAggregateBody`. Both honour the contract — there is no longer a per-account
  // verdict string composed here.
  const projected = verdict?.disposition === 'pacing-projection';

  if (!transition) return;

  if (transition.to === 'none') {
    // Recovery: resolve the alarm. The standing fact is NOT retracted here — it is the
    // pool-wide aggregate now, and this account recovering does not mean the others did.
    // Its retract lives in the aggregate leg above, which fires when the burning set empties.
    const { broadcastSevereEventResolved } = await import('../severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: factKey(accountId),
      // `transition.label` and not a bare `none`: the recovery line states a verdict too, and the
      // reader-contract is that no verdict string travels without its disposition (P-005). Here it
      // renders as "no wall asserted", which is the whole point — the alarm is over.
      summary: `account '${accountId}' burn RECOVERED (was ${transition.from}) → ${transition.label}: ${transition.reason}`,
    });
    return;
  }

  const { broadcastSevereEvent } = await import('../severe-event-broadcast');
  await broadcastSevereEvent({
    summary: `account '${accountId}' burn ${transition.label} (was ${transition.from}): ${transition.reason}`,
    body:
      (projected
        ? `PACING POLICY, NOT A MEASURED WALL. The burn governor (WI-41147) PROJECTS this account's rolling ` +
          `7-day window exhausts on its current trajectory — the account is serviceable right now and the ` +
          `provider has walled nothing. Do not report this as "at capacity", and do not remedy it by ` +
          `throttling the fleet.\n`
        : `MEASURED WALL. The provider's own rolling 7-day meter reads exhausted — this is an observation, ` +
          `not a projection: the account cannot serve until its window resets.\n`) +
      `Verdict: ${transition.label} — ${transition.reason}\n` +
      `Selection already ${transition.to === 'shed' ? 'refuses' : 'deprioritizes'} this account while the verdict stands; ` +
      `the pool-aggregate lever sheds fleet concurrency if EVERY account is burning. ` +
      `Verify with accounts:status (rows[].burn — read .disposition before acting); ` +
      `accounts:probe-capacity refreshes a stale projection.`,
    category: 'account-burn',
    conditionKey: factKey(accountId),
    // Edge-triggered by construction: this emitter alarms on the TRANSITION and stays silent
    // while the verdict persists — declare it so the staleness reconciler doesn't read the
    // deliberate silence as recovery (WI-6228).
    oneShot: true,
  });
}
