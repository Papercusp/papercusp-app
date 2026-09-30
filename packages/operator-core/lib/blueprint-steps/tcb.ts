/**
 * Deterministic-blueprint TCB — the program-mode SPINE EXECUTOR + the
 * DETERMINISTIC-STEP RUNNER, pinned into the never-auto protected set
 * (deterministic-blueprints-migration-2026-06-13 P-141; ties to
 * agent-capability-confinement-2026-06-13 D-007 — "the dispatch gate is the
 * TCB; it cannot graduate its own permissions").
 *
 * The executor is the **trusted computing base** for every deterministic /
 * hybrid spine: it dispatches each registered step (a typed `CoordOp`) and
 * decides which spines are admissible. Concentrating that authority means it
 * MUST NOT be able to widen its own permissions — an auto-edit to its own
 * dispatch / validation / runner code is exactly the self-graduation hazard the
 * recursion-safety rails forbid (queen-autonomy-policy P-090 /
 * self-learning-frontier P-049: the never-auto set, which graduation cannot
 * promote, already covers the loop / auth / deploy / budgets / scheduler).
 *
 * These globs are spread into `DEFAULT_RISK_TIER_POLICY.protectedPathPatterns`
 * (`harness/improvements/policy.ts`), so a captured improvement that TOUCHES the
 * executor classifies `tier: 'human'` under ANY graduation dial — the only
 * widening dial (`autoKinds`) can never promote it. The pin + the
 * cannot-graduate property are pinned by `tcb-invariants.test.ts` (P-141) so a
 * refactor cannot silently un-make them.
 *
 * Already covered by the existing protected set (so deliberately NOT repeated
 * here — they are pinned by the same policy, just under broader patterns):
 *   - the DURABLE executor + the agent-spawn chokepoint — under
 *     `packages/operator-core/lib/dbos/**` (`coord-program-workflow.ts`,
 *     `orchestrator-runner.ts` / `spawnInvokeOnce`).
 *   - the routine cadence layer that FIRES a program-mode blueprint — under
 *     `packages/operator-core/lib/harness/routines/**` (`system:blueprint-run`).
 *
 * This module is a PURE constant (no imports, no op registration) so the safety
 * policy can import it without pulling in the executor's runtime.
 */

/**
 * The repo-relative glob patterns (the `matchGlob` `**`/`*` dialect — see
 * `harness/improvements/policy.ts`) that name the deterministic-blueprint
 * SPINE EXECUTOR + DETERMINISTIC-STEP RUNNER. Spread into the risk-tier
 * policy's `protectedPathPatterns`; each is asserted both wired-in and
 * never-graduable by `tcb-invariants.test.ts`.
 */
export const DETERMINISTIC_EXECUTOR_TCB_PATTERNS: readonly string[] = [
  // The program-mode SPINE EXECUTOR adapter + the coord-op REGISTRY / DISPATCH
  // gate: `runProgramCore` + `inlineRunOp` (the args-schema-validated dispatch)
  // and `requireCoordOp` (the registry the executor resolves every step
  // through). The registered ops live here too — they ARE the capability
  // surface a spine may invoke, so the whole dispatch layer is TCB.
  'packages/operator-core/lib/coord-ops/**',
  // The DETERMINISTIC-STEP RUNNER: the migrated learning loops' deterministic
  // step-ops (`negative-space:scan`, `regret:mine`, …) — a registered typed
  // function the executor runs as a checkpointed step.
  'packages/operator-core/lib/blueprint-steps/**',
  // The pure step interpreter + runner the executor delegates to — the literal
  // step-execution engine (`planStep` / `selectGateBranch` / `runProgram`).
  'libs/generic/step-program/**',
  // The blueprint VALIDATOR + schema — the gate that decides which deterministic
  // / hybrid spines are admissible to run at all (`validateBlueprint`).
  'libs/papercusp/packages/orchestrator/src/blueprint/**',
];
