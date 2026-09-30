/**
 * Routine rows normally belong to a registered harness/hive, but the routines
 * engine also has two deliberate harness-less namespaces:
 *
 * - `@...` slugs are reserved synthetic hosts (for example `@singleton`).
 * - the workspace id is the workspace-scoped host used by global routines.
 *
 * Keep this predicate shared by startup validation and fire-path orphan
 * cleanup. If those two classifiers drift, valid routines are either reported
 * as fatally dark or, worse, disarmed as if their harness had been deleted.
 */
export function isReservedHarnesslessRoutineHost(installSlug: string, workspaceId: string): boolean {
  return installSlug.startsWith('@') || installSlug === workspaceId;
}
