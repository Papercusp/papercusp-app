/**
 * Posture modes — the autonomy axis (manual/auto/cold-auto) and the three
 * stackable overlays (ideate/drain/grade) as FOUR ChatModeActions writing
 * mode:set { ownerDirected: true }
 * (gui-chat-session-controls-2026-07-25 P-004, reshaped by
 * session-chat-popup-direction-d-2026-08-02 P-005).
 *
 * P-005 changed the SHAPE, not the writes. These were two ChatActions —
 * buttons labelled `Autonomy` and `Overlays` that opened a card and reported
 * nothing about the current state, so the state had to appear elsewhere as a
 * read-only chip. One concept, two objects, two places, neither admitting it
 * was the other: that is the confusion the owner reported. As mode-actions
 * they report AND set, so each is one pill.
 *
 * Labels/hints come from the mode registry
 * (packages/operator-core/lib/modes/registry — the SAME source mode:set /
 * mode:get / the HUD chips already read) so no new copy drifts from it.
 *
 * Both actions post through the admin proxy route
 * (packages/operator-core/lib/endpoint-route/routes/admin/mode.ts, P-003) —
 * the browser has no bearer token, so the route re-dispatches into mode:set
 * in-process with a verified owner-authority identity
 * (ident.ownerId === ADMIN_COORD_UI_OWNER), which is what lets this write
 * carry ownerDirected:true and arm the D-003 sticky guard.
 *
 * No live "what's currently set" read: both `run` implementations are
 * reconciling (they set every option's enabled state explicitly — the
 * unchecked/unselected ones included), so posting is safe and idempotent
 * regardless of prior state, and mode:set { enabled:false } is a no-op on
 * whichever mode wasn't already active. This avoids needing a mode:get round
 * trip just to pre-populate the card.
 */
import { z } from 'zod';
import { fetchSyncQuery } from '@papercusp/sync';
import { modeById, modeChipLabel } from '@papercusp/operator-core/lib/modes/registry';
import { registerChatModeAction } from './registry';
import type { ChatActionContext } from './types';

const AUTONOMY_IDS = ['manual', 'auto', 'cold-auto'] as const;
type AutonomyId = (typeof AUTONOMY_IDS)[number];

/**
 * The overlays whose value really is just on/off.
 *
 * `grade` USED to be in this list and is registered separately below (WI-7471):
 * turning grading on means naming a rubric, so its menu is `Off` + one row per
 * active rubric rather than `On`/`Off`. Leaving it here as well would register
 * the axis TWICE under the same id — so removing it from this array is part of
 * that change, not an unrelated tidy-up.
 *
 * `drain` left for the SAME reason (P-005): turning a drain on means saying what
 * it is scoped to, so its "on" carries a value too. One entry is not a
 * degenerate loop worth collapsing — it is the list of axes that genuinely are
 * plain booleans, and the next such overlay joins it here.
 */
const OVERLAY_IDS = ['ideate'] as const;
type OverlayId = (typeof OVERLAY_IDS)[number];

/** POST one mode:set write through the admin proxy route (P-003). Exported for tests. */
/**
 * Send the session's agent a request, the same way the composer under this bar
 * does — `coord:send` with `wake: 'required'`.
 *
 * Deliberately the SAME endpoint and the same wake level as
 * `sendToSessionOwner` in SessionChatModal rather than a second path: a menu row
 * that says "ask this agent" must reach the agent by the mechanism the reader
 * can see working three inches below it, or the two silently diverge and only
 * one of them wakes anybody.
 *
 * Exported for tests.
 */
export async function askAgent(agent: string, body: string): Promise<void> {
  const r = await fetch('/api/admin/coord/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: [agent],
      summary: body.length > 80 ? `${body.slice(0, 77)}…` : body,
      body,
      wake: 'required',
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`coord:send → ${r.status}: ${text.slice(0, 200)}`);
  }
}

