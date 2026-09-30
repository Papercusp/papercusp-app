/**
 * operator.* — scan / approve.
 *
 * Voice engines + palette drive these via the registry like any other
 * action. (`operator.across-workspaces` and the panel-event scan were
 * retired with the operator-card panel — unify-agent-launches D-005;
 * `operator.scan` survives, repointed at the `scan` launch blueprint.)
 */
import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type CommandDef } from '../types';

const ScanArg = z.object({
  query: z.string().nullable().optional().describe('Optional natural-language query to seed the scan.'),
});
type ScanArgT = z.infer<typeof ScanArg>;

const ApproveArg = z.object({
  slug: z.string().describe('Harness slug, e.g. "sheets" or "forms".'),
  capability: z.string().nullable().optional().describe('Optional capability id. Omit if there is exactly one pending.'),
});
type ApproveArgT = z.infer<typeof ApproveArg>;

const scan: CommandDef<ScanArgT, { ok: true }> = {
  id: 'operator.scan',
  kind: 'command',
  description:
    'Fire a workspace scan (the `scan` launch blueprint). Findings land as work_items in the self-improvement backlog.',
  schema: ScanArg,
  agents: ['operator', 'oracle', 'palette'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Run Papercup scan', icon: '⚲', keywords: 'operator scan run' },
  handler: async ({ query }) => {
    if (typeof window === 'undefined') {
      throw new CommandError({ code: 'wrong-process', message: 'scan must run in the browser', retryable: false });
    }
    // D-005 (unify-agent-launches): the scan IS the `scan` launch blueprint —
    // fire it via the invoke route (loopback inside the desktop webview).
    void fetch('/api/harness/papercup/invoke?role=scanner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kickoff: query
          ? `Palette/voice-requested workspace scan: ${query}. Capture each finding via improvements:capture.`
          : 'Palette/voice-requested workspace scan. Capture each finding via improvements:capture.',
        extra: ['BLUEPRINT_ID=scan'],
        timeoutMs: 900_000,
      }),
    }).catch(() => { /* fire-and-forget — the cadence routine is the reliable path */ });
    return { ok: true };
  },
};

const approve: CommandDef<ApproveArgT, { ok: true }> = {
  id: 'operator.approve-pending',
  kind: 'command',
  description: 'Approve a pending capability for a harness slug. Server-side; no panel needed.',
  schema: ApproveArg,
  agents: ['operator', 'oracle', 'palette'],
  // Has to be 'required' for the EL Conv AI agent: it's pushed via
  // el-agent-sync.mjs as a client-tool, and buildClientTools only
  // exposes browser:'required'. Otherwise the agent calls it and crashes
  // with "Client tool with name operator_approve_pending is not defined
  // on client". The handler still does a server-side fetch — browser
  // tag is about *where the handler runs*, not where it talks to.
  browser: 'required',
  concurrent: 'queue',
  tier: 'short',
  handler: async ({ slug, capability }) => {
    const r = await fetch('/api/agent-mcp/operator-standing-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetHarness: slug, capability, decision: 'approve' }),
    });
    if (!r.ok) {
      throw new CommandError({
        code: 'http-error',
        message: `approve failed: HTTP ${r.status}`,
        retryable: r.status >= 500,
      });
    }
    return { ok: true };
  },
};

register(scan);
register(approve);
