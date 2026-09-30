/**
 * Read-only data functions for harness routes that the MCP tools also
 * project. Function-of-truth pattern: each function below is the single
 * implementation; the hono route at app/api/_hono/harness.ts and the
 * defineTool entries at lib/agent-tools/harness/* both call into here.
 *
 * Helpers (resolveProject, parseFeatures, harnessDir, etc.) live in
 * the hono module — this file imports them rather than duplicating.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, desc, eq } from 'drizzle-orm';
import {
  aggregateCostFromLogDir,
  countPulsesFromRunLog,
  harnessDir,
  isProjectAlive,
  parseFeatures,
  resolveProject,
  resolvePhasedProject,
  safeRead,
  tailFile,
} from './harness-core';
import { phasePhaseLabel, type Phase } from './harness-phases';
import type { ProjectEntry } from './harness-registry';

export type HarnessReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 404; error: string };

// ── escalation ──────────────────────────────────────────────────────

export interface EscalationData {
  escalation: string | null;
  supervisorNotes: string | null;
  mtimeMs: number | null;
}

export async function getEscalation(
  slug: string,
  phase?: string,
): Promise<HarnessReadResult<EscalationData>> {
  const project = await resolvePhasedProject(slug, phasePhaseLabel(phase));
  if (!project) return { ok: false, status: 404, error: 'unknown project' };
  const escalationPath = join(harnessDir(project), 'escalation.md');
  const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(escalationPath).mtimeMs;
  } catch {
    /* missing file — null mtime */
  }
  const { loadTextArtifact } = await import('./text-artifacts');
  const { activeWorkspaceId } = await import('./workspace-registry');

  // Query harness_escalations (written by TS orchestrator + bash run.sh) first,
  // then fall back to harness_text_artifacts (written by harness-fs-watcher for
  // disk files), then finally the disk file itself.
  let pgEscalation: string | null = null;
  let pgMtimeMs: number | null = null;
  try {
    const { sql } = getOrgPg();
    const wid = activeWorkspaceId();
    const rows = phase
      ? await sql<{ escalation: string; mtime_ms: number }[]>`
          SELECT escalation, mtime_ms
            FROM harness_shared.harness_escalations
           WHERE workspace_id = ${wid}
             AND harness_slug = ${slug}
             AND phase = ${phase}
           LIMIT 1
        `
      : await sql<{ escalation: string; mtime_ms: number }[]>`
          SELECT escalation, mtime_ms
            FROM harness_shared.harness_escalations
           WHERE workspace_id = ${wid}
             AND harness_slug = ${slug}
           ORDER BY mtime_ms DESC
           LIMIT 1
        `;
    if (rows.length > 0) {
      pgEscalation = rows[0].escalation;
      pgMtimeMs = rows[0].mtime_ms;
    }
  } catch {
    /* table may not exist in older installs — fall through */
  }

  const [artifactEscalation, pgNotes] = await Promise.all([
    pgEscalation === null ? loadTextArtifact(slug, 'escalation.md') : Promise.resolve(null),
    loadTextArtifact(slug, 'supervisor-notes.md'),
  ]);

  return {
    ok: true,
    data: {
      escalation: pgEscalation ?? artifactEscalation ?? safeRead(escalationPath),
      supervisorNotes: pgNotes ?? safeRead(supervisorNotesPath),
      mtimeMs: pgMtimeMs ?? mtimeMs,
    },
  };
}

// ── reviews list ────────────────────────────────────────────────────

interface PendingReviewRow {
  payload: Record<string, unknown>;
  review_id: string;
  resolved: boolean;
  ts: number;
}

export interface ReviewsListData {
  reviews: Array<Record<string, unknown> & { id: string; resolved: boolean; ts: number }>;
}

export async function listPendingReviews(slug: string, phase: Phase): Promise<ReviewsListData> {
  const { db } = getOrgPg();
  // F-B2 (workspace-data-isolation-leaks): getOrgPg() bypasses RLS, so scope the
  // pending-reviews read to the active workspace explicitly (else a same-named
  // harness in another workspace leaks its reviews here).
  const { activeWorkspaceId } = await import('./workspace-registry');
  const t = generated.pendingReviewsInHarnessShared;
  const rows = await db
    .select({ payload: t.payload, review_id: t.reviewId, resolved: t.resolved, ts: t.ts })
    .from(t)
    .where(and(eq(t.workspaceId, activeWorkspaceId()), eq(t.harnessSlug, slug), eq(t.phase, phase), eq(t.resolved, false)))
    .orderBy(desc(t.ts));
  return {
    reviews: (rows as PendingReviewRow[]).map((r) => ({ ...r.payload, id: r.review_id, resolved: r.resolved, ts: r.ts })),
  };
}

