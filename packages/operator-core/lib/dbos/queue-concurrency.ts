/**
 * DBOS queue-concurrency compatibility seam.
 *
 * Capacity is now owned by the capless durable governor. A fixed WorkflowQueue
 * concurrency (including a host-derived profile value) duplicates a ceiling and
 * prevents upward probing after pressure clears. Keep this optional argument for
 * rolling-deploy source compatibility with existing queue constructors, but
 * intentionally return `undefined`: DBOS receives no local capacity cap and the
 * governor/physical database feedback decides which receipt may run.
 */
export function queueConcurrency(_legacyServerCeiling?: number): undefined {
  return undefined;
}
