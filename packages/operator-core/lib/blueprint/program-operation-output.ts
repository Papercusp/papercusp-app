/**
 * The output a RESOLVED program-execution root settles with (plan
 * blueprint-backed-work-item-execution-2026-09-23, WI-10004002) — the value a
 * program operation's `acceptance.resultSchema` must admit. A gateless program
 * resolves as `{ outcome: 'done', resolved: true }` (program-runner.ts); a gate op
 * adds its `decision`. Shared by the settlement writer (coord-program-workflow.ts)
 * and the published-docs guard (operation-docs-examples.integration.test.ts) so
 * the documented schema and the real settled shape cannot drift apart.
 */
export function programOperationOutput(
  outcome: { outcome: string; resolved: boolean; decision?: unknown },
): Record<string, unknown> {
  if (!outcome.resolved) throw new Error('an unresolved program outcome has no operation output');
  return {
    outcome: outcome.outcome,
    resolved: true,
    ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
  };
}
