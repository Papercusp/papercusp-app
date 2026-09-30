'use client';

import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
} from 'react';
import { useLexiconPackId } from '@/lib/useLexicon';
import { HiveQueenMark } from './PotVisualIdentity';

type Props = ComponentPropsWithoutRef<'svg'> & {
  decorative?: boolean;
};

export const OracleLogoMark = forwardRef<SVGSVGElement, Props>(function OracleLogoMark(
  { className, decorative = true, ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const packId = useLexiconPackId();
  if (packId === 'the-hive') {
    return (
      <HiveQueenMark
        ref={ref}
        className={className}
        decorative={decorative}
        data-hive-mark="oracle"
        {...props}
      />
    );
  }

  const ids = {
    bg: `${base}-bg`,
    ring: `${base}-ring`,
    core: `${base}-core`,
  };

  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="38%" r="68%">
          <stop offset="0%" stopColor="#16324b" />
          <stop offset="58%" stopColor="#0a1624" />
          <stop offset="100%" stopColor="#060d17" />
        </radialGradient>
        <linearGradient id={ids.ring} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#dbf6ff" />
          <stop offset="54%" stopColor="#66dcff" />
          <stop offset="100%" stopColor="#1d88af" />
        </linearGradient>
        <radialGradient id={ids.core} cx="50%" cy="42%" r="58%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="22%" stopColor="#a3ecff" stopOpacity="0.88" />
          <stop offset="45%" stopColor="#58d7ff" stopOpacity="0.78" />
          <stop offset="100%" stopColor="#58d7ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="64" cy="64" r="56" fill={`url(#${ids.bg})`} stroke={`url(#${ids.ring})`} strokeWidth="4" />
      <circle cx="64" cy="64" r="46" fill="none" stroke="rgba(219,246,255,0.18)" strokeWidth="1.4" />
      <circle cx="64" cy="64" r="28" fill="none" stroke="rgba(219,246,255,0.28)" strokeWidth="3" />
      <circle cx="64" cy="64" r="17" fill={`url(#${ids.core})`} />
      <path d="M64 20c0 7-8 11-15 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M64 20c0 7 8 11 15 17" fill="none" stroke="#d9a977" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M64 48v32" fill="none" stroke="#7ce2ff" strokeWidth="3.8" strokeLinecap="round" />
      <path d="M57 75c2.1 2.7 4.5 3.9 7 3.9s4.9-1.2 7-3.9" fill="none" stroke="#7ce2ff" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="64" cy="34" r="2.7" fill="#7ce2ff" />
    </svg>
  );
});
