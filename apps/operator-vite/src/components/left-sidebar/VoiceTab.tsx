/**
 * Voice tab (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * Voice tab. Mounts the holepunch `VideoGrid` (the self-contained voice/video
 * session surface — WS bridge, capture, per-peer tiles, control bar) for the
 * active shared harness, gated behind the same `papercusp-video-channels`
 * flag the workbench voice pane uses; the P2P voice-channel panel
 * (channel list / join / mute / mic meter / agent-speaking —
 * holepunch-voice-channels P-015, gated behind `papercusp-voice-channels`);
 * and a deep link to the full voice settings (engines / role voices / spend).
 */
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { Settings2 } from 'lucide-react';
import VideoGrid from '../voice-video/VideoGrid';
import VoiceChannelPanel from '../voice-video/VoiceChannelPanel';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';
import { useLexicon } from '@/lib/useLexicon';
import { Chip } from '../ui';

export default function VoiceTab({ active }: { active: boolean }) {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const harnessSlug = useResolvedHarnessSlug();
  const videoOn = useFlag(FLAGS.VIDEO_CHANNELS);
  const voiceOn = useFlag(FLAGS.VOICE_CHANNELS);

  return (
    <div className="pclsb-voice" data-testid="left-sidebar-voice">
      <div className="pclsb-panel__bar pclsb-voice__bar">
        <span className="pclsb-panel__bar-label">
          peers{harnessSlug ? ` · ${harnessSlug}` : ''}
        </span>
        <span className="pclsb-panel__bar-spacer" />
        <Chip
          onClick={() => navigateClient('/settings/voice')}
          aria-label="Peer audio settings: engines, role voices, spend"
        >
          <Settings2 size={12} aria-hidden="true" /> settings
        </Chip>
      </div>
      {active && voiceOn && <VoiceChannelPanel className="pclsb-voice__channels" />}
      {active && videoOn && harnessSlug ? (
        <VideoGrid harnessSlug={harnessSlug} className="pclsb-voice__grid" />
      ) : (
        <div className="pclsb-panel__empty pclsb-voice__empty">
          {videoOn
            ? harnessSlug
              ? ''
              : `Select a shared ${t('pot', { lower: true })} to join its peer channel.`
            : voiceOn
              ? ''
              : 'Peer audio/video channels are flag-gated (papercusp-voice-channels / papercusp-video-channels) — flip them in /admin/features.'}
        </div>
      )}
    </div>
  );
}
