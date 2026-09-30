/**
 * The `Subject` port — the ONE swappable boundary of the eval-battery engine
 * (reconciliation D-001). The engine owns the battery loop + judge + stats + cost
 * discipline; the only thing that varies is the subject:
 *
 *   - the **gym** is the `HarnessSubject`: a cell's `variant` = a prompt overlay,
 *     `run` = a role *inside a fixed harness* — a COMPONENT eval;
 *   - the **Apiary/gen-0** is the `InstanceSubject`: a cell's `variant` = a genome
 *     delta, `run` = a *config-varied whole instance* — a WHOLE-INSTANCE eval.
 *
 * One engine, two subjects. The engine treats `THandle` OPAQUELY — it never reads a
 * handle field (the gym's `pipelineUsd` and the apiary's `costUsd` differ); the caller
 * reads what it needs off the handle in its own outcome mapping + store hooks.
 */

/** What `collectAndDistill` returns: the judge-sized trace + raw + optional metric signals. */
export interface DistilledRun<TSignals = unknown> {
  /** The distilled trace the judge reads (capped at the battery's `maxDistillChars`). */
  distilledTrace: string;
  /** A reference (path/uri) to the full trace, for provenance. */
  traceRef: string;
  /** The raw deterministic signals recorded with the run. */
  rawSignals: unknown;
  /** Subject-specific metric signals threaded into an optional `collectMetrics` step
   *  (e.g. the apiary's status / tokens / times / escalation / sources). */
  signals?: TSignals;
}

/**
 * One subject of the battery. `TCell` is the subject's own run-input shape (the gym's
 * `AbRunInput`, the apiary's `BeekeeperRunInput`); `THandle` its own run handle.
 */
export interface Subject<TCell, THandle, TSignals = unknown> {
  /** Run one cell (boot/spawn the subject for this variant + case). */
  run(cell: TCell): Promise<THandle>;
  /** Distill the run's trace + raw signals for the judge + collectors. */
  collectAndDistill(input: { handle: THandle; cell: TCell; maxChars: number }): Promise<DistilledRun<TSignals>>;
  /** The judge inputs (intent + projectContext) for this cell; the engine fills in the
   *  distilled trace + rubric. The gym maps task→intent/projectContext, the apiary maps
   *  the case prompt→intent (projectContext = ''). */
  judgeInput(cell: TCell): { intent: string; projectContext: string };
}
