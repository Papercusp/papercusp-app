/**
 * Audited set / clear of the workspace WORK-SCOPE policy — THE one mutation path.
 *
 * D-003 (plan workspace-work-scope-policy-2026-09-04): the tool IS the control surface.
 * WI-2145092 adds a second door (the /admin/work-scope pane, via POST /api/work-scope/*),
 * and two doors onto one policy must share one mutation, or the audit trail forks: this
 * module is that mutation. Both `workspace:work_scope { op:'set'|'clear' }` and the HTTP
 * route call these helpers, so a pane click and a tool call are indistinguishable in the
 * pot-control-policy revision history (runControlMutation: capture-prev, apply, verify,
 * revert-on-failure, audit id).
 */
import { z } from 'zod';
import { runControlMutation } from './gateway-control/control-harness';
import { writePotControlPolicy } from './pot-control-policy';
import {
  clearWorkScopePolicy,
  readWorkScopePolicy,
  setWorkScopePolicy,
  type WorkScopeException,
  type WorkScopePolicy,
} from './work-scope-policy';

/** One exception row — shared by the MCP tool's args and the HTTP route's body. */
export const workScopeExceptionSchema = z
  .object({
    harness: z.string().min(1).max(120).optional(),
    plan: z.string().min(1).max(200).optional(),
    goal: z.string().min(1).max(200).optional(),
    workItem: z.string().min(1).max(120).optional(),
    reason: z.string().min(3).max(500),
  })
  .refine((e) => !!(e.harness || e.plan || e.goal || e.workItem), {
    message: 'an exception needs at least one of harness / plan / goal / workItem',
  });

/** The `set` body — shared by the MCP tool's args and the HTTP route's body. */
export const workScopeSetSchema = z.object({
  mode: z.enum(['enforce', 'off']).default('enforce'),
  allowHarnesses: z.array(z.string().min(1).max(120)).min(1).max(200),
  exceptions: z.array(workScopeExceptionSchema).max(200).optional(),
  reason: z.string().min(3).max(1000),
  dryRun: z.boolean().optional(),
});

export interface WorkScopeSetInput {
  mode: 'enforce' | 'off';
  allowHarnesses: string[];
  exceptions?: WorkScopeException[];
  reason: string;
}

const ACTION = 'workspace:work_scope';
const SUBJECT = 'work-scope';

/**
 * Set the policy under the control harness. `actor` is stamped as `setBy` on the policy
 * and on every exception, and recorded on the audit row.
 */
export async function applyWorkScopeSet(
  input: WorkScopeSetInput,
  actor: string,
  opts: { dryRun?: boolean } = {},
) {
  const next = {
    mode: input.mode,
    allowHarnesses: input.allowHarnesses,
    exceptions: input.exceptions?.map((e) => ({ ...e, setBy: actor })),
    setBy: actor,
    reason: input.reason,
  };
  return runControlMutation<WorkScopePolicy | null>(
    {
      action: ACTION,
      subject: SUBJECT,
      actor,
      capturePrev: () => readWorkScopePolicy(),
      apply: () => setWorkScopePolicy(next),
      revertTo: async (prev) => {
        await writePotControlPolicy({ workScope: prev ?? undefined });
      },
      verify: async (stored) => {
        const ok =
          !!stored &&
          stored.mode === next.mode &&
          stored.allowHarnesses.length === next.allowHarnesses.length &&
          stored.allowHarnesses.every((h, i) => h === next.allowHarnesses[i]!.trim());
        return { ok, detail: ok ? undefined : 'policy did not persist as written' };
      },
      describe: (prev) => ({ current: prev, patch: next }),
    },
    { dryRun: opts.dryRun },
  );
}

/** Clear the policy under the control harness — the ONE-call reversal D-001 promises. */
export async function applyWorkScopeClear(actor: string, opts: { dryRun?: boolean } = {}) {
  return runControlMutation<WorkScopePolicy | null>(
    {
      action: ACTION,
      subject: SUBJECT,
      actor,
      capturePrev: () => readWorkScopePolicy(),
      apply: async () => {
        await clearWorkScopePolicy();
        return null;
      },
      revertTo: async (prev) => {
        await writePotControlPolicy({ workScope: prev ?? undefined });
      },
      verify: async () => {
        const now = await readWorkScopePolicy();
        return { ok: now === null, detail: now === null ? undefined : 'policy still present after clear' };
      },
      describe: (prev) => ({ current: prev, patch: null }),
    },
    { dryRun: opts.dryRun },
  );
}
