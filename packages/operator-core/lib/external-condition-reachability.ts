import { EVENT_CATALOG, keyMatchesCatalog } from './events/await/catalog';
import { findRootAnchor, loadNode } from './events/await/compose-store';
import { inspectEventKey } from './events/await/store';

export type ExternalConditionReachabilityVerdict = 'reachable' | 'impossible' | 'unknown';
export type ExternalConditionReachabilityBasis =
  | 'fired'
  | 'live-resolver'
  | 'cancelled-registration'
  | 'expired-registration'
  | 'missing-registration'
  | 'unmeasured';

export interface ExternalConditionReachability {
  verdict: ExternalConditionReachabilityVerdict;
  basis: ExternalConditionReachabilityBasis;
  authoritative: boolean;
  evidence: string;
  checkedAt: string;
}

export interface ExternalConditionReachabilityInput {
  firedAt?: string | null;
  /** A catalogued emitter, active announcement, or owning condition object. */
  liveResolver?: boolean;
  /** Only producer announcements count. Cancelling a consumer await says nothing about the producer. */
  registration?: 'live' | 'cancelled' | 'expired' | 'missing' | 'unmeasured';
}

type ComposedRootLoader = typeof loadNode;
type ComposedRootAnchorLoader = typeof findRootAnchor;

function composedRootId(eventKey: string): number | null {
  const match = /^composed-root:([1-9][0-9]*)$/.exec(eventKey);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The `composed-root:<id>` key is a delivery-shim key, not an event-catalog family.
 * Its producer is the live root node, and the anchor is the delivery path that makes
 * a root trip wakeable. Keep this exact-key check narrow so arbitrary synthetic keys
 * do not become a false reachability proof.
 */
async function hasActiveComposedRootAnchor(
  eventKey: string,
  loadRoot: ComposedRootLoader,
  loadAnchor: ComposedRootAnchorLoader,
): Promise<boolean> {
  const rootId = composedRootId(eventKey);
  if (rootId == null) return false;
  const root = await loadRoot(rootId);
  if (
    !root ||
    root.id !== rootId ||
    root.rootId !== rootId ||
    root.parentId !== null ||
    root.firedAt !== null ||
    root.cancelledAt !== null
  ) {
    return false;
  }
  return (await loadAnchor(rootId)) !== null;
}

/**
 * Pure tri-state classifier. Time is used only to stamp evidence; age is never a
 * reachability input. In particular, an old unregistered condition remains
 * unknown rather than silently becoming impossible.
 */
export function classifyExternalConditionReachability(
  input: ExternalConditionReachabilityInput,
  now = new Date().toISOString(),
): ExternalConditionReachability {
  if (input.firedAt) {
    return {
      verdict: 'reachable',
      basis: 'fired',
      authoritative: true,
      evidence: `event fired at ${input.firedAt}`,
      checkedAt: now,
    };
  }
  if (input.liveResolver || input.registration === 'live') {
    return {
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
      evidence: 'a live resolver or producer registration can still satisfy the condition',
      checkedAt: now,
    };
  }
  if (input.registration === 'cancelled') {
    return {
      verdict: 'impossible',
      basis: 'cancelled-registration',
      authoritative: true,
      evidence: 'the latest authoritative producer registration was cancelled',
      checkedAt: now,
    };
  }
  if (input.registration === 'expired') {
    return {
      verdict: 'impossible',
      basis: 'expired-registration',
      authoritative: true,
      evidence: 'the latest authoritative producer registration expired',
      checkedAt: now,
    };
  }
  if (input.registration === 'missing') {
    return {
      verdict: 'unknown',
      basis: 'missing-registration',
      authoritative: false,
      evidence: 'no producer registration or catalogued resolver was found',
      checkedAt: now,
    };
  }
  return {
    verdict: 'unknown',
    basis: 'unmeasured',
    authoritative: false,
    evidence: 'reachability could not be measured',
    checkedAt: now,
  };
}

function latestAnnouncementState(
  announcements: Awaited<ReturnType<typeof inspectEventKey>>['announcements'],
  nowMs: number,
): ExternalConditionReachabilityInput['registration'] {
  const latest = announcements.find((row) => !row.supersededAt);
  if (!latest) return 'missing';
  if (latest.cancelledAt) return 'cancelled';
  if (latest.expiresTs) {
    const expires = Date.parse(latest.expiresTs);
    if (Number.isFinite(expires) && expires <= nowMs) return 'expired';
  }
  return 'live';
}

/** Resolve one event/gate key from the existing event ledger and emitter catalog. */
export async function readEventConditionReachability(
  eventKey: string,
  opts: {
    inspect?: typeof inspectEventKey;
    now?: Date;
    loadComposedRoot?: ComposedRootLoader;
    loadComposedRootAnchor?: ComposedRootAnchorLoader;
  } = {},
): Promise<ExternalConditionReachability> {
  const now = opts.now ?? new Date();
  const inspect = opts.inspect ?? inspectEventKey;
  const loadComposedRoot = opts.loadComposedRoot ?? loadNode;
  const loadComposedRootAnchor = opts.loadComposedRootAnchor ?? findRootAnchor;
  try {
    const snapshot = await inspect(eventKey);
    // An announcement is a causal generation boundary. The per-key fire latch
    // intentionally retains history across generations, so it may only be used
    // when there is no current declaration. Otherwise a fire from generation N
    // would incorrectly satisfy a newly declared generation N+1.
    const currentAnnouncement = snapshot.announcements.find((row) => !row.supersededAt);
    const firedAt = currentAnnouncement
      ? currentAnnouncement.firedAt
      : snapshot.fireLatch?.lastFiredAt ?? null;
    const composedRootReachable = await hasActiveComposedRootAnchor(
      eventKey,
      loadComposedRoot,
      loadComposedRootAnchor,
    );
    return classifyExternalConditionReachability(
      {
        firedAt,
        liveResolver: keyMatchesCatalog(eventKey, EVENT_CATALOG) || composedRootReachable,
        registration: latestAnnouncementState(snapshot.announcements, now.getTime()),
      },
      now.toISOString(),
    );
  } catch (error) {
    return {
      ...classifyExternalConditionReachability({ registration: 'unmeasured' }, now.toISOString()),
      evidence: `reachability resolver failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
