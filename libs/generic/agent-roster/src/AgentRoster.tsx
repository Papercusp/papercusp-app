/**
 * AgentRoster — the fleet-grouped roster list, the machine tabs above it, the
 * multi-select bulk bar, and the hover/pin detail strip below it.
 *
 * This is the presentation half of the operator's agents-running popover, lifted
 * whole (P-001 / D-005) so a second surface renders the SAME roster from the SAME
 * code. What stayed behind in the host, and why, is the entire point:
 *
 *   · DATA — the host runs its own query and hands `agents` in as a prop. This
 *     component never fetches.
 *   · URL STATE — the selected machine tab is `machineTab` + `onMachineTabChange`.
 *     The operator keeps it in nuqs (the repo's rule: user-meaningful state lives
 *     in the URL, and an agent-readable surface must be able to see it); a host
 *     with no router can pass local state or nothing at all.
 *   · CHROME — tooltip and the two dots arrive through `chrome`.
 *   · ACTIONS — the bulk bar's endpoints arrive through `bulk`; the inspector is
 *     `onInspect`, and the host mounts its own modal. Omit either and the
 *     affordance is not rendered at all, which is how a read-only host stays
 *     honest instead of showing dead buttons.
 *
 * Hovering a row previews that agent in the detail strip. Clicking uses the
 * host's row-activation seam when present; otherwise it pins the row, or opens
 * live thinking when the host offers an inspector and the agent has a stream.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  activityLiveness,
  activityLivenessTitle,
  canFocusWindow,
  displayName,
  fmtCompactAge,
  groupByFleet,
  hasThinking,
  isTranscriptFresh,
  machineKey,
  machineTabs,
} from './logic';
import { KIND_GLYPH, KIND_LEGEND, agentGlyph } from './glyphs';
import { AgentDetailStrip } from './AgentDetailStrip';
import { defaultRosterChrome, identityRosterLabels, type RosterBulkActions, type RosterChrome, type RosterLabels } from './seams';
import type { RosterAgent } from './types';

export interface AgentRosterProps {
  agents: RosterAgent[];
  /** A clock the host ticks (the operator ticks 1s while its popover is open) so
   *  the last-active pills count up between roster pushes. */
  nowMs: number;
  /** Deep-link target: pin + scroll this agent's row into view once per focus
   *  value. Re-running on a push-driven refresh would fight the user, so it is
   *  handled exactly once per distinct value. */
  focusOwner?: string | null;
  /** The host's presentational primitives. Defaults render correctly unstyled. */
  chrome?: RosterChrome;
  /** The host's vocabulary. Defaults leave every word exactly as stored. */
  labels?: RosterLabels;
  /** Selected machine tab key. Controlled by the host so the operator can keep it
   *  in the URL. `undefined`/null selects the first (local) tab. */
  machineTab?: string | null;
  onMachineTabChange?: (key: string | null) => void;
  /** Omit to render with NO checkboxes and NO bulk bar — the correct read-only
   *  roster for a host that cannot act on agents. */
  bulk?: RosterBulkActions | null;
  /** Omit to render with no inspect affordance anywhere. */
  onInspect?: (a: RosterAgent) => void;
  /**
   * Host-owned row activation. When supplied, this runs for every row (including
   * rows without a transcript handle), allowing a host to navigate to its own
   * conversation surface. It takes precedence over `onInspect`; the latter
   * remains the desktop inspector seam for hosts that do not need custom routing.
   */
  onRowActivate?: (a: RosterAgent) => void;
  /** Rendered inside the roster root, after the detail strip — where the host
   *  mounts its own inspector modal so it sits in the same stacking context. */
  children?: ReactNode;
}

