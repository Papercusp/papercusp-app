/**
 * `system:gate-canary-sweep` — the missing SCHEDULED counterpart of the
 * on-demand `gates:canary-check` tool (fleet-reliability-verification-
 * 2026-07-10 P-011 substrate, `gates/canary.ts`).
 *
 * WI-5977 (explicit-presence-as-convention-2026-07-26): "a built-in CANARY
 * job that deliberately [proves it can fail], so a runner that ever reports
 * it green is caught by the system rather than by whoever happened to be
 * careful that day." The `GateCanaryDef` substrate + the federation-probe and
 * green-checkpoint canaries have existed since 2026-07-10, and
 * green-checkpoint-canary.ts's own file header already claimed a "scheduled
 * (system:gate-canary-sweep) counterpart" — but nothing ever registered that
 * action or seeded a routine for it (reuse-first search, 2026-07-26: zero
 * hits for `gate-canary-sweep` anywhere in the tree before this file). This
 * closes that gap.
 *
 * WI-6005 widened the first pass in two ways it had explicitly deferred:
 *
 *   1. **Real escalation on a gate alarm.** A canary alarm ('gate') means a
 *      KNOWN-GOOD sample failed the apparatus itself — exactly the class this
 *      whole substrate exists to catch, and the first pass only logged +
 *      recorded a fact for it. `recordCanaryVerdict()` below now fires the
 *      SAME `notifyAttention` + durable `harness_escalations` one-shot/
 *      recovery-clear pair every other "real gate-broken signal" in this
 *      codebase uses (release-actions.ts's `GATE_STALL_PHASE`, green-stall-
 *      watchdog.ts's `WATCHDOG_PHASE`) — an urgent owner ping, plus a durable
 *      row so a stuck alarm survives a restart and is queryable, deduped so a
 *      standing alarm doesn't re-ping every tick, and cleared on recovery.
 *
 *   2. **The green-checkpoint result-parser canary.** Deferred in the first
 *      pass because it lives in `apps/operator/lib/release/
 *      green-checkpoint-canary.ts` — APPS/OPERATOR tier, which operator-core
 *      must not import (the same layering `system:green-checkpoint` /
 *      `system:autoloop-release-readiness-monitor` already respect; see
 *      autoloop-release-readiness-action.ts's header). This sweeps it too, on
 *      the SAME cadence as the federation-probe canary, by shelling out to a
 *      standalone CLI (`apps/operator/lib/release/
 *      run-green-checkpoint-canary.ts`) — mirroring exactly how
 *      `system:autoloop-release-readiness-monitor` shells out to
 *      `run-autoloop-release-profile.ts`. Unlike the federation-probe canary,
 *      this one is NOT federation-scoped (it is a pure apparatus check with no
 *      dependency on the target harness being a registered hive), so it runs
 *      unconditionally every tick, independent of the `isRegisteredHive` gate
 *      below.
 *
 * TARGET HARNESS: the routine's OWN `install_slug` (`ctx.installSlug`) is the
 * harness the federation-probe canary checks, exactly like every other
 * per-harness system action. If that harness is not actually a registered
 * federated hive (isRegisteredHive), the federation-probe sweep reports
 * INDETERMINATE (verdict 'unknown', alarm 'none') rather than manufacturing a
 * false 'gate-broken' alarm — the same EI-11574 lesson `gates:canary-check`
 * already applies to a missing/wildcard harness.
 *
 * Records the verdict as a per-harness fact every tick (one fact key per
 * canary: `GATE_CANARY_SWEEP_FACT_KEY` for the federation-probe canary,
 * `GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY` for the result-parser canary) so a
 * stale/silently-stopped sweep is visible via `facts:list`, mirroring
 * autoloop-release-readiness-action.ts.
 *
 * Seeded INACTIVE (seed-gate-canary-sweep-routine.ts) — same bring-up
 * discipline as every other routine registered here: the routines engine on
 * the GREEN `:3070` operator won't know this action name until the staging→
 * main deploy carries it, and the seed script also needs a real federated
 * harness slug named explicitly (never guessed) before it is worth arming.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { assertFact } from '../agent-facts/store';
import { isRegisteredHive } from '../harness-registry';
import { insertProbe } from '../sync/pot-git/federation-probe-store';
import { buildFederationProbeCanary } from './federation-probe-canary';
import { runGateCanary, classifyGateCanary, type GateCanaryReport } from './canary';

export const GATE_CANARY_SWEEP_FACT_KEY = 'gate-canary-sweep-verdict';
export const GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY = 'gate-canary-sweep-verdict:green-checkpoint-parser';
export const GATE_CANARY_SWEEP_ACTION_NAME = 'gate-canary-sweep';

/** Distinct `harness_escalations.phase` per canary, so the two dedup/recover
 *  independently and never clobber each other's row (mirrors every sibling
 *  watchdog in this codebase using one phase per condition). */
