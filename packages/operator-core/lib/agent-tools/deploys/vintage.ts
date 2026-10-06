/**
 * deploys:vintage — "is the fix actually RUNNING there?" in one query
 * (fleet-reliability-verification-2026-07-10 P-008).
 *
 * Lists every runtime that has self-reported into `harness_shared.runtime_vintage`
 * (bg-host, staging-api, dev-api, desktop sidecars, watchdogs, the gateway, …) and,
 * for each row whose `treeSha` resolves in the local checkout, computes commit-lag
 * against `origin/staging` HEAD — so "did the fix land there yet" resolves without
 * manual ssh + log-tailing (asked ~5x by hand during the 2026-07-09/10 night-shift
 * outage: a Mac bundle predating a landed fix, a tower bundle mid half-rename
 * break, a watchdog silently auto-deploying an instrumented build).
 *
 * READ-ONLY: no `git fetch` — reads already-fetched origin refs, same contract as
 * dev:pipeline_position.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listRuntimeVintage, type RuntimeVintageRow } from '../../runtime-vintage';
import { devDeployState } from '../../dev-deploy-state';
import { execFileViaSidecar } from '../../fleet/git-via-sidecar';

/** Injectable git runner (returns trimmed stdout, or null on any failure). */
export type GitRunner = (repo: string, args: string[]) => Promise<string | null>;

/** The vintage probe's per-git-call kill timeout. */
export const VINTAGE_GIT_TIMEOUT_MS = 10_000;

/**
 * Build the real git runner over an execFile-shaped seam. The default seam is
 * {@link execFileViaSidecar}: on bg-host a direct fork stalls the main thread for
 * ~40 ms per GB of RSS (WI-10006307 measured one deploys:vintage call at 68% of a
 * 706 ms-p95 loop-saturation profile inside spawn < execFile < realGit).
 */
