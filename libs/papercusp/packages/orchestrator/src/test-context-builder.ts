/**
 * Test-context builder for dispatcher-level integration tests.
 *
 * Not a test file (no `.test.ts` suffix → vitest ignores it). Provides
 * a single entry point that sets up a temp git project, a fake harness
 * state dir, a working InvokeContext + HarnessConfig + Logger + LanePool,
 * and a cleanup hook. Helper methods on the returned builder let tests
 * pre-create lane worktrees, write competition manifests, set feature
 * statuses, etc.
 *
 * Most tests will also `vi.mock('./invoke', ...)` upstream to stub the
 * agent backend — see handle-next-validator.test.ts for the pattern.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLanePool, type LanePool } from './lanes';
import { writeCompetitionManifest } from './lanes';
import { readFeaturesMem, seedMemoryStore, _resetMemoryStateForTests } from './state-memory';
import type { InvokeContext } from './invoke';
import type { Logger } from './log';
import type { FeatureRecord } from './types';

// Per-process cleanup: the in-memory feature store is keyed by stateDir,
// so different tests using different tmpdirs are already isolated. But
// if tests reuse a stateDir across runs (rare), or you want airtight
// guarantees, call this from beforeEach.
export { _resetMemoryStateForTests };

export interface OrchTestContext {
  root: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  ctx: InvokeContext;
  cfg: Record<string, unknown>;
  logger: Logger;
  /** Capture of all log lines emitted via `logger.log`. */
  loggedLines: string[];
  lanePool: LanePool;
  /** Tear down the temp directory. Call from `finally`. */
  cleanup: () => void;
  // ─── helpers tests use ─────────────────────────────────────────
  /** Pre-create a feature worktree at .papercusp/worktrees/<fid> with files + a commit. */
  addFeatureWorktree(fid: string, files: Record<string, string>): {
    worktree: string;
    branch: string;
  };
  /** Pre-create a lane worktree at .papercusp/worktrees/<fid>-lane-<N> with files + a commit. */
  addLane(fid: string, laneNum: number, files: Record<string, string>): {
    worktree: string;
    branch: string;
  };
  /** Write a real competition manifest for `fid` with `n` lanes. */
  writeManifest(fid: string, n: number): void;
  /** Pre-create a synthesis worktree with one commit (simulating synth success). */
  addSynthesisWorktree(fid: string, files: Record<string, string>): {
    worktree: string;
    branch: string;
  };
  /** Seed the in-memory feature store with the given features.
   *  Overwrites any prior state for this stateDir. */
  setFeatures(features: Array<{ id: string; status: string; attempts?: number }>): void;
  /** Read the current features from the in-memory store after handler runs. */
  readFeatures(): Array<{ id: string; status: string; attempts?: number }>;
  /** Whether a hook log file exists for the given hook name. */
  hookFired(name: string): boolean;
  /** Read a hook log file's content. */
  readHookLog(name: string): string;
}

export interface OrchTestContextOptions {
  /** Override config fields. Merged on top of sensible defaults. */
  cfg?: Record<string, unknown>;
}

const DEFAULT_CFG = {
  // Production default for useChunkLoop is true (chunk-loop is the
  // canonical worker model). Tests in this suite predominantly exercise
  // the synthesizer + branch-iso pipeline, so the test-context default
  // is `false`. Individual tests that want chunk-loop set it back to
  // true via the options.cfg override.
  parallelWorkers: { max: 4, useChunkLoop: false },
  branchIsolation: { enabled: true, useWorktrees: true, baseBranch: 'main' },
};

/**
 * Build the test context. Caller must invoke `.cleanup()` in `finally`.
 */
