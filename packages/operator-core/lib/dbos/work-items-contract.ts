/**
 * DBOS's bundled work-items import contract.
 *
 * The operator-core work-items helpers are bundled into packaged hosts rather than
 * resolved from node_modules at runtime. A partially refreshed bundle can therefore
 * contain a newer DBOS caller alongside an older work-items module: the host stays
 * alive, but DBOS aborts while importing its routines and every scheduled routine is
 * dark. Keep this check dependency-free so host-bootstrap can run it immediately
 * before importing DBOS.
 */

/** The exclusion helpers required by the current DBOS routines import graph. */
export const REQUIRED_DBOS_WORK_ITEMS_EXPORTS = [
  'needsOwnerActionExclusionSql',
] as const;

/** Return the current contract exports missing from a bundled work-items module. */
export function missingDbosWorkItemsExports(moduleExports: Record<string, unknown>): string[] {
  return REQUIRED_DBOS_WORK_ITEMS_EXPORTS.filter((name) => typeof moduleExports[name] !== 'function');
}

/**
 * Fail before DBOS registration when a packaged bundle has a mixed work-items contract.
 * The caller's outer boot guard deliberately handles this as a normal DBOS boot failure
 * so the existing urgent attention + severe-event diagnostics remain in one path.
 */
export function assertDbosWorkItemsImportContract(moduleExports: Record<string, unknown>): void {
  const missing = missingDbosWorkItemsExports(moduleExports);
  if (missing.length === 0) return;

  throw new Error(
    '[dbos] bundled work-items import contract is stale or mixed — missing required export(s): ' +
      `${missing.join(', ')}. Rebuild the sidecar from one coherent source tree before starting DBOS.`,
  );
}
