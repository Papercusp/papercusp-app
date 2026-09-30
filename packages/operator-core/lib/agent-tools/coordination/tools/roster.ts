/**
 * coord:roster { scope, view } — unified presence/roster reader with explicit lenses.
 *
 * ONE read door answering "who's in this hive/fleet and what are they doing", with
 * four view lenses:
 *   - view=live (DEFAULT) — in-a-turn presence state (same underlying model as
 *     coord:presence, fleet:assignments, coord:glance; just one tool instead of three)
 *   - view=members — fleet/hive membership (who joined what, when)
 *   - view=claims — work-item + plan-item claims (who's on what work/plan)
 *   - view=history — historical who-was-ever-here (append-only coord log filtered by
 *     audience, requires coord:catch-up infrastructure)
 *
 * Scope defaults to 'hive' (caller's home hive); accepts 'workspace', and 'all' for a
 * SUPERUSER caller (the live gate is `ctx.isSuperuser`, not any agent role — a
 * non-superuser asking for 'all' is narrowed to 'workspace', never refused).
 *
 * The singular interface kills "which of 5 tools do I call" — coord:presence /
 * fleet:status / fleet:assignments / coord:glance become thin aliases (or deprecate).
 * Presence-coord-unification P-001 / D-001.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  resolvePresenceScope,
  assemblePresenceSnapshot,
  projectRosterRows,
  filterRosterRowsByState,
  computeRosterViewEtag,
} from '../presence-snapshot';
import { resolveSelfRef, markSelfRows } from '../self-marker';
import { readIdentity } from '../../locks/identity';
import { COORD_ROLES } from '../roles';
import { listFleetAssignments, groupByAgent, orphanedClaims, stalledClaims } from '../../../fleet/assignments';
import {
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
} from '../../fleet/assignments';
import { resolveConcreteWorkspaceId } from '../../../workspace-registry';
import { resolveAgentIdentity } from '../identity';
import { PRESENCE_TIER_CAPS, shapeCoordPresence } from './presence-shape';

/**
 * Explicit liveness is a deliberately cheap row shape, but it is still
 * unbounded by cardinality.  A large workspace can therefore overflow the
 * result door even though every individual row is narrow; the door's marker
 * would then be inserted into the JSON text and make the response unparsable.
 * Reuse the established trimmed roster cap as the conservative, transport-safe
 * page size.  Callers can target an owner (or use the ids lens) to recover the
 * rest without paying for the full presence rows.
 */
export const EXPLICIT_LIVENESS_ROW_CAP = PRESENCE_TIER_CAPS.trimmed.rows;

export function capExplicitLivenessRows(
  rows: readonly (Record<string, unknown> | string)[],
): { rows: (Record<string, unknown> | string)[]; truncated: boolean } {
  const truncated = rows.length > EXPLICIT_LIVENESS_ROW_CAP;
  return {
    rows: truncated ? rows.slice(0, EXPLICIT_LIVENESS_ROW_CAP) : [...rows],
    truncated,
  };
}

/**
 * WI-6658/WI-6662: did the CALLER apply an explicit `project`/`states` lens?
 * Any lensed read carries a top-level `projection` block, and that block is the
 * signal for the automatic payload-tier shaper to keep its hands off — see the
 * `shape` note below for why re-shaping those rows would invert the request.
 */
function hasCallerLens(data: unknown): boolean {
  return !!(data as { projection?: unknown } | null | undefined)?.projection;
}

