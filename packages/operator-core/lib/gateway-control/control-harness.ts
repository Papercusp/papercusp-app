/**
 * Gateway-control harness (B-X-1) — the papercusp binding of the D-005 control-mutation
 * harness (gateway-live-control-and-egress-plan-2026-06-20 D-005).
 *
 * The whole point of the live-control surface is UNSUPERVISED agent self-correction, which is
 * only safe with four guarantees on every mutating tool (D-005): a **dryRun preview**, a
 * **post-apply verify**, an **audit record** (who/what/prev/ts), and a **one-call revert**.
 * Each control tool describes its mutation as a `ControlMutationSpec` and runs it through
 * `runControlMutation`, which orchestrates the four guarantees uniformly.
 *
 * THE ORCHESTRATION lives in the borrowable **`@papercusp/control-mutation`** lib (extracted
 * so papercusp AND oddsmith consume ONE implementation instead of diverging hand-copies). It
 * is generic — it knows nothing about accounts, egress, AIMD, or DBs — and takes the audit
 * WRITE as an injected port. THIS module is the papercusp binding: it keeps the only
 * papercusp-specific piece — `writeControlAudit` (the `harness_shared.audit_log` write) — and a
 * thin `runControlMutation` wrapper that wires it (and the gateway-control system actor) as the
 * defaults, so every existing call site is unchanged.
 *
 * REUSE-FIRST: the audit record is written to the EXISTING `harness_shared.audit_log` store
 * (the `details` jsonb carries prev+next for the revert), keyed by the action namespace
 * `gateway-control.<action>` so `audit:list` surfaces control actions distinctly.
 */
import { withWorkspace, generated } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import { activeWorkspaceId } from '../workspace-registry';
import {
  runControlMutation as runControlMutationCore,
  type ControlMutationSpec,
  type ControlOutcome,
  type RunControlOpts,
  type ControlHarnessDeps,
  type ControlAuditRecord,
} from '@papercusp/control-mutation';

// Re-export the harness types from the lib so existing importers of this module are unchanged.
export type {
  ControlVerify,
  ControlMutationSpec,
  ControlOutcome,
  RunControlOpts,
  ControlHarnessDeps,
  ControlAuditRecord,
} from '@papercusp/control-mutation';

const al = generated.auditLogInHarnessShared;

const DEFAULT_ACTOR = 'system:gateway-control';

function auditId(): string {
  return `gwc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a control mutation to the shared audit_log (reuse-first). `details` carries prev+next so
 * the action is fully reconstructable + revertible from the audit row. Best-effort like
 * operator-audit (a missing audit row must never fail the control action) but RETURNS the id so
 * the outcome can reference it; on write failure returns '' (the mutation still applied).
 */
export async function writeControlAudit(rec: ControlAuditRecord): Promise<string> {
  const workspaceId = activeWorkspaceId();
  const id = auditId();
  try {
    await withWorkspace(workspaceId, async (tx) => {
      await drizzle(tx)
        .insert(al)
        .values({
          id,
          ts: Date.now(),
          actor: rec.actor || DEFAULT_ACTOR,
          action: `gateway-control.${rec.action}`,
          subject: rec.subject,
          details: {
            prev: rec.prev,
            next: rec.next,
            ...(rec.verify ? { verify: rec.verify } : {}),
            ...(rec.reverted ? { reverted: true } : {}),
            ...(rec.revertOf ? { revert_of: rec.revertOf } : {}),
          } as never,
          workspaceId,
        });
    });
    return id;
  } catch (err) {
    console.warn(`[gateway-control] audit write failed for ${rec.action}/${rec.subject}:`, err);
    return '';
  }
}

/**
 * Run a control mutation with the four D-005 guarantees — the papercusp binding of
 * `@papercusp/control-mutation`: defaults the audit writer to the `harness_shared.audit_log`
 * write (`writeControlAudit`) and the actor to the gateway-control system principal, so every
 * existing call site is unchanged. Pass `deps.writeAudit` (a fake) in tests.
 */
export function runControlMutation<T>(
  spec: ControlMutationSpec<T>,
  opts: RunControlOpts = {},
  deps: ControlHarnessDeps = {},
): Promise<ControlOutcome<T>> {
  return runControlMutationCore(
    { ...spec, actor: spec.actor ?? DEFAULT_ACTOR },
    opts,
    { ...deps, writeAudit: deps.writeAudit ?? writeControlAudit },
  );
}
