/**
 * loop:standdown-all — bulk-pause EVERY active per-session engine loop
 * (loop-su-% routines) workspace-wide, or scoped to one fleet's CURRENT
 * members with `fleetSlug` — the fleet-wide-stand-down primitive that
 * routines:group-set cannot reach (loop-su-% rows are never routine-group
 * members).
 *
 * WHY (EI-22138154596110669): a fleet-wide "stand-down" broadcast asserted
 * "All engine loops are paused (routines:set active:false, resumable)" but
 * had, by hand-calling routines:set a few times, actually touched only 2 of
 * 26+ active loop-su-% rows in its window — there was no dedicated bulk-pause
 * tool for engine loops. No expiry was stamped on the ad-hoc pause either, so
 * the broadcast's sole named resume authority dying would have stranded every
 * paused loop indefinitely (it did not, only by luck).
 *
 * Same pattern class as release-pause-ttl.ts (gate-verdict-liveness-and-repair-
 * reliability-2026-08-31 P-004): every stand-down pause carries a finite expiry
 * (default DEFAULT_RELEASE_PAUSE_TTL_HOURS, overridable via `pauseTtlHours`) and
 * `sweepExpiredLoopStanddowns` (release-pause-ttl.ts, riding the SAME
 * routinesTick step the release sweep already rides) auto-resumes it and
 * records a notice on lapse — no new scheduler mechanism, no new pause family.
 * `loop:status` renders the hold via `loopStanddownBanner` while it is active.
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply
 * verify+auto-revert, audit, one-call revert) — same pattern as
 * routines:group-set, scoped to the dynamic loop-su-% set instead of a
 * routine group.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { pausedByFrom } from '../routines/set';
import {
  DEFAULT_RELEASE_PAUSE_TTL_HOURS,
  LOOP_STANDDOWN_MARKER,
  resolveLoopStanddownExpiryMs,
} from '../../harness/routines/release-pause-ttl';

interface LoopTargetSnap {
  installSlug: string;
  name: string;
  targetOwnerId: string;
  active: boolean;
  /** The routine's `metadata.pause` and `lastPause` at capture time, for an exact revert. */
  pause: Record<string, unknown> | null;
  lastPause: Record<string, unknown> | null;
}

const MAX_TARGETS_FOR_REVERT_CAPTURE = 5000;

