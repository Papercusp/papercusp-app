/**
 * audience.ts — audience-selector expansion for coord delivery
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 *
 * Lifecycle auto-emits (claim / intent / finding / completion) used to broadcast
 * to `to: ['*']` — every event into every agent's inbox (~360/6h). This module
 * lets the `to[]` carry AUDIENCE SELECTORS that resolve, at send time, to just
 * the agents *watching* the relevant plan / topic / work-item:
 *
 *   @plan:<slug>          — explicit plan subscribers ∪ active presence on the
 *                           plan ∪ subscribers of topics the plan is tagged to
 *   @topic:<slug>         — subscribers of that topic
 *   @object:<kind>:<ref>  — subscribers of that coord object (the full stored
 *                           subscription target_ref, e.g. `feature:<h>#<id>` /
 *                           `issue:<id>`) ∪ its tagged-topic subscribers
 *   @file:<path>          — everyone on that file: active presence whose
 *                           current_files includes <path> ∪ agents holding or
 *                           queued on a LIVE file-lock for it (the
 *                           file-collision signal, for intent/window)
 *   @fleet:<slug>         — live (fresh-heartbeat) members of a named fleet
 *                           (membership IS the subscription — the soft
 *                           coord_presence.fleet_slug label, no rows to manage)
 *   @fleet-leader:<slug>  — the named fleet's CURRENT leader (escalate-to-lead;
 *                           the durable agent_fleets registry, liveness-independent)
 *
 * Plain ownerIds, `*` (broadcast), and `human` pass through untouched, so a
 * normal coord:send is zero-overhead (no `@` → no resolution).
 *
 * Resolution happens in the async send path (sendMessage), NOT in the sync rule
 * `args` — that is why the lifecycle rules emit a SELECTOR string and this module
 * expands it. The expanded concrete ownerIds are stored on the single envelope,
 * so the inbox filter (`to.includes(ownerId) || '*'`) and the federation
 * projection are unchanged (D-001/D-003). Empty resolution → empty `to` → the row
 * still persists (plan-history) but reaches no inbox; we never fall back to `*`
 * (D-004). The pure core takes injected resolvers so it unit-tests with in-memory
 * doubles; the host wires the PG-backed deps in ./audience-host.
 */

/**
 * A fleet member that was NOT delivered to, and why (P-003). Structural on purpose —
 * this module stays host-agnostic, so the reason vocabulary is declared here rather
 * than imported from the PG-backed fleet roster that produces it.
 */
export interface FleetAudienceOmission {
  ownerId: string;
  reason: 'stale-heartbeat' | 'ended' | 'suspect' | 'bee-role';
  heartbeatAt?: string | null;
}

/**
 * A selector that DID resolve, but every recipient it resolved to is absent from
 * the roster ENTIRELY — a reaped session.
 *
 * Deliberately a separate field from `unresolvedSelectors`, because the failure it
 * names is invisible to a count: the audience resolved to N≥1 recipients and still
 * reaches nobody, ever. Every miss-signal on the send path keys off cardinality
 * ZERO, so before this existed a reaped recipient produced `recipients_resolved: 1`
 * and the full success shape (EI-22180848452883121).
 */
export interface UnreachableAudience {
  selector: string;
  ownerIds: string[];
}

/** An active (fresh-heartbeat, non-revoked) agent + what it is working on. */
export interface ActivePresence {
  ownerId: string;
  planSlug: string | null;
  files: string[];
}

