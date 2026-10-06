/**
 * P-001 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 — D-002, D-006, D-010):
 * the ONE door through which a fix enters a frozen candidate's judged lineage.
 *
 * An ADMISSION is a plumbing commit on top of the queue's current `repairHead` whose tree is
 * repairHead's tree with EXACTLY the named paths replaced by the named source's entries —
 * a deletion when the path is absent at the source, the gitlink at the source pin for a
 * submodule path. It is built with `read-tree` / `update-index --cacheinfo` / `write-tree` /
 * `commit-tree -p repairHead` in a scratch index (the shared checkout's working tree and
 * real index are never touched), and it is PROVED before it is published: `diff-tree
 * --name-only repairHead..new` must be a non-empty SUBSET of the allowlist, or the commit
 * is left unreferenced and the call refuses. The published lineage lives on the gate-owned
 * ref `refs/papercusp/frozen/<candidate>`, advanced by compare-and-swap so two admissions
 * cannot race, and every admission is returned as a ledger entry for the queue row.
 *
 * Nothing here reads the integration branch by name, fast-forwards, or merges. The only
 * inputs are a repairHead, a source commit and a path list. Under D-010 the source is the
 * shared checkout's `staging` (the agent fixed there; git-sync committed it) — there is one
 * route — but the primitive is source-agnostic: any commit in the same object store works,
 * which is what lets P-020 admit a synthesized hunk-exact blob through the same door.
 *
 * WHY a subset and not set-equality (the Aug-27 D-002 wording said "equals"): the STRAY
 * direction is the only unsafe one. An allowlisted path whose source entry already equals
 * repairHead's is reported under `unchanged` and the admission is idempotent; refusing it
 * would make a re-run after a partial failure impossible. A diff naming a path OUTSIDE the
 * allowlist is refused, always — that is the invariant the stray-file control in the test
 * file falsifies.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenRepairAdmission } from './frozen-candidate-repair-queue';
import { ADMISSION_GIT_DATE } from './admission-commit-date';

export const FROZEN_LINEAGE_REF_PREFIX = 'refs/papercusp/frozen/';

/** The identity every admission commit carries. It is the gate's, never the agent's: the
 * agent is recorded in the ledger entry and the commit message, where attribution belongs. */
export const ADMISSION_GIT_IDENTITY = Object.freeze({
  name: 'Papercusp Green Checkpoint',
  email: 'green-checkpoint@papercusp.local',
});

/** Fixed commit dates keep a preview's plumbing commit identical to the confirmed commit.
 *  Defined in the leaf module `admission-commit-date` and re-exported here, unchanged, for every
 *  existing importer: the pure gate-health readers need to RECOGNISE this date (it is a sentinel,
 *  not a measurement) and cannot import this module, which pulls in node builtins. */
export { ADMISSION_GIT_DATE };

const SHA_RE = /^[0-9a-f]{40,64}$/;

/** The gate-owned ref that carries a frozen candidate's judged lineage. */
export function frozenLineageRef(candidate: string): string {
  if (!SHA_RE.test(candidate)) {
    throw new Error(`frozenLineageRef: candidate must be a full sha, got ${JSON.stringify(candidate)}`);
  }
  return `${FROZEN_LINEAGE_REF_PREFIX}${candidate}`;
}

export interface AdmissionGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Every git call goes through one runner so a test can observe or sabotage a step. */
export type AdmissionGitRunner = (
  argv: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
) => AdmissionGitResult;

