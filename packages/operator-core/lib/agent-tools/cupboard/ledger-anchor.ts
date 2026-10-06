/**
 * cupboard:ledger-anchor — read the hourly anchoring of the hash-chained
 * ledgers (agent-economy-flywheel-2026-08-30 P-041, D-024). Read-only: `status`
 * reports the backend, the latest anchored root and the cadence; `prove` builds
 * a portable inclusion bundle for one chain link; `verify` checks a bundle
 * against public chain data. Running a pass now is cupboard:ledger-anchor-run.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:ledger-anchor',
  capability: 'harness:read',
  description:
    'Hourly anchoring of the hash-chained ledgers on Base (EAS). `status`: backend config, latest anchored root, pending links, cadence. `prove`: a portable inclusion bundle for one chain link (stream + seq). `verify`: check a bundle against public chain data only.',
  guidance: {
    when: 'You need the anchoring state, or a third-party-checkable proof that a ledger entry existed by a given hour.',
    notWhen: 'Publishing an anchor now (cupboard:ledger-anchor-run) or verifying the chain itself (cupboard:ledger-chain).',
    chaining: '`prove` returns `not-yet-anchored` until the next hourly pass; pass `verify` the bundle exactly as `prove` returned it.',
    seeAlso: ['cupboard:ledger-anchor-run', 'cupboard:ledger-chain'],
  },
  args: z.object({
    op: z.enum(['status', 'prove', 'verify']),
    streamId: z.string().min(1).max(512).optional().describe('prove: the chain stream, e.g. money-journal.'),
    seq: z.number().int().min(0).optional().describe('prove: the link position in the stream.'),
    bundle: z.record(z.string(), z.unknown()).optional().describe('verify: a bundle from `prove`.'),
    expectedAttester: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .describe('verify: pin the published anchor address (defaults to the configured key).'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, anchor, eas, store, chain] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/ledger-anchor'),
      import('../../cupboard/ledger-anchor-eas'),
      import('../../cupboard/ledger-anchor-store'),
      import('../../cupboard/ledger-chain'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const resolved = eas.resolveAnchorBackend();
    const anchors = store.pgLedgerAnchorStore();

    if (args.op === 'status') {
      const [leaves, recorded, links] = await Promise.all([
        anchors.leaves(workspaceId),
        anchors.anchors(workspaceId),
        store.pgAnchorLinkFeed().links(workspaceId),
      ]);
      const last = recorded.at(-1) ?? null;
      return text({
        ok: true,
        workspaceId,
        logId: store.ledgerAnchorLogId(workspaceId),
        backend: resolved.ok
          ? { ready: true, kind: resolved.backend.kind, attester: resolved.backend.attester.toLowerCase(), ...resolved.config }
          : { ready: false, reason: resolved.reason, detail: resolved.detail, ...resolved.config },
        leaves: leaves.length,
        pendingLinks: Math.max(0, links.length - leaves.length),
        anchors: recorded.length,
        latest: last
          ? {
              anchorSeq: last.anchorSeq,
              logRoot: last.logRoot,
              treeSize: last.treeSize,
              windowStart: new Date(last.windowStart * 1000).toISOString(),
              windowEnd: new Date(last.windowEnd * 1000).toISOString(),
              backend: last.backend,
              chainId: last.chainId,
              ref: last.ref,
              txHash: last.txHash,
              attester: last.attester,
            }
          : null,
        cadence: anchor.anchorCadence({
          workspaceId,
          nowSeconds: Math.floor(Date.now() / 1000),
          lastWindowEnd: last?.windowEnd ?? null,
        }),
      });
    }

    if (args.op === 'prove') {
      if (!args.streamId || args.seq === undefined) return text({ ok: false, error: 'prove needs streamId and seq' });
      const link = (await chain.pgLedgerChainLinkStore().links(workspaceId, args.streamId)).find((l) => l.link.seq === args.seq);
      if (!link) return text({ ok: false, error: 'no-such-link' });
      const bundle = await anchor.buildInclusionBundle({ workspaceId, link: link.link, store: anchors });
      return 'error' in bundle ? text({ ok: false, error: bundle.error }) : text({ ok: true, bundle });
    }

    if (!args.bundle) return text({ ok: false, error: 'verify needs bundle' });
    const bundle = args.bundle as unknown as import('../../cupboard/ledger-anchor').AnchorInclusionBundle;
    const chainId = bundle.anchor?.chainId ?? null;
    const spec = chainId === null ? undefined : eas.ANCHOR_CHAINS[chainId];
    if (bundle.anchor?.backend !== 'eas' || !spec) {
      return text({ ok: false, error: `cannot read anchors for backend ${String(bundle.anchor?.backend)} on chain ${String(chainId)}` });
    }
    const { http } = await import('viem');
    const rpcUrl = chainId === resolved.config.chainId ? resolved.config.rpcUrl : spec.chain.rpcUrls.default.http[0]!;
    const reader = eas.easAnchorReader({ chain: spec.chain, transport: http(rpcUrl) });
    const expectedAttester = args.expectedAttester ?? (resolved.ok ? resolved.backend.attester : undefined);
    const verdict = await anchor.verifyInclusionBundle(bundle, reader, expectedAttester ? { expectedAttester } : {});
    return text({ ...verdict, rpcUrl, ...(expectedAttester ? { expectedAttester: expectedAttester.toLowerCase() } : {}) });
  },
});
