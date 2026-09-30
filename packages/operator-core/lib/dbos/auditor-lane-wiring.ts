/**
 * G2 Auditor Lane Wiring — P-007 of papercusp-user-protection-gate-2026-05-31.
 *
 * Provides the real `AuditorSpawnFn` and `CreateEscalationFn` implementations
 * that the DBOS orchestrator loop's auditor lane requires.
 *
 * Loaded + wired by `wireOrchestratorInvokeRunner()` (in orchestrator-runner.ts)
 * when `PAPERCUSP_DBOS_ORCHESTRATOR=1`.
 *
 * Spawn path:
 *   - Uses `spawnInvokeOnce` (the same helper as the debugger and finalizer)
 *     to run the `auditor` role via the harness's configured agent CLI.
 *   - Passes `FEATURE_ID=<fid>` so the orchestrator assembles the right prompt
 *     (feature title + summary injected by the prompt-build layer).
 *   - Also passes `AUDITOR_FEATURE_CONTEXT=<context>` so the auditor's prompt
 *     can include the feature content directly if the prompt-build doesn't.
 *   - Parses the auditor's JSON output via `parseAuditorOutput`.
 *
 * Escalation path:
 *   - Creates a coord escalation (`openEscalation`) at severity='blocker',
 *     carrying the feature id, harness slug, verdict reasons, and override
 *     instructions for the human (admit or confirm-reject via coord:resolve).
 *
 * Both are best-effort: any failure returns null / logs + continues.
 */
import { parseAuditorOutput } from '@papercusp/orchestrator';
import type { AuditorSpawnFn, CreateEscalationFn } from '@papercusp/orchestrator';
import { resolveLaunchRole } from '../blueprint/launch-blueprint';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';
import { spawnInvokeOnce } from './orchestrator-runner';
import { setAuditorLaneFns } from './orchestrator-loop';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';

/**
 * Spawn the `auditor` role for one feature through the ONE spawn chokepoint
 * (`spawnInvokeOnce` — the same governed + paced helper the debugger/finalizer
 * use). Parses the agent's JSON output. Returns null on failure — the lane treats
 * null as fail-safe reject.
 */
async function spawnAuditorInvokeOnce(
  projectDir: string,
  harnessSlug: string,
  featureId: string,
  featureContext: string,
  workspaceId: string,
): Promise<{ output: string; exitCode: number }> {
  const extras = [
    `FEATURE_ID=${featureId}`,
    `AUDITOR_FEATURE_CONTEXT=${featureContext}`,
  ];
  // unify-agent-launches-as-blueprints D-002/D-006: the role is DECLARED by the
  // `audit` launch blueprint (decider auditor) + resolved here, rather than a
  // hardcoded literal — so the launch is declarative. The auditor is a LIVE
  // user-protection gate (its verdict synchronously gates feature admission), so we
  // keep the synchronous spawn + verdict-parse + escalate behavior unchanged and
  // fall back to the literal on any resolution error — the gate must never fail to
  // spawn because a blueprint file couldn't be read.
  let role = 'auditor';
  try {
    role = await resolveLaunchRole('audit');
  } catch (err) {
    console.warn(`[auditor-spawn] audit blueprint role resolve failed, using 'auditor': ${(err as Error).message}`);
  }
  // P-008: route through `spawnInvokeOnce` (the single governed chokepoint) instead
  // of a private `buildInvokeOnce` + raw `child_process.spawn` — the prior inlined
  // spawn matched this module's doc-comment claim ("Uses spawnInvokeOnce") but not
  // its code, and bypassed the governor's pacing. Behavior is preserved (synchronous
  // verdict; fail-safe reject on non-zero/empty); the per-auditor 120s timeout
  // optimization defers to invoke-once's own timeout (a safe upper bound).
  const r = await spawnInvokeOnce(projectDir, role, extras, buildPipelineExtraEnv({ harnessSlug, workspaceId }));
  if (r.exitCode !== 0 && r.stderr?.trim()) {
    console.error(
      `[auditor-spawn] ${harnessSlug}/${featureId} exit ${r.exitCode} — stderr:\n${r.stderr.trim().slice(0, 2000)}`,
    );
  }
  // Strip orchestrator timestamp lines, keep agent output.
  const output = r.output
    .split('\n')
    .filter((l) => !/^\[20\d\d-\d\d-\d\dT/.test(l))
    .join('\n')
    .trim();
  return { output, exitCode: r.exitCode };
}

export const realAuditorSpawn: AuditorSpawnFn = async (
  harnessSlug,
  featureId,
  featureContext,
) => {
  try {
    const workspaceId = activeWorkspaceId();
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) {
      console.warn(`[auditor-spawn] unknown harness ${harnessSlug} — skip`);
      return null;
    }
    const { output, exitCode } = await spawnAuditorInvokeOnce(
      project.path,
      harnessSlug,
      featureId,
      featureContext,
      workspaceId,
    );
    if (exitCode !== 0 || !output.trim()) {
      console.warn(`[auditor-spawn] ${harnessSlug}/${featureId} non-zero exit (${exitCode}) or empty output`);
      return null;
    }
    const verdict = parseAuditorOutput(output);
    if (!verdict) {
      console.warn(`[auditor-spawn] ${harnessSlug}/${featureId} unparseable output: ${output.slice(0, 200)}`);
      return null;
    }
    return verdict;
  } catch (err) {
    console.error(`[auditor-spawn] ${harnessSlug}/${featureId} error:`, (err as Error).message);
    return null;
  }
};

