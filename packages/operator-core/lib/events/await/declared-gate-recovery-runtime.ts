/**
 * Runtime wiring for the declared-gate recovery contract
 * (plan declared-gate-recovery-contract-2026-09-21; the pure contract lives in
 * ./declared-gate-recovery.ts).
 *
 * Two consumers share ONE evidence reader so they can never disagree:
 *
 *   - `events:status { event }` renders the evaluator's result for the current
 *     declaration (read-only; no side effects) — R-001's "existing status
 *     surface provides a bounded result".
 *   - the await sweeper (engine.ts), for every timed-out WAKE await whose exact
 *     key carries an announcement: classify the current generation, run the
 *     idempotent action bridge once per (announcement, generation,
 *     classification), and hand the waiter its exact next verb inside the
 *     timeout wake payload.
 *
 * Every probe is individually bounded and reported as `unavailable` rather
 * than defaulted, so a slow catalog read or a liveness-oracle outage yields
 * `unknown` + re-await, never a takeover and never success (R-001/R-002).
 *
 * Heavy/cyclic dependencies (condition-upsert → work-items, the coordination
 * wake fan, the events:status ownership resolver) are imported lazily: the
 * engine loads this module on the timeout path only, and those modules import
 * the engine themselves.
 */
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  announcementExpectedVerdict,
  announcementGenerationState,
} from './announcement-verdict';
import { findCatalogNearMiss, keyMatchesCatalog, mergeInstalledEventCatalog, type EventCatalogEntry } from './catalog';
import {
  applyDeclaredGateRecovery,
  evaluateDeclaredGateGeneration,
  type DeclaredGateAnnouncement,
  type DeclaredGateEvidenceInput,
  type DeclaredGateRecoveryAction,
  type DeclaredGateRecoveryDeps,
  type DeclaredGateRecoveryResult,
  type RecoveryProbe,
} from './declared-gate-recovery';
import { readInstalledUnitEvents } from './installed-events';
import { findAnnouncementsForKey, probeKeyFireEvidence } from './store';
import type { AwaitRow } from './types';

export const DECLARED_GATE_RECOVERY_ACTOR = 'system:declared-gate-recovery' as const;

const PROBE_TIMEOUT_MS = 1_500;

type OwnershipValue = { declaredByLiveness: string | null; liveSuccessorIds: readonly string[] };

export function toDeclaredGateAnnouncement(row: AwaitRow, eventKey: string = row.eventKey): DeclaredGateAnnouncement {
  return {
    id: row.id,
    eventKey,
    generation: row.causalGeneration ?? null,
    state: announcementGenerationState(row),
    declaredBy: row.subscriberId,
    firedAt: row.firedAt,
    firedReason: row.firedReason,
    expectedCondition: row.expectedCondition ?? null,
    expectedVerdict: announcementExpectedVerdict(row),
    boundTo: row.boundTo ?? null,
  };
}

function unavailable(reason: string): { status: 'unavailable'; reason: string } {
  return { status: 'unavailable', reason };
}

function degradedReason(r: { reason?: string; errorMessage?: string }): string {
  return r.reason === 'error' ? `error: ${r.errorMessage ?? 'unknown'}` : (r.reason ?? 'unavailable');
}

/** Static + installed catalog membership of an exact key (bounded). */
export async function probeCatalogMembership(
  eventKey: string,
  opts: { harnessSlug?: string } = {},
): Promise<DeclaredGateEvidenceInput['catalog']> {
  const probe = await withBoundedTimeout(
    async () => {
      const installed = await readInstalledUnitEvents({ harnessSlug: opts.harnessSlug });
      const entries = mergeInstalledEventCatalog(installed).entries as readonly EventCatalogEntry[];
      return { member: keyMatchesCatalog(eventKey, entries), nearMiss: findCatalogNearMiss(eventKey, entries) };
    },
    { fallback: null, timeoutMs: PROBE_TIMEOUT_MS, label: 'declared-gate-recovery:catalog' },
  );
  if (probe.value == null) return unavailable(`catalog ${degradedReason(probe)}`);
  return { status: 'measured', value: probe.value };
}

/**
 * Fire latch + family siblings + earlier-generation fires (bounded). `history`
 * is the key's declaration history when the caller already read it.
 */
