/**
 * behaviour-suite — the DESKTOP agent-behaviour suite (plan desktop-agent-behaviour-suite-2026-07-03).
 *
 * Scores a REAL su/ornith run — captured from its own omp session transcript, the way agents
 * actually run (a visible psu / fleet:launch-on-plan launch on the owner's desktop) — against 8
 * codified, deterministic, no-LLM-judge behaviour checks. The desktop counterpart to the headless
 * cert-battery (lib/inference-gateway/cert-battery), reusing its ToolCallStats + critical-check
 * verdict shape. The transcript parser + assertions + report are PURE (unit-testable with inline
 * fixtures); the runner's launch/capture/teardown I/O sits behind an injected port (runner.ts),
 * with the live node wiring in runner-node.ts.
 */
export * from './transcript';
export * from './assertions';
export * from './report';
export * from './runner';
export * from './fixture';
// runner-node is intentionally NOT re-exported here — it carries node-only imports (fs, child_process)
// and must not be pulled into the pure scoring path. Import it directly where node I/O is wanted.
