/**
 * AgentsRunningPill — the always-visible header control that replaces the
 * overflowing per-agent run pills (AdvNowRunning) once there are more than a few
 * agents. A compact "⚡ N agents running" pill (with a colored dot per active
 * fleet); clicking it opens a popover with the WHOLE-workspace agent roster
 * GROUPED BY FLEET and COLORED BY FLEET — mirroring the zellij Fleet-tab roster
 * (apps/tui/src/fleet.rs). Reads the same push-driven `advRoster.list` sync query
 * the Sessions roster uses (workspace-wide, presence-primary; each entry carries
 * fleetSlug + fleetColor = the fleet's scheme.cursor accent).
 *
 * ── This file is now the HOST, not the implementation ──────────────────────
 * The roster's pure logic and its row/section rendering live in
 * `@papercusp/agent-roster` (libs/generic/agent-roster), extracted by P-001 of
 * portal-universal-bar-and-agent-roster-2026-08-31 so the web portal renders the
 * SAME roster from the SAME code with its own theme (D-005: an extraction, never
 * a copy — a copy would fork ~2,700 lines across two repos permanently).
 *
 * What stayed HERE is exactly what is operator-specific, and it is what the
 * package's three seams were designed around:
 *   · the `advRoster.list` sync query + its 5s cadence (the portal is
 *     cross-origin from :3070 and has its own auth);
 *   · the URL state — nuqs, per the repo rule that user-meaningful state is
 *     agent-readable only from the URL;
 *   · the chrome (Popover / Tooltip / LivenessDot / ThinkingDot) and the lexicon;
 *   · the bulk-action endpoints and AgentInspectorModal.
 *
 * Every pure function this file used to define is RE-EXPORTED below, unchanged in
 * name and signature, so the surfaces that import them from here — AgentsPillSessions,
 * AdvOverviewTab, SwarmTab, AgentsTab, AskComposer, and the tests — did not have
 * to change at all.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import {
  AgentRoster,
  ROSTER_STYLES,
  canFocusWindow,
  canForkSession,
  displayName as rosterDisplayName,
  distinctMachineCount,
  groupByFleet,
  isTranscriptFresh,
  resumableSessionId,
  thinkingStreamUrl,
  type RosterAgent,
  type RosterBulkActions,
  type RosterChrome,
  type RosterLabels,
} from '@papercusp/agent-roster';
import { Popover } from '@/app/harness/Popover';
import { Tooltip } from '@/app/harness/Tooltip';
import { LivenessDot } from '@/app/coord/presence-ui';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import { ThinkingDot } from '@/app/harness/AgentThinkingStream';
import { useOpenHudConversation } from './use-open-hud-conversation';
import {
  InactiveSessionsSection,
  SessionSearchResults,
  SessionsSearchInput,
  type SearchSessionResult,
} from './AgentsPillSessions';
/* WI-37204 — the SAME pure id parser/matcher the server's id leg runs, so the
   instant client pass and the server pass cannot disagree about what counts as
   an id. adv-session-search's imports are all type-only, so it erases to a pure
   module and is safe in this bundle. */
import {
  matchSessionIdField,
  parseSessionIdQuery,
  transcriptIdentity,
} from '@papercusp/operator-core/lib/adv-session-search';
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
// Portable pill styles (the `.pc-advshell__action` button base) — shared with
// AdvShell so this pill renders styled in the Quick Panel popup too, which does
// not mount AdvShell (quick-panel-status-pills D-001). This pill's own wrapper +
// roster popover styles remain self-injected in RosterStyles below.
import './adv-header-pills.css';
import { advRosterArgs } from '@/lib/adv-roster-args';

/* ── Re-exports: the roster's shared vocabulary ────────────────────────────
   These moved to @papercusp/agent-roster but are re-exported from here with
   their original names and signatures. Importing them from this path stays
   correct, which is why the extraction touched no other operator file. */
export {
  activityLiveness,
  activityLivenessTitle,
  agentGlyph,
  canFocusWindow,
  canForkSession,
  distinctMachineCount,
  filterRoster,
  fmtCompactAge,
  groupByFleet,
  hasThinking,
  isRunningAgent,
  isTranscriptFresh,
  machineKey,
  machineTabs,
  resumableSessionId,
  shortOwner,
  thinkingStreamUrl,
  LIVE_TURN_MS,
  type FleetGroup,
  type MachineTab,
  type RosterAgent,
} from '@papercusp/agent-roster';