export default defineTool({
  name: 'coord:roster',
  description:
    'ONE read door with an explicit lens: view=live (in-a-turn presence), members (fleet/hive membership), claims (who-on-what-item), history (who-was-ever-here). Same underlying model; coord:presence / fleet:status / fleet:assignments / coord:glance become thin aliases (or deprecate). Kills "which of 5 tools do I call".',
  guidance: {
    when: 'Before dispatch/handoff/routing: who can take work (view=live)? Who joined what fleet (view=members)? Who\'s on plan P (view=claims)? Historical who-was-ever-here (view=history). Just need live ownerIds? { view:"live", project:"liveness", states:["live"] } — ~99% smaller than the default read, and the only form that reliably fits one result.',
    notWhen: 'Being notified of future changes (subscribe fleet_assignment change-feed). Full message history (coord:inbox). Rate-limit telemetry (dev:rate_governor_status). NEVER hand-query coord_presence for liveness — sessionState is derived from six legs, two of which are not in Postgres, so no column holds it; use project/states here instead.',
    chaining: 'coord:roster { view } → read ONCE per turn; tail [coord+N] deltas for transitions. For history, use coord:catch-up after to refine by topic/plan.',
    returns:
      'view=live/members: { active: AgentRow[] (the roster), agents: AgentRow[] (SAME array — alias, use either), summary, self?, etag, ... }. view=claims: { agents: AgentGroup[] (claims-grouped, a DIFFERENT row shape), summary, orphaned, stalled }. view=history: { data: null, suggestion }.',
    seeAlso: [
      'coord:presence (view=live · members)',
      'fleet:assignments (view=claims)',
      'coord:catch-up { audience } (view=history)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // WI-6662 (context-trimming-tiers P-022): the AUTOMATIC payload-tier lens,
  // reusing coord:presence's shaper VERBATIM so two doors onto the same
  // assemblePresenceSnapshot cannot diverge in what they cost to ask. Before
  // this, a trimmed session got 130 uncapped ~37-key rows here but 40 projected
  // ~17-key rows from coord:presence — the same per-surface divergence
  // presence-derivation-unification-2026-07-17 closed for the VERDICT, showing
  // up in the PAYLOAD instead.
  //
  // Safe for the other lenses by construction: shapeCoordPresence returns `data`
  // untouched unless `active[]` is an array, and view=claims emits `agents[]`
  // while view=history emits `data:null`.
  //
  // EI-21845811145701209: view=live/members now ALSO emits `agents[]`, as an
  // alias of `active[]` (same reference, tier-shaped identically — see
  // presence-shape.ts). That makes `agents` the correct key for EVERY view of
  // this tool, closing the guess that used to silently read as "zero agents"
  // on live/members while happening to be right on claims.
  //
  // ⚠ An EXPLICIT caller lens BEATS the automatic one. Rows the caller already
  // projected to { ownerId, sessionState } would be RE-WIDENED by the shaper
  // into ~17 mostly-null fields — so a trimmed session asking for the cheapest
  // form would be handed a BIGGER payload than it asked for, which is the exact
  // inversion of both items' purpose.
  //
  // WI-6665 added a THIRD lens (the `since:` re-poll guard) and it composes
  // safely for the same structural reason: the `{ unchanged:true }` stub carries
  // no `active[]`, and shapeCoordPresence returns `data` untouched unless
  // `active[]` is an array — so the tier shaper cannot re-widen a stub any more
  // than it can a claims/history payload. A FOURTH lens must re-check exactly
  // this: the ordering rule is EXPLICIT-REQUEST-BEATS-AUTOMATIC-DEFAULT, and
  // anything that rewrites `active[]` has to preserve it. Note the etags are NOT
  // interchangeable between this tool and coord:presence — see
  // computeRosterViewEtag for why hashing the roster instead of the emitted
  // representation would lie here.
  // WI-2145871: opted in to the row contract, reusing coord:presence's pinned set
  // VERBATIM — the same reuse-the-shaper argument as the lens above, one level
  // out. `project()` in presence-shape.ts REBUILDS each row from a hand-written
  // key list, so `fields` is the axis that actually holds; `preserve: ['agents']`
  // pins the EI-21845811145701209 alias invariant.
  //
  // ⚠ Why the contract is NOT toothless despite the passthrough branch above:
  // checkTrimmedContract feeds the shaper a synthetic `{ active: [row], agents:
  // '__contract_top__agents' }`, and `hasCallerLens` is `!!data.projection` — a
  // key the check never sets. So the synthetic input takes the `shapeCoordPresence`
  // branch, not the passthrough, and a field deleted from `project()` fails here
  // by name. A future lens keyed off a DIFFERENT marker than `projection` must
  // re-check exactly this: if the check's synthetic input starts taking a
  // passthrough branch, the contract silently degrades to asserting nothing while
  // still reading as green.
  shape: {
    contract: {
      rows: 'active',
      fields: [
        'ownerId',
        'state',
        'wakeable',
        'intent',
        'confirmLiveness',
        'dormantScheduled',
        'contextPressure',
        'coordHook',
        'intentDivergent',
        'fleetControlState',
        'canAcquireWork',
      ],
      preserve: ['agents'],
    },
    standard: (data: unknown) => (hasCallerLens(data) ? data : shapeCoordPresence(data, 'standard')),
    trimmed: (data: unknown) => (hasCallerLens(data) ? data : shapeCoordPresence(data, 'trimmed')),
  },
  args: z.object({
    view: z
      .enum(['live', 'members', 'claims', 'history'])
      .optional()
      .describe(
        'Lens type: live (DEFAULT) = in-a-turn presence state; members = fleet/hive membership; claims = work/plan-item claims; history = append-only who-was-ever-here.',
      ),
    scope: z
      .enum(['hive', 'workspace', 'all'])
      .optional()
      .describe(
        'hive (DEFAULT) = your Hive\'s agents + federated peers; workspace = the whole workspace; all = every workspace — SUPERUSER only, and a non-superuser asking for it is silently narrowed to workspace rather than refused. Caller with no Hive (SU/operator) falls back to workspace.',
      ),
    pot: z
      .string()
      .optional()
      .describe('Explicit Hive slug to scope to (overrides caller-hive resolution; implies scope=hive).'),
    workspace: z
      .string()
      .optional()
      .describe('Workspace id for workspace/hive scope; omit to use the caller\'s.'),
    owner: z
      .string()
      .optional()
      .describe(
        'TARGETED lookup (view=live,members only): return ONLY the row(s) matching this agent id/label (exact, else substring). Include even if ended.',
      ),
    plan: z
      .string()
      .max(200)
      .optional()
      .describe('Filter to one plan slug (view=claims only) — "who\'s on P".'),
    agent: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one agent (view=claims only) — "what is X doing".'),
    include_detail: z
      .boolean()
      .optional()
      .describe('view=live,members: add each agent\'s heldFiles (cross-DB lock detail, opt-in). Default false.'),
    include_stale: z
      .boolean()
      .optional()
      .describe('view=live,claims: also list stale idle agents (no claims, old heartbeat). Default false.'),
    project: z
      .enum(['ids', 'liveness', 'full'])
      .optional()
      .describe(
        'view=live,members: how much of each row to emit. full (DEFAULT) = every field, unchanged. liveness = { ownerId, sessionState } only (~92% smaller). ids = ownerIds only (~96% smaller). The SAME oracle verdict either way — fewer fields, never a cheaper derivation.',
      ),
    states: z
      .array(z.enum(['live', 'parked', 'draining', 'suspect', 'ended', 'recorded']))
      .max(6)
      .optional()
      .describe(
        'view=live,members: return only rows in these sessionStates — e.g. ["live"]. summary/byState still describe the WHOLE roster, so you can see what you filtered out. A federated peer with no derivable state matches nothing and is reported as projection.unknownStateExcluded, never silently dropped.',
      ),
    since: z
      .string()
      .max(64)
      .optional()
      .describe(
        'CHEAP UNCHANGED RE-POLL (view=live,members): pass the `etag` from your PRIOR coord:roster read with THE SAME lens args. If the rows you would be handed are byte-identical, you get a ~120B { unchanged:true, etag, as_of } instead of the payload. This etag hashes the EMITTED representation, so unlike coord:presence\'s it DOES track liveness — a live↔parked flip changes it, and { project:"liveness", states:["live"] } re-polls correctly. It is NOT interchangeable with a coord:presence etag (different scope, salted apart); a foreign, stale, or different-lens token simply misses and you get the full read. ⚠ On the DEFAULT project:"full" read the rows carry lastActiveSecAgo, which moves nearly every read — the etag churns and this guard does nothing. Pair `since:` with a cheap lens (ids/liveness/states), which is where re-polling is worth guarding anyway.',
      ),
  }),
  result: z
    .object({
      active: z.array(z.unknown()).optional(),
      agents: z.array(z.unknown()).optional(),
      summary: z.unknown().optional(),
      self: z.unknown().optional(),
      etag: z.string().optional(),
      as_of: z.string().optional(),
      view: z.string().optional(),
      orphaned: z.array(z.unknown()).optional(),
      stalled: z.array(z.unknown()).optional(),
      data: z.unknown().optional(),
      suggestion: z.string().optional(),
      unchanged: z.boolean().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const view = args.view ?? 'live';
    const scope = args.scope ?? 'hive';

    // `plan` is a claims-lens filter.  The shared argument schema keeps the
    // field available for every view so callers can discover one stable
    // surface, but silently ignoring it on live/members/history would return
    // an unfiltered roster while making the request look successful (EI-21360300825984576).
    if (args.plan !== undefined && view !== 'claims') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'unsupported_filter',
              filter: 'plan',
              view,
              supportedViews: ['claims'],
              detail: 'The plan filter is supported only for view:"claims"; use view:"claims" or omit plan.',
            }),
          },
        ],
        isError: true,
      };
    }

    // Shared identity context for both presence and claims views
    const c = (ctx ?? {}) as { workspaceId?: string | null; harnessSlug?: string | null; isSuperuser?: boolean };
    const effScope = args.scope === 'all' && !c.isSuperuser ? 'workspace' : scope;

    // For claims view, resolve identity softly (can fail without breaking the read)
    let actorWorkspace: string | null = null;
    if (view === 'claims') {
      try {
        actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
      } catch {
        actorWorkspace = null;
      }
    }

    if (view === 'live' || view === 'members') {
      // Live and members views: use presence-snapshot infrastructure
      const resolved = await resolvePresenceScope(c, {
        scope: effScope,
        hive: args.pot,
        workspace: args.workspace,
        // EI-18653888556683414: a targeted owner lookup defaults to workspace-wide
        // (not hive-narrowed) so a live peer outside the caller's own Hive is
        // still found instead of reading as "no such agent".
        targetedOwner: !!args.owner,
      });

      let detail: { coordinationDomain: string } | undefined;
      if (args.include_detail) {
        try {
          detail = { coordinationDomain: readIdentity(ctx).coordinationDomain };
        } catch {
          detail = undefined;
        }
      }

      const snapshot = await assemblePresenceSnapshot(resolved, {
        ...(args.owner ? { owner: args.owner } : {}),
        ...(detail ? { detail } : {}),
      });

      const self = resolveSelfRef(ctx);

      // WI-6658: the state filter + field projection run on the ASSEMBLED rows,
      // so every emitted `sessionState` is the same oracle verdict the full read
      // would have given — this lens changes what is EMITTED, never how it is
      // derived. `summary` (incl. byState) is deliberately left describing the
      // WHOLE roster: a filtered read that also narrowed its own summary would
      // be unable to tell you what it hid from you.
      const projection = args.project ?? 'full';
      const marked = markSelfRows(snapshot.active, self);
      const { rows: filtered, unknownStateExcluded } = filterRosterRowsByState(marked, args.states);
      const projected = projectRosterRows(filtered, projection);
      const livenessPage =
        projection === 'liveness' ? capExplicitLivenessRows(projected) : { rows: projected, truncated: false };
      const emitted = livenessPage.rows;
      const lensed = projection !== 'full' || (args.states?.length ?? 0) > 0;

      // WI-6665: the re-poll etag is computed over the rows we are ABOUT TO
      // EMIT — after the state filter and the field projection — so it
      // identifies the representation, not the roster behind it. `snapshot.etag`
      // (identity+state, liveness deliberately excluded) is coord:presence's
      // contract and is NOT usable here: this tool's lens means one roster etag
      // maps to many payloads, and its cheapest lens asks precisely the liveness
      // question that etag ignores. It was previously leaked through the
      // `...snapshot` spread with no `since:` to spend it on; we replace it
      // rather than emit two same-named tokens with different meanings.
      const viewEtag = computeRosterViewEtag(projected, {
        view: view === 'live' ? 'live' : 'members',
        scope: resolved.scope,
        potId: resolved.potId ?? null,
        project: projection,
        states: args.states,
        includeDetail: args.include_detail,
        includeStale: args.include_stale,
        owner: args.owner,
      });

      // The short-circuit. Cheap by construction: we still ASSEMBLE the snapshot
      // (the oracle is the only honest source of sessionState — see the
      // projectRosterRows doc comment), so this saves PAYLOAD, not derivation.
      // Payload is what the caller pays for: a full read measured ~134KB.
      if (args.since && args.since === viewEtag) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                unchanged: true,
                etag: viewEtag,
                as_of: snapshot.as_of,
                scope: resolved.scope,
                note: 'rows identical to your etag under the SAME lens args; this etag tracks liveness, so a live↔parked flip would have changed it. A different project/states means a different etag — re-read without since:.',
              }),
            },
          ],
        };
      }

      const output = {
        ...(livenessPage.truncated
          ? {
              activeTruncated: {
                shown: emitted.length,
                censusCount: projected.length,
                truncatedByLimit: true as const,
                limit: EXPLICIT_LIVENESS_ROW_CAP,
                more: 'narrow with owner/states, or use project:"ids" for the complete owner-id set',
              },
            }
          : {}),
        ...snapshot,
        etag: viewEtag,
        view: view === 'live' ? 'live' : 'members',
        ...(self ? { self } : {}),
        active: emitted,
        // EI-21845811145701209: alias `agents` to the SAME rows as `active` for
        // view=live/members. Readers repeatedly guess `agents` first (it is also
        // the correct key for view=claims below, so this makes the guess right
        // across every view rather than right for one and silently [] for
        // another). Never a second derivation — same reference as `active`.
        agents: emitted,
        ...(lensed
          ? {
              projection: {
                project: projection,
                ...(args.states?.length ? { states: args.states } : {}),
                returned: emitted.length,
                ofActive: snapshot.active.length,
                ...(livenessPage.truncated
                  ? { truncatedByLimit: true as const, limit: EXPLICIT_LIVENESS_ROW_CAP }
                  : {}),
                ...(unknownStateExcluded ? { unknownStateExcluded } : {}),
              },
            }
          : {}),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    if (view === 'claims') {
      // Claims view: use fleet:assignments infrastructure
      // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
      // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
      // never leaks into the workspace filter as if it were a real workspace id
      // (see fleet:assignments' handler for the full incident writeup).
      const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
      const rows = await listFleetAssignments({
        workspaceId,
        agent: args.agent,
        plan: args.plan,
        harness: args.pot,
        activeOnly: !args.include_stale,
      });

      // Unification F1/P-003: the claims lens used to serve the fleet_assignment
      // view's heartbeat-only `alive` while view=live served the full oracle
      // model — ONE tool, two truths (a dead-but-warm session read alive here).
      // Reconcile through the same oracle-backed path fleet:assignments uses
      // (best-effort, like that tool), BEFORE the alive-filter so a dead-warm
      // claimless agent is excluded rather than shown as alive.
      const grouped = groupByAgent(rows);
      await reconcileWakeability(
        grouped,
        undefined,
        undefined,
        undefined,
        undefined,
        RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
      ).catch(() => {});
      const agents = grouped.filter(
        (g) => args.include_stale || g.claims.length > 0 || g.alive,
      );

      const orphans = orphanedClaims(rows);
      const stalled = stalledClaims(rows);

      const summary = {
        agents: agents.length,
        alive: agents.filter((a) => a.alive).length,
        claims: rows.filter((r) => r.source !== 'presence').length,
        orphaned_claims: orphans.length,
        stalled_claims: stalled.length,
        declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
        work_item_load: agents.reduce((n, a) => n + a.load, 0),
      };

      const self = resolveSelfRef(ctx);
      const output = {
        view: 'claims',
        as_of: new Date().toISOString(),
        summary,
        agents: markSelfRows(agents, self),
        orphaned: orphans,
        stalled: stalled,
        ...(self ? { self } : {}),
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    if (view === 'history') {
      // History view: placeholder for append-only coord log integration (WI-1346)
      // For now, return a structure that points to coord:catch-up
      const output = {
        view: 'history',
        as_of: new Date().toISOString(),
        note: 'History read via coord:catch-up with audience filtering (depends on WI-1346: make coord:catch-up the blessed history read)',
        scope: effScope,
        suggestion: 'Use coord:catch-up { audience: "@fleet:<slug>" } to read historical who-was-ever-here for a fleet',
        data: null, // placeholder until WI-1346 lands
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(output),
          },
        ],
      };
    }

    // Should never reach here due to zod enum validation, but be defensive
    throw new Error(`Unknown view: ${view}`);
  },
});
