/**
 * pot-git/gate/hermeticity.ts — DG-6: what a machine must OFFER to run a shard
 * from `(stagingSha, shard)`, and which coverage silently narrows off the dev
 * box (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8 P-049, D-011).
 *
 * AUDIT VERDICT (2026-07-02, all 82 unit + 4 integration shard workspaces):
 * the suite architecture is hermetic BY DESIGN — every integration shard rides
 * `@papercusp/test-config` (testcontainers PG/redis/typesense via
 * `getTestPg`/`baseline-schema-global-setup`; per-run throwaway DBs;
 * `setup-hermetic-env.ts` scrubs spawn-env pollution and redirects state-dir
 * seams off the real `~/.papercusp`). Live-operator suites self-skip on a
 * reachability probe (`it.skipIf(!live)` / probe→`describe.skip`). The one
 * REAL non-hermeticity class found — five suites reading migration DDL through
 * hand-rolled relative-guess candidate lists with a hardcoded dev-box absolute
 * path as last resort — was FIXED in this change (`readRepoFile` walk-up in
 * test-config; iq-battery corpus/collectors/beekeeper-gen0 + hive-eval
 * store-pg/trend-read migrated). The admin test-runs REPORTER's dev-DSN
 * fallback is fail-soft (connect_timeout 1 → null) — on a foreign machine it
 * silently reports nothing, which is correct: the distributed gate's verdict
 * facts (DG-1) are the cross-machine record, not that reporter.
 *
 * WHAT THIS MODULE IS: the pure, machine-readable projection of that audit —
 *   - `shardCapabilities(shard)` → what DG-3 scheduling must match against a
 *     machine's capability tags before placing the shard;
 *   - `KNOWN_COVERAGE_COUPLINGS` → suites whose coverage NARROWS (self-skips)
 *     when an optional capability is absent — DG-5's `green(S)` still counts
 *     their pass, but the aggregation can surface "green with narrowed live
 *     coverage" honestly instead of implying full-coverage green;
 *   - `GATE_COVERAGE_BOUNDARY` → test frameworks the shard model does NOT
 *     carry (loud, per the no-silent-caps rule: a gate that silently omits
 *     suites reads as "covered everything" when it didn't).
 *
 * Pure data + functions over shards.ts shapes — no I/O, no policy.
 */

import type { ShardLayer, ShardSpec } from './shards';

/** The capability vocabulary DG-3 machine tags + DG-6 requirements share. */
export type ShardCapability =
  /** A node runtime + an `npm ci`'d checkout at the staging sha. */
  | 'node'
  /** A Docker daemon (testcontainers PG/redis/typesense; images pullable or pre-pulled). */
  | 'docker'
  /** A LIVE operator (`:3070`-class) — OPTIONAL everywhere: suites probe + self-skip. */
  | 'live-operator'
  /** Real LLM credentials / the inference gateway — OPT-IN suites only. */
  | 'llm-credentials';

/** Capabilities REQUIRED to run a layer at all (full verdict validity). */
export function baseCapabilities(layer: ShardLayer): ShardCapability[] {
  return layer === 'integration' ? ['node', 'docker'] : ['node'];
}

/** How a suite behaves when its optional capability is absent. */
export type CouplingBehavior =
  /** Probes the dependency and skips its cases — verdict stays valid, coverage narrows. */
  | 'self-skips'
  /** Runs ONLY when an explicit env opt-in is set — absent by default everywhere. */
  | 'opt-in-env'
  /** Degrades silently without failing (telemetry-class). */
  | 'fail-soft';

export interface CoverageCoupling {
  /** Workspace the suite lives in (`ShardSpec.workspaceName`). */
  workspaceName: string;
  layer: ShardLayer;
  /** Repo-relative file (or family glob) — evidence, human-auditable. */
  path: string;
  capability: ShardCapability;
  behavior: CouplingBehavior;
  note: string;
}

/**
 * The audited registry (2026-07-02). Every row was VERIFIED in-file — keep it
 * that way: add a row only with the guard/probe line in hand. An entry here is
 * a suite whose coverage narrows off the dev box, NOT a broken suite.
 */
export const KNOWN_COVERAGE_COUPLINGS: readonly CoverageCoupling[] = [
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/agent-tools/locks/__tests__/resource-locks.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'it.skipIf(!live) — live resource-lock drain semantics against the running su MCP',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/agent-tools/locks/__tests__/resource-command-match.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'it.skipIf guards (same live-locks family)',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/agent-tools/locks/__tests__/su-locks-http-mcp.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'skip-guarded HTTP/MCP smoke against :3070',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/__tests__/ui-control.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'itLive = baseUrl ? it : it.skip (OP_PORT / OPERATOR_BASE_URL probe)',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/__tests__/power-user-e2e.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'itLive pattern — live power-user flow smoke',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/__tests__/agent-tools-list.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'skip-guarded (7 guards) against the live tool catalog',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/__tests__/admin-failures.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'skip-guarded live admin-surface probes',
  },
  {
    workspaceName: '@papercusp/operator-core',
    layer: 'integration',
    path: 'lib/deployment/work-on-frame.integration.test.ts',
    capability: 'live-operator',
    behavior: 'opt-in-env',
    note: 'describe.skipIf(!WORK_ON_FRAME_E2E_HARNESS) — provisions a REAL frame, explicit opt-in',
  },
  {
    workspaceName: '@papercusp/web',
    layer: 'integration',
    path: 'scripts/hooks/cc/__tests__/pretooluse-locks-live.integration.test.ts',
    capability: 'live-operator',
    behavior: 'self-skips',
    note: 'reachability probe → describe.skip — live PreToolUse lock-hook semantics',
  },
];

export interface ShardHermeticity {
  shardId: string;
  /** A machine must offer ALL of these for the shard's verdict to be valid. */
  required: ShardCapability[];
  /** Coverage that narrows (does not invalidate) without these capabilities. */
  narrowsWithout: CoverageCoupling[];
  /** True when nothing beyond `required` is needed for a FULL-coverage run. */
  fullyHermetic: boolean;
}

/** DG-6 assessment for one shard — DG-3 matches `required` against machine
 *  tags; DG-5 may surface `narrowsWithout` on an otherwise-green aggregate. */
export function assessShard(
  shard: Pick<ShardSpec, 'shardId' | 'workspaceName' | 'layer'>,
  registry: readonly CoverageCoupling[] = KNOWN_COVERAGE_COUPLINGS,
): ShardHermeticity {
  const narrows = registry.filter(
    (c) => c.workspaceName === shard.workspaceName && c.layer === shard.layer,
  );
  return {
    shardId: shard.shardId,
    required: baseCapabilities(shard.layer),
    narrowsWithout: narrows,
    fullyHermetic: narrows.length === 0,
  };
}

/**
 * What the (workspace × unit|integration) shard model does NOT carry — LOUD,
 * so `green(S)` is never read as "all testing passed". These run on their own
 * rails (and remain candidates for later gate phases).
 */
export const GATE_COVERAGE_BOUNDARY: readonly { framework: string; rail: string }[] = [
  { framework: 'Playwright e2e (apps/operator/e2e/*.spec.ts)', rail: 'own runner; needs a booted operator UI' },
  { framework: 'Cargo #[cfg(test)] (papercusp-desktop)', rail: 'cargo test; not an npm workspace script' },
  { framework: 'LLM scenarios (lib/llm-testing/scenarios/*)', rail: 'llm-test runner; spends tokens, needs credentials' },
];