export function buildOrchTestContext(
  options: OrchTestContextOptions = {},
): OrchTestContext {
  const root = mkdtempSync(join(tmpdir(), 'orch-test-'));
  const projectDir = root;
  const stateDir = join(projectDir, '.papercusp');
  const logDir = join(stateDir, 'logs');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(stateDir, 'worktrees'), { recursive: true });

  // Initial git project with one commit on main.
  spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: projectDir });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: projectDir });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: projectDir });
  writeFileSync(join(projectDir, 'README.md'), 'base\n');
  spawnSync('git', ['add', '-A'], { cwd: projectDir });
  spawnSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: projectDir });

  const cfg: Record<string, unknown> = {
    ...DEFAULT_CFG,
    ...(options.cfg ?? {}),
    parallelWorkers: {
      ...DEFAULT_CFG.parallelWorkers,
      ...((options.cfg?.parallelWorkers as object) ?? {}),
    },
    branchIsolation: {
      ...DEFAULT_CFG.branchIsolation,
      ...((options.cfg?.branchIsolation as object) ?? {}),
    },
  };

  const loggedLines: string[] = [];
  const logger: Logger = {
    log: (msg: string) => {
      loggedLines.push(msg);
    },
    notifyEvent: () => {},
  } as any;

  // Write config.json so runMainLoop's `readConfig(ctx.stateDir)` sees the
  // same cfg the dispatcher tests configure via options.
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(cfg, null, 2));

  const lanePool = createLanePool(stateDir, (cfg.parallelWorkers as any).max ?? 1);

  const ctx: InvokeContext = {
    harnessDir: '/unused/harnessDir',
    projectDir,
    stateDir,
    logDir,
    phase: 'staging',
    claudeCmd: '/bin/true',
  } as any;

  return {
    root,
    projectDir,
    stateDir,
    logDir,
    ctx,
    cfg,
    logger,
    loggedLines,
    lanePool,
    cleanup: () => rmSync(root, { recursive: true, force: true }),

    addFeatureWorktree(fid, files) {
      const worktree = join(stateDir, 'worktrees', fid);
      const branch = `harness/${fid}`;
      spawnSync('git', ['worktree', 'add', '-B', branch, worktree, 'main'], {
        cwd: projectDir,
      });
      for (const [path, content] of Object.entries(files)) {
        const full = join(worktree, path);
        const dir = path.includes('/')
          ? join(worktree, path.slice(0, path.lastIndexOf('/')))
          : worktree;
        mkdirSync(dir, { recursive: true });
        writeFileSync(full, content);
      }
      spawnSync('git', ['add', '-A'], { cwd: worktree });
      spawnSync('git', ['commit', '--quiet', '-m', `worker: ${fid}`], { cwd: worktree });
      return { worktree, branch };
    },

    addLane(fid, laneNum, files) {
      const worktree = join(stateDir, 'worktrees', `${fid}-lane-${laneNum}`);
      const branch = `harness/${fid}-lane-${laneNum}`;
      spawnSync('git', ['worktree', 'add', '-B', branch, worktree, 'main'], {
        cwd: projectDir,
      });
      for (const [path, content] of Object.entries(files)) {
        const full = join(worktree, path);
        const dir = path.includes('/')
          ? join(worktree, path.slice(0, path.lastIndexOf('/')))
          : worktree;
        mkdirSync(dir, { recursive: true });
        writeFileSync(full, content);
      }
      spawnSync('git', ['add', '-A'], { cwd: worktree });
      spawnSync('git', ['commit', '--quiet', '-m', `lane ${laneNum}`], { cwd: worktree });
      return { worktree, branch };
    },

    writeManifest(fid, n) {
      writeCompetitionManifest(stateDir, fid, n);
    },

    addSynthesisWorktree(fid, files) {
      const worktree = join(stateDir, 'worktrees', `${fid}-synthesis`);
      const branch = `harness/${fid}-synthesis`;
      spawnSync('git', ['worktree', 'add', '-B', branch, worktree, 'main'], {
        cwd: projectDir,
      });
      for (const [path, content] of Object.entries(files)) {
        const full = join(worktree, path);
        const dir = path.includes('/')
          ? join(worktree, path.slice(0, path.lastIndexOf('/')))
          : worktree;
        mkdirSync(dir, { recursive: true });
        writeFileSync(full, content);
      }
      spawnSync('git', ['add', '-A'], { cwd: worktree });
      spawnSync('git', ['commit', '--quiet', '-m', `synth: ${fid}`], { cwd: worktree });
      return { worktree, branch };
    },

    setFeatures(features) {
      // PG-canonical at runtime; in tests we seed the in-memory store
      // (state-memory.ts). No filesystem features.json anymore.
      seedMemoryStore(stateDir, features as FeatureRecord[]);
    },

    readFeatures() {
      return readFeaturesMem({ kind: 'memory', stateDir });
    },

    hookFired(name) {
      const hookDir = join(logDir, 'hooks');
      if (!existsSync(hookDir)) return false;
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      return readdirSync(hookDir).some((f: string) => f.includes(`-${name}.log`));
    },

    readHookLog(name) {
      const hookDir = join(logDir, 'hooks');
      if (!existsSync(hookDir)) return '';
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      const match = readdirSync(hookDir).find((f: string) => f.includes(`-${name}.log`));
      if (!match) return '';
      return readFileSync(join(hookDir, match), 'utf8');
    },
  };
}
