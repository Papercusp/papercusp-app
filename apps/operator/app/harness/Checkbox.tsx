'use client';

import * as RC from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

const ROOT_STYLE: CSSProperties = {
  width: 14,
  height: 14,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  borderRadius: 3,
  cursor: 'pointer',
  outline: 'none',
  flexShrink: 0,
  padding: 0,
};

/**
 * Checkbox — Radix Checkbox styled to match the harness's native checkboxes.
 * Drop-in for `<input type="checkbox" checked={x} onChange={(e) => setX(e.target.checked)} />`:
 *
 *   <Checkbox checked={x} onChange={setX} />
 *
 * Supports indeterminate state, which native HTML checkboxes can't express
 * declaratively. Wrap with a <label> to keep the click target inclusive.
 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  indeterminate,
  ariaLabel,
  describedBy,
  id,
  style,
  className,
  dataTestId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  ariaLabel?: string;
  /** Forwarded as aria-describedby, for pairing with a nearby hint/description. */
  describedBy?: string;
  /** Forwarded as the element id — pair with a <label htmlFor={id}> for native
   *  label association (findByLabelText etc). */
  id?: string;
  style?: CSSProperties;
  className?: string;
  /** Forwarded as data-testid on the checkbox element itself, so tests that
   * click getByTestId(...) hit the real toggle target (EI-9468 migration). */
  dataTestId?: string;
}) {
  const value: boolean | 'indeterminate' = indeterminate ? 'indeterminate' : checked;
  return (
    <RC.Root
      id={id}
      checked={value}
      onCheckedChange={(v) => onChange(v === true)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      data-testid={dataTestId}
      className={className}
      style={className ? undefined : { ...ROOT_STYLE, ...style }}
    >
      <RC.Indicator>
        {indeterminate ? <Minus size={10} /> : <Check size={10} />}
      </RC.Indicator>
    </RC.Root>
  );
}
