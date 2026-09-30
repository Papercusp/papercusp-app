/**
 * WorkbenchVoicePanel — the voice/video pane of the desktop workbench
 * (plan `desktop-workbench-shell-2026-06-05`, P-004 / D-005).
 *
 * Lives on the operator-vite side (not in `apps/operator/app/harness/dock`)
 * because it mounts the holepunch `VideoGrid`, an operator-vite component
 * `@/app` cannot import (dependency direction is operator-vite → @/app). The
 * workbench route registers it via `registerWorkbenchVoicePanel()`.
 *
 * Two regions:
 *   - Video: the holepunch `VideoGrid` for the active shared harness, gated
 *     behind the (default-off) `papercusp-video-channels` flag. Off / no
 *     harness → a labeled empty state.
 *   - Voice: the seam where the universal-voice shared-session controls
 *     (`universal-voice-interface`) attach when they land.
 */

'use client';

import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import VideoGrid from '../voice-video/VideoGrid';
import VoiceChannelPanel from '../voice-video/VoiceChannelPanel';
import { panelRegistry, type PanelComponentProps } from '@/app/harness/dock/panel-registry';
import { useLexicon } from '@/lib/useLexicon';

const fill: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const mute: React.CSSProperties = {
  color: 'var(--fg-mute, #888)',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  textAlign: 'center',
};

export function WorkbenchVoicePanel({ params }: PanelComponentProps) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const harnessSlug = typeof params.harnessSlug === 'string' ? params.harnessSlug : '';
  const videoOn = useFlag(FLAGS.VIDEO_CHANNELS);
  const voiceOn = useFlag(FLAGS.VOICE_CHANNELS);

  return (
    <div style={fill} data-testid="workbench-voice-pane">
      <div
        data-testid="workbench-video-seam"
        style={{
          flex: 2,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          borderBottom: '1px solid var(--border, #2a2a2a)',
          background: 'var(--bg-2, #16181d)',
        }}
      >
        {videoOn && harnessSlug ? (
          <VideoGrid harnessSlug={harnessSlug} className="workbench-video-grid" />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <span style={mute}>
              Video channel{harnessSlug ? ` · ${harnessSlug}` : ` · no shared ${t('pot', { lower: true })}`}
            </span>
            <span style={mute}>
              {videoOn
                ? `Select a shared ${t('pot', { lower: true })} to join its video channel`
                : 'Enable papercusp-video-channels to turn on video'}
            </span>
          </div>
        )}
      </div>
      {/* Voice seam — P2P voice channels (holepunch-voice P-015) when the flag
          is on; otherwise the universal-voice shared-session placeholder. */}
      <div
        data-testid="workbench-voice-seam"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          ...(voiceOn ? { overflow: 'auto' } : { alignItems: 'center', justifyContent: 'center', padding: 12 }),
        }}
      >
        {voiceOn ? (
          <VoiceChannelPanel className="workbench-voice-channels" />
        ) : (
          <span style={mute}>Voice — shared operator session (universal-voice-interface)</span>
        )}
      </div>
    </div>
  );
}

let registered = false;

/** Register the `workbench:voice` panel type. Idempotent. */
export function registerWorkbenchVoicePanel(): void {
  if (registered) return;
  registered = true;
  panelRegistry.register('workbench:voice', WorkbenchVoicePanel, { keepAlive: true, title: 'Peers' });
}
