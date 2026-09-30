'use client';

/**
 * GoalPanelVisibilityMenu — one explicit visibility chooser for every side
 * panel in the goal conversation popup.
 *
 * The old toolbar rendered six directional chevrons in one row. Each control
 * was individually operable, but the row made the reader decode direction,
 * current state, and panel ownership before they could answer the simple
 * question "what is visible?". This popover keeps that state in the existing
 * URL-backed setters while presenting it as checked rows, grouped by the edge
 * each panel occupies.
 *
 * Unavailable panels are omitted by the caller. The popover deliberately stays
 * open when a checkbox changes so several panels can be arranged in one pass.
 */
import { useId, useState, type CSSProperties } from 'react';
import { ChevronDown, PanelsTopLeft } from 'lucide-react';
import { Checkbox } from '@/app/harness/Checkbox';
import { Popover } from '@/app/harness/Popover';
import { PANEL_TOOLBAR_BUTTON_STYLE } from '@/app/_components/chat/PanelToggleButton';

export interface GoalPanelVisibilityOption {
  id: string;
  label: string;
  side: 'left' | 'right';
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Kept stable across the toolbar-to-popover migration so focused tests and
   * automation do not need a second vocabulary for the same panel state. */
  testId: string;
}

const POPOVER_STYLE: CSSProperties = {
  width: 224,
  padding: 8,
  background: 'var(--bg-popover)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  boxShadow: '0 12px 28px color-mix(in srgb, var(--accent-deep), transparent 82%)',
};

const GROUP_STYLE: CSSProperties = {
  display: 'grid',
  gap: 2,
};

const GROUP_LABEL_STYLE: CSSProperties = {
  padding: '5px 6px 3px',
  color: 'var(--fg-mute)',
  fontSize: 9,
  fontWeight: 660,
  textTransform: 'uppercase',
};

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14px minmax(0, 1fr)',
  alignItems: 'center',
  gap: 8,
  minHeight: 28,
  padding: '4px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 11,
};

export default function GoalPanelVisibilityMenu({
  options,
}: {
  options: GoalPanelVisibilityOption[];
}) {
  const [open, setOpen] = useState(false);
  const idPrefix = useId();
  const left = options.filter((option) => option.side === 'left');
  const right = options.filter((option) => option.side === 'right');

  const group = (side: 'left' | 'right', rows: GoalPanelVisibilityOption[]) => (
    <div key={side} role="group" aria-label={`${side === 'left' ? 'Left' : 'Right'} side`} style={GROUP_STYLE}>
      <div style={GROUP_LABEL_STYLE}>{side === 'left' ? 'Left side' : 'Right side'}</div>
      {rows.map((option) => {
        const checkboxId = `${idPrefix}-${option.id}`;
        return (
          <label key={option.id} htmlFor={checkboxId} style={ROW_STYLE}>
            <Checkbox
              id={checkboxId}
              checked={option.checked}
              onChange={option.onChange}
              dataTestId={option.testId}
            />
            <span>{option.label}</span>
          </label>
        );
      })}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      sideOffset={4}
      ariaLabel="Panel visibility"
      contentStyle={POPOVER_STYLE}
      trigger={(
        <button
          type="button"
          className="pc-button"
          data-testid="goal-panels-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Choose visible panels"
          style={PANEL_TOOLBAR_BUTTON_STYLE}
        >
          <PanelsTopLeft size={12} aria-hidden="true" />
          Panels
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      )}
    >
      <div style={{ display: 'grid', gap: 6 }}>
        {group('left', left)}
        <div aria-hidden="true" style={{ height: 1, background: 'var(--border-muted)' }} />
        {group('right', right)}
      </div>
    </Popover>
  );
}
