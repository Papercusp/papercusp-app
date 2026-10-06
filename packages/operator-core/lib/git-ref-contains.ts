/**
 * Is `sha` an ancestor-or-equal of `ref`? — measured through a STDOUT-ONLY git runner, and
 * correct on a history whose commit dates run backwards.
 *
 * WHY NOT `rev-list --count ${ref}..${sha}`: that was the containment read in this tree, and
 * it is date-ordered. `git rev-list A..B` stops walking the uninteresting side once SLOP (5)
 * consecutive uninteresting commits are older than everything left to emit, so when `ref`
 * heads a run of more than five commits dated in the PAST of their own parents, the
 * subtraction never reaches the shared history and the count comes back as "B's whole
 * ancestry". Repair-queue ADMISSION commits are exactly that run: every one carries the
 * deterministic `ADMISSION_GIT_DATE` (2000-01-01, see release/admission-commit-date.ts), and
 * under freeze-and-converge `origin/main` and the deployed sha routinely head dozens of them.
 * Measured 2026-10-02 on this repo: `rev-list --count d740fc3802..88eb78c838` = 29714 while
 * `merge-base --is-ancestor 88eb78c838 d740fc3802` exits 0 — so every path read
 * `inMain:false, deployed:false` on a release that contained it. `--topo-order` is NOT a fix:
 * it only answers correctly when a commit-graph supplies generation numbers.
 *
 * WHY NOT `merge-base --is-ancestor`: its answer is the exit status, which a stdout-only runner
 * (null on any non-zero exit) cannot tell apart from a failed read. `git merge-base <sha> <ref>`
 * prints the best common ancestor instead, and that IS `sha` exactly when `sha` is contained.
 * merge-base paints both sides to exhaustion, so commit dates cannot cut it short.
 *
 * Tri-state like every containment leg (D-038 axis 2): `null` means the read failed (missing
 * object, unrelated histories, timeout) — never "not contained".
 *
 * Deliberately a LEAF module with no imports, so both the bg-host pipeline probe and the
 * candidate-containment reader can share it without pulling each other in.
 */

/** Runs `git <args>` and yields trimmed stdout, or null on any failure. */
export type GitStdoutRead = (args: string[]) => Promise<string | null>;

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

/** The argv for the containment read (exported so test fakes key on the real shape). */
export function refContainsArgv(ref: string, sha: string): string[] {
  return ['merge-base', sha, ref];
}

export async function gitRefContains(read: GitStdoutRead, ref: string, sha: string): Promise<boolean | null> {
  const out = await read(refContainsArgv(ref, sha));
  if (out === null) return null;
  const base = out.split('\n')[0]?.trim().toLowerCase() ?? '';
  if (!base) return null;
  if (HEX_SHA.test(sha)) return base.startsWith(sha.toLowerCase());
  // A symbolic `sha` (a ref name) has to be resolved before the comparison means anything.
  const full = await read(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (full === null) return null;
  return base === full.trim().toLowerCase();
}
