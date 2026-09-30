/**
 * AnalyzePanel — the Analyze-stage "what happens inside idea generation?" view
 * (learning-tab-visibility-2026-07-18 P-009 / D-001, owner ask 2026-07-18:
 * "I want the user to be able to see the advanced things happening as part of
 * idea generation, I dont want to hide it").
 *
 * One disclosure per fired cycle (newest first, `learning.analyze` snapshot —
 * migration 623 stage artifacts joined to tick economics + routed rows):
 *
 *   1. Ideation roster — per-slot ideator outcomes + the raw per-ideator
 *      ideas, each with the creative lens it rode.
 *   2. Adversarial critique — every idea's keep/moonshot/reject verdict,
 *      novelty/feasibility scores, and the critics' notes.
 *   3. Fusions — debate/recombine proposals with their source-idea chains and
 *      the routed artifact each became (the same refs the Ideas view traces).
 *
 * Self-contained (own sync query + pc-analyze__* styles, the panel idiom).
 * Cycle bodies live inside Radix Collapsible (LearningDisclosure) so closed
 * cycles stay UNMOUNTED — 8 full pipelines never render at once.
 */
import { useEffect } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { Workflow, RefreshCw, CheckCircle2, CircleDashed } from "lucide-react";
import type {
  AnalyzeSnapshot,
  AnalyzeCycle,
  AnalyzeCycleSummary,
} from "@papercusp/operator-core/lib/sync-resolver/learning-analyze-read";
import { CardStack } from "@papercusp/card-stack";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import { Tooltip } from "@/app/harness/Tooltip";
import { CATEGORICAL } from "@/app/harness/theme";
import { useLexicon } from "@/lib/useLexicon";
import {
  LearningDisclosure,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";
import { snapshotFault } from "./snapshot-fault";
import { DreamPanel } from "./DreamPanel";

function cycleWhen(at: string | null): string {
  const ms = at ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** Compact funnel summary for the cycle disclosure label (P-007: computed from
 *  the lightweight cycle SUMMARY — counts + verdicts — not the full artifacts). */
function cycleSummary(c: AnalyzeCycleSummary): string {
  const kept = c.verdicts.filter((v) => v === "keep").length;
  const moon = c.verdicts.filter((v) => v === "moonshot").length;
  const parts = [
    `${c.ideasCount} ideas`,
    c.verdicts.length > 0 ? `${kept} keep · ${moon} moonshot` : null,
    `${c.proposalsCount} fusions`,
    `${c.routedCount} routed`,
  ].filter(Boolean);
  const spend = c.tick?.spendUsd;
  return `${cycleWhen(c.at)} — ${parts.join(" → ")}${spend != null ? ` · $${spend.toFixed(2)}` : ""}`;
}

export function AnalyzePanel({
  onStatus,
  active = true,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED learning view. LearningTab keeps warm
   *  panes mounted and only flips `hidden`, so the settle point needs this to
   *  fire on a revisit that does not remount (EI-19383745196363732). */
  active?: boolean;
} = {}) {
  const t = useLexicon();
  const sync = useSyncQuery<AnalyzeSnapshot>({
    queryName: "learning.analyze",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const cycles = snap?.cycles ?? [];
  // WI-6410: `sync.error` alone covers only the TRANSPORT half. When the
  // resolver catches its own read failure it RESOLVES successfully with a
  // degraded payload — sync.error is falsy, cycles is [], and the view claimed
  // "No analysis cycles yet". snapshotFault reads both halves; it is the same
  // helper this file already uses one function below for learning.analyzeCycle.
  const fault = snapshotFault(sync.error, snap, "Pipeline");

  const status: "neutral" | "good" | "warn" | "bad" = sync.error
    ? "bad"
    : cycles.length === 0
      ? "neutral"
      : "good";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — the interaction
  // LearningTab begins when the view changes (EI-19375505819043214: the owner
  // named THIS view as taking several seconds to expand).
  //
  // The settle is "the loading artifacts are gone", not "the data is good": we
  // end once the read is no longer in flight and the panel is showing its final
  // content — a resolved snapshot OR a fault. Ending only on success would
  // leave a failed read's start mark dangling until STALE_START_MS discarded
  // it, so a slow FAILING view — exactly what the owner saw — would silently
  // measure nothing.
  //
  // endInteraction is measure-once and no-ops without a matching begin, so this
  // is inert on a first mount or any render that did not follow a view switch.
  //
  // Gated on `active` as well as `settled`: this pane is kept MOUNTED when the
  // user switches away (LearningTab's warmViews), so on a revisit `settled` is
  // already true and never changes — an effect keyed on it alone would never
  // re-run and the switch would measure nothing (EI-19383745196363732).
  const settled = !sync.loading && (snap !== undefined || Boolean(fault));
  useInteractionSettle(PERF_INTERACTIONS.learningViewSwitch, settled, active);

  return (
    <section
      className="pc-learning__section pc-analyze"
      aria-label="Idea-generation pipeline per cycle"
    >
      <LearningPageHeader
        icon={Workflow}
        title="Pipeline"
        question={`What actually happens inside ${t("scout")} idea generation — per fired cycle?`}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload pipeline artifacts"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      <DreamPanel active={active} />
      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Pipeline unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : sync.loading && !snap ? (
        <p className="pc-learning__quietempty">Loading cycle artifacts…</p>
      ) : cycles.length === 0 ? (
        // WI-6388: was "…they land when the next <scout> cycle fires with the
        // stage-artifact persist live on this host" — internal vocabulary, and
        // a cause this branch cannot establish (see the note in FrontierPanel).
        // State the user-visible condition instead.
        <LearningVisualEmpty
          icon={Workflow}
          title="No analysis cycles yet"
          body={`This view shows what each ${t("scout")} analysis cycle produced, stage by stage. A cycle appears here after the next one finishes.`}
        />
      ) : (
        <div className="pc-analyze__cycles">
          {cycles.map((c, i) => (
            <LearningDisclosure
              key={c.cycleId}
              label={cycleSummary(c)}
              defaultOpen={i === 0}
            >
              {/* P-007: the full artifacts load on demand — this body only mounts
                  when the disclosure is open (Radix Collapsible unmounts closed
                  cycles), so its own single-cycle sync query fires per expand
                  instead of learning.analyze shipping all 8 pipelines up-front. */}
              <CycleDetailLoader cycleId={c.cycleId} />
            </LearningDisclosure>
          ))}
        </div>
      )}
      <style>{`
      .pc-analyze__cycles { display: flex; flex-direction: column; gap: 8px; }
      /* Per-cycle expanders: the raised-heading treatment is now the GLOBAL
         LearningDisclosure style (LearningVisuals) — cycle labels just wrap. */
      .pc-analyze__cycles .pc-learning-visual__disclosure-label { white-space: normal; }
      /* One overlapping deck per lens, per run (owner ask 2026-07-19). */
      .pc-analyze__lensstacks {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px; margin-top: 6px;
      }
      .pc-analyze__lensgroup { display: flex; flex-direction: column; min-width: 0; }
      /* The fusions deck spans the full row — fusion cards carry experiments
         and source chains, so they want the width. */
      .pc-analyze__lensstacks--fusions { grid-template-columns: 1fr; }
      .pc-analyze__ideacard {
        display: flex; flex-direction: column; gap: 6px; padding: 0 13px 12px;
        font-size: 12px; color: var(--fg, #e7eef5);
      }
      /* Accent header band (design pass 2026-07-19f) — the verdict/meta row
         rides a category-tinted strip, matching the Ideas cards. */
      .pc-analyze__ideacard > .pc-analyze__row:first-child {
        margin: 0 -13px 2px; padding: 8px 13px 7px;
        background: linear-gradient(
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 10%, transparent),
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 3%, transparent));
        border-bottom: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 16%, var(--border, rgba(125, 211, 252, 0.16)));
      }
      .pc-analyze__ideatitle {
        font-size: 12.5px; font-weight: 660; line-height: 1.4;
        color: var(--fg, #e7eef5); overflow-wrap: anywhere;
      }
      .pc-analyze__notes {
        margin: 0; font-size: 11px; line-height: 1.5; color: var(--fg-dim, #b9d4e8);
        border-left: 2px solid color-mix(in srgb, var(--accent, #7dd3fc) 35%, transparent);
        padding-left: 8px;
      }
      .pc-analyze__notes b { font-weight: 660; color: var(--fg, #e7eef5); }
      /* Ref chips: fixed width + end-ellipsis — the raw id is never needed in
         full on the card (owner ask 2026-07-19e); tooltip carries it. */
      .pc-analyze__chip--ref { max-width: 190px; }
      .pc-analyze__chip-text {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-analyze__sectionhead {
        display: flex; align-items: baseline; gap: 10px; margin: 12px 2px 6px;
      }
      .pc-analyze__sectionhead h4 {
        margin: 0; font-size: 13px; font-weight: 740; text-transform: uppercase;
        color: var(--fg, #e7eef5);
      }
      .pc-analyze__sectionhead > span { font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8); }
      .pc-analyze__slots { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
      /* Compact squared chips, NOT giant pills (owner report 2026-07-19c: the
         roster ovals above the decks read as broken progress indicators). */
      .pc-analyze__slots li {
        display: inline-flex; align-items: baseline; gap: 5px; padding: 1px 7px;
        border-radius: 6px; font-size: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-analyze__slots li.is-failed { color: var(--fg-mute, #7f9bb4); border-style: dashed; }
      .pc-analyze__slots li em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-analyze__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      /* Cards sit on an ELEVATED surface (owner ask 2026-07-19: card text was
         unreadable) — content rides real contrast, not muted-on-transparent. */
      .pc-analyze__list li {
        padding: 8px 11px; border-radius: 8px; font-size: 12px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.035));
        color: var(--fg, #e7eef5);
      }
      .pc-analyze__row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
      .pc-analyze__row strong { font-weight: 660; color: var(--fg, #e7eef5); }
      .pc-analyze__chip {
        display: inline-flex; gap: 4px; padding: 1px 8px; border-radius: 6px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.24)); font-size: 10px; font-weight: 600;
        color: var(--fg-dim, #b9d4e8); white-space: nowrap;
      }
      .pc-analyze__chip.is-keep { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 55%, transparent); background: color-mix(in srgb, var(--good, #34d399) 12%, transparent); }
      .pc-analyze__chip.is-moonshot { color: var(--accent, #7dd3fc); border-color: color-mix(in srgb, var(--accent, #7dd3fc) 55%, transparent); background: color-mix(in srgb, var(--accent, #7dd3fc) 12%, transparent); }
      .pc-analyze__chip.is-reject { color: var(--fg-mute, #7f9bb4); opacity: 0.9; }
      .pc-analyze__scores { font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-analyze__body { margin: 5px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--fg-dim, #b9d4e8); }
      .pc-analyze__mech { margin: 4px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--fg-dim, #b9d4e8); font-style: italic; }
      .pc-analyze__exp {
        margin: 6px 0 0; padding: 7px 10px; border-radius: 6px; font-size: 11px; line-height: 1.55;
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 22%, var(--border));
        background: color-mix(in srgb, var(--accent, #7dd3fc) 6%, transparent);
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-analyze__exp b { font-weight: 660; color: var(--fg, #e7eef5); }
      .pc-analyze__sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
      .pc-analyze__routedref { color: var(--good); }
      .pc-analyze__complete {
        display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
        padding: 5px 8px; border-radius: 6px; margin-bottom: 2px;
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.16));
      }
      .pc-analyze__completemark {
        display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
        border-radius: 6px; font-size: 10px; color: var(--fg-mute, #7f9bb4);
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.18));
      }
      .pc-analyze__completemark.is-present {
        border-style: solid; color: var(--good, #34d399);
        border-color: color-mix(in srgb, var(--good, #34d399) 35%, transparent);
      }
      .pc-analyze__completewhen { margin-left: auto; font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-analyze__chip--link { cursor: pointer; background: none; }
      .pc-analyze__chip--link:hover { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent); color: var(--fg-dim, #b9d4e8); }
      .pc-analyze__chip--ungrounded { border-style: dashed; opacity: 0.8; }
      `}</style>
    </section>
  );
}

/** One stage's persistence verdict for the completeness row (WI-5412 item 2):
 *  stage-artifact persistence is best-effort, so a cycle can legitimately be
 *  missing pieces — the row SAYS which, replacing ambiguous empty sections. */
function CompletenessMark({
  label,
  present,
  detail,
}: {
  label: string;
  present: boolean;
  detail: string;
}) {
  return (
    <Tooltip
      label={
        present
          ? `${detail} — persisted for this cycle.`
          : `${detail} — NOT persisted for this cycle (stage-artifact capture is best-effort; a missing stage is a recording gap, not necessarily a pipeline gap).`
      }
    >
      <span
        className={`pc-analyze__completemark${present ? " is-present" : ""}`}
      >
        {present ? (
          <CheckCircle2 size={10} aria-hidden />
        ) : (
          <CircleDashed size={10} aria-hidden />
        )}
        {label}
      </span>
    </Tooltip>
  );
}

/** Stable category color per lens (owner ask 2026-07-19d — deck accents follow
 *  the CATEGORY): hash into the theme's fixed categorical swatches, the same
 *  scheme the Ideas view + SignalsPanel use. */
const CATEGORICAL_HEXES = Object.values(CATEGORICAL).map((c) => c.hex);
function lensColor(lens: string): string {
  let h = 0;
  for (let i = 0; i < lens.length; i++) h = (h * 31 + lens.charCodeAt(i)) | 0;
  return CATEGORICAL_HEXES[Math.abs(h) % CATEGORICAL_HEXES.length];
}

/** Group a cycle's raw ideas by their creative lens — biggest lens first, so
 *  the dominant decks lead (mirrors the Ideas view's lens stacks). */
function groupIdeasByLens<T extends { lens?: string | null } | null | undefined>(
  ideas: readonly T[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const idea of ideas) {
    const lens = (idea && idea.lens) || "unknown";
    const bucket = groups.get(lens);
    if (bucket) bucket.push(idea);
    else groups.set(lens, [idea]);
  }
  return [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
}

/** P-007: on-demand loader for one cycle's FULL artifacts. Mounts only when its
 *  parent disclosure is open (Radix unmounts closed cycles), so this single-cycle
 *  sync query fires per expand — learning.analyze itself ships only the summary. */
// Exported for AnalyzePanel.test.tsx: its three states (fault / in-flight /
// genuinely empty) are only reachable by driving this loader directly — the
// parent mounts it behind a Radix disclosure, and testing through that would
// assert on the disclosure, not on the state machine that actually broke.
export function CycleDetailLoader({ cycleId }: { cycleId: string }) {
  const sync = useSyncQuery<AnalyzeCycle>({
    queryName: "learning.analyzeCycle",
    args: { cycleId },
    staleTime: 30_000,
  });
  const cycle = sync.data?.[0];
  // WI-6395. Three states used to collapse into two, and the collapse was the
  // bug: `sync.error` covered TRANSPORT failure only, because the resolver
  // catches a data-layer failure and returns a successful empty — so a broken
  // read fell through to `!cycle` and rendered "Loading cycle artifacts…"
  // FOREVER. A permanent fake spinner is worse than a wrong empty state: it
  // tells the reader to keep waiting for something that already failed, and
  // nothing in the UI will ever change. The resolver now tags its degraded
  // return, so all three states are separable here.
  const fault = snapshotFault(sync.error, cycle, "This cycle's artifacts");
  if (fault.failed) {
    return (
      <LearningVisualError
        title={fault.message ?? "This cycle's artifacts failed to load"}
        onRetry={() => sync.invalidate()}
      />
    );
  }
  if (!cycle) {
    // Only claim to be loading while a read is genuinely in flight.
    return sync.loading ? (
      <p className="pc-learning__quietempty">Loading cycle artifacts…</p>
    ) : (
      <p className="pc-learning__quietempty">
        This cycle recorded no artifacts — its generation ran but stored nothing
        to show.
      </p>
    );
  }
  return <CycleDetail cycle={cycle} />;
}

function CycleDetail({ cycle }: { cycle: AnalyzeCycle }) {
  const t = useLexicon();
  const ideaTitle = (id: string): string =>
    cycle.ideas.find((idea) => idea?.id === id)?.title ?? id;
  // Critique verdicts joined onto their idea's card (the second "Adversarial
  // critique" list collapsed into the decks — owner ask 2026-07-19).
  const scoredById = new Map(
    cycle.scored
      .filter((s) => s?.idea?.id)
      .map((s) => [s.idea.id, s] as const),
  );
  // Grounding chips (WI-5412 item 2): each idea's addressesPatternRefs — the
  // digest signals it targeted. wi: refs deep-link to the Improvements backlog.
  const [, setLviewRaw] = useQueryState("lview", parseAsString);
  const [, setLane] = useQueryState("lane", parseAsString);
  const [, setSrcSel] = useQueryState("lsrc", parseAsString);
  const [, setLsel] = useQueryState("lsel", parseAsString);
  const renderGroundingChip = (ref: string) => {
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "ref";
    const rest = sep > 0 ? ref.slice(sep + 1) : ref;
    if (kind === "wi") {
      return (
        <Tooltip key={ref} label={`${rest} — open in Improvements`}>
          <button
            type="button"
            className="pc-analyze__chip pc-analyze__chip--link pc-analyze__chip--ref"
            onClick={() => {
              void setLsel(rest);
              void setLane(null);
              void setSrcSel(null);
              void setLviewRaw("improvements");
            }}
          >
            ⊙ <span className="pc-analyze__chip-text">{rest}</span>
          </button>
        </Tooltip>
      );
    }
    return (
      <span key={ref} className="pc-analyze__chip pc-analyze__chip--ref" title={ref}>
        ⊙ <span className="pc-analyze__chip-text">{rest}</span>
      </span>
    );
  };
  const cycleAtMs = cycle.at ? Date.parse(cycle.at) : NaN;
  return (
    <div>
      {/* Explicit completeness row — which stages this cycle actually persisted. */}
      <div className="pc-analyze__complete" aria-label="Cycle completeness">
        <CompletenessMark
          label="roster"
          present={cycle.ideatorSlots.length > 0}
          detail="Per-slot ideator outcomes"
        />
        <CompletenessMark
          label="ideas"
          present={cycle.ideas.length > 0}
          detail="Raw per-ideator ideas"
        />
        <CompletenessMark
          label="critique"
          present={cycle.scored.length > 0}
          detail="Adversarial critique verdicts"
        />
        <CompletenessMark
          label="fusions"
          present={cycle.proposals.length > 0}
          detail="Debate/recombine proposals"
        />
        <CompletenessMark
          label="routing"
          present={cycle.routed.length > 0}
          detail="Routed-ledger rows"
        />
        {!Number.isNaN(cycleAtMs) ? (
          <em
            className="pc-analyze__completewhen"
            title="When the cycle's artifacts landed (≈ cycle completion)"
          >
            {new Date(cycleAtMs).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </em>
        ) : null}
      </div>

      <div className="pc-analyze__sectionhead">
        <h4>Step 1 · Ideas generated</h4>
        <span>
          one deck per creative lens; each idea's card carries the critics'
          keep / moonshot / reject verdict
        </span>
      </div>
      {cycle.ideatorSlots.length > 0 ? (
        <ul className="pc-analyze__slots" aria-label="Ideator roster slots">
          {cycle.ideatorSlots.map((s, i) => (
            <li
              key={`${s?.lens ?? "slot"}-${i}`}
              className={s?.ok === false ? "is-failed" : undefined}
              title={s?.error ?? undefined}
            >
              <strong>{s?.lens ?? "?"}</strong>
              <em>
                {s?.ok === false
                  ? `failed${s?.error ? " — hover" : ""}`
                  : `${s?.raw ?? 0} raw → ${s?.produced ?? 0}`}
              </em>
            </li>
          ))}
        </ul>
      ) : null}
      {cycle.ideas.length > 0 ? (
        // The card system, per run (owner ask 2026-07-19): this cycle's ideas
        // grouped into one overlapping deck per lens; the critique verdict +
        // scores + notes ride each idea's card instead of a second list.
        <div className="pc-analyze__lensstacks">
          {groupIdeasByLens(cycle.ideas).map(([lens, ideas]) => (
            <section
              key={lens}
              className="pc-analyze__lensgroup"
              aria-label={`${lens} ideas this cycle`}
            >
              <CardStack
                items={ideas}
                getKey={(idea, i) => idea?.id ?? `idea-${i}`}
                ariaLabel={`${lens} ideas this cycle`}
                accent={lensColor(lens)}
                header={
                  <>
                    <span className="pc-cardstack__header-label">{lens}</span>
                    <span className="pc-cardstack__header-count">
                      {ideas.length}
                    </span>
                  </>
                }
                renderCard={(idea) => {
                  const s = idea?.id ? scoredById.get(idea.id) : undefined;
                  return (
                    <div className="pc-analyze__ideacard">
                      <div className="pc-analyze__row">
                        {s ? (
                          <span
                            className={`pc-analyze__chip is-${s.verdict ?? "reject"}`}
                          >
                            {s.verdict ?? "?"}
                          </span>
                        ) : (
                          <span
                            className="pc-analyze__chip pc-analyze__chip--ungrounded"
                            title="No critique verdict persisted for this idea."
                          >
                            no verdict
                          </span>
                        )}
                        {s ? (
                          <span className="pc-analyze__scores">
                            novelty {Math.round((s.novelty ?? 0) * 100)} ·
                            feasibility {Math.round((s.feasibility ?? 0) * 100)}
                          </span>
                        ) : null}
                      </div>
                      <strong className="pc-analyze__ideatitle">
                        {idea?.title ?? idea?.id ?? "(untitled idea)"}
                      </strong>
                      {idea?.body ? (
                        <p className="pc-analyze__body">{idea.body}</p>
                      ) : null}
                      {idea?.mechanism ? (
                        <p className="pc-analyze__mech">{idea.mechanism}</p>
                      ) : null}
                      {s?.notes ? (
                        <p className="pc-analyze__notes">
                          <b>Critics:</b> {s.notes}
                        </p>
                      ) : null}
                      {Array.isArray(idea?.addressesPatternRefs) &&
                      idea.addressesPatternRefs.length > 0 ? (
                        <div
                          className="pc-analyze__sources"
                          aria-label="Grounding — the signals this idea addresses"
                        >
                          {idea.addressesPatternRefs.map(renderGroundingChip)}
                        </div>
                      ) : (
                        <div className="pc-analyze__sources">
                          <span
                            className="pc-analyze__chip pc-analyze__chip--ungrounded"
                            title="No grounding refs recorded — the critics weigh ungroundedness against the idea."
                          >
                            ungrounded
                          </span>
                        </div>
                      )}
                    </div>
                  );
                }}
              />
            </section>
          ))}
        </div>
      ) : (
        <p className="pc-learning__quietempty">
          No raw ideas persisted for this cycle
          {cycle.scored.length > 0
            ? ` (${cycle.scored.length} critique verdicts exist without their raw ideas)`
            : ""}
          .
        </p>
      )}

      <div className="pc-analyze__sectionhead">
        <h4>Step 2 · Fused proposals</h4>
        <span>
          the ideas that survived Step 1, merged into concrete bets — each
          carries a falsifiable first experiment, and these are what route into
          the {t("pot", { lower: true })}'s work
        </span>
      </div>
      {cycle.proposals.length > 0 ? (
        // Fusions as their own deck too — everything in Analyze is a card
        // (owner ask 2026-07-19b).
        <div className="pc-analyze__lensstacks pc-analyze__lensstacks--fusions">
          <section
            className="pc-analyze__lensgroup"
            aria-label="Recombined proposals"
          >
            <CardStack
              items={cycle.proposals}
              getKey={(p, i) => p?.id ?? `fusion-${i}`}
              ariaLabel="Recombined proposals"
              accent={lensColor("fusions")}
              header={
                <>
                  <span className="pc-cardstack__header-label">fusions</span>
                  <span className="pc-cardstack__header-count">
                    {cycle.proposals.length}
                  </span>
                </>
              }
              renderCard={(p) => {
                const routed = cycle.routed.find((r) => r.ideaId === p?.id);
                return (
                  <div className="pc-analyze__ideacard">
                    <div className="pc-analyze__row">
                      {routed ? (
                        <span
                          className="pc-analyze__chip pc-analyze__routedref"
                          title={routed.title ?? routed.routedRef}
                        >
                          routed → {routed.rail} ·{" "}
                          {routed.routedRef.replace(/^[a-z]+:/i, "")}
                        </span>
                      ) : (
                        <span className="pc-analyze__chip">not routed</span>
                      )}
                    </div>
                    <strong className="pc-analyze__ideatitle">
                      {p?.framing ?? p?.id ?? "(proposal)"}
                    </strong>
                    {p?.mechanism ? (
                      <p className="pc-analyze__body">{p.mechanism}</p>
                    ) : null}
                    {p?.whyNew ? (
                      <p className="pc-analyze__mech">Why new: {p.whyNew}</p>
                    ) : null}
                    {p?.bet ? (
                      <p className="pc-analyze__mech">The bet: {p.bet}</p>
                    ) : null}
                    {p?.cheapExperiment ? (
                      <div className="pc-analyze__exp">
                        <b>Cheap experiment:</b> {p.cheapExperiment.hypothesis}{" "}
                        <b>Method:</b> {p.cheapExperiment.method}{" "}
                        <b>Falsified by:</b>{" "}
                        {p.cheapExperiment.falsifiableSignal}
                      </div>
                    ) : null}
                    {Array.isArray(p?.sourceIdeaIds) &&
                    p.sourceIdeaIds.length > 0 ? (
                      <div
                        className="pc-analyze__sources"
                        aria-label="Fused source ideas"
                      >
                        {p.sourceIdeaIds.map((id) => (
                          <span
                            key={id}
                            className="pc-analyze__chip"
                            title={id}
                          >
                            ⤷ {ideaTitle(id)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
          </section>
        </div>
      ) : (
        <p className="pc-learning__quietempty">
          No proposals persisted for this cycle
          {cycle.tick?.stop ? ` (cycle stop: ${cycle.tick.stop})` : ""}.
        </p>
      )}
    </div>
  );
}
