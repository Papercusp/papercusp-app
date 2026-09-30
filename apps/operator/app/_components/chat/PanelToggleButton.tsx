'use client';

/**
 * PanelToggleButton — the ONE show/hide control for a popup side panel.
 *
 * ── The grammar it enforces ────────────────────────────────────────────────
 * The LABEL IS CONSTANT ("Orders", never "Hide orders")
 * [owner 2026-08-02, on the sessions popup: "dont add the hide when its
 * expanded just make the open/close arror more visible"]. The button names the
 * PANEL and a chevron carries the verb, so the hit target stops changing width
 * as it is pressed — a label that grows by five characters on click moves every
 * control beside it, and the reader's next click lands on the wrong one.
 *
 * THE CHEVRON TRACKS THE MOTION, NOT THE STATE. It points the way the panel's
 * inner edge travels when you press:
 *
 *              side='left'                    side='right'
 *   open    ‹ Orders   (closes leftward)    Activity ›  (closes rightward)
 *   closed    Orders › (opens rightward)  ‹ Activity    (opens leftward)
 *
 * which collapses to one invariant, and it is why this is a single component
 * rather than four call-site ternaries: A LEFT-POINTING CHEVRON ALWAYS LEADS
 * THE LABEL AND A RIGHT-POINTING ONE ALWAYS TRAILS IT. The glyph sits on the
 * side of the label the panel is about to move toward.
 *
 * `aria-pressed` + `aria-label` still spell the action out ("Hide agent
 * orders" / "Show agent orders") — a screen reader cannot see a chevron point,
 * so the constant visible label is not enough on its own. That is what
 * `describe` is for: the noun phrase, not a second copy of the verb.
 *
 * ── Why it is SHARED, not copied ───────────────────────────────────────────
 * [owner 2026-08-10] the goal popup should "mimic the design used in the
 * equivalent popup in the sessions tab for the hide and expand buttons". This
 * component was extracted for exactly that: five call sites in SessionChatModal
 * and, originally, five more in GoalDetailPanel — a copied ternary in each is
 * how the two popups drift apart on the first restyle of either. Same rule the
 * goal popup already follows for the rails themselves
 * (AgentOrders/AgentDossier/FleetPeersRail are imported verbatim, never forked)
 * and for `chat-controls.css`.
 *
 * ⚠ AS BUILT SINCE WI-38428 (2026-08-13) THE GOAL POPUP RENDERS NONE OF THESE.
 * Its directional toggle row was deliberately replaced by
 * `GoalPanelVisibilityMenu` — one grouped checkbox popover — so the five
 * goal-side call sites are gone and SessionChatModal is now the only consumer
 * of the button itself. GoalDetailPanel and that menu still import
 * PANEL_TOOLBAR_BUTTON_STYLE, which is what keeps the two toolbars matching.
 * Do NOT "restore" the goal toggles to make this docblock true again: the
 * popover is the later, deliberate design, and reinstating the row would
 * revert it.
 *
 * ⚠ The button carries `display: inline-flex` INLINE, matching what the
 * sessions popup shipped and the owner signed off on in the desktop shell.
 * chat-controls.css's own header records the WebKitGTK rail (a `<button>` there
 * ignores flex for VERTICAL CENTRING, so CSS-declared button shapes use an
 * inner span). Kept as-is deliberately: this component's job is to make the two
 * popups identical, and quietly re-laying-out the sessions popup's approved
 * toolbar is a different change from the one that was asked for.
 */
import type { CSSProperties } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** The panel-toggle chevron. Sized + weighted deliberately
 *  [owner 2026-08-02: "just make the open/close arrow more visible"]: the old
 *  control drew a typographic "‹"/"›" at the button's 11px font size, which all
 *  but disappeared next to the label. A real icon at 14px with a heavier stroke
 *  is the visible affordance, and it inherits the button's colour so it still
 *  reads as one control rather than a decoration beside one. */
export const PANEL_CHEVRON_SIZE = 14;
export const PANEL_CHEVRON_STROKE = 2.75;

/** The compact toolbar button both popups use — for these toggles and for the
 *  icon-only maximize/close controls that sit beside them. Exported so the
 *  neighbours match by construction rather than by two copies of four values. */
export const PANEL_TOOLBAR_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  padding: '4px 7px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

export interface PanelToggleButtonProps {
  /** The PANEL's name, and all the button ever says. Never a verb. */
  label: string;
  /** Which edge the panel opens from — decides which way the chevron points. */
  side: 'left' | 'right';
  /** Is the panel open right now? */
  open: boolean;
  onToggle: () => void;
  /** The noun phrase for the screen-reader label: "Hide {describe}" /
   *  "Show {describe}". Defaults to the lower-cased label, which is right for
   *  a one-word panel name and wrong for anything that needs an article
   *  ("the goal brief") or a fuller description ("plans and work items"). */
  describe?: string;
  'data-testid'?: string;
  /** Panel headers and collapsed edge strips share the same label/chevron. */
  placement?: 'toolbar' | 'panel' | 'edge';
  /** Merged OVER the shared toolbar style, for a surface that needs to nudge
   *  spacing. Prefer not passing it: divergence here is how the two popups
   *  start looking different again. */
  style?: CSSProperties;
}

export default function PanelToggleButton({
  label,
  side,
  open,
  onToggle,
  describe,
  'data-testid': testId,
  placement = 'toolbar',
  style,
}: PanelToggleButtonProps) {
  /* The whole rule, in one line — see the docblock's table. A left panel that
     is open closes leftward; a right panel that is closed opens leftward. */
  const pointsLeft = side === 'left' ? open : !open;
  const noun = describe ?? label.toLowerCase();
  return (
    <button
      type="button"
      className={`pc-button pc-panel-toggle pc-panel-toggle--${placement}`}
      onClick={onToggle}
      aria-pressed={open}
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} ${noun}`}
      data-testid={testId}
      style={placement === 'toolbar' ? { ...PANEL_TOOLBAR_BUTTON_STYLE, ...style } : style}
    >
      {pointsLeft ? (
        <ChevronLeft size={PANEL_CHEVRON_SIZE} strokeWidth={PANEL_CHEVRON_STROKE} aria-hidden="true" />
      ) : null}
      <span className="pc-panel-toggle__label">{label}</span>
      {pointsLeft ? null : (
        <ChevronRight size={PANEL_CHEVRON_SIZE} strokeWidth={PANEL_CHEVRON_STROKE} aria-hidden="true" />
      )}
    </button>
  );
}
