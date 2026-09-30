/**
 * launchRun — spawn the legacy TS orchestrator whole-loop entry
 * (`orchestrator/bin/run.ts`) for a project, detached.
 *
 * ⚠ LEGACY / SUPERSEDED. The live orchestrator is the in-process DBOS
 * durable pipeline (`dbos/orchestrator-workflow.ts`) + one-shot
 * invoke-once, NOT this whole-loop subprocess. `orchestrator/bin/run.ts`
 * was archived 2026-06-06 (archive-legacy-orchestrator-deadcode) to
 * `libs/papercusp/_retired/orchestrator-run-loop/`, so `orchestratorRunBin()`
 * now resolves to a missing file and `launchRun` returns
 * `{ ok: false, error: 'orchestrator bin missing' }`. The launch / resume /
 * replan routes that still call this are the raw-spawn bypass slated for
 * re-routing to the governed DBOS chokepoint by
 * `unify-agent-spawn-chokepoint-2026-06-06` (P-008). The bash `run.sh` was
 * deleted 2026-05-30.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 40 — Na carve-out unblocks the spawn cluster).
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { orchestratorRunBin, tsxBin, harnessPackageDir } from './harness-paths';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import type { ProjectEntry } from './harness-registry';

export async function launchRun(
  project: ProjectEntry,
  extra?: string,
): Promise<{ ok: true; logPath: string } | { ok: false; error: string }> {
  const orchBin = orchestratorRunBin();
  if (!existsSync(orchBin)) return { ok: false, error: 'orchestrator bin missing' };
  const logPath = `/tmp/harness-${project.slug}.log`;
  const cmd = `nohup node ${tsxBin()} ${orchBin} >> ${logPath} 2>&1 &`;

  // Decrypt search-provider keys from PG (Migration 047) and pass them
  // through as env vars so OMP's web_search providers can see them.
  // Each spawned worker/validator/etc. inherits these from the
  // orchestrator's env. Best-effort: if PG is down or no keys are
  // configured, the orchestrator simply runs without them.
  let searchProviderEnv: Record<string, string> = {};
  try {
    const { buildSpawnEnv } = await import('./search-provider-credentials');
    searchProviderEnv = await buildSpawnEnv();
  } catch {
    // PG unavailable / encryption key missing — proceed with no keys.
  }

  const child = spawn('bash', ['-c', cmd], {
    cwd: project.path,
    env: {
      ...process.env,
      AGENT_CMD: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
      CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
      HARNESS_DIR: harnessPackageDir(),
      PROJECT_DIR: project.path,
      HARNESS_SLUG: project.slug,
      // PG is the canonical feature store. Without this, the
      // orchestrator's in-memory fallback (designed for tests) yields
      // an empty store, pre-loop's featuresExist() returns false, and
      // the scoper-gate fails on every launch even though PG has the
      // feature queue.
      PAPERCUSP_USE_PG_STATE: '1',
      // spawn-mcp reads DATABASE_URL (or PAPERCUSP_PG_DSN) to load its
      // signing key from harness_shared.operator_secrets. Without it,
      // every tool invocation hits "no PG DSN in env" and the
      // orchestrator hits no-tools, decides it can't do anything, and
      // immediately escalates. We use the operator's own resolved
      // admin URL (env → discovery file → native fallback) so the
      // spawned orchestrator hits the exact same Postgres the operator
      // uses, not a stale hardcoded default.
      DATABASE_URL: getHarnessAdminUrl(),
      ...searchProviderEnv,
      ...(extra
        ? Object.fromEntries(
            extra
              .split(/\s+/)
              .filter(Boolean)
              .map((kv: string) => kv.split('=')),
          )
        : {}),
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, logPath };
}
