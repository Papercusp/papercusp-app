/**
 * routines:group-set — bulk pause/resume every routine in a group, and/or patch the
 * group's metadata (description, steward, review_cadence, mark-reviewed) — WI-5018
 * "routines can grow infinitely large ... grouping functionality would be very
 * beneficial" [owner 2026-07-15].
 *
 * GUARDRAIL (non-negotiable, per repo CLAUDE.md scheduling rules): this tool is
 * metadata + management ONLY. It never fires anything and never creates a third
 * execution mechanism — it flips the SAME `active` flag routines:set already flips,
 * just for every member of a group in one call, and it patches routine_groups (a
 * pure label/steward/cadence registry, no trigger_config).
 *
 * Wrapped in the gateway-control harness (dryRun preview, post-apply verify+auto-revert,
 * audit, one-call revert) — same pattern as routines:set, scoped to N rows instead of one.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { pausedByFrom } from './set';
import { DEFAULT_RELEASE_PAUSE_TTL_HOURS, resolvePauseExpiryMs } from '../../harness/routines/release-pause-ttl';

interface MemberSnap {
  installSlug: string;
  name: string;
  active: boolean;
  /** metadata->'pause' — the durable pause-attribution record (null when absent). */
  pause: Record<string, unknown> | null;
}

interface GroupSnap {
  exists: boolean;
  description: string | null;
  steward: string | null;
  reviewCadence: string | null;
  lastReviewedAtIso: string | null;
  members: MemberSnap[];
}

const MAX_MEMBERS_FOR_REVERT_CAPTURE = 5000;

