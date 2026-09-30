/**
 * overwatch/loop — the autonomous overwatch wake-loop (overwatch-role-2026-06-15
 * B-04, owns C-3).
 *
 * This is the LAUNCH half of the overwatch's autonomous loop — the analogue of the
 * Queen's `system:blueprint-run` → hive launch, but on the overwatch's OWN wake
 * channel (it must NOT ride the Queen's `hive-wake`; that would collide). It wires
 * three things, reusing the seams the sibling briefs already landed:
 *
 *   1. **The `system:overwatch-launch` action** (`OVERWATCH_WAKE_TARGET_ACTION`,
 *      liveness.ts) — fired by the one-shot `overwatch-wake` routine when due. It
 *      computes the OverwatchBrief (B-03 `computeOverwatchBrief` → B-02
 *      `renderOverwatchBrief`) and launches role=overwatch via the invoke route
 *      with the brief injected (`bpkind=overwatch`, `BLUEPRINT_ID=coding` so the
 *      persona resolves at `blueprints/coding/prompts/overwatch.md`, B-05/D-010).
 *      The brief rides the /invoke body as `overwatchBrief`; the route sets
 *      `OVERWATCH_WAKE_BRIEF`; invoke.ts hands it to buildPrompt as a
 *      `<system-reminder>` tail block (mirrors the Queen's MUG_WAKE_BRIEF).
 *
 *   2. **The waker** (`registerOverwatchWaker`, wake-bridge.ts) — the B-07 ↔ B-04
 *      seam: `kettle:start` requests an immediate wake / `kettle:pause`
 *      clears the pending one, both through this module's `requestWake`/`clearWake`,
 *      which arm/clear the one-shot `overwatch-wake` routine via
 *      `declareOverwatchTimeWake`/`clearOverwatchTimeWake` (liveness.ts).
 *
 *   3. **declare-next-wake** — NOT here. The overwatch declares its own next wake
 *      at turn-end via the `kettle:declare-wake` tool (agent-tools/overwatch/
 *      declare_wake.ts), which calls the SAME `declareOverwatchTimeWake` primitive.
 *      The action deliberately does NOT pre-arm a cadence wake: at a short cadence a
 *      pre-armed wake could fire mid-turn and double-launch the overwatch. So the
 *      next wake is armed only AFTER a turn ends (the persona declares it; B-09's
 *      `overwatchTurnEndCheck` backstops a forgotten declaration with a fallback
 *      SLEEP) — exactly the proven hive model.
 *
 * GATING (B-10/D-009/D-013): the action self-gates on `FLAGS.OVERWATCH` AND B-07's
 * started bit before doing any work, and the central spawn chokepoint
 * (operator-spawn.ts) independently rejects a role=overwatch launch while the flag
 * is off. Flag off ⇒ nothing here ever launches the role. Stays dark until B-12.
 *
 * The fire is injectable (`setOverwatchLaunchFire`) so unit tests capture the
 * dispatch without a real HTTP call (the codebase's `setBlueprintRunFire` pattern).
 */
import { randomUUID } from "node:crypto";
import { getOrgPg } from "@papercusp/db-org";
import { describeFetchError, loopbackFetch } from "../loopback-fetch";
import { operatorApiBase } from "../operator-api-base";
import { classifyFireError, recordFire } from "../autoloop";
import {
  managedSetInterval,
  type ManagedHandle,
} from "@papercusp/scheduled-registry";
import {
  registerSystemAction,
  type SystemActionCtx,
} from "../harness/routines/system-actions";
import {
  OVERWATCH_ROLE,
  OVERWATCH_BLUEPRINT_ID,
  OVERWATCH_WAKE_TARGET_ACTION,
  OVERWATCH_INVOKE_TIMEOUT_MS as OVERWATCH_TURN_TIMEOUT_MS,
  OVERWATCH_SCORECARD_DEADLINE_GRACE_MS,
  declareOverwatchTimeWake,
  clearOverwatchTimeWake,
} from "./liveness";
import { getOverwatchStarted } from "./control-state";
import { getPotStarted } from "../pot/started";
import { overwatchEnabled } from "./watchdog";
import { computeOverwatchBrief } from "./compute-brief";
import { renderOverwatchBrief } from "./brief-types";
import { registerOverwatchWaker } from "./wake-bridge";
import { agentProducedTurn } from "../fleet/invoke-outcome";
import { resolvePotHomeSlug } from "../pot/wake";
import { operatorHomeHarnessSlug } from "../harness/operator-home-harness";
import { trackDetached } from '../detached-imports';

