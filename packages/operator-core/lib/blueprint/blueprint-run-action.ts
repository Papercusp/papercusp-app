/**
 * The `system:blueprint-run` routine action (harness-blueprint-orchestration-2026-06-03
 * P-021 / D-018).
 *
 * A blueprint declares `triggers.schedule: [{ cron, action }]` defaults; `harness:create`
 * materializes each into a `harness_shared.routines` row whose `target_role` is the action
 * (default `system:blueprint-run` — see `materialize-triggers.ts`). The shipped DBOS
 * `routinesTick` dispatches a due `system:<action>` routine to the registered handler
 * INLINE as one durable step (`system-actions.ts`) — NOT through a `pending_events`
 * consumer (that hop is retired, `git-sync-auto-commit` D-006). This module registers that
 * handler. Blueprint ⟂ scheduler: one seam onto the existing engine, no second scheduler.
 *
 * The handler is blueprint-aware: it resolves the harness's effective blueprint and acts
 * per the routine's `payload_template.mode`:
 *
 *   - `'run'` (default) — fires the blueprint's declared decider role (`spine.decider`) for
 *     the harness via the invoke route. This "starts a blueprint run": the decider wakes,
 *     `deriveNext` drives the next pipeline action. Same autonomous launch the
 *     routines-workflow role-routine branch uses; fire-and-forget. Touches no work-item
 *     table, so it is independent of P-020. Replaying the durable step just re-fires the
 *     decider (idempotent in effect — the decider is fired on a cadence anyway).
 *
 *   - `'work-item'` — admits a canonical work-item of the blueprint's declared kind.
 *     A per-fire receipt reserves its identity and accepted input before the item is
 *     created, so retrying a DBOS fire or an explicit-id call reuses the same item.
 *
 * Runs as ONE durable step (the `system-actions.ts` contract), so it must be safe to re-run
 * from the top — both modes are (see the per-mode notes above).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import {
  loadBuiltinBlueprint,
  isProgramSpine,
  blueprintRetirement,
  describeBlueprintRetirement,
  type Blueprint,
} from '@papercusp/orchestrator/blueprint';
import { resolveProjectDir } from '../spawn-config';
import { loopbackFetch } from '../loopback-fetch';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from '../harness/routines/system-actions';
import { checkFireGate, recordFire } from '../autoloop';
import { getEffectiveBlueprint } from './project-to-pg';
import { resolveLaunchBlueprint, buildLaunchSpawnRequest } from './launch-blueprint';
import { operatorApiBase } from '../operator-api-base';
import { readHarnessRegistryFor } from '../device-harnesses';
import { isReservedHarnesslessRoutineHost } from '../harness/routines/routine-host';
import '../coord-ops/index'; // register coord ops (program-mode spine steps)
import '../blueprint-steps/index'; // register deterministic step-ops (P-010)
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner';
import { buildCoordOpCtx } from '../coord-ops/prod-caps';
import { registerHarnessOpProxies } from '../harness-ops/proxy';
import { HarnessEndpointUnavailableError } from '../harness-ops/transport';
import { runWithWorkspace } from '../workspace-als';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveWorkItemPot } from '../pot-membership';
import { isDeprecatedWorkItemKind } from '../work-items';
import { acceptScheduledBlueprintWorkItem } from './operation-admission';

const operatorBase = operatorApiBase;

// ── EI-1575: self-heal orphaned routines for deleted harnesses/hives ──────────
// A per-install routine left armed after its harness/hive is deleted fires
// forever — each tick queues a durable blueprint launch whose
// `/api/harness/<slug>/invoke` 404s, so it can never succeed. Rather than rely
// on every deletion path remembering to disarm (and leaving already-orphaned
// rows firing), the firing seam itself disarms when it detects the target is
// gone.

type InstallGoneFn = (workspaceId: string, installSlug: string) => Promise<boolean>;
type DisarmRoutinesFn = (workspaceId: string, installSlug: string) => Promise<number>;
let _installGone: InstallGoneFn | null = null;
let _disarmRoutines: DisarmRoutinesFn | null = null;

/** Test seam (EI-1575): override the orphaned-install existence check + disarm. */
export function setOrphanRoutineSeams(seams: {
  installGone?: InstallGoneFn | null;
  disarm?: DisarmRoutinesFn | null;
}): void {
  if ('installGone' in seams) _installGone = seams.installGone ?? null;
  if ('disarm' in seams) _disarmRoutines = seams.disarm ?? null;
}

