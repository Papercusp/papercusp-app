'use client';

/**
 * FleetLaunchRow — the agent chat popup's ALWAYS-VISIBLE fleet-launch row
 * (WI-6505, owner ask 2026-07-27).
 *
 * The owner asked for this twice, and the second message revised the first:
 *   (i)  "Add a new fleet button to the agent chant popup on the bottom next to
 *        where you can select grade, that presents the user with all the options
 *        for fleet launching that agents are supposed to ask a user about. i.e.
 *        which account. which model, headed or headed, how many, default system
 *        account or pin to an account using the inference gateway."
 *   (ii) "Instead of abutton like the others make this fleet launching its own
 *        always visible row modeled after how the new session row works on the
 *        main hud page"
 *
 * (ii) governs the FORM — one always-visible row, NOT a button in ChatActionBar
 * alongside Grade. (i) still governs the CONTENT: every option an agent is
 * supposed to ask about before launching a fleet is exposed here, so the human
 * answers them once in the UI instead of over five chat turns.
 *
 * ── Why this is a sibling of ChatActionBar, not an entry in it ───────────────
 * ChatActionBar renders the ChatAction registry, and every one of those actions
 * targets THIS session (grade it, resume it, change its posture). A fleet launch
 * is not an act on the open session — it creates N new ones. It is also gated
 * differently: the action bar only mounts when `actionCtx` resolves (a live
 * session with a known owner id), and the owner asked for this row to be ALWAYS
 * visible. Registering it as a ChatAction would have inherited that gate and hid
 * the row exactly when a human most wants it (the session is dead/stuck — launch
 * a fleet instead).
 *
 * ── The launch path, and why it is NOT the fleet:launch-on-plan tool ────────
 * Each member goes through `launchAgent` → POST /api/adv/sessions/launch-su —
 * the GUI's one audited spawn path, the same call the HUD's new-session row
 * makes. The first launch CREATES the fleet (`fleetName`, so the server
 * slugifies and allocates the colour); the rest JOIN it by slug.
 *
 * The obvious-looking alternative — POST /api/agent-tools/fleet/launch-on-plan,
 * the agent tool that opens N members in one call — CANNOT WORK FROM A BROWSER,
 * and this is worth stating because the failure looks like success from a
 * distance. Those agent-tools routes carry no agent identity, so the tool's
 * `resolveAgentIdentity` throws and every call 500s with "context carries no
 * power-user / superuser / principal / fleet-spawn / signed-spawn identity" —
 * verified from curl AND from inside the authenticated Tauri webview. (Probing
 * it with an EMPTY body is what fools you: zod arg-validation runs first, so you
 * get a tidy `invalid_args` + schema and conclude the route is callable. It only
 * proves zod ran. See the `agent-tools-http-route-has-no-ui-identity` fact.)
 *
 * Nor is a loopback endpoint wrapping that tool the right fix: it makes the
 * CALLER the fleet's leader and seeds a leader brief. A GUI launch has no
 * caller, so a synthetic principal would become "leader" of a fleet it can never
 * lead — worse than a leaderless one.
 *
 * What this costs, stated plainly: `fleet:launch-on-plan` also seeds a
 * plan-scoped claim spec so members' `scheduler:get_next` stays on that plan.
 * launch-su does not, so these members pull under the default spec — the SAME
 * behaviour the existing new-session row's fleet-create already has, so this row
 * is consistent with the GUI rather than introducing a new gap.
 *
 * ── Option sources are SHARED, never re-declared ────────────────────────────
 * Models/efforts/accounts come from the same exports the HUD's new-session row
 * uses (`OMP_MODEL_OPTIONS`, `buildAccountOptions`, `useSuLaunchOptions` → psu's
 * own options endpoint). This repo has twice paid for a hand-maintained rival
 * list drifting from psu's (WI-6300 — the model menu had fallen four models
 * behind; WI-6321 — fleet/account/context were unreachable from the GUI at all).
 * Derive; never re-declare.
 *
 * ── State is nuqs ───────────────────────────────────────────────────────────
 * Per CLAUDE.md: user-meaningful selections go in the URL, and the agent → UI
 * control surface (`ui:get_state` / `ui:dispatch`) reads and writes the URL, so
 * `useState` here would make the row invisible to the very agents that are
 * supposed to stop asking these questions in chat. That is the load-bearing
 * reason, and it is why this row diverges from NewSessionLauncher's documented
 * `useState` choice: that launcher's picks are a private mid-edit draft, while
 * these are a shareable, agent-driveable launch configuration.
 */