const operatorBase = operatorApiBase;

/** The registry key for the launch action — derived from the contract constant
 *  (liveness.ts) so a rename of the action follows automatically. */
const OVERWATCH_LAUNCH_ACTION = OVERWATCH_WAKE_TARGET_ACTION.startsWith(
  "system:",
)
  ? OVERWATCH_WAKE_TARGET_ACTION.slice("system:".length)
  : OVERWATCH_WAKE_TARGET_ACTION;

/** Overwatch is a monitor, not a worker lane: a turn that cannot emit its scorecard
 *  in bounded time must fail closed so the deterministic scorecard backstop can
 *  speak. The invoke route's autonomous-loop ceiling is deliberately long for Queen
 *  and bees, but it leaves the monitor silent for far too long under gateway stalls.
 *
 *  8 min, NOT the original 3 (2026-07-01): the loop switched to the codex backend
 *  (owner-steering modelOverrides.overwatch = gpt-5.4:*), whose spawn+turn takes
 *  ~5-8 min (observed on the Queen's codex turns) — at 180s EVERY overwatch fire
 *  died at the timeout with no turn (`timedOut=true, outLen≈750` in autoloop_state)
 *  and the role NEVER produced a scorecard. 480s still fails closed under the 600s
 *  wake cadence (no overlapping turns; overwatchMidTurn guards a slow one). */
export const OVERWATCH_INVOKE_TIMEOUT_MS = OVERWATCH_TURN_TIMEOUT_MS;

/** Input to the overwatch launch fire — the resolved role + the computed brief. */
export interface OverwatchLaunchFireInput {
  installSlug: string;
  workspaceId: string;
  role: string;
  /** Human-readable wake reason (the routine's payload kickoff). */
  kickoff: string;
  /** The rendered OverwatchBrief, or null when its precompute degraded (the
   *  persona then gathers the panels itself — overwatch.md's fallback). */
  brief: string | null;
  /** SESSION model override (model-override-sidebar-2026-06-23) — a `model[:effort]`
   *  spec for THIS overwatch wake, from `owner-steering.modelOverrides.overwatch`.
   *  Threaded as `body.spawnModel` → PAPERCUSP_SPAWN_MODEL (the highest-precedence
   *  model channel). Empty/absent ⇒ the workspace default (agent-config models.overwatch). */
  spawnModel?: string | null;
}

export type OverwatchLaunchFireFn = (
  input: OverwatchLaunchFireInput,
) => void | Promise<void>;

let _fire: OverwatchLaunchFireFn | null = null;
/** Override the launch fire (tests). Pass `null` to restore the default invoke fire. */
export function setOverwatchLaunchFire(fn: OverwatchLaunchFireFn | null): void {
  _fire = fn;
}

