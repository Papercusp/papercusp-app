/**
 * events sugar verbs — thin, DISCOVERABLE named waits over `events:await`
 * (event-await-discoverability-and-coverage-2026-07-03 P-003, D-002/D-005).
 *
 * Each verb is a ~convenience wrapper that (a) puts a named await in the tool list
 * so an agent FINDS it (the whole plan's point — agents poll because they never
 * find `events:await`), and (b) builds the correctly-shaped key from the catalog
 * (`events/await/catalog.ts` — the single source of truth) so a key shape lives in
 * exactly one place. NOT a second subscription system: every verb resolves to the
 * same `registerAwait` the raw `events:await` uses. Mirrors how `coord:wake` /
 * `coord:dispatch` hide the `coord:inbox-wake:<owner>` key.
 *
 * D-005: because the sugar sources keys from the catalog, a future Phase 4 (fold
 * await into the ECA engine) reshapes HOW these resolve, not the verbs themselves.
 *
 * DUAL-OUTCOME verbs (deploy, checkpoint) arm awaits on the two MUTUALLY-EXCLUSIVE
 * outcome keys (success + failure) so the agent wakes either way — safe because a
 * deploy either lands OR fails, never both, so there is no double-wake. Keys that
 * CO-fire (the general work-item:status and the specific work-item:done) are never
 * armed together — the verb picks exactly one.
 */

import * as path from "node:path";
import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import { resolveAgentIdentity } from "../coordination/identity";
import { captureWakeHandleForOwner } from "../../events/await/handle";
import {
  registerAwait,
  attachProducerHealthCertificate,
  cancelAwait,
  cancelAwaitsForSubscribersOnKeys,
  FLEET_BENCH_NOTE_PREFIX,
} from "../../events/await/store";
import { startAwaitSweeper } from "../../events/await/engine";
import { buildKey } from "../../events/await/catalog";
import { clampText, LIMITS } from "../limits";
import { devDeployState } from "../../dev-deploy-state";
import { liveBlockedState, liveSettledProbe, type LiveBlockedStateProbe } from "../../work-items-events";
import { withBoundedTimeout } from "../../bounded-timeout";
import { CHECKPOINT_MAX_RUNTIME_SEC } from "../../release-checkpoint-launch";
import { readDeployInFlight } from "../../release-deploy-launch";
import { gitPipelinePosition } from "../../git-pipeline-position";
import { gitPipelineSnapshot } from "../../git-pipeline-stats";
import { findGreenCheckpointVerdictForCandidate } from "../../harness/git-sync/pipeline-events";
import { checkpointProducerCertificate } from "../../events/await/checkpoint-verified-wait";
import type { TimeoutBehavior } from "../../events/await/types";
import { harnessArg } from "../_harness-scope";
import {
  gitSyncAwaitScope,
  gitSyncScopeRequiredResult,
  gitSyncShaSuffixProblem,
  gitSyncShaSuffixRefusal,
} from "./git-sync-await-scope";
import { probeServiceUpLatch } from "./service-up-edge";
import { mainWaitPlanReviewForWait } from "../../acceptance-runtime-wait-guard";

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): 30min default, matches events:await.
// Aliased to the local names so every usage/describe below is unchanged.
import {
  AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC,
  AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC,
} from "../../events/await/types";

/** Shared timeout arg — identical semantics to events:await's. */
const timeoutArg = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_SEC)
  .optional()
  .describe(
    `Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}); on the deadline you are woken with a TIMEOUT marker.`,
  );

/** Shared deadline behavior — identical semantics to events:await's. */
const onTimeoutArg = z
  .enum(["wake", "expire"])
  .optional()
  .describe(
    "What happens at the deadline without the event: 'wake' (default) = re-invoke with a TIMEOUT marker; 'expire' = lapse silently (visible in events:status).",
  );

// WI-5685: checkpoint:await used to inherit the GENERIC 1800s (30min) default above, which is
// shorter than the green-checkpoint suite can legitimately run — the systemd backstop alone
// (CHECKPOINT_MAX_RUNTIME_SEC) allows up to 3h, well past the suite's own in-process timeout, and
// the run can still be salvaging/emitting its verdict for a bit after that. A DEFAULT await
// therefore used to strand the caller mid-suite on every single default-timeout call (2 for 2 in
// the WI-5685 evidence) — not an edge case, the COMMON case, since most callers never think to
// override a generic-sounding default. Give this verb its OWN default derived from the suite's
// real worst-case ceiling instead of the one-size-fits-all generic default; explicit timeout_sec
// still always wins.
export const CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC = CHECKPOINT_MAX_RUNTIME_SEC + 10 * 60; // 3h backstop + 10min grace for the verdict to land/emit after the process exits

// Producer enrichment is best-effort. Registration is already durable before
// this bounded observation/attachment window begins, so a slow or unavailable
// snapshot leaves an ordinary timeout await in place.
export const CHECKPOINT_PRODUCER_ENRICHMENT_TIMEOUT_MS = 3_000;

const checkpointTimeoutArg = z
  .number()
  .int()
  // A zero-second deadline is intentional here: it lets callers use the
  // candidateSha already-judged latch as a bounded, non-blocking probe. The
  // await store also supports immediate expiry when no verdict is recorded.
  .nonnegative()
  .max(MAX_TIMEOUT_SEC)
  .optional()
  .describe(
    `Deadline in seconds (0 = bounded immediate probe; default ${CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC} ≈ ${Math.round(CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC / 60)}min — WI-5685: sized to the suite's real worst-case ceiling, the ${Math.round(CHECKPOINT_MAX_RUNTIME_SEC / 60)}min systemd backstop + slack, NOT the generic events:await default (${DEFAULT_TIMEOUT_SEC}s) which used to strand a default-timeout caller mid-suite); on the deadline you are woken with a TIMEOUT marker.`,
  );

