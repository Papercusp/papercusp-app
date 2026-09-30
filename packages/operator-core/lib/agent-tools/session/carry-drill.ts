/** session:carry-drill — P-020's explicit, default-off cold-boot chaos surface. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  gradeColdBootDrill,
  reportColdBootDrills,
  startColdBootDrill,
  verifyColdBootDrill,
} from '../../cold-boot-drill-live';
import {
  reportResidualCarrySamples,
  readRetiredResidualClasses,
  retireResidualClass,
  unretireResidualClass,
} from '../../residual-carry-pass-live';

const argsSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('start'),
    sessionClass: z.string().trim().min(1).max(120).optional(),
    effectiveWindowTokens: z.number().int().min(16_000).max(1_000_000).optional(),
    acknowledgeOwnerHistoryUncertainty: z.literal(true).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    op: z.literal('grade'),
    drillId: z.string().trim().min(1).max(200),
  }),
  z.object({ op: z.literal('report') }),
  // EI-12655 fix (c): post-start lifecycle self-check — assert the drill left
  // every durable leg (ledger row, host respawn event, a TERMINAL outcome, a
  // live owner socket) instead of discovering a silent vanish at grade time.
  z.object({
    op: z.literal('verify'),
    drillId: z.string().trim().min(1).max(200).optional(),
    sessionClass: z.string().trim().min(1).max(120).optional(),
  }),
  // P-019 retirement actuation (D-010 leg 3): a discrete, evidence-gated action —
  // never applied automatically off scoreResidualMissRate's raw recommendation
  // (D-001). Requires the class's OWN live report to already say retire:true.
  z.object({
    op: z.literal('retire'),
    sessionClass: z.string().trim().min(1).max(120),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    op: z.literal('unretire'),
    sessionClass: z.string().trim().min(1).max(120),
  }),
]);

export default defineTool({
  name: 'session:carry-drill',
  description:
    'Opt-in cold-boot chaos drill for THIS session: force a clean-boundary deterministic carry-respawn, mechanically grade what the successor searched for, verify a drill left every durable lifecycle leg, report per-class sufficiency + the P-019 residual-pass miss-rate corpus, or retire/unretire the residual pass for a session class once its own report shows retire:true. Destructive start is default-off and rate-limited.',
  capability: 'coord:write',
  guidance: {
    when:
      'P-020 carry validation, or (op:retire/unretire) P-019 residual-pass retirement once a class clears the miss-rate gate. Call start at a clean boundary; the fresh successor follows the injected marker and calls grade at its next clean boundary. If start returns owner_history_uncertain, reconcile the owner request, checkpoint the lane, then explicitly retry with acknowledgeOwnerHistoryUncertainty:true; this never bypasses a known unanswered owner message.',
    notWhen:
      'Routine compaction or ordinary session recovery — use session:request-compaction. Never start while an owner message is unanswered or work is uncheckpointed. Never retire a class without first reading its report — the tool refuses if the class is not yet evidence-clear.',
    seeAlso: ['session:request-compaction', 'coord:orient'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 10 } },
  args: argsSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const result =
      args.op === 'start'
        ? await startColdBootDrill({
            ownerId: identity.ownerId,
            ownerLabel: identity.ownerLabel,
            workspaceId: identity.workspaceId,
            sessionClass: args.sessionClass,
            effectiveWindowTokens: args.effectiveWindowTokens,
            acknowledgeOwnerHistoryUncertainty: args.acknowledgeOwnerHistoryUncertainty,
            note: args.note,
          })
        : args.op === 'grade'
          ? await gradeColdBootDrill(identity.ownerId, args.drillId)
          : args.op === 'verify'
            ? await verifyColdBootDrill(identity.ownerId, {
                drillId: args.drillId,
                sessionClass: args.sessionClass,
              })
            : args.op === 'retire'
              ? await (async () => {
                  const report = await reportResidualCarrySamples();
                  const cls = report.perClass.find((c) => c.sessionClass === args.sessionClass);
                  if (!cls || !cls.retire) {
                    return {
                      ok: false as const,
                      error: 'insufficient-evidence',
                      sessionClass: args.sessionClass,
                      stats: cls ?? null,
                      params: report.params,
                    };
                  }
                  return retireResidualClass(
                    args.sessionClass,
                    {
                      retiredBy: identity.ownerId,
                      evidence: { n: cls.n, missRate: cls.missRate, errorCount: cls.errorCount },
                      note: args.note,
                    },
                  );
                })()
              : args.op === 'unretire'
                ? { ok: true as const, removed: await unretireResidualClass(args.sessionClass) }
                : // op:'report' — drill sufficiency + terminal outcomes, PLUS the P-019
                  // residual miss-rate corpus (per-class retire verdicts, D-010) and the
                  // classes already retired: the three halves of P-022's per-class
                  // retirement evidence on one surface.
                  {
                    ...(await reportColdBootDrills()),
                    residual: await reportResidualCarrySamples(),
                    retiredClasses: await readRetiredResidualClasses(),
                  };
    const failed = 'ok' in result && result.ok === false;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(failed ? { isError: true } : {}),
    };
  },
});
