/**
 * learning:set-pot-scope — THE per-pot learning master switch
 * (plan learning-pot-scope-gate-2026-08-30, P-001 / D-001).
 *
 * Writes harness_shared.learning_pot_scope, the row every learning lane's
 * preflight ANDs with its own arming:
 *
 *     lane runs  ⟺  potLearningEnabled(pot)  AND  <the lane's existing gate>
 *
 * It NEVER writes a lane's own config (gym_autoloop_config,
 * learning_governor_loops, routines.active). That is the whole point of the
 * owner's decision: because each lane keeps its arming untouched, switching a
 * pot off and back on restores EXACTLY the lanes that were armed before and
 * revives nothing a human had deliberately parked. The rejected alternative —
 * stamping each lane row on pause and reviving only stamped rows — needed no
 * migration but was not a GATE: an agent calling gym:arm could re-arm a pot the
 * owner had switched off.
 *
 * Takes an ARRAY because the picker's bulk footer must be ONE write rather than
 * N racing upserts — which is also one audit event instead of a burst.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  clearPotLearningScope,
  listPotLearningScope,
  setPotLearningScope,
} from '../../learning/pot-gate/store';
import type { PotLearningScope } from '../../learning/pot-gate/core';
import { listHives } from '../../hive-store';

/** What each named pot looked like before the write — `null` = no row (⇒ enabled). */
type PriorState = Record<string, PotLearningScope | null>;

