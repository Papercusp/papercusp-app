'use client';

/**
 * VoiceLeaderBootstrap — kicks off voice-leader election on chrome boot.
 *
 * Per v4 §2i: election runs ASYNC during chrome boot. Render is not
 * blocked. Voice features (`speak()` in voice-mode.ts) wait on the
 * leader-state read before emitting; followers are silent.
 *
 * This component renders nothing — it just fires `bootVoiceLeader()`
 * once on mount.
 */

import { useEffect } from 'react';
import { bootVoiceLeader } from './voice-leader';

export function VoiceLeaderBootstrap(): null {
  useEffect(() => {
    void bootVoiceLeader();
  }, []);
  return null;
}
