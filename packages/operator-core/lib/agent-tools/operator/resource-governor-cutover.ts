/**
 * governor:admission_cutover — the operator seam for the bounded admission-ledger cutover.
 *
 * P-005 deliberately keeps the database mutation inside PgAdmissionCutoverQueueStore:
 * the store owns the advisory lock, work_items table lock, newest-row CAS, and
 * positive ledger/cutover controls. This tool adds no second writer. It makes
 * the existing census and one-way retirement edge reachable and auditable as a
 * normal MCP invocation instead of requiring raw SQL.
 */
import { z } from 'zod';
import { defineTool, isOperatorConfigWriteRole, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  PgAdmissionCutoverQueueStore,
  type AdmissionCutoverCensus,
} from '../../resource-governor/admission-cutover-store';

type CutoverStore = Pick<PgAdmissionCutoverQueueStore, 'readCutoverCensus' | 'markLegacyWritersRetired'>;

export const admissionCutoverArgsSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('status'),
  }),
  z.object({
    op: z.literal('retire_legacy_writers'),
    expectedLegacyNewestCreatedMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'Exact legacyNewestCreatedMs from the immediately preceding status read; null is an explicit empty census.',
      ),
    writerPlanesLedgerOnly: z
      .literal(true)
      .describe('Attests that every independently deployed admission-writer plane is running the ledger-only release.'),
    confirm: z
      .literal(true)
      .describe(
        'Confirms the one-way retired-writer marker. Existing legacy receipts may still settle; new legacy inserts reject.',
      ),
  }),
]);

export type AdmissionCutoverArgs = z.infer<typeof admissionCutoverArgsSchema>;

export interface AdmissionCutoverDeps {
  readonly workspaceId: () => string;
  readonly store: (workspaceId: string) => CutoverStore;
}

const DEFAULT_DEPS: AdmissionCutoverDeps = {
  workspaceId: activeWorkspaceId,
  store: (workspaceId) => new PgAdmissionCutoverQueueStore({ workspaceId }),
};

function nextAction(census: AdmissionCutoverCensus): string {
  if (!census.cutoverLatched || census.ledgerTotal === 0) {
    return 'Ship and exercise the ledger-only writer before retiring any legacy writer.';
  }
  if (!census.legacyWritersRetired) {
    return 'After every writer plane is proven ledger-only, repeat status and retire with its exact legacyNewestCreatedMs.';
  }
  if (census.legacyActive > 0) {
    return `Reconcile the ${census.legacyActive} active legacy receipt(s) to terminal; do not arm migration 1077.`;
  }
  if (census.legacyCreatedAfterRetirement > 0) {
    return 'A legacy receipt crossed the retired-writer edge; investigate the writer/guard breach and do not arm migration 1077.';
  }
  return 'The database cutover census permits terminal cleanup; independently re-verify deployed writer identity before arming migration 1077.';
}

export async function runAdmissionCutoverOperation(
  args: AdmissionCutoverArgs,
  deps: AdmissionCutoverDeps = DEFAULT_DEPS,
): Promise<{
  ok: true;
  op: AdmissionCutoverArgs['op'];
  workspaceId: string;
  applied: boolean;
  census: AdmissionCutoverCensus;
  next: string;
}> {
  const workspaceId = deps.workspaceId();
  const store = deps.store(workspaceId);
  const before = await store.readCutoverCensus();

  if (args.op === 'status') {
    return {
      ok: true,
      op: args.op,
      workspaceId,
      applied: false,
      census: before,
      next: nextAction(before),
    };
  }

  if (before.legacyWritersRetired) {
    return {
      ok: true,
      op: args.op,
      workspaceId,
      applied: false,
      census: before,
      next: nextAction(before),
    };
  }

  if (before.legacyNewestCreatedMs !== args.expectedLegacyNewestCreatedMs) {
    throw new Error(
      'governor:admission_cutover stale census: ' +
        `expected legacyNewestCreatedMs=${String(args.expectedLegacyNewestCreatedMs)}, ` +
        `fresh status measured ${String(before.legacyNewestCreatedMs)}; rerun op:"status"`,
    );
  }

  const after = await store.markLegacyWritersRetired(args.expectedLegacyNewestCreatedMs);
  return {
    ok: true,
    op: args.op,
    workspaceId,
    applied: true,
    census: after,
    next: nextAction(after),
  };
}

export default defineTool({
  name: 'governor:admission_cutover',
  profile: 'engineer',
  description:
    'Read the dedicated admission-ledger rolling-cutover census or establish the serialized one-way legacy-writer retirement marker. Retirement requires the exact newest-legacy-row watermark from a fresh status read, explicit confirmation, and an attestation that every deployed writer plane is ledger-only. This tool never deletes receipts or arms migration 1077.',
  guidance: {
    when: 'During the bounded resource-governor admission-ledger migration: status first; retire only after every independently deployed writer plane is confirmed ledger-only.',
    notWhen:
      'For ordinary governor health use state:read governor.*. Never use retirement as proof that active legacy receipts are zero, and never use this tool to arm/delete migration 1077.',
    chaining:
      'governor:admission_cutover {op:"status"} → externally prove every writer plane ledger-only → retire_legacy_writers with the exact returned watermark → reconcile to zero → arm migration 1077 only after a fresh ready census.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: admissionCutoverArgsSchema,
  async handler(args, ctx) {
    if (args.op === 'retire_legacy_writers' && ctx.role !== 'su' && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error(
        'governor:admission_cutover retirement requires su or an operator-config write role; status is read-only',
      );
    }
    const payload = await runAdmissionCutoverOperation(args);
    // Canonical `{ data }` shape — the framework owns wire encoding (tool-data-shape-ratchet).
    return { data: payload };
  },
});
