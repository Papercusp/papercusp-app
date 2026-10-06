/**
 * P-004 (git-pipeline-agent-state-2026-07-26) — "does the commit the gate is about
 * to judge actually contain MY change?"
 *
 * The green-checkpoint judges a COMMITTED candidate, checked out into an isolated
 * tree. It cannot see the working tree, and — because of the quiet-cut — the commit
 * it judges is routinely NOT the tip. Nothing in the fire path answered the one
 * question the caller actually has, so EI-18752644493166307 burned two gate runs
 * finding out by hand (`git show <candidate>:<path> | grep <marker>`, four times).
 *
 * The expensive part is not the wasted run: it is that a candidate WITHOUT your fix
 * reds on the pre-fix failure with the pre-fix count, which reads as **"your fix did
 * not work"** rather than **"your fix was not present"**. The natural next move is to
 * go re-debug code that was already correct. This module exists so that reading is
 * never available: a caller is told, in the reply, which of its files the candidate
 * does and does not carry.
 *
 * ## The one design constraint: an ABSENCE must never read as a POSITIVE
 *
 * Every primitive here is built from git reads that produce NON-EMPTY output on
 * success, and the verdict type is a THREE-valued `boolean | null` — never a bare
 * boolean. The naive implementation (`git diff --name-only <sha> -- <path>`, empty
 * ⇒ "same") silently converts *the git call failed* into *your change IS in the
 * candidate* — a false reassurance, which is the exact failure class this module was
 * written to kill. git-pipeline-position.ts's `refContains` takes the same care for
 * the same reason ("rev-list prints a count on success … unlike `merge-base
 * --is-ancestor`, whose 0/1 exit a stdout-only runner swallows").
 *
 * So the comparison is BLOB-IDENTITY, both sides read as a sha:
 *   - `git rev-parse --verify <sha>:<path>` → the blob the candidate carries
 *   - `git hash-object -- <path>`           → the blob the working tree holds
 * Equal ⇒ the candidate carries exactly what you have. Different ⇒ it does not.
 * Candidate-side absent + tree-side present ⇒ a NEW file (the case a `git diff`
 * against a commit cannot see at all) — but NOT necessarily an uncommitted one: a new
 * file committed after the candidate is absent there and committed here, so HEAD, not
 * the candidate, decides which lever the caller needs. Tree-side unreadable
 * ⇒ `null`, "unknown", never "fine".
 *
 * That rule is now contract-level for every state cell, not a local discipline:
 * unified-agent-state-plane-2026-07-27 #D-038 axis 2. Its corollary is why
 * `unknownReason` below is an ENUMERATED code rather than the prose it started
 * as — see `cell-contract.ts`.
 */

import { cellUnknown, type CellUnknown } from './cell-contract';
import { gitRefContains } from './git-ref-contains';

/**
 * A git read scoped to one repo: trimmed stdout on success, `''` for a successful
 * command that printed nothing, and `null` when the command FAILED.
 *
 * The `''` vs `null` distinction is load-bearing — see the module doc. Adapters for
 * the two runner shapes already in the tree are at the bottom of this file.
 */
export type GitRead = (args: string[]) => Promise<string | null>;

const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The blob `sha` stores at `relPath`, or null when the path is absent there / the read failed. */
export async function blobAtCommit(git: GitRead, sha: string, relPath: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', `${sha}:${relPath}`]);
  return out && SHA_RE.test(out) ? out : null;
}

/**
 * The blob the WORKING TREE currently holds at `relPath` — the content a gate run
 * cannot see. Works for an untracked/new file, which is the whole point: a brand-new
 * test file is invisible to `git diff <commit>` and would otherwise read as "clean".
 */
export async function blobInWorkingTree(git: GitRead, relPath: string): Promise<string | null> {
  const out = await git(['hash-object', '--', relPath]);
  return out && SHA_RE.test(out) ? out : null;
}

