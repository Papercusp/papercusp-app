/**
 * admit-conflict-free.ts — proactive, hive-scoped touch-set exclusion at the
 * placement chokepoint (plan-implementation-framework-2026-06-15 P-002,
 * "touch-set exclusion"; flag `papercusp-touch-set-exclusion`).
 *
 * Among the ready placement frontier, admit a conflict-free subset: a task is
 * admitted iff its declared file touch-set is disjoint from (a) the files already
 * in use by running bees and (b) the files of siblings admitted earlier this pass.
 * Greedy in the caller's priority order — the standard list-scheduling move:
 * priority from the DAG, exclusion at dispatch. A task with NO declared touch-set
 * is always admitted — the unknown case falls through to the runtime file-lock
 * backstop (intra-hive) / reactive git-merge (cross-hive). Pure + order-stable.
 *
 * Scope (D-003 / D-008): HIVE-scoped only. Cross-hive file collisions are NOT
 * coordinated here (that would be O(N)-global) — they stay on reactive merge.
 */

export interface ConflictFreeNode {
  id: string;
  /** Declared repo-relative file touch-set; empty/absent ⇒ unknown ⇒ always admitted. */
  files?: readonly string[] | null;
}

/**
 * Partition `tasks` (in priority order) into admitted vs deferred under file
 * exclusion. `inUseFiles` = files currently held by running work (e.g. live bees'
 * current_files). Deferred tasks keep their original order so the caller can
 * re-surface them next pass. Pure — never mutates its inputs.
 */
export function admitConflictFree<T extends ConflictFreeNode>(
  tasks: readonly T[],
  inUseFiles: readonly string[] = [],
): { admitted: T[]; deferred: T[] } {
  const claimed = new Set<string>(inUseFiles);
  const admitted: T[] = [];
  const deferred: T[] = [];
  for (const t of tasks) {
    const files = t.files ?? [];
    if (files.length === 0) {
      // Unknown touch-set → admit; the runtime file-lock is the backstop.
      admitted.push(t);
      continue;
    }
    if (files.some((f) => claimed.has(f))) {
      deferred.push(t);
      continue;
    }
    admitted.push(t);
    for (const f of files) claimed.add(f);
  }
  return { admitted, deferred };
}