export default defineTool({
  name: 'routines:group-set',
  profile: 'engineer',
  description:
    "Bulk pause/resume every routine in a group (active:false/true), and/or patch the group's metadata (description, steward, reviewCadence) and/or mark it reviewed now (markReviewed:true — clears review-due). Pause stamps each member it deactivates (metadata.pause + groupPause marker); resume restores EXACTLY those — members paused deliberately beforehand stay paused (activateAll:true forces every member on). WI-5018 routines grouping — metadata + a bulk convenience over routines:set, never a new execution mechanism. Audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Pause/resume EVERY routine in a group at once (e.g. pause the whole "release" group during a delicate manual deploy) instead of calling routines:set once per routine, or update a group\'s steward/description/review cadence, or clear its review-due flag after auditing it.',
    notWhen: 'To change ONE routine (cron, one-off pause, payload knobs), use routines:set. To just SEE groups/rollup, routines:list { rollup:true }.',
    chaining: 'routines:list { rollup:true } first to see current group state + review-due; routines:list { rollup:true, group } after to confirm.',
    seeAlso: [
      'routines:list (rollup:true for the group view; group filter for raw member rows)',
      'routines:set (change ONE routine, including assigning it to this group)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 15 } },
  args: z.object({
    group: z.string().min(1).max(120).describe('The routine group slug (must already exist — routines:set { group } auto-creates one on first assignment).'),
    active: z.boolean().optional().describe('active:false pauses every currently-active member (stamping each with the group-pause marker). active:true resumes ONLY the members this group-pause held (snapshot restore); pass activateAll:true to instead force every member on.'),
    reason: z.string().min(1).max(500).optional().describe('REQUIRED when pausing (active:false) — why. Persisted on each stamped member as metadata.pause { reason, pausedBy, pausedAtMs, groupPause } (same discipline as routines:set).'),
    pauseTtlHours: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe(
        `Only meaningful alongside active:false on the RELEASE group. How long this bulk hold may last, in hours — stamped on every member as metadata.pause.expiresAtMs, after which the routines engine AUTO-RESUMES them and records a notice. Omit for the ${DEFAULT_RELEASE_PAUSE_TTL_HOURS}h default. A release-group pause is ALWAYS finite (a whole-group pause is how the release pipeline goes dark in one call); ignored on any other group.`,
      ),
    activateAll: z.boolean().optional().describe('With active:true — resume EVERY member, including ones paused deliberately outside this group-pause. Default resumes only the group-pause snapshot.'),
    description: z.string().max(2000).optional().describe('Patch the group description.'),
    steward: z.string().max(200).optional().describe('Patch the group steward (who owns reviewing it).'),
    reviewCadence: z.string().max(40).optional().describe('Patch the review cadence, e.g. "90d". Used with lastReviewedAt to compute review-due in routines:list rollup.'),
    markReviewed: z.boolean().optional().describe('true = bump last_reviewed_at to now (clears review-due).'),
    dryRun: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:group-set requires operator, architect, or mug role');
    }
    if (
      args.active === undefined &&
      args.description === undefined &&
      args.steward === undefined &&
      args.reviewCadence === undefined &&
      !args.markReviewed
    ) {
      throw new Error('group-set requires active, description, steward, reviewCadence, and/or markReviewed');
    }
    if (args.active === false && !args.reason) {
      throw new Error(
        'routines:group-set { active: false } (bulk pause) requires a `reason` — an unattributed pause has twice left routines silently off for days (same rule as routines:set). Pass a short reason, e.g. "pausing learning loops from the Learning tab".',
      );
    }

    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const group = args.group;

    const readSnap = async (): Promise<GroupSnap> => {
      const groupRows = await sql<
        Array<{ description: string | null; steward: string | null; review_cadence: string | null; last_reviewed_at: Date | null }>
      >`
        SELECT description, steward, review_cadence, last_reviewed_at
          FROM harness_shared.routine_groups
         WHERE workspace_id = ${ws} AND slug = ${group}
         LIMIT 1`;
      if (groupRows.length === 0) {
        throw new Error(
          `routine group not found: "${group}" (assign a routine to it first via routines:set { group: "${group}" }, which auto-creates it — or check the slug via routines:list { rollup:true })`,
        );
      }
      const g = groupRows[0];
      const memberRows = await sql<
        Array<{ install_slug: string; name: string; active: boolean; pause: Record<string, unknown> | null }>
      >`
        SELECT install_slug, name, active, metadata -> 'pause' AS pause
          FROM harness_shared.routines
         WHERE workspace_id = ${ws} AND group_slug = ${group}
         LIMIT ${MAX_MEMBERS_FOR_REVERT_CAPTURE}`;
      return {
        exists: true,
        description: g.description,
        steward: g.steward,
        reviewCadence: g.review_cadence,
        lastReviewedAtIso: g.last_reviewed_at ? new Date(g.last_reviewed_at).toISOString() : null,
        members: memberRows.map((r) => ({
          installSlug: r.install_slug,
          name: r.name,
          active: r.active,
          pause: r.pause ?? null,
        })),
      };
    };

    /** Does this member's pause record carry THIS group's group-pause marker? */
    const heldByGroupPause = (m: MemberSnap): boolean =>
      m.pause !== null && (m.pause as { groupPause?: unknown }).groupPause === group;

    const writeGroupMeta = async (snap: GroupSnap): Promise<void> => {
      await sql`
        UPDATE harness_shared.routine_groups
           SET description = ${snap.description},
               steward = ${snap.steward},
               review_cadence = ${snap.reviewCadence},
               last_reviewed_at = ${snap.lastReviewedAtIso}::timestamptz,
               updated_at = now()
         WHERE workspace_id = ${ws} AND slug = ${group}`;
    };

    const outcome = await runControlMutation<GroupSnap>(
      {
        action: 'routines:group-set',
        subject: group,
        actor: `role:${ctx.role}`,
        capturePrev: readSnap,
        apply: async () => {
          const prev = await readSnap();
          const next: GroupSnap = {
            exists: true,
            description: args.description !== undefined ? args.description : prev.description,
            steward: args.steward !== undefined ? args.steward : prev.steward,
            reviewCadence: args.reviewCadence !== undefined ? args.reviewCadence : prev.reviewCadence,
            lastReviewedAtIso: args.markReviewed ? new Date().toISOString() : prev.lastReviewedAtIso,
            members: prev.members,
          };
          await writeGroupMeta(next);
          if (args.active === false) {
            // Bulk PAUSE: deactivate only the currently-ACTIVE members, stamping each with
            // the same durable pause-attribution record routines:set writes — plus the
            // groupPause marker that makes the held set a derivable snapshot. Members that
            // were already inactive (their own deliberate pauses included) are untouched.
            // P-004 (gate-verdict-liveness-and-repair-reliability-2026-08-31): a bulk
            // pause of the RELEASE group takes the whole release pipeline dark in one
            // call, so it carries the same finite expiry a single-routine pause does —
            // stamped identically, and enforced by the same routines-engine sweep.
            // Null (key omitted) for every other group.
            const pausedAtMs = Date.now();
            const expiresAtMs = resolvePauseExpiryMs({
              groupSlug: group,
              pausedAtMs,
              ttlHours: args.pauseTtlHours ?? null,
              reason: args.reason ?? null,
            });
            const stamp = {
              reason: args.reason,
              pausedBy: pausedByFrom(ctx, ctx.role),
              pausedAtMs,
              groupPause: group,
              ...(expiresAtMs !== null ? { expiresAtMs } : {}),
            };
            await sql`
              UPDATE harness_shared.routines
                 SET active = false,
                     -- jsonb bound as explicit stringify + cast: sql.json() THROWS on the
                     -- getOrgPg client (EI-607) and a bare object does not bind.
                     metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(stamp)}::jsonb),
                     updated_at = now()
               WHERE workspace_id = ${ws} AND group_slug = ${group} AND active = true`;
            next.members = prev.members.map((m) => (m.active ? { ...m, active: false, pause: stamp } : m));
          } else if (args.active === true) {
            // RESUME: by default restore ONLY the members this group-pause held (the
            // groupPause-stamped ones) — clearing pause → lastPause exactly as
            // routines:set does. activateAll:true forces every member on instead.
            const resumedAt = Date.now();
            if (args.activateAll) {
              await sql`
                UPDATE harness_shared.routines
                   SET active = true,
                       metadata = CASE
                         WHEN metadata ? 'pause'
                           THEN (metadata - 'pause')
                                || jsonb_build_object('lastPause', (metadata -> 'pause') || jsonb_build_object('resumedAtMs', ${resumedAt}::bigint))
                         ELSE COALESCE(metadata, '{}'::jsonb)
                       END,
                       updated_at = now()
                 WHERE workspace_id = ${ws} AND group_slug = ${group}`;
              next.members = prev.members.map((m) => ({ ...m, active: true, pause: null }));
            } else {
              await sql`
                UPDATE harness_shared.routines
                   SET active = true,
                       metadata = (metadata - 'pause')
                                || jsonb_build_object('lastPause', (metadata -> 'pause') || jsonb_build_object('resumedAtMs', ${resumedAt}::bigint)),
                       updated_at = now()
                 WHERE workspace_id = ${ws} AND group_slug = ${group}
                   AND metadata -> 'pause' ->> 'groupPause' = ${group}`;
              next.members = prev.members.map((m) => (heldByGroupPause(m) ? { ...m, active: true, pause: null } : m));
            }
          }
          return next;
        },
        revertTo: async (prev) => {
          await writeGroupMeta(prev);
          if (args.active !== undefined && prev.members.length > 0) {
            // Restore each member's ORIGINAL active flag AND pause record (not just flip
            // back) — a bulk pause must not silently resume a routine that was already
            // paused before it, and a reverted pause must not leave its stamp behind.
            for (const m of prev.members) {
              await sql`
                UPDATE harness_shared.routines
                   SET active = ${m.active},
                       metadata = CASE
                         WHEN ${m.pause === null}
                           THEN COALESCE(metadata, '{}'::jsonb) - 'pause'
                         ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pause}', ${JSON.stringify(m.pause ?? {})}::jsonb)
                       END,
                       updated_at = now()
                 WHERE workspace_id = ${ws} AND install_slug = ${m.installSlug} AND name = ${m.name}`;
            }
          }
        },
        verify: async (next) => {
          const cur = await readSnap();
          let activeOk = true;
          if (args.active !== undefined) {
            // Member-by-member against the computed next state — a snapshot resume leaves
            // deliberately-paused members OFF, so a blanket every(active===args.active)
            // would wrongly fail exactly when the tool did its job.
            const byKey = new Map(cur.members.map((m) => [`${m.installSlug}/${m.name}`, m.active]));
            activeOk = next.members.every((m) => byKey.get(`${m.installSlug}/${m.name}`) === m.active);
          }
          const metaOk =
            cur.description === next.description &&
            cur.steward === next.steward &&
            cur.reviewCadence === next.reviewCadence &&
            (!args.markReviewed || cur.lastReviewedAtIso !== null);
          const ok = activeOk && metaOk;
          return { ok, detail: ok ? undefined : 'group row / member active flags did not reflect the change' };
        },
        describe: (prev) => {
          const prevActive = prev.members.filter((m) => m.active).length;
          const held = prev.members.filter((m) => !m.active && heldByGroupPause(m)).length;
          let proposedActive = prevActive;
          if (args.active === false) proposedActive = 0;
          else if (args.active === true) proposedActive = args.activateAll ? prev.members.length : prevActive + held;
          return {
            current: {
              description: prev.description,
              steward: prev.steward,
              reviewCadence: prev.reviewCadence,
              memberCount: prev.members.length,
              activeCount: prevActive,
              heldByGroupPause: held,
            },
            proposed: {
              description: args.description !== undefined ? args.description : prev.description,
              steward: args.steward !== undefined ? args.steward : prev.steward,
              reviewCadence: args.reviewCadence !== undefined ? args.reviewCadence : prev.reviewCadence,
              memberCount: prev.members.length,
              activeCount: proposedActive,
            },
          };
        },
      },
      { dryRun: args.dryRun },
    );

    // Keep the owner's automation panes (Blender / Docs) live after a bulk
    // pause/resume — same contract as routines:set. Never fails the mutation.
    if (outcome.applied && !outcome.dryRun) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
        // The Learning tab's header pause/resume + spend chip reads the same group
        // state through learning.loopControl — keep it live on every bulk flip.
        notifySyncInvalidate('learning.loopControl');
        notifySyncInvalidate('learning.dream');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    return {
      data: {
        ok: true,
        group,
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
