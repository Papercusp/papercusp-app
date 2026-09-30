/**
 * `PipelineAction` — the action the durable feature-pipeline loop acts on, the
 * output of both the legacy `classifyDecision` switch and the blueprint
 * `deriveNext` interpreter.
 *
 * `harness-blueprint-orchestration-2026-06-03` P-003. This is the canonical home
 * (the engine lib); the operator's `apps/operator/lib/dbos/orchestrator-decide.ts`
 * carries a structurally-identical copy today and is unified onto this type in
 * P-004 (the wire-in). The shapes MUST stay byte-identical until then — the
 * P-003 equivalence test compares `classifyDecision`'s output (operator copy) to
 * `deriveNext`'s output (this type) by deep-strict-equality.
 *
 *   - `terminal` — finalize (`done` / `escalate`) or stop cleanly (`idle`, the
 *     dispatcher re-scans). `reason` is present ONLY on `escalate` (a stray
 *     `reason: undefined` key would break deep-strict-equality).
 *   - `dispatch` — run `role` for `feature` with the templated `extras`, loop.
 *   - `unsupported` — a global-only verb the per-feature pipeline does not run
 *     (parallel lanes / NEXT_HARNESS / CEO mode): warn + stop.
 */
export type PipelineAction =
  | { kind: 'terminal'; outcome: 'done' | 'escalate' | 'idle'; reason?: string }
  | { kind: 'dispatch'; role: string; feature: string; extras: string[] }
  | { kind: 'unsupported'; verb: string };
