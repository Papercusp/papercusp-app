/**
 * git-runner — the shared GitRunner + thin helpers for the harness-docs
 * subsystem (drift checks, the freshness sweep, provenance capture, the endpoints).
 * Same shape as run-git-sync's RunGit (never throws; captures code/stdout/stderr).
 *
 * ## Why this routes through the spawner sidecar (EI-18808838427010743)
 *
 * `fork()` copies the calling process's page tables, so the parent-side cost of
 * `child_process.spawn` scales with the PARENT's RSS — charged as SYNCHRONOUS
 * system time on the main thread, i.e. it blocks the event loop. Measured on
 * this box: ~40 ms of blocked loop per GB of parent RSS. The bg-host runs at
 * ~4 GB, so every `git` call forked from it cost ~165 ms of dead loop, for
 * plumbing git itself finishes in ~4 ms (~97% pure overhead imposed by the
 * caller's own footprint).
 *
 * This subsystem is the single most frequent git caller in the bg-host: the
 * drift checker runs `git log <range> --name-only` per (baseline, submodule)
 * group per doc, and /proc sampling of bg-host's children confirmed
 * `harness/docs/drift.ts` as the dominant `git` parent even AFTER the pot-git
 * seam was rerouted. So the same fix applies here, from the same shared helper
 * (repo convention: reuse-first — one implementation, not a third copy).
 *
 * The sidecar is small, so ITS fork is cheap (~3 ms); this process pays only a
 * Unix-socket round-trip. Any sidecar problem falls back to {@link runGitLocal},
 * so a sidecar fault degrades performance, never correctness. Set
 * `PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR=0` to force the local path for this
 * subsystem alone.
 */

import { spawn } from 'node:child_process';
import { collectChildOutput } from '../../child-output.js';
import type { GitRunner } from './subject-ref';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from '../../fleet/git-via-sidecar';

/**
 * Kill-timeout for the sidecar-routed run.
 *
 * The local path is deliberately unbounded (it always has been), but the
 * sidecar path needs SOME bound so a wedged child cannot pin a sidecar slot
 * forever. Generous enough that a legitimate `git log` over a large range
 * finishes well inside it.
 */
const SIDECAR_GIT_TIMEOUT_MS = 120_000;

/**
 * Local (in-process) GitRunner — never throws, captures code/stdout/stderr.
 *
 * ⚠ Forking from THIS process is expensive in proportion to its own RSS (see
 * the module header). Prefer {@link runGit}. Exported so the fallback path
 * stays directly testable.
 */
export const runGitLocal: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    const out = collectChildOutput(child);
    child.on('error', (e) =>
      resolve({ code: -1, stdout: out.stdout.text(), stderr: out.stderr.text() + String(e) }),
    );
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: out.stdout.text(), stderr: out.stderr.text() }),
    );
  });

export const runGit: GitRunner = async (args, cwd) => {
  if (gitSidecarEnabled('PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR')) {
    try {
      // Pass THIS process's env explicitly: the sidecar merges over its OWN
      // process.env, so omitting it would silently run git under the sidecar's
      // environment rather than the caller's.
      return await runGitViaSpawnerSidecar(args, cwd, SIDECAR_GIT_TIMEOUT_MS, process.env);
    } catch (e) {
      // A log line per call would itself be a cost on this, the hottest git
      // path in the host — but warning only ONCE made a permanently-degraded
      // sidecar look identical to a healthy one. The shared seam counts every
      // fallback and re-warns on a bounded cadence, giving both properties.
      noteSidecarFallback('harness-docs', e);
    }
  }
  return runGitLocal(args, cwd);
};

/** Current HEAD sha of a repo, or null if it can't be read. */
export async function repoHeadSha(repoRoot: string): Promise<string | null> {
  const r = await runGit(['rev-parse', 'HEAD'], repoRoot);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Files changed between two refs (repo-relative), or null on git failure. */
export async function repoChangedPaths(repoRoot: string, a: string, b: string): Promise<string[] | null> {
  const r = await runGit(['diff', '--name-only', a, b], repoRoot);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export interface ChangedPathPair {
  /** Git's name-status token, e.g. `M`, `A`, `D`, or `R100`. */
  status: string;
  /** The path present at the newer ref (or the only path for non-renames). */
  path: string;
  /** The path present at the older ref for a detected rename. */
  previousPath?: string;
}

/** Parse `git diff --name-status --find-renames` without losing rename provenance. */
export function parseChangedPathPairs(stdout: string): ChangedPathPair[] {
  const out: ChangedPathPair[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trimEnd().split('\t');
    const status = fields[0]?.trim();
    if (!status || !fields[1]) continue;
    if (status.startsWith('R') && fields[2]) {
      out.push({ status, previousPath: fields[1], path: fields[2] });
    } else {
      out.push({ status, path: fields[1] });
    }
  }
  return out;
}

/** Changed paths plus old/new provenance for Git-detected renames. */
export async function repoChangedPathPairs(repoRoot: string, a: string, b: string): Promise<ChangedPathPair[] | null> {
  const r = await runGit(['diff', '--name-status', '--find-renames', a, b], repoRoot);
  if (r.code !== 0) return null;
  return parseChangedPathPairs(r.stdout);
}

/** Submodule paths (repo-relative) declared in `<repoRoot>/.gitmodules`, or [] if none.
 *  Used by the drift checker to route a submodule anchor's `git log` into the submodule
 *  against its own baseline (docs-audit 2026-06-23 #3). */
export async function listSubmodulePaths(repoRoot: string): Promise<string[]> {
  const r = await runGit(['config', '-f', '.gitmodules', '--get-regexp', 'path'], repoRoot);
  if (r.code !== 0) return [];
  // lines: "submodule.<name>.path <path>"
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p));
}