/** The row's display NAME: the human owner-label, else a short owner id. NEVER the
 *  agent TYPE (claude/codex/omp) — that's the backend, not a name.
 *
 *  Operator binding of the package's `displayName`: the generic form takes a plain
 *  label normalizer (it must work in a host with no lexicon provider), and this
 *  adapts the operator's `BoundLexicon` onto it. Callers keep the original
 *  `displayName(a, lex)` signature. */
export function displayName(
  a: Pick<RosterAgent, 'label' | 'ownerId'>,
  lex?: BoundLexicon,
): string {
  return rosterDisplayName(a, lex ? (raw) => agentDisplayLabel(raw, lex) : undefined);
}

/** advRoster.list returns a single-element array wrapping the roster object. */
interface RosterResponse {
  active: RosterAgent[];
}

/** The operator's presentational primitives, handed to the shared roster. Module
 *  scope so the object identity is stable across renders. */
const OPERATOR_CHROME: RosterChrome = { Tooltip, LivenessDot, ThinkingDot };

/** All POSTs use text/plain (a CORS "simple request" — the desktop webkit2gtk
 *  build fails preflight OPTIONS silently; the routes parse the raw body as JSON
 *  regardless). */
const postText = (url: string, payload: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(payload) });

/** POST one window-action per agent, best-effort, and count the successes. Each
 *  agent is independent: one failure must not abort the rest of the batch. */
async function postEach(url: string, agents: readonly RosterAgent[]): Promise<number> {
  let ok = 0;
  await Promise.all(
    agents.map(async (a) => {
      try {
        const res = await postText(url, {
          id: a.advSessionId ?? undefined,
          windowId: a.windowId ?? undefined,
          pid: a.pid ?? undefined,
        });
        if (res.ok) ok++;
      } catch { /* best-effort per agent */ }
    }),
  );
  return ok;
}

/** The operator's bulk endpoints. The shared roster owns WHEN these run (and the
 *  confirm-arming on kill); the routes and their auth are ours. */
const OPERATOR_BULK: RosterBulkActions = {
  async message(ownerIds, text) {
    const res = await postText('/api/admin/coord/send', {
      to: [...ownerIds],
      summary: text.slice(0, 120),
      body: text,
    });
    // A THROW (not a returned string) is what keeps the composer open with the
    // user's text — see RosterBulkActions. The message is shown verbatim.
    if (!res.ok) throw new Error(`Message failed (HTTP ${res.status})`);
    return `Sent to ${ownerIds.length}`;
  },
  async wake(ownerIds) {
    const res = await postText('/api/admin/coord/send', {
      to: [...ownerIds],
      summary: '(nudge from the operator)',
      wake: 'required',
    });
    return res.ok ? `Nudged ${ownerIds.length}` : `Wake failed (HTTP ${res.status})`;
  },
  async focus(selected) {
    const targets = selected.filter((a) => canFocusWindow(a));
    return `Focused ${await postEach('/api/adv/sessions/focus', targets)}/${targets.length}`;
  },
  async kill(selected) {
    const targets = selected.filter((a) => canFocusWindow(a));
    const ok = await postEach('/api/adv/sessions/close-window', targets);
    // The skipped count is why `kill` is handed the WHOLE selection: "Killed 2/3"
    // alone would leave the user wondering what happened to the third.
    const noWindow = selected.length - targets.length;
    return `Killed ${ok}/${targets.length}${noWindow > 0 ? ` (${noWindow} had no window)` : ''}`;
  },
  async copyIds(ownerIds) {
    await navigator.clipboard.writeText(ownerIds.join('\n'));
    return `Copied ${ownerIds.length} id${ownerIds.length === 1 ? '' : 's'}`;
  },
};

