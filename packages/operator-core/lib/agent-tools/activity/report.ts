/**
 * activity:report — ingest one worker-activity event (a native tool call /
 * lifecycle transition / todo snapshot) into harness_shared.agent_activity.
 *
 * The sink of the cross-CLI activity bridge (papercusp-worker-integration-2026-06-04,
 * D-003). The per-CLI hooks call this on every completed native tool call:
 *   - Claude + Codex: the shared `posttooluse-activity-report.sh` PostToolUse hook.
 *   - OMP: the in-process `coord-hook.ts` post-tool bundle port.
 * The migration-143 trigger fires NOTIFY agent_activity, which the pui fleet view
 * rides over /api/activity/stream — so this write is the whole "tell the fleet view
 * what each worker is doing" path. The curator + the event-reaction system read the
 * same table.
 *
 * Design: cheap + non-blocking. The default hook path remains fire-and-forget;
 * OMP optionally waits for the same call's delta bundle. The handler does ONE
 * bounded INSERT before that fold. The display `summary` is
 * derived server-side (summariseActivity) when the hook didn't pre-format one, so
 * there is a single formatter shared across every CLI. detail is payload-capped.
 *
 * `owner_id` is the worker's coordination identity (PAPERCUSP_SID, the same id baked
 * into its MCP `?client=`) — passed explicitly because the hook is the source of
 * truth for it. Falls back to the request's client/principal when omitted.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { recordActivity, type TodoItem, type ToolInput } from '@papercusp/activity-bridge';
import { createPgTelemetryStore } from '../../activity-pg-store';
import {
  armInboxWake,
  cancelInboxWake,
  ensureInboxWakeArmedForActiveSession,
} from '../../events/await/inbox-wake-arm';
import { writeWatermark } from '../coordination/watermarks';
import { isWorkspaceContended } from '../locks/contention-retry';
import { releaseAllWorkItemLeasesForOwner } from '../../work-item-lease-release';
import { consumeRespawnExpected } from '../../carry-respawn-marker';
import { recentContextResetWake } from '../../session-reset-continuation';
import {
  NATIVE_SESSION_ID_RE,
  classifyOwnerNativeSession,
  reanchorAdvSessionNativeId,
  reanchorAdvSessionNativeIdByOwner,
} from '../../adv-sessions';
import { resolveAgentIdentity } from '../coordination/identity';
import { fileLockCoordinationDomain, lockDomainForProjectDir } from '../locks/coordination-domain';
import { releaseAllOwnedLocks } from '../locks/release-all-owned';
import { buildActivityHookBundle } from './hook-bundle';
import { SESSION_START_MARKER, SESSION_END_MARKER } from './lifecycle-markers';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { noteLiveNativeSession } from '../../compaction-usage';

/** Map a lifecycle-report summary to a session phase. The shared cc/ lifecycle
 *  hook sends exactly SESSION_START_MARKER (SessionStart) or SESSION_END_MARKER
 *  (SessionEnd/Stop) — EXACT match only (EI-12979). This used to be an
 *  unanchored `/start/i` / `/end/i` regex, so ANY lifecycle summary merely
 *  CONTAINING "end" (e.g. "recommend", "extended", "appended") would
 *  misfire as a session end and (wrongly) cancel the worker's inbox-wake
 *  watch + force-release every lease/claim it holds (see the call site
 *  below) — a live agent could be treated as dead from a substring
 *  coincidence. Anything that is not the exact marker is a no-op. */
function lifecyclePhase(summary?: string | null): 'start' | 'end' | null {
  if (!summary) return null;
  if (summary === SESSION_START_MARKER) return 'start';
  if (summary === SESSION_END_MARKER) return 'end';
  return null;
}

/** A todo item shape the CLIs emit (TodoWrite / TaskCreate / todo_write). */
const todoSchema = z
  .object({
    content: z.string().optional(),
    status: z.string().optional(),
    activeForm: z.string().optional(),
  })
  .passthrough();

/**
 * WI-41305: lifecycle-report needs the SAME terminal-vs-continuation verdict
 * this handler already computes for lease safety. Carry it on the ordinary
 * activity result so the hook never grows a second, drifting classifier.
 */
