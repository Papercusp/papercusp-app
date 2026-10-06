/**
 * launch-agent.ts — one renderer-side entry point for launching a
 * tracked agent session, across all three backends (agent-launch
 * unification; Phase 4 P-030, converged in P-032).
 *
 * ALL agents go through one path now: `POST /api/adv/sessions/launch-su`
 * → server spawns a terminal running `psu --no-picker --agent=<a> …`,
 * which records the tracked `adv_sessions` row + exec's the matching
 * `*-su` wrapper. model / resume-by-id / kickoff are threaded through to
 * the wrapper (P-032 retired the omp-only `buildEngineerOmpLaunchCommand`
 * / console-launch `mode:'omp'` path — omp now rides psu like the others,
 * so there's a single launch implementation instead of two).
 */
import type { SuSessionBackend } from '@papercusp/chat-protocol';
import type { LaunchOpts } from './native-console';
import type { NativeSessionHandle } from './native-session-handles';
import type { SuAgent, SuContextSize } from './su-agents';

/**
 * The two OWNER-FACING "start something new" surfaces launch with NO window.
 *
 * [owner 2026-08-11, interactive, verbatim]: "okay it worked but it opened
 * the console too, it should launch the agent headlessly" — then, asked whether
 * this should be always-headless or a choice: **"Always headless. same for new
 * goal"**.
 *
 * So this is a flat product rule, not a preference: the HUD's "+ New session"
 * (NewSessionLauncher) and "+ Start a goal" (GoalComposer → goals:start) both
 * send it unconditionally. The owner EXPLICITLY REJECTED both alternatives that
 * were offered — a headed/headless toggle, and headless-only-when-the-chat-opens
 * — so do not reintroduce either as a "flexible" improvement. The owner drives
 * these sessions through the HUD chat, which works on a headless session
 * precisely because psu's `--headless` keeps the managed pty (and therefore
 * injection) ON; the terminal window was never the interaction surface.
 *
 * It is a NAMED CONSTANT rather than a `headless: true` literal at each call
 * site so the rule is single-sourced and greppable: two literals in two
 * components drift the moment one of them is refactored, and the failure is
 * silent (a window reappears, and nothing fails).
 *
 * ⚠ DELIBERATELY NOT the default of `launchAgent`/`launch-su`. Other surfaces
 * launch a terminal ON PURPOSE and their whole point is the window —
 * AgentInspectorModal's "Resume in terminal", the harness DetailPanel's
 * open-in-terminal, and FleetLaunchRow's owner-approved headed/headless picker.
 * `launchAgent` also sends `headless: opts.headless ?? false` explicitly, so a
 * route-level default flip would be inert for every one of them anyway. Scope
 * this to the surfaces the directive names.
 */
export const OWNER_LAUNCH_HEADLESS = true;

