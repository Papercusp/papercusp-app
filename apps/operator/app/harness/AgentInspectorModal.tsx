'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Modal } from './Modal';
import { TONE } from './theme';
import { Tooltip } from './Tooltip';
import { useLexicon } from '../../lib/useLexicon';
import { agentDisplayLabel } from './agent-display';
import { canUseContentOriginDesktopActions } from '@/lib/ipc-status-tauri';
import {
  useAgentThinkingStream,
  Entry,
  waitingMessage,
  groupEntriesIntoTurns,
  ThinkingDot,
  fmtEntryTime,
  type Turn,
} from './AgentThinkingStream';

/**
 * The header's three session-continuation actions. All POST the SAME
 * `/api/agent-mcp/console/launch` route with the same `resumeSessionId`; they differ
 * only in what the spawned process is:
 *   - `resume` — `psu --resume=<id>` in a NEW TERMINAL (resume in place).
 *   - `fork`   — `psu --resume=<id> --fork` in a new terminal (branch; claude-only).
 *   - `gui`    — `psu --resume=<id> --headless`, NO terminal, then the caller opens
 *                the session's conversation in the HUD popup
 *                (resume-in-gui-button-2026-08-09; claude-only for the same reason
 *                fork is — see the button's comment).
 * Each keeps its OWN busy/error state, so one failing never disables the others.
 */
type LaunchAction = 'resume' | 'fork' | 'gui';

/**
 * AgentInspectorModal — the pinned, full-height view of a run's live thinking
 * stream. Opened by clicking a running agent's row in the AgentsRoster
 * (operator-vite's AgentsRunningPill → onInspect), the LIVE surface for this
 * — NOT a hover popover (EI-5917/WI-2346: AgentThinkingStream.tsx used to also
 * export a default `AgentThinkingPopover` hover component with no JSX caller
 * anywhere in the tree; it was deleted and only its shared hook/renderer
 * exports below survive, reused here).
 *
 * It does NOT dismiss on mouse-leave, so the whole transcript can be read +
 * scrolled. It reuses the shared stream hook + Entry renderer, but presents
 * the timeline grouped into TURNS, NEWEST-FIRST: the turn the agent is
 * currently working streams live at the TOP as "● Live turn" (with a pulsing
 * thinking indicator), and when it completes it becomes the top of the
 * completed-turns list below it — each older turn beneath, latest highest.
 *
 * Empty-timeline state reuses the shared `waitingMessage` helper (WI-1325): a
 * live run producing ZERO output for STALL_AFTER_MS escalates from a hopeful
 * "Waiting…" to a "⚠ no output for {elapsed} — stalled/rate-limited" warning +
 * a "stalled?" header, so a wedged agent stops reading as an eternal green
 * "live · No output yet".
 */
