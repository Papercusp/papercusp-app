/**
 * release:checkpoint-cancel — stop one exact detached checkpoint runner.
 *
 * This is intentionally separate from `release:checkpoint-run { replaceStale:true }`:
 * replacement is a guarded recovery heuristic, while cancellation is an operator's
 * explicit response to a known-unsafe candidate. The store CAS requires the logical
 * attempt id and the exact systemd unit recorded on that attempt before it will invoke
 * the protected SIGTERM path. The qualification row and the repair queue are updated
 * independently: only the former is settled, and the queue is never retired here.
 */

import { z } from 'zod';
import { defineTool, isOperatorConfigWriteRole, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { resolveCheckpointRouting } from '../../harness/routines/hive-release-env';
import { integrationRoot } from '../../release-deploy-launch';
import {
  checkpointUnitForRoot,
  terminateActiveCheckpointUnit,
} from '../../release-checkpoint-launch';
import {
  cancelStoredQualification,
  type StoredQualificationCancellation,
} from '../../release/checkpoint-qualification-transaction';
import { resolveAgentIdentity } from '../coordination/identity';
import { LIMITS, softText } from '../limits';

const json = (payload: unknown) => ({ data: payload });

type CheckpointCancelContext = {
  harnessSlug?: string | null;
  workspaceId?: unknown;
  role?: string;
  isSuperuser?: boolean;
};

function concreteWorkspace(ctx: CheckpointCancelContext): string {
  const workspace = typeof ctx.workspaceId === 'string' ? ctx.workspaceId.trim() : '';
  return workspace && workspace !== '*' ? workspace : activeWorkspaceId();
}

function baseUnit(unit: string): string {
  return unit.endsWith('.service') ? unit.slice(0, -'.service'.length) : unit;
}

function refused(reason: string, extra: Record<string, unknown> = {}) {
  return json({ ok: false, cancelled: false, refused: true, reason, ...extra });
}

function renderCancellation(
  result: StoredQualificationCancellation,
  args: { attemptId: string; unit: string },
) {
  if (result.status === 'updated') {
    return json({
      ok: true,
      cancelled: true,
      attempt_id: args.attemptId,
      unit: args.unit,
      outcome: result.transaction.outcome,
      repair_queue: 'preserved',
      note: 'The exact detached runner was SIGTERMed and the logical qualification was terminally settled as code-inconclusive. The frozen repair queue was not changed.',
    });
  }
  if (result.status === 'stop-failed') {
    return refused('stop_failed', {
      attempt_id: args.attemptId,
      unit: args.unit,
      error: result.error,
      note: 'The exact qualification row was left unchanged because the protected unit did not confirm a successful SIGTERM. Retry only after checking the exact unit state.',
    });
  }
  if (result.status === 'conflict') {
    return refused('exact_attempt_unit_mismatch', {
      attempt_id: args.attemptId,
      unit: args.unit,
      note: 'NOT cancelled: the durable qualification did not still name this attempt and unit together. No systemd signal was sent.',
    });
  }
  if (result.status === 'terminal') {
    return refused('qualification_terminal', {
      attempt_id: args.attemptId,
      unit: args.unit,
      outcome: result.transaction.outcome,
      note: 'NOT cancelled: this exact logical attempt already has a terminal outcome, so no unit was signalled.',
    });
  }
  return refused(`qualification_${result.status}`, {
    attempt_id: args.attemptId,
    unit: args.unit,
    error: 'error' in result ? result.error : undefined,
    note: 'NOT cancelled: the qualification transaction could not be read safely.',
  });
}

export default defineTool({
  name: 'release:checkpoint-cancel',
  profile: 'engineer',
  description:
    'Cancel one known-unsafe detached green-checkpoint runner by exact logical attempt id and exact recorded systemd unit. The protected SIGTERM path is invoked only after the same-row attempt/unit CAS succeeds; the qualification becomes terminal code-inconclusive and the frozen repair queue is preserved.',
  guidance: {
    when: 'A live detached checkpoint is proven unsafe or is judging a candidate that must not be allowed to produce a verdict. Obtain attemptId and unit from the qualification/run evidence first.',
    notWhen: 'Do not use this as a generic retry or stale-run heuristic. Use release:checkpoint-run { replaceStale:true } for the separately guarded stale-candidate recovery path.',
    chaining: 'read the exact qualification attempt/unit → release:checkpoint-cancel → inspect the inconclusive evidence and preserved repair queue before starting a successor.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'release-fixer', 'release-manager'],
  args: z.object({
    attemptId: z.string().min(1).max(256).describe('the exact logical qualification attempt id currently owning the detached runner'),
    unit: z
      .string()
      .regex(/^papercup-green-checkpoint-manual-[a-z0-9-]+\.service$/)
      .describe('the exact systemd user unit recorded on that attempt, including the .service suffix'),
    reason: softText(LIMITS.SHORT_TITLE)
      .optional()
      .describe('why this known-unsafe runner is being cancelled; stored as the terminal code-inconclusive reason'),
  }),
  async handler(args, ctx) {
    try {
      resolveAgentIdentity(ctx);
    } catch {
      return refused('authentication_required', {
        note: 'A verified caller identity is required before a protected checkpoint unit can be signalled.',
      });
    }
    if (ctx.isSuperuser !== true && ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      return refused('role_forbidden', {
        role: ctx.role ?? 'unknown',
        note: 'release:checkpoint-cancel requires su or an operator-config write role.',
      });
    }

    const workspaceId = concreteWorkspace(ctx);
    const installSlug = operatorHomeHarnessSlug();
    const routing = await resolveCheckpointRouting({ installSlug, workspaceId }, integrationRoot());
    if (routing.skip) {
      return refused('checkpoint_routing_skip', {
        harness: installSlug,
        workspace_id: workspaceId,
        detail: routing.skip.reason,
      });
    }
    const checkpointRoot = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
    const expectedUnit = `${checkpointUnitForRoot(checkpointRoot)}.service`;
    if (args.unit !== expectedUnit) {
      return refused('unit_mismatch', {
        attempt_id: args.attemptId,
        unit: args.unit,
        note: 'NOT cancelled: the requested unit is not the canonical unit for this operator-home checkpoint target.',
      });
    }

    const result = await cancelStoredQualification(
      { workspaceId, installSlug },
      {
        attemptId: args.attemptId,
        unit: args.unit,
        reason: args.reason,
        evidenceRefs: ['tool:release:checkpoint-cancel'],
      },
      () => terminateActiveCheckpointUnit(baseUnit(args.unit)),
    );
    return renderCancellation(result, args);
  },
});