export function AgentRoster({
  agents,
  nowMs,
  focusOwner = null,
  chrome = defaultRosterChrome,
  labels = identityRosterLabels,
  machineTab = null,
  onMachineTabChange,
  bulk = null,
  onInspect,
  onRowActivate,
  children,
}: AgentRosterProps): JSX.Element {
  const { Tooltip, LivenessDot, ThinkingDot } = chrome;
  const nameOf = (a: RosterAgent) => displayName(a, labels.agentLabel);
  const selectable = Boolean(bulk);

  const [pinned, setPinned] = useState<string | null>(null);
  // Keep the most recently previewed agent selected after the pointer leaves the
  // roster. The detail strip sits directly above whatever the host puts below it;
  // clearing hover on mouse-leave made that whole section blink out while the user
  // moved toward it. Falling back to the first visible agent also keeps the strip
  // mounted before the first hover and across push-driven roster refreshes.
  const [previewed, setPreviewed] = useState<string | null>(null);

  // Deep-link focus: pin + preview + scroll — handled ONCE per focus value
  // (push-driven roster refreshes re-run the effect; re-pinning is harmless but
  // re-scrolling would fight the user).
  const focusHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusOwner) {
      focusHandledRef.current = null;
      return;
    }
    if (focusHandledRef.current === focusOwner) return;
    if (!agents.some((a) => a.ownerId === focusOwner)) return;
    focusHandledRef.current = focusOwner;
    setPinned(focusOwner);
    setPreviewed(focusOwner);
    const t = window.setTimeout(() => {
      document
        .querySelector(`[data-testid="agent-row-${focusOwner}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => window.clearTimeout(t);
  }, [focusOwner, agents]);

  // Per-machine tabs: THIS machine ("Local") first, then each connected machine.
  // Only shown when >1 machine is present; otherwise the whole roster renders as
  // before.
  const tabs = useMemo(() => machineTabs(agents), [agents]);
  const showTabs = tabs.length > 1;
  const activeTabKey = showTabs
    ? (machineTab && tabs.some((t) => t.key === machineTab) ? machineTab : tabs[0].key)
    : null;
  const shown = useMemo(
    () => (activeTabKey ? agents.filter((a) => machineKey(a) === activeTabKey) : agents),
    [agents, activeTabKey],
  );
  const groups = useMemo(() => groupByFleet(shown), [shown]);
  const total = shown.length;

  // Sticky detail selection: the explicitly pinned/hovered agent wins, then
  // whoever we were ALREADY showing (if still present), then the first row.
  // Resolving through this fallback chain means a live-roster refresh that briefly
  // drops the selected agent no longer collapses `active` to null. That null was
  // what made the detail strip disappear and reappear on every refresh; now it
  // stays mounted, falling through to the last-shown agent (or the first row).
  const lastShownIdRef = useRef<string | null>(null);
  const active = useMemo(() => {
    const findIn = (id: string | null) => {
      if (!id) return null;
      for (const g of groups) {
        const a = g.agents.find((x) => x.ownerId === id);
        if (a) return { agent: a, color: g.color };
      }
      return null;
    };
    return (
      findIn(pinned) ??
      findIn(previewed) ??
      findIn(lastShownIdRef.current) ??
      (shown[0] ? findIn(shown[0].ownerId) : null)
    );
  }, [groups, shown, pinned, previewed]);
  // Remember whoever the strip is currently showing, so the next refresh prefers
  // to keep showing them (sticky) rather than snapping back to the first row.
  useEffect(() => {
    if (active) lastShownIdRef.current = active.agent.ownerId;
  }, [active]);

  // ── Multi-select + bulk actions ─────────────────────────────────────────
  // Per-row checkboxes select agents; a bulk bar (shown when ≥1 in the CURRENT
  // machine-tab view is selected) drives the host's actions. Every endpoint is the
  // host's — this component only decides WHEN to call them and what to say about
  // the result.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'message' | 'wake' | 'focus' | 'kill'>(null);
  const [composing, setComposing] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [killArmed, setKillArmed] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  // Only agents in the current view (machine tab) count — switching tabs hides the
  // bar rather than acting on off-screen selections.
  const selectedAgents = useMemo(() => shown.filter((a) => selected.has(a.ownerId)), [shown, selected]);
  const selectedIds = selectedAgents.map((a) => a.ownerId);
  const allShownSelected = shown.length > 0 && shown.every((a) => selected.has(a.ownerId));
  const toggleSelected = (ownerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
    setKillArmed(false);
    setBulkNote(null);
  };
  const selectAllShown = () => {
    setSelected(new Set(shown.map((a) => a.ownerId)));
    setKillArmed(false);
    setBulkNote(null);
  };
  const clearSelection = () => {
    setSelected(new Set());
    setKillArmed(false);
    setComposing(false);
    setBulkNote(null);
  };

  /** Run one host action with the busy/note bookkeeping every button shares.
   *  A thrown Error's message becomes the note, so a host reports its own
   *  precision ("Wake failed (HTTP 503)") rather than a generic word; anything
   *  else thrown falls back to `fallbackFailure`. A failure is never swallowed
   *  into a silent no-op. Resolves true only if the action did not throw. */
  const runBulk = async (
    phase: 'message' | 'wake' | 'focus' | 'kill',
    fallbackFailure: string,
    action: () => Promise<string | null>,
  ): Promise<boolean> => {
    setBulkBusy(phase);
    setBulkNote(null);
    try {
      setBulkNote(await action());
      return true;
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : fallbackFailure;
      setBulkNote(msg);
      return false;
    } finally {
      setBulkBusy(null);
    }
  };

  const sendBulkMessage = async () => {
    const text = msgText.trim();
    const send = bulk?.message;
    if (!text || selectedIds.length === 0 || !send) return;
    const sent = await runBulk('message', 'Message failed', () => send(selectedIds, text));
    // Clear the composer only on a send that did not throw — a failure keeps the
    // text so the user does not lose what they typed.
    if (sent) {
      setComposing(false);
      setMsgText('');
    }
  };
  const wakeSelected = async () => {
    if (selectedIds.length === 0 || !bulk?.wake) return;
    await runBulk('wake', 'Wake failed', () => bulk.wake!(selectedIds));
  };
  const focusSelected = async () => {
    if (!bulk?.focus) return;
    // Short-circuit before calling the host at all when nothing in the selection
    // could possibly be focused. The host still receives the WHOLE selection (see
    // RosterBulkActions) so its note can account for the ones it skipped.
    if (!selectedAgents.some((a) => canFocusWindow(a))) {
      setBulkNote('None of the selected have a focusable window');
      return;
    }
    await runBulk('focus', 'Focus failed', () => bulk.focus!(selectedAgents));
  };
  const killSelected = async () => {
    if (!bulk?.kill) return;
    // Confirm-armed: first click arms ("Confirm kill N?"), second executes.
    if (!killArmed) {
      setKillArmed(true);
      setBulkNote(null);
      return;
    }
    await runBulk('kill', 'Kill failed', () => bulk.kill!(selectedAgents));
    setKillArmed(false);
    setSelected(new Set());
  };
  const copyIds = async () => {
    if (!bulk?.copyIds) return;
    try {
      setBulkNote(await bulk.copyIds(selectedIds));
    } catch {
      setBulkNote('Copy failed');
    }
  };

  const rowClass = (a: RosterAgent) =>
    `pc-agents-roster__row${selectable ? '' : ' pc-agents-roster__row--nocheck'}`
    + `${a.ownerId === pinned ? ' is-pinned' : ''}`
    + `${selected.has(a.ownerId) ? ' is-selected' : ''}`;

  /** Click/Enter on a row: run the host's primary action when supplied; otherwise
   *  open live thinking when an inspector + stream exist, or toggle its pin.
   *  Hover always previews. */
  const activateRow = (a: RosterAgent) => {
    if (onRowActivate) {
      onRowActivate(a);
      return;
    }
    if (onInspect && hasThinking(a)) onInspect(a);
    else setPinned((p) => (p === a.ownerId ? null : a.ownerId));
  };

  return (
    // The last preview remains selected when the pointer leaves. This keeps the
    // detail strip mounted while the user moves into it or into whatever the host
    // renders below it.
    <div
      className="pc-agents-roster"
      role="group"
      aria-label={`${total} agents running`}
      data-testid="agents-roster"
    >
      {showTabs && (
        <div className="pc-agents-roster__tabs" role="tablist" data-testid="agents-machine-tabs">
          {tabs.map((t) => (
            <Tooltip
              key={t.key}
              label={t.isLocal ? 'Agents on this machine' : `Agents on ${t.label}`}
              side="bottom"
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.key === activeTabKey}
                className={`pc-agents-roster__tab${t.key === activeTabKey ? ' is-active' : ''}`}
                data-testid={`agents-machine-tab-${t.key}`}
                onClick={() => onMachineTabChange?.(t.key === tabs[0].key ? null : t.key)}
              >
                {t.label} <span className="pc-agents-roster__tab-count">{t.count}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <div className="pc-agents-roster__legend" aria-hidden>
        {KIND_LEGEND.map(({ kind, term, literal }) => (
          <span key={kind} className="pc-agents-roster__legend-item">
            {KIND_GLYPH[kind] ?? '·'} {term ? labels.term(term, { lower: true }) : literal}
          </span>
        ))}
      </div>
      {bulk && selectedAgents.length > 0 ? (
        <div className="pc-agents-roster__bulkbar" data-testid="agents-bulk-bar" role="toolbar" aria-label="Bulk agent actions">
          <span className="pc-agents-roster__bulk-count" data-testid="agents-bulk-count">{selectedAgents.length} selected</span>
          {bulk.message ? (
            <button
              type="button"
              className="pc-agents-roster__bulk-btn"
              data-testid="agents-bulk-message"
              onClick={() => { setComposing((c) => !c); setKillArmed(false); setBulkNote(null); }}
            >
              ✉ Message
            </button>
          ) : null}
          {/* Bulk-action hints ride the injected Tooltip (constant labels, so the
              falsy<->truthy remount trap does not apply) — a native title= on a
              button trips the operator's design-primitives lint. */}
          {bulk.wake ? (
            <Tooltip label="Re-invoke the selected agents (coord wake)">
              <button
                type="button"
                className="pc-agents-roster__bulk-btn"
                data-testid="agents-bulk-wake"
                disabled={bulkBusy === 'wake'}
                onClick={wakeSelected}
              >
                {bulkBusy === 'wake' ? 'nudging…' : '⏰ Wake'}
              </button>
            </Tooltip>
          ) : null}
          {bulk.focus ? (
            <Tooltip label="Raise the selected agents' terminal windows">
              <button
                type="button"
                className="pc-agents-roster__bulk-btn"
                data-testid="agents-bulk-focus"
                disabled={bulkBusy === 'focus'}
                onClick={focusSelected}
              >
                {bulkBusy === 'focus' ? 'focusing…' : '⤢ Focus all'}
              </button>
            </Tooltip>
          ) : null}
          {bulk.copyIds ? (
            <Tooltip label="Copy the selected owner ids to the clipboard">
              <button
                type="button"
                className="pc-agents-roster__bulk-btn"
                data-testid="agents-bulk-copy"
                onClick={copyIds}
              >
                ⧉ Copy ids
              </button>
            </Tooltip>
          ) : null}
          {bulk.kill ? (
            <Tooltip label="Close the selected agents' terminal windows (graceful — SIGHUPs the CLI)">
              <button
                type="button"
                className={`pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--danger${killArmed ? ' is-armed' : ''}`}
                data-testid="agents-bulk-kill"
                disabled={bulkBusy === 'kill'}
                onClick={killSelected}
              >
                {bulkBusy === 'kill'
                  ? 'killing…'
                  : killArmed
                    ? `⚠ Confirm kill ${selectedAgents.length}?`
                    : '✕ Kill'}
              </button>
            </Tooltip>
          ) : null}
          <span className="pc-agents-roster__bulk-spacer" />
          <button
            type="button"
            className="pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost"
            data-testid="agents-bulk-selectall"
            onClick={allShownSelected ? clearSelection : selectAllShown}
          >
            {allShownSelected ? 'Deselect all' : 'Select all'}
          </button>
          <button
            type="button"
            className="pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost"
            data-testid="agents-bulk-clear"
            onClick={clearSelection}
          >
            Clear
          </button>
          {bulkNote ? (
            <span className="pc-agents-roster__bulk-note" data-testid="agents-bulk-note">{bulkNote}</span>
          ) : null}
          {composing ? (
            <div className="pc-agents-roster__compose" data-testid="agents-bulk-compose">
              <textarea
                className="pc-agents-roster__compose-input"
                data-testid="agents-bulk-msg"
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                placeholder={`Message ${selectedAgents.length} agent${selectedAgents.length === 1 ? '' : 's'}…`}
                rows={2}
                autoFocus
              />
              <div className="pc-agents-roster__compose-actions">
                <button
                  type="button"
                  className="pc-agents-roster__bulk-btn"
                  data-testid="agents-bulk-msg-send"
                  disabled={bulkBusy === 'message' || msgText.trim().length === 0}
                  onClick={sendBulkMessage}
                >
                  {bulkBusy === 'message' ? 'sending…' : 'Send'}
                </button>
                <button
                  type="button"
                  className="pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost"
                  onClick={() => setComposing(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="pc-agents-roster__scroll" data-testid="agents-roster-scroll">
        {groups.map((g) => (
          <section key={g.slug ?? '__none'} className="pc-agents-roster__group">
            <header
              className="pc-agents-roster__group-head"
              style={g.slug ? { color: g.color ?? undefined } : undefined}
            >
              <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
              {g.slug ?? 'No fleet'} <span className="pc-agents-roster__group-count">({g.agents.length})</span>
            </header>
            {g.agents.map((a) => (
              <div
                key={a.ownerId}
                className={rowClass(a)}
                data-testid={`agent-row-${a.ownerId}`}
                data-liveness={a.liveness}
                role="button"
                tabIndex={0}
                onMouseEnter={() => setPreviewed(a.ownerId)}
                onClick={() => activateRow(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activateRow(a);
                  }
                }}
              >
                {/* A REAL native accent checkbox: a shared Radix primitive's
                    <button>+svg restyle never matched the approved native mockup,
                    because it is an approximation, not the browser's own checkbox.
                    A native <input type=checkbox> with accent-color IS the native
                    accent look, and the Tauri/WebKitGTK webview draws it natively.
                    stopPropagation on click+keydown so ticking the box never opens
                    the inspector / pins the row (the row's own handlers). */}
                {selectable ? (
                  <input
                    type="checkbox"
                    className="pc-agents-roster__check"
                    data-testid={`agent-select-${a.ownerId}`}
                    checked={selected.has(a.ownerId)}
                    aria-label={`Select ${nameOf(a)}`}
                    onChange={() => toggleSelected(a.ownerId)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                ) : null}
                <span className="pc-agents-roster__live">
                  {isTranscriptFresh(a) ? (
                    <ThinkingDot size={7} title={`${nameOf(a)} — thinking`} />
                  ) : (
                    <LivenessDot
                      liveness={activityLiveness(a, nowMs)}
                      size={7}
                      title={activityLivenessTitle(a, nowMs)}
                    />
                  )}
                  {fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs) ? (
                    <span
                      className="pc-agents-roster__age"
                      title={`last turn ${fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs)} ago`}
                    >
                      {fmtCompactAge(a.lastActiveAt ?? a.heartbeatAt, nowMs)}
                    </span>
                  ) : null}
                </span>
                <span className="pc-agents-roster__glyph" style={g.color ? { color: g.color } : undefined} aria-hidden>
                  {agentGlyph(a)}
                </span>
                <span className="pc-agents-roster__name" style={g.color ? { color: g.color } : undefined} title={`${a.ownerId}${a.agent ? ` · ${a.agent}` : ''}`}>
                  {nameOf(a)}
                </span>
                <span className="pc-agents-roster__doing" title={a.intent || undefined}>
                  {a.feature ? <span className="pc-agents-roster__feat">{a.feature}</span> : null}
                  {a.intent || (a.currentPlanSlug ? a.currentPlanSlug : '—')}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      {active ? (
        <AgentDetailStrip
          agent={active.agent}
          color={active.color}
          pinned={active.agent.ownerId === pinned}
          nowMs={nowMs}
          labels={labels}
          chrome={chrome}
          onInspect={onInspect}
        />
      ) : null}
      {children}
    </div>
  );
}