// ── features list (slug+phase variant of /status:features[]) ────────

export interface FeaturesListData {
  features: Array<Record<string, unknown>>;
}

export async function listFeaturesForHarness(
  slug: string,
  phase: Phase,
): Promise<HarnessReadResult<FeaturesListData>> {
  const project = await resolvePhasedProject(slug, phase);
  if (!project) return { ok: false, status: 404, error: 'unknown project' };
  const features = await parseFeatures(project);
  return { ok: true, data: { features } };
}

// ── health (large surface — mirrors GET /:slug/health) ──────────────

export interface HealthData {
  ok: boolean;
  alive: boolean;
  escalated: boolean;
  features: { total: number; passed: number; failing: number; inProgress: number; blocked: number };
  lastRunAgeSeconds: number | null;
  ghostRate: number;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export async function getHealth(
  slug: string,
  opts?: { project?: ProjectEntry },
): Promise<HarnessReadResult<HealthData>> {
  const project = opts?.project ?? (await resolveProject(slug));
  if (!project) return { ok: false, status: 404, error: 'unknown project' };

  const features = await parseFeatures(project);
  const totalFeatures = features.length;
  const passed = features.filter((f) => f.status === 'passed' || f.status === 'done').length; // unify: done≈passed
  const failing = features.filter((f) => f.status === 'failing').length;
  const inProgress = features.filter(
    (f) => f.status === 'in_progress' || f.status === 'validating',
  ).length;
  const blocked = features.filter((f) => f.status === 'blocked').length;

  const escalated = existsSync(join(harnessDir(project), 'escalation.md'));
  const alive = isProjectAlive(project.path);

  let lastRunMs = 0;
  try {
    const logDir = join(harnessDir(project), 'logs');
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) {
        if (!f.endsWith('.out') && !f.endsWith('.jsonl')) continue;
        try {
          const s = statSync(join(logDir, f));
          if (s.mtimeMs > lastRunMs) lastRunMs = s.mtimeMs;
        } catch {
          /* ignore unreadable log file */
        }
      }
    }
  } catch {
    /* ignore unreadable log dir */
  }
  const lastRunAgeSeconds = lastRunMs ? Math.floor((Date.now() - lastRunMs) / 1000) : null;

  const runLog = tailFile(join(harnessDir(project), 'logs', 'run.log'), 128 * 1024);
  const decLines = [...runLog.matchAll(/^\[[^\]]+\] ORCH decision:\s*(\S+)/gm)];
  const knownVerbs = new Set([
    'NEXT_WORKER',
    'NEXT_VALIDATOR',
    'NEXT_ARCHITECT',
    'ESCALATE',
    'CONVERTED',
    'DONE',
  ]);
  const ghosts = decLines.filter((m) => !knownVerbs.has(m[1])).length;
  const ghostRate = decLines.length > 0 ? ghosts / decLines.length : 0;

  let pendingCheckpoints = 0;
  try {
    for (const f of readdirSync(harnessDir(project))) {
      if (
        /^checkpoint-[A-Za-z0-9_.-]+\.md$/.test(f) &&
        !existsSync(join(harnessDir(project), `${f}.granted`))
      ) {
        pendingCheckpoints += 1;
      }
    }
  } catch {
    /* ignore */
  }

  const smokeFail = existsSync(join(harnessDir(project), 'smoke-failure.md'));

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [
    // SPEC.md (spec_present) and validation-contract.md (contract_present)
    // were dropped here: plans replaced both as the authoritative
    // scope/acceptance surface (plans-central-harness-ux-2026-05-26,
    // D-004/D-005). A plan-native harness has neither file, so gating
    // health on them would flag every current harness unhealthy.
    // features_present already covers "has this harness been given work".
    { name: 'features_present', ok: features.length > 0 },
    { name: 'not_escalated', ok: !escalated, detail: escalated ? 'see escalation.md' : undefined },
    {
      name: 'no_pending_checkpoints',
      ok: pendingCheckpoints === 0,
      detail: pendingCheckpoints > 0 ? `${pendingCheckpoints} awaiting grant` : undefined,
    },
    {
      name: 'smoke_test_clean',
      ok: !smokeFail,
      detail: smokeFail ? 'last smoke test failed' : undefined,
    },
    {
      name: 'recent_activity',
      ok: lastRunAgeSeconds !== null && lastRunAgeSeconds < 600,
      detail:
        lastRunAgeSeconds !== null ? `${lastRunAgeSeconds}s since last run` : 'no runs',
    },
    {
      name: 'low_ghost_rate',
      ok: ghostRate < 0.1,
      detail: `${ghosts}/${decLines.length} parser ghosts`,
    },
    {
      name: 'not_stuck',
      ok: failing === 0 || inProgress > 0,
      detail: `${failing} failing, ${inProgress} in progress`,
    },
  ];
  const overallOk = checks.every((c) => c.ok);

  // Touch the cost aggregator and pulse counter so they stay reachable
  // (used by the broader status route; leaving them imported keeps the
  // export surface stable for follow-on lib code).
  void aggregateCostFromLogDir;
  void countPulsesFromRunLog;

  return {
    ok: true,
    data: {
      ok: overallOk,
      alive,
      escalated,
      features: { total: totalFeatures, passed, failing, inProgress, blocked },
      lastRunAgeSeconds,
      ghostRate,
      checks,
    },
  };
}

