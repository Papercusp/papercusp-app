/**
 * announce-key — pure key/scope helpers for ANNOUNCED gate events
 * (fleet-member-native-guidance-2026-07-10 P-010, EI-9270).
 *
 * The rendezvous plane is a single FLAT namespace (WI-3575 — load-bearing), so
 * two fleets both announcing a gate named `phase3-open` would collide on the
 * actual event key. Scoped announcements therefore AUTO-PREFIX the concrete key
 * from their discovery scope (`fleet:<slug>:<gate>`), mirroring the static
 * catalog's one-place-per-key-shape rule (D-005): the declaration row and the
 * key shape can never drift apart because both come from buildAnnouncedKey.
 */

export type AnnounceScopeKind = 'fleet' | 'plan' | 'harness' | 'global';

export interface AnnounceScope {
  kind: AnnounceScopeKind;
  /** The fleet/plan/harness slug; null for 'global'. */
  ref: string | null;
}

/**
 * Build the concrete announced key for a gate name + scope.
 * - global → the gate name as-is (`release-window-open`).
 * - scoped → `<kind>:<ref>:<gate>` (`fleet:p2p-git:phase3-open`) — idempotent:
 *   a gate already carrying its own scope prefix is not double-prefixed.
 */
export function buildAnnouncedKey(gate: string, scope: AnnounceScope): string {
  const g = gate.trim();
  if (scope.kind === 'global') return g;
  if (!scope.ref) throw new Error(`announce: scope '${scope.kind}' requires a ref (the ${scope.kind} slug)`);
  const prefix = `${scope.kind}:${scope.ref}:`;
  return g.startsWith(prefix) ? g : `${prefix}${g}`;
}

/**
 * Resolve the announcer's DEFAULT scope — the narrowest context they are in:
 * fleet → plan → global. Pass what you know from presence; explicit args win
 * upstream (this only answers the "no scope named" case).
 */
export function defaultAnnounceScope(input: {
  fleetSlug?: string | null;
  planSlug?: string | null;
}): AnnounceScope {
  if (input.fleetSlug) return { kind: 'fleet', ref: input.fleetSlug };
  if (input.planSlug) return { kind: 'plan', ref: input.planSlug };
  return { kind: 'global', ref: null };
}

/**
 * Normalize an event key for NEAR-MISS comparison (event-key-nearmiss-guard
 * P-003): lowercase + strip the separator characters agents drift on
 * (`-`, `_`, `:`, `.`), so `phase3-ready` ≡ `phase-3-ready` ≡ `Phase3_Ready`.
 * Deliberately normalized-EXACT, not edit-distance (D-003): catches the real
 * drift class with zero false-positive noise.
 */
export function normalizeEventKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_:.]/g, '');
}

/** Does an announcement's discovery scope match a reader's contexts? Global
 *  announcements are visible to everyone. */
export function announcementVisibleTo(
  ann: { scopeKind: string | null; scopeRef: string | null },
  reader: { fleetSlug?: string | null; planSlug?: string | null; harnessSlug?: string | null },
): boolean {
  if (!ann.scopeKind || ann.scopeKind === 'global') return true;
  if (ann.scopeKind === 'fleet') return !!reader.fleetSlug && ann.scopeRef === reader.fleetSlug;
  if (ann.scopeKind === 'plan') return !!reader.planSlug && ann.scopeRef === reader.planSlug;
  if (ann.scopeKind === 'harness') return !!reader.harnessSlug && ann.scopeRef === reader.harnessSlug;
  return false;
}
