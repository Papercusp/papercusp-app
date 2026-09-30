'use client';

import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
} from 'react';
import { useLexiconPackId } from '@/lib/useLexicon';
import { HivePrimaryMark } from './PotVisualIdentity';

type Props = ComponentPropsWithoutRef<'svg'> & {
  decorative?: boolean;
  variant?: 'full' | 'compact';
};

export const OperatorLogoMark = forwardRef<SVGSVGElement, Props>(function OperatorLogoMark(
  { className, decorative = true, variant = 'full', ...props },
  ref,
) {
  const packId = useLexiconPackId();
  const base = useId().replace(/:/g, '');
  if (packId === 'the-hive') {
    return (
      <HivePrimaryMark
        ref={ref}
        className={className}
        decorative={decorative}
        data-hive-mark={variant}
        {...props}
      />
    );
  }

  const ids = {
    bg: `${base}-bg`,
    ring: `${base}-ring`,
    cup: `${base}-cup`,
    coffee: `${base}-coffee`,
    glow: `${base}-glow`,
  };

  const compact = variant === 'compact';
  return (
    <svg
      ref={ref}
      viewBox="18 12 92 92"
      className={className}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="38%" r="68%">
          <stop offset="0%" stopColor="var(--bg-raised-high, #17324a)" />
          <stop offset="58%" stopColor="var(--bg-1, #0b1624)" />
          <stop offset="100%" stopColor="var(--bg, #07101d)" />
        </radialGradient>
        <linearGradient id={ids.ring} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--accent-soft, #b9efff)" />
          <stop offset="52%" stopColor="var(--accent, #57d8ff)" />
          <stop offset="100%" stopColor="var(--accent-deep, #178db8)" />
        </linearGradient>
        <linearGradient id={ids.cup} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="var(--fg, #f3eef9)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--fg-dim, #d7d2e2)" stopOpacity="0.78" />
        </linearGradient>
        <linearGradient id={ids.coffee} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--warn, #c8a57b)" />
          <stop offset="100%" stopColor="var(--accent-deep, #8b5e3d)" />
        </linearGradient>
        <filter id={ids.glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {compact ? (
        <>
          <circle cx="64" cy="64" r="57" fill={`url(#${ids.bg})`} stroke="color-mix(in srgb, var(--accent-soft), transparent 84%)" strokeWidth="1" />
          <path d="M64 18c0 7.5-8.5 12-16 18" fill="none" stroke="var(--warn, #d9a977)" strokeWidth="3.2" strokeLinecap="round" />
          <path d="M64 18c0 7.5 8.5 12 16 18" fill="none" stroke="var(--warn, #d9a977)" strokeWidth="3.2" strokeLinecap="round" />
          <g transform="translate(0 7)">
            <path
              d="M34 39h60l-4.5 45c0 6-9.5 10.5-25.5 10.5S38.5 90 38.5 84z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.16"
              stroke="var(--accent-soft, #d8f4ff)"
              strokeOpacity="0.88"
              strokeWidth="2.35"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="39" rx="30" ry="6.2" fill={`url(#${ids.cup})`} fillOpacity="0.2" stroke="var(--accent-soft, #d8f4ff)" strokeOpacity="0.88" strokeWidth="2.35" />
            <ellipse cx="64" cy="39" rx="23.5" ry="3.8" fill={`url(#${ids.coffee})`} fillOpacity="0.9" />
            <path d="M44.5 58c11.2-3 27.8-3 39 0" fill="none" stroke="var(--warn, #d9a977)" strokeOpacity="0.74" strokeWidth="2.15" strokeLinecap="round" />
            <rect x="60.75" y="55" width="6.5" height="21" rx="3" fill="var(--accent-strong, #7ce2ff)" fillOpacity="0.84" />
            <path d="M54.5 86c2.4 3 5.6 4.5 9.5 4.5s7.1-1.5 9.5-4.5" fill="none" stroke="var(--accent-strong, #7ce2ff)" strokeOpacity="0.84" strokeWidth="2.05" strokeLinecap="round" />
          </g>
        </>
      ) : (
        <>
          <circle cx="64" cy="64" r="59" fill={`url(#${ids.bg})`} stroke="color-mix(in srgb, var(--accent-soft), transparent 90%)" strokeWidth="0.8" />
          <circle cx="64" cy="64" r="56" fill="none" stroke={`url(#${ids.ring})`} strokeOpacity="0.38" strokeWidth="1.4" />
          <path d="M64 18c0 8-9 13-17 20" fill="none" stroke="var(--warn, #d9a977)" strokeWidth="3.45" strokeLinecap="round" />
          <path d="M64 18c0 8 9 13 17 20" fill="none" stroke="var(--warn, #d9a977)" strokeWidth="3.45" strokeLinecap="round" />
          <g filter={`url(#${ids.glow})`}>
            <circle cx="64" cy="29" r="2.8" fill="var(--accent-strong, #7ce2ff)" />
          </g>
          <g transform="translate(0 3)">
            <path
              d="M31 39h66l-4.5 48c0 6.8-10.8 12.2-28.5 12.2S35.5 93.8 35.5 87z"
              fill={`url(#${ids.cup})`}
              fillOpacity="0.16"
              stroke="var(--accent-soft, #d8f4ff)"
              strokeOpacity="0.88"
              strokeWidth="2.45"
              strokeLinejoin="round"
            />
            <ellipse cx="64" cy="39" rx="33" ry="6.8" fill={`url(#${ids.cup})`} fillOpacity="0.2" stroke="var(--accent-soft, #d8f4ff)" strokeOpacity="0.88" strokeWidth="2.45" />
            <ellipse cx="64" cy="39" rx="25.5" ry="4.1" fill={`url(#${ids.coffee})`} fillOpacity="0.9" />
            <path d="M43.5 59c11.8-3.2 29.2-3.2 41 0" fill="none" stroke="var(--warn, #d9a977)" strokeOpacity="0.74" strokeWidth="2.25" strokeLinecap="round" />
            <rect x="60.6" y="56" width="6.8" height="22" rx="3.2" fill="var(--accent-strong, #7ce2ff)" fillOpacity="0.84" />
            <path d="M54 88c2.6 3.3 6 4.9 10 4.9s7.4-1.6 10-4.9" fill="none" stroke="var(--accent-strong, #7ce2ff)" strokeOpacity="0.84" strokeWidth="2.1" strokeLinecap="round" />
          </g>
        </>
      )}
    </svg>
  );
});