export async function postModeSet(
  agent: string,
  mode: string,
  enabled: boolean,
  reason: string,
  /**
   * P-005 / D-002: scope instructions that must outlive their delivery.
   *
   * The three states are distinct on the wire and mean different things to
   * mode:set — OMITTED leaves any standing instruction alone (which is why this
   * is `undefined`, not `''`, for every caller that has nothing to say), `''`
   * explicitly clears it, and a string asserts it.
   */
  instructions?: string,
): Promise<void> {
  const r = await fetch('/api/admin/mode/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode,
      enabled,
      reason,
      agent,
      ownerDirected: true,
      ...(instructions === undefined ? {} : { instructions }),
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`mode:set(${mode}) → ${r.status}: ${text.slice(0, 200)}`);
  let parsed: { ok?: boolean; error?: string; stickyConflict?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* tolerate a non-JSON 200 — treated as success */
  }
  if (parsed.ok === false) {
    throw new Error(
      parsed.stickyConflict
        ? `mode:set(${mode}) refused — an owner-directed incumbent is already set; your change was delivered as a request instead`
        : `mode:set(${mode}) → ${parsed.error ?? 'unknown error'}`,
    );
  }
}

function ownerId(ctx: ChatActionContext): string {
  return ctx.sessionOwnerId;
}

/**
 * The standing modes currently registered on the session this chat is attached
 * to, read straight off `ctx`.
 *
 * The roster row types `modes` as `Array<HudMode | string>` — a bare string is
 * tolerated because federation and a mid-deploy SSE push both produce one — so
 * both shapes are normalised here. Exported for test.
 */
export function activeModes(ctx: ChatActionContext): Set<string> {
  const raw = ctx.modes;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const m of raw) {
    if (typeof m === 'string') {
      out.add(m);
    } else if (m && typeof m === 'object' && typeof (m as { mode?: unknown }).mode === 'string') {
      out.add((m as { mode: string }).mode);
    }
  }
  return out;
}

/* ── P-005: the four Mode pills ────────────────────────────────────────────
 * These REPLACE the previous `Autonomy` and `Overlays` buttons. Those were
 * verbs that opened a card, and said nothing about what was currently set —
 * so the current value had to be shown elsewhere as a read-only chip, which is
 * the AUTO-chip/Autonomy-button duplicate the owner reported. A pill reports
 * and sets, so each mode is now exactly one object on the surface.
 * ────────────────────────────────────────────────────────────────────────── */

registerChatModeAction({
  id: 'mode-autonomy',
  cap: 'AUTO',
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  current: (ctx) => {
    const modes = activeModes(ctx);
    // Order matters: cold-auto is the more specific of the two, and an agent
    // carrying both should read as the colder one rather than silently
    // reporting the warmer.
    if (modes.has('cold-auto')) {
      return { value: 'cold', optionId: 'cold-auto', on: true, title: modeById('cold-auto')?.oneLiner };
    }
    if (modes.has('auto')) {
      return { value: 'on', optionId: 'auto', on: true, title: modeById('auto')?.oneLiner };
    }
    return {
      value: 'off',
      optionId: 'manual',
      on: false,
      title: 'Confirm-before-acting posture — no standing autonomy mode is set',
    };
  },
  options: () =>
    AUTONOMY_IDS.map((id) => ({
      id,
      label: id === 'manual' ? 'Manual' : (modeById(id)?.title ?? modeChipLabel(id)),
      hint:
        id === 'manual'
          ? 'Confirm-before-acting posture — no standing autonomy mode'
          : modeById(id)?.oneLiner,
    })),
  set: async (ctx, optionId) => {
    const choice = optionId as AutonomyId;
    const reason = 'owner set autonomy posture from the chat control band';
    const agent = ownerId(ctx);
    // RECONCILE THE WHOLE AXIS, always. The previous implementation only
    // ENABLED the chosen mode, so switching auto → cold-auto left `auto`
    // standing as well and the agent carried two autonomy modes at once.
    // enabled:false is a no-op on whichever was not set, so setting every
    // option explicitly is both correct and safe with no prior-state read.
    await Promise.all(
      AUTONOMY_IDS.filter((id) => id !== 'manual').map((id) =>
        postModeSet(agent, id, id === choice, reason),
      ),
    );
  },
});