export const realAdmissionGit: AdmissionGitRunner = (argv, opts) => {
  const r = spawnSync('git', [...argv], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export type AdmissionEntryKind = 'blob' | 'symlink' | 'gitlink' | 'absent';

export interface AdmissionTreeEntry {
  path: string;
  kind: AdmissionEntryKind;
  /** Octal mode string as `ls-tree` prints it (100644 / 100755 / 120000 / 160000), null when absent. */
  mode: string | null;
  sha: string | null;
}

export type AdmissionRefusalCode =
  | 'invalid-paths'
  | 'repair-head-unresolvable'
  | 'source-unresolvable'
  | 'path-not-found'
  | 'path-under-gitlink'
  | 'nothing-to-admit'
  | 'stray-paths'
  | 'admission-incomplete'
  | 'lineage-ref-moved'
  | 'git-failed';

/**
 * P-004 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): one dependency an admitted
 * file makes that resolves to NOTHING at the proved admission commit. This includes imports and
 * detected runtime data reads. The fix for the caller is always the same — admit `wanted` too —
 * and never "widen to the tip".
 */
export interface AdmissionMissingImport {
  /** The admitted file whose dependency cannot be resolved at the admission commit. */
  from: string;
  /** The specifier or data filename exactly as written in `from`. */
  specifier: string;
  /** The repo-relative path the caller should admit — the candidate that exists on `probeRef` when one does, else the first candidate tried. */
  wanted: string;
  /** Every repo-relative candidate probed at the admission commit, in probe order. */
  tried: string[];
  /** Whether `wanted` exists on the probe ref (the shared staging tip): `present` means admitting it closes the gap. */
  atProbeRef: 'present' | 'absent' | 'unknown';
  /** A same-source cohort member or runtime data dependency required by a whole-blob admission. */
  relation?: 'reverse-importer' | 'imported-module' | 'runtime-data';
}

/**
 * What a `preflight` hook returns to stop an admission: the proved commit stays unpublished
 * garbage. `git-failed` is the instrument failing (the check could not run) — the door fails
 * CLOSED, because "could not verify" is not "verified".
 */
export type AdmissionPreflightRefusal =
  | { code: 'admission-incomplete'; detail: string; missing: AdmissionMissingImport[] }
  | { code: 'git-failed'; step: string; detail: string };

export interface AdmissionRefusal {
  ok: false;
  code: AdmissionRefusalCode;
  detail: string;
  /** stray-paths: what the built commit touched OUTSIDE the allowlist. Never empty for that code. */
  stray?: string[];
  /** invalid-paths: the offending inputs, verbatim. */
  paths?: string[];
  /** git-failed: the plumbing step that failed. */
  step?: string;
  /** admission-incomplete: every unresolved import, with the path to admit. Never empty for that code. */
  missing?: AdmissionMissingImport[];
  /** admission-incomplete: the built-and-proved commit the preflight inspected (unpublished; ordinary garbage). */
  commit?: string;
}

export interface AdmissionSuccess {
  ok: true;
  commit: string;
  tree: string;
  /** The proved diff-tree name set — identical to `entry.paths`. */
  diff: string[];
  /** Allowlisted paths whose source entry already equalled repairHead's — identical to `entry.unchanged`. */
  unchanged: string[];
  lineageRef: string;
  /**
   * false on a dry run: the commit was built and PROVED but the lineage ref was not moved,
   * so `entry` describes what a confirmed call would record and must not be persisted.
   */
  published: boolean;
  entry: FrozenRepairAdmission;
}

export type AdmissionOutcome = AdmissionSuccess | AdmissionRefusal;

/**
 * Repo-relative, forward-slash, no `.`/`..` segments, no leading slash, no trailing slash.
 * Returns null for anything that does not normalize to that shape — the caller refuses the
 * whole call rather than admitting a best guess.
 */
export function normalizeAdmissionPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || p.includes('\\') || p.includes('\0')) return null;
  if (p.startsWith('/')) return null;
  p = p.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

export function validateAdmissionPaths(
  paths: readonly string[],
): { ok: true; paths: string[] } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const out = new Set<string>();
  for (const raw of paths) {
    const p = normalizeAdmissionPath(raw);
    if (p === null) invalid.push(String(raw));
    else out.add(p);
  }
  if (invalid.length > 0) return { ok: false, invalid };
  if (out.size === 0) return { ok: false, invalid: [] };
  return { ok: true, paths: [...out].sort() };
}

