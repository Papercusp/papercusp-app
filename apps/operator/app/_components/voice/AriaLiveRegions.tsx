'use client';

/**
 * Dual aria-live regions (Phase 1e, v4 §2j).
 *
 * Two hidden regions in the chrome layout. `speak(text, { priority })`
 * writes to the corresponding region synchronously so screen-reader
 * users see the same content the TTS speaks.
 *
 *   polite    → role=status, queues behind current SR output
 *   assertive → role=alert,  preempts SR output
 *
 * Per-feature priority assignment (per v4 §2j table):
 *   suggestion arrival     → polite (assertive when tier=high)
 *   auto-fire + cancel cue → polite (assertive when tier=high)
 *   active/passive flip    → polite
 *   cadence status         → polite
 *   budget warning         → assertive
 *   breaker tripped        → assertive
 *   pause toggle           → polite
 *   TTS-failure toast      → assertive
 *
 * (The original table also listed "receiving-flip consumed → polite" and
 * "receiving-flip escalated → assertive". Both card states were removed by the
 * card-lifecycle collapse — a card is now only pending/accepted/ignored — so
 * neither event can fire. settings-audit 2026-07-09.)
 *
 * Visual prominence invariant: visual toasts always carry the same
 * information regardless of voice state. This component is the
 * a11y-only mirror of what TTS speaks.
 */

import { useEffect, useState } from 'react';
import { subscribeAriaLiveText } from './aria-live-bus';

export function AriaLiveRegions(): React.JSX.Element {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    const unsub = subscribeAriaLiveText((priority, text) => {
      if (priority === 'assertive') setAssertive(text);
      else setPolite(text);
    });
    return unsub;
  }, []);

  return (
    <>
      <div
        aria-live="polite"
        role="status"
        style={visuallyHidden}
        id="voice-aria-polite"
      >
        {polite}
      </div>
      <div
        aria-live="assertive"
        role="alert"
        style={visuallyHidden}
        id="voice-aria-assertive"
      >
        {assertive}
      </div>
    </>
  );
}

const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
