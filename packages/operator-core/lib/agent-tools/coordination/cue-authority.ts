/**
 * cue-authority.ts — stamp a coordination CONTROL cue (drain / pause / steer) with
 * the SENDER's structured authority + governance scope, so a recipient can instantly
 * tell "a fleet leader is draining ITS members" from "the Hive Queen is pausing the
 * whole hive" (queen-fleet-authority-boundary-2026-07-02 P-003).
 *
 * The 2026-07-02 incident: a fleet leader broadcast a Queen-shaped drain cue to '*';
 * recipients could not distinguish its (fleet-scoped) authority from a real hive-wide
 * Queen pause, so owner-directed leaders self-drained. P-001/P-002/P-004 stop the
 * misdirected DELIVERY at source; THIS stamp makes the authority + scope of any cue
 * that IS delivered legible — "a coordination cue without a source-authority+scope
 * stamp is the core of the incident."
 *
 * Authority is DERIVED from the sender's real role, never self-asserted: a hive-level
 * session (queen / overwatch) speaks with hive-queen authority over the whole hive; a
 * fleet leader speaks with fleet-leader authority over its own fleet's members only.
 * An ordinary bee, or an owner-directed su/sentinel/planner session, has no control
 * authority → no stamp.
 *
 * Pure + import-free: the presence/fleet IO lives in the caller
 * (resolveSenderCueAuthority, ./cue-authority-resolve). Kept dependency-free so
 * coord-schema (the injection renderer) can import the read/render helpers WITHOUT
 * pulling the DB / agent-mcp graph into its dependency tree.
 */

/** Who is speaking. `hive-queen` = hive-level authority (a queen / overwatch
 *  session); `fleet-leader` = a named-fleet leader, authority over its members only. */
export type CueAuthorityKind = 'hive-queen' | 'fleet-leader';

/** How far the cue's authority reaches. `hive-wide` = every agent in the hive;
 *  `fleet-members` = only the named fleet's members. */
export type CueScopeKind = 'hive-wide' | 'fleet-members';

export interface CueAuthorityStamp {
  authority: CueAuthorityKind;
  /** hive slug (hive-queen) or fleet slug (fleet-leader). */
  authorityRef: string;
  scope: CueScopeKind;
  /** fleet slug for a `fleet-members` scope; omitted for `hive-wide`. */
  scopeRef?: string;
}

/** The reserved envelope field the stamp rides on — a single nested object, so it
 *  can't collide with any base envelope field and passes through sendMessage's
 *  `extra` merge + the coord_event_log body verbatim (like coord:emit's markers). */
export const CUE_AUTHORITY_FIELD = 'cueAuthority';

/**
 * A typed marker for control cues whose acknowledgement is a lifecycle
 * disposition, not a request that should re-invoke the sender. The marker is
 * deliberately separate from cue authority: authority answers who may command
 * the action, while this answers how the expected ack should be delivered.
 */
export type ExpectedLifecycleAckKind = 'fleet-wind-down';

export interface ExpectedLifecycleAckMarker {
  kind: ExpectedLifecycleAckKind;
  fleet: string;
}

/** Reserved envelope field for expected lifecycle acknowledgements. */
export const EXPECTED_LIFECYCLE_ACK_FIELD = 'expectedLifecycleAck';

/** Stamp the expected acknowledgement semantics for a fleet wind-down cue. */
export function expectedFleetWindDownAck(fleetSlug: string): ExpectedLifecycleAckMarker {
  return {
    kind: 'fleet-wind-down',
    fleet: fleetSlug.trim() || '(fleet)',
  };
}

/**
 * Read + validate an expected lifecycle-ack marker from a coord envelope.
 * Malformed/forged values are ignored defensively, just like cue authority
 * stamps, so ordinary replies retain their normal wake semantics.
 */