/**
 * Arm one or more awaits sharing ONE wake handle (captured now — the agent is
 * asleep at fire time). Mirrors events:await, so the sugar and the raw verb are
 * the same primitive. Returns the registered keys + a resume advice line.
 *
 * EI-12457: `opts.payloadFilter` (applied to every key in this call) binds the wait
 * to an exact subject (e.g. a candidate SHA) so a same-key fire for a DIFFERENT
 * subject never wakes this caller. `opts.supersedeKeys` cancels this SAME
 * subscriber's own prior, still-pending awaits on those keys FIRST — re-arming a
 * wait for a moved-on candidate retires the stale registration instead of leaving
 * it to accumulate/eventually fire a stale wake.
 */
async function armAwaits(
  ctx: Parameters<typeof resolveAgentIdentity>[0],
  keys: string[],
  note: string,
  timeoutSec: number | undefined,
  opts: {
    payloadFilter?: unknown;
    supersedeKeys?: string[];
    timeoutBehavior?: TimeoutBehavior;
  } = {},
): Promise<{
  ok: true;
  events: string[];
  await_ids: number[];
  superseded?: number;
  advice: string;
}> {
  const identity = resolveAgentIdentity(ctx);
  startAwaitSweeper();
  let superseded: number | undefined;
  if (opts.supersedeKeys && opts.supersedeKeys.length > 0) {
    try {
      superseded = await cancelAwaitsForSubscribersOnKeys([identity.ownerId], opts.supersedeKeys, {
        excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
      });
    } catch {
      /* best-effort — a failed retirement must never block arming the new wait */
    }
  }
  const { handle } = await captureWakeHandleForOwner(identity.ownerId, {});
  const timeoutBehavior = opts.timeoutBehavior ?? "wake";
  const awaitIds: number[] = [];
  for (const key of keys) {
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: key,
      policy: "wake",
      note: clampText(note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior,
      timeoutSec: timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      payloadFilter: opts.payloadFilter ?? null,
      // Producer certificates are attached after all rows are registered.
      producerHealthCertificate: null,
    });
    awaitIds.push(row.id);
  }
  return {
    ok: true,
    events: keys,
    await_ids: awaitIds,
    ...(superseded != null ? { superseded } : {}),
    advice:
      timeoutBehavior === "wake"
        ? "Registered. End your turn now — you are re-invoked when it fires (or at the deadline). Do not poll."
        : "Registered. End your turn now — you are re-invoked when it fires; if the deadline passes first, the await expires silently. Do not poll.",
  };
}

/**
 * A service-up key is an EDGE, so it cannot satisfy a waiter when the service
 * is already healthy. That rule used to live here as a private helper, which
 * is why the RAW `events:await` path never got it (EI-20268841604319803): it
 * armed a dead edge wait in silence while this sugar handled the same key
 * correctly. Both surfaces now share `probeServiceUpLatch` from
 * ./service-up-edge so they cannot drift apart again.
 */

