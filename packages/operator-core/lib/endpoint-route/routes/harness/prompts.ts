/**
 * Per-harness prompt overrides — WORKSPACE-OWNED (PG), D-7 / decision (c).
 *
 *   GET    /api/harness/:slug/prompts            — role list + which have a workspace override
 *   GET    /api/harness/:slug/prompts/:role      — effective override + base + committed default
 *   PUT    /api/harness/:slug/prompts/:role      — live prompt edit. Blueprint-harness →
 *                                                  commit→reproject `.papercusp/prompts/<role>.md`
 *                                                  (P-016/D-007); legacy → PG override.
 *   DELETE /api/harness/:slug/prompts/:role      — clear the override = reset that role to default
 *   POST   /api/harness/:slug/prompts/reset-all  — clear all overrides = reset every role
 *
 * The live per-(workspace,harness,role) override lives in the PG store
 * (harness_prompt_overrides), scoped to the ACTIVE workspace. The committed
 * `.papercusp/prompts/<role>.md` (if a harness ships one) is the immutable DEFAULT
 * — the app never writes it, so the harness repo's git tree stays clean and a
 * "reset" simply clears the PG override (the orchestrator's PG→file fallback then
 * yields the committed default, or the base role prompt when none is committed).
 * Standalone/CLI harness runs keep using the committed file directly. See
 * orchestrator resolvePromptOverrideWithStore for the read side.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import { getKnownRoles } from '../../../known-roles';
import type { ProjectEntry } from '../../../harness-registry';
import { activeWorkspaceId } from '../../../workspace-registry';
import { routeWithWorkspace } from '../../../route-workspace';
import {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  listPromptOverrides,
  clearAllPromptOverrides,
} from '../../../harness-prompt-overrides';
// P-016 (D-007): a prompt edit on a blueprint-harness is a commit→reproject, not a
// direct PG override write.
import { commitAndReproject } from '../../../blueprint/commit-reproject';
import { realCommitReprojectDeps } from '../../../blueprint/commit-reproject-real';
// Behavior-change-ledger hooks (self-learning-frontier P-004 / D-003): every
// successful write here is a live prompt mutation. Best-effort — never blocks.
import { recordBehaviorChange } from '../../../change-ledger/change-ledger';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

/** Committed repo default for a role (`.papercusp/prompts/<role>.md`), or null. */
const committedDefault = (p: ProjectEntry, role: string): string | null =>
  safeRead(join(harnessDir(p), 'prompts', `${role}.md`));

function safeRole(role: string): string | null {
  if (!getKnownRoles().includes(role)) return null;
  return role;
}

const getPrompts = defineTool({
  method: 'GET',
  path: '/harness/:slug/prompts',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    let overrides: string[] = [];
    try {
      overrides = (await listPromptOverrides(activeWorkspaceId(), project.slug))
        .map((o) => o.role)
        .filter((r) => getKnownRoles().includes(r))
        .sort();
    } catch { /* store unavailable → report none */ }
    return Response.json({ roles: getKnownRoles(), overrides });
  },
});

const getPromptByRole = defineTool({
  method: 'GET',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });

    let stored: string | null = null;
    try { stored = await getPromptOverride(activeWorkspaceId(), project.slug, role); } catch {}
    const def = committedDefault(project, role); // immutable repo default (or null)
    // The canonical base-library persona (Phase 5: the global prompts/ dir was deleted;
    // the universal role library lives at blueprints/base/prompts/<role>.md).
    const globalPath = harnessPath('blueprints', 'base', 'prompts', `${role}.md`);
    return Response.json({
      role,
      // effective value the editor shows: workspace override → committed default → ''
      content: stored ?? def ?? '',
      overrideExists: stored !== null, // a workspace override is set (→ show "reset")
      defaultContent: def ?? '', // what a reset restores (committed repo default)
      globalContent: safeRead(globalPath) ?? '', // base role prompt
    });
  },
});

