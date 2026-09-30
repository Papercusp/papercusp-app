/**
 * plan-markdown-render — auto-render PG plans to an on-disk markdown mirror
 * (plan-markdown-auto-render-2026-06-06).
 *
 * This module wires the pure tick (./tick.ts) to the real world:
 *   - a Node `fs/promises` adapter (`nodeRenderFs`),
 *   - lightweight PG reads against `harness_shared.harness_plans`,
 *   - the canonical mirror dirs (`apps/operator/docs/plans/` + `archive/`),
 *   - a process-lived watermark map (cheap restart: an already-correct file is
 *     adopted without a content fetch — see tick.ts).
 *
 * Scope: the papercup (SU) plans → `apps/operator/docs/plans/`, the historical
 * home the PG-canonical migration retired. The DBOS scheduled wrapper that calls
 * `planMarkdownRenderTick` every 30s lives at
 * `lib/dbos/plan-markdown-render-workflow.ts` (opt-in via PAPERCUSP_DBOS_PLAN_RENDER).
 */
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { withWorkspace } from '@papercusp/db-org';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { resolvePlanScope, getPlansDir, getArchiveDir } from '../../agent-tools/plans/source';
import { runPlanRenderTick, type RenderFs, type RenderTarget, type RenderTickResult } from './tick';

export type { RenderTickResult } from './tick';

/** Skip rendering a plan whose last write landed within this window — so a
 *  multi-chunk `set-content` write renders once, after it settles. */
export const SETTLE_WINDOW_MS = 15_000;

/** Tick cadence (6-field crontab) for the DBOS scheduled wrapper. */
export const RENDER_CRONTAB = '*/30 * * * * *';

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** Real `fs/promises`-backed {@link RenderFs}. */
export const nodeRenderFs: RenderFs = {
  async readFile(absPath) {
    try {
      return await fs.readFile(absPath, 'utf8');
    } catch (e) {
      if (errno(e) === 'ENOENT') return null;
      throw e;
    }
  },
  async writeFile(absPath, content) {
    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
  },
  async remove(absPath) {
    try {
      await fs.unlink(absPath);
    } catch (e) {
      if (errno(e) !== 'ENOENT') throw e;
    }
  },
  async listMarkdown(dir) {
    try {
      const ents = await fs.readdir(dir, { withFileTypes: true });
      return ents.filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      throw e;
    }
  },
};

/** Cheap per-plan listing (slug, hash, archived, updatedAt) — NO content blob. */
async function listRenderTargets(workspaceId: string, harnessSlug: string): Promise<RenderTarget[]> {
  const rows = await withWorkspace(
    workspaceId,
    async (tx) =>
      tx<{ plan_slug: string; content_hash: string; archived: boolean; updated_at: Date | string }[]>`
      SELECT plan_slug, content_hash, archived, updated_at
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`,
  );
  return rows.map((r) => ({
    slug: r.plan_slug,
    contentHash: r.content_hash,
    archived: r.archived,
    updatedAtMs: new Date(r.updated_at).getTime(),
  }));
}

/** Fetch one plan's canonical markdown (only for plans that actually changed). */
async function getPlanContent(workspaceId: string, harnessSlug: string, slug: string): Promise<string | null> {
  const rows = await withWorkspace(
    workspaceId,
    async (tx) =>
      tx<{ content: string }[]>`
      SELECT content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}
       LIMIT 1`,
  );
  return rows[0]?.content ?? null;
}

/** Process-lived per-slug watermark — survives across ticks, rebuilt on restart
 *  (the adopt path keeps that cheap). NOT persisted: it is a pure optimization;
 *  correctness comes from the on-disk file compare. */
const renderedHashes = new Map<string, string>();

/**
 * Run one render tick against the live PG + filesystem. Scoped to the papercup
 * (SU) plans → `apps/operator/docs/plans/`. `opts.repoRoot` overrides the
 * mirror root (used by the live-verify path + real-fs tests).
 */
export async function planMarkdownRenderTick(opts: { repoRoot?: string } = {}): Promise<RenderTickResult> {
  const { workspaceId, harnessSlug } = await resolvePlanScope({});
  const plansDir = getPlansDir({ repoRoot: opts.repoRoot });
  const archiveDir = getArchiveDir({ repoRoot: opts.repoRoot });
  return runPlanRenderTick({
    fs: nodeRenderFs,
    plansDir,
    archiveDir,
    nowMs: Date.now(),
    settleWindowMs: SETTLE_WINDOW_MS,
    listTargets: () => listRenderTargets(workspaceId, harnessSlug),
    getContent: (slug) => getPlanContent(workspaceId, harnessSlug, slug),
    hash: hashPlanContent,
    renderedHashes,
  });
}

/** Test-only: clear the process watermark so a test starts from a cold cache. */
export function __resetRenderWatermarkForTests(): void {
  renderedHashes.clear();
}
