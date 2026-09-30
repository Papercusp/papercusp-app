import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
} from 'react';

type SvgProps = ComponentPropsWithoutRef<'svg'> & {
  decorative?: boolean;
};

type MarkProps = SvgProps & {
  monochrome?: boolean;
};

export const HIVE_BRAND_COLORS = {
  ink: '#0B0E14',
  charcoal: '#0F1411',
  charcoalRaised: '#171A13',
  honey: '#F6B72F',
  honeyStrong: '#FFD166',
  honeyDeep: '#B97812',
  cream: '#FFF2C2',
} as const;

function ariaProps(decorative: boolean | undefined) {
  return {
    'aria-hidden': decorative ? true : undefined,
    focusable: 'false' as const,
  };
}

export const HivePrimaryMark = forwardRef<SVGSVGElement, MarkProps>(function HivePrimaryMark(
  { className, decorative = true, monochrome = false, ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const ids = {
    bg: `${base}-hive-bg`,
    honey: `${base}-hive-honey`,
    wing: `${base}-hive-wing`,
    glow: `${base}-hive-glow`,
  };
  const stroke = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.honeyStrong;
  const fill = monochrome ? 'none' : `url(#${ids.bg})`;
  const honey = monochrome ? 'currentColor' : `url(#${ids.honey})`;
  const muted = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.cream;
  const beeFill = monochrome ? 'none' : honey;
  const beeWing = monochrome ? 'none' : `url(#${ids.wing})`;

  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#25210F" />
          <stop offset="56%" stopColor={HIVE_BRAND_COLORS.charcoal} />
          <stop offset="100%" stopColor="#080A08" />
        </radialGradient>
        <linearGradient id={ids.honey} x1="24%" y1="8%" x2="84%" y2="92%">
          <stop offset="0%" stopColor={HIVE_BRAND_COLORS.honeyStrong} />
          <stop offset="52%" stopColor={HIVE_BRAND_COLORS.honey} />
          <stop offset="100%" stopColor={HIVE_BRAND_COLORS.honeyDeep} />
        </linearGradient>
        <linearGradient id={ids.wing} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFF8D6" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#F6B72F" stopOpacity="0.30" />
        </linearGradient>
        <filter id={ids.glow} x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur stdDeviation="3.4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d="M64 8 113 36v56l-49 28-49-28V36z" fill={fill} stroke={stroke} strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M64 20 101 41v43l-37 22-37-22V41z" fill="none" stroke={stroke} strokeOpacity={monochrome ? 0.55 : 0.34} strokeWidth="1.6" />
      <path d="M25 78c21-26 52-37 80-30M25 52c27 13 50 33 68 57M44 103c17-36 31-54 60-67" fill="none" stroke={stroke} strokeOpacity={monochrome ? 0.35 : 0.24} strokeWidth="1.6" strokeLinecap="round" />
      <g filter={monochrome ? undefined : `url(#${ids.glow})`}>
        <g transform="translate(57 48) rotate(-8) scale(1.25)">
          <path d="M-7-3c-7-7-15-6-20 1 6 3 14 2 20-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.48} strokeWidth="1.3" />
          <path d="M7-3c7-7 15-6 20 1-6 3-14 2-20-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.48} strokeWidth="1.3" />
          <path d="M0-12c6 5 9 11 9 19 0 10-4 18-9 18S-9 17-9 7c0-8 3-14 9-19Z" fill={beeFill} stroke={stroke} strokeWidth="1.5" />
          <path d="M-7 3H7M-7 12H7" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.64} strokeWidth="2" strokeLinecap="round" />
        </g>
        <g transform="translate(87 31) rotate(24) scale(.74)">
          <path d="M-7-2c-6-5-12-4-16 1 5 2 11 2 16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M7-2c6-5 12-4 16 1-5 2-11 2-16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M0-10c5 4 8 9 8 16 0 9-3 16-8 16S-8 15-8 6c0-7 3-12 8-16Z" fill={beeFill} stroke={stroke} strokeWidth="1.8" />
          <path d="M-6 2H6M-6 10H6" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.62} strokeWidth="2.1" strokeLinecap="round" />
        </g>
        <g transform="translate(34 72) rotate(-38) scale(.68)">
          <path d="M-7-2c-6-5-12-4-16 1 5 2 11 2 16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M7-2c6-5 12-4 16 1-5 2-11 2-16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M0-10c5 4 8 9 8 16 0 9-3 16-8 16S-8 15-8 6c0-7 3-12 8-16Z" fill={beeFill} stroke={stroke} strokeWidth="1.8" />
          <path d="M-6 2H6M-6 10H6" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.62} strokeWidth="2.1" strokeLinecap="round" />
        </g>
        <g transform="translate(82 88) rotate(31) scale(.82)">
          <path d="M-7-2c-6-5-12-4-16 1 5 2 11 2 16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M7-2c6-5 12-4 16 1-5 2-11 2-16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.42} strokeWidth="1.4" />
          <path d="M0-10c5 4 8 9 8 16 0 9-3 16-8 16S-8 15-8 6c0-7 3-12 8-16Z" fill={beeFill} stroke={stroke} strokeWidth="1.8" />
          <path d="M-6 2H6M-6 10H6" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.62} strokeWidth="2.1" strokeLinecap="round" />
        </g>
        <g transform="translate(39 35) rotate(49) scale(.58)">
          <path d="M-7-2c-6-5-12-4-16 1 5 2 11 2 16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.40} strokeWidth="1.4" />
          <path d="M7-2c6-5 12-4 16 1-5 2-11 2-16-1Z" fill={beeWing} stroke={muted} strokeOpacity={monochrome ? 0.70 : 0.40} strokeWidth="1.4" />
          <path d="M0-10c5 4 8 9 8 16 0 9-3 16-8 16S-8 15-8 6c0-7 3-12 8-16Z" fill={beeFill} stroke={stroke} strokeWidth="1.8" />
          <path d="M-6 2H6M-6 10H6" stroke={HIVE_BRAND_COLORS.charcoal} strokeOpacity={monochrome ? 0 : 0.62} strokeWidth="2.1" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
});

