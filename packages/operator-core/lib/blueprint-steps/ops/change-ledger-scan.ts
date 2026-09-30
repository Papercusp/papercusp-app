/**
 * `change-ledger:scan` — the change-ledger repo-edit scan as a DETERMINISTIC
 * blueprint step (deterministic-blueprints-migration-2026-06-13 P-004 / bucket A).
 *
 * The deterministic step kind = a registered typed function (declared
 * args/result I/O) the program-mode spine runs as a checkpointed step — "a
 * defineTool-like registered function" (D-002), NOT a scripting surface. This op
 * WRAPS the shipped scan logic (`runChangeLedgerScan` — flag + git-log scan, the
 * SAME orchestration the `system:change-ledger-scan` routine runs) so the
 * migration reshapes, it does not rewrite (D-003) and stays behavior-neutral
 * (D-004): same flag, same git-log scan, same ledger dedupe.
 *
 * Pure-deterministic (git + SQL, no agent) ⇒ a gateless program-mode pipeline:
 * `blueprints/change-ledger/blueprint.yaml` declares one step that fires this op
 * and a `triggers.schedule` cadence; `system:blueprint-run` runs the program.
 * NB: pure bookkeeping (no LLM, no queue filing), so — unlike the frontier
 * miners — there is NO learning-governor gate, only the kill-switch flag.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runChangeLedgerScan, type ChangeLedgerScanDeps } from '../../change-ledger/scan-loop.js';

/** Declared input I/O — the trailing git-log window (the routine's payload knob). */
const args = z.object({
  /** Trailing git-log window in days (clamped 1..90). Default 14. */
  sinceDays: z.number().int().positive().optional(),
});

/** Declared output I/O — the scan result (or the gate that skipped it). */
const result = z.object({
  ran: z.boolean(),
  skipReason: z.enum(['flag-off']).optional(),
  edits: z.number().int().optional(),
  recorded: z.number().int().optional(),
});

/** Test seam — inject flag/git-log/record deps (mirrors the negative-space op). */
let _deps: ChangeLedgerScanDeps | null = null;
export function setChangeLedgerScanDeps(deps: ChangeLedgerScanDeps | null): void {
  _deps = deps;
}

export const changeLedgerScanOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'change-ledger:scan',
  description:
    'Deterministic step: git-log the prompt-source roots over a trailing window and offer one behavior-change-ledger row per (commit, file) (the change-ledger repo-edit scan).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    // A deterministic capability step declares the substrate it needs; the
    // workspace it scans into is the harness's. Absent ⇒ a misconfigured fire —
    // fail loud rather than silently record into the wrong scope.
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('change-ledger:scan requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runChangeLedgerScan({ workspaceId, installSlug, payload: a }, _deps ?? {});
    ctx.log?.(
      `change-ledger:scan ran=${outcome.ran}` +
        (outcome.skipReason ? ` skip=${outcome.skipReason}` : '') +
        (outcome.ran ? ` edits=${outcome.edits} recorded=${outcome.recorded}` : ''),
    );
    return {
      ran: outcome.ran,
      skipReason: outcome.skipReason,
      edits: outcome.edits,
      recorded: outcome.recorded,
    };
  },
};

registerCoordOp(changeLedgerScanOp);
