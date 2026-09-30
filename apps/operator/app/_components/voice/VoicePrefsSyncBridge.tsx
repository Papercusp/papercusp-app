'use client';

import { useEffect } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';
import { setVoicePrefsClient } from './voice-prefs-client';

/** Keeps imperative voice subsystems on the same root sync projection as React settings surfaces. */
export function VoicePrefsSyncBridge() {
  const { data } = useSyncQuery<VoicePrefs>({
    queryName: 'voicePrefs.effective',
    staleTime: 30_000,
  });
  useEffect(() => {
    if (data?.[0]) setVoicePrefsClient(data[0]);
  }, [data]);
  return null;
}
