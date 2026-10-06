/**
 * cupboard:ledger-anchor-run — run one hourly anchoring pass for this
 * workspace now (agent-economy-flywheel-2026-08-30 P-041, D-024). The DBOS
 * schedule runs the same pass every 15 minutes; this is the manual lever.
 * Without `confirm:true` it reports what the pass would do and publishes nothing.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:ledger-anchor-run',
  capability: 'harness:write',
  description:
    "Run one ledger anchoring pass for this workspace now: log new chain links, publish the completed hour's root (EAS on Base Sepolia), check cadence, then push the public transparency report. Dry run unless confirm:true.",
  guidance: {
    when: 'The hourly anchor is behind (a missed-hour alert, or cupboard:ledger-anchor status shows cadence missed) and the cause is fixed.',
    notWhen: 'Reading anchor state or proofs (cupboard:ledger-anchor). An hour that is already anchored is a no-op.',
    chaining: 'A failed tick names the error (e.g. insufficient funds = the anchor key needs Base Sepolia test ETH).',
    seeAlso: ['cupboard:ledger-anchor'],
  },
  args: z.object({
    confirm: z.boolean().default(false).describe('true publishes; false only reports.'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, eas, store, runtime] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/ledger-anchor-eas'),
      import('../../cupboard/ledger-anchor-store'),
      import('../../cupboard/ledger-anchor-runtime'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    if (!args.confirm) {
      const resolved = eas.resolveAnchorBackend();
      const [leaves, links] = await Promise.all([
        store.pgLedgerAnchorStore().leaves(workspaceId),
        store.pgAnchorLinkFeed().links(workspaceId),
      ]);
      return text({
        ok: true,
        dryRun: true,
        workspaceId,
        backendReady: resolved.ok,
        ...(resolved.ok ? {} : { backendUnavailable: `${resolved.reason}: ${resolved.detail}` }),
        pendingLinks: Math.max(0, links.length - leaves.length),
        note: 'Re-run with confirm:true to publish.',
      });
    }
    const result = await runtime.runLedgerAnchorPass({ workspaces: [workspaceId] });
    const ws = result.workspaces[0];
    // The schedule pushes the transparency report right after anchoring (P-044); so does the manual lever.
    const { runTransparencyPass } = await import('../../cupboard/transparency-runtime');
    const transparency = await runTransparencyPass({ workspaces: [workspaceId] }).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    return text({
      ok: ws?.tick.status === 'anchored' || ws?.tick.status === 'already-anchored',
      backend: result.backend,
      backendUnavailable: result.backendUnavailable,
      workspace: ws ?? null,
      transparency,
    });
  },
});
