import React from 'react';

interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Toggle-on state — adds the canonical `.pclsb-chipbtn.is-on` active styling. */
  active?: boolean;
}

/**
 * Chip — the shared toggle / action chip over the canonical `.pclsb-chipbtn`
 * token (operator-vite-ui-consolidation U2-5). Replaces the per-file re-rolled
 * `<button className="pclsb-chipbtn{ is-on}">` across the sidebar panels.
 *
 * Children carry the icon + label (every existing site passes both). All native
 * button props forward (onClick, disabled, title, aria-label, data-testid), and
 * `type` defaults to "button" so it never accidentally submits a form.
 */
export const Chip: React.FC<ChipProps> = ({ active = false, className = '', type, children, ...rest }) => {
  const cls = ['pclsb-chipbtn', active && 'is-on', className].filter(Boolean).join(' ');
  return (
    <button type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  );
};

type ChipBarProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * ChipBar — a light inline-flex row container for a set of <Chip>s (a filter
 * bar). Layout is self-contained (no token dependency) so it works anywhere;
 * pass a `className` to theme it and `style` to override the defaults.
 */
export const ChipBar: React.FC<ChipBarProps> = ({ className = '', style, children, ...rest }) => {
  return (
    <div
      className={`pclsb-chipbar ${className}`.trim()}
      role="group"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}
      {...rest}
    >
      {children}
    </div>
  );
};