export function readExpectedLifecycleAck(
  env: Record<string, unknown> | null | undefined,
): ExpectedLifecycleAckMarker | null {
  const raw = env?.[EXPECTED_LIFECYCLE_ACK_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const marker = raw as Record<string, unknown>;
  if (
    marker.kind === 'fleet-wind-down' &&
    typeof marker.fleet === 'string' &&
    marker.fleet.length > 0
  ) {
    return { kind: 'fleet-wind-down', fleet: marker.fleet };
  }
  return null;
}

/**
 * Derive the cue-authority stamp for a SENDER from its resolved role inputs. Pure.
 *   - queen / overwatch      → hive-queen(<hive>), hive-wide
 *   - fleet leader (+ slug)  → fleet-leader(<slug>), fleet-members(<slug>)
 *   - anything else          → null (no recognized control authority; no stamp)
 * `kind` is the classifyAgentPane kind STRING; kept a plain string so this module
 * needs no agent-mcp import (and coord-schema stays graph-light).
 */
export function resolveCueAuthority(input: {
  kind: string;
  potSlug?: string | null;
  fleetSlug?: string | null;
  fleetRole?: string | null;
}): CueAuthorityStamp | null {
  if (input.kind === 'mug' || input.kind === 'kettle') {
    return {
      authority: 'hive-queen',
      authorityRef: (input.potSlug ?? '').trim() || '(hive)',
      scope: 'hive-wide',
    };
  }
  if (input.fleetRole === 'leader' && input.fleetSlug) {
    return {
      authority: 'fleet-leader',
      authorityRef: input.fleetSlug,
      scope: 'fleet-members',
      scopeRef: input.fleetSlug,
    };
  }
  return null;
}

/**
 * A hive-wide stamp for an action whose authority is INTRINSIC to the action itself
 * — pot:pause / kettle:pause ARE hive-level controls that pause the whole hive,
 * whoever triggers them, so their cue is hive-queen/hive-wide regardless of the
 * caller's own pane-kind. `hive` is the hive / home slug being paused.
 */
export function hiveWideCueAuthority(hive: string | null | undefined): CueAuthorityStamp {
  return {
    authority: 'hive-queen',
    authorityRef: (hive ?? '').trim() || '(hive)',
    scope: 'hive-wide',
  };
}

/**
 * A fleet-scoped stamp for an action whose authority is INTRINSIC to the action
 * itself — fleet:wind-down / fleet:resume ARE that fleet's control plane
 * (P-009 / H4), whoever the (already guard-checked: owner / leader / queen)
 * invoker is. The mirror of {@link hiveWideCueAuthority} at fleet scope: the
 * cue renders `fleet-leader(<slug>)→fleet-members(<slug>)`, BINDING for that
 * fleet's members and receive-side DEMOTED (H1) for everyone else.
 */
export function fleetScopedCueAuthority(fleetSlug: string): CueAuthorityStamp {
  const slug = fleetSlug.trim() || '(fleet)';
  return {
    authority: 'fleet-leader',
    authorityRef: slug,
    scope: 'fleet-members',
    scopeRef: slug,
  };
}

/**
 * Render a stamp to a short, scannable tag for the coord injection line, e.g.
 * `hive-queen(papercusp)→hive-wide` or
 * `fleet-leader(windows-parity)→fleet-members(windows-parity)`.
 */
export function renderCueAuthorityTag(stamp: CueAuthorityStamp): string {
  const scope =
    stamp.scope === 'fleet-members' && stamp.scopeRef
      ? `fleet-members(${stamp.scopeRef})`
      : stamp.scope;
  return `${stamp.authority}(${stamp.authorityRef})→${scope}`;
}

/**
 * The rendering RECIPIENT's scope context — who is reading the line and which
 * fleets they currently belong to (coord-authority-hardening-2026-07-11 P-003 /
 * H1 receive-side defang). Resolved by the CALLER (IO — live presence-fleet read
 * at render time, so membership drift between send and read is handled by
 * construction); this module stays pure + import-free.
 */
export interface RecipientCueScope {
  recipientId: string;
  /** Fleet slugs the recipient is CURRENTLY a member of (leader counts). */
  fleetSlugs: readonly string[];
}

/**
 * Is a stamped cue BINDING for this recipient? (H1, the EI-9501 class.)
 *   - hive-wide scope        → binding for everyone → true
 *   - fleet-members(X) scope → true only for members of X — or the sender itself
 *     (your own line rendered back never demotes).
 * Pure; the caller resolves membership. A cue that fails this check is DEMOTED
 * at render (flag-and-demote — NEVER dropped: the body still shows verbatim).
 */
export function isCueInScopeFor(
  stamp: CueAuthorityStamp,
  recipient: RecipientCueScope,
  senderId?: string | null,
): boolean {
  if (stamp.scope !== 'fleet-members') return true;
  if (senderId != null && senderId === recipient.recipientId) return true;
  const slug = stamp.scopeRef ?? stamp.authorityRef;
  return recipient.fleetSlugs.includes(slug);
}

/**
 * The DEMOTED tag for an out-of-scope fleet-scoped cue: keeps the full authority
 * stamp visible (the reader can audit who claimed what) and states plainly that
 * the line is not binding on THEM. Rendered instead of renderCueAuthorityTag —
 * the message body itself is untouched.
 */
export function renderOutOfScopeCueTag(stamp: CueAuthorityStamp): string {
  const slug =
    stamp.scope === 'fleet-members' ? (stamp.scopeRef ?? stamp.authorityRef) : stamp.authorityRef;
  return `${renderCueAuthorityTag(stamp)} — OUT-OF-SCOPE for you (not in fleet ${slug}); NOT binding`;
}

/**
 * Read + validate a cue-authority stamp off a coord envelope / inbox entry. Returns
 * null when absent or malformed (defensive — never throws), so a hand-forged or
 * legacy envelope can't crash the inbox renderer.
 */
export function readCueAuthority(
  env: Record<string, unknown> | null | undefined,
): CueAuthorityStamp | null {
  const raw = env?.[CUE_AUTHORITY_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const { authority, authorityRef, scope } = s;
  if (
    (authority === 'hive-queen' || authority === 'fleet-leader') &&
    typeof authorityRef === 'string' &&
    authorityRef.length > 0 &&
    (scope === 'hive-wide' || scope === 'fleet-members')
  ) {
    return {
      authority,
      authorityRef,
      scope,
      ...(typeof s.scopeRef === 'string' && s.scopeRef.length > 0
        ? { scopeRef: s.scopeRef }
        : {}),
    };
  }
  return null;
}