export default function AgentsRunningPill() {
  const [open, setOpen] = useQueryState('agentsRoster', parseAsBoolean.withDefault(false));
  const { data } = useSyncQuery<RosterResponse>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
    // `transcriptFresh` is derived from transcript mtimes rather than a database row,
    // so no SSE invalidation can announce either edge of its 10s activity
    // window. Keep this always-mounted header observer on a small explicit
    // cadence; all roster consumers share the same structurally keyed query.
    pollIntervalMs: 5_000,
  });
  // A 1s clock — only while the roster is open — so the last-active pills tick up
  // live between the sync query's pushes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);
  // Search-anything box state — URL-backed like agentsRoster/agentsMachine.
  // Plain string form (no parseAsString.withDefault): the parser object runs at
  // every pill render, and the suite-wide nuqs test mocks stub parseAsString as
  // a bare `{}` — the guard also tolerates their single-shared-value stubs.
  const [searchQRaw, setSearchQ] = useQueryState('agentsQ');
  const searchQ = typeof searchQRaw === 'string' ? searchQRaw : '';
  // Deep-link focus (WI-5517): ?agentsFocus=<ownerId> — an Overview Agents-tile
  // row click opens this popover pinned to that agent, with the inactive
  // session-history section auto-expanded + filtered to them. Cleared when the
  // popover closes so the next manual open starts neutral.
  const [focusOwnerRaw, setFocusOwner] = useQueryState('agentsFocus');
  const focusOwner = typeof focusOwnerRaw === 'string' && focusOwnerRaw ? focusOwnerRaw : null;
  // Portal parity deep-link: the hosted portal frames this same operator
  // surface with agentsRoster=true&agentsInspect=<ownerId>. The literal boolean
  // matches nuqs parseAsBoolean; `1` parses as the default false. The roster resolves
  // the owner against its full-fidelity rows and opens the exact
  // AgentInspectorModal used by a native row click.
  const [inspectOwnerRaw, setInspectOwner] = useQueryState('agentsInspect');
  const inspectOwner = typeof inspectOwnerRaw === 'string' && inspectOwnerRaw ? inspectOwnerRaw : null;
  // The pill says "running", so membership comes from the authoritative shared
  // session-lifecycle oracle — NOT heartbeat freshness and NOT an armed loop.
  // Parked/ended processes may keep heartbeating for hours; counting those is
  // what produced the owner-visible "65 running" while only 3 were live.
  // Memoed on `data` so identities stay stable across the 1s nowMs ticks.
  const running = useMemo(
    () => ((data?.[0]?.active ?? []) as RosterAgent[]).filter((a) => a.sessionState === 'live'),
    [data],
  );
  const activeOwnerIds = useMemo(() => new Set(running.map((a) => a.ownerId)), [running]);
  const q = searchQ.trim();

  /* ── Instant id matches (WI-37204, owner ask 2026-08-08) ──────────────────
     At >=2 chars this popover REPLACES the roster with the server's transcript
     search, so a query that is an ID used to answer nothing at all: the engine
     searches turn TEXT, and an agent's own id is not something its transcript
     says (measured pre-fix on the live operator: `?q=su-bc38a419` →
     `totalHits: 0, sessions: []`).

     The server now has an id leg, but a round-trip measured 0.4–4.9s and the
     answer for a LIVE agent is already sitting in this component's roster
     payload — so match it here, on the keystroke, and let the server's pass
     (which additionally reaches ENDED sessions) merge in behind it. Same
     instant-then-union shape the HUD board uses, and the merge runs the SAME
     pure `mergeIdMatches` the route does, so neither surface can drift.

     Matched over the FULL active roster, not the `running` subset: `running`
     drops stale entries because that is the right call for BROWSING, and naming
     a session by its unique id is not browsing — a human holding an id wants
     that session whatever state it is in. */
  const instantIdMatches = useMemo<SearchSessionResult[]>(() => {
    const token = q.length >= 2 ? parseSessionIdQuery(q) : null;
    if (!token) return [];
    const out: SearchSessionResult[] = [];
    for (const a of ((data?.[0]?.active ?? []) as RosterAgent[])) {
      const field = matchSessionIdField(a, token);
      if (!field) continue;
      out.push({
        ...transcriptIdentity(a),
        topScore: 0,
        hits: [],
        active: a,
        session: null,
        idMatch: field,
      });
    }
    return out;
  }, [data, q]);

  // Always mounted, even at zero ([owner 2026-09-15] "it should instead say
  // 0 agents running"): an absent pill read as "the feature is missing" during
  // the post-boot hydration window (WI-37363), and an honest "0 agents running"
  // is a reading where an empty header is not. `is-running` stays a STATE class.
  const isRunning = running.length > 0;
  const groups = groupByFleet(running);
  const fleetDots = groups.filter((g) => g.slug !== null && g.color).slice(0, 6);
  const thinkingCount = running.filter(isTranscriptFresh).length;
  const machineCount = distinctMachineCount(running);

  return (
    <div className="pc-advshell__agents-pill-wrap">
      <Popover
        open={open}
        onOpenChange={(next: boolean) => {
          void setOpen(next);
          if (!next) {
            void setFocusOwner(null);
            void setInspectOwner(null);
          }
        }}
        trigger={(
          <button
            type="button"
            className={`pc-advshell__action pc-advshell__action--agents${isRunning ? ' is-running' : ''}`}
            data-testid="agents-running-pill"
            aria-expanded={open}
            aria-controls="pc-advshell-agents-pop"
          >
            <span aria-hidden>⚡</span>
            {running.length} agent{running.length === 1 ? '' : 's'} running
            {thinkingCount > 0 && (
              <span className="pc-agents-pill__thinking" data-testid="agents-thinking-count">
                {' · '}{thinkingCount} thinking
              </span>
            )}
            {machineCount > 1 && (
              <span className="pc-agents-pill__machines" data-testid="agents-machine-count">
                {' across '}{machineCount} machines
              </span>
            )}
            {fleetDots.length > 0 && (
              <span className="pc-agents-pill__dots" aria-hidden>
                {fleetDots.map((g) => (
                  <span
                    key={g.slug}
                    className="pc-agents-pill__dot"
                    style={{ background: g.color ?? 'var(--fg-mute)' }}
                    title={g.slug ?? undefined}
                  />
                ))}
              </span>
            )}
          </button>
        )}
        tooltipLabel="Agents running — grouped by fleet"
        side="bottom"
        align="end"
        ariaLabel="Agents running"
        contentClassName="pc-advshell__agents-pop"
      >
        <div id="pc-advshell-agents-pop" data-testid="agents-running-pop">
          <SessionsSearchInput value={searchQ} onChange={(v) => void setSearchQ(v || null)} />
          {q.length >= 2 ? (
            <SessionSearchResults query={q} nowMs={nowMs} instantIdMatches={instantIdMatches} />
          ) : (
            <>
              {isRunning ? (
                <AgentsRoster
                  agents={running}
                  nowMs={nowMs}
                  focusOwner={focusOwner}
                  inspectOwner={inspectOwner}
                  onInspectOwnerConsumed={() => void setInspectOwner(null)}
                />
              ) : (
                <p className="pc-advshell__idle" data-testid="agents-running-empty">
                  No agents running right now.
                </p>
              )}
              <InactiveSessionsSection activeOwnerIds={activeOwnerIds} nowMs={nowMs} focusOwnerId={focusOwner} />
            </>
          )}
        </div>
      </Popover>
      <RosterStyles />
    </div>
  );
}

