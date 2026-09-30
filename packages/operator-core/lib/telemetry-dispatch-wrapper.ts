/**
 * P-012 (goal-mode-design-intent-hardening-2026-08-16): the write-side gate for the
 * dispatch-wrapper telemetry mark. The pure contract (metadata key + census
 * predicates) lives in agent-tools/sessions/automatic-tool-names.ts, which is
 * deliberately dependency-free — the flag read cannot live there, so the three
 * wrapper handlers (tools:invoke, code:run, recipes:run) share this one reader
 * instead of each growing its own copy.
 *
 * Fail-soft to OFF (skip the mark, keep pre-P-012 row shape) when flag infra is
 * unavailable — early boot and unit tests must never lose a telemetry row over an
 * annotation.
 */
export async function dispatchWrapperMarkEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.TELEMETRY_DISPATCH_WRAPPER_MARK, 'system');
  } catch {
    return false;
  }
}
