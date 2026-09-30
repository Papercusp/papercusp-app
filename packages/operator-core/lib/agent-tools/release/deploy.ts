/**
 * release:deploy — the agent-facing manual deploy lever + gate-unblock diagnosis
 * (release-pipeline-resilience-2026-06-09 P-015 / deploy-trigger-and-gate-unblock-2026-06-21).
 *
 * The gap it closes: deploy is AUTO-on-green only (no manual trigger), and the gate is
 * whole-tree all-or-nothing — so a gate-clean change is hostage to ANY red anywhere, with no
 * sanctioned expedite or escape (2026-06-21 incident: the work-item-ledger change was
 * gate-clean but couldn't reach :3070 for hours behind two UNRELATED reds).
 *
 * Ops (SAFE-by-default; deploy-trigger D-001/D-003):
 *   - status  — READ-ONLY. "What's blocking my deploy?" in one call: gate green/red, stalled/
 *               wedged, release-fixer status, how far the live :3070 is behind the green pin,
 *               and the decision-tree recommendation. Call this FIRST when a change isn't live.
 *   - trigger — expedite a GREEN-but-stalled deploy. Refuses unless there is green code ahead
 *               of the live deploy (it can only ever ship the green pin). Dry-run unless
 *               confirm:true. Audited.
 *   - force   — operator/queen/architect ONLY, loud + audited: deploy an UN-GREEN commit past a
 *               red gate. REQUIRES naming the red tests being accepted (acknowledgeRedTests) +
 *               a reason. The deliberate, rare escape for the no-users testing window — NEVER an
 *               agent's reflex. Prefer fixing the reds; quarantine a confirmed-unrelated red by
 *               hand; force last.
 *
 * The fire-path is a thin wrapper over the EXISTING deploy chokepoint
 * (apps/operator/lib/release/deploy-cli.ts) launched DETACHED — see release-deploy-launch.ts
 * for why (the deploy restarts the very :3070 operator hosting this tool). `quarantine` is
 * deliberately NOT an op here: per owner-confirmed deploy-trigger D-003 the tool wraps
 * deploy-cli (plan/execute/force) with no new gate-correctness logic, and quarantine edits the
 * protected quarantine.txt + must open a de-quarantine follow-up — an accountable by-hand /
 * release-fixer action (release-pipeline-resilience D-003), not a reflexive op. The guidance
 * below teaches fix-reds > quarantine-by-hand > owner-force.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { readIdentity } from '../locks/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { getOwnerDirective } from '../../owner-directives';
import { readDeployStatus, launchDetachedDeploy, integrationRoot, type DeployStatus, type DeployStatusReadStage } from '../../release-deploy-launch';
import { currentDiagnosticVintage } from '../../diagnostic-vintage';
import { fireGitSyncNow } from '../../harness/git-sync/git-sync-action';
import { operatorHomeHarnessSlug, canonicalHarnessSlug } from '../../harness/operator-home-harness';
import { recentPipelineEvents } from '../../harness/git-sync/pipeline-events';
import { withBoundedTimeout, type BoundedTimeoutResult } from '../../bounded-timeout';
import { statePlaneForDoor } from '../state-plane-door';
import { deployTriggerRefusalReason } from '../../release/deploy-trigger-refusal';
import { readGateOwnership, shouldStandDownForLivePeer, type CellOwnership } from '../../coord/gate-ownership';
import { executeWithGateActionReceipt } from '../../release/gate-action-receipt';
import {
  projectGateWaitOperationalBrief,
  renderGateWaitFactLines,
  type GateWaitOperationalBrief,
} from '../../operational-brief/gate-wait-brief';
import { renderOperationalBrief } from '../../operational-brief/brief';

const json = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/**
 * EI-20482937744589016 — THE SUBJECT STAMP. This tool reads exactly ONE pipeline: the
 * operator-HOME harness's release pipeline (its integration tree, its green-checkpoint, its
 * :3070). It is NOT harness-scoped and never has been — every other harness (SideStage and
 * any other registered hive) promotes staging→main on its OWN green-checkpoint, which these
 * numbers say nothing about.
 *
 * The defect this closes is a MISATTRIBUTION, not a wrong number: called from a SideStage
 * session the reply is a correct reading of the Papercusp pipeline that CARRIED NOTHING SAYING
 * SO — SHAs, a red-streak and a commit backlog that look exactly like an answer about the
 * caller's own harness. Filed after a WI-39128 session got Papercusp SHAs + a 98-commit
 * backlog while cwd and task were both SideStage, and again on 2026-08-17 (WI-39713) where it
 * nearly produced a false finding about SideStage's frozen origin/main.
 *
 * So every reply — status, refusal, dry-run, fire, and the degraded status_unavailable
 * envelope — names its subject, and a caller whose OWN harness differs gets a loud mismatch
 * alert beside it. A number that cannot be misattributed needs no reader to remember this.
 */