function stringPayloadField(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Workspace-scoped Overwatch stores the one-shot routine under the workspace
 * sentinel (installSlug === workspaceId), but every agent-facing operation still
 * targets the concrete hive harness. New wake rows carry `potSlug`; old sentinel
 * rows fall back to the configured hive home so they recover after deploy.
 *
 * EI-5842 (overwatch dead 5 days): the fallback MUST resolve to a registered
 * harness slug — never the workspace id or the `*` cross-workspace wildcard, which
 * the invoke route's `resolveProject` can't find → HTTP 404 "unknown project" →
 * the meta-monitor gates itself dark after 3 errors. Two paths produced a bad
 * target: (1) a sentinel row (installSlug === workspaceId) fell to
 * `resolvePotHomeSlug(null, null)`, which returns NULL when
 * `PAPERCUSP_POT_HOME_SLUG` is unset (unlike `operatorHomeHarnessSlug`, it lacks
 * the legacy default), so the final `?? ctx.installSlug` re-produced the workspace
 * id; (2) a `*` wildcard row skipped the sentinel branch entirely and fell to
 * `ctx.installSlug === '*'`. Both are caught here by resolving any sentinel /
 * wildcard install slug to the operator-home hive, which ALWAYS yields a
 * registered slug (the env pointer canonicalized, else the legacy default).
 */
function resolveOverwatchLaunchInstallSlug(ctx: SystemActionCtx): string {
  const fromPayload =
    stringPayloadField(ctx.payloadTemplate, "potSlug") ??
    stringPayloadField(ctx.payloadTemplate, "installSlug") ??
    stringPayloadField(ctx.payloadTemplate, "harness");
  if (fromPayload) return fromPayload;

  // A sentinel (installSlug === workspaceId), a `*` cross-workspace wildcard, or a
  // missing install slug carries no concrete hive: falling through to
  // ctx.installSlug would POST the invoke route against a non-harness slug → 404.
  // Resolve the operator-home hive instead. `resolvePotHomeSlug(null, null)`
  // canonicalizes the env pointer (retired-slug self-heal) but can be null;
  // `operatorHomeHarnessSlug()` backstops that with the legacy default so the
  // target is never null, never the workspace id, never `*`.
  const isSentinel =
    !ctx.installSlug ||
    ctx.installSlug === ctx.workspaceId ||
    ctx.installSlug === "*";
  if (isSentinel) {
    return resolvePotHomeSlug(null, null) ?? operatorHomeHarnessSlug();
  }
  return ctx.installSlug;
}

/**
 * The default fire: invoke role=overwatch via the loopback invoke route with the
 * brief threaded through the POST body. Fire-and-forget (the invoke route runs the
 * agent to completion up to its timeout; a scheduled launch must not block the
 * durable step on the whole agent lifetime — the next declared wake re-fires).
 * Mirrors blueprint-run-action.ts's `defaultFire`.
 */
const defaultOverwatchFire: OverwatchLaunchFireFn = async ({
  installSlug,
  workspaceId,
  role,
  kickoff,
  brief,
  spawnModel,
}) => {
  const ws = encodeURIComponent(workspaceId);
  // `bpkind=overwatch` tells the invoke route to record a TRACKED, resumable
  // session (label `overwatch · <slug>/<role>`, matching overwatchMidTurn) AND to
  // run `overwatchTurnEndCheck` (not the hive's) when the turn ends.
  const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}&bpkind=overwatch`;
  const body: Record<string, unknown> = {
    kickoff,
    timeoutMs: OVERWATCH_INVOKE_TIMEOUT_MS,
    // `BLUEPRINT_ID=coding` scopes the role's prompt resolution to
    // `blueprints/coding/prompts/overwatch.md` (the canonical persona, B-05/D-010),
    // falling back to the global stub if absent (D-007).
    extra: [`BLUEPRINT_ID=${OVERWATCH_BLUEPRINT_ID}`],
  };
  if (brief) body.overwatchBrief = brief;
  // SESSION model override (model-override-sidebar-2026-06-23): pin this wake's model
  // via the highest-precedence channel (PAPERCUSP_SPAWN_MODEL), separate from the
  // workspace default. Absent ⇒ no pin (workspace/CLI default).
  if (spawnModel && spawnModel.trim()) body.spawnModel = spawnModel.trim();
  const deadline = armScorecardDeadlineBackstop({
    workspaceId,
    installSlug,
    role,
  });
  // Stamp the attempt, then refresh the pane's "is-it-alive?" heartbeat strip:
  // `recordFire` wrote a fresh `autoloop_state` row that `overwatch.liveness`
  // reads, so the strip's last-run / countdown / ALIVE badge update live over SSE
  // the moment a wake fires. Name-only (the consumer subscribes with no args).
  void recordFire(installSlug, role, "firing", "attempt")
    .catch(() => {})
    .finally(invalidateOverwatchLiveness);

  // KETTLE TURN VISIBILITY. This fire is an IN-PROCESS `/invoke` (loopbackFetch), not a
  // spawned invoke-once child, so it historically recorded NO `spawned_agents` row: the
  // kettle's turns were invisible in fleet:tree, and pot:soak-report — whose roleSuccess
  // reads that table — saw "no terminal kettle turns" no matter how many turns the meta-
  // monitor actually took, which pinned the production-readiness verdict NOT-READY on a
  // criterion nothing could ever satisfy. Record the row the same way launch-blueprint's
  // fire-and-forget fallback does (WI-108/EI-403): `running` at fire, pid-stamped and
  // heartbeated so the P-011 reclaim sweep can't reap a legitimately long turn (the invoke
  // ceiling is 480s, well past RECLAIM_STALE_MS 300s — an unbeaten row would come back
  // `reaped`, i.e. a FAILED turn, making the gate read worse than the silence did), then
  // finished done/failed on the SAME classification the recordFire branches below compute.
  // Best-effort end to end: a bookkeeping failure must never break the meta-monitor's fire.
  // The spawn stores are DYNAMICALLY imported (the launch-blueprint / scorecard convention):
  // they pull the db-org graph in behind them, and this module's unit tests mock @papercusp/
  // db-org partially — a static import would drag that graph into their module graph and
  // break collection. Tests replace the whole fire via setOverwatchLaunchFire anyway.
  const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runId = `overwatch-${Date.now()}-${randomUUID().slice(0, 6)}`;
  let pg: ReturnType<typeof getOrgPg> | null = null;
  let spawnTree: typeof import("../fleet/spawn-tree") | null = null;
  let reclaim: typeof import("../fleet/spawn-reclaim") | null = null;
  try {
    [spawnTree, reclaim] = await Promise.all([
      import("../fleet/spawn-tree"),
      import("../fleet/spawn-reclaim"),
    ]);
    pg = getOrgPg();
    await spawnTree.recordSpawn(pg.sql, {
      spawnId,
      workspaceId,
      harnessSlug: installSlug,
      // parent_role is NOT NULL in spawned_agents — a scheduled, parentless system launch
      // is recorded as spawned by the operator host, matching every other root spawn.
      parentSpawnId: null,
      parentRole: "operator",
      childRole: role,
      runId,
      status: "running",
    });
    await reclaim.recordSpawnPid(pg.sql, spawnId, process.pid).catch(() => {});
  } catch (e) {
    console.warn(
      `[overwatch-loop] spawn record failed (${installSlug}/${role}): ${e instanceof Error ? e.message : e}`,
    );
    pg = null;
  }

  let heartbeat: ManagedHandle | null = null;
  if (pg && reclaim) {
    const sql = pg.sql;
    const { heartbeatSpawns, SPAWN_HEARTBEAT_INTERVAL_MS } = reclaim;
    heartbeat = managedSetInterval(
      "overwatch-launch-heartbeat",
      SPAWN_HEARTBEAT_INTERVAL_MS,
      () => {
        void heartbeatSpawns(sql, [spawnId]).catch(() => {
          /* best-effort — a missed beat at worst risks an early reclaim, itself
             recoverable (the next declared wake re-fires the overwatch). */
        });
      },
      { category: "lifecycle", instanced: true },
    );
  }
  const settleSpawn = (
    status: "done" | "failed",
    errorMessage?: string,
  ): void => {
    if (heartbeat) {
      heartbeat.stop();
      heartbeat = null;
    }
    if (!pg || !spawnTree) return;
    void spawnTree
      .finishSpawn(pg.sql, {
        spawnId,
        workspaceId,
        status,
        ...(errorMessage ? { errorMessage } : {}),
      })
      .catch(() => {});
  };

  void loopbackFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, {
    // This connection stays open for the whole Kettle turn. Use the dispatcher
    // whose headers/body timeouts cover the invoke ceiling instead of undici's
    // short default, which otherwise surfaces as a blind `fetch failed`.
    launch: true,
  })
    .then(
      async (r) => {
        const responseBody = await r
          .text()
          .catch(() => "");
        const detail = responseBody.replace(/\s+/g, " ").slice(0, 320);
        if (!r.ok) {
          const message = `error: HTTP ${r.status}${detail ? ` — ${detail.slice(0, 160)}` : ""}`;
          settleSpawn("failed", message);
          await recordFire(installSlug, role, message, classifyFireError(message));
          await runScorecardBackstop(workspaceId, installSlug, message);
          return;
        }

        const invokeError = classifyInvokeBodyFailure(
          responseBody,
          `${installSlug}/${role}`,
        );
        if (invokeError) {
          settleSpawn("failed", invokeError);
          await recordFire(installSlug, role, invokeError, classifyFireError(invokeError));
          await runScorecardBackstop(workspaceId, installSlug, invokeError);
          return;
        }

        // The agent produced a real turn — `done` is the spawn-row truth regardless of the
        // scorecard deadline below (a missed scorecard is a separate obligation the
        // backstop already records; it is not an infra failure of this turn).
        settleSpawn("done");
        if (deadline.fired) return;
        return recordFire(installSlug, role, "ok", "ok");
      },
      async (e) => {
        const detail = describeFetchError(e).slice(0, 180);
        console.warn(
          `[overwatch-loop] launch fire failed (${installSlug}/${role}): ${detail}`,
        );
        const message = `error: ${detail}`;
        settleSpawn("failed", message);
        await recordFire(installSlug, role, message, classifyFireError(message));
        await runScorecardBackstop(workspaceId, installSlug, message);
      },
    )
    .catch(() => {})
    .finally(() => {
      deadline.cancel();
      invalidateOverwatchLiveness();
    });
};

function classifyInvokeBodyFailure(text: string, label: string): string | null {
  if (!text.trim()) {
    return `error: invoke produced no Kettle turn — ${label} returned an empty invoke response body; Kettle is a monitor, so empty/uncertain launch results fail closed and run the scorecard backstop`;
  }

  const outcome = agentProducedTurn(text, label);
  if (!outcome.ran)
    return `error: invoke produced no Kettle turn — ${outcome.detail.trim()}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { ok?: unknown }).ok !== false
  )
    return null;
  const obj = parsed as {
    error?: unknown;
    exitCode?: unknown;
    timedOut?: unknown;
    durationMs?: unknown;
  };
  const parts = ["error: invoke returned ok:false"];
  if (typeof obj.error === "string" && obj.error.trim())
    parts.push(obj.error.trim().slice(0, 180));
  if (typeof obj.exitCode === "number") parts.push(`exitCode=${obj.exitCode}`);
  if (obj.timedOut === true) parts.push("timedOut=true");
  if (typeof obj.durationMs === "number")
    parts.push(`durationMs=${obj.durationMs}`);
  return parts.join(" — ");
}

