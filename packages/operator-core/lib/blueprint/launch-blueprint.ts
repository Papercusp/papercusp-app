/**
 * The launch-blueprint primitive — unify-agent-launches-as-blueprints-2026-06-04
 * (P0 / D-002 / D-007).
 *
 * THE unification seam. Before this plan every repeatable agent launch was a
 * hand-wired invoke-caller that hardcoded a role string into
 * `loopbackFetch(/invoke?role=<string>)` (git-sync's merge-resolver, the release
 * routine, the self-improvement implementer) or `spawnInvokeOnce(<string>)` (the
 * auditor lane). This module replaces that with ONE declarative primitive: a
 * **launch blueprint** declares its role (`spine.decider`) + its trigger, and a
 * caller fires it by id (or by event key) — the role + model come from the
 * blueprint, not a literal. The `/invoke?role=` route stays as the low-level spawn
 * mechanism the primitive uses (D-002); only the *caller* becomes declarative.
 *
 * Two kinds of trigger-able built-in blueprint coexist:
 *   - **launch blueprints** (this module) — single-role, fired through the invoke
 *     route by `fireLaunchBlueprint` (deploy / scan / implement / merge-resolution /
 *     audit). The degenerate "one role, one trigger" case (D-007).
 *   - **program blueprints** (`coord-ops/trigger.ts`) — coord-op `steps` + `gate`
 *     programs fired by `startCoordProgramForEvent` (vote / deliberate).
 *
 * Pure resolution (`resolveLaunchTarget*`) is separated from the side-effecting
 * fire so a caller that needs to OBSERVE the dispatch result (git-sync records the
 * resolver's HTTP status / exit code) resolves the target here but keeps its own
 * fire+observe loop, while the simple fire-and-forget callers use
 * `fireLaunchBlueprint`.
 */
import { randomUUID } from 'node:crypto';
import {
  loadBuiltinBlueprint,
  loadBlueprintFromFile,
  assertNotNestedHive,
  assertBlueprintLaunchEligible,
  type Blueprint,
  type ResolveExtendsPath,
} from '@papercusp/orchestrator/blueprint';
import { getOrgPg } from '@papercusp/db-org';
import { operatorResolveExtends } from './installed-blueprints';
import { loopbackFetch, describeFetchError } from '../loopback-fetch';
import { dbosOrchestratorActive } from '../dbos/dbos-flags';
import { operatorApiBase } from '../operator-api-base';
import { recordSpawn, finishSpawn } from '../fleet/spawn-tree';
import { agentProducedTurn } from '../fleet/invoke-outcome';
import {
  isReleaseFixerNoTurnFailure,
  isRetryableReleaseFixerNoTurnFailure,
  recordReleaseFixerNoTurnEscalation,
} from '../release/fixer-liveness';
import { heartbeatSpawns, recordSpawnPid, SPAWN_HEARTBEAT_INTERVAL_MS } from '../fleet/spawn-reclaim';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { DurableSpawnFireInput } from '../dbos/durable-spawn';
import type { Db } from '../fleet/pg-stores';

// The invoke route is a Hono API route on the operator's API port — derive the base from
// the shared helper (operator-api-base.ts), never the stale `:3055` Vite SPA default.
const operatorBase = operatorApiBase;
/** Bounded stderr captured from the invoke response into `spawned_agents.output_tail`. */
const INVOKE_OUTPUT_TAIL_LIMIT = 2_000;
/** The fallback retries one unclassified release-fixer launcher death, never more. */
const RELEASE_FIXER_FALLBACK_RETRY_LIMIT = 1;

/**
 * The built-in SINGLE-ROLE launch blueprints (vs the program-mode vote/deliberate,
 * which `coord-ops/trigger.ts` owns). Each declares one role in `spine.decider` +
 * a trigger (`triggers.schedule` for cadence launches, `triggers.event` for
 * event-driven ones). Firing one invokes that role once via the invoke route.
 */
export const BUILTIN_LAUNCH_BLUEPRINTS = [
  'deploy',
  'scan',
  'implement',
  'merge-resolution',
  'doc-steward',
  'release-fix',
  'content-fix',
  'audit',
  'coding',
  'cup',
  'papercup',
] as const;
export type LaunchBlueprintId = (typeof BUILTIN_LAUNCH_BLUEPRINTS)[number];

/** A Queen turn is a supervisor/control-loop turn, not a short route smoke.
 * Cold boot + a deep frontier can legitimately spend several minutes surveying
 * before the Queen emits its final decision line; a 5m deadline killed those runs
 * mid-turn and left the autonomous loop with zero placements. Keep a finite DBOS
 * deadline for wedged model routes, but match the normal full-turn budget rather
 * than the old smoke-test budget. */
export const QUEEN_INVOKE_TIMEOUT_MS = 900_000;

/**
 * The blueprint-resolver seam — default loads the built-in by id. The operator can
 * override (a PG-cache / Cupboard-installed / forked launch blueprint) the same way
 * the coord-program workflow's resolver is overridable. Pass `null` to restore.
 */
export type LaunchResolverFn = (blueprintId: string) => Blueprint | Promise<Blueprint>;
// DEFAULT resolver is installed-aware (D-007/WI-1146): installed (`~/.papercusp/blueprints`)
// → built-in. `installedAwareLaunchResolver` is a hoisted function declaration so it can be
// referenced here. Lives in THIS module (not wired externally) so `resolveLaunchBlueprint`
// uses it directly — avoiding the ESM dual-instance trap where an external
// `setLaunchBlueprintResolver` set a different module copy's `_resolver`.
const builtinResolver: LaunchResolverFn = installedAwareLaunchResolver();
let _resolver: LaunchResolverFn = builtinResolver;
export function setLaunchBlueprintResolver(fn: LaunchResolverFn | null): void {
  _resolver = fn ?? builtinResolver;
}

