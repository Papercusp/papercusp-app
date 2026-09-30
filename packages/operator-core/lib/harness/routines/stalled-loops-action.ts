/**
 * `system:sweep-stalled-loops` — the registration seam for {@link sweepStalledLoops}
 * (WI-6639).
 *
 * Thin by design, matching `gc-dead-loops-action.ts`: the sweep logic lives in
 * `stalled-loops-guard.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `dry_run` — report matches without disarming or broadcasting.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepStalledLoops } from './stalled-loops-guard';

registerSystemAction('sweep-stalled-loops', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const result = await sweepStalledLoops({ workspaceId: ctx.workspaceId, dryRun: cfg.dry_run === true });
  if (result.paused > 0) {
    console.log(
      `[sweep-stalled-loops] ${result.dryRun ? 'would auto-disarm' : 'auto-disarmed'} ${result.paused}/` +
        `${result.checked} armed loop(s) with no turns produced despite repeated fires, e.g. ${result.sample.join(', ')}`,
    );
  }
  // EI-19362678179163398: a non-zero veto count is a LIVE signal that last_turn_at is
  // under-reporting again (the exact failure class this guard's own root-cause fix
  // closed once already) — surfaced loudly rather than silently swallowed, since the
  // guard's per-owner console.warn inside the sweep is easy to miss in a routine's log.
  if (result.vetoedByRecentTurn.length > 0) {
    console.warn(
      `[sweep-stalled-loops] VETOED ${result.vetoedByRecentTurn.length} owner(s) that read turnsStalled:true ` +
        `but had produced a real turn inside the floor — last_turn_at may be under-reporting again ` +
        `(EI-19362678179163398): ${result.vetoedByRecentTurn.join(', ')}`,
    );
  }
  // EI-19406534159939583: fire-starved loops are the INFRASTRUCTURE half of this sweep — live
  // agents that answered every fire and then stopped receiving them. Surfaced at warn level and
  // separately from the disarm line above, because the two findings blame opposite parties and
  // the sweep that conflated them took 5 of a 10-member fleet dark.
  if (result.reArmedFireStarved.length > 0) {
    console.warn(
      `[sweep-stalled-loops] FIRE-STARVED ${result.reArmedFireStarved.length}/${result.checked} loop(s) ` +
        `${result.dryRun ? 'would be re-armed' : 're-armed'} (NOT disarmed) — each answered its last fire ` +
        `and none has arrived since, so the loop-firing path stopped serving live agents ` +
        `(EI-19406534159939583): ${result.reArmedFireStarved.join(', ')}`,
    );
  }
  // WI-36685: wake-starved loops are the DELIVERY half — one layer below fire-starved. There the
  // fires stopped; here they kept arriving and reached nobody, because no standing inbox-wake
  // await existed, so no delivery row was ever created and the agent was never asked for a turn.
  // Warn level and its own line for the same reason as its sibling: it blames the transport, not
  // the agent, and it names a DIFFERENT thing to go fix (the await arm path, not the scheduler).
  if (result.repairedWakeStarved.length > 0) {
    console.warn(
      `[sweep-stalled-loops] WAKE-STARVED ${result.repairedWakeStarved.length}/${result.checked} loop(s) ` +
        `${result.dryRun ? 'would be repaired' : 'repaired'} (NOT disarmed) — each kept being fired at while ` +
        `no wake was ever delivered (no standing coord:inbox-wake await, so every emit matched nothing). ` +
        `Their watch ${result.dryRun ? 'would be' : 'was'} re-armed and the loops made due ` +
        `(WI-36685): ${result.repairedWakeStarved.join(', ')}`,
    );
  }
  // WI-37546: REVIVALS are this module reporting that its OWN earlier verdict was wrong — each
  // entry is one disarm that should not have stood, and before this existed each was a session
  // dark until a human noticed. Warn level, and named separately from every population above
  // because it blames neither the agent nor the transport but the turn-stalled inference itself.
  if (result.revivedAfterDisarm.length > 0) {
    console.warn(
      `[sweep-stalled-loops] REVIVED ${result.revivedAfterDisarm.length} previously-disarmed loop(s) ` +
        `${result.dryRun ? 'would be re-armed' : 're-armed'} — each was disarmed as turn-stalled and its ` +
        `owner has since made progressing tool calls, so the verdict was wrong ` +
        `(WI-37546): ${result.revivedAfterDisarm.join(', ')}`,
    );
  }
  // WI-37546: the LIVENESS veto — owners still making progressing tool calls since their last
  // fire. Logged at info like the provider-wall line below and for the same inverted-diagnostic
  // reason: a non-zero count here is the exemption WORKING (measured 2026-08-09, this evidence
  // existed for 18 of 19 disarms that day and nothing read it). Worry when it is persistently
  // ZERO on a workspace whose agents are demonstrably working — that means the activity read has
  // stopped matching and the false disarms have silently resumed.
  if (result.vetoedByToolActivity.length > 0) {
    console.log(
      `[sweep-stalled-loops] LIVE ${result.vetoedByToolActivity.length}/${result.checked} loop(s) left ` +
        `ARMED (not disarmed) — each owner is still making progressing tool calls since its last fire, ` +
        `so it is not wedged whatever last_turn_at claims ` +
        `(WI-37546): ${result.vetoedByToolActivity.join(', ')}`,
    );
  }
  // EI-19441932615368003: walled loops are the PROVIDER half. Logged at info, not warn — unlike
  // the two above, a non-zero count here is EXPECTED under load and blames nobody: it is the
  // lifecycle-death backoff working, and this line is the evidence the guard is no longer
  // converting those transient walls into permanent halts. Its diagnostic value is inverted from
  // its siblings — worry when it is persistently ZERO on a workspace that IS hitting usage walls,
  // because that means the exemption has stopped matching and silent halting has resumed.
  if (result.vetoedByProviderWall.length > 0) {
    console.log(
      `[sweep-stalled-loops] WALLED ${result.vetoedByProviderWall.length}/${result.checked} loop(s) left ` +
        `ARMED (not disarmed) — each died on a provider usage/rate wall and is backed off waiting for it ` +
        `to lift, which is self-healing and must not be made permanent ` +
        `(EI-19441932615368003): ${result.vetoedByProviderWall.join(', ')}`,
    );
  }
});