/** The injected, async resolvers (PG-backed in the host, fakes in tests). */
export interface AudienceResolvers {
  /** Explicit subscribers of a subscription target (object|topic) → ownerIds. */
  listTargetSubscribers(targetKind: 'object' | 'topic', targetRef: string): Promise<string[]>;
  /** Current assignee/holder ownerIds for a canonical issue or feature object ref. */
  listObjectOwners?(objectKind: 'issue' | 'feature', objectRef: string): Promise<string[]>;
  /** Active presence rows. Called at most once per expandAudience call. */
  listActivePresence(): Promise<ActivePresence[]>;
  /** Topic slugs a coord object (kind, ref) is tagged to (coord_links rel='tagged'). */
  listTaggedTopics(objectKind: string, objectRef: string): Promise<string[]>;
  /** Live (fresh-heartbeat) members of a named fleet (by slug or human name — the
   *  host slugifies) → ownerIds. Backs the `@fleet:` selector. */
  listFleetMembers(fleetSlug: string): Promise<string[]>;
  /**
   * P-003 — the fleet members this send did NOT reach, and why. OPTIONAL and purely
   * DIAGNOSTIC: it never changes who is delivered to (that is `listFleetMembers`), it
   * only lets a `@fleet:` result distinguish a FULL delivery from a PARTIAL one. A host
   * that cannot answer omits it (or returns []), and the send reports no omissions —
   * which is why callers must treat "absent" as UNKNOWN, never as "nobody was dropped".
   */
  explainFleetAudience?(fleetSlug: string): Promise<FleetAudienceOmission[]>;
  /** The named fleet's current leader → ownerId(s) (0 or 1; the durable registry,
   *  liveness-independent). Backs the `@fleet-leader:` selector.
   *
   *  Liveness-independence is DELIBERATE: an escalation must reach the lead even
   *  while they are offline, landing in their durable inbox for when they return.
   *  That justification holds for an ended-but-recorded session and NOT for a
   *  reaped one — see `listUnreachableRecipients`, which draws exactly that line
   *  without touching who is delivered to. */
  listFleetLeader(fleetSlug: string): Promise<string[]>;
  /**
   * Which of these ownerIds are absent from the roster ENTIRELY — no local presence
   * row, no recorded session, no federated peer: a REAPED id whose inbox nobody will
   * ever read. OPTIONAL and purely DIAGNOSTIC: it never changes who is delivered to.
   * A host that cannot answer omits it (or returns []), and the send reports nothing
   * unreachable — so callers must read an empty result as UNKNOWN, never as "every
   * recipient is reachable".
   *
   * NOT a liveness or "is it awake" test, and deliberately not interchangeable with
   * one. An ended-but-recorded leader still has a durable inbox to come back to,
   * which is precisely why `listFleetLeader` above is liveness-independent; a reaped
   * one does not. Reaped ≡ zero recipients for delivery purposes; merely offline is
   * not.
   */
  listUnreachableRecipients?(ids: readonly string[]): Promise<string[]>;
  /**
   * Agents on a repo-relative path per the LOCK plane — holders of a live
   * (unexpired) file-lock ∪ agents queued waiting for one. The automatic half of
   * `@file:` (EI-18772330418885814); see the selector branch for why presence
   * alone is not enough. MUST be fail-soft in the host: a lock plane that is
   * unreachable/unconfigured returns `[]` rather than failing the send.
   */
  listPathLockAgents(path: string): Promise<string[]>;
}

export type AudienceMode = 'scoped' | 'broadcast';

/** The expanded audience plus selectors that resolved to no recipients. */
export interface AudienceExpansion {
  resolved: string[];
  unresolvedSelectors: string[];
  /**
   * Selectors that resolved to recipients who are ALL reaped (see
   * {@link UnreachableAudience}). EMPTY means "none KNOWN" — a host without the
   * probe, or a roster read that threw, both land here — never proof that every
   * recipient is reachable.
   */
  unreachableSelectors: UnreachableAudience[];
}

const SELECTOR_PREFIX = '@';

/** True if any entry is an audience selector (so a send must run expandAudience). */
export function hasAudienceSelector(to: readonly string[]): boolean {
  return to.some((t) => t.startsWith(SELECTOR_PREFIX));
}

/** Build an `@object:` selector from a coord ObjectRef (the canonical
 *  `${kind}:${ref}` that subscriptions store as target_ref). */
export function objectSelector(ref: { kind: string; ref: string }): string {
  return `@object:${ref.kind}:${ref.ref}`;
}

/**
 * Expand a `to[]` containing audience selectors into concrete ownerIds.
 * Pass-throughs (plain ids, `*`, `human`) are preserved; selectors resolve via
 * `resolvers`; in `broadcast` mode every selector collapses to `*` (the
 * kill-switch — D-005). Result is deduped; an unknown selector resolves to no
 * one (never `*` on a typo).
 */
export async function expandAudience(
  to: readonly string[],
  resolvers: AudienceResolvers,
  mode: AudienceMode = 'scoped',
): Promise<string[]> {
  return (await expandAudienceDetailed(to, resolvers, mode)).resolved;
}

/**
 * Expand an audience while retaining the selectors that matched no recipients.
 * The plain `expandAudience` API intentionally remains resolution-only for
 * existing callers; send paths that need to tell a partial delivery from a
 * complete one use this diagnostic sibling.
 */
