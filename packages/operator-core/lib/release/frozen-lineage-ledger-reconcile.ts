/**
 * P-027 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 — D-014): the frozen
 * lineage has TWO stores and they must agree.
 *
 *   1. `refs/papercusp/frozen/<candidate>` — the gate-owned ref, advanced by compare-and-swap
 *      in `admitPathsOntoRepairHead` (P-001). Every commit on it beyond the candidate is one
 *      admission, and the commit itself carries everything the ledger row says about it: its
 *      parent (`fromRepairHead`), its committer time, the paths it changed (`diff-tree`), the
 *      blobs it admitted (`ls-tree`) and, in its message trailers, the actor / source / reason.
 *   2. `routines.metadata.repair_queue.admissions[]` + `repairHead` — the queue row the gate
 *      decides from and the tools render.
 *
 * Until D-014 the row could silently fall BEHIND the ref: a green-checkpoint run reads the
 * queue once, runs a suite for up to an hour, then writes its in-memory copy back — and an
 * admission that landed in between (ref advanced, row advanced) was overwritten by the stale
 * copy (measured 2026-09-05 17:41Z: e4327abf on the ref, row still at f2b87953, admissions=2
 * for 3 lineage commits; the gate then judged a head the lineage had already moved past).
 * The write side is fixed by the CAS in `writeFrozenCandidateRepairQueue`; THIS module is the
 * read side: given a queue row and the repository, rebuild the ledger entries for every
 * lineage commit the row does not know, DERIVED from the commits (rung 1 of the derived-truth
 * ladder — never from a memory of what was admitted), and advance `repairHead` to the ref.
 *
 * What it will NOT do: guess. A ref that is BEHIND the row (someone reset it), a ref whose
 * history does not contain the row's repairHead, or a commit on the gate's ref that was not
 * written by the admit door (no parseable trailers, more than one parent, an empty diff) is
 * reported by status and the row is returned untouched — those are defects to surface, and
 * laundering them into the ledger would hide exactly the disagreement this exists to expose.
 */
import type { FrozenCandidateRepairQueue, FrozenRepairAdmission } from './frozen-candidate-repair-queue';
import { markFrozenRepairAdmitted } from './frozen-candidate-repair-queue';
import { frozenLineageRef, realAdmissionGit, type AdmissionGitRunner } from './repair-head-admission';

const SHA_RE = /^[0-9a-f]{40,64}$/;

/** The trailers `buildAdmissionMessage` (repair-head-admission.ts) writes on every admission commit. */
export interface ParsedAdmissionCommitMessage {
  candidate: string;
  /** The head the admission was built onto — must equal the commit's sole parent. */
  repairHead: string;
  source: { ref: string; sha: string };
  actor: string;
  reason?: string;
  /** The ALLOWLIST the caller named (changed ∪ unchanged) — the commit's diff-tree says which changed. */
  paths: string[];
}

/**
 * PURE. Parse an admission commit message. Returns null for anything the admit door would not
 * have written: a missing trailer, a malformed sha, no `paths:` block. Tolerant only of
 * whitespace and trailing blank lines — a foreign commit on the gate's ref must read as foreign.
 */
export function parseAdmissionCommitMessage(body: string): ParsedAdmissionCommitMessage | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const fields: Record<string, string> = {};
  const paths: string[] = [];
  let inPaths = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (inPaths) {
      if (line.startsWith('- ')) {
        const p = line.slice(2).trim();
        if (p) paths.push(p);
        continue;
      }
      if (line.trim() === '') continue;
      // Anything else after the paths block is not the admit door's message.
      return null;
    }
    if (line === 'paths:') {
      inPaths = true;
      continue;
    }
    const m = /^(candidate|repairHead|source|actor|reason):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
  }
  if (!inPaths || paths.length === 0) return null;
  if (!SHA_RE.test(fields.candidate ?? '') || !SHA_RE.test(fields.repairHead ?? '')) return null;
  if (!fields.actor) return null;
  const at = (fields.source ?? '').lastIndexOf('@');
  if (at <= 0) return null;
  const sourceRef = fields.source.slice(0, at);
  const sourceSha = fields.source.slice(at + 1);
  if (!sourceRef || !SHA_RE.test(sourceSha)) return null;
  return {
    candidate: fields.candidate,
    repairHead: fields.repairHead,
    source: { ref: sourceRef, sha: sourceSha },
    actor: fields.actor,
    ...(fields.reason ? { reason: fields.reason } : {}),
    paths: [...new Set(paths)].sort(),
  };
}

