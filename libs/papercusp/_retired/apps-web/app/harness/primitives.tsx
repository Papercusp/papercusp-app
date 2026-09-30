'use client';

import { CSSProperties, ReactNode } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus, ROLE, RoleKey } from './theme';

/** Dot + label — Linear's status badge pattern. */
export function StatusPill({
  status,
  size = 'sm',
  showLabel = true,
}: {
  status: HarnessStatus;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const s = STATUS[status];
  const dotSize = size === 'xs' ? 6 : 8;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: size === 'xs' ? SIZES.xs : SIZES.sm,
      color: s.text,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{
        width: dotSize, height: dotSize, borderRadius: '50%',
        background: s.solid, flexShrink: 0,
      }} />
      {showLabel && <span>{s.label}</span>}
    </span>
  );
}

/** Short monospace ID pill — copyable. */
export function IdPill({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id).catch(() => {});
        onClick?.();
      }}
      title={`${id} — click to copy`}
      style={{
        fontFamily: FONTS.mono,
        fontSize: SIZES.xs,
        color: COLORS.textMuted,
        background: 'transparent',
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.sm,
        padding: '1px 6px',
        cursor: 'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {id}
    </button>
  );
}

export function RolePill({ role }: { role: string }) {
  const key = (role in ROLE ? role : 'unknown') as RoleKey;
  const r = ROLE[key];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: SIZES.xs, color: COLORS.text,
    }}>
      <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%', background: r.solid,
      }} />
      {r.label.toLowerCase()}
    </span>
  );
}

/** Standard card container with subtle border. */
export function SectionCard({
  title,
  actions,
  children,
  style,
  bodyStyle,
  noPadding,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  noPadding?: boolean;
}) {
  return (
    <div style={{
      background: COLORS.surfaceRaised,
      border: `1px solid ${COLORS.border}`,
      borderRadius: RADIUS.md,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      ...style,
    }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0.5rem 0.75rem',
          borderBottom: `1px solid ${COLORS.borderSubtle}`,
          fontSize: SIZES.sm,
          color: COLORS.textMuted,
          fontWeight: 500,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}>
          <span>{title}</span>
          {actions && <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{actions}</span>}
        </div>
      )}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: noPadding ? 0 : '0.5rem 0.75rem',
        ...bodyStyle,
      }}>
        {children}
      </div>
    </div>
  );
}

export function KbdHint({ children }: { children: ReactNode }) {
  return (
    <kbd style={{
      fontFamily: FONTS.mono,
      fontSize: '0.65rem',
      padding: '1px 5px',
      background: COLORS.surfaceHover,
      color: COLORS.textMuted,
      border: `1px solid ${COLORS.border}`,
      borderRadius: RADIUS.sm,
      textTransform: 'none',
    }}>
      {children}
    </kbd>
  );
}

/** Small icon-style button used across the harness UI. */
export function IconButton({
  onClick,
  title,
  children,
  variant = 'ghost',
  disabled,
}: {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  children: ReactNode;
  variant?: 'ghost' | 'primary' | 'danger' | 'subtle';
  disabled?: boolean;
}) {
  const styles: Record<string, CSSProperties> = {
    ghost: {
      background: 'transparent',
      color: COLORS.textMuted,
      border: `1px solid ${COLORS.border}`,
    },
    subtle: {
      background: COLORS.surfaceHover,
      color: COLORS.text,
      border: `1px solid ${COLORS.border}`,
    },
    primary: {
      background: COLORS.success,
      color: 'white',
      border: `1px solid ${COLORS.success}`,
      fontWeight: 600,
    },
    danger: {
      background: COLORS.danger,
      color: 'white',
      border: `1px solid ${COLORS.danger}`,
      fontWeight: 600,
    },
  };
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        ...styles[variant],
        borderRadius: RADIUS.sm,
        padding: '0.25rem 0.6rem',
        fontSize: SIZES.sm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {children}
    </button>
  );
}
