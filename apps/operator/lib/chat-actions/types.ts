/**
 * ChatAction — the declarative unit behind the chat action bar
 * (gui-chat-session-controls-2026-07-25 P-002).
 *
 * Adding a new bottom-of-chat action (a posture toggle, the grade rubric
 * picker, resume/fork/focus, …) means registering ONE descriptor via
 * `registerChatAction` (lib/chat-actions/registry.ts) — the bar component
 * (ChatActionBar) never grows a per-action branch.
 *
 * Value collection reuses the SAME CardSpec / askUserLocal / LocalCardHost
 * plumbing the agent-initiated card path already uses
 * (apps/operator/app/_components/chat/LocalCardHost.tsx,
 * apps/operator/lib/chat-cards/ask-user-local.ts) — there is no second card
 * vocabulary (plan D-001). The distinction from an agent-initiated card: an
 * action-bar card resolves a LOCAL promise, and the action's `run` then
 * sends a directive to an agent that never asked — it does NOT resolve the
 * agent question-gate an agent-initiated `ctx.askUser` card would.
 */
import type { ReactNode } from 'react';
import type { CardSpec } from '@papercusp/agent-mcp';
// askUserLocal (lib/chat-cards/ask-user-local.ts) — the host every params()
// card is rendered through — is typed `TSchema extends ZodTypeAny`, not
// CardSpec's generic StandardSchemaV1 default; pin the same bound here so a
// params() CardSpec type-checks straight into askUserLocal without a cast.
import type { ZodTypeAny } from 'zod';

/**
 * Context handed to every hook on a ChatAction. Deliberately an open bag
 * beyond the two fields every action can rely on — concrete lanes (posture
 * P-004, grade P-005, session actions P-006, identity P-012) each need
 * different session/roster/mode-registry facts and shouldn't force a
 * registry-wide type change just to add one.
 */
export interface ChatActionContext {
  /** su ownerId of the agent session this chat is attached to. */
  sessionOwnerId: string;
  /** Friendly display label, when the caller has one. */
  ownerLabel?: string | null;
  /**
   * Whether the roster query that supplies this context has answered for the
   * target owner. Optional for callers that predate the distinction; those
   * callers retain each action's existing field-based availability rules.
   *
   * `loading` is intentionally different from `resolved-missing`: while the
   * query is in flight, an absent roster field is not evidence that the
   * control does not apply. The surface can show a disabled loading pill until
   * the query resolves and then either reveal the real value or remove it.
   */
  rosterReadState?: ChatRosterReadState;
  /** Lane-specific extension fields (session roster row, mode state, …). */
  [extra: string]: unknown;
}

/** The three honest answers to a roster read for the chat's target owner. */
export type ChatRosterReadState = 'loading' | 'resolved' | 'resolved-missing';

/** A lightweight confirm-before-run step — no payload collected. */
export interface ChatActionConfirm {
  /** Shown as the confirm card's prompt. */
  message: string;
  /** Label for the single "go ahead" option. Defaults to "Confirm". */
  confirmLabel?: string;
}

