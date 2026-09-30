/**
 * Durable system action for the dead-citation sweep (EI-21894865709918325). Unlike
 * `work-item-admission-delta-sweep-action.ts`, this action makes no LLM call — "does this id
 * resolve in harness_shared.work_items" is a plain lookup, not a judgment call, so there is
 * nothing here to clock or budget beyond the SQL query itself.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { captureImprovement } from '../improvements/capture-core';
import {
  deadCitationSweepWatchdogKey,
  renderDeadCitationSweepBody,
  runDeadCitationSweep,
  type DeadCitationSweepDeps,
  type DeadCitationSweepResult,
} from '../../dead-citation-sweep';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const DEAD_CITATION_SWEEP = 'dead-citation-sweep';

const execFileAsync = promisify(execFile);

/** Repo root: lib/harness/routines -> lib -> operator-core -> packages -> <repo root>. */
function repoRoot(): string {
  return path.resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
}

/**
 * `git ls-files` — tracked files only, which is exactly the "committed source/docs" surface a
 * dead citation report should be judged against (an uncommitted stray edit should not produce a
 * finding). Globs match `runDeadCitationSweep`'s own filter, kept here too as a cheap pre-filter
 * so `git ls-files` does not have to enumerate the whole tree (node_modules included) before the
 * in-module filter runs.
 */
async function listRepoFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--', '*.md', '*.mdx', '*.json', '*.ts', '*.tsx', '*.mjs', '*.js', '*.sh'],
    { cwd: repoRoot(), maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot(), relPath), 'utf8');
}

/** Live-id resolution against the base table — the same mixed-family (EI-/WI-/F-) query CLAUDE.md
 *  itself prescribes for this exact check, scoped to no single harness because a citation can
 *  legitimately name a work-item filed under a different harness than the one doing the sweep. */
async function productionLiveIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string }[]>`
    SELECT DISTINCT feature_id
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids}::text[])`;
  return new Set(rows.map((r) => r.feature_id));
}

const productionDeps: DeadCitationSweepDeps = {
  listFiles: listRepoFiles,
  readFile: readRepoFile,
  liveIds: productionLiveIds,
};

export interface DeadCitationSweepActionDeps {
  run: () => Promise<DeadCitationSweepResult>;
  file: (input: { harnessSlug: string; result: DeadCitationSweepResult }) => Promise<{ filed: boolean }>;
  log: (message: string) => void;
}

async function productionFile(input: {
  harnessSlug: string;
  result: DeadCitationSweepResult;
}): Promise<{ filed: boolean }> {
  if (input.result.deadCitations.length === 0) return { filed: false };
  await captureImprovement({
    title: `Dead work-item citation(s) in tracked documentation/metadata (${input.result.deadCitations.length})`,
    kind: 'bug',
    severity: 'minor',
    body: renderDeadCitationSweepBody(input.result),
    scope: `harness:${input.harnessSlug}`,
    foundDuring: `${DEAD_CITATION_SWEEP}`,
    dedupScope: 'open',
    watchdogKey: deadCitationSweepWatchdogKey(input.harnessSlug),
    sourceRole: 'system',
    createdBy: 'system:dead-citation-sweep',
    payloadExtra: {
      deadCitationSweep: {
        scannedFiles: input.result.scannedFiles,
        citedIds: input.result.citedIds,
        deadIds: input.result.deadCitations.map((d) => d.id),
      },
    },
  });
  return { filed: true };
}

export function makeDeadCitationSweepAction(overrides: Partial<DeadCitationSweepActionDeps> = {}) {
  const deps: DeadCitationSweepActionDeps = {
    run: () => runDeadCitationSweep(productionDeps),
    file: productionFile,
    log: (message) => console.log(`[${DEAD_CITATION_SWEEP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run();
    const { filed } = await deps.file({ harnessSlug: ctx.installSlug, result });
    deps.log(
      `${ctx.installSlug}: scanned=${result.scannedFiles} cited=${result.citedIds} ` +
        `dead=${result.deadCitations.length} filed=${filed}`,
    );
  };
}

registerSystemAction(DEAD_CITATION_SWEEP, makeDeadCitationSweepAction());