/**
 * The proof. Pure so it can be tested without a repository and so the stray-file control
 * in the test file can falsify exactly this rule: every path the built commit changed must
 * be in the allowlist; an allowlisted path the commit did not change is `unchanged`.
 */
export function proveAdmissionDiff(input: {
  diff: readonly string[];
  allowlist: readonly string[];
}): { ok: true; admitted: string[]; unchanged: string[] } | { ok: false; stray: string[] } {
  const allow = new Set(input.allowlist);
  const stray = [...new Set(input.diff.filter((p) => !allow.has(p)))].sort();
  if (stray.length > 0) return { ok: false, stray };
  const admitted = [...new Set(input.diff)].sort();
  const changed = new Set(admitted);
  const unchanged = input.allowlist.filter((p) => !changed.has(p)).sort();
  return { ok: true, admitted, unchanged };
}

/**
 * `ls-tree <superproject> -- <path-inside-submodule>` returns no entry: gitlinks are commit
 * pointers, not trees the superproject can walk. Walk up from `path` to the nearest enclosing
 * gitlink at `commit`, so an absent leaf is never mistaken for a file absent from the tree.
 * Returns `entry: null` when no ancestor is a gitlink. Shared by path-exact admission (which
 * refuses `path-under-gitlink`) and hunk-exact admission (WI-10005976: it replayed a submodule
 * file's hunks onto an empty base and misreported a `hunk-conflict`).
 */
export function findGitlinkAncestor(
  run: (argv: readonly string[]) => AdmissionGitResult,
  commit: string,
  path: string,
): { ok: true; entry: AdmissionTreeEntry | null } | { ok: false; step: string; result: AdmissionGitResult } {
  const parts = path.split('/');
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const ancestor = parts.slice(0, length).join('/');
    const step = `ls-tree ${commit.slice(0, 12)} -- ${ancestor}`;
    const r = run(['ls-tree', '-z', commit, '--', ancestor]);
    if (r.status !== 0) return { ok: false, step, result: r };
    const line = r.stdout.split('\0').find((candidate) => candidate.endsWith(`\t${ancestor}`));
    if (!line) continue;
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(.*)$/.exec(line);
    if (!m) return { ok: false, step, result: { ...r, stderr: `unparseable entry ${JSON.stringify(line)}` } };
    if (m[2] === 'commit') return { ok: true, entry: { path: ancestor, kind: 'gitlink', mode: m[1]!, sha: m[3]! } };
    if (m[2] !== 'tree') return { ok: true, entry: null };
  }
  return { ok: true, entry: null };
}

function buildAdmissionMessage(input: {
  candidate: string;
  repairHead: string;
  sourceRef: string;
  sourceSha: string;
  actor: string;
  reason?: string;
  paths: readonly string[];
}): string {
  const lines = [
    `admit ${input.paths.length} path(s) onto frozen lineage ${input.candidate.slice(0, 12)}`,
    '',
    `candidate: ${input.candidate}`,
    `repairHead: ${input.repairHead}`,
    `source: ${input.sourceRef}@${input.sourceSha}`,
    `actor: ${input.actor}`,
    ...(input.reason ? [`reason: ${input.reason.replace(/\s+/g, ' ').trim()}`] : []),
    'paths:',
    ...input.paths.map((p) => `- ${p}`),
  ];
  return lines.join('\n') + '\n';
}