const putPrompt = defineTool({
  method: 'PUT',
  path: '/harness/:slug/prompts/:role',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });

    // P-016 / D-007: for a blueprint-harness (git-canonical `.papercusp/blueprint.yaml`),
    // a live prompt edit is a commit→reproject — it commits `.papercusp/prompts/<role>.md`
    // (the file the orchestrator's resolver reads) and re-projects the blueprint, instead
    // of the ungated direct PG override write. `harness_prompt_overrides` is kept only as
    // the workspace-divergence escape-hatch (legacy / non-blueprint harnesses below).
    if (existsSync(join(project.path, '.papercusp', 'blueprint.yaml'))) {
      try {
        const res = await routeWithWorkspace((tx) =>
          commitAndReproject(
            { workspaceId: activeWorkspaceId(), harnessSlug: project.slug, harnessDir: project.path, edit: { kind: 'prompt', role, md: body.content } },
            realCommitReprojectDeps(tx),
          ),
        );
        if (res.ok && res.committed) {
          await recordBehaviorChange({
            workspaceId: activeWorkspaceId(),
            source: 'prompts-api',
            action: 'set',
            targetKind: 'prompt-file',
            target: `${project.slug}/.papercusp/prompts/${role}.md`,
            harnessSlug: project.slug,
            role,
            diffRef: res.commit ?? null,
            actor: 'prompts-api',
            summary: `prompt commit→reproject set → ${role}@${project.slug}`,
          });
        }
        return Response.json({ ok: res.ok, role, mode: 'commit-reproject', committed: res.committed, commit: res.commit, contentHash: res.contentHash, reason: res.reason });
      } catch (e) {
        return Response.json({ ok: false, role, mode: 'commit-reproject', error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }

    // Legacy / non-blueprint harness: PG-only override (the escape-hatch); the harness
    // folder is never modified, so the repo git tree stays clean.
    await setPromptOverride(activeWorkspaceId(), project.slug, role, body.content);
    await recordBehaviorChange({
      workspaceId: activeWorkspaceId(),
      source: 'prompts-api',
      action: 'set',
      targetKind: 'prompt-override',
      target: `${project.slug}/${role}`,
      harnessSlug: project.slug,
      role,
      actor: 'prompts-api',
      summary: `prompt override set → ${role}@${project.slug}`,
    });
    return Response.json({ ok: true, role, mode: 'pg-override' });
  },
});

const deletePrompt = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/prompts/:role',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    // Clearing the workspace override IS "reset to default": the orchestrator's
    // PG→file fallback then yields the committed default (or the base prompt).
    const existed = await deletePromptOverride(activeWorkspaceId(), project.slug, role);
    if (existed) {
      await recordBehaviorChange({
        workspaceId: activeWorkspaceId(),
        source: 'prompts-api',
        action: 'clear',
        targetKind: 'prompt-override',
        target: `${project.slug}/${role}`,
        harnessSlug: project.slug,
        role,
        actor: 'prompts-api',
        summary: `prompt override cleared (reset to default) → ${role}@${project.slug}`,
      });
    }
    return Response.json({ ok: true, reset: existed });
  },
});

const resetAllPrompts = defineTool({
  method: 'POST',
  path: '/harness/:slug/prompts/reset-all',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const cleared = await clearAllPromptOverrides(activeWorkspaceId(), project.slug);
    if (cleared > 0) {
      await recordBehaviorChange({
        workspaceId: activeWorkspaceId(),
        source: 'prompts-api',
        action: 'clear-all',
        targetKind: 'prompt-override',
        target: `${project.slug}/*`,
        harnessSlug: project.slug,
        actor: 'prompts-api',
        summary: `all prompt overrides cleared (${cleared}) @${project.slug}`,
        payload: { cleared },
      });
    }
    return Response.json({ ok: true, cleared });
  },
});

export default [getPrompts, getPromptByRole, putPrompt, deletePrompt, resetAllPrompts];