export interface LaunchAgentOpts extends LaunchOpts {
  /** Exact GOAL subject bootstrap must attest before the first agent turn. */
  goalBootstrapSubject?: string | null;
  /**
   * WI-10004787: the ownerId this launch is made on behalf of (psu
   * `--launched-by`). bootstrap-su inherits that owner's goal context from it,
   * so a server-side launcher acting FOR an agent must set it; a human launch
   * from the GUI leaves it unset.
   */
  launchedBy?: string | null;
  /** Selected identity layers from the existing blueprint stack. */
  stack?: readonly string[] | null;
  /** Exact source hash shown in the GUI picker; bootstrap rechecks it. */
  selectedIdentityRevision?: string | null;
  /** Existing agent-chat id to bind when PUI creates a durable SU session. */
  agentChatId?: string | null;
  /** Which backend to launch. Omitted → the configured backend
   *  (/settings/agent, resolved server-side by launch-su). */
  agent?: SuAgent;
  /**
   * Deferred (pui-reactive-session-panes D-006): RECORD a pending "workbench
   * launch" instead of spawning a terminal. The session materializes as a pane
   * in the pui workbench (the single launcher), not a standalone terminal.
   * Returns `advSessionId` of the recorded row.
   */
  deferSpawn?: boolean;
  attachedEngine?: boolean;
  /**
   * Initial-context size variant, orthogonal to `agent`. The only value is
   * 'trimmed' (`SuContextSize`): a small core surface up front, grown on demand
   * via tools:find / ctx.activateTools, with tools:invoke reaching anything
   * unseeded. Omitted → 'trimmed'.
   *
   * The former 'full' variant, which advertised the whole superuser catalog up
   * front, is GONE as a mode (trimmed-only-agent-context-launch-2026-08-27) —
   * it survives only as a deprecated input alias that normalizes to 'trimmed'.
   * Do not reintroduce it here: this type is the launch-time surface, so
   * re-widening it is what would let a legacy value reach a spawn.
   */
  contextSize?: SuContextSize;
  /**
   * WI-2140338 [owner 2026-09-01]: session compaction ceiling in TOKENS, threaded
   * to the spawn as `--compaction-limit` (the argv seam MemberSpec.compactionLimit
   * already rides). Lets a launcher pin a session to its model's full window
   * (e.g. 1_000_000) instead of the tier default. Omitted = tier/system default.
   * Distinct from `contextSize` (initial TOOL surface), not a token knob.
   */
  compactionLimit?: number | null;
  /**
   * P-017 (work-on-everything-goal): free-text first-turn brief for the spawned
   * session, delivered via the spawn-safe PAPERCUSP_KICKOFF_PROMPT env
   * (launch-su threads it into the child env; psu's resolveKickoffText reads
   * it). DISTINCT from the inherited curated `kickoff` ({ kind: 'new-plan' }),
   * which selects an in-repo brief file — this one carries the text itself.
   */
  kickoffPrompt?: string | null;
  /**
   * WI-6321 — psu-parity launch options. Before these, a GUI launch could express
   * neither, so every one was silently unfleeted and on the default system
   * credential while `psu` offered both.
   *
   * `fleet` JOINS an existing fleet by slug; `fleetName` CREATES one (this session
   * leads it), optionally forcing its colour via `fleetScheme`. Pass one or the
   * other — launch-su rejects both together.
   */
  fleet?: string | null;
  fleetName?: string | null;
  fleetScheme?: string | null;
  /** psu `--account=`: 'default' (system/CLI login) | 'auto' (gateway-routed with
   *  failover) | a pool account id. A GUI launch should ALWAYS send one — psu with
   *  no --account opens an interactive picker that would hang the spawn. */
  account?: string | null;
  /**
   * psu `--carry=`: how an autonomous session continues across wakes. This is
   * independent of headed/headless and is persisted in `launch_argv` so the
   * runtime's launch contract can be audited after the process starts.
   */
  carry?: 'warm' | 'cold' | null;
  /**
   * Attach to an existing tracked SU session without spawning anything. Kept
   * on the canonical launch route so PUI reuses the same workspace-scoped
   * `adv_sessions` identity and native-handle resolver as every other surface.
   * PUI callers should use {@link openPuiSuSession}, which requires an explicit
   * backend and makes create vs attach a discriminated operation.
   */
  attachAdvSessionId?: number | null;
  /**
   * WI-6505 — psu `--headless`: launch with NO desktop window. The session still
   * registers presence, joins its fleet and stays injectable for warm wakes; it
   * just logs to a file instead of a terminal. Orthogonal to every other option.
   *
   * Omitted/false keeps the historical behaviour exactly (a visible terminal).
   */
  headless?: boolean;
  /**
   * retire-mug-kettle-su-only-2026-08-09 P-042 (D-067) — the launch-time MODE.
   *
   * Before this, AUTO and DRAIN could only be entered by TYPING them to a
   * session that was already running: psu had `--auto` / `--mode=drain` and
   * bootstrap-su registered both durably, but no GUI surface could express
   * either. With the Mug/Kettle tier retired, su + its modes are how the app is
   * driven, so "launch a session that is already in DRAIN" had no route at all.
   *
   * One field, not a `mode` + `auto` pair — a session launches in exactly one
   * posture. Values are the modes registry's `LAUNCHABLE_MODE_IDS`; launch-su
   * validates against the same list and maps it onto psu's argv (`'auto'` is a
   * boolean flag, named modes take `--mode=`).
   *
   * Omitted/null keeps the historical behaviour exactly: a plain interactive
   * session in the default ask-first posture.
   */
  mode?: string | null;
}

