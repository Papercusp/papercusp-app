'use client';

import { forwardRef, type CSSProperties, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const BASE_STYLE: CSSProperties = {
  background: 'var(--bg-2, var(--panel-dim, transparent))',
  color: 'var(--fg, var(--ink, currentColor))',
  border: '1px solid var(--border, var(--line, currentColor))',
  borderRadius: 4,
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '4px 8px',
  outline: 'none',
};

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
};

/** Registry `control.text`: text input with optional leading/trailing slots. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { leading, trailing, style, className, ...rest },
  ref,
) {
  if (!leading && !trailing) {
    return (
      <input
        ref={ref}
        className={className ? `pc-text-input ${className}` : 'pc-text-input'}
        style={{ ...BASE_STYLE, ...style }}
        {...rest}
      />
    );
  }
  return (
    <div
      className={className ? `pc-text-input-wrap ${className}` : 'pc-text-input-wrap'}
      style={{ ...BASE_STYLE, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', ...style }}
    >
      {leading}
      <input
        ref={ref}
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', padding: '4px 0', outline: 'none' }}
        {...rest}
      />
      {trailing}
    </div>
  );
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { style, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={className ? `pc-text-input ${className}` : 'pc-text-input'}
      style={{ ...BASE_STYLE, padding: '6px 8px', minHeight: 60, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45, ...style }}
      {...rest}
    />
  );
});
