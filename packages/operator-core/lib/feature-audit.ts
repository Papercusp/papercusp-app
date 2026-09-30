/**
 * Append an audit row for a feature mutation. Fire-and-forget; never
 * blocks the caller.
 *
 * Writes the canonical row to `harness_shared.feature_audit_consolidated`
 * + a `sync_invalidate` for Zero. The per-harness `feature_audit` table is now
 * an auto-updatable view over consolidated (migration 118), so the old
 * best-effort per-harness mirror was removed — mirroring would route back into
 * consolidated and double-write.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 26a) so the features-mutation routes + `issues/:id/promote` +
 * `brainstorm/promote` can call it after they migrate off Hono.
 */
export function auditFeatureChange(
  harnessSlug: string,
  featureId: string,
  field: string,
  oldValue: any,
  newValue: any,
  actor: string,
): void {
  (async () => {
    try {
      const { db } = (await import('@papercusp/db-org')).getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { activeWorkspaceId } = await import('./workspace-registry');
      const ws = activeWorkspaceId();
      await db.insert(generated.featureAuditConsolidatedInHarnessShared).values({
        workspaceId: ws,
        harnessSlug,
        featureId,
        ts: Date.now(),
        field,
        oldValue: oldValue === undefined ? null : JSON.stringify(oldValue),
        newValue: newValue === undefined ? null : JSON.stringify(newValue),
        actor,
      });
      const { notifySyncInvalidate } = await import('./sync-sse');
      await notifySyncInvalidate('featureAudit.byHarness', { harnessSlug });
    } catch (e) {
      console.warn('[harness] feature audit insert failed:', (e as Error)?.message);
    }
  })();
}