/* ------------------------------------------------------------------------- *
 * Submodule-aware containment (EI-18828378090895599)
 *
 * A path inside a submodule is NOT a superproject blob: the superproject tree stores
 * only a GITLINK (mode 160000) for the submodule directory. So `rev-parse
 * <sha>:papercusp-desktop/bin/x.sh` FAILS — while `hash-object -- <same path>` happily
 * succeeds, because it just hashes bytes on disk and knows nothing about submodules.
 *
 * That asymmetry is what made the bug CONFIDENTLY WRONG rather than merely blind:
 * candidate-side null + tree-side present fell into the "new file" branch, HEAD was
 * read the same failing way (null), and `headBlob === treeBlob` was false — so a fully
 * committed file was reported `uncommitted`, whose prescribed lever is "git-sync:run,
 * then re-fire". On an already-red gate that costs another ~55min suite run and cannot
 * possibly help, because the file was committed all along. It is the exact inverse of
 * the misread the `marker` arg was added to kill.
 *
 * The repair is to ask the question in the repo that can answer it: resolve the
 * submodule commit the candidate PINS via its gitlink, then compare blobs INSIDE the
 * submodule. `git -C <root> -C <sub>` is the idiom — git accumulates relative `-C`
 * options, and both adapters at the bottom of this file lead with `-C <repo>`, so one
 * prepended pair re-scopes any read without a second runner.
 *
 * The module's absence-is-never-a-positive rule is unchanged and is why the gitlink
 * read below is THREE-valued: a submodule missing from the candidate ('' from ls-tree)
 * is a definitive negative, while an unreadable gitlink is `unknown` — never a verdict.
 * ------------------------------------------------------------------------- */

/** Re-scope a bound GitRead into a subdirectory (see the cumulative `-C` note above). */
export function gitReadInSubdir(git: GitRead, subdir: string): GitRead {
  return (args) => git(['-C', subdir, ...args]);
}

/**
 * Submodule paths from `.gitmodules`, LONGEST FIRST so a nested submodule wins over its
 * parent. Best-effort: a repo without `.gitmodules` yields `[]`, which restores the
 * plain superproject behaviour exactly.
 */