/**
 * True when `installSlug` names a harness/hive that no longer exists in the
 * workspace registry, so its routines are orphaned and should be disarmed.
 * Deliberately conservative — it returns false (NOT gone) when:
 *   - the slug is a reserved `@`-prefixed harness-LESS host (e.g. the
 *     `@singleton` learning-loop routines, which legitimately have no harness), or
 *   - the slug is the workspace sentinel itself (workspace-scoped hive/learning
 *     routines use this harness-less install host), or
 *   - the registry reads back empty (a transient unreadable registry must never
 *     be mistaken for "every harness was deleted" → mass-disarm).
 */
async function installIsGone(workspaceId: string, installSlug: string): Promise<boolean> {
  if (isReservedHarnesslessRoutineHost(installSlug, workspaceId)) return false;
  try {
    const projects = await readHarnessRegistryFor(workspaceId);
    if (projects.length === 0) return false; // registry empty/unreadable — don't risk a false disarm
    return !projects.some((p) => p.slug === installSlug);
  } catch {
    // A transient registry-read failure must never be read as "gone" (→ disarm)
    // nor crash the routine step. Treat as not-gone; the next fire re-checks.
    return false;
  }
}

/** Disarm (deactivate) every active routine of a gone install. Returns the count. */
async function disarmInstallRoutines(workspaceId: string, installSlug: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET active = false, next_fire_at = NULL, updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND active = true
    RETURNING id
  `;
  return rows.length;
}

/**
 * The decider-fire seam — injectable so tests capture the dispatch without a real HTTP
 * call (the codebase's `setPipelineInvokeRunner` pattern). Default = the invoke route.
 */
export type DeciderFireFn = (input: {
  installSlug: string;
  workspaceId: string;
  role: string;
  kickoff: string;
}) => void | Promise<void>;

let _fire: DeciderFireFn | null = null;
/** Override the decider-fire fn (tests). Pass `null` to restore the default invoke fire. */
export function setBlueprintRunFire(fn: DeciderFireFn | null): void {
  _fire = fn;
}

const defaultFire: DeciderFireFn = ({ installSlug, workspaceId, role, kickoff }) => {
  // Validate role name — reject invalid characters before sending the request (EI-212).
  // The invoke route validates with /^[A-Za-z0-9_-]+$/, so ensure it matches.
  if (!/^[A-Za-z0-9_-]+$/.test(role)) {
    const detail = `invalid role name '${role}' — allowed: [A-Za-z0-9_-]`;
    console.warn(`[blueprint-run] decider fire skipped (${installSlug}/${role}): ${detail}`);
    void recordFire(installSlug, role, `error: ${detail}`, 'error').catch(() => {});
    return;
  }
  const ws = encodeURIComponent(workspaceId);
  const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}`;
  // Fire-and-forget: the invoke route runs the agent to completion (up to its timeout); a
  // scheduled run must NOT block the durable step on the whole agent lifetime — the next
  // due tick re-fires (the routine cadence model). Mirrors routines-workflow.ts's
  // role-routine branch + the git-sync merge-resolver dispatch.
  //
  // P-009 (D-009): the dispatch + its eventual settle are recorded into
  // harness_shared.autoloop_state, so consecutive_errors feeds the fire gate —
  // a repeatedly-failing decider backs off instead of re-firing at full cadence.
  void recordFire(installSlug, role, 'firing', 'attempt').catch(() => {});
  // The queen-memory-hybrid L2 warm-wake attempt (pot/mug-warm-session) was RETIRED
  // with the Mug tier — retire-mug-kettle-su-only-2026-08-09 P-059. It only ever acted
  // for role 'mug'/'brain', which the retired tier no longer spawns, and its documented
  // fall-through was this exact cold spawn, so the surviving path is unchanged.
  void coldFire();
  return;

  function coldFire(): void {
  void loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kickoff }),
  })
    .then(
      async (r) => {
        if (r.ok) return recordFire(installSlug, role, 'ok', 'ok');
        // EI-212: keep a snippet of the error body — a bare "HTTP 400" left the
        // root cause unidentifiable (the gym E2E chased it for a day).
        const body = await r
          .text()
          .then((t) => t.replace(/\s+/g, ' ').slice(0, 160))
          .catch(() => '');
        return recordFire(
          installSlug,
          role,
          `error: HTTP ${r.status}${body ? ` — ${body}` : ''}`,
          'error',
        );
      },
      (e) => {
        const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
        console.warn(`[blueprint-run] decider fire failed (${installSlug}/${role}): ${detail}`);
        return recordFire(installSlug, role, `error: ${detail}`, 'error');
      },
    )
    .catch(() => {});
  } // end coldFire (queen-memory-hybrid L2 warm-branch wrapper)
};