export default function AgentInspectorModal({
  slug,
  phase,
  runId,
  role,
  open,
  onClose,
  startedAtMs,
  streamUrl,
  focusTarget,
  resumeTarget,
  onOpenInGui,
  conversationOwnerId,
  highlightTerm,
}: {
  slug: string;
  phase: string;
  runId: string;
  role: string;
  open: boolean;
  onClose: () => void;
  /** Run start (epoch-ms). Drives the elapsed counter + stall detection while
   *  the timeline is still empty. Optional — defaults to when the inspector was
   *  opened, so a wedged run still escalates from "waiting" to "stalled?". */
  startedAtMs?: number;
  /** Explicit stream URL — set for interactive-session transcripts; omit to use
   *  the bee run-log stream keyed by slug/runId. */
  streamUrl?: string;
  /** The agent's OS terminal-window handle — passed ONLY when focus will work (a
   *  stored X11 `windowId`). Present ⇒ a "Focus window" button that raises the
   *  agent's terminal via `POST /api/adv/sessions/focus`; absent ⇒ no button. */
  focusTarget?: { advSessionId?: number | null; windowId?: string | null; pid?: number | null };
  /**
   * WI-3882 (P-012, adv-sessions-live-roster): the session id to fork/resume
   * into a NEW terminal via `POST /api/agent-mcp/console/launch`'s
   * `resumeSessionId` (plan-agent-launch P-023 — `<agent-cli> -r <id>`,
   * console-launcher.ts). Present ⇒ up to THREE independent buttons, ALL offered
   * for active AND ended sessions (owner ask 2026-07-11 — retracted the earlier
   * "fork only for active / resume only for inactive" split):
   *   • "Resume in new terminal" (fork:false) — always shown when resumeTarget
   *     is present. `<cli> -r <id>` resumes the transcript IN PLACE. Both
   *     claude and omp accept `-r`, so callers gate presence on that alone.
   *     When `live:true` (source still running) this opens a SECOND CLI on the
   *     same live transcript — a collision — so the button carries a warning
   *     tooltip in that case; it stays enabled (owner wants the option).
   *   • "Fork in new terminal" (fork:true) — shown only when `canFork:true`.
   *     `<cli> -r <id> --fork-session` BRANCHES into a new session (the source,
   *     if live, keeps running untouched). `--fork-session` is claude-only
   *     (console-launcher.ts) — omp has no fork command — so callers set
   *     `canFork` = "is a claude session" (see `canForkLive` in
   *     AgentsRunningPill.tsx), independent of active/inactive.
   *   • "Resume in GUI" (headless:true) — resume-in-gui-button-2026-08-09. The same
   *     in-place resume as the first button, but spawned with NO terminal window
   *     (`psu --resume=<id> --headless` via spawnHeadless); the caller then opens the
   *     session's conversation in the HUD popup via `onOpenInGui`. Shown only with
   *     `canFork` + `guiOwnerId` + an `onOpenInGui` host — see the button itself for
   *     why claude-only is structural here rather than incidental. A still-LIVE
   *     source skips the spawn entirely (it is already reachable).
   * Absent ⇒ no buttons (never a dead one). `live` no longer gates which button
   * shows — it tags the Resume button's collision tooltip, and turns the GUI
   * button into a pure "open the conversation" with no relaunch.
   * Linux-only for now, same constraint as the primary /console/launch spawn
   * path itself (see native-console.ts) — mirrors focusTarget's posture.
   */
  resumeTarget?: {
    sessionId: string;
    live: boolean;
    canFork: boolean;
    label?: string | null;
    /**
     * resume-in-gui-button-2026-08-09: the session's COORD OWNER ID — the key the
     * HUD conversation popup (`SessionChatModal`, via `hudsession=`) is addressed by.
     * Supplied by the caller rather than resolved server-side because the caller
     * already holds it on every call site (a roster row's `ownerId`, an ended row's
     * `coordOwnerId`) and it is the id the popup will actually key on — one source,
     * so the button cannot open a popup on a different agent than the one it resumed.
     *
     * Safe to hand to a resumed session because `psu --resume` is
     * IDENTITY-PRESERVING: `resumeEnvFor` reuses `session.coordOwnerId` rather than
     * minting a fresh SID, so the resumed process re-registers under this same id.
     * Absent ⇒ no GUI button (never a dead one).
     */
    guiOwnerId?: string | null;
  } | null;
  /**
   * resume-in-gui-button-2026-08-09 (owner ask 2026-08-09: "add a 'resume in GUI'
   * button that does the same thing as resume in terminal but instead of opening in
   * the terminal it opens it in the HUD -> conversation popup").
   *
   * Called with `resumeTarget.guiOwnerId` once the session is resumed (or immediately,
   * when it was already live). The CALLER owns the navigation — this component lives
   * in `apps/operator` and the HUD's nuqs params (`tab` / `hudsession`) belong to the
   * operator-vite /adv shell, which it cannot import (AGENT-ENV § cross-tree alias
   * trap). Absent ⇒ no GUI button, so a host with nowhere to open a conversation
   * never renders one.
   */
  onOpenInGui?: (ownerId: string) => void;
  /** A read-only history host can open the chat without offering a relaunch. */
  conversationOwnerId?: string;
  /** Search-hit deep-link (agents-pill-inactive-search-2026-07-09 P-005): the
   *  term to highlight throughout the transcript. Pair with a streamUrl that
   *  carries `find`/`anchorTs` — the stream's `anchor` event then names the
   *  matched backfill entry and the pane auto-scrolls to it. */
  highlightTerm?: string;
}) {
  const lex = useLexicon();
  const displayRole = agentDisplayLabel(role, lex);
  const { events, status, thinking, anchor } = useAgentThinkingStream(slug, phase, runId, streamUrl);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Elapsed baseline: the run start when known, else when this inspector opened
  // (captured once). Feeds the stall escalation while the timeline is empty.
  const openedAtRef = useRef<number>(Date.now());
  const [now, setNow] = useState(() => Date.now());
  // Tick a 1s clock ONLY while still waiting on the first output (empty timeline,
  // not terminal) so the elapsed counter + stall escalation update live.
  useEffect(() => {
    if (events.length > 0 || status === 'done') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [events.length, status]);

  // Group the flat timeline into turns and show them NEWEST-FIRST (latest highest).
  // The newest turn is the "live" one while the agent is actively thinking; when a
  // turn completes it just becomes the top of the completed list below.
  const turns = useMemo(() => groupEntriesIntoTurns(events), [events]);
  const ordered = useMemo(() => [...turns].reverse(), [turns]);

  // Search-hit anchor: the matched backfill entry (by identity — backfill
  // entries keep their array positions as live `event` deltas append after).
  const anchorEntry = anchor?.found && anchor.index != null ? events[anchor.index] ?? null : null;

  // Newest turn is at the TOP, so keep the scroll pinned to the top as new turns /
  // entries stream in — unless the user scrolled DOWN to read history, or the
  // pane is anchored to a search match (the match owns the scroll position).
  const atTopRef = useRef(true);
  useEffect(() => {
    if (anchorEntry) return;
    const el = scrollRef.current;
    if (el && atTopRef.current) el.scrollTop = 0;
  }, [events, anchorEntry]);

  // Scroll to the anchored (matched) entry ONCE per stream — after the backfill
  // renders. The wrapper div carries data-anchor="true" (see TurnBlock).
  const anchorScrolledRef = useRef(false);
  useEffect(() => { anchorScrolledRef.current = false; }, [streamUrl, runId]);
  useEffect(() => {
    if (!anchorEntry || anchorScrolledRef.current) return;
    const el = scrollRef.current?.querySelector('[data-anchor="true"]');
    if (!el) return;
    anchorScrolledRef.current = true;
    atTopRef.current = false;
    (el as HTMLElement).scrollIntoView({ block: 'center' });
  }, [anchorEntry, events.length]);

  // "Focus window" — raise the agent's OS terminal via the existing wmctrl-backed
  // endpoint. Only wired when the caller passed a focusTarget (i.e. focus will work).
  const [focusState, setFocusState] = useState<'idle' | 'busy' | 'err' | 'unsupported'>('idle');
  const focusWindow = useCallback(async () => {
    if (!focusTarget) return;
    if (!await canUseContentOriginDesktopActions()) {
      setFocusState('unsupported');
      return;
    }
    setFocusState('busy');
    try {
      const res = await fetch('/api/adv/sessions/focus', {
        method: 'POST',
        // text/plain → CORS "simple request", no preflight OPTIONS (webkit2gtk in
        // the desktop build fails preflight handshakes silently — see the resume
        // handler below + native-console.ts). The route parses the raw body as
        // JSON regardless of content-type.
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          id: focusTarget.advSessionId ?? undefined,
          windowId: focusTarget.windowId ?? undefined,
          pid: focusTarget.pid ?? undefined,
        }),
      });
      setFocusState(res.ok ? 'idle' : 'err');
    } catch {
      setFocusState('err');
    }
  }, [focusTarget]);

  // "Fork/Resume in new terminal" (WI-3882) — reuse the existing capability:
  // terminal + psu-session-resume path (plan-agent-launch P-023) via the same
  // console-launch route the "+" console button / capability:terminal use.
  // TASK2 (owner ask 2026-07-11): Resume (fork:false) and Fork (fork:true) are
  // two INDEPENDENT actions now, each offered for active AND ended sessions —
  // so track launch state + the server's failure reason per action.
  //
  // resume-in-gui-button-2026-08-09 adds a THIRD action on the same route + the same
  // per-action bookkeeping: `gui` — a resume with `headless:true`, i.e. no terminal
  // window, whose conversation the caller then opens in the HUD.
  const [launchState, setLaunchState] = useState<Record<LaunchAction, 'idle' | 'busy' | 'err'>>(
    { resume: 'idle', fork: 'idle', gui: 'idle' },
  );
  // The server's actual failure reason (WI-3988/WI-3989) per action — shown as
  // that button's tooltip so a failure is diagnosable, not a bare "failed".
  const [launchErr, setLaunchErr] = useState<Record<LaunchAction, string | null>>(
    { resume: null, fork: null, gui: null },
  );
  const launchResume = useCallback(async (key: LaunchAction) => {
    if (!resumeTarget) return;
    const guiOwnerId = resumeTarget.guiOwnerId ?? null;
    if (key === 'gui' && (!guiOwnerId || !onOpenInGui)) return;
    // A still-LIVE source needs NO spawn to be reachable in the GUI: it is already
    // running and already injectable, so the conversation popup can talk to it right
    // now. Resuming it anyway would open a second CLI on the same transcript — the
    // exact collision the Resume tooltip warns about — and buy nothing. (The terminal
    // Resume keeps offering that, deliberately: the owner wants the option there.)
    if (key === 'gui' && resumeTarget.live) {
      onOpenInGui!(guiOwnerId!);
      return;
    }
    setLaunchState((s) => ({ ...s, [key]: 'busy' }));
    setLaunchErr((e) => ({ ...e, [key]: null }));
    try {
      const res = await fetch('/api/agent-mcp/console/launch', {
        method: 'POST',
        // WI-3988/WI-3989: use text/plain, NOT application/json. application/json
        // is not a CORS "simple request", so it triggers a preflight OPTIONS —
        // which webkit2gtk in the desktop build fails SILENTLY, so the POST never
        // reached the server and Fork/Resume died with a bare "failed" (the
        // console-launch debug log showed no browser request at all). text/plain
        // is a simple request (no preflight); the route parses the raw body as
        // JSON regardless of content-type. Mirrors the proven native-console.ts
        // console-launch path (the working "+" console button uses text/plain).
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          resumeSessionId: resumeTarget.sessionId,
          // fork:true → `--fork-session` (branch into a new session, source
          // untouched, claude-only); fork:false → `-r` (resume in place). A
          // resume-in-place of a still-LIVE session opens a second CLI on the
          // same transcript (the collision the Resume tooltip warns about).
          fork: key === 'fork',
          // resume-in-gui-button-2026-08-09: the ONLY difference between `resume`
          // and `gui` on the wire. Server-side it swaps `spawnConsole` for
          // `spawnHeadless` and appends psu's `--headless` — no window, but the
          // managed pty (and so the injectability the HUD composer needs) stays on.
          ...(key === 'gui' ? { headless: true } : {}),
          label: resumeTarget.label ?? `${key} · ${displayRole}`,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.status === 'ok') {
        setLaunchState((s) => ({ ...s, [key]: 'idle' }));
        // Hand the conversation over ONLY once the resume actually succeeded —
        // opening the popup on a launch that failed would show an agent that is not
        // there and a composer with nobody to wake.
        if (key === 'gui') onOpenInGui!(guiOwnerId!);
      } else {
        setLaunchErr((e) => ({ ...e, [key]: data?.error ?? `HTTP ${res.status}` }));
        setLaunchState((s) => ({ ...s, [key]: 'err' }));
      }
    } catch (e) {
      setLaunchErr((e2) => ({ ...e2, [key]: e instanceof Error ? e.message : 'request failed' }));
      setLaunchState((s) => ({ ...s, [key]: 'err' }));
    }
  }, [resumeTarget, displayRole, onOpenInGui]);

  const elapsedMs = Math.max(0, now - (startedAtMs ?? openedAtRef.current));
  const waiting = waitingMessage(status, elapsedMs);
  // A live run sitting on zero output past the stall threshold reads as
  // "stalled?" instead of a reassuring green "live" (shared waitingMessage logic).
  const stalledNow = events.length === 0 && status === 'live' && waiting.stalled;
  const statusLabel = stalledNow ? 'stalled?' : status === 'connecting' ? 'connecting…' : status;
  const statusColor = stalledNow ? TONE.warn
    : status === 'live' ? TONE.good
    : status === 'error' ? TONE.bad
    : TONE.neutral;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Agent inspector — ${displayRole}`}
      srOnlyTitle
      contentStyle={{
        width: 'min(880px, 94vw)',
        height: 'min(78vh, 900px)',
        padding: 0,
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'var(--fg)',
      }}
    >
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--bg-2)',
        fontSize: 12,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-mute)' }}>
          <Tooltip label="Back to agent sessions">
            <button
              type="button"
              data-testid="agent-inspector-back"
              aria-label="Back to agent sessions"
              onClick={onClose}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                padding: 0,
                color: 'var(--fg-mute)',
                background: 'transparent',
                border: '1px solid transparent',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <ArrowLeft size={15} aria-hidden />
            </button>
          </Tooltip>
          <span>
            <strong style={{ color: 'var(--fg)' }}>{displayRole}</strong>
            {' · '}<code style={{ fontSize: 11 }}>{runId}</code>
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {conversationOwnerId && onOpenInGui ? (
            <button type="button" className="h-button" onClick={() => onOpenInGui(conversationOwnerId)}>
              Open conversation
            </button>
          ) : null}
          {/* TASK2 (owner 2026-07-11): Resume + Fork are two INDEPENDENT buttons,
              both offered for active AND ended sessions. Resume (↻, fork:false)
              always shows when a resumeTarget is present; on a still-LIVE source
              it carries a collision-warning tooltip (a second CLI on the same
              transcript) but stays enabled. Fork (⑂, fork:true) shows only for a
              claude session (canFork) since --fork-session is claude-only.
              Native `title` (not a Radix Tooltip whose label toggles) — see
              EI-9449: a label that flips falsy⇄truthy after mount remounts the
              whole button subtree and strands any DOM ref mid-flight. */}
          {resumeTarget ? (
            <button
              type="button"
              data-testid="resume-terminal-btn"
              onClick={() => launchResume('resume')}
              disabled={launchState.resume === 'busy'}
              title={launchState.resume === 'err' && launchErr.resume
                ? launchErr.resume
                : resumeTarget.live
                  ? 'Opens a second CLI on the still-running session (same transcript) — may collide with the live agent. Use Fork to branch a fresh session instead.'
                  : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: launchState.resume === 'busy' ? 'default' : 'pointer',
                color: launchState.resume === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>↻</span>
              {launchState.resume === 'busy'
                ? 'resuming…'
                : launchState.resume === 'err'
                  ? 'resume failed'
                  : 'Resume in new terminal'}
            </button>
          ) : null}
          {resumeTarget?.canFork ? (
            <button
              type="button"
              data-testid="fork-terminal-btn"
              onClick={() => launchResume('fork')}
              disabled={launchState.fork === 'busy'}
              title={launchState.fork === 'err' && launchErr.fork ? launchErr.fork : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: launchState.fork === 'busy' ? 'default' : 'pointer',
                color: launchState.fork === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>⑂</span>
              {launchState.fork === 'busy'
                ? 'forking…'
                : launchState.fork === 'err'
                  ? 'fork failed'
                  : 'Fork in new terminal'}
            </button>
          ) : null}
          {/* resume-in-gui-button-2026-08-09 (owner ask 2026-08-09) — "Resume in GUI",
              deliberately to the RIGHT of Resume + Fork. Same resume as those, minus
              the terminal: the session comes back headless (no window) and the caller
              opens its conversation in the HUD popup, where the composer talks to it.

              Gated on `canFork` — which is literally `agent === 'claude'`
              (canForkSession) — because the claude branch is the ONLY one whose
              console resume routes through psu, and psu is what gives the resumed
              session its coord presence + injectable pty. A headless codex/omp resume
              would exec a bare CLI nobody could reach, so the server refuses it too;
              the gate here just avoids offering a button that would 400.

              Also gated on `guiOwnerId` + `onOpenInGui`: with no id to key the popup
              on, or no host able to open one, the action has no destination — so it
              is not rendered rather than rendered dead. */}
          {resumeTarget?.canFork && resumeTarget.guiOwnerId && onOpenInGui ? (
            <button
              type="button"
              data-testid="resume-gui-btn"
              onClick={() => launchResume('gui')}
              disabled={launchState.gui === 'busy'}
              title={launchState.gui === 'err' && launchErr.gui
                ? launchErr.gui
                : resumeTarget.live
                  ? 'This session is still running, so nothing is re-launched — this just opens its conversation in the HUD.'
                  : 'Resumes the session with no terminal window and opens its conversation in the HUD.'}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: launchState.gui === 'busy' ? 'default' : 'pointer',
                color: launchState.gui === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>⧉</span>
              {launchState.gui === 'busy'
                ? 'resuming…'
                : launchState.gui === 'err'
                  ? 'GUI resume failed'
                  : 'Resume in GUI'}
            </button>
          ) : null}
          {focusTarget ? (
            <button
              type="button"
              data-testid="focus-window-btn"
              onClick={focusWindow}
              disabled={focusState === 'busy'}
              title={focusState === 'unsupported' ? 'Window focus is available only in the desktop GUI connected to its local Server.' : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                font: 'inherit', fontSize: 11, cursor: focusState === 'busy' ? 'default' : 'pointer',
                color: focusState === 'err' ? TONE.bad : 'var(--fg)',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 5, padding: '2px 8px', lineHeight: 1.4,
              }}
            >
              <span aria-hidden>⤢</span>
              {focusState === 'busy' ? 'focusing…' : focusState === 'err' ? 'focus failed' : focusState === 'unsupported' ? 'desktop only' : 'Focus window'}
            </button>
          ) : null}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {thinking ? <ThinkingDot size={7} /> : (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
            )}
            <span style={{ color: thinking ? TONE.good : statusColor }}>{thinking ? 'thinking…' : statusLabel}</span>
            <span style={{ color: 'var(--fg-mute)' }}>· {turns.length} turn{turns.length === 1 ? '' : 's'} · {events.length} event{events.length === 1 ? '' : 's'}</span>
            {highlightTerm && anchor ? (
              <span
                data-testid="anchor-status"
                style={{ color: anchor.found ? 'var(--accent-strong, #7dd3fc)' : TONE.warn }}
              >
                {anchor.found
                  ? `· ⚓ jumped to match`
                  : '· match not in transcript — showing latest'}
              </span>
            ) : null}
          </span>
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atTopRef.current = el.scrollTop < 40;
        }}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: waiting.stalled ? TONE.warn : 'var(--fg-mute)', fontStyle: 'italic' }}>
            {waiting.text}
          </div>
        ) : (
          ordered.map((turn, i) => (
            <TurnBlock
              key={turn.seq}
              turn={turn}
              live={thinking && i === 0}
              highlightTerm={highlightTerm}
              anchorEntry={anchorEntry}
            />
          ))
        )}
      </div>
    </Modal>
  );
}

/**
 * One turn rendered as a bordered block: a header (● Live turn while streaming,
 * else "Turn N" + its time) over the turn's prompt + activity. The live turn sits
 * at the TOP of the pane (newest-first) and is accented + pulsing. When the pane
 * is anchored to a search hit, the matched entry's wrapper carries
 * data-anchor="true" (the auto-scroll target) + an accent outline, and every
 * entry highlights `highlightTerm` occurrences.
 */
function TurnBlock({
  turn,
  live,
  highlightTerm,
  anchorEntry,
}: {
  turn: Turn;
  live: boolean;
  highlightTerm?: string;
  anchorEntry?: import('./AgentThinkingStream').TimelineEntry | null;
}) {
  const time = fmtEntryTime(turn.startTs);
  const accent = live ? 'var(--accent, #38bdf8)' : 'var(--border)';
  return (
    <div
      data-testid={live ? 'turn-live' : `turn-${turn.seq}`}
      style={{
        marginBottom: 12,
        border: `1px solid ${accent}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 94%)' : 'transparent',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
        background: live ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'var(--bg-2)',
        borderBottom: '1px solid var(--border)', fontSize: 11,
      }}>
        {live ? <ThinkingDot size={7} /> : (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fg-mute)', display: 'inline-block' }} />
        )}
        <strong style={{ color: live ? 'var(--accent-strong, #7dd3fc)' : 'var(--fg)' }}>
          {live ? 'Live turn' : `Turn ${turn.seq + 1}`}
        </strong>
        {time ? <span style={{ color: 'var(--fg-mute)', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span> : null}
      </div>
      <div style={{ padding: 8 }}>
        {/* Newest-first WITHIN the turn too, so the current streamed line is the
            highest thing in the (top) live turn — not buried at the bottom. The
            prompt is the oldest event of the turn, so it falls to the foot. */}
        {[...(turn.prompt ? [turn.prompt, ...turn.entries] : turn.entries)]
          .reverse()
          .map((e, i) => {
            const anchored = Boolean(anchorEntry && e === anchorEntry);
            return (
              <div
                key={i}
                data-anchor={anchored ? 'true' : undefined}
                style={anchored
                  ? { outline: '2px solid var(--accent, #38bdf8)', outlineOffset: 2, borderRadius: 4 }
                  : undefined}
              >
                <Entry entry={e} highlightTerm={highlightTerm} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