export interface LaunchAgentResult {
  ok: boolean;
  /** Set when the launcher (`psu`/`*-su` wrappers) isn't installed. */
  code?: 'omp_not_installed';
  error?: string;
  /** Suggested local command to repair the missing prerequisite. */
  installCmd?: string;
  /**
   * The recorded adv_sessions row id — present on the DEFERRED path and, since
   * WI-6376, on the ORDINARY terminal path too.
   *
   * ⚠ Do NOT use its presence/absence to tell the two paths apart. That was true
   * once and is not any more: WI-6376 (owner ask 2026-07-25 — sessions must appear
   * on the board however they were launched) made launch-su record a STARTING row
   * for every launch carrying an `ownerId`, and WI-37743 moved that insert ABOVE
   * the spawn so an early `bootstrap-su` can adopt a row that already exists.
   * Reading a returned id as "this was rerouted onto the deferred/attach path"
   * produced a confident FALSE regression report on 2026-08-30; the field the code
   * actually branches on is `display`. See the discriminator note in
   * `su-session-real-backend-matrix.integration.test.ts` (§"IT IS STILL THE
   * LIVE-SPAWN PATH"), which carries the full post-mortem.
   *
   * Absent when the launch carries no `ownerId` (e.g. a resume), or when the
   * best-effort insert failed — it must never turn a good launch into a failure.
   */
  advSessionId?: number;
  /**
   * WI-6363: the coord owner id launch-su PRE-PINNED for this session (`psu
   * --owner-id=`), present on BOTH the terminal and deferred paths.
   *
   * This — not `advSessionId` — is the handle a caller opens the session's chat
   * with: it is pinned by the caller before the spawn, so it is stable from launch
   * onward and needs no database round-trip to learn.
   */
  ownerId?: string;
  /**
   * EI-18696184925888288: set when launch-su reported `ok` but the spawned
   * terminal process exited almost immediately — a likely silent launch
   * failure (no window ever opened) that a flat success would hide.
   */
  warning?: string;
  /**
   * WI-6505: the fleet slug this launch resolved to — the server's slugify of
   * `fleetName` when it created one, else the `fleet` joined. A multi-member
   * launch feeds this back as `fleet` for members 2..N so they JOIN rather than
   * each creating their own; never re-derive it client-side.
   */
  fleetSlug?: string;
  /** True when this response recorded a pending workbench launch. */
  deferred?: boolean;
  /** True when this response attached to an existing row without spawning. */
  attached?: boolean;
  /** Explicit backend resolved by launch-su. */
  agent?: SuAgent;
  workspaceId?: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  /** Existing backend-native handle on attach; null while a new row is pending. */
  nativeSession?: NativeSessionHandle | null;
}

export type CreatePuiSuSessionInput = {
  operation: 'create';
  /** PUI never falls back to the global configured backend. */
  backend: SuSessionBackend;
  /** Carry is an explicit launch choice on the PUI contract. */
  carry: 'warm' | 'cold';
  /** Existing agent-chat id to bind to the created adv-session row. */
  agentChatId?: string | null;
} & Omit<
  LaunchAgentOpts,
  'agent' | 'carry' | 'deferSpawn' | 'attachAdvSessionId' | 'resumeSessionId' | 'fork' | 'runPsu'
>;

export interface AttachPuiSuSessionInput {
  operation: 'attach';
  /** Must match the backend persisted on the target adv_sessions row. */
  backend: SuSessionBackend;
  advSessionId: number;
  /** Optional expected context; a mismatch is refused rather than guessed. */
  harnessSlug?: string | null;
  planSlug?: string | null;
}

export type PuiSuSessionInput = CreatePuiSuSessionInput | AttachPuiSuSessionInput;

export interface PuiSuSessionBinding {
  operation: 'created' | 'attached';
  backend: SuSessionBackend;
  advSessionId: number;
  ownerId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  nativeSession: NativeSessionHandle | null;
}

export type PuiSuSessionResult =
  | { ok: true; session: PuiSuSessionBinding }
  | { ok: false; code?: LaunchAgentResult['code']; error: string; installCmd?: string };