// ── wave progress (promote-policy-and-waves P-011) ──────────────────

export interface WaveCounts {
  total: number;
  passed: number;
  failing: number;
  inProgress: number;
  blocked: number;
}

export interface WaveProgressData {
  /** Plan slug this wave data belongs to. */
  planSlug: string;
  /** Ordered waves (wave ids in the order features were promoted). */
  waves: string[];
  /** Per-wave counts keyed by wave id. */
  byWave: Record<string, WaveCounts>;
  /** Overall totals across all waves from this plan. */
  totals: WaveCounts;
}

/**
 * Compute per-wave feature counts for a given plan in a harness.
 *
 * Reads `harness_features_consolidated` WHERE `source_plan_slug = planSlug`
 * and groups the results by `wave`. Wave order is by first seen (the order
 * features were promoted, approximated by created_ts).
 */
export async function getWaveProgress(
  harnessSlug: string,
  planSlug: string,
): Promise<HarnessReadResult<WaveProgressData>> {
  try {
    const { sql } = getOrgPg();
    // F-B1 (workspace-data-isolation-leaks): getOrgPg() bypasses RLS — scope to
    // the active workspace so wave counts don't aggregate a same-named harness
    // across workspaces.
    const { activeWorkspaceId } = await import('./workspace-registry');
    const rows = await sql<{
      wave: string | null;
      status: string;
      created_ts: number | bigint | null;
    }[]>`
      SELECT wave, status, created_ts
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id     = ${activeWorkspaceId()}
         AND harness_slug     = ${harnessSlug}
         AND source_plan_slug = ${planSlug}
       ORDER BY created_ts ASC NULLS LAST
    `;

    const byWave: Record<string, WaveCounts> = {};
    const waveOrder: string[] = [];

    for (const r of rows) {
      const wave = r.wave ?? '(no wave)';
      if (!byWave[wave]) {
        byWave[wave] = { total: 0, passed: 0, failing: 0, inProgress: 0, blocked: 0 };
        waveOrder.push(wave);
      }
      const c = byWave[wave]!;
      c.total += 1;
      const s = r.status;
      if (s === 'passed' || s === 'done') c.passed += 1; // unify: done≈passed
      else if (s === 'failing') c.failing += 1;
      else if (s === 'in_progress' || s === 'validating') c.inProgress += 1;
      else if (s === 'blocked') c.blocked += 1;
    }

    const totals: WaveCounts = { total: 0, passed: 0, failing: 0, inProgress: 0, blocked: 0 };
    for (const c of Object.values(byWave)) {
      totals.total += c.total;
      totals.passed += c.passed;
      totals.failing += c.failing;
      totals.inProgress += c.inProgress;
      totals.blocked += c.blocked;
    }

    return {
      ok: true,
      data: { planSlug, waves: waveOrder, byWave, totals },
    };
  } catch (e) {
    return { ok: false, status: 404, error: String(e) };
  }
}