function reply(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function checkpointPipelineName(integrationRoot: string): string {
  const base = path.basename(path.resolve(integrationRoot));
  return (base.replace(/[^a-zA-Z0-9_-]/g, "-") || "default").slice(0, 64);
}

async function defaultCheckpointPipeline(): Promise<string | undefined> {
  try {
    const state = await devDeployState();
    return checkpointPipelineName(state.integrationRoot);
  } catch {
    return undefined;
  }
}

// ── EI-18676050719521433: the deploy-already-landed LATCH. `release:deployed:<sha>`
// is emitted ONLY for the shas in the deploy BATCH that ships them
// (apps/operator/lib/release/deploy.ts: plan.targetSha + each plan.commitShas) — a
// sha deployed in an EARLIER batch, awaited AFTERWARD, can never re-fire that exact
// key. Without an arm-time check the caller slept the FULL timeout holding its work-
// item claim even though release:trace already knew the target had landed (live
// case: su-29fe479d parked 2026-07-26T02:22Z on a sha release:trace confirmed was
// already deployed; the wait could only ever time out). Same class as the
// EI-9270 announced-gate latch and EI-13095 work-item:done latch elsewhere in this
// file/events:await — probe NOW, answer already_deployed instead of registering a
// dead-on-arrival wait. Best-effort + time-bounded: an unresolvable probe (timeout,
// unknown sha) falls through to a normal registration, never blocks arming.
// EI-19448585641887174: `positions.deployed` is a GIT fact — true from the deploy's
// `swap` step onward, because it is ancestry against the RELEASE CHECKOUT'S HEAD
// (dev-deploy-state derives `deployed` from `cfg.releaseRoot`). The process restart
// happens LATER (apps/operator/lib/release/deploy.ts: swap … L389 restart … L438 emit).
// So inside the swap→restart window this probe was reporting a sha as "live on :3070"
// and telling the caller to "proceed with the work that needed it live now" while the
// OLD process was still serving — "deployed ✓" stated as a process conclusion, the
// misread CLAUDE.md records as filed four separate times.
//
// The falsifier was already in the object this probe builds and discarded:
// `serving.startedSinceCodeChange`. It is reported ALONGSIDE `deployed` rather than
// folded INTO it, deliberately — see the latch site for why suppressing the latch here
// would re-open EI-18676050719521433.
async function deployAlreadyLiveProbe(sha: string): Promise<{
  deployed: boolean;
  targetSha: string | null;
  deployedSha: string | null;
  /** AFFIRMATIVE evidence the serving process has not loaded the deployed code.
   *  `false` means measured-and-current; `null` means unmeasurable, never "stale". */
  servingStale: boolean;
  servingBehindMin: number | null;
}> {
  const snapshot = await gitPipelineSnapshot();
  const position = await gitPipelinePosition(
    { sha },
    { loadSnapshot: () => Promise.resolve(snapshot), loadDeploy: () => Promise.resolve(snapshot.deploy) },
  );
  return {
    deployed: !!position.targetSha && position.positions.deployed,
    targetSha: position.targetSha,
    deployedSha: position.deployedSha,
    // Only an AFFIRMATIVE `false` counts. `null` (no unit, unprobeable host) must read
    // as "not measured", never as staleness — inventing a warning from an absence is
    // the same defect in the opposite direction.
    servingStale: position.serving.startedSinceCodeChange === false,
    servingBehindMin: position.serving.behindMin,
  };
}

// ── deploy:await — "wake when my sha is live on :3070" ───────────────────────
defineTool({
  name: "deploy:await",
  description:
    "Sleep until a deploy lands (a staging sha reaches the live GREEN :3070 operator) instead of polling dev:pipeline_position. Arms awaits on BOTH release:deployed (success) and release:deploy-failed (failure) so you wake either way. Pass sha to target a specific commit; omit to wake on the next deploy of any sha. A targeted sha that is ALREADY live returns already_deployed immediately instead of registering a dead wait. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You left an edit in the tree and need it LIVE on :3070 before your next step — instead of re-polling dev:pipeline_position, arm this and end your turn.",
    notWhen:
      "Just checking where a change sits (not blocked on it) — that is dev:pipeline_position, one read. Forcing a deploy — release:deploy / the deploy-cli.",
    chaining:
      "deploy:await { sha } → end turn → on wake, payload.sha confirms which deploy landed; resume the work that needed it live.",
    seeAlso: [
      "events:catalog (all awaitable keys)",
      "dev:pipeline_position (a one-shot position read)",
      "events:await (the raw primitive)",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "Target commit sha; omit to wake on the next deploy of any sha (the global key).",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    const keys = [
      buildKey("deploy", { sha: args.sha }),
      buildKey("deploy-failed"),
    ];
    const note =
      args.note ??
      `deploy:await${args.sha ? ` ${args.sha}` : ""} — blocked until the deploy lands (or fails)`;

    if (args.sha) {
      const probe = await withBoundedTimeout(deployAlreadyLiveProbe(args.sha), {
        fallback: {
          deployed: false,
          targetSha: null,
          deployedSha: null,
          servingStale: false,
          servingBehindMin: null,
        },
        timeoutMs: 3_000,
        label: "deploy-await:alreadyDeployedLatch",
      });
      if (probe.value.deployed) {
        // EI-19448585641887174: the latch STILL fires when serving is stale, and that is
        // deliberate — its subject is key semantics, not liveness. `release:deployed:<sha>`
        // is emitted only for shas in the batch that ships them, so for an already-shipped
        // sha the wait is dead whatever the process is doing; suppressing the latch here
        // would re-open EI-18676050719521433 (a full-timeout sleep holding a work-item
        // claim). What was wrong was the CLAIM, not the latch: `serving` measures the
        // process against the LATEST deploy, not against this sha, so it cannot decide
        // whether to wait — only whether "live" is an honest word. So report it, and
        // point at the key that DOES mark restart-complete.
        const stale = probe.value.servingStale;
        const behind = probe.value.servingBehindMin;
        return reply({
          ok: true,
          already_deployed: true,
          event: keys[0],
          sha: probe.value.targetSha,
          deployedSha: probe.value.deployedSha,
          serving_stale: stale,
          advice: stale
            ? `${args.sha} is in the release checkout, but :3070 is NOT yet running it — the serving process started ` +
              `${behind === null ? "" : `~${behind}m `}BEFORE the code it serves, i.e. a deploy has swapped the files and has ` +
              `not restarted the process yet. Do NOT treat this as live. Waiting on "${keys[0]}" is still pointless (that ` +
              `key only fires for shas in a FUTURE deploy batch) — instead await the GLOBAL "release:deployed", which is ` +
              `emitted only after the restart AND its health probe pass, or re-read dev:pipeline_position and check ` +
              `serving.startedSinceCodeChange.`
            : `${args.sha} is ALREADY deployed (live on :3070) — its exact "${keys[0]}" key is emitted only for shas in a FUTURE deploy batch, so it can never re-fire for this one. Do not wait; proceed with the work that needed it live now.`,
        });
      }
    }

    // EI-19448585641887174: the UNTARGETED arm ("wake on the next deploy of any sha") has
    // no already-landed latch, and that is where the reported loss happened — an agent
    // armed this DURING a deploy, believing it would wake when that deploy finished, and
    // slept the full 900s. `release:deployed` is emitted at the very END of a deploy
    // (after the restart and its health probe), so for a deploy already past that point
    // the event has ALREADY fired and this await can only be satisfied by a LATER one.
    //
    // We ARM anyway rather than refuse — "wake me on the next deploy" is a legitimate
    // thing to want, and refusing would break it. What was missing is that the caller
    // was never TOLD, and by the time the silence is informative the window is gone.
    // EI-21537066270866278: deploy:await is a thin sugar over events:await, so
    // renewing it must preserve the primitive's EI-14225 one-shot semantics.
    // Retire this caller's prior pending success/failure pair before arming the
    // replacement; otherwise every idle-loop renewal leaks two registrations
    // and one deploy produces duplicate wakes.
    const mainWaitPlanReview = await mainWaitPlanReviewForWait({
      ownerId: resolveAgentIdentity(ctx).ownerId,
      event: keys[0],
      note: args.note,
    });
    if (mainWaitPlanReview && !mainWaitPlanReview.allowWait) {
      return { ...reply({ ok: false, error: mainWaitPlanReview.code, ...mainWaitPlanReview }), isError: true };
    }
    const armed = await armAwaits(ctx, keys, note, args.timeout_sec, {
      supersedeKeys: keys,
      timeoutBehavior: args.on_timeout,
    });
    if (!args.sha) {
      const flight = await withBoundedTimeout(readDeployInFlight(), {
        fallback: null,
        timeoutMs: 3_000,
        label: "deploy-await:inFlightArmWarning",
      });
      // Only an AFFIRMATIVE systemd reading warns. `systemd-unavailable` means the probe
      // could not measure, which must never be dressed up as "a deploy is running".
      const f = flight.value;
      if (f && f.active && f.source === "systemd") {
        return reply({
          ...armed,
          deploy_in_flight: {
            unit: f.unit,
            activeState: f.activeState,
            startedAtMs: f.startedAtMs,
            logPath: f.logPath,
          },
          warning:
            `A deploy is ALREADY RUNNING (${f.unit} is ${f.activeState}) and you armed an UNTARGETED await. ` +
            `"release:deployed" is emitted only at the END of a deploy — after the restart and its health probe — so if that ` +
            `deploy is already past its restart the event has ALREADY fired and this await will NOT wake for it; it will wait ` +
            `for the NEXT deploy. If what you wanted was "wake when the CURRENT deploy finishes", cancel this and check ` +
            `dev:pipeline_position instead: serving.startedSinceCodeChange flipping true is the restart actually completing. ` +
            `(A targeted deploy:await { sha } does not have this gap — it probes before arming.)`,
        });
      }
    }
    return reply({ ...armed, ...(mainWaitPlanReview ? { mainWaitPlanReview } : {}) });
  },
});

// EI-18676650746298156: checkpoint:await's candidateSha sibling to
// EI-18676050719521433's deploy-already-landed latch (deployAlreadyLiveProbe, above). A
// candidateSha binds via a payload predicate on a FUTURE `release:green`/
// `green-checkpoint:red` emit — a candidate ALREADY judged before the wait armed produces
// no future emit to match, so the caller would sleep the FULL (3h+) checkpoint timeout
// even though the verdict already exists.
//
// Unlike the deploy sibling this MUST be an exact-match probe against RECORDED verdicts
// (harness_shared.pipeline_events, kind='green_checkpoint'), never an ancestry/ready-pin
// check — WI-5685 is the OPPOSITE failure mode: a LATER candidate that still contains your
// commit must NOT short-circuit you, because its verdict is for a DIFFERENT candidate than
// the one you asked about. findGreenCheckpointVerdictForCandidate matches on the recorded
// `detail.candidate` exactly (prefix-safe both directions), so it can never conflate the
// two races. Best-effort + time-bounded, same contract as the deploy sibling: an
// unresolvable probe (timeout, no matching row) falls through to a normal registration,
// never blocks arming.
async function checkpointAlreadyJudgedProbe(
  candidateSha: string,
  installSlug: string | null,
  runId?: string,
): Promise<{ judged: boolean; green: boolean | null; status: string | null; createdAtMs: number | null }> {
  const match = await findGreenCheckpointVerdictForCandidate(installSlug, candidateSha, { runId });
  if (!match) return { judged: false, green: null, status: null, createdAtMs: null };
  // EI-21124809100423369: the early `decision-pending` row records the suite result
  // before optional promotion work settles. It is not a terminal verdict: while the
  // exact run is still active, treating its usually-false `detail.green` as a final red
  // latches stale remediation advice and skips the await that should catch the terminal
  // outcome. Leave the normal registration path armed for the eventual final row.
  if (match.status === "decision-pending" || match.detail.promotionPending === true) {
    return { judged: false, green: null, status: null, createdAtMs: null };
  }
  const rawGreen = match.detail.green;
  return {
    judged: true,
    green: typeof rawGreen === "boolean" ? rawGreen : null,
    status: match.status,
    createdAtMs: match.createdAtMs,
  };
}

// ── checkpoint:await — "wake when the green gate resolves" ────────────────────
defineTool({
  name: "checkpoint:await",
  description:
    // WI-5690-drain: trimmed from a 1180-char description (was over the 1600-char
    // hard cap at 1875 total) — the detailed WI-5685 race-condition explanation now
    // lives ONLY on the candidateSha arg's own .describe() (still full detail there,
    // uncounted by the prompt-weight budget), not duplicated here.
    "Sleep until the pipeline green-checkpoint resolves — arms awaits on release:green:<pipeline> (passed), green-checkpoint:red:<pipeline> (held), and green-checkpoint:inconclusive:<pipeline> (no verdict — a wedge; payload.reason names why). candidateSha (EI-12457) binds to your exact candidate; omit it to wake on any candidate and lineage-check payload.sha via release:trace — see the candidateSha arg for the WI-5685 race caveat (a later candidate containing your commit will NOT wake a sha-bound await). An already-judged candidateSha returns already_judged, not a dead wait. runId binds to the exact judging run (without pipeline: global keys filtered by runId). pipeline overrides; global:true = every co-hosted pipeline. Re-arming retires your prior pending wait. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You need the gate verdict — green (your change cleared into main) or held/red — before proceeding, instead of re-polling dev:pipeline_position / dev:build_status.",
    notWhen:
      "Waiting for the DEPLOY (past the gate, live on :3070) — that is deploy:await. Configuring the gate — release:checkpoint-config. Unsure your commit will be the EXACT judged candidate (a cron tick may race ahead) — omit candidateSha rather than bind to a sha that may never verdict; lineage-check with release:trace on wake.",
    chaining:
      "checkpoint:await { candidateSha } → end turn → on wake, payload tells you green (advanced) or red (payload.summary = failing tail) for this pipeline/candidate; resume or go fix the red.",
    seeAlso: [
      "events:catalog",
      "deploy:await (the next stage — live on :3070)",
      "release:trace (exact-SHA lineage check — use when you did NOT pass candidateSha)",
      "events:await",
    ],
  },
  requirePrincipal: false,
  // EI-20231798718160589: this handler only captures a wake handle and writes
  // coordination-plane awaits; it never reads ctx.tx. Do not hold the ambient
  // org-app transaction while registering the gate wait, or pool pressure can
  // make checkpoint:await time out before the registration runs.
  skipWorkspaceTx: true,
  // `release-fixer` is here because its own runbook mandates this verb: on a LEGACY
  // dispatch it must "wait for the real verdict (`checkpoint:await`)" instead of killing
  // a live run over a pessimistic quiet-cut prediction
  // (blueprints/base/prompts/release-fixer.md), and the `release-fix` blueprint declares
  // `checkpoint:await` in its `dependencies.tools`. It is NOT in SU_ROLES (it keeps its
  // native file/shell surface), so the spread alone denied a verb the prompt requires —
  // the six-recurrence class of EI-21988345999773689 / EI-21979521274634237 / WI-1179061.
  // ../../release/release-fixer-tool-contract.test.ts derives this pairing from the
  // prompt text, so dropping the role here fails that test rather than stranding a fixer.
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    pipeline: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Scope to ONE pipeline's gate — the repo basename of its integration root (e.g. 'papercusp'). " +
          "Omit to default to the current dev pipeline, unless runId is supplied (then global keys are " +
          "filtered to that exact run). Use global:true for the global keys, which wake " +
          "on EVERY co-hosted pipeline's verdict (EI-7646: you then must lineage-check payload.sha/payload.pipeline yourself).",
      ),
    candidateSha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "EI-12457: bind the wait to this exact candidate (full sha or a prefix) via a payload predicate on the " +
          "emitted payload.sha — a verdict for any OTHER candidate (a stale/superseded run) will NOT wake you; " +
          "you keep sleeping until the correct candidate resolves or the deadline. Strongly recommended whenever " +
          "you know which commit you are judging (e.g. right after a git-sync:await/deploy). WI-5685: this is an " +
          "EXACT match, not an ancestry check — a LATER candidate that still contains your commit (e.g. the hourly " +
          "cron races ahead and judges a newer tip) will NOT wake you even though its green verdict already covers " +
          "you. If a cron tick could plausibly land before your exact candidate does, omit candidateSha (wake on " +
          "ANY verdict for this pipeline) and confirm inclusion afterwards with release:trace instead of binding here. " +
          "EI-18676650746298156: if this EXACT candidate was already judged before you armed (recorded in " +
          "harness_shared.pipeline_events), you get already_judged:true immediately instead of sleeping to the " +
          "timeout — this is the same EXACT-match rule as above, so it can never be fooled by a later candidate " +
          "that merely contains your commit.",
      ),
    runId: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "WI-4957: bind further to the EXACT run (payload.runId, an exact match) that judged your candidate — " +
          "only needed when two runs might judge the SAME candidate sha (a re-fire, or a routine/manual race) " +
          "and you must not accept the other one's verdict. With no explicit pipeline, runId uses the global " +
          "event keys so the exact run can be awaited across co-hosted installs. Combines with candidateSha " +
          "(both must match); rarely needed on its own.",
      ),
    global: z
      .boolean()
      .optional()
      .describe(
        "Use the global release:green / green-checkpoint:red keys instead of the current pipeline's keys. Only for cross-pipeline monitors.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: checkpointTimeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    const pipeline = args.global
      ? undefined
      : (args.pipeline ??
        (args.runId ? undefined : await defaultCheckpointPipeline()));
    const keys = [
      buildKey("checkpoint", { pipeline }),
      buildKey("checkpoint-red", { pipeline }),
      // EI-19320479870270699: the third, non-judging outcome — armed alongside the
      // other two so "await the decision" covers every way the run can end.
      buildKey("checkpoint-inconclusive", { pipeline }),
      // EI-20689157831228179: the FOURTH outcome — the suite passed but a post-suite
      // gate withheld promotion (payload.reason names which). Without this a caller
      // slept to the full timeout on the single most actionable result the gate can
      // produce: the code fix worked, only promotion is blocked.
      buildKey("checkpoint-held", { pipeline }),
    ];
    const note =
      args.note ??
      `checkpoint:await${pipeline ? ` [${pipeline}]` : " [global]"}${args.candidateSha ? ` @ ${args.candidateSha.slice(0, 8)}` : ""}${args.runId ? ` (run ${args.runId.slice(0, 8)})` : ""} — blocked until the green gate resolves`;
    // WI-4957: candidateSha and runId compose into ONE AND-filter — a payload must satisfy
    // both when both are given (payloadMatchesFilter/evaluateDataCondition treats a
    // multi-key MatchMap as an implicit AND, same as every other predicate in this codebase).
    const payloadFilter =
      args.candidateSha || args.runId
        ? {
            ...(args.candidateSha ? { sha: { startsWith: args.candidateSha } } : {}),
            ...(args.runId ? { runId: args.runId } : {}),
          }
        : undefined;
    // WI-5685: this verb's OWN default (not the generic events:await one) — see
    // CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC's doc comment for why the generic 30min default
    // strands a caller mid-suite.
    const timeoutSec = args.timeout_sec ?? CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC;

    // EI-18676650746298156: the already-judged latch — see checkpointAlreadyJudgedProbe's
    // doc above. Only meaningful when candidateSha is given (an unbound wait has no exact
    // candidate to look up, exactly like deploy:await skipping its probe when sha is omitted).
    if (args.candidateSha) {
      const probe = await withBoundedTimeout(
        checkpointAlreadyJudgedProbe(args.candidateSha, args.global ? null : (pipeline ?? null), args.runId),
        {
          fallback: { judged: false, green: null, status: null, createdAtMs: null },
          timeoutMs: 3_000,
          label: "checkpoint-await:alreadyJudgedLatch",
        },
      );
      if (probe.value.judged && probe.value.green !== null) {
        const firedKey = probe.value.green ? keys[0] : keys[1];
        return reply({
          ok: true,
          already_judged: true,
          green: probe.value.green,
          status: probe.value.status,
          event: firedKey,
          candidateSha: args.candidateSha,
          judgedAtMs: probe.value.createdAtMs,
          advice: probe.value.green
            ? `${args.candidateSha} ALREADY resolved GREEN (status=${probe.value.status}) — its exact "${firedKey}" key already fired when this candidate was judged and will not re-fire for it. Do not wait; proceed with the work that needed the gate green now.`
            : `${args.candidateSha} ALREADY resolved HELD/RED (status=${probe.value.status}) — its exact "${firedKey}" key already fired when this candidate was judged and will not re-fire for it. Do not wait; go fix the red / handle the hold now (dev:pipeline_position / release:trace for the current failing-test detail).`,
        });
      }
    }

    // Capture the registration start before the durable rows are created. The
    // producer certificate is intentionally enriched only after registration;
    // otherwise a slow git/DB snapshot can make the caller time out before an
    // await exists at all.
    const mainWaitPlanReview = await mainWaitPlanReviewForWait({
      ownerId: resolveAgentIdentity(ctx).ownerId,
      event: keys[0],
      note: args.note,
    });
    if (mainWaitPlanReview && !mainWaitPlanReview.allowWait) {
      return { ...reply({ ok: false, error: mainWaitPlanReview.code, ...mainWaitPlanReview }), isError: true };
    }
    const registrationStartedAtMs = Date.now();
    const armed = await armAwaits(ctx, keys, note, timeoutSec, {
      payloadFilter,
      timeoutBehavior: args.on_timeout,
      // EI-12457: a re-await for this pipeline supersedes any prior pending
      // checkpoint-family wait this same subscriber still holds for it.
      supersedeKeys: keys,
    });

    if (pipeline) {
      try {
        const snapshot = await withBoundedTimeout(
          gitPipelineSnapshot(pipeline, { includeActiveRun: true }),
          {
            fallback: null,
            timeoutMs: CHECKPOINT_PRODUCER_ENRICHMENT_TIMEOUT_MS,
            label: "checkpoint-await:producerSnapshot",
          },
        );
        if (snapshot.value) {
          const certificate = checkpointProducerCertificate({
            pipeline,
            ...(args.candidateSha ? { candidateSha: args.candidateSha } : {}),
            ...(args.runId ? { runId: args.runId } : {}),
            ownerId: resolveAgentIdentity(ctx).ownerId,
            issuedAtMs: registrationStartedAtMs,
            expectedCadenceMs: CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC * 1000,
            verificationDeadlineMs: registrationStartedAtMs + timeoutSec * 1000,
            snapshot: snapshot.value,
          });
          await withBoundedTimeout(
            attachProducerHealthCertificate({ awaitIds: armed.await_ids, certificate }),
            {
              fallback: 0,
              timeoutMs: CHECKPOINT_PRODUCER_ENRICHMENT_TIMEOUT_MS,
              label: "checkpoint-await:producerCertificateAttach",
            },
          );
        }
      } catch {
        // The await rows are already durable. Keep them as plain timeout waits
        // if certificate construction or enrichment cannot complete.
      }
    }

    return reply(armed);
  },
});

