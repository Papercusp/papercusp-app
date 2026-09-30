/**
 * coord:glance — ONE cheap call answering "what should I know right now?":
 * wake-gate state (default mode + staged-wake count), bees in flight, governor
 * pauses, the recent activity rows the fleet statusline already rendered, and
 * contextual TIPS evaluated for the caller's audience (glance-tips.ts).
 *
 * Built for high-frequency consumers (the Claude Code statusline renders on
 * every conversation update), so it stays light: three small PG reads, an
 * in-memory governor snapshot, and the pure tips engine — no usage/$spend
 * aggregation (that's dev:rate_governor_status).
 *
 * The founding tip (2026-06-11): the queen's autonomous loop sat silently
 * queued behind a manual wake gate for hours. coord:glance exists so that
 * state is one statusline line away, with the slash command to fix it.
 *
 * EI-3226: `bees.running` counts fresh-HEARTBEAT nursery rows — a host-process
 * alive signal, which stays fresh for a parked/idle session and can diverge
 * from coord:presence's reconciled liveness. `bees.working` (last_output_at
 * fresh) is the confirmed-active subset; prefer it for real health checks.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { snapshotGovernors } from '@papercusp/papercusp-shared/agent';
import { COORD_ROLES } from '../roles';
import { getDefaultWakeMode } from '../wake-mode';
import { countAllPendingWakes } from '../pending-wakes';
import { evaluateTips, GLANCE_AUDIENCES } from '../glance-tips';
import { resolveAgentIdentity } from '../identity';
import { getPresence } from '../presence';
import { contextUsagePct } from './inbox-context-usage';
import { fetchPresenceFleet } from '../presence-fleet';
import { getLoopStatus } from '../../../harness/routines/loop';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getFleet, listFleetsLedBy, resolveFleetScheme } from '../../../agent-fleets-store';
import { nearestColorSquareEmoji } from '../../../console-color-schemes';
import { getModes } from '../../../modes/store';
import { getAgentDisplayName } from '../../../display-names/store';
import {
  normalizeObjective,
  renderStatusDisplay,
  sessionObjective,
  type StatusDisplayGlance,
} from '../status-display';

const DEFAULT_ACTIVITY_LIMIT = 12;

/**
 * The pool account that served this owner's most-recent turn, from the
 * inference gateway's GET /admin/route?owner=<id> (routed-account visibility,
 * 2026-06-22). Historically each CLIENT statusline fetched this per tick; the
 * single-source display render (tui-status-parity-single-source-2026-07-05)
 * moves it server-side so the ⇢ chip is rendered ONCE for every TUI. Cheap +
 * fail-open: short timeout, 30s per-owner TTL cache (misses cached too, so a
 * down gateway costs one probe per TTL, not one per statusline tick).
 */
const ROUTED_ACCOUNT_TTL_MS = 30_000;
const routedAccountCache = new Map<string, { value: string | null; at: number }>();

