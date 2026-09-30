'use client';

/**
 * NumField — labeled + hinted wrapper around lib/forms DraftNumberInput for
 * the /settings/voice prefs. All commit/validation semantics (commit on
 * blur/Enter only, finite + [min, max] gate, inline hold-on-invalid error,
 * Escape revert, idle-only adoption of external echoes) live in
 * DraftNumberInput — this adds only the page's label/hint chrome.
 */
import type { CSSProperties, ReactNode } from 'react';
import { DraftNumberInput } from '@/lib/forms';

const labelStyle: CSSProperties = { display: 'block', fontWeight: 700, fontSize: 12, marginBottom: 4 };

export function NumField({ label, ariaLabel, value, step = 1, min = 0, max, onCommit, hint, inputStyle }: {
  label: ReactNode;
  /** Required when `label` isn't a plain string. */
  ariaLabel?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onCommit: (n: number) => void;
  hint?: ReactNode;
  inputStyle?: CSSProperties;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <DraftNumberInput
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        value={value}
        min={min}
        max={max}
        step={step}
        onCommit={onCommit}
        style={{ padding: '6px 10px', width: '100%', fontSize: 13, ...inputStyle }}
      />
      {hint && <p style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-mute)' }}>{hint}</p>}
    </div>
  );
}
