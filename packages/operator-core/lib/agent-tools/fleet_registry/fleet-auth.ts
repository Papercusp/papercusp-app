/**
 * fleet-auth — PURE fleet-authority predicates, dependency-free.
 *
 * Extracted from control-core (per-member-declarative-launch-specs P-006) so the auth
 * decision can be reused by side-effect-free callers (the cross-session compaction-limit
 * setter, and unit tests) WITHOUT dragging in control-core's messaging / audience / presence
 * machinery. control-core re-exports `classifyFleetControlInvoker` for back-compat, so every
 * existing importer keeps working.
 */

/** How a caller is authorized over a fleet, or null when they have none. */
export type FleetControlInvokerGrade = 'leader' | 'queen' | 'owner';

/**
 * PURE: classify the invoker's authority over a fleet, or null when they have none.
 * Order: leader beats the pane-kind grants (most specific claim).
 *   - leader — the registry row's recorded leader_owner_id
 *   - queen  — a mug/kettle pane (hive-level control authority)
 *   - owner  — an su pane (the owner's own interactive session; su-as-owner is
 *              the established convention, cf. blender:grade-idea)
 */
export function classifyFleetControlInvoker(input: {
  callerOwnerId: string;
  leaderOwnerId: string | null;
  paneKind: string;
}): FleetControlInvokerGrade | null {
  if (input.leaderOwnerId && input.leaderOwnerId === input.callerOwnerId) return 'leader';
  if (input.paneKind === 'mug' || input.paneKind === 'kettle') return 'queen';
  if (input.paneKind === 'su') return 'owner';
  return null;
}