/**
 * The shape of one `rubrics.list` sync-query row.
 *
 * VERIFIED against the producer, not inherited (WI-7471): rubrics moved from a
 * standalone `harness_shared.rubrics` table to plans (`template:'rubric'`,
 * migration 353), so a field list copied from the pre-migration code could have
 * been quietly wrong. These four are what `rubrics.list`'s derived-read producer
 * actually projects today — packages/operator-core/lib/derived-reads/producers.ts.
 * Only the fields this module reads are declared.
 */
interface RubricListRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: 'proposed' | 'active' | 'retired';
}

/** The `off` row of the GRADE menu. Its id can never collide with a rubric id
 *  by accident, because rubric ids are slugs and this is compared first. */
const GRADE_OFF = 'off';

/* ── the one non-rubric row [owner 2026-08-03] ───────────────────────────────
 * "grade mode rubric selector should have a create rubric option if there are
 * no rubrics. If there are a lot rubrics too much to show that should be
 * handled gracefully."
 *
 * Two ends of one problem: the menu was only correct for the middle of the
 * range. With zero active rubrics it rendered `Off` alone — a menu whose only
 * option is "no", telling the reader nothing about how to get a rubric. With
 * forty it would have rendered forty rows inside a popup that is already
 * height-constrained.
 *
 * The TOO-MANY end is now handled where it belongs, in the control: the menu
 * scrolls and filters (`searchable` below), so every active rubric is listed
 * and the reader narrows it by typing. It used to be handled here instead, by
 * a `__more-rubrics` row reading "N more — ask this agent to choose" — removed
 * on the owner's follow-up the same day: "the grade mode popup should not offer
 * to ask the agent, it should just have a scroll and a search filter in the
 * dropdown." Truncating a list and then offering to delegate the reading of it
 * is a worse answer than simply showing the list.
 *
 * The ZERO end still needs a row, because no amount of scrolling or filtering
 * produces a rubric that does not exist. It resolves to ASKING THIS AGENT, and
 * that is not a cop-out — it is the only create path there is. Rubrics are
 * authored by agents through the `rubrics:*` tools; there is no owner-facing
 * rubric form anywhere in the app, and the `/rubrics` route was REMOVED from
 * the navbar in 2026-07 precisely because the live Vite operator never
 * registered it (ChromeShell.tsx:311). Linking a "create" affordance at a route
 * that 404s would be worse than the dead end it replaces. The composer three
 * inches below this menu wakes the agent, so the row does exactly what a reader
 * would otherwise type by hand.
 *
 * The id is `__`-prefixed so it can never collide with a rubric slug. */
const GRADE_CREATE = '__create-rubric';

/**
 * GRADE — the one overlay whose "on" carries a VALUE, so it does not fit the
 * plain on/off shape the other two share (WI-7471).
 *
 * [owner 2026-08-03] "I want the rubric picker back, add that to the grade
 * on/off toggle." The rubric picker used to be a separate `Grade session…`
 * button; WI-7439 removed it as a duplicate of this pill's on/off toggle, which
 * was right about the duplication and did lose the rubric CHOICE with it. It
 * comes back HERE rather than as a second button, which is what the owner asked
 * for and is also the better shape: a mode and the control that sets it are ONE
 * object (see types.ts), and "which rubric" is simply that mode's value.
 *
 * `options()` is async — the rubric set is fetched, lazily, when the menu opens.
 * `params()`-style fetching is the same pattern the deleted GradeAction used;
 * see types.ts's `options` doc for why this is async while `current()` is not.
 */
