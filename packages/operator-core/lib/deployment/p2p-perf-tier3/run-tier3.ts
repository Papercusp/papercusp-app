/**
 * run-tier3.ts — the Tier-3 suite orchestrator (P-010/P-012).
 *
 * The single entry point both Tier-3 paths call: the cred-gated real-frame test
 * and the $0 local-parity test. It runs the selected scenarios over whatever
 * `PeerLauncher` it's handed, persists one JSON artifact per scenario under
 * `test-results/p2p-perf/<runId>/`, and writes a `report.md` via the SHARED
 * renderer — so a Tier-3 run's artifacts + report are byte-shape-identical to a
 * Tier-1/2 run's (artifact parity, P-012).
 *
 * No cloud knowledge here — provisioning lives in bench-frames.ts; this only
 * orchestrates + persists. That's what lets the local launcher exercise the
 * entire path with zero cost.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PerfArtifact } from '../../sync/hyperbee/perf/artifact';
import { renderPerfReport } from '../../sync/hyperbee/perf/report';
import type { PeerLauncher } from './remote-peer';
import {
  crossRegionReplication,
  dhtDiscovery,
  natHolepunch,
  type Tier3ScenarioOpts,
} from './scenarios';

export type Tier3ScenarioId = 'cross-region-replication' | 'dht-discovery' | 'nat-holepunch';

const SCENARIO_FNS: Record<Tier3ScenarioId, (o: Tier3ScenarioOpts) => Promise<PerfArtifact>> = {
  'cross-region-replication': crossRegionReplication,
  'dht-discovery': dhtDiscovery,
  'nat-holepunch': natHolepunch,
};

export interface Tier3SuiteOpts {
  launcher: PeerLauncher;
  /** Unique-per-run topic slug (peers derive a shared swarm topic from it). */
  harnessSlug: string;
  scenarios?: Tier3ScenarioId[];
  workspaceId?: string;
  /** When set, peers federate over the HIVE pubkey topic instead of the
   *  workspace/slug topic — the shared-hive-federation P-011 cross-machine E2E. */
  hivePubkey?: string;
  count?: number;
  rate?: number;
  seed?: number;
  mergePollMs?: number;
  meshTimeoutMs?: number;
  catchUpTimeoutMs?: number;
  estimateClock?: boolean;
  /** Artifact dir (default `test-results/p2p-perf/<runId>`). */
  outDir?: string;
  profile?: string;
  log?: (line: string) => void;
}

export interface Tier3SuiteResult {
  runId: string;
  outDir: string;
  reportPath: string;
  artifacts: PerfArtifact[];
}

export async function runTier3Suite(opts: Tier3SuiteOpts): Promise<Tier3SuiteResult> {
  const log = opts.log ?? (() => {});
  const scenarios = opts.scenarios ?? ['cross-region-replication', 'dht-discovery'];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.outDir ?? join(process.cwd(), 'test-results', 'p2p-perf', runId);
  mkdirSync(outDir, { recursive: true });

  const scenarioOpts: Tier3ScenarioOpts = {
    launcher: opts.launcher,
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
    hivePubkey: opts.hivePubkey,
    count: opts.count ?? 50,
    rate: opts.rate ?? 10,
    seed: opts.seed,
    mergePollMs: opts.mergePollMs,
    meshTimeoutMs: opts.meshTimeoutMs,
    catchUpTimeoutMs: opts.catchUpTimeoutMs,
    estimateClock: opts.estimateClock,
    log,
  };

  const artifacts: PerfArtifact[] = [];
  for (const id of scenarios) {
    const fn = SCENARIO_FNS[id];
    if (!fn) throw new Error(`runTier3Suite: unknown scenario '${id}'`);
    log(`\n▶ tier3.${id}`);
    const artifact = await fn(scenarioOpts);
    artifacts.push(artifact);
    const n = artifacts.length;
    const file = join(outDir, `${String(n).padStart(3, '0')}-${artifact.scenario.replace(/[^a-z0-9.-]/gi, '_')}.json`);
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    // `slo` alone is host responsiveness; `conv` is whether replication kept up
    // — a green slo beside a red conv is a real, observed combination (EI-20576392705164447).
    log(
      `  ✔ ${artifact.scenario} slo=${artifact.sloPassed === null ? 'n/a' : artifact.sloPassed ? '✓' : '✖'}` +
        ` conv=${
          artifact.convergencePassed === null || artifact.convergencePassed === undefined
            ? 'n/a'
            : `${artifact.convergencePassed ? '✓' : '✖'}(${artifact.convergence?.convergedReaders}/${artifact.convergence?.expectedReaders})`
        }`,
    );
  }

  const reportPath = join(outDir, 'report.md');
  writeFileSync(
    reportPath,
    renderPerfReport({
      runId,
      profile: opts.profile ?? 'tier3',
      artifacts,
      titleSuffix: 'Tier 3 — real frames',
    }),
  );
  log(`\nartifacts: ${outDir}`);
  log(`report:    ${reportPath}`);
  return { runId, outDir, reportPath, artifacts };
}