async function fetchRoutedAccount(ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const cached = routedAccountCache.get(ownerId);
  if (cached && Date.now() - cached.at < ROUTED_ACCOUNT_TTL_MS) return cached.value;
  let value: string | null = null;
  try {
    const base = process.env.PAPERCUSP_GATEWAY_URL?.replace(/\/$/, '')
      ?? `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
    const res = await fetch(`${base}/admin/route?owner=${encodeURIComponent(ownerId)}`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const body = (await res.json()) as { account?: unknown } | null;
      value = typeof body?.account === 'string' && body.account ? body.account : null;
    }
  } catch {
    value = null; // gateway down / owner unseen — the chip just isn't shown
  }
  routedAccountCache.set(ownerId, { value, at: Date.now() });
  return value;
}

/** Nursery heartbeats are supervisor-maintained; stale running rows are dead. */
const BEE_FRESH_MS = 15 * 60_000;

/**
 * `heartbeat_at` is the HOST PROCESS's own alive-beat (bumped every
 * SPAWN_HEARTBEAT_INTERVAL_MS by spawn-reclaim.ts as long as the launching
 * operator host hasn't died) — it says nothing about whether the bee INSIDE
 * that process is actively doing anything. A parked/idle session still has a
 * live host process, so `bees.running` alone can read "3 running" while
 * `coord:presence` (which layers wakeability/session-state on top) shows
 * zero live bees (EI-3226) — misleading for a Queen using glance as the cheap
 * fleet-health read.
 *
 * `last_output_at` (child stdout — bumped only when the process actually
 * generates output) is the same signal mcp-dark-watchdog.ts and the
 * spawn-ceiling-jam detector already use to tell "process alive" apart from
 * "actively working" — reuse it here instead of reproducing coord:presence's
 * full wakeability join (which would defeat glance's cheap-read design).
 * `bees.working` is ADDITIVE (bees.running keeps its existing meaning for
 * back-compat) so a caller that wants the honest "confirmed active" count can
 * read the narrower one.
 *
 * WI-36765: `last_output_at` alone is a FALSE ZERO for a headless cup — a cup
 * makes MCP tool calls (which never touch `spawned_agents.last_output_at`,
 * only captured child STDOUT does) but can go many minutes without printing
 * a stdout line, so a cup mid-turn on tool calls reads as "not working"
 * forever. Widen `working` with an OR EXISTS against a fresh
 * `harness_shared.tool_invocations` row for the same spawn — a real MCP call
 * is exactly as strong a "working" signal as fresh stdout. This is safe to
 * correlate on `spawn_id` here specifically because the outer join only ever
 * reaches NURSERY spawns (rows in `spawned_agents`), and for that spawn kind
 * `tool_invocations.spawn_id` genuinely is a stable per-session boundary —
 * unlike interactive/su sessions, which mint a fresh spawn_id per call (see
 * the `tool_invocations spawn_id is not a session boundary` measurement
 * note); verified live 2026-08-09 against the cup that motivated this bug
 * (35 tool_invocations rows spanning 25+ minutes under one spawn_id).
 * `ti.workspace_id = spawned_agents.workspace_id` is included so the
 * correlated lookup can use the existing `tool_invocations_spawn_id_ws_idx`
 * (workspace_id, spawn_id) index rather than an unindexed spawn_id-only scan
 * of a 7M+-row table — the subquery only ever executes for the small set of
 * already-fresh-heartbeat rows the outer WHERE has already narrowed to.
 */
const BEE_WORKING_FRESH_MS = BEE_FRESH_MS;

/**
 * Exported so an integration test can exercise the real SQL against a real
 * Postgres (the unit test mocks `getOrgPg().sql` entirely and so cannot
 * validate this query's actual WHERE-clause semantics — see
 * glance-bee-working.integration.test.ts, WI-36765).
 */
export async function getBeeCounts(
  sql: ReturnType<typeof getOrgPg>['sql'],
): Promise<{ n: number; working: number }> {
  const rows = await sql<Array<{ n: number; working: number }>>`
    SELECT
      count(*)::int AS n,
      count(*) FILTER (
        WHERE last_output_at > now() - make_interval(secs => ${BEE_WORKING_FRESH_MS / 1000})
           OR EXISTS (
             SELECT 1 FROM harness_shared.tool_invocations ti
             WHERE ti.workspace_id = spawned_agents.workspace_id
               AND ti.spawn_id = spawned_agents.spawn_id
               AND ti.invoked_at > now() - make_interval(secs => ${BEE_WORKING_FRESH_MS / 1000})
           )
      )::int AS working
    FROM harness_shared.spawned_agents
    WHERE status IN ('running', 'restarting')
      AND heartbeat_at > now() - make_interval(secs => ${BEE_FRESH_MS / 1000})
  `;
  return rows[0] ?? { n: 0, working: 0 };
}

/**
 * Re-exported from the shared render module, where it now lives beside the
 * display-name and objective resolvers it serves (plan
 * hud-session-display-names-2026-08-31, D-003). Kept exported here so existing
 * importers of this path keep working.
 */
export { normalizeObjective } from '../status-display';

/**
 * The caller's concrete workspace — the ctx scope unless it is absent or the
 * all-workspaces wildcard, in which case the active registry workspace.
 *
 * Kept as a helper rather than inlined because each `self.*` segment below
 * resolves it inside its OWN try block: that isolation is deliberate (a
 * workspace-resolution hiccup must wipe only the segment that needed it, never
 * the objective already resolved above), so the expression genuinely recurs.
 */
function resolveWorkspaceId(ctx: unknown): string {
  const scoped = (ctx as { workspaceId?: string } | null | undefined)?.workspaceId;
  return scoped && scoped !== '*' ? scoped : activeWorkspaceId();
}

export default defineTool({
  name: 'coord:glance',
  description:
    "One cheap combined fleet glance: wake mode (default) + staged-wake count, bees in flight (bees.running = fresh-heartbeat nursery rows, a process-alive signal that can include parked/idle sessions; bees.working = the confirmed-active subset with fresh child-stdout output — prefer it for real health checks), paused governor buckets, recent cross-CLI activity rows, and contextual tips (with ready-to-run slash commands) evaluated for the caller's audience. With audience 'user' also returns a server-rendered `display` block (title + statusline lines + tip notice) that client status surfaces print verbatim — the single-source TUI render. The statusline/TUI read — one call instead of four. Takes ONLY audience/state/activity_limit/display_only — no `fleet`, `workspace`, or `harness` arg (scope is inferred from context); use fleet:assignments or fleet:leader-brief for named-fleet health.",
  guidance: {
    when: "A status surface (statusline, TUI bar, dashboard widget) needs the fleet's headline state in one round-trip, or you want the current contextual tips for an audience.",
    notWhen:
      'Deep rate-limit telemetry (usage %, $spend) — dev:rate_governor_status. Full presence roster or named-fleet health — coord:presence, fleet:assignments, or fleet:leader-brief; this tool has no `fleet`, `workspace`, or `harness` argument. Reviewing/releasing the staged wakes themselves — coord:wake-queue.',
    seeAlso: [
      'coord:roster (full presence with view lenses)',
      'fleet:assignments (named-fleet roster/health)',
      'fleet:leader-brief (leader-only named-fleet health brief)',
      'dev:rate_governor_status (deep rate-limit / spend telemetry)',
      'coord:wake-queue (review or release the staged wakes)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // EI-20226779878046151: glance gathers independent coordination snapshots
  // and never reads ctx.tx. Its orient fold must not retain an org-app pool
  // slot while those bounded reads complete.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    audience: z
      .enum(GLANCE_AUDIENCES)
      .optional()
      .describe("Who is looking — scopes which tips apply. Default 'user' (a human status surface)."),
    state: z
      .record(z.string(), z.string().max(200))
      .optional()
      .describe('Free-form caller state pairs for tip rules to match on (e.g. view=fleet-tab).'),
    activity_limit: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Recent activity rows to include (default 12; 0 to skip).'),
    display_only: z
      .boolean()
      .optional()
      .describe(
        'For human status surfaces that only print display.title/statusline/notice: compute display normally, but omit raw activity rows from the returned payload.',
      ),
  }),
  async handler(args, ctx) {
    const audience = args.audience ?? 'user';
    // Session-tier DEFAULT for the activity window (context-trimming-tiers
    // P-022). This tool keeps its hand-rolled JSON ToolResult — the statusline
    // + objective-title cc hooks and the OMP coord-hook MCP-call it and
    // `JSON.parse` the text (the coord:inbox hazard), and those pollers carry
    // no ctx_tier → full default → byte-identical. Only a trimmed/standard LLM
    // session gets the smaller window; an explicit activity_limit always wins.
    const sessionTier = (ctx as { contextTier?: 'trimmed' | 'standard' | 'full' })
      .contextTier;
    const tierActivityDefault =
      sessionTier === 'trimmed' ? 6 : sessionTier === 'standard' ? 8 : DEFAULT_ACTIVITY_LIMIT;
    const activityLimit = args.activity_limit ?? tierActivityDefault;
    const { sql } = getOrgPg();

    const [wakeDefault, stagedByOwner, beeCounts, activity] = await Promise.all([
      getDefaultWakeMode(),
      countAllPendingWakes(),
      getBeeCounts(sql),
      activityLimit > 0
        ? sql<Array<{ owner_id: string; summary: string | null; kind: string; created_at: string }>>`
            SELECT owner_id, summary, kind, created_at
            FROM harness_shared.agent_activity
            -- ::bigint, not the text alias — see activity/recent.ts (lexicographic
            -- ordering froze that read at id 999 once).
            ORDER BY id::bigint DESC
            LIMIT ${activityLimit}
          `
        : Promise.resolve([]),
    ]);

    const stagedTotal = [...stagedByOwner.values()].reduce((a, b) => a + b, 0);
    const beesRunning = beeCounts.n;
    const beesWorking = beeCounts.working;
    const now = Date.now();
    const governorPaused = snapshotGovernors()
      .filter((b) => b.state.pausedUntil > now)
      .map((b) => ({ key: b.key, pausedUntil: new Date(b.state.pausedUntil).toISOString() }));

    // Resolved early (EI-7696) so the tips engine can scope a per-agent action
    // (coord:wake-queue release_all) to the CALLER instead of the fleet-wide
    // stagedTotal it's evaluated against. Re-thrown failures never surface —
    // same fail-open contract as every other self.* signal below, which reuses
    // this same value rather than re-resolving it.
    let selfOwnerId: string | null = null;
    try {
      selfOwnerId = resolveAgentIdentity(ctx).ownerId ?? null;
    } catch {
      selfOwnerId = null;
    }

    // EI-13229: the caller's OWN staged count (0 when unresolvable or simply
    // has nothing staged) — distinct from the fleet-wide `stagedTotal` above.
    // `stagedByOwner` is already read for the roster badge; no extra query.
    const selfStagedCount = selfOwnerId ? (stagedByOwner.get(selfOwnerId) ?? 0) : 0;

    const tips = evaluateTips({
      audience,
      wakeDefault,
      stagedTotal,
      selfOwnerId,
      selfStagedCount,
      beesRunning,
      governorPausedKeys: governorPaused.map((g) => g.key),
      state: args.state ?? {},
    });

    // self.objective — the caller's CURRENT objective, for client status displays
    // (session-objective-display-2026-06-22): their in-execution work-item title ??
    // their declared coord intent. The single client-agnostic source the CC/Codex/OMP
    // renders read, so the display tracks coordination state with no LLM file-writing.
    // FAIL-OPEN: glance renders on every statusline tick, so any trouble → null and the
    // existing render is unaffected.
    let selfObjective: string | null = null;
    // self.loop — is THIS session on an engine loop (loop:arm)? Surfaced here (the one
    // client-agnostic glance read the statusline already makes every tick) so the CC/Codex/OMP
    // bottom display + terminal title can show "⟳ <interval>" with NO extra call
    // (loop-status-display-2026-06-23). Only an ACTIVE loop is reported; null otherwise.
    // `reachable` (WI-655): a CHEAP statusline signal derived from the loop row already
    // read — a loop that last fired but reached nobody (`no-session-now`) or whose wake
    // turn died (`stalled`) is the black-hole this surfaces, so the bottom display can
    // render "⟳ <interval> (unreachable!)" with NO extra probe.
    let selfLoop: { active: true; intervalSec: number; parked: boolean; reachable: boolean } | null = null;
    // self.fleets — EVERY named fleet this agent is in, for the multi-fleet terminal
    // identity (WI-1963). Scope A (no schema change): all fleets they LEAD
    // (agent_fleets.leader_owner_id — a per-fleet fact, so leading N fleets yields N
    // entries) ∪ their single presence member-fleet. A window has only ONE background
    // (OSC 11), so N fleets are shown as N nearest-match color SQUARES + names in the
    // OS title (statusline-fleet.sh). Empty when the agent is in no fleet. FAIL-OPEN.
    let selfFleets: Array<{ slug: string; label: string; role: string; square: string }> = [];
    // self.context — the caller's cached context-usage gauge (agent-managed-compaction
    // P-015): the same watchdog-cached tokens/limit the coord:inbox usage line uses,
    // surfaced here so the statusline can render an ambient `ctx N%` segment every tick
    // with NO extra call. null when usage can't be computed (no limit / no estimate).
    let selfContext: { tokens: number; limit: number; pct: number } | null = null;
    // self.modes — the caller's OFFICIAL standing modes (agent_modes rows, e.g.
    // ['auto','ideate']), so the statusline/GUI can render mode chips every tick with
    // NO extra call (EI-7626). Empty when none set. FAIL-OPEN like its siblings.
    let selfModes: string[] = [];
    // self.displayName — the caller's owner-keyed MANUAL name
    // (harness_shared.agent_display_names), read HERE so the OS terminal title
    // can lead with it on the very next status tick after a rename, with no
    // extra call and no client-side rule (plan hud-session-display-names,
    // D-001/D-003 — `renderStatusDisplay` resolves the fallback chain, this just
    // supplies the manual layer). null when the agent has no manual name, which
    // is also what a read hiccup degrades to: the title then falls back to the
    // objective exactly as it did before this feature existed (R9).
    let selfDisplayName: string | null = null;
    // selfOwnerId is already resolved above (hoisted for the tips engine,
    // EI-7696) — reused here rather than re-resolved.
    try {
      const ownerId = selfOwnerId;
      if (ownerId) {
        // workspace-scoped like every other harness_shared read: a bare owner_id
        // filter must never reach across workspaces, and the HUD roster resolves
        // this same objective per-workspace — an unscoped read here could pick a
        // different row and break the parity R1 requires. Measured before adding
        // the predicate: all 219 in-flight claimed rows carry a non-null
        // workspace_id, so nothing that resolved before stops resolving.
        const wipRows = await sql<Array<{ title: string }>>`
          SELECT title FROM harness_shared.work_items
          WHERE workspace_id = ${resolveWorkspaceId(ctx)}
            AND taken_by = ${ownerId} AND status IN ('wip', 'building', 'failing')
          ORDER BY taken_at DESC NULLS LAST LIMIT 1`;
        // Fetch presence ONCE here — reused for the objective-intent fallback AND the
        // context gauge (avoids a second PK read on the statusline hot path).
        const pres = await getPresence(ownerId);
        // intent is a NOT-NULL text column defaulting to '' (coord_presence) — an
        // undeclared intent reads back as '' (falsy, not nullish), so a bare `?? null`
        // would leak '' through and render an empty `🔭  · ` segment. Normalize blank
        // titles/intents to null so the fallback chain is honestly wip → intent → null.
        // ONE chain, shared with the HUD roster (R1/R8) — see sessionObjective.
        selfObjective = sessionObjective({
          workItemTitle: wipRows[0]?.title,
          intent: pres?.intent,
        }).objective;
        const ctxPct = contextUsagePct(pres?.contextTokens, pres?.compactionLimit);
        if (ctxPct != null && pres?.contextTokens != null && pres?.compactionLimit != null) {
          selfContext = { tokens: pres.contextTokens, limit: pres.compactionLimit, pct: ctxPct };
        }
        try {
          const ls = await getLoopStatus(ownerId);
          if (ls?.active) {
            const unreachable = ls.lastDeliveryOutcome === 'no-session-now' || ls.stalled === true;
            selfLoop = {
              active: true,
              intervalSec: ls.intervalSec ?? 0,
              parked: !!ls.parked,
              reachable: !unreachable,
            };
          }
        } catch {
          selfLoop = null; // fail-open: loop read never breaks the glance render
        }
        // Fleets this agent leads + its member fleet → color squares + names for the
        // OS title. Own try so a fleet-read hiccup never wipes objective/loop above.
        try {
          const wsId = resolveWorkspaceId(ctx);
          const seen = new Set<string>();
          for (const f of (await listFleetsLedBy(wsId, ownerId)).slice(0, 12)) {
            seen.add(f.fleetSlug);
            selfFleets.push({
              slug: f.fleetSlug,
              label: f.title?.trim() || f.fleetSlug,
              role: 'leader',
              square: nearestColorSquareEmoji(resolveFleetScheme(f).bg),
            });
          }
          // Their single presence membership fleet — skip if already a led fleet.
          const membership = (await fetchPresenceFleet([ownerId])).get(ownerId);
          if (membership?.fleetSlug && !seen.has(membership.fleetSlug)) {
            const rec = await getFleet(wsId, membership.fleetSlug);
            selfFleets.push({
              slug: membership.fleetSlug,
              label: rec?.title?.trim() || membership.fleetSlug,
              role: membership.fleetRole === 'leader' ? 'leader' : 'member',
              square: rec ? nearestColorSquareEmoji(resolveFleetScheme(rec).bg) : '⬛',
            });
          }
        } catch {
          selfFleets = []; // fail-open: a fleet-read error never breaks the render
        }
        // Official modes — own try so a modes-read hiccup never wipes the segments above.
        try {
          const wsId = resolveWorkspaceId(ctx);
          selfModes = (await getModes(wsId, ownerId)).map((m) => m.mode);
        } catch {
          selfModes = [];
        }
        // Manual display name — own try, same discipline: a name is decoration,
        // so a read hiccup drops to the objective fallback rather than costing
        // the caller its whole status render (R9).
        try {
          selfDisplayName = normalizeObjective(
            await getAgentDisplayName(resolveWorkspaceId(ctx), ownerId),
          );
        } catch {
          selfDisplayName = null;
        }
      }
    } catch {
      selfObjective = null;
    }

    const payload: StatusDisplayGlance & Record<string, unknown> = {
      ok: true,
      now: new Date(now).toISOString(),
      wake: {
        default: wakeDefault,
        stagedTotal,
        stagedOwners: stagedByOwner.size,
      },
      // `running` = host-process alive (heartbeat_at) — cheap but can include
      // parked/idle sessions (EI-3226). `working` = confirmed actively
      // generating output (last_output_at fresh) — the honest subset; a
      // caller doing real fleet-health assessment should prefer it over
      // `running`, or cross-check coord:presence for the full picture.
      bees: { running: beesRunning, working: beesWorking },
      governor: { anyPaused: governorPaused.length > 0, paused: governorPaused },
      activity,
      tips,
      self: {
        objective: selfObjective,
        displayName: selfDisplayName,
        loop: selfLoop,
        fleets: selfFleets,
        context: selfContext,
        modes: selfModes,
      },
      // Loud tier marker (D-004): a non-full session sees the smaller
      // activity window is tier-derived (widen via activity_limit /
      // payloadTier:"full").
      ...(sessionTier && sessionTier !== 'full' ? { payload_tier: sessionTier } : {}),
    };

    // The SINGLE-SOURCE display render (tui-status-parity-single-source-2026-07-05):
    // server-rendered title + statusline lines + injectable tip notice that every
    // client hook (Claude statusline, Codex/OMP title + notice pipes) prints
    // VERBATIM — one place to change what all TUIs show. Only for the human
    // status-surface audience; agent callers ('su'/'queen'/'bee') keep the lean
    // structured payload.
    if (audience === 'user') {
      // FAIL-OPEN (WI-1383525 GAP 3): a fault inside the render must degrade to
      // "no display block" — every client hook then takes its shared legacy
      // fallback, which objective-title-parity.test.ts pins byte-identical
      // across the three pipes — never fail the whole glance for the human
      // surface. `displayError` keeps the fault observable instead of silent.
      try {
        payload.display = renderStatusDisplay(payload, {
          ownerId: selfOwnerId,
          account: await fetchRoutedAccount(selfOwnerId),
        });
      } catch (err) {
        payload.display = null;
        payload.displayError = err instanceof Error ? err.message : String(err);
      }
    }

    if (args.display_only) payload.activity = [];

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload),
        },
      ],
    };
  },
});
