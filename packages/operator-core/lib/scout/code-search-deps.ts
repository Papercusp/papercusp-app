/**
 * A real `CodeSearchDeps` for the Scout prior-art probe, backed by `git grep`.
 *
 * `code-existence-probe` is deliberately pure and injectable so its logic is
 * testable without touching a repo. This module is the I/O half: the thing that
 * actually reaches the tree.
 *
 * ## The one correctness point that matters here
 *
 * **`git grep` exits 1 when it finds NOTHING.** That is a successful search with an
 * empty result, not a failure. Treating exit 1 as an error would report every
 * genuine miss as a probe outage; treating a REAL failure (exit >= 2 — bad repo,
 * bad flag, timeout) as an empty result would report an outage as "no prior art
 * exists". The second direction is the false negative the probe exists to prevent,
 * so the two are separated explicitly and neither is inferred from stdout being
 * empty.
 *
 * ## Injection safety
 *
 * Search terms come from idea PROSE, so they are untrusted. Every call goes through
 * `execFile`-style argv (never a shell string), and the term is passed after `-e`
 * with a terminating `--`, so a term beginning with `-` is a literal, not a flag.
 * `-F` keeps it a fixed string rather than a regex.
 */

import { execFileViaSidecar } from '../fleet/git-via-sidecar';
import type { CodeSearchDeps, SemanticPriorArtMatch } from './code-existence-probe';
import type { PlanRecord } from './plan-slug-leg';

/** Result of one process run. `code` is the exit status. */
export interface ExecOutcome {
  stdout: string;
  code: number;
}

/** Injectable process runner, so tests never shell out. */
export type ExecRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer: number },
) => Promise<ExecOutcome>;

export interface GitGrepOptions {
  /** Repo root to search. */
  cwd: string;
  /** Max file paths retained per term (default 50). */
  maxFiles?: number;
  /** Per-search timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Max stdout bytes before the runner aborts (default 8 MiB). */
  maxBuffer?: number;
  /** Extra non-evidence path patterns, on top of `NON_EVIDENCE_PATTERNS`. */
  extraNonEvidencePatterns?: RegExp[];
  /** Override the process runner (tests). */
  exec?: ExecRunner;
  /** Optional semantic leg, passed straight through to the probe. */
  searchSemantic?: (text: string) => Promise<SemanticPriorArtMatch[]>;
  /** Optional plan-slug leg, passed straight through to the probe. */
  searchPlans?: (text: string) => Promise<PlanRecord[]>;
}

const DEFAULTS = {
  maxFiles: 50,
  timeoutMs: 10_000,
  maxBuffer: 8 * 1024 * 1024,
} as const;

/** Exit codes above this are real failures; 1 is an honest "no matches". */
const GIT_GREP_NO_MATCH = 1;

/**
 * Paths whose contents are NOT evidence that a capability was implemented.
 *
 * Every entry was earned by a false positive on the real backlog, not guessed:
 *
 *  - **the screening module's own files** — the worst one, and self-inflicted.
 *    Documenting an idea id as an EXAMPLE inside this module makes the module
 *    report that idea as already-implemented. Measured: EI-7650 and EI-7652 were
 *    recommended DROP when the only two files citing them were
 *    `idea-cluster-screen.ts` and its test, written minutes earlier to document
 *    those very ids. A screen that manufactures its own evidence is worse than
 *    no screen, because the false positives look exactly like the true ones.
 *  - **agent memory dumps** (`.papercusp/memory/raw.md`) — WI-2497's only hit.
 *  - **scratchpad reports** — WI-2890's only hit was a month-old audit writeup.
 *  - **generated docs** (`public/internal/docs/**`, `llms-full.txt`) — one source
 *    doc fans out into several rendered copies, inflating file counts too.
 *  - **prose generally** (.md/.mdx/.html/.txt) — an idea DISCUSSED in a doc is
 *    not an idea BUILT. This is the distinction the whole leg turns on.
 *
 * ## ⚠ WHAT THIS FILTER CANNOT CATCH — read before trusting a lexical hit
 *
 * It filters by PATH, so it cannot see prose ABOUT a defect that lives inside a
 * genuine source file. That residue is not hypothetical and it is adversarial:
 * **the code that DISCUSSES a defect is very often exactly the code that FAILS to
 * handle it.**
 *
 * Worked case (su-b9269a31): a 19-item family about rubrics collapsing distinct
 * states into `unknown`. Grepping for that vocabulary returns plenty of matches in
 * `scorecards.ts` and `overwatch/scorecard-backstop.ts` — every one of them
 * describing the defect, none implementing a fix. A path filter admits all of it.
 *
 * The discriminator that survives is **"does an implementation exist"**, not "is
 * this discussed" — which is why a lexical hit is context for a reader and never
 * grounds for a verdict, and why a family like that belongs in INCONCLUSIVE rather
 * than DROP.
 */
/**
 * The screen's OWN module basenames — every file that participates in this
 * screening pass, and therefore every file whose citation of an idea id is an
 * EXAMPLE rather than an implementation.
 *
 * Exported and enumerated (rather than inlined into the regex below) so that a
 * recurrence guard can check it against the tree: adding a new leg file and
 * forgetting to list it here re-arms defect #3 in full — the new file documents
 * idea ids in its own comments, the self-id leg greps them, and the screen goes
 * back to manufacturing its own evidence. That is not hypothetical: `plan-slug-leg`
 * was added to this list only after the omission was caught.
 */
