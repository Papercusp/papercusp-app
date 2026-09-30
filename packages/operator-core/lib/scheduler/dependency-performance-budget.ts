/** Measured P-016 budgets for the canonical dependency graph paths. */
export const DEPENDENCY_GRAPH_SCALE_BASELINE = Object.freeze({ nodes: 130_000, edges: 1_500 });

export const DEPENDENCY_GRAPH_BUDGET_MS = Object.freeze({
  mutation: 2_000,
  census: 5_000,
});

export type DependencyGraphBudgetOperation = keyof typeof DEPENDENCY_GRAPH_BUDGET_MS;

export interface DependencyGraphPerformanceTelemetry {
  schemaVersion: 'dependency-graph-performance-v1';
  operation: DependencyGraphBudgetOperation;
  durationMs: number;
  budgetMs: number;
  budgetStatus: 'within-budget' | 'over-budget';
  nodes: number;
  edges: number;
  scaleBaseline: typeof DEPENDENCY_GRAPH_SCALE_BASELINE;
}

export function dependencyGraphPerformanceTelemetry(input: {
  operation: DependencyGraphBudgetOperation;
  durationMs: number;
  nodes: number;
  edges: number;
}): DependencyGraphPerformanceTelemetry {
  const budgetMs = DEPENDENCY_GRAPH_BUDGET_MS[input.operation];
  return {
    schemaVersion: 'dependency-graph-performance-v1',
    ...input,
    durationMs: Math.round(input.durationMs * 10) / 10,
    budgetMs,
    budgetStatus: input.durationMs <= budgetMs ? 'within-budget' : 'over-budget',
    nodes: input.nodes,
    edges: input.edges,
    scaleBaseline: DEPENDENCY_GRAPH_SCALE_BASELINE,
  };
}