export default defineTool({
  name: 'loop:standdown-all',
  profile: 'engineer',
  description:
    "Bulk-pause active per-session engine loops (loop-su-% routines), or resume loops held by a prior stand-down. Scope to the workspace or one fleet's CURRENT members with `fleetSlug`. `action` defaults to `pause`; both actions require a reason. Pause always stamps a finite auto-resume expiry and returns its `standdownGeneration`. Resume clears only rows carrying the `standdownAll` marker in the requested scope (and optional exact generation), preserving unrelated per-agent pauses. Both operations return the actual targets, are audited, and are one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when:
      "Pausing every (or one fleet's) active engine loop at once for a coordinated stand-down, or resuming loops paused by this tool. A resume clears only the stand-down markers in scope; ordinary per-agent pauses stay in place.",
    notWhen:
      'To stop your OWN loop permanently, use loop:end. To pause or resume one specific routine, use routines:set. To pause or resume a routine GROUP (not engine loops), use routines:group-set.',
    chaining:
      "loop:status / fleet:assignments before, to see which loops are active. After `pauseTtlHours` lapses, the routines engine auto-resumes a stand-down. Use `action:'resume'` for an earlier bulk resume; pass the returned `standdownGeneration` to resume exactly one pause generation, or omit it to clear every stand-down marker in scope.",
    seeAlso: [
      'loop:end (stop your own loop, permanently)',
      'routines:set (one routine)',
      'routines:group-set (a routine GROUP, not engine loops)',
      'loop:status (see the stand-down banner + when it auto-resumes)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 5 } },
  args: z.object({
    action: z
      .enum(['pause', 'resume'])
      .default('pause')
      .describe('pause creates a stand-down generation; resume clears matching stand-down markers.'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'Required for every bulk action. Pause stores it on each loop marker; resume records it in the control audit.',
      ),
    fleetSlug: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Scope the stand-down to loops owned by this fleet's CURRENT members only (per coord_presence.fleet_slug — the live projection, not the historical membership ledger, so a member who already left is not touched). Omit to stand down EVERY active loop-su-% routine in the workspace.",
      ),
    pauseTtlHours: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe(
        `How long this stand-down may last, in hours — stamped on every paused loop as metadata.pause.expiresAtMs, after which the routines engine AUTO-RESUMES it and records a notice (same TTL mechanism as a release-group pause). Omit for the ${DEFAULT_RELEASE_PAUSE_TTL_HOURS}h default. A stand-down pause is ALWAYS finite — there is no open-ended option.`,
      ),
    standdownGeneration: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('For action=resume, limit the resume to this exact generation returned by action=pause. Omit to resume every stand-down marker in the selected scope, including legacy markers without a generation.'),
    dryRun: z.boolean().optional(),
  }).superRefine((args, refinement) => {
    if (args.action === 'resume' && args.pauseTtlHours !== undefined) {
      refinement.addIssue({ code: z.ZodIssueCode.custom, path: ['pauseTtlHours'], message: 'pauseTtlHours is only valid when action=pause' });
    }
    if (args.action === 'pause' && args.standdownGeneration !== undefined) {
      refinement.addIssue({ code: z.ZodIssueCode.custom, path: ['standdownGeneration'], message: 'standdownGeneration is returned by action=pause and only used by action=resume' });
    }
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('loop:standdown-all requires operator, architect, or mug role');
    }

    // Endpoint dispatch applies the Zod default; direct handler callers may not.
    const action = args.action ?? 'pause';
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const scopeLabel = args.fleetSlug
      ? `fleet:${args.fleetSlug}`
      : args.standdownGeneration
        ? `generation:${args.standdownGeneration}`
        : 'workspace';

    const readActiveTargets = async (): Promise<LoopTargetSnap[]> => {
      const rows = args.fleetSlug
        ? await sql<
            Array<{ install_slug: string; name: string; target_owner_id: string; active: boolean | null; pause: Record<string, unknown> | null; last_pause: Record<string, unknown> | null }>
          >`
            SELECT r.install_slug, r.name, r.target_owner_id, r.active,
                   r.metadata -> 'pause' AS pause, r.metadata -> 'lastPause' AS last_pause
              FROM harness_shared.routines r
             WHERE r.workspace_id = ${ws}
               AND r.reschedule_interval_sec IS NOT NULL
               AND r.active = true
               AND r.name LIKE 'loop-su-%'
               AND r.target_owner_id IS NOT NULL
               AND r.target_owner_id IN (
                     SELECT p.owner_id FROM harness_shared.coord_presence p
                      WHERE p.workspace_id = ${ws} AND p.fleet_slug = ${args.fleetSlug}
                   )
             LIMIT ${MAX_TARGETS_FOR_REVERT_CAPTURE}`
        : await sql<
            Array<{ install_slug: string; name: string; target_owner_id: string; active: boolean | null; pause: Record<string, unknown> | null; last_pause: Record<string, unknown> | null }>
          >`
            SELECT r.install_slug, r.name, r.target_owner_id, r.active,
                   r.metadata -> 'pause' AS pause, r.metadata -> 'lastPause' AS last_pause
              FROM harness_shared.routines r
             WHERE r.workspace_id = ${ws}
               AND r.reschedule_interval_sec IS NOT NULL
               AND r.active = true
               -- EI-22818006456104074: the workspace scan MUST be confined to su engine
               -- loops with a real owner. Without these two predicates the 17 NULL-owner
               -- system routines (service-health, stale-claim-sweep, …) entered prev,
               -- the owner-keyed UPDATE/verify below could never match them (ANY() never
               -- matches NULL), verify() failed, and runControlMutation auto-reverted —
               -- ok:true with applied:false / pausedCount:0. The lever silently no-op'd.
               AND r.name LIKE 'loop-su-%'
               AND r.target_owner_id IS NOT NULL
             LIMIT ${MAX_TARGETS_FOR_REVERT_CAPTURE}`;
      return rows.map((r) => ({
        installSlug: r.install_slug,
        name: r.name,
        targetOwnerId: r.target_owner_id,
        active: Boolean(r.active),
        pause: r.pause ?? null,
        lastPause: r.last_pause ?? null,
      }));
    };

    const readStanddownTargets = async (): Promise<LoopTargetSnap[]> => {
      const generation = args.standdownGeneration ?? null;
      const fleetSlug = args.fleetSlug ?? null;
      const rows = await sql<
        Array<{ install_slug: string; name: string; target_owner_id: string; active: boolean | null; pause: Record<string, unknown> | null; last_pause: Record<string, unknown> | null }>
      >`
        SELECT r.install_slug, r.name, r.target_owner_id, r.active,
               r.metadata -> 'pause' AS pause, r.metadata -> 'lastPause' AS last_pause
          FROM harness_shared.routines r
         WHERE r.workspace_id = ${ws}
           AND r.reschedule_interval_sec IS NOT NULL
           AND r.name LIKE 'loop-su-%'
           AND r.target_owner_id IS NOT NULL
           AND r.metadata -> 'pause' ->> ${LOOP_STANDDOWN_MARKER} = 'true'
           AND (
             (
               ${fleetSlug}::text IS NULL
               AND (${generation}::text IS NOT NULL OR r.metadata -> 'pause' ->> 'fleetSlug' IS NULL)
             )
             OR r.metadata -> 'pause' ->> 'fleetSlug' = ${fleetSlug}::text
           )
           AND (
             ${generation}::text IS NULL
             OR r.metadata -> 'pause' ->> 'standdownGeneration' = ${generation}::text
           )
         LIMIT ${MAX_TARGETS_FOR_REVERT_CAPTURE}`;
      return rows.map((r) => ({
        installSlug: r.install_slug,
        name: r.name,
        targetOwnerId: r.target_owner_id,
        active: Boolean(r.active),
        pause: r.pause ?? null,
        lastPause: r.last_pause ?? null,
      }));
    };

    let createdStanddownGeneration: string | undefined;
    let expectedResumeCount = 0;
    const readTargets = action === 'pause' ? readActiveTargets : readStanddownTargets;
    const outcome = await runControlMutation<LoopTargetSnap[]>(
      {
        action: action === 'pause' ? 'loop:standdown-all' : 'loop:resume-standdown-all',
        subject: scopeLabel,
        actor: `role:${ctx.role}`,
        capturePrev: readTargets,
        apply: async () => {
          // Re-read at apply time (not the dryRun-shared capturePrev instance) so a
          // caller who dryRun-previewed first and applied moments later is scoped to
          // what is ACTUALLY active now, same discipline as routines:group-set.
          const prev = await readTargets();
          if (prev.length === 0) return prev;
          if (action === 'pause') {
            const pausedAtMs = Date.now();
            const expiresAtMs = resolveLoopStanddownExpiryMs({ pausedAtMs, ttlHours: args.pauseTtlHours ?? null });
            createdStanddownGeneration = randomUUID();
            const stamp: Record<string, unknown> = {
              reason: args.reason,
              pausedBy: pausedByFrom(ctx, ctx.role),
              pausedAtMs,
              [LOOP_STANDDOWN_MARKER]: true,
              standdownGeneration: createdStanddownGeneration,
              expiresAtMs,
            };
            if (args.fleetSlug) stamp.fleetSlug = args.fleetSlug;
            const ownerIds = prev.map((t) => t.targetOwnerId);
            // Re-guarded on active=true here too: a row that flipped inactive between the
            // read above and this write (another agent's own routines:set, a race) is
            // naturally excluded rather than double-stamped.
            await sql`
              UPDATE harness_shared.routines
                 SET active = false,
                     -- jsonb bound as explicit stringify + cast: sql.json() throws on the
                     -- getOrgPg client (EI-607) and a bare object does not bind.
                     metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(stamp)}::jsonb),
                     updated_at = now()
               WHERE workspace_id = ${ws}
                 AND reschedule_interval_sec IS NOT NULL
                 AND active = true
                 AND name LIKE 'loop-su-%'
                 AND target_owner_id = ANY(${ownerIds}::text[])`;
          } else {
            const resumedAtMs = Date.now();
            expectedResumeCount = prev.length;
            const exactTargets = JSON.stringify(
              prev.map((target) => ({ install_slug: target.installSlug, name: target.name, pause: target.pause })),
            );
            const updated = await sql<Array<{ install_slug: string; name: string }>>`
              UPDATE harness_shared.routines AS routine
                 SET active = true,
                     metadata = jsonb_set(
                       COALESCE(routine.metadata, '{}'::jsonb) - 'pause',
                       '{lastPause}',
                       targets.pause || jsonb_build_object('resumedAtMs', ${resumedAtMs}::bigint),
                       true
                     ),
                     updated_at = now()
                FROM jsonb_to_recordset(${exactTargets}::jsonb)
                     AS targets(install_slug text, name text, pause jsonb)
               WHERE routine.workspace_id = ${ws}
                 AND routine.reschedule_interval_sec IS NOT NULL
                 AND routine.name LIKE 'loop-su-%'
                 AND routine.target_owner_id IS NOT NULL
                 AND routine.install_slug = targets.install_slug
                 AND routine.name = targets.name
                 AND routine.metadata -> 'pause' = targets.pause
                 AND routine.metadata -> 'pause' ->> ${LOOP_STANDDOWN_MARKER} = 'true'
              RETURNING routine.install_slug, routine.name`;
            const updatedKeys = new Set(updated.map((row) => `${row.install_slug}/${row.name}`));
            return prev.filter((target) => updatedKeys.has(`${target.installSlug}/${target.name}`));
          }
          return prev;
        },
        revertTo: async (prev) => {
          for (const t of prev) {
            await sql`
              UPDATE harness_shared.routines
                 SET active = ${t.active},
                     metadata = CASE
                       WHEN ${t.pause === null}
                         THEN COALESCE(metadata, '{}'::jsonb) - 'pause'
                       ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(t.pause ?? {})}::jsonb)
                     END,
                     updated_at = now()
               WHERE workspace_id = ${ws} AND install_slug = ${t.installSlug} AND name = ${t.name}`;
            if (action === 'resume') {
              await sql`
                UPDATE harness_shared.routines
                   SET metadata = CASE
                     WHEN ${t.lastPause === null}
                       THEN COALESCE(metadata, '{}'::jsonb) - 'lastPause'
                     ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastPause}', ${JSON.stringify(t.lastPause ?? {})}::jsonb, true)
                   END,
                       updated_at = now()
                 WHERE workspace_id = ${ws} AND install_slug = ${t.installSlug} AND name = ${t.name}`;
            }
          }
        },
        verify: async (touched) => {
          if (touched.length === 0) return { ok: true };
          // Verify by ROW identity (install_slug, name), not by owner: an owner can have
          // an older inactive sibling loop row, and a NULL owner can never be looked up
          // in an owner-keyed map (EI-22818006456104074).
          const ownerIds = touched.map((t) => t.targetOwnerId);
          const cur = await sql<
            Array<{
              install_slug: string;
              name: string;
              target_owner_id: string;
              active: boolean;
              standdown: boolean | null;
              standdown_generation: string | null;
            }>
          >`
            SELECT install_slug, name, target_owner_id, active,
                   (metadata -> 'pause' ->> ${LOOP_STANDDOWN_MARKER})::boolean AS standdown,
                   metadata -> 'pause' ->> 'standdownGeneration' AS standdown_generation
              FROM harness_shared.routines
             WHERE workspace_id = ${ws}
               AND reschedule_interval_sec IS NOT NULL
               AND name LIKE 'loop-su-%'
               AND target_owner_id = ANY(${ownerIds}::text[])`;
          const rowKey = (installSlug: string, name: string) => `${installSlug}/${name}`;
          const byRow = new Map(cur.map((r) => [rowKey(r.install_slug, r.name), r]));
          if (action === 'resume' && touched.length !== expectedResumeCount) {
            return { ok: false, detail: 'not every captured stand-down marker still matched during resume' };
          }
          const ok = touched.every((t) => {
            const row = byRow.get(rowKey(t.installSlug, t.name));
            return action === 'pause'
              ? row?.active === false && row?.standdown === true && row?.standdown_generation === createdStanddownGeneration
              : row?.active === true && row?.standdown !== true;
          });
          return { ok, detail: ok ? undefined : action === 'pause' ? 'not every targeted loop is paused + stamped standdownAll' : 'not every targeted stand-down loop was resumed and cleared' };
        },
        describe: (prev) => action === 'pause'
          ? {
              scope: scopeLabel,
              current: { activeCount: prev.length },
              proposed: { activeCount: 0, pausedCount: prev.length },
            }
          : {
              scope: scopeLabel,
              current: { standdownCount: prev.length },
              proposed: { activeCount: prev.length, resumedCount: prev.length, reason: args.reason },
            },
      },
      { dryRun: args.dryRun },
    );

    const touched = outcome.applied ? (outcome.next ?? []) : [];
    const pausedCount = action === 'pause' ? touched.length : 0;
    const resumedCount = action === 'resume' ? touched.length : 0;
    const targets = touched.map((t) => ({ ownerId: t.targetOwnerId, routineName: t.name, harness: t.installSlug }));

    // Keep the owner's automation panes live after a bulk pause — same contract as
    // routines:set / routines:group-set. Never fails the mutation.
    if (outcome.applied && !outcome.dryRun && touched.length > 0) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    // REFUSE-OR-LOUDLY-WARN (the whole point of this tool): a caller broadcasting
    // "stood down" off this result must never be able to trust a silent 0. A real
    // apply that captured zero active candidates is loudly flagged rather than
    // returned as an unremarkable success — the exact shape of the original bug
    // (asserting "all" while touching almost none) but now MEASURABLE instead of
    // trusted. Not a throw: a genuinely quiet moment (no active loops at all, or a
    // fleet between members) is a legitimate — if rare — true reading, and a caller
    // must be able to dryRun-probe it without an exception in the way.
    const warning = !outcome.dryRun && outcome.applied && touched.length === 0
      ? action === 'pause'
        ? `No active loop-su-% routines were found in scope (${scopeLabel}) — NOTHING was paused. If you expected active loops, check fleetSlug / workspace before treating this as "stood down".`
        : `No stand-down markers were found in scope (${scopeLabel}) — NOTHING was resumed.`
      : undefined;

    return {
      data: {
        ok: true,
        action,
        scope: scopeLabel,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        pausedCount,
        resumedCount,
        ...(createdStanddownGeneration ? { standdownGeneration: createdStanddownGeneration } : {}),
        targets,
        ...(warning ? { warning } : {}),
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
      },
    };
  },
});