/**
 * A launch resolver that spans the operator's distribution tiers — installed
 * (`~/.papercusp/blueprints`) → built-in — the SAME resolution `blueprint:validate`
 * and `blueprint:catalog` already use (`operatorResolveExtends` + `loadBlueprintFromFile`).
 *
 * Without this the DEFAULT resolver (`builtinResolver`) is built-in-ONLY, so a
 * HARNESS-provided cadence blueprint installed under the installed tier
 * (e.g. `oddsmith-prospector`) fired by a `system:blueprint-run` routine throws
 * `no built-in blueprint "…"` instead of resolving — the missing integration that
 * blocked the harness-provided-cadence live-arm (harness-provided-cadence-ops-2026-06-26
 * D-007 / WI-1146). Built-in ids resolve identically (the composed resolver includes
 * the built-in tier), so this is purely additive. This IS the default resolver
 * (`builtinResolver`). `resolveFactory` is injectable for tests; it is invoked PER
 * resolve so the installed dir always reflects the current `papercuspRoot()`.
 */
export function installedAwareLaunchResolver(
  resolveFactory: () => ResolveExtendsPath = operatorResolveExtends,
): LaunchResolverFn {
  return (id) => {
    const resolve = resolveFactory();
    const file = resolve(id);
    if (file) return loadBlueprintFromFile(file, resolve).blueprint;
    // Truly-unknown id: fall back to the built-in loader so the error message
    // (`no built-in blueprint "…"`) is preserved for genuinely-missing ids.
    return loadBuiltinBlueprint(id).blueprint;
  };
}

/** Build the invoke-route URL for a role launch. */
function invokeUrl(
  installSlug: string,
  role: string,
  workspaceId: string,
  bpkind?: 'hive' | 'pot' | 'harness',
): string {
  const ws = encodeURIComponent(workspaceId);
  // `bpkind=hive` tells the invoke route this launch is a kind:'hive' blueprint.
  // pot-rename dual-accept: a kind:'pot' blueprint ALSO sends bpkind=hive — it
  // provisions a harness_kind:'hive' home, so the launch config is identical and the
  // consumer (spawn.ts) keeps its single `bpkind === 'hive'` check unchanged.
  // (the hive/Queen) so it records a TRACKED, resumable session (D-010) — the
  // route can't resolve the blueprint itself (it only sees the install slug).
  const kind = bpkind === 'hive' || bpkind === 'pot' ? '&bpkind=hive' : '';
  return `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}${kind}`;
}

export interface LaunchTarget {
  /** The launch blueprint id resolved. */
  blueprintId: string;
  /** The role to invoke — the blueprint's `spine.decider` (single-role launch). */
  role: string;
  /** The resolved `/invoke?role=` URL. */
  url: string;
}

/**
 * WI-269: resolve a launch's workspace to a CONCRETE id before it is baked into the
 * `/invoke ?ws=` URL. A durable-spawn fire persists this URL in its DBOS workflow
 * input; if a system / cross-workspace routine built it with `ctx.workspaceId === '*'`
 * (e.g. `improvement-implement`), a post-bg-host-restart REPLAY re-POSTs `?ws=*` →
 * `workspaceContextMiddleware` rejects it (`isKnownWorkspace('*')` is false) → 400
 * `unknown_workspace` → a zombie spawn that never launches. The live fire only
 * worked because the request ALS carried the real workspace, which the persisted URL
 * does not. So resolve `*`/empty to the harness's own workspace (the spawn's true
 * target), falling back to the host pin, and REFUSE to build a URL we cannot resolve
 * — failing loud at enqueue beats a silent zombie on replay. A concrete, known
 * workspace passes through unchanged (the normal path is untouched).
 */
async function resolveConcreteLaunchWorkspace(installSlug: string, workspaceId: string): Promise<string> {
  if (workspaceId && workspaceId !== '*') return workspaceId;
  // Dynamic import: keep harness-core / workspace-registry out of launch-blueprint's
  // static boot graph; this path only runs for a `*`/empty workspace (rare).
  const { resolveWorkspaceForHarnessSlug } = await import('../harness-core');
  const { activeWorkspaceId, isKnownWorkspace } = await import('../workspace-registry');
  const resolved = (await resolveWorkspaceForHarnessSlug(installSlug)) ?? activeWorkspaceId();
  if (resolved === '*' || !isKnownWorkspace(resolved)) {
    // REFUSE (su-fa30048c consensus): a mis-resolution must surface at enqueue, never
    // as a silent replay zombie. The throw is caught by the fire loop (logged as a
    // recorded fire failure) / fails the durable step — i.e. the fire is skipped.
    throw new Error(
      `[launch] WI-269: cannot resolve a concrete workspace for harness '${installSlug}' ` +
        `(workspaceId='${workspaceId}' → '${resolved}') — refusing to build a launch URL with ` +
        `ws='${resolved}' that would 400 unknown_workspace on a durable-spawn replay.`,
    );
  }
  return resolved;
}

/**
 * Resolve a launch blueprint id → its launch target (role + invoke URL). The
 * DECLARATIVE primitive: "which role does this launch fire?" comes from the
 * blueprint's `spine.decider`, not a hardcoded literal. A caller that observes the
 * dispatch (git-sync) uses this + its own fire loop; simple callers use
 * `fireLaunchBlueprint`.
 */
