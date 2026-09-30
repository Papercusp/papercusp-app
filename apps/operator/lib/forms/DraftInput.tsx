'use client';

/**
 * DraftInput / DraftTextarea — commit-on-blur text inputs for per-field
 * auto-save settings pages (the useDebouncedSave pattern, form-patterns §2).
 *
 * Plain `<input value={x} onChange={setX}>` on an auto-save page persists
 * every keystroke: mid-typed values ("fab", "opus:") go live, and a
 * transiently invalid value can clobber the stored setting. These wrappers
 * keep typing in a LOCAL draft and only call `onCommit` when the user
 * finishes editing (blur or Enter) AND the draft passes `validate` — so the
 * page's state (and therefore the auto-save) only ever sees committed,
 * valid values.
 *
 * Behaviour:
 *   - typing      → local draft only, nothing persists
 *   - blur/Enter  → valid: onCommit(draft) (only if changed); invalid: keep
 *                   the draft visible with the error — the committed value
 *                   (and the store) stays untouched
 *   - Escape      → revert the draft to the committed value
 *   - external `value` changes are adopted while not focused (hydration,
 *     resets), and ignored mid-edit so they can't eat a keystroke
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const errorTextStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--bad)',
  lineHeight: 1.3,
};

interface DraftCommonProps {
  /** The committed value (page state). The draft re-syncs to it when not focused. */
  value: string;
  /** Called with the draft on blur/Enter when it validates and differs from `value`. */
  onCommit: (value: string) => void;
  /** Return an error message to block the commit, or null when the draft is OK. */
  validate?: (draft: string) => string | null;
  /** Style for the wrapper element (use for layout: width / flex). */
  wrapperStyle?: CSSProperties;
}

function useDraft({ value, onCommit, validate }: DraftCommonProps) {
  const [draft, setDraft] = useState(value);
  // Errors surface on the first commit ATTEMPT (blur/Enter), not on every
  // keystroke of a fresh edit — flashing "invalid" mid-word is noise. Once
  // flagged, the message tracks the draft live and clears the moment the
  // value validates (validate() returning null hides it automatically).
  const [showError, setShowError] = useState(false);
  const focusedRef = useRef(false);

  // Adopt external changes (hydration, reset buttons) only while idle —
  // never yank the field out from under an in-progress edit.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const error = validate?.(draft) ?? null;

  const commit = () => {
    setShowError(error != null);
    if (error) return; // invalid → flagged, committed value stays
    if (draft !== value) onCommit(draft);
  };

  return {
    draft,
    setDraft,
    error: showError ? error : null,
    commit,
    revert: () => { setDraft(value); setShowError(false); },
    onFocus: () => { focusedRef.current = true; },
    onBlur: () => { focusedRef.current = false; commit(); },
  };
}

export function DraftInput({
  value,
  onCommit,
  validate,
  wrapperStyle,
  style,
  ...rest
}: DraftCommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus'>) {
  const d = useDraft({ value, onCommit, validate });
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, ...wrapperStyle }}>
      <input
        {...rest}
        value={d.draft}
        aria-invalid={d.error ? true : undefined}
        style={{ ...style, ...(d.error ? { borderColor: 'var(--bad)' } : {}) }}
        onChange={(e) => d.setDraft(e.target.value)}
        onFocus={d.onFocus}
        onBlur={d.onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) d.commit();
          else if (e.key === 'Escape') d.revert();
          rest.onKeyDown?.(e);
        }}
      />
      {d.error && <span role="alert" style={errorTextStyle}>{d.error}</span>}
    </span>
  );
}

export function DraftTextarea({
  value,
  onCommit,
  validate,
  wrapperStyle,
  style,
  ...rest
}: DraftCommonProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus'>) {
  const d = useDraft({ value, onCommit, validate });
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, ...wrapperStyle }}>
      <textarea
        {...rest}
        value={d.draft}
        aria-invalid={d.error ? true : undefined}
        style={{ ...style, ...(d.error ? { borderColor: 'var(--bad)' } : {}) }}
        onChange={(e) => d.setDraft(e.target.value)}
        onFocus={d.onFocus}
        onBlur={d.onBlur}
        onKeyDown={(e) => {
          // Enter inserts a newline in a textarea; commit happens on blur.
          if (e.key === 'Escape') d.revert();
          rest.onKeyDown?.(e);
        }}
      />
      {d.error && <span role="alert" style={errorTextStyle}>{d.error}</span>}
    </span>
  );
}