/** The launch-su endpoints to try (explicit pin, then same-origin, then Tauri fallback ports). */
function launchSuEndpoints(): string[] {
  const out: string[] = [];
  // An EXPLICIT operator pin beats every implicit fallback below.
  //
  // Without it, a NON-BROWSER caller has no way to say which operator it means:
  // `window` is undefined under vitest, so the same-origin branch is skipped and
  // the call always lands on :3070 — the RELEASE checkout, which serves green
  // `main`. While the gate is red that can be DAYS behind staging, so an
  // acceptance run silently exercises deployed code instead of the tree under
  // test — and still passes, which is the part that makes it dangerous: nothing
  // in the result reports the mismatch. su-session-real-backend-matrix pins the
  // staging operator (:3170) through this so its CREATE hop tests this tree.
  //
  // PAPERCUSP_OPERATOR_BASE is the same env var every other internal-fetch site
  // uses (see agents-list.ts `operatorBase()`), and no running operator sets it,
  // so honouring it here changes nothing until a caller deliberately opts in.
  // This file is isomorphic, hence the guarded `process` access for the webview.
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const pinned = env?.PAPERCUSP_OPERATOR_BASE?.trim();
  if (pinned) out.push(`${pinned.replace(/\/+$/, '')}/api/adv/sessions/launch-su`);
  if (typeof window !== 'undefined') {
    const p = window.location.protocol;
    if (p === 'http:' || p === 'https:') out.push('/api/adv/sessions/launch-su');
  }
  // A Node caller running INSIDE an operator already knows which operator it is:
  // the Hono host stamps `PAPERCUSP_HONO_PORT` on its own process, which is the
  // same signal `operator-api-base.ts operatorApiBase()` derives from. Without
  // this, such a caller falls through to the bare :3070 below and launches on a
  // DIFFERENT operator than the one it is running in — the release checkout,
  // serving green `main`. That is not hypothetical: measured 2026-08-31, the
  // live host owning :3170 carries PAPERCUSP_HONO_PORT=3170 (others 3270/3271),
  // so the goal-holder-launch routine and the three su-session adapters were all
  // reaching the wrong operator in practice.
  //
  // Port 0 means "bind any free port" and cannot be dialled, so it is skipped.
  // With nothing set this resolves to :3070 — byte-identical to the old order.
  const honoPort = Number(env?.PAPERCUSP_HONO_PORT?.trim());
  if (Number.isInteger(honoPort) && honoPort > 0) {
    out.push(`http://localhost:${honoPort}/api/adv/sessions/launch-su`);
  }
  // A non-browser caller with NEITHER a pin NOR a host port still lands here,
  // on the release operator. No warning is emitted for it: `vitest-fail-on-console`
  // makes a library-level console.warn fail every test that launches unpinned
  // (measured — it red-lit launch-agent.test.ts, a file this change never
  // touched), and after the host-port branch above that residual population is
  // just "a Node process outside any operator", for which :3070 is the only
  // sensible guess. Loudness for those callers belongs at the CALL SITE — the
  // blob-containment refusal in su-session-real-backend-matrix is the pattern.
  out.push('http://localhost:3070/api/adv/sessions/launch-su');
  out.push('http://localhost:3055/api/adv/sessions/launch-su');
  // Dedupe: PAPERCUSP_HONO_PORT=3070 (or a pin naming a fallback) would
  // otherwise probe the same endpoint twice on the failure path.
  return [...new Set(out)];
}

/**
 * Launch a tracked agent session via launch-su → psu → `<agent>-su`.
 * Threads model / resume / kickoff so every backend has parity.
 */
