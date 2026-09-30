'use client';

/**
 * ChatActionBar — renders the ChatAction registry as a row of buttons
 * (gui-chat-session-controls-2026-07-25 P-002). Adding an action means
 * registering a descriptor (lib/chat-actions) — this component never grows
 * a per-action branch.
 *
 * Value collection: an action with `params` opens its CardSpec through
 * `askUserLocal` — rendered by whichever `<LocalCardHost/>` is mounted in
 * the same tree (SessionChatModal mounts one alongside this bar). A
 * `confirm` step (no payload) reuses the same plumbing via a synthetic
 * single-option card; declining (Skip) cancels the run.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { askUserLocal } from '@/lib/chat-cards/ask-user-local';
import { Tooltip } from '@/app/harness/Tooltip';
// Import the BARREL, not `chat-actions/registry` directly: the barrel's
// side-effect imports (`import './SessionActions'` etc.) are what REGISTER the
// concrete actions. Importing the registry module alone gets you a working
// `listChatActions` over an EMPTY registry — so the bar rendered `null` and the
// whole action bar was invisible in the app, while unit tests stayed green
// because they import the action modules directly. Keep this pointed at the
// barrel; the shorter-looking `/registry` path is the bug.
import { listChatActions, listChatModeActions } from '@/lib/chat-actions';
import type {
  ChatAction,
  ChatActionContext,
  ChatModeAction,
  ChatModeOption,
} from '@/lib/chat-actions/types';
import { Select } from '@/app/harness/Select';
import { ComboboxMenu } from '@/app/harness/Combobox';

/**
 * WI-6552: ceiling on a `params()` option-load before the bar gives up.
 *
 * This exists to guarantee the bar RECOVERS from a load that never settles —
 * not to enforce snappiness. Erroring out a load that would have succeeded is
 * a worse failure than making the user wait, because it turns a working
 * feature into a broken one.
 *
 * P-009 / D-003: DERIVED, not picked. The previous value was a bare 30_000
 * justified by "a cold `rubrics.list` can take far longer than a snappy budget
 * would allow" — but that observation was measuring WI-6559, where the sync
 * gate's deadline did not cover the queue wait, so a cold `rubrics.list` never
 * settled at all. That bug is fixed; the justification died with it. The real
 * post-fix numbers are nowhere near 30s: warm resolve 250ms, server 8.8ms, and
 * a 106-query desktop startup wave completes in ~2.9s at p50 395ms.
 *
 * What actually sets the floor is an ORDERING INVARIANT, not a latency budget.
 * The sync layer rejects a request that cannot get a gate slot at its
 * DEFAULT_REQUEST_TIMEOUT_MS (20s) with a real, specific message. This ceiling
 * must sit ABOVE that, or it fires first and replaces that message with an
 * opaque "timed out" — re-creating the very opacity WI-6559 was filed for.
 * 25s = the layer's 20s + 5s of headroom for the rejection to propagate and
 * render.
 *
 * Deliberately a LITERAL rather than `DEFAULT_REQUEST_TIMEOUT_MS + 5_000`:
 * importing that constant pulls the `@papercusp/sync` barrel into this module's
 * graph, and ~90 test files across the tree `vi.mock('@papercusp/sync')` with
 * hand-written factories. Any of them that transitively reaches this component
 * would fail with "No DEFAULT_REQUEST_TIMEOUT_MS export is defined on the mock"
 * — a tree-wide fixture break, in files this change never touched, to derive
 * one number. The ordering is instead enforced by the guard test in
 * ChatActionBar.test.tsx, which imports the real constant (it mocks no barrel),
 * so the invariant is still checked without the coupling.
 */
export const PARAMS_TIMEOUT_MS = 25_000;

