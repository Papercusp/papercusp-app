/**
 * Gateway-control harness (B-X-1) — the shared dryRun/verify/audit/revert wrapper every
 * gateway + account control tool composes (gateway-live-control-and-egress-plan D-005).
 * See control-harness.ts for the contract. B-EGRESS / B-ACCT / B-GWCTL build against this.
 */
export {
  runControlMutation,
  writeControlAudit,
  type ControlMutationSpec,
  type ControlOutcome,
  type ControlVerify,
  type ControlAuditRecord,
  type ControlHarnessDeps,
  type RunControlOpts,
} from './control-harness';