export async function expandAudienceDetailed(
  to: readonly string[],
  resolvers: AudienceResolvers,
  mode: AudienceMode = 'scoped',
): Promise<AudienceExpansion> {
  const out = new Set<string>();
  const unresolved = new Set<string>();
  // Cache the in-flight read, not only its eventual value. Multiple selectors
  // are resolved concurrently below, so a value-only cache would let each
  // @plan/@file branch start its own identical presence query before the first
  // one settles.
  let presencePromise: Promise<ActivePresence[]> | undefined;
  const presenceOnce = (): Promise<ActivePresence[]> =>
    (presencePromise ??= resolvers.listActivePresence());

  // Selector reads are independent. Fan them out, then fold the settled arrays
  // in input order so the existing first-seen/dedup ordering stays stable on the
  // wire even though the backing reads complete in arbitrary order.
  const expansions = await Promise.all(
    to.map(async (t) => {
      if (!t.startsWith(SELECTOR_PREFIX)) {
        return { selector: t, resolved: [t], unresolved: false };
      }
      if (mode === 'broadcast') {
        return { selector: t, resolved: ['*'], unresolved: false };
      }
      const resolved = await resolveSelector(t, resolvers, presenceOnce);
      return { selector: t, resolved, unresolved: resolved.length === 0 };
    }),
  );

  for (const expansion of expansions) {
    if (expansion.unresolved) unresolved.add(expansion.selector);
    for (const id of expansion.resolved) out.add(id);
  }
  return {
    resolved: [...out],
    unresolvedSelectors: [...unresolved],
    unreachableSelectors: await findUnreachableSelectors(expansions, resolvers),
  };
}

/**
 * Which selectors resolved ONLY to reaped recipients (EI-22180848452883121).
 *
 * Scoped to a selector's WHOLE resolved set on purpose. A `@fleet:` audience that
 * loses one of six members had a PARTIAL delivery — that is `explainFleetAudience`'s
 * job, and folding it in here would make one field mean two things. A selector whose
 * every recipient is reaped is a different event: it reached NOBODY, the same outcome
 * as a zero-cardinality miss, arriving with the success shape instead.
 *
 * Pass-through entries (a plain ownerId the caller typed) are excluded because they
 * already get the `unknown_recipient` roster refusal — this closes the gap where the
 * SAME id, reached via a selector, skips that check entirely.
 *
 * Fail-soft throughout: no probe, or a probe that throws, yields [] — which the field's
 * contract defines as "none known", never as "all reachable".
 */
async function findUnreachableSelectors(
  expansions: readonly { selector: string; resolved: string[]; unresolved: boolean }[],
  resolvers: AudienceResolvers,
): Promise<UnreachableAudience[]> {
  const probe = resolvers.listUnreachableRecipients;
  if (!probe) return [];
  const candidates = expansions.filter(
    (e) => e.selector.startsWith(SELECTOR_PREFIX) && e.resolved.length > 0,
  );
  if (candidates.length === 0) return [];
  // `*`/`human` are delivery channels, not sessions — they have no roster row to
  // miss, so probing them would report the broadcast kill-switch as unreachable.
  const ids = [
    ...new Set(candidates.flatMap((e) => e.resolved).filter((id) => id !== '*' && id !== 'human')),
  ];
  if (ids.length === 0) return [];
  let unreachable: ReadonlySet<string>;
  try {
    unreachable = new Set(await probe(ids));
  } catch {
    return [];
  }
  if (unreachable.size === 0) return [];
  return candidates
    .filter((e) => e.resolved.every((id) => unreachable.has(id)))
    .map((e) => ({ selector: e.selector, ownerIds: e.resolved.filter((id) => unreachable.has(id)) }));
}