/** Lazily-loaded built-in fallback blueprint — used when a harness has no blueprint of its own.
 *  Owner-directed 2026-07-20 (EI-18177667809538623 follow-up): repointed from the RETIRED
 *  `coding-factory` (director→…→curator spine, retired 2026-06-24) to the LIVE `coding-solo`
 *  (single-agent, decider `worker`, kind `feature`), so a blueprint-less harness never silently
 *  runs dead legacy code. `coding-solo` is the live single-worker coding model — the same target
 *  the gym substrate now uses (gym/autoloop-cycle.ts). A harness that genuinely needs the full
 *  multi-role coding spine must declare its own `.papercusp/blueprint.yaml`, not lean on this
 *  default. (Repointed — not removed — because live harnesses with no blueprint, e.g. `papercup`,
 *  still resolve through here; a hard removal would halt their dispatch.) */
let _codingFallback: Blueprint | null = null;
function codingFallback(): Blueprint {
  return (_codingFallback ??= loadBuiltinBlueprint('coding-solo').blueprint);
}

/**
 * The effective-blueprint resolver seam — injectable so unit tests stay hermetic (no PG /
 * registry). Default = `resolveBlueprint` (PG cache + lazy file projection).
 */
export type BlueprintResolverFn = (installSlug: string, workspaceId: string) => Promise<Blueprint | null>;
let _resolver: BlueprintResolverFn | null = null;
/** Override the blueprint resolver (tests). Pass `null` to restore the default. */
export function setBlueprintResolver(fn: BlueprintResolverFn | null): void {
  _resolver = fn;
}

/**
 * Resolve the harness's effective blueprint: PG cache first, lazily projecting the
 * git-canonical `.papercusp/blueprint.yaml` on a miss (`getEffectiveBlueprint`). Returns null
 * when neither a cache row nor a source file exists — the caller falls back to `coding`.
 * Fail-safe: any error → null (a scheduled fire never throws on resolution).
 */
