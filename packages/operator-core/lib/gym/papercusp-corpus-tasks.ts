/**
 * Turn the validated real corpus into gym tasks, inside a real pinned checkout.
 *
 * This is the seam that replaces `fixedTasks()` — the 4-line stub service the
 * gym used to optimize against (D-004: "IT SHOULD BE PUTTING THE REAL PAPERCUSP
 * APP THROUGH THE GYM"). Both call sites — autoloop-cycle and ab-run — go
 * through here so the substrate is materialised exactly once, one way.
 *
 * The corpus JSON is GENERATED, never hand-edited: scratchpad/gym-build-corpus.ts
 * feeds `buildDescriptorsFromProbe` from the probe's measured artifacts, and the
 * discrimination gate remains the only admission path (D-006).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPinnedSubstratePlan, type PapercuspTaskDescriptor } from './papercusp-substrate';
import { materialisePapercuspCorpus, type MaterialisedTask, type RunGit } from './papercusp-corpus-materialise';
import type { GitCommand } from './clone';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_JSON = join(HERE, 'corpus/papercusp-real-corpus.json');

export interface PapercuspCorpus {
  pinCommit: string;
  descriptors: PapercuspTaskDescriptor[];
}

/** Read the generated corpus. Throws rather than falling back to a toy corpus. */
export function loadPapercuspCorpus(path: string = CORPUS_JSON): PapercuspCorpus {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PapercuspCorpus>;
  if (!raw.pinCommit || !Array.isArray(raw.descriptors) || raw.descriptors.length === 0) {
    throw new Error(
      `papercusp corpus at ${path} is empty or malformed. Regenerate it with scratchpad/gym-build-corpus.ts; ` +
        `do NOT fall back to a synthetic corpus — a run that silently swaps in toy tasks while still reporting ` +
        `corpus:'real' is exactly the blindness P-011's fitness-signal-is-real gate exists to catch.`,
    );
  }
  return { pinCommit: raw.pinCommit, descriptors: raw.descriptors };
}

/**
 * Every `node_modules` directory in the source checkout, repo-root-relative.
 *
 * Enumerated, never hardcoded: the count tracks the workspace layout (136 on
 * this tree today). These are symlinked rather than installed — `npm install`
 * in the substrate would cost minutes per cycle and is what made a real-repo
 * task look unaffordable in the first place (D-003's false premise, corrected
 * by D-006's measurement).
 */
export function enumerateNodeModulesDirs(sourceRepo: string): string[] {
  const out = execFileSync(
    'find',
    ['.', '-name', 'node_modules', '-type', 'd', '-prune', '-not', '-path', './.git/*'],
    { cwd: sourceRepo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^\.\//, ''))
    .filter(Boolean);
}

/** Run one planned git command, returning trimmed stdout. */
export const execGitCommand: RunGit = async (cmd: GitCommand): Promise<string> =>
  execFileSync(cmd.argv[0]!, cmd.argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(cmd.env ? { env: { ...process.env, ...cmd.env } } : {}),
    ...(cmd.stdin === undefined ? {} : { input: cmd.stdin }),
  }).trim();

export interface MaterialiseSubstrateInput {
  /** The canonical Papercusp checkout to clone FROM. */
  sourceRepo: string;
  /**
   * Where to materialise it.
   *
   * ⚠ MUST be on the SAME FILESYSTEM as `sourceRepo`. The clone is `--local`,
   * which hardlinks the object store instead of copying ~9.9G — and hardlinks
   * cannot cross devices, so a `/tmp` dest fails with "Invalid cross-device
   * link". On this box /tmp is a separate NVMe from the workspace, so the
   * caller must NOT reuse its /tmp scratch dir for this.
   */
  destDir: string;
  corpus?: PapercuspCorpus;
}

export interface MaterialisedSubstrate {
  pinCommit: string;
  /** The commit carrying `.papercusp/*`, which every task commit is rooted at. */
  baseCommit: string;
  tasks: MaterialisedTask[];
}

/**
 * The gym's harness config, injected into the task world.
 *
 * These live HERE rather than at each call site because they must end up in a
 * COMMIT, not merely in the substrate's working tree — the runner clones from
 * the object store and never sees a working tree. Written to the checkout and
 * left uncommitted (as the toy-substrate code did, where `git add -A` happened
 * to sweep them up) they would silently vanish, the throwaway harness would
 * boot with NO blueprint, and `blueprint-run-action.ts`'s `codingFallback`
 * would route the gym onto the RETIRED `coding-factory` director→…→curator
 * spine — optimizing dead legacy code while still reporting corpus:'real'.
 */
export const GYM_HARNESS_FILES: ReadonlyArray<{ path: string; content: string }> = Object.freeze([
  {
    path: '.papercusp/config.json',
    // `workingStateCheck` is the L1 gate the worker chunk-loop runs per chunk.
    // Carried over verbatim from the toy substrate so this change swaps the
    // CORPUS and nothing else — but note it now costs what a real repo-wide
    // typecheck costs (~150s here) rather than the toy repo's instant one. A
    // misconfigured command degrades to "commit without the L1 gate" with a
    // warning (worker-chunk-loop.ts), so this is a cost knob, not a correctness
    // one; scoping it per-task is tracked separately.
    content: JSON.stringify({ worktrees: { enabled: false }, parallelWorkers: { workingStateCheck: 'npm run typecheck' } }),
  },
  {
    // Pin the substrate to the LIVE single-worker coding blueprint so the gym
    // optimizes the CURRENT `worker.md` prompt. `coding-solo` extends
    // `single-agent` (decider: `worker`) and carries the `gym: collectTrace:
    // git-diff` seam the ab-runner needs. The projection is keyed by
    // (workspace_id, harness_slug), so this fixed id never collides across the
    // per-run gymRunIdentity slugs.
    path: '.papercusp/blueprint.yaml',
    content: 'id: gym-substrate\nextends: coding-solo\nversion: 0.0.1\n',
  },
]);

/**
 * Clone the real repo at the corpus pin, symlink dependencies, and build one
 * commit per task whose tree carries the rewound implementation.
 */
export async function materialisePapercuspSubstrate(input: MaterialiseSubstrateInput): Promise<MaterialisedSubstrate> {
  const corpus = input.corpus ?? loadPapercuspCorpus();
  const plan = buildPinnedSubstratePlan({
    sourceRepo: input.sourceRepo,
    commit: corpus.pinCommit,
    destDir: input.destDir,
    nodeModulesDirs: enumerateNodeModulesDirs(input.sourceRepo),
  });

  for (const cmd of plan.commands) await execGitCommand(cmd);
  for (const { link, target } of plan.symlinks) {
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link);
  }

  const baseCommit = await commitHarnessConfig(input.destDir, corpus.pinCommit);
  const tasks = await materialisePapercuspCorpus(corpus.descriptors, input.destDir, execGitCommand, baseCommit);
  return { pinCommit: corpus.pinCommit, baseCommit, tasks };
}

