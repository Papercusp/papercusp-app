/**
 * Private capability for recovering a legacy fleet-scope downgrade.
 *
 * Old out-of-scope create+assign attempts were persisted as an unassigned row
 * with a public `fleetScopeDowngrade` payload marker.  The marker identifies
 * the exact requested target, but it is not itself authorization: callers must
 * pass an object minted by the current fleet-leader admission check.  Keeping
 * the mint in a module-private WeakSet prevents payload/argument forgery from
 * crossing the claim writer's born-pending floor.
 */

export interface FleetScopeDowngradeMarker {
  readonly requestedAssignee: string;
  readonly reportedBy: string;
  readonly fleet: string;
  readonly code: string;
  readonly at: string;
}

export interface LegacyFleetScopeDowngradeAdmission extends FleetScopeDowngradeMarker {
  readonly itemId: string;
  readonly target: string;
  readonly workspaceId: string;
  readonly leaderOwnerId: string;
}

const admissions = new WeakSet<object>();

/** A downgrade is a short-lived recovery handoff, not an eternal claim token. */
export const LEGACY_FLEET_SCOPE_DOWNGRADE_MAX_AGE_MS = 24 * 60 * 60_000;

export function readFleetScopeDowngradeMarker(payload: unknown): FleetScopeDowngradeMarker | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).fleetScopeDowngrade;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  const fields = ['requestedAssignee', 'reportedBy', 'fleet', 'code', 'at'] as const;
  if (!fields.every((field) => typeof marker[field] === 'string' && marker[field].trim())) return null;
  if (!['fleet_scope_violation', 'fleet_scope_missing', 'fleet_winding_down'].includes(marker.code as string)) {
    return null;
  }
  const at = marker.at as string;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const now = Date.now();
  if (atMs > now + 5 * 60_000 || now - atMs > LEGACY_FLEET_SCOPE_DOWNGRADE_MAX_AGE_MS) return null;
  return {
    requestedAssignee: marker.requestedAssignee as string,
    reportedBy: marker.reportedBy as string,
    fleet: marker.fleet as string,
    code: marker.code as string,
    at,
  };
}

export function mintLegacyFleetScopeDowngradeAdmission(
  args: LegacyFleetScopeDowngradeAdmission,
): LegacyFleetScopeDowngradeAdmission {
  const admission = Object.freeze({ ...args });
  admissions.add(admission);
  return admission;
}

export function isLegacyFleetScopeDowngradeAdmission(
  value: unknown,
): value is LegacyFleetScopeDowngradeAdmission {
  return typeof value === 'object' && value !== null && admissions.has(value);
}
