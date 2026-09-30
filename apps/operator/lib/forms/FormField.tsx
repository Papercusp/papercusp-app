'use client';

/**
 * FormField — labelled wrapper around any input with inline error display.
 *
 * Mirrors the visual conventions used elsewhere in the operator
 * (`pluginFieldLabel`, `var(--fg-dim)/--text-3` palette) so a hand-rolled
 * form can be migrated to react-hook-form by swapping `<label>...<input/>`
 * blocks for `<FormField label=...>...</FormField>` with zero visual delta.
 *
 * Accepts a `FieldError` directly from RHF's `formState.errors[name]` or a
 * plain string (for server-side errors set via `setError('root.serverError')`).
 */
import type { FieldError } from 'react-hook-form';
import type { ReactNode } from 'react';

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--fg-dim)',
  marginBottom: 4,
};
const descriptionStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-mute)',
  marginBottom: 4,
  lineHeight: 1.4,
};
const errorStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--bad)',
  marginTop: 4,
};

export function FormField({
  label,
  error,
  description,
  required,
  children,
  className,
}: {
  label: string;
  error?: FieldError | string | undefined;
  description?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const message = typeof error === 'string' ? error : error?.message;
  return (
    <div className={`h-form-field ${className ?? ''}`} style={{ marginBottom: 12 }}>
      <label style={labelStyle}>
        {label} {required && <span style={{ color: 'var(--bad)' }}>*</span>}
      </label>
      {description && <div style={descriptionStyle}>{description}</div>}
      {children}
      {message && <div role="alert" style={errorStyle}>{message}</div>}
    </div>
  );
}