registerChatModeAction({
  id: 'mode-grade',
  cap: modeChipLabel('grade').toUpperCase(),
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  // PURE + sync, like every other axis: read straight off the roster row. The
  // pill reports WHETHER grading is on; the chosen rubric rides in the mode's
  // free-text reason (the same place the old GradeAction put it), which is not
  // part of the roster projection — so claiming to display it here would mean
  // displaying something this function cannot actually know.
  current: (ctx) => {
    const on = activeModes(ctx).has('grade');
    return { value: on ? 'on' : 'off', optionId: on ? undefined : GRADE_OFF, on, title: modeById('grade')?.oneLiner };
  },
  /* One row per ACTIVE rubric, and a workspace grows that set without limit —
     so the menu scrolls and filters rather than truncating. See `searchable` on
     ChatModeAction. */
  searchable: true,
  searchPlaceholder: 'Search rubrics…',
  options: async () => {
    const rows = await fetchSyncQuery<RubricListRow>({ queryName: 'rubrics.list', args: {} });
    // ACTIVE only: a proposed rubric is not yet something to grade against, and
    // a retired one is deliberately out of use.
    const active = rows.filter((r) => r.status === 'active');
    /* Alphabetical, not resolver order — the reader scans this list, and a set
       that reorders itself between two opens cannot be scanned. Still worth
       doing now that nothing is cut: order is what makes a long list usable
       even when all of it is present. */
    active.sort((a, b) => a.title.localeCompare(b.title));
    return [
      {
        id: GRADE_OFF,
        label: 'Off',
        // WI-6552 [owner 2026-07-27]: the picker EXPLAINS what grade mode is
        // rather than just naming the input. The owner met the old rubric list
        // with no idea what it would do — "something that comes up that
        // explains what grade mode is" — and a workspace can hold a dozen
        // active rubrics, so the bare list gave no clue what picking one
        // commits the agent to. The explanation survives the move onto the
        // pill; it just rides the menu's first row now instead of a card.
        hint: 'Grade mode asks this agent to score its own work against a rubric — a named checklist of criteria — and report the result, instead of just carrying on. Pick a rubric to turn it on.',
      },
      ...active.map((r) => ({ id: r.rubricId, label: r.title, hint: r.characteristic })),
      /* NOTHING to grade against. `Off` alone is a menu whose only option is
         "no" — it does not even tell the reader that rubrics are a thing the
         agent can make. */
      ...(active.length === 0
        ? [
            {
              id: GRADE_CREATE,
              label: 'Ask this agent to create one',
              hint: 'No rubrics exist yet. Rubrics are written by agents, so this sends this agent a request to draft one for the work it is doing and propose it for ratification.',
            },
          ]
        : []),
    ];
  },
  set: async (ctx, optionId) => {
    const agent = ownerId(ctx);
    if (optionId === GRADE_OFF) {
      await postModeSet(agent, 'grade', false, 'owner turned grade mode off from the chat control band');
      return;
    }
    /* This row does NOT touch grade mode — it asks the agent to do something,
       exactly as typing it into the composer below would. Kept distinct from
       the mode path on purpose: turning grade mode ON without a rubric is the
       WI-7471 defect (a mode set with no criteria, the rubric surviving only as
       free text in the reason), and it would be a regression to re-introduce it
       here under a friendlier label. */
    if (optionId === GRADE_CREATE) {
      await askAgent(
        agent,
        'Please create a rubric. There are no active rubrics in this workspace, so grade mode has nothing to score against. Draft one for the work you are doing now — name the characteristic it measures and its criteria — propose it for ratification, and tell me its id when it is in.',
      );
      return;
    }
    await postModeSet(
      agent,
      'grade',
      true,
      `owner selected rubric ${optionId} for grade mode from the chat control band`,
    );
  },
});

/* ── DRAIN — the second overlay whose "on" carries a value (P-005) ───────────
 * [owner 2026-08-09] "the drain mode should have an input box where you can
 * type in instructions for the drain… e.g. all bugs except the ones related to
 * the p2p features."
 *
 * A drain is a MISSION, not a switch: "drain the queue" is only half an
 * instruction without saying which queue. So this axis follows the GRADE
 * precedent rather than the plain On/Off loop below — same reason, one axis
 * later.
 *
 * The two ids are deliberately NOT 'on'/'off'.
 *
 * `current()` reports the display value 'on' when drain is running, and a plain
 * menu is a Radix Select, which does not fire onChange when you pick the row
 * that is already selected. An `on` row would therefore be DEAD exactly when
 * the owner most wants it — re-scoping a drain that is already running, which
 * is the case mode:set's upsert semantics exist to serve. Giving the row an id
 * that can never equal the current display value keeps it live in both states.
 * GRADE does the same thing (its `current` returns optionId undefined while on,
 * and no option is named 'on'); this is that pattern, stated.
 */
