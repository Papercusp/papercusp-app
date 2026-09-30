/**
 * VoiceChannelPanel — the desktop twin of the pui Voice tab
 * (holepunch-voice-channels-2026-06-05 P-015, D-014 item 2).
 *
 * Self-contained: channel list (+ create), join/leave, mute, a live mic
 * meter, per-peer speaking/muted state, and the agent-speaking indicator —
 * all over the page-singleton voice-channel runtime (one WS + one mic + one
 * playout shared by every mount, so the sidebar Voice tab and the workbench
 * voice pane can both render it without double audio).
 *
 * The selected channel is URL state (`?vchan=` via nuqs) so agents
 * (ui:dispatch) and deep links can drive it; the create-channel name is a
 * mid-edit draft (useState by the book). Live capture/playback behaviour is
 * the supervised desktop verify (D-014); the transport, conversion math, and
 * this panel's view-model are unit-tested.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import {
  getVoiceChannelRuntime,
  type VoiceChannelRuntime,
  type VoiceChannelState,
} from '../../lib/voice/desktop-voice-channel-runtime';
import { buildVoiceChannelModel } from './voice-channel-state';
import './VoiceChannelPanel.css';

export interface VoiceChannelPanelProps {
  className?: string;
}

function useVoiceChannelState(runtime: VoiceChannelRuntime): VoiceChannelState {
  // Cache the snapshot per change-notification: useSyncExternalStore requires
  // getSnapshot to return a STABLE value between notifications or it loops.
  const subscribe = useCallback(
    (onStoreChange: () => void) => runtime.subscribe(onStoreChange),
    [runtime],
  );
  const [snap] = useState<{ current: VoiceChannelState | null }>(() => ({ current: null }));
  return useSyncExternalStore(
    (cb) => subscribe(() => {
      snap.current = null;
      cb();
    }),
    () => {
      snap.current ??= runtime.state();
      return snap.current;
    },
  );
}

export default function VoiceChannelPanel({ className }: VoiceChannelPanelProps): JSX.Element {
  const runtime = getVoiceChannelRuntime();
  const state = useVoiceChannelState(runtime);
  const model = buildVoiceChannelModel(state);
  const [wantedChannel, setWantedChannel] = useQueryState('vchan', parseAsString);
  const [draftName, setDraftName] = useState('');

  // Connect (idempotent) + prime channels on mount.
  useEffect(() => {
    runtime.refreshChannels();
  }, [runtime]);

  // Deep link: ?vchan=<id> joins once connected (no-op when already there).
  useEffect(() => {
    if (!wantedChannel || !model.connected) return;
    if (model.inChannel?.id === wantedChannel) return;
    runtime.join(wantedChannel);
    // model.inChannel?.id is deliberately read fresh each status push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedChannel, model.connected, model.inChannel?.id, runtime]);

  const join = (id: string) => {
    void setWantedChannel(id);
    runtime.join(id);
  };
  const leave = () => {
    void setWantedChannel(null);
    runtime.leave();
  };
  const create = () => {
    const name = draftName.trim();
    if (!name) return;
    runtime.createChannel(name);
    setDraftName('');
  };

  return (
    <div className={`pc-voice-chan${className ? ` ${className}` : ''}`} data-testid="voice-channel-panel">
      {model.lastError && (
        <div className="pc-voice-chan__banner" role="alert">
          {model.lastError}
        </div>
      )}

      <div className="pc-voice-chan__list" role="list" aria-label="Voice channels">
        {model.rows.length === 0 && (
          <div className="pc-voice-chan__empty">No channels yet — create one below.</div>
        )}
        {model.rows.map((row) => (
          <div key={row.id} role="listitem" className="pc-voice-chan__row" data-active={row.active}>
            <span className="pc-voice-chan__row-name">{row.name}</span>
            {row.active ? (
              <button type="button" className="pc-voice-chan__btn pc-voice-chan__btn--leave" onClick={leave}>
                Leave
              </button>
            ) : (
              <button type="button" className="pc-voice-chan__btn" onClick={() => join(row.id)}>
                Join
              </button>
            )}
          </div>
        ))}
        <form
          className="pc-voice-chan__create"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input
            className="pc-voice-chan__input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="new channel…"
            aria-label="New channel name"
          />
          <button type="submit" className="pc-voice-chan__btn" disabled={!draftName.trim()}>
            Create
          </button>
        </form>
      </div>

      {model.inChannel && (
        <div className="pc-voice-chan__session" data-testid="voice-channel-session">
          <div className="pc-voice-chan__session-bar">
            <span className="pc-voice-chan__session-name">{model.inChannel.name}</span>
            <button
              type="button"
              className="pc-voice-chan__btn"
              aria-pressed={!model.inChannel.muted}
              data-active={!model.inChannel.muted}
              onClick={() => runtime.setMuted(!model.inChannel?.muted)}
            >
              {model.inChannel.muted ? '🔇 Unmute' : '🎤 Mute'}
            </button>
          </div>

          <div className="pc-voice-chan__meter" aria-label="Mic level" role="meter" aria-valuenow={model.micLevelPct}>
            <div className="pc-voice-chan__meter-fill" style={{ width: `${model.micLevelPct}%` }} />
          </div>
          {model.micError && (
            <div className="pc-voice-chan__banner" role="status">
              Mic unavailable: {model.micError}. Listening only.
            </div>
          )}

          {model.inChannel.agentSpeaking && (
            <div className="pc-voice-chan__agent" data-testid="agent-speaking">
              ✦ agent speaking…
            </div>
          )}

          <ul className="pc-voice-chan__peers" aria-label="Peers">
            {model.inChannel.peers.length === 0 && (
              <li className="pc-voice-chan__empty">No peers yet — they join this channel from their box.</li>
            )}
            {model.inChannel.peers.map((p) => (
              <li key={p.id} className="pc-voice-chan__peer" data-speaking={p.speaking}>
                <span className="pc-voice-chan__peer-dot" aria-hidden="true" />
                <span className="pc-voice-chan__peer-label">
                  {p.muted ? '🔇 ' : ''}
                  {p.label}
                  {p.speaking ? ' (speaking)' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
