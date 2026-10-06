/**
 * WI-10004397: the single source for git-sync's disk-headroom REFUSAL wording.
 *
 * `withGitFetchHeadroom` refuses a fetch while the object store's filesystem sits at or under
 * the critical write reserve. That refusal reaches git-sync's `last_error` behind a long
 * generic prefix ("fetch failed; submodule remote state could not be verified before
 * superproject publication: …"), and on 2026-09-30 both fleet alarms misread it:
 *  - the escalation broadcast said "cause unclassified", and the "HEAD has unpushed commits"
 *    form would have read "push failing — commits NOT reaching origin", because "unpushed"
 *    contains "push";
 *  - the stall watchdog cut its cause headline before the headroom clause and named a DBOS
 *    executor wedge as the common root.
 * The real cause was a full root disk, and every superproject commit on the box stopped for
 * ~40 minutes while the alarms pointed at the network and the engine.
 *
 * Deliberately a LEAF module with no imports, so every alarm can recognise the refusal
 * without pulling in the fetch runner or the disk sampler (which loads the database layer).
 */
export const GIT_FETCH_HEADROOM_REFUSAL = 'git fetch stopped for disk headroom';

/** git's own out-of-space failure, which means the same thing: the local disk is full. */
const NO_SPACE_LEFT = 'no space left on device';

/**
 * True when a recorded git-sync error says the LOCAL DISK is full: the headroom refusal above,
 * or git's own ENOSPC. Neither is a network, credential or origin fault. "headroom unmeasured"
 * (the object store could not be sampled) is deliberately NOT matched: that is a measurement
 * failure, not evidence the disk is full.
 */
export function isLocalDiskFullError(text: string | null | undefined): boolean {
  const e = (text ?? '').toLowerCase();
  return e.includes(GIT_FETCH_HEADROOM_REFUSAL) || e.includes(NO_SPACE_LEFT);
}

/**
 * The actionable clause of a disk-full error: from the refusal (or ENOSPC) phrase to the end of
 * its line, prefixed with the scope that reported it (`libs/x: …`) when there is one. Null when
 * the text is not a disk-full error. Alarms that truncate a cause line use this so the clause
 * survives the cut instead of the generic "fetch failed; …" prefix.
 */
export function localDiskFullClause(text: string | null | undefined): string | null {
  const raw = text ?? '';
  const lower = raw.toLowerCase();
  let at = lower.indexOf(GIT_FETCH_HEADROOM_REFUSAL);
  if (at < 0) at = lower.indexOf(NO_SPACE_LEFT);
  if (at < 0) return null;
  const lineStart = raw.lastIndexOf('\n', at) + 1;
  const lineEnd = raw.indexOf('\n', at);
  const clause = raw.slice(at, lineEnd < 0 ? raw.length : lineEnd).trim();
  const line = raw.slice(lineStart, at);
  const scopeEnd = line.indexOf(': ');
  const scope = scopeEnd > 0 && scopeEnd <= 80 ? line.slice(0, scopeEnd).trim() : '';
  return scope && scope !== clause ? `${scope}: ${clause}` : clause;
}