function releaseSubjectStamp(ctx: { harnessSlug?: string | null }) {
  const home = canonicalHarnessSlug(operatorHomeHarnessSlug());
  const subject = {
    harness: home,
    scope: 'operator-home-release-pipeline' as const,
    integrationRoot: integrationRoot(),
    note: `Every sha, gate verdict and deploy position in this reply describes the \`${home}\` operator release pipeline ONLY. Other harnesses run their own green-checkpoint and their own promotion — this reply is not evidence about them.`,
  };
  // `'*'` is the superuser wildcard and an absent slug is simply unknown: in neither case can
  // we assert a mismatch, so we stamp the subject and claim nothing more. Only a concrete,
  // different slug earns the alert (a retired alias is canonicalized first, so a `papercup`
  // caller against a `papercusp` home is correctly NOT a mismatch).
  const raw = ctx?.harnessSlug?.trim();
  const caller = raw && raw !== '*' ? canonicalHarnessSlug(raw) : null;
  if (!caller || caller === home) return { subject };
  return {
    subject,
    harnessMismatch: {
      callerHarness: caller,
      reportedHarness: home,
      warning: `⚠ CROSS-HARNESS READ — you called from harness \`${caller}\`, but release:deploy reports the \`${home}\` operator pipeline. These SHAs, gate reds and deploy positions are NOT \`${caller}\`'s and must not be quoted as its release truth: \`${caller}\` promotes on its OWN green-checkpoint. This tool has no \`${caller}\` mode; use that harness's own release surface.`,
    },
  };
}
type ReleaseSubjectStamp = ReturnType<typeof releaseSubjectStamp>;

/**
 * EI-20482937744589016 — an ASSERTION, not a selector. The filed defect names the schema
 * itself as half the trap: with no harness field at all, a caller has nowhere to state which
 * pipeline they believe they are asking about.
 *
 * ⚠ CORRECTED 2026-08-18 (measured, not assumed): an earlier draft of this comment claimed a
 * bare `{ op:'status', harness:'sidestage' }` would be SILENTLY STRIPPED and answered about
 * Papercusp. That is FALSE for this tool. The args schema is a strict `oneOf` with
 * `additionalProperties:false` on every branch, so the pre-fix build REFUSED the key outright
 * — verified live against the running pre-fix `:3070` (deployed sha 4824a92b):
 * `invalid_input: Unrecognized key: "harness"`. There was never a silent-misanswer window.
 *
 * So what this field actually buys is the QUALITY of the refusal, not the existence of one:
 * before, a caller stating their belief got an anonymous schema dump that never says WHICH
 * pipeline the tool reports; now they get a refusal that names the home harness and explains
 * the one-pipeline rule. It is deliberately not a way to target another harness — this
 * tool drives one pipeline and adding a real selector would be a different (and much larger)
 * change.
 */
const harnessAssertion = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL ASSERTION (not a selector): the harness you believe you are asking about. This tool ONLY ever reports the operator-home pipeline, so any other value is REFUSED rather than silently answered about the wrong harness. Omit it to accept the home pipeline.',
  );

/** Refuse a harness assertion naming anything but the one pipeline this tool can report. */
function harnessAssertionRefusal(op: 'status' | 'trigger' | 'force' | 'gate-history', asserted: string | undefined, stamp: ReleaseSubjectStamp) {
  const raw = asserted?.trim();
  if (!raw) return null;
  const want = canonicalHarnessSlug(raw);
  if (want === stamp.subject.harness) return null;
  return json({
    ok: false,
    op,
    refused: true,
    ...stamp,
    reason: `harness_not_reportable — you asserted harness \`${want}\`, but release:deploy can only ever report the \`${stamp.subject.harness}\` operator pipeline (it is not harness-scoped). Refusing rather than answering about a DIFFERENT harness than you asked for. \`${want}\` promotes on its own green-checkpoint; read its release state there.`,
  });
}

/**
 * The status operation is a liveness diagnostic, so it must return a terminal
 * envelope before the MCP client's transport deadline even when one of its
 * read-only dependencies stalls under load. The underlying read is not
 * cancellable; withBoundedTimeout deliberately degrades the caller while
 * swallowing the late result/rejection.
 */
export const RELEASE_STATUS_READ_TIMEOUT_MS = 20_000;