function armScorecardDeadlineBackstop(opts: {
  workspaceId: string;
  installSlug: string;
  role: string;
}): {
  fired: boolean;
  cancel: () => void;
} {
  const state = { fired: false, cancel: () => clearTimeout(timer) };
  const timer = setTimeout(() => {
    void (async () => {
      const reason = `no complete scorecard within ${OVERWATCH_INVOKE_TIMEOUT_MS}ms launch deadline`;
      const res = await runScorecardBackstop(
        opts.workspaceId,
        opts.installSlug,
        reason,
      );
      if (res.outcome === "synthesized" || res.outcome === "error") {
        state.fired = true;
        await recordFire(
          opts.installSlug,
          opts.role,
          `error: ${reason}; backstop ${res.outcome}`,
          classifyFireError(`error: ${reason}; backstop ${res.outcome}`), // WI-669
        );
        invalidateOverwatchLiveness();
      }
    })().catch((e) => {
      state.fired = true;
      const detail = e instanceof Error ? e.message : String(e);
      void recordFire(
        opts.installSlug,
        opts.role,
        `error: scorecard deadline backstop threw: ${detail}`,
        classifyFireError(detail), // WI-669
      ).finally(invalidateOverwatchLiveness);
    });
  }, OVERWATCH_INVOKE_TIMEOUT_MS + OVERWATCH_SCORECARD_DEADLINE_GRACE_MS);
  return state;
}

