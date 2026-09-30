/**
 * Grader registry (Port 3, P-005 / BRIEF 3) — resolve the right {@link OfficialGrader} for a benchmark
 * family, with shell-free live I/O bindings. M1 (SWE-bench Pro diff-batch) is built; M2 (Terminal-Bench /
 * Harness-Bench in-container) throws until built (feasibility doc §3/§4 — second).
 *
 * The live subprocess port uses `execFile` (argument array, NO shell) — never `exec` — so a patch / path
 * can never inject a shell command into the grader.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { BenchmarkFamily, OfficialGrader } from '../types';
import {
  makeSweBenchProGrader,
  type GraderFs,
  type ProcExec,
  type SweBenchProGraderConfig,
  type SweBenchProGraderDeps,
} from './swe-bench-pro';
import { makeSweLancerGrader, type SweLancerGraderConfig } from './swe-lancer';
import {
  makeSweBenchVerifiedGrader,
  type SweBenchVerifiedGraderConfig,
  type SweBenchVerifiedGraderDeps,
} from './swe-bench-verified';
import {
  makeTheAgentCompanyGrader,
  type TheAgentCompanyGraderConfig,
  type TheAgentCompanyGraderDeps,
} from './the-agent-company';
import { makeGaiaGrader, type GaiaGraderConfig } from './gaia-official';
import { makeGdpvalGrader, type GdpvalGraderConfig } from './gdpval-official';
import { makeFrontierSweGrader, type FrontierSweGraderConfig, type FrontierSweGraderDeps } from './frontier-swe';

export { makeFakeGrader } from './fake';
export { makeSweBenchProGrader, parseSweBenchProReport } from './swe-bench-pro';
export { makeSweLancerGrader, parseSweLancerReport } from './swe-lancer';
export {
  makeSweBenchVerifiedGrader,
  parseSweBenchVerifiedReport,
  assertVerifiedHarnessInstalled,
} from './swe-bench-verified';
export type { ProcExec, GraderFs, SweBenchProGraderConfig, SweBenchProGraderDeps } from './swe-bench-pro';
export type { SweLancerGraderConfig, SweLancerGraderDeps } from './swe-lancer';
export type {
  SweBenchVerifiedGraderConfig,
  SweBenchVerifiedGraderDeps,
  SweBenchVerifiedReport,
} from './swe-bench-verified';
export {
  makeTheAgentCompanyGrader,
  parseTheAgentCompanyResult,
  computeTacScore,
  extractTacCheckpoints,
} from './the-agent-company';
export { makeGaiaGrader, type GaiaGraderConfig } from './gaia-official';
export { makeGdpvalGrader, type GdpvalGraderConfig } from './gdpval-official';
export {
  makeFrontierSweGrader,
  parseFrontierSweReward,
  rewardFromJson,
  type FrontierSweGraderConfig,
  type FrontierSweGraderDeps,
  type FrontierSweRawReward,
} from './frontier-swe';
export type {
  TheAgentCompanyGraderConfig,
  TheAgentCompanyGraderDeps,
  TacResult,
  TacCheckpoint,
  TacScore,
} from './the-agent-company';

/** Live subprocess runner — `execFile` (no shell); resolves with streams + exit code, never rejects on exit≠0. */
export const liveProcExec: ProcExec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', code });
      },
    );
  });

/** Live fs port for the grader (scratch predictions JSON + output dir). */
export const liveGraderFs: GraderFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data),
  readFile: (path) => readFile(path, 'utf8'),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

export interface GraderRegistryConfig {
  sweBenchPro?: SweBenchProGraderConfig;
  sweBenchVerified?: SweBenchVerifiedGraderConfig;
  sweLancer?: SweLancerGraderConfig;
  theAgentCompany?: TheAgentCompanyGraderConfig;
  gaia?: GaiaGraderConfig;
  gdpval?: GdpvalGraderConfig;
  frontierSwe?: FrontierSweGraderConfig;
}

/**
 * Resolve the official grader for `family`. Inject `deps` (exec/fs) in tests; production uses the live
 * shell-free bindings. M2 families throw until their in-container backend lands.
 */
export function getOfficialGrader(
  family: BenchmarkFamily,
  cfg: GraderRegistryConfig,
  deps?: Partial<SweBenchProGraderDeps>,
): OfficialGrader {
  switch (family) {
    case 'swe-bench-pro': {
      if (!cfg.sweBenchPro) throw new Error('getOfficialGrader: swe-bench-pro requires a SweBenchProGraderConfig');
      return makeSweBenchProGrader(cfg.sweBenchPro, {
        exec: deps?.exec ?? liveProcExec,
        fs: deps?.fs ?? liveGraderFs,
      });
    }
    case 'swe-bench-verified': {
      if (!cfg.sweBenchVerified)
        throw new Error('getOfficialGrader: swe-bench-verified requires a SweBenchVerifiedGraderConfig');
      return makeSweBenchVerifiedGrader(cfg.sweBenchVerified, {
        exec: deps?.exec ?? liveProcExec,
        fs: deps?.fs ?? liveGraderFs,
      } satisfies SweBenchVerifiedGraderDeps);
    }
    case 'swe-lancer': {
      if (!cfg.sweLancer) throw new Error('getOfficialGrader: swe-lancer requires a SweLancerGraderConfig');
      return makeSweLancerGrader(cfg.sweLancer, {
        exec: deps?.exec ?? liveProcExec,
        fs: deps?.fs ?? liveGraderFs,
      });
    }
    case 'the-agent-company': {
      if (!cfg.theAgentCompany)
        throw new Error('getOfficialGrader: the-agent-company requires a TheAgentCompanyGraderConfig');
      return makeTheAgentCompanyGrader(cfg.theAgentCompany, {
        exec: deps?.exec ?? liveProcExec,
        fs: deps?.fs ?? liveGraderFs,
      } satisfies TheAgentCompanyGraderDeps);
    }
    case 'gaia': {
      if (!cfg.gaia) throw new Error('getOfficialGrader: gaia requires a GaiaGraderConfig');
      return makeGaiaGrader(cfg.gaia);
    }
    case 'gdpval': {
      if (!cfg.gdpval) throw new Error('getOfficialGrader: gdpval requires a GdpvalGraderConfig (incl. a judge)');
      return makeGdpvalGrader(cfg.gdpval);
    }
    case 'frontier-swe': {
      if (!cfg.frontierSwe) throw new Error('getOfficialGrader: frontier-swe requires a FrontierSweGraderConfig');
      return makeFrontierSweGrader(cfg.frontierSwe, {
        exec: deps?.exec ?? liveProcExec,
        fs: deps?.fs ?? liveGraderFs,
      } satisfies FrontierSweGraderDeps);
    }
    case 'terminal-bench':
    case 'harness-bench':
      throw new Error(
        `getOfficialGrader: M2 in-container grader for "${family}" not built yet (feasibility doc §3/§4 — M1 first)`,
      );
    default:
      throw new Error(`getOfficialGrader: unsupported benchmark family "${family}"`);
  }
}
