/**
 * The detail strip below the roster — the hovered/pinned agent's plan +
 * work-item + declared intent, from the roster data it was already handed.
 */
import type { JSX } from 'react';
import { activityLiveness, activityLivenessTitle, displayName, hasThinking, isTranscriptFresh, shortOwner } from './logic';
import { agentGlyph } from './glyphs';
import type { RosterAgent } from './types';
import type { RosterChrome, RosterLabels } from './seams';

export interface AgentDetailStripProps {
  agent: RosterAgent;
  color: string | null;
  pinned: boolean;
  nowMs: number;
  labels: RosterLabels;
  chrome: RosterChrome;
  /** Omit to render the strip with no inspect affordance at all — correct for a
   *  host with no thinking-stream surface (never a dead button). */
  onInspect?: (a: RosterAgent) => void;
}

export function AgentDetailStrip({
  agent,
  color,
  pinned,
  nowMs,
  labels,
  chrome,
  onInspect,
}: AgentDetailStripProps): JSX.Element {
  const { ThinkingDot } = chrome;
  const name = displayName(agent, labels.agentLabel);
  return (
    <div className="pc-agents-roster__detail" data-testid="agent-detail">
      <div className="pc-agents-roster__detail-head" style={color ? { color } : undefined}>
        {agentGlyph(agent)} <strong>{name}</strong>
        {agent.fleetSlug ? <span className="pc-agents-roster__detail-fleet"> · {agent.fleetSlug}</span> : null}
        <span className="pc-agents-roster__detail-live" title={activityLivenessTitle(agent, nowMs)}> · {activityLiveness(agent, nowMs)}{agent.loopArmed ? ' (loop armed)' : ''}</span>
        {isTranscriptFresh(agent) ? (
          <span className="pc-agents-roster__detail-thinking" style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 4, color: '#6aa84f' }}>
            <ThinkingDot size={6} /> thinking
          </span>
        ) : null}
        {pinned ? <span className="pc-agents-roster__detail-pin"> · pinned</span> : null}
      </div>
      <dl className="pc-agents-roster__detail-grid">
        <dt>Agent</dt><dd>{agent.agent ?? (labels.roleLabel(agent.role) || '—')} · <code>{shortOwner(agent.ownerId)}</code></dd>
        <dt>Plan</dt><dd>{agent.currentPlanSlug ?? '—'}</dd>
        <dt>Work item</dt><dd>{agent.feature ?? '—'}</dd>
        <dt>Doing</dt><dd>{agent.intent || '(no declared intent)'}</dd>
      </dl>
      {/* Guarded: only an agent with a resolvable thinking source gets the action —
          no dead button otherwise. Two "no thinking" cases get an explicit,
          accurate note instead of a silently-inert row OR an empty modal:
          (a) a presence-only process that never recorded a session/run/thread
          handle, and (b) a session WITH a handle whose transcript no longer
          resolves (parked/ended agent, transcript rotated away) — flagged by
          thinkingResolvable === false. */}
      {onInspect && hasThinking(agent) ? (
        <button
          type="button"
          className="pc-agents-roster__inspect"
          data-testid="agent-inspect-btn"
          onClick={() => onInspect(agent)}
        >
          ▶ Live thinking
        </button>
      ) : agent.thinkingResolvable === false ? (
        <div className="pc-agents-roster__nothinking" data-testid="agent-no-thinking-note">
          Live thinking unavailable — no transcript to stream (this session has ended or
          its transcript was rotated away since it last took a turn).
        </div>
      ) : onInspect ? (
        <div className="pc-agents-roster__nothinking" data-testid="agent-no-thinking-note">
          Live thinking unavailable — this {agent.agent ?? 'session'} process recorded no
          transcript handle (no session row, run-log, or thread id) to stream from.
        </div>
      ) : null}
    </div>
  );
}