export type LineageLedgerReconcileStatus =
  /** The ref is at the row's repairHead (or absent while the row is still at the candidate). */
  | 'in-sync'
  /** Entries were rebuilt for every lineage commit beyond the row's repairHead; `queue` carries them. */
  | 'reconciled'
  /** No lineage ref exists although the row's repairHead is not the candidate — the row is ahead of git. */
  | 'ref-absent'
  /** The ref points INSIDE the row's history (it was reset/retracted below the row). Not repaired here. */
  | 'ref-behind-row'
  /** The row's repairHead is not on the ref's history at all. Not repaired here. */
  | 'lineage-diverged'
  /** A commit on the ref was not written by the admit door (no trailers / merge / empty diff). Not repaired. */
  | 'commit-unreadable'
  /** git itself failed; nothing can be concluded. */
  | 'git-failed';

export interface LineageLedgerReconcileResult {
  status: LineageLedgerReconcileStatus;
  /** The row after reconciliation — the INPUT object itself unless status is `reconciled`. */
  queue: FrozenCandidateRepairQueue;
  refHead: string | null;
  /** Entries rebuilt from commits, oldest first (empty unless `reconciled`). */
  reconciled: FrozenRepairAdmission[];
  /** One human line — what was found, and for a refusal, exactly why nothing was changed. */
  detail: string;
}

export interface ReconcileLineageLedgerInput {
  /** Repository root holding the lineage ref (the shared integration checkout). */
  root: string;
  git?: AdmissionGitRunner;
}

/**
 * Reconcile a queue row against its lineage ref. PURE with respect to the row — the caller
 * persists the returned queue (through the CAS transition, so a concurrent writer is never
 * overwritten). Synchronous git plumbing only.
 */
