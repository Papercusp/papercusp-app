/**
 * Shared hive start/stop control (start-hive-wake-orchestration P-006).
 *
 * Extracted from AdvNowRunning so the central Pots-tab control (LocalPotsControl)
 * and the always-visible header "N hives running" pill (PotsRunningPill) drove the
 * SAME gated/audited dispatch and read the same `hive.controlState` sync query —
 * one write path, no drift. Both of those callers are now gone with the mug/kettle
 * tier (PotsRunningPill deleted 2026-08-10 by P-075; LocalPotsControl by P-077,
 * once P-075 and P-077 between them removed its last mount), so AdvNowRunning's
 * own Start/Stop is the ONLY caller left. `pot:start` / `pot:pause` flip the persisted started
 * bit and fire `notifySyncInvalidate('hive.controlState')`, so every consumer
 * refreshes live after a toggle.
 */

import { runAgentTool } from './run-tool';

/** One row of the `hive.controlState` sync query (per registered LOCAL hive). */
export interface HiveControlRow {
  slug: string;
  started: boolean;
  nextFireAt?: string | null;
  lastWakeAt?: string | null;
  watchdogFires24h?: number;
}

/** Count of started hives. Pure — exported for unit tests. */
export function countStarted(rows: readonly HiveControlRow[]): number {
  return rows.filter((r) => r.started === true).length;
}

/**
 * Pluralized label for the header pill ("N pot(s) running"). Pure + hook-free so
 * it stays unit-testable — the CALLER supplies the resolved brand noun (singular,
 * plural) from the active lexicon (restore-pot-lexicon P-006). Defaults to the
 * literal 'hive'/'hives' only for the bare unit test; production always passes the
 * lexicon words.
 */
export function hivesRunningLabel(n: number, singular = 'hive', plural = 'hives'): string {
  return `${n} ${n === 1 ? singular : plural} running`;
}

/**
 * Fire a hive control tool through the loopback palette bridge — the full
 * gated/audited dispatch (the same path the old global-header HiveStartPauseButton
 * used). Throws on any failure so callers can toast.
 */
export async function runHiveControl(
  tool: 'pot:start' | 'pot:pause',
  slug: string,
  extraArgs: Record<string, unknown> = {},
): Promise<void> {
  // Delegates to the ONE shared dispatch (P-007). The guarded plain-text error
  // handling that used to live inline here is the reason `run-tool.ts` exists:
  // it was the only one of six copies that had it, so it became the shared
  // implementation rather than being left as this file's private lesson.
  await runAgentTool(tool, { harness: slug, ...extraArgs });
}