export async function resolveLaunchTarget(
  blueprintId: string,
  opts: { installSlug: string; workspaceId: string },
): Promise<LaunchTarget> {
  const bp = await _resolver(blueprintId);
  // Launch eligibility belongs at this shared target-building choke point. Every
  // invoke URL (direct, event-driven, and durable-spawn) is built here, while
  // resolveLaunchBlueprint remains a read-only resolver for catalog/program
  // inspection. This prevents a retired blueprint from reaching a role-admission
  // 403 and leaves the retirement reason attached to the caller-visible error.
  assertBlueprintLaunchEligible(bp);
  const role = bp.spine.decider;
  const workspaceId = await resolveConcreteLaunchWorkspace(opts.installSlug, opts.workspaceId);
  return { blueprintId, role, url: invokeUrl(opts.installSlug, role, workspaceId, bp.kind) };
}

/**
 * Resolve a launch/program blueprint by id (the same `_resolver` seam
 * `fireLaunchBlueprint` uses). Lets a caller INSPECT the resolved blueprint —
 * e.g. `system:blueprint-run` checks `isProgramSpine(bp.spine)` to route a
 * program-mode launch (a migrated deterministic/hybrid loop) to the program
 * runner instead of a decider fire (deterministic-blueprints-migration-2026-06-13
 * P-011).
 */
export async function resolveLaunchBlueprint(blueprintId: string): Promise<Blueprint> {
  return _resolver(blueprintId);
}

/**
 * Resolve just the ROLE a launch blueprint fires (its `spine.decider`). For a
 * caller that spawns the role through a path OTHER than the invoke route — the
 * auditor lane uses `spawnInvokeOnce` (a direct subprocess), so it needs the role
 * name, not an invoke URL — making the role declarative without building a URL.
 */
export async function resolveLaunchRole(blueprintId: string): Promise<string> {
  const bp = await _resolver(blueprintId);
  // The auditor lane launches this role through a direct subprocess rather than
  // resolveLaunchTarget, so it needs the same launch/spend eligibility check.
  assertBlueprintLaunchEligible(bp);
  return bp.spine.decider;
}

// ── event-keyed launch (D-004) ──────────────────────────────────────────────

let _eventMap: Record<string, string> | null = null;
/**
 * event key → launch blueprint id, built once from the built-in launch blueprints'
 * `triggers.event` (e.g. `git-sync:conflict` → `merge-resolution`,
 * `feature:reaches-auditor-lane` → `audit`). The sibling of
 * `coordOpTriggerMap` for single-role launches.
 */
export function launchBlueprintTriggerMap(): Record<string, string> {
  if (_eventMap) return _eventMap;
  const map: Record<string, string> = {};
  for (const id of BUILTIN_LAUNCH_BLUEPRINTS) {
    try {
      const { blueprint } = loadBuiltinBlueprint(id);
      const key = blueprint.triggers?.event;
      if (key) map[key] = id;
    } catch {
      /* a missing/invalid built-in just isn't a trigger target */
    }
  }
  _eventMap = map;
  return map;
}

/** Resolve an event key to the launch blueprint id that declares it, or null. */
export function resolveLaunchTriggerEvent(eventKey: string): string | null {
  return launchBlueprintTriggerMap()[eventKey] ?? null;
}

/** Clear the memoised event map (tests / dev prompt reload). */
export function resetLaunchBlueprintTriggerMap(): void {
  _eventMap = null;
}

/**
 * Resolve an EVENT key → its launch target (role + invoke URL). The declarative
 * "what does this event launch?" — git-sync resolves `git-sync:conflict` here
 * (→ merge-resolver) instead of hardcoding the role. Returns null when no launch
 * blueprint declares the key.
 */
export async function resolveLaunchTargetForEvent(
  eventKey: string,
  opts: { installSlug: string; workspaceId: string },
): Promise<LaunchTarget | null> {
  const blueprintId = resolveLaunchTriggerEvent(eventKey);
  if (!blueprintId) return null;
  return resolveLaunchTarget(blueprintId, opts);
}

// ── fire-and-forget launch ───────────────────────────────────────────────────

export interface FireLaunchInput {
  installSlug: string;
  workspaceId: string;
  /** Human-readable kickoff (the route forwards it; agents read it as context). */
  kickoff?: string;
  /** Extra args forwarded to invoke-once (the route's `extra`). */
  extra?: string[];
  /** Per-launch timeout for the invoke route (defaults to the route's own). */
  timeoutMs?: number;
  /**
   * Extra fields merged into the /invoke POST body (NOT forwarded to the child as
   * args). The route reads these for its own bookkeeping — e.g. the auto-implement
   * lane passes `{ improvementDispatch: { dispatchId, itemId, attempt } }` so the
   * route can run the worker-exit back-edge (EI-404) when the worker exits. Generic
   * so launch-blueprint stays domain-agnostic.
   */
  bodyExtra?: Record<string, unknown>;
  /**
   * The parent/initiator context, when this launch is fired BY something with a
   * parent (a spawning agent, a recursion parent). Presence of a parent triggers
   * the no-nest guard (local-hive D-009 / swarm D-018): a `kind:'hive'` blueprint
   * fired with a parent is REJECTED — hives launch only as roots. The hive's own
   * launch (the parentless `system:blueprint-run` routine) omits this and is
   * allowed. Carries `spawnId`/`role` for lineage; either being set marks a parent.
   */
  parent?: { spawnId?: string | null; role?: string | null } | null;
}

