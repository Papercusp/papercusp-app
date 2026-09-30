/**
 * Readiness-drift monitor — `system:readiness-drift-monitor`
 * (work-item-dependency-edges-2026-08-02 P-004).
 *
 * WHY THIS EXISTS. `reconcileReadiness` (lib/scheduler/readiness-reconcile.ts) has
 * been the designated detector for maintained-readiness drift since
 * work-item-deps-and-readiness-2026-06-22 P-005, and its own doc comment says it is
 * "a detector the scheduler/health surface reads". Nothing read it: the only caller
 * in the tree was its integration test. A detector nobody runs is not a safety net,
 * it is a comment — this action is the cadence that actually runs it.
 *
 * WHAT DRIFT MEANS. The `work_item_blocked` sidecar is trigger-maintained; PRESENCE
 * of a row = the feature item is NOT ready. Both drift directions are live hazards:
 *   • MISSING — blocked per the oracle, no sidecar row ⇒ the indexed anti-join claim
 *     HANDS OUT BLOCKED WORK. The dangerous direction.
 *   • EXTRA   — a sidecar row for an item that is not actually blocked ⇒ ready work
 *     STARVES, never claimed.
 *
 * DETECT **AND** REPAIR. `reconcileReadiness` stays a pure detector — that seam is
 * deliberate and unchanged. Repair lives here, and is simply `sync_work_item_blocked`
 * (the SAME function the wir_* triggers call) re-applied to the drifted keys, so it
 * is idempotent and cannot invent state the triggers wouldn't. Set
 * `payload_template.repair = false` for a detect-only tick.
 *
 * ⚠ SCOPE LIMIT — the readiness sweep catches a TRIGGER that has fallen out of step
 * with the ORACLE. It cannot catch an oracle that is itself wrong: when the predicate
 * is defective, the sidecar and the oracle agree perfectly and drift reads 0. That is
 * not hypothetical — it is exactly how EI-19313459163394127 hid. Every issue-family
 * blocking edge in the system was inert for months while this reconciliation would
 * have reported a clean missing=0/extra=0. Correctness of the predicate is the job
 * of migration 719's regression tests, NOT of this monitor; do not read a green
 * readiness tick as "blocking works".
 *
 * SECOND SWEEP — ENDPOINT INTEGRITY (EI-19325959789634791 / D-017). One concrete
 * slice of that blind spot is now covered here. An edge whose endpoint declares a
 * `*_kind` (or ref FORM) disagreeing with the family of the row it resolves to is
 * INERT: form-valid, mirrored, acyclic, counted by every row-shape check, and
 * invisible to the floor that must honour it. The readiness sweep cannot see it
 * (it is feature-only, and the sidecar agrees with the oracle either way), so
 * `reconcileWorkItemDepEndpoints` runs on this SAME tick. It is a SEPARATE
 * invariant on a separate table — kept as its own detector rather than folded into
 * reconcileReadiness, which structurally cannot see issue-family rows.
 *
 * The endpoint sweep is DETECT-ONLY, deliberately. The write seam
 * (`resolveDepEndpoint`) now makes the mismatch inexpressible, so a NEW mismatch
 * means something BYPASSED that seam — a fact to investigate, not to paper over.
 * Auto-rewriting the rows here would also make this a second edge writer, which is
 * exactly what D-010/D-014 exist to prevent. Repair stays the writer's job
 * (re-running syncWorkItemDepEdges for the affected item).
 *
 * Never throws (the routine engine treats a throw as a failed step, and a monitor
 * must not be able to wedge the tick). The two sweeps are independently guarded, so
 * a failure in one cannot suppress the other.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { reconcileReadiness, type ReadinessKey } from '../../scheduler/readiness-reconcile';
import {
  reconcileDependencyGraphPolicy,
  reconcileWorkItemDepEndpoints,
  type DepEndpointDefect,
} from '../../scheduler/work-item-deps-integrity';

/** Max keys named in a log line — the rest are summarized by count. */
const SAMPLE = 10;

