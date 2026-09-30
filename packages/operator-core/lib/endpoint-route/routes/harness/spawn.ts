/**
 * Spawn cluster — launch / invoke / resume.
 *
 *   POST /api/harness/:slug/launch    — kick off a full orchestrator run (detached)
 *   POST /api/harness/:slug/invoke    — single-role synchronous invocation (cross-harness primitive)
 *   POST /api/harness/:slug/resume    — clear escalation.md + relaunch
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 41). All three call `launchRun` from `lib/harness-launch.ts`
 * (carved out in b40).
 */
import { join } from 'node:path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getOrgPg, listUnconsumedEvents, consumeEvents } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  resolveProject,
  resolvePhasedProject,
  harnessDir,
} from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { SUPERUSER_TOKEN_PATH } from '../../../superuser-token';
import { launchRun } from '../../../harness-launch';
import { firePluginLifecycle } from '../../../plugin-host-runtime';
import { emitPipelineEvent } from '../../../events/pipeline-events';
import { recordAdvSession, markAdvSessionEnded, endedByForObservedExit } from '../../../adv-sessions';
import { defineTool } from '@papercusp/agent-mcp';
import { operatorApiBase } from '../../../operator-api-base';
import { resolveSpawnBackendModel, isOmpBackendExplicitlyConfigured } from '../../../harness-invoke-once';
import {
  backendFeatureGuard,
  interactiveBackendFromSpawnBackend,
} from '../../../backend-feature-capabilities';
import { canonicalCoordRole } from '../../../agent-tools/coordination/roles';
import { trackDetached } from '../../../detached-imports';
import { resolveInvokeProjectDir } from './invoke-project-dir';

/**
 * launch-path-argv-reconstruction (WI-1343), extended to the hive/overwatch invoke
 * path (WI-1347): this route is the loopback invoke chokepoint for the HTTP-based
 * autonomous spawns (Queen hive launches, overwatch) — there is no `psu …` CLI
 * invocation to reconstruct (unlike bootstrap-su/bootstrap-role), so this records
 * the resolved invoke-chokepoint call as a forensic descriptor instead: which
 * backend, role, harness, and launch kind were requested. Pure — exported for tests.
 */
export function reconstructHiveLaunchArgv(o: {
  backend: string;
  role: string;
  harnessSlug: string;
  isOverwatchLaunch: boolean;
  modelPin?: string | null;
}): string[] {
  const argv = [
    'invoke',
    `--agent=${o.backend}`,
    `--role=${o.role}`,
    `--harness=${o.harnessSlug}`,
    `--kind=${o.isOverwatchLaunch ? 'overwatch' : 'hive'}`,
  ];
  if (o.modelPin) argv.push(`--model=${o.modelPin}`);
  return argv;
}

const launch = defineTool({
  method: 'POST',
  path: '/harness/:slug/launch',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    // No gate: a harness can always be launched. SPEC.md is deprecated
    // (plans-central-harness-ux-2026-05-26, D-004) and a started plan is not
    // required to launch — with none, the orchestrator simply finds no
    // plan-scoped features eligible to pick and idles, rather than the launch
    // being rejected.
    const body = await req.json().catch(() => ({}));
    const extra = typeof (body as any).extra === 'string' ? (body as any).extra : '';
    const result = await launchRun(project, extra);
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
    // Phase 6b — plugin lifecycle hooks; best-effort. `beforeMissionStart` is
    // a FROZEN typed fire-point (plugin-system-hive-port D-003); the launch
    // emission is the live extension surface (reaction rules + events:await),
    // re-homed from the retired HookBus `mission.start` (P-007).
    void firePluginLifecycle('beforeMissionStart', {
      installSlug: project.slug,
      projectDir: project.path,
      stateDir: harnessDir(project),
    });
    emitPipelineEvent({ name: 'launch', harnessSlug: project.slug });
    return Response.json({ ok: true, logPath: result.logPath });
  },
});

/**
 * Extract ```actions``` block from agent output and POST each entry to
 * /api/admin/execute-action with the harness's harness_token. Returns
 * a summary of dispatched actions or null if no block was present.
 */