/**
 * What the fire path knows about the spawn it produced — the correlation a caller
 * can persist (the improvement dispatch ledger records it as `spawned_run_id`).
 * `runId` is the fallback path's spawned_agents run_id, or the DBOS durable-spawn
 * idempotency key (the durable workflow id) when the launch went durable.
 */
export interface LaunchSpawnInfo {
  /** spawned_agents.spawn_id when the fire path records one. Durable fires use `durable-spawn:<runId>`. */
  spawnId: string | null;
  /** The durable correlation id for this fire (see above). */
  runId: string | null;
  /** True when the fire was enqueued as a DBOS durable workflow. */
  durable: boolean;
}

/**
 * The fire seam — injectable so tests capture the dispatch without a real HTTP call
 * (the codebase's `setPipelineInvokeRunner` pattern). Default = the invoke route.
 * Returning `LaunchSpawnInfo` is optional — a seam that returns void just yields
 * `spawn: null` on the launch result.
 */
export type LaunchFireFn = (
  input: FireLaunchInput & LaunchTarget,
) => void | LaunchSpawnInfo | Promise<void | LaunchSpawnInfo>;
let _fire: LaunchFireFn | null = null;
/** Override the launch-fire fn (tests). Pass `null` to restore the default route fire. */
export function setLaunchBlueprintFire(fn: LaunchFireFn | null): void {
  _fire = fn;
}

function isCodexLaunchModelSpec(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const id = spec.trim().toLowerCase();
  return id.startsWith('openai-codex/') || id.startsWith('chatgpt:') || /^gpt-\d/.test(id);
}

function withDefaultLaunchTimeout(input: FireLaunchInput, role: string): FireLaunchInput {
  if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) return input;
  // pot-rename dual-accept: `mug` is the additive twin of `queen` (same brain role).
  return role === 'mug' ? { ...input, timeoutMs: QUEEN_INVOKE_TIMEOUT_MS } : input;
}

/**
 * Build the /invoke POST body for a role launch — shared by the fire-and-forget
 * `defaultFire` and the build-without-firing `buildLaunchSpawnRequest` (EI-403-A),
 * so both produce a byte-identical body.
 */
function buildInvokeBody(
  blueprintId: string,
  input: { kickoff?: string; extra?: string[]; timeoutMs?: number; bodyExtra?: Record<string, unknown> },
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.kickoff) body.kickoff = input.kickoff;
  // `BLUEPRINT_ID=<id>` scopes the role's prompt resolution to
  // `blueprints/<id>/prompts/<role>.md` (invoke.ts), falling back to the global
  // `prompts/<role>.md` — so a launch blueprint can ship its own role prompt (the
  // `scan` blueprint does, to capture work-items instead of operator cards) while
  // the others inherit their global persona unchanged.
  body.extra = [`BLUEPRINT_ID=${blueprintId}`, ...(input.extra ?? [])];
  if (input.timeoutMs) body.timeoutMs = input.timeoutMs;
  // Route-only bookkeeping fields (not child args) — e.g. the implement lane's
  // improvementDispatch correlation for the worker-exit back-edge (EI-404).
  if (input.bodyExtra) Object.assign(body, input.bodyExtra);
  return body;
}

/**
 * Resolve a launch blueprint + build its /invoke fire as a DURABLE-SPAWN REQUEST,
 * WITHOUT firing it (EI-403-A). The auto-implement lane uses this from inside its
 * routine step — where `durableSpawnFire`'s `startWorkflow` is illegal — and
 * returns the request as `SystemActionResult.durableSpawns`; the routine workflow
 * starts it durably AFTER the step (`startDurableSpawns`). The caller MUST pass a
 * STABLE `idempotencyKey` (derived from durable state, not a clock) so a recovery
 * replay dedups. Mirrors `fireLaunchBlueprint`'s resolution; the parentless
 * implement launch needs no no-nest hive guard.
 */
export async function buildLaunchSpawnRequest(
  blueprintId: string,
  input: FireLaunchInput,
  idempotencyKey: string,
): Promise<DurableSpawnFireInput> {
  const target = await resolveLaunchTarget(blueprintId, input);
  const effectiveInput = withDefaultLaunchTimeout(input, target.role);
  // EI-403 round-2: the durable path otherwise records NO spawned_agents row, so the
  // implement worker ran invisibly (round 1's fire-and-forget fallback DID record it,
  // via the WI-108 fix below). Opt INTO recordSpawn so the durably-fired worker shows
  // in fleet:tree — `durableSpawnFireImpl` writes/finishes the row (stable id =
  // durable-spawn:<key>). The implement lane's itemId rides bodyExtra.improvementDispatch.
  const dispatch = (input.bodyExtra?.improvementDispatch ?? undefined) as { itemId?: string } | undefined;
  return {
    url: target.url,
    body: buildInvokeBody(target.blueprintId, effectiveInput),
    idempotencyKey,
    label: `${input.installSlug}/${target.role}`,
    spawnRecord: {
      workspaceId: input.workspaceId,
      harnessSlug: input.installSlug,
      childRole: target.role,
      parentRole: input.parent?.role ?? 'operator',
      parentSpawnId: input.parent?.spawnId ?? null,
      itemId: dispatch?.itemId ?? null,
    },
  };
}