export interface ChatAction {
  /** Stable id — React key, and the confirm/params card's rough identity. */
  id: string;
  label: string;
  /**
   * A compact rendering of `label` for space-constrained surfaces.
   *
   * `label` stays the action's ONE true name — AgentInspectorModal renders it
   * verbatim, and the owner's 2026-07-27 ask was that the chat popup offer
   * "the same ones that show up in the turn history in the agents running
   * dropdown", so renaming the label itself would break the parity that ask
   * created. This is the narrow escape hatch instead: the chat action bar is
   * a single dense row that must also hold four mode pills, and
   * "Resume in new terminal" spends 22 characters saying what "Resume" plus
   * the ↻ icon already say in six.
   *
   * A surface using this MUST keep the full `label` as the accessible name,
   * so nothing is lost to a screen reader or a tooltip — only pixels.
   */
  shortLabel?: string;
  /** Optional icon element, rendered at whatever size the bar's CSS sets. */
  icon?: ReactNode;
  /** Actions sharing a `group` render as one cluster, in first-seen order. */
  group?: string;
  /** Whether this action is offered at all, given the current ctx. */
  available(ctx: ChatActionContext): boolean;
  /**
   * Optional value-collection step: return a CardSpec and the bar opens it
   * via `askUserLocal` (rendered by whichever LocalCardHost is mounted in
   * the tree) and awaits the response. Omit for a zero-param action (a
   * plain button click straight into `run`). Async because some actions
   * fetch their option set at click time (e.g. P-005's rubric picker reads
   * `rubrics:list` live).
   */
  params?(ctx: ChatActionContext): Promise<CardSpec<ZodTypeAny>>;
  /** Optional confirm-before-run step, after `params` resolves. */
  confirm?: ChatActionConfirm | ((ctx: ChatActionContext) => ChatActionConfirm | null | undefined);
  /**
   * Perform the action. `value` is the params card's submitted payload
   * (`undefined` when the action declares no `params`). The bar only calls
   * `run` after every declared params/confirm step ended in `submit`.
   */
  run(ctx: ChatActionContext, value: unknown): Promise<void> | void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The SECOND descriptor shape: a mode-action
 * (session-chat-popup-direction-d-2026-08-02 P-005, deck change #3).
 *
 * WHY A SECOND SHAPE RATHER THAN A FLAG ON ChatAction. A `ChatAction` is a
 * VERB: it has no state of its own, so the bar can render it as a button and
 * be done. A mode is not a verb — it is a value that is currently something,
 * and the control that changes it. Modelling that as a ChatAction is exactly
 * what produced the duplication the owner reported: the mode had to be shown
 * somewhere ELSE as a read-only chip (`AUTO` in the status row) while its
 * setter lived here as a button with an unrelated name (`Autonomy`), so one
 * concept wore two costumes in two places and neither said it was the other.
 *
 * A ChatModeAction reports AND sets, so it renders as ONE object — the
 * vocabulary's Mode pill: a filled cap carrying the axis name, its current
 * value beside it, and a caret saying a chooser opens. Being one object is the
 * entire fix; the pill shape is just how that is made visible.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One selectable value of a mode axis. */
export interface ChatModeOption {
  /** Stable id, passed back to `set`. */
  id: string;
  label: string;
  /** One-line explanation, shown under the label in the chooser. */
  hint?: string;
  /**
   * Render the row but refuse the pick — "present, correct, and not settable
   * from here" (hud-chat-owner-controls-2026-08-11 D-006 §A).
   *
   * This is a THIRD state, not loading and not error, and it exists because
   * OMITTING such a row is the worse lie. The forcing case: the ACCOUNT axis's
   * "default system account" is a value the owner named explicitly, yet a
   * `--account=default` session bypasses the inference gateway entirely and
   * cannot be re-pinned live — it must be respawned. Dropping the row would say
   * the option does not exist; offering it live would say a click applies it.
   * Neither is true, and neither resolves with time, so this must not be
   * modelled as a transient state.
   *
   * Say WHY in `hint` — a disabled row with no reason is just a dead end.
   */
  disabled?: boolean;
}

/** What a mode axis is set to right now. */
export interface ChatModeState {
  /** Short current value rendered beside the cap — "on", "off", "cold". */
  value: string;
  /**
   * Which `options()` entry `value` corresponds to, when the two differ.
   *
   * `value` is DISPLAY text and is deliberately terser than an option label —
   * the autonomy axis shows "on" for the option whose id is `auto` and "cold"
   * for `cold-auto`. The dropdown needs the id to put a checkmark on the row
   * that is actually in force, and deriving it by matching display text would
   * be a silent mis-highlight the moment either string changes.
   *
   * OPTIONAL on purpose: for an axis whose option ids already ARE its display
   * values (the stackable overlays, ids `on`/`off`), `value` is the id and
   * this adds nothing. Callers fall back to `value`. Making it required would
   * strand every existing fixture that builds a ChatModeState — the exact trap
   * `lint:required-field-strands` exists to catch.
   */
  optionId?: string;
  /**
   * Whether the axis is engaged. Drives the FORM (filled cap vs hollow), which
   * is what makes on/off legible in greyscale rather than by colour alone.
  */
  on: boolean;
  /**
   * The axis is waiting for the surface's source data. A loading state is
   * rendered as a disabled placeholder pill, never as a guessed value that a
   * reader could mistake for the resolved state.
   */
  loading?: boolean;
  /** Long explanation for the pill's tooltip. */
  title?: string;
}

export interface ChatModeAction {
  /** Stable id — React key and test handle. */
  id: string;
  /** The cap text: the axis's short name, e.g. "AUTO", "IDEATE". */
  cap: string;
  /** Mode-actions sharing a `group` render as one cluster, in first-seen order. */
  group?: string;
  /** Whether this axis is offered at all, given the current ctx. */
  available(ctx: ChatActionContext): boolean;
  /**
   * Read the current value out of `ctx`. PURE and synchronous on purpose: the
   * pill re-renders from whatever the surface already knows (the roster row's
   * `modes`), so it never costs a fetch and never shows a value that
   * disagrees with the rest of the surface.
   */
  current(ctx: ChatActionContext): ChatModeState;
  /**
   * The values this axis can be set to. MAY be async (WI-7471).
   *
   * Async because one axis's option set is not a constant: GRADE offers `Off`
   * plus one row per ACTIVE rubric, and the rubric set lives in the store, not
   * in this module. [owner 2026-08-03] "I want the rubric picker back, add that
   * to the grade on/off toggle."
   *
   * ── Why async here and NOT on `current()` ──
   * They look symmetric and are not. `current()` answers "what is this axis set
   * to", which the surface ALREADY knows from the roster row it rendered the
   * pill from — so it stays pure and sync, and the pill can never display a
   * value that disagrees with the rest of the popup. `options()` answers "what
   * COULD it be set to", which is a different question with a different source
   * and is only ever needed once the user opens the menu.
   *
   * That timing is the whole reason this is allowed to be async rather than
   * being fed in through `ctx`: the bar resolves it LAZILY, on menu open, so a
   * session popup that nobody grades pays nothing. Feeding the rubric list
   * through `ctx` would instead put a standing `rubrics.list` query on every
   * popup open — working directly against WI-6617 (cut queries-per-screen) to
   * serve a menu that is usually never opened.
   *
   * A sync implementation is still perfectly normal and is what the other three
   * axes do; the bar accepts either.
   */
  options(ctx: ChatActionContext): ChatModeOption[] | Promise<ChatModeOption[]>;
  /**
   * Render this axis's menu as a SEARCHABLE, scrolling list instead of a plain
   * one. Default false.
   *
   * The distinction it encodes is whether the option set is BOUNDED. AUTO and
   * the overlays offer two or three fixed states, where a search box is noise;
   * GRADE offers one row per active rubric, a set the workspace grows without
   * limit — so it is the axis that needs to scroll and filter. That is the same
   * property `options()` being async already tracks, but declared rather than
   * inferred: a sync axis could still be unbounded, and the surface should not
   * have to guess from the shape of a function.
   *
   * [owner 2026-08-03] "the grade mode popup should not offer to ask the agent,
   * it should just have a scroll and a search filter in the dropdown."
   */
  searchable?: boolean;
  /**
   * Placeholder for the search box, when `searchable`. Lives on the axis
   * because the axis is what knows its options are called "rubrics"; the bar
   * renders whatever it is handed and falls back to a generic prompt.
   */
  searchPlaceholder?: string;
  /**
   * Optional value-collection step, run AFTER an option is picked and BEFORE
   * `set` (session-chat-popup-timestamps-and-modes-2026-08-09 P-005).
   *
   * Return a CardSpec to collect a value for `optionId`, or null/undefined for
   * options that need none — so an axis can ask on `on` and stay silent on
   * `off`. The collected payload is handed to `set` as `value`; DECLINING the
   * card cancels the write entirely, exactly as declining a ChatAction's
   * `params` card cancels its run.
   *
   * ── Why a CARD and not an input inside the menu ──
   * Two reasons, and the second is decisive.
   *
   * Reuse: this is the SAME CardSpec / askUserLocal / LocalCardHost plumbing
   * `ChatAction.params` already uses three inches away (plan D-001, "there is
   * no second card vocabulary"). An inline text field in the pill's dropdown
   * would be a second, bespoke one.
   *
   * Mechanics: the plain menu is a Radix `Select`, which claims keystrokes for
   * typeahead — a text input inside it cannot reliably receive typing at all.
   * The searchable menu's box is a FILTER over existing options, not a value
   * collector; it has nothing to do with entering free text.
   *
   * This does NOT re-open what WI-7439/the 2026-08-02 note settled ("just make
   * it look like a standard drop down/up"). That was about the OPTION CHOOSER —
   * a value picker whose current value is already displayed, which is precisely
   * a <select> and had no business being a stack of cards. Collecting free text
   * after the pick is the other thing: a question that genuinely has no answer
   * until the human types one, which is what a card is for.
   */
  params?(
    ctx: ChatActionContext,
    optionId: string,
  ): CardSpec<ZodTypeAny> | null | undefined;
  /**
   * Apply a chosen option. `value` is the `params` card's submitted payload
   * (`undefined` when the axis declares no `params`, or none for this option).
   */
  set(ctx: ChatActionContext, optionId: string, value?: unknown): Promise<void> | void;
}