type ActivityReportResult = Awaited<ReturnType<typeof recordActivity>> & {
  /** `foreign` (WI-10003957): the ending native session is not the owner's bound
   *  incarnation — a nested CLI that inherited PAPERCUSP_SID. Never reaped. */
  session_end_disposition?: 'terminal' | 'continuation' | 'foreign';
};

export default defineTool({
  name: 'activity:report',
  description:
    "Report one worker-activity event (a native tool call, lifecycle transition, or todo snapshot) to the cross-CLI activity bridge sink (harness_shared.agent_activity). Called by the per-CLI hooks on every tool call; feeds the pui fleet view + curator. The display summary is derived server-side from tool_name+tool_input when not supplied. Fire-and-forget: returns { ok, id } and never blocks.",
  capability: 'activity:report',
  guidance: {
    when: 'Almost never call this by hand — the per-CLI hooks (posttooluse-activity-report.sh / the OMP coord-hook port) call it automatically to mirror each worker\'s native tool stream into the fleet view. Call directly only to inject a synthetic activity marker (e.g. a custom lifecycle note).',
    notWhen: 'To READ the activity stream use `activity:recent` (or the /api/activity/stream SSE). To coordinate with peers use `coord:send`. To drive a pui use `tui:dispatch`.',
    // EI-22571277074273886: recovery callers reasonably carry the ownerId/limit
    // vocabulary used by adjacent owner-scoped and bounded-read tools. Keep the
    // correction on the failure path: activity:report records one event, while
    // activity:recent is the bounded read surface.
    argRedirects: {
      ownerId:
        'owner — activity:report names the reporting worker with `owner`; rename the key rather than dropping the identity value.',
      limit: {
        tool: 'activity:recent',
        args: { limit: 50 },
        note: 'activity:report records exactly one activity event and has no `limit` argument; use activity:recent { limit } to read a bounded activity stream.',
      },
    },
    seeAlso: [
      'activity:recent (READ the activity stream)',
      'coord:send (coordinate with peers)',
    ],
  },
  requirePrincipal: false,
  // EI-18803497769946984: this handler never reads `ctx.tx`, but it is the single
  // hottest tool on the box and under load has run past 110s — long enough for the
  // ambient workspace transaction to trip idle_in_transaction_session_timeout (60s)
  // and fail as a bare `write CONNECTION_CLOSED 127.0.0.1:6432`.
  // See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  // EI-19386201256023240: this tool's near-exclusive caller is a per-CLI shell
  // hook (posttooluse-activity-report.sh / the OMP coord-hook port) that
  // `json.loads`s the raw result body to read `hook_bundle` — a programmatic
  // consumer, not a model reading context. The `hook_bundle` payload routinely
  // exceeds the per-result door (median ~202KB, measured 2026-08-02), and a
  // door-truncated body plus its prose footer is invalid JSON: the hook's
  // parse throws and it fails open SILENTLY, dropping the coordination fold
  // with no error anywhere (64,326 truncated responses/24h, 87% of all door
  // fires on the box). See ProjectedTool.skipResultDoor.
  // WI-37843: the reason is load-bearing, not decorative — it is what keeps the
  // store-identity-suspect PROSE off this body too, so the hook's `json.loads`
  // stays valid. Behavior is unchanged from the former `true`.
  skipResultDoor: 'programmatic-caller',
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** The reporting worker's coordination identity (PAPERCUSP_SID). */
    owner: z.string().min(1).max(256).optional(),
    /** Which CLI produced it: 'claude' | 'codex' | 'omp'. Best-effort. */
    agent: z.string().max(32).optional(),
    /** The reporting child's fine-grained launch role, when the hook can carry it. */
    role: z.string().trim().min(1).max(80).optional(),
    /** The CLI's native session id (for resume correlation). */
    session_id: z.string().max(256).optional(),
    /** The stable adv_sessions row id, when the launcher can carry it. */
    adv_session_id: z.coerce.number().int().positive().optional(),
    /** The harness the worker is in (its cwd's repo), when known. */
    harness_slug: z.string().max(256).optional(),
    /** Override the derived kind; otherwise inferred (todos > tool > lifecycle). */
    kind: z.enum(['tool', 'lifecycle', 'todos']).optional(),
    /** The native tool name (Edit / Bash / apply_patch / …). */
    tool_name: z.string().max(128).optional(),
    /** 'pre' (PreToolUse/tool_call) | 'post' (PostToolUse/tool_result). */
    phase: z.enum(['pre', 'post']).optional(),
    /** The CLI's per-call id, correlating a pre/post pair. */
    tool_use_id: z.string().max(256).optional(),
    /** Raw (hook-capped) native tool input — summarised server-side. */
    tool_input: z.record(z.string(), z.unknown()).optional(),
    /** A TodoWrite/TaskCreate/TaskUpdate snapshot — summarised server-side. */
    todos: z.array(todoSchema).max(100).optional(),
    /** A pre-formatted one-liner; overrides the server-derived summary. */
    summary: z.string().max(512).optional(),
    /** 'ok' | 'error' when the report carries an outcome. */
    status: z.string().max(32).optional(),
    /** The worker's cwd at report time. */
    cwd: z.string().max(1024).optional(),
    /**
     * Native-hook delta cursor. When present, activity:report also returns the
     * current coordination inbox/display snapshot iff this generation changed,
     * replacing separate coord:inbox + coord:glance MCP calls.
     */
    hook_bundle: z
      .object({
        generation: z.string().max(256).nullable().optional(),
        since_ts: z.string().max(128).nullable().optional(),
        force_resync: z.boolean().optional(),
        // EI-24022555028936462: the Claude hook sends this when its cached glance is
        // missing/stale (asks for the GLANCE leg only; see hook-bundle.ts). It was
        // declared on ActivityHookBundleRequest but never here, so every such call
        // was refused invalid_args. report-args-contract.test.ts now reads the keys
        // the hooks actually send and fails if this schema stops accepting one.
        glance_stale: z.boolean().optional(),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    // owner_id is the load-bearing grouping key — prefer the explicit arg (the hook
    // knows it), else the request's client identity, else the principal slug.
    const owner =
      (args.owner && args.owner.trim()) ||
      (ctx as { clientId?: string }).clientId ||
      ctx.principal?.slug ||
      (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);
    if (!owner) {
      return { isError: true, content: [{ type: 'text', text: 'owner_required: pass the worker owner id (PAPERCUSP_SID).' }] };
    }

    // WI-10001513: this request is the ONLY thing that crosses the process boundary
    // carrying the caller's live NATIVE session id, and on a 16-worker cluster it is
    // the only way THIS worker can learn that a carry-respawn killed the transcript
    // its context anchor still points at (the respawn's own invalidation POST lands
    // on exactly one worker; the other 15 keep serving the dead predecessor's frozen
    // token count forever, because a dead transcript stops growing and so reads as
    // "unchanged ⇒ current"). Done FIRST, before any await: the context-gauge
    // annotator renders this very response on the way out, so healing here is what
    // makes the number it prints describe the LIVE session rather than the dead one.
    // Sync, in-process, and total (a Map get + a string compare) — never throws, and
    // a report without a session id is simply a no-op.
    noteLiveNativeSession(owner, args.session_id);

    // Native hooks may omit harness_slug because the dispatch context already
    // carries the concrete harness. Persist that context fallback so an exact
    // activity:recent harness filter cannot hide otherwise valid owner rows.
    // Neither the explicit nor contextual '*' sentinel is a real harness.
    const harnessSlug =
      resolveConcreteHarnessSlug(args.harness_slug, ctx) ??
      resolveConcreteHarnessSlug(undefined, ctx);

    // Normalize the raw cross-CLI report + append it through the PG-backed
    // TelemetryStore seam (@papercusp/activity-bridge). The host-domain `scope`
    // maps to the harness the worker is in; everything else is the worker's
    // coordination identity. The migration-143 NOTIFY trigger does the fleet-view push.
    //
    // FIRE-AND-FORGET (the tool's documented contract: "never blocks"): a TRANSIENT
    // PG contention on this telemetry INSERT — a `lock_timeout` (55P03) or
    // `statement_timeout` (57014), which the harness_admin org pool caps at 15s — must
    // NOT surface as a hard tool error. The per-CLI hooks call this detached on EVERY
    // native tool call (~45k/day); a single dropped fleet-view row self-heals on the
    // worker's next report, so a rare contention dip is a benign no-op, never a fleet-
    // wide "tool activity:report is failing" watchdog signal (EI-7439). This mirrors the
    // best-effort/swallowed treatment of every other write in this handler (the inbox-wake
    // arm + watermark below). Non-contention errors (a genuine bug / DB-down) still surface.
    let result: ActivityReportResult;
    try {
      result = await recordActivity(createPgTelemetryStore(), {
        owner,
        agent: args.agent ?? null,
        sessionId: args.session_id ?? null,
        scope: harnessSlug,
        kind: args.kind,
        toolName: args.tool_name ?? null,
        phase: args.phase,
        toolUseId: args.tool_use_id ?? null,
        toolInput: args.tool_input as ToolInput,
        todos: args.todos as TodoItem[] | undefined,
        summary: args.summary ?? null,
        status: args.status ?? null,
        cwd: args.cwd ?? null,
        // `ctx.principal.workspaceId` is '*' for an unscoped superuser request.
        // Never persist that sentinel: concrete workspace reads (including
        // activity:recent) cannot see it. Prefer the request context and fall
        // back to the active workspace through the shared resolver.
        workspaceId: resolveConcreteWorkspaceId(ctx.workspaceId, ctx.principal?.workspaceId),
      });
    } catch (e) {
      if (!isWorkspaceContended(e)) throw e; // a real fault must still surface
      // Dropped-under-contention: report a soft, honest result (id null + dropped
      // marker) rather than a handler error. The side-effect arms below are throttled
      // + best-effort and will re-run on the next report, so skipping them here is safe.
      const hookBundle = args.hook_bundle
        ? await buildActivityHookBundle(owner, args.hook_bundle, ctx).catch(() => null)
        : undefined;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            id: null,
            dropped: 'contention',
            ...(hookBundle ? { hook_bundle: hookBundle } : {}),
          }),
        }],
      };
    }

    // turn-lifecycle-control P-003/P-004: a session's lifecycle transition is the
    // universal, client-agnostic moment to (un)arm its inbox-wake watch — so EVERY
    // psu/Queen-launched agent is wakeable WITHOUT having to call coord:await-inbox
    // (D-001). Idempotent upsert / cancel; never let it break the report.
    const phase = args.kind === 'lifecycle' ? lifecyclePhase(args.summary) : null;
    // Judge sessions are deliberately admitted only to narrow evidence/reply
    // tools, so they cannot consume the broad coord inbox that the standing
    // inbox-wake would deliver. The role is carried by the child hooks from the
    // trusted role-scoped launch env; exact-match only keeps ordinary roles on
    // the existing always-arm/self-heal path.
    const isJudge = args.role?.trim() === 'judge';
    // WI-10003957: every lifecycle effect below is keyed on the OWNER, but the
    // report comes from whichever native CLI fired the hook. PAPERCUSP_SID is
    // inherited by every descendant of an su, so a nested CLI (a test's
    // `claude -p` probe inside a capability:bash job, a CLI run from native Bash)
    // reports SessionStart/SessionEnd AS the su. Measured 2026-09-29: such a
    // probe's SessionStart re-anchored su-075445e6's adv row to itself, and its
    // SessionEnd then read as the owner's terminal end: leases and locks were
    // released, inbox-wake cancelled, and lifecycle-report.sh fleet:kill'ed the
    // live host. Classify the reporting session against the owner's bound
    // incarnation once. Fails open (null → today's behavior) on a read error.
    const reportedSessionId = args.session_id?.trim() ?? '';
    const sessionBinding = phase && NATIVE_SESSION_ID_RE.test(reportedSessionId)
      ? await classifyOwnerNativeSession({
          ownerId: owner,
          sessionId: reportedSessionId,
          advSessionId: args.adv_session_id ?? null,
        }).catch((e) => {
          console.warn(
            `[activity:report] native-session binding check for ${owner} failed, treating the session as the owner's: ${e instanceof Error ? e.message : e}`,
          );
          return null;
        })
      : null;
    const foreignSession = sessionBinding?.binding === 'foreign';
    if (phase) {
      try {
        if (phase === 'start') {
          // presence-v2 P-010 (D-007): a fresh context / resume means the agent's
          // cached roster baseline is gone while its durable coord cursor kept
          // advancing — mark a re-bootstrap so the next coord:inbox re-injects the
          // presence snapshot ONCE. Independent best-effort (its own catch) so an
          // inbox-wake hiccup never skips it, and vice-versa.
          await writeWatermark(owner, { snapshot_rebootstrap_pending: true }).catch(() => {});
          if (!isJudge) {
            await armInboxWake({ ownerId: owner, workspaceId: ctx.principal?.workspaceId });
          }
          // WI-37420: a COLD loop wake delivered over psu-socket-reset types
          // `/clear` into the LIVE pty (session-reset-continuation.ts) — the CLI
          // child mints a brand-new native session id for that in-place reset
          // WITHOUT the host ever kill+respawning the process, so the WI-5075
          // respawn report (reportSessionRespawned → reanchorAdvSessionNativeId*)
          // never fires for this leg: it is only called from psu-pty-host's
          // recycleChild, which 'reset' never goes through. This SessionStart
          // hook fire is the ONLY signal that crosses process boundaries with the
          // fresh id in hand (the hook literally reads it off its own stdin
          // event), so re-anchor here too — otherwise `adv_sessions.session_id`
          // for this owner is permanently stuck on the FIRST launch's transcript
          // across every subsequent reset, and every owner→native-session
          // consumer (the compaction watchdog's context estimate, loop-cost-cap's
          // spend read) silently tracks a dead/nonexistent transcript forever.
          // Idempotent (`session_id IS DISTINCT FROM`) and validated against the
          // same UUID shape the respawn report requires, so a malformed or
          // already-current id is a safe no-op. Best-effort: reanchor hygiene
          // must never fail this report.
          // WI-10003957: a FOREIGN start re-anchors only on evidence of the
          // legitimate in-place reset above (a psu-socket-reset/recycle wake just
          // landed for this owner). Otherwise it is a nested CLI, and re-anchoring
          // would rebind the owner's row to it (and re-open an ended row).
          const reanchorAllowed = !foreignSession
            || (await recentContextResetWake(owner).catch(() => null)) != null;
          if (!reanchorAllowed) {
            console.warn(
              `[activity:report] SessionStart re-anchor REFUSED for ${owner}: native session ${reportedSessionId} is not the owner's bound incarnation ` +
                `${sessionBinding?.boundSessionId} (adv ${sessionBinding?.advSessionId}) and no context-reset wake landed — a nested CLI that inherited PAPERCUSP_SID (WI-10003957)`,
            );
          }
          if (reanchorAllowed && args.session_id && NATIVE_SESSION_ID_RE.test(args.session_id.trim())) {
            const reanchor = args.adv_session_id != null
              ? reanchorAdvSessionNativeId(args.adv_session_id, args.session_id.trim())
              : reanchorAdvSessionNativeIdByOwner(owner, args.session_id.trim());
            await reanchor.catch((e) => {
              console.warn(
                `[activity:report] SessionStart reanchor for ${owner} failed: ${e instanceof Error ? e.message : e}`,
              );
            });
          }
        } else if (!foreignSession) {
          await cancelInboxWake(owner, ctx.principal?.workspaceId); // D-003: cancel on clean end
        }
      } catch (e) {
        console.warn(
          `[activity:report] inbox-wake ${phase} for ${owner} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
      if (phase === 'end' && foreignSession) {
        // WI-10003957: not the owner's incarnation ending, so no owner-keyed
        // effect (lease/lock release, carry-marker consume, and — via the
        // non-terminal disposition — no lifecycle-report.sh fleet:kill).
        result.session_end_disposition = 'foreign';
        console.warn(
          `[activity:report] session-end IGNORED for ${owner}: native session ${reportedSessionId} is not the owner's bound incarnation ` +
            `${sessionBinding?.boundSessionId} (adv ${sessionBinding?.advSessionId}) — a nested CLI that inherited PAPERCUSP_SID, not the owner's death (WI-10003957)`,
        );
      } else if (phase === 'end') {
        // EI-18676518990229124: a carry-respawn (session:request-compaction,
        // deterministic-context-carry P-018/P-022) ends THIS process under the
        // SAME ownerId and relaunches it seconds later — that SessionEnd is a
        // scheduled continuation, not a death, so the P-002 force-release
        // below must be SKIPPED for it (the marker is set by
        // request-compaction only once its respawn is genuinely queued; see
        // carry-respawn-marker.ts for the full incident + evidence). A
        // respawn that never actually lands still frees the owner's claims
        // via the P-001 scheduled backstop (the marker's short TTL), so
        // skipping here trades nothing away for the real-death case.
        // WI-6756: the SAME "same-owner continuation, not a death" exemption, for
        // the OTHER trigger that re-execs the CLI child — a COLD loop wake
        // delivered over psu-socket-reset/recycle. The marker above cannot cover
        // it for a different reason than staleness: that wake is injected by
        // papercup-bg-host, which never calls markRespawnExpected at all (it does
        // not go through session:request-compaction), so there is no mark to
        // find. The wake pipeline's own delivery ledger is the signal instead;
        // see session-reset-continuation.ts for the full incident + why no new
        // table/write path was introduced for that leg. Both checks are
        // fail-open on a read error (fall through to the release = today's
        // behavior) so neither guard can strand a claim by failing.
        //
        // EI-21431501901242395: an ARMED engine loop is a third same-owner
        // continuation authority. A warm loop can outlive the current native CLI
        // incarnation and resume the SAME coordination owner on its next fire. If
        // that incarnation's SessionEnd lands while the loop remains active, this
        // fast path must not erase the loop's driving work-item claim before the
        // successor turn arrives. If the owner is genuinely gone, the loop's
        // bounded reachability guard deactivates it and the ordinary P-001
        // liveness reaper becomes the backstop; once the loop is inactive, the
        // normal terminal release below applies unchanged.
        //
        // All three are now cross-PROCESS reads, and deliberately so: the operator is
        // clustered (N round-robin :3070 workers), so the process that marked a
        // respawn is usually not the one handling this report — that mismatch is
        // exactly what made the original in-memory marker fail intermittently
        // (see carry-respawn-marker.ts).
        const respawnExpected = await consumeRespawnExpected(owner);
        const resetWake = respawnExpected
          ? null
          : await recentContextResetWake(owner).catch((e) => {
              console.warn(
                `[activity:report] reset-continuation check for ${owner} failed, treating as a real session end: ${e instanceof Error ? e.message : e}`,
              );
              return null;
            });
        const activeLoopOwner = respawnExpected || resetWake
          ? false
          : await import('../../adv-roster')
              .then(({ activeLoopOwners }) => activeLoopOwners())
              .then((owners) => owners.has(owner))
              .catch((e) => {
                console.warn(
                  `[activity:report] active-loop continuation check for ${owner} failed, treating as a real session end: ${e instanceof Error ? e.message : e}`,
                );
                return false;
              });
        if (respawnExpected) {
          result.session_end_disposition = 'continuation';
          console.log(
            `[activity:report] session-end lease release SKIPPED for ${owner}: a carry-respawn is expected (same-owner continuation, not a death)`,
          );
        } else if (resetWake) {
          result.session_end_disposition = 'continuation';
          console.log(
            `[activity:report] session-end lease release SKIPPED for ${owner}: a ${resetWake.channel} wake landed ${resetWake.ageMs}ms ago ` +
              `(context reset, same-owner continuation, not a death) — claims stay held; a reset that never lands is freed by the scheduled lease reap`,
          );
        } else if (activeLoopOwner) {
          result.session_end_disposition = 'continuation';
          console.log(
            `[activity:report] session-end lease release SKIPPED for ${owner}: an engine loop remains armed ` +
              `(same-owner warm continuation) — claims stay held; a genuinely dead owner is freed after the loop reachability guard deactivates it`,
          );
        } else {
          result.session_end_disposition = 'terminal';
          // session-death-claim-release-2026-07-11 P-002 (the FAST PATH): the
          // SAME SessionEnd/Stop lifecycle event that already fires on every
          // psu session (hooks/cc/lifecycle-report.sh → THIS call, unchanged)
          // is the earliest, cheapest signal that `owner`'s process is gone —
          // force-release every work-item lease + coordination claim it holds
          // NOW, in seconds, rather than waiting on the ~hourly reap schedule
          // (P-001, the backstop for the cases this event misses: a SIGKILL, a
          // raw terminal close that skips the hook, a host crash). File/resource
          // locks must follow the SAME death/continuation classification: a dead
          // owner cannot edit again, while a carry/reset successor is the same
          // logical owner and must retain deliberate holds. Each cleanup has its
          // own try/catch so one store's fault cannot skip the other store.
          try {
            const primaryCoordinationDomain = args.cwd?.trim()
              ? lockDomainForProjectDir(args.cwd.trim())
              : fileLockCoordinationDomain();
            let source;
            try {
              source = resolveAgentIdentity(ctx);
            } catch {
              // `activity:report` permits an explicit owner without a principal.
              // Lock deletion remains authoritative; only the optional resource
              // back-up notification lacks a source in that uncommon path.
            }
            const locks = await releaseAllOwnedLocks({
              ownerId: owner,
              primaryCoordinationDomain,
              source,
            });
            if (locks.released.length || locks.resourcesReleased) {
              console.log(
                `[activity:report] session-end lock release for ${owner}: released ${locks.released.length} file path(s) ` +
                  `across ${1 + locks.crossDomainReleased.length} domain(s), ${locks.resourcesReleased} resource lock(s)`,
              );
            }
          } catch (e) {
            console.warn(
              `[activity:report] session-end lock release for ${owner} failed: ${e instanceof Error ? e.message : e}`,
            );
          }
          try {
            const rel = await releaseAllWorkItemLeasesForOwner(owner);
            if (rel.releasedIds.length || rel.claimsCleared) {
              console.log(
                `[activity:report] session-end lease release for ${owner}: released ${rel.releasedIds.length} item(s) ` +
                  `[${rel.releasedIds.slice(0, 20).join(',')}${rel.releasedIds.length > 20 ? ',…' : ''}], ` +
                  `cleared ${rel.claimsCleared} claim-ledger row(s)`,
              );
            }
          } catch (e) {
            console.warn(
              `[activity:report] session-end lease release for ${owner} failed: ${e instanceof Error ? e.message : e}`,
            );
          }
        }
      }
    } else if (args.kind !== 'lifecycle' && !isJudge) {
      // SELF-HEAL (launch-wakeability): a genuine non-lifecycle report is a native
      // tool call from a running session. If that session's SessionStart arm was lost
      // (the detached, fail-open lifecycle hook POST can drop at launch — leaving a
      // live agent un-wakeable for its whole life), re-arm so it becomes a dispatch
      // target from its first tool call onward. Throttled + best-effort + scoped to a
      // live tracked adv_sessions row (see ensureInboxWakeArmedForActiveSession). Gated
      // on kind!=='lifecycle' so an UNRECOGNIZED lifecycle summary stays a no-op and a
      // clean SessionEnd (cancel, above) is never resurrected.
      await ensureInboxWakeArmedForActiveSession({
        ownerId: owner,
        workspaceId: ctx.principal?.workspaceId ?? undefined,
      }).catch(() => {});
    }

    const hookBundle = args.hook_bundle
      ? await buildActivityHookBundle(owner, args.hook_bundle, ctx).catch(() => null)
      : undefined;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            ...result,
            ...(hookBundle ? { hook_bundle: hookBundle } : {}),
          }),
        },
      ],
    };
  },
});
