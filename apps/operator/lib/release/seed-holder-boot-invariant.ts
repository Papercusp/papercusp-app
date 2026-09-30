/**
 * P-015, second assertion — D-025's recurrence guard, verbatim:
 *
 *   "a process holding a hive's corestore write lock MUST answer booted:true for that hive.
 *    Cheap, falsifiable, and it would have caught this the moment it appeared rather than
 *    after an 18-day-stale release seed."
 *
 * WHY THE INVARIANT CAN BREAK. `booted` is derived from `getBootedHarness()`, an in-process
 * LRU registry. Holding the corestore's fd lock is a property of an open store handle. They
 * are two different facts about the same process and NOTHING reconciles them, so bg-host can
 * hold `…/papercusp/hyperbee/CORESTORE` (fd 114u, READ/WRITE) while answering `booted:false`
 * for that very hive — measured 2026-08-08, five probes over four minutes, no recovery.
 *
 * WHY IT NEEDS A NAME RATHER THAN JUST A REFUSAL. cut-seed-cli already refused this state,
 * correctly, but described it as "no operator process here reports having booted it" — which
 * reads as *nobody holds this hive*. That is the opposite of what is provable at that moment:
 * `sourceWritable === false` is set ONLY on `isCorestoreLockedError`, so the lock is held BY
 * SOMEONE, definitionally. Reading the refusal as an absence of holders points at remedy (b),
 * "quiesce the operator" — a fleet-affecting outage — when the actual defect is an inconsistent
 * registry that costs nothing to fix. Naming the state is the whole guard.
 *
 * The three-way split below is load-bearing. "Some sibling answered and every one said false"
 * is a genuinely different fact from "nothing answered at all", and collapsing them is how the
 * inconsistency stayed invisible: a box with no operator running is not violating anything.
 */

export type HolderBootVerdictCode =
  /** The lock is held and a process claims the boot. The invariant holds. */
  | 'consistent'
  /** Nothing holds the lock — the invariant is not engaged. */
  | 'not-engaged'
  /** D-025: the lock is held, siblings answered, and every one denied booting the hive. */
  | 'holder-without-boot'
  /** The lock is held but no sibling answered, so the holder is outside the probed set. */
  | 'holder-unreachable';

export interface HolderBootInvariantInput {
  /** True only when the corestore open failed with a LOCKED error — i.e. the lock is PROVEN held. */
  readonly storeLocked: boolean;
  /** True when some sibling answered `booted: true`. */
  readonly holderFound: boolean;
  /** Ports that answered the discovery probe at all. */
  readonly answered: readonly number[];
  /** Ports the discovery probe attempted. */
  readonly probed: readonly number[];
  /** Ports alive but serving a build older than the probe route (they cannot answer truthfully). */
  readonly staleBuild?: readonly number[];
}

export interface HolderBootVerdict {
  readonly code: HolderBootVerdictCode;
  /** false ⇒ the D-025 invariant is VIOLATED on this box right now. */
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Judge D-025's invariant. Pure — the caller supplies what it measured.
 *
 * `ok` is false ONLY for `holder-without-boot`. `holder-unreachable` is a real obstacle but not
 * a violation: a holder the probe never reached has not been shown to deny anything, and
 * reporting an unmeasured case as a violation would be the same over-claim in the other
 * direction.
 */
export function judgeHolderBootInvariant(inp: HolderBootInvariantInput): HolderBootVerdict {
  const staleBuild = inp.staleBuild ?? [];
  if (!inp.storeLocked) {
    return {
      code: 'not-engaged',
      ok: true,
      message: 'corestore write lock is free — D-025 holder⇒booted is not engaged.',
    };
  }
  if (inp.holderFound) {
    return {
      code: 'consistent',
      ok: true,
      message: 'corestore write lock is held and a process reports booted:true — D-025 holds.',
    };
  }
  if (inp.answered.length === 0) {
    const stale = staleBuild.length
      ? ` ⚠ port(s) ${staleBuild.join(', ')} are alive but predate the probe route, so they cannot answer even while holding the hive.`
      : '';
    return {
      code: 'holder-unreachable',
      ok: true,
      message:
        `the corestore write lock IS held, but no sibling answered the discovery probe ` +
        `(probed ${inp.probed.length ? inp.probed.join(', ') : 'none'}), so the holder is outside ` +
        `the probed set — this is undetermined, NOT a D-025 violation.${stale}`,
    };
  }
  return {
    code: 'holder-without-boot',
    ok: false,
    message:
      `D-025 INVARIANT VIOLATED — holder-without-boot. The corestore write lock is PROVEN held ` +
      `(the writable open failed with a corestore-locked error), yet every sibling that answered ` +
      `(${inp.answered.join(', ')} of probed ${inp.probed.join(', ')}) reports booted:false for this ` +
      `hive. Some process on this box holds the store while denying it has booted it: \`booted\` comes ` +
      `from the in-process getBootedHarness() LRU, lock ownership is an open fd, and nothing keeps ` +
      `them consistent. Do NOT read this as "nobody holds the hive" and do NOT quiesce the operator ` +
      `to work around it — that is a fleet-affecting outage for an inconsistent registry. Root-cause ` +
      `WHY the holder does not register the boot (evicted engine, undisposed drain handle); if the ` +
      `handle is orphaned, freeing it lets the cut open the store writable with NO outage.` +
      (staleBuild.length
        ? ` ⚠ port(s) ${staleBuild.join(', ')} are alive but predate the probe route — if one of THEM is ` +
          `the holder this is a stale build, not the D-025 inconsistency; restart it onto current code first.`
        : ''),
  };
}