// ── work-item:await — "wake on a work item's status change" ───────────────────
const WI_STATE_FAMILY: Record<string, string> = {
  done: "work-item-done",
  unblocked: "work-item-unblocked",
  blocked: "work-item-blocked",
  claimed: "work-item-claimed",
};

defineTool({
  name: "work-item:await",
  description:
    "Sleep until a work item changes status instead of polling work_items:get. With no `state`, arms the general work-item:status:<id> (ANY transition). With a single `state` (done|unblocked|blocked|claimed), arms only that specific key. The unblocked key requires a live `blocks` dependency edge; lifecycle-only blocked holds are refused because they cannot emit it. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You are blocked on a peer/dependency work item (its completion, unblock, or any transition) — arm this and end your turn instead of re-reading work_items:get.",
    notWhen:
      "Just inspecting an item once — work_items:get. Waiting on a PLAN item (P-NNN) — plan-item:await. Ambient interest in a topic — watch:create { targetKind:\"topic\", wake:false }.",
    chaining:
      'work-item:await { id: "WI-123", state: "done" } → end turn → on wake the item has settled; continue.',
    seeAlso: [
      "events:catalog",
      "work_items:get (one-shot read)",
      "plan-item:await",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    id: z.string().min(1).max(64).describe("The work-item id, e.g. WI-1234."),
    state: z
      .enum(["any", "done", "unblocked", "blocked", "claimed"])
      .optional()
      .describe(
        "Which transition to wake on. 'any' (default) = the general status key; a specific state arms only that key.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    const state = args.state ?? "any";
    const key =
      state === "any"
        ? buildKey("work-item", { id: args.id })
        : buildKey(WI_STATE_FAMILY[state], { id: args.id });
    // Registration LATCHES (EI-13095): the sugar used to bypass the latches the raw
    // events:await handler carries, so a wait armed AFTER the fact could only time
    // out. Same probes, same answers: state:'done' on an ALREADY-settled item ⇒
    // already_done (the done key fired at settle time and never re-fires);
    // state:'unblocked' on an item with no live blocker / settled ⇒
    // already_unblocked (the P-006 edge-key latch). Best-effort + time-bounded —
    // an 'unknown' probe arms normally.
    let unblockedProbe: LiveBlockedStateProbe | null = null;
    if (state === "done") {
      const probe = await withBoundedTimeout(liveSettledProbe(args.id), {
        fallback: { verdict: "unknown" as const },
        timeoutMs: 1_500,
        label: "work-item-await:doneLatch",
      });
      if (probe.value.verdict === "settled") {
        return reply({
          ok: true,
          already_done: true,
          event: key,
          item_state: probe.value.itemState ?? "settled",
          advice: `${args.id} is ALREADY settled (${probe.value.itemState ?? "terminal"}) — "${key}" fired when it settled and will not fire again. Do not wait; proceed now.`,
        });
      }
    } else if (state === "unblocked") {
      const probe = await withBoundedTimeout(liveBlockedState(args.id), {
        fallback: { verdict: "unknown" as const, dependencyState: "unknown" as const },
        timeoutMs: 1_500,
        label: "work-item-await:unblockedLatch",
      });
      unblockedProbe = probe.value;
      if (probe.value.verdict === "unblocked" || probe.value.verdict === "settled") {
        return reply({
          ok: true,
          already_unblocked: true,
          event: key,
          item_state: probe.value.verdict,
          lifecycle_state: probe.value.lifecycleState,
          dependency_state: probe.value.dependencyState,
          advice:
            probe.value.verdict === "settled"
              ? `${args.id} is already SETTLED — "${key}" will never fire. Do not wait on it.`
              : `${args.id} has NO live blocker right now — "${key}" fires only on a future blocked→unblocked edge. Proceed with the blocked work now.`,
        });
      }
      if (probe.value.verdict === "blocked" && probe.value.dependencyState === "unblocked") {
        return reply({
          ok: false,
          error: "unfirable_work_item_unblocked",
          firable: false,
          event: key,
          work_item_id: args.id,
          item_state: probe.value.lifecycleState,
          lifecycle_state: probe.value.lifecycleState,
          dependency_state: probe.value.dependencyState,
          advice:
            `${args.id} is lifecycle-${probe.value.lifecycleState} but has NO live blocker dependency edge. ` +
            `"${key}" fires only when the item's LAST live \`blocks\` edge clears, so this exact key cannot fire for the current shape and nothing was registered. ` +
            "Await work-item:done:<actual-blocker-id> instead (and keep a bounded fallback wake), or omit `state` to await the general lifecycle status key.",
        });
      }
    }
    const armed = await armAwaits(
      ctx,
      [key],
      args.note ?? `work-item:await ${args.id} (${state})`,
      args.timeout_sec,
      { timeoutBehavior: args.on_timeout },
    );
    if (unblockedProbe?.verdict === "blocked" && unblockedProbe.lifecycleState) {
      return reply({
        ...armed,
        item_state: unblockedProbe.lifecycleState,
        lifecycle_state: unblockedProbe.lifecycleState,
        dependency_state: unblockedProbe.dependencyState,
      });
    }
    return reply(armed);
  },
});

// ── service:await-up — "wake when a service recovers" ────────────────────────
defineTool({
  name: "service:await-up",
  description:
    "Sleep until a monitored service transitions back to HEALTHY (service:up:<name>) instead of re-polling dev:service_health. If it is already healthy, return immediately instead of arming a dead edge wait. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "A service you depend on is down and you need it back before proceeding — arm this and end your turn instead of re-polling dev:service_health.",
    notWhen:
      "A one-shot health check — dev:service_health. Restarting the service yourself — the systemctl/dev:restart path.",
    chaining:
      'service:await-up { name: "inference-gateway" } → end turn → on wake it is healthy; resume.',
    seeAlso: [
      "events:catalog",
      "dev:service_health (one-shot read)",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "The service name, e.g. inference-gateway / substrate-sidecar / git-sync.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    const event = buildKey("service-up", { name: args.name });
    const alreadyUp = await probeServiceUpLatch(args.name);
    if (alreadyUp) {
      return reply({
        ok: true,
        already_up: true,
        service: args.name,
        event,
        health: {
          status: alreadyUp.status,
          url: alreadyUp.url,
          note: alreadyUp.note,
        },
        advice: `Service "${args.name}" is already healthy according to a fresh probe. Do not wait on "${event}"; proceed now.`,
      });
    }

    const armed = await armAwaits(
      ctx,
      [event],
      args.note ?? `service:await-up ${args.name}`,
      args.timeout_sec,
      { timeoutBehavior: args.on_timeout },
    );

    // Close the registration-window race: a service can recover after the
    // pre-arm probe but before the row is registered (or while registration is
    // in flight). Cancel only this caller's row, and only while it is still
    // pending; if the transition already won the race, its durable wake wins.
    const recoveredDuringRegistration = await probeServiceUpLatch(args.name);
    const awaitId = armed.await_ids[0];
    if (recoveredDuringRegistration && awaitId != null) {
      let retired = false;
      try {
        retired = await cancelAwait({
          awaitId,
          subscriberId: resolveAgentIdentity(ctx).ownerId,
        });
      } catch {
        // Fail-soft: if the reconciliation write is unavailable, keep the
        // registration response honest and let the normal await path proceed.
      }
      if (retired) {
        return reply({
          ...armed,
          already_up: true,
          reconciled_after_register: true,
          service: args.name,
          event,
          health: {
            status: recoveredDuringRegistration.status,
            url: recoveredDuringRegistration.url,
            note: recoveredDuringRegistration.note,
          },
          advice: `Service "${args.name}" was already healthy when the wait was registered. The still-pending "${event}" await was retired; proceed now.`,
        });
      }
    }

    return reply(armed);
  },
});

// ── git-sync:await — "wake when my edit is committed" ────────────────────────
// EXPORTED (uniquely among this file's sugar verbs) so its argRedirects can be pinned
// by a unit test without standing up the projection registry: every other verb here is
// registered purely for its side effect, and a bare module import populates no registry,
// so there is otherwise no handle to assert against. See contract-repair-p008-scope-keys.test.ts.
export const gitSyncAwaitTool = defineTool({
  name: "git-sync:await",
  description:
    'Sleep until git-sync creates a LOCAL commit (git-sync:committed:<sha>) — the "is my edit committed locally yet" wait. Pass sha to target a commit; omit to wake on the next local git-sync commit. Then END YOUR TURN. The default timeout_sec (1800) already accounts for a slow cycle under heavy fleet concurrency (git-sync is a disk-bound op and can legitimately queue behind lock contention or host memory/IO pressure); a caller-set SHORT timeout_sec (e.g. 600 or less) risks firing on ordinary cadence variance, which reads as a false "host is broken" signal — prefer the default, or a longer explicit value, over a short one (EI-21915439526975712).',
  capability: "coord:write",
  guidance: {
    when: "You left an edit in the tree and your next step needs it COMMITTED LOCALLY — arm this and end your turn.",
    notWhen:
      "You need bridged-hive origin/staging proof — await git-sync:egressed:<sha> from events:catalog. You need it LIVE on :3070 (past commit → gate → deploy) — that is deploy:await. You own the commit yourself — you do not (git-sync owns the local commit).",
    chaining:
      "edit a file → git-sync:await → end turn → on wake it is a local commit; continue.",
    seeAlso: [
      "events:catalog",
      "dev:pipeline_position",
      'deploy:await (the later "live on :3070" stage)',
      "events:await",
    ],
    // EI-22381504248976138 / EI-21691010640177631 — the same key, filed twice: a caller
    // reaches this tool from the git-sync ROUTINE (routines:list, whose own selector is
    // `installSlug`, with `harness` only its compatibility alias) and carries that
    // spelling across. The rejection lists the accepted keys, and `harness` is in that
    // list — but the two filings still read the outcome as a schema/doc DRIFT ("discovery
    // advertises installSlug, live schema accepts harness"), because nothing on the
    // failure path says the two names are the SAME scope under different verbs.
    //
    // D-004 local form: `harness` is a declared key here, so this renders as a same-tool
    // RENAME rather than sending the caller to another tool.
    argRedirects: {
      installSlug:
        "harness — the same scope, spelled differently by the two verbs: routines:list selects the git-sync ROUTINE by `installSlug` (`harness` is only its alias), while this await selects the git-sync SCOPE by `harness`. RENAME the key rather than dropping it — a scope-less call with no `sha` is refused outright, and with a `sha` it waits on a GLOBAL commit event instead of your tree's",
      install_slug:
        "harness — this tool spells the scope `harness`. RENAME the key; snake_case is not accepted here, and dropping it changes what you wait on (no scope + no `sha` is refused; no scope WITH a `sha` waits globally)",
      workspace:
        "harness — git-sync commits are per-TREE, so the scope is the harness whose checkout you edited, not a workspace. RENAME the key. If you meant \"my edit reached origin\", that is a different event: await git-sync:egressed:<sha> via events:await",
    },
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    // EI-22377735399722977 — the scope is REQUIRED here for a sha-less wait, and
    // nothing said so before the refusal: the shared harnessArg text reads as
    // "a harness-scoped session supplies this automatically", which is true of
    // ordinary reads and false of this one. An operator-scope session carries the
    // `*` sentinel, which is not a concrete tree, so gitSyncAwaitScope() returns
    // null and the call is refused `harness_required` at the handler.
    harness: harnessArg.describe(
      "The harness whose CHECKOUT you edited — which tree's commit wakes you. REQUIRED unless you pass `sha`: an operator/workspace-scope session carries the `*` sentinel, not a concrete tree, so a sha-less wait with no harness is refused `harness_required` (pass the concrete slug, e.g. 'papercusp'). With a `sha` it is optional — the commit identity already scopes the wait — but omitting it there waits on the GLOBAL commit event, so keep it to stay bound to your own tree.",
    ),
    sha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe("Target commit sha; omit to wake on the next git-sync commit."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    const eventKey = buildKey("git-sync", { sha: args.sha });
    // EI-24719187042784648: git-sync emits only the FULL head sha, so a short sha (or any
    // non-sha suffix) arms a key that can never fire. Refuse it instead of hanging to timeout.
    const shaProblem = gitSyncShaSuffixProblem(eventKey);
    if (shaProblem) return gitSyncShaSuffixRefusal(eventKey, shaProblem, "git-sync:await");
    const scope = gitSyncAwaitScope(args.harness, ctx);
    if (!args.sha && !scope) return gitSyncScopeRequiredResult(eventKey, "git-sync:await");
    // A global commit event is emitted asynchronously. Capture the boundary before
    // registering the wait so an event produced by an earlier cycle but delayed in
    // the fire-and-forget queue cannot satisfy this new no-SHA wait.
    const registrationBoundaryMs = !args.sha ? Date.now() : undefined;
    const payloadFilter = scope
      ? {
          ...scope,
          ...(registrationBoundaryMs != null
            ? { committedAtMs: { gt: registrationBoundaryMs } }
            : {}),
        }
      : undefined;
    return reply(
      await armAwaits(
        ctx,
        [eventKey],
        args.note ?? "git-sync:await — blocked until locally committed",
        args.timeout_sec,
        payloadFilter
          ? { payloadFilter, timeoutBehavior: args.on_timeout }
          : { timeoutBehavior: args.on_timeout },
      ),
    );
  },
});

// ── plan-item:await — "wake when a plan item is done" ────────────────────────
defineTool({
  name: "plan-item:await",
  description:
    "Sleep until a plan item flips to done (plan-item:done:<slug>:<id>) instead of polling plans:get. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You are blocked on another plan item (a dependency P-NNN) finishing before you can proceed — arm this and end your turn instead of re-reading plans:get.",
    notWhen:
      "Inspecting a plan once — plans:get. Waiting on a WORK item (WI-NNN) — work-item:await.",
    chaining:
      'plan-item:await { slug, id: "P-014" } → end turn → on wake the item is done; continue.',
    seeAlso: [
      "events:catalog",
      "plans:get (one-shot read)",
      "work-item:await",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(200).describe("The plan slug."),
    id: z.string().min(1).max(16).describe("The plan item id, e.g. P-014."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("plan-item", { slug: args.slug, id: args.id })],
        args.note ?? `plan-item:await ${args.slug}:${args.id}`,
        args.timeout_sec,
        { timeoutBehavior: args.on_timeout },
      ),
    );
  },
});

// ── fleet:await-drained — "wake when my fleet's lanes are all done" ──────────
defineTool({
  name: "fleet:await-drained",
  description:
    "Sleep until every claimable item in a fleet's lanes is done (fleet:drained:<slug>) — the leader's \"wake me when the fleet drains so I can loop:end + write the scorecard\" wait — instead of re-checking the roster. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You lead a fleet and are waiting for it to finish all lanes before you loop:end + write the fleet-execution-health scorecard — arm this and end your turn instead of re-polling the roster each wake.",
    notWhen:
      "You still have leadership work to do this wake (directing members, acking pings). Checking roster once — fleet:status / coord:roster.",
    chaining:
      "fleet:await-drained { slug } → end turn → on wake the lanes are drained; loop:end + scorecard.",
    seeAlso: [
      "events:catalog",
      "fleet:status (one-shot roster)",
      "loop:end",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The fleet slug."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
    on_timeout: onTimeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("fleet-drained", { slug: args.slug })],
        args.note ?? `fleet:await-drained ${args.slug}`,
        args.timeout_sec,
        { timeoutBehavior: args.on_timeout },
      ),
    );
  },
});
