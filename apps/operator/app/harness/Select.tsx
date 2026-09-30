"use client";

import * as RS from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { usePopperZ } from "./popper-z";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Group wrapper around a sub-list of `SelectOption`s. Mix freely with
 * flat `SelectOption`s in the same `options` array — the wrapper
 * decides which are which by the discriminant `kind` field. Added per
 * `plans-newbutton-and-subharness-scope-2026-05-25` P-026 so the
 * /adv/sessions "Start from plan context" picker can group plans by
 * their resolved harness.
 */
export interface SelectGroup {
  kind: "group";
  /** Group heading, e.g. the harness slug. */
  label: ReactNode;
  options: SelectOption[];
}

export type SelectEntry = SelectOption | SelectGroup;

const GROUP_LABEL_STYLE: CSSProperties = {
  padding: "6px 8px 2px",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  color: "color-mix(in oklab, var(--fg, #e7f7ff), transparent 38%)",
};

function isGroup(entry: SelectEntry): entry is SelectGroup {
  return (entry as { kind?: string }).kind === "group";
}

const TRIGGER_DEFAULT_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "var(--bg-2)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
};

const DEFAULT_TRIGGER_CLASS = "h-select-trigger";

const CONTENT_STYLE: CSSProperties = {
  boxSizing: "border-box",
  background: "color-mix(in srgb, var(--bg-deeper), transparent 2%)",
  color: "var(--fg)",
  border: "1px solid color-mix(in oklab, var(--accent), transparent 62%)",
  borderRadius: 10,
  padding: 6,
  /* THIS number is what actually decides whether the menu is reachable, and it
     has to clear the whole app shell — `<main>` is 70, `.oracle-dock` 80, and
     `.oracle-dock--maximal-hud` 1450.
     MEASURED (P-006): Radix's Popper reads this Content's computed z-index at
     mount and copies it onto `[data-radix-popper-content-wrapper]` as an INLINE
     style. The wrapper is `position: fixed`, so it establishes its own stacking
     context and that inline value is the one that competes with the shell — it
     also beats any CSS rule targeting the wrapper (inline wins without
     `!important`). At the old value of 70 the wrapper tied with `<main>` and
     every menu painted behind the app: mounted, positioned, opacity 1, and
     completely unclickable. The harness.css wrapper rule is the FLOOR for
     poppers that set no content z-index at all; this is the one that governs
     Select. Guarded by `_lints/popper-stacking.test.ts`.
     NOT set here: the floor also RISES above any open modal (WI-35969), so it
     is not a constant — `usePopperZ()` supplies it per render in the component
     below, and a literal here would be an inert value that reads as if it were
     the one in force. */
  boxShadow:
    "0 18px 54px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)",
  fontSize: 12,
  minWidth: "var(--radix-select-trigger-width)",
  backdropFilter: "blur(14px) saturate(150%)",
  /* Bound the WHOLE popper, not only its scrolling viewport. The content shell
     adds 6px padding + a 1px border on every side; constraining only Viewport
     lets that 14px of chrome escape Radix's collision boundary at short window
     heights. 434px preserves the 420px desktop viewport cap plus that chrome. */
  maxHeight: "min(434px, var(--radix-select-content-available-height))",
  overflow: "hidden",
};

/**
 * Keep long menus inside Radix's measured collision boundary. CONTENT_STYLE
 * bounds the whole shell (including border + padding); the viewport still owns
 * scrolling so keyboard navigation and the optional Radix scroll buttons keep
 * observing the same scroll container. The fixed cap keeps a menu from taking
 * over a tall desktop window, while the parent's flex layout shrinks it below
 * 420px when the total-content collision bound is tighter.
 */
const VIEWPORT_STYLE: CSSProperties = {
  maxHeight: 420,
  overflowY: "auto",
  overscrollBehavior: "contain",
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 8px",
  borderRadius: 3,
  outline: "none",
  cursor: "pointer",
};

