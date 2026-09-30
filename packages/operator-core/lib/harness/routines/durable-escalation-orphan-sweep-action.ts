/**
 * Durable system action for the durable-escalation orphan sweep (WI-1741477).
 *
 * EI-19339499404613652 built the detector — `durable-escalation-orphan-scan.ts` (pure
 * classifier) and `durable-escalation-orphan-sweep.ts` (read-only ledger adapter) — and
 * nothing invoked it. A detector with no caller is precisely the failure mode the parent
 * item is about: an instrument that exists and never fires. This is its caller.
 *
 * Like `dead-citation-sweep-action.ts` this makes no LLM call: "is this emitter's open-row
 * age far outside its OWN close-time distribution" is arithmetic over a ledger read, not a
 * judgment, so there is nothing here to clock or budget beyond the SQL.
 *
 * ⛔ THERE IS DELIBERATELY NO AUTO-CLOSE, AND NONE MAY BE ADDED. Silence past an emitter's
 * own norm is consistent with BOTH "the work completed and the close never ran" and "the
 * condition is no longer observed", and only the first would justify resolving anything.
 * The scan module exposes no close path and no safe-to-close flag on purpose; this action
 * reports and files, and a human or a later triage lane decides. Auto-closing here would
 * convert an unresolved-orphan detector into an orphan-manufacturing machine.
 */
import { getOrgPg } from '@papercusp/db-org';
import { captureImprovement } from '../improvements/capture-core';
import {
  actionableFindings,
  type EmitterFinding,
  type ScanReport,
} from '../../durable-escalation-orphan-scan';
import { sweepDurableEscalations } from '../../durable-escalation-orphan-sweep';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const DURABLE_ESCALATION_ORPHAN_SWEEP = 'durable-escalation-orphan-sweep';

/**
 * One open item per condition, refreshed rather than re-filed (WI-39604). A recurring
 * detector that files a fresh sibling every tick buries its own signal, and the daily
 * cadence below would produce a new row every day for as long as the condition stands.
 */
export function durableEscalationOrphanWatchdogKey(workspaceId: string): string {
  return `${DURABLE_ESCALATION_ORPHAN_SWEEP}:${workspaceId}`;
}

/** Separate key so a MEASUREMENT failure can never be deduped against a FINDINGS report. */
export function durableEscalationScanBlindWatchdogKey(workspaceId: string): string {
  return `${DURABLE_ESCALATION_ORPHAN_SWEEP}:measured-nothing:${workspaceId}`;
}