/**
 * The fleet-grouped roster list rendered inside the popover — the operator's
 * binding of the shared `AgentRoster`.
 *
 * Everything this wrapper adds is operator-specific by construction: the lexicon
 * (the cast words shown in the kind legend come from the LEXICON, never from the
 * internal pane-kind ids — the legend used to leak "queen / overwatch / bee /
 * sentinel" into the UI), the nuqs-backed machine tab, the bulk endpoints, and
 * the inspector modal.
 */
export function AgentsRoster({
  agents,
  nowMs,
  focusOwner = null,
  inspectOwner = null,
  onInspectOwnerConsumed,
}: {
  agents: RosterAgent[];
  nowMs: number;
  /** Deep-link target (?agentsFocus=): pin + scroll this agent's row into view
   *  once per focus value (WI-5517 — the Overview Agents-tile click-through). */
  focusOwner?: string | null;
  /** Deep-link target (?agentsInspect=): open the same inspector a native row
   *  click opens, once the full-fidelity operator roster has resolved it. */
  inspectOwner?: string | null;
  onInspectOwnerConsumed?: () => void;
}) {
  const lex = useLexicon();
  const labels = useMemo<RosterLabels>(() => ({
    term: (key, opts) => lex(key, opts),
    agentLabel: (raw) => agentDisplayLabel(raw, lex),
    roleLabel: (raw) => agentRoleLabel(raw, lex),
  }), [lex]);

  const [inspecting, setInspecting] = useState<RosterAgent | null>(null);
  useEffect(() => {
    if (!inspectOwner) return;
    const target = agents.find((a) => a.ownerId === inspectOwner);
    if (target) setInspecting(target);
  }, [agents, inspectOwner]);
  // resume-in-gui-button-2026-08-09: where the inspector's "Resume in GUI" button
  // sends you — the HUD tab with this agent's conversation popup open (and this
  // popover closed). The navigation lives vite-side because AgentInspectorModal is in
  // apps/operator, which cannot import from here.
  const openHudConversation = useOpenHudConversation();

  // Shared-hive per-machine tabs ride nuqs (?agentsMachine=); clearing it = Local.
  const [machineTab, setMachineTab] = useQueryState('agentsMachine', parseAsString);

  return (
    <AgentRoster
      agents={agents}
      nowMs={nowMs}
      focusOwner={focusOwner}
      chrome={OPERATOR_CHROME}
      labels={labels}
      machineTab={typeof machineTab === 'string' ? machineTab : null}
      onMachineTabChange={(key) => void setMachineTab(key)}
      bulk={OPERATOR_BULK}
      onInspect={setInspecting}
    >
      {inspecting && thinkingStreamUrl(inspecting) ? (
        <AgentInspectorModal
          slug={inspecting.harnessSlug ?? ''}
          phase="staging"
          runId={inspecting.runId ?? inspecting.sessionId ?? inspecting.ownerId}
          role={inspecting.agentPaneKind ?? inspecting.role ?? 'agent'}
          streamUrl={thinkingStreamUrl(inspecting) ?? undefined}
          focusTarget={canFocusWindow(inspecting)
            ? { advSessionId: inspecting.advSessionId ?? null, windowId: inspecting.windowId ?? null, pid: inspecting.pid ?? null }
            : undefined}
          resumeTarget={resumableSessionId(inspecting)
            ? {
                sessionId: resumableSessionId(inspecting)!,
                // This roster only shows RUNNING agents, so the source is live —
                // tags the Resume button's collision-warning tooltip. Fork
                // (canFork) branches a fresh session and avoids the collision.
                live: true,
                canFork: canForkSession(inspecting),
                // resume-in-gui-button-2026-08-09: the coord owner id the HUD
                // conversation popup is keyed by. Because `live` is true here, the
                // GUI button spawns NOTHING — this agent is already running and
                // already injectable, so it just opens the conversation on it.
                guiOwnerId: inspecting.ownerId,
                // No fixed label: each button self-labels (fork · / resume · role)
                // since the actions share this resumeTarget.
              }
            : undefined}
          onOpenInGui={openHudConversation}
          open
          onClose={() => {
            setInspecting(null);
            onInspectOwnerConsumed?.();
          }}
        />
      ) : null}
    </AgentRoster>
  );
}

