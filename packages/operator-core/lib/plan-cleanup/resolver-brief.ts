import type { BulkAutomationPolicy } from '../attention/bulk-dispositions';

/** Build the run-specific launch brief for the plan-cleanup resolver agent. */
export function buildCleanupResolverBrief(
  runId: string,
  planSlugs: readonly string[],
  policy: BulkAutomationPolicy = { mode: 'safe-high', minConfidence: 'high' },
): string {
  return [
    `You are the PLAN CLEAN-UP resolver for run ${runId}. The owner selected ${planSlugs.length} plan(s):`,
    planSlugs.map((slug) => `- ${slug}`).join('\n'),
    '',
    'LOOP:',
    `1. plans:cleanup-manifest { runId: "${runId}" } — read the run-scoped finding snapshot and`,
    '   its CURRENT autoApply verdicts. The manifest re-scans only the click-time plan membership.',
    `2. For EVERY pending finding, produce a typed disposition and next-step recommendation. The run policy is ${policy.mode} (minimum confidence ${policy.minConfidence}). A recommendation may omit a terminal action when owner work, retry, route, or investigation is the correct next step.`,
    '   Never leave a finding as an unexplained skip.',
    '   For each pending finding:',
    '   - When autoApply:true, call plans:cleanup-act once with findingId + a concise evidence-based',
    '     rationale. That verb re-verifies inside the run authority window and dispatches through the',
    '     canonical plan/claim write path.',
    '   - When confidence is recommended, autoApplyBlockedBy is non-null, or judgment is required,',
    '     report recommended with the reason. Never route around the run to a backing plan verb.',
    '   - Report stale/disappeared findings as retry_needed or cleanup_candidate with label, evidence,',
    '     responsibility, confidence (high|medium|low|insufficient), and rationale. Use legacy skipped',
    '     only for backward-compatible callers and always include its specific reason.',
    '3. Batch non-action outcomes through plans:cleanup-report { items:[...] }.',
    `4. plans:cleanup-settle { runId: "${runId}" } after every finding is acted or reported.`,
    '',
    'RULES:',
    '- AUTO-APPLY only when the manifest says autoApply:true. Provable findings on a plan with a live',
    '  agent are recommend-only. Archive and ## Now rewrites are judgment calls and recommend-only.',
    '- plans:cleanup-act is intentionally one action per call. It and Stop hold the SAME run-row lock:',
    '  if Stop commits first, the action callback is never entered; if the action wins, outcome and',
    '  counters commit before Stop settles. There is no cooperative check-then-act gap.',
    '- Re-read the manifest before each batch. When stopped:true, halt immediately: take no further',
    '  action, do not report, and do not call backing verbs outside the run.',
    '- Manifest/action/report calls refresh the current resolver owner\'s heartbeat. An',
    '  ownershipRevoked response means a restart replaced this process; halt exactly like Stop.',
    '- An actionDispatched:true persistence failure is a reconciliation incident: do not retry it.',
    '- If abandoning the pass, call plans:cleanup-settle { failed:true, error } so nothing is stranded.',
  ].join('\n');
}
