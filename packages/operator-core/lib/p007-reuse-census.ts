/**
 * Source-backed census for measured-agent-productivity P-007 R-006.
 *
 * The census is intentionally pure: callers provide the changed-file sources,
 * while this module verifies the recorded P-003..P-006 population and the
 * concrete edges into the existing config, wake/carry, fleet/event, and
 * evidence consumers. It is a detector, not a second scheduler or monitor.
 */

export type P007Area = 'P-003' | 'P-004' | 'P-005' | 'P-006';

export interface P007ChangedFile {
  area: P007Area;
  path: string;
}

export interface P007CallGraphEdge {
  area: P007Area;
  path: string;
  /** Every token must remain in the file for the edge to be considered live. */
  requiredTokens: readonly string[];
  description: string;
}

/** Exact completion-file population recorded by WI-10000332..WI-10000335. */
export const P007_CHANGED_FILES: readonly P007ChangedFile[] = [
  ...[
    'packages/operator-core/lib/agent-config-constants.ts',
    'packages/operator-core/lib/agent-config-constants.test.ts',
    'apps/operator/lib/chat-actions/ContextLimitAction.ts',
    'packages/operator-core/lib/model-context-budget.mjs',
    'packages/operator-core/lib/model-context-budget.d.mts',
    'apps/operator/lib/release/release-instructions.ts',
    'apps/operator/lib/release/release-history-page.test.ts',
    'packages/operator-core/lib/agent-tools/config/set-compaction-limit-core.test.ts',
    'apps/operator/scripts/psu-launcher.mjs',
    'apps/operator/scripts/psu-launcher.d.mts',
  ].map((path) => ({ area: 'P-003' as const, path })),
  ...[
    'apps/operator/scripts/psu-pty-host.mjs',
    'apps/operator/scripts/psu-pty-host.d.mts',
    'packages/operator-core/lib/events/await/psu-pty-discovery.ts',
    'packages/operator-core/lib/events/await/wake-executor.ts',
  ].map((path) => ({ area: 'P-004' as const, path })),
  ...[
    'packages/operator-core/lib/fleet-repeated-recovery.ts',
    'packages/operator-core/lib/fleet-repeated-recovery.test.ts',
    'packages/operator-core/lib/fleet-repeated-recovery.integration.test.ts',
    'packages/operator-core/lib/fleet-transition-events.ts',
    'packages/operator-core/lib/fleet-transition-events.test.ts',
    'packages/operator-core/lib/harness/routines/fleet-transition-sweep-action.ts',
    'packages/operator-core/lib/harness/routines/fleet-transition-sweep-action.test.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.test.ts',
    'packages/operator-core/lib/events/await/catalog.ts',
    'packages/operator-core/lib/events/await/catalog.test.ts',
    'packages/operator-core/lib/events/await/emitter-pin.ts',
    'packages/operator-core/lib/events/await/emitter-pin.test.ts',
  ].map((path) => ({ area: 'P-005' as const, path })),
  ...['packages/operator-core/lib/acceptance-bar-contract-snapshot.integration.test.ts'].map((path) => ({
    area: 'P-006' as const,
    path,
  })),
];

/** Concrete source edges which distinguish extension from a parallel surface. */
export const P007_CALL_GRAPH_EDGES: readonly P007CallGraphEdge[] = [
  {
    area: 'P-003',
    path: 'apps/operator/lib/chat-actions/ContextLimitAction.ts',
    requiredTokens: ['postCompactionLimit', '/api/admin/config/set-compaction-limit'],
    description: 'context control posts through the existing compaction-limit config seam',
  },
  {
    area: 'P-004',
    path: 'packages/operator-core/lib/events/await/wake-executor.ts',
    requiredTokens: ['spawnPty', 'degradeToInboxOrDrop', 'psu-pty-discovery'],
    description: 'wake recovery extends the existing pty/inbox executor path',
  },
  {
    area: 'P-005',
    path: 'packages/operator-core/lib/harness/routines/fleet-transition-sweep-action.ts',
    requiredTokens: ['fleet-repeated-recovery', 'fleet-transition-events', 'detectFleetTransitions'],
    description: 'fleet sweep feeds the existing transition detector and emitter',
  },
  {
    area: 'P-005',
    path: 'packages/operator-core/lib/agent-tools/fleet/leader-brief.ts',
    requiredTokens: ['RepeatedRecoveryAlert', 'repeatedRecovery'],
    description: 'leader brief consumes the existing repeated-recovery alert',
  },
  {
    area: 'P-006',
    path: 'packages/operator-core/lib/acceptance-bar-contract-snapshot.integration.test.ts',
    requiredTokens: ['bindSpecEvidence', 'readAcceptanceBarContractSnapshot', 'grading'],
    description: 'acceptance evidence composes the existing binding/snapshot/grading stores',
  },
];

export interface P007CensusFinding {
  kind: 'missing-file' | 'unexpected-file' | 'missing-edge';
  path: string;
  detail: string;
  area?: P007Area;
}

export interface P007CensusResult {
  ok: boolean;
  checkedFiles: number;
  checkedEdges: number;
  findings: P007CensusFinding[];
}

export function assessP007ReuseCensus(sources: Readonly<Record<string, string>>): P007CensusResult {
  const findings: P007CensusFinding[] = [];
  const expectedPaths = new Set(P007_CHANGED_FILES.map((f) => f.path));

  for (const file of P007_CHANGED_FILES) {
    if (!(file.path in sources)) {
      findings.push({ kind: 'missing-file', path: file.path, area: file.area, detail: 'completion census file is absent' });
    }
  }
  for (const path of Object.keys(sources)) {
    if (!expectedPaths.has(path)) {
      findings.push({ kind: 'unexpected-file', path, detail: 'path is outside the recorded P-003..P-006 completion population' });
    }
  }
  for (const edge of P007_CALL_GRAPH_EDGES) {
    const source = sources[edge.path];
    if (source === undefined) continue;
    const missing = edge.requiredTokens.filter((token) => !source.includes(token));
    if (missing.length > 0) {
      findings.push({
        kind: 'missing-edge',
        path: edge.path,
        area: edge.area,
        detail: `${edge.description}; missing ${missing.join(', ')}`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    checkedFiles: P007_CHANGED_FILES.filter((f) => f.path in sources).length,
    checkedEdges: P007_CALL_GRAPH_EDGES.filter((e) => e.path in sources).length,
    findings,
  };
}