async function resolveBlueprint(installSlug: string, workspaceId: string): Promise<Blueprint | null> {
  const { sql } = getOrgPg();
  let blueprintPath: string | null = null;
  try {
    const dir = await resolveProjectDir(installSlug, workspaceId);
    if (dir) {
      const f = join(dir, '.papercusp', 'blueprint.yaml');
      if (existsSync(f)) blueprintPath = f;
    }
  } catch {
    /* dir unresolved — a cache hit may still satisfy below */
  }
  try {
    return await getEffectiveBlueprint(sql, { workspaceId, harnessSlug: installSlug, blueprintPath });
  } catch (e) {
    console.warn(`[blueprint-run] effective-blueprint resolve failed (${installSlug}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Legacy mode='work-item' remains a compatibility entry point. Its accepted
 * task now uses the canonical work-item writer and a durable per-fire receipt.
 * A DBOS workflow id, or an explicit item id for a manual call, is required
 * so retrying the same fire cannot mint a sibling task.
 */
async function createWorkItem(ctx: SystemActionCtx, bp: Blueprint): Promise<void> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  const wi = (payloadTemplate?.workItem ?? {}) as Record<string, unknown>;
  const itemKind = bp.workItem.kind; // 'feature' | 'chunk' | 'task' | …
  if (isDeprecatedWorkItemKind(itemKind)) {
    console.warn(
      `[blueprint-run] ${installSlug}: workItem.kind='chunk' is deprecated; scheduled creation refused`,
    );
    return;
  }
  const explicitId = typeof wi.id === 'string' && wi.id.trim() ? wi.id.trim() : null;
  const requestKey = ctx.workflowId ?? (explicitId ? `explicit-id:${explicitId}` : null);
  if (!requestKey) {
    throw new Error('blueprint scheduled work-item requires a stable workflowId or explicit item id');
  }
  const title =
    typeof wi.title === 'string' && wi.title.trim() ? wi.title.trim() : `Scheduled work item (${installSlug})`;
  const summary = typeof wi.summary === 'string' ? wi.summary : undefined;
  const payload = wi.payload && typeof wi.payload === 'object' && !Array.isArray(wi.payload)
    ? wi.payload as Record<string, unknown> : undefined;

  // pot-membership-enforcement-2026-07-20 (P-005/P-006): a scheduled work-item must
  // belong to a REAL Pot. A workspace-global routine host (`@singleton`) or any non-pot
  // installSlug homes to the workspace platform Pot; a real Pot slug is unchanged.
  // Defensive: this is a durable step (never-throw contract) + the enforcement is
  // flag-gated, so a resolver miss keeps installSlug rather than failing the step (the
  // P-006 DB trigger is the hard backstop for a genuine non-pot write).
  let potSlug = installSlug;
  if (await getFlag(FLAGS.POT_MEMBERSHIP_ENFORCEMENT, 'system')) {
    try {
      const resolved = await resolveWorkItemPot({ rawSlug: installSlug, workspaceId });
      if (resolved) potSlug = resolved;
    } catch (e) {
      console.warn(`[blueprint-run] ${installSlug}: pot-membership resolve skipped: ${e instanceof Error ? e.message : e}`);
    }
  }

  const { sql } = getOrgPg();
  const item = await acceptScheduledBlueprintWorkItem(sql, {
    workspaceId, installSlug, targetHarnessSlug: potSlug, callerId: 'system:blueprint-run',
    requestKey, allowDefinitionDrift: Boolean(ctx.workflowId), blueprint: bp,
    title, summary, payload, ...(explicitId ? { explicitId } : {}),
  });
  console.log(`[blueprint-run] ${installSlug}: accepted scheduled work-item ${item.id} (item_kind=${itemKind})`);
}

/**
 * Run a PROGRAM-mode blueprint (a migrated deterministic / hybrid learning loop —
 * deterministic-blueprints-migration-2026-06-13 P-011) inline as this durable
 * step, via the pure `runProgramCore` + `inlineRunOp`. Behavior-neutral with the
 * bespoke loops, which also ran inline in their `system:<loop>` step (D-004): the
 * whole steps+gate program runs to completion in one step; a crash replays it
 * (the loops are idempotent / cadence-recovered). A HYBRID loop's agent step
 * (`orchestrator:spawn-roles`) still routes through `coordSpawnRunner` →
 * `spawnInvokeOnce`, THE governed launch chokepoint (D-005) — so blueprint-izing
 * closes the eval-battery second-spawn-path seam for free.
 *
 * `inlineRunOp` runs each op directly (no nested `DBOS.runStep`) — required,
 * since the system action IS already one DBOS step (nested steps are illegal).
 * Never throws: a program failure logs + returns (the durable-step contract).
 */
// WI-1087: a harness-provided cadence op whose sidecar has no dispatch endpoint
// (e.g. `oddsmith-prospector` when the oddsmith sidecar isn't deployed on this host)
// is WITHHELD, not FAILED — but the cadence fires every tick, so debounce the withhold
// log to stay "visibly gated" without spamming the journal every ~10 min.
const WITHHOLD_LOG_WINDOW_MS = 30 * 60_000;
const lastEndpointWithholdLogAt = new Map<string, number>();
function shouldLogEndpointWithhold(key: string): boolean {
  const now = Date.now();
  const prev = lastEndpointWithholdLogAt.get(key) ?? 0;
  if (now - prev < WITHHOLD_LOG_WINDOW_MS) return false;
  lastEndpointWithholdLogAt.set(key, now);
  return true;
}

async function runScheduledProgram(
  bp: Blueprint,
  opts: { installSlug: string; workspaceId: string; payload?: Record<string, unknown> | null },
): Promise<void> {
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
  const ctx = buildCoordOpCtx({
    identity: { ownerId: 'system:blueprint-run', ownerLabel: 'blueprint-run' },
    workspaceId: opts.workspaceId,
    harnessSlug: opts.installSlug,
    depth: 0,
  });
  // P-002 (runtime guarantee): register a PROXY CoordOp for each harness-provided
  // op THIS program declares, right before the spine runs — so `inlineRunOp`'s
  // `requireCoordOp` resolves a harness op regardless of which path resolved the
  // blueprint (launch blueprint or the harness's own effective blueprint), and
  // independent of whether admission ran in this (possibly freshly-restarted)
  // process. Idempotent + default-inert.
  registerHarnessOpProxies((bp.ops ?? []) as Parameters<typeof registerHarnessOpProxies>[0]);
  try {
    // Run the program inside its install's WORKSPACE ALS scope (scout-gateway-egress-scope,
    // 2026-06-30). The PG-backed flag-override store keys reads on `activeWorkspaceId()`
    // (flag-bus.ts), so an op that evaluates a flag — e.g. Scout's in-process ideator path
    // checking INFERENCE_GATEWAY to point PAPERCUSP_ANTHROPIC_URL at the localhost pool —
    // would otherwise read the 'default' workspace (no override row) instead of this
    // routine's workspace, resolve the flag OFF, and egress LLM calls DIRECT to
    // api.anthropic.com on one rate-limited account → 180s ideator timeouts / 0 ideas. The
    // routine fires with opts.workspaceId; making it the active ALS scope is what lets every
    // op (scout/neologism/regret/…) see the per-workspace overrides + gateway routing.
    const outcome = await runWithWorkspace(opts.workspaceId, () =>
      runProgramCore({ blueprint: bp, payload, ctx, runOp: inlineRunOp }),
    );
    console.log(
      `[blueprint-run] ${opts.installSlug}: ran program '${bp.id}' → ${outcome.outcome} (resolved=${outcome.resolved})`,
    );
  } catch (e) {
    // WI-1087: a harness-provided cadence op (e.g. oddsmith-prospector) dispatched to a
    // harness whose sidecar has no registered endpoint is NOT a program failure — the
    // sidecar may register later and the cadence re-fires. WITHHOLD it (visibly gated,
    // debounced) instead of a per-tick FAILED that spams the journal. (Typed-error keyed;
    // message fallback in case a wrapper strips the class.)
    const endpointUnavailable =
      e instanceof HarnessEndpointUnavailableError ||
      (e instanceof Error && e.message.includes('has no dispatch endpoint registered'));
    if (endpointUnavailable) {
      if (shouldLogEndpointWithhold(`${opts.installSlug}:${bp.id}`)) {
        console.warn(
          `[blueprint-run] ${opts.installSlug}: program '${bp.id}' WITHHELD — ${e instanceof Error ? e.message : e} ` +
            `(will run when the sidecar registers; suppressing repeats ~30m)`,
        );
      }
    } else {
      console.warn(
        `[blueprint-run] ${opts.installSlug}: program '${bp.id}' FAILED: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

export function programPayloadFromTemplate(payloadTemplate: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!payloadTemplate || typeof payloadTemplate !== 'object') return null;
  const {
    blueprintId: _blueprintId,
    mode: _mode,
    kickoff: _kickoff,
    timeoutMs: _timeoutMs,
    launchInstallSlug: _launchInstallSlug,
    potSlug: _potSlug,
    hiveInstallSlug: _hiveInstallSlug,
    targetInstallSlug: _targetInstallSlug,
    workItem: _workItem,
    payload,
    ...topLevel
  } = payloadTemplate;
  const nested = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  return { ...topLevel, ...nested };
}

function payloadString(payloadTemplate: Record<string, unknown> | null | undefined, key: string): string | null {
  const raw = payloadTemplate?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function launchInstallSlugFromPayload(
  payloadTemplate: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  return (
    payloadString(payloadTemplate, 'launchInstallSlug') ??
    payloadString(payloadTemplate, 'potSlug') ??
    payloadString(payloadTemplate, 'hiveInstallSlug') ??
    payloadString(payloadTemplate, 'targetInstallSlug') ??
    fallback
  );
}

/** The registered `system:blueprint-run` handler. */
export async function handleBlueprintRun(ctx: SystemActionCtx): Promise<void | SystemActionResult> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;

  // EI-1575: stop firing for a DELETED harness/hive. Each tick of an orphaned
  // routine queues a durable blueprint launch (e.g. the 'coding' queen) whose
  // `/api/harness/<slug>/invoke` 404s — a perpetual, useless 404 + DBOS churn.
  // When the target install is gone from the registry, disarm ALL of its
  // routines and stop. This self-heals already-orphaned rows on their next
  // fire, independent of which deletion path missed the cleanup. (Reserved
  // `@singleton` hosts + an empty/unreadable registry are never "gone" — see
  // installIsGone.)
  const installGone = _installGone ?? installIsGone;
  if (await installGone(workspaceId, installSlug)) {
    const disarm = _disarmRoutines ?? disarmInstallRoutines;
    const n = await disarm(workspaceId, installSlug);
    console.warn(
      `[blueprint-run] ${installSlug}: target harness/hive is gone — disarmed ${n} orphaned routine(s); will not re-fire (EI-1575)`,
    );
    return;
  }

  // unify-agent-launches-as-blueprints D-002: a routine may name a STANDALONE
  // launch blueprint to fire (e.g. the `scan` cadence routine seeds
  // `{ blueprintId: 'scan' }`). The launch becomes declarative — the role + model
  // resolve from the named blueprint via the launch-blueprint primitive, not a
  // hardcoded invoke-caller. (Omitting `blueprintId` keeps the original behavior:
  // fire the HARNESS's own effective blueprint decider — the harness:create
  // `triggers.schedule` materialization path.)
  const launchId = typeof payloadTemplate?.blueprintId === 'string' ? payloadTemplate.blueprintId.trim() : '';
  if (launchId) {
    // A PROGRAM-mode launch (a migrated deterministic / hybrid loop, e.g.
    // `{ blueprintId: 'negative-space' }`) has no single decider to fire — run its
    // steps+gate program inline instead of `fireLaunchBlueprint` (P-011). Resolve
    // through the same seam fireLaunchBlueprint uses; a resolve failure falls
    // through to the launch path (which logs its own error).
    let launchBp: Blueprint | null = null;
    try {
      launchBp = await resolveLaunchBlueprint(launchId);
    } catch (e) {
      console.warn(`[blueprint-run] ${installSlug}: could not resolve launch blueprint '${launchId}': ${e instanceof Error ? e.message : e}`);
    }
    if (launchBp && isProgramSpine(launchBp.spine)) {
      await runScheduledProgram(launchBp, {
        installSlug,
        workspaceId,
        payload: programPayloadFromTemplate(payloadTemplate),
      });
      return;
    }
    const kickoff =
      typeof payloadTemplate?.kickoff === 'string' && payloadTemplate.kickoff.trim()
        ? payloadTemplate.kickoff
        : `Scheduled launch of blueprint '${launchId}' for '${installSlug}'.`;
    // A scheduled launch may need far more than the invoke route's 90s default —
    // a workspace `scan` runs many turns (P-009 smoke: 300s SIGTERMed a real scan
    // with zero output). The routine's payload_template carries the budget,
    // forwarded as the route's `timeoutMs`.
    const timeoutMs = Number(payloadTemplate?.timeoutMs);
    // EI-995: fire via the EI-403-A durableSpawns SEAM, NOT `fireLaunchBlueprint`
    // inline. This handler runs as ONE DBOS step; firing inline → durableSpawnFire
    // hits "startWorkflow from within a step" → falls back to a fire-and-forget that
    // AWAITS the worker run, which the step does NOT keep alive → the autonomous Queen
    // (and Overwatch) returned in ~80ms, orphaned, placing nothing (the live :3070
    // no-op). Returning the request lets the routine workflow start it DURABLY after
    // the step, where startWorkflow is legal (system-actions.ts → startDurableSpawns).
    // The handler is a checkpointed step, so this per-fire key is stable on replay.
    const launchInstallSlug = launchInstallSlugFromPayload(payloadTemplate, installSlug);
    const idempotencyKey = `blueprint-run:${launchInstallSlug}:${launchId}:${Date.now()}`;
    const durableSpawn = await buildLaunchSpawnRequest(
      launchId,
      {
        installSlug: launchInstallSlug,
        workspaceId,
        kickoff,
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      },
      idempotencyKey,
    );
    console.log(
      `[blueprint-run] ${installSlug}: queued durable launch '${launchId}' for '${launchInstallSlug}' (role ${durableSpawn.spawnRecord?.childRole ?? '?'})`,
    );
    return { durableSpawns: [durableSpawn] };
  }

  const resolve = _resolver ?? resolveBlueprint;
  const resolved = await resolve(installSlug, workspaceId);
  const bp = resolved ?? codingFallback();
  // WI-5645 (no-retirement-launch-guard): LOUD WARNING, not a block, when this fire
  // is about to run against a retired blueprint (itself or via `extends` — e.g. the
  // EI-18177667809538623 external-bench ⟶ coding-factory shape). Deliberately NOT
  // refused here: `codingFallback()` is the default for every blueprint-less harness
  // (blueprint-run-action.test.ts pins that it still fires), so a hard block at this
  // chokepoint risks silently halting their dispatch. The orchestrator-loop.ts dispatch
  // gate + the gym autoloop tick (this WI's other two chokepoints) DO hard-block; this
  // one only makes the fallback's retirement visible.
  //
  // ⚠ TWO CORRECTIONS, measured 2026-08-16 (WI-39505):
  //  1. `codingFallback()` is NOT `coding-factory` and NOT behavior-preserving — it has
  //     been the SINGLE-AGENT `coding-solo` (decider `worker`) since 2026-07-20
  //     (33d1bac9f4, owner-directed; see its docstring at the definition above).
  //  2. The affected set is no longer "unknown, possibly large". Measured across all 8
  //     workspaces: 44 of 107 registered projects have a live path and no
  //     `.papercusp/blueprint.yaml` (37 are papercusp monorepo sub-lib registrations;
  //     the 7 real ones include `papercusp` itself). It is nonetheless INERT on every
  //     scheduled path today: all 37 `system:blueprint-run` routines carry an explicit
  //     `payload_template.blueprintId` and take the early return above, so this line is
  //     unreached by them. Re-measure before citing — that early-return share is exactly
  //     what makes this safe, and one routine registered without a `blueprintId` changes it.
  const retirement = blueprintRetirement(bp);
  if (retirement) {
    console.warn(
      `[blueprint-run] ${installSlug}: firing decider against a RETIRED blueprint — ` +
        `${describeBlueprintRetirement(retirement, bp.id)}` +
        (resolved ? '' : ' (via the no-blueprint codingFallback() default)'),
    );
  }
  const mode = typeof payloadTemplate?.mode === 'string' ? payloadTemplate.mode : 'run';

  if (mode === 'work-item') {
    await createWorkItem(ctx, bp);
    return;
  }
  // A harness whose OWN effective blueprint is program-mode (a deterministic /
  // hybrid loop) runs its program inline rather than firing a decider (P-011).
  if (isProgramSpine(bp.spine)) {
    await runScheduledProgram(bp, {
      installSlug,
      workspaceId,
      payload: programPayloadFromTemplate(payloadTemplate),
    });
    return;
  }
  // mode === 'run' (default): start a blueprint run by firing the declared decider.
  const role = bp.spine.decider;
  // P-009 (D-009): the error-backoff fire gate — a decider with accumulating
  // consecutive_errors is re-fired on an exponential backoff (circuit-open past
  // the threshold ⇒ ~one probe per cap window), not at full cadence.
  const gate = await checkFireGate(installSlug, role);
  if (!gate.allow) {
    console.warn(
      `[blueprint-run] ${installSlug}: decider '${role}' fire WITHHELD (${gate.reason}, ` +
        `consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`,
    );
    return;
  }
  const fire = _fire ?? defaultFire;
  await fire({
    installSlug,
    workspaceId,
    role,
    kickoff: `Scheduled blueprint run for '${installSlug}' (decider ${role}).`,
  });
  console.log(`[blueprint-run] ${installSlug}: fired decider '${role}' (scheduled blueprint run)`);
}

// `scheduling: 'on-demand'` (EI-18752496371939475): one row per BLUEPRINT run schedule,
// materialized when a blueprint is armed — not a standing workspace-wide row to seed.
registerSystemAction('blueprint-run', handleBlueprintRun, { scheduling: 'on-demand' });
