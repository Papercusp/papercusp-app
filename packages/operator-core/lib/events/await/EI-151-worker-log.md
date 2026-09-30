# EI-151 worker log — cross-agent inbox-wake misroute

## Bug
One agent's always-armed inbox-wake (turn-lifecycle-control) was delivered into a
**different** agent's session: A's `coord:inbox-wake:<A>` fired but executed
against B's live session (B told it was B's own awaited event).

## Root cause
The emit fires the correct, owner-specific key — the misroute is purely at
**execution**, in the wake-executor's live-session inject channel
(`psu-socket-inject`) and shared by `turn:interrupt`'s force leg. Both resolve a
live session via `findLiveHost(ownerId)` in
`packages/operator-core/lib/events/await/psu-pty-discovery.ts`.

`findLiveHost` located the discovery file purely by **filename**
(`<sanitizeKey(ownerId)>.json`) and returned its contents after a pid+socket
liveness check — but **never verified the file's recorded `ownerId` matched the
requested one**. `sanitizeKey` is lossy (maps every char outside
`[a-zA-Z0-9._-]` to `_`, truncates to 200), so two distinct coord owner ids can
resolve to the **same** discovery file (a structured pot-Scout id vs a colliding
one; a stale file left at a reused key during a `/loop` re-host). Whoever wrote
last owns the filename; a wake/interrupt for the *other* agent then resolved to
that host → cross-agent injection. Exactly the EI-151 symptom.

## Fix (self/inline)
`findLiveHost`: reject (return null → park/inbox, never the wrong session) when
the file's recorded `h.ownerId` is present and differs from the requested
`ownerId`. The recorded owner is authoritative; a filename collision / stale
reuse no longer hands back a different agent's host. Guards **both** the
wake-executor and `turn:interrupt` in one shared function.

No protected surface touched (no migration, deploy/release, scheduler, git-sync,
locks authority, auth/credentials, flags, or the self-improvement loop's own
code) — read-only discovery hardening.

## Regression test
`psu-pty-discovery.test.ts` → "EI-151: returns null when the recorded ownerId
differs from the requested key (cross-owner misroute)": a live, otherwise-valid
host file at owner A's discovery path but recorded as owner B (live pid + bound
socket so only the identity check can reject) → `findLiveHost('su-A')` must be
null. Red before the fix (would return B's host), green after.

## Verification
`npx vitest run lib/events/await` → 80/80 green, including the new test and every
cross-agent isolation/liveness suite (wake-executor-matrix, wake-resume-isolation
EI-153, wake-executor). tsc on the package shows **no** new errors in my files;
the package's existing tsc errors (466) are the pre-existing baseline from ~15
unrelated in-flight modified files in operator-core (none touch psu-pty), present
before this edit.

## For the validator to re-verify
- That requiring `h.ownerId === ownerId` doesn't reject any *legitimate* host:
  every writer (psu-pty-host.mjs `hostThroughPty`, the testbed `spawnSocketHost`,
  the unit-test `writeMeta`) writes `ownerId` == the filename key, so matching
  files still resolve. Confirmed by the unchanged green isolation/matrix suites.