export const SCREEN_OWN_MODULES = [
  'code-existence-probe',
  'idea-cluster-screen',
  'code-search-deps',
  'plan-slug-leg',
  // The screen's own entrypoint. It documents WI-9476 and EI-19480829864185465
  // in its header, so without this exclusion the self-id leg greps those ids,
  // hits the screen's own source, and reports the screen as prior art for the
  // very ideas it is screening — defect #3 again. Caught by the guard below on
  // the day it was added, which is the second time that guard has paid for
  // itself (`plan-slug-leg` was the first).
  'screen-backlog',
] as const;

export const NON_EVIDENCE_PATTERNS: RegExp[] = [
  /(^|\/)scratchpad\//,
  /(^|\/)\.papercusp\//,
  /(^|\/)node_modules\//,
  /(^|\/)docs?\//,
  /\/public\/internal\//,
  /\.(md|mdx|html|txt|json|lock|snap)$/i,
  // This module screens ideas; its own citations of an idea id are examples,
  // never implementations.
  // Derived from SCREEN_OWN_MODULES so the list has ONE home — see the guard in
  // code-search-deps.test.ts that keeps it in step with the tree.
  new RegExp(
    `(^|/)packages/operator-core/lib/scout/(${SCREEN_OWN_MODULES.join('|')})\\.(test\\.)?ts$`,
  ),
];

/**
 * Is this path admissible as evidence that something was BUILT?
 *
 * Exported and pure so the exclusion set is testable and arguable on its own,
 * rather than buried in a grep pipeline.
 */
export function isEvidencePath(path: string, extra: RegExp[] = []): boolean {
  return ![...NON_EVIDENCE_PATTERNS, ...extra].some((re) => re.test(path));
}

/**
 * Map an execFile-style outcome onto {@link ExecOutcome}: a numeric exit code
 * resolves (exit 1 is `git grep`'s honest "no match"), anything else rejects. A
 * killed process reports a signal, not a numeric code — that is a real failure
 * (timeout / OOM), never an empty result.
 */
export function execOutcomeFromError(err: unknown): ExecOutcome {
  const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : NaN;
  if (Number.isFinite(code) && code >= 0) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return { stdout: typeof stdout === 'string' ? stdout : '', code };
  }
  throw err instanceof Error ? err : new Error(String(err));
}

/**
 * WI-10005424 — the fork happens in the spawner sidecar, not here. Measured on the
 * tower 2026-10-02 09:26Z: a bg-host main-thread fork took 256–512 ms at 11.7 GB RSS,
 * and `probeCodeExistence`'s `git grep` was one of them. `execFileViaSidecar` falls
 * back to a local spawn (counted under `scout-code-search`) when no sidecar is up.
 */
const defaultExec: ExecRunner = async (file, args, opts) => {
  try {
    const { stdout } = await execFileViaSidecar(file, args, {
      timeoutMs: opts.timeoutMs,
      subsystem: 'scout-code-search',
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer,
    });
    return { stdout, code: 0 };
  } catch (err) {
    return execOutcomeFromError(err);
  }
};

/**
 * Search tracked files for `term` as a literal substring.
 *
 * Returns paths on a hit, `[]` on an honest miss, and THROWS on a real failure —
 * because `probeCodeExistence` converts a throw into `searched: false`, which is
 * how an outage stays distinguishable from a miss. Swallowing the error here would
 * quietly defeat that.
 */
export async function gitGrepFiles(term: string, opts: GitGrepOptions): Promise<string[]> {
  const exec = opts.exec ?? defaultExec;
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;

  // Empty/whitespace terms would make `git grep` match everything.
  if (!term.trim()) return [];

  const { stdout, code } = await exec(
    'git',
    ['grep', '--no-color', '-l', '-F', '-I', '-e', term, '--'],
    {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBuffer: opts.maxBuffer ?? DEFAULTS.maxBuffer,
    },
  );

  if (code === GIT_GREP_NO_MATCH) return []; // a real, complete, empty answer
  if (code !== 0) {
    throw new Error(`git grep failed (exit ${code}) for term ${JSON.stringify(term)}`);
  }

  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((p) => isEvidencePath(p, opts.extraNonEvidencePatterns))
    .slice(0, maxFiles);
}

/**
 * Build a `CodeSearchDeps` backed by `git grep`, with per-term memoisation.
 *
 * Memoisation is not an optimisation detail — the screening pass probes every
 * member of a cluster, and members of a cluster are near-duplicates, so the same
 * terms recur heavily within one cluster. Without the cache a 10-member cluster
 * runs ~10x the greps for the same answers.
 *
 * The cache stores REJECTIONS too (as a rejected promise), so a backend outage is
 * not silently retried into a different answer partway through one report.
 */
export function createGitGrepDeps(opts: GitGrepOptions): CodeSearchDeps {
  const cache = new Map<string, Promise<string[]>>();

  const deps: CodeSearchDeps = {
    search: (term: string) => {
      const hit = cache.get(term);
      if (hit) return hit;
      const p = gitGrepFiles(term, opts);
      cache.set(term, p);
      // Keep the rejection observable to the caller, but stop Node treating a
      // cached-and-not-yet-awaited rejection as unhandled.
      p.catch(() => undefined);
      return p;
    },
  };

  if (opts.searchSemantic) deps.searchSemantic = opts.searchSemantic;
  if (opts.searchPlans) deps.searchPlans = opts.searchPlans;
  return deps;
}