export interface AdmitPathsInput {
  /** Repository root that holds BOTH repairHead and the source commit (they share the object store). */
  root: string;
  /** The immutable frozen candidate — names the lineage ref. */
  candidate: string;
  /** The queue's current repairHead: the parent of the admission commit. */
  repairHead: string;
  /** Repo-relative paths to admit. Refused when empty or malformed. */
  paths: readonly string[];
  /** The commit (any ref/sha in `root`) whose entries for `paths` are admitted. */
  source: {
    ref: string;
    /**
     * Stable provenance label used in the admission message/ledger while `ref` supplies the
     * immutable object read. This keeps a reviewed staging preview byte-identical after the
     * branch advances: `ref:<reviewed SHA>, recordAsRef:'staging'` reads the SHA but records the
     * same source identity as the original staging preview.
     */
    recordAsRef?: string;
  };
  /** Who admits — recorded in the ledger entry and the commit message. */
  actor: string;
  reason?: string;
  nowMs: number;
  git?: AdmissionGitRunner;
  /**
   * Build and PROVE the admission commit but do not publish it: the lineage ref is left where
   * it is and the returned `entry` is a preview. The unreferenced commit is ordinary garbage
   * for git to collect. A dry run still refuses everything a real run refuses — including a
   * lineage ref that has moved — so its verdict is exactly the verdict confirm would get.
   */
  dryRun?: boolean;
  /**
   * P-004 completeness preflight. Runs on the built and PROVED admission commit, after the
   * diff-tree and parent proofs and BEFORE the lineage ref moves — on a dry run too, so the
   * preview carries the same verdict confirm would get. Return null to accept; return a
   * refusal to stop the admission (`admission-incomplete`: the commit is never published and
   * repairHead does not move). The hook sees exactly what would be published: the commit, its
   * tree and the proved name set. It is the admit door's, not the primitive's, choice of check
   * (`checkAdmissionImportCompleteness` in admission-import-completeness.ts is the one wired).
   */
  preflight?: (built: {
    commit: string;
    tree: string;
    admitted: readonly string[];
    /** The exact source object and parent used to build this proved commit. */
    sourceCommit: string;
    repairHead: string;
  }) => AdmissionPreflightRefusal | null;
}

/**
 * Build, prove and publish one admission. Synchronous on purpose: every step is a cheap
 * plumbing call, the caller is a tool handler or the gate, and a sync sequence cannot be
 * interleaved with a second admission in the same process.
 */