export async function probeFireHistory(
  row: AwaitRow,
  history?: readonly AwaitRow[],
  eventKey: string = row.eventKey,
): Promise<DeclaredGateEvidenceInput['fireHistory']> {
  const [evidence, declarations] = await Promise.all([
    withBoundedTimeout(() => probeKeyFireEvidence(eventKey), {
      fallback: null,
      timeoutMs: PROBE_TIMEOUT_MS,
      label: 'declared-gate-recovery:fire-evidence',
    }),
    history
      ? Promise.resolve({ value: history as readonly AwaitRow[] | null, degraded: false as boolean, reason: undefined, errorMessage: undefined })
      : withBoundedTimeout<readonly AwaitRow[] | null>(
          () => findAnnouncementsForKey(eventKey, { includeSuperseded: true }),
          { fallback: null, timeoutMs: PROBE_TIMEOUT_MS, label: 'declared-gate-recovery:declaration-history' },
        ),
  ]);
  if (evidence.value == null) return unavailable(`fire latch ${degradedReason(evidence)}`);
  if (declarations.value == null) return unavailable(`declaration history ${degradedReason(declarations)}`);
  const generation = row.causalGeneration ?? null;
  const priorGenerationFired = declarations.value.some(
    (d) =>
      d.id !== row.id &&
      d.firedAt != null &&
      d.firedReason === 'event' &&
      (generation == null || d.causalGeneration == null || d.causalGeneration < generation),
  );
  return {
    status: 'measured',
    value: {
      exactFired: evidence.value.exact,
      familyFires: evidence.value.fires,
      priorGenerationFired,
      lastFiredAt: evidence.value.lastFiredAt,
    },
  };
}

/** Liveness-oracle ownership through the one events:status resolver (bounded, lazy). */
export async function probeOwnership(
  row: AwaitRow,
  workspaceId: string | null,
): Promise<DeclaredGateEvidenceInput['ownership']> {
  const probe = await withBoundedTimeout<OwnershipValue | null>(
    async () => {
      const { resolveAnnouncementOwnership } = await import('../../agent-tools/events/status');
      const owned = (await resolveAnnouncementOwnership([row], workspaceId)).get(row.id);
      return owned ? { declaredByLiveness: owned.declaredByLiveness, liveSuccessorIds: owned.liveSuccessorIds } : null;
    },
    { fallback: null, timeoutMs: PROBE_TIMEOUT_MS * 2, label: 'declared-gate-recovery:ownership' },
  );
  if (probe.value == null) return unavailable(`ownership ${degradedReason(probe)}`);
  return { status: 'measured', value: probe.value };
}

export interface GatherDeclaredGateEvidenceOptions {
  /** The exact key being inspected (defaults to the row's own event_key). */
  eventKey?: string;
  /** The key's current authoritative generation (defaults to this row's). */
  currentGeneration?: number | null;
  /** Pre-resolved ownership (events:status already computed it). */
  ownership?: RecoveryProbe<OwnershipValue>;
  /** Declaration history when already read. */
  history?: readonly AwaitRow[];
  producer?: DeclaredGateEvidenceInput['producer'];
  harnessSlug?: string;
  workspaceId?: string | null;
  nowMs?: number;
}

export async function gatherDeclaredGateEvidence(
  row: AwaitRow,
  opts: GatherDeclaredGateEvidenceOptions = {},
): Promise<DeclaredGateEvidenceInput> {
  const eventKey = opts.eventKey ?? row.eventKey;
  const [catalog, fireHistory, ownership] = await Promise.all([
    probeCatalogMembership(eventKey, { harnessSlug: opts.harnessSlug }),
    probeFireHistory(row, opts.history, eventKey),
    opts.ownership ? Promise.resolve(opts.ownership) : probeOwnership(row, opts.workspaceId ?? row.workspaceId ?? null),
  ]);
  return {
    announcement: toDeclaredGateAnnouncement(row, eventKey),
    currentGeneration: opts.currentGeneration !== undefined ? opts.currentGeneration : (row.causalGeneration ?? null),
    catalog,
    fireHistory,
    ownership,
    producer: opts.producer ?? null,
    checkedAtMs: opts.nowMs ?? Date.now(),
  };
}