/**
 * Commit `.papercusp/*` on top of the pin and return the new commit.
 *
 * `add -f` is required, not incidental: the real repo GITIGNORES these paths,
 * so a plain `add` silently no-ops and the commit would carry nothing — which
 * is the exact silent failure this function exists to prevent. Verified by
 * reading the resulting tree back rather than trusting the exit code.
 */
async function commitHarnessConfig(destDir: string, pinCommit: string): Promise<string> {
  for (const f of GYM_HARNESS_FILES) {
    const abs = join(destDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  const git = (...rest: string[]): GitCommand => ({
    argv: ['git', '-C', destDir, ...rest],
    env: {
      GIT_AUTHOR_NAME: 'papercusp-gym',
      GIT_AUTHOR_EMAIL: 'gym@papercusp.local',
      GIT_COMMITTER_NAME: 'papercusp-gym',
      GIT_COMMITTER_EMAIL: 'gym@papercusp.local',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  });

  // `--sparse` is as load-bearing as `-f`, and for a different wall: the substrate
  // is a CONE-MODE SPARSE CHECKOUT (buildPinnedSubstratePlan) and `.papercusp/` is
  // deliberately not in the cone, so without it the add fails with "paths ... exist
  // outside of your sparse-checkout definition" — `-f` only overrides gitignore,
  // never the sparse cone. First observed on the 2026-08-16 gym revive: this path
  // shipped 2026-08-02, after the loop was disabled, so its first live run was the
  // first time the two flags' walls were both standing.
  await execGitCommand(git('add', '--sparse', '-f', ...GYM_HARNESS_FILES.map((f) => f.path)));
  await execGitCommand(git('commit', '-q', '-m', 'gym: harness config (blueprint pin + L1 gate)'));
  const baseCommit = await execGitCommand(git('rev-parse', 'HEAD'));

  for (const f of GYM_HARNESS_FILES) {
    // Prove the file is in the COMMITTED TREE, not just on disk. A gitignore
    // rule, a stale index, or a future `add` without -f would otherwise leave
    // the gym booting blueprint-less and silently optimizing the retired spine.
    await execGitCommand(git('cat-file', '-e', `${baseCommit}:${f.path}`));
  }
  if (baseCommit === pinCommit) {
    throw new Error(`papercusp substrate: harness-config commit is identical to the pin — ${GYM_HARNESS_FILES.map((f) => f.path).join(', ')} did not land`);
  }
  return baseCommit;
}