function RosterStyles() {
  return (
    <style>{`
      .pc-advshell__agents-pill-wrap { display: inline-flex; }
      .pc-agents-pill__thinking { color: var(--good, #34d399); font-weight: 600; }
      .pc-agents-pill__dots { display: inline-flex; gap: 2px; margin-left: 6px; }
      .pc-agents-pill__dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
      .pc-agents-pill__machines { color: var(--fg-mute); }
      .pc-advshell__agents-pop {
        max-height: min(70vh, 560px);
        overflow-y: auto;
        /* DEFINITE width, not content-driven: intrinsic max-content sizing let a
           long agent intent blow the roster popover past the viewport (~1600px),
           and typing a search query then snapped it down to the 420px min — the
           "search box goes narrow" glitch. One stable width for every state
           (roster / search results / inactive list); rows already ellipsize. */
        width: min(680px, calc(100vw - 24px));
        min-width: 420px;
        padding: 4px;
        /* Flex column so fixed chrome (search box, hover detail strip, inactive
           footer) never slides under the sticky footer — the roster LIST is the
           part that shrinks/scrolls; popover overflow stays as a safety valve. */
        display: flex; flex-direction: column;
        /* Solid, opaque surface (design tokens) — a header popover must be readable,
           never translucent. Matches the sibling Hives popover's weight. */
        background: var(--bg-1, #0b1525);
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, var(--border, rgba(125, 211, 252, 0.26)));
        border-radius: 10px;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
      }
      #pc-advshell-agents-pop { display: flex; flex-direction: column; min-height: 0; }
${ROSTER_STYLES}
    `}</style>
  );
}