const DRAIN_ON = 'on-with-scope';
const DRAIN_OFF = 'off';

/** The text card's payload — LocalCardHost resolves a `text` presentation as
 *  `{ value }`. Narrow it here rather than casting at the call site. */
function cardText(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return (value as { value: string }).value.trim();
  }
  return '';
}

registerChatModeAction({
  id: 'mode-drain',
  cap: modeChipLabel('drain').toUpperCase(),
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  current: (ctx) => {
    const on = activeModes(ctx).has('drain');
    // optionId undefined while ON, so the Select's value matches no row — see
    // the id note above. While OFF it points at the real `Off` row, so that one
    // still carries its checkmark.
    return {
      value: on ? 'on' : 'off',
      optionId: on ? undefined : DRAIN_OFF,
      on,
      title: modeById('drain')?.oneLiner,
    };
  },
  options: () => [
    {
      id: DRAIN_ON,
      label: 'On…',
      hint: 'Set what this drain covers, then start it. Picking this while a drain is already running RE-SCOPES it.',
    },
    { id: DRAIN_OFF, label: 'Off', hint: 'Stop draining, and drop the standing scope instructions.' },
  ],
  /* The one genuinely new UI piece. Only the ON row collects anything: turning a
     drain OFF has nothing to ask. */
  params: (_ctx, optionId) =>
    optionId === DRAIN_ON
      ? {
          prompt:
            'What should this drain cover? Left empty, the agent drains everything actionable in its scope.',
          dataSchema: z.object({ value: z.string() }),
          presentation: {
            kind: 'text' as const,
            placeholder: 'e.g. all bugs except the ones related to the p2p features',
            // The owner's own example is a sentence, and real scopes carry
            // exclusions — this is not a one-word field.
            multiline: true,
          },
          allowDecline: true,
        }
      : null,
  set: async (ctx, optionId, value) => {
    const agent = ownerId(ctx);
    const enabled = optionId === DRAIN_ON;
    if (!enabled) {
      /* No `instructions` argument at all: mode:set retracts the standing fact
         on ANY disable, so passing one here would be saying the same thing
         twice — and the disable path is the one that must work even when it is
         some other surface doing the disabling. */
      await postModeSet(agent, 'drain', false, 'owner turned drain mode off from the chat control band');
      return;
    }
    const instructions = cardText(value);
    await postModeSet(
      agent,
      'drain',
      true,
      instructions
        ? 'owner started a scoped drain from the chat control band'
        : 'owner started an unscoped drain from the chat control band',
      /* Empty is sent EXPLICITLY, not omitted. Starting a drain with an empty
         box means "no scope", and must clear whatever a previous drain left
         standing — inheriting last week's exclusions in silence is the exact
         failure D-002 calls worse than none. */
      instructions,
    );
  },
});

for (const overlay of OVERLAY_IDS) {
  registerChatModeAction({
    id: `mode-${overlay}`,
    cap: modeChipLabel(overlay).toUpperCase(),
    group: 'posture',
    available: (ctx) => Boolean(ctx.sessionOwnerId),
    current: (ctx) => {
      const on = activeModes(ctx).has(overlay);
      return { value: on ? 'on' : 'off', on, title: modeById(overlay)?.oneLiner };
    },
    // Stackable overlays are independent booleans, so each pill offers only
    // its own two states — which is also why they are separate pills rather
    // than one multi-select: three independent switches read as three
    // switches, and the old single `Overlays` button hid all three behind a
    // name that named none of them.
    options: () => [
      { id: 'on', label: 'On', hint: modeById(overlay)?.oneLiner },
      { id: 'off', label: 'Off' },
    ],
    set: async (ctx, optionId) => {
      await postModeSet(
        ownerId(ctx),
        overlay,
        optionId === 'on',
        'owner set overlay modes from the chat control band',
      );
    },
  });
}