export async function submodulePrefixes(git: GitRead): Promise<string[]> {
  const out = await git(['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((p): p is string => !!p)
    .sort((a, b) => b.length - a.length);
}

/** The submodule commit a superproject commit pins, three-valued (see above). */
export type Gitlink =
  | { state: 'pinned'; pin: string }
  /** The superproject commit has no such submodule — a DEFINITIVE negative. */
  | { state: 'absent' }
  /** The read failed; nothing may be concluded. */
  | { state: 'unreadable' };

export async function submoduleGitlinkAt(git: GitRead, sha: string, sub: string): Promise<Gitlink> {
  const out = await git(['ls-tree', sha, '--', sub]);
  if (out === null) return { state: 'unreadable' };
  if (out === '') return { state: 'absent' };
  const m = /^160000\s+commit\s+([0-9a-f]{7,40})\b/.exec(out.trim());
  // An entry that is NOT a gitlink means the path is an ordinary directory/file at that
  // commit — not something this helper may turn into a pin.
  return m ? { state: 'pinned', pin: m[1] } : { state: 'absent' };
}

/** The blob pinned by the superproject HEAD, including a file inside a submodule.
 * A submodule checkout's own HEAD may be newer than the gitlink, so always read
 * the pinned commit rather than treating its current checkout as committed here. */
export async function committedBlobAtHead(
  git: GitRead,
  path: string,
  submodules?: readonly string[],
): Promise<string | null> {
  const sub = (submodules ?? await submodulePrefixes(git)).find(prefix => path.startsWith(`${prefix}/`));
  if (!sub) return blobAtCommit(git, 'HEAD', path);
  const link = await submoduleGitlinkAt(git, 'HEAD', sub);
  return link.state === 'pinned'
    ? blobAtCommit(gitReadInSubdir(git, sub), link.pin, path.slice(sub.length + 1))
    : null;
}

/**
 * Containment for one path inside `sub`, evaluated in the submodule's own object store.
 *
 * Reason selection keeps every value pointing at a lever that actually works, which is
 * the whole reason the false `uncommitted` was expensive:
 *  - not committed INSIDE the submodule        → `uncommitted`  (git-sync:run — correct)
 *  - committed there, but this candidate's pin
 *    predates it (or the pointer bump is still
 *    pending in the superproject)              → `newer-commit` (wait / next run — correct)
 */
async function classifySubmodulePath(
  git: GitRead,
  candidateSha: string,
  committedSha: string | null,
  sub: string,
  relPath: string,
  fullPath: string,
): Promise<PathContainment> {
  const unknown = (detail: string): PathContainment => ({
    path: fullPath,
    inCandidate: null,
    reason: null,
    unknownReason: cellUnknown('resolver-failed', detail),
  });
  if (!relPath) {
    return {
      path: fullPath,
      inCandidate: null,
      reason: null,
      unknownReason: cellUnknown(
        'not-applicable',
        `'${fullPath}' is the submodule directory itself (a gitlink), not a file inside it — blob containment does not apply.`,
      ),
    };
  }
  const subGit = gitReadInSubdir(git, sub);
  const treeBlob = await blobInWorkingTree(subGit, relPath);
  if (!treeBlob) {
    return unknown(
      `Could not read '${relPath}' from submodule '${sub}' working tree (deleted, or the submodule is not checked out) — containment is UNKNOWN, not confirmed.`,
    );
  }
  const link = await submoduleGitlinkAt(git, candidateSha, sub);
  if (link.state === 'unreadable') {
    return unknown(
      `Could not read the gitlink for submodule '${sub}' at ${candidateSha.slice(0, 12)} — containment is UNKNOWN, not missing.`,
    );
  }
  // Committed-ness is decided in the submodule, where the file actually lives.
  const subHeadBlob = committedSha ? await blobAtCommit(subGit, 'HEAD', relPath) : null;
  const reasonWhenMissing = (): MissingReason => {
    if (!committedSha) return 'absent';
    return subHeadBlob === treeBlob ? 'newer-commit' : 'uncommitted';
  };
  if (link.state === 'absent') {
    // The candidate predates the submodule entirely; it cannot carry the file.
    return { path: fullPath, inCandidate: false, reason: reasonWhenMissing(), unknownReason: null };
  }
  const candidateBlob = await blobAtCommit(subGit, link.pin, relPath);
  if (candidateBlob === treeBlob) {
    return { path: fullPath, inCandidate: true, reason: null, unknownReason: null };
  }
  return { path: fullPath, inCandidate: false, reason: reasonWhenMissing(), unknownReason: null };
}

/**
 * EI-18797292094433710 — the containment verdicts above compare the path's CURRENT
 * content, which answers "does the candidate carry exactly what I have?" and NOT the
 * question a caller actually asks: **"is MY change in the candidate?"**
 *
 * Those come apart the moment a PEER commits to the same file after you. The candidate
 * then carries your change and still fails blob-identity, so `inCandidate` reads false
 * with reason `newer-commit` — forever, on a hot shared file, because the tip is always
 * newer than the quiet-cut candidate. That misreading cost ~2h of a 3h+ fleet-wide
 * outage whose fix was sitting in every candidate the whole time.
 *
 * ## Why the caller must supply the marker — it cannot be derived
 *
 * The obvious repair is "resolve the commit carrying the caller's change and test
 * ancestry". It does not work HERE, and the reason is structural rather than
 * incidental: **git-sync commits the entire shared tree under one identity**, so the
 * fleet's commits are indistinguishable auto-commits ("chore(git-sync): auto-commit
 * …") that each carry many agents' unrelated edits. There is no commit that is "yours",
 * and listing the commits a candidate lacks yields N identical subjects — useless for
 * recognition, which is exactly why the tool punted this to a hand-run
 * `git merge-base --is-ancestor` instead of answering it.
 *
 * What IS decidable is content the caller can name: a distinctive string from its own
 * change. That is precisely what agents were already doing by hand
 * (`git show <sha>:<path> | grep -c '<marker>'`), so this promotes the established
 * workaround into the tool rather than inventing a new mechanism.
 *
 * The three-valued discipline of this module applies unchanged, and the '' vs null
 * distinction does the work: `git ls-tree` prints an entry when the path exists at that
 * commit and EMPTY on a clean miss, so "absent at that commit" is a DEFINITIVE negative
 * while a failed read stays `null`. A `false` here therefore never comes from a broken
 * git call — the failure this module exists to prevent.
 *
 * ⚠ SUBMODULE CAUTION (EI-18828378090895599). Unlike `classifyPathsAgainstCandidate`,
 * this function is NOT submodule-aware, and here that would be actively dangerous: for a
 * path inside a submodule, `ls-tree <superSha> -- <sub>/<file>` returns '' — which the
 * rule above reads as a DEFINITIVE negative, i.e. a confident "your change is NOT in the
 * candidate". That is the precise misread `marker` was added to kill, inverted.
 *
 * So `dev:pipeline_position` never calls this directly for a superproject-relative path:
 * it goes through `markerAtCandidateForPath` below, which resolves the gitlink first (as
 * `classifySubmodulePath` does) and counts the marker INSIDE the pinned submodule
 * commit. Call this one only with a path that is a real blob in `git`'s own tree.
 */
export interface MarkerContainment {
  marker: string;
  sha: string;
  /** true = the marker occurs at least once in that commit's version of the file. */
  present: boolean | null;
  /** Occurrences of the literal marker; 0 with `present:false`, null when unknown. */
  count: number | null;
  /** false = the path does not exist at that commit at all (a definitive miss). */
  pathPresent: boolean | null;
  unknownReason: CellUnknown | null;
}

/** Occurrences of a LITERAL (never regex) marker — the caller supplies code, not a pattern. */
function countLiteral(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Does `sha`'s version of `relPath` contain `marker`, and how many times?
 *
 * Counting happens in JS over `git show` output rather than via `git grep -c`, because
 * `git grep` signals "no match" through EXIT CODE 1 — which every runner in this tree
 * collapses to `null`, making a clean miss indistinguishable from a broken call. Reading
 * the blob keeps the miss inside the DATA (a string with zero occurrences) where it is
 * unambiguous.
 */
export async function markerAtCommit(
  git: GitRead,
  sha: string,
  relPath: string,
  marker: string,
): Promise<MarkerContainment> {
  const base = { marker, sha };
  const unknown = (code: Parameters<typeof cellUnknown>[0], detail: string): MarkerContainment => ({
    ...base,
    present: null,
    count: null,
    pathPresent: null,
    unknownReason: cellUnknown(code, detail),
  });
  if (!marker) {
    return unknown('not-applicable', 'No marker was supplied, so there is nothing to look for.');
  }
  const resolved = await git(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (!resolved || !SHA_RE.test(resolved)) {
    return unknown(
      'resolver-failed',
      `Commit '${sha.slice(0, 12)}' does not resolve in this repo — marker containment is UNKNOWN, not missing.`,
    );
  }
  // '' (exit 0, no output) = the tree genuinely has no such path at that commit — a
  // DEFINITIVE negative. null = the read failed, which must never read as a negative.
  const entry = await git(['ls-tree', sha, '--', relPath]);
  if (entry === null) {
    return unknown('resolver-failed', `Could not list '${relPath}' at ${sha.slice(0, 12)} — containment is UNKNOWN.`);
  }
  if (entry === '') {
    return { ...base, present: false, count: 0, pathPresent: false, unknownReason: null };
  }
  const blob = await git(['show', `${sha}:${relPath}`]);
  if (blob === null) {
    // ls-tree says the path IS there, so a failed read is a genuine anomaly, not absence.
    return unknown('resolver-failed', `'${relPath}' exists at ${sha.slice(0, 12)} but could not be read.`);
  }
  const count = countLiteral(blob, marker);
  return { ...base, present: count > 0, count, pathPresent: true, unknownReason: null };
}

/**
 * P-011 (main-green-status-visible-2026-09-03): `markerAtCommit` for a SUPERPROJECT-relative
 * path that may live inside a submodule. The plain path is delegated unchanged; a submodule
 * path resolves the gitlink `candidateSha` carries for its submodule and counts the marker
 * in THAT commit's version of the file, read inside the submodule's own object store — the
 * same route `classifySubmodulePath` takes for blob identity, so the two verdicts the cell
 * reports are about the same object.
 *
 * Three-valued exactly like the gitlink read: an ABSENT gitlink (the candidate predates the
 * submodule) is a definitive "no such file" (`pathPresent:false`), an UNREADABLE one is
 * `unknown`, never a verdict. `sha` on the result stays the SUPERPROJECT candidate — the
 * commit the caller asked about; the pin is the route to its content, not the subject.
 */
export async function markerAtCandidateForPath(
  git: GitRead,
  candidateSha: string,
  path: string,
  marker: string,
  opts: { submodules?: string[] } = {},
): Promise<MarkerContainment> {
  if (!marker) return markerAtCommit(git, candidateSha, path, marker);
  const submodules = opts.submodules ?? (await submodulePrefixes(git));
  const sub = submodules.find((s) => path === s || path.startsWith(s + '/')) ?? null;
  if (!sub) return markerAtCommit(git, candidateSha, path, marker);
  const base = { marker, sha: candidateSha };
  const unknown = (code: Parameters<typeof cellUnknown>[0], detail: string): MarkerContainment => ({
    ...base,
    present: null,
    count: null,
    pathPresent: null,
    unknownReason: cellUnknown(code, detail),
  });
  const rel = path.slice(sub.length).replace(/^\//, '');
  if (!rel) {
    return unknown(
      'not-applicable',
      `'${path}' is the submodule directory itself (a gitlink), not a file inside it — marker containment does not apply.`,
    );
  }
  const link = await submoduleGitlinkAt(git, candidateSha, sub);
  if (link.state === 'unreadable') {
    return unknown(
      'resolver-failed',
      `Could not read the gitlink for submodule '${sub}' at ${candidateSha.slice(0, 12)} — marker containment is UNKNOWN, not missing.`,
    );
  }
  if (link.state === 'absent') {
    // The candidate predates the submodule entirely: it has no version of this file.
    return { ...base, present: false, count: 0, pathPresent: false, unknownReason: null };
  }
  const inner = await markerAtCommit(gitReadInSubdir(git, sub), link.pin, rel, marker);
  return { ...inner, sha: candidateSha };
}

/**
 * Why a path is not in the candidate. The reason picks the LEVER, which is the only
 * part the caller can act on:
 *  - `uncommitted`  → the edit never left the working tree. Commit it (git-sync:run).
 *  - `newer-commit` → it IS committed, but in a commit newer than the candidate
 *                     (quiet-cut, or the candidate simply lags). Re-fire once the
 *                     quiet window passes, or wait for the next run.
 *  - `absent`       → the candidate has no such path AND no HEAD was supplied to ask
 *                     whether a newer commit carries it, so committed-ness is genuinely
 *                     unknown. With a HEAD (the default) this collapses into one of the
 *                     two above, because those name a lever and this does not.
 */
export type MissingReason = 'uncommitted' | 'newer-commit' | 'absent';

export interface PathContainment {
  path: string;
  /** true = the candidate carries exactly this working-tree content. null = could not tell. */
  inCandidate: boolean | null;
  reason: MissingReason | null;
  /**
   * Present when `inCandidate` is null: why the comparison could not be made —
   * ENUMERATED, never prose (D-038 axis 2 corollary). A caller branches on
   * `code` (`not-applicable` is final; `resolver-failed` is retry-or-escalate);
   * `detail` carries the sentence this field used to hold on its own.
   */
  unknownReason: CellUnknown | null;
}

/** The newest commit touching `relPath` in `ref` — tri-state (module doc: an absence must
 *  never read as a positive). `null` = the read failed; `{ sha: null }` = a MEASURED
 *  absence (no commit in `ref`'s history touches this path); `{ sha }` = found. */
async function newestCommitTouching(
  git: GitRead,
  ref: string,
  relPath: string,
): Promise<{ sha: string | null } | null> {
  const out = await git(['log', '-1', '--pretty=%H', ref, '--', relPath]);
  if (out === null) return null;
  return { sha: out === '' ? null : out };
}

/**
 * Is `sha` an ancestor-or-equal of `ref`? Tri-state, through a stdout-only runner — see
 * git-ref-contains.ts for why this is `merge-base` and not `rev-list --count ${ref}..${sha}`
 * (that read miscounts when the frozen candidate heads a run of 2000-01-01 admission commits,
 * which is precisely the ref this module judges).
 */
async function isAncestorOrEqual(git: GitRead, sha: string, ref: string): Promise<boolean | null> {
  return gitRefContains(git, ref, sha);
}

/**
 * EI-19326775809436764 — a path classified `uncommitted` by blob comparison against the
 * live WORKING TREE is not self-evidently the CALLER's missing work. On a checkout edited
 * by ~100 concurrent agents, the dirty content just as often belongs to a peer mid-edit on
 * a file the caller separately (and already, committedly) touched. Reporting that path as
 * `missing` and prescribing "commit it (git-sync:run), then re-fire" is then both wrong and
 * expensive — a needless multi-hour suite re-run on a candidate that already carries every
 * commit that has landed.
 *
 * This does NOT attempt to determine WHOSE edit the dirty content is — that is undecidable
 * without a marker (see `markerAtCommit`'s doc above: git-sync commits the whole tree under
 * one identity, so no commit is identifiably "yours"). It answers a narrower, fully
 * decidable question instead: has EVERY commit that has ever landed on this path (as of
 * `committedSha`) already reached the candidate? If so, nothing COMMITTED is missing — the
 * blob mismatch is caused entirely by content nobody has committed yet, and blaming "your
 * missing commit" for it is unsound.
 *
 * Per this module's absence-is-never-a-positive rule, a confirmed refinement is reported as
 * UNKNOWN (`insufficient-data`), never as `inCandidate: true` — it does not prove the
 * caller's own edit is captured (it may still be sitting uncommitted), it only disproves
 * that a LANDED commit is missing. Returns null when no refinement applies (the read failed,
 * no commit has ever touched this path at `committedSha`, or the ancestry check found the
 * candidate genuinely behind) — callers keep the original `uncommitted` classification.
 */
async function refineUnattributedUncommitted(
  git: GitRead,
  committedSha: string,
  candidateSha: string,
  path: string,
): Promise<PathContainment | null> {
  const newest = await newestCommitTouching(git, committedSha, path);
  if (!newest?.sha) return null;
  const upToDate = await isAncestorOrEqual(git, newest.sha, candidateSha);
  if (upToDate !== true) return null;
  return {
    path,
    inCandidate: null,
    reason: null,
    unknownReason: cellUnknown(
      'insufficient-data',
      `The candidate already contains every commit landed for '${path}' as of HEAD — nothing COMMITTED is ` +
        `missing. The remaining difference from the working tree is UNCOMMITTED content that could be yours ` +
        `(not yet swept by git-sync) or a peer's unrelated edit on this shared tree; this tool cannot attribute ` +
        `it. If it is your own uncommitted work, git-sync:run then re-fire; otherwise this path's containment ` +
        `is already confirmed by ancestry — no re-fire needed.`,
    ),
  };
}

/**
 * Classify each path against `candidateSha` by blob identity against the WORKING TREE.
 *
 * `committedSha` (usually HEAD) separates the two missing-reasons: a path whose
 * working-tree blob differs from HEAD's is an UNCOMMITTED edit (the caller's own
 * lever); one that matches HEAD but not the candidate is committed-but-newer (the
 * quiet-cut case). Omit it and every miss is reported as `newer-commit`.
 */
export async function classifyPathsAgainstCandidate(
  git: GitRead,
  candidateSha: string | null,
  paths: string[],
  committedSha: string | null = 'HEAD',
  opts: {
    /**
     * Submodule prefixes to recognise. Omitted ⇒ discovered from `.gitmodules`
     * (EI-18828378090895599); pass `[]` to force plain superproject behaviour.
     */
    submodules?: string[];
  } = {},
): Promise<PathContainment[]> {
  if (!candidateSha) {
    return paths.map((path) => ({
      path,
      inCandidate: null,
      reason: null,
      // No candidate was supplied at all, so containment is not a question that
      // applies yet — a retry with the same inputs cannot change it.
      unknownReason: cellUnknown(
        'not-applicable',
        'No candidate commit could be resolved, so there is nothing to compare against.',
      ),
    }));
  }
  // The candidate COMMIT must resolve before any per-path verdict is meaningful. Without
  // this, an unresolvable sha makes every `<sha>:<path>` read fail, and a failed read on
  // the candidate side is indistinguishable from "the commit genuinely lacks this path" —
  // so every file comes back `absent`, a DEFINITIVE miss, and the caller is hard-warned
  // that none of its work is in the run. Caught live: a garbage sha reported
  // `inCandidate: false, reason: 'absent'` for a file that was plainly committed.
  // `judgingSha` is parsed from a log line / a foreign checkout's HEAD, so a stale or
  // bogus value is a real input, not a hypothetical — and a detector that cries wolf is
  // one agents learn to ignore.
  const resolved = await git(['rev-parse', '--verify', `${candidateSha}^{commit}`]);
  if (!resolved || !SHA_RE.test(resolved)) {
    return paths.map((path) => ({
      path,
      inCandidate: null,
      reason: null,
      // A sha WAS supplied and this repo could not resolve it — a fetch, or a
      // read against the right checkout, may still answer. Not `not-applicable`.
      unknownReason: cellUnknown(
        'resolver-failed',
        `Candidate commit '${candidateSha.slice(0, 12)}' does not resolve in this repo — containment is UNKNOWN, not missing.`,
      ),
    }));
  }
  // EI-18828378090895599: a path inside a submodule cannot be answered by superproject
  // blob reads at all — see the submodule block above. Discovered once per call, not
  // per path, and skipped entirely when the caller passes an explicit list.
  const submodules = opts.submodules ?? (await submodulePrefixes(git));
  const submoduleFor = (p: string): string | null =>
    submodules.find((s) => p === s || p.startsWith(s + '/')) ?? null;

  return Promise.all(
    paths.map(async (path): Promise<PathContainment> => {
      const sub = submoduleFor(path);
      if (sub) {
        return classifySubmodulePath(
          git,
          candidateSha,
          committedSha,
          sub,
          path.slice(sub.length).replace(/^\//, ''),
          path,
        );
      }
      const [candidateBlob, treeBlob] = await Promise.all([
        blobAtCommit(git, candidateSha, path),
        blobInWorkingTree(git, path),
      ]);
      if (!treeBlob) {
        return {
          path,
          inCandidate: null,
          reason: null,
          unknownReason: cellUnknown(
            'resolver-failed',
            `Could not read '${path}' from the working tree (deleted, or outside this repo) — containment is UNKNOWN, not confirmed.`,
          ),
        };
      }
      if (candidateBlob === treeBlob) return { path, inCandidate: true, reason: null, unknownReason: null };
      // A path ABSENT from the candidate is NOT self-evidently uncommitted. A brand-new
      // file committed AFTER the candidate is absent there and fully committed here — the
      // single commonest case on this tree, because the quiet-cut deliberately steps the
      // judged commit back ~4 min behind the tip. Answering `absent` without consulting
      // HEAD therefore sent callers to `git-sync:run`, a NO-OP for an already-committed
      // file, while the real lever (wait out the quiet window / let the next run pick it
      // up) went unnamed. So HEAD decides this case exactly as it decides the modified
      // one below; `absent` now survives only when there is no HEAD to ask.
      const headBlob = committedSha ? await blobAtCommit(git, committedSha, path) : null;
      if (!candidateBlob) {
        if (!committedSha) return { path, inCandidate: false, reason: 'absent', unknownReason: null };
        // HEAD carries exactly this content ⇒ committed, merely newer than the candidate.
        // HEAD lacks it or differs ⇒ the edit really has not left the working tree — UNLESS
        // ancestry proves otherwise; see refineUnattributedUncommitted below.
        if (headBlob === treeBlob) return { path, inCandidate: false, reason: 'newer-commit', unknownReason: null };
        const refined = await refineUnattributedUncommitted(git, committedSha, candidateSha, path);
        if (refined) return refined;
        return { path, inCandidate: false, reason: 'uncommitted', unknownReason: null };
      }
      if (!(headBlob && headBlob !== treeBlob)) {
        return { path, inCandidate: false, reason: 'newer-commit', unknownReason: null };
      }
      {
        const refined = committedSha ? await refineUnattributedUncommitted(git, committedSha, candidateSha, path) : null;
        if (refined) return refined;
      }
      return { path, inCandidate: false, reason: 'uncommitted', unknownReason: null };
    }),
  );
}

/** The caller-facing split P-004 asks `release:checkpoint-run` to report. */
export interface CallerEditsInCandidate {
  /** Paths the candidate carries byte-identically to the working tree. */
  included: string[];
  /** Paths it does NOT — a red on any of these is NOT evidence your fix failed. */
  missing: string[];
  /** Paths whose containment could not be determined (never counted as included). */
  unknown: string[];
  /** Per-path detail, in the order the paths were given. */
  paths: PathContainment[];
  /** The candidate these verdicts describe. */
  candidateSha: string | null;
}

export async function callerEditsInCandidate(
  git: GitRead,
  candidateSha: string | null,
  paths: string[],
  committedSha: string | null = 'HEAD',
  opts: { submodules?: string[] } = {},
): Promise<CallerEditsInCandidate> {
  const results = await classifyPathsAgainstCandidate(git, candidateSha, paths, committedSha, opts);
  return {
    included: results.filter((r) => r.inCandidate === true).map((r) => r.path),
    missing: results.filter((r) => r.inCandidate === false).map((r) => r.path),
    unknown: results.filter((r) => r.inCandidate === null).map((r) => r.path),
    paths: results,
    candidateSha,
  };
}

const TEST_FILE_RE = /\.test\.tsx?$/;

/**
 * EI-18796358994458975 — a known FALSE-RED SHAPE: among the caller's own declared paths,
 * the candidate carries a `*.test.ts(x)` byte-identically (`inCandidate: true`) while a
 * NON-test path is missing for reason `newer-commit` — i.e. the quiet-cut stepped the
 * judged commit back to a point that has the test but not the implementation commit that
 * makes it pass. That candidate is red before the suite even starts, and the red is
 * indistinguishable in the ledger from a genuine regression.
 *
 * Deliberately restricted to the caller's OWN declared `paths` (never a repo-wide scan):
 * this module has no import-graph resolver, and `paths` is already the caller's own
 * "files my change touches" declaration — exactly the set the 2026-07-27 incident's
 * containment report proved the shape against (`deliberation-harness-fallback.test.ts`
 * included, `index.ts` missing/`newer-commit`, same declared change). A caller that
 * declares its test file alongside its implementation file gets this warning for free;
 * one that declares only the test file cannot be helped by this heuristic (there is no
 * signal to detect a split against), which is a scope limit, not a false negative.
 */
export interface TestImplSplitRisk {
  /** True when at least one included test file AND one missing (`newer-commit`) non-test
   *  file both appear among the caller's declared paths — the shape this module detects. */
  detected: boolean;
  /** Declared `*.test.ts(x)` paths the candidate DOES carry. */
  includedTests: string[];
  /** Declared non-test paths missing from the candidate for reason `newer-commit` — the
   *  likely "other half" of a torn TDD commit pair. */
  missingImpl: string[];
}

export function testImplSplitRisk(paths: PathContainment[]): TestImplSplitRisk {
  const includedTests = paths.filter((p) => p.inCandidate === true && TEST_FILE_RE.test(p.path)).map((p) => p.path);
  const missingImpl = paths
    .filter((p) => p.inCandidate === false && p.reason === 'newer-commit' && !TEST_FILE_RE.test(p.path))
    .map((p) => p.path);
  return { detected: includedTests.length > 0 && missingImpl.length > 0, includedTests, missingImpl };
}

/**
 * Paths with uncommitted working-tree changes, INCLUDING untracked files.
 *
 * An untracked file is the most dangerous input to a gate run — a brand-new test or
 * fixture the candidate provably cannot contain, and the one case a `git diff` against
 * a commit cannot see at all — so it must be in this set.
 *
 * Deliberately TWO bare-path reads rather than one `git status --porcelain`. Porcelain
 * v1 encodes the state in a fixed two-column PREFIX (`" M path"`), so its meaning
 * depends on leading whitespace — and every runner in this tree trims stdout, which
 * silently eats the first line's leading space and shifts the column parse by one. That
 * is a parse whose correctness depends on something no caller can see; these two
 * commands emit paths and nothing else, so there is no column to lose.
 */
export async function uncommittedPaths(git: GitRead): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only', 'HEAD']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  const paths = [tracked, untracked]
    .filter((o): o is string => typeof o === 'string' && o.length > 0)
    .flatMap((o) => o.split('\n'))
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(paths)];
}

/**
 * `sha subject` for the commits in `(from, to]` that touch `relPath` — the concrete
 * resolution P-004 asks for.
 *
 * The old quiet-cut warning listed excluded SHAS and said "if your fix is among
 * them". That offloads the resolution onto the reader, and it is the wrong space to
 * offload it into: an agent knows exactly which FILES it edited and knows nothing
 * about which sha carries them. Answering in path-space turns a question the caller
 * cannot answer into one it never has to.
 */
export async function excludedCommitsTouchingPath(
  git: GitRead,
  from: string,
  to: string,
  relPath: string,
): Promise<string[]> {
  if (from === to) return [];
  const out = await git(['log', '--oneline', '--no-decorate', `${from}..${to}`, '--', relPath]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * WI-38356 — the gitlink prefix that CONTAINS `relPath`, or null when it is not inside any of
 * `submodulePaths` (pair with `submodulePrefixes`, whose longest-first order this preserves).
 *
 * Why this is needed at all: `excludedCommitsTouchingPath` above runs a SUPERPROJECT
 * `git log -- <relPath>`, and a submodule's contents are not superproject paths — a commit that
 * bumps `libs/papercusp` touches exactly that gitlink, never
 * `libs/papercusp/libs/db/sql/816-x.sql`. So that read's honest answer for a submodule-internal
 * path is "no commits", which a caller cannot distinguish from "nothing touched it". Resolving
 * the containing gitlink is what makes the two separable.
 *
 * A path EQUAL to a gitlink is deliberately NOT "inside" it: that path already resolves in the
 * superproject, so it needs no attribution. (`classifyPathsAgainstCandidate`'s own `submoduleFor`
 * matches equality too, because it must answer "is this path submodule-governed at all" — a
 * different question from "which commit carries this file".)
 */
export function containingSubmodulePath(submodulePaths: string[], relPath: string): string | null {
  let best: string | null = null;
  for (const p of submodulePaths) {
    if (!p || !relPath.startsWith(`${p}/`)) continue;
    if (best === null || p.length > best.length) best = p;
  }
  return best;
}

/* NOTE: the "every path touched by (from, to]" read deliberately does NOT live here.
 * Its only consumer is `willJudge.excludedPaths` in release-checkpoint-launch.ts, which
 * must stay SYNCHRONOUS — that function's steps from the active-run check to `spawnFn`
 * have to run in one tick (see its cancelStaleAwaits comment), so an async helper could
 * not be used there. It is `pathsBetweenSync` in that module. An async twin here would be
 * dead code that only its own test exercised. */

/* ------------------------------------------------------------------------- *
 * Adapters for the two git-runner shapes already in the tree.
 * ------------------------------------------------------------------------- */

/** Bind a `(repo, args)` runner (git-pipeline-position's `GitRunner`) to one repo. */
export function gitReadForRepo(
  runner: (repo: string, args: string[]) => Promise<string | null>,
  repo: string,
): GitRead {
  return (args) => runner(repo, args);
}

/** Bind a sync `(cmd, args) => { status, stdout }` runner (release-checkpoint-launch's `ExecSyncLike`). */
export function gitReadFromExecSync(
  execFn: (cmd: string, args: string[]) => { status: number | null; stdout: string },
  repo: string,
): GitRead {
  return async (args) => {
    const r = execFn('git', ['-C', repo, ...args]);
    // Preserve the '' vs null distinction the module doc depends on: a zero exit with
    // no output is a real EMPTY answer, not a failure.
    return r.status === 0 ? r.stdout.trim() : null;
  };
}
