/**
 * cupboard:statement-attestation — outside-accountant attestations of a closed
 * monthly statement (agent-economy-flywheel-2026-08-30 P-047, D-031).
 *
 *   record  store the public attestation record for a month and chain it, so the
 *           next hourly anchor run puts its document hash on chain beside the
 *           month root. Dry run unless confirm:true.
 *   proof   the record + its D-024 inclusion bundle, once anchored
 *   list    recorded attestations (optionally one month)
 *   verify  check a proof against public chain data (and the document hash, if given)
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({ data: payload });

const HEX64 = /^[0-9a-fA-F]{64}$/;

export default defineTool({
  name: 'cupboard:statement-attestation',
  capability: 'harness:write',
  description:
    "Outside-accountant attestations of a closed monthly statement: `record` (month, documentSha256, attestor, attestedOn, scope; dry run unless confirm:true) chains the document hash for anchoring beside the month root; `proof`, `list`, `verify` (proof) against public chain data.",
  guidance: {
    when: "An accountant has signed off a published monthly statement and the sign-off must be anchored, or someone must check such an attestation.",
    notWhen: 'Publishing the statement itself (the hourly transparency pass does that); proving a payment (cupboard:payment-receipt).',
    chaining: 'Needs the month\'s signed statement already published. `proof` returns `not-yet-anchored` until the next hourly anchor pass.',
    seeAlso: ['cupboard:ledger-anchor', 'cupboard:payment-receipt'],
  },
  args: z.object({
    op: z.enum(['record', 'proof', 'list', 'verify']),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('record/proof/list: the attested month, YYYY-MM.'),
    documentSha256: z.string().regex(HEX64).optional().describe('SHA-256 of the signed attestation document (record: required; proof/verify: optional).'),
    attestorName: z.string().min(1).max(200).optional().describe('record: who signed the attestation.'),
    attestorFirm: z.string().max(200).optional().describe('record: the accounting firm, if any.'),
    attestedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('record: the date on the document, YYYY-MM-DD.'),
    scope: z
      .array(z.enum(['stripe-balance-transactions', 'stripe-payouts', 'bank-feed']))
      .min(1)
      .optional()
      .describe('record: what the accountant checked the statement against.'),
    statementDigest: z.string().regex(HEX64).optional().describe('record: the statement digest the document names; must match the published one.'),
    proof: z.record(z.string(), z.unknown()).optional().describe('verify: a proof exactly as `proof` returned it.'),
    expectedAttester: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe('verify: pin the published anchor address.'),
    confirm: z.boolean().default(false).describe('record: true stores and chains; false only validates.'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, store] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/statement-attestation-store'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const documentSha256 = args.documentSha256?.toLowerCase();

    if (args.op === 'list') {
      const rows = await store.listStatementAttestations(workspaceId, args.month);
      return text({ ok: true, count: rows.length, attestations: rows.map((r) => ({ ...r.record, recordedBy: r.recordedBy })) });
    }

    if (args.op === 'proof') {
      if (!args.month) return text({ ok: false, error: 'proof needs month' });
      return text({ ...(await store.statementAttestationProof(workspaceId, args.month, documentSha256)) });
    }

    if (args.op === 'record') {
      if (!args.month || !documentSha256 || !args.attestorName || !args.attestedOn || !args.scope) {
        return text({ ok: false, error: 'record needs month, documentSha256, attestorName, attestedOn and scope' });
      }
      const { openTransparencyWorker } = await import('../../cupboard/transparency-runtime');
      const opened = await openTransparencyWorker();
      if (!opened.worker) return text({ ok: false, error: 'worker-unavailable', detail: opened.unavailable });
      const input = {
        month: args.month,
        documentSha256,
        attestorName: args.attestorName,
        attestorFirm: args.attestorFirm ?? null,
        attestedOn: args.attestedOn,
        scope: args.scope,
        ...(args.statementDigest ? { expectedStatementDigest: args.statementDigest.toLowerCase() } : {}),
        recordedBy: ctx?.principal?.slug ?? null,
      };
      if (!args.confirm) {
        // Validate against the published statement without writing: a memory store and chain take the writes.
        const { memoryLedgerChainLinkStore } = await import('../../cupboard/ledger-chain');
        const preview = await store.recordStatementAttestation(workspaceId, input, {
          worker: opened.worker,
          store: store.memoryStatementAttestationStore(),
          chain: memoryLedgerChainLinkStore(),
        });
        return text({ ...preview, dryRun: true, note: preview.ok ? 'Re-run with confirm:true to store and chain it.' : undefined });
      }
      return text({ ...(await store.recordStatementAttestation(workspaceId, input, { worker: opened.worker })) });
    }

    if (!args.proof) return text({ ok: false, error: 'verify needs proof' });
    const [attestationMod, eas] = await Promise.all([
      import('../../cupboard/statement-attestation'),
      import('../../cupboard/ledger-anchor-eas'),
    ]);
    const proof = args.proof as unknown as import('../../cupboard/statement-attestation').StatementAttestationProof;
    const chainId = proof.bundle?.anchor?.chainId ?? null;
    const spec = chainId === null ? undefined : eas.ANCHOR_CHAINS[chainId];
    if (proof.bundle?.anchor?.backend !== 'eas' || !spec) {
      return text({ ok: false, reason: 'malformed', error: `cannot read anchors for chain ${String(chainId)}` });
    }
    const resolved = eas.resolveAnchorBackend();
    const { http } = await import('viem');
    const rpcUrl = chainId === resolved.config.chainId ? resolved.config.rpcUrl : spec.chain.rpcUrls.default.http[0]!;
    const reader = eas.easAnchorReader({ chain: spec.chain, transport: http(rpcUrl) });
    const expectedAttester = args.expectedAttester ?? (resolved.ok ? resolved.backend.attester : undefined);
    const verdict = await attestationMod.verifyStatementAttestation(proof, reader, {
      ...(documentSha256 ? { documentSha256 } : {}),
      ...(expectedAttester ? { expectedAttester } : {}),
    });
    return text({ ...verdict, rpcUrl, ...(expectedAttester ? { expectedAttester: expectedAttester.toLowerCase() } : {}) });
  },
});
