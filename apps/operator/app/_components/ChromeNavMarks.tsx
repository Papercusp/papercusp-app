import type { ComponentPropsWithoutRef } from 'react';

type IconProps = ComponentPropsWithoutRef<'svg'>;

export function DeckCardsMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <rect
        x="9.2"
        y="3.9"
        width="9.3"
        height="12.4"
        rx="2.1"
        transform="rotate(8 9.2 3.9)"
        stroke="currentColor"
        strokeOpacity="0.38"
        strokeWidth="1.7"
      />
      <rect
        x="6.5"
        y="5.4"
        width="10.1"
        height="13.1"
        rx="2.2"
        stroke="currentColor"
        strokeOpacity="0.64"
        strokeWidth="1.7"
      />
      <rect
        x="3.9"
        y="7.4"
        width="10.8"
        height="13.3"
        rx="2.35"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M6.5 11.2h5.6"
        stroke="currentColor"
        strokeOpacity="0.9"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M6.5 14.3h3.6"
        stroke="currentColor"
        strokeOpacity="0.76"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function BrainMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <path
        d="M9 4.4a2.6 2.6 0 0 0-2.6 2.6c0 .25.04.49.1.72A2.8 2.8 0 0 0 4 10.5c0 .98.5 1.85 1.25 2.36A2.8 2.8 0 0 0 4.6 15a2.8 2.8 0 0 0 1.84 2.63A2.5 2.5 0 0 0 6.4 18.5a2.6 2.6 0 0 0 5.1.7V5.6A2.6 2.6 0 0 0 9 4.4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M15 4.4a2.6 2.6 0 0 1 2.6 2.6c0 .25-.04.49-.1.72A2.8 2.8 0 0 1 20 10.5c0 .98-.5 1.85-1.25 2.36A2.8 2.8 0 0 1 19.4 15a2.8 2.8 0 0 1-1.84 2.63c.03.28.04.41.04.87a2.6 2.6 0 0 1-5.1.7V5.6A2.6 2.6 0 0 1 15 4.4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 5.6v13.6" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.65" />
      <path d="M8.4 9.6c.7.6 1.6.9 2.5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeOpacity="0.7" />
      <path d="M15.6 9.6c-.7.6-1.6.9-2.5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeOpacity="0.7" />
      <path d="M8.4 13.6c.7.6 1.6.9 2.5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeOpacity="0.7" />
      <path d="M15.6 13.6c-.7.6-1.6.9-2.5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeOpacity="0.7" />
    </svg>
  );
}

export function OpsTargetMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="5.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none" />
      <path d="M12 2.6v3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M12 18.2v3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M2.6 12h3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M18.2 12h3.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function ResMark({ className, ...props }: IconProps) {
  // Layered stack — resources (accounts + GPUs) handed down into the hive tree.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <path
        d="M12 3.2 3.4 7.6 12 12l8.6-4.4L12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M3.4 12 12 16.4 20.6 12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity="0.78"
      />
      <path
        d="M3.4 16.4 12 20.8 20.6 16.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity="0.55"
      />
    </svg>
  );
}

export function TerminalMark({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      focusable="false"
      {...props}
    >
      <rect
        x="2.8"
        y="4.4"
        width="18.4"
        height="15.2"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M6.6 9.2 L9.9 12 L6.6 14.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.9 15.2h5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeOpacity="0.85"
      />
    </svg>
  );
}
