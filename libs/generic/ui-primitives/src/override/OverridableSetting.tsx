/**
 * OverridableSetting — the shared presentational backbone for "workspace default
 * vs session override" settings (sentinel-as-herald-2026-06-21 frontend foundation).
 *
 * Replaces the ~8 hand-rolled copies (ModelTiersOverride's per-tier row,
 * ThrottleSection's per-knob head, AutonomySurfacing, …) with one component: a
 * `label` + an `override`/`default` badge + a reset/clear button shown ONLY when
 * the setting is overridden AND an `onReset` is provided. The actual input control
 * is the `children` slot, so each tab keeps its own control (text input, select,
 * checkbox) while sharing the badge + reset chrome.
 *
 * Two looks, one component, via `badgeStyle`:
 *  - `'chip'` (default) — the ModelTiersOverride look: a text pill badge inline
 *    with the control + a ↺ reset button (`.pc-override-badge`, `.pc-override-reset`).
 *  - `'inline'` — the ThrottleSection `pc-queen__knobbadge` look: a right-aligned
 *    badge (`margin-left:auto`) in the knob head, with a queen-accent --on tint.
 *
 * Purely presentational: it owns NO state and computes NO override math. Callers
 * pass `isOverridden` (compute it with the sibling `isOverridden()` util) and
 * `onReset`. Reset visibility = `isOverridden && !!onReset`.
 */
import type { ReactNode } from 'react';
import { OVERRIDE_CSS } from './override.styles';

export type OverrideBadgeStyle = 'chip' | 'inline';

export interface OverridableSettingProps {
  /** The human label for the setting (also the badge/reset aria context). */
  label: string;
  /** Whether the setting is currently overridden (compute via the `isOverridden()` util). */
  isOverridden: boolean;
  /** Clears the override back to the default. The reset button only renders when this is set. */
  onReset?: () => void;
  /** Disables the reset button (e.g. an in-flight write). */
  busy?: boolean;
  /** `'chip'` = ModelTiersOverride text pill (default); `'inline'` = ThrottleSection knobbadge. */
  badgeStyle?: OverrideBadgeStyle;
  /** Reset button content — defaults to `↺` (the ModelTiersOverride glyph). */
  resetLabel?: ReactNode;
  /** The input control slot (text input, select, checkbox, …). */
  children?: ReactNode;
}

/** Injects the `pc-override-*` styles once. Rendered by OverridableSetting; export
 *  it so a parent can hoist the `<style>` out of a list when rendering many rows. */
export function OverridableSettingStyle() {
  return <style>{OVERRIDE_CSS}</style>;
}

export default function OverridableSetting({
  label,
  isOverridden,
  onReset,
  busy = false,
  badgeStyle = 'chip',
  resetLabel = '↺',
  children,
}: OverridableSettingProps) {
  const badgeClass = `pc-override-badge${badgeStyle === 'inline' ? ' pc-override-badge--inline' : ''}${
    isOverridden ? ' pc-override-badge--on' : ''
  }`;
  const showReset = isOverridden && !!onReset;
  return (
    <div className={`pc-override pc-override--${badgeStyle}`}>
      <OverridableSettingStyle />
      <span className="pc-override__label">{label}</span>
      {children != null && <span className="pc-override__control">{children}</span>}
      <span className={badgeClass}>{isOverridden ? 'override' : 'default'}</span>
      {showReset && (
        <button
          type="button"
          className="pc-override-reset"
          onClick={onReset}
          disabled={busy}
          aria-label={`Reset ${label} to default`}
        >
          {resetLabel}
        </button>
      )}
    </div>
  );
}
