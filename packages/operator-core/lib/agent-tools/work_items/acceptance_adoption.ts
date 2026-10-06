/**
 * work_items:acceptance_adoption — the operator door for P-011 of
 * observation-candidate-acceptance-promotion-2026-09-30 (WI-10004574).
 *
 * Reuses the adoption module (harness/improvements/legacy-acceptance-adoption.ts) and
 * its ledger (migration 1310); this file only resolves scope, identity and the serving
 * build, then dispatches one op:
 *   - report       report-first dry run of ONE bounded legacy cohort (mutates only its receipt)
 *   - apply        enrol exactly the reported, still-unchanged, unprotected rows (confirm:true)
 *   - revert       restore the prior readiness on an applied cohort (confirm:true)
 *   - canary       run the four current-build checks on THIS runtime and record a receipt (confirm:true)
 *   - cutover-check  whether a proposed enforcement cutover is authorized by a passed canary receipt
 * No new surface beyond the op switch: every rule lives in the module so the tool and the
 * integration test exercise the same code.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { getServingHostIdentity } from '../../serving-host-identity';
import { createIssue, setIssueState } from '../../issues-engineer';
import {
  ACCEPTANCE_CANARY_RUNTIME,
  LEGACY_ADOPTION_KINDS,
  LEGACY_ADOPTION_MAX_COHORT,
  applyLegacyAdoptionCohort,
  authorizeEnforcementCutoverAdvance,
  enforcementCutoverAttested,
  reportLegacyAdoptionCohort,
  revertLegacyAdoptionCohort,
  runAcceptanceCanary,
} from '../../harness/improvements/legacy-acceptance-adoption';

const MUTATING_OPS = new Set(['apply', 'revert', 'canary']);

export default defineTool({
  name: 'work_items:acceptance_adoption',
  profile: 'engineer',
  description:
    'Legacy implementation-acceptance adoption. op:report dry-runs one bounded pre-cutover cohort (eligible vs protected rows, fingerprinted); op:apply enrols exactly that report\'s still-unchanged, unprotected rows; op:revert restores them; op:canary runs the four current-build acceptance checks on this runtime and records a receipt; op:cutover-check says whether a proposed enforcement cutover has a passed canary receipt. apply/revert/canary need confirm:true.',
  guidance: {
    when: 'Adopting pre-cutover bug/change/task rows into implementation acceptance, or proving the current build before the enforcement cutover moves.',
    notWhen: 'Reviewing one item — that is the agent-review intake path. Counting stages — that is work_items:list / the readiness projection.',
    chaining: 'op:report → read eligible/protected → op:apply { reportRunId, confirm:true } within an hour → op:revert { applyRunId, confirm:true } if wrong. op:canary { confirm:true } → op:cutover-check { proposedCutover }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z.enum(['report', 'apply', 'revert', 'canary', 'cutover-check']).describe('Which adoption step to run.'),
    harness: z.string().min(1).max(80).describe('Harness whose issue-family lane is adopted (the hive home lane).'),
    workspace: z.string().min(1).max(120).optional().describe('Workspace override; defaults to the call context.'),
    kind: z.enum(LEGACY_ADOPTION_KINDS).optional().describe('report: cohort kind (default bug).'),
    createdFromMs: z.number().int().nonnegative().optional().describe('report: inclusive lower created_ts bound (epoch ms).'),
    createdBeforeMs: z.number().int().positive().optional().describe('report: exclusive upper created_ts bound; clamped to the cutover.'),
    limit: z.number().int().min(1).max(LEGACY_ADOPTION_MAX_COHORT).optional().describe('report: cohort size cap.'),
    reportRunId: z.string().min(1).max(120).optional().describe('apply: the report receipt to apply.'),
    applyRunId: z.string().min(1).max(120).optional().describe('revert: the apply receipt to revert.'),
    proposedCutover: z.string().datetime().optional().describe('cutover-check: proposed enforcement cutover (ISO-8601).'),
    confirm: z.literal(true).optional().describe('Required for apply, revert and canary.'),
  }),
  async handler(args, ctx) {
    if (MUTATING_OPS.has(args.op) && args.confirm !== true) {
      return { data: { ok: false, refusal: 'confirm-required', op: args.op } };
    }
    const workspaceId = resolveConcreteWorkspaceId(args.workspace ?? (ctx as { workspaceId?: string | null }).workspaceId);
    const actor = resolveAgentIdentity(ctx as never).ownerId;
    const { sql } = getOrgPg();
    const scope = { workspaceId, harnessSlug: args.harness };

    switch (args.op) {
      case 'report': {
        const report = await reportLegacyAdoptionCohort(sql, {
          ...scope,
          selector: { kind: args.kind ?? 'bug', createdFromMs: args.createdFromMs ?? null, createdBeforeMs: args.createdBeforeMs ?? null },
          limit: args.limit,
          actor,
        });
        return { data: report };
      }
      case 'apply': {
        if (!args.reportRunId) return { data: { ok: false, refusal: 'reportRunId-required' } };
        return { data: await applyLegacyAdoptionCohort(sql, { ...scope, reportRunId: args.reportRunId, actor }) };
      }
      case 'revert': {
        if (!args.applyRunId) return { data: { ok: false, refusal: 'applyRunId-required' } };
        return { data: await revertLegacyAdoptionCohort(sql, { ...scope, applyRunId: args.applyRunId, actor }) };
      }
      case 'canary': {
        const receipt = await runAcceptanceCanary(sql, {
          ...scope,
          actor,
          runtime: ACCEPTANCE_CANARY_RUNTIME,
          buildSha: getServingHostIdentity().buildSha,
          probe: {
            // The real create path (R-11): the probe must be born creation-enrolled. It is
            // assigned to the canary actor at birth so no other agent can claim it.
            create: async () => {
              const issue = await createIssue({
                title: 'acceptance canary probe',
                body: 'Synthetic row written by work_items:acceptance_adoption op:canary; dropped immediately.',
                kind: 'bug',
                scope: `harness:${args.harness}`,
                createdBy: actor,
                assignee: actor,
                admission: 'auto',
                admittedBy: 'bypass:acceptance-canary',
              });
              return { id: issue.id };
            },
            drop: async (id, runId) => {
              await setIssueState(id, 'dropped', actor, `acceptance-canary:${runId}`, { skipCompletionGate: true });
            },
          },
        });
        return { data: { ok: receipt.status === 'passed', ...receipt } };
      }
      case 'cutover-check': {
        const attested = enforcementCutoverAttested();
        const authorization = args.proposedCutover
          ? await authorizeEnforcementCutoverAdvance(sql, { ...scope, proposedCutoverMs: Date.parse(args.proposedCutover) })
          : null;
        return { data: { ok: attested.ok && (authorization?.ok ?? true), attested, authorization } };
      }
    }
  },
});