/** Production bridge deps: the key's current declaration, condition-upsert, the coord wake fan. */
export function defaultDeclaredGateRecoveryDeps(row: AwaitRow): DeclaredGateRecoveryDeps {
  return {
    async readCurrentDeclaration(eventKey) {
      const [current] = await findAnnouncementsForKey(eventKey, { includeCancelled: true });
      return current ? { generation: current.causalGeneration ?? null, state: announcementGenerationState(current) } : null;
    },
    async upsertCondition(conditionKey, input) {
      const { upsertConditionWorkItem } = await import('../../coord/condition-upsert');
      const res = await upsertConditionWorkItem(conditionKey, {
        kind: 'bug',
        severity: 'minor',
        ...(row.scopeKind === 'harness' && row.scopeRef ? { harness: row.scopeRef } : {}),
        workspaceId: row.workspaceId,
        createdBy: DECLARED_GATE_RECOVERY_ACTOR,
        title: input.title,
        summary: input.summary,
        payload: input.payload,
      });
      return { id: res.id, created: res.created };
    },
    async wakeOwner(ownerId, input) {
      const { wakeRecipients } = await import('../../agent-tools/coordination/inbox-wake');
      const wake = await wakeRecipients([ownerId], {
        summary: input.summary,
        payload: input.payload,
        source: DECLARED_GATE_RECOVERY_ACTOR,
        workspaceId: row.workspaceId,
        requiredWake: true,
      });
      return { queued: wake.queued ?? wake.woken ?? 0 };
    },
  };
}

/** Compact, wake-payload-sized projection of a recovery result + bridge action. */
export function declaredGateRecoveryPayload(
  result: DeclaredGateRecoveryResult,
  action: DeclaredGateRecoveryAction | null,
): Record<string, unknown> {
  const e = result.evidence;
  return {
    event: e.eventKey,
    announcement_id: e.announcementId,
    generation: e.generation,
    current_generation: e.currentGeneration,
    ...(result.status === 'classified'
      ? {
          classification: result.classification,
          escalation_target: result.escalationTarget,
          idempotence_key: result.idempotenceKey,
        }
      : { inactive: result.reason }),
    next_verb: result.nextVerb,
    evidence: {
      declared_by: e.declaredBy,
      generation_state: e.generationState,
      catalog: e.catalogMembership,
      fire_history: e.fireHistory,
      owner_liveness: e.ownerLiveness,
      producer_health: e.producerHealth,
      expected_condition: e.expectedCondition,
      expected_verdict: e.expectedVerdict,
      reasons: e.reasons,
    },
    ...(action ? { action } : {}),
    rule: 'A timeout stays a timeout until the exact key fires with a matching generation and expected condition; follow next_verb, never treat this wake as the gate opening.',
  };
}

export interface AnnotateTimedOutAnnouncedAwaitsDeps {
  findCurrentDeclaration?: (eventKey: string) => Promise<AwaitRow | null>;
  gather?: (row: AwaitRow) => Promise<DeclaredGateEvidenceInput>;
  bridgeDeps?: (row: AwaitRow) => DeclaredGateRecoveryDeps;
}

/**
 * The sweeper hook. For each distinct exact key among `wakes` that carries a
 * current declaration: evaluate the generation ONCE, run the bridge ONCE, and
 * return the per-await payload extension. Keys without an announcement, and
 * keys whose evaluation fails, are simply absent from the map — the caller
 * keeps the generic timeout wake for them (fail-open).
 */
export async function annotateTimedOutAnnouncedAwaits(
  wakes: readonly AwaitRow[],
  deps: AnnotateTimedOutAnnouncedAwaitsDeps = {},
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  const byKey = new Map<string, AwaitRow[]>();
  for (const w of wakes) {
    if (!w.eventKey || w.eventKey.includes('*')) continue;
    const list = byKey.get(w.eventKey) ?? [];
    list.push(w);
    byKey.set(w.eventKey, list);
  }
  const findCurrent =
    deps.findCurrentDeclaration ??
    (async (eventKey: string) => (await findAnnouncementsForKey(eventKey, { includeCancelled: true }))[0] ?? null);
  const gather = deps.gather ?? ((row: AwaitRow) => gatherDeclaredGateEvidence(row));
  const bridgeDeps = deps.bridgeDeps ?? defaultDeclaredGateRecoveryDeps;
  for (const [eventKey, waiters] of byKey) {
    try {
      const declaration = await findCurrent(eventKey);
      if (!declaration) continue;
      const result = evaluateDeclaredGateGeneration(await gather(declaration));
      let action: DeclaredGateRecoveryAction | null = null;
      try {
        action = await applyDeclaredGateRecovery(result, bridgeDeps(declaration));
      } catch (e) {
        action = {
          action: 'none',
          conditionKey: result.status === 'classified' ? result.idempotenceKey : null,
          workItemId: null,
          detail: `bridge failed; the classification and next verb still stand: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const payload = declaredGateRecoveryPayload(result, action);
      for (const w of waiters) out.set(w.id, payload);
    } catch {
      // Fail-open: this key keeps the generic timeout wake.
    }
  }
  return out;
}