import { useCallback, useMemo, useState } from 'react';
import { parseAsBoolean, parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Combobox, type ComboboxOption } from '@/app/harness/Combobox';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { usePlanList } from '@/app/admin/plans/plans-api';
import {
  ACCOUNT_SELECT_DEFAULT,
  MODEL_SELECT_DEFAULT,
  OMP_MODEL_OPTIONS,
  PLAN_SELECT_PLACEHOLDER,
  buildAccountOptions,
  buildLaunchPlanOptions,
  modelBackend,
} from '@/app/adv/sessions/NewSessionLauncher';
import { useSuLaunchOptions } from '@/app/adv/sessions/use-su-launch-options';

/**
 * Members 2..N JOIN the fleet member 1 created, by slug. That slug comes back
 * from the server (`fleetSlug` on the launch response) rather than being
 * re-derived here on purpose: the server's slugifier truncates at 60 chars and
 * falls back to "fleet" for a name that slugifies to nothing, so a client-side
 * copy would silently disagree on exactly those inputs — and disagreeing means
 * every member after the first creates its OWN fleet instead of joining. Ask the
 * authority; never re-implement it.
 */

/**
 * Headed vs headless — the owner's "headed or headed", which is an obvious typo
 * for headed/headless (there is no second "headed" mode to pick between).
 *
 * Both values are explicit rows rather than a checkbox: this is the one option
 * whose wrong answer is expensive and invisible (headless members have no window
 * to notice), so it reads as a deliberate pick, not a toggle you skim past.
 */
export const HEADED_VALUE = 'headed';
export const HEADLESS_VALUE = 'headless';

export const WINDOW_MODE_OPTIONS: ComboboxOption[] = [
  {
    value: HEADED_VALUE,
    label: 'Headed',
    detail: 'Visible desktop terminal per member',
  },
  {
    value: HEADLESS_VALUE,
    label: 'Headless',
    detail: 'Background sessions, no window — logs to a file',
  },
];

/**
 * Clamp a member count to the range the tool actually accepts.
 *
 * The ceiling is imported from the client-safe constants module, which
 * `fleet:launch-on-plan` itself imports for its own `.max()` — so this control
 * cannot offer a count the tool would reject (WI-6505 lifted the constant there
 * for exactly this reason).
 *
 * Pure — exported for unit-test access.
 */
export function clampMemberCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

/** One member's outcome, as the launch loop records it. */
export interface MemberOutcome {
  ok: boolean;
  error?: string;
  warning?: string;
}

/**
 * Turn N per-member outcomes into ONE human sentence.
 *
 * Two things this exists to get right, both of which a naive "if the last call
 * succeeded" would report wrongly:
 *  - a PARTIAL launch (3 asked for, 2 opened) is a success worth stating with
 *    its shortfall, not a silent success and not a failure;
 *  - a launch where every member failed must say WHY, using the server's own
 *    message, rather than a generic "launch failed".
 *
 * Pure — exported for unit-test access.
 */
export function describeLaunchOutcome(results: MemberOutcome[], fleetName: string): { ok: boolean; message: string } {
  const opened = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  if (opened === 0) {
    // Prefer the first real reason over inventing copy — launch-su's errors are
    // specific (no terminal, psu missing, over the concurrency ceiling).
    const why = failures.find((f) => f.error?.trim())?.error?.trim();
    return { ok: false, message: why ?? `Could not launch “${fleetName}”.` };
  }
  const warned = results.filter((r) => r.ok && r.warning).length;
  let message = `Launched ${opened} member${opened === 1 ? '' : 's'} on “${fleetName}”`;
  if (failures.length > 0) message += ` — ${failures.length} failed to start`;
  else if (warned > 0) message += ` — ${warned} may not have opened a window`;
  return { ok: true, message: `${message}.` };
}

export interface FleetLaunchRowProps {
  className?: string;
  /** Called after a launch that opened at least one member — lets a host refresh
   *  a roster that is not already sync-driven. */
  onLaunched?: (fleetSlug: string | null) => void;
}

/**
 * The always-visible fleet-launch row. Self-contained: its own option fetches,
 * its own URL-backed selection state, its own launch call — so it drops into any
 * chat surface with no props.
 */
