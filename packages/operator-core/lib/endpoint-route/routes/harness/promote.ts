/**
 * Phase promotion cluster — promote / promote/:id/confirm / rollback.
 *
 *   POST /api/harness/:slug/promote                — create a pending review in the `from` worktree
 *   POST /api/harness/:slug/promote/:id/confirm    — merge `from` into `to`, optionally smoke-build, record in PG
 *   POST /api/harness/:slug/rollback               — git reset --hard to the previous promotion's SHA
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 43). `PHASE_ORDER` inlines (no other consumer remains).
 */
import { existsSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  type Phase,
  phasePath,
  phasePhaseLabel,
  ALL_PHASES,
} from '../../../harness-phases';
import {
  resolvePhasedProject,
  safeRead,
  parseFeatures,
} from '../../../harness-core';
import { harnessQuery } from '@papercusp/db-org';
import { papercuspPath } from '../../../papercusp-root';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { notifySyncInvalidate } from '../../../sync-sse';
import { defineTool } from '@papercusp/agent-mcp';
import { runGovernedOperation } from '../../../resource-governor/execution';

const PHASE_ORDER: Phase[] = [...ALL_PHASES];

const promote = defineTool({
  method: 'POST',
  path: '/harness/:slug/promote',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as { from?: string; to?: string };
    const from = phasePhaseLabel(body.from);
    const to = phasePhaseLabel(body.to);
    if (from === to) return Response.json({ error: 'from and to must differ' }, { status: 400 });

    const fromPath = phasePath(project, from);
    const toPath = phasePath(project, to);
    if (!existsSync(fromPath)) return Response.json({ error: `worktree missing for ${from}` }, { status: 400 });
    if (!existsSync(toPath)) return Response.json({ error: `worktree missing for ${to} — run /phases/setup` }, { status: 400 });

    const ts = Math.floor(Date.now() / 1000);
    const id = `promotion-${ts}-${from}-to-${to}`;

    let criteria: Record<string, unknown> = {
      allFeaturesPassed: true,
      noOpenReviews: true,
    };
    // Promotion-gate knobs come from the blueprint (⊕ PG instance overrides), not
    // config.json (deprecate-harness-config-json-2026-06-06). Resolved once here and
    // reused for the Layer-3 smoke-build gate below.
    let promotionKnob: Record<string, any> | undefined;
    try {
      const effCfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      promotionKnob = effCfg?.promotion as Record<string, any> | undefined;
      const override = promotionKnob?.[`${from}_to_${to}`]?.criteria;
      if (override && typeof override === 'object') criteria = override;
    } catch { /* ignore */ }

    const item = {
      id,
      kind: 'promotion',
      from, to,
      criteria,
      status: 'feature-freeze',
      readinessScore: 0,
      readinessSummary: 'Freeze just initiated. Orchestrator updates this on each loop.',
      summary: `Promote ${from} → ${to}`,
      question: `Confirm promotion of ${from} branch into ${to} once criteria pass.`,
      ts,
      resolved: false,
    };
    {
      const { db } = (await import('@papercusp/db-org')).getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { sql: dsql } = await import('drizzle-orm');
      const prev = generated.pendingReviewsInHarnessShared;
      const tsMs = ts * 1000;
      await db
        .insert(prev)
        .values({
          harnessSlug: project.slug,
          phase: from,
          reviewId: id,
          featureId: null,
          kind: 'promotion',
          payload: item as any,
          ts: tsMs,
          mtimeMs: tsMs,
          workspaceId: activeWorkspaceId(),
          resolved: false,
        })
        .onConflictDoUpdate({
          target: [prev.harnessSlug, prev.phase, prev.reviewId],
          set: {
            payload: dsql`EXCLUDED.payload`,
            mtimeMs: dsql`EXCLUDED.mtime_ms`,
            resolved: false,
          },
        });
      void notifySyncInvalidate('pendingReviews.byHarness', { harnessSlug: project.slug });
    }
    // PG is canonical for pending reviews (storage policy, audit P-077) — no
    // worktree JSON is written anymore. confirm reads/resolves via PG; the
    // FS overwrite there only services pre-P-077 promotion files.

    const notesPath = join(fromPath, '.papercusp', 'supervisor-notes.md');
    const block = `\n## promotion ${new Date().toISOString()}\n\nFeature freeze initiated. Only process failing features. Emit promotion-handoff.md when all features passed.\nPromotion item: ${id}\n`;
    await appendFile(notesPath, block, 'utf8');

    return Response.json({ ok: true, item });
  },
});

