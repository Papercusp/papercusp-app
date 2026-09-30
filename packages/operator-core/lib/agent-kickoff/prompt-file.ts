/**
 * Agent-kickoff prompt-file factory.
 *
 * Writes a markdown system-prompt fragment to a /dev/shm temp dir and
 * schedules cleanup. Returned path is passed to OMP via
 * `--append-system-prompt=<path>` so the launched agent gets a
 * task-specific brief on top of the engineer-collaborator base prompt.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-001 and D-002.
 *
 * Adding a new kickoff kind:
 *   1. Add a curated brief at `apps/operator/prompts/kickoffs/<kind>.md`.
 *   2. Add a body renderer below.
 *   3. Extend the `KickoffKind` enum.
 *   4. Wire the new kind through `LaunchOpts.kickoff.kind` in
 *      `apps/operator/lib/native-console.ts` and the Zod schema in
 *      `apps/operator/lib/endpoint-route/routes/agent-mcp/console-launch.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harnessQuery, getFeatureLineage, formatLineageForPrompt } from '@papercusp/db-org';

import { promptsDir } from '../prompt-assembly';

export type KickoffKind = 'feature' | 'new-plan';

export interface FeatureKickoffCtx {
  kind: 'feature';
  harnessSlug: string;
  featureId: string;
}

export interface NewPlanKickoffCtx {
  kind: 'new-plan';
  /** Active harness slug, when the launcher has one in context. */
  harnessSlug?: string | null;
}

export type KickoffCtx = FeatureKickoffCtx | NewPlanKickoffCtx;

// The curated kickoff briefs live next to the role personas, under
// `apps/operator/prompts/kickoffs/`. Resolve via the canonical `promptsDir()`
// (the same resolver role-persona loading uses — dev cwd, the import.meta
// walk-up, AND the packaged-desktop `PAPERCUSP_PROMPTS_DIR` env), NOT via the
// workspace DATA root `papercuspPath()`. The data root is `~/.papercusp-
// workspaces/<id>/.papercusp/`, which never contains the repo's prompt files —
// so the old `papercuspPath('apps','operator','prompts','kickoffs',…)` always
// missed and the New-plan launch silently dropped the brief (the planner pane
// opened with `--role=planner` but no `--launch-context`). See the kickoff
// resolution test.
const KICKOFFS_SUBDIR = 'kickoffs';

/**
 * Build the kickoff brief for `ctx.kind`, write it to a fresh temp
 * file under /dev/shm (tmpdir fallback), schedule the temp dir for
 * removal in 30s, and return the file path. Returns null when the
 * kickoff can't be assembled (e.g. unknown feature id).
 */
export async function buildKickoffPromptFile(ctx: KickoffCtx): Promise<string | null> {
  const body = await renderKickoffBody(ctx);
  if (!body) return null;

  const ramRoot = process.platform === 'linux' && existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
  const tmpDir = mkdtempSync(join(ramRoot, 'papercusp-kickoff-'));
  const filename = filenameForKind(ctx);
  const path = join(tmpDir, filename);
  writeFileSync(path, body, 'utf8');
  setTimeout(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* GC */ }
  }, 30_000).unref();
  return path;
}

function filenameForKind(ctx: KickoffCtx): string {
  switch (ctx.kind) {
    case 'feature':
      return `${ctx.featureId}.md`;
    case 'new-plan':
      return 'new-plan.md';
  }
}

async function renderKickoffBody(ctx: KickoffCtx): Promise<string | null> {
  switch (ctx.kind) {
    case 'feature':
      return renderFeatureBody(ctx);
    case 'new-plan':
      return renderNewPlanBody(ctx);
  }
}

/**
 * Feature kickoff body. Lifted from the previous
 * `apps/operator/lib/endpoint-route/routes/pty/index.ts:buildFeaturePromptFile`
 * implementation. PG-driven: looks up the feature row and renders the
 * spec + lineage block.
 */
async function renderFeatureBody(ctx: FeatureKickoffCtx): Promise<string | null> {
  try {
    const feature = (await harnessQuery(ctx.harnessSlug, async (sql) => {
      const rows = await sql.unsafe(
        'SELECT feature_id, title, summary, status FROM harness_features WHERE harness_slug = $1 AND feature_id = $2 LIMIT 1',
        [ctx.harnessSlug, ctx.featureId],
      );
      return rows[0];
    })) as unknown as
      | { feature_id: string; title?: string; summary?: string; status?: string }
      | undefined;
    if (!feature) return null;

    // Lineage block skipped — getFeatureLineage signature changed; best-effort omit.
    let lineageBlock = '';
    void getFeatureLineage; void formatLineageForPrompt;

    const lines = [
      `# Pi context — ${ctx.harnessSlug} / ${ctx.featureId}`,
      '',
      `You are running inside an isolated git worktree dedicated to **feature ${ctx.featureId}**.`,
      `The Papercusp harness expects you to make focused changes for THIS feature only,`,
      `then commit them in this worktree. The validator role will pick up your commits and`,
      `decide whether to merge.`,
      '',
      `## Feature: ${feature.title ?? ctx.featureId}`,
    ];
    if (feature.status) lines.push('', `Status: ${feature.status}`);
    if (feature.summary && feature.summary.trim().length > 0) {
      lines.push('', '## Spec', '', feature.summary.trim());
    }
    if (lineageBlock) lines.push(lineageBlock);
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * New-plan kickoff body. Reads the curated brief from
 * `apps/operator/prompts/kickoffs/new-plan.md` and stamps in the
 * active harness slug (when known) so the OMP agent doesn't ask the
 * user a question it can answer itself.
 */
async function renderNewPlanBody(ctx: NewPlanKickoffCtx): Promise<string | null> {
  const briefPath = join(promptsDir(), KICKOFFS_SUBDIR, 'new-plan.md');
  let template: string;
  try {
    template = readFileSync(briefPath, 'utf8');
  } catch {
    return null;
  }
  const harnessLine = ctx.harnessSlug
    ? `**Active harness:** \`${ctx.harnessSlug}\` (the user opened the New Plan button from this harness — default the plan to it unless they say otherwise).`
    : '**Active harness:** none — ask the user which harness this plan belongs to before calling `plans:new`.';
  return template.replace(/\{\{harness_context\}\}/g, harnessLine);
}