export function reconcileFrozenRepairQueueWithLineageRef(
  queue: FrozenCandidateRepairQueue,
  input: ReconcileLineageLedgerInput,
): LineageLedgerReconcileResult {
  const git = input.git ?? realAdmissionGit;
  const run = (argv: readonly string[]) => git(argv, { cwd: input.root });
  const untouched = (status: LineageLedgerReconcileStatus, refHead: string | null, detail: string): LineageLedgerReconcileResult => ({
    status,
    queue,
    refHead,
    reconciled: [],
    detail,
  });

  const ref = frozenLineageRef(queue.candidate);
  const rp = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (rp.status !== 0) {
    if (queue.repairHead === queue.candidate) {
      return untouched('in-sync', null, `${ref} is absent and the row is still at the candidate — no admission yet`);
    }
    return untouched(
      'ref-absent',
      null,
      `${ref} is absent but the row's repairHead ${queue.repairHead.slice(0, 12)} is not the candidate — the row is ahead of git`,
    );
  }
  const refHead = rp.stdout.trim();
  if (refHead === queue.repairHead) return untouched('in-sync', refHead, `${ref} is at the row's repairHead ${refHead.slice(0, 12)}`);

  // Is the row's head on the ref's history? `merge-base --is-ancestor` exits 0/1 for yes/no and
  // anything else for a git fault — the three cases must not be conflated.
  const rowOnRef = run(['merge-base', '--is-ancestor', queue.repairHead, refHead]);
  if (rowOnRef.status !== 0) {
    if (rowOnRef.status !== 1) {
      return untouched('git-failed', refHead, `merge-base --is-ancestor failed: ${(rowOnRef.stderr || rowOnRef.stdout).trim().slice(0, 200)}`);
    }
    const refInRow = run(['merge-base', '--is-ancestor', refHead, queue.repairHead]);
    if (refInRow.status === 0) {
      return untouched(
        'ref-behind-row',
        refHead,
        `${ref} is at ${refHead.slice(0, 12)}, an ANCESTOR of the row's repairHead ${queue.repairHead.slice(0, 12)} — the ref was reset below the row; not repaired here`,
      );
    }
    if (refInRow.status !== 1) {
      return untouched('git-failed', refHead, `merge-base --is-ancestor failed: ${(refInRow.stderr || refInRow.stdout).trim().slice(0, 200)}`);
    }
    return untouched(
      'lineage-diverged',
      refHead,
      `the row's repairHead ${queue.repairHead.slice(0, 12)} is not on ${ref} (${refHead.slice(0, 12)}) and the ref is not on the row — two lineages; not repaired here`,
    );
  }

  const list = run(['rev-list', '--reverse', '--first-parent', `${queue.repairHead}..${refHead}`]);
  if (list.status !== 0) {
    return untouched('git-failed', refHead, `rev-list failed: ${(list.stderr || list.stdout).trim().slice(0, 200)}`);
  }
  const commits = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (commits.length === 0) return untouched('in-sync', refHead, `no lineage commits beyond the row's repairHead`);

  let next = queue;
  const rebuilt: FrozenRepairAdmission[] = [];
  let expectedParent = queue.repairHead;
  for (const sha of commits) {
    const meta = run(['show', '-s', '--format=%P%n%ct', sha]);
    if (meta.status !== 0) return untouched('git-failed', refHead, `show ${sha.slice(0, 12)} failed`);
    const [parentsLine = '', ctLine = ''] = meta.stdout.split('\n');
    const parents = parentsLine.trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 1) {
      return untouched(
        'commit-unreadable',
        refHead,
        `${sha.slice(0, 12)} on ${ref} has ${parents.length} parents — the admit door writes exactly one; not repaired`,
      );
    }
    if (parents[0] !== expectedParent) {
      return untouched(
        'commit-unreadable',
        refHead,
        `${sha.slice(0, 12)} on ${ref} is parented on ${parents[0].slice(0, 12)}, not the previous lineage head ${expectedParent.slice(0, 12)}; not repaired`,
      );
    }
    const committedAtSec = Number.parseInt(ctLine.trim(), 10);
    if (!Number.isFinite(committedAtSec) || committedAtSec <= 0) {
      return untouched('commit-unreadable', refHead, `${sha.slice(0, 12)} has no committer time`);
    }
    const body = run(['show', '-s', '--format=%B', sha]);
    if (body.status !== 0) return untouched('git-failed', refHead, `show -s --format=%B ${sha.slice(0, 12)} failed`);
    const parsed = parseAdmissionCommitMessage(body.stdout);
    if (!parsed) {
      return untouched(
        'commit-unreadable',
        refHead,
        `${sha.slice(0, 12)} on ${ref} carries no admit-door trailers (a foreign commit on the gate's ref); not repaired`,
      );
    }
    if (parsed.candidate !== queue.candidate || parsed.repairHead !== expectedParent) {
      return untouched(
        'commit-unreadable',
        refHead,
        `${sha.slice(0, 12)} trailers name candidate ${parsed.candidate.slice(0, 12)} / repairHead ${parsed.repairHead.slice(0, 12)} but the lineage is ${queue.candidate.slice(0, 12)} / ${expectedParent.slice(0, 12)}; not repaired`,
      );
    }
    const diff = run(['diff-tree', '-r', '--name-only', '--no-commit-id', expectedParent, sha]);
    if (diff.status !== 0) return untouched('git-failed', refHead, `diff-tree ${sha.slice(0, 12)} failed`);
    const changed = [...new Set(diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort();
    if (changed.length === 0) {
      return untouched('commit-unreadable', refHead, `${sha.slice(0, 12)} on ${ref} changes nothing — not an admission; not repaired`);
    }
    const changedSet = new Set(changed);
    const unchanged = parsed.paths.filter((p) => !changedSet.has(p)).sort();
    const blobs: Record<string, string | null> = {};
    for (const p of changed) blobs[p] = null;
    const ls = run(['ls-tree', '-r', '-z', sha, '--', ...changed]);
    if (ls.status !== 0) return untouched('git-failed', refHead, `ls-tree ${sha.slice(0, 12)} failed`);
    for (const entry of ls.stdout.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, , objectSha] = entry.slice(0, tab).split(/\s+/);
      const path = entry.slice(tab + 1);
      if (objectSha && changedSet.has(path)) blobs[path] = objectSha;
    }
    const entry: FrozenRepairAdmission = {
      atMs: committedAtSec * 1000,
      actor: parsed.actor,
      source: parsed.source,
      fromRepairHead: expectedParent,
      toRepairHead: sha,
      paths: changed,
      unchanged,
      blobs,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      provenance: 'reconciled-from-ref',
    };
    next = markFrozenRepairAdmitted(next, entry);
    rebuilt.push(entry);
    expectedParent = sha;
  }
  return {
    status: 'reconciled',
    queue: next,
    refHead,
    reconciled: rebuilt,
    detail:
      `rebuilt ${rebuilt.length} ledger entr${rebuilt.length === 1 ? 'y' : 'ies'} from ${ref} ` +
      `(${queue.repairHead.slice(0, 12)} → ${refHead.slice(0, 12)}): ${rebuilt
        .map((e) => `${e.toRepairHead.slice(0, 12)} ${e.paths.length} path(s) by ${e.actor}`)
        .join('; ')}`,
  };
}

/** How many ledger rows a queue carries that were rebuilt from the ref rather than written by the door. */
export function countReconciledAdmissions(queue: FrozenCandidateRepairQueue | null): number {
  return (queue?.admissions ?? []).filter((a) => a.provenance === 'reconciled-from-ref').length;
}
