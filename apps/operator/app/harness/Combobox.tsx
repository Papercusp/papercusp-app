'use client';

/**
 * Searchable single-selects. TWO shapes live here, differing only in where the
 * search box sits — pick by what the CONTROL has to look like:
 *
 *   • `Combobox`     — the control IS the text box (this file's original, and
 *                      the default when nothing constrains the trigger).
 *   • `ComboboxMenu` — the control is a BUTTON you supply, and the search box
 *                      sits inside the dropped panel. For a trigger whose shape
 *                      is fixed by something else, e.g. the chat popup's mode
 *                      pill. See its own doc block for why it is a sibling
 *                      rather than a flag on `Combobox`.
 *
 * They share the option types, the row renderer, the cmdk filtering model, the
 * Popover portal and every `h-combobox__*` style, so the list itself cannot
 * drift between them.
 *
 * ── Combobox ──
 * A SEARCHABLE single-select whose control IS a text box.
 *
 * The visible control is the search input itself: click or tab into it and the
 * full list drops open; type and it filters. There is no separate "open the
 * panel, then find the search field inside it" step.
 *
 * Built for `hud-session-launcher-and-board-tabs-2026-07-26` P-003 (owner ask
 * 2026-07-26: "make the select plan and model selector search boxes that show
 * the full list if you focus it before typing into it and then filters as you
 * type") and reshaped to input-as-control per the owner's follow-up: "make the
 * search dropdowns show as a text box to type in with the default as just the
 * default text". Deliberately generic so P-004 (plan filter) and P-008 (effort
 * selector) reuse it rather than growing more bespoke pickers (D-002).
 *
 * "Default as just the default text": when the current `value` is `emptyValue`
 * (or matches nothing), the box renders EMPTY with `placeholder` showing — so
 * the default reads as placeholder text, not as a typed-in value.
 *
 * COMPOSITION — both halves are existing primitives, nothing hand-rolled:
 *   - `harness/Popover` anchors + portals the list and handles Escape/dismiss.
 *     It is used in ANCHOR mode (not trigger mode): a Trigger would toggle the
 *     panel shut every time the user clicked their own input to move the
 *     cursor, so open state is driven here from focus/typing/selection, and
 *     `keepOpenWithin` exempts the input from Radix's outside-dismiss.
 *     Portalling is load-bearing: the launcher sits inside horizontally
 *     scrolling HUD chrome, so an in-flow panel would be clipped by an
 *     ancestor's overflow.
 *   - `cmdk` (already a dependency, already used by CommandPalette) owns
 *     filtering, scoring and arrow-key navigation. Its `<Command>` root wraps
 *     BOTH the inline input and the portalled list; that is safe because cmdk
 *     scopes its item DOM queries to the List's own inner ref, not to the
 *     command root, so the list may live in a portal.
 *
 * P-006 (overflow cut off with no scrollbar) and P-007 (rich two-line rows
 * carrying a full timestamp) are properties of this component rather than
 * separate work: the list is its own bounded scroll container (clamped to the
 * room actually below the control), and `ComboboxOption.detail` renders a
 * second line.
 */
import { Command as CmdK } from 'cmdk';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';

