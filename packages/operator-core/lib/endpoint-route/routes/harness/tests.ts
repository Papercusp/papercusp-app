/**
 * Per-phase tests tab:
 *
 *   GET  /api/harness/:slug/tests              — list tests for the resolved phase
 *   POST /api/harness/:slug/tests/:id/run      — execute a test via playwright/vitest/pytest/cargo/shell; update status
 *
 * V1 ship-state gate: both routes return 404 when FLAGS.HARNESS_PHASES is
 * off — the tests tab is phase-coupled per the harness-phases plan.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 34). Helpers `readTests` / `writeTests` / interface `TestItem`
 * were inlined here (they had no other callers).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { type ProjectEntry } from '../../../harness-registry';
import { type Phase, phasePhaseLabel, phasePath } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

export interface TestItem {
  id: string;
  summary: string;
  /**
   * For 'playwright' | 'vitest' | 'pytest': a repo-relative test file path,
   * passed straight to the runner. For 'cargo': the repo-relative directory
   * containing the crate's Cargo.toml (cargo runs `cargo test` from that
   * directory — there is no single-file equivalent, since cargo organizes
   * tests by crate/target, not by source file). For 'shell': a repo-relative
   * path to an executable script, run directly via `bash` (so the +x bit
   * isn't required) from the worktree root.
   */
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest' | 'cargo' | 'shell';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
  phase: Phase;
  kind?: 'contract' | 'edge';
}

/** Resolve the (bin, args, cwd) to execFileSync for one TestItem's framework. */
export function buildRunCommand(t: TestItem, wtPath: string): { bin: string; args: string[]; cwd: string } {
  switch (t.framework) {
    case 'playwright':
      return { bin: 'npx', args: ['playwright', 'test', t.file], cwd: wtPath };
    case 'vitest':
      return { bin: 'npx', args: ['vitest', 'run', t.file], cwd: wtPath };
    case 'pytest':
      return { bin: 'pytest', args: [t.file], cwd: wtPath };
    case 'cargo':
      return { bin: 'cargo', args: ['test'], cwd: join(wtPath, t.file) };
    case 'shell':
      return { bin: 'bash', args: [join(wtPath, t.file)], cwd: wtPath };
  }
}

function readTests(project: ProjectEntry, phase: Phase): TestItem[] {
  const p = phasePath(project, phase);
  const f = join(p, '.papercusp', 'tests.json');
  const raw = safeRead(f);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed.tests ?? [];
  } catch { return []; }
}

async function writeTests(project: ProjectEntry, phase: Phase, tests: TestItem[]): Promise<void> {
  const p = phasePath(project, phase);
  const dir = join(p, '.papercusp');
  await mkdir(dir, { recursive: true });
  const f = join(dir, 'tests.json');
  const tmp = `${f}.tmp.${Date.now()}`;
  await writeFile(tmp, JSON.stringify({ tests }, null, 2), 'utf8');
  await rename(tmp, f);
}

async function phasesEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.HARNESS_PHASES, 'system');
}

const listTests = defineTool({
  method: 'GET',
  path: '/harness/:slug/tests',
  auth: 'public',
  async handler(req, ctx) {
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
    const url = new URL(req.url);
    const phase = phasePhaseLabel(url.searchParams.get('phase') ?? undefined);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    return Response.json({ tests: readTests(project, phase), phase });
  },
});

const runTest = defineTool({
  method: 'POST',
  path: '/harness/:slug/tests/:id/run',
  auth: 'loopback',
  async handler(req, ctx) {
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
    const url = new URL(req.url);
    const phase = phasePhaseLabel(url.searchParams.get('phase') ?? undefined);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');
    const tests = readTests(project, phase);
    const t = tests.find((x) => x.id === id);
    if (!t) return Response.json({ error: 'test not found' }, { status: 404 });

    const wtPath = phasePath(project, phase);
    const started = Date.now();
    const { bin, args, cwd } = buildRunCommand(t, wtPath);
    const executionResult = await runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'harness-test-run',
        owner: `harness:${project.slug}:test`,
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `harness:${project.slug}:test:${id}`,
        metadata: { harness: project.slug, testId: id },
      },
      async () => {
        try {
          return {
            ok: true,
            output: execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }),
          };
        } catch (e: any) {
          return { ok: false, output: String(e?.stdout ?? '') + String(e?.stderr ?? '') };
        }
      },
    );
    const { ok, output } = executionResult;
    const durationMs = Date.now() - started;
    t.status = ok ? 'passing' : 'failing';
    t.lastRunTs = Math.floor(Date.now() / 1000);
    t.durationMs = durationMs;
    await writeTests(project, phase, tests);

    return Response.json({ ok, test: t, output: output.slice(-4000) });
  },
});

export default [listTests, runTest];