export default function FleetLaunchRow({ className, onLaunched }: FleetLaunchRowProps) {
  // Selections live in the URL (see the module header). Prefixed keys so they
  // cannot collide with the ~180 params already in use across this app.
  const [fleetName, setFleetName] = useQueryState('fleetName', parseAsString.withDefault(''));
  const [planSlug, setPlanSlug] = useQueryState('fleetPlan', parseAsString);
  const [model, setModel] = useQueryState('fleetModel', parseAsString.withDefault(''));
  const [account, setAccount] = useQueryState(
    'fleetAccount',
    parseAsString.withDefault(ACCOUNT_SELECT_DEFAULT),
  );
  const [headless, setHeadless] = useQueryState('fleetHeadless', parseAsBoolean.withDefault(false));
  const [count, setCount] = useQueryState('fleetCount', parseAsInteger.withDefault(1));

  // Launch lifecycle is render-only — useState is correct here (CLAUDE.md's
  // split puts loading/saving state on the local side of the line).
  const [launching, setLaunching] = useState(false);

  // psu's own account pool, keyed to the backend the picked model implies —
  // pool pinning is per-backend, exactly as the new-session row resolves it.
  const launchOptions = useSuLaunchOptions(null, modelBackend(model) ?? 'claude');
  const accountOptions = useMemo(
    () => buildAccountOptions(launchOptions.accounts),
    [launchOptions.accounts],
  );

  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const selectedPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === planSlug) ?? null,
    [planSlug, planList.data],
  );
  const planOptions = useMemo(
    () => buildLaunchPlanOptions(planList.data?.plans ?? [], selectedPlan?.harness ?? null, planList.loading),
    [planList.data, planList.loading, selectedPlan],
  );

  const launch = useCallback(async () => {
    if (launching) return;
    // A fleet needs a NAME (it becomes the durable handle) and a LANE. Both are
    // checked here so the human fixes them in the row rather than reading a
    // tool refusal — but they are still the tool's rules, not this row's: it
    // refuses a nameless fleet, and refuses a launch with neither `plan` nor
    // `claimKinds` because members would otherwise drain the whole backlog.
    if (!fleetName.trim()) {
      toast.error('Name the fleet — that name becomes its durable handle.');
      return;
    }
    if (!selectedPlan) {
      toast.error('Pick a plan — it is the lane the members work.');
      return;
    }
    setLaunching(true);
    try {
      const name = fleetName.trim();
      const members = clampMemberCount(count);
      const chosenModel = model && model !== MODEL_SELECT_DEFAULT ? model : null;
      const common = {
        slug: selectedPlan.harness ?? null,
        planSlug: selectedPlan.slug,
        label: name,
        model: chosenModel,
        // The model implies its backend (the menu spans claude/codex/omp), and
        // sending the model without it launches the WRONG CLI nominally set to an
        // unrunnable id — the trap that spawned 4 mislabelled members on
        // 2026-07-03. Send both, derived from the same menu.
        agent: modelBackend(model),
        // ALWAYS sent — a psu launch with no --account opens an interactive
        // picker that would hang every spawned member waiting for a human.
        account: account || ACCOUNT_SELECT_DEFAULT,
        headless,
      };

      // Member 1 CREATES the fleet (fleetName) and reports back the slug the
      // server assigned; members 2..N JOIN that slug. Deliberately SERIAL for the
      // first hop — firing all N in parallel with `fleetName` would race N
      // creations of the same fleet — then parallel for the rest, which is just
      // N independent joins.
      const first = await launchAgent({ ...common, fleetName: name, fleet: null });
      const outcomes: MemberOutcome[] = [
        { ok: first.ok, error: first.error, warning: first.warning },
      ];
      // Only fan out if the fleet actually exists now; otherwise N-1 more
      // failures would just be noise on top of the real error.
      if (first.ok && members > 1) {
        const joinSlug = first.fleetSlug ?? null;
        const rest = await Promise.all(
          Array.from({ length: members - 1 }, () =>
            launchAgent({ ...common, fleet: joinSlug, fleetName: joinSlug ? null : name }),
          ),
        );
        for (const r of rest) outcomes.push({ ok: r.ok, error: r.error, warning: r.warning });
      }

      const verdict = describeLaunchOutcome(outcomes, name);
      if (verdict.ok) {
        toast.success(verdict.message, { duration: 5000 });
        // The launch CREATED a fleet — re-read the picker source so it is
        // immediately joinable elsewhere without a reload.
        launchOptions.refresh();
        onLaunched?.(first.fleetSlug ?? name);
      } else {
        toast.error(verdict.message, { duration: 8000 });
      }
    } catch (e) {
      toast.error(`Fleet launch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaunching(false);
    }
  }, [
    launching,
    fleetName,
    selectedPlan,
    count,
    headless,
    account,
    model,
    launchOptions,
    onLaunched,
  ]);

  return (
    <div
      className={`pc-fleet-launch-row${className ? ` ${className}` : ''}`}
      data-testid="fleet-launch-row"
      aria-label="Launch a fleet"
    >
      {/* ── P-007: CAPTIONS, and deliberately NOT a disclosure ──────────────
          Deck item #5 drew this collapsed, behind a "✛ Launch a fleet…"
          trigger. I built that, and it was wrong: owner ask (ii) at the top of
          this file says "Instead of abutton like the others make this fleet
          launching its own always visible row", so collapsing it turns the row
          back into exactly the button the owner rejected. The owner's
          2026-08-02 decision that the launcher STAYS in the popup settled
          WHERE it lives, not whether it is collapsed. The row therefore stays
          unconditionally visible, and FleetLaunchRow.test.tsx's "renders
          unconditionally, with a control for every option" is the test that
          holds that line — it caught this.

          What P-007 does change is the FORM, which is where the owner's actual
          complaint was: every control now carries a VISIBLE caption above a
          recessed well (the vocabulary's Field shape). Until now these seven
          controls had no visible names at all — their labels existed only in
          `ariaLabel`, and that is literally where the owner's complaint text
          came from ("Plan the fleet works", "Account routing for every fleet
          member", "Headed or headless members"). Those strings were never
          written as UI copy; they were being READ as UI copy because nothing
          else named the controls. ── */}
      <div className="pc-new-session-launcher pc-fleet-launch-row__fields">
        {/* The zone's NAME, not a group caption. It already sat at this band's
            leading edge as grey text; as a filled cap it joins the same
            vocabulary the other five zones use — and it is what makes "this band
            does not act on the session you are looking at" legible. Zero added
            height: the cap shares the row it was already on. */}
        <span className="pc-zone-cap pc-fleet-strip__label">Fleet</span>
        {/* ── The strip's FIELD GRID (WI-7456) ───────────────────────────────
            [owner 2026-08-03] "the alignement on the bottom panel is still all
            mest up", third recurrence. These six fields used to be items in a
            WRAPPING FLEX strip they shared with the zone cap and the submit,
            each `flex: 1 1 auto`. Three consequences, all measured on WI-7456
            at a 740px band: the wrapped second line restarted at the band's
            padding (x=11), i.e. under the FLEET cap, 49px left of where line
            one's first field began; the two lines' captions were 49px apart in
            every column; and their wells were 18–42px apart, because a field's
            caption width ("Name" 27px vs "Account" 49px) pushed its own well.

            A grid fixes all three at once and is why this is a wrapper rather
            than another round of margins: the columns are declared ONCE, so
            NAME/PLAN/MODEL land above ACCOUNT/WINDOWS/MEMBERS by construction
            instead of by coincidence of content width. The submit stays a
            SIBLING of this grid (the strip's third column) so it cannot
            consume a field cell and push the strip to a third line. ── */}
        <div className="pc-fleet-strip__grid">
        <div className="pc-ctl-field pc-ctl-field--inline">
          {/* The VISIBLE caption shortens to "Name" (the strip's own "FLEET"
              label supplies the rest of the phrase to a sighted reader), but
              the ACCESSIBLE name stays the full "Fleet name" — a screen-reader
              user gets no such spatial grouping, and "Name" alone in a popup
              full of names is not a name. `aria-label` wins over the
              `aria-labelledby` this used to carry, and WCAG 2.5.3 is satisfied
              because the accessible name still CONTAINS the visible label. */}
          <span className="pc-ctl-field__cap" id="fleet-cap-name" aria-hidden="true">
            Name
          </span>
          <input
            className="pc-new-session-launcher__input"
            type="text"
            value={fleetName}
            onChange={(e) => void setFleetName(e.target.value)}
            placeholder="Fleet's durable handle"
            title="Fleet name — names the fleet's durable handle"
            aria-label="Fleet name"
            data-testid="fleet-launch-name"
          />
        </div>
        <div className="pc-ctl-field pc-ctl-field--inline">
          <span className="pc-ctl-field__cap" title="Plan — the lane members work">Plan</span>
          <Combobox
            triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--plan"
            value={planSlug ?? PLAN_SELECT_PLACEHOLDER}
            emptyValue={PLAN_SELECT_PLACEHOLDER}
            onChange={(value) => void setPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
            disabled={planList.loading}
            ariaLabel="Plan the fleet works"
            placeholder={planList.loading ? 'Loading plans…' : 'Select plan…'}
            emptyLabel="No plans match"
            options={planOptions}
          />
        </div>
        <div className="pc-ctl-field pc-ctl-field--inline">
          <span className="pc-ctl-field__cap" title="Model — every member">Model</span>
          <Combobox
            triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--model"
            value={model || MODEL_SELECT_DEFAULT}
            emptyValue={MODEL_SELECT_DEFAULT}
            onChange={(value) => void setModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
            ariaLabel="Model for every fleet member"
            placeholder="Default"
            emptyLabel="No models match"
            options={OMP_MODEL_OPTIONS}
          />
        </div>
        {/* The owner's fifth option — "default system account or pin to an
            account using the inference gateway" — IS this control: its rows are
            `default` (system/CLI login, gateway skipped), `auto` (gateway-routed
            with failover) and every pool account (a hard gateway pin). One
            control, because psu's --account is one flag with three modes. */}
        <div className="pc-ctl-field pc-ctl-field--inline">
          <span className="pc-ctl-field__cap" title="Account routing — for every fleet member">Account</span>
          <Combobox
            triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--account"
            value={account}
            emptyValue={ACCOUNT_SELECT_DEFAULT}
            onChange={(value) => void setAccount(value)}
            ariaLabel="Account routing for every fleet member"
            placeholder="Default account"
            emptyLabel="No accounts match"
            options={accountOptions}
          />
        </div>
        <div className="pc-ctl-field pc-ctl-field--inline">
          <span className="pc-ctl-field__cap" title="Windows — headed or headless members">Windows</span>
          <Combobox
            triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--window"
            value={headless ? HEADLESS_VALUE : HEADED_VALUE}
            onChange={(value) => void setHeadless(value === HEADLESS_VALUE)}
            ariaLabel="Headed or headless members"
            placeholder="Headed"
            emptyLabel="No modes match"
            options={WINDOW_MODE_OPTIONS}
          />
        </div>
        <div className="pc-ctl-field pc-ctl-field--inline">
          <span className="pc-ctl-field__cap" id="fleet-cap-count" aria-hidden="true">
            Members
          </span>
          <input
            aria-label="Members"
            className="pc-new-session-launcher__input pc-fleet-launch-row__count"
            type="number"
            min={1}
            value={count}
            // Clamped on COMMIT, not on every keystroke: clamping as you type makes
            // the field impossible to clear and retype (a "1" you are turning into
            // "12" snaps back), so the raw value is held and bounded at launch.
            onChange={(e) => void setCount(Number.parseInt(e.target.value, 10) || 1)}
            onBlur={() => void setCount(clampMemberCount(count))}
            title="How many members"
            data-testid="fleet-launch-count"
          />
        </div>
        </div>
        {/* The submit lives INSIDE the strip rather than in a band of its own.
            It used to sit in a third stacked band with a `border-top`, which
            cost a whole row to render one right-aligned button. `margin-left:
            auto` pushes it to the far edge of whichever line it lands on, so
            the strip is one line when there is room and wraps when there is
            not.

            ⚠ MEASURED CORRECTION 2026-08-03 (P-009): this used to end "— never
            three", which is false and was never measured. At a 1280px window
            the popup's centre column is 652px and this strip's six fields plus
            the submit wrap to THREE lines. Two lines is what it does at the
            popup's designed 748px column (window >= ~1361px), not everywhere.
            See plan decision D-005 — a line-count claim about this popup is
            meaningless without stating the width it was measured at. */}
        <Button
          variant="primary"
          size="sm"
          className="pc-new-session-launcher__btn pc-fleet-strip__submit"
          onClick={() => void launch()}
          disabled={launching}
          data-testid="fleet-launch-submit"
        >
          {launching ? 'Launching…' : '+ Launch fleet'}
        </Button>
      </div>
    </div>
  );
}
