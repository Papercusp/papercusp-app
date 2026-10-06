/**
 * LearningLoopControl — the Learning tab header's pause/resume + spend control
 * (WI-39501, owner ask 2026-08-16: "a single small place … in the header at the
 * same level as the [stage tabs] for the pause/resume button and overall spend
 * tracking", + dialog refinements: chip shows "learning" with an ANIMATED
 * ellipsis while active, and a pause/resume button sits right next to the chip).
 *
 * One small slot on the stage row — the header element every step shares:
 *   [ ● learning… · $4.62 ▾ ] [⏸]
 * The chip opens a popover control center (run/pause switch, spend breakdown,
 * what resume restores, link to the full token report); the adjacent icon
 * button is the one-click pause/resume.
 *
 * Reads `learning.loopControl` (self-improvement routine group state + the
 * loop's own spend — scout/gym/llm-testing roles only, owner scope ruling).
 * Writes through the SAME gated + audited bridge the Automation pane uses
 * (`/api/agent-mcp/run-tool` → routines:group-set), whose group-pause stamps
 * make resume restore EXACTLY the routines the pause held — a deliberate
 * pre-existing hold (IQ battery, template gym, …) is never revived.
 *
 * Styles are scoped here (pc-lloop__*) so the LearningTab wiring stays small;
 * the paused stepper treatment keys off `.pc-lloop--paused` via :has() in
 * LearningStyles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryState, parseAsBoolean, parseAsString } from "nuqs";
import { ChevronDown, Pause, Play, Search } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import { useFlag } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import type {
  AutomationArming,
  AutomationCatalog,
} from "@papercusp/operator-core/lib/automation/catalog";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import { runAgentTool } from "./run-tool";
import { useOpenPotDrawer } from "./LearningPotDrawer";
import { useOpenPotPicker } from "./LearningPotPicker";
import DreamControl from "./DreamControl";
import {
  buildLearningPotRail,
  partitionLearningPotRail,
  type LearningPotChip,
} from "./learning-pot-rail";
// Native `title=` on a button is blocked by lint:design-primitives — Tooltip is
// the shared primitive. It renders via Radix `Trigger asChild`, so it clones the
// button rather than wrapping it: the .pc-lloop flex row is unaffected.
import { Tooltip } from "@/app/harness/Tooltip";
import type { LearningLoopControl as LoopSnapshot } from "@papercusp/operator-core/lib/harness/improvements/loop-control";

/** Human labels for the loop's spend roles. */
const ROLE_LABELS: Record<string, string> = {
  scout: "Scout",
  gym: "Gym",
  "llm-testing": "Judges",
};