const fmt = (keys: readonly ReadinessKey[]): string =>
  keys
    .slice(0, SAMPLE)
    .map((k) => `${k.workspace_id}/${k.harness_slug}#${k.feature_id}`)
    .join(', ') + (keys.length > SAMPLE ? ` …+${keys.length - SAMPLE} more` : '');

/**
 * Re-apply the trigger's own maintenance function to a set of drifted keys.
 * Returns how many were re-synced. Best-effort per key: one bad row never aborts
 * the sweep.
 */
async function repairKeys(keys: readonly ReadinessKey[]): Promise<number> {
  if (keys.length === 0) return 0;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  let repaired = 0;
  for (const k of keys) {
    try {
      await sql`SELECT harness_shared.sync_work_item_blocked(
        ${k.workspace_id}, ${k.harness_slug}, ${k.feature_id})`;
      repaired++;
    } catch (e) {
      console.warn(
        `[readiness-drift-monitor] repair failed for ${k.workspace_id}/${k.harness_slug}#${k.feature_id}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  return repaired;
}

const fmtEndpoint = (defects: readonly DepEndpointDefect[]): string =>
  defects
    .slice(0, SAMPLE)
    .map(
      (d) =>
        `${d.relation}#${d.row_id} ${d.side}=${d.ref} declared=${d.declared_kind}` +
        (d.expected_kind
          ? ` expected=${d.expected_kind}`
          : d.bare_id_found_in
            ? // The repair-deciding distinction: the item EXISTS, the qualifier is wrong.
              ` (unresolved here — that id exists in harness: ${d.bare_id_found_in} ⇒ RE-POINT the ref, do not delete)`
            : ' (resolves to nothing anywhere ⇒ stale ref, delete the edge)'),
    )
    .join(', ') + (defects.length > SAMPLE ? ` …+${defects.length - SAMPLE} more` : '');

/**
 * The D-017 endpoint-integrity sweep. Detect-only (see the module header for why), and
 * separately guarded so a failure here cannot suppress the readiness sweep above.
 */
async function sweepEndpointIntegrity(): Promise<void> {
  try {
    const res = await reconcileWorkItemDepEndpoints();
    if (res.defects === 0) {
      console.log(
        '[readiness-drift-monitor] work-item endpoints are family-consistent across ' +
          'work_item_deps + coord_links + coord_threads (defects=0)',
      );
      return;
    }
    // MISMATCHED leads: those edges are silently inert, which is the D-017 hazard.
    // DANGLING is hygiene — the writer tolerates an absent blocker by design.
    console.warn(
      `[readiness-drift-monitor] ENDPOINT DEFECTS defects=${res.defects} ` +
        `mismatched=${res.mismatched.length} (declared kind/form disagrees with the target row's family → the edge gates NOTHING) ` +
        `dangling=${res.dangling.length} (endpoint resolves to no row)`,
    );
    if (res.mismatched.length > 0) {
      console.warn(`[readiness-drift-monitor] mismatched: ${fmtEndpoint(res.mismatched)}`);
      console.warn(
        '[readiness-drift-monitor] a mismatch should be INEXPRESSIBLE at the canonical write seam ' +
          '(resolveDepEndpoint) — its presence means a writer BYPASSED that seam. Investigate the ' +
          'writer; repair by re-running syncWorkItemDepEdges for the affected item, not by hand-editing rows. ' +
          'NOTE the relation: work_item_deps is canonical and re-running the writer fixes it; ' +
          'a work-item blocks row in coord_links is unsupported legacy/rogue data after migration 935 ' +
          'and must be removed or corrected at the bypassing writer.',
      );
    }
    if (res.dangling.length > 0) {
      console.warn(`[readiness-drift-monitor] dangling: ${fmtEndpoint(res.dangling)}`);
    }
  } catch (e) {
    console.warn(
      '[readiness-drift-monitor] endpoint-integrity sweep failed (non-fatal): ' +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

async function sweepDependencyGraphPolicy(): Promise<void> {
  try {
    const census = await reconcileDependencyGraphPolicy();
    if (census.findings.length === 0) {
      console.log(
        `[readiness-drift-monitor] dependency policy clean across ${census.workspaces.length} workspace(s) ` +
          `(nodes=${census.nodes} edges=${census.edges} findings=0 stranded=${census.strandedNodes} ` +
          `durationMs=${census.telemetry.durationMs} budgetMs=${census.telemetry.budgetMs} ` +
          `budgetStatus=${census.telemetry.budgetStatus})`,
      );
      return;
    }
    console.warn(
      `[readiness-drift-monitor] DEPENDENCY POLICY FINDINGS findings=${census.findings.length} ` +
        `hard=${census.hardBlocks} advisory=${census.advisories} nodes=${census.nodes} edges=${census.edges} ` +
        `durationMs=${census.telemetry.durationMs} budgetMs=${census.telemetry.budgetMs} ` +
        `budgetStatus=${census.telemetry.budgetStatus}`,
    );
    for (const workspace of census.workspaces.filter((row) => row.findings.length > 0).slice(0, SAMPLE)) {
      console.warn(
        `[readiness-drift-monitor] workspace=${workspace.workspaceId} ` +
          `findings=${workspace.findings.map((finding) => `${finding.code}:${finding.classification}`).join(', ')}`,
      );
    }
    console.warn(
      '[readiness-drift-monitor] graph-policy findings are detect-only; repair the named writer/edge or record an explicit grandfather before strict rollout',
    );
  } catch (e) {
    console.warn(
      '[readiness-drift-monitor] dependency-policy sweep failed (non-fatal): ' +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

registerSystemAction('readiness-drift-monitor', async (ctx: SystemActionCtx) => {
  // Runs regardless of how the readiness sweep below exits (including its early returns),
  // because the two answer different questions and a clean readiness tick says nothing
  // about endpoint integrity.
  await sweepEndpointIntegrity();
  await sweepDependencyGraphPolicy();
  try {
    const repairEnabled = ctx.payloadTemplate?.repair !== false;

    const before = await reconcileReadiness();
    if (before.drift === 0) {
      console.log('[readiness-drift-monitor] sidecar agrees with the oracle (drift=0)');
      return;
    }

    // MISSING is the direction that hands out blocked work, so it leads the line.
    console.warn(
      `[readiness-drift-monitor] DRIFT drift=${before.drift} ` +
        `missing=${before.missing.length} (blocked per oracle, no sidecar row → served as ready) ` +
        `extra=${before.extra.length} (sidecar row but not blocked → starving)`,
    );
    if (before.missing.length > 0) console.warn(`[readiness-drift-monitor] missing: ${fmt(before.missing)}`);
    if (before.extra.length > 0) console.warn(`[readiness-drift-monitor] extra: ${fmt(before.extra)}`);

    if (!repairEnabled) {
      console.warn('[readiness-drift-monitor] repair disabled (payload_template.repair=false) — detect only');
      return;
    }

    const repaired = await repairKeys([...before.missing, ...before.extra]);
    const after = await reconcileReadiness();

    if (after.drift === 0) {
      console.log(`[readiness-drift-monitor] repaired ${repaired} key(s); sidecar now agrees with the oracle`);
      return;
    }
    // Residual drift after re-applying the triggers' own function means the fault is
    // NOT a missed trigger firing — it is the maintenance path itself. Say so loudly;
    // that distinction is the whole diagnostic value of the second pass.
    console.warn(
      `[readiness-drift-monitor] RESIDUAL drift=${after.drift} after repairing ${repaired} key(s) — ` +
        're-applying sync_work_item_blocked did not converge, so the fault is in the maintenance ' +
        'function or the oracle, not a missed trigger firing. Investigate rather than re-running.',
    );
  } catch (e) {
    // A monitor must never wedge the routine tick.
    console.warn('[readiness-drift-monitor] sweep failed (non-fatal): ' + (e instanceof Error ? e.message : String(e)));
  }
});
