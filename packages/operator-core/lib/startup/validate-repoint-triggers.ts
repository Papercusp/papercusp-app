/**
 * Boot-time visibility guard for the repoint/readiness trigger COUPLING
 * (EI-19389225060317498, follow-up to migration 734).
 *
 * Migration 734's own header warns: "A future bulk backfill that DISABLEs triggers to
 * avoid a federation spike (as 649 did, by name) must NOT include
 * repoint_qualified_refs_trg in that list, or it re-creates this defect wholesale." That
 * warning names only ONE of the two triggers a harness re-home actually depends on:
 *
 *   - `repoint_qualified_refs_trg` (work_items, migration 734) repoints stale
 *     harness-qualified refs — including `work_item_deps.blocked_ref` — to the item's
 *     new slug.
 *   - `wir_deps_sync_trg` (work_item_deps, migration 379) is what actually RESYNCS the
 *     `work_item_blocked` readiness sidecar off that same UPDATE. 734 relies on this
 *     trigger firing as an UNDOCUMENTED cascade, not by design.
 *
 * Measured in packages/operator-core/lib/scheduler/rename-drift-effectiveness.integration.test.ts
 * ("the guard has TEETH" / "and it is wir_deps_sync_trg doing it"): with 734 fully intact
 * and ONLY `wir_deps_sync_trg` dropped, every ref is repointed correctly and the
 * readiness sidecar still silently strands at the OLD harness_slug — reproducing the
 * EI-19374236094682800 symptom (correct refs, live blocker, item served anyway) by a
 * different route. A bulk backfill that reads 734's header, faithfully preserves
 * `repoint_qualified_refs_trg`, and disables `wir_deps_sync_trg` for the SAME reason
 * (avoiding trigger-cascade overhead on a big UPDATE) recreates the exact defect 734
 * shipped to fix, without 734 itself being touched at all.
 *
 * This guard does not change either trigger's state (that is a runtime posture decision
 * for whoever is running the disable-trigger window) and does not gate boot — it exists
 * so a disabled window is DETECTED and logged loudly rather than silently trusted, per
 * EI-19389225060317498's suggested fix #2 ("A guard asserting both triggers are enabled
 * ... so a DISABLE-TRIGGER window is detected rather than trusted"). Read-only + fail-soft,
 * like its startup/ siblings (validate-durability-settings.ts et al.): a health check must
 * never fail boot, and a connection hiccup here says nothing about the real trigger state.
 */
import { getOrgPg } from '@papercusp/db-org';

/** The two triggers that must move together — see the module doc for why. */
export const REPOINT_COUPLED_TRIGGERS = ['repoint_qualified_refs_trg', 'wir_deps_sync_trg'] as const;

export interface RepointTriggerState {
  tableName: string;
  triggerName: string;
  /** Raw pg_trigger.tgenabled: 'O' origin (normal), 'D' disabled, 'R' replica-only, 'A' always. */
  enabled: string;
}

export interface RepointTriggersResult {
  ok: boolean;
  /** State of every coupled trigger FOUND in the catalog (missing rows are reported via `missing`). */
  triggers: RepointTriggerState[];
  /** Any of REPOINT_COUPLED_TRIGGERS not found in pg_trigger at all (e.g. dropped, not just disabled). */
  missing: string[];
  /** true when at least one coupled trigger is disabled ('D') or missing entirely — i.e. the
   *  repoint-and-resync coupling is currently broken, whatever the reason. */
  couplingBroken: boolean;
}

export async function checkRepointTriggersEnabled(): Promise<RepointTriggersResult> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ table_name: string; trigger_name: string; enabled: string }>>`
      SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND NOT t.tgisinternal
         AND t.tgname = ANY(${[...REPOINT_COUPLED_TRIGGERS]}::text[])
    `;
    const triggers: RepointTriggerState[] = rows.map((r) => ({
      tableName: r.table_name,
      triggerName: r.trigger_name,
      enabled: r.enabled,
    }));
    const foundNames = new Set(triggers.map((t) => t.triggerName));
    const missing = REPOINT_COUPLED_TRIGGERS.filter((n) => !foundNames.has(n));
    const disabled = triggers.filter((t) => t.enabled === 'D');
    const couplingBroken = disabled.length > 0 || missing.length > 0;

    if (couplingBroken) {
      const parts = [
        ...disabled.map((t) => `${t.triggerName} on ${t.tableName} is DISABLED`),
        ...missing.map((n) => `${n} is MISSING from the catalog`),
      ];
      console.warn(
        `[repoint-trigger-guard] the repoint/readiness coupling is broken: ${parts.join('; ')}. ` +
          'A harness re-home performed while this holds will repoint refs correctly but silently ' +
          'strand the work_item_blocked readiness sidecar at the OLD harness_slug (EI-19389225060317498) ' +
          '— the item will read as claimable when it should still be blocked. If this is an ' +
          'intentional bulk-backfill trigger-disable window, re-enable both triggers before it ends; ' +
          'if not, this is a live defect.',
      );
    } else {
      console.log(
        `[repoint-trigger-guard] repoint/readiness coupling intact — ${REPOINT_COUPLED_TRIGGERS.join(' + ')} both enabled.`,
      );
    }

    return { ok: true, triggers, missing, couplingBroken };
  } catch (e) {
    // Fail-soft: a health check must never fail boot, and a connection hiccup here says
    // nothing about the real trigger state.
    console.warn(
      '[repoint-trigger-guard] startup check skipped (non-fatal):',
      e instanceof Error ? e.message : e,
    );
    return { ok: true, triggers: [], missing: [], couplingBroken: false };
  }
}
