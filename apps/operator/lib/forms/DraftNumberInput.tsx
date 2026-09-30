'use client';

/**
 * DraftNumberInput — the numeric sibling of DraftInput for per-field
 * auto-save settings pages (form-patterns §2). Typing stays in a local
 * draft; the value persists only on blur/Enter and only when it parses to a
 * finite number inside [min, max]. An invalid or out-of-range draft gets an
 * inline error and the stored value stays untouched — never clamp-and-save
 * mid-edit (the /settings/voice bug class: a PUT per keystroke that fought
 * the user's typing). Escape reverts; external `value` changes (hydration, a
 * peer field's save echoing the whole prefs object back) are adopted only
 * while idle, never mid-edit.
 *
 * The one semantic knob is `emptyDraft` — what committing an empty field
 * means: 'invalid' (default — flag it; the setting always has a number) or
 * 'ignore' (a silent no-op — for optional overrides where empty just means
 * "nothing entered", e.g. /settings/user per-preference overrides).
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, InputHTMLAttributes } from 'react';

const errorTextStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--bad)',
  lineHeight: 1.3,
};

export function DraftNumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  emptyDraft = 'invalid',
  wrapperStyle,
  style,
  ...rest
}: {
  /** Committed value (page state). `null`/`undefined` = unset — the draft starts empty. */
  value: number | null | undefined;
  /** Called with the parsed number on blur/Enter when it validates and differs from `value`. */
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Committing an empty field: 'invalid' = inline error (default), 'ignore' = silent no-op. */
  emptyDraft?: 'invalid' | 'ignore';
  /** Style for the wrapper element (use for layout: width / flex). */
  wrapperStyle?: CSSProperties;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus' | 'type' | 'min' | 'max' | 'step'>) {
  const committedDraft = value == null ? '' : String(value);
  const [draft, setDraft] = useState(committedDraft);
  // Errors surface on the first commit ATTEMPT (blur/Enter), not on every
  // keystroke of a fresh edit; once flagged, editing clears the flag and the
  // next attempt re-validates.
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) { setDraft(value == null ? '' : String(value)); setError(null); }
  }, [value]);

  const commit = () => {
    if (draft.trim() === '') {
      if (emptyDraft === 'ignore') { setError(null); return; }
      setError('not a number — keeping the saved value');
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setError('not a number — keeping the saved value');
      return;
    }
    if ((min != null && n < min) || (max != null && n > max)) {
      setError(
        min != null && max != null
          ? `out of range (${min}–${max}) — keeping the saved value`
          : min != null
            ? `must be ≥ ${min} — keeping the saved value`
            : `must be ≤ ${max} — keeping the saved value`,
      );
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, ...wrapperStyle }}>
      <input
        {...rest}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setDraft(committedDraft); setError(null); }
          rest.onKeyDown?.(e);
        }}
        style={{ ...style, ...(error ? { borderColor: 'var(--bad)' } : {}) }}
      />
      {error && <span role="alert" style={errorTextStyle}>{error}</span>}
    </span>
  );
}
