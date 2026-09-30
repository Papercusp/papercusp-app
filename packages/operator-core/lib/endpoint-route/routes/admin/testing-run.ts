/**
 * POST /api/admin/testing/run — start a detached test run.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014/P-015.
 *
 * Body shape:
 *   { runner: TestRunner }
 *
 * Spawns the appropriate child process per runner.kind, returns the
 * runId. The SPA polls GET /api/admin/testing/run/:runId for status +
 * rolling output. SSE upgrade is a follow-up; polling matches the
 * existing /api/admin/testing/test-runs pattern.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { startRun, type SpawnRequest } from '../../../testing-run-store';
import { inferWorkspaceRoot, resolveNearestVitestConfig } from '../../../testing-domain-glob';

export type TestRunner =
  | { kind: 'vitest'; filePath: string }
  | { kind: 'vitest-multi'; filePaths: string[]; label?: string }
  | { kind: 'playwright'; filePath: string }
  // `manifestPath` (EI-1610): a standalone crate with no root Cargo.toml workspace
  // can't be reached via `-p <crate>` from the repo root; point cargo at the crate's
  // own manifest instead. Optional → the workspace `-p` path is unchanged.
  | { kind: 'cargo'; crate: string; test?: string; manifestPath?: string }
  | { kind: 'node'; cmd: string; args?: string[]; label?: string }
  | { kind: 'shell'; cmd: string; args?: string[]; label?: string };

export function toSpawn(runner: TestRunner): SpawnRequest | { error: string } {
  switch (runner.kind) {
    case 'vitest': {
      if (!runner.filePath) return { error: 'vitest requires filePath' };
      // No explicit --reporter flag: vitest CLI's --reporter REPLACES the
      // config-side reporter list, which would drop the admin reporter that
      // writes per-file rows to test_runs (P-014). The merged config already
      // includes `default` via @papercusp/test-config.
      //
      // EI-8902: a bare `npx vitest run <file>` with no `--config` runs with
      // ZERO Vite config whenever there's no root-level vitest.config.ts
      // (there isn't one — CLAUDE.md EI-7666), so any `@/`-aliased import
      // false-fails "Failed to resolve import" even though the file/code are
      // fine — this was silently feeding false-positive reds into
      // harness_shared.test_runs (the watchdog's red-test source) for every
      // apps/operator-vite test. Resolve + pass the nearest per-package
      // config, same as `npm run test:affected` already does.
      const configPath = resolveNearestVitestConfig(runner.filePath, inferWorkspaceRoot());
      return {
        kind: 'vitest',
        label: `vitest ${runner.filePath}`,
        filePath: runner.filePath,
        command: 'npx',
        args: ['vitest', 'run', ...(configPath ? ['--config', configPath] : []), runner.filePath],
      };
    }
    case 'vitest-multi': {
      if (!Array.isArray(runner.filePaths) || runner.filePaths.length === 0) {
        return { error: 'vitest-multi requires non-empty filePaths' };
      }
      // EI-8902 (see the 'vitest' case above): resolve --config from the
      // FIRST file. A "Run section"/"Run all" batch is always drawn from one
      // registered test domain/section, which in practice never spans two
      // packages with different vitest configs — if that assumption ever
      // breaks, files outside the first one's package still run (vitest
      // itself decides whether they're in-scope for that config), just
      // without per-file config precision.
      const configPath = resolveNearestVitestConfig(runner.filePaths[0], inferWorkspaceRoot());
      return {
        kind: 'vitest',
        label: runner.label ?? `vitest ${runner.filePaths.length} files`,
        command: 'npx',
        args: ['vitest', 'run', ...(configPath ? ['--config', configPath] : []), ...runner.filePaths],
      };
    }
    case 'playwright':
      if (!runner.filePath) return { error: 'playwright requires filePath' };
      return {
        kind: 'playwright',
        label: `playwright ${runner.filePath}`,
        filePath: runner.filePath,
        command: 'npx',
        args: ['playwright', 'test', runner.filePath],
      };
    case 'cargo':
      if (!runner.crate) return { error: 'cargo requires crate' };
      return {
        kind: 'cargo',
        label: runner.test ? `cargo ${runner.crate}::${runner.test}` : `cargo ${runner.crate}`,
        command: 'cargo',
        args: [
          'test',
          // EI-1610: from the repo root, `-p <crate>` fails for a crate that isn't a
          // member of a root Cargo workspace ("could not find Cargo.toml"). When the
          // caller supplies the crate's own manifest, target it via --manifest-path;
          // `-p` is then redundant (the manifest IS the single crate) so it's omitted.
          ...(runner.manifestPath ? ['--manifest-path', runner.manifestPath] : ['-p', runner.crate]),
          ...(runner.test ? [runner.test] : []),
          '--message-format=json',
        ],
      };
    case 'node':
      if (!runner.cmd) return { error: 'node requires cmd' };
      return {
        kind: 'node',
        label: runner.label ?? `node ${runner.cmd}`,
        command: runner.cmd,
        args: runner.args ?? [],
      };
    case 'shell':
      if (!runner.cmd) return { error: 'shell requires cmd' };
      return {
        kind: 'shell',
        label: runner.label ?? `shell ${runner.cmd}`,
        command: runner.cmd,
        args: runner.args ?? [],
      };
    default: {
      const _exhaustive: never = runner;
      void _exhaustive;
      return { error: 'unknown runner kind' };
    }
  }
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/run',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null) as { runner?: TestRunner } | null;
    const runner = body?.runner;
    if (!runner || typeof runner !== 'object' || !('kind' in runner)) {
      return Response.json(
        { error: 'body must be { runner: { kind, ... } }' },
        { status: 400 },
      );
    }
    const spawnReq = toSpawn(runner as TestRunner);
    if ('error' in spawnReq) {
      return Response.json(spawnReq, { status: 400 });
    }
    const snapshot = startRun(spawnReq);
    return Response.json({ runId: snapshot.runId, snapshot });
  },
});