export function admitPathsOntoRepairHead(input: AdmitPathsInput): AdmissionOutcome {
  const git = input.git ?? realAdmissionGit;
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) {
    throw new Error('admitPathsOntoRepairHead: nowMs must be a positive timestamp');
  }
  if (typeof input.actor !== 'string' || !input.actor.trim()) {
    throw new Error('admitPathsOntoRepairHead: actor must be non-empty');
  }
  const validated = validateAdmissionPaths(input.paths);
  if (!validated.ok) {
    return {
      ok: false,
      code: 'invalid-paths',
      detail:
        validated.invalid.length === 0
          ? 'no paths were named; an admission is by explicit path allowlist'
          : `not repo-relative normal paths: ${validated.invalid.map((p) => JSON.stringify(p)).join(', ')}`,
      paths: validated.invalid,
    };
  }
  const allowlist = validated.paths;

  const run = (argv: readonly string[], env?: NodeJS.ProcessEnv): AdmissionGitResult =>
    git(argv, { cwd: input.root, env: env ? { ...process.env, ...env } : undefined });
  const revParse = (ref: string): string | null => {
    const r = run(['rev-parse', '--verify', '--quiet', ref]);
    const out = r.stdout.trim();
    return r.status === 0 && SHA_RE.test(out) ? out : null;
  };
  const gitFailed = (step: string, r: AdmissionGitResult): AdmissionRefusal => ({
    ok: false,
    code: 'git-failed',
    step,
    detail: `${step} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
  });

  const repairHeadSha = revParse(`${input.repairHead}^{commit}`);
  if (!repairHeadSha) {
    return {
      ok: false,
      code: 'repair-head-unresolvable',
      detail: `repairHead ${input.repairHead} does not resolve to a commit in ${input.root}`,
    };
  }
  const repairHeadTree = revParse(`${repairHeadSha}^{tree}`);
  if (!repairHeadTree) return gitFailed('rev-parse repairHead^{tree}', run(['rev-parse', `${repairHeadSha}^{tree}`]));
  const sourceSha = revParse(`${input.source.ref}^{commit}`);
  if (!sourceSha) {
    return {
      ok: false,
      code: 'source-unresolvable',
      detail: `source ${JSON.stringify(input.source.ref)} does not resolve to a commit in ${input.root}`,
    };
  }
  const recordedSourceRef = input.source.recordAsRef ?? input.source.ref;

  const lsTree = (
    commit: string,
    path: string,
  ): { ok: true; entry: AdmissionTreeEntry } | { ok: false; refusal: AdmissionRefusal } => {
    const r = run(['ls-tree', '-z', commit, '--', path]);
    if (r.status !== 0) return { ok: false, refusal: gitFailed(`ls-tree ${commit.slice(0, 12)} -- ${path}`, r) };
    const line = r.stdout.split('\0').find((l) => l.endsWith(`\t${path}`));
    if (!line) return { ok: true, entry: { path, kind: 'absent', mode: null, sha: null } };
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(.*)$/.exec(line);
    if (!m) {
      return {
        ok: false,
        refusal: gitFailed(`ls-tree ${commit.slice(0, 12)} -- ${path}`, {
          ...r,
          stderr: `unparseable entry ${JSON.stringify(line)}`,
        }),
      };
    }
    if (m[2] === 'tree') {
      return {
        ok: false,
        refusal: {
          ok: false,
          code: 'invalid-paths',
          detail: `${path} is a directory at ${commit.slice(0, 12)}; admit the files inside it by name`,
          paths: [path],
        },
      };
    }
    const kind: AdmissionEntryKind = m[2] === 'commit' ? 'gitlink' : m[1] === '120000' ? 'symlink' : 'blob';
    return { ok: true, entry: { path, kind, mode: m[1], sha: m[3] } };
  };

  const gitlinkAncestor = (
    commit: string,
    path: string,
  ): { ok: true; entry: AdmissionTreeEntry | null } | { ok: false; refusal: AdmissionRefusal } => {
    const found = findGitlinkAncestor(run, commit, path);
    return found.ok ? found : { ok: false, refusal: gitFailed(found.step, found.result) };
  };

  const atSource = new Map<string, AdmissionTreeEntry>();
  const atHead = new Map<string, AdmissionTreeEntry>();
  for (const path of allowlist) {
    const s = lsTree(sourceSha, path);
    if (!s.ok) return s.refusal;
    const h = lsTree(repairHeadSha, path);
    if (!h.ok) return h.refusal;
    const c = lsTree(input.candidate, path);
    if (!c.ok) return c.refusal;
    const candidateGitlink = gitlinkAncestor(input.candidate, path);
    if (!candidateGitlink.ok) return candidateGitlink.refusal;
    const sourceGitlink = gitlinkAncestor(sourceSha, path);
    if (!sourceGitlink.ok) return sourceGitlink.refusal;
    const headGitlink = gitlinkAncestor(repairHeadSha, path);
    if (!headGitlink.ok) return headGitlink.refusal;
    if (candidateGitlink.entry || sourceGitlink.entry || headGitlink.entry) {
      const describe = (entry: AdmissionTreeEntry | null) =>
        entry ? `${entry.path}@${entry.sha}` : '(no gitlink ancestor)';
      const ancestorPaths = [candidateGitlink.entry, sourceGitlink.entry, headGitlink.entry]
        .filter((entry): entry is AdmissionTreeEntry => entry !== null)
        .map((entry) => entry.path);
      const suggestedGitlinks = [...new Set(ancestorPaths)].sort();
      return {
        ok: false,
        code: 'path-under-gitlink',
        detail:
          `${path} is inside submodule gitlink(s); the superproject cannot admit an inner path. ` +
          `Gitlink commits: candidate ${describe(candidateGitlink.entry)}, ` +
          `source ${describe(sourceGitlink.entry)}, repairHead ${describe(headGitlink.entry)}. ` +
          `If the whole submodule pointer is intended, retry with paths: [${suggestedGitlinks.map((p) => JSON.stringify(p)).join(', ')}].`,
      };
    }
    atSource.set(path, s.entry);
    atHead.set(path, h.entry);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'papercusp-admit-'));
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const rt = run(['read-tree', repairHeadSha], indexEnv);
    if (rt.status !== 0) return gitFailed('read-tree', rt);
    for (const path of allowlist) {
      const s = atSource.get(path)!;
      const h = atHead.get(path)!;
      if (s.kind === 'absent') {
        if (h.kind === 'absent') {
          // An absent path on both sides is a valid already-reflected deletion only when the
          // frozen candidate proves the path existed. Otherwise a typo would become a false-green.
          const c = lsTree(input.candidate, path);
          if (!c.ok) return c.refusal;
          if (c.entry.kind === 'absent') {
            return {
              ok: false,
              code: 'path-not-found',
              detail:
                `${path} is absent from source ${JSON.stringify(input.source.ref)}, repairHead ` +
                `${repairHeadSha.slice(0, 12)}, and frozen candidate ${input.candidate.slice(0, 12)}`,
            };
          }
          continue;
        }
        const rm = run(['update-index', '--force-remove', '--', path], indexEnv);
        if (rm.status !== 0) return gitFailed(`update-index --force-remove ${path}`, rm);
        continue;
      }
      const ui = run(['update-index', '--add', '--replace', '--cacheinfo', `${s.mode},${s.sha},${path}`], indexEnv);
      if (ui.status !== 0) return gitFailed(`update-index --cacheinfo ${path}`, ui);
    }
    const wt = run(['write-tree'], indexEnv);
    const tree = wt.stdout.trim();
    if (wt.status !== 0 || !SHA_RE.test(tree)) return gitFailed('write-tree', wt);
    if (tree === repairHeadTree) {
      return {
        ok: false,
        code: 'nothing-to-admit',
        detail:
          `every named path already has its ${input.source.ref} content on repairHead ` +
          `${repairHeadSha.slice(0, 12)} — nothing to admit (unchanged: ${allowlist.join(', ')})`,
      };
    }

    const message = buildAdmissionMessage({
      candidate: input.candidate,
      repairHead: repairHeadSha,
      sourceRef: recordedSourceRef,
      sourceSha,
      actor: input.actor,
      reason: input.reason,
      paths: allowlist,
    });
    const identityEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_AUTHOR_DATE: ADMISSION_GIT_DATE,
      GIT_COMMITTER_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_COMMITTER_DATE: ADMISSION_GIT_DATE,
    };
    const ct = run(['commit-tree', tree, '-p', repairHeadSha, '-m', message], identityEnv);
    const commit = ct.stdout.trim();
    if (ct.status !== 0 || !SHA_RE.test(commit)) return gitFailed('commit-tree', ct);

    // THE PROOF. Ask git what the commit actually changed, then hold it against the allowlist.
    // Everything above could be wrong (a mis-parsed mode, a runner that adds an extra entry,
    // a future edit to the loop) and this still refuses a stray path.
    const dt = run(['diff-tree', '-r', '--name-only', '--no-commit-id', '-z', repairHeadSha, commit]);
    if (dt.status !== 0) return gitFailed('diff-tree proof', dt);
    const diff = dt.stdout.split('\0').filter(Boolean);
    const proof = proveAdmissionDiff({ diff, allowlist });
    if (!proof.ok) {
      return {
        ok: false,
        code: 'stray-paths',
        stray: proof.stray,
        detail:
          `REFUSED: the built admission ${commit.slice(0, 12)} touches ${proof.stray.length} path(s) outside ` +
          `the allowlist (${proof.stray.join(', ')}); it was NOT published and repairHead did not move`,
      };
    }
    if (proof.admitted.length === 0) {
      return { ok: false, code: 'nothing-to-admit', detail: 'the proved diff is empty' };
    }
    const parent = revParse(`${commit}^`);
    if (parent !== repairHeadSha) {
      return gitFailed('parent proof', {
        status: 1,
        stdout: '',
        stderr: `parent ${parent} != repairHead ${repairHeadSha}`,
      });
    }

    // P-004 COMPLETENESS PREFLIGHT — on the proved commit, before anything is published. An
    // admission that lands a file whose import resolves to nothing at this commit would only be
    // caught a suite later by the gate's lint:tsc round; the door refuses it now and names the
    // path to admit, and it NEVER widens to the tip on the caller's behalf.
    if (input.preflight) {
      const stop = input.preflight({
        commit,
        tree,
        admitted: proof.admitted,
        sourceCommit: sourceSha,
        repairHead: repairHeadSha,
      });
      if (stop) {
        return stop.code === 'git-failed'
          ? { ok: false, code: 'git-failed', step: stop.step, detail: stop.detail, commit }
          : { ok: false, code: 'admission-incomplete', detail: stop.detail, missing: stop.missing, commit };
      }
    }

    // PUBLISH by compare-and-swap on the gate-owned lineage ref. The ref may not exist yet
    // (first admission on a queue) — creation asserts absence. If it exists it must equal the
    // repairHead the caller admitted onto; anything else means the lineage advanced under us.
    const lineageRef = frozenLineageRef(input.candidate);
    const current = revParse(lineageRef);
    if (current !== null && current !== repairHeadSha) {
      return {
        ok: false,
        code: 'lineage-ref-moved',
        detail:
          `${lineageRef} is at ${current.slice(0, 12)} but this admission was built onto ` +
          `${repairHeadSha.slice(0, 12)}: the lineage advanced under you — re-read the queue and admit ` +
          `onto its current repairHead`,
      };
    }
    const blobs: Record<string, string | null> = {};
    for (const path of allowlist) blobs[path] = atSource.get(path)!.sha;
    const entry: FrozenRepairAdmission = {
      atMs: input.nowMs,
      actor: input.actor.trim(),
      source: { ref: recordedSourceRef, sha: sourceSha },
      fromRepairHead: repairHeadSha,
      toRepairHead: commit,
      paths: proof.admitted,
      unchanged: proof.unchanged,
      blobs,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    if (input.dryRun === true) {
      return {
        ok: true,
        commit,
        tree,
        diff: proof.admitted,
        unchanged: proof.unchanged,
        lineageRef,
        published: false,
        entry,
      };
    }
    const ur = run([
      'update-ref',
      '-m',
      `admit ${proof.admitted.length} path(s) by ${input.actor}`,
      lineageRef,
      commit,
      current ?? '0'.repeat(repairHeadSha.length),
    ]);
    if (ur.status !== 0) {
      return {
        ok: false,
        code: 'lineage-ref-moved',
        detail: `update-ref ${lineageRef} refused (${(ur.stderr || ur.stdout).trim().slice(0, 300)}) — a concurrent admission won; re-read the queue and retry`,
      };
    }

    return {
      ok: true,
      commit,
      tree,
      diff: proof.admitted,
      unchanged: proof.unchanged,
      lineageRef,
      published: true,
      entry,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Un-publish an admission whose queue-row write failed AFTER the lineage ref moved. The ref
 * and the row are two stores; this is the compensating step that keeps them in agreement, and
 * it is exact: a compare-and-swap from the published commit back to the head it was built on,
 * so it can never retract anything but the admission it is handed. Returns false when the ref
 * is no longer at the published commit (a later admission already built on it), in which case
 * nothing is touched and the caller must report the disagreement rather than hide it.
 */
export function retractAdmission(input: {
  root: string;
  candidate: string;
  published: string;
  previousRepairHead: string;
  git?: AdmissionGitRunner;
}): boolean {
  const git = input.git ?? realAdmissionGit;
  const lineageRef = frozenLineageRef(input.candidate);
  const r = git(
    [
      'update-ref',
      '-m',
      `retract admission ${input.published.slice(0, 12)} (queue row write failed)`,
      lineageRef,
      input.previousRepairHead,
      input.published,
    ],
    { cwd: input.root },
  );
  return r.status === 0;
}