export interface ComboboxOption {
  value: string;
  /**
   * Primary line. Plain text (not ReactNode) because it doubles as what the
   * text box displays when this option is selected, and as the text cmdk
   * scores the search against.
   */
  label: string;
  /** Optional second line under the label — e.g. a full updated timestamp. */
  detail?: ReactNode;
  /** Extra text folded into the search index but never rendered. */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxGroup {
  kind: 'group';
  /** Group heading, e.g. a harness slug. */
  label: string;
  options: ComboboxOption[];
}

export type ComboboxEntry = ComboboxOption | ComboboxGroup;

export function isComboboxGroup(entry: ComboboxEntry): entry is ComboboxGroup {
  return (entry as { kind?: string }).kind === 'group';
}

/** Flatten groups away — exported for callers that need the selected option. */
export function flattenComboboxEntries(entries: ComboboxEntry[]): ComboboxOption[] {
  const out: ComboboxOption[] = [];
  for (const entry of entries) {
    if (isComboboxGroup(entry)) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

/**
 * The one row renderer both shapes share — `Combobox` (input-as-control) and
 * `ComboboxMenu` (trigger-as-control) differ in where the search box lives, not
 * in what a row looks like. Kept as a plain function rather than duplicated in
 * each so the two-line row, the search-key contract and the check indicator
 * cannot drift apart.
 */
function renderComboboxItem(
  opt: ComboboxOption,
  value: string | null,
  onSelect: (value: string) => void,
) {
  return (
    <CmdK.Item
      key={opt.value}
      // `value` is the option's own value, unique by construction — labels are
      // not (two plans can share a title), and duplicate cmdk values collapse
      // into one selectable row. The human-readable text rides along in
      // `keywords`, which cmdk scores equally.
      value={opt.value}
      keywords={[opt.label, ...(opt.keywords ?? [])]}
      disabled={opt.disabled}
      onSelect={() => onSelect(opt.value)}
      className="h-combobox__item"
    >
      <span className="h-combobox__item-copy">
        <span className="h-combobox__item-label">{opt.label}</span>
        {opt.detail != null && <span className="h-combobox__item-detail">{opt.detail}</span>}
      </span>
      {opt.value === value && (
        <Check size={11} className="h-combobox__item-check" aria-hidden="true" />
      )}
    </CmdK.Item>
  );
}

/** Groups + flat rows, in caller order. Shared by both shapes for the same
 *  reason as `renderComboboxItem`. */
function renderComboboxEntries(
  entries: ComboboxEntry[],
  value: string | null,
  onSelect: (value: string) => void,
) {
  return entries.map((entry, idx) =>
    isComboboxGroup(entry) ? (
      <CmdK.Group key={`grp-${idx}`} heading={entry.label} className="h-combobox__group">
        {entry.options.map((opt) => renderComboboxItem(opt, value, onSelect))}
      </CmdK.Group>
    ) : (
      renderComboboxItem(entry, value, onSelect)
    ),
  );
}

export interface ComboboxProps {
  /** Selected option value, or null when nothing is chosen. */
  value: string | null;
  onChange: (value: string) => void;
  options: ComboboxEntry[];
  /** Required — labels the text box AND the list for screen readers. */
  ariaLabel: string;
  /**
   * The default text. Shown as the input's PLACEHOLDER whenever no real
   * selection is active, so the default state reads as prompt text rather
   * than as something the user typed.
   */
  placeholder?: string;
  /**
   * The sentinel value meaning "nothing really chosen" (e.g. a
   * `__select_plan__` / `__default_model__` row that exists in the list so the
   * user can get back to it). While `value` equals this, the box shows the
   * placeholder instead of that row's label.
   */
  emptyValue?: string;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  testId?: string;
  /** Appended to the control's base class — never replaces it, so a caller
   *  passing only a width can't strip the control's appearance (the trap in
   *  `Select`'s replace-semantics). */
  triggerClassName?: string;
  /** Hard ceiling for the list in px. The panel also clamps itself to the
   *  space actually available below the control, whichever is smaller. */
  maxListHeight?: number;
  align?: 'start' | 'center' | 'end';
}

export function Combobox({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select…',
  emptyValue,
  emptyLabel = 'No matches',
  disabled,
  id,
  testId,
  triggerClassName,
  maxListHeight = 320,
  align = 'start',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  /**
   * What the user has typed since opening, or null when the box is simply
   * displaying the current selection. The null state is what lets a focus
   * show the FULL list while the box still reads as the chosen option.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => flattenComboboxEntries(options), [options]);
  const selected = useMemo(() => {
    if (value == null || (emptyValue != null && value === emptyValue)) return null;
    return flat.find((o) => o.value === value) ?? null;
  }, [flat, value, emptyValue]);

  const shown = draft ?? selected?.label ?? '';
  /**
   * Only filter once the user actually types. Otherwise focusing a box that
   * displays "Claude Opus" would filter the list down to Claude Opus — the
   * opposite of the requirement that focus reveals everything.
   */
  const shouldFilter = draft != null && draft.trim() !== '';

  const close = useCallback(() => {
    setOpen(false);
    setDraft(null);
  }, []);

  const select = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setOpen(false);
      setDraft(null);
    },
    [onChange],
  );

  return (
    <CmdK
      label={ariaLabel}
      loop
      shouldFilter={shouldFilter}
      className={`h-combobox${triggerClassName ? ` ${triggerClassName}` : ''}`}
      // cmdk handles ArrowUp/Down/Enter at its root; the inline input sits
      // inside that root, so navigation works even though the list is
      // portalled elsewhere in the DOM.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
          setOpen(true);
        }
      }}
    >
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        side="bottom"
        align={align}
        sideOffset={4}
        ariaLabel={ariaLabel}
        // Focus must STAY in the text box while the list is open — that is the
        // whole point of the input-as-control shape.
        autoFocusOnOpen={false}
        keepOpenWithin={boxRef}
        contentClassName="h-combobox__panel"
        contentStyle={{ ['--h-combobox-max-list' as string]: `${maxListHeight}px` }}
        anchor={
          <div className="h-combobox__box" ref={boxRef} data-open={open ? 'true' : undefined}>
            <CmdK.Input
              id={id}
              data-testid={testId}
              disabled={disabled}
              value={shown}
              onValueChange={(v) => {
                setDraft(v);
                if (!disabled) setOpen(true);
              }}
              onFocus={(e) => {
                if (disabled) return;
                setDraft(null);
                setOpen(true);
                // Select-all so the first keystroke replaces the shown
                // selection rather than appending to it.
                e.currentTarget.select();
              }}
              onMouseDown={() => {
                if (!disabled) setOpen(true);
              }}
              onBlur={close}
              placeholder={placeholder}
              className="h-combobox__input"
            />
            <ChevronDown size={11} aria-hidden="true" className="h-combobox__chevron" />
          </div>
        }
      >
        <CmdK.List className="h-combobox__list">
          <CmdK.Empty className="h-combobox__empty">{emptyLabel}</CmdK.Empty>
          {renderComboboxEntries(options, value, select)}
        </CmdK.List>
      </Popover>
    </CmdK>
  );
}