async function resolveSelector(
  selector: string,
  resolvers: AudienceResolvers,
  presenceOnce: () => Promise<ActivePresence[]>,
): Promise<string[]> {
  if (selector.startsWith('@topic:')) {
    const slug = selector.slice('@topic:'.length).trim();
    return slug ? resolvers.listTargetSubscribers('topic', slug) : [];
  }

  if (selector.startsWith('@plan:')) {
    const slug = selector.slice('@plan:'.length).trim();
    if (!slug) return [];
    const [directSubscribers, taggedSubscribers, activePresence] = await Promise.all([
      resolvers.listTargetSubscribers('object', `plan:${slug}`),
      taggedTopicSubscribers('plan', slug, resolvers),
      presenceOnce(),
    ]);
    const ids = new Set<string>();
    for (const id of directSubscribers) ids.add(id);
    for (const id of taggedSubscribers) ids.add(id);
    for (const p of activePresence) if (p.planSlug === slug) ids.add(p.ownerId);
    return [...ids];
  }

  if (selector.startsWith('@object:')) {
    // The remainder IS the stored subscription target_ref (`<kind>:<ref>`).
    const targetRef = selector.slice('@object:'.length).trim();
    if (!targetRef) return [];
    const lookup = objectTargetLookup(targetRef);
    const ids = new Set<string>();
    // Keep the selector spelling as a first lookup for backwards compatibility,
    // then try the canonical family-owned target. This is intentionally limited
    // to the two historical work-item spellings; arbitrary object kinds must not
    // acquire fuzzy aliases.
    for (const candidate of lookup.targetRefs) {
      for (const id of await resolvers.listTargetSubscribers('object', candidate)) ids.add(id);
    }
    if (lookup.taggedObject) {
      for (const id of await taggedTopicSubscribers(lookup.taggedObject.kind, lookup.taggedObject.ref, resolvers)) {
        ids.add(id);
      }
    }
    // A current work-item owner is a live audience even when they have not
    // subscribed to the object or one of its tagged topics. Keep this seam
    // optional for hosts that do not have the work-item store, and fail soft so
    // a transient owner read cannot discard the subscription-derived audience.
    if (lookup.ownerObject && resolvers.listObjectOwners) {
      try {
        for (const id of await resolvers.listObjectOwners(lookup.ownerObject.kind, lookup.ownerObject.ref)) {
          ids.add(id);
        }
      } catch {
        // Best-effort enrichment; the existing audience remains authoritative.
      }
    }
    return [...ids];
  }

  if (selector.startsWith('@file:')) {
    const path = selector.slice('@file:'.length).trim();
    if (!path) return [];
    const ids = new Set<string>();
    for (const p of await presenceOnce()) if (p.files.includes(path)) ids.add(p.ownerId);
    // EI-18772330418885814 — the presence half alone is NOT a check for who is on a
    // file. `current_files` is populated only by an explicit
    // `coord:declare-intent { current_files }`, and every declare that OMITS the arg
    // RESETS it to [] — so in practice it is empty for essentially every agent
    // (measured live 2026-07-27: 119 live presence rows, ZERO with a non-empty
    // current_files). That made `@file:` resolve to nobody even while a peer
    // verifiably held a lock on the path, and coord:send answered with a confident
    // `zero_recipients` / "reached NOBODY live" — read as positive evidence of
    // absence, it invites an agent to edit straight into a live peer's work. A live
    // file-lock is the strongest, and the only AUTOMATIC, "this agent is on this
    // file" signal there is, so union it in. Waiters count too: an agent queued on
    // the path is by definition trying to edit it.
    for (const id of await resolvers.listPathLockAgents(path)) ids.add(id);
    return [...ids];
  }

  // `@fleet-leader:` MUST be tested before `@fleet:` would be — though the
  // prefixes don't actually collide (`@fleet-` vs `@fleet:`), keep the more
  // specific one first for clarity.
  if (selector.startsWith('@fleet-leader:')) {
    const slug = selector.slice('@fleet-leader:'.length).trim();
    return slug ? resolvers.listFleetLeader(slug) : [];
  }

  if (selector.startsWith('@fleet:')) {
    const slug = selector.slice('@fleet:'.length).trim();
    return slug ? resolvers.listFleetMembers(slug) : [];
  }

  // Unknown selector — deliver to no one (never broadcast on a typo).
  return [];
}

/**
 * Resolve the subscription target refs accepted by an @object selector.
 *
 * `work_items` historically exposed the generic `work_item`/`work-item` kind in
 * selectors, while the capability stores have always keyed subscriptions by the
 * family-specific ObjectRef: `issue:<id>` or `feature:<harness>#<id>`. A bare
 * work-item ref is therefore unambiguously the issue-family shape; a feature ref
 * carries its harness qualification (`<harness>#<id>`). Keep the old spelling in
 * the candidate list so legacy rows remain reachable, but never scan all feature
 * harnesses for a bare id.
 */
function objectTargetLookup(targetRef: string): {
  targetRefs: string[];
  taggedObject?: { kind: string; ref: string };
  ownerObject?: { kind: 'issue' | 'feature'; ref: string };
} {
  const colon = targetRef.indexOf(':');
  if (colon <= 0) return { targetRefs: [targetRef] };

  const kind = targetRef.slice(0, colon);
  const ref = targetRef.slice(colon + 1);
  if (kind !== 'work_item' && kind !== 'work-item') {
    return {
      targetRefs: [targetRef],
      taggedObject: { kind, ref },
      ownerObject: kind === 'issue' || kind === 'feature' ? { kind, ref } : undefined,
    };
  }

  const canonicalKind = ref.includes('#') ? 'feature' : 'issue';
  const canonicalTargetRef = `${canonicalKind}:${ref}`;
  return {
    targetRefs: targetRef === canonicalTargetRef ? [targetRef] : [targetRef, canonicalTargetRef],
    taggedObject: { kind: canonicalKind, ref },
    ownerObject: { kind: canonicalKind, ref },
  };
}

async function taggedTopicSubscribers(
  objectKind: string,
  objectRef: string,
  resolvers: AudienceResolvers,
): Promise<string[]> {
  const topics = await resolvers.listTaggedTopics(objectKind, objectRef);
  if (!topics.length) return [];
  const ids = new Set<string>();
  // A tagged object can carry several topics. Their subscriber reads do not
  // depend on each other; retain topic/list order while issuing them together.
  const subscribersByTopic = await Promise.all(
    topics.map((slug) => resolvers.listTargetSubscribers('topic', slug)),
  );
  for (const subscribers of subscribersByTopic) {
    for (const id of subscribers) ids.add(id);
  }
  return [...ids];
}