export default defineTool({
  name: 'learning:set-pot-scope',
  profile: 'engineer',
  description:
    "Switch learning ON or OFF for one or many POTS at once (harness_shared.learning_pot_scope) — the master gate ANDed with every learning lane's own arming, so it covers the frontier loops, dream, gym and Scout together. Switching a pot off leaves every lane's own config untouched, so switching it back on restores exactly the lanes that were armed before and revives nothing that was deliberately parked. An absent row means ENABLED, so a pot that has never been flipped is learning. Audited + one-call-revertible; refuses an unknown pot slug (a typo would otherwise gate nothing while reading as a successful switch-off).",
  capability: 'operator:write',
  guidance: {
    when: "Stop or resume ALL learning for a pot — an experiment pot you do not want spending, a customer pot that should never learn, or re-enabling one you had switched off. Also the write behind the Learning tab's pot rail and per-pot drawer.",
    notWhen:
      'To arm/disarm ONE lane use gym:arm (gym) or governor:arm (a governor lane); to pause a lane\'s SCHEDULE use routines:set; for the workspace-wide Scout ceiling use learning:set-scout-budget. This tool is the pot-level switch ABOVE all of those and changes none of them.',
    chaining:
      'Read the current scope first (dev:pg_query on harness_shared.learning_pot_scope, or the automation.catalog arming block) — pots with no row are enabled. Pass the whole selection in ONE call rather than looping.',
    seeAlso: [
      'gym:arm (one pot\'s gym lane)',
      'governor:arm (one governor lane)',
      'learning:set-scout-budget (workspace-wide Scout ceiling)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    pots: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(500)
      .describe("Pot home slugs to flip, e.g. ['papercusp', 'calendar']. Pass the whole selection in one call — this is a single atomic write and a single audit event."),
    enabled: z
      .boolean()
      .describe('false = no learning lane may run for these pots, whatever its own arming says. true = release the gate (each lane resumes at its own prior arming).'),
    reason: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('WHY learning is being switched OFF — a real citation (owner directive id/date, work-item), not a label. Recorded as structured pause provenance so a quiet pot reads as deliberate, not broken. Ignored when enabled:true (enabling clears the record).'),
    ownerDirected: z
      .boolean()
      .optional()
      .describe("true = this pause is the OWNER's standing decision. Requires `reason` (cite the directive). Set it ONLY from a literal owner directive you can point to — it tells every producer-silence detector to treat the silence as deliberate."),
    reviewBy: z
      .string()
      .datetime()
      .optional()
      .describe('ISO-8601 instant when this pause should be re-examined. Omit for an open-ended pause.'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('learning:set-pot-scope requires operator, architect, or mug role');
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const pots = [...new Set(args.pots)];

    // Who to stamp as `set_by`. The agent identity is the useful audit trail;
    // fall back to the role rather than failing the write, because an
    // unresolvable identity is not a reason to leave the gate unchanged.
    let setBy = `role:${ctx.role}`;
    try {
      setBy = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* identity unresolvable on this transport — the role is still an actor */
    }

    // Refuse unknown slugs. A typo here is the one genuinely dangerous input:
    // it would write a disabled row for a pot that does not exist, read back as
    // a successful switch-off, and leave the REAL pot learning.
    const known = new Set((await listHives(workspaceId, sql)).map((h) => h.homeSlug));
    const unknown = pots.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `learning:set-pot-scope: unknown pot slug(s) ${unknown.join(', ')} — no such pot in this workspace. ` +
          'Gating a slug that does not exist would read as a successful switch-off while the real pot keeps learning.',
      );
    }

    const readPrior = async (): Promise<PriorState> => {
      const rows = await listPotLearningScope(sql, { workspaceId });
      const byPot = new Map(rows.map((r) => [r.potSlug, r]));
      const prior: PriorState = {};
      for (const p of pots) prior[p] = byPot.get(p) ?? null;
      return prior;
    };

    const outcome = await runControlMutation<PriorState>(
      {
        action: 'learning:set-pot-scope',
        subject: pots.join(','),
        actor: `role:${ctx.role}`,
        capturePrev: readPrior,
        apply: async () => {
          await setPotLearningScope(sql, {
            workspaceId,
            potSlugs: pots,
            enabled: args.enabled,
            setBy,
            pauseReason: args.reason ?? null,
            ownerDirected: args.ownerDirected === true,
            reviewBy: args.reviewBy ? new Date(args.reviewBy) : null,
          });
          return readPrior();
        },
        revertTo: async (prev) => {
          // Exact inverse: pots that HAD a row go back to their stored value;
          // pots that had none get their row REMOVED, so a revert cannot leave
          // a set_by stamp naming an actor who never set it.
          const hadNoRow = pots.filter((p) => prev[p] === null);
          if (hadNoRow.length > 0) await clearPotLearningScope(sql, { workspaceId, potSlugs: hadNoRow });
          // Restore each pot's OWN prior row, pause record included — a revert
          // must put back the provenance that was there, not silently drop it,
          // and pots that shared a write can have had different prior pauses.
          for (const p of pots) {
            const before = prev[p];
            if (!before) continue;
            await setPotLearningScope(sql, {
              workspaceId,
              potSlugs: [p],
              enabled: before.enabled,
              setBy: before.setBy ?? null,
              pauseReason: before.pauseReason,
              ownerDirected: before.ownerDirected,
              reviewBy: before.reviewBy,
            });
          }
        },
        verify: async () => {
          const cur = await readPrior();
          const wrong = pots.filter((p) => (cur[p]?.enabled ?? true) !== args.enabled);
          return {
            ok: wrong.length === 0,
            detail: wrong.length === 0 ? undefined : `pot scope did not reflect the change for: ${wrong.join(', ')}`,
          };
        },
        describe: (prev) => ({
          current: Object.fromEntries(pots.map((p) => [p, prev[p]?.enabled ?? true])),
          proposed: Object.fromEntries(pots.map((p) => [p, args.enabled])),
          note: 'Lane configs (gym_autoloop_config, learning_governor_loops, routines.active) are NOT touched.',
        }),
      },
      { dryRun: args.dryRun },
    );

    if (outcome.applied && !outcome.dryRun) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
        notifySyncInvalidate('learning.dream');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    // token-opt P-003: return `{ data }` and let the framework own wire encoding
    // (including auto-TOON on the MCP transport) rather than hand-rolling the legacy
    // inline-JSON content envelope. This tool has one mechanical return and no isError
    // slot in use, so the migration is shape-for-shape.
    // (Deliberately not spelling that envelope out here: the ratchet's detector is a
    // text scan, so quoting the pattern in a comment counts as an offender.)
    return {
      data: {
        ok: true,
        pots,
        enabled: args.enabled,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
      },
    };
  },
});
