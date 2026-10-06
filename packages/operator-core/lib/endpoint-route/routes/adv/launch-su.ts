/**
 * POST /api/adv/sessions/launch-su — in-app web launch of a tracked SU
 * session (P-020). The web equivalent of typing `psu` in a terminal:
 * server-spawns a terminal running `psu --no-picker --agent=… …`, which
 * records the adv_sessions row (via bootstrap-su) and exec's the matching
 * `*-su` wrapper. The session then appears in /adv Sessions via the live
 * poll — no sessionId returned synchronously (psu creates the row).
 *
 * Delegating to `psu` (rather than re-deriving the envelope + spawning a
 * wrapper here) keeps a single source of truth for the launch flow.
 *
 * Linux-only server-side spawn, mirroring console-launch.ts. Same-origin
 * (the /adv UI is served by the operator) — no CORS preamble needed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { sseResponse } from '@papercusp/sse';
import { isSuAgent, type SuAgent, type SuContextSize } from '../../../su-agents';
import { normalizeSuContextSize } from '../../../su-context-size.mjs';
import { buildKickoffPromptFile } from '../../../agent-kickoff/prompt-file';
import { validateKickoffKind } from '../../../agent-kickoff/kickoff-kind';
import { isOnPath, shellEscape, spawnInTerminal } from '../../../terminal-spawn';
// WI-37841: the ONE derivation of this launch's boot-log path, shared with
// psu-launcher.mjs (the other writer) and with the reader that surfaces its tail.
import { psuLaunchLogPath } from '../../../psu-launch-log.mjs';
import {
  DISPLAY_TERMINAL_LAUNCH,
  getAdvSession,
  markAdvSessionEnded,
  recordAdvSession,
  setAdvSessionPid,
} from '../../../adv-sessions';
import { nativeSessionHandleForAdvSession } from '../../../native-session-handles';
import {
  bindSuSessionToAdvSession,
  readDurableSuSession,
  suppressDuplicateSuLaunch,
} from '../../../su-session-persistence';
import { notifySyncInvalidate } from '../../../sync-sse';
import { checkInteractiveSafetyFloor } from '../../../interactive-safety-floor';
import { composeLaunchModelSpec, isLaunchAccountValue } from '../../../agent-config-constants';
import { defaultLaunchAccount, defaultLaunchAccountFor } from '../../../agent-launch-core';
import { isLaunchableMode, LAUNCHABLE_MODE_IDS } from '../../../modes/registry';
import { activeWorkspaceId } from '../../../workspace-registry';
import { HARNESS_SLUG_RE } from '../../../harness-slug';
import { hostedAgentIdentityPsuEnv } from '../../../workspace-host/hosted-agent-identity-psu-env';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
// EI-21563406996333542: shared with the WRITE doors (goals:update) so a slug can
// never be stored that this launch door will later refuse. Same value as the
// private const it replaces.
const SLUG_RE = HARNESS_SLUG_RE;
// Model fuzzy-match (e.g. `anthropic/claude-opus-4-7`, `gpt-5.5`) + psu's
// canonical trailing `[1m]` context marker. Keep the marker in its one valid
// position (before an optional effort suffix) rather than admitting arbitrary
// brackets; shellEscape remains the real command-injection guard.
const MODEL_RE = /^(?=.{1,80}$)[A-Za-z0-9._:/-]+(?:\[1m\](?::[A-Za-z0-9._-]+)?)?$/i;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Terminal discovery + spawn live in the shared `terminal-spawn` helper
// (findTerminal/isOnPath/shellEscape/spawnInTerminal) — imported above.

async function handleLaunchSu(req: Request): Promise<Response> {
  let body: {
    agent?: string;
    harness_slug?: string | null;
    plan_slug?: string | null;
    stack?: string[] | null;
    selected_identity_revision?: string | null;
    // P-032: omp-parity passthroughs (the features the retired
    // buildEngineerOmpLaunchCommand used to provide).
    model?: string | null;
    // PUI/PSU option-source parity: effort stays a separate UI choice, but
    // psu carries it in the model spec. Compose it through the canonical
    // agent-config helper rather than reimplementing suffix rules here or in
    // the PUI client.
    effort?: string | null;
    // su-context-size-variants: 'trimmed' | 'steward' (legacy 'full' →
    // 'trimmed') — initial tool-seed size (WI-2140338).
    context_size?: string | null;
    // WI-2140338 [owner 2026-09-01]: session compaction ceiling in TOKENS,
    // emitted as `--compaction-limit` (the MemberSpec seam). Null/omitted =
    // tier/system default. Distinct from context_size (tool surface).
    compaction_limit?: number | null;
    resume_session_id?: string | null;
    kickoff?: { kind?: string } | null;
    // P-017 (work-on-everything-goal): free-text first-turn brief, delivered
    // spawn-safe via the PAPERCUSP_KICKOFF_PROMPT env (psu resolveKickoffText's
    // fallback) — never a `--kickoff=` argv value (shell-quoting breaks inside a
    // greeting oneliner) and never the curated `kickoff` above. NOT carried by
    // the defer_spawn (workbench) path, which records argv only.
    kickoff_prompt?: string | null;
    /** Existing GOAL attachment bootstrap must verify before a first turn. */
    goal_bootstrap_subject?: string | null;
    /**
     * WI-10004787: the ownerId this launch is made ON BEHALF OF, forwarded as
     * psu's `--launched-by=<id>`. That flag is the one seam bootstrap-su reads
     * to inherit the launcher's goal context (session_briefs.goal_id), so a
     * server-side caller launching FOR an agent — the goal-drain-fleet watchdog
     * relaunching a holder's drain worker — must pass it, or every call the new
     * session makes is stamped goal_id NULL and its goal never sees the work.
     */
    launched_by?: string | null;
    // WI-6321 (owner ask 2026-07-27): psu-parity launch options the GUI could
    // not express, so every GUI launch was silently unfleeted and on the
    // default system credential.
    // named-su-agent-fleets P-006: `fleet` = an existing slug to JOIN;
    // `fleet_name` = a NEW fleet's title (this session becomes its LEADER),
    // with `fleet_scheme` naming its colour. psu derives the slug from the
    // name, so a new fleet sends the name and lets the launcher slugify.
    fleet?: string | null;
    fleet_name?: string | null;
    fleet_scheme?: string | null;
    // Delegated agent-slot ref consumed by bootstrap-su. The canonical seat
    // ledger/ref/cap validation stays there; this route only preserves the
    // existing psu --seat transport for GUI/PUI launches.
    seat?: string | null;
    // psu-account-chooser: 'default' | 'auto' | a pool account id. OPTIONAL on
    // the wire, but never absent from the argv: an omitted value resolves to
    // `defaultLaunchAccount()` below, because psu with no --account opens an
    // INTERACTIVE picker, which would hang a spawned session waiting for a human
    // at a terminal. This field used to be documented as "ALWAYS sent by a GUI
    // launch" and the route trusted that; D-014 disproved it from a real trace.
    account?: string | null;
    // PUI SU-session contract: same psu carry input as fleet launch. Persisted
    // in launch_argv; orthogonal to headed/headless.
    carry?: string | null;
    // Read-only attach to one existing workspace-scoped adv_sessions row.
    // When set, this route returns its native handle and spawns nothing.
    attach_adv_session_id?: number | null;
    // pui-reactive-session-panes D-006: record a pending workbench launch
    // instead of spawning a terminal — the pui reactively opens the pane that
    // RUNS it (the single launcher). The pane materializes via the roster.
    defer_spawn?: boolean;
    /** Attach a structured engine to the existing SU host, without a native pane. */
    attached_engine?: boolean;
    // WI-6505 (owner ask 2026-07-27, the chat popup's fleet-launch row): launch
    // with NO desktop window — a background su session that still registers
    // presence and joins its fleet, logging to a file instead of a terminal.
    // psu has had `--headless` since headless-fleet-launch P-001; this route
    // simply could not express it, which is why a GUI fleet launch could only
    // ever open N windows.
    headless?: boolean;
    // retire-mug-kettle-su-only-2026-08-09 P-042 (D-067): the launch-time
    // MODE. Until this, AUTO and DRAIN were reachable only by typing them to
    // an already-running session — psu had the flags and bootstrap-su
    // registered them durably, but no GUI surface could express either.
    //
    // ONE field, not a `mode` + `auto` pair: a session launches in exactly one
    // posture, and the pair makes `{auto:false, mode:'drain'}` expressible.
    // Values come from the modes registry (LAUNCHABLE_MODE_IDS), never a
    // literal list — see the mapping note at the argv push below.
    mode?: string | null;
    /** PUI's existing chat id; bind it to the deferred adv row. */
    agent_chat_id?: string | null;
    /** attached_engine only: the directory PUI was launched from. The session
     *  runs there when this host can see it (pui-chat-first-ux P-001). */
    cwd?: string | null;
  } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json({ status: 'error', error: 'invalid JSON body' }, 400);
  }

  if (body.stack != null && (!Array.isArray(body.stack) || body.stack.length > 40 ||
      body.stack.some((ref) => typeof ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)))) {
    return json({ status: 'error', error: 'stack must contain valid slot:id refs' }, 400);
  }
  if (body.selected_identity_revision != null &&
      (!/^[a-f0-9]{64}$/.test(body.selected_identity_revision) || body.stack?.length !== 1)) {
    return json({ status: 'error', error: 'selected_identity_revision requires one selected stack ref and sha256 revision' }, 400);
  }

  const attachAdvSessionId = body.attach_adv_session_id ?? null;
  if (attachAdvSessionId != null && (!Number.isSafeInteger(attachAdvSessionId) || attachAdvSessionId <= 0)) {
    return json({ status: 'error', error: 'attach_adv_session_id must be a positive integer' }, 400);
  }
  if (attachAdvSessionId != null && body.defer_spawn) {
    return json({ status: 'error', error: 'attach_adv_session_id and defer_spawn are mutually exclusive' }, 400);
  }
  if (body.attached_engine && (body.defer_spawn || body.headless || body.resume_session_id)) {
    return json(
      {
        status: 'error',
        error: 'attached_engine cannot be combined with a deferred, headless or native-resume launch',
      },
      400,
    );
  }
  const hasExplicitAgent = typeof body.agent === 'string' && body.agent.trim().length > 0;
  if (attachAdvSessionId != null && !hasExplicitAgent) {
    return json({ status: 'error', error: 'attach requires an explicit agent: claude|omp|codex' }, 400);
  }

  // No explicit agent → the CONFIGURED backend (/settings/agent — owner ask
  // 2026-06-07: an agent-less launch like the New-Plan button must follow
  // the global pick, not a hardcoded omp). Config speaks 'claude-code';
  // psu speaks 'claude'.
  let agent: SuAgent;
  if (body.agent == null || body.agent === '') {
    const { readAgentConfig, effectiveBackend } = await import('../../../agent-config');
    const b = effectiveBackend(await readAgentConfig());
    agent = b === 'claude-code' ? 'claude' : b;
  } else if (isSuAgent(body.agent)) {
    agent = body.agent;
  } else {
    return json({ status: 'error', error: 'agent must be one of claude|omp|codex' }, 400);
  }
  const harness = body.harness_slug?.trim() || null;
  const plan = body.plan_slug?.trim() || null;
  if (harness && !SLUG_RE.test(harness)) return json({ status: 'error', error: 'invalid harness slug' }, 400);
  if (plan && !SLUG_RE.test(plan)) return json({ status: 'error', error: 'invalid plan slug' }, 400);

  let model: string | null = null;
  try {
    model = composeLaunchModelSpec(body.model, body.effort) ?? null;
  } catch (error) {
    return json({ status: 'error', error: error instanceof Error ? error.message : 'invalid model/effort' }, 400);
  }
  const resumeSessionId = body.resume_session_id?.trim() || null;
  const goalBootstrapSubject = typeof body.goal_bootstrap_subject === 'string'
    ? body.goal_bootstrap_subject.trim() : null;
  if (body.goal_bootstrap_subject != null &&
      (typeof body.goal_bootstrap_subject !== 'string' || !goalBootstrapSubject || goalBootstrapSubject.length > 200)) {
    return json({ status: 'error', error: 'goal_bootstrap_subject must be a non-empty string of at most 200 characters' }, 400);
  }
  if (goalBootstrapSubject && (resumeSessionId || body.mode || body.fleet || body.fleet_name)) {
    return json({ status: 'error', error: 'goal_bootstrap_subject requires a fresh, fleetless session without a separate launch mode' }, 400);
  }
  if (model && !MODEL_RE.test(model)) return json({ status: 'error', error: 'invalid model' }, 400);
  if (resumeSessionId && !SESSION_ID_RE.test(resumeSessionId))
    return json({ status: 'error', error: 'invalid resume session id' }, 400);

  // WI-6321: fleet + account. Every value below is interpolated into a psu
  // argv token, so each is shape-guarded here rather than trusted — the same
  // discipline the harness/plan slugs above get.
  const fleet = body.fleet?.trim() || null;
  if (fleet && !SLUG_RE.test(fleet)) return json({ status: 'error', error: 'invalid fleet slug' }, 400);
  const fleetName = body.fleet_name?.trim() || null;
  // A fleet TITLE is human text (psu slugifies it), so it cannot take SLUG_RE.
  // Bound it and exclude shell/argv-hostile characters instead.
  if (fleetName && !/^[\w .,'’&()\/-]{1,80}$/u.test(fleetName)) {
    return json({ status: 'error', error: 'invalid fleet name' }, 400);
  }
  const fleetScheme = body.fleet_scheme?.trim() || null;
  if (fleetScheme && !/^[A-Za-z0-9 _-]{1,60}$/.test(fleetScheme)) {
    return json({ status: 'error', error: 'invalid fleet scheme' }, 400);
  }
  if (fleet && fleetName) {
    return json(
      { status: 'error', error: 'pass fleet (join an existing one) or fleet_name (create a new one), not both' },
      400,
    );
  }
  // D-014 (pui-su-session-runtime-correction-2026-08-27): an omitted `account`
  // MUST still persist the explicit default. Defaulting to `null` here dropped
  // `--account=` from launch_argv entirely, and bootstrap-su then interpreted the
  // unspecified Claude routing as gateway-routed — where the owner turn was shed
  // after DEFAULT_MAX_QUEUE_WAIT_MS on admission timeout. `defaultLaunchAccount()`
  // is the same resolver the scripted path (agent-launch-core) already applies, so
  // the GUI/PUI create and the scripted launch now compose an identical argv.
  // WI-10004158 / D-011: an omitted account follows an OMP gateway model to
  // `auto`; the default account would refuse that model at engine start.
  let account = body.account?.trim() || '';
  if (!account) {
    if (agent === 'omp') {
      const { ompDefaultModel } = await import('../../../../../../apps/operator/scripts/psu-launcher.mjs');
      account = defaultLaunchAccountFor({ agent, model,
        ompSelector: process.env.PAPERCUSP_OMP_MODEL_SELECTOR ?? null, ompNativeDefault: () => ompDefaultModel() });
    } else {
      account = defaultLaunchAccount();
    }
  }
  if (!isLaunchAccountValue(account)) {
    return json({ status: 'error', error: 'invalid account' }, 400);
  }
  const seat = body.seat?.trim() || null;
  if (seat && (seat.length > 256 || /[\u0000-\u001f\u007f]/u.test(seat))) {
    return json({ status: 'error', error: 'invalid seat ref' }, 400);
  }
  // WI-10004787: same identity shape injectLaunchedByArg and bootstrap-su accept,
  // so a value this route forwards is never one bootstrap then refuses.
  const launchedBy = typeof body.launched_by === 'string' ? body.launched_by.trim() || null : null;
  if (body.launched_by != null &&
      (typeof body.launched_by !== 'string' || (launchedBy && !/^[A-Za-z0-9._:-]{1,120}$/.test(launchedBy)))) {
    return json({ status: 'error', error: 'launched_by must be an owner id' }, 400);
  }
  const carry = body.carry?.trim() || null;
  if (carry && carry !== 'warm' && carry !== 'cold') {
    return json({ status: 'error', error: 'carry must be warm|cold' }, 400);
  }
  const agentChatId = body.agent_chat_id?.trim() || null;
  if (agentChatId && !/^[A-Za-z0-9._:-]{1,200}$/.test(agentChatId)) {
    return json({ status: 'error', error: 'invalid agent chat id' }, 400);
  }

  // PUI attaches through the same canonical session row. Structured sessions
  // reconnect their saved engine here after an operator restart; legacy
  // native sessions retain their existing read-only attachment behavior.
  if (attachAdvSessionId != null) {
    const row = await getAdvSession(attachAdvSessionId);
    if (!row) {
      return json({ status: 'error', error: `adv session ${attachAdvSessionId} was not found` }, 404);
    }
    if (row.agent !== agent) {
      return json(
        {
          status: 'error',
          error: `adv session ${attachAdvSessionId} backend is ${row.agent ?? 'unrecorded'}, not ${agent}`,
        },
        409,
      );
    }
    if (harness && row.harnessSlug !== harness) {
      return json(
        {
          status: 'error',
          error: `adv session ${attachAdvSessionId} harness is ${row.harnessSlug ?? 'workspace-scoped'}, not ${harness}`,
        },
        409,
      );
    }
    if (plan && row.planSlug !== plan) {
      return json(
        {
          status: 'error',
          error: `adv session ${attachAdvSessionId} plan is ${row.planSlug ?? 'unscoped'}, not ${plan}`,
        },
        409,
      );
    }
    const { readDurableSuSession } = await import('../../../su-session-persistence');
    const durable = await readDurableSuSession({ advSessionId: row.id, workspaceId: activeWorkspaceId() });
    if (durable?.descriptor && durable.agentChatId && durable.harnessSlug) {
      const { launchAttachedSuSession } = await import('../../../su-session-attached-launch');
      return launchAttachedSuSession(req, {
        agent,
        agent_chat_id: durable.agentChatId,
        harness_slug: durable.harnessSlug,
        account: durable.descriptor.accountRoute ?? 'default',
        carry: durable.descriptor.carry,
        model: durable.descriptor.model,
      });
    }
    return json({
      status: 'ok',
      attached: true,
      advSessionId: row.id,
      ...(row.coordOwnerId ? { ownerId: row.coordOwnerId } : {}),
      agent,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      planSlug: row.planSlug,
      nativeSession: nativeSessionHandleForAdvSession(row),
    });
  }

  // P-042 / D-067: validate the launch mode against the modes REGISTRY, not a
  // local literal. psu-launcher.mjs and bootstrap-su.ts each already carry a
  // hardcoded copy of this vocabulary; a third one here would be the copy that
  // drifts, and it would fail in the worst direction — the GUI offering a mode
  // psu refuses, which exits 0 after printing one line, so the caller shows a
  // SUCCESS toast for a session that never started.
  const launchMode = body.mode?.trim() || null;
  if (launchMode && !isLaunchableMode(launchMode)) {
    return json(
      {
        status: 'error',
        error: `mode must be one of ${LAUNCHABLE_MODE_IDS.join('|')} ` + `(got ${launchMode.slice(0, 32)})`,
      },
      400,
    );
  }

  // Resolve the fleet to a SLUG before composing argv. `--fleet=<slug>` is the
  // only fleet flag psu's arg parser understands — its `fleetName`/`fleetScheme`
  // are set exclusively by its own INTERACTIVE picker, so forwarding
  // `--fleet-name=` would be a dead token psu silently ignores (checked against
  // the parser, not assumed). Creating the row here is also the more honest
  // split: fleet creation is durable operator state, and doing it now means a
  // failure surfaces as a 400 instead of a terminal that opens and dies.
  let fleetSlug = fleet;
  if (fleetName) {
    try {
      const { createFleetIfAbsent, fleetSlugFromName } = await import('../../../agent-fleets-store');
      const slug = fleetSlugFromName(fleetName);
      if (!slug) return json({ status: 'error', error: 'fleet name produced an empty slug' }, 400);
      await createFleetIfAbsent({
        workspaceId: activeWorkspaceId(),
        fleetSlug: slug,
        title: fleetName,
        // null ⇒ the store allocates the next unused catalog scheme, which is
        // exactly what the picker previewed as `nextScheme`.
        colorScheme: fleetScheme,
      });
      fleetSlug = slug;
    } catch (e: any) {
      return json({ status: 'error', error: `could not create fleet: ${e?.message ?? 'unknown error'}` }, 500);
    }
  }
  if (seat && !fleetSlug) {
    return json(
      {
        status: 'error',
        error: 'seat requires fleet: delegated seats belong to an existing fleet',
      },
      400,
    );
  }

  let contextSize: SuContextSize = 'trimmed';
  let contextSizeNormalization: { requested: 'full'; effective: 'trimmed'; deprecated: true } | null = null;
  if (body.context_size != null && body.context_size !== '') {
    const normalized = normalizeSuContextSize(body.context_size);
    if (!normalized.ok) return json({ status: 'error', error: `context_size: ${normalized.error}` }, 400);
    contextSize = normalized.contextSize;
    if (normalized.normalizedLegacyFull) {
      contextSizeNormalization = { requested: 'full', effective: 'trimmed', deprecated: true };
    }
  }
  const kickoffV = validateKickoffKind(body.kickoff ?? null);
  if (kickoffV.kind === 'error') {
    return json({ status: 'error', error: kickoffV.error }, 400);
  }
  const kickoffKind = kickoffV.value?.kind ?? null;
  const kickoffPrompt =
    typeof body.kickoff_prompt === 'string' && body.kickoff_prompt.trim() ? body.kickoff_prompt : null;

  // Safety floor (unify-agent-spawn-chokepoint P-012): a human-initiated psu
  // launch WAIVES brain admission (the human is the judgment + the durability)
  // but STILL passes the deterministic concurrency ceiling — the same shared
  // floor the native console launch passes (lib/interactive-safety-floor.ts).
  // Over-ceiling → 429 with an actionable reason; fail-open on a read error.
  // Applies to the deferred (workbench) path too: the floor gates the human's
  // launch decision here, not the later pane materialization.
  const floor = await checkInteractiveSafetyFloor();
  if (!floor.ok) return json({ status: 'error', error: floor.reason }, 429);

  if (body.attached_engine) {
    if (!agentChatId || !harness)
      return json({ status: 'error', error: 'attached_engine requires an agent chat and project' }, 400);
    const { launchAttachedSuSession } = await import('../../../su-session-attached-launch');
    const launchContext =
      kickoffKind === 'new-plan' ? await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: harness }) : null;
    return launchAttachedSuSession(req, {
      agent,
      agent_chat_id: agentChatId,
      harness_slug: harness,
      plan_slug: plan,
      account,
      carry: carry === 'cold' ? 'cold' : 'warm',
      model,
      mode: launchMode,
      context_size: contextSize,
      compaction_limit: body.compaction_limit,
      fleet: fleetSlug,
      seat,
      launch_context: launchContext,
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
    });
  }

  if (process.platform !== 'linux') {
    return json({ status: 'error', error: 'server-side spawn only implemented for Linux' }, 501);
  }

  const psuPath = join(homedir(), '.local', 'bin', 'psu');
  const psuRef = existsSync(psuPath) ? psuPath : 'psu';
  if (psuRef === 'psu' && !isOnPath('psu')) {
    return json(
      {
        status: 'error',
        code: 'psu_not_installed',
        error: '`psu` not found on PATH — run apps/operator/scripts/install-standalone-mcp.sh',
      },
      200,
    );
  }

  // Kickoff brief (P-032): generate the curated prompt file server-side
  // (same factory the retired console-launch omp path used) and hand its
  // path to psu, which feeds it to the *-su wrapper as the launch-context
  // (layered onto the engineer playbook). Best-effort — a generation miss
  // just launches without the brief rather than failing the launch.
  let kickoffFile: string | null = null;
  if (kickoffKind === 'new-plan') {
    try {
      kickoffFile = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: harness });
    } catch {
      kickoffFile = null;
    }
  }

  // All tokens are fixed flags or validated values; shellEscape is the real
  // guard (the validators above reject shell metacharacters anyway).
  // WI-6363 (owner ask 2026-07-27: "when you click +new session the gui chat
  // with them should show up"). PRE-PIN the coord owner id here and hand it to
  // psu, so the CALLER knows the session's real identity at launch time.
  //
  // Why this is the only workable handle: the chat is keyed by coord owner id,
  // and until now this route could not tell the client one. The terminal path
  // below records NO adv_sessions row at all (psu self-registers asynchronously
  // once it boots, see the comment on the spawn result), so there was no
  // advSessionId to return either — the client got `{status:'ok', pid}` and had
  // nothing to open a chat with. `psu --owner-id=` exists for exactly this
  // "state a spawner keys pre-spawn" case (WI-5002/EI-13277): bootstrap-su
  // validates the id and binds the session to it instead of minting its own.
  //
  // Deliberately built BEFORE the defer_spawn branch so BOTH paths carry it —
  // the deferred path records these args as `launch_argv`, so the pui-run
  // session binds to the same pre-pinned owner when it eventually starts.
  //
  // NOT pinned on a RESUME: a resumed session already HAS an identity, and
  // forcing a freshly-minted owner onto it would either be refused by
  // bootstrap-su (the id is bound to a live un-ended row) or, worse, split the
  // resumed session away from its own history — the exact failure the pin
  // exists to prevent, inverted. A resume returns no `ownerId`, and callers
  // treat that as "nothing to open" rather than guessing.
  const ownerId = resumeSessionId ? null : `su-${randomUUID()}`;
  const psuArgs = [psuRef, '--no-picker', `--agent=${agent}`];
  if (ownerId) psuArgs.push(`--owner-id=${ownerId}`);
  if (harness) psuArgs.push(`--harness=${harness}`);
  for (const ref of body.stack ?? []) psuArgs.push(`--stack=${ref}`);
  if (body.selected_identity_revision) psuArgs.push(`--identity-revision=${body.selected_identity_revision}`);
  psuArgs.push(plan ? `--plan=${plan}` : '--no-plan');
  if (model) psuArgs.push(`--model=${model}`);
  psuArgs.push(`--context-size=${contextSize}`);
  // WI-2140338 [owner 2026-09-01]: pin the session's token ceiling when the
  // launcher supplied one (goal launch profiles do for full-window holders).
  // Validated int>0; a non-finite/negative value is refused above argv, not
  // silently dropped into a malformed flag.
  if (body.compaction_limit != null) {
    const cl = Math.floor(Number(body.compaction_limit));
    if (!Number.isFinite(cl) || cl <= 0) {
      return json(
        {
          status: 'error',
          error: `compaction_limit: expected a positive integer, got ${String(body.compaction_limit)}`,
        },
        400,
      );
    }
    psuArgs.push(`--compaction-limit=${cl}`);
  }
  // WI-6321 — same flags, same order psu's own psuLaunchArgvRecord emits them,
  // so a GUI launch and a terminal launch produce an identical launch_argv.
  // Unconditional by D-014: `account` is now always resolved above, and the argv
  // parity guard in su-session-real-backend-matrix.integration.test.ts asserts
  // every deferred row carries `--account=`. A conditional push here is what let
  // the flag go missing.
  psuArgs.push(`--account=${account}`);
  if (fleetSlug) psuArgs.push(`--fleet=${fleetSlug}`);
  if (seat) psuArgs.push(`--seat=${seat}`);
  if (carry) psuArgs.push(`--carry=${carry}`);
  if (resumeSessionId) psuArgs.push(`--resume-session=${resumeSessionId}`);
  if (kickoffFile) psuArgs.push(`--launch-context=${kickoffFile}`);
  if (goalBootstrapSubject) psuArgs.push(`--goal-bootstrap-subject=${goalBootstrapSubject}`);
  if (launchedBy) psuArgs.push(`--launched-by=${launchedBy}`);
  // hive-agent-tabs P-006: a New-plan launch IS the Planner — launch the
  // planner role/persona (`=` form; psu drops the space form) so the dock
  // panes it as a typed 📋 Planner pane (responsive — auto-injection OFF).
  if (kickoffKind === 'new-plan') psuArgs.push('--role=planner');
  // WI-6505: `--headless` keeps psu's managed pty ON despite non-TTY stdio and
  // implies --no-picker (already passed). Pushed LAST so the argv is otherwise
  // byte-identical to a headed launch — the two paths differ by exactly this flag.
  if (body.headless) psuArgs.push('--headless');
  // P-042 / D-067 — the launch MODE, mapped onto psu's two shapes:
  //
  //   'auto'  → `--auto`        (a BOOLEAN flag)
  //   others  → `--mode=<id>`   (a NAMED mode; today only 'drain')
  //
  // The special case is load-bearing, not cosmetic. `--mode=auto` would make
  // psu forward `{mode:'auto'}` to bootstrap-su, which refuses any named mode
  // but 'drain' with a 400 — so the naive uniform mapping breaks the very
  // posture this feature exists to deliver. AUTO rides the boolean all the way
  // down (effectiveAutoMode → `{auto:true}` → syncLaunchModeToRegistry).
  //
  // Nothing more is needed to make the mode DURABLE: bootstrap-su already
  // writes the agent_modes row on the way up. Deliberately NOT delivered via
  // `kickoff` — a machine-injected turn is classified VERIFIED AGENT-ORIGIN, so
  // the provenance hook would not register the flip, leaving a mode that LOOKS
  // active in the transcript but is invisible to peers and dropped at the next
  // compaction (this plan's D-066).
  if (launchMode === 'auto') psuArgs.push('--auto');
  else if (launchMode) psuArgs.push(`--mode=${launchMode}`);

  // Deferred (D-006): record a pending "workbench launch" instead of spawning a
  // terminal. The pui reactively opens a work-area pane that RUNS `launch_argv`
  // (the single launcher), then marks the row launched. No process starts here.
  if (body.defer_spawn) {
    // A retried PUI create must not mint a second adv row for the same chat.
    // The durable unique index is the final arbiter; this read makes the
    // common replay path return the original identity immediately.
    if (agentChatId) {
      const existing = await readDurableSuSession({ agentChatId });
      if (suppressDuplicateSuLaunch(existing, { agentChatId })) {
        return json({
          status: 'ok',
          duplicate: true,
          attached: true,
          advSessionId: existing!.advSessionId,
          ...(existing!.ownerId ? { ownerId: existing!.ownerId } : {}),
          agent: existing!.backend ?? agent,
          workspaceId: existing!.workspaceId,
          harnessSlug: existing!.harnessSlug,
          planSlug: plan,
          nativeSession: null,
        });
      }
    }
    const label = plan ? `${agent} · ${plan}` : agent;
    const advSessionId = await recordAdvSession({
      planSlug: plan,
      agent,
      // P-006: record the planner role so BOTH classifiers (pending-launch
      // argv hint + the live presence join on adv.role) type the pane.
      role: kickoffKind === 'new-plan' ? 'planner' : null,
      mode: 'console',
      cwd: null, // psu cds itself from --harness/--plan (parity with the terminal path)
      label,
      // P-002: the deferred row is the session's durable identity, not merely
      // a queue receipt. Once PUI atomically marks it launched, bootstrap-su
      // recognizes and adopts this same owner-bound row.
      coordOwnerId: ownerId,
      display: 'workbench',
      launchArgv: psuArgs,
    });
    if (advSessionId == null) {
      return json({ status: 'error', error: 'failed to record session' }, 500);
    }
    let deferredBindingError: string | null = null;
    if (agentChatId) {
      const binding = await bindSuSessionToAdvSession({ advSessionId, agentChatId }).catch(() => null);
      if (binding?.status === 'error') {
        // Fail OPEN — the adv row is committed and the pane is still worth
        // showing — but never fail SILENT: an unbound row cannot be attached
        // to later, and a bind that could not even be evaluated used to be
        // indistinguishable here from a clean 'not_found'.
        deferredBindingError = binding.reason;
      }
      if (binding?.status === 'conflict') {
        // A concurrent creator may have won the unique chat index between
        // the duplicate read and this row insert. Close this loser before it
        // can become a second pending pane, then return the winner's stable
        // identity to the caller.
        await markAdvSessionEnded(advSessionId, null, 'cleanup').catch(() => undefined);
        const winner = await readDurableSuSession({ agentChatId });
        if (winner) {
          return json({
            status: 'ok',
            duplicate: true,
            attached: true,
            advSessionId: winner.advSessionId,
            ...(winner.ownerId ? { ownerId: winner.ownerId } : {}),
            agent: winner.backend ?? agent,
            workspaceId: winner.workspaceId,
            harnessSlug: winner.harnessSlug,
            planSlug: plan,
            nativeSession: null,
          });
        }
      }
    }
    // Wake the pui dock-driver NOW so it reactively panes this pending
    // workbench launch deterministically, instead of waiting for the general
    // invalidation firehose or the 60s roster safety-net (the gap that left a
    // New-plan click un-paned for hours after an operator restart). The pui
    // refetches /api/adv/roster on ANY `invalidate` frame; 'roster' names it
    // explicitly. Best-effort: the row is already committed, so a notify
    // hiccup must not fail the launch (the safety-net still backs it up).
    void notifySyncInvalidate('roster').catch(() => {});
    return json({
      status: 'ok',
      deferred: true,
      advSessionId,
      ...(ownerId ? { ownerId } : {}),
      agent,
      workspaceId: activeWorkspaceId(),
      harnessSlug: harness,
      planSlug: plan,
      nativeSession: null,
      ...(deferredBindingError ? { bindingError: deferredBindingError } : {}),
      ...(contextSizeNormalization ? { contextSizeNormalization } : {}),
    });
  }

  const psuCommand = psuArgs.map(shellEscape).join(' ');
  // HEADLESS keeps the bare `exec`: there is no window to hold open, and the
  // keep-open wrapper's trailing `exec "$SHELL" -l` would leave an immortal
  // login shell behind instead of letting the child exit.
  const oneliner = `exec ${psuCommand}`;

  // ⚠ WI-37743 — THIS ROW IS WRITTEN BEFORE THE SPAWN, AND THE ORDER IS THE
  // WHOLE POINT. Do not move it back below.
  //
  // psu's first act on boot is to call bootstrap-su with this pre-pinned owner
  // id. bootstrap-su ADOPTS this row (adoptStartingTerminalLaunch) instead of
  // inserting a second one — but it can only adopt a row that already EXISTS.
  // While this write lived after the spawn, psu regularly won the race:
  // measured 2026-08-10, psu registered at 15:54:16.294 and this row was not
  // born until 15:54:17.933, so the adopt found nothing, bootstrap-su took its
  // INSERT fallback, and the launch ended with TWO live rows for one session
  // (14707 + 14708, same session_id). Writing it first removes the race
  // outright; tuning the post-spawn delay would only out-run it, and the
  // spawn's early-exit probe legitimately takes up to EARLY_EXIT_PROBE_MS.
  //
  // WI-6376 (owner ask 2026-07-25: sessions must show up on the board "whether
  // or not they are launched with the new session button or if they are
  // launched with the psu utility"). Recording it here also gets the card onto
  // the board a beat sooner, since the roster is presence-primary and the boot
  // window is short.
  //
  // display=DISPLAY_TERMINAL_LAUNCH, never 'workbench': that value is D-006's
  // pui pane queue, and a terminal launch already has its own terminal. This
  // row is read by listStartingTerminalLaunches into the roster's `starting`
  // tier, which the pui does not consume.
  //
  // pid/terminalBin are NOT known yet — they are stamped on by
  // setAdvSessionPid once the spawn returns (and the row is closed out if the
  // spawn fails), so nothing downstream loses a field by this reordering.
  //
  // Best-effort: a bookkeeping miss must not turn a successful launch into a
  // reported failure.
  const startingAdvSessionId = ownerId
    ? await recordAdvSession({
        planSlug: plan,
        agent,
        role: kickoffKind === 'new-plan' ? 'planner' : null,
        mode: 'console',
        cwd: null, // psu cds itself from --harness/--plan
        label: plan ? `${agent} · ${plan}` : agent,
        coordOwnerId: ownerId,
        pid: null,
        terminalBin: null,
        display: DISPLAY_TERMINAL_LAUNCH,
        launchArgv: psuArgs,
      }).catch(() => null)
    : null;
  // Push the new row to open boards immediately rather than waiting for the
  // next roster poll — the boot window is short, and a card that appears late
  // is the same defect in miniature.
  if (startingAdvSessionId != null) void notifySyncInvalidate('roster').catch(() => {});

  // WI-6505 — the two spawn shapes, normalized to ONE result so everything
  // below (the early-exit warning, the adv_sessions row, the response) stays a
  // single code path rather than forking per mode.
  //
  // Headless routes through `spawnHeadless` — the SAME helper
  // fleet:launch-on-plan uses — deliberately, not a hand-rolled `detached:true`
  // spawn: it enrols the child in the task ledger and, on a systemd host, puts
  // it in a transient `systemd-run --user --scope` sibling of the operator's own
  // service, so an operator restart cannot reap it (EI-9748). A bare detached
  // spawn here would skip both.
  let spawned:
    | {
        ok: true;
        terminal: string;
        pid: number | undefined;
        likelyOpened: boolean;
        stderr?: string;
        failureReason?: string;
      }
    | { ok: false; error: string };
  if (body.headless) {
    try {
      const [
        { buildConsoleEnvelope },
        { spawnHeadless },
        { papercuspPathForWorkspace },
        { resolveSpawnHostOperatorBaseUrl },
      ] = await Promise.all([
        import('../../../console-launcher'),
        import('../../../console-spawn'),
        import('../../../papercusp-root'),
        import('../../../mcp-base-url'),
      ]);
      const workspaceId = activeWorkspaceId();
      const spawnHostBase = resolveSpawnHostOperatorBaseUrl();
      const spawnHostPort = new URL(spawnHostBase).port;
      const base = await buildConsoleEnvelope({
        workspaceId,
        // null (not undefined) is the "no harness" value here — the envelope
        // builder then resolves the workspace's home checkout as cwd.
        slug: harness,
        operatorBaseUrl: spawnHostBase,
        // The long-lived proxy fronts green main. A current-build desktop or
        // staging launch must bootstrap against the same operator that read
        // its selected identity; otherwise its child silently uses old code.
        ...(spawnHostPort && spawnHostPort !== '3070'
          ? { agentMcpBaseUrl: spawnHostBase } : {}),
        // Each psu bootstraps its own MCP — same reason capability:terminal and
        // fleet:launch-on-plan skip it.
        skipMcpJson: true,
      });
      const r = await spawnHeadless({
        envelope: {
          ...base,
          // Same delivery goal-auto-start / capability:launch-agent use: the
          // brief rides the spawn-safe env, read by psu's resolveKickoffText.
          // D-424: on a hosted host the agent-identity spec rides the same env.
          env: {
            ...base.env,
            ...(kickoffPrompt ? { PAPERCUSP_KICKOFF_PROMPT: kickoffPrompt } : {}),
            ...hostedAgentIdentityPsuEnv(),
          },
          greetingCmd: oneliner,
          cwd: base.cwd,
        },
        label: `${agent}${plan ? ` · ${plan}` : ''} (headless)`,
        // The workspace's fleet-logs dir — NON-repo, so git-sync never tries to
        // commit a session log into the staging tree.
        logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
        coordOwnerId: ownerId,
      });
      // `terminal` already reads "headless (log: <path>)", so the caller is told
      // where to tail without a second field.
      spawned =
        r.status === 'ok'
          ? // A headless child has no window that could fail to open, so the
            // early-exit warning below has nothing to be uncertain about —
            // spawnHeadless already probed for a boot-time death and would have
            // returned an error-with-log-tail instead.
            { ok: true, terminal: r.terminal, pid: r.pid ?? undefined, likelyOpened: true }
          : { ok: false, error: r.error };
    } catch (e: any) {
      spawned = { ok: false, error: `headless launch failed: ${e?.message ?? e}` };
    }
  } else {
    // WI-6821 DEFECT A: the child must NOT inherit this operator's own
    // `PAPERCUSP_OPERATOR_URL` verbatim. That variable is contractually a BARE
    // BASE (every caller appends the path itself — `${base}/api/mcp?…`), but a
    // launching operator can carry the already-suffixed MCP url; psu then builds
    // `…/api/mcp/api/…`, 404s, prints a bare `not_found` and exits 1 in ~0.4s.
    // Because the oneliner above is `exec <psu …>`, that exit IS the window
    // closing — the terminal flashes open and shut, the recorded pid dies, psu
    // never registers, and the adv_sessions row written below keeps
    // `session_id NULL` for its whole window. That is exactly the "Starting up
    // — waiting for this session to come online…" the owner reported (reproduced
    // 2026-08-02: bare base → launches; same url + `/api/mcp` → dead in 0.4s).
    // The session outlives this operator process, so its MCP transport uses the
    // stable proxy rather than the current host's restart-prone serving port.
    const [{ resolveLongLivedSessionMcpBaseUrl }, { keepWindowOpenOnFailure }] = await Promise.all([
      import('../../../mcp-base-url'),
      import('../../../console-spawn'),
    ]);
    const r = await spawnInTerminal({
      // WI-37743: NOT the bare `exec ${psuCommand}` this used to send. `exec`
      // replaces the shell, so ANY psu boot refusal — the 409 this very bug
      // was, a bad operator URL, a missing token — closed the window the same
      // instant it printed the reason. The window flashed, the adv_sessions
      // row sat at `session_id NULL` forever, and the owner was told only
      // "Starting up — waiting for this session to come online…". The
      // diagnosis then cost a session of process archaeology (WI-37743) to
      // recover a message that had been printed to a window all along.
      // console-spawn's windows have never had this problem; this is the same
      // helper they use.
      oneliner: keepWindowOpenOnFailure(psuCommand, {
        // WI-37841: point the receipt at THIS launch's boot log — the same
        // file psu itself tees its diagnostics into (psu-launch-log.mjs owns
        // the one derivation, so neither side can drift).
        //
        // The two writers cover disjoint halves of the failure space, which is
        // why both are needed. psu's own tee cannot record a failure that
        // happens BEFORE node runs — psu missing from PATH, an unusable login
        // shell, a bad interpreter — and those exit through this shell wrapper
        // instead. Without the receipt they leave no trace anywhere the
        // operator can read, which is indistinguishable from the launch never
        // having been attempted.
        //
        // Null when there is no pre-pinned owner (a resume) — the wrapper then
        // behaves exactly as it did before, printing to the window only.
        receiptPath: psuLaunchLogPath(ownerId),
      }),
      env: {
        ...process.env,
        PAPERCUSP_OPERATOR_URL: resolveLongLivedSessionMcpBaseUrl(),
        // The bash -lc child inherits this env (the operator-URL var above
        // already rides the same seam) — spawn-safe, unlike a --kickoff argv.
        ...(kickoffPrompt ? { PAPERCUSP_KICKOFF_PROMPT: kickoffPrompt } : {}),
        // D-424: a hosted host's psu runs its agent CLI as the customer account.
        ...hostedAgentIdentityPsuEnv(),
      },
    });
    spawned = r.ok ? r : { ok: false, error: r.error };
  }
  if (!spawned.ok) {
    // The starting row now predates the spawn, so a failed spawn would strand
    // it as a phantom "starting" card forever. Close it out. (Before the
    // reorder this path wrote no row at all, so a failed launch showed as
    // NOTHING on the board — this is strictly more honest, not just tidier.)
    if (startingAdvSessionId != null) {
      void markAdvSessionEnded(startingAdvSessionId, null, 'cleanup').catch(() => {});
    }
    return json({ status: 'error', error: spawned.error }, 500);
  }
  // Stamp on what only the spawn knew. Best-effort for the same reason the
  // insert is: the terminal is already running, so a bookkeeping miss must not
  // turn a successful launch into a reported failure.
  if (startingAdvSessionId != null) {
    void setAdvSessionPid(startingAdvSessionId, spawned.pid ?? null, spawned.terminal ?? null).catch(() => {});
  }
  // EI-18696184925888288: `ok` here only means the OS spawn call didn't
  // throw — it cannot confirm a window actually opened or that psu ever
  // booted (that self-registers a separate adv_sessions row, asynchronously,
  // once it does). When the spawned terminal process already exited by the
  // time we checked, say so — a silent no-op reported as confident success
  // is worse than an honest "not sure this worked".
  //
  // EI-19385011811175105: when the emulator printed something on its way out,
  // LEAD with that line. A silent failure here exits 0, so its stderr is the
  // only evidence of the cause, and without it the owner is told only that
  // "the terminal closed" — which reads as a transient hiccup and sends them
  // to retry a launch that will fail identically every single time.
  // WI-37743: lead with `failureReason` — what WE observed — before the
  // emulator's stderr, because a silent failure prints NOTHING and the old
  // message then degraded to a generic "exited almost immediately" that reads
  // like a transient hiccup and sends the owner to retry a launch that will
  // fail identically every time.
  const warning = spawned.likelyOpened
    ? undefined
    : (spawned.failureReason ? `${spawned.failureReason} — ` : '') +
      (spawned.stderr ? `${spawned.terminal}: ${spawned.stderr} — ` : '') +
      'the spawned terminal process exited almost immediately — it may not have opened a window ' +
      '(a headless/offscreen display, or the terminal emulator failed silently). Check /adv/sessions ' +
      'for the new session; if it never appears, the launch did not actually happen.';

  // (The starting row + its roster notify moved ABOVE the spawn — WI-37743.
  // psu can call bootstrap-su before the spawn call even returns, and the
  // adopt can only complete a row that already exists. See the comment there.)

  return json({
    status: 'ok',
    agent,
    ...(startingAdvSessionId != null ? { advSessionId: startingAdvSessionId } : {}),
    // WI-6363: the pre-pinned coord owner id this session will register as.
    // The caller opens its chat with this — it is pinned before the spawn, so
    // it is stable from launch onward and needs no database round-trip.
    // Absent on a resume (see the mint above).
    //
    // ⚠ NOT "unlike the adv_sessions row, which does not exist yet on this
    // path" — that read TRUE before WI-6376 and is now false: the line above
    // returns `advSessionId` from the STARTING row recorded at :615, which
    // WI-37743 moved ABOVE the spawn. The two clauses sat one line apart and
    // contradicted each other; the stale half caused a false regression report
    // on 2026-08-30.
    ...(ownerId ? { ownerId } : {}),
    harnessSlug: harness,
    planSlug: plan,
    ...(contextSizeNormalization ? { contextSizeNormalization } : {}),
    // WI-6505: the slug this launch resolved the fleet to — the server-side
    // slugify of `fleet_name` when it CREATED one, else the `fleet` it joined.
    // Returned so a multi-member GUI launch can have members 2..N join the
    // fleet member 1 just created WITHOUT re-implementing the slugifier
    // client-side (it truncates at 60 chars and defaults to "fleet", so a copy
    // would disagree exactly where it matters and split the fleet in two).
    ...(fleetSlug ? { fleetSlug } : {}),
    terminal: spawned.terminal,
    pid: spawned.pid,
    ...(warning ? { warning } : {}),
  });
}

type LaunchEvents = {
  'launch-starting': { status: 'starting' };
  'launch-result': { httpStatus: number; body: Record<string, unknown> };
};

const launchSu = defineTool({
  method: 'POST',
  path: '/adv/sessions/launch-su',
  auth: 'loopback',
  handler(req) {
    const url = new URL(req.url);
    if (url.searchParams.get('stream') !== '1') return handleLaunchSu(req);
    url.searchParams.delete('stream');
    const launchRequest = new Request(url, req);
    return sseResponse<LaunchEvents>({
      signal: req.signal,
      heartbeatMs: 5_000,
      setup: async (sink) => {
        sink.event('launch-starting', { status: 'starting' });
        try {
          const response = await handleLaunchSu(launchRequest);
          const body = (await response
            .clone()
            .json()
            .catch(async () => ({
              status: 'error',
              error: await response.text(),
            }))) as Record<string, unknown>;
          sink.event('launch-result', { httpStatus: response.status, body });
        } catch (error) {
          sink.event('launch-result', {
            httpStatus: 503,
            body: {
              status: 'error',
              code: 'attached_engine_start_failed',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          sink.done();
        }
      },
    });
  },
});

export default [launchSu];