/**
 * Reject with `message` if `p` has not settled within `ms`. The pending
 * promise is abandoned, not cancelled — there is nothing to cancel through
 * the ChatAction contract — but the BAR recovers, which is the point: a
 * never-settling `params()` otherwise pins the button aria-busy forever.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function confirmed(action: ChatAction, ctx: ChatActionContext): Promise<boolean> {
  const spec = typeof action.confirm === 'function' ? action.confirm(ctx) : action.confirm;
  if (!spec) return true;
  const r = await askUserLocal({
    prompt: spec.message,
    dataSchema: z.object({ picks: z.tuple([z.literal('confirm')]) }),
    presentation: {
      kind: 'radio',
      options: [{ id: 'confirm', label: spec.confirmLabel ?? 'Confirm', style: 'primary' }],
    },
    allowDecline: true,
  });
  return r.action === 'submit';
}

/**
 * P-003 replaced this component's inline styles with the shared control
 * VOCABULARY (`pc-ctl-*`, chat-controls.css, loaded by SessionChatModal).
 *
 * The inline styles existed because `.chat-action-bar-button` was emitted here
 * but defined in NO stylesheet in the repo, so the bar rendered as bare UA
 * buttons with the icon jammed against the label ("↻Resume in new terminal").
 * A real sheet now exists and every chat surface loads it, so the classes are
 * load-bearing rather than decorative — and being classes is the point: the
 * five shapes have to be declared in ONE place for "rounded means the system
 * is telling you something" to hold anywhere.
 *
 * The old classNames (`chat-action-bar`, `chat-action-bar-button`) are kept
 * alongside the new ones so existing tests and any external selector keep
 * working.
 */
interface GroupedActions {
  group: string;
  actions: ChatAction[];
}

function groupActions(actions: ChatAction[]): GroupedActions[] {
  const order: string[] = [];
  const byGroup = new Map<string, ChatAction[]>();
  for (const action of actions) {
    const g = action.group ?? '';
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g)!.push(action);
  }
  return order.map((group) => ({ group, actions: byGroup.get(group)! }));
}

