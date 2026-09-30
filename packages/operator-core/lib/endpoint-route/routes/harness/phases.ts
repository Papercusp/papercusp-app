/**
 * Harness phase pipeline — read phase state + provision phase worktrees:
 *
 *   GET  /api/harness/:slug/phases        — per-phase state (staging/testing/production)
 *   POST /api/harness/:slug/phases/setup  — run bin/setup-phases.sh
 *
 * The promote / promote-confirm / rollback routes stay in
 * `_hono/harness.ts` for a later batch.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 24).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  resolvePhasedProject, safeRead, parseFeatures,
  aggregateCostFromLogDir, countPulsesFromRunLog, isHarnessDriverCmdline,
} from '../../../harness-core';
import { phasePhaseLabel, phasePath, ALL_PHASES, type Phase } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

interface PhaseInfo {
  phase: Phase;
  path: string;
  branch: string;
  port: number | null;
  publicUrl: string | null;
  exists: boolean;
  alive: boolean;
  passed: number;
  total: number;
  cost: number;
  iteration: number;
  promotionInFlight: string | null;
}

/**
 * One-shot /proc scan for run.sh harness processes — (pid, cwd) pairs,
 * cached 5s on globalThis. Walking /proc per-phase × per-page dominated
 * the /phases endpoint's app-code time on busy hosts.
 */
type ScanCacheEntry = { ts: number; value: Array<{ pid: string; cwd: string }> };
// Realm-pinned rather than hand-rolled on globalThis: a split module record would
// give each copy its own 5s cache, silently restoring the per-phase × per-page /proc
// walk this exists to collapse. Key string unchanged.
const scanCacheState = pinModuleState<{ entry: ScanCacheEntry | null }>(
  '__papercuspRunShScanCache',
  () => ({ entry: null }),
);
function scanRunShProcesses(): Array<{ pid: string; cwd: string }> {
  const now = Date.now();
  const cached = scanCacheState.entry;
  if (cached && now - cached.ts < 5000) return cached.value;

  const out: Array<{ pid: string; cwd: string }> = [];
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!isHarnessDriverCmdline(cmdline)) continue;
        const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8').trim();
        out.push({ pid, cwd });
      } catch { /* proc went away or unreadable — skip */ }
    }
  } catch {}
  scanCacheState.entry = { ts: now, value: out };
  return out;
}

async function computePhaseInfo(
  project: ProjectEntry,
  phase: Phase,
  runShProcs?: Array<{ pid: string; cwd: string }>,
  preFetchedFeatures?: Array<{ status?: string }>,
): Promise<PhaseInfo> {
  const path = phasePath(project, phase);
  const branch = phase === 'staging'
    ? (safeRead(join(project.path, '.git', 'HEAD'))?.trim().replace(/^ref: refs\/heads\//, '') ?? 'main')
    : phase;
  const scopedProject: ProjectEntry = { ...project, path };
  const exists = existsSync(path);

  let port: number | null = null;
  let publicUrl: string | null = null;
  // Per-phase port/publicUrl now live in the workspace-PG registry ProjectEntry
  // (deprecate-harness-config-json-2026-06-06), carried on the resolved project's
  // `phases` blob — no config.json read.
  const phaseCfg = project.phases?.[phase];
  if (phaseCfg) {
    if (typeof phaseCfg.port === 'number') port = phaseCfg.port;
    if (typeof phaseCfg.publicUrl === 'string' && phaseCfg.publicUrl.length > 0) publicUrl = phaseCfg.publicUrl;
  }

  if (!exists) {
    return { phase, path, branch, port, publicUrl, exists: false, alive: false, passed: 0, total: 0, cost: 0, iteration: 0, promotionInFlight: null };
  }

  const feats = preFetchedFeatures ?? await parseFeatures(scopedProject);
  const counts = feats.reduce((a: Record<string, number>, f) => { a[f.status ?? ''] = (a[f.status ?? ''] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const passed = counts.passed ?? 0;
  const total = feats.length;

  const cost = aggregateCostFromLogDir(join(path, '.papercusp', 'logs')).cost;
  const iteration = countPulsesFromRunLog(join(path, '.papercusp', 'logs', 'run.log'));

  const procs = runShProcs ?? scanRunShProcesses();
  const alive = procs.some((p) => p.cwd.startsWith(path));

  // promotion in-flight = any unresolved Promotion item in pending-reviews
  let promotionInFlight: string | null = null;
  try {
    const pr = join(path, '.papercusp', 'pending-reviews');
    if (existsSync(pr)) {
      for (const f of readdirSync(pr)) {
        if (!f.endsWith('.json')) continue;
        try {
          const obj = JSON.parse(readFileSync(join(pr, f), 'utf8'));
          if (obj.kind === 'promotion' && !obj.resolved) {
            promotionInFlight = obj.id;
            break;
          }
        } catch {}
      }
    }
  } catch {}

  return { phase, path, branch, port, publicUrl, exists, alive, passed, total, cost, iteration, promotionInFlight };
}

const getPhases = defineTool({
  method: 'GET',
  path: '/harness/:slug/phases',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    // Pre-fetch features + scan procs ONCE — shared across all phases.
    const runShProcs = scanRunShProcesses();
    const features = await parseFeatures(project);
    const out = await Promise.all(
      [...ALL_PHASES].map((p) => computePhaseInfo(project, p, runShProcs, features)),
    );
    return Response.json({ phases: out });
  },
});

const setupPhases = defineTool({
  method: 'POST',
  path: '/harness/:slug/phases/setup',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const script = harnessPath('bin', 'setup-phases.sh');
    if (!existsSync(script)) return Response.json({ error: 'setup-phases.sh missing' }, { status: 500 });
    try {
      const out = await runGovernedOperation(
        {
          workspaceId: activeWorkspaceId(),
          namespace: 'harness-phase-setup',
          owner: `harness:${project.slug}:phases`,
          admissionClass: 'process',
          demand: { cpuWeight: 0.5, memoryBytes: 128 * 1024 * 1024, fileDescriptors: 3 },
          payloadRef: `harness:${project.slug}:phase-setup`,
          metadata: { harness: project.slug },
        },
        async () => execFileSync('bash', [script, project.path], { encoding: 'utf8', timeout: 30_000 }),
      );
      return Response.json({ ok: true, output: out });
    } catch (e: any) {
      return Response.json({ error: String(e?.stderr ?? e?.message ?? e) }, { status: 500 });
    }
  },
});

export default [getPhases, setupPhases];