function renderFinding(f: EmitterFinding): string {
  const p95 = f.p95CloseHours === null ? 'uncalibrated' : `${f.p95CloseHours.toFixed(2)}h`;
  const threshold = f.thresholdHours === null ? 'n/a' : `${f.thresholdHours.toFixed(2)}h`;
  const worst = f.anomalousOpen.length > 0 ? f.anomalousOpen[0] : null;
  const sample = f.anomalousOpen
    .slice(0, 5)
    .map((r) => `\`${r.id}\` (${r.ageHours.toFixed(1)}h)`)
    .join(', ');
  return [
    `### \`${f.emitter}\` — **${f.verdict}**`,
    '',
    `- closed: ${f.closedCount} · open: ${f.openCount} · own p95 close: ${p95} · anomaly threshold: ${threshold}`,
    `- open rows past threshold: **${f.anomalousOpen.length}**${
      worst ? ` (oldest ${worst.ageHours.toFixed(1)}h — \`${worst.id}\`)` : ''
    }`,
    f.incoherentClosedCount > 0
      ? `- ⚠ ${f.incoherentClosedCount} closed row(s) record a close BEFORE their own creation — excluded from the distribution, and a ledger defect in their own right (see WI-1713046).`
      : null,
    sample ? `- sample: ${sample}` : null,
    '',
    `${f.why}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function renderDurableEscalationOrphanBody(report: ScanReport, findings: EmitterFinding[]): string {
  return [
    `Scanned **${report.rowsScanned}** durable escalation row(s) across **${report.emittersScanned}** machine emitter(s); ` +
      `**${findings.length}** need attention.`,
    '',
    'Each emitter is calibrated against its OWN close-time distribution, not a hand-configured ' +
      'cadence — an emitter that normally closes in milliseconds and an emitter that normally takes ' +
      'two weeks are both judged against themselves.',
    '',
    '**Read the verdicts precisely — two of the three are UNDETERMINED, not accusations:**',
    '',
    '- `orphan-suspect` — a demonstrated resolve path, and open rows far past its own p95. This is the accusation.',
    '- `no-resolve-path-observed` — has never closed a single row, so no distribution exists to calibrate against.',
    '- `insufficient-close-sample` — too few closes to calibrate. **Undetermined; never read this as clean.**',
    '',
    ...findings.map(renderFinding),
    '',
    '---',
    '',
    '⛔ **Do not blanket-close the rows named here.** Silence past an emitter\'s own norm is consistent ' +
      'with BOTH "the work completed and the close never ran" and "the condition is no longer observed", ' +
      'and only the first would justify resolving. Find the resolve path first; this detector deliberately ' +
      'offers no close path.',
    '',
    `Filed by the \`${DURABLE_ESCALATION_ORPHAN_SWEEP}\` system action and re-evaluated on its next scheduled run.`,
  ].join('\n');
}

export interface DurableEscalationOrphanSweepActionDeps {
  run: (workspaceId: string) => Promise<ScanReport>;
  file: (input: {
    workspaceId: string;
    harnessSlug: string;
    report: ScanReport;
    findings: EmitterFinding[];
  }) => Promise<{ filed: boolean }>;
  fileScanBlind: (input: { workspaceId: string; harnessSlug: string }) => Promise<{ filed: boolean }>;
  log: (message: string) => void;
}

async function productionFile(input: {
  workspaceId: string;
  harnessSlug: string;
  report: ScanReport;
  findings: EmitterFinding[];
}): Promise<{ filed: boolean }> {
  if (input.findings.length === 0) return { filed: false };
  const orphanSuspects = input.findings.filter((f) => f.verdict === 'orphan-suspect').length;
  await captureImprovement({
    title:
      `Durable escalation emitters with unclosed rows past their own close-time norm ` +
      `(${input.findings.length}${orphanSuspects > 0 ? `, ${orphanSuspects} orphan-suspect` : ''})`,
    kind: 'bug',
    severity: orphanSuspects > 0 ? 'major' : 'minor',
    body: renderDurableEscalationOrphanBody(input.report, input.findings),
    scope: `harness:${input.harnessSlug}`,
    foundDuring: DURABLE_ESCALATION_ORPHAN_SWEEP,
    dedupScope: 'open',
    watchdogKey: durableEscalationOrphanWatchdogKey(input.workspaceId),
    sourceRole: 'system',
    createdBy: `system:${DURABLE_ESCALATION_ORPHAN_SWEEP}`,
    payloadExtra: {
      durableEscalationOrphanSweep: {
        rowsScanned: input.report.rowsScanned,
        emittersScanned: input.report.emittersScanned,
        emitters: input.findings.map((f) => ({
          emitter: f.emitter,
          verdict: f.verdict,
          openCount: f.openCount,
          closedCount: f.closedCount,
          p95CloseHours: f.p95CloseHours,
          anomalousOpenCount: f.anomalousOpen.length,
        })),
      },
    },
  });
  return { filed: true };
}

/**
 * A scan that read ZERO rows is a BLIND INSTRUMENT, not a clean bill of health — and the two
 * produce an identical empty `findings`. The scan module carries `rowsScanned` for exactly this
 * reason; consuming it and reporting only on `findings` would rebuild, in the caller, the
 * measurement-that-measured-nothing defect the whole detector exists to catch.
 */
async function productionFileScanBlind(input: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<{ filed: boolean }> {
  await captureImprovement({
    title: 'Durable-escalation orphan sweep read ZERO ledger rows — the detector is blind, not clean',
    kind: 'bug',
    severity: 'major',
    body: [
      `The \`${DURABLE_ESCALATION_ORPHAN_SWEEP}\` action ran against workspace \`${input.workspaceId}\` and its ` +
        'ledger read returned **zero rows**.',
      '',
      'That is NOT a clean result. Zero rows scanned and zero findings are indistinguishable in the ' +
        '`findings` array alone, which is why the scan reports `rowsScanned` separately — a detector ' +
        'reporting "nothing wrong" from a measurement that observed nothing is the exact defect this ' +
        'instrument was built to detect, reproduced one level up in its own caller.',
      '',
      'Check, in order: that `harness_shared.engineer_issues` holds rows for this workspace_id; that ' +
        'machine emitters still write `created_by` with the `system:` prefix the sweep filters on; and ' +
        'that the lookback window still covers live traffic.',
    ].join('\n'),
    scope: `harness:${input.harnessSlug}`,
    foundDuring: DURABLE_ESCALATION_ORPHAN_SWEEP,
    dedupScope: 'open',
    watchdogKey: durableEscalationScanBlindWatchdogKey(input.workspaceId),
    sourceRole: 'system',
    createdBy: `system:${DURABLE_ESCALATION_ORPHAN_SWEEP}`,
  });
  return { filed: true };
}

export function makeDurableEscalationOrphanSweepAction(
  overrides: Partial<DurableEscalationOrphanSweepActionDeps> = {},
) {
  const deps: DurableEscalationOrphanSweepActionDeps = {
    run: (workspaceId) => sweepDurableEscalations({ workspaceId }, getOrgPg().sql),
    file: productionFile,
    fileScanBlind: productionFileScanBlind,
    log: (message) => console.log(`[${DURABLE_ESCALATION_ORPHAN_SWEEP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const report = await deps.run(ctx.workspaceId);
    if (report.rowsScanned === 0) {
      const { filed } = await deps.fileScanBlind({
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
      });
      deps.log(`${ctx.installSlug}: rowsScanned=0 — BLIND, not clean; scanBlindFiled=${filed}`);
      return;
    }
    const findings = actionableFindings(report);
    const { filed } = await deps.file({
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.installSlug,
      report,
      findings,
    });
    deps.log(
      `${ctx.installSlug}: rows=${report.rowsScanned} emitters=${report.emittersScanned} ` +
        `actionable=${findings.length} ` +
        `orphanSuspect=${findings.filter((f) => f.verdict === 'orphan-suspect').length} filed=${filed}`,
    );
  };
}

registerSystemAction(DURABLE_ESCALATION_ORPHAN_SWEEP, makeDurableEscalationOrphanSweepAction());
