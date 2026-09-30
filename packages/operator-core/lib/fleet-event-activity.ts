/**
 * Projects the fleet transition event families onto the existing activity ledger.
 *
 * The ledger's INSERT already drives `/api/activity/stream`, so this is the one
 * events -> pui bridge P-026 needs.  It deliberately adds no event family and no
 * second transport.  Every accepted fire becomes one row; callers await the
 * append so two causally adjacent fires retain BIGSERIAL order.
 */
import type { ActivityRecord } from '@papercusp/activity-bridge';
import { createPgTelemetryStore } from './activity-pg-store';

export const FLEET_ACTIVITY_TRANSITIONS = [
  'member-dead',
  'member-left',
  'claim-released',
  'item-completed',
  'context-critical',
  'drained',
  'admission-blocked',
] as const;

export type FleetActivityTransition = (typeof FLEET_ACTIVITY_TRANSITIONS)[number];

export interface FleetEventActivityInput {
  eventKey: string;
  payload?: unknown;
  summary?: string | null;
  workspaceId: string;
}

export interface FleetEventActivityDeps {
  append?: (record: ActivityRecord) => Promise<unknown>;
  log?: (message: string) => void;
}

const transitionSet = new Set<string>(FLEET_ACTIVITY_TRANSITIONS);

function objectPayload(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Pure, lossless projection. `null` means this is not one of P-026's six events. */
export function fleetEventActivityRecord(input: FleetEventActivityInput): ActivityRecord | null {
  const match = /^fleet:([^:]+):(.+)$/.exec(input.eventKey);
  if (!match || !transitionSet.has(match[1]!)) return null;

  const transition = match[1] as FleetActivityTransition;
  const payload = objectPayload(input.payload);
  const fleetSlug = nonEmptyString(payload.fleetSlug) ?? match[2]!;
  const owner =
    nonEmptyString(payload.agentId) ??
    nonEmptyString(payload.assignee) ??
    nonEmptyString(payload.priorAssignee) ??
    `fleet:${fleetSlug}`;

  return {
    owner,
    agent: 'fleet',
    sessionId: null,
    scope: nonEmptyString(payload.harness),
    kind: 'lifecycle',
    toolName: 'fleet:event',
    phase: 'post',
    toolUseId: null,
    summary: input.summary?.trim() || `fleet ${fleetSlug}: ${transition}`,
    status: null,
    detail: {
      eventKey: input.eventKey,
      fleetSlug,
      transition,
      payload,
    },
    cwd: null,
    workspaceId: input.workspaceId,
  };
}

/** Best-effort activity append: observability must never break the event fire. */
export async function appendFleetEventActivity(
  input: FleetEventActivityInput,
  deps: FleetEventActivityDeps = {},
): Promise<boolean> {
  const record = fleetEventActivityRecord(input);
  if (!record) return false;

  try {
    const append = deps.append ?? ((row: ActivityRecord) => createPgTelemetryStore().append(row));
    await append(record);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps.log ?? console.warn)(`[fleet-event-activity] append failed for ${input.eventKey}: ${message}`);
    return false;
  }
}
