'use client';

import { useEffect, useState } from 'react';
import { useLexiconPackId } from '@/lib/useLexicon';
import { HivePrimaryMark } from './PotVisualIdentity';

const CUP_MOTIONS = ['spin', 'bob', 'tilt', 'orbit', 'pulse', 'scan'] as const;
type CupMotion = (typeof CUP_MOTIONS)[number];
type CupMotionState = CupMotion | 'idle';

// Each value mirrors the matching CSS animation duration in globals.css
// (the `pc-header-cup-*` / `pc-header-cusp-scan` keyframes). The reset
// timer uses it to clear `data-cup-motion` exactly when the animation
// ends, so keep the two in sync.
const MOTION_DURATIONS_MS: Record<CupMotion, number> = {
  spin: 1450,
  bob: 1200,
  tilt: 1250,
  orbit: 1500,
  pulse: 1250,
  scan: 1400,
};

function pickMotion(lastMotion: CupMotion | null): CupMotion {
  const choices = CUP_MOTIONS.filter((motion) => motion !== lastMotion);
  return choices[Math.floor(Math.random() * choices.length)] ?? CUP_MOTIONS[0];
}

export function AnimatedPapercuspCup() {
  const packId = useLexiconPackId();
  const [motion, setMotion] = useState<CupMotionState>('idle');

  useEffect(() => {
    let startTimer: number | undefined;
    let resetTimer: number | undefined;
    let lastMotion: CupMotion | null = null;

    const scheduleNext = () => {
      const delayMs = 6000 + Math.random() * 8000;
      startTimer = window.setTimeout(() => {
        const nextMotion = pickMotion(lastMotion);
        lastMotion = nextMotion;
        setMotion(nextMotion);
        resetTimer = window.setTimeout(() => {
          setMotion('idle');
          scheduleNext();
        }, MOTION_DURATIONS_MS[nextMotion]);
      }, delayMs);
    };

    scheduleNext();

    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(resetTimer);
    };
  }, []);

  if (packId === 'the-hive') {
    return (
      <HivePrimaryMark
        className="pc-header-brand-logo pc-header-brand-logo--hive"
        data-cup-motion={motion}
      />
    );
  }

  return (
    <svg
      viewBox="170 0 180 170"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className="pc-header-brand-logo"
      data-cup-motion={motion}
    >
      <defs>
        <radialGradient id="pcGlow" cx="50%" cy="48%" r="42%">
          <stop offset="0%" stopColor="#f3eef9" stopOpacity="0.18" />
          <stop offset="58%" stopColor="#d4a373" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#d4a373" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="pc-header-brand-cusp" fill="none" stroke="#f3eef9" strokeWidth="5" strokeLinecap="round" opacity="0.96">
        <path d="M 260 20 C 260 54 238 72 214 86" />
        <path d="M 260 20 C 260 54 282 72 306 86" />
      </g>
      <ellipse className="pc-header-brand-cup-glow" cx="260" cy="104" rx="70" ry="58" fill="url(#pcGlow)" />
      <g className="pc-header-brand-cup-stage" transform="translate(260 104) scale(1.08)" opacity="0.46">
        <g className="pc-header-brand-cup">
          <path d="M -48 -20 L -42 42 Q -42 50 0 50 Q 42 50 42 42 L 48 -20 Z" fill="#fff5e1" fillOpacity="0.20" stroke="#f3eef9" strokeOpacity="0.46" strokeWidth="3.2" strokeLinejoin="round" />
          <ellipse cx="0" cy="-20" rx="48" ry="9.5" fill="#fff5e1" fillOpacity="0.20" stroke="#f3eef9" strokeOpacity="0.46" strokeWidth="3.2" />
          <ellipse cx="0" cy="-20" rx="39.5" ry="6.9" fill="#d4a373" fillOpacity="0.48" />
          <path d="M -39 16 Q 0 8 39 16" stroke="#d4a373" strokeOpacity="0.62" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M -24 13 Q -15 5 -6 12" stroke="#f3eef9" strokeOpacity="0.52" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M 6 12 Q 15 5 24 13" stroke="#f3eef9" strokeOpacity="0.52" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="-16" cy="29" r="7.2" fill="#fff5e1" fillOpacity="0.20" stroke="#f3eef9" strokeOpacity="0.46" strokeWidth="2" />
          <circle cx="16" cy="29" r="7.2" fill="#fff5e1" fillOpacity="0.20" stroke="#f3eef9" strokeOpacity="0.46" strokeWidth="2" />
          <circle cx="-16" cy="25" r="2.9" fill="#f3eef9" fillOpacity="0.62" />
          <circle cx="16" cy="25" r="2.9" fill="#f3eef9" fillOpacity="0.62" />
          <ellipse cx="0" cy="39" rx="4.4" ry="6.2" fill="#f3eef9" fillOpacity="0.46" />
        </g>
      </g>
    </svg>
  );
}