/**
 * Create a `blocker` coord escalation for a rejected remote feature so the
 * human can override→admit or confirm-reject via coord:resolve.
 * Uses a stable system identity (`pc-auditor-gate`) — not a user session.
 */
export const realCreateEscalation: CreateEscalationFn = async ({
  featureId,
  harnessSlug,
  reasons,
}) => {
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    // System-level identity for the auditor gate (not a user-session actor).
    // The owner id is stable so the escalation is attributable.
    const identity = {
      ownerId: 'pc-auditor-gate',
      ownerLabel: 'auditor-gate · system',
      source: 'principal' as const,
      workspaceId: null,
      userId: null,
    };
    await openEscalation(identity, {
      severity: 'blocker',
      summary: `Auditor rejected remote feature ${featureId} (${harnessSlug}) — human review required`,
      body:
        `The G2 auditor screened a remote-authored feature and rejected it.\n\n` +
        `**Feature:** \`${featureId}\` in harness \`${harnessSlug}\`\n\n` +
        `**Reasons:** ${reasons}\n\n` +
        `**Actions:**\n` +
        `- **Override → admit**: call \`coord:resolve\` with choice \`admit\` if you have reviewed the feature and it is safe.\n` +
        `- **Confirm reject**: call \`coord:resolve\` with choice \`reject\` to confirm the feature stays quarantined.\n` +
        `- **Want a deeper look first?** Run the \`review\` blueprint on the quarantined feature — its ` +
        `dimension-reviewer → adversarial-verifier → synthesizer loop produces a full report to inform ` +
        `your decision (unify-agent-launches D-011: the deep multi-dimension review runs AFTER quarantine, ` +
        `never at the blocking gate).\n\n` +
        `The feature will remain quarantined (not auto-picked) until a human resolves this escalation.`,
      options: [
        { id: 'admit', label: 'Override → admit (I reviewed it and it is safe)' },
        { id: 'reject', label: 'Confirm reject (quarantine permanently)' },
      ],
      meta: { harnessSlug, featureId },
    });
    console.log(
      `[auditor-dispatch] escalation created for rejected feature ${harnessSlug}/${featureId}`,
    );
  } catch (err) {
    console.error(
      `[auditor-dispatch] escalation create error for ${harnessSlug}/${featureId}:`,
      (err as Error).message,
    );
    throw err; // let the lane's error path log it
  }
};

let _wired = false;
/** Wire the real auditor spawn + escalation functions into the orchestrator loop. Idempotent. */
export function wireAuditorLane(): void {
  if (_wired) return;
  _wired = true;
  setAuditorLaneFns(realAuditorSpawn, realCreateEscalation);
}