async function runScorecardBackstop(
  workspaceId: string,
  installSlug: string,
  reason: string,
): Promise<{ outcome: "synthesized" | "skipped" | "error"; reason: string }> {
  try {
    const { overwatchScorecardEndCheck } = await import("./scorecard-backstop");
    const res = await overwatchScorecardEndCheck({ workspaceId, installSlug });
    if (res.outcome === "error") {
      console.warn(
        `[overwatch-loop] ${installSlug}: scorecard backstop failed after launch error (${reason}): ${res.reason}`,
      );
    }
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[overwatch-loop] ${installSlug}: scorecard backstop threw after launch error (${reason}): ${msg}`,
    );
    return { outcome: "error", reason: msg };
  }
}

/** Refresh the `overwatch.liveness` sync subscribers (the "is-it-alive?" strip)
 *  after a fire stamps `autoloop_state`. Lazy import (the loop module is imported
 *  at boot, before the SSE bus is necessarily wired) + fully fail-soft — a notify
 *  miss never affects the launch. */
function invalidateOverwatchLiveness(): void {
  void trackDetached(import("../sync-sse"))
    .then(({ notifySyncInvalidate }) =>
      notifySyncInvalidate("overwatch.liveness", {}),
    )
    .catch(() => {});
}

/**
 * The registered `system:overwatch-launch` handler. Self-gates (flag + started),
 * computes the brief fail-soft, and fires the role launch. NEVER throws — it runs
 * inside a retryable DBOS step (routines-workflow.ts), and a throw after firing
 * would double-launch the overwatch on retry; every failure mode degrades to "no
 * launch this tick" (the watchdog re-arms a fallback if the channel goes quiet).
 */
export async function handleOverwatchLaunch(
  ctx: SystemActionCtx,
): Promise<void> {
  const { workspaceId, payloadTemplate } = ctx;
  const installSlug = resolveOverwatchLaunchInstallSlug(ctx);
  try {
    // Defense-in-depth (the spawn chokepoint also rejects role=overwatch while the
    // flag is off): skip cheaply when the role is dark or the loop is paused so we
    // never compute a brief / fire a launch that the chokepoint would reject anyway.
    if (!(await overwatchEnabled())) {
      console.log(
        `[overwatch-loop] ${installSlug}: launch skipped — overwatch flag off`,
      );
      return;
    }
    if (!(await getOverwatchStarted(workspaceId, installSlug))) {
      console.log(
        `[overwatch-loop] ${installSlug}: launch skipped — overwatch not started`,
      );
      return;
    }
    // Owner invariant [owner 2026-07-16]: the Kettle supervises a RUNNING pot —
    // only STARTED pots receive kettle (and mug) work. The overwatch-started bit
    // above is the LOOP's own switch (kettle:start/kettle:pause) and survives a pot
    // stop, so without this check a stale overwatch-wake routine keeps launching
    // kettle turns on a pot nobody is running (live: kettle · sb-devboard-hive
    // firing every ~3min on 2026-07-16 while papercusp was the only started pot).
    if (!(await getPotStarted(workspaceId, installSlug))) {
      console.log(
        `[overwatch-loop] ${installSlug}: launch skipped — pot not started (kettle only supervises started pots)`,
      );
      return;
    }

    const kickoff =
      typeof payloadTemplate?.kickoff === "string" &&
      payloadTemplate.kickoff.trim()
        ? payloadTemplate.kickoff.trim()
        : `Scheduled overwatch wake for '${installSlug}'. Survey system health (the brief) and act on the anomalies.`;

    // Precompute the brief (B-03 → B-02). computeOverwatchBrief is itself fail-soft
    // (catastrophic failure → the neutral emptyOverwatchBrief), but wrap defensively
    // so a render/compute throw never aborts the launch — a null brief launches the
    // overwatch to gather the panels itself (overwatch.md's degraded fallback).
    let brief: string | null = null;
    try {
      const computed = await computeOverwatchBrief(workspaceId, installSlug, {
        wokeBy: kickoff,
      });
      brief = renderOverwatchBrief(computed);
    } catch (e) {
      console.warn(
        `[overwatch-loop] ${installSlug}: brief precompute failed — launching without it: ${e instanceof Error ? e.message : e}`,
      );
      brief = null;
    }

    // Session model override (model-override-sidebar-2026-06-23): owner-steering
    // modelOverrides.kettle pins THIS wake's model, separate from the workspace
    // agent-config default. Fail-soft → no override (workspace default).
    let spawnModel: string | null = null;
    try {
      const { getOwnerSteering } = await import("../owner-steering");
      spawnModel =
        (await getOwnerSteering(workspaceId, installSlug)).modelOverrides
          ?.kettle ?? null;
    } catch {
      /* fail-soft — launch at the default model */
    }

    const fire = _fire ?? defaultOverwatchFire;
    await fire({
      installSlug,
      workspaceId,
      role: OVERWATCH_ROLE,
      kickoff,
      brief,
      spawnModel,
    });
    console.log(
      `[overwatch-loop] ${installSlug}: fired overwatch launch (brief ${brief ? "attached" : "absent"})`,
    );
  } catch (e) {
    // The whole handler is fail-soft (the durable-step contract): never throw.
    console.warn(
      `[overwatch-loop] ${installSlug}: launch handler failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

// ── register the action + the waker at module load ────────────────────────────

registerSystemAction(OVERWATCH_LAUNCH_ACTION, handleOverwatchLaunch);

/**
 * Wire the real wake-launch into the B-07 control seam (wake-bridge.ts). Until this
 * runs, `kettle:start`/`kettle:pause` calls through `requestOverwatchWake`/
 * `clearOverwatchWake` are fail-soft no-ops; once registered they arm/clear the
 * one-shot `overwatch-wake` routine the action above fires.
 */
registerOverwatchWaker({
  async requestWake({ harness, workspaceId, reason }) {
    const { sql } = getOrgPg();
    // `at: now` is clamped to now+floor by declareOverwatchTimeWake — the first
    // wake fires on the next routine tick past the floor (no instant spin).
    return declareOverwatchTimeWake(sql, {
      workspaceId,
      installSlug: harness,
      at: new Date(),
      kickoff: reason,
    });
  },
  async clearWake({ harness, workspaceId }) {
    const { sql } = getOrgPg();
    await clearOverwatchTimeWake(sql, harness, { workspaceId });
    return { cleared: true };
  },
});