const FEDERATION_PROBE_ESCALATION_PHASE = 'gate-canary-sweep:federation-probe';
const GREEN_CHECKPOINT_PARSER_ESCALATION_PHASE = 'gate-canary-sweep:green-checkpoint-parser';

/**
 * Shared by both canaries: log, assert the per-canary fact (every tick,
 * regardless of alarm state — mirrors the rest of this file), and fire the
 * real escalation (WI-6005) on an alarm transition. Never throws — a failure
 * anywhere in here must not break the sweep tick or the OTHER canary's own
 * handling.
 */
async function recordCanaryVerdict(opts: {
  ctx: SystemActionCtx;
  report: GateCanaryReport;
  factKey: string;
  escalationPhase: string;
  title: string;
}): Promise<void> {
  const { ctx, report, factKey, escalationPhase, title } = opts;
  const line = `[gate-canary-sweep] ${ctx.installSlug} ${report.id}: verdict=${report.classification.verdict} alarm=${report.classification.alarm} — ${report.classification.detail}`;
  if (report.classification.alarm === 'none') {
    console.log(line);
  } else {
    // alarm:'gate' — a KNOWN-GOOD sample failed the apparatus itself. This is
    // exactly the class WI-5977 exists to catch: a runner that would otherwise
    // report green (or silently stop reporting at all) while broken.
    console.warn(line);
  }

  await assertFact({
    scope: 'harness',
    scopeRef: ctx.installSlug,
    key: factKey,
    body: `gate-canary-sweep(${report.id}): ${report.classification.verdict.toUpperCase()} (alarm=${report.classification.alarm}) — ${report.canaryDetail}`.slice(0, 500),
    createdBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
    ttlSec: 24 * 3600,
    workspaceId: ctx.workspaceId,
  }).catch((e) => {
    console.warn(`[gate-canary-sweep] fact assert failed for ${report.id} (non-fatal):`, e instanceof Error ? e.message : e);
  });

  // WI-6005: real escalation on a gate alarm — the same notifyAttention +
  // durable harness_escalations one-shot/recovery-clear pair every other
  // "real gate-broken signal" in this codebase uses.
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const existing = (await sql.unsafe(
      `SELECT escalation FROM harness_shared.harness_escalations WHERE harness_slug = $1 AND phase = $2`,
      [ctx.installSlug, escalationPhase],
    )) as Array<{ escalation: unknown }>;
    const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

    if (report.classification.alarm !== 'none') {
      if (alreadyAlarmed) return; // one-shot until recovery, like every sibling watchdog
      try {
        const { notifyAttention } = await import('../attention-notify');
        await notifyAttention({
          kind: 'intervention',
          title,
          body:
            `${report.classification.detail} (canary: ${report.canaryDetail}). A KNOWN-GOOD sample failed to pass ` +
            `through the gate's own apparatus — green may be unreachable by construction. This is NOT by itself ` +
            'evidence of a real system failure, but the apparatus needs a look.',
          importance: 'urgent',
          workspaceId: ctx.workspaceId,
          data: { canaryId: report.id, verdict: report.classification.verdict, alarm: report.classification.alarm },
        });
      } catch (e) {
        console.warn(`[gate-canary-sweep] notify failed for ${report.id}: ${e instanceof Error ? e.message : e}`);
      }
      try {
        await sql.unsafe(
          `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (harness_slug, phase)
           DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
          [
            ctx.installSlug,
            escalationPhase,
            JSON.stringify({
              kind: escalationPhase,
              harness_slug: ctx.installSlug,
              canaryId: report.id,
              verdict: report.classification.verdict,
              alarm: report.classification.alarm,
              detail: report.classification.detail,
              canaryDetail: report.canaryDetail,
              emitted_at: Date.now(),
            }),
            Date.now(),
            ctx.workspaceId,
          ],
        );
      } catch (e) {
        console.warn(`[gate-canary-sweep] escalation write failed for ${report.id}: ${e instanceof Error ? e.message : e}`);
      }
      console.warn(`[gate-canary-sweep] ESCALATED ${report.id} on ${ctx.installSlug}: ${report.classification.detail}`);
    } else if (alreadyAlarmed) {
      await sql.unsafe(
        `UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $3
          WHERE harness_slug = $1 AND phase = $2 AND escalation IS NOT NULL`,
        [ctx.installSlug, escalationPhase, Date.now()],
      );
      console.log(`[gate-canary-sweep] RECOVERED ${report.id} on ${ctx.installSlug} — cleared the prior escalation`);
    }
  } catch (e) {
    console.warn(`[gate-canary-sweep] escalation handling failed for ${report.id} (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

// ── green-checkpoint result-parser canary (shelled out — apps/operator tier) ──

export const GREEN_CHECKPOINT_CANARY_RESULT_MARKER = '__GREEN_CHECKPOINT_CANARY_RESULT__';

/** Pure + synchronous work on the other side (checkResultParser) — 30s is generous
 *  headroom for a wedged/hung child (e.g. tsx boot cost), same discipline as the
 *  other shelled-out canaries/evaluators in this codebase. */
const GREEN_CHECKPOINT_CANARY_TIMEOUT_MS = 30_000;

function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function defaultRunGreenCheckpointCanary(root: string): Promise<CliRunResult> {
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const script = path.join(root, 'apps/operator/lib/release/run-green-checkpoint-canary.ts');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(tsx, [script], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
    });
    const finish = (r: CliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: 1, stdout, stderr: stderr + '\n[gate-canary-sweep] green-checkpoint-parser canary TIMED OUT' });
    }, GREEN_CHECKPOINT_CANARY_TIMEOUT_MS);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

export type RunGreenCheckpointCanaryFn = (root: string) => Promise<CliRunResult>;
let _runGreenCheckpointCanary: RunGreenCheckpointCanaryFn = defaultRunGreenCheckpointCanary;
/** Override the CLI runner (tests). Pass null to restore the live spawn path. */
export function setGreenCheckpointCanaryRunner(fn: RunGreenCheckpointCanaryFn | null): void {
  _runGreenCheckpointCanary = fn ?? defaultRunGreenCheckpointCanary;
}

/** Parse the JSON on the marker line (mirrors parseAutoloopVerdictMarker). Exported
 *  for unit testing without spawning a subprocess. */
export function parseGreenCheckpointCanaryMarker(stdout: string): { ok: boolean; detail?: string } | null {
  const line = stdout.split('\n').find((l) => l.includes(GREEN_CHECKPOINT_CANARY_RESULT_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(GREEN_CHECKPOINT_CANARY_RESULT_MARKER) + GREEN_CHECKPOINT_CANARY_RESULT_MARKER.length).trim()) as {
      ok: boolean;
      detail?: string;
    };
  } catch {
    return null;
  }
}

async function sweepGreenCheckpointParserCanary(ctx: SystemActionCtx): Promise<void> {
  const root = integrationRoot();
  const r = await _runGreenCheckpointCanary(root);
  const parsed = parseGreenCheckpointCanaryMarker(r.stdout);
  // A missing/unparseable marker is exactly the "canary itself could not be
  // determined" case classifyGateCanary already models (canaryOk: null) — never
  // silently dropped (the WI-2009 stale-verdict class this substrate exists to
  // catch), regardless of WHY the CLI failed to produce a verdict.
  const canaryOk = parsed ? parsed.ok : null;
  const canaryDetail = parsed
    ? (parsed.detail ?? (parsed.ok ? 'canary passed' : 'canary failed'))
    : `evaluator run produced no parseable verdict (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`;
  const classification = classifyGateCanary({ canaryOk, systemGreen: null });
  const report: GateCanaryReport = {
    id: 'green-checkpoint:result-parser',
    describe: 'a known-green + known-bad sample through the checkpoint result-parsing apparatus (shelled out — apps/operator tier)',
    ranAtMs: Date.now(),
    canaryOk,
    canaryDetail,
    systemGreen: null,
    classification,
  };
  await recordCanaryVerdict({
    ctx,
    report,
    factKey: GREEN_CHECKPOINT_PARSER_CANARY_FACT_KEY,
    escalationPhase: GREEN_CHECKPOINT_PARSER_ESCALATION_PHASE,
    title: 'Gate apparatus BROKEN — green-checkpoint result-parser canary failed',
  });
}

registerSystemAction(GATE_CANARY_SWEEP_ACTION_NAME, async (ctx: SystemActionCtx) => {
  const harnessSlug = ctx.installSlug;

  // 1. Federation-probe canary — federation-scoped (EI-11574: a non-federated /
  //    lookup-failed target is indeterminate, never a false gate-broken alarm).
  const federated = await isRegisteredHive(ctx.workspaceId, harnessSlug).catch((e) => {
    console.warn(`[gate-canary-sweep] isRegisteredHive lookup failed (treating as indeterminate): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  if (federated !== true) {
    // NOT gate-broken: a non-federated (or lookup-failed) target harness is not
    // evidence the apparatus is broken — per EI-11574, an indeterminate target
    // must never manufacture a false critical alarm.
    const detail =
      federated === null
        ? `harness-federation lookup failed for "${harnessSlug}" — canary indeterminate, not evidence of a gate failure`
        : `"${harnessSlug}" is not a registered federated hive — canary indeterminate, nothing to sweep here`;
    console.log(`[gate-canary-sweep] ${detail}`);
    await assertFact({
      scope: 'harness',
      scopeRef: harnessSlug,
      key: GATE_CANARY_SWEEP_FACT_KEY,
      body: `gate-canary-sweep: UNKNOWN (indeterminate) — ${detail}`.slice(0, 500),
      createdBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
      ttlSec: 24 * 3600,
      workspaceId: ctx.workspaceId,
    }).catch((e) => {
      console.warn('[gate-canary-sweep] fact assert failed (non-fatal):', e instanceof Error ? e.message : e);
    });
  } else {
    const canary = buildFederationProbeCanary({
      workspaceId: ctx.workspaceId,
      harnessSlug,
      emittedBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
      harnessIsFederated: () => Promise.resolve(true),
      insertProbe,
    });
    // No live systemGreen signal wired here (this is an apparatus-only sweep,
    // like the on-demand gates:canary-check tool) — pass null so a healthy
    // apparatus reads 'unknown'/alarm:'none' rather than a manufactured 'healthy'.
    const report = await runGateCanary(canary, null);
    await recordCanaryVerdict({
      ctx,
      report,
      factKey: GATE_CANARY_SWEEP_FACT_KEY,
      escalationPhase: FEDERATION_PROBE_ESCALATION_PHASE,
      title: 'Gate apparatus BROKEN — federation-probe canary failed',
    });
  }

  // 2. Green-checkpoint result-parser canary (WI-6005) — apparatus-only, NOT
  //    federation-scoped, so it runs on the SAME cadence regardless of #1's
  //    outcome above. Independently fail-safe: a failure here must never
  //    affect (or be affected by) the federation-probe sweep.
  await sweepGreenCheckpointParserCanary(ctx).catch((e) => {
    console.warn(`[gate-canary-sweep] green-checkpoint-parser sweep failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  });
});
