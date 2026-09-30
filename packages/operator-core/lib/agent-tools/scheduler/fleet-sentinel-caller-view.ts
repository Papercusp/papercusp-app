/**
 * EI-20304090779240149: `scheduler:get_claim_spec { fleet }` answers about the FLEET's own
 * sentinel row, but its result was shaped identically to the caller-scoped `{ cupId }` read —
 * same `{ source:'fleet', spec, revision }` envelope — so an agent asking "what spec am I
 * running under?" got a confident "fleet, rev 7" that was never a statement about itself.
 *
 * Measured live 2026-08-13 (su-48bb5561, papercusp-workspace): at 02:42:50Z the session read
 * `{ fleet:'nonp2p-bug-drain-headless-0812' }` and got fleet rev7; at 02:43:00Z
 * `scheduler:get_next { harness }` claimed out-of-lane WI-5988 under DEFAULT_CLAIM_SPEC,
 * because `fleet_membership_events` held NO join for that owner (its first was 02:43:43Z,
 * after the incident). Both reads were CORRECT about their own subject; only the shape
 * invited reading one as the other. The report filed it as "get_next ignored restored fleet
 * membership" — membership was never restored, so no change to the claim path would have
 * helped. The fix belongs on the READ that misled the caller.
 *
 * Same class as the repo's bounded-measurement rule: a value that is only true of another
 * subject must say so ON the value, not in prose the caller read minutes earlier. Pure and
 * DB-free so it is unit-testable against a permanently-wrong control (see the sibling test)
 * rather than needing a live fleet.
 */

/** The subset of a resolved {@link import('../../scheduler/claim-spec-store').ClaimSpecRecord}
 *  this view needs — kept structural so a caller can pass a full record unchanged. */
export interface CallerSpecResolution {
  source: 'cup' | 'fleet' | 'default';
  revision: number | null;
  fleetSlug?: string;
}

export interface FleetSentinelCallerView {
  /** Whether the caller's OWN pulls actually resolve to the sentinel being read. */
  appliesToCaller: boolean;
  callerEffective: {
    ownerId: string;
    /** false when the caller's own resolution could not be read — never silently `applies`. */
    resolved: boolean;
    source: 'cup' | 'fleet' | 'default' | null;
    revision: number | null;
    fleetSlug: string | null;
  };
  /** Present only when the sentinel is NOT the caller's effective spec (or is unknown). */
  warning?: string;
}

/**
 * Explain a fleet-sentinel read RELATIVE TO THE CALLER.
 *
 * `callerRecord: null` means the caller's own resolution could not be read; that is reported
 * as unresolved with a warning, never as agreement — an unreadable comparison is the reading
 * a caller is least entitled to treat as "it applies to me".
 */
export function fleetSentinelCallerView(args: {
  fleetSlug: string;
  callerId: string;
  callerRecord: CallerSpecResolution | null;
}): FleetSentinelCallerView {
  const { fleetSlug, callerId, callerRecord } = args;
  const subject = `fleet '${fleetSlug}'`;
  const preamble =
    `⚠ This is ${subject}'s OWN sentinel spec row, NOT your effective claim spec. `;

  if (!callerRecord) {
    return {
      appliesToCaller: false,
      callerEffective: { ownerId: callerId, resolved: false, source: null, revision: null, fleetSlug: null },
      warning:
        preamble +
        'Your own resolution could not be read, so whether YOUR pulls run under it is UNKNOWN — ' +
        `re-read it directly with scheduler:get_claim_spec { cupId: '${callerId}' } before relying on this spec for your own claims.`,
    };
  }

  const callerFleet = callerRecord.fleetSlug ?? null;
  const appliesToCaller = callerRecord.source === 'fleet' && callerFleet === fleetSlug;
  const callerEffective = {
    ownerId: callerId,
    resolved: true,
    source: callerRecord.source,
    revision: callerRecord.revision,
    fleetSlug: callerFleet,
  };
  if (appliesToCaller) return { appliesToCaller, callerEffective };

  // Not the caller's lane. Name the CONCRETE remedy + call shape for the specific reason —
  // a mismatch a caller cannot act on is an alarm, not a rail.
  let because: string;
  if (callerRecord.source === 'cup') {
    because =
      'you have your OWN per-bee spec, which always WINS over an inherited fleet spec' +
      (callerRecord.revision !== null ? ` (rev ${callerRecord.revision})` : '') +
      `. Your pulls will NOT use ${subject}'s spec until that override is replaced/cleared via scheduler:set_claim_spec { cupId: '${callerId}' }.`;
  } else if (callerRecord.source === 'fleet') {
    because =
      `you inherit a DIFFERENT fleet's spec — '${callerFleet}'` +
      (callerRecord.revision !== null ? ` (rev ${callerRecord.revision})` : '') +
      `. Remedy: fleet:join { fleet: '${fleetSlug}', as: 'member' } to move lanes.`;
  } else if (callerFleet) {
    because =
      `your latest membership fact names fleet '${callerFleet}' but no valid sentinel spec resolved, so you are mid-transition and self-select fails CLOSED (WI-4770). ` +
      `Remedy: have the leader install the sentinel via scheduler:set_claim_spec { fleet: '${callerFleet}' }, or fleet:leave to settle to solo default pulls.`;
  } else {
    because =
      'you have NO fleet membership and NO per-bee spec, so YOUR pulls resolve to DEFAULT_CLAIM_SPEC and can take work this lane excludes. ' +
      `Remedy: fleet:join { fleet: '${fleetSlug}', as: 'member' } BEFORE your next scheduler:get_next.`;
  }
  return {
    appliesToCaller,
    callerEffective,
    warning: preamble + `Reading it does not put you in the lane: ${because}`,
  };
}
