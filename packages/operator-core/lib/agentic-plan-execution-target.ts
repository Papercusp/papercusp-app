/**
 * The small execution contract shared by agentic plan entry points.
 *
 * `appHarnessSlug` owns the plan run and its work-item queue. `agentName` is the
 * durable stable identity stored on assigned work items; wake delivery resolves
 * that name to a currently adopting session at dispatch time.
 */
export interface AgenticPlanExecutionTarget {
  appHarnessSlug: string;
  agentName: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: keyof AgenticPlanExecutionTarget): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) throw new Error(`agentic_plan_execution_target_invalid:${field}`);
  return parsed;
}

/**
 * Pure parser for optional persisted JSON. Absence means "ordinary plan run";
 * a present-but-malformed contract fails loudly instead of silently falling
 * back to the papercusp queue or waking the wrong agent.
 */
export function parseAgenticPlanExecutionTarget(raw: unknown): AgenticPlanExecutionTarget | null {
  if (raw === undefined || raw === null) return null;
  const value = record(raw);
  if (!value) throw new Error('agentic_plan_execution_target_invalid:expected_object');
  const appHarnessSlug = requiredString(value.appHarnessSlug, 'appHarnessSlug');
  if (appHarnessSlug === '*' || appHarnessSlug === 'all') {
    throw new Error('agentic_plan_execution_target_invalid:appHarnessSlug');
  }
  return {
    appHarnessSlug,
    agentName: requiredString(value.agentName, 'agentName'),
  };
}
