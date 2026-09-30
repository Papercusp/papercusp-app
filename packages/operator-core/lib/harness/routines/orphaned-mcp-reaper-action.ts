/**
 * `system:orphaned-mcp-reaper` — EI-18691186726153223.
 *
 * Wires the pure decision core (`orphaned-mcp-reaper.ts`) to a real /proc scan +
 * real process signalling. Design + safety model live in that module's header.
 *
 * DOUBLE-GATED (mirrors `system:test-webview-reaper`, the closest existing
 * precedent — same host-local "kill a leaked agent-spawned process" shape):
 *  - FLAGS.ORPHANED_MCP_REAPER defaults ON (no-op if flipped OFF).
 *  - The routine is seeded INACTIVE — the kill never fires until an operator
 *    activates it (`seed-orphaned-mcp-reaper-routine.ts --active`, recommended
 *    `--active --dry-run` first to review the candidate set).
 *
 * trigger_config knobs (all optional):
 *   - dry_run (default false) — classify + log, kill nothing.
 *   - min_age_minutes (default 30) — grace window before a group is reap-eligible.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { reapOrphanedMcpProcesses } from '../../orphaned-mcp-reaper';

registerSystemAction('orphaned-mcp-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const minAgeMinutes = typeof cfg.min_age_minutes === 'number' ? cfg.min_age_minutes : undefined;

  const flagOn = await getFlag(FLAGS.ORPHANED_MCP_REAPER, 'system').catch(() => false);
  if (!flagOn) {
    const result = await reapOrphanedMcpProcesses({
      dryRun: true,
      minAgeMs: minAgeMinutes != null ? minAgeMinutes * 60_000 : undefined,
    });
    console.log(
      `[orphaned-mcp-reaper] kill disabled (papercusp-orphaned-mcp-reaper flag OFF) — detection-only: ` +
        `${result.scanned} proc(s) scanned, ${result.groupsPlanned} group(s) WOULD reap ` +
        `(${result.skippedTooYoung} too young, ${result.skippedNoAgentAnchor} no agent anchor)`,
    );
    return;
  }

  const result = await reapOrphanedMcpProcesses({
    dryRun,
    minAgeMs: minAgeMinutes != null ? minAgeMinutes * 60_000 : undefined,
  });
  console.log(
    `[orphaned-mcp-reaper] ${result.scanned} proc(s) scanned, ${result.groupsPlanned} group(s) → ` +
      `${result.dryRun ? 'WOULD kill' : 'killed'} ${result.killed.length} pid(s)` +
      (result.killed.length ? ` [pids: ${result.killed.slice(0, 30).join(',')}${result.killed.length > 30 ? ',…' : ''}]` : '') +
      ` (skipped ${result.skippedTooYoung} too-young, ${result.skippedNoAgentAnchor} no-agent-anchor)`,
  );
});
