'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { GraduationCap, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import {
  loadVoicePrefsClient,
  setVoicePrefsClient,
  subscribeVoicePrefsClient,
} from '@/app/_components/voice/voice-prefs-client';
import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

type AudienceMode = 'engineer' | 'novice';

const LS_KEY = 'pc:audienceMode';

async function saveAudienceMode(mode: AudienceMode): Promise<void> {
  // Broadcast to other tabs before the fetch so the storage event fires promptly.
  try { localStorage.setItem(wsLocalKey(LS_KEY), mode); } catch { /* private browsing */ }
  // FAIL-SOFT (WI-4342): the caller fires this with `void`, so ANY rejection here
  // became an *unhandled promise rejection* — a real one, caught by clicking the
  // toggle while the operator sidecar was unreachable ("TypeError: Load failed").
  // The localStorage write above has already persisted + cross-tab-broadcast the
  // choice, so a failed server persist must degrade quietly, not blow up the page.
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audienceMode: mode }),
    });
    if (r.ok) {
      const next = await r.json() as VoicePrefs;
      setVoicePrefsClient(next);
    }
  } catch { /* sidecar down / offline — local choice above still stands */ }
}

export function AudienceModeSelector() {
  const [mode, setMode] = useState<AudienceMode>('engineer');

  useEffect(() => {
    setMode(loadVoicePrefsClient().audienceMode ?? 'engineer');
    // Same-tab sync: fires when this tab calls setVoicePrefsClient.
    const unsub = subscribeVoicePrefsClient((next) => {
      setMode(next.audienceMode ?? 'engineer');
    });
    // Cross-tab sync: fires when another tab writes LS_KEY.
    const onStorage = (e: StorageEvent) => {
      if (e.key === wsLocalKey(LS_KEY) && (e.newValue === 'engineer' || e.newValue === 'novice')) {
        setMode(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsub();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const select = useCallback((next: AudienceMode) => {
    setMode(next);
    void saveAudienceMode(next);
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <div className="audience-mode-selector" role="group" aria-label="Audience mode">
        <Tooltip label="Engineer mode — peer-level, terse, full technical vocabulary"><button
          type="button"
          className={`audience-mode-btn${mode === 'engineer' ? ' audience-mode-btn--active' : ''}`}
          onClick={() => select('engineer')}
          aria-pressed={mode === 'engineer'}
          aria-label="Engineer"
        >
          <Wrench size={14} aria-hidden="true" />
        </button></Tooltip>
        <Tooltip label="Novice mode — plain language, outcome-first, no implementation questions"><button
          type="button"
          className={`audience-mode-btn${mode === 'novice' ? ' audience-mode-btn--active' : ''}`}
          onClick={() => select('novice')}
          aria-pressed={mode === 'novice'}
          aria-label="Novice"
        >
          <GraduationCap size={14} aria-hidden="true" />
        </button></Tooltip>
      </div>
    </>
  );
}

const CSS = `
.audience-mode-selector {
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 80%));
  overflow: hidden;
  flex-shrink: 0;
}
.audience-mode-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 9px;
  background: transparent;
  border: none;
  color: var(--fg-mute, #94a3b8);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  line-height: 0;
}
.audience-mode-btn + .audience-mode-btn {
  border-left: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 80%));
}
.audience-mode-btn:hover {
  background: color-mix(in srgb, var(--accent-strong), transparent 92%);
  color: var(--fg, #e7eef7);
}
.audience-mode-btn--active {
  background: color-mix(in srgb, var(--accent), transparent 86%);
  color: var(--accent-strong, #7dd3fc);
}
`;
