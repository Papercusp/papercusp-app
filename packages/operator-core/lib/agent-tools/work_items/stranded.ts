/**
 * work_items:stranded — the triage read for FINISHED-BUT-STILL-OPEN work (WI-38297).
 *
 * Read-only companion to `work_items:claimable`. Where that tool answers "what can I
 * take", this one answers the question that was previously unaskable in bulk: "which
 * open items are already DONE and only missing their closure?" The derivation, the
 * measured ~43% precision that makes this a queue rather than a sweep, and the
 * classifiers rejected on that evidence all live in `../../stranded-checkpoint-scan`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { scanStrandedCheckpoints } from '../../stranded-checkpoint-scan';

export default defineTool({
  name: 'work_items:stranded',
  profile: 'engineer',
  description:
    // PROMPT-WEIGHT: keep this + guidance under 1500 chars (tool-guidance-budget).
    // The derivation, the precision measurement and the rejected classifiers are in
    // the scan module's header, deliberately not here.
    "Open issue-family items whose OWN checkpoint declares the work finished — the stranded-finished backlog (code committed, item never closed because the holder's verification job died with their session). Returns candidates + the checkpoint HEAD that matched, oldest/strongest first. READ-ONLY and deliberately not a sweep: the classifier measured ~43% precise, and its false positives include notes reading '⛔ DO NOT CLOSE' and 'CLAIMED, no code written yet'. SOURCE-VERIFY every candidate before closing it. `citesBgJob` marks the stronger subset (the checkpoint's promised evidence was a background job that cannot outlive its author). `matched` counts the WHOLE population; the row list is a page (`truncatedByLimit`). `closableLocally:false` marks a remote-authored item this node CANNOT complete — verify it, then hand its authoring peer the evidence.",
  guidance: {
    when:
      "Draining/triaging a backlog, or auditing why it is not shrinking — to find work that is already committed and needs only verify-and-close.",
    notWhen:
      "What you can CLAIM → work_items:claimable. ONE item's prior work → work_items:get (its own checkpoint + priorWork warnings). Never wire this to an auto-closer: at ~43% precision that re-labels genuinely-open work as done.",
    chaining:
      "→ work_items:get { id } (read the full checkpoint) → verify the fix in source/tests → work_items:claim → work_items:complete.",
    seeAlso: [
      'work_items:claimable (what is actually claimable — the SSOT claim floors)',
      'work_items:release (warns at the moment a strand is created)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('restrict to one harness lane; omit ⇒ every harness in the workspace'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('max candidate ROWS to return (default 20, cap 100). Never bounds `matched`/`scanned`.'),
    headChars: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe('chars of each checkpoint HEAD to return (default 400)'),
    minAgeDays: z
      .number()
      .int()
      .nonnegative()
      .max(365)
      .optional()
      .describe(
        'only checkpoints at least this many days old (default 0 = no floor). Raises precision sharply: an agent whose checkpoint mentions a running job is usually an agent working RIGHT NOW, so most 0-day matches are in-flight work, not strands.',
      ),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(
      (ctx as { workspaceId?: string | null }).workspaceId,
      ctx.principal?.workspaceId,
    );
    const result = await scanStrandedCheckpoints({
      workspaceId,
      harness: args.harness ?? null,
      limit: args.limit ?? 20,
      headChars: args.headChars,
      minAgeDays: args.minAgeDays,
    });

    const payload = {
      ok: true as const,
      workspaceId,
      harness: args.harness ?? null,
      ...result,
      note:
        'CANDIDATES, not a verdict. The classifier (checkpointDeclaresTerminal) measured ~43% precise over this ' +
        'population by hand-reading every match — so roughly two in five are NOT finished, and the observed false ' +
        'positives are emphatic ("⛔ DO NOT CLOSE…", "CLAIMED, no code written yet"). Read each checkpointHead, then ' +
        'verify the claim IN SOURCE (the commit/tests it names) before claiming and completing. `matched`/`scanned` ' +
        'are totals over the whole population; `candidates` is a page — check `truncatedByLimit` before quoting the ' +
        'row count as the size of the problem. CHECK `closableLocally` BEFORE YOU START: a remote-authored candidate ' +
        'REFUSES work_items:complete on this node ("its authoring peer must claim/resolve it"), and nothing else in ' +
        'the row predicts it — you find out only after paying the full verification cost. It is not a skip signal: ' +
        'verify it, then post the evidence as a comment so its authoring peer can close it (that federates). ' +
        '`matchedNotClosableLocally` sizes that subset over the whole population — measured 15% of open checkpointed ' +
        'items when this was added.',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
