/**
 * coord:orientation_telemetry — the READ half of P-020's reach/action instrument
 * (plan turn-start-memory-two-class-2026-09-21).
 *
 * The item says "expose as a read (state cell or `orient:stats`), no dashboard".
 * This is that read. It projects {@link readOrientationTelemetry} and derives
 * NOTHING of its own — the aggregation, the class-A/class-B split and the
 * 500-turn flag all live in the module, so this file cannot drift from it.
 *
 * ── WHY THIS IS A TOOL AND NOT A REGISTERED CELL ─────────────────────────────
 *
 * The item offered both shapes, and "it is a read, therefore register a cell"
 * is the tempting answer. It is the wrong one, for the reason the state-plane
 * adoption gate states directly (scripts/check-no-bespoke-state-read.mjs, D-010):
 * a cell earns its keep by COLLAPSING A DUPLICATED DERIVATION. Registering one
 * here would add a registry entry without removing any, which is precisely the
 * measured `predicate_watches` failure that gate exists to prevent — shipped,
 * correct in principle, zero rows, and strictly worse than nothing because it
 * adds a place to look.
 *
 * Both of that gate's legitimate exemption classes apply, not just one:
 *   (i)  NOT LIVE STATE — this is a REPORT over a historical ledger. A cell
 *        answers "what is true right now"; every number here is an aggregate
 *        over rows accumulated across turns, and a `state:subscribe` threshold
 *        on it would be meaningless.
 *   (ii) SINGLE DOOR — exactly one thing answers this question and nothing
 *        re-derives it.
 *
 * ⚠ Measured 2026-09-22, not assumed: `isStateReadCandidate` does NOT select
 * this tool's name, so the gate never fires on it and the `@not-a-cell` marker
 * below is currently inert. It is written anyway because the gate's noun list is
 * explicitly a stopgap that "chases the corpus" (EI-18791777695307535) — if
 * `telemetry` is ever added to it, the verdict is already recorded here rather
 * than being re-litigated by whoever hits the red.
 *
 * // @not-a-cell A report over a historical telemetry ledger, not live state: every field is an aggregate across turns, and registering a cell would add registry surface without collapsing a duplicated derivation (the D-010 predicate_watches failure).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  readOrientationTelemetry,
  ORIENTATION_ZERO_ACTION_FLAG_TURNS,
} from '../../orientation-telemetry';
import type { SqlTag } from '../../memory/bump-last-surfaced';

function json(obj: unknown) {
  // { data } shape: the framework owns wire encoding (tool-data-shape ratchet, WI-10002555).
  return { data: obj };
}

export default defineTool({
  name: 'coord:orientation_telemetry',
  // @no-coord-tier A read-only design-evidence aggregate, not an agent coordination behaviour:
  // it reports past reach/action per turn-start orientation class so an AUTHOR can argue for
  // adding or removing a class. D-001's ladder ranks how reliably an agent is made to perform a
  // coordination behaviour; there is no coordination act here to enforce, and no agent should
  // be steered to call it unbidden while coordinating (WI-10002544).
  profile: 'engineer',
  description:
    'Measured REACH (how often each turn-start orientation class actually reached an agent) and ACTION (turns-until-disposition for obligation classes), with a flag on any class that reached agents for 500+ turns causing zero dispositions. Evidence for adding or removing an orientation class.',
  capability: 'coord:read',
  guidance: {
    when: 'Deciding whether a turn-start orientation class earns its place — before adding one, or when arguing to remove one. Use the measured reach/action instead of eyeballing a HUD diff.',
    notWhen:
      'Not for reading your CURRENT orientation (that is coord:orient). Not live state — every number is an aggregate over past turns, so there is nothing here to subscribe to.',
    chaining:
      'A flagged class is a prompt to re-argue its actor test, never an auto-removal. dispositions:null means action was NOT measured for that class, which is not a zero.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    workspaceId: z
      .string()
      .optional()
      .describe('Defaults to the calling session workspace.'),
    sink: z
      .string()
      .optional()
      .describe("Which render sink to report reach for. Defaults to 'turn-start'."),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspaceId ?? ctx.workspaceId ?? 'default';
    const { sql } = getOrgPg();
    const read = await readOrientationTelemetry(sql as unknown as SqlTag, {
      workspaceId,
      ...(args.sink ? { sink: args.sink } : {}),
    });

    // The false-zero rail. An empty class list means one of two OPPOSITE things
    // — "measured, nothing has rendered" vs "could not measure at all" — and
    // they prescribe opposite actions, so the verdict is stated rather than
    // left to be inferred from an empty array.
    const verdict = read.unavailableReason
      ? 'unavailable'
      : read.classes.length === 0
        ? 'measured-empty'
        : 'measured';

    return json({
      ...read,
      workspaceId,
      verdict,
      flagThresholdTurns: ORIENTATION_ZERO_ACTION_FLAG_TURNS,
      note:
        verdict === 'unavailable'
          ? 'NOT a zero-reach reading — the telemetry could not be read at all (see unavailableReason; migration 1192 may not be applied on this host). Do not remove a class on this result.'
          : verdict === 'measured-empty'
            ? 'Measured: no orientation renders recorded for this workspace/sink yet. Reach evidence does not exist yet — this is not evidence of zero reach.'
            : undefined,
    });
  },
});