export const HiveQueenMark = forwardRef<SVGSVGElement, MarkProps>(function HiveQueenMark(
  { className, decorative = true, monochrome = false, ...props },
  ref,
) {
  const base = useId().replace(/:/g, '');
  const ids = {
    bg: `${base}-queen-bg`,
    crown: `${base}-queen-crown`,
    core: `${base}-queen-core`,
    glow: `${base}-queen-glow`,
  };
  const stroke = monochrome ? 'currentColor' : HIVE_BRAND_COLORS.honeyStrong;
  const fill = monochrome ? 'none' : `url(#${ids.bg})`;

  return (
    <svg
      ref={ref}
      viewBox="0 0 128 128"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <radialGradient id={ids.bg} cx="50%" cy="35%" r="72%">
          <stop offset="0%" stopColor="#2B250D" />
          <stop offset="62%" stopColor="#10120E" />
          <stop offset="100%" stopColor="#070807" />
        </radialGradient>
        <linearGradient id={ids.crown} x1="20%" y1="0%" x2="86%" y2="100%">
          <stop offset="0%" stopColor="#FFF2C2" />
          <stop offset="46%" stopColor="#FFD166" />
          <stop offset="100%" stopColor="#B97812" />
        </linearGradient>
        <radialGradient id={ids.core} cx="50%" cy="46%" r="58%">
          <stop offset="0%" stopColor="#FFF8D6" stopOpacity="0.96" />
          <stop offset="38%" stopColor="#F6B72F" stopOpacity="0.78" />
          <stop offset="100%" stopColor="#F6B72F" stopOpacity="0" />
        </radialGradient>
        <filter id={ids.glow} x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur stdDeviation="4.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d="M64 8 113 36v56l-49 28-49-28V36z" fill={fill} stroke={stroke} strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M35 48 48 30l16 19 16-19 13 18-8 37H43z" fill={monochrome ? 'none' : `url(#${ids.crown})`} stroke={stroke} strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="64" cy="72" r="25" fill={monochrome ? 'none' : `url(#${ids.core})`} stroke={stroke} strokeOpacity="0.62" strokeWidth="1.8" />
      <g filter={monochrome ? undefined : `url(#${ids.glow})`}>
        <path d="M47 75h34M52 65h24M57 55h14" stroke={stroke} strokeWidth="2.8" strokeLinecap="round" />
        <path d="M64 42v54" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" />
      </g>
      <path d="M31 91h66" stroke={stroke} strokeOpacity="0.42" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
});

type NounIconKind = 'hive' | 'swarm' | 'mug' | 'papercup' | 'cup' | 'keeper' | 'cell' | 'comb' | 'frame';

type NounIconProps = SvgProps & {
  kind: NounIconKind;
};

export function HiveNounIcon({ kind, className, decorative = true, ...props }: NounIconProps) {
  const base = useId().replace(/:/g, '');
  const id = `${base}-${kind}`;

  if (kind === 'mug') {
    return <HiveQueenMark className={className} decorative={decorative} monochrome {...props} />;
  }

  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <linearGradient id={id} x1="18%" y1="0%" x2="86%" y2="100%">
          <stop offset="0%" stopColor="#FFF2C2" />
          <stop offset="58%" stopColor="#F6B72F" />
          <stop offset="100%" stopColor="#B97812" />
        </linearGradient>
      </defs>
      {kind === 'hive' ? (
        <path d="M32 6 55 19v26L32 58 9 45V19z" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinejoin="round" />
      ) : null}
      {kind === 'swarm' ? (
        <g fill="none" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 34c9-12 21-17 36-15M19 47c10-10 21-13 33-9" strokeOpacity="0.55" />
          <g transform="translate(19 23) rotate(-28)">
            <path d="M0-5c4 3 6 7 6 12 0 6-2 10-6 10S-6 13-6 7c0-5 2-9 6-12Z" />
            <path d="M-5 1c-5-4-9-3-12 1 4 2 8 1 12-1ZM5 1c5-4 9-3 12 1-4 2-8 1-12-1Z" />
          </g>
          <g transform="translate(38 17) rotate(28) scale(.74)">
            <path d="M0-5c4 3 6 7 6 12 0 6-2 10-6 10S-6 13-6 7c0-5 2-9 6-12Z" />
            <path d="M-5 1c-5-4-9-3-12 1 4 2 8 1 12-1ZM5 1c5-4 9-3 12 1-4 2-8 1-12-1Z" />
          </g>
          <g transform="translate(33 43) rotate(-8) scale(.82)">
            <path d="M0-5c4 3 6 7 6 12 0 6-2 10-6 10S-6 13-6 7c0-5 2-9 6-12Z" />
            <path d="M-5 1c-5-4-9-3-12 1 4 2 8 1 12-1ZM5 1c5-4 9-3 12 1-4 2-8 1-12-1Z" />
          </g>
          <g transform="translate(49 32) rotate(34) scale(.62)">
            <path d="M0-5c4 3 6 7 6 12 0 6-2 10-6 10S-6 13-6 7c0-5 2-9 6-12Z" />
            <path d="M-5 1c-5-4-9-3-12 1 4 2 8 1 12-1ZM5 1c5-4 9-3 12 1-4 2-8 1-12-1Z" />
          </g>
        </g>
      ) : null}
      {kind === 'cup' ? (
        <g stroke={`url(#${id})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M32 18c7 5 10 11 10 19 0 10-4 18-10 18S22 47 22 37c0-8 3-14 10-19Z" />
          <path d="M24 31h16M23 40h18M25 22c-6-6-14-5-18 1 6 3 12 3 18-1ZM39 22c6-6 14-5 18 1-6 3-12 3-18-1Z" />
        </g>
      ) : null}
      {kind === 'papercup' ? (
        <g stroke={`url(#${id})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M32 10 54 22v22L32 56 10 44V22z" strokeOpacity="0.42" />
          <path d="M32 18c7 5 10 11 10 19 0 10-4 18-10 18S22 47 22 37c0-8 3-14 10-19Z" />
          <path d="M24 31h16M23 40h18M25 22c-6-6-14-5-18 1 6 3 12 3 18-1ZM39 22c6-6 14-5 18 1-6 3-12 3-18-1Z" />
          <path d="M18 16 10 8M46 16l8-8M14 51l-6 5M50 51l6 5" strokeOpacity="0.78" />
        </g>
      ) : null}
      {kind === 'keeper' ? (
        <g stroke={`url(#${id})`} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M32 9 52 21v22L32 55 12 43V21z" strokeOpacity="0.42" />
          <path d="M23 31c0-7 4-12 9-12s9 5 9 12c0 6-4 10-9 10s-9-4-9-10Z" />
          <path d="M19 54c2-8 7-12 13-12s11 4 13 12M22 26c5 2 12 2 20 0" />
        </g>
      ) : null}
      {kind === 'cell' ? (
        <path d="M32 8 52 20v24L32 56 12 44V20z" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinejoin="round" />
      ) : null}
      {kind === 'comb' ? (
        <g fill="none" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinejoin="round">
          <path d="M22 8 34 15v14l-12 7-12-7V15z" />
          <path d="M42 8 54 15v14l-12 7-12-7V15z" />
          <path d="M32 29 44 36v14l-12 7-12-7V36z" />
        </g>
      ) : null}
      {kind === 'frame' ? (
        <g fill="none" stroke={`url(#${id})`} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="12" y="10" width="40" height="44" rx="4" />
          <path d="M20 18h24M20 46h24M20 26l24 14M44 26 20 40" />
        </g>
      ) : null}
    </svg>
  );
}

export function HiveCombMotif({ className, decorative = true, ...props }: SvgProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      viewBox="0 0 360 120"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      {...ariaProps(decorative)}
      {...props}
    >
      <defs>
        <pattern id={`${id}-comb`} width="48" height="42" patternUnits="userSpaceOnUse" patternTransform="translate(2 0)">
          <path d="M24 2 45 14v24L24 50 3 38V14z" fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.2" />
        </pattern>
        <linearGradient id={`${id}-fade`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="360" height="120" fill={`url(#${id}-comb)`} />
      <path d="M26 61h308" stroke={`url(#${id}-fade)`} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export type { NounIconKind };