export function createRealGit(exec: typeof execFileViaSidecar = execFileViaSidecar): GitRunner {
  return async (repo, args) => {
    try {
      const { stdout } = await exec('git', ['-C', repo, ...args], {
        timeoutMs: VINTAGE_GIT_TIMEOUT_MS,
        subsystem: 'deploys-vintage',
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  };
}

export const realGit: GitRunner = createRealGit();

export interface VintageRowReport {
  workspaceId: string;
  unit: string;
  host: string;
  treeSha: string | null;
  buildTime: string | null;
  bundleVersion: string | null;
  pid: number | null;
  reportedAt: string;
  reportedAgeMs: number;
  extra: Record<string, unknown>;
  /** Commits `origin/staging` has that `treeSha` doesn't (0 = fully caught up).
   *  Null when `treeSha` is unset or doesn't resolve locally (e.g. a packaged
   *  bundle sha not present in this checkout's object db). */
  commitsBehindStaging: number | null;
  /** Commits `treeSha` has that `origin/staging` doesn't — nonzero flags a
   *  build carrying commits staging hasn't seen (a local/forked/dev build). */
  commitsAheadOfStaging: number | null;
  /** Human summary of the lag state for this row. */
  note: string;
}

export interface VintageReport {
  stagingHeadSha: string | null;
  stagingHeadShortSha: string | null;
  rows: VintageRowReport[];
}

/**
 * Keep the diagnostic fan-out bounded. A workspace can accumulate many
 * current runtime rows (the live Papercusp workspace has exceeded 100), and
 * starting one git process per row serially makes this read exceed the
 * dispatch deadline. Each probe starts two independent rev-list calls, so a
 * four-item pool caps the git-process burst at eight.
 */
const VINTAGE_PROBE_CONCURRENCY = 4;

/** Bounded-concurrency map that preserves input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface VintageLag {
  commitsBehindStaging: number | null;
  commitsAheadOfStaging: number | null;
}

function parseCommitCount(value: string | null): number | null {
  return value ? Number(value) : null;
}

export function noteFor(behind: number | null, ahead: number | null, treeSha: string | null): string {
  if (!treeSha) return 'no treeSha reported — cannot resolve a commit position.';
  if (behind === null) return `treeSha ${treeSha.slice(0, 9)} does not resolve in this checkout (unknown commit — likely a packaged bundle built from a different clone).`;
  if (behind === 0 && (ahead ?? 0) === 0) return 'up to date with origin/staging HEAD.';
  if (behind > 0) return `${behind} commit(s) behind origin/staging HEAD.`;
  return `carries ${ahead} commit(s) origin/staging does not have (forked/local/dev build).`;
}

export async function buildVintageReport(
  deps: { git?: GitRunner; loadRows?: () => Promise<RuntimeVintageRow[]>; loadRoot?: () => Promise<string> } = {},
): Promise<VintageReport> {
  const git = deps.git ?? realGit;
  const loadRows = deps.loadRows ?? (() => listRuntimeVintage());
  const loadRoot = deps.loadRoot ?? (async () => (await devDeployState()).integrationRoot);

  const root = await loadRoot();
  const stagingHeadSha = await git(root, ['rev-parse', '--verify', 'origin/staging']);
  const stagingHeadShortSha = stagingHeadSha ? stagingHeadSha.slice(0, 9) : null;

  const rawRows = await loadRows();
  // Multiple runtimes commonly carry the same build. Probe each SHA once and
  // reuse its lag for every row, rather than multiplying git work by the row
  // count. Two rev-list calls preserve the old behavior for unrelated commit
  // histories (where a three-dot symmetric-difference query would fail).
  const treeShas = Array.from(
    new Set(rawRows.map((r) => r.treeSha).filter((sha): sha is string => Boolean(sha))),
  );
  const lagByTreeSha = new Map<string, VintageLag>();
  if (stagingHeadSha && treeShas.length > 0) {
    const lagEntries = await mapWithConcurrency(treeShas, VINTAGE_PROBE_CONCURRENCY, async (treeSha) => {
      const [behind, ahead] = await Promise.all([
        git(root, ['rev-list', '--count', `${treeSha}..origin/staging`]),
        git(root, ['rev-list', '--count', `origin/staging..${treeSha}`]),
      ]);
      return {
        treeSha,
        lag: {
          commitsBehindStaging: parseCommitCount(behind),
          commitsAheadOfStaging: parseCommitCount(ahead),
        },
      };
    });
    for (const { treeSha, lag } of lagEntries) lagByTreeSha.set(treeSha, lag);
  }

  const now = Date.now();
  const rows: VintageRowReport[] = [];
  for (const r of rawRows) {
    const lag = r.treeSha ? lagByTreeSha.get(r.treeSha) : undefined;
    const commitsBehindStaging = lag?.commitsBehindStaging ?? null;
    const commitsAheadOfStaging = lag?.commitsAheadOfStaging ?? null;
    rows.push({
      workspaceId: r.workspaceId,
      unit: r.unit,
      host: r.host,
      treeSha: r.treeSha,
      buildTime: r.buildTime,
      bundleVersion: r.bundleVersion,
      pid: r.pid,
      reportedAt: r.reportedAt,
      reportedAgeMs: now - new Date(r.reportedAt).getTime(),
      extra: r.extra,
      commitsBehindStaging,
      commitsAheadOfStaging,
      note: noteFor(commitsBehindStaging, commitsAheadOfStaging, r.treeSha),
    });
  }
  return { stagingHeadSha, stagingHeadShortSha, rows };
}

export default defineTool({
  name: 'deploys:vintage',
  profile: 'engineer',
  description:
    'Lists every runtime that has self-reported its build identity (bg-host, staging-api, dev-api, desktop sidecars, watchdogs, gateway, …) with commit-lag vs origin/staging HEAD per unit. Answers "is the fix actually RUNNING there" without manual ssh + log-tailing.',
  capability: 'intel:read',
  guidance: {
    when: 'Before trusting that a landed fix is live on a specific runtime/host — a Mac/Windows desktop bundle, the tower bg-host, a watchdog, the inference gateway, or any service that calls reportRuntimeVintageOnBoot at boot.',
    notWhen: 'For the git-sync → green-checkpoint → :3070 pipeline of a single commit, use dev:pipeline_position instead — this tool is about WHICH RUNNING PROCESSES carry which build, not about one commit\'s pipeline position.',
    seeAlso: [
      'dev:pipeline_position (where a single commit sits in the pipeline)',
      'dev:build_status (local build mtime + reachability)',
    ],
  },
  requirePrincipal: false,
  // EI-18803497769946984: shells out and never reads ctx.tx — holding the ambient
  // workspace transaction across that wait trips idle_in_transaction_session_timeout
  // (60s), surfacing as a bare `write CONNECTION_CLOSED 127.0.0.1:6432`.
  // See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // EI-21388223987997525: the runtime ledger can contain 100+ rows and each
  // row needs local git ancestry reads. The probes are bounded and
  // SHA-deduplicated above, but retain margin over the 60s default so a busy
  // host restart cannot abort a healthy read at the dispatch boundary.
  timeoutSec: 120,
  agentRoles: ['operator', 'architect', 'debugger', 'release-manager', 'release-fixer', 'cup'],
  args: z.object({ workspace: z.string().min(1).optional() }),
  async handler(args) {
    const report = await buildVintageReport(
      args.workspace ? { loadRows: () => listRuntimeVintage(args.workspace) } : {},
    );
    return { data: report };
  },
});
