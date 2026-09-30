/**
 * Adaptive-mode telemetry endpoints:
 *
 *   GET   /api/harness/:slug/orchestrator/adaptive-telemetry      — list rows
 *   POST  /api/harness/:slug/orchestrator/adaptive-telemetry      — record a
 *         NEXT_WORKER decision; returns { id } so the caller can attach an outcome
 *   PATCH /api/harness/:slug/orchestrator/adaptive-telemetry/:id  — attach an
 *         outcome ('pass'|'fail'|'cancelled') + duration / synthesis result
 *
 * The orchestrator main-loop calls POST from handleNextWorker and PATCH
 * from the validator post-hook. Failures are best-effort — telemetry must
 * never block agent dispatch.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 10).
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../../../harness-core';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const getTelemetry = defineTool({
  method: 'GET',
  path: '/harness/:slug/orchestrator/adaptive-telemetry',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? 200);
    const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 200));
    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { desc, eq } = await import('drizzle-orm');
    const at = generated.adaptiveTelemetryInHarnessShared;
    const rows = await db
      .select({
        id: at.id,
        ts: at.ts,
        featureId: at.featureId,
        requested_n: at.requestedN,
        actual_n: at.actualN,
        tier_label: at.tierLabel,
        available_at_decision: at.availableAtDecision,
        max_slots: at.maxSlots,
        outcome: at.outcome,
        outcome_ts: at.outcomeTs,
        duration_ms: at.durationMs,
        synthesized: at.synthesized,
        synthesis_error: at.synthesisError,
      })
      .from(at)
      .where(eq(at.harnessSlug, project.slug))
      .orderBy(desc(at.ts))
      .limit(limit);
    return Response.json({ rows });
  },
});

const postTelemetry = defineTool({
  method: 'POST',
  path: '/harness/:slug/orchestrator/adaptive-telemetry',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    let body: {
      featureId?: string;
      requestedN?: number;
      actualN?: number;
      tierLabel?: string | null;
      availableAtDecision?: number | null;
      maxSlots?: number | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.featureId || typeof body.featureId !== 'string') {
      return Response.json({ error: 'featureId required' }, { status: 400 });
    }
    const requestedN = Number(body.requestedN);
    const actualN = Number(body.actualN);
    if (!Number.isInteger(requestedN) || !Number.isInteger(actualN) || actualN < 1) {
      return Response.json({ error: 'requestedN/actualN must be positive integers' }, { status: 400 });
    }
    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const at = generated.adaptiveTelemetryInHarnessShared;
    const ws = activeWorkspaceId();
    const rows = await db
      .insert(at)
      .values({
        harnessSlug: project.slug,
        ts: Date.now(),
        featureId: body.featureId,
        requestedN: requestedN,
        actualN: actualN,
        tierLabel: body.tierLabel ?? null,
        availableAtDecision: body.availableAtDecision ?? null,
        maxSlots: body.maxSlots ?? null,
        workspaceId: ws,
      })
      .returning({ id: at.id });
    return Response.json({ ok: true, id: rows[0]?.id ?? null });
  },
});

const patchTelemetry = defineTool({
  method: 'PATCH',
  path: '/harness/:slug/orchestrator/adaptive-telemetry/:id',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: 'invalid id' }, { status: 400 });
    let body: {
      outcome?: string;
      durationMs?: number | null;
      synthesized?: boolean | null;
      synthesisError?: string | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const hasOutcome = body.outcome !== undefined;
    const hasSynth = body.synthesized !== undefined;
    if (!hasOutcome && !hasSynth) {
      return Response.json({ error: "expected 'outcome' and/or 'synthesized' field" }, { status: 400 });
    }
    if (hasOutcome && !['pass', 'fail', 'cancelled'].includes(body.outcome!)) {
      return Response.json({ error: "outcome must be one of 'pass'|'fail'|'cancelled'" }, { status: 400 });
    }
    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq } = await import('drizzle-orm');
    const at = generated.adaptiveTelemetryInHarnessShared;
    const update: Record<string, unknown> = {};
    if (hasOutcome) {
      update.outcome = body.outcome;
      update.outcomeTs = Date.now();
      update.durationMs = body.durationMs ?? null;
    }
    if (hasSynth) {
      update.synthesized = body.synthesized;
      update.synthesisError = body.synthesisError ?? null;
    }
    await db
      .update(at)
      .set(update)
      .where(and(eq(at.id, BigInt(id)), eq(at.harnessSlug, project.slug)));
    return Response.json({ ok: true });
  },
});

export default [getTelemetry, postTelemetry, patchTelemetry];