export function ChatActionBar({ ctx }: { ctx: ChatActionContext }): ReactNode {
  const actions = useMemo(() => listChatActions(ctx), [ctx]);
  /** P-005: the mode axes, rendered as pills ahead of the verbs. */
  const modes = useMemo(() => listChatModeActions(ctx), [ctx]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * WI-7471: resolved option sets, keyed by mode id.
   *
   * A mode's `options()` may be async — GRADE's rows are one per ACTIVE rubric,
   * fetched from the store. Render cannot await, and calling an async
   * `options()` during render would re-fire the fetch on every re-render, so
   * resolved sets are cached here and populated on MENU OPEN (below). A sync
   * axis resolves in a microtask and is indistinguishable from immediate.
   */
  const [modeOptions, setModeOptions] = useState<Record<string, ChatModeOption[]>>({});
  /** Mode ids whose options are in flight — drives the menu's placeholder row. */
  const [optionsLoading, setOptionsLoading] = useState<Record<string, boolean>>({});
  /** WI-6552: last action that completed successfully — the success half of
   *  the feedback pair below. Cleared whenever another action starts. */
  const [done, setDone] = useState<string | null>(null);

  if (actions.length === 0 && modes.length === 0) return null;

  /**
   * Writes a mode pick chosen from the pill's own dropdown.
   *
   * [owner 2026-08-02] "I dont like how the options popup looks, just make
   * it look like a standard drop down/up." This used to route through
   * askUserLocal/LocalCardHost, which renders the option set as a stack of
   * full-width AskChoiceCard rows in the card slot ABOVE the composer — a
   * ~200px panel, detached from the pill that opened it, for what is a
   * two-to-three value switch. The pill already ends in a caret, and a caret
   * means "a menu opens HERE"; opening a card elsewhere broke that promise.
   *
   * Note this does not violate the prior plan's D-001 ("there is no second
   * card vocabulary"). That rule is about CARDS — a chooser that asks a
   * question and waits for an answer. A mode pill is not asking a question:
   * it is a value picker whose current value it already displays, which is
   * precisely a <select>. Using the design-system Select makes it the same
   * control as every other value picker on the surface, so the vocabulary got
   * smaller here, not larger.
   */
  /**
   * Resolve a mode's option set once, on first menu open (WI-7471).
   *
   * Bounded by the SAME `withTimeout` / `PARAMS_TIMEOUT_MS` the `params()` path
   * uses, and for the same reason spelled out on that constant: the fetch that
   * hangs here is `rubrics.list`, which is precisely the query WI-6552 caught
   * never settling. Unbounded, the menu would sit on its loading row forever
   * with no error — the worst of the two failures, because it looks like the
   * feature simply does not work.
   */
  const ensureOptions = (mode: ChatModeAction): void => {
    if (modeOptions[mode.id] || optionsLoading[mode.id]) return;
    let result: ChatModeOption[] | Promise<ChatModeOption[]>;
    try {
      result = mode.options(ctx);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    // A sync axis needs no loading state at all — settle it in place so the
    // menu opens fully populated rather than flashing a placeholder row.
    if (Array.isArray(result)) {
      setModeOptions((prev) => ({ ...prev, [mode.id]: result as ChatModeOption[] }));
      return;
    }
    setOptionsLoading((prev) => ({ ...prev, [mode.id]: true }));
    void withTimeout(
      result,
      PARAMS_TIMEOUT_MS,
      `${mode.cap} could not load its options in time — try again.`,
    )
      .then((opts) => setModeOptions((prev) => ({ ...prev, [mode.id]: opts })))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        // eslint-disable-next-line no-console
        console.warn(`[chat-action-bar] mode ${mode.id} options failed`, e);
      })
      .finally(() => setOptionsLoading((prev) => ({ ...prev, [mode.id]: false })));
  };

  const applyMode = async (mode: ChatModeAction, optionId: string): Promise<void> => {
    setError(null);
    setDone(null);
    setRunningId(mode.id);
    try {
      /* P-005: an axis may collect a value for the option just picked (DRAIN's
         scope instructions). Sync on purpose — unlike `options()`, this builds a
         spec from what the axis already knows and fetches nothing, so there is
         no hang to bound with `withTimeout`.

         Declining CANCELS the write. A half-applied "drain on, instructions
         abandoned" is the failure to avoid: it is indistinguishable, from the
         agent's side, from an owner who meant an unscoped drain. */
      let value: unknown;
      const spec = mode.params?.(ctx, optionId);
      if (spec) {
        const r = await askUserLocal(spec);
        if (r.action !== 'submit') return;
        value = r.payload;
      }
      await mode.set(ctx, optionId, value);
      // The CACHE, not a fresh `options()` call: re-calling would re-fetch an
      // async axis purely to render a confirmation string, and the cache is
      // guaranteed populated — this only runs after a pick from that menu.
      const options = modeOptions[mode.id] ?? [];
      setDone(`${mode.cap} → ${options.find((o) => o.id === optionId)?.label ?? optionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.warn(`[chat-action-bar] mode ${mode.id} failed`, e);
    } finally {
      setRunningId(null);
    }
  };

  const invoke = async (action: ChatAction): Promise<void> => {
    setError(null);
    setDone(null);
    setRunningId(action.id);
    try {
      if (!(await confirmed(action, ctx))) return;
      let value: unknown;
      if (action.params) {
        // WI-6552: `params()` may hang rather than settle — Grade's fetches
        // `rubrics.list` through the sync layer's in-flight gate, which can
        // queue behind a page's other queries and never resolve OR reject.
        // Awaiting it unbounded leaves this button aria-busy + disabled with
        // NO card and NO error: a permanently dead action bar, which is the
        // same "nothing happened" the owner reported, in its worst form.
        // Bound it so the failure is at least legible and the bar recovers.
        const spec = await withTimeout(
          action.params(ctx),
          PARAMS_TIMEOUT_MS,
          `${action.label} could not load its options in time — try again.`,
        );
        const r = await askUserLocal(spec);
        if (r.action !== 'submit') return;
        value = r.payload;
      }
      await action.run(ctx, value);
      // WI-6552 [owner 2026-07-27, verbatim] "I also selected one of the
      // rubrics and nothing happaned." It very likely DID happen: single-select
      // cards commit on click and `run` posts the directive, but this bar only
      // ever rendered feedback in the CATCH below — a fully successful action
      // returned in complete silence, which is indistinguishable from a dead
      // click. Acknowledge success too, so the two outcomes never look alike.
      setDone(action.label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.warn(`[chat-action-bar] ${action.id} failed`, e);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div
      className="chat-action-bar pc-ctl-band pc-ctl-band--do"
      role="toolbar"
      aria-label="Chat actions"
      data-testid="chat-action-bar"
    >
      {/* The zone cap — everything in this band changes THIS session, which is
          what separates it from the Fleet strip below (that one acts on
          something else entirely). Inline at the band's leading edge rather than
          a title row: the popup was just compacted from five rows to two, and a
          header row per zone would have spent that back.

          It is the band grid's FIRST COLUMN, not a flex item (WI-7456): see
          chat-controls.css §⑧. That is what stops a wrapped control line from
          restarting underneath it. */}
      <span className="pc-zone-cap">Controls</span>
      {/* ── The band's SECOND column: every control, in one box ──────────────
          [owner 2026-08-03] "the alignement on the bottom panel is still all
          mest up" (third time). This wrapper is the whole structural fix. The
          cap used to be just another flex item in the same wrapping strip as
          the controls, so when the strip wrapped, line 2 restarted at the
          band's padding — i.e. UNDERNEATH the cap, in the label gutter, while
          line 1's first control sat 49px to its right. Measured on WI-7456.
          Now the cap owns column 1 and every control lives in column 2, so a
          wrapped line cannot back into the gutter: there is no gutter to back
          into. ── */}
      <div className="pc-ctl-band__controls">
      {/* Modes first: they say what the agent IS, and the verbs below act on
          it. Reading order follows that dependency. */}
      {modes.map((mode) => {
        const state = mode.current(ctx);
        /* WI-7471: the option set is RESOLVED, not called here. An async
           `options()` invoked during render would re-fetch on every
           re-render; `ensureOptions` fetches once, on open. */
        const resolvedOptions =
          modeOptions[mode.id] ??
          (optionsLoading[mode.id] ? [{ id: '__loading__', label: 'Loading…' }] : []);
        /* `optionId` when the axis distinguishes it from display text
           (autonomy shows "on" for the option `auto`); the overlays'
           option ids already ARE their display values, so `value` is the
           id there and the fallback is exact, not approximate. */
        const value = state.loading ? '__loading__' : state.optionId ?? state.value;
        const displayValue = state.loading ? 'Loading…' : state.value;
        const ariaLabel = state.loading
          ? `${mode.cap} is loading${state.title ? ` — ${state.title}` : ''}.`
          : `${mode.cap} is ${state.value}${state.title ? ` — ${state.title}` : ''}. Change it.`;
        const triggerClassName = `pc-ctl-mode${state.on ? '' : ' pc-ctl-mode--off'}`;
        /* Hoisted so BOTH menu shapes hang the identical pill off themselves.
           The pill is a two-part object — a filled cap carrying the axis name
           plus its current value — and the shape IS the vocabulary
           (chat-controls.css: a mode and the control that sets it are ONE
           thing), so which control opens the menu must not change how the pill
           reads. */
        const triggerChildren = (
          <span className="pc-ctl-mode__inner">
            <span className="pc-ctl-mode__cap">{mode.cap}</span>
            <span className="pc-ctl-mode__value">
              {displayValue}
              <span aria-hidden="true">▾</span>
            </span>
          </span>
        );
        // A placeholder row must not be pickable — selecting it would post
        // `__loading__` as a real value.
        const isPlaceholder = (id: string) => id === '__loading__';

        /* An axis whose option set is UNBOUNDED gets the searchable, scrolling
           menu; a two- or three-state axis gets the plain one, where a search
           box would be noise. See `searchable` on ChatModeAction. */
        if (mode.searchable) {
          return (
            <ComboboxMenu
              key={mode.id}
              value={value}
              onChange={(optionId) => void applyMode(mode, optionId)}
              disabled={runningId !== null || state.loading === true}
              onOpenChange={(open) => {
                if (open && !state.loading) ensureOptions(mode);
              }}
              options={resolvedOptions.map((o) => ({
                value: o.id,
                /* `label` is plain text here by contract — it is both what the
                   row shows and what cmdk scores. The hint becomes the second
                   line AND a search key, so typing a rubric's characteristic
                   finds it, not just its title. */
                label: o.label,
                detail: o.hint,
                keywords: o.hint ? [o.hint] : undefined,
                /* Two different un-pickables, both refused here: the transient
                   loading placeholder, and D-006 §A's PERMANENT "present but
                   not settable from this surface" row (the axis declares it —
                   see ChatModeOption.disabled). */
                disabled: isPlaceholder(o.id) || o.disabled === true,
              }))}
              testId={`chat-mode-${mode.id}`}
              triggerData={{ 'data-on': state.on ? 'true' : 'false' }}
              triggerClassName={triggerClassName}
              triggerChildren={triggerChildren}
              /* The band sits at the BOTTOM of the popup, so the menu's natural
                 home is above it. Radix still flips when there is no room. */
              side="top"
              align="start"
              ariaLabel={ariaLabel}
              searchPlaceholder={mode.searchPlaceholder}
            />
          );
        }

        return (
          <Select
            key={mode.id}
            value={value}
            onChange={(optionId) => void applyMode(mode, optionId)}
            disabled={runningId !== null || state.loading === true}
            onOpenChange={(open) => {
              if (open && !state.loading) ensureOptions(mode);
            }}
            options={resolvedOptions.map((o) => ({
              value: o.id,
              // Same two un-pickables as the searchable menu above.
              disabled: isPlaceholder(o.id) || o.disabled === true,
              label: o.hint ? (
                <span className="pc-ctl-mode-opt">
                  <span className="pc-ctl-mode-opt__label">{o.label}</span>
                  <span className="pc-ctl-mode-opt__hint">{o.hint}</span>
                </span>
              ) : (
                o.label
              ),
            }))}
            testId={`chat-mode-${mode.id}`}
            triggerData={{ 'data-on': state.on ? 'true' : 'false' }}
            triggerClassName={triggerClassName}
            /* The band sits at the BOTTOM of the popup, so the menu's natural
               home is above it — hence the owner's "drop down/up". Radix still
               flips to `bottom` on its own when the pill is high enough that
               there is no room above, so this is a preference, not a pin. */
            side="top"
            align="start"
            ariaLabel={ariaLabel}
            triggerChildren={triggerChildren}
          />
        );
      })}
      {modes.length > 0 && actions.length > 0 ? (
        <span className="pc-ctl-band__sep" aria-hidden="true" />
      ) : null}
      {groupActions(actions).map(({ group, actions: groupItems }) => (
        <div className="chat-action-bar-group" key={group || '_'} data-group={group || undefined}>
          {groupItems.map((action) => (
            /* The FULL label stays the accessible name AND the tooltip even when
               the button renders the short one, so compaction costs pixels and
               nothing else. The tooltip is the shared Radix primitive, not a bare
               `title=` — that attribute is invisible to keyboard and touch users
               and is rejected by the design-primitive lint (WI-6143). Trigger
               asChild keeps the DOM element identical. */
            <Tooltip key={action.id} label={action.label}>
              <button
                type="button"
                className="chat-action-bar-button pc-ctl-act"
                data-testid={`chat-action-${action.id}`}
                onClick={() => void invoke(action)}
                disabled={runningId !== null}
                aria-busy={runningId === action.id}
                aria-label={action.label}
              >
                <span className="pc-ctl-act__inner">
                  {action.icon ? <span className="pc-ctl-act__icon">{action.icon}</span> : null}
                  <span>{action.shortLabel ?? action.label}</span>
                </span>
              </button>
            </Tooltip>
          ))}
        </div>
      ))}
      {error && (
        <div className="chat-action-bar-error" role="alert">
          {error}
        </div>
      )}
      {!error && done && (
        <div className="chat-action-bar-done" role="status" data-testid="chat-action-bar-done">
          ✓ {done} applied
        </div>
      )}
      </div>
    </div>
  );
}
