'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Modal } from './Modal';

/**
 * PromptModal — replacement for `window.prompt()` that captures free-text
 * input (parallel to `<ConfirmModal>` for yes/no). Use when migrating a
 * site shaped like:
 *
 *   const name = window.prompt('Rename workspace:', current);
 *   if (!name) return;
 *   await save(name);
 *
 * to:
 *
 *   const [open, setOpen] = useState(false);
 *   <PromptModal
 *     open={open}
 *     onOpenChange={setOpen}
 *     title="Rename workspace"
 *     label="New name"
 *     defaultValue={current}
 *     onSubmit={async (name) => { await save(name); }}
 *   />
 *
 * The input auto-focuses on open. Empty / whitespace-only submissions are
 * rejected (button disabled). `onSubmit` may be async; the dialog auto-
 * closes on resolve. Errors keep it open (toast yourself).
 *
 * For a typed-confirmation gate (user must type the exact resource name
 * to enable the destructive action), use `<ConfirmModal requireType=…>`
 * instead — that's a *gate*, not a *capture*.
 */
export function PromptModal({
  open,
  onOpenChange,
  title,
  label,
  body,
  defaultValue = '',
  placeholder,
  submitLabel = 'Submit',
  cancelLabel = 'Cancel',
  allowEmpty = false,
  validate,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  body?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on every open so the field always reflects defaultValue and clears
  // any prior error / busy state.
  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setBusy(false);
      setError(null);
      // Defer focus to after Modal opens (its onOpenAutoFocus may grab the
      // dialog itself first).
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [open, defaultValue]);

  const trimmed = value.trim();
  const validationError = trimmed
    ? (validate?.(trimmed) ?? null)
    : allowEmpty ? null : 'Required';
  const canSubmit = !validationError && !busy;

  const close = () => onOpenChange(false);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        onOpenChange(v);
      }}
      title={title}
      srOnlyTitle
      closeOnEscape={!busy}
      closeOnOutsideClick={!busy}
      contentStyle={{
        width: 'min(440px, 92vw)',
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
        color: 'var(--fg, #e8e8ea)',
      }}
    >
      <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>{title}</h2>
      {body !== undefined && (
        <div style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          {body}
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <label style={{ display: 'block', margin: '0 0 16px', fontSize: 12, color: 'var(--fg-mute)' }}>
          {label}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            disabled={busy}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            autoFocus
            style={{
              display: 'block',
              width: '100%',
              marginTop: 6,
              padding: '6px 8px',
              background: 'var(--bg-2)',
              border: `1px solid ${error ? 'var(--bad)' : 'var(--border)'}`,
              borderRadius: 4,
              color: 'var(--fg)',
              fontFamily: 'inherit',
              fontSize: 13,
            }}
          />
          {error && <span style={{ display: 'block', marginTop: 4, color: 'var(--bad)' }}>{error}</span>}
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={close} disabled={busy} style={ghostBtn(busy)}>
            {cancelLabel}
          </button>
          <button type="submit" disabled={!canSubmit} style={primaryBtn(!canSubmit)}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ghostBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 13,
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--fg-dim)',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 13,
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
    color: 'var(--accent-ink, #051827)',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontWeight: 600,
  };
}
