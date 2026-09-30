/**
 * SignalsPanel — the Observe-stage signals view, organized around the two
 * questions the owner actually asks (WI-5412 item 1, superseding the four-
 * section P-006 layout that interleaved trigger and feed concepts):
 *
 *   1. **Will it fire?** — the weighted score vs the volume gate's threshold,
 *      plus the 6 TRIGGER lanes as colored vertical cards (WI-5417 — each
 *      lane keeps a unique, stable CATEGORICAL hue so the row reads at a
 *      glance instead of as a wall of identical chips; docs stay in tooltips).
 *   2. **What will it read?** — the persisted digest a cycle was/will be
 *      prompted with: a BROWSEABLE per-cycle history (WI-5417 — the newest
 *      ~10 fired cycles, nuqs-selected via `?sdig=`), each showing NEW-since-
 *      last-cycle entries first (lane chip + drill-back source ref) with the
 *      standing corpus behind a disclosure.
 *
 * The standalone lane taxonomy lives behind an "All input lanes" disclosure,
 * grouped trigger-vs-fed as a two-column definition grid with each lane's
 * chip carrying its categorical color (WI-5417 item 4). All data still
 * derives from the `learning.scout` snapshot (the gate's own readers — never
 * a UI-side re-derivation).
 */
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { Rss, RefreshCw, HelpCircle } from "lucide-react";
import type { ScoutSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-scout-read";
import { Tooltip } from "@/app/harness/Tooltip";
import { Popover } from "@/app/harness/Popover";
import { CardStack } from "@papercusp/card-stack";
import { CATEGORICAL } from "@/app/harness/theme";
import {
  LearningDisclosure,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";

/** One-line description per TRIGGER (accumulator) lane — mirrors the
 *  signal-accumulator module docs; counts are "new since the last cycle". */
const TRIGGER_LANE_DOCS: Record<string, string> = {
  "scorecard-rating-changes":
    "A rubric criterion whose new grade DIFFERS from its previous one (a re-grade at the same rating is not signal; a first-ever grade is).",
  observations: "New agent-filed observations (engineer_issues rows carrying an observation).",
  captures: "New bug / feature / improvement filings (engineer_issues rows without an observation).",
  reverts: "Work released back after being claimed — bounced work is the revert-shaped signal.",
  deferrals: "Work items newly blocked / deprecated / needs-human — the colony getting stuck.",
  completions: "Work items reaching a terminal-success state.",
};

/** One-line description per FED (digest grounding) lane — what the corpus
 *  synthesis reads and ideas cite as grounding. Mirrors the FULL flattenDigest
 *  lane list (lenses.ts) — every lane the ideator prompt actually renders. */
const FED_LANE_DOCS: Record<string, string> = {
  corpus: "The standing MetaPattern corpus — recurring friction patterns distilled from the whole signal history.",
  "recurring-friction": "Recurring friction patterns — the same breakage/annoyance surfacing across many signals.",
  "time-token-sink": "Time / token sinks — where agent hours and LLM spend chronically pool.",
  "chronic-deferral": "Chronically deferred work — items the colony keeps pushing off.",
  "capability-gap": "Capability gaps — things agents repeatedly could not do.",
  "rubric-rating": "Rubric criterion grades — quality verdicts on live behavior.",
  "spend-anomaly": "Spend anomalies — cost spikes worth ideating on.",
  "niche-map": "The quality-diversity niche map — where idea-space is unexplored.",
  "standing-fact": "Standing facts (facts:assert) — durable conclusions agents have pinned.",
  "watchdog-health": "Watchdog health — chronic measured infrastructure signal from the 15-min collectors + standing open alarm conditions (watchdog_ticks).",
  "gate-pipeline-health": "Gate / pipeline health — release ship-path incidents: standing reds, promotion/deploy stalls, chronic pipeline failures.",
  "coord-health": "Coordination health — escalation storms, unanswered directed mail, inbox/wake floods, claim conflicts.",
  "tool-telemetry": "Tool telemetry — measured DX friction: per-tool error rates, arg-limit rejections, retry loops, chronic p95 latency.",
  "knowledge-reuse-gap": "Knowledge-reuse gaps — lessons that exist but keep not being found/applied.",
  "plan-health": "Plan-health signals — stalled / drifting plans.",
  "owner-correction": "Owner corrections — every time you redirect an agent, that becomes learning input.",
  "recent-commit": "Recent-commit churn hotspots — where the tree is actively morphing right now.",
};

// Every hue used below comes from the theme's fixed CATEGORICAL swatch set
// (never a hand-rolled color) — stable per-lane assignment so a lane keeps
// its color across renders/themes. 23 lanes over 19 swatches means a few
// hues repeat ACROSS the trigger/fed groups (never WITHIN one), which is
// fine — the two groups are never compared side-by-side in one glance.
const TRIGGER_LANE_COLOR: Record<string, string> = {
  "scorecard-rating-changes": CATEGORICAL.violet400.hex,
  observations: CATEGORICAL.blue400.hex,
  captures: CATEGORICAL.teal500.hex,
  reverts: CATEGORICAL.rose500.hex,
  deferrals: CATEGORICAL.amber500.hex,
  completions: CATEGORICAL.emerald400.hex,
};

const FED_LANE_COLOR: Record<string, string> = {
  corpus: CATEGORICAL.slate400.hex,
  "recurring-friction": CATEGORICAL.red400.hex,
  "time-token-sink": CATEGORICAL.orange500.hex,
  "chronic-deferral": CATEGORICAL.yellow500.hex,
  "capability-gap": CATEGORICAL.pink500.hex,
  "rubric-rating": CATEGORICAL.violet300.hex,
  "spend-anomaly": CATEGORICAL.lime500.hex,
  "niche-map": CATEGORICAL.teal300.hex,
  "standing-fact": CATEGORICAL.teal400.hex,
  "watchdog-health": CATEGORICAL.indigo400.hex,
  "gate-pipeline-health": CATEGORICAL.pink400.hex,
  "coord-health": CATEGORICAL.slate500.hex,
  "tool-telemetry": CATEGORICAL.green500.hex,
  "knowledge-reuse-gap": CATEGORICAL.violet400.hex,
  "plan-health": CATEGORICAL.blue400.hex,
  "owner-correction": CATEGORICAL.teal500.hex,
  "recent-commit": CATEGORICAL.rose500.hex,
};

const CATEGORICAL_HEXES = Object.values(CATEGORICAL).map((c) => c.hex);

/** Stable hash-derived fallback so a lane missing from the explicit maps
 *  above (a future addition to the open FED_LANE_DOCS set) still gets a
 *  consistent categorical color rather than crashing or reading grey. */
function hashLaneColor(lane: string): string {
  let h = 0;
  for (let i = 0; i < lane.length; i++) h = (h * 31 + lane.charCodeAt(i)) | 0;
  return CATEGORICAL_HEXES[Math.abs(h) % CATEGORICAL_HEXES.length];
}

function laneLabel(lane: string): string {
  return lane.replace(/-/g, " ");
}

/** Group digest entries by lane (owner ask 2026-07-19: "make the standing
 *  corpus cards stacked by their type"). Groups render in the CANONICAL
 *  FED_LANE_DOCS order with unknown lanes appended alphabetically — a stable
 *  stack that does not reshuffle between cycles as per-lane counts shift
 *  (count-ordering would make the same corpus look reorganized every tick). */
function groupByLane<T extends { lane: string }>(
  entries: readonly T[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const existing = groups.get(e.lane);
    if (existing) existing.push(e);
    else groups.set(e.lane, [e]);
  }
  const canonical = Object.keys(FED_LANE_DOCS);
  return [...groups.entries()].sort(([a], [b]) => {
    const ia = canonical.indexOf(a);
    const ib = canonical.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

/** One reference card per lane — the taxonomy rendered as cards rather than a
 *  definition grid (owner ask 2026-07-19). Shared by the trigger-lane and
 *  fed-lane groups so the two can never drift apart visually. */
function laneCards(
  docs: Record<string, string>,
  colors: Record<string, string>,
  ariaLabel: string,
) {
  return (
    <ul className="pc-signals__cards" aria-label={ariaLabel}>
      {Object.entries(docs).map(([lane, doc]) => (
        <li
          key={lane}
          className="pc-signals__card"
          style={
            { "--lane-color": colors[lane] ?? hashLaneColor(lane) } as CSSProperties
          }
        >
          <header className="pc-signals__card-head">
            <span className="pc-signals__lane">
              <i aria-hidden />
              {laneLabel(lane)}
            </span>
          </header>
          <p className="pc-signals__card-summary is-doc">{doc}</p>
        </li>
      ))}
    </ul>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? "—"
    : new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SignalsPanel({
  onStatus,
  active = true,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263: this view previously had no settle point
   *  at all, so a switch to it emitted a begin nothing ever ended). */
  active?: boolean;
} = {}) {
  // WI-5417: the browseable digest-history selection — which fired cycle's
  // full digest entries to show. null = newest (the server's default).
  const [sdig, setSdig] = useQueryState("sdig", parseAsString);
  // The full lane taxonomy is reference material — tucked behind a header "?"
  // popover (owner ask 2026-07-19) rather than an always-present section.
  const [lanesOpen, setLanesOpen] = useState(false);

  const sync = useSyncQuery<ScoutSnapshot>({
    queryName: "learning.scout",
    args: sdig ? { cycleId: sdig } : {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const cadence = snap?.cadence ?? null;
  const ranTicks = (snap?.ticks ?? []).filter((t) => t.status === "ran");
  // P-008/WI-5417: the SELECTED fired cycle's persisted digest (delta +
  // standing corpus) + the compact history of the newest ~10 cycles.
  const digest = snap?.digest ?? null;
  const digestHistory = snap?.digestHistory ?? [];

  // Digest source refs deep-link like the Ideas view's grounding chips: wi:
  // refs open the improvements backlog with that row selected.
  const [, setLviewRaw] = useQueryState("lview", parseAsString);
  const [, setLane] = useQueryState("lane", parseAsString);
  const [, setSrcSel] = useQueryState("lsrc", parseAsString);
  const [, setLsel] = useQueryState("lsel", parseAsString);
  const openImprovement = (id: string) => {
    void setLsel(id);
    void setLane(null);
    void setSrcSel(null);
    void setLviewRaw("improvements");
  };

  const status: "neutral" | "good" | "warn" | "bad" = sync.error
    ? "bad"
    : cadence == null && ranTicks.length === 0
      ? "neutral"
      : "good";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points (pipeline /
  // observations / improvements / learnings): gated on the PRIMARY read only,
  // settles on a fault as well as success, gated on `active` so a warm-but-
  // inactive pane (kept mounted per LearningTab's warmViews) doesn't emit on
  // a revisit that never remounts (EI-19383745196363732).
  const signalsSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    signalsSettled,
    active,
  );

  const renderSourceChip = (ref: string) => {
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "ref";
    const rest = sep > 0 ? ref.slice(sep + 1) : ref;
    if (kind === "wi") {
      return (
        <Tooltip label={`${rest} — open in Improvements`}>
          <button
            type="button"
            className="pc-signals__srcchip pc-signals__srcchip--link"
            onClick={() => openImprovement(rest)}
          >
            <i>{kind}</i>
            {rest}
          </button>
        </Tooltip>
      );
    }
    return (
      <span className="pc-signals__srcchip" title={ref}>
        <i>{kind}</i>
        {rest}
      </span>
    );
  };

  const scorePct =
    cadence && cadence.threshold > 0
      ? Math.min(100, Math.round((cadence.score / cadence.threshold) * 100))
      : 0;

  return (
    <section
      className="pc-learning__section pc-signals"
      aria-label="Learning pipeline input signals"
    >
      <LearningPageHeader
        icon={Rss}
        title="Signals"
        question="What is the learning pipeline being fed — and what will make it fire next?"
        action={
          <span className="pc-signals__headeractions">
            <Popover
              open={lanesOpen}
              onOpenChange={setLanesOpen}
              side="bottom"
              align="end"
              ariaLabel="All input lanes explained"
              tooltipLabel="What every input lane means"
              contentClassName="pc-signals__lanespopover"
              trigger={
                <button
                  type="button"
                  className="pc-learning__refresh"
                  aria-label="Explain all input lanes"
                  aria-expanded={lanesOpen}
                >
                  <HelpCircle size={13} aria-hidden />
                </button>
              }
            >
              <div className="pc-signals__taxonomygroup">
                <h4>Trigger lanes — what fires a cycle</h4>
                {laneCards(
                  TRIGGER_LANE_DOCS,
                  TRIGGER_LANE_COLOR,
                  "Trigger lanes explained",
                )}
              </div>
              <div className="pc-signals__taxonomygroup">
                <h4>Fed lanes — what the digest reads</h4>
                {laneCards(FED_LANE_DOCS, FED_LANE_COLOR, "Fed lanes explained")}
              </div>
            </Popover>
            <button
              type="button"
              className="pc-learning__refresh"
              aria-label="Reload signals"
              disabled={sync.fetching}
              onClick={() => sync.invalidate()}
            >
              <RefreshCw size={13} aria-hidden />
            </button>
          </span>
        }
      />
      {sync.error ? (
        <LearningVisualError
          title="The signals read failed"
          onRetry={() => sync.invalidate()}
        />
      ) : sync.loading && !snap ? (
        <p className="pc-learning__quietempty">Loading signal state…</p>
      ) : cadence == null && ranTicks.length === 0 ? (
        // WI-6410 (copy only — no behaviour, no data wiring; see the plan's
        // D-006). The old title was "No signal state recorded yet — the
        // accumulator sweep has not run on this workspace", which had the two
        // defects WI-6388 fixed everywhere else on this tab: "accumulator
        // sweep" is internal vocabulary, and the clause after the dash asserts a
        // CAUSE this branch cannot establish. The condition here is only
        // `cadence == null && no ticks`, which is equally consistent with a
        // fresh install, a paused loop, or a workspace with nothing to score.
        // State the observed condition; teach what makes data appear.
        <LearningVisualEmpty
          icon={Rss}
          title="No signal state recorded yet"
          body="This view shows which signals are building toward the next cycle, and whether they are strong enough to fire one. Signal state appears here once this workspace has recorded some."
        />
      ) : (
        <>
          {/* ── Half 1: Will it fire? ─────────────────────────────────── */}
          {cadence ? (
            <>
              <div className="pc-signals__sectionhead">
                <h3>Will it fire?</h3>
                <span>
                  the weighted score over the trigger lanes fires a cycle at ≥
                  {cadence.threshold}; zero signal withholds everything
                </span>
              </div>
              <div
                className="pc-signals__meter"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={cadence.threshold}
                aria-valuenow={cadence.score}
                aria-label="Cycle trigger score"
              >
                <span
                  className={`pc-signals__meterfill${scorePct >= 100 ? " is-armed" : ""}`}
                  style={{ width: `${scorePct}%` }}
                  aria-hidden
                />
                <strong>
                  {Math.round(cadence.score * 10) / 10} / {cadence.threshold}
                  {scorePct >= 100 ? " — fires next sweep" : ""}
                </strong>
              </div>
              <div
                className="pc-signals__triggergrid"
                aria-label="Trigger lanes — new signal since the last cycle"
              >
                {cadence.lanes.map((l) => {
                  const color = TRIGGER_LANE_COLOR[l.lane] ?? hashLaneColor(l.lane);
                  return (
                    <Tooltip
                      key={l.lane}
                      label={`${TRIGGER_LANE_DOCS[l.lane] ?? l.lane} Weight ×${l.weight} → contributes ${Math.round(l.count * l.weight * 10) / 10}.`}
                    >
                      <div
                        className={`pc-signals__triggercard${l.count > 0 ? " is-live" : ""}`}
                        style={{ "--lane-color": color } as CSSProperties}
                      >
                        <strong>{l.count}</strong>
                        <span>{laneLabel(l.lane)}</span>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* ── Half 2: What will it read? — browseable per-cycle history ── */}
          {digestHistory.length > 0 && digest ? (
            <>
              <div className="pc-signals__sectionhead">
                <h3>What will it read?</h3>
                <span
                  title="The persisted corpus digest a fired cycle's ideators were prompted with — browse the newest cycles below; the delta leg ('NEW since your last cycle') leads the prompt, exactly as shown here."
                >
                  {digestHistory.length} recent cycle
                  {digestHistory.length === 1 ? "" : "s"}
                </span>
              </div>
              <div
                className="pc-signals__historystrip"
                role="tablist"
                aria-label="Digest history — browse recent cycles"
              >
                {digestHistory.map((h, i) => {
                  const isNewest = i === 0;
                  const isSelected = h.cycleId === digest.cycleId;
                  return (
                    <button
                      key={h.cycleId ?? h.at ?? `history-${i}`}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`pc-signals__historytab${isSelected ? " is-selected" : ""}`}
                      onClick={() => void setSdig(isNewest ? null : h.cycleId)}
                    >
                      <span>{formatTime(h.at)}</span>
                      <em>
                        {h.totalEntries}
                        {h.newCount > 0 ? ` · ${h.newCount} new` : ""}
                      </em>
                    </button>
                  );
                })}
              </div>
              <p className="pc-signals__digest-meta">
                {digest.totalEntries} entries
                {digest.cycleId ? ` · ${digest.cycleId}` : ""}
                {digest.at ? ` · ${formatTime(digest.at)}` : ""}
              </p>
              {digest.newEntries.length > 0 ? (
                // The delta leg as per-lane DECKS too (owner ask 2026-07-19c:
                // "convert What will it read? to cards") — same grouping the
                // standing corpus uses; the NEW flag rides each deck's badge.
                <div
                  className="pc-signals__cardstack"
                  aria-label="New digest entries since the previous cycle"
                >
                  {groupByLane(digest.newEntries).map(([lane, entries]) => (
                    <section
                      key={`new-${lane}`}
                      className="pc-signals__lanegroup"
                      style={
                        {
                          "--lane-color":
                            FED_LANE_COLOR[lane] ?? hashLaneColor(lane),
                        } as CSSProperties
                      }
                    >
                      <CardStack
                        items={entries}
                        getKey={(e) => e.ref}
                        ariaLabel={`New ${laneLabel(lane)} entries`}
                        accent={FED_LANE_COLOR[lane] ?? hashLaneColor(lane)}
                        header={
                          <>
                            <Tooltip label={FED_LANE_DOCS[lane] ?? lane}>
                              <span className="pc-signals__lane">
                                <i aria-hidden />
                                {laneLabel(lane)}
                              </span>
                            </Tooltip>
                            <span className="pc-signals__newflag">new</span>
                            <span className="pc-cardstack__header-count">
                              {entries.length}
                            </span>
                          </>
                        }
                        renderCard={(e) => (
                          <div className="pc-signals__card pc-signals__card--stacked">
                            <p className="pc-signals__card-summary">
                              {e.summary}
                            </p>
                            {renderSourceChip(e.ref)}
                          </div>
                        )}
                      />
                    </section>
                  ))}
                </div>
              ) : (
                <p className="pc-signals__digest-none">
                  No new entries vs the previous cycle — the delta leg was
                  empty; the cycle ran on standing corpus.
                </p>
              )}
              {digest.standingEntries.length > 0 ? (
                <LearningDisclosure
                  label="Standing corpus"
                  count={digest.standingEntries.length}
                >
                  <div className="pc-signals__cardstack">
                    {groupByLane(digest.standingEntries).map(
                      ([lane, entries]) => (
                        <section
                          key={lane}
                          className="pc-signals__lanegroup"
                          style={
                            {
                              "--lane-color":
                                FED_LANE_COLOR[lane] ?? hashLaneColor(lane),
                            } as CSSProperties
                          }
                        >
                          {/* One overlapping DECK per lane (@papercusp/card-stack):
                              same-type entries browsed one at a time — the lane
                              badge rides the active card, the count is the
                              stack depth. The uncapped corpus stays compact. */}
                          <CardStack
                            items={entries}
                            getKey={(e) => e.ref}
                            ariaLabel={`${laneLabel(lane)} standing entries`}
                            accent={FED_LANE_COLOR[lane] ?? hashLaneColor(lane)}
                            header={
                              <>
                                <Tooltip label={FED_LANE_DOCS[lane] ?? lane}>
                                  <span className="pc-signals__lane">
                                    <i aria-hidden />
                                    {laneLabel(lane)}
                                  </span>
                                </Tooltip>
                                <span className="pc-cardstack__header-count">
                                  {entries.length}
                                </span>
                              </>
                            }
                            renderCard={(e) => (
                              <div className="pc-signals__card pc-signals__card--stacked">
                                <p className="pc-signals__card-summary">
                                  {e.summary}
                                </p>
                                {renderSourceChip(e.ref)}
                              </div>
                            )}
                          />
                        </section>
                      ),
                    )}
                  </div>
                </LearningDisclosure>
              ) : null}
            </>
          ) : null}
        </>
      )}
      <style>{`
      /* Section headers you can actually SEE (owner ask 2026-07-19c): real
         heading size + full foreground, the explainer readable beside it. */
      .pc-signals__sectionhead {
        display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 16px 2px 8px;
      }
      .pc-signals__sectionhead h3 {
        margin: 0; font-size: 13px; font-weight: 740; text-transform: uppercase;
        color: var(--fg, #e7eef5);
      }
      .pc-signals__sectionhead > span { font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8); }
      .pc-signals__meter {
        position: relative; height: 22px; border-radius: 6px; overflow: hidden;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
        display: flex; align-items: center;
      }
      .pc-signals__meterfill {
        position: absolute; inset: 0 auto 0 0;
        background: color-mix(in srgb, var(--accent, #7dd3fc) 22%, transparent);
        transition: width 200ms ease;
      }
      .pc-signals__meterfill.is-armed { background: color-mix(in srgb, var(--good, #34d399) 28%, transparent); }
      .pc-signals__meter strong {
        position: relative; padding: 0 9px; font-size: 11px; font-weight: 700;
        color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
      }
      .pc-signals__triggergrid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
        gap: 6px; margin-top: 6px;
      }
      .pc-signals__triggercard {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 3px; min-height: 52px; padding: 7px 5px; border-radius: 8px; text-align: center;
        border: 1px solid color-mix(in srgb, var(--lane-color) 28%, var(--border));
        background: color-mix(in srgb, var(--lane-color) 6%, var(--bg-2));
        color: var(--fg-mute, #7f9bb4); cursor: default;
      }
      .pc-signals__triggercard.is-live {
        border-color: color-mix(in srgb, var(--lane-color) 55%, transparent);
        background: color-mix(in srgb, var(--lane-color) 13%, var(--bg-2));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-signals__triggercard strong {
        font-size: 15px; font-weight: 760; line-height: 1; font-variant-numeric: tabular-nums;
        color: var(--lane-color);
      }
      .pc-signals__triggercard span { font-size: 9.5px; line-height: 1.2; }
      .pc-signals__historystrip {
        display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px;
      }
      .pc-signals__historytab {
        display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px;
        padding: 3px 8px; border-radius: 7px; cursor: pointer; font: inherit;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-signals__historytab:hover { color: var(--fg-dim, #b9d4e8); border-color: color-mix(in srgb, var(--accent, #7dd3fc) 35%, var(--border)); }
      .pc-signals__historytab.is-selected {
        color: var(--fg, #e7eef5); border-color: color-mix(in srgb, var(--accent, #7dd3fc) 55%, transparent);
        background: color-mix(in srgb, var(--accent, #7dd3fc) 10%, var(--bg-2));
      }
      .pc-signals__historytab span { font-size: 10px; font-variant-numeric: tabular-nums; }
      .pc-signals__historytab em { font-style: normal; font-size: 9px; opacity: .82; }
      .pc-signals__digest-meta { margin: 6px 2px 4px; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-signals__taxonomygroup { margin-bottom: 8px; }
      .pc-signals__taxonomygroup:last-child { margin-bottom: 0; }
      .pc-signals__taxonomygroup h4 {
        margin: 4px 2px 4px; font-size: 9.5px; font-weight: 700; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-signals__headeractions { display: inline-flex; align-items: center; gap: 4px; }
      /* The lane-taxonomy popover: reference material anchored under the "?"
         header button (owner ask 2026-07-19). Bounded + scrollable so the full
         23-lane set never pushes the panel around. */
      .pc-signals__lanespopover {
        width: min(420px, 90vw); max-height: min(60vh, 520px); overflow-y: auto;
        padding: 12px 13px; border-radius: 10px;
        background: var(--bg-1, #0f1720);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.45);
      }
      .pc-signals__lanespopover .pc-signals__cards { grid-template-columns: 1fr; }
      /* Card grid (owner ask 2026-07-19): the digest entries and the lane
         taxonomy read as CARDS rather than dense rows — each card carries its
         lane accent on the left edge so type is legible at a glance, and the
         summary wraps to 3 lines instead of being ellipsized to one. */
      .pc-signals__cards {
        list-style: none; margin: 0; padding: 0;
        display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px;
      }
      .pc-signals__card {
        display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
        padding: 8px 10px; border-radius: 8px; font-size: 11px;
        color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
        border-left: 3px solid var(--lane-color, var(--border, rgba(125, 211, 252, 0.12)));
        background: color-mix(in srgb, var(--lane-color, transparent) 4%, transparent);
      }
      .pc-signals__card.is-new {
        border-color: color-mix(in srgb, var(--accent, #7dd3fc) 30%, transparent);
        border-left-color: var(--lane-color, var(--accent, #7dd3fc));
      }
      .pc-signals__card-head { display: flex; align-items: center; gap: 6px; width: 100%; }
      .pc-signals__card-summary {
        margin: 0; font-size: 11px; line-height: 1.45; width: 100%;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
      }
      .pc-signals__card-summary.is-doc { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-signals__newflag {
        margin-left: auto; padding: 0 6px; border-radius: 999px;
        font-size: 9px; font-weight: 700; text-transform: uppercase;
        color: var(--accent, #7dd3fc);
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 40%, transparent);
      }
      /* Standing corpus: one overlapping card DECK per lane (owner ask 3b +
         card-system migration 2026-07-19) — the lane badge rides the active
         card, and the full (uncapped) summary shows while browsing. */
      .pc-signals__cardstack {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }
      .pc-signals__lanegroup { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .pc-signals__card--stacked { padding: 12px 14px 14px; }
      .pc-signals__card--stacked .pc-signals__card-summary {
        display: block; overflow: visible; -webkit-line-clamp: unset;
      }
      @media (max-width: 900px) {
        .pc-signals__cards { grid-template-columns: 1fr; }
      }
      .pc-signals__lane { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; color: var(--lane-color, var(--fg-mute)); }
      .pc-signals__lane i { width: 7px; height: 7px; border-radius: 50%; background: var(--lane-color); flex: none; }
      .pc-signals__fedchip {
        display: inline-flex; gap: 4px; padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); font-size: 10px;
        white-space: nowrap;
      }
      .pc-signals__digest { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .pc-signals__digest li {
        display: flex; align-items: baseline; gap: 7px; padding: 3px 8px;
        border-radius: 6px; font-size: 11px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.10));
      }
      .pc-signals__digest li.is-new { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 35%, transparent); }
      .pc-signals__digest li .pc-signals__fedchip { flex-shrink: 0; }
      .pc-signals__digest-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-signals__digest-none { margin: 2px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-signals__srcchip {
        display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 7px;
        border-radius: 999px; font-size: 10px; flex-shrink: 0;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        color: var(--fg-mute, #7f9bb4); background: none;
        max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-signals__srcchip i { font-style: normal; opacity: 0.7; }
      .pc-signals__srcchip--link { cursor: pointer; }
      .pc-signals__srcchip--link:hover { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent); color: var(--fg-dim, #b9d4e8); }
      `}</style>
    </section>
  );
}