/**
 * Select — Radix Select wrapper that mirrors the visual of the harness's
 * native <select> elements (dark theme, terse). Replaces:
 *   <select value={x} onChange={(e) => setX(e.target.value)}>
 *     <option value="a">A</option>
 *   </select>
 *
 * with:
 *   <Select value={x} onChange={setX} options={[{value:'a', label:'A'}]} />
 *
 * Trigger and Content can be restyled via `triggerStyle` / `contentStyle`,
 * or passed `className` for full CSS override.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  id,
  ariaLabel,
  describedBy,
  disabled,
  testId,
  triggerStyle,
  contentStyle,
  className,
  triggerClassName,
  triggerChildren,
  side,
  align,
  triggerData,
  onOpenChange,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectEntry[];
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  /** Forwarded as aria-describedby on the trigger, for pairing with a nearby hint. */
  describedBy?: string;
  disabled?: boolean;
  testId?: string;
  triggerStyle?: CSSProperties;
  contentStyle?: CSSProperties;
  className?: string;
  triggerClassName?: string;
  /**
   * Replaces the default `<Value/> + <Icon/>` trigger body with your own
   * markup, for a trigger whose shape is NOT "selected text + caret".
   *
   * The case this exists for is the chat popup's mode pill, which is a
   * two-part object — a filled cap carrying the axis name (`AUTO`) plus its
   * current value (`on ▾`) — and which must keep that shape because the
   * shape IS the vocabulary (chat-controls.css: a mode and the control that
   * sets it are ONE thing). Wrapping the pill in a separate trigger would put
   * a button inside a button; supplying the body keeps one element.
   *
   * You own the caret when you pass this — the default `<Icon/>` is not
   * rendered, since a custom trigger usually places its own.
   */
  triggerChildren?: ReactNode;
  /** Preferred side to open on. Radix still flips when there is no room. */
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /**
   * Extra `data-*` attributes for the trigger, for state a caller needs to
   * read off the element (styling hooks, test handles). Keys are used exactly
   * as given, so pass the full `data-…` name. An `undefined` value is dropped
   * rather than rendered as the string "undefined".
   */
  triggerData?: Record<string, string | undefined>;
  /**
   * Fired when the menu opens (`true`) and closes (`false`).
   *
   * Added for the chat popup's GRADE pill (WI-7471), whose option set is one
   * row per active rubric and therefore has to be FETCHED. Opening is the
   * moment that fetch becomes worth paying for: a caller can load its options
   * lazily here instead of eagerly on mount, so a surface where the menu is
   * never opened costs nothing.
   *
   * Deliberately a notification, not control: `RS.Root` stays UNCONTROLLED, so
   * a caller that only wants the signal cannot accidentally break opening by
   * forgetting to feed `open` back.
   */
  onOpenChange?: (open: boolean) => void;
}) {
  /* The popper floor, live. `RS.Root` is UNCONTROLLED (see onOpenChange above),
     so opening the menu does NOT re-render this component — the style object
     Radix mounts is whatever the LAST render produced. `usePopperZ` subscribes
     to the open-modal registry so that render happens when a modal opens, not
     when the menu does; Radix reads the z once at Content mount and can never
     be corrected afterwards (WI-35969). */
  const popperZ = usePopperZ(undefined);
  const triggerDataAttrs = Object.fromEntries(
    Object.entries(triggerData ?? {}).filter(([, v]) => v !== undefined),
  );
  return (
    <RS.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      onOpenChange={onOpenChange}
    >
      <RS.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        data-testid={testId}
        {...triggerDataAttrs}
        className={triggerClassName ?? className ?? DEFAULT_TRIGGER_CLASS}
        style={
          triggerClassName || className
            ? undefined
            : { ...TRIGGER_DEFAULT_STYLE, ...triggerStyle }
        }
      >
        {triggerChildren ?? (
          <>
            <RS.Value placeholder={placeholder} />
            <RS.Icon>
              <ChevronDown size={11} />
            </RS.Icon>
          </>
        )}
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          data-anim="pop"
          position="popper"
          side={side}
          align={align}
          sideOffset={4}
          style={{ ...CONTENT_STYLE, zIndex: popperZ, ...contentStyle }}
        >
          <RS.Viewport style={VIEWPORT_STYLE}>
            {/* Radix throws ("must have a value prop that is not an empty
                string") if any Item value is '', taking the whole subtree
                down with it. Drop empty-value options defensively so a bad
                caller can't crash the page — an empty value isn't selectable
                anyway (the empty string is reserved for "no selection"). */}
            {options.map((entry, idx) =>
              isGroup(entry) ? (
                <RS.Group key={`grp-${idx}`}>
                  <RS.Label style={GROUP_LABEL_STYLE}>{entry.label}</RS.Label>
                  {entry.options
                    .filter((opt) => opt.value !== "")
                    .map((opt) => (
                      <RS.Item
                        key={opt.value}
                        value={opt.value}
                        disabled={opt.disabled}
                        style={ITEM_STYLE}
                        className="h-select-item"
                      >
                        <RS.ItemText>{opt.label}</RS.ItemText>
                        <RS.ItemIndicator>
                          <Check size={11} />
                        </RS.ItemIndicator>
                      </RS.Item>
                    ))}
                </RS.Group>
              ) : entry.value === "" ? null : (
                <RS.Item
                  key={entry.value}
                  value={entry.value}
                  disabled={entry.disabled}
                  style={ITEM_STYLE}
                  className="h-select-item"
                >
                  <RS.ItemText>{entry.label}</RS.ItemText>
                  <RS.ItemIndicator>
                    <Check size={11} />
                  </RS.ItemIndicator>
                </RS.Item>
              ),
            )}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