export interface ComboboxMenuProps {
  /** Selected option value, or null when nothing is chosen. */
  value: string | null;
  onChange: (value: string) => void;
  options: ComboboxEntry[];
  /** Required — labels the trigger, the panel and the search box. */
  ariaLabel: string;
  /**
   * The trigger's body. You own its shape entirely; this component supplies
   * only a `<button>` to hang it on, so a trigger that is NOT "selected text +
   * caret" stays one element rather than a button inside a button.
   */
  triggerChildren: ReactNode;
  triggerClassName?: string;
  /** Extra `data-*` for the trigger (styling hooks, test handles). Pass the
   *  full `data-…` name; an `undefined` value is dropped. */
  triggerData?: Record<string, string | undefined>;
  disabled?: boolean;
  id?: string;
  /** Trigger test id. The search box gets `<testId>-search`. */
  testId?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  /** Hard ceiling for the list in px; the panel also clamps to the room Radix
   *  measures below (or above) the trigger, whichever is smaller. */
  maxListHeight?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /**
   * Popper z-index. Raising it orders this menu above other poppers; LOWERING
   * it below the floor has no effect — `harness/Popover` clamps up to the LIVE
   * floor (`popperFloorZ()`: the shell floor, or above the topmost open modal),
   * because Radix copies the Content's z-index onto the position:fixed wrapper
   * inline and anything under the floor is painted behind the app shell — or
   * behind the modal — rather than merely "lower" (see harness/popper-z.ts).
   */
  zIndex?: number;
  /** Fired on open (`true`) and close (`false`) — the moment to lazily fetch
   *  an option set that is not a constant. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * ComboboxMenu — a SEARCHABLE single-select whose control is a BUTTON you
 * supply, with the search box inside the dropped panel.
 *
 * ── Why this is a sibling of `Combobox` and not a prop on it ──
 * `Combobox`'s control IS its text box: focus it and the list drops, type and
 * it filters, and the box doubles as the display of the current selection.
 * That shape is load-bearing there and is documented at the top of this file.
 *
 * It cannot serve a trigger whose shape is fixed by something else. The case
 * this exists for is the chat popup's mode pill — a filled cap carrying the
 * axis name (`GRADE`) plus its current value (`on ▾`) — which must keep that
 * shape because the shape IS the vocabulary (chat-controls.css: a mode and the
 * control that sets it are ONE thing). Inverting `Combobox` to serve it would
 * mean two focus models, two meanings for the input, and two open/close
 * regimes inside one component, on a component with five live callers.
 *
 * So the two shapes stay separate and share what is genuinely shared: the
 * option types, `renderComboboxItem`/`renderComboboxEntries`, the cmdk
 * filtering and keyboard model, the `harness/Popover` portal, and every
 * `h-combobox__*` style including the bounded-scroll list (P-006) and the
 * two-line row (P-007).
 *
 * COMPOSITION note — unlike `Combobox`, the cmdk root lives ENTIRELY inside the
 * panel (the standard Popover+Command arrangement). `Combobox` has to span the
 * root across both halves because its input sits outside the portal; here the
 * input is inside it, so the trigger stays outside cmdk's keyboard handling and
 * cannot have a keystroke on the closed pill resolve to selecting a row.
 */
export function ComboboxMenu({
  value,
  onChange,
  options,
  ariaLabel,
  triggerChildren,
  triggerClassName,
  triggerData,
  disabled,
  id,
  testId,
  searchPlaceholder = 'Search…',
  emptyLabel = 'No matches',
  maxListHeight = 320,
  side,
  align = 'start',
  /* No default: `undefined` lets harness/Popover apply the LIVE floor, which
     rises above an open modal. Defaulting to the static floor here pinned it to
     1500 and would have buried this menu inside a modal (WI-35969). */
  zIndex,
  onOpenChange,
}: ComboboxMenuProps) {
  const [open, setOpen] = useState(false);
  /** The search text. Unlike `Combobox`'s `draft` this is ONLY a query — it
   *  never doubles as the display of the selection, because the trigger shows
   *  that. It resets on close so a re-open always starts from the full list. */
  const [query, setQuery] = useState('');

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setQuery('');
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const select = useCallback(
    (optValue: string) => {
      onChange(optValue);
      handleOpenChange(false);
    },
    [onChange, handleOpenChange],
  );

  const triggerDataAttrs = Object.fromEntries(
    Object.entries(triggerData ?? {}).filter(([, v]) => v !== undefined),
  );

  /**
   * Put the caret in the search box when the panel opens, so "open it and
   * start typing" works — the whole point of the filter.
   *
   * React's `autoFocus` is NOT enough here, and this is a MEASURED correction
   * rather than a precaution. `autoFocus` fires during React's commit, but the
   * panel opens inside surfaces that run their own focus management afterwards
   * and win. Measured live in the isolated headless instance on 2026-08-03:
   * with `autoFocus` alone the menu opened correctly and filtered correctly,
   * but `document.activeElement` was the chat popup's own
   * `session-chat-conversation` container — the reader had to click the box
   * before typing.
   *
   * A jsdom test CANNOT catch this: in isolation nothing competes for focus, so
   * `autoFocus` "works" there and the assertion passes green while the real app
   * disagrees. Hence the rAF — it runs after the popover's mount-focus and any
   * ancestor focus manager have settled, instead of racing them.
   */
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      side={side}
      align={align}
      sideOffset={4}
      ariaLabel={ariaLabel}
      zIndex={zIndex}
      /* Radix's own auto-focus targets the CONTENT element, which would leave
         the first keystroke going nowhere. Suppressing it and letting the input
         claim focus on mount is what makes "open and type" work. */
      autoFocusOnOpen={false}
      contentClassName="h-combobox__panel h-combobox-menu__panel"
      contentStyle={{ ['--h-combobox-max-list' as string]: `${maxListHeight}px` }}
      trigger={
        <button
          type="button"
          id={id}
          disabled={disabled}
          data-testid={testId}
          className={triggerClassName}
          {...triggerDataAttrs}
        >
          {triggerChildren}
        </button>
      }
    >
      <CmdK
        label={ariaLabel}
        loop
        /* Only filter once something is typed — an empty query must show the
           FULL list, which is the whole point of the search box replacing a
           truncated one. */
        shouldFilter={query.trim() !== ''}
        className="h-combobox-menu"
      >
        <div className="h-combobox-menu__search">
          <Search size={11} aria-hidden="true" className="h-combobox-menu__search-icon" />
          <CmdK.Input
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            data-testid={testId ? `${testId}-search` : undefined}
            className="h-combobox-menu__input"
          />
        </div>
        <CmdK.List className="h-combobox__list">
          <CmdK.Empty className="h-combobox__empty">{emptyLabel}</CmdK.Empty>
          {renderComboboxEntries(options, value, select)}
        </CmdK.List>
      </CmdK>
    </Popover>
  );
}