const defaultFire = async (
  {
    url,
    role,
    installSlug,
    blueprintId,
    kickoff,
    extra,
    timeoutMs,
    workspaceId,
    parent,
    bodyExtra,
  }: FireLaunchInput & LaunchTarget,
  releaseFixerRetryCount = 0,
  allowDurable = true,
): Promise<LaunchSpawnInfo> => {
  const body = buildInvokeBody(blueprintId, { kickoff, extra, timeoutMs, bodyExtra });

  // DURABLE when DBOS is on (unify-agent-spawn-chokepoint P-010): the launch runs
  // inside a registered, step-retried DBOS workflow that survives a host crash +
  // re-fires once, instead of the historical `void loopbackFetch` that LOST the
  // agent on crash. Gated on the flag so durable-spawn.ts (it registers a DBOS
  // workflow at import) is only loaded under DBOS; `durableSpawnFire` returns false
  // when it can't durably enqueue here (e.g. called from inside another step) so we
  // fall through to fire-and-forget.
  if (allowDurable && dbosOrchestratorActive()) {
    try {
      const { durableSpawnFire } = await import('../dbos/durable-spawn');
      const idempotencyKey = `launch:${installSlug}:${blueprintId}:${role}:${Date.now()}`;
      const dispatch = (bodyExtra?.improvementDispatch ?? undefined) as { itemId?: string } | undefined;
      if (
        await durableSpawnFire({
          url,
          body,
          idempotencyKey,
          label: `${installSlug}/${role}`,
          spawnRecord: {
            workspaceId,
            harnessSlug: installSlug,
            childRole: role,
            parentRole: parent?.role ?? 'operator',
            parentSpawnId: parent?.spawnId ?? null,
            itemId: dispatch?.itemId ?? null,
          },
        })
      ) {
        // The workflow id IS the durable correlation for this fire.
        return { spawnId: `durable-spawn:${idempotencyKey}`, runId: idempotencyKey, durable: true };
      }
    } catch (e) {
      // DBOS may have committed the workflow before the enqueue response was
      // lost. A direct /invoke fallback here would create a second child.
      if (e instanceof Error && e.name === 'DurableSpawnEnqueueUncertainError') throw e;
      console.warn(
        `[launch-blueprint] durable fire unavailable (${installSlug}/${role}); falling back: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Fire-and-forget fallback (DBOS off, or durableSpawnFire declined — e.g. called
  // from inside a DBOS step). Record a durable spawned_agents row so this launch
  // appears in fleet:tree instead of being silently untracked (WI-108).
  const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runId = `launch-${Date.now()}-${randomUUID().slice(0, 6)}`;
  let pg: ReturnType<typeof getOrgPg> | null = null;
  try {
    pg = getOrgPg();
    const sql = pg.sql;
    const writeRecord = async (db: Db): Promise<void> => {
      await recordSpawn(db, {
        spawnId,
        workspaceId,
        harnessSlug: installSlug,
        // parent_role is NOT NULL in spawned_agents — a parentless system launch is
        // recorded as spawned by the operator host (matches every other root spawn).
        parentSpawnId: parent?.spawnId ?? null,
        parentRole: parent?.role ?? 'operator',
        childRole: role,
        runId,
        status: 'running',
      });
      // EI-21144257978207759: a release-fixer can be fired by the short-lived
      // green-checkpoint CLI.  Without pre-handoff provenance that CLI could exit before
      // its fire-and-forget /invoke request admitted a child, leaving a fresh-heartbeat
      // `running` row with no session, PID, output, or tools.  The serialized repair queue
      // then treated that phantom as its live owner for the full stale-heartbeat window.
      //
      // Stamp ONLY release-fix with the process that currently owns the pending request.
      // Once /invoke admits the real child it calls recordSpawnPid(..., { handoff:true }),
      // atomically replacing this PID/boot identity and changing run_id from launch-* to
      // invoke-launch-*.  Other blueprint roles retain the cross-process route-only stamp
      // introduced by EI-20981156698708733.
      if (blueprintId === 'release-fix') {
        await recordSpawnPid(db, spawnId, process.pid).catch(() => {
          /* best-effort — releaseFixerSpawnAlive also rejects a null-pickup row after
             one heartbeat cadence, so a stamp miss cannot recreate the 300s phantom. */
        });
      }
    };
    if (role === 'mug') {
      const admission = await sql.begin(
        async (
          tx,
        ): Promise<
          { admitted: true } | { admitted: false; activeSpawnId: string; activeHarnessSlug: string | null }
        > => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${'queen-singleton:' + workspaceId}))`;
          const active = await tx<{ spawn_id: string; harness_slug: string | null }[]>`
          SELECT spawn_id, harness_slug
            FROM harness_shared.spawned_agents
           WHERE workspace_id = ${workspaceId}
             AND child_role = 'mug'
             AND status IN ('running', 'restarting')
             AND spawn_id <> ${spawnId}
           ORDER BY started_at DESC
           LIMIT 1`;
          const incumbent = active[0];
          if (incumbent) {
            return {
              admitted: false,
              activeSpawnId: incumbent.spawn_id,
              activeHarnessSlug: incumbent.harness_slug ?? null,
            };
          }
          await writeRecord(tx);
          return { admitted: true };
        },
      );
      if (!admission.admitted) {
        console.warn(
          `[launch-blueprint] skipped duplicate Mug launch (${installSlug}/${role}); ` +
            `workspace ${workspaceId} already has active Mug ${admission.activeSpawnId}` +
            `${admission.activeHarnessSlug ? ` (${admission.activeHarnessSlug})` : ''}`,
        );
        return { spawnId: admission.activeSpawnId, runId: null, durable: false };
      }
    } else {
      await writeRecord(sql);
    }
  } catch (e) {
    console.warn(
      `[launch-blueprint] fallback spawn record failed (${installSlug}/${role}): ${e instanceof Error ? e.message : e}`,
    );
    if (role === 'mug') return { spawnId: null, runId: null, durable: false };
    pg = null;
  }

  // HEARTBEAT THE LAUNCH ROW (P-011 liveness fix). `loopbackFetch` holds the
  // connection open for the WHOLE worker run — a kind:'hive' Queen wake (or an
  // overwatch loop) runs up to the invoke route's 2700s ceiling, far past
  // RECLAIM_STALE_MS (300s). Unlike the cup:spawn path (operator-spawn.ts'
  // ensureSpawnHeartbeatLoop), this fire-and-forget launch row was recorded but
  // never heartbeated — so the P-011 reclaim sweep (run opportunistically inside
  // every admitSpawn, even DBOS-off) reaped a still-running Queen at ~310s with
  // "spawn heartbeat stale > 300s (launching operator host presumed dead)",
  // killing orchestration mid-run (the P-033 real-Queen bench symptom). Beat the
  // row for as long as THIS process is awaiting the fetch — when this process dies
  // the beats stop and the reclaim correctly frees the slot. unref'd so it never
  // holds the process open; cleared the instant the fetch settles.
  let heartbeat: ManagedHandle | null = null;
  if (pg) {
    const sql = pg.sql;
    heartbeat = managedSetInterval(
      'launch-blueprint-heartbeat',
      SPAWN_HEARTBEAT_INTERVAL_MS,
      () => {
        void heartbeatSpawns(sql, [spawnId]).catch(() => {
          /* best-effort — a missed beat at worst risks an early reclaim, itself
           recoverable (the launch re-fires on the next cadence/wake). */
        });
      },
      { category: 'lifecycle', instanced: true },
    );
  }
  const stopHeartbeat = (): void => {
    if (heartbeat) {
      heartbeat.stop();
      heartbeat = null;
    }
  };

  // Keep the row identity out of the child prompt/args while handing it to the
  // /invoke route. The route uses this internal field only to stamp the actual
  // invoke-once child pid + launcher boot after admission.
  const invokeBody = { ...body, spawnRecordId: spawnId };

  void loopbackFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invokeBody),
    },
    // P-033: this fire holds the connection for the WHOLE worker run (a kind:'hive'
    // Queen wake runs up to the route's 45-min ceiling). Opt into the raised-timeout
    // launch dispatcher so a slow opus:xhigh queen turn isn't severed by undici's
    // default 5-min headers cap (UND_ERR_HEADERS_TIMEOUT) before she places a bee.
    { launch: true },
  )
    .then(async (r) => {
      stopHeartbeat();
      if (!pg) return;
      // HTTP 200 ≠ the agent ran. Judge the invoke body with the SHARED rule
      // (fleet/invoke-outcome), same as durable-spawn: a fire that returns ok-shaped
      // while the agent never emitted a turn (a 429-killed / dead-launcher spawn) is
      // recorded `failed` (infra_loss), NOT silently `done`. This path previously
      // recorded `done` on ANY resolve — the doc-steward silent-swallow that left
      // drifted docs un-healed (docs-audit 2026-06-23 #1). A non-2xx also resolves
      // here (loopbackFetch doesn't throw on it), so treat that as failed too.
      let status: 'done' | 'failed' = 'done';
      let errorMessage: string | undefined;
      const responseText = r && typeof r.text === 'function' ? await r.text().catch(() => '') : '';
      // The /invoke route returns the complete SpawnInvokeOnceResult in its JSON
      // body. Keep the structured child outcome at the same harvest seam as the
      // error classification: the fallback launch row is otherwise left with
      // only prose in error_message (WI-637706). Preserve an explicitly captured
      // empty stderr (`''`) as distinct from a response that did not expose a
      // stderr field (`null`), so readers can tell "captured no stderr" from
      // "this writer never received a result payload".
      let invokeResult: { exitCode?: unknown; stderr?: unknown } | null = null;
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (parsed && typeof parsed === 'object') {
          invokeResult = parsed as { exitCode?: unknown; stderr?: unknown };
        }
      } catch {
        // Keep the legacy fail-soft behavior for non-JSON invoke responses.
      }
      const harvestedExitCode =
        typeof invokeResult?.exitCode === 'number' && Number.isInteger(invokeResult.exitCode)
          ? invokeResult.exitCode
          : null;
      const harvestedOutputTail =
        typeof invokeResult?.stderr === 'string'
          ? invokeResult.stderr.slice(-INVOKE_OUTPUT_TAIL_LIMIT)
          : null;
      if (r && r.ok === false) {
        status = 'failed';
        const tail = responseText ? ` — ${responseText.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '';
        errorMessage = `invoke ${installSlug}/${role} → HTTP ${r.status}${tail}`;
      } else {
        const prelim = agentProducedTurn(responseText, `${installSlug}/${role}`);
        if (!prelim.ran) {
          status = 'failed';
          // Corroborate with the live gateway state so a CAPACITY-SHED mid-turn death
          // (the all-accounts 429 storm) is labeled `capacity_shed`, not the phantom
          // `infra_loss` / "host dead/unstable" that sends debuggers hunting a host bug
          // (H13/P-006). Same shared rule durable-spawn uses. Best-effort, never throws.
          const { gatewayWholesaleThrottled } = await import('../inference-gateway/observability');
          const gatewayThrottled = isCodexLaunchModelSpec(body.spawnModel)
            ? false
            : await gatewayWholesaleThrottled().catch(() => false);
          const outcome = agentProducedTurn(responseText, `${installSlug}/${role}`, { gatewayThrottled });
          // Prefix with the ACTUAL classified failure (capacity_shed / auth_error /
          // usage_limit / context_overflow / infra_loss) — never a hardcoded `infra_loss:`
          // that mislabels an auth / quota / prompt-too-long death as a phantom host loss
          // (B3 / autonomous-loop-hardening F1). durable-spawn already prefixes this way.
          errorMessage = `${outcome.failureClass ?? 'infra_loss'}:${outcome.detail}`;
        }
      }
      if (status === 'failed') {
        console.warn(`[launch-blueprint] fire not green (${installSlug}/${role}): ${errorMessage}`);
      }
      // A release-fixer that returns no turn is not merely a failed child row: it left the
      // red gate without a diagnosis. Reuse the durable escalation table so the next reader
      // sees the failure immediately, while the liveness-aware dispatcher remains the retry
      // mechanism. This runs for both timeout and pre-turn auth/context/infra failures.
      const retryReleaseFixer =
        blueprintId === 'release-fix' &&
        releaseFixerRetryCount < RELEASE_FIXER_FALLBACK_RETRY_LIMIT &&
        isRetryableReleaseFixerNoTurnFailure(errorMessage);
      if (blueprintId === 'release-fix' && isReleaseFixerNoTurnFailure(errorMessage) && !retryReleaseFixer) {
        const releaseFixerContext = bodyExtra?.releaseFixerContext as
          | { candidate?: unknown; failingTests?: unknown }
          | undefined;
        const opened = await recordReleaseFixerNoTurnEscalation(pg.sql, {
          installSlug,
          workspaceId,
          spawnId,
          candidate: typeof releaseFixerContext?.candidate === 'string' ? releaseFixerContext.candidate : null,
          failingTests: Array.isArray(releaseFixerContext?.failingTests)
            ? releaseFixerContext.failingTests.filter((test): test is string => typeof test === 'string')
            : [],
          errorMessage: errorMessage ?? 'release-fixer produced no turn',
        });
        if (opened) {
          console.warn(`[launch-blueprint] release-fixer no-turn escalation opened (${installSlug}/${spawnId})`);
        }
      }
      await finishSpawn(pg.sql, {
        spawnId,
        workspaceId,
        status,
        exitCode: harvestedExitCode,
        outputTail: harvestedOutputTail,
        ...(errorMessage ? { errorMessage } : {}),
      }).catch(() => {});
      if (retryReleaseFixer) {
        console.warn(
          `[launch-blueprint] retrying release-fixer fallback after infra_loss (${installSlug}/${spawnId}); ` +
            `retry ${releaseFixerRetryCount + 1}/${RELEASE_FIXER_FALLBACK_RETRY_LIMIT}`,
        );
        void defaultFire(
          {
            url,
            role,
            installSlug,
            blueprintId,
            kickoff,
            extra,
            timeoutMs,
            workspaceId,
            parent,
            bodyExtra,
          },
          releaseFixerRetryCount + 1,
          false,
        ).catch((retryError) => {
          console.warn(
            `[launch-blueprint] release-fixer fallback retry failed to start (${installSlug}): ${
              retryError instanceof Error ? retryError.message : String(retryError)
            }`,
          );
        });
      }
    })
    .catch((e) => {
      stopHeartbeat();
      // describeFetchError surfaces undici's hidden cause code (e.g. UND_ERR_SOCKET)
      // so the persisted error_message + watchdog signal are self-diagnosing (EI-390).
      const detail = describeFetchError(e);
      console.warn(`[launch-blueprint] fire failed (${installSlug}/${role}): ${detail}`);
      if (pg) {
        void finishSpawn(pg.sql, {
          spawnId,
          workspaceId,
          status: 'failed',
          errorMessage: detail,
        }).catch(() => {});
      }
    });
  return { spawnId, runId, durable: false };
};

/**
 * Fire a named launch blueprint: resolve its role (`spine.decider`) and invoke it
 * once via the invoke route. The fire-and-forget convenience over
 * `resolveLaunchTarget` — for the simple callers (release cadence, self-improvement
 * implement, the `system:blueprint-run` blueprintId path). Returns the resolved
 * target so the caller can log/record what it fired, plus `spawn` — the fire
 * path's correlation (LaunchSpawnInfo), null when the fire seam didn't surface one.
 */
export async function fireLaunchBlueprint(
  blueprintId: string,
  input: FireLaunchInput,
): Promise<LaunchTarget & { spawn: LaunchSpawnInfo | null }> {
  // No-nest guard (local-hive D-009 / swarm D-018 enforcement A): a kind:'hive'
  // blueprint fired WITH a parent context is rejected — hives are peers, launchable
  // only as a root. A root launch (the hive's parentless system:blueprint-run) omits
  // `parent` and passes. Resolve the full blueprint only when a parent is present so
  // root launches keep their cheap role-only resolution.
  const hasParent = Boolean(input.parent && (input.parent.spawnId || input.parent.role));
  if (hasParent) {
    const bp = await _resolver(blueprintId);
    assertNotNestedHive(bp, true);
  }
  const target = await resolveLaunchTarget(blueprintId, input);
  input = withDefaultLaunchTimeout(input, target.role);

  // Queen wake brief: computed at the /invoke ROUTE (harness/spawn.ts), NOT here
  // (WI-682). This launcher used to precompute it (B-03/B-04), but EI-995 moved
  // the scheduled queen wakes to the buildLaunchSpawnRequest durable seam which
  // bypassed this function entirely — every scheduled Queen woke briefless and the
  // @role:queen parked mailbox rotted undelivered. The route is the one chokepoint
  // EVERY wake path traverses (durable spawn, direct fire, manual /invoke), so the
  // compute + slot drain live there. A caller that already computed a snapshot may
  // still pre-supply bodyExtra.queenBrief — it rides the body and the route
  // respects it verbatim (no recompute).
  let fireInput = input;

  // BENCH-SCOPED, FAIL-CLOSED OPUS PIN (P-033 Fix 2). Pin the BENCH-hive Queen to opus PER-WAKE — threaded
  // as bodyExtra.spawnModel → the /invoke route → her child's PAPERCUSP_SPAWN_MODEL (the highest-precedence
  // model channel). Scoped to a bench hive ONLY (the bench flag is set + the install slug is a bench home,
  // `xbq…`), so this replaces the GLOBAL AGENT_MODELS queen=opus on :3170: every NON-bench hive's Queen keeps
  // its sonnet floor, only the bench Queen is pinned. FAIL-CLOSED — the governor WAITS on a paused opus bucket
  // (never substitutes) and the model-tiers floor-clamp never downgrades below the pin. Honors a caller-set
  // bodyExtra.spawnModel + PAPERCUSP_XBENCH_MODEL (default opus:xhigh) as the one knob.
  if (
    target.role === 'mug' &&
    fireInput.bodyExtra?.spawnModel == null &&
    (
      process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE ??
      process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE /* legacy env name — dual-accept until callers migrate */ ??
      ''
    ).trim() &&
    /^xbq/.test(input.installSlug)
  ) {
    const benchModel = (process.env.PAPERCUSP_XBENCH_MODEL ?? 'opus:xhigh').trim();
    fireInput = { ...fireInput, bodyExtra: { ...fireInput.bodyExtra, spawnModel: benchModel } };
  }

  // Resolve what this role actually launches as — model AND backend — through the
  // ONE resolver (fleet/role-launch.ts, plan role-model-one-answer-2026-09-03
  // P-001/P-003/P-005). This block used to be three: a per-role/tier model
  // resolution, an independent `roleBackends` lookup, and a compose-time
  // contradiction check bolted on after the two disagreed in production. Splitting
  // one question across three blocks is what let a body ship asserting a model and
  // a backend that could not both be true.
  //
  // Two properties this file relies on and must not re-implement:
  //   - a LIVE config read (not the `process.env.AGENT_MODELS` /
  //     `AGENT_ROLE_BACKENDS` mirrors, which a long-running scheduler process such
  //     as bg-host refreshes only at its own boot — WI-2142846: a `release-fixer`
  //     override sat ignored for days while the process ran the stale global default);
  //   - `spawnModel` stays null when nothing overrides the committed default, so an
  //     un-steered launch is byte-identical to before.
  //
  // Explicit caller / bench pins still win: each field is written only when the
  // caller left it unset.
  if (fireInput.bodyExtra?.spawnModel == null || fireInput.bodyExtra?.spawnBackend == null) {
    try {
      const { resolveRoleLaunchLive } = await import('../fleet/role-launch');
      const launch = await resolveRoleLaunchLive(target.role, {
        workspaceId: input.workspaceId,
        installSlug: input.installSlug,
      });
      const bodyExtra = { ...fireInput.bodyExtra };
      if (bodyExtra.spawnModel == null && launch.spawnModel) bodyExtra.spawnModel = launch.spawnModel;
      if (bodyExtra.spawnBackend == null && launch.backend) bodyExtra.spawnBackend = launch.backend;
      fireInput = { ...fireInput, bodyExtra };

      // P-005: a contradiction is reported, never silently resolved. WARN rather
      // than throw — this runs on every autonomous launch, and a hard refusal would
      // take the fleet down over a config disagreement the caller cannot fix
      // mid-flight. The precedence itself is deliberate (WI-4640); this only makes
      // the losing side visible, which is the half that was missing when nine
      // release-fixers (2026-09-03 00:32Z→01:27Z) spawned onto a usage-walled codex
      // account while `roleBackends['release-fixer']` said 'claude-code'.
      if (launch.conflict) {
        console.warn(`[backend-conflict] launch-blueprint role '${target.role}': ${launch.conflict.note}`);
      }
    } catch {
      /* fail-soft: leave the role on its committed default if config is unreadable */
    }
  }

  const fire = _fire ?? defaultFire;
  const fired = (await fire({ ...fireInput, ...target })) as LaunchSpawnInfo | undefined;
  return { ...target, spawn: fired ?? null };
}

/**
 * Fire the launch blueprint that declares `eventKey` (D-004). Returns the resolved
 * target, or null when no launch blueprint declares the key. The event-driven
 * sibling of `fireLaunchBlueprint` — parallel to `startCoordProgramForEvent` for
 * program-mode blueprints.
 */
export async function fireLaunchBlueprintForEvent(
  eventKey: string,
  input: FireLaunchInput,
): Promise<(LaunchTarget & { spawn: LaunchSpawnInfo | null }) | null> {
  const blueprintId = resolveLaunchTriggerEvent(eventKey);
  if (!blueprintId) {
    console.warn(`[launch-blueprint] no launch blueprint declares trigger event "${eventKey}"`);
    return null;
  }
  return fireLaunchBlueprint(blueprintId, input);
}