async function dispatchActionsBlockFromOutput(
  callerSlug: string,
  projectPath: string,
  output: string,
): Promise<{ count: number; results: any[] } | null> {
  let blockMatch = output.match(/```actions\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) {
    const pathMatch = output.match(/stdout:\s*(\S+\.out)/);
    let jsonlPath: string | null = null;
    if (pathMatch) {
      jsonlPath = pathMatch[1].replace(/\.out$/, '.jsonl');
    } else {
      const logsDir = join(projectPath, '.papercusp', 'logs');
      if (existsSync(logsDir)) {
        const files = readdirSync(logsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ path: join(logsDir, f), mt: statSync(join(logsDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        if (files.length > 0) jsonlPath = files[0].path;
      }
    }
    if (jsonlPath && existsSync(jsonlPath)) {
      try {
        const text = readFileSync(jsonlPath, 'utf8').split('\n').reduce((acc, line) => {
          try {
            const j = JSON.parse(line);
            const ev = j.event || j;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              return acc + (ev.delta.text || '');
            }
          } catch { /* skip */ }
          return acc;
        }, '');
        blockMatch = text.match(/```actions\s*\n([\s\S]*?)\n```/);
      } catch { /* skip */ }
    }
  }
  if (!blockMatch) return null;
  let actions: any[];
  try {
    actions = JSON.parse(blockMatch[1]);
    if (!Array.isArray(actions)) return null;
  } catch {
    return { count: 0, results: [{ error: 'malformed JSON in actions block' }] };
  }
  if (actions.length === 0) return null;

  const cfgPath = join(projectPath, '.papercusp', 'config.json');
  if (!existsSync(cfgPath)) return null;
  let token: string;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    token = cfg.harness_token;
    if (!token) return null;
  } catch { return null; }

  const operatorBase = operatorApiBase();
  const results: any[] = [];
  for (const action of actions) {
    const actionId = randomUUID();
    try {
      const r = await fetch(`${operatorBase}/api/admin/execute-action`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ actionId, action }),
        signal: AbortSignal.timeout(360_000),
      });
      const j = await r.json().catch(() => ({}));
      results.push({ op: action.op, ok: (j as any).ok === true, error: (j as any).error ?? null, status: r.status });
    } catch (e: any) {
      results.push({ op: action.op, ok: false, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { count: actions.length, results };
}

/**
 * Per-launch child timeout. A tracked autonomous-loop launch (a kind:'hive' Queen
 * duty cycle — survey → place → record — or an overwatch wake — survey → nudge →
 * declare-wake) is not a short single-role call, so the old 90s default SIGTERM'd
 * every Queen wake ~mid-survey (local-hive P-071 smoke, 2026-06-10: two consecutive
 * wakes exited 143 at ~91s with the kickoff unread). Plain launch-blueprint roles
 * (doc-steward / worker / release-fixer) also run a full LLM turn and can legitimately
 * queue behind the inference gateway before first output, so their default is no
 * longer the old 90s CLI smoke timeout. Loop launches still default to the route's
 * ceiling (2700s); an explicit `body.timeoutMs` wins for both kinds.
 */
function resolveInvokeTimeoutMs(bodyTimeoutMs: unknown, isLoopLaunch: boolean): number {
  const fallback = isLoopLaunch ? 2_700_000 : 900_000;
  return Math.max(5_000, Math.min(2_700_000, Number(bodyTimeoutMs ?? fallback)));
}

/**
 * The launcher's kickoff ("why this wake fired") — fireLaunchBlueprint sends
 * it, but this route used to silently DROP it, so the Queen woke with no idea
 * why (P-071 smoke). It is threaded to the child the same way cup:spawn
 * threads its Queen brief: via MUG_BRIEF, which invoke.ts hands to
 * buildPrompt as the situational-overlay `brief` section.
 */
function extractKickoff(bodyKickoff: unknown): string {
  return typeof bodyKickoff === 'string' ? bodyKickoff.slice(0, 4_000).trim() : '';
}

/**
 * Internal launch-row correlation passed by launch-blueprint/durable-spawn.
 * Only the two server-generated id families are accepted; arbitrary request
 * bodies must not gain a write primitive against spawned_agents.
 */
export function extractSpawnRecordId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (id.length === 0 || id.length > 512) return null;
  return id.startsWith('s-') || id.startsWith('durable-spawn:') ? id : null;
}

/**
 * Single-role invocation — used by NEXT_HARNESS dispatch from a parent
 * harness's coordinator. Synchronously runs the TS orchestrator's
 * `invoke-once` (`invoke <role>`) in the child harness's project dir and
 * returns the captured stdout.
 */
const invoke = defineTool({
  method: 'POST',
  path: '/harness/:slug/invoke',
  auth: 'loopback',
  // A single-role agent invocation runs an LLM to completion — far longer than
  // the 30s route default. The handler caps the child at `timeoutMs` (≤2700s —
  // supports long-running auto-fix implementations; raised from 1200s to support
  // 45min implementTimeoutMs). Give the route a ceiling just above the cap so it
  // never aborts a within-limits agent mid-run (claude-code promote reads the
  // plan + calls plans:promote, ~30-120s).
  timeoutSec: 2710,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = url.searchParams.get('role') ?? 'orchestrator';
    if (!/^[A-Za-z0-9_-]+$/.test(role)) {
      return Response.json({ error: 'invalid role name' }, { status: 400 });
    }
    // pot-rename compat (WI-3168-adjacent): this route is the ONE chokepoint every
    // launch-blueprint spawn traverses, but real callers still invoke with the OLD
    // role spelling (queen-brief-launch.ts's header comment documents `?role=queen`
    // as the actual production convention for Queen wakes; migration 519 backfilled
    // every DB column from old→new). Every role-identity CHECK below dual-checks via
    // `canonicalRole` (matching the `role === 'queen' || role === 'mug'` pattern
    // used elsewhere: bee/spawn.ts, blueprint/launch-blueprint.ts, role-launch-spec.ts,
    // …) and the STORED adv_sessions `role` field is canonicalized to match every
    // other role-scoped column. The raw `role` var is kept as-is for the argv/label
    // forensic record and the spawned child/response (those reflect what was
    // literally invoked, not what's canonically stored).
    const canonicalRole = canonicalCoordRole(role);
    // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-008 / D-018). The
    // second of THREE spawn doors (the third is agent-mcp/bootstrap-role.ts, the
    // `psu --role` console path — see retired-tier-roles.ts; this comment said
    // "exactly TWO" until P-013/D-022 and was wrong). This route is the one the comment
    // above already calls "the ONE chokepoint every launch-blueprint spawn
    // traverses", and fireLaunchBlueprint's own header adds that EVERY wake path
    // reaches it (durable spawn, direct fire, manual /invoke) — so this single
    // gate covers the Mug's whole launch family, including dbos/durable-spawn.ts
    // and blueprint/launch-blueprint.ts, which P-008 listed as separate targets.
    // The ROLE family (cup:spawn, place_batch, relaunch, …) funnels through the
    // other chokepoint, fleet/operator-spawn.ts.
    //
    // Deliberately keyed on `canonicalRole`, not the raw string: this route's own
    // comment records that real callers still invoke with the OLD spellings
    // (`?role=queen` is documented as the production convention for Mug wakes),
    // so a raw-string match would leave the retired tier reachable under every
    // one of its old names.
    const { isRetiredTierRole } = await import('../../../pot/retired-tier-roles');
    if (isRetiredTierRole(role)) {
      const { mugKettleSystemEnabled } = await import('../../../pot/started');
      if (!(await mugKettleSystemEnabled())) {
        return Response.json(
          {
            error: 'mug_kettle_retired',
            retired: 'permanent',
            message:
              `Cannot spawn role="${role}" — the Mug/Kettle/Cup tier is RETIRED, permanently. ` +
              `Launch an su fleet instead — fleet:launch-on-plan. ` +
              `There is no longer a flag to flip: the reversible escape hatch ` +
              `(papercusp-mug-kettle-system) was deleted in P-068, which is how that flag ` +
              `was always specified to graduate.`,
          },
          { status: 403 },
        );
      }
    }
    const body = await req.json().catch(() => ({} as any));
    const spawnRecordId = extractSpawnRecordId((body as any)?.spawnRecordId);
    const invokeDir = resolveInvokeProjectDir({ projectPath: project.path, role, body });
    if (!invokeDir.ok) {
      return Response.json(
        {
          error: 'invalid_repair_worktree',
          code: invokeDir.code,
          message: invokeDir.message,
        },
        { status: 400 },
      );
    }
    const invokeProjectDir = invokeDir.projectDir;
    const isHiveLaunch = url.searchParams.get('bpkind') === 'hive';
    // overwatch-role-2026-06-15 B-04 (C-3): an overwatch wake is also a tracked
    // autonomous-loop launch — its own bpkind so it gets the longer timeout, a
    // tracked/resumable session, the brief env, and the OVERWATCH turn-end check
    // (B-09), never the Queen's hive ones.
    const isOverwatchLaunch = url.searchParams.get('bpkind') === 'overwatch';
    // EI-21987499463893160: launch-blueprint/release-fixer invokes already carry
    // the durable spawned_agents id, but a plain invoke has no SessionStart hook
    // of its own to arm the standing inbox-wake. Arm that exact alias here so a
    // required coord:send wake can rendezvous with the launch even before the
    // child has written a presence row. Tracked hive/overwatch launches mint a
    // distinct hiveSpawnId below and own their session lifecycle; do not arm the
    // caller's spawned_agents row for those launches.
    if (spawnRecordId && !isHiveLaunch && !isOverwatchLaunch) {
      try {
        const { armInboxWake } = await import('../../../events/await/inbox-wake-arm');
        await armInboxWake({ ownerId: spawnRecordId });
      } catch (e) {
        // Wakeability is best-effort bookkeeping and must never prevent the
        // already-admitted child from launching.
        console.warn(
          `[invoke ${project.slug}/${role}] launch-row inbox-wake arm failed for ${spawnRecordId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    const timeoutMs = resolveInvokeTimeoutMs((body as any)?.timeoutMs, isHiveLaunch || isOverwatchLaunch);
    const extra: string[] = Array.isArray((body as any)?.extra)
      ? (body as any).extra.filter((s: any) => typeof s === 'string')
      : [];
    const spawnModelPin =
      typeof (body as any)?.spawnModel === 'string' ? ((body as any).spawnModel as string).trim() : '';
    // WI-2142846: an explicit per-fire backend override — set by launch-blueprint.ts's
    // live readAgentConfig() role-backend resolution (bodyExtra.spawnBackend), the
    // SAME channel shape spawnModel already uses. Validated against the same 3-value
    // set roleBackendOverride accepts (never 'auto' — that is not a concrete backend
    // an override can name); an unrecognized value is dropped rather than trusted, so
    // this route can never be handed a spawnBackend the rest of the resolution chain
    // (applyBackendSwap's DEFAULT_BACKEND_CMDS lookup) does not know how to honor.
    const rawSpawnBackend = (body as any)?.spawnBackend;
    const spawnBackendPin =
      rawSpawnBackend === 'claude-code' || rawSpawnBackend === 'omp' || rawSpawnBackend === 'codex'
        ? rawSpawnBackend
        : undefined;
    let routeBackendModel = resolveSpawnBackendModel(role, spawnModelPin || undefined, spawnBackendPin);
    let routeBackend = routeBackendModel.backend;
    // Set below only when the omp→claude-code tracked-launch rescue (D-fix
    // EI-18133554034909305) applies, OR an explicit spawnBackend pin was supplied
    // above (WI-2142846) — either way, the actual spawned child (buildInvokeOnce, via
    // spawnInvokeOnce's extraEnv) independently RE-RESOLVES the backend from scratch
    // (see the comment at this variable's use below) and would otherwise ignore this
    // route's own resolution entirely, landing back on ITS OWN stale/unconfigured
    // default rather than the one this route (or its caller) just decided on.
    let backendFallbackForSpawnEnv: string | null = spawnBackendPin ?? null;
    // Per-hive override (domain-generic-hive-architecture-2026-06-18 P-012/P-013/D-013):
    // the loopback invoke route is the single chokepoint for the HTTP-based autonomous
    // spawns (queen via bpkind=hive, overwatch, launch blueprints) — all of which carry a
    // BLUEPRINT_ID extra. Materialize the home Hive's FEDERATED promptOverride.* into a
    // local-tier blueprint and pass its root via BLUEPRINT_LOCAL_ROOT= so invoke.ts's
    // tier-aware resolver (P-014) picks the hive's customized role prompts over the
    // built-in (the bee/direct path is wired separately in operator-spawn.ts). Best-effort
    // + only when a BLUEPRINT_ID is present: a miss leaves `extra` unchanged (built-in only).
    try {
      const bpId = extra.find((e) => e.startsWith('BLUEPRINT_ID='))?.slice('BLUEPRINT_ID='.length);
      if (bpId) {
        const { resolveHiveLocalBlueprintRoot, blueprintLocalRootExtra } = await import(
          '../../../hive-local-blueprint-resolve'
        );
        const localRootExtra = blueprintLocalRootExtra(
          await resolveHiveLocalBlueprintRoot({
            workspaceId: activeWorkspaceId(),
            harnessSlug: project.slug,
            harnessDir: project.path,
            hiveBlueprintId: bpId,
          }),
        );
        if (localRootExtra) extra.push(localRootExtra);
      }
    } catch {
      /* best-effort: never block a spawn on a per-hive-override miss */
    }
    const kickoff = extractKickoff((body as any)?.kickoff);
    // Auto-implement dispatch correlation (EI-404): when present, the implement lane
    // fired this invoke fire-and-forget (it runs inside a DBOS step, so it can't await
    // the worker). This route is the one thing that DOES await the worker exit, so it
    // runs the worker-exit back-edge below. NOT forwarded to the child as args.
    const improvementDispatch = (body as any)?.improvementDispatch as
      | { dispatchId?: string; itemId?: string; attempt?: number }
      | undefined;

    // Tracked, resumable session for kind:'hive' blueprint launches (D-010).
    // fireLaunchBlueprint marks them with `?bpkind=hive` — this route only ever
    // sees the INSTALL slug, never the blueprint, so the launcher must say so.
    // ONE identity end-to-end: the minted spawn id becomes BOTH the
    // adv_sessions coordOwnerId AND the child's PAPERCUSP_SPAWN_ID (→ the
    // signed MCP URL's `client=` param, the Queen's coord identity). A bee's
    // coord:send {wake:true} addressed to that id finds this row and
    // wake-executor resumes it. Claude resumes by native session id; Codex has
    // no forced native id, so it resumes through the durable CODEX_HOME keyed by
    // the adv_sessions row id (nativeSessionHandleForAdvSession).
    let nativeSessionId: string | null = null;
    let hiveSpawnId: string | null = null;
    let advSessionRowId: number | null = null;
    if (isHiveLaunch || isOverwatchLaunch) {
      let trackedInteractiveBackend = interactiveBackendFromSpawnBackend(routeBackend);
      let trackedGuard = backendFeatureGuard(trackedInteractiveBackend, 'forced-native-session-id');
      if (!trackedGuard.supported && trackedInteractiveBackend !== 'codex') {
        // EI-18133554034909305 "Agent spawns are failing repeatedly": every tracked
        // hive/overwatch launch resolves omp by DEFAULT (resolveSpawnBackendModel's
        // `process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p'` fallthrough) when
        // the host has no explicit per-role/global backend config — and omp
        // structurally cannot support a forced native session id (it resumes by
        // thread id), so this ALWAYS 400'd, deterministically, on a host with no
        // override configured. Rescue exactly that "fell through to the generic
        // default" case by re-resolving with an explicit claude-code override — the
        // same rescue codex already gets below, just via a fallback instead of a
        // fixed special-case, since codex (unlike omp) still mints a usable
        // transcript-key uuid. Preserve the loud, honest 400 when omp was an
        // EXPLICIT operator choice (a per-role AGENT_ROLE_BACKENDS override, or a
        // configured AGENT_CMD/CLAUDE) — that is a real misconfiguration worth
        // surfacing, not silently overriding.
        if (!isOmpBackendExplicitlyConfigured(role)) {
          routeBackendModel = resolveSpawnBackendModel(role, spawnModelPin || undefined, 'claude-code');
          routeBackend = routeBackendModel.backend;
          trackedInteractiveBackend = interactiveBackendFromSpawnBackend(routeBackend);
          trackedGuard = backendFeatureGuard(trackedInteractiveBackend, 'forced-native-session-id');
          backendFallbackForSpawnEnv = 'claude-code';
          console.warn(
            `[invoke ${project.slug}] tracked ${isOverwatchLaunch ? 'overwatch' : 'hive'} launch for role=${role} ` +
              `resolved to the unconfigured default backend (omp), which cannot support a forced native session id — ` +
              `falling back to claude-code instead of failing the spawn`,
          );
        }
      }
      if (!trackedGuard.supported && trackedInteractiveBackend !== 'codex') {
        return Response.json({
          ok: false,
          error:
            `tracked ${isOverwatchLaunch ? 'overwatch' : 'hive'} launch requires native session id support for resume, ` +
            `but ${trackedInteractiveBackend} does not support forced-native-session-id: ${trackedGuard.reason}`,
        }, { status: 400 });
      }
      // Claude: the uuid is FORCED onto the CLI (`--session-id`) so `claude
      // --resume` works. Codex: the CLI accepts no forced id, but the uuid is
      // still minted as the TRANSCRIPT/ROSTER key — invoke.ts tees the codex
      // turn into `~/.papercusp/codex-transcripts/<uuid>.jsonl` and the hive-tabs
      // mirror pane locates it by this id. Without it every codex queen/overwatch
      // row carried session_id NULL and the owner's TUI panes sat on "no
      // transcript found — waiting for the next wake…" forever while both agents
      // ran (2026-07-01, the gpt-5.4 switch).
      nativeSessionId =
        trackedGuard.supported || trackedInteractiveBackend === 'codex' ? randomUUID() : null;
      hiveSpawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // overwatch-role-2026-06-15 B-04: the overwatch is a tracked/resumable loop
      // like the Queen, but on its OWN label prefix — `overwatch · <slug>/<role>`,
      // which overwatchMidTurn (B-09 watchdog) matches to skip a mid-turn re-arm.
      advSessionRowId = await recordAdvSession({
        sessionId: nativeSessionId,
        coordOwnerId: hiveSpawnId,
        agent: trackedInteractiveBackend === 'codex' ? 'codex' : 'claude',
        role: canonicalRole,
        cwd: invokeProjectDir,
        mode: 'console',
        // WI-3967: this prefix used to be the literal 'hive' — the hive→pot rename
        // (2026-07-xx) updated the READERS (resolveMugOwner/resolveMugOwners in
        // placement-watchdog.ts, pot/watchdog.ts, pot/wake.ts all query for
        // `'pot · ' + slug + '/%'`) but never the WRITER here, so every session
        // recorded since has carried a `hive · <slug>/<role>` label that NONE of
        // those readers can match — resolveMugOwner returns null unconditionally,
        // silently degrading gatherInbox's @role:mug slot-parked-message drain to a
        // permanent no-op (the root cause of WI-3967's dead-drop) plus every other
        // resolveMugOwner/watchdog.ts/pot-wake.ts consumer. 'pot' now matches the
        // readers; hiveInstallSlugFromLabel (wake-executor.ts) was updated in lockstep.
        label: `${isOverwatchLaunch ? 'overwatch' : 'pot'} · ${project.slug}/${role}`,
        // WI-1347: forensic reconstruction of this invoke-chokepoint call (no literal
        // CLI invocation exists for a hive/overwatch spawn to record verbatim).
        launchArgv: reconstructHiveLaunchArgv({
          backend: trackedInteractiveBackend,
          role,
          harnessSlug: project.slug,
          isOverwatchLaunch,
          modelPin: spawnModelPin || null,
        }),
      });

      // Roster/pane visibility (owner-facing zellij dock). The pui panes an agent
      // from the coord_presence-PRIMARY roster (adv-roster.ts builds it as
      // presence.map(...)); no presence row ⇒ no roster entry ⇒ the dock's
      // dock_pane_argv() hits a bare `continue` and silently skips it — so the
      // owner never sees the mug/kettle turn even though it ran (its spawned_agents
      // + adv_sessions rows exist and the turn completes). A cup gets a row because
      // it boots as a principal and mints one on its first coord:orient; a tracked
      // hive/overwatch launch only ever calls no-op-on-missing-row heartbeats
      // (coord:escalate/emit/pot:wake/kettle:declare-wake — never coord:inbox/orient,
      // the only presence-MINTING calls), so it seeds none. Seed it HERE under the
      // SAME coordOwnerId the adv_sessions row uses (hiveSpawnId) — the agent's env
      // PAPERCUSP_SPAWN_ID resolves to this id, so its own dispatch heartbeats keep
      // the row fresh, the roster's LEFT-join to adv_sessions resolves the resumable
      // session_id for `claude --resume`, and the presence reaper clears it when the
      // turn ends. Best-effort: bookkeeping must never break a spawn.
      try {
        const { writePresence } = await import('../../../agent-tools/coordination/presence');
        await writePresence(
          {
            ownerId: hiveSpawnId,
            ownerLabel: `${canonicalRole} · ${project.slug}`,
            source: 'fleet-spawn',
            workspaceId: activeWorkspaceId(),
            userId: null,
          },
          { agentRole: canonicalRole },
          project.slug,
        );
      } catch (e) {
        console.warn(
          `[invoke] seed presence failed (${project.slug}/${role}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Phase 7: write pending_events for the role to read at $STATE_DIR/pending-events.jsonl.
    if (role === 'orchestrator') {
      try {
        const { sql } = getOrgPg();
        // P-041: scope the queue read/consume to the request workspace — the
        // admin handle bypasses RLS and install_slug isn't workspace-unique, so
        // an unscoped read would hand this orchestrator another workspace's
        // events (and the consume would mark them handled).
        const ws = activeWorkspaceId();
        const events = await listUnconsumedEvents(sql, project.slug, { onlyDue: true, limit: 25, workspaceId: ws });
        const stateDir = join(project.path, '.papercusp');
        const eventsFile = join(stateDir, 'pending-events.jsonl');
        mkdirSync(stateDir, { recursive: true });
        if (events.length > 0) {
          const jsonl = events
            .map((e) => JSON.stringify({
              id: e.id,
              kind: e.kind,
              target_role: e.targetRole,
              payload: e.payload,
              due_at: e.dueAt,
              source_id: e.sourceId,
            }))
            .join('\n');
          writeFileSync(eventsFile, jsonl + '\n', 'utf8');
          await consumeEvents(sql, events.map((e) => e.id), `papercusp-invoke:${project.slug}`, ws);
        } else {
          try { rmSync(eventsFile, { force: true }); } catch { /* ignore */ }
        }
      } catch {
        // pending_events table absent — proceed without
      }
    }

    // This route is operator-initiated + loopback-gated (auth: 'loopback',
    // enforced at the route-stack authStep), so the spawned agent connects to the agent-mcp via the
    // `?superuser=1` door — giving it the isSuperuser identity that
    // resolveAgentIdentity-gated coord tools (plans:promote, coord:*) require.
    // A plain signed-spawn ctx has no principal, so those tools 4xx. The bearer
    // is read here and threaded to spawn-mcp (writeSignedSpawnMcp) via env.
    const suBearer = (() => {
      try { return readFileSync(SUPERUSER_TOKEN_PATH, 'utf8').trim() || undefined; }
      catch { return undefined; }
    })();

    // Route the spawn through the ONE chokepoint (spawnInvokeOnce) — governor pacing
    // + the unified ceiling + whole-group kill on timeout — instead of a private
    // buildInvokeOnce + raw child_process.spawn (unify-agent-spawn-chokepoint P-008).
    // The per-request timeoutMs is threaded through; the route keeps its
    // actions-dispatch + structured response, now on the chokepoint's output.
    //
    // LAZY import on purpose: orchestrator-runner transitively pulls in the whole DBOS
    // workflow graph (orchestrator-loop/-workflow register process-global workflows at
    // module load). Importing it eagerly would drag those registrations into the route
    // graph, so any test that re-imports the routes under vi.resetModules() would hit a
    // duplicate-registration crash. Loading it on first /invoke (cached thereafter)
    // keeps route registration side-effect-free; the cost is a one-time async import.
    const { spawnInvokeOnce } = await import('../../../dbos/orchestrator-runner');
    const env: Record<string, string> = suBearer ? { PAPERCUSP_SPAWN_SU_BEARER: suBearer } : {};
    // Carry the omp→claude-code tracked-launch rescue (above) through to the
    // ACTUAL spawned child: buildInvokeOnce (via spawnInvokeOnce's extraEnv)
    // independently re-resolves the backend from scratch and would otherwise
    // land back on the same unconfigured omp default this route just rescued
    // itself from, spawning the wrong CLI under the native session id it minted
    // for claude.
    if (backendFallbackForSpawnEnv) env.PAPERCUSP_SPAWN_BACKEND = backendFallbackForSpawnEnv;
    // Instance-config env-transport parity (cloud-deployment P-008): spawnInvokeOnce
    // attaches HARNESS_CONFIG_JSON only when the spawn env names the install
    // (HARNESS_SLUG + PAPERCUSP_WORKSPACE_ID — buildPipelineExtraEnv stamps them on the
    // DBOS pipeline path). This HTTP /invoke route — the SECOND spawn chokepoint — never
    // stamped them, so route-launched roles (kettle/mug/blueprint-run) ran with an EMPTY
    // instance config and fell through to committed role-model defaults: a pot-level
    // configOverride (aiBackend.roles.<role>.model) silently never reached them, which
    // kept kettle@papercusp hard-down on a claude-unreachable model id even after the
    // registry pin (2026-07-17 outage; evidence on WI-5102).
    env.HARNESS_SLUG = project.slug;
    env.PAPERCUSP_WORKSPACE_ID = activeWorkspaceId();
    // EI-13668 root cause: `deriveAgentRole` (identity.ts) only ever derives a role
    // from `PAPERCUSP_AGENT_ROLE` env or a coarse identity.source→role fallback (never
    // 'mug'/'kettle'/'papercup'/'papercup-deep' — those map to the generic 'cup' via
    // the 'fleet-spawn'/'signed-spawn' source branch). The one-time presence seed
    // below (`writePresence(..., { agentRole: canonicalRole }, ...)`) sets the role
    // correctly at spawn time, but that row is IMMEDIATELY clobbered the moment the
    // spawned agent's OWN session makes its first presence write (coord:orient /
    // declare-intent / heartbeat) — those calls don't pass `agentRole` explicitly, so
    // presence.ts recomputes it via `deriveAgentRole(identity)` using THIS call's own
    // identity/source, landing back on the generic fallback. `@role:mug` (and every
    // other role-slot selector) then never matches a truly-live role holder — it only
    // ever sees the one-shot seed row, which stops being "live" the instant the agent
    // heartbeats for real. Stamping PAPERCUSP_AGENT_ROLE on the CHILD PROCESS'S env
    // here makes `deriveAgentRole` return the correct role on every subsequent
    // presence write for the lifetime of this process — the durable fix, not another
    // one-shot seed.
    env.PAPERCUSP_AGENT_ROLE = canonicalRole;
    // EI-7871 (WI-3082 follow-up): this /invoke route is the ONE chokepoint every
    // launch-blueprint spawn traverses (queen via bpkind=hive, overwatch via
    // bpkind=overwatch, doc-steward/sentinel/scan/deploy/audit/merge-resolution/
    // content-fix/release-fix/coding/implement via fireLaunchBlueprint) — and none
    // of them stamped PAPERCUSP_TURN_TRIGGER, so invoke.ts's usage-sample record
    // (libs/papercusp/packages/orchestrator/src/invoke.ts:3453) always saw it
    // undefined -> NULL turn_trigger for these roles' agent_usage_samples rows
    // (WI-3082's buildPipelineExtraEnv fix only covered the DBOS invoke-once
    // pipeline path — a DIFFERENT chokepoint from this HTTP /invoke route). Every
    // caller of this route fires from a scheduled cadence / event-driven system
    // trigger (never a live human or an interactive coord-wake resume — that's
    // wake-executor.ts's separate resume path, fixed alongside this), so 'cron' is
    // the correct default; a caller that knows better (e.g. wake-executor.ts's
    // defaultFireHiveWake, which fires because of an actual coord/events:await
    // wake) can override via bodyExtra.turnTrigger.
    const turnTrigger = typeof (body as any)?.turnTrigger === 'string' ? (body as any).turnTrigger : 'cron';
    env.PAPERCUSP_TURN_TRIGGER = turnTrigger;
    // WI-40422: plain launch-blueprint invocations already carry the durable
    // spawned_agents id as spawnRecordId. Thread that exact id into the child so
    // tool_invocations can join back to the same row. A tracked hive/overwatch
    // launch owns a distinct coord identity, so its hiveSpawnId keeps precedence.
    // EI-22019512930234742: mcp-call and coordination tools identify the caller
    // from PAPERCUSP_SID before PAPERCUSP_SPAWN_ID. Bind both to the same
    // route-owned identity so a child cannot invent a per-process owner.
    // EI-22367010504753373: a direct /invoke without either durable launch row
    // still needs a route-owned identity. runChild records this value as the
    // task-ledger coordOwnerId; without it, a timed-out resolver can leave an
    // exclusive resource lease under an opaque UUID that no liveness instrument
    // can safely condemn. Mint once at this route boundary and bind both env keys
    // to it so the task row and every child tool call share the same join key.
    const childOwnerId = hiveSpawnId ?? spawnRecordId ?? `s-invoke-${randomUUID()}`;
    env.PAPERCUSP_SID = childOwnerId;
    env.PAPERCUSP_SPAWN_ID = childOwnerId;
    if (hiveSpawnId) {
      if (nativeSessionId) env.PAPERCUSP_NATIVE_SESSION_ID = nativeSessionId;
      // Codex ALWAYS gets the durable-CODEX_HOME key (resume-by-row-id), even now
      // that it ALSO carries a native session id — the id is the transcript/roster
      // key (hive-tabs mirror), NOT a resume handle; the durable home remains the
      // resume mechanism. Pre-2026-07-01 this was `!nativeSessionId && …`, which
      // the codex transcript fix would have silently broken.
      if (routeBackend === 'codex' && advSessionRowId != null) {
        env.PAPERCUSP_CODEX_SESSION_KEY = String(advSessionRowId);
      }
    }
    // queen-brief-cache-assembly B-03 (P-006) → moved to THIS route (WI-682): the
    // Queen's wake brief (ranked survey floor + carry-note + the @role:queen
    // parked-message drain) is computed HERE, the ONE chokepoint every Queen wake
    // path actually traverses. It used to live in fireLaunchBlueprint, but EI-995
    // moved scheduled wakes to the buildLaunchSpawnRequest durable seam which
    // bypassed it — every scheduled Queen woke briefless and the role:queen
    // mailbox rotted undelivered for a week (the exact two-chokepoints-drift the
    // D-011 gateway fix warns about). A caller may still pre-supply body.queenBrief
    // (respected verbatim); absent that, compute fail-soft — a brief failure never
    // blocks the wake, she falls back to the survey tools. invoke.ts hands it to
    // buildPrompt({ queenBrief }) → a <system-reminder> in the volatile tail
    // (D-006). Distinct from MUG_BRIEF (the kickoff / Queen→bee overlay).
    // P-059: the `canonicalRole === 'mug'` leg that COMPUTED this brief
    // (`computeMugWakeBrief`, pot/mug-brief-launch) retired with the Mug/Kettle
    // system — there is no Mug to wake, so there is nothing to compute. The
    // CHANNEL survives and is still live: a caller may pre-supply
    // body.queenBrief (fireLaunchBlueprint's bodyExtra does), it rides through
    // to env.MUG_WAKE_BRIEF, and the orchestrator reads that env var in
    // invoke.ts to build the <system-reminder> tail block (D-006). Only the
    // now-unreachable auto-compute is gone.
    const queenWakeBrief = typeof (body as any)?.queenBrief === 'string' ? ((body as any).queenBrief as string) : '';
    if (queenWakeBrief.trim()) env.MUG_WAKE_BRIEF = queenWakeBrief;
    // BENCH-SCOPED, FAIL-CLOSED OPUS PIN (P-033 Fix 2). A per-invocation model spec threaded by
    // fireLaunchBlueprint (bodyExtra.spawnModel) for a BENCH-hive Queen wake → PAPERCUSP_SPAWN_MODEL,
    // the highest-precedence model channel (invoke.ts resolveModel reads it FIRST, above AGENT_MODELS +
    // the committed floor). This pins the bench Queen to opus WITHOUT a GLOBAL AGENT_MODELS opus entry on
    // :3170 — so only the bench hive's Queen is pinned, every other hive keeps its sonnet floor. FAIL-CLOSED
    // by the same two guarantees as the bee pin: the governor WAITS on a paused opus bucket (never
    // substitutes) and the model-tiers floor-clamp never downgrades below the pinned model.
    if (spawnModelPin) env.PAPERCUSP_SPAWN_MODEL = spawnModelPin;
    // overwatch-role-2026-06-15 B-04 (C-3): the overwatch's precomputed
    // OverwatchBrief (assembled by the system:overwatch-launch action). invoke.ts
    // hands it to buildPrompt({ overwatchBrief }), which renders it as a
    // <system-reminder> tail block — the same mechanism as MUG_WAKE_BRIEF, a
    // distinct env for a distinct role's brief.
    const overwatchWakeBrief = typeof (body as any)?.overwatchBrief === 'string' ? ((body as any).overwatchBrief as string) : '';
    if (overwatchWakeBrief.trim()) env.OVERWATCH_WAKE_BRIEF = overwatchWakeBrief;
    // EI-506: MUG_BRIEF is the Queen→BEE situational overlay (invoke.ts → the
    // "## Queen brief" section). For the QUEEN's OWN wake the kickoff is a terse
    // wake-reason ('timer', 'coord:escalate'), which would render as a self-addressed
    // bee-overlay — misleading. Her wake reason is already carried in the wake brief's
    // "Woke by:" line, so set MUG_BRIEF from the kickoff for the queen ONLY when she
    // has no wake brief (degraded fallback — preserves the P-071 "why you woke" signal
    // the kickoff threading was added for). Non-queen roles always get the real overlay.
    // overwatch (B-04): its wake reason rides the OverwatchBrief's `wokeBy`, so
    // setting MUG_BRIEF would render a misleading "## Queen brief" overlay (the
    // EI-506 reasoning, applied to the overwatch) — exclude it like the briefed Queen.
    if (kickoff && canonicalRole !== 'kettle' && (canonicalRole !== 'mug' || !queenWakeBrief.trim())) env.MUG_BRIEF = kickoff;
    // hive-inference-gateway routing (D-011 fix): the /invoke spawn path is the SECOND spawn
    // chokepoint and had DRIFTED from the bee chokepoint (operator-spawn.ts:1045-1063) — it never
    // routed Queen/overwatch/blueprint-run agents through the localhost pacing gateway, so they
    // egressed with the single shared ~/.claude OAuth credential and 429'd on its WEEKLY cap (→ the
    // ~3s/0-token wakes that placed nothing) while the 8-account pool sat idle with headroom. Route
    // through the shared resolveSpawnGatewayEnv (the ONE routing decision both chokepoints apply, so
    // they can't drift again). Fail-soft + flag-gated inside the helper; {} when the gateway is off
    // (unchanged direct egress). Lazy-import keeps the route module registration side-effect-free
    // (cf. the orchestrator-runner import above).
    {
      const { resolveSpawnGatewayEnv } = await import('../../../inference-gateway/spawn-env');
      Object.assign(
        env,
        await resolveSpawnGatewayEnv({
          workspaceId: activeWorkspaceId(),
          slug: project.slug,
          ownerId: hiveSpawnId ?? undefined,
          backend: routeBackend,
          role, // gateway-priority-tiers: role → admission tier (flag-gated header)
          model: routeBackendModel.model || undefined, // P-005/WI-951: per-role Claude model fidelity through the gateway — the /invoke chokepoint (mirrors operator-spawn.ts:1220), closing the second-chokepoint drift
        }),
      );
    }
    // Load the launch-row writers once per correlated invoke. Both callbacks
    // below must target spawnRecordId (the durable release-fixer row), even when
    // a tracked hive launch uses hiveSpawnId as the child's coord identity.
    const spawnTracking = spawnRecordId ? await import('../../../fleet/spawn-reclaim') : null;
    let lastOutputPersistedAt = 0;
    const persistSpawnOutputActivity =
      spawnRecordId && spawnTracking
        ? () => {
            const observedAt = Date.now();
            // Match the nursery heartbeat cadence: stdout/stderr may arrive in
            // thousands of chunks, while one monotonic write per minute preserves
            // truthful progress without turning the stream into a write storm.
            if (
              lastOutputPersistedAt > 0 &&
              observedAt - lastOutputPersistedAt < spawnTracking.SPAWN_HEARTBEAT_INTERVAL_MS
            )
              return;
            lastOutputPersistedAt = observedAt;
            void trackDetached(
              spawnTracking.heartbeatSpawns(getOrgPg().sql, [spawnRecordId], new Map([[spawnRecordId, observedAt]])),
            ).catch((error) => {
              // Let a later chunk retry if this best-effort write failed.
              if (lastOutputPersistedAt === observedAt) lastOutputPersistedAt = 0;
              console.warn(
                `[invoke ${project.slug}/${role}] launch-row output stamp failed for ${spawnRecordId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }
        : undefined;
    const spawnStartMs = Date.now();
    const r = await spawnInvokeOnce(
      invokeProjectDir,
      role,
      extra,
      env,
      {
        timeoutMs,
        ...(spawnRecordId ? { taskSpawnId: spawnRecordId } : {}),
        ...(spawnRecordId
          ? {
              // The firing DBOS/operator process may differ from this /invoke
              // worker. Stamp the actual invoke-once child, not the caller's
              // pid, so boot/reclaim liveness remains truthful across the
              // handoff (EI-20981156698708733).
              onChildPid: (pid: number) => {
                void trackDetached(
                  spawnTracking!.recordSpawnPid(getOrgPg().sql, spawnRecordId, pid, { handoff: true }),
                ).catch((error) => {
                  console.warn(
                    `[invoke ${project.slug}/${role}] launch-row PID stamp failed for ${spawnRecordId}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                });
              },
              // WI-40422: task_ledger heartbeats prove only that the cgroup
              // exists. Persist concrete child output against the exact launch
              // row so pre-turn liveness can distinguish progress from an idle
              // Node/Claude/socat scope.
              onOutputActivity: persistSpawnOutputActivity,
            }
          : {}),
      },
    );
    const workerRuntimeMs = Date.now() - spawnStartMs;

    // A failed/timed-out merge-resolver can leave MERGE_HEAD plus owner-scoped
    // git-sync leases behind after this route's timeout kill. The cleanup helper
    // is intentionally lazy (like the runner above) so route registration does
    // not pull the lock store into every harness route, and it receives the
    // superproject path + exact route-owned child identity/extra payload.
    if (canonicalRole === 'merge-resolver' && (r.timedOut === true || r.exitCode !== 0)) {
      try {
        const { cleanupMergeResolverAfterFailure } = await import(
          '../../../harness/merge-resolver-cleanup'
        );
        const cleanup = await cleanupMergeResolverAfterFailure({
          projectPath: project.path,
          ownerId: childOwnerId,
          extra,
        });
        if (!cleanup.released) {
          console.warn(
            `[invoke ${project.slug}/${role}] merge-resolver cleanup did not release owner ${childOwnerId}` +
              (cleanup.releaseError ? `: ${cleanup.releaseError}` : ''),
          );
        }
      } catch (error) {
        // Cleanup is recovery bookkeeping; never turn a child failure into a
        // route failure, and keep the original invoke result visible.
        console.warn(
          `[invoke ${project.slug}/${role}] merge-resolver cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Worker-exit back-edge for the auto-implement lane (EI-404 + EI-406): a
    // dispatched implement worker that exits WITHOUT calling improvements:resolve
    // (crash, non-zero exit, or exited 0 forgetting to resolve) is recorded on its
    // dispatch-ledger row NOW — visible in seconds instead of waiting for the 2h
    // orphan collector — and an environment-failure death (rate-limit/credential/DOA)
    // rolls its attempt counter back so a credential outage can't drain the auto pool.
    // Best-effort: bookkeeping must never fail the route. (A host RESTART kills this
    // handler too, so this can't fire then — that case is EI-403 Option B's recovery.)
    if (improvementDispatch?.dispatchId && improvementDispatch.itemId) {
      try {
        const { recordImplementWorkerExit } = await import('../../../harness/improvements/implement-worker-exit');
        await recordImplementWorkerExit({
          dispatchId: improvementDispatch.dispatchId,
          itemId: improvementDispatch.itemId,
          attempt: Number(improvementDispatch.attempt) || 1,
          exitCode: r.exitCode ?? 1,
          runtimeMs: workerRuntimeMs,
          stdout: r.output,
          stderr: r.stderr,
          // WI-2162: this route's own `timeoutMs` (resolveInvokeTimeoutMs) is what
          // SIGTERM's the child — thread it so the classifier can tell "the clock ran
          // out" (env, bounded-escalation, NOT a lane-breakage signal) from a genuine
          // crash, instead of both landing in the same charged/signal-eligible bucket.
          configuredTimeoutMs: timeoutMs,
        });
      } catch (e) {
        console.warn(`[invoke ${project.slug}] implement worker-exit back-edge failed:`, e);
      }
    }

    // Mark the tracked session ended (by ROW id — markAdvSessionEnded takes the
    // adv_sessions PK, not the native session UUID). The row stays queryable so
    // a wake during the idle window can still resume the ended process via
    // `claude --resume` (wake-executor checks pid liveness, then resumes).
    if (advSessionRowId != null) {
      try {
        // WI-38054: a timed-out worker did not choose to stop — THIS route SIGTERMs it
        // (see the configuredTimeoutMs note above), so recording 'self' claimed a
        // voluntary exit for a kill we ourselves performed.
        //
        // EI-21908787009967815: `timedOut` alone was too narrow, because it only knows
        // about kills THIS route performed. A worker killed by anyone else — a sidecar
        // restart tearing down the cgroup (the original WI-38054 scenario), a peer's
        // `processes:kill`, the OOM killer — is equally involuntary and was recorded as
        // 'self'. The runner now carries the signal Node reports on `close`, so prefer
        // that OBSERVATION and keep `timedOut` only as the fallback for the kill we
        // perform ourselves. An ordinary non-zero exit still stays 'self': a non-zero
        // code is a failed run, not a kill, and guessing otherwise is the manufactured
        // attribution migration 800 refuses to invent.
        const { endedBy, signal } = endedByForObservedExit(r.endedSignal, {
          killedByUs: r.timedOut ?? false,
          killedByUsSignal: 'SIGTERM',
        });
        await markAdvSessionEnded(advSessionRowId, r.exitCode ?? null, endedBy, { signal });
      } catch (e) {
        console.warn(`[invoke] failed to mark adv session ${advSessionRowId} as ended:`, e);
      }
    }

    // Turn-end liveness backstop (start-hive-wake P-009 / D-002): the Queen's
    // turn just ended — if the hive is started and she left NO wake armed, arm
    // the fallback sleep (never an immediate re-invoke, D-004). Fire-and-forget
    // off the response path; the module is fail-soft by contract.
    if (isHiveLaunch) {
      void trackDetached(import('../../../pot/watchdog'))
        .then(({ potTurnEndCheck }) =>
          potTurnEndCheck({ workspaceId: activeWorkspaceId(), installSlug: project.slug }),
        )
        .then((res) => {
          if (res.outcome === 'armed' || res.outcome === 'staged') {
            console.warn(`[invoke ${project.slug}] hive watchdog ${res.outcome} a fallback wake: ${res.reason}`);
          }
        })
        .catch(() => {});
    }
    // overwatch-role-2026-06-15 B-04/B-09 (D-018): the overwatch's turn just ended —
    // if it left no next wake armed, B-09's watchdog arms a fallback SLEEP (never an
    // immediate re-invoke — a broken-prompt overwatch must fail toward "sleeps too
    // long"). Fire-and-forget off the response path; the module is fail-soft.
    if (isOverwatchLaunch) {
      void trackDetached(import('../../../overwatch/watchdog'))
        .then(({ overwatchTurnEndCheck }) =>
          overwatchTurnEndCheck({ workspaceId: activeWorkspaceId(), installSlug: project.slug }),
        )
        .then((res) => {
          if (res.outcome === 'armed') {
            console.warn(`[invoke ${project.slug}] overwatch watchdog armed a fallback wake: ${res.reason}`);
          }
        })
        .catch(() => {});
      // hive-loop-supervision 2026-06-21 (su-f76c85): the SYMMETRIC backstop for the
      // every-wake scorecard. If the overwatch's turn ended without emitting its
      // pot-coordination-health scorecard, synthesize + file a baseline floor from the
      // system-health brief so the monitor is never silent (the agent skip stays visible
      // — the floor is excluded from the agent-emission freshness detector). Fail-soft.
      void trackDetached(import('../../../overwatch/scorecard-backstop'))
        .then(({ overwatchScorecardEndCheck }) =>
          overwatchScorecardEndCheck({ workspaceId: activeWorkspaceId(), installSlug: project.slug }),
        )
        .then((res) => {
          if (res.outcome === 'synthesized') {
            console.warn(`[invoke ${project.slug}] overwatch scorecard backstop synthesized a floor: ${res.reason}`);
          }
        })
        .catch(() => {});
    }
    const agentOutput = r.output; // spawnInvokeOnce already strips the [timestamp] log lines
    const decisionLine = (agentOutput.split('\n')[0] ?? '').trim();
    const timedOut = r.timedOut ?? false;
    const ok = r.exitCode === 0 && !timedOut;
    let actionsResult: { count: number; results: any[] } | null = null;
    if (ok) {
      try {
        actionsResult = await dispatchActionsBlockFromOutput(project.slug, project.path, agentOutput);
      } catch (e) {
         
        console.warn(`[invoke ${project.slug}/${role}] actions dispatch failed:`, e);
      }
    }
    return Response.json({
      ok,
      slug: project.slug,
      role,
      decisionLine,
      agentOutput,
      stdout: agentOutput,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut,
      rawStdoutTail: r.rawStdoutTail,
      actions: actionsResult,
    });
  },
});

const resume = defineTool({
  method: 'POST',
  path: '/harness/:slug/resume',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    try { await unlink(join(harnessDir(project), 'escalation.md')); } catch { /* ignore */ }
    const result = await launchRun(project);
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ ok: true, logPath: result.logPath });
  },
});

export default [launch, invoke, resume];

// Exported for unit tests (pure helpers; the spawn path is live-exercised).
export const __test = { resolveInvokeTimeoutMs, extractKickoff, extractSpawnRecordId };