const confirmPromotion = defineTool({
  method: 'POST',
  path: '/harness/:slug/promote/:id/confirm',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');

    // PG is canonical (audit P-077): look the promotion up in pending_reviews
    // instead of scanning phase worktrees for a JSON file.
    const { db } = (await import('@papercusp/db-org')).getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq } = await import('drizzle-orm');
    const prev = generated.pendingReviewsInHarnessShared;
    const rows = await db
      .select({ payload: prev.payload, phase: prev.phase, resolved: prev.resolved })
      .from(prev)
      .where(and(
        eq(prev.workspaceId, activeWorkspaceId()),
        eq(prev.harnessSlug, project.slug),
        eq(prev.reviewId, id),
      ))
      .limit(1);
    if (!rows.length) return Response.json({ error: 'promotion not found' }, { status: 404 });

    const obj = { ...(rows[0].payload as any) };
    if (obj.kind !== 'promotion') return Response.json({ error: 'not a promotion item' }, { status: 400 });
    if (rows[0].resolved || obj.resolved) return Response.json({ error: 'already resolved' }, { status: 409 });

    const from = phasePhaseLabel(obj.from);
    const to = phasePhaseLabel(obj.to);
    const fromPath = phasePath(project, from);
    const toPath = phasePath(project, to);
    const fromBranch = from === 'staging' ? 'main' : from;

    try {
      await runGovernedOperation(
        {
          workspaceId: activeWorkspaceId(),
          namespace: 'harness-promotion',
          owner: `harness:${project.slug}:promotion`,
          admissionClass: 'process',
          demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
          payloadRef: `harness:${project.slug}:promotion:${id}`,
          metadata: { harness: project.slug, from, to },
        },
        async () => {
          try {
            execFileSync('git', ['-C', toPath, 'fetch', project.path, fromBranch], { encoding: 'utf8' });
            execFileSync('git', ['-C', toPath, 'merge', '--ff-only', `FETCH_HEAD`], { encoding: 'utf8' });
          } catch {
            execFileSync('git', ['-C', toPath, 'merge', '--no-edit', fromBranch], { encoding: 'utf8' });
          }
        },
      );
    } catch (error: any) {
      return Response.json({ error: `merge failed: ${String(error?.stderr ?? error?.message ?? error)}` }, { status: 500 });
    }

    // Layer 3 — pre-handoff smoke-build (opt-in by infra-contract.json or
    // explicit config). On failure, reset destination to ORIG_HEAD,
    // file a fix-the-build feature, reject the promotion.
    let smokeEnabled = false;
    try {
      const effCfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      const explicit = (effCfg?.promotion as Record<string, any> | undefined)?.smokeBuild?.enabled;
      if (typeof explicit === 'boolean') smokeEnabled = explicit;
      else smokeEnabled = existsSync(join(project.path, '.papercusp', 'infra-contract.json'));
    } catch { /* fall through with smokeEnabled=false */ }

    if (smokeEnabled) {
      try {
        const { runAction, listActions } = await import('../../../branch-actions');
        const harnessConfigsDir = papercuspPath('harnesses', project.slug);
        const globalPluginsDir = papercuspPath('global-plugins');
        const candidates = await listActions(project.path, to as 'staging' | 'testing' | 'production', {
          harnessConfigsDir, globalPluginsDir,
        });
        const buildAction = candidates.find((a) => a.name === 'build') ?? candidates[0];
        if (buildAction) {
          const handle = await runAction({
            stagingPath: project.path,
            phasePath: toPath,
            harness: project.slug,
            branch: to as 'staging' | 'testing' | 'production',
            name: buildAction.name,
            harnessConfigsDir, globalPluginsDir,
            skipEnvCheck: true,
          });
          const meta = await handle.done;
          if (meta.status !== 'completed') {
            try {
              execFileSync('git', ['-C', toPath, 'reset', '--hard', 'ORIG_HEAD'], { encoding: 'utf8' });
            } catch { /* observable in dest worktree git status */ }
            try {
              const fid = `F-INFRA-FIX-PROMOTION-${Math.floor(Date.now() / 1000)}`;
              const tail = (() => {
                try {
                  const log = safeRead(join(buildAction.scriptPath.replace(/\/[^/]+$/, ''), '..', '..', 'action-runs', to, buildAction.name, `${meta.runId}.log`));
                  return (log ?? '').split('\n').slice(-30).join('\n').slice(0, 2000);
                } catch { return '(see action-runs log)'; }
              })();
              const summary = `The destination worktree's build script failed during promotion (runId=${meta.runId}, exit=${meta.exitCode ?? '?'}, dur=${meta.durationMs ?? 0}ms). Last log lines:\n\n\`\`\`\n${tail}\n\`\`\`\n\nThe merge has been reverted. Fix the build on the ${from} branch (or update the build script accordingly) and re-attempt promotion.`;
              const nowTs = Date.now();
              await harnessQuery(project.slug, (sql) => sql`
                INSERT INTO harness_features (harness_slug, feature_id, title, summary, status, attempts, kind, metadata, ts, created_ts, updated_ts)
                VALUES (
                  ${project.slug}, ${fid},
                  ${`Fix broken build before re-promoting ${from} → ${to}`},
                  ${summary},
                  'todo',
                  0,
                  'infra',
                  ${JSON.stringify({ proposed_by: 'promotion-smoke-build', smoke_run_id: meta.runId, blocked_promotion: id })}::text::jsonb,
                  ${nowTs}, ${nowTs}, ${nowTs}
                )
              `);
            } catch { /* feature creation best-effort */ }

            return Response.json({
              error: 'smoke-build failed',
              runId: meta.runId,
              exitCode: meta.exitCode,
              reverted: true,
              message: `The build for ${to} did not pass post-merge. The merge has been reverted; a fix-the-build feature was created. See OperatorActionLog for the run.`,
            }, { status: 422 });
          }
        }
      } catch (e) {
        // Smoke-build infra failed — don't block the promotion; merge succeeded.
         
        console.warn(`[promotion] smoke-build skipped due to error: ${(e as Error).message}`);
      }
    }

    let newSha = '';
    try { newSha = execFileSync('git', ['-C', toPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
    {
      const hp = generated.harnessPromotionsInHarnessShared;
      await db
        .insert(hp)
        .values({
          workspaceId: activeWorkspaceId(),
          harnessSlug: project.slug,
          promotionId: obj.id,
          fromPhase: from,
          toPhase: to,
          sha: newSha || null,
          ts: Math.floor(Date.now() / 1000),
        })
        .onConflictDoNothing();
    }

    try {
      const feats = await parseFeatures({ ...project, path: fromPath });
      const passed = feats.filter((f: any) => f.status === 'passed');
      const handoff = [
        `# Promotion handoff: ${from} → ${to}`,
        ``,
        `Handed off at ${new Date().toISOString()}.`,
        ``,
        `## Features that passed in ${from}`,
        '',
        ...passed.map((f: any) => `- \`${f.id}\` — ${f.summary ?? f.title}`),
        ``,
        `## Validation`,
        ``,
        // validation-contract.md is deprecated (D-005); acceptance is now each
        // feature's inline VAL-* assertions (harness_plan_assertions).
        `Each feature's acceptance is its inline VAL-* assertions — resolve via GET /api/harness/${project.slug}/assertion/:valId.`,
      ].join('\n');
      await writeFile(join(toPath, '.papercusp', 'promotion-handoff.md'), handoff, 'utf8');
    } catch { /* best-effort handoff */ }

    obj.resolved = true;
    obj.status = 'promoted';
    await db
      .update(prev)
      .set({ resolved: true, payload: obj as any })
      .where(and(
        eq(prev.workspaceId, activeWorkspaceId()),
        eq(prev.harnessSlug, project.slug),
        eq(prev.phase, rows[0].phase),
        eq(prev.reviewId, id),
      ));
    void notifySyncInvalidate('pendingReviews.byHarness', { harnessSlug: project.slug });
    // FS back-compat: a pre-P-077 promotion wrote a JSON into its from-phase
    // worktree. Overwrite it in place when present (never create one) — the
    // watcher's deleteReview is unconditional and a stale unresolved file
    // would clobber the PG row we just resolved.
    for (const phase of PHASE_ORDER) {
      const legacy = join(phasePath(project, phase), '.papercusp', 'pending-reviews', `${id}.json`);
      if (existsSync(legacy)) {
        await writeFile(legacy, JSON.stringify(obj, null, 2), 'utf8');
        break;
      }
    }

    return Response.json({ ok: true, sha: newSha, promotion: obj });
  },
});

const rollback = defineTool({
  method: 'POST',
  path: '/harness/:slug/rollback',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as { phase?: string };
    const phase = phasePhaseLabel(body.phase);
    const path = phasePath(project, phase);
    if (!existsSync(path)) return Response.json({ error: `no worktree for ${phase}` }, { status: 400 });

    const { db } = (await import('@papercusp/db-org')).getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, desc, eq } = await import('drizzle-orm');
    const hp = generated.harnessPromotionsInHarnessShared;
    const promotions = await db
      .select({ promotionId: hp.promotionId, sha: hp.sha, ts: hp.ts })
      .from(hp)
      .where(and(eq(hp.workspaceId, activeWorkspaceId()), eq(hp.harnessSlug, project.slug), eq(hp.toPhase, phase)))
      .orderBy(desc(hp.ts))
      .limit(10);
    if (promotions.length < 2) return Response.json({ error: 'no previous promotion to roll back to' }, { status: 400 });
    const prior = promotions[1];
    if (!prior.sha) return Response.json({ error: 'previous promotion has no sha' }, { status: 400 });

    try {
      execFileSync('git', ['-C', path, 'reset', '--hard', prior.sha], { encoding: 'utf8' });
    } catch (e: any) {
      return Response.json({ error: `rollback failed: ${String(e?.stderr ?? e?.message ?? e)}` }, { status: 500 });
    }

    await db.insert(hp).values({
      workspaceId: activeWorkspaceId(),
      harnessSlug: project.slug,
      promotionId: `rollback-${Date.now()}`,
      fromPhase: phase,
      toPhase: phase,
      sha: prior.sha,
      ts: Math.floor(Date.now() / 1000),
    });

    return Response.json({ ok: true, rolledBackTo: prior.sha });
  },
});

export default [promote, confirmPromotion, rollback];
