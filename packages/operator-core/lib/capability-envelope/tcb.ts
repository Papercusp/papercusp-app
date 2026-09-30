/**
 * Capability dispatch-gate TCB — the policy DECISION + ENFORCEMENT point for the
 * autonomous fleet, pinned into the never-auto protected set
 * (agent-capability-confinement-2026-06-13 P-030 / D-007 — "the dispatch gate is
 * the TCB; it cannot graduate its own permissions").
 *
 * Once the fleet is confined (B-18), EVERY capability a fleet agent can exercise
 * flows through one chokepoint: the shared endpoint dispatch evaluates the
 * capability envelope (the PDP), enforces the role-allowlist, and emits the
 * per-action decision-ledger row (D-012). Concentrating that authority means the
 * gate MUST NOT be able to widen its OWN permissions — an auto-captured
 * improvement that edits the envelope policy, the ledger emit, the host wiring
 * that injects them into live dispatch, or the gated capability tools themselves
 * is exactly the self-graduation hazard the recursion-safety rails forbid
 * (queen-autonomy-policy P-090 / self-learning-frontier P-049: the never-auto
 * set, which graduation cannot promote, already covers the loop / auth / deploy /
 * budgets / scheduler).
 *
 * These globs are spread into `DEFAULT_RISK_TIER_POLICY.protectedPathPatterns`
 * (`harness/improvements/policy.ts`), so a captured improvement that TOUCHES the
 * gate classifies `tier: 'human'` under ANY graduation dial — the only widening
 * dial (`autoKinds`) can never promote it. The pin + the cannot-graduate property
 * are pinned by `tcb-invariants.test.ts` (P-030) so a refactor cannot silently
 * un-make them. Sibling of the deterministic-blueprint executor TCB
 * (`blueprint-steps/tcb.ts`, D-007) — that pins the spine executor; THIS pins the
 * capability dispatch gate the confinement plan concentrates authority in.
 *
 * Already covered by the existing protected set (so deliberately NOT repeated
 * here — pinned by the same policy under broader patterns):
 *   - the credential / auth perimeter — under the existing auth + credentials
 *     globs in policy.ts.
 *   - the file-lock authority a write capability coordinates through — under the
 *     existing locks-package glob in policy.ts.
 *
 * Pure constant (no imports, no runtime) so the safety policy can import it
 * without pulling in the dispatch runtime.
 */

/**
 * The repo-relative glob patterns (the `matchGlob` `**`/`*` dialect — see
 * `harness/improvements/policy.ts`) that name the capability dispatch GATE: the
 * policy-decision point, the per-action ledger chokepoint, the host wiring that
 * injects them into live tool dispatch, the generic dispatch stack that runs the
 * gate steps, and the gated capability tool surface itself. Spread into the
 * risk-tier policy's `protectedPathPatterns`; each is asserted both wired-in and
 * never-graduable by `tcb-invariants.test.ts`.
 */
export const CAPABILITY_DISPATCH_TCB_PATTERNS: readonly string[] = [
  // The POLICY-DECISION POINT (PDP): the per-role capability envelope — the
  // static allow/deny that decides "may this fleet role do X at all" (D-003).
  // The TCB pin itself (this module) lives here too.
  'packages/operator-core/lib/capability-envelope/**',
  // The per-action DECISION LEDGER (D-012): the one-row-per-governed-action
  // chokepoint + its disposition layer — the audit rail the gate writes through.
  'packages/operator-core/lib/decision-ledger/**',
  // The HOST WIRING (the PEP seat): where `checkCapabilityEnvelope` + the
  // projected dispatch deps are injected into the live tool dispatch. An edit
  // here could unwire the gate (no-op the envelope) without touching the policy.
  'packages/operator-core/lib/projected-tool-deps.ts',
  // The generic dispatch STACK that runs the gate steps (`role-allowlist`,
  // `capability-check`, `capability-envelope`) — the enforcement mechanism every
  // gated tool call passes through.
  'libs/generic/tooldef/src/dispatch-stack.ts',
  // The GATED CAPABILITY SURFACE: bash / file I/O / git / net — the tools the
  // gate governs. Widening what these execute (or bypassing the in-handler
  // file-lock guard) widens the gate's effective permission, so the whole
  // capability tool dir is TCB.
  'packages/operator-core/lib/agent-tools/capability/**',
];
