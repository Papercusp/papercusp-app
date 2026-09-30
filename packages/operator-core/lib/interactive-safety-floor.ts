/**
 * interactive-safety-floor.ts — the P-012 safety floor for INTERACTIVE agent
 * launches (unify-agent-spawn-chokepoint-2026-06-06 P-012 / D-013 residual 3).
 *
 * A human-initiated session — the native console launch (console-launch.ts) and
 * the /adv web launch of a `psu` terminal (adv/launch-su.ts) — WAIVES brain
 * admission: no `new_subagent` worth-it round-trip, because the human is the
 * judgment AND the durability (D-003). But it STILL passes the deterministic
 * safety floor: the absolute concurrency ceiling (`maxSimultaneousAgents`), the
 * plan's last-resort guard. Over-ceiling → refuse with an actionable message
 * (the human can `fleet:cancel` a spawn or raise the cap live). Reading the
 * floor also feeds interactive launches into the same headroom picture the
 * brain consults (`getSpawnHeadroom`), so they are not invisible to the floor.
 *
 * EI-5678: `getSpawnHeadroom` is called with `skipHostSaturationShed: true` —
 * host-saturation load-shedding (EI-73) is a brain-admission-style throttle
 * built for autonomous spawns, not the deterministic ceiling this floor is
 * documented to enforce. Without this, a human could be refused with a
 * self-contradicting `0 agent(s) running ≥ ceiling 8` message whose real cause
 * (host saturation) was never surfaced — leaving `headroom <= 0` here always
 * traceable to the count-based ceiling the message actually describes.
 *
 * Fail-OPEN: if the headroom read throws (e.g. PG briefly down) we NEVER block
 * a human launch on it — the floor is a guard, not a gate that can wedge a
 * person.
 *
 * Lazy import: `fleet/operator-spawn` pulls `dbos/orchestrator-runner` (which
 * registers the DBOS workflow graph at module load), so importing it eagerly
 * would drag those process-global registrations into the import graph of every
 * route that uses this helper (the vi.resetModules crash class D-012 fixed).
 */
import { activeWorkspaceId } from './workspace-registry';

export async function checkInteractiveSafetyFloor(
  log: (line: string) => void = () => {},
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { getSpawnHeadroom } = await import('./fleet/operator-spawn');
    const floor = await getSpawnHeadroom(activeWorkspaceId(), { skipHostSaturationShed: true });
    if (floor.headroom <= 0) {
      return {
        ok: false,
        reason:
          `interactive launch refused by the safety floor: ${floor.running} agent(s) running ≥ ceiling ` +
          `${floor.ceiling} (maxSimultaneousAgents). Interactive launches WAIVE brain admission but still ` +
          `pass the floor (P-012 / D-013) — fleet:cancel a spawn or raise maxSimultaneousAgents ` +
          `(operator:rate_limit_config), then retry.`,
      };
    }
    log(`safety floor OK: running=${floor.running} ceiling=${floor.ceiling} headroom=${floor.headroom} (admission waived — human-initiated)`);
    return { ok: true };
  } catch (e: any) {
    // Fail-open: never block a human-initiated launch on a floor-read failure.
    log(`safety floor read failed (${e?.message}); proceeding (fail-open for interactive)`);
    return { ok: true };
  }
}