export async function launchAgent(opts: LaunchAgentOpts): Promise<LaunchAgentResult> {
  // No explicit agent → omit it; the launch-su route resolves the CONFIGURED
  // backend (/settings/agent). Explicit picks (the sessions launcher) pass
  // through unchanged.
  const agent: SuAgent | null = opts.agent ?? null;
  const body = JSON.stringify({
    agent,
    harness_slug: opts.slug ?? null,
    plan_slug: opts.planSlug ?? null,
    stack: opts.stack ?? null,
    selected_identity_revision: opts.selectedIdentityRevision ?? null,
    model: opts.model ?? null,
    context_size: opts.contextSize ?? null,
    compaction_limit: opts.compactionLimit ?? null,
    resume_session_id: opts.resumeSessionId ?? null,
    kickoff: opts.kickoff ?? null,
    kickoff_prompt: opts.kickoffPrompt ?? null,
    ...(opts.goalBootstrapSubject ? { goal_bootstrap_subject: opts.goalBootstrapSubject } : {}),
    ...(opts.launchedBy ? { launched_by: opts.launchedBy } : {}),
    defer_spawn: opts.deferSpawn ?? false,
    attached_engine: opts.attachedEngine ?? false,
    // WI-6321 — psu parity. Null-safe: an omitted option keeps the previous
    // behaviour exactly (launch-su treats null as "not supplied").
    fleet: opts.fleet ?? null,
    fleet_name: opts.fleetName ?? null,
    fleet_scheme: opts.fleetScheme ?? null,
    account: opts.account ?? null,
    carry: opts.carry ?? null,
    attach_adv_session_id: opts.attachAdvSessionId ?? null,
    // WI-6505. Null-safe like the options above: an omitted flag is "not
    // supplied", which launch-su treats as a headed launch.
    headless: opts.headless ?? false,
    // P-042 / D-067. Null-safe like the options above: omitted is "not
    // supplied", which launch-su treats as the default ask-first posture.
    mode: opts.mode ?? null,
    ...(opts.agentChatId ? { agent_chat_id: opts.agentChatId } : {}),
  });
  let lastError = 'no spawn path available';
  // An operator's own JSON answer outranks a LATER transport failure. In a hosted browser the
  // same-origin endpoint answers (e.g. 403 route_not_relayed) and the localhost fallbacks then
  // throw "Failed to fetch" from the user's own machine; reporting the last error hid the real
  // reason behind "Launch failed: Failed to fetch" (owner #773, 2026-09-28).
  let answeredError: string | null = null;
  for (const url of launchSuEndpoints()) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' }, // CORS "simple request" — sidesteps WebKit preflight
        body,
      });
      const data = (await r.json().catch(() => null)) as
        | {
            status?: string;
            code?: string;
            error?: string;
            advSessionId?: number;
            ownerId?: string;
            warning?: string;
            fleetSlug?: string;
            deferred?: boolean;
            attached?: boolean;
            agent?: SuAgent;
            workspaceId?: string;
            harnessSlug?: string | null;
            planSlug?: string | null;
            nativeSession?: NativeSessionHandle | null;
          }
        | null;
      if (!data) { lastError = `launch-su HTTP ${r.status} (no body)`; continue; }
      if (data.code === 'psu_not_installed') {
        return {
          ok: false,
          code: 'omp_not_installed',
          error: data.error,
          installCmd: 'bash apps/operator/scripts/install-standalone-mcp.sh',
        };
      }
      if (r.ok && data.status === 'ok') {
        return {
          ok: true,
          advSessionId: data.advSessionId,
          ownerId: data.ownerId,
          warning: data.warning,
          fleetSlug: data.fleetSlug,
          deferred: data.deferred,
          attached: data.attached,
          agent: data.agent,
          workspaceId: data.workspaceId,
          harnessSlug: data.harnessSlug,
          planSlug: data.planSlug,
          nativeSession: data.nativeSession,
        };
      }
      lastError = data.error ?? `launch-su HTTP ${r.status}`;
      answeredError = lastError;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: answeredError ?? lastError };
}

/**
 * PUI's one create/attach door. Creation starts an attached structured engine;
 * attach looks up the stable advSessionId without launching another process.
 */
export async function openPuiSuSession(input: PuiSuSessionInput): Promise<PuiSuSessionResult> {
  let launched: LaunchAgentResult;
  if (input.operation === 'create') {
    const { operation: _operation, backend, carry, ...opts } = input;
    launched = await launchAgent({
      ...opts,
      agent: backend,
      // PUI is a non-interactive launcher, so its account route must be
      // explicit. A null/omitted account reaches bootstrap-su as "use the
      // owner's nominated default", which may silently route through the
      // inference gateway. The real Rust PUI already defaults this field to
      // `default` (system credential, gateway skipped); keep the shared TS door
      // on the same contract so tests and alternate PUI clients cannot create a
      // different launch_argv by omission.
      account: opts.account ?? 'default',
      carry,
      deferSpawn: false,
      attachedEngine: true,
      attachAdvSessionId: null,
    });
  } else {
    launched = await launchAgent({
      agent: input.backend,
      slug: input.harnessSlug ?? null,
      planSlug: input.planSlug ?? null,
      deferSpawn: false,
      attachAdvSessionId: input.advSessionId,
    });
  }

  if (!launched.ok) {
    return {
      ok: false,
      ...(launched.code ? { code: launched.code } : {}),
      error: launched.error ?? 'launch-su request failed',
      ...(launched.installCmd ? { installCmd: launched.installCmd } : {}),
    };
  }
  if (!Number.isSafeInteger(launched.advSessionId) || launched.advSessionId! <= 0) {
    return { ok: false, error: 'launch-su returned no stable advSessionId' };
  }
  const backend = launched.agent ?? input.backend;
  if (backend !== input.backend) {
    return {
      ok: false,
      error: `launch-su returned backend ${backend}; expected ${input.backend}`,
    };
  }

  return {
    ok: true,
    session: {
      operation: input.operation === 'create' ? 'created' : 'attached',
      backend,
      advSessionId: launched.advSessionId!,
      ownerId: launched.ownerId ?? null,
      workspaceId: launched.workspaceId ?? null,
      harnessSlug: launched.harnessSlug ?? (input.operation === 'create' ? input.slug : input.harnessSlug) ?? null,
      planSlug: launched.planSlug ?? input.planSlug ?? null,
      nativeSession: launched.nativeSession ?? null,
    },
  };
}