function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function agoLabel(atMs: number, nowMs: number): string {
  const min = Math.max(0, (nowMs - atMs) / 60_000);
  if (min < 1) return "just now";
  if (min < 90) return `${Math.round(min)}m ago`;
  if (min < 60 * 36) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

/** Fire routines:group-set through the gated + audited run-tool bridge (the
 *  Automation pane's exact contract — 'loopback' actor, confirmed:true). */
async function runGroupSet(args: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/agent-mcp/run-tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "routines:group-set", args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  if (text) {
    const payload = JSON.parse(text) as { ok?: boolean; message?: string };
    if (payload.ok === false) throw new Error(payload.message ?? "routines:group-set refused");
  }
}

/** Human sub-line for one pot row: what that pot itself has armed. */
function potSubline(chip: LearningPotChip): string {
  const lanes =
    chip.lanes.total > 0
      ? `${chip.lanes.armed} of ${chip.lanes.total} lane${chip.lanes.total === 1 ? "" : "s"} armed`
      : "no lanes";
  const gym =
    chip.gym.state === "absent"
      ? "no gym"
      : chip.gym.state === "on"
        ? "gym armed"
        : chip.gym.state === "unknown"
          ? "gym unreadable"
          : "gym off";
  return `${lanes} · ${gym}`;
}

/**
 * The pot section of the dropdown — the rail's seven chips, folded in
 * (owner ask 2026-09-07: "im proposing a dropdown", then "fit it all on one
 * line"). It replaces LearningPotRail outright rather than sitting beside it.
 *
 * WHY IT SITS UNDER THE MASTER SWITCH. A pot's lanes are ANDed with the group
 * switch above it, so reading this panel top-to-bottom reads the real logic.
 * That is the same ordering argument the per-pot popover made before this
 * absorbed it, and putting a pot first would invite "the pot says on, so it is
 * running" — false whenever the group is paused.
 *
 * The Learning switch is the pot scope. A segment's state is
 * its OWN arming, never the effective outcome (learning-pot-rail.ts rule 3):
 * switching a pot off deliberately leaves each lane's arming untouched so
 * switching it back on restores exactly what was armed. This row preserves that
 * — it writes `learning:set-pot-scope` only. The adjacent Dreaming switch
 * reuses DreamControl's explicit automatic-Dream setting for this pot.
 *
 * WHY THE NAME OPENS THE DRAWER INSTEAD OF A NESTED POPOVER. The drawer is a
 * strict SUPERSET of the chip popover this replaces: it already writes
 * learning:set-pot-scope, gym:arm and governor:arm alongside the budgets. So
 * routing there keeps every per-lane control the rail carried, instead of
 * rebuilding a smaller, second copy of it inside a dropdown.
 */
function PotScopeList({
  arming,
  onWrote,
  groupPaused,
}: {
  arming: AutomationArming | null;
  onWrote: () => void;
  groupPaused: boolean;
}) {
  const t = useLexicon();
  const openDrawer = useOpenPotDrawer();
  const openPicker = useOpenPotPicker();
  // Render-only state: a filter box inside a popover that closes on outside
  // click has no meaning to share or link (CLAUDE.md's useState column).
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Every pot the model knows, ACTIVE ONES FIRST. The rail could only ever show
  // the active partition and summarised the rest as "+47 idle"; a list can hold
  // both, so the dormant tail is reachable here instead of behind a count — but
  // it must not push the pots that are actually running down the list, which is
  // what interleaving them by spend would do.
  const chips = useMemo(() => {
    const { active, dormant } = partitionLearningPotRail(
      buildLearningPotRail(arming),
    );
    return [...active, ...dormant];
  }, [arming]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chips;
    return chips.filter(
      (chip) =>
        potHomeLabel(chip.potSlug).toLowerCase().includes(q) ||
        chip.potSlug.toLowerCase().includes(q),
    );
  }, [chips, query]);
  const onCount = chips.filter((chip) => chip.learning === "on").length;

  const toggle = useCallback(
    async (chip: LearningPotChip) => {
      setBusy(chip.potSlug);
      setErr(null);
      try {
        await runAgentTool("learning:set-pot-scope", {
          pots: [chip.potSlug],
          enabled: chip.learning !== "on",
        });
        onWrote();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [onWrote],
  );

  if (chips.length === 0) return null;

  return (
    <>
      <hr className="pc-lloop__hr" />
      <div className="pc-lloop__seclabel">
        <span>{t("pot", { plural: true })}</span>
        <span>{`${onCount} of ${chips.length} learning`}</span>
      </div>
      {/* The filter earns its place on the real population, not this one: the
          rail's own measurement put the workspace at 54 pots with a learning
          setup. Below ~8 it is dead weight, so it is not rendered. */}
      {chips.length > 8 ? (
        <label className="pc-lloop__potfilter">
          <Search size={11} aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${t("pot", { plural: true, lower: true })}…`}
            aria-label={`Filter ${t("pot", { plural: true, lower: true })}`}
          />
        </label>
      ) : null}
      <div className="pc-lloop__potlist">
        {shown.map((chip) => {
          const label = potHomeLabel(chip.potSlug);
          const isOn = chip.learning === "on";
          return (
            <div className="pc-lloop__potrow" key={chip.potSlug}>
              {/* Tooltip, not a native title=: a title is invisible to
                  keyboard and touch users and fails lint:design-primitives.
                  It renders via Radix `Trigger asChild`, so it CLONES this
                  button rather than wrapping it — the grid row is unaffected. */}
              <Tooltip
                label={`${label} — budgets, enforcement and per-lane arming`}
              >
                <button
                  type="button"
                  className="pc-lloop__potname"
                  aria-label={`Open fields for ${label}`}
                  onClick={() => openDrawer(chip.potSlug)}
                >
                  <b>{label}</b>
                  <span className="pc-lloop__potsub">{potSubline(chip)}</span>
                </button>
              </Tooltip>
              <span className="pc-lloop__potspend">
                {chip.spentUsd > 0 ? (
                  <>
                    {usd(chip.spentUsd)}
                    <i aria-hidden>+</i>
                  </>
                ) : (
                  // A dash, not $0.00: six chips shouting a zero was the noise
                  // the rail was carrying (owner, 2026-09-07).
                  <span className="pc-lloop__potzero">—</span>
                )}
              </span>
              <div className="pc-lloop__potlearning">
                <span className="pc-lloop__togglelabel">Learning</span>
                {chip.learning === "unknown" ? (
                // An unreadable scope cannot be drawn as a two-state switch
                // without asserting a position we never read. The WRITE is
                // still well-defined, so offer it rather than disabling the
                // only control that can repair the read.
                <button
                  type="button"
                  className="pc-lloop__potfix"
                  disabled={busy !== null}
                  onClick={() => void toggle(chip)}
                >
                  set
                </button>
              ) : (
                <span className="pc-lloop__sw">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={isOn}
                    disabled={busy !== null}
                    aria-label={`${isOn ? "Switch off" : "Switch on"} learning for ${label}`}
                    onChange={() => void toggle(chip)}
                  />
                  <span className="pc-lloop__swtrack" aria-hidden />
                  <span className="pc-lloop__swthumb" aria-hidden />
                </span>
                )}
              </div>
              <DreamControl compact potSlug={chip.potSlug} potLabel={label}
                learningPaused={groupPaused || chip.learning !== "on"} onWrote={onWrote} />
            </div>
          );
        })}
        {shown.length === 0 ? (
          <p className="pc-lloop__fine">No {t("pot", { plural: true, lower: true })} match that filter.</p>
        ) : null}
      </div>
      {err ? (
        <p className="pc-lloop__err" role="alert">
          {err}
        </p>
      ) : null}
      <p className="pc-lloop__fine">
        A name opens that {t("pot", { lower: true })}&apos;s fields — budgets,
        enforcement and per-lane arming.
      </p>
      {/* The picker enumerates EVERY pot, including ones with no learning setup
          at all — which buildLearningPotRail deliberately omits, so this list
          cannot reach them. Kept as the one route to that population. */}
      <button type="button" className="pc-lloop__link" onClick={openPicker}>
        {`See every ${t("pot", { lower: true })} →`}
      </button>
    </>
  );
}

export default function LearningLoopControl() {
  const enabled = useFlag(FLAGS.LEARNING_LOOP_CONTROL);
  const t = useLexicon();
  const sync = useSyncQuery<LoopSnapshot>({
    queryName: "learning.loopControl",
    args: {},
    staleTime: 30_000,
  });
  // The pot scopes + per-pot spend the rail used to read. Same query, same
  // staleTime — this control absorbed the rail rather than adding a read.
  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: "automation.catalog",
    args: {},
    staleTime: 15_000,
  });
  const arming = catalogQuery.data?.[0]?.arming ?? null;
  // A write through the run-tool bridge changes state this query is the truth
  // of, and the bridge cannot know which query that is — so the caller
  // invalidates. Without it the row keeps rendering the scope it just changed,
  // which reads as "the switch did nothing".
  const onPotWrote = useCallback(() => {
    catalogQuery.invalidate?.();
  }, [catalogQuery]);
  const [open, setOpen] = useQueryState("lloop", parseAsBoolean.withDefault(false));
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setInsightView] = useQueryState("insightView", parseAsString);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const fit = () => {
      const popover = rootRef.current?.querySelector<HTMLElement>(".pc-lloop__pop");
      if (popover) popover.style.maxHeight = `${Math.max(120, window.innerHeight - popover.getBoundingClientRect().top - 16)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [open, sync.data]);

  // Outside-click / Escape close for the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) void setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const snap = sync.data?.[0];
  const paused = snap?.status === "paused";

  /**
   * The verdict that leads the stage row — the sentence the seven pills never
   * said (owner, 2026-09-07: "all seven pots read learning off" was invisible
   * behind a dashed border and 62% opacity).
   *
   * "Learning" is the group switch AND the pot's own scope, never either alone
   * — the rule the whole rail model is built on — so a paused group means
   * nothing is learning however many pots are switched on, and vice versa.
   *
   * The spend is the POT total (gym + governor lanes), which is what the rail
   * showed and what the reader recognises. It is a FLOOR, never complete:
   * scout is gated per-pot but armed workspace-wide, so no per-pot scout spend
   * exists to add. The trailing `+` carries that caveat, exactly as the chip's
   * did, and is rendered from the data rather than hard-coded.
   */
  const verdict = useMemo(() => {
    // ONE POPULATION, ALL THREE FIGURES — the ACTIVE partition, i.e. the pots
    // with something actually armed under them. This is the population the rail
    // gave chips to (7 here), not every pot with a learning setup (54 here, the
    // rail's own measurement): a pot with nothing armed is not waiting to learn,
    // so counting it would say "54 paused" about a pause holding 7. Mixing the
    // two across the clauses is exactly the miscounting the rail's dormant-chip
    // comment warns about, so spend is summed over the same set rather than
    // over all pots — and the trailing `+` already states it is a floor.
    const { active: chips } = partitionLearningPotRail(
      buildLearningPotRail(arming),
    );
    if (chips.length === 0) return null;
    const potsOn = chips.filter((chip) => chip.learning === "on").length;
    const lanesArmed = chips.reduce((sum, chip) => sum + chip.lanes.armed, 0);
    const spentUsd = chips.reduce((sum, chip) => sum + chip.spentUsd, 0);
    const spendComplete = chips.every((chip) => chip.spendComplete);
    const nothingLearning = paused || potsOn === 0;
    return {
      nothingLearning,
      lead: nothingLearning
        ? "Nothing is learning"
        : `${potsOn} of ${chips.length} ${t("pot", { plural: chips.length !== 1, lower: true })} learning`,
      pots: paused
        ? `${chips.length} ${t("pot", { plural: chips.length !== 1, lower: true })} paused`
        : `${potsOn} of ${chips.length} on`,
      lanes: `${lanesArmed} lane${lanesArmed === 1 ? "" : "s"} armed${nothingLearning ? ", idle" : ""}`,
      spend: `${usd(spentUsd)}${spendComplete ? "" : "+"}`,
    };
  }, [arming, paused, t]);

  const setActive = useCallback(
    async (nextActive: boolean) => {
      if (!snap || busy) return;
      setBusy(true);
      setError(null);
      try {
        await runGroupSet(
          nextActive
            ? { group: snap.group, active: true }
            : { group: snap.group, active: false, reason: "Paused from the Learning tab" },
        );
        // The server emits an SSE invalidate too, but its 90s source-side dedupe
        // can swallow a quick pause→resume — the clicker always refetches locally.
        sync.invalidate();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [snap, busy, sync],
  );

  // Shape-guard, not just presence: a row without `spend` (a stale cache, a
  // generic test mock, a server predating the learning.loopControl resolver)
  // must read as "no snapshot yet", never crash the whole Learning tab
  // (WI-39530 — 11 LearningTab.test.tsx reds from `snap.spend.todayUsd`).
  if (!enabled || !snap || !snap.spend) return null;

  const spendToday = usd(snap.spend.todayUsd);
  const holdNote = paused
    ? `Held${snap.pausedAtMs ? ` ${agoLabel(snap.pausedAtMs, snap.evaluatedAt)}` : ""}${
        snap.pausedBy ? ` by ${snap.pausedBy}` : ""
      }. Resume restores the ${snap.heldCount} routine${snap.heldCount === 1 ? "" : "s"} this pause held — deliberate holds stay held.`
    : `Pausing holds the ${snap.activeCount} active routine${snap.activeCount === 1 ? "" : "s"} in the ${snap.group} group. Resume restores exactly those — loops paused deliberately stay paused.`;

  return (
    <div ref={rootRef} className={`pc-lloop${paused ? " pc-lloop--paused" : ""}`}>
      {/* The verdict, first on the row and in words. It is the ELASTIC member
          of the line: the stepper and the controls are fixed, so this is what
          gives way, dropping clauses from the right rather than wrapping the
          row onto a second line (the strip this replaced cost a whole row). */}
      {verdict ? (
        <span
          className={`pc-lloop__verdict${verdict.nothingLearning ? " is-idle" : ""}`}
        >
          <span className="pc-lloop__lead">
            <span className="pc-lloop__dot" aria-hidden />
            {verdict.lead}
          </span>
          {/* Each figure carries its OWN leading separator so a container
              query can drop the pair together — hiding a value and leaving a
              dangling "·" is the classic version of this bug. */}
          <span className="pc-lloop__figs">
            <span className="pc-lloop__fig">
              <em aria-hidden>·</em>
              {verdict.pots}
            </span>
            <span className="pc-lloop__fig pc-lloop__fig--lanes">
              <em aria-hidden>·</em>
              {verdict.lanes}
            </span>
            <span className="pc-lloop__fig pc-lloop__fig--spend">
              <em aria-hidden>·</em>
              {verdict.spend}
            </span>
          </span>
        </span>
      ) : null}
      <Tooltip
        label={
          error ??
          `Learning ${t("pot", { plural: true, lower: true })}, spend and pause`
        }
      >
        <button
          type="button"
          className="pc-lloop__chip"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => void setOpen(!open)}
        >
          {/* No status dot here: the verdict to the left already carries it,
              and two dots on one line read as two different states. */}
          <span className="pc-lloop__word">
            {t("pot", { plural: true })}
          </span>
          {verdict ? null : (
            <span className="pc-lloop__amt">{spendToday}</span>
          )}
          <ChevronDown size={10} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip
        label={
          error ??
          (paused
            ? `Resume the ${snap.heldCount} held learning loop${snap.heldCount === 1 ? "" : "s"}`
            : `Pause all ${snap.activeCount} learning loop${snap.activeCount === 1 ? "" : "s"}`)
        }
      >
        <button
          type="button"
          className="pc-lloop__pp"
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={paused ? "Resume all learning loops" : "Pause all learning loops"}
          onClick={() => void setActive(paused)}
        >
          {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
        </button>
      </Tooltip>

      {open ? (
        <div className="pc-lloop__pop" role="dialog" aria-label="Learning loops">
          <div className="pc-lloop__pophead">
            Learning loops
            <span className={`pc-lloop__state pc-lloop__state--${snap.status}`}>{snap.status}</span>
          </div>
          <label className="pc-lloop__swrow">
            <span>Run the loop</span>
            <span className="pc-lloop__sw">
              {/* role="switch" is the accurate semantic — this is a two-state
                  on/off toggle with a track + thumb, not a checkbox in a set —
                  and it is what lint:design-primitives keys on to tell the two
                  apart (design-primitives.test.ts:290). Keep it. */}
              <input
                type="checkbox"
                role="switch"
                checked={!paused}
                disabled={busy}
                onChange={(e) => void setActive(e.target.checked)}
              />
              <span className="pc-lloop__swtrack" aria-hidden />
              <span className="pc-lloop__swthumb" aria-hidden />
            </span>
          </label>
          <p className="pc-lloop__fine">{holdNote}</p>
          {error ? (
            <p className="pc-lloop__err" role="alert">
              {error}
            </p>
          ) : null}
          {/* The pots, between the master switch they are ANDed with and the
              spend they produce. This is what replaced LearningPotRail. */}
          <PotScopeList arming={arming} onWrote={onPotWrote} groupPaused={paused} />
          <hr className="pc-lloop__hr" />
          <div className="pc-lloop__srow">
            <span>Today</span>
            <b>{spendToday}</b>
          </div>
          <div className="pc-lloop__srow">
            <span>Last 7 days</span>
            <b>{usd(snap.spend.weekUsd)}</b>
          </div>
          {snap.spend.byRole.map((r) => (
            <div key={r.role} className="pc-lloop__srow pc-lloop__srow--sub">
              <span>{ROLE_LABELS[r.role] ?? r.role}</span>
              <span>{usd(r.todayUsd)}</span>
            </div>
          ))}
          <p className="pc-lloop__fine">The loop's own roles only — implement workers are not counted.</p>
          <button
            type="button"
            className="pc-lloop__link"
            onClick={() => {
              void setOpen(false);
              void setTab("insights");
              void setInsightView("tokens");
            }}
          >
            Full token report →
          </button>
        </div>
      ) : null}

      <style>{`
        /* Was absolutely positioned at the stage row's right edge; it is now a
           real flex member of that row so the stepper, the verdict and the
           controls negotiate width instead of overlapping (owner, 2026-09-07:
           "fit it all on one line"). position:relative stays — the popover
           below anchors to this box. */
        .pc-lloop {
          position: relative; flex: 1 1 auto; min-width: 0;
          display: flex; align-items: center; justify-content: flex-end;
          gap: 8px; z-index: 2;
        }

        /* ── the verdict: the row's elastic middle ───────────────────────── */
        .pc-lloop__verdict {
          flex: 1 1 auto; min-width: 0; overflow: hidden;
          display: flex; align-items: center;
          font-size: 12px; color: var(--fg-dim); white-space: nowrap;
        }
        .pc-lloop__lead {
          flex: none; display: inline-flex; align-items: center; gap: 7px;
          color: var(--fg); font-weight: 600; font-size: 12.5px;
        }
        .pc-lloop__verdict .pc-lloop__dot {
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 14%, transparent);
        }
        .pc-lloop--paused .pc-lloop__verdict .pc-lloop__dot {
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 14%, transparent);
        }
        /* An idle verdict is the one that must READ, so it takes the warn dot
           even when the group itself is running and only the scopes are off. */
        .pc-lloop__verdict.is-idle .pc-lloop__dot { background: var(--warn); }
        /* WHOLE figures or none (WI-10006513). The container-query steps
           below drop figures at fixed widths, but they cannot know how wide
           the live values are: at 1366x650 the spend figure still rendered and
           overflow:hidden sliced its end off, so "·$598.30+" read as
           "·$598.3" — a WRONG number, worse than no number. Now the strip
           WRAPS and is exactly one line tall: a figure that does not fit moves
           whole onto the hidden second line instead of being cut mid-value. */
        .pc-lloop__figs {
          display: inline-flex; flex-wrap: wrap; align-items: center;
          min-width: 0; height: 18px; line-height: 18px;
          overflow: hidden; font-variant-numeric: tabular-nums;
        }
        .pc-lloop__fig { flex: none; }
        .pc-lloop__fig em { font-style: normal; color: var(--fg-mute); margin: 0 9px; }
        .pc-lloop__chip {
          display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
          border: 1px solid var(--border-strong); border-radius: 999px;
          background: var(--bg-1); color: var(--fg-dim); cursor: pointer; font: inherit;
          font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap;
        }
        .pc-lloop__chip:hover { color: var(--fg); background: var(--bg-2); }
        .pc-lloop__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
        .pc-lloop--paused .pc-lloop__dot { background: var(--warn); }
        .pc-lloop--paused .pc-lloop__chip {
          color: var(--warn);
          border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
          background: color-mix(in srgb, var(--warn) 9%, var(--bg-1));
        }
        .pc-lloop__word { font-weight: 650; }
        .pc-lloop__ell { display: inline-flex; }
        .pc-lloop__ell i { font-style: normal; animation: pc-lloop-ell 1.4s infinite both; }
        .pc-lloop__ell i:nth-child(2) { animation-delay: .2s; }
        .pc-lloop__ell i:nth-child(3) { animation-delay: .4s; }
        @keyframes pc-lloop-ell { 0%, 20% { opacity: .15; } 40% { opacity: 1; } 100% { opacity: .15; } }
        @media (prefers-reduced-motion: reduce) { .pc-lloop__ell i { animation: none; } }
        .pc-lloop__amt { color: var(--fg-mute); }
        .pc-lloop--paused .pc-lloop__amt { color: inherit; opacity: .8; }
        .pc-lloop__pp {
          display: grid; place-items: center; width: 24px; height: 24px; min-height: 24px; border-radius: 8px;
          border: 1px solid var(--border-strong); background: var(--bg-1);
          color: var(--fg-dim); cursor: pointer; padding: 0;
        }
        .pc-lloop__pp:hover { color: var(--fg); background: var(--bg-2); }
        .pc-lloop__pp[disabled] { opacity: .5; cursor: default; }
        .pc-lloop--paused .pc-lloop__pp {
          color: var(--warn);
          border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
        }
        .pc-lloop__pop {
          position: absolute; right: 0; top: 30px; z-index: 30; width: min(440px, calc(100vw - 32px));
          box-sizing: border-box;
          max-height: 70vh; overflow-y: auto; overscroll-behavior: contain;
          /* Floating controls must be opaque: --bg-2 is intentionally a
             translucent in-panel wash, so content behind this menu otherwise
             bleeds through and competes with the pause/resume copy. */
          background: var(--bg-popover); border: 1px solid var(--border-strong);
          border-radius: 10px; padding: 12px 14px;
          box-shadow: 0 12px 32px color-mix(in srgb, var(--fg) 12%, transparent);
          font-size: 12px; color: var(--fg-dim); text-align: left;
        }
        .pc-lloop__pophead {
          display: flex; justify-content: space-between; align-items: center;
          font-weight: 700; color: var(--fg); margin-bottom: 6px;
        }
        .pc-lloop__state { font-size: 10px; font-weight: 700; text-transform: uppercase; }
        .pc-lloop__state--running { color: var(--good); }
        .pc-lloop__state--paused { color: var(--warn); }
        .pc-lloop__swrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 0 8px; cursor: pointer; }
        .pc-lloop__sw { position: relative; display: inline-flex; flex: none; }
        /* The invisible input IS the hit target, so it must cover the whole
           track. "inset: 0" alone does NOT size it: a checkbox is a replaced
           element, and an absolutely positioned replaced element keeps its
           intrinsic ~12px box whatever the offsets say (CSS 2.1 §10.3.8). It
           then covered only the track's LEFT end, which is where the thumb
           sits when OFF — so switching ON worked, and clicking the thumb of an
           ON switch hit the bare span and did nothing: "I can't turn the top
           pot off" (WI-10003857; the top pot is the one that is on). Explicit
           width/height plus "appearance: none" make the box obey the offsets.
           lint:design-primitives now refuses an overlay input without them. */
        .pc-lloop__sw input { position: absolute; inset: 0; width: 100%; height: 100%; appearance: none; opacity: 0; margin: 0; cursor: pointer; }
        .pc-lloop__swtrack { width: 30px; height: 17px; border-radius: 999px; background: var(--border-strong); transition: background var(--dur-fast); pointer-events: none; }
        .pc-lloop__swthumb { position: absolute; top: 2.5px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--fg); transition: transform var(--dur-fast); pointer-events: none; }
        .pc-lloop__sw input:checked + .pc-lloop__swtrack { background: var(--accent); }
        .pc-lloop__sw input:checked ~ .pc-lloop__swthumb { transform: translateX(12px); }
        .pc-lloop__sw input:focus-visible + .pc-lloop__swtrack { outline: 2px solid var(--accent); outline-offset: 2px; }
        .pc-lloop__sw input:disabled { cursor: default; }
        .pc-lloop__sw input:disabled ~ span { opacity: .5; }
        .pc-lloop__fine { margin: 0 0 6px; font-size: 11px; line-height: 1.45; color: var(--fg-mute); }
        .pc-lloop__err { margin: 0 0 6px; font-size: 11px; line-height: 1.45; color: var(--bad, #fb7185); }
        .pc-lloop__hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
        .pc-lloop__srow { display: flex; justify-content: space-between; padding: 2px 0; font-variant-numeric: tabular-nums; }
        .pc-lloop__srow b { color: var(--fg); font-weight: 650; }
        .pc-lloop__srow--sub { color: var(--fg-mute); font-size: 11.5px; }
        .pc-lloop__link { display: inline-block; margin-top: 6px; font-size: 12px; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit; }
        .pc-lloop__link:hover { text-decoration: underline; text-underline-offset: 3px; }

        /* ── the pot section (absorbed from LearningPotRail) ─────────────── */
        .pc-lloop__seclabel {
          display: flex; align-items: baseline; justify-content: space-between;
          font-size: 10px; font-weight: 700; text-transform: uppercase;
          color: var(--fg-mute); margin-bottom: 7px;
        }
        .pc-lloop__potfilter {
          display: flex; align-items: center; gap: 6px; width: 100%;
          padding: 3px 9px; margin-bottom: 6px; box-sizing: border-box;
          border: 1px solid var(--border); border-radius: 999px;
          background: var(--bg-2); color: var(--fg-mute);
        }
        .pc-lloop__potfilter:focus-within { border-color: var(--accent); color: var(--fg); }
        .pc-lloop__potfilter input {
          flex: 1 1 auto; min-width: 0; border: 0; background: none; outline: none;
          color: var(--fg); font: inherit; font-size: 11px;
        }
        .pc-lloop__potfilter input::placeholder { color: var(--fg-mute); }
        /* Caps at ~5 rows and scrolls: the rail's own measurement puts the live
           workspace at 54 pots with a learning setup, so an uncapped list would
           run off the bottom of the screen. */
        .pc-lloop__potlist { max-height: 168px; overflow-y: auto; margin: 0 -2px; padding: 0 2px; }
        .pc-lloop__potrow {
          display: grid; grid-template-columns: minmax(0, 1fr) auto 52px 70px;
          gap: 9px; align-items: center; padding: 5px 0;
          border-bottom: 1px solid var(--border-muted, rgba(125, 211, 252, 0.08));
        }
        .pc-lloop__potrow:last-child { border-bottom: 0; }
        .pc-lloop__potlearning, .pc-lloop__potdream { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; align-self: start; }
        .pc-lloop__togglelabel { font-size: 10px; color: var(--fg-dim); }
        .pc-lloop__togglehint { font-size: 9px; line-height: 1.3; text-align: center; color: var(--fg-mute); overflow-wrap: anywhere; }
        .pc-lloop__togglehint[role=alert] { color: var(--bad); }
        .pc-lloop__potname {
          all: unset; cursor: pointer; min-width: 0;
          display: flex; flex-direction: column; gap: 1px;
        }
        .pc-lloop__potname > b {
          color: var(--fg); font-weight: 500; font-size: 11.5px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-lloop__potname:hover > b { color: var(--accent); }
        .pc-lloop__potname:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
        .pc-lloop__potsub { color: var(--fg-mute); font-size: 10px; white-space: nowrap; }
        .pc-lloop__potspend {
          color: var(--fg); font-size: 11px; white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .pc-lloop__potspend i { font-style: normal; color: var(--fg-mute); }
        .pc-lloop__potzero { color: var(--fg-mute); }
        .pc-lloop__potfix { all: unset; cursor: pointer; font-size: 10.5px; color: var(--accent); }
        .pc-lloop__potfix:disabled { cursor: default; color: var(--fg-mute); }
        .pc-lloop__potfix:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        /* ── one line, so the middle gives way ───────────────────────────── */
        /* The stepper and the controls are fixed; the verdict is what has room
           to lose, so it drops a clause at a time from the RIGHT, always
           keeping the part that answers the question. Each figure carries its
           own separator, so nothing leaves a dangling "·" behind. */
        @container learning (max-width: 1040px) {
          .pc-lloop__fig--lanes { display: none; }
        }
        @container learning (max-width: 840px) {
          .pc-lloop__fig--spend { display: none; }
        }
        @container learning (max-width: 700px) {
          .pc-lloop__figs { display: none; }
        }
        /* Below this the row genuinely cannot hold three things, so the verdict
           yields the line entirely rather than crushing the stepper. */
        @container learning (max-width: 560px) {
          .pc-lloop__verdict { display: none; }
        }
      `}</style>
    </div>
  );
}