/** A pre-launch observation is useful audit evidence, but is not an atomic claim receipt. */
async function deployGateOwnershipReceipt(callerOwnerId: string) {
  try {
    const ownership = await readGateOwnership();
    return {
      standDown: shouldStandDownForLivePeer(ownership, callerOwnerId),
      receipt: {
        certainty: ownership.claimState === 'held' && ownership.workItem
          ? 'prelaunch-observation' as const
          : 'unknown' as const,
        observedAt: new Date().toISOString(),
        conditionKey: ownership.eventKey,
        workItem: ownership.workItem,
        holder: ownership.takenBy,
        takenAt: ownership.takenAt,
        claimState: ownership.claimState,
        assessment: ownership.assessment,
        unknownReason: ownership.unknown?.code ?? (ownership.workItem ? null : 'no-held-condition'),
      },
    };
  } catch (error) {
    return {
      standDown: false,
      receipt: {
        certainty: 'unknown' as const,
        observedAt: new Date().toISOString(),
        conditionKey: null,
        workItem: null,
        holder: null,
        takenAt: null,
        claimState: null,
        assessment: null,
        unknownReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function validateForceOwnerSignoff(ref: string, commit: string): Promise<
  { ok: true; directiveId: number; sourceTurnRef: string | null } |
  { ok: false; reason: string }
> {
  const match = /^owner-directive:([1-9]\d*)$/.exec(ref);
  if (!match) return { ok: false, reason: 'owner_signoff_reference_unverifiable' };
  try {
    const directive = await getOwnerDirective(Number(match[1]));
    if (!directive || directive.workspaceId !== activeWorkspaceId() || !directive.capturedByHook) {
      return { ok: false, reason: 'owner_signoff_not_owner_captured' };
    }
    const words = directive.verbatimText.toLowerCase();
    if (!/\bforce\b/.test(words) || !/\bdeploy\b/.test(words) ||
        !words.includes(commit.slice(0, 12).toLowerCase())) {
      return { ok: false, reason: 'owner_signoff_does_not_name_force_target' };
    }
    return { ok: true, directiveId: directive.id, sourceTurnRef: directive.sourceTurnRef };
  } catch {
    return { ok: false, reason: 'owner_signoff_read_unavailable' };
  }
}

/** The subset of the status surfaced in tool replies (full status under `status`). */
function statusBrief(s: DeployStatus) {
  return {
    state: s.state,
    // WI-4489: `verdictStale` rides alongside the red count on purpose — a bare `consecutiveReds: 4`
    // reads as "the gate is red NOW", which is exactly the misread that sends agents to fix already-
    // green tests. When it is stale, say so where the count is shown.
    gate: {
      green: s.gate.green,
      consecutiveReds: s.gate.consecutiveReds,
      fireStale: s.gate.fireStale,
      verdictStale: s.gate.verdictStale,
      ...(s.gate.verdictStale ? { verdictStaleReason: s.gate.verdictStaleReason } : {}),
      // EI-10902: "what did the last tick decide, and on what code?" — surfaced here too so a
      // trigger/force reply carries the same answer without a follow-up op:status call.
      ...(s.gate.failingTests.length ? { failingTests: s.gate.failingTests } : {}),
      repairQueue: s.gate.repairQueue ?? null,
      repairQueueRead: s.gate.repairQueueRead,
      // WI-2141736 P-004: rides in every reply beside `repairQueue`, because the question it
      // answers — "is the freeze actually on, and if not why not" — is invisible through a
      // null queue, which is what a retire and an owner-set OFF both leave behind. Measured
      // 2026-09-02: 20 retirements, 0 resumes, evidenced only by grepping run logs.
      freezeAndConverge: s.gate.freezeAndConverge ?? null,
      lastVerdict: s.gate.lastVerdict,
    },
    deployedBehindGreenPin: s.deploy.deployedBehindGreenPin,
    // EI-18724155280048738: rides in EVERY reply (status, refusal, dry-run, fire) because the
    // question it answers — "is a deploy already running?" — is exactly the one a caller who got
    // a transport error instead of a result comes back to ask.
    deployInFlight: s.deployInFlight,
    // EI-20234052054064013: a live checkpoint (including an in-process auto-refire) is the
    // authoritative answer to "should I fire another checkpoint?" — carry it in every reply.
    checkpointRunInFlight: s.checkpointRunInFlight,
    // P-009: the compact, current execution truth. This is intentionally separate from
    // gate.green/red because running, paused, blocked, and idle are not code verdicts.
    checkpoint: s.checkpoint,
    manualRunAuthority: s.manualRunAuthority,
    // EI-20512352412751871: every refusal/dry-run reply must carry the exact
    // release-trigger control that made an ordinary deploy safe or blocked.
    releaseTrigger: s.releaseTrigger,
    diagnosticVintage: currentDiagnosticVintage({
      stagingHeadSha: s.deploy.stagingHeadSha,
      greenPinSha: s.deploy.greenPinSha,
    }),
    canTriggerGreen: s.canTriggerGreen,
    recommendation: s.recommendation,
  };
}

const GATE_OWNERSHIP_READ_TIMEOUT_MS = 5_000;

/**
 * P-009 (spec OP-BRIEF-P009-GATE): the deploy/gate wait operational brief, projected from the
 * status read already in hand plus the gate-ownership cell. A failed or slow ownership read
 * yields an explicit unknown owner naming the failure — never a silent "unowned".
 */
export async function gateWaitBriefFor(
  status: DeployStatus,
  readOwnership: () => Promise<CellOwnership> = () => readGateOwnership(),
): Promise<GateWaitOperationalBrief & { text: string }> {
  let ownership: CellOwnership | null = null;
  let ownershipReadError: string | undefined;
  try {
    const read = await withBoundedTimeout(readOwnership, {
      fallback: null,
      timeoutMs: GATE_OWNERSHIP_READ_TIMEOUT_MS,
      label: 'release:deploy:gate-ownership',
    });
    ownership = read.value;
    if (read.degraded || !read.value) {
      // withBoundedTimeout converts a thrown read into { degraded, errorMessage } — name it.
      ownershipReadError = read.errorMessage
        ? `gate ownership read failed: ${read.errorMessage}`
        : `gate ownership read returned nothing within ${GATE_OWNERSHIP_READ_TIMEOUT_MS}ms`;
    }
  } catch (error) {
    ownershipReadError = `gate ownership read failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const brief = projectGateWaitOperationalBrief({ status, ownership, ownershipReadError });
  return { ...brief, text: [renderOperationalBrief(brief), ...renderGateWaitFactLines(brief)].join('\n') };
}

type StatusReadResult = BoundedTimeoutResult<DeployStatus | null> & { pendingReads: DeployStatusReadStage[] };

async function readStatusBounded(readerOwnerId: string | null): Promise<StatusReadResult> {
  let pendingReads: DeployStatusReadStage[] = [];
  const result = await withBoundedTimeout(() => readDeployStatus({
    readerOwnerId,
    onReadProgress: (pending) => {
      pendingReads = pending;
    },
  }), {
    fallback: null,
    timeoutMs: RELEASE_STATUS_READ_TIMEOUT_MS,
    label: 'release:deploy:status',
  });
  return { ...result, pendingReads };
}

function statusUnavailable(
  op: 'status' | 'trigger' | 'force',
  read: StatusReadResult,
  stamp: ReleaseSubjectStamp,
) {
  const timedOut = read.reason === 'timeout';
  return json({
    ok: false,
    op,
    ...stamp,
    error: {
      code: timedOut ? 'status_timeout' : 'status_unavailable',
      message: timedOut
        ? `release status did not complete within ${RELEASE_STATUS_READ_TIMEOUT_MS}ms; retry the read before taking a deploy action`
        : `release status could not be read${read.errorMessage ? `: ${read.errorMessage}` : ''}`,
      retryable: true,
      elapsedMs: read.elapsedMs,
      ...(timedOut ? { timeoutMs: RELEASE_STATUS_READ_TIMEOUT_MS } : {}),
      ...(timedOut ? { pendingReads: read.pendingReads } : {}),
    },
    status: null,
  });
}

/**
 * Checkpoint and deploy logs are ordinary files, not journal units. Return a
 * ready-to-call capability handle beside each path so a caller cannot
 * accidentally feed the path back into `logs:read` (EI-20200101026196583).
 * Keep the default tail bounded: the caller can request a different window
 * after following the handle.
 */
const RELEASE_LOG_TAIL_LINES = 200;

function fileReadHandle(logPath: string) {
  return {
    tool: 'capability:read' as const,
    args: { file_path: logPath, tail: RELEASE_LOG_TAIL_LINES },
  };
}

function attachFileReadHandles(status: DeployStatus): DeployStatus {
  const lastVerdict = status.gate.lastVerdict?.logPath
    ? { ...status.gate.lastVerdict, read: fileReadHandle(status.gate.lastVerdict.logPath) }
    : status.gate.lastVerdict;
  const deployInFlight = status.deployInFlight?.logPath
    ? { ...status.deployInFlight, read: fileReadHandle(status.deployInFlight.logPath) }
    : status.deployInFlight;
  const checkpointRunInFlight = status.checkpointRunInFlight && typeof status.checkpointRunInFlight.logPath === 'string' && status.checkpointRunInFlight.logPath
    ? { ...status.checkpointRunInFlight, read: fileReadHandle(status.checkpointRunInFlight.logPath) }
    : status.checkpointRunInFlight;

  return {
    ...status,
    gate: { ...status.gate, lastVerdict },
    deployInFlight,
    checkpointRunInFlight,
  };
}

export default defineTool({
  name: 'release:deploy',
  profile: 'engineer',
  description:
    'Deploy diagnosis and manual levers for a committed change not live on :3070. status reads gate/deploy state and recommends an action; gate-history reads recent checkpoint ticks; trigger expedites a green-but-stalled deploy (confirm:true); force is an audited, role-gated un-green escape (acknowledgeRedTests + reason). Actions run detached; use git-sync:run separately.',
  guidance: {
    when:
      'A committed, gate-clean change isn\'t live on :3070 — {op:status} to see why. GREEN-but-stalled → {op:trigger,confirm:true} (safe; only ships the green pin). Gate RED on UNRELATED tests → FIX the reds first (even out of lane).',
    notWhen:
      'Never force as a reflex to "get my change out" — force ships KNOWN-BROKEN code (route-around-the-broken-thing); owner/operator-gated, no-users window only. Prefer fix-reds > quarantine-a-confirmed-unrelated-red-by-hand > owner-force; never silently wait. Threshold tuning → release:checkpoint-config; per-path probe → dev:pipeline_position.',
    chaining:
      'dev:pipeline_position{path} → release:deploy{op:status}. Read returned *.read handles with capability:read; they are files, not journal units. For checkpointRunInFlight, active:true + heldExternally:true confirms a live external runner. If systemd.appliesToActiveRun:false, a missing unit is not evidence it ended. Null or unchanged progressAtMs means no advancing heartbeat was observed, not proof of a stall. Do not fire a duplicate checkpoint from these fields. Trigger only when green-but-stalled; otherwise fix reds.',
    seeAlso: [
      'release:checkpoint-run (re-run the gate verdict before deploying)',
      'dev:pipeline_position (locate your commit in the pipeline first)',
      'release:checkpoint-config (the gate config)',
      'capability:read (read the file log via the `read` handle returned in status)',
    ],
  },
  capability: 'operator:write',
  // The status branch only reads pipeline state; trigger/force remain writes. Keep the
  // static effect as `write` so unknown or malformed calls stay behind the dry-run gate.
  effectForCall: (args) => (args.op === 'status' || args.op === 'gate-history' ? 'read' : 'write'),
  requirePrincipal: false,
  // EI-18761103623054929: the default dispatch-stack tool timeout is 60s (dispatch-stack.ts:
  // `exec.timeoutSec = exec.tool.timeoutSec ?? 60`) — too short for THIS tool specifically.
  // `trigger`/`force` synchronously await fireGitSyncNow (see the EI-18733783500981433 comment
  // below) before launching, and that fire-and-refresh is NOT bounded by "tens of seconds" under
  // real load: measured live 2026-07-26 21:56-21:58 EDT (coming off 5 consecutive gate reds with
  // 60 commits stranded, i.e. git-sync itself had a large backlog to work through), 4 of 5
  // consecutive `trigger` calls took 83s / 96s / 177s / 61s — all past the 60s default, each
  // surfacing as a spurious `timeout` (or, on a direct MCP call, a raw transport
  // "write CONNECTION_CLOSED") even though the underlying deploy launch itself succeeded. Raising
  // the budget (same fix shape as dev:restart's own slow drain-then-restart, `timeoutSec:
  // MAX_DRAIN_SEC + 30`) lets the legitimately-slow-but-real operation finish inside its own
  // timeout instead of being cut off by an unrelated, too-short default. 300s comfortably covers
  // every measured duration above with margin; this is a rare, human/agent-initiated expedite
  // lever, never a hot loop, so a generous ceiling costs nothing.
  timeoutSec: 300,
  // EI-18733783500981433: `trigger`/`force` await fireGitSyncNow + readDeployStatus (git-sync
  // fire-and-refresh can itself take tens of seconds) before launching the detached deploy, and
  // never read ctx.tx (only ctx.role / ctx.principal-derived identity). Without this, the host's
  // ambient workspace transaction sits idle for that whole stretch and gets killed by Postgres's
  // idle_in_transaction_session_timeout (60s) — surfacing as a bare
  // "write CONNECTION_CLOSED 127.0.0.1:6432" transport error even though the deploy itself
  // launched successfully (this is exactly the false-negative EI-18724155280048738 had to work
  // around with the deployInFlight in-flight check). Confirmed live: 100% of
  // tools:invoke→release:deploy CONNECTION_CLOSED failures in the trailing 12h clustered at
  // ~60s duration. Same fix as capability:bash (EI-18666279107998059) — see
  // ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // Broad invoke allowlist (status is the read every role reaches for); the WRITE ops self-gate
  // inside the handler (trigger needs confirm; force needs operator-config-write role).
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('status'),
      harness: harnessAssertion,
      operationalBrief: z
        .boolean()
        .optional()
        .describe(
          'Add `operationalBrief`: verdict, pin, gate owner, next available lever and deadline projected from this read; unmeasured fields are explicit `unknown`.',
        ),
    }),
    z.object({
      op: z.literal('gate-history'),
      harness: harnessAssertion,
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many recent green-checkpoint ticks to return, newest first. Default 6.'),
    }),
    z.object({
      op: z.literal('trigger'),
      harness: harnessAssertion,
      confirm: z.boolean().optional().describe('false/absent ⇒ DRY RUN (preview what would deploy). true ⇒ fire the detached green deploy.'),
    }),
    z.object({
      op: z.literal('force'),
      harness: harnessAssertion,
      reason: hardText(LIMITS.SHORT_TITLE, { min: 8 }).describe('Why a force (un-green) deploy is justified — loudly audited.'),
      ownerSignoffRef: z.string().min(8).max(200).optional().describe(
        'For confirm:true, a caller-supplied owner authorization reference. Required before a force deploy can launch; this tool records but does not validate the cited authorization.',
      ),
      acknowledgeRedTests: z
        .array(z.string().min(1))
        .min(1)
        .describe('The specific red test(s)/failure(s) you are KNOWINGLY shipping past — naming them is required.'),
      commit: z
        .string()
        .regex(/^[0-9a-fA-F]{7,40}$/)
        .optional()
        .describe('The commit sha to ship past the red gate. Omitted ⇒ the current staging HEAD (shown in the dry-run preview).'),
      confirm: z.boolean().optional().describe('false/absent ⇒ DRY RUN. true ⇒ fire the detached force deploy.'),
    }),
  ]),
  async handler(args, ctx) {
    // EI-20482937744589016: resolve the subject BEFORE any read — every exit below (refusal,
    // degraded envelope, dry-run, fire) must name which pipeline it is about, and a caller
    // asserting a different harness is refused before we do any work at all.
    const stamp = releaseSubjectStamp(ctx as { harnessSlug?: string | null });
    const wrongHarness = harnessAssertionRefusal(args.op, args.harness, stamp);
    if (wrongHarness) return wrongHarness;
    // ── gate-history: read-only, independent of deploy status ──
    // WI-5377: op:status's `gate.lastVerdict` (EI-10902) answers "what did the LAST tick
    // decide?" — this answers "what did the last N ticks decide?", the small history read
    // that item's own follow-up deferred. Reuses the SAME append-only source
    // (harness_shared.pipeline_events, mig 177) and the SAME per-tick shape `lastVerdict`
    // already exposes, just plural and with `failingTests` threaded per-tick (lastVerdict
    // deliberately omits it — that field is the ROLLING gate_health.failingTests, a
    // different, CURRENT-only source). Placed before readStatusBounded/readIdentity
    // deliberately: this read needs neither, so a slow/degraded deploy-status read must
    // never fail a call that only wants gate history.
    if (args.op === 'gate-history') {
      const limit = args.limit ?? 6;
      const rows = await recentPipelineEvents(stamp.subject.harness, limit, undefined, {
        kinds: ['green_checkpoint'],
      });
      const ticks = rows.map((r) => ({
        tickAtMs: r.createdAtMs,
        candidate: typeof r.detail?.candidate === 'string' ? r.detail.candidate : null,
        from: typeof r.detail?.from === 'string' ? r.detail.from : null,
        status: r.status,
        failingTests: Array.isArray(r.detail?.failingTests)
          ? r.detail.failingTests.filter((t): t is string => typeof t === 'string')
          : [],
        logPath: typeof r.detail?.logPath === 'string' ? r.detail.logPath : null,
      }));
      const payload = { ok: true, op: 'gate-history' as const, ...stamp, limit, ticks };
      const plane = statePlaneForDoor(payload, 'release:deploy', args, ctx);
      return json({ ...payload, ...(plane ? { plane } : {}) });
    }
    const identity = readIdentity(ctx);
    // ── status: read-only, always allowed ──
    // EI-20262656218311418: readDeployStatus fans out to PG/systemd and can outlive the MCP
    // transport. Return a structured, retryable envelope instead of allowing an empty response.
    const statusRead = await readStatusBounded(identity.ownerId);
    if (statusRead.degraded || !statusRead.value) {
      return statusUnavailable(args.op, statusRead, stamp);
    }
    let status = statusRead.value;
    if (args.op === 'status') {
      const payload = {
        ok: true,
        op: 'status',
        ...stamp,
        ...attachFileReadHandles(status),
        diagnosticVintage: currentDiagnosticVintage({
          stagingHeadSha: status.deploy.stagingHeadSha,
          greenPinSha: status.deploy.greenPinSha,
        }),
        ...(args.operationalBrief ? { operationalBrief: await gateWaitBriefFor(status) } : {}),
      };
      const plane = statePlaneForDoor(payload, 'release:deploy', args, ctx);
      return json({ ...payload, ...(plane ? { plane } : {}) });
    }

    const actor = `${identity.ownerLabel} (role:${ctx.role ?? 'unknown'})`;
    // Step 0 (WI-1320): a REAL (confirmed) deploy commits the latest staging FIRST via git-sync,
    // so it ships CURRENT work — not a stale tree when git-sync is lagging/wedged (the
    // force-deploy-ships-stale-staging asymmetry). Best-effort (never block the deploy on it),
    // then re-read status because staging HEAD may have advanced (force resolves stagingHeadSha).
    // A dry-run (confirm absent/false) does NOT commit — it only previews.
    // Reuse the bounded read above; a second unbounded read would both redeclare `status`
    // and recreate the transport-timeout failure this guard is meant to prevent.
    // An explicit force commit is already an immutable deploy target. Running git-sync before
    // that launch cannot change what will ship; it only delays systemd-run behind an unrelated,
    // potentially long git pipeline. EI-21235497883261126 reproduced the concrete failure:
    // two exact-SHA force calls exhausted the caller's 30s transport budget inside this step
    // and never reached launchDetachedDeploy. Keep the freshness step for trigger and for an
    // implicit force target (where staging HEAD is the target), but launch an explicit commit
    // immediately.
    const explicitForceCommit = args.op === 'force' && args.commit !== undefined;
    if ((args as { confirm?: boolean }).confirm === true && !explicitForceCommit) {
      // Wrap the WHOLE step (slug resolution + fire + re-read) — it must NEVER fail the deploy.
      try {
        await fireGitSyncNow(operatorHomeHarnessSlug(), activeWorkspaceId());
        const refreshed = await readStatusBounded(identity.ownerId);
        if (!refreshed.degraded && refreshed.value) status = refreshed.value;
      } catch (e) {

        console.warn('[release:deploy] pre-deploy git-sync fire failed (continuing with current staging):', (e as Error)?.message);
      }
    }

    // ── trigger: expedite a GREEN-but-stalled deploy ──
    if (args.op === 'trigger') {
      // P-009: the refusal decision lives in ONE pure predicate so the gate-wait operational
      // brief reports the deploy lever from the same code this handler refuses on.
      const triggerRefusal = deployTriggerRefusalReason(status);
      if (triggerRefusal !== null) {
        return json({
          ok: false,
          op: 'trigger',
          refused: true,
          ...stamp,
          reason: triggerRefusal,
          status: statusBrief(status),
        });
      }
      if (!args.confirm) {
        return json({
          ok: true,
          op: 'trigger',
          dry_run: true,
          ...stamp,
          would_deploy: { greenPinSha: status.deploy.greenPinSha, commitsAhead: status.deploy.deployedBehindGreenPin },
          note: 'Pass confirm:true to fire the detached green deploy (restarts :3070; only ships the green pin). The deploy reports its own outcome (broadcast + pipeline event + release:deployed/deploy-failed events).',
          status: statusBrief(status),
        });
      }
      const gateOwnership = await deployGateOwnershipReceipt(identity.ownerId);
      if (gateOwnership.standDown) {
        ctx.metadata?.({ gateActionReceipt: {
          schemaVersion: 1, action: 'deploy-trigger', callerOwnerId: identity.ownerId,
          ownership: gateOwnership.receipt, effect: { status: 'refused-live-peer' },
        } });
        return json({ ok: false, op: 'trigger', refused: true, ...stamp,
          reason: 'gate_condition_claimed_by_live_peer', ownership: gateOwnership.receipt });
      }
      const accepted = await executeWithGateActionReceipt({
        action: 'release:deploy', actor, ownerId: identity.ownerId,
        conditionKey: gateOwnership.receipt.conditionKey ?? '',
        allowUnowned: true,
        target: { op: 'trigger', greenPinSha: status.deploy.greenPinSha },
        run: () => launchDetachedDeploy({}),
        summarize: (effect) => ({ status: effect.launched ? 'detached-launch-accepted' : 'not-launched',
          unit: effect.unit ?? null, reason: effect.reason ?? null, deployedSha: 'unknown' }),
      });
      if (!accepted.ok) {
        ctx.metadata?.({ gateActionReceipt: { schemaVersion: 2, action: 'deploy-trigger',
          callerOwnerId: identity.ownerId, receiptId: accepted.receiptId,
          effect: { status: accepted.effectMayHaveRun ? 'unknown' : 'refused', reason: accepted.reason } } });
        return json({ ok: false, op: 'trigger', refused: !accepted.effectMayHaveRun, ...stamp,
          reason: accepted.reason, receiptId: accepted.receiptId, effectMayHaveRun: accepted.effectMayHaveRun });
      }
      const launch = accepted.effect;
      ctx.metadata?.({ gateActionReceipt: {
        schemaVersion: 2, action: 'deploy-trigger', callerOwnerId: identity.ownerId,
        receiptId: accepted.receiptId,
        ownership: { ...gateOwnership.receipt, ...accepted.ownership }, target: { greenPinSha: status.deploy.greenPinSha },
        effect: { status: launch.launched ? 'detached-launch-accepted' : 'not-launched', unit: launch.unit ?? null,
          reason: launch.reason ?? null, deployedSha: 'unknown' },
      } });
      // The committed audit intent survives a process restart. Its settlement
      // and the claim-row lock complete before this response is returned.
      return json({
        ok: launch.launched,
        op: 'trigger',
        ...stamp,
        launched: launch.launched,
        unit: launch.unit,
        logPath: launch.logPath,
        ...(launch.reason ? { reason: launch.reason } : {}),
        // EI-18724155280048738: both notes name the ONE authoritative re-check. The failure note
        // no longer hedges ("likely") — a duplicate-unit refusal IS the in-flight guard firing,
        // and op:status now proves it instead of leaving the caller to guess with `ps`.
        note: launch.launched
          ? 'Green deploy started (detached). Watch /admin/git or await release:deployed / deploy-failed — this connection survives (the deploy restarts :3070, not this tool). IF THIS CALL RETURNED A TRANSPORT ERROR INSTEAD OF THIS RESULT: the deploy still launched. Do NOT re-trigger — confirm with release:deploy{op:status}, whose `deployInFlight.active` reads the systemd unit and is authoritative from the moment of launch. A `ps` check is NOT a valid discriminator: the deploy-cli process tree only becomes visible ~20s in, so an immediate `ps` false-negatives.'
          : 'Deploy NOT launched — a deploy is already in flight (the manual lever + auto-serve share one transient unit, so one deploy runs at a time; this refusal IS that guard working, not a fault). Confirm and watch it via release:deploy{op:status} → `deployInFlight`.',
      });
    }

    // ── force: operator-gated un-green escape ──
    // args.op === 'force'
    if (!isOperatorConfigWriteRole(ctx.role)) {
      return json({
        ok: false,
        op: 'force',
        refused: true,
        ...stamp,
        reason: `role_forbidden — release:deploy{op:force} requires operator, mug, or architect role (you are role:${ctx.role ?? 'unknown'}). Forcing ships KNOWN-BROKEN code; it is an owner-authorized escape, never an agent's reflex. Prefer fixing the reds.`,
        status: statusBrief(status),
      });
    }
    const commit = args.commit ?? status.deploy.stagingHeadSha ?? undefined;
    if (!commit) {
      return json({
        ok: false,
        op: 'force',
        refused: true,
        ...stamp,
        reason: 'no_commit — could not resolve the staging HEAD to force-deploy; pass an explicit `commit` sha.',
        status: statusBrief(status),
      });
    }
    if (!args.confirm) {
      return json({
        ok: true,
        op: 'force',
        dry_run: true,
        ...stamp,
        would_force_deploy: {
          commit,
          acknowledgeRedTests: args.acknowledgeRedTests,
          reason: args.reason,
          currentGate: statusBrief(status),
        },
        warning:
          'FORCE ships an UN-GREEN commit past the gate (KNOWN-BROKEN code). This is the rare no-users-window escape — prefer fixing the reds. Pass confirm:true to fire; the action is loudly audited + notifies the owner.',
      });
    }
    if (!args.ownerSignoffRef) {
      ctx.metadata?.({ gateActionReceipt: {
        schemaVersion: 1, action: 'deploy-force', callerOwnerId: identity.ownerId,
        target: { commit, ownerSignoffRef: null }, effect: { status: 'refused-missing-owner-signoff' },
      } });
      return json({ ok: false, op: 'force', refused: true, ...stamp,
        reason: 'owner_signoff_reference_required', commit });
    }
    const ownerSignoff = await validateForceOwnerSignoff(args.ownerSignoffRef, commit);
    if (!ownerSignoff.ok) {
      ctx.metadata?.({ gateActionReceipt: { schemaVersion: 2, action: 'deploy-force',
        callerOwnerId: identity.ownerId, target: { commit, ownerSignoffRef: args.ownerSignoffRef },
        effect: { status: 'refused-owner-signoff', reason: ownerSignoff.reason } } });
      return json({ ok: false, op: 'force', refused: true, ...stamp,
        reason: ownerSignoff.reason, commit });
    }
    const gateOwnership = await deployGateOwnershipReceipt(identity.ownerId);
    if (gateOwnership.standDown) {
      ctx.metadata?.({ gateActionReceipt: {
        schemaVersion: 1, action: 'deploy-force', callerOwnerId: identity.ownerId,
        ownership: gateOwnership.receipt, effect: { status: 'refused-live-peer' },
      } });
      return json({ ok: false, op: 'force', refused: true, ...stamp,
        reason: 'gate_condition_claimed_by_live_peer', ownership: gateOwnership.receipt });
    }
    // The audit intent must commit and the claim row must be locked before a
    // notification can truthfully say a force deploy was triggered.
    const accepted = await executeWithGateActionReceipt({
      action: 'release:deploy', actor, ownerId: identity.ownerId,
      conditionKey: gateOwnership.receipt.conditionKey ?? '',
      allowUnowned: true,
      target: { op: 'force', commit, ownerSignoffRef: args.ownerSignoffRef,
        ownerSignoffDirectiveId: ownerSignoff.directiveId,
        ownerSignoffSourceTurnRef: ownerSignoff.sourceTurnRef },
      run: () => launchDetachedDeploy({ force: true, commit }),
      summarize: (effect) => ({ status: effect.launched ? 'detached-launch-accepted' : 'not-launched',
        unit: effect.unit ?? null, reason: effect.reason ?? null, deployedSha: 'unknown' }),
    });
    if (!accepted.ok) {
      ctx.metadata?.({ gateActionReceipt: { schemaVersion: 2, action: 'deploy-force',
        callerOwnerId: identity.ownerId, receiptId: accepted.receiptId,
        effect: { status: accepted.effectMayHaveRun ? 'unknown' : 'refused', reason: accepted.reason } } });
      return json({ ok: false, op: 'force', refused: !accepted.effectMayHaveRun, ...stamp,
        reason: accepted.reason, receiptId: accepted.receiptId, effectMayHaveRun: accepted.effectMayHaveRun });
    }
    const launch = accepted.effect;
    if (launch.launched) {
      try {
        const { notifyAttention } = await import('../../attention-notify');
        await notifyAttention({
          kind: 'intervention', importance: 'urgent', title: '⚠ FORCE deploy triggered',
          body: `${actor} force-deployed ${commit.slice(0, 12)} past a red gate. Accepting reds: ${args.acknowledgeRedTests.join(', ')}. Reason: ${args.reason}`,
        });
      } catch (err) {
        console.warn('[release:deploy] force notifyAttention failed:', (err as Error)?.message);
      }
    }
    ctx.metadata?.({ gateActionReceipt: {
      schemaVersion: 2, action: 'deploy-force', callerOwnerId: identity.ownerId,
      receiptId: accepted.receiptId,
      ownership: { ...gateOwnership.receipt, ...accepted.ownership }, target: { commit, ownerSignoffRef: args.ownerSignoffRef,
        ownerSignoffAssessment: 'owner-captured-target-matched',
        ownerSignoffDirectiveId: ownerSignoff.directiveId,
        ownerSignoffSourceTurnRef: ownerSignoff.sourceTurnRef },
      effect: { status: launch.launched ? 'detached-launch-accepted' : 'not-launched', unit: launch.unit ?? null,
        reason: launch.reason ?? null, deployedSha: 'unknown' },
    } });
    return json({
      ok: launch.launched,
      op: 'force',
      ...stamp,
      launched: launch.launched,
      unit: launch.unit,
      commit,
      acknowledgeRedTests: args.acknowledgeRedTests,
      logPath: launch.logPath,
      ...(launch.reason ? { reason: launch.reason } : {}),
      note: launch.launched
        ? 'FORCE deploy started (detached) — audited + owner-notified. Watch /admin/git; the deploy reports its outcome (broadcast + pipeline event).'
        : 'Force deploy NOT launched — likely a deploy is already in flight. Re-check release:deploy{op:status}.',
    });
  },
});
