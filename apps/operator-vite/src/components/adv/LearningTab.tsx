/**
 * The workspace learning loop: Observe → Improve → Verify → Retain.
 * Each stage composes the existing sync-backed panels; `?lview=` remains the
 * canonical deep-link state and `?lhive=` scopes the hive-aware views.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useQueryState,
  useQueryStates,
  parseAsStringEnum,
  parseAsString,
} from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleDot,
  RefreshCw,
  ShieldCheck,
  UserRound,
  CheckCircle2,
  Dumbbell,
  Sparkles,
  XCircle,
  Clock,
  HelpCircle,
  Gauge,
  BookOpen,
  ArrowUp,
  ArrowDown,
  Minus,
  Activity,
  Repeat2,
  Hourglass,
  Radar,
  Brain,
  Star,
  MessageSquarePlus,
  Send,
  Eye,
  Lightbulb,
  FlaskConical,
  GitBranch,
  Beaker,
  Telescope,
  Rss,
  Microscope,
  Workflow,
  Zap,
} from "lucide-react";
// WI-7279: the wire shape is NARROWER than the server-side ScoredItem — the
// resolver projects humanQueue to the fields this tab actually reads. Import the
// wire type, not ScoredItem, so reading a field that is no longer sent fails to
// compile here instead of silently evaluating to `undefined` at runtime.
import type {
  LearningImprovementsArgs,
  LearningImprovementsRow,
  SlimHumanQueueItem,
} from "@papercusp/operator-core/lib/harness/improvements/learning-digest-snapshot";
import type { CompanionListSummary } from "@papercusp/facets";
// `tierReason` ships INTERNED (WI-39773 / D-008) — a `trc` code plus a
// per-payload legend. Resolve it through this helper, never by indexing the
// legend inline: pairing a row with the wrong payload's legend would resolve to
// a DIFFERENT sentence rather than fail.
//
// Imported from `learning-digest-wire`, NOT from `learning-digest-snapshot`: the
// latter is the server compute module and this is a real (non-erased) import, so
// reaching through it would put its dynamic server-side import graph in front of
// the browser bundler. The wire module is a leaf with no imports.
import { tierReasonOf } from "@papercusp/operator-core/lib/harness/improvements/learning-digest-wire";
import { CATEGORICAL, SEVERITY } from "@/app/harness/theme";
import type { ImprovementFlow } from "@papercusp/operator-core/lib/harness/improvements/flow-metrics";
import type {
  ScoutSnapshot,
  ScoutRoutedItem,
  ScoutTickEconomics,
  ScoutCadenceState,
  ScoutDraftIteration,
} from "@papercusp/operator-core/lib/sync-resolver/learning-scout-read";
import type { HiveLearningsSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-read";
import type { RetainExtrasSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-retain-read";
// VALUE import — deliberately from the pure types module, never from
// learning-retain-read (node:fs would enter the browser bundle).
import {
  RETAIN_FEED_TABS,
  RETAIN_KIND_FOR_TAB,
  type RetainDetail,
  type RetainFeedCounts,
  type RetainFeedColumnFilters,
  type RetainFeedKind,
  type RetainFeedPage,
  type RetainFeedQueryArgs,
  type RetainFeedRow,
  type RetainFeedTab,
  type RetainPlanChild,
} from "@papercusp/operator-core/lib/sync-resolver/learning-retain-types";
// WI-39493 owner ask 2026-08-16: the Retained ledger renders through the SAME
// grid + column-filter components as the Work tab's work-item queue
// (WorkItemsPanel.tsx — VirtualGrid + useColumnFilters/ColumnFilterBar).
import {
  VirtualGrid,
  usePersistedColumnWidths,
  type ColumnDef,
} from "@papercusp/grid-core";
// (useColumnFilters/ColumnFilterBar are already imported below with the rest
// of the @/app/harness surface.)
import "@/app/adv/harnesses/adv-panel-chrome.css";
import type { HiveThroughputSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-throughput-read";
import type { PotSoakReportSnapshot } from "@papercusp/operator-core/lib/pot/soak-report";
import type { ReleaseReadinessSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-release-readiness-read";
import { readinessRubricChipText } from "./learning-readiness-chip";
import { tabOverflowState, useAdvScope } from "./AdvShell";
import { BenchmarkTrend, type BenchmarkTrendInstance } from "./BenchmarkTrend";
import type { BakeoffTrendRow } from "@papercusp/operator-core/lib/pot-eval/bakeoff-trend";
import { EkgPanel } from "./EkgPanel";
import { RedQueenPanel } from "./RedQueenPanel";
import { FrontierPanel } from "./FrontierPanel";
import { SignalsPanel } from "./SignalsPanel";
import { AnalyzePanel } from "./AnalyzePanel";
import LearningLoopControl from "./LearningLoopControl";
import LearningPotPicker, { useOpenPotPicker } from "./LearningPotPicker";
import LearningPotDrawer from "./LearningPotDrawer";
import KnowledgePackCandidates from "./KnowledgePackCandidates";
import { ExperimentsPanel } from "./ExperimentsPanel";
import { Tooltip } from "@/app/harness/Tooltip";
import { Popover } from "@/app/harness/Popover";
import { CardStack } from "@papercusp/card-stack";
import {
  useColumnFilters,
  useColumnFilterState,
  useColumnFiltersFromState,
  parseAsColumnFilters,
  ColumnFilterBar,
  filterCountLabel,
  type CountEvidence,
} from "@/app/harness/filters";
import type { FilterableColumn } from "@papercusp/grid-core";
import { statusToneColor } from "@/app/harness/theme";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { usePromptDialog } from "@/app/harness/usePromptDialog";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import { useFlag } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import LearningInfraHealthChip from "./LearningInfraHealthChip";
import LearningEfficacyPanel from "./LearningEfficacyPanel";
import RubricsPanel from "@/app/_components/RubricsPanel";
import RubricDetailPanel from "@/app/_components/RubricDetailPanel";
import ObservationsPanel from "@/app/adv/create/ObservationsPanel";
import {
  beginInteraction,
  PERF_INTERACTIONS,
} from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  LearningComparisonBars,
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningStatLine,
  LearningVisualEmpty,
  LearningVisualError,
  LearningVisualStyles,
  LoopSection,
} from "./LearningVisuals";
import { snapshotFault } from "./snapshot-fault";

const LVIEWS = [
  "signals",
  "observations",
  "rubrics",
  "pipeline",
  // `ideas` was RETIRED 2026-07-27 (learning-tab-surface-public-release P-003,
  // owner Option A: "okay lets go with a but keep the observe tab"). The Ideas
  // ledger and the Backlog were two lists over one population — the generator's
  // output and the work that output became — and reading either alone told half
  // the story. They are now ONE list under `improvements`; a stale `?lview=ideas`
  // deep-link is redirected there (see LearningTab's redirect effect).
  "gym",
  "improvements",
  "benchmark",
  "orchestration",
  "bakeoff",
  "ekg",
  "red-queen",
  "experiments",
  "frontier",
  "throughput",
  "learnings",
] as const;
type LView = (typeof LVIEWS)[number];

type LearningStage = "observe" | "analyze" | "improve" | "verify" | "retain";
type LearningViewStatus = "neutral" | "good" | "warn" | "bad";
type LearningStatusSemantic = "attention" | "failure";

function statusSemantic(
  status: LearningViewStatus,
): LearningStatusSemantic | null {
  if (status === "bad") return "failure";
  if (status === "warn") return "attention";
  return null;
}

function statusDescription(status: LearningViewStatus): string {
  const semantic = statusSemantic(status);
  if (semantic === "attention") return "needs attention";
  if (semantic === "failure") return "data unavailable";
  return "";
}

/** One-line "what is this view FOR" per tab (owner ask 2026-07-19: a tooltip
 *  that repeats the tab's name is not a tooltip). Rendered as the tab's
 *  title/tooltip; the label stays the aria name. Record<LView,…> so a new
 *  view cannot ship without one. */
/** Built per-render from the active lexicon (restore-pot-lexicon P-006 — same
 *  pattern as railMeta): the tenancy noun in these one-liners must track the
 *  FLAGS.THE_HIVE pack instead of hardcoding one pack's label. */
function viewDescriptions(
  t: ReturnType<typeof useLexicon>,
): Record<LView, string> {
  const pot = t("pot", { lower: true });
  return {
    signals:
      "What the learning pipeline is being fed, and what will make it fire next.",
    observations:
      "Pre-idea sensor readings agents file at turn end — browse-only; only recurring ones get promoted to work.",
    rubrics:
      "The quality rubrics live behavior is judged against, with their grade history.",
    pipeline:
      "Inside each idea-generation cycle: ideator roster, raw ideas, critique verdicts, fusions, and where they routed.",
    gym: `Prompt-optimization experiments — challengers vs champions — plus ${t("scout")}-seeded archive niches.`,
    improvements:
      "What the learning loop produced: each idea and the work it became, from not-ready-yet through shipped. Grading an idea here is what teaches the generator.",
    benchmark:
      "Whole-system benchmark runs (the IQ battery) — is a new instance measurably better?",
    orchestration: `${t("pot")}-eval scoring trends — is orchestration quality improving over time?`,
    bakeoff:
      "Comparative scoring across competing framework setups on the same tasks.",
    ekg: "The learning loop's vital signs over time, at a glance.",
    "red-queen":
      "Adversarial-pressure tracking — is quality keeping pace as the environment hardens?",
    experiments: "A/B experiments the loop has run, and how they came out.",
    frontier: "Mined improvement territory the loop has not explored yet.",
    // WI-6383: the old line ("how much each pot banks") described Retain, not
    // this view — nothing here counts what was banked. It renders the loop's
    // operating yardstick, so the tooltip now names what is actually on screen.
    throughput: `Whether each ${pot}'s loop is keeping up — placement rate, how busy its fleet is, and what is stuck.`,
    learnings: `The ${pot}'s shared memory — what it keeps and recalls while it works.`,
  };
}

/** One line per stage of the loop, same rule. */
const STAGE_DESCRIPTIONS: Record<LearningStage, string> = {
  observe: "What the system sees: raw signals, observations, rubric grades.",
  analyze: "What idea generation does with it, cycle by cycle.",
  improve: "What the loop produced: ideas, experiments, and the work backlog.",
  retain: "What the system keeps: shared memory and adopted lessons.",
  // Generic / whole-system, NOT per-run (owner ask 2026-07-19) — every view
  // here measures the system at large, so it reads as the outermost ring after
  // the loop banks its lesson. Per-run outcomes live in Improve → Ideas.
  verify:
    "Is the SYSTEM measurably better over time — benchmarks, scoring trends, the release gate (whole-system, not per-idea).",
};

/** The Verify stage's views — hoisted so the stage can be declared LAST in
 *  {@link STAGES} (owner ask 2026-07-19) without burying the list mid-array. */
const VERIFY_VIEWS: ReadonlyArray<{
  id: LView;
  label: string;
  icon: typeof Eye;
}> = [
  { id: "benchmark", label: "Benchmark", icon: FlaskConical },
  // P-006: this view renders hive-eval SCORING trends (is orchestration
  // quality improving?), not an orchestration control surface — the label
  // says what the numbers are, not what they measure over.
  { id: "orchestration", label: "Pot scoring", icon: GitBranch },
  { id: "bakeoff", label: "Framework bake-off", icon: Repeat2 },
  { id: "ekg", label: "EKG", icon: Activity },
  { id: "red-queen", label: "Red Queen", icon: Radar },
  { id: "experiments", label: "Experiments", icon: Beaker },
  { id: "frontier", label: "Frontier", icon: Telescope },
  // WI-6383: RESTORED. Throughput shipped as a real subtab (2026-06-13), was
  // converted to a header "Loop health" utility icon (2026-07-11), and lost its
  // only entry point when that whole utility row was deleted the next day. The
  // view kept working the entire time — LVIEWS, the render dispatch and the
  // resolver all survived — so for 15 days it was reachable ONLY by hand-typing
  // `?lview=throughput`. It does not go back in the header: the header removal
  // was deliberate and is still pinned ("keeps operational destinations out of
  // the learning header"), so it returns as what it originally was, a subtab.
  //
  // WHY Verify. It is a whole-system operating measurement, not a per-idea one:
  // placement rate, fleet saturation, stuck count, mean-time-to-complete. That
  // is the same family as its neighbours Wake efficiency and EKG. It sits after
  // Frontier because those two are the stage's HIVE-AWARE pair (P-005), so the
  // pot lens applies to an adjacent run of tabs rather than a scattered one.
  { id: "throughput", label: "Throughput", icon: Zap },
];

const STAGES: ReadonlyArray<{
  id: LearningStage;
  label: string;
  icon: typeof Eye;
  views: ReadonlyArray<{ id: LView; label: string; icon: typeof Eye }>;
}> = [
  {
    id: "observe",
    label: "Observe",
    icon: Eye,
    views: [
      { id: "signals", label: "Signals", icon: Rss },
      { id: "observations", label: "Observations", icon: Eye },
      { id: "rubrics", label: "Rubrics", icon: Gauge },
    ],
  },
  // P-009 (owner ask 2026-07-18: "I want the user to be able to see the
  // advanced things happening as part of idea generation, I dont want to hide
  // it"): the pipeline-transparency stage between Observe and Improve —
  // per-cycle divergent generation, adversarial critique, and fusion.
  {
    id: "analyze",
    label: "Analyze",
    icon: Microscope,
    views: [{ id: "pipeline", label: "Pipeline", icon: Workflow }],
  },
  {
    id: "improve",
    label: "Improve",
    icon: Lightbulb,
    views: [
      { id: "gym", label: "Gym", icon: Dumbbell },
      // ONE list, not two (P-003, owner Option A 2026-07-27). It was "Backlog"
      // only to disambiguate it from a sibling "Ideas" tab that no longer
      // exists; the merged view carries BOTH halves of the loop's output — the
      // idea and the work it became — so it is named for the stage's verb. The
      // lview id stays `improvements`: deep-links depend on it.
      { id: "improvements", label: "Improvements", icon: Sparkles },
    ],
  },
  {
    id: "retain",
    label: "Retain",
    icon: Brain,
    views: [{ id: "learnings", label: "Learnings", icon: Brain }],
  },
  // Verify sits AFTER Retain (owner ask 2026-07-19: "is the verify actually
  // verifying the runs... if it's a generic verify putting it before retain is
  // weird"). It is generic: every view here reads a WHOLE-SYSTEM measurement
  // (learning.releaseReadiness, learning.hiveEvalTrend, learning.bakeoff,
  // learning.soakReport, wake efficiency) — none of them joins to the ideas or
  // improvements this loop just produced. Per-RUN outcome tracking already
  // lives in Improve (the Ideas funnel routed→filed→claimed→done and the
  // per-idea trace ending in grade→outcome). So this is the outermost feedback
  // ring — "did the system as a whole get better" — which follows banking the
  // lesson rather than gating it. See the same note on STAGE_DESCRIPTIONS.
  {
    id: "verify",
    label: "Verify",
    icon: Gauge,
    views: VERIFY_VIEWS,
  },
];

// Exported READ-ONLY, under a qualified name, for the reachability guard —
// which has to reconstruct the real pre-fix catalog to prove it reds on the
// actual defect rather than on a synthetic stand-in (WI-6383).
export { STAGES as LEARNING_STAGES };

// Same contract, for the perf-settle COVERAGE guard (WI-7263): that guard needs
// the true size of the view population to tell "a view was added without a
// settle point" apart from "the settle points moved". Deriving it from
// LEARNING_STAGES instead would be circular — the reachability guard already
// pins those two lists to each other, so a view added to BOTH would slip
// through unmeasured.
export { LVIEWS as LEARNING_VIEWS };

/**
 * Every `?lview=` value that NO navigation can reach — the detector for the
 * WI-6383 class.
 *
 * THE CLASS. `LVIEWS` (what `?lview=` accepts, what the render dispatch
 * switches on) and {@link STAGES} (what the stage/subtab nav offers) are two
 * parallel lists over the same population. Nothing made them agree, so a view
 * could be deleted from the nav while staying fully alive everywhere else — no
 * type error, no failing test, no dead code for `knip` to find. Throughput sat
 * in exactly that state for 15 days: implemented, routed, resolver live,
 * unreachable. Restoring the one tab does not stop the next one going the same
 * way; this does.
 *
 * `catalog`/`views` are injectable ONLY so the guard test can prove the
 * detector reds on the real pre-fix catalog rather than on a synthetic one —
 * production callers pass nothing. Deliberately checks the UNFILTERED catalog:
 * a flag-gated view (see {@link TESTING_ONLY_VIEWS}, folded in by
 * {@link hiddenViews}) is hidden on purpose and still reachable when its flag
 * is on, which is not this defect.
 */
export function orphanedLearningViews(
  catalog: typeof STAGES = STAGES,
  views: readonly LView[] = LVIEWS,
): LView[] {
  const reachable = new Set<string>(
    catalog.flatMap((stage) => stage.views.map((candidate) => candidate.id)),
  );
  return views.filter((view) => !reachable.has(view));
}

/** Views hidden from the Learning tab unless FLAGS.TESTING is on.
 *
 *  The Gym is NOT public-release ready [owner 2026-07-27: "Put all the gym
 *  features behind a testing flag, it isnt ready at all and I dont want to get
 *  that ready now."]. It rides FLAGS.TESTING — the SAME flag that
 *  already hides the `/dev/gym` route (design-simplification P-013) — so every
 *  gym surface sits behind ONE switch, and no new dark flag has to be minted
 *  (which would spend DARK_FLAGS_HIGH_WATERMARK budget to gate what an existing
 *  flag already gates).
 *
 *  WHY it is not ready, measured 2026-07-27 (WI-6315): the gym optimizes prompt
 *  overrides for `coding-solo`'s worker/validator roles — 8 and ZERO live tool
 *  invocations respectively — on a generated 4-line stub substrate whose only
 *  build gate is `node --check`, scored by an LLM composite rather than an
 *  observed outcome. The Improve→Gym arrow is decorative as well: 0.6% of
 *  triaged ideas route to it, and a routed idea only becomes hint text in the
 *  proposer prompt. A public user opening Improve would see a loop that visibly
 *  does not close.
 *
 *  {@link STAGES} stays the single catalog: this filters a COPY, so the
 *  flag-ON path is byte-identical to what shipped before the gate. */
const TESTING_ONLY_VIEWS: ReadonlySet<LView> = new Set<LView>(["gym"]);

/* The `wake-efficiency` view (MugWakeEfficiencyPanel) used to be hidden here
 * behind FLAGS.MUG_KETTLE_SYSTEM. It is now DELETED outright — the Mug/Kettle
 * tier is retired (D-074), so the pane could only ever render an empty
 * live-Mug read for a system that cannot run
 * (retire-mug-kettle-su-only-2026-08-09 P-059 / D-076). The panel itself is in
 * `_retired/mug-kettle-deciders/`.
 *
 * ⚠ `red-queen` and `frontier` were deliberately NEVER part of that set, though
 * a filename scan would sweep both in (D-020): RedQueenPanel is the
 * SELF-HEALING drill — "Red Queen" is the evolutionary arms-race term, not the
 * Mug — and FrontierPanel renders the learning-loop lane grid. Both belong to
 * the learning system D-001 keeps INTACT. Do not retire them with the tier. */

/** The one rule both the nav filter and the render degradation read.
 *
 *  Deriving them separately is how the two lists drift — the same defect
 *  {@link orphanedLearningViews} exists to catch between LVIEWS and STAGES, one
 *  level down. A view hidden from the nav but still rendered by a stale
 *  `?lview=` is not a smaller bug than the reverse. */
function hiddenViews(testingOn: boolean): ReadonlySet<LView> {
  const hidden = new Set<LView>();
  if (!testingOn) for (const v of TESTING_ONLY_VIEWS) hidden.add(v);
  return hidden;
}

function visibleStages(testingOn: boolean): typeof STAGES {
  const hidden = hiddenViews(testingOn);
  if (hidden.size === 0) return STAGES;
  return STAGES.map((stage) => ({
    ...stage,
    views: stage.views.filter((candidate) => !hidden.has(candidate.id)),
    // A stage whose every view is gated would render an empty pane rather than
    // disappear, so drop it — today none is (Improve keeps Ideas + Backlog).
  })).filter((stage) => stage.views.length > 0);
}

function stageForView(view: LView): LearningStage | null {
  return (
    STAGES.find((stage) =>
      stage.views.some((candidate) => candidate.id === view),
    )?.id ?? null
  );
}

function stageStatus(
  stage: (typeof STAGES)[number],
  statuses: Partial<Record<LView, LearningViewStatus>>,
): LearningViewStatus | null {
  const visible = stage.views
    .map((candidate) => statuses[candidate.id])
    .filter((status): status is LearningViewStatus => Boolean(status));
  if (visible.includes("bad")) return "bad";
  if (visible.includes("warn")) return "warn";
  if (visible.includes("good")) return "good";
  return visible.length > 0 ? "neutral" : null;
}

/** Sub-views whose data is scoped to ONE Hive (the tenancy unit, D-008) — they
 *  read the tab-level `?lhive=`. P-005 (pot-scope-all-learnings): Scout (ideas),
 *  Frontier and Throughput joined the lens — their stores carry a pot, or
 *  resolve one via registry membership. Still workspace-global: views whose
 *  tables have no pot column (Benchmark, Knowledge, EKG/RedQueen, Bakeoff,
 *  Experiments, Wake-efficiency, Signals, Observations, Rubrics, Analyze). */
const HIVE_AWARE_VIEWS: ReadonlySet<LView> = new Set<LView>([
  "improvements",
  "gym",
  "learnings",
  "frontier",
  "throughput",
]);

/**
 * Learning's arming teaching links open the every-pot SCOPE PICKER
 * (learning-pot-scope-gate-2026-08-30, P-009).
 *
 * THEY USED TO LAND ON THE WRONG PAGE. The destination was
 * `tab=workflows&wfKind=routine` — the routine SCHEDULE list, which answers
 * "when does this run", not "is this pot learning at all". A person who clicked
 * "Open Arming" because nothing was learning arrived at a cadence table with no
 * control that would change what they came to change. The picker is the surface
 * that actually answers it: every pot, its current switch, and what turning it
 * on would really do.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. The pot switch is a GATE, not an arm
 * (D-007) — releasing it lets each lane resume at its own prior arming, so it
 * cannot by itself arm a lane. That is why the Gym empty-state's button is
 * labelled for the scope surface rather than "Arm the Gym": the picker names
 * the lane you still have to arm ("switching on alone starts nothing; arm Gym
 * to make it learn") but is not the control that arms it, and a button whose
 * label promises an action its destination cannot perform is the same
 * wrong-page failure in a new costume.
 *
 * The old constants are kept EXPORTED and referenced by nothing here on
 * purpose — LearningTab.test.tsx pins them as the pre-P-009 destination so a
 * silent revert to the Workflows tab fails a test instead of shipping.
 */
export const ARMING_WORKFLOWS_TAB = "workflows";
export const ARMING_WORKFLOWS_KIND = "routine";

function useOpenArming(): () => void {
  return useOpenPotPicker();
}

/** P-009 first-run orientation banner — ONCE PER WORKSPACE (owner decision
 *  2026-07-26): dismissal persists in localStorage (UI state, not a feature
 *  flag; the desktop app is one workspace per install). */
const ORIENTATION_DISMISS_KEY = "pc-learning-orientation-dismissed";

function LearningOrientationBanner() {
  const t = useLexicon();
  const openArming = useOpenArming();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ORIENTATION_DISMISS_KEY) === "1";
    } catch {
      return true; // storage unavailable ⇒ fail quiet, never re-nag each render
    }
  });
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(ORIENTATION_DISMISS_KEY, "1");
    } catch {
      /* best effort */
    }
  };
  const pot = t("pot", { lower: true });
  return (
    <div
      className="pc-learning__orient"
      role="note"
      aria-label="How learning works"
    >
      <div className="pc-learning__orientbody">
        <strong>Your {pot} learns as you work</strong>
        <p>
          Agents capture friction the moment they hit it, the Gym A/B-refines
          your playbooks under a budget you set, and the {t("scout")} explores
          new ideas from this {pot}&apos;s own history — everything it learns is
          scoped to this {pot}.
        </p>
        <button
          type="button"
          className="pc-learning__orientaction"
          onClick={openArming}
        >
          Open Arming
        </button>
      </div>
      <button
        type="button"
        className="pc-learning__orientdismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export default function LearningTab() {
  const t = useLexicon();
  const viewDesc = viewDescriptions(t);
  const [lview, setLview] = useQueryState(
    "lview",
    parseAsStringEnum<LView>([...LVIEWS]).withDefault("improvements"),
  );
  const [rubricId, setRubricId] = useQueryState("rrubric", parseAsString);
  const [, setGradeDetail] = useQueryState("grade", parseAsString);
  const [, setRetainDetail] = useQueryState("lretain", parseAsString);
  // FLAGS.TESTING gates the Gym view (see TESTING_ONLY_VIEWS). Resolve it here
  // so a stale `?lview=gym` deep-link — a bookmark, an old link in a report, the
  // param left in the URL when the flag is turned off — lands on the default
  // view instead of rendering a pane the tab no longer offers.
  const testingOn = useFlag(FLAGS.TESTING);
  // A stale `?lview=wake-efficiency` (the deleted Mug/Kettle view, D-076) is no
  // longer a hidden-but-known id — it is simply not in LVIEWS, so the
  // membership test below rejects it into the default view.
  const stages = useMemo(() => visibleStages(testingOn), [testingOn]);
  const requestedView: LView = (LVIEWS as readonly string[]).includes(lview)
    ? (lview as LView)
    : "improvements";
  const view: LView = hiddenViews(testingOn).has(requestedView)
    ? "improvements"
    : requestedView;

  // P-003: keep the URL naming the view actually on screen. Two ways it can
  // lie, and BOTH resolve here rather than in a per-case special: a retired id
  // (`?lview=ideas` — the Ideas ledger merged into Improvements), and a valid
  // but flag-hidden id (`?lview=gym` with FLAGS.TESTING off). In each case the
  // pane already degrades to the default above, so this is not about what
  // renders — it is that the URL is the AGENT-VISIBLE control surface (repo
  // rule: user-meaningful state lives in nuqs, and ui:get_state reads it). A
  // param naming a view nobody is looking at is a real bug for the reader
  // driving this tab through ui:dispatch, not cosmetics.
  //
  // Read through the RAW param, not `lview`: parseAsStringEnum resolves an
  // unknown value to the default, so the enum hook can never SEE "ideas" — only
  // the raw string can. Writing null-safe (no param ⇒ no write) keeps a clean
  // URL clean instead of stamping ?lview=improvements on every mount.
  const [lviewRaw, setLviewRaw] = useQueryState("lview", parseAsString);
  useEffect(() => {
    if (lviewRaw != null && lviewRaw !== view) void setLviewRaw(view);
  }, [lviewRaw, setLviewRaw, view]);

  // Perf: begin the learning-view-switch interaction on a view CHANGE — the
  // "expanding the sections" gesture the owner reported as taking several
  // seconds (EI-19375505819043214). The matching endInteraction fires in the
  // selected panel when its primary read resolves.
  //
  // Keyed off `view` (the view actually rendered), not `lview`/`lviewRaw`: a
  // flag-hidden or retired id degrades to the default above, and timing a
  // switch to a pane nobody is looking at would measure the wrong render.
  //
  // The FIRST mount is deliberately skipped. Mount cost is a different
  // interaction with a different cause (it is harness-dock-open's territory),
  // and folding it in here would blend two populations under one budget — the
  // exact conflation that made command-palette-open report a 7.6x regression
  // that did not exist (WI-6543).
  //
  // ⚠ useLayoutEffect, NOT useEffect — this is a CORRECTNESS requirement, not a
  // style choice, and getting it wrong silently corrupts every measure this
  // instrument emits (EI-19375505819043214, measured 2026-08-02).
  //
  // React runs effects in phases, and within a phase CHILD BEFORE PARENT. The
  // settle points live in the child panels (AnalyzePanel, ObservationsPanel,
  // ImprovementsView) as passive `useEffect`s. So with a passive begin HERE,
  // the order on a view switch is:
  //
  //     child endInteraction  →  parent beginInteraction        (WRONG)
  //
  // A panel whose data is already cached settles ON MOUNT, so its
  // endInteraction runs FIRST and consumes whatever start mark is lying
  // around — the PREVIOUS view's dangling start (dangling because that view
  // has no settle point, or settled before its own begin). The emitted measure
  // then spans "time the user spent on the previous view", which is unbounded
  // and has nothing to do with render cost. Observed: a headless run that
  // dwelt 14s per view emitted a single 15,289ms measure — 14s of dwell plus
  // ~1.3s of actual settle — against a 1500ms budget. STALE_START_MS (30s)
  // does not save us: 15s is well inside it, so the garbage measure passes
  // through looking like a real 10x budget breach.
  //
  // ALL layout effects run before ANY passive effect, so a layout begin here
  // precedes every child settle regardless of the child-before-parent rule:
  //
  //     parent beginInteraction  →  child endInteraction        (correct)
  //
  // This holds only while the settle points stay PASSIVE. A panel that ever
  // settles in a layout effect re-opens the bug; the ordering contract is
  // pinned by LearningTab.perf-begin-order.test.tsx.
  const perfPrevViewRef = useRef<LView | null>(null);
  useLayoutEffect(() => {
    const prev = perfPrevViewRef.current;
    perfPrevViewRef.current = view;
    if (prev !== null && prev !== view) {
      beginInteraction(PERF_INTERACTIONS.learningViewSwitch);
    }
  }, [view]);

  // Pot lens INHERITED from the top-bar pot selector (owner directive
  // 2026-07-26: "the pot should be inherited by the currently selected pot" —
  // the tab-level `?lhive=` picker is GONE; one selection scopes every tab).
  // All Pots ⇒ '' ⇒ the workspace-wide rollup each hive-aware view already
  // supports. WI-5412 perf gate preserved: hive-aware views wait for the scope
  // to resolve (projects list loaded) so the first fetch runs with the real
  // lens, never a transient.
  const scope = useAdvScope();
  const hive = scope.hive;
  const hiveAware = HIVE_AWARE_VIEWS.has(view);
  const hiveReady = !hiveAware || scope.ready;
  const activeStage = stageForView(view);
  const activeStageMeta =
    stages.find((stage) => stage.id === activeStage) ?? null;
  const [viewStatuses, setViewStatuses] = useState<
    Partial<Record<LView, LearningViewStatus>>
  >({});
  const reportStatus = useCallback(
    (reportedView: LView, status: LearningViewStatus) => {
      setViewStatuses((current) =>
        current[reportedView] === status
          ? current
          : { ...current, [reportedView]: status },
      );
    },
    [],
  );
  const previousView = useRef<LView>(view);
  useEffect(() => {
    const previous = previousView.current;
    if (previous === view) return;
    if (previous === "improvements") void setGradeDetail(null);
    if (previous === "rubrics") void setRubricId(null);
    if (previous === "learnings") void setRetainDetail(null);
    previousView.current = view;
  }, [setGradeDetail, setRetainDetail, setRubricId, view]);

  // Work Queue parity without an unbounded hidden tree: keep the current pane
  // and the two most recent panes mounted. Normal back-and-forth stays warm,
  // while old chart trees and their live subscriptions are evicted.
  const [warmViews, setWarmViews] = useState<readonly LView[]>([view]);
  useEffect(() => {
    setWarmViews((current) =>
      [view, ...current.filter((candidate) => candidate !== view)].slice(0, 3),
    );
  }, [view]);
  // Include the newly selected view in this render; the effect persists it for
  // later renders without introducing a one-frame empty panel.
  const mountedViews = [
    view,
    ...warmViews.filter((candidate) => candidate !== view),
  ].slice(0, 3);

  // View-tab strip overflow affordance (P-007): when tabs are clipped, fade the
  // clipped edge so it reads "there are more views this way" instead of
  // silently cutting off. Same data-attr + mask pattern (and the same pure
  // tabOverflowState helper) as AdvShell's top-level tab strip.
  const viewListRef = useRef<HTMLDivElement | null>(null);
  // A ref alone CANNOT drive the wiring effect below: assigning `.current`
  // renders nothing, so an effect keyed on anything else silently misses the
  // strip mounting — and the strip genuinely mounts mid-life. Its gate is
  // `activeStageMeta.views.length > 1`, and that view set is FLAG-derived
  // (visibleStages(testingOn)); Improve holds exactly `gym` (the sole
  // TESTING-only view) plus `improvements`, so it sits on that boundary, while
  // FLAGS.TESTING is dark and useFlag serves FLAG_DEFAULTS until the async
  // loadFlags() resolves. `activeStage` stays "improve" across that flip, so it
  // cannot see it. Track the node in STATE via a callback ref, so the mount
  // itself re-runs the effect. (WI-486080)
  const [viewList, setViewList] = useState<HTMLDivElement | null>(null);
  const attachViewList = useCallback((node: HTMLDivElement | null) => {
    viewListRef.current = node;
    setViewList(node);
  }, []);
  const viewTabCount = activeStageMeta?.views.length ?? 0;
  const [viewOverflow, setViewOverflow] = useState({
    left: false,
    right: false,
  });
  const updateViewOverflow = useCallback(() => {
    const list = viewListRef.current;
    if (!list) {
      setViewOverflow({ left: false, right: false });
      return;
    }
    setViewOverflow(
      tabOverflowState(list.scrollLeft, list.scrollWidth, list.clientWidth),
    );
  }, []);
  useEffect(() => {
    // `viewList` (state, not the ref) is what makes this effect fire on the
    // mount itself. activeStage and viewTabCount cover the two ways the tab SET
    // changes while the same node stays mounted — a stage switch React reuses
    // the node for, and a flag flip that adds/removes a view within one stage.
    // Both change scrollWidth without resizing the element, which is precisely
    // what a ResizeObserver cannot see.
    const list = viewList;
    updateViewOverflow();
    if (!list) return;
    list.addEventListener("scroll", updateViewOverflow, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateViewOverflow())
        : null;
    ro?.observe(list);
    return () => {
      list.removeEventListener("scroll", updateViewOverflow);
      ro?.disconnect();
    };
  }, [updateViewOverflow, viewList, activeStage, viewTabCount]);
  // Only scroll the selected view tab into view when it is actually clipped
  // (e.g. a URL-restored view on a narrow pane) — never scroll away from
  // fully-visible tabs.
  useEffect(() => {
    const list = viewListRef.current;
    if (!list) return;
    const trigger = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!trigger) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = trigger.getBoundingClientRect();
    if (tabRect.left >= listRect.left && tabRect.right <= listRect.right)
      return;
    try {
      trigger.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* best effort */
    }
  }, [view]);

  return (
    <div className="pc-learning">
      {/* WI-39501: the stage row hosts the ONE header control every step shares —
          pause/resume-all learning routines + the loop's spend (LearningLoopControl,
          absolutely positioned at the row's right edge). */}
      <div className="pc-learning__stagerow">
        <Tabs.Root
          className="pc-learning__stages"
          value={activeStage ?? ""}
          onValueChange={(next) => {
            // `stages`, not STAGES: clicking a stage lands on its FIRST VISIBLE
            // view, so a gated view can never be selected by the stage nav.
            const stage = stages.find((candidate) => candidate.id === next);
            if (stage?.views[0]) void setLview(stage.views[0].id);
          }}
        >
          <Tabs.List
            className="pc-learning__stage-list"
            aria-label="Learning loop stage"
          >
            {stages.map((stage, index) => {
              const Icon = stage.icon;
              const status = stageStatus(stage, viewStatuses);
              const semantic = status ? statusSemantic(status) : null;
              return (
                <Tabs.Trigger
                  key={stage.id}
                  value={stage.id}
                  className="pc-learning__stage"
                  aria-label={stage.label}
                  title={STAGE_DESCRIPTIONS[stage.id]}
                  aria-describedby={
                    status ? `learning-stage-status-${stage.id}` : undefined
                  }
                >
                  <span
                    className={`pc-learning__stage-icon${semantic ? ` has-${semantic}` : ""}`}
                  >
                    <Icon size={16} aria-hidden />
                    {semantic ? (
                      <>
                        <span className="pc-learning__statusmark" aria-hidden />
                        <span
                          id={`learning-stage-status-${stage.id}`}
                          className="pc-learning__statusdesc"
                        >
                          {statusDescription(status!)}
                        </span>
                      </>
                    ) : null}
                  </span>
                  <span className="pc-learning__stage-label">
                    {stage.label}
                  </span>
                  {index < stages.length - 1 ? (
                    <span className="pc-learning__stage-line" aria-hidden />
                  ) : null}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
        <LearningLoopControl />
      </div>

      {/* The pot RAIL used to sit here — one chip per learning pot, on its own
          row between the stepper and the view controls. It is gone (owner,
          2026-09-07): with every pot switched off, seven near-identical pills
          said "learning off" only through a dashed border and 62% opacity, and
          the one fact that mattered — nothing is learning — was invisible. Its
          scope question is now answered in WORDS by the verdict on the stage
          row above, and its per-pot controls live in that control's dropdown.
          The model it was built on (learning-pot-rail.ts) is unchanged and now
          feeds both. */}
      {/* P-008's every-pot scope picker. Mounted here rather than inside the
          loop control because it enumerates EVERY pot, including ones with no
          learning setup at all — a population buildLearningPotRail omits, so
          the dropdown's list cannot reach them. It is a modal driven by URL
          state, so it costs nothing closed. */}
      <LearningPotPicker />
      {/* P-012's per-pot drawer, mounted beside the picker for the same reason
          and one more: it must be openable for a pot with NO rail chip. D-008
          measured that the chip popover is the only surface operating per-lane
          switches, which is why the rail cannot collapse its switched-off pots
          (the owner's "gigantic display" complaint, P-052). Mounting the drawer
          on the tab — reachable from the picker by slug — is what breaks that
          dependency; hanging it off the rail would rebuild it. */}
      <LearningPotDrawer />

      <div className="pc-learning__controls">
        {/* The per-tab pot picker that lived here is GONE (owner directive
            2026-07-26): the lens is inherited from the top-bar pot selector via
            useAdvScope — see the `hive` derivation above. The inherited pot is
            named in the strap line below so scope stays visible. */}
        {hiveAware && hive ? (
          <span
            className="pc-learning__hivepick"
            title={`Scoped to the ${t("pot", { lower: true })} selected in the top bar`}
          >
            <Brain size={12} aria-hidden />
            <span className="pc-learning__hivepicklabel">
              {potHomeLabel(hive)}
            </span>
          </span>
        ) : null}
        {activeStageMeta && activeStageMeta.views.length > 1 ? (
          <Tabs.Root
            className="pc-learning__view-tabs"
            data-stage={activeStageMeta.id}
            data-of-left={viewOverflow.left ? "" : undefined}
            data-of-right={viewOverflow.right ? "" : undefined}
            value={view}
            onValueChange={(next) => void setLview(next as LView)}
          >
            <Tabs.List
              ref={attachViewList}
              className="pc-learning__view-list"
              aria-label={`${activeStageMeta.label} views`}
            >
              {activeStageMeta.views.map((candidate) => {
                const Icon = candidate.icon;
                const status = viewStatuses[candidate.id];
                const semantic = status ? statusSemantic(status) : null;
                return (
                  <Tabs.Trigger
                    key={candidate.id}
                    value={candidate.id}
                    className={`pc-learning__view-tab${semantic ? ` has-${semantic}` : ""}`}
                    aria-label={candidate.label}
                    title={viewDesc[candidate.id]}
                    aria-describedby={
                      status
                        ? `learning-view-status-${candidate.id}`
                        : undefined
                    }
                  >
                    <span
                      className={`pc-learning__view-icon${semantic ? ` has-${semantic}` : ""}`}
                    >
                      <Icon size={12} aria-hidden />
                      {semantic ? (
                        <>
                          <span
                            className="pc-learning__statusmark"
                            aria-hidden
                          />
                          <span
                            id={`learning-view-status-${candidate.id}`}
                            className="pc-learning__statusdesc"
                          >
                            {statusDescription(status!)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="pc-learning__view-label">
                      {candidate.label}
                    </span>
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
          </Tabs.Root>
        ) : (
          <span />
        )}

        <LearningInfraHealthChip />
      </div>

      {/* P-009 lexicon gloss: the active view's one-liner, VISIBLE — a
          title-attr tooltip is undiscoverable for exactly the first-run user
          it serves. Same source as the tab tooltips (viewDescriptions). */}
      <p className="pc-learning__strap">{viewDesc[view]}</p>

      <LearningOrientationBanner />

      {stageForView(view) === "verify" ? <ReleaseReadinessStrip /> : null}

      <div className="pc-learning__body">
        {LVIEWS.filter((candidate) => mountedViews.includes(candidate)).map(
          (mountedView) => (
            <section
              key={mountedView}
              className="pc-learning__viewpane"
              data-view={mountedView}
              role="tabpanel"
              aria-label={stageForView(mountedView) ?? "Loop health"}
              hidden={mountedView !== view}
            >
              <LearningViewContent
                view={mountedView}
                active={mountedView === view}
                hive={hive}
                hiveReady={hiveReady}
                rubricId={rubricId}
                onRubricSelect={setRubricId}
                onStatus={reportStatus}
              />
            </section>
          ),
        )}
      </div>

      <LearningVisualStyles />
      <LearningStyles />
    </div>
  );
}

function LearningViewContent({
  view,
  active,
  hive,
  hiveReady,
  rubricId,
  onRubricSelect,
  onStatus,
}: {
  view: LView;
  /** True when THIS pane is the selected view. Panes are kept mounted while
   *  warm (see `warmViews`) and only `hidden` flips, so a pane can be mounted
   *  and inactive — which is why the perf settle points need this to fire on a
   *  revisit that does not remount (EI-19383745196363732). */
  active: boolean;
  hive: string;
  hiveReady: boolean;
  rubricId: string | null;
  onRubricSelect: (id: string | null) => void;
  onStatus: (view: LView, status: LearningViewStatus) => void;
}) {
  const reportViewStatus = useCallback(
    (status: LearningViewStatus) => onStatus(view, status),
    [onStatus, view],
  );
  if (view === "signals") {
    return <SignalsPanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "observations") {
    return <ObservationsPanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "pipeline") {
    return <AnalyzePanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "rubrics") {
    return (
      <div className="pc-learning__rubricsplit">
        <RubricsPanel
          onSelect={onRubricSelect}
          selectedId={rubricId}
          compact={Boolean(rubricId)}
          collapseUnscored
          onStatus={reportViewStatus}
          active={active}
        />
        {rubricId ? (
          <aside
            className="pc-learning__rubricdetail"
            aria-label="Rubric evidence"
          >
            <RubricDetailPanel
              rubricId={rubricId}
              onBack={() => onRubricSelect(null)}
            />
          </aside>
        ) : null}
      </div>
    );
  }
  if (view === "gym") {
    return (
      <GymView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  if (view === "improvements") {
    return (
      <ImprovementsView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  if (view === "benchmark") {
    return <ApiaryView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "orchestration") {
    return <HiveEvalTrendView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "bakeoff") {
    return <BakeoffTrendView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "ekg")
    return <EkgPanel onStatus={reportViewStatus} active={active} />;
  if (view === "red-queen")
    return <RedQueenPanel onStatus={reportViewStatus} active={active} />;
  if (view === "experiments")
    return <ExperimentsPanel onStatus={reportViewStatus} active={active} />;
  if (view === "frontier")
    return (
      <FrontierPanel
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  if (view === "throughput") {
    return (
      <ThroughputView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  return (
    <LearningsView
      hive={hive}
      hiveReady={hiveReady}
      onStatus={reportViewStatus}
      active={active}
    />
  );
}

// ─── Release-readiness strip (learning-tab-alignment-2026-07-13 P-001) ───────
//
// The Verify stage's GO/NO-GO gate: blender:success-metrics' bars + the
// blender-release-readiness rubric's governance state. D-001: everything here
// renders the server read (learning.releaseReadiness), which reuses the SAME
// readers the MCP tools serve — no UI-side re-derivation.

function ReleaseReadinessStrip() {
  const sync = useSyncQuery<ReleaseReadinessSnapshot>({
    queryName: "learning.releaseReadiness",
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  if (!snap) return null; // loading / unreadable — the strip appears once the read lands
  const report = snap.report;
  const rubric = snap.rubric;
  const verdict = report?.verdict ?? null;

  return (
    <div
      className="pc-learning__readiness"
      role="status"
      aria-label="Release readiness"
    >
      <Tooltip
        label={
          report
            ? `The learning program's done-check over the live ledgers (window: ${report.window.ticks} ticks, ${report.window.routedIdeas} routed ideas). 'pass' only when every bar passes; 'incomplete' = a bar lacks evidence.`
            : (snap.errors?.join(" · ") ?? "success-metrics unreadable")
        }
      >
        <span
          className={`pc-learning__readiness-verdict pc-learning__readiness-verdict--${verdict ?? "unknown"}`}
        >
          <ShieldCheck size={12} aria-hidden />
          release gate: {verdict ?? "unreadable"}
          {report ? (
            <em>
              {report.passed}/{report.criteria.length}
            </em>
          ) : null}
        </span>
      </Tooltip>

      {(report?.criteria ?? []).map((c) => (
        <Tooltip key={c.key} label={`${c.bar} — ${c.observed}`}>
          <span
            className={`pc-learning__readiness-bar pc-learning__readiness-bar--${c.status}`}
          >
            {c.status === "pass" ? (
              <CheckCircle2 size={11} aria-hidden />
            ) : c.status === "fail" ? (
              <XCircle size={11} aria-hidden />
            ) : (
              <HelpCircle size={11} aria-hidden />
            )}
            {c.key}
          </span>
        </Tooltip>
      ))}

      <Tooltip
        label={
          rubric
            ? rubric.status === "active"
              ? `Ratified gate rubric (${rubric.criteriaCount} criteria)${rubric.ratifiedBy ? ` — ratified by ${rubric.ratifiedBy}` : ""}${rubric.proposedBy ? `, proposed by ${rubric.proposedBy}` : ""}.`
              : `The gate rubric is ${rubric.status} — not yet ratified (author ≠ ratifier governance). ${rubric.criteriaCount} criteria${rubric.proposedBy ? `, proposed by ${rubric.proposedBy}` : ""}.`
            : "No blender-release-readiness rubric proposed yet — the gate has no ratified spec."
        }
      >
        <span
          className={`pc-learning__readiness-rubric pc-learning__readiness-rubric--${rubric?.status ?? "missing"}`}
        >
          <Gauge size={11} aria-hidden />
          {readinessRubricChipText(rubric)}
        </span>
      </Tooltip>
    </div>
  );
}

// ─── Improve view (the merged loop-output list) ───────────────────────────────

const LANES = ["all", "auto", "human"] as const;
type Lane = (typeof LANES)[number];

type LearningServerFilters = Pick<
  LearningImprovementsArgs,
  | "kinds"
  | "severities"
  | "scopes"
  | "stages"
  | "ideaTypes"
  | "lenses"
  | "score"
  | "ageDays"
>;

// `useSyncQuery` accepts a generic JSON-ish argument record, while the resolver
// exposes a closed interface so callers get exact field names and values. Keep
// both guarantees at this transport boundary instead of weakening the resolver
// contract with a string index signature.
type LearningImprovementsQueryArgs = LearningImprovementsArgs &
  Record<string, unknown>;

/** Provenance scope — the mockup's scope bar (owner-approved 2026-07-27).
 *
 *  It filters by WHERE A ROW CAME FROM, and it is the single control that makes
 *  this view honest. Measured 2026-07-27: 8,202 rows — 99.93% of the old
 *  Backlog — were ALSO on the Work tab, because the backlog read applied no
 *  provenance filter at all. `loop` scopes to what the learning loop itself
 *  produced (~823); `all` is the deliberate escape hatch back to every capture.
 *
 *  `loop` is the resolver's DEFAULT (P-002) and the ONLY variant served from
 *  the precomputed snapshot — so the common path must pass NO scope arg. */
const LOOP_SCOPES = ["loop", "all"] as const;
type LoopScope = (typeof LOOP_SCOPES)[number];

function ageLabel(days: number): string {
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

/**
 * One row of the merged Improve list (P-003, owner Option A 2026-07-27).
 *
 * Improve used to be two tabs over ONE population: Ideas (the generator's
 * ledger) and Backlog (the work those ideas became). Reading either alone told
 * half the story — an idea with no visible fate, or a work item with no visible
 * origin. A row now carries both halves, and either may be absent:
 *
 * - `item` + `idea` — the common case: an idea that became work.
 * - `idea` only — [owner 2026-07-27 verbatim] "THE IMPROVE SHOULD JUST BE
 *   THE IDEAS BEFORE THEY GET INTO WORK ITEMS OR THE WORK ITEMS THAT CAME FROM
 *   IDEAS": an idea routed to a plan/gym/benchmark rail, or still held before
 *   it is filed. These are the "not ready yet" end of the pipeline.
 * - `item` only — a capture with no idea behind it. Under `loop` scope that is
 *   a PROVENANCE GAP worth seeing (see WI-6338: the three records of "Scout
 *   produced this" disagree by ~50%); under `all` scope it is simply a
 *   human/watchdog filing.
 */
interface LoopRow {
  key: string;
  item: SlimHumanQueueItem | null;
  idea: ScoutRoutedItem | null;
}

/** Is THIS row the deep-link target (`?lsel`)?
 *
 *  Both operands must be checked, not just compared: a row with no work item
 *  has `item?.id === undefined`, so a bare `row.item?.id === lsel` reports TRUE
 *  for every unfiled idea whenever `lsel` is itself nullish — which scroll-
 *  jacks the list and (in jsdom) throws on the un-implemented scrollIntoView.
 *  The pre-merge row compared an always-present string and could not hit this. */
function isSelectedRow(row: LoopRow, lsel: string | null): boolean {
  return lsel != null && row.item != null && row.item.id === lsel;
}

/**
 * The public pipeline vocabulary (P-004, owner ruling 2026-07-27).
 *
 * ONE set of words for where a thing is in the loop, used by the row chip AND
 * the funnel above the list so the summary and the rows cannot describe the
 * same population differently.
 *
 * These deliberately are NOT the storage vocabulary. `open` / `assignee` /
 * `resolved` describe the work-items table, not the question a reader is
 * asking; and the chip this replaces ("review" vs "auto", "Waits for your
 * review") described a HUMAN APPROVAL GATE that does not exist — in a full-auto
 * loop the human teaches the generator by grading and never approves the work.
 * Naming a gate that nobody operates invites someone to wait at it.
 */
type PipelineState =
  | "not-ready"
  | "approved"
  | "in-flight"
  | "shipped"
  | "dropped";

const PIPELINE_STATES: Record<PipelineState, { label: string; desc: string }> =
  {
    "not-ready": {
      label: "not ready yet",
      desc: "The loop produced this idea but has not filed it as work yet.",
    },
    approved: {
      label: "approved",
      desc: "Filed as work. Waiting for an agent to pick it up.",
    },
    "in-flight": {
      label: "in flight",
      desc: "An agent is working on this right now.",
    },
    shipped: { label: "shipped", desc: "Landed." },
    dropped: { label: "dropped", desc: "Abandoned — closed without shipping." },
  };

/**
 * Which pipeline state a merged row is in — exclusive by construction.
 *
 * ⚠ `ScoredItem.state` is the COLLAPSED three-value lifecycle
 * (`open|resolved|closed`) that `toLifecycleState` maps the unified work-item
 * enum onto — NOT the raw `done|dropped|wip|…` enum the server's SQL sees. The
 * two vocabularies read alike and mean different things, which is precisely how
 * EI-18792873324746237 put a permanent "0 shipped" on this tab. Do not copy a
 * state list between this function and a query.
 *
 * ⚠⚠ THIS PARAGRAPH USED TO CLAIM that only the first three states are reachable
 * here — that the digest admits ONLY open items ("Only OPEN items go into the
 * actionable queues" — digest.ts), so a terminal row "cannot appear in this list
 * at all" and `shipped` was "a FUNNEL-only word". THAT WAS FALSE, and believing it
 * is why nobody noticed that every landed item was still being listed on Improve.
 * The open-only rule governs `autoEligible`/`humanQueue`; this list is a DIFFERENT
 * corpus — learning-digest-snapshot.ts merges `scoreImprovementCandidates(candidates)`,
 * the whole candidate set, through `mergeLearningImproveRows`. Terminal rows reached
 * this function every day. Do not restore the claim from the shape of digest.ts;
 * check the merge the rows actually come from.
 *
 * `shipped` is now unreachable for a REAL and checkable reason instead: the server
 * merge drops landed rows outright (D-005 — an item leaves Improve exactly when it
 * arrives on Retain), pinned by learning-improve-view-query.test.ts. `dropped` stays
 * reachable — Retain never takes abandoned work, so Improve remains its only home.
 * Both terminal branches are kept: one line each, and falling through to `approved`
 * would label a finished or abandoned item as waiting work.
 */
function pipelineState(row: LoopRow): PipelineState {
  const item = row.item;
  if (!item) return "not-ready";
  if (item.state === "resolved") return "shipped";
  if (item.state === "closed") return "dropped";
  return item.assignee ? "in-flight" : "approved";
}

/** Recency for the merged sort, in days, from whichever half the row has.
 *  Work items carry `ageDays` from the digest; ideas carry a routing instant. */
function rowAgeDays(row: LoopRow, nowMs: number): number {
  if (row.item) return row.item.ageDays;
  const at = row.idea?.routedAt ? Date.parse(row.idea.routedAt) : NaN;
  return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : (nowMs - at) / 86_400_000;
}

function ImprovementsView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const RAIL_META = railMeta(t);
  const openArming = useOpenArming();
  const [scope, setScope] = useQueryState(
    "lscope",
    parseAsStringEnum<LoopScope>([...LOOP_SCOPES]).withDefault("loop"),
  );
  // P-042: the tab-level hive lens scopes the feed to one hive's member-harness
  // improvements; '' ⇒ the workspace-wide feed (no hive arg). Gated on
  // hiveReady (WI-5412): this is the tab's heaviest read — firing it before
  // the lens resolves paid it twice on every first click.
  //
  // The scope arg is passed ONLY for 'all' (P-002): 'loop' is the resolver's
  // default, and the derived-read producer precomputes exactly the default
  // variant. Sending `scope:'loop'` explicitly would be a different args key,
  // miss the snapshot, and pay the 0.4-0.5s inline compute on every mount.
  // Parse the complete impf state before the sync read so storage-backed axes
  // are bounded in SQL; presentation-only filters remain client-derived.
  const filterCols = useMemo<FilterableColumn<LoopRow>[]>(
    () => [
      {
        key: "kind",
        header: "Kind",
        filter: { type: "enum", accessor: (r) => r.item?.kind ?? "—" },
      },
      {
        key: "severity",
        header: "Severity",
        filter: { type: "enum", accessor: (r) => r.item?.severity ?? "—" },
      },
      {
        key: "scope",
        header: "Scope",
        filter: { type: "enum", accessor: (r) => r.item?.scope ?? "—" },
      },
      {
        key: "stage",
        header: "Stage",
        filter: {
          type: "enum",
          accessor: (r) => PIPELINE_STATES[pipelineState(r)].label,
        },
      },
      {
        key: "ideaType",
        header: "Idea type",
        filter: { type: "enum", accessor: (r) => r.item?.ideaType ?? "—" },
      },
      {
        key: "lens",
        header: "Lens",
        filter: { type: "enum", accessor: (r) => r.idea?.lens ?? "—" },
      },
      {
        key: "score",
        header: "Score",
        filter: { type: "number", accessor: (r) => r.item?.score ?? 0 },
      },
      {
        key: "ageDays",
        header: "Age (days)",
        filter: { type: "number", accessor: (r) => r.item?.ageDays ?? 0 },
      },
    ],
    [],
  );
  const [filterState] = useQueryState("impf", parseAsColumnFilters(filterCols));
  const [search, setSearch] = useQueryState(
    "impq",
    parseAsString.withDefault(""),
  );
  const [lane, setLane] = useQueryState(
    "lane",
    parseAsStringEnum<Lane>([...LANES]).withDefault("all"),
  );
  const [src, setSrc] = useQueryState("lsrc", parseAsString);
  const [railFilter, setRailFilter] = useQueryState("irail", parseAsString);
  const serverFilters = useMemo<LearningServerFilters>(() => {
    const valuesFor = (key: string): string[] => {
      const value = filterState?.[key];
      if (Array.isArray(value))
        return value.filter((item): item is string => typeof item === "string");
      return typeof value === "string" && value ? [value] : [];
    };
    const kinds = valuesFor("kind").filter(
      (kind): kind is NonNullable<LearningImprovementsArgs["kinds"]>[number] =>
        kind === "bug" || kind === "change" || kind === "feature",
    );
    const severities: Array<
      NonNullable<LearningImprovementsArgs["severities"]>[number]
    > = [];
    for (const severity of valuesFor("severity")) {
      if (
        severity === "critical" ||
        severity === "major" ||
        severity === "minor" ||
        severity === "nit"
      ) {
        severities.push(severity);
      }
    }
    const scopes = valuesFor("scope").filter(
      (scopeValue) => scopeValue !== "—",
    );
    const stages = valuesFor("stage").flatMap((label) => {
      if (label in PIPELINE_STATES) {
        return [
          label as NonNullable<LearningImprovementsArgs["stages"]>[number],
        ];
      }
      const hit = Object.entries(PIPELINE_STATES).find(
        ([, meta]) => meta.label === label,
      );
      return hit
        ? [hit[0] as NonNullable<LearningImprovementsArgs["stages"]>[number]]
        : [];
    });
    const ideaTypes = valuesFor("ideaType").filter((value) => value !== "—");
    const lenses = valuesFor("lens").filter((value) => value !== "—");
    const rangeFor = (
      key: string,
    ): NonNullable<LearningImprovementsArgs["score"]> | undefined => {
      const value = filterState?.[key];
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      const min =
        typeof value.min === "number" && Number.isFinite(value.min)
          ? value.min
          : undefined;
      const max =
        typeof value.max === "number" && Number.isFinite(value.max)
          ? value.max
          : undefined;
      return min === undefined && max === undefined ? undefined : { min, max };
    };
    const score = rangeFor("score");
    const ageDays = rangeFor("ageDays");
    return {
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(severities.length > 0 ? { severities } : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(stages.length > 0 ? { stages } : {}),
      ...(ideaTypes.length > 0 ? { ideaTypes } : {}),
      ...(lenses.length > 0 ? { lenses } : {}),
      ...(score ? { score } : {}),
      ...(ageDays ? { ageDays } : {}),
    };
  }, [filterState]);
  const serverArgs = useMemo<LearningImprovementsQueryArgs>(
    () => ({
      ...(hive ? { hive } : {}),
      ...(scope === "all" ? { scope: "all" as const } : {}),
      ...(lane !== "all" ? { lanes: [lane] } : {}),
      ...(src ? { sources: [src] } : {}),
      ...(railFilter ? { rails: [railFilter] } : {}),
      ...serverFilters,
      ...((search ?? "").trim() ? { q: (search ?? "").trim() } : {}),
    }),
    [hive, lane, railFilter, scope, search, serverFilters, src],
  );
  const serverPredicateActive =
    lane !== "all" ||
    Boolean(src) ||
    Boolean(railFilter) ||
    Boolean((search ?? "").trim()) ||
    Object.values(serverFilters).some((value) => value !== undefined);
  const sync = useSyncQuery<LearningImprovementsRow>({
    queryName: "learning.improvements",
    args: serverArgs,
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const digestCandidate = sync.data?.[0];
  // A resolved sync read can contain unavailable provenance or snapshot metadata
  // without a digest. Keep those rows on the existing retry path; treating one
  // as queue data crashes on window.byState before the error UI can render.
  const incompleteDigest = Boolean(
    digestCandidate &&
      (!digestCandidate.window?.byState ||
        !Number.isFinite(digestCandidate.window?.open)),
  );
  const improveFault = snapshotFault(
    sync.error ?? (incompleteDigest ? "Incomplete Improve snapshot" : null),
    digestCandidate,
    "Improve",
  );
  const digest = improveFault.failed ? undefined : digestCandidate;
  const summarySync = useSyncQuery<CompanionListSummary>({
    queryName: "learning.improvements.summary",
    args: serverArgs,
    staleTime: 30_000,
    enabled: hiveReady && serverPredicateActive,
  });
  const improveSummaryCandidate = summarySync.data?.[0];
  const improveSummary =
    improveSummaryCandidate &&
    Number.isSafeInteger(improveSummaryCandidate.total) &&
    Number.isSafeInteger(improveSummaryCandidate.matched) &&
    Array.isArray(improveSummaryCandidate.facets)
      ? improveSummaryCandidate
      : undefined;
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — LearningTab
  // begins the interaction on the view change (EI-19375505819043214).
  //
  // WHY THIS VIEW MATTERS MOST: `improvements` is both the tab's DEFAULT
  // landing view and its heaviest read (learning.improvements measured
  // 320,607B on the live operator, ~98.6% of it a 454-row humanQueue). It is
  // therefore the view the owner most plausibly meant by "expanding the
  // sections took several seconds" — and until now it had no settle point at
  // all, so the instrument added to answer that report was structurally
  // incapable of measuring it. A per-view experiment run against the real
  // desktop reported nothing for this view for exactly this reason.
  //
  // Gated on the PRIMARY read only (learning.improvements), deliberately not
  // on the scout / drafts legs: those are secondary sections, and waiting on
  // them would attribute their cost to this interaction. Same rule as the
  // sibling settle points in AnalyzePanel and ObservationsPanel.
  //
  // Settles on a FAULT too, not just success — a slow FAILING view is exactly
  // what the owner described, and ending only on success would leave the start
  // mark dangling until STALE_START_MS discarded it, measuring nothing.
  //
  // Note `enabled: hiveReady` above: while the pot lens is unresolved the read
  // is disabled (loading false, data undefined, no error), so `settled` stays
  // false and the interaction correctly spans the lens resolution the user is
  // actually waiting through.
  //
  // Gated on `active` as well: this pane is kept MOUNTED when the user switches
  // away (warmViews below), so on a revisit `improvementsSettled` is already
  // true and never changes — an effect keyed on it alone would never re-run and
  // the switch would measure nothing (EI-19383745196363732).
  const summarySettled =
    !serverPredicateActive ||
    (!summarySync.loading &&
      (summarySync.data !== undefined || Boolean(summarySync.error)));
  const improvementsSettled =
    !sync.loading &&
    (sync.data !== undefined || Boolean(sync.error)) &&
    summarySettled;
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    improvementsSettled,
    active,
  );
  // The idea half of the same population (absorbed from the retired Ideas
  // view): lens, rail, grounding trace, grade and outcome, plus the cycle
  // engine's own instruments. Same hive lens, same readiness gate.
  const scoutSync = useSyncQuery<ScoutSnapshot>({
    queryName: "learning.scout",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const snap = scoutSync.data?.[0];
  const routed = useMemo(
    () => digest?.routedRows ?? snap?.recent ?? [],
    [digest?.routedRows, snap?.recent],
  );
  const rails = snap?.railCounts ?? [];
  const health = snap?.health ?? { status: "neutral" as const, markers: [] };
  const groundingTitles = snap?.groundingTitles ?? {};
  // Drafts-in-iteration (moved here from the Ideas view — owner ask
  // 2026-07-19): a draft plan awaiting revision is WORK IN PROGRESS, so it
  // belongs on the backlog surface. Thin dedicated read, never the heavy
  // learning.scout snapshot.
  // WI-6385: same lens and same readiness gate as the two legs above. It
  // previously had neither, so under a selected pot this list showed every
  // pot's drafts beside two pot-scoped siblings.
  // WI-6395: enveloped (`[{ items, unavailable? }]`) so a failed read stops
  // arriving as "no drafts in iteration". This is a SECONDARY read on the
  // Improvements view — its failure must not blank the primary list, so it
  // degrades to an empty drafts section rather than an error page; the
  // provenance is still carried for the section's own copy.
  const draftsSync = useSyncQuery<{ items?: ScoutDraftIteration[] }>({
    queryName: "learning.scoutDrafts",
    args: hive ? { hive } : {},
    staleTime: 60_000,
    enabled: hiveReady,
  });
  const drafts = draftsSync.data?.[0]?.items ?? [];
  // WI-6410: the comment above promised "the provenance is still carried for
  // the section's own copy" — and nothing read it. The envelope was built, the
  // flag arrived, and this view dropped it on the floor, so a failed drafts read
  // rendered as no drafts section at all. A comment is not an enforcement
  // mechanism (the same lesson the server guard's header records); the guard
  // that now covers this file is.
  const draftsFault = snapshotFault(
    draftsSync.error,
    draftsSync.data?.[0],
    "Drafts in iteration",
  );
  // Selected item (`?lsel=`): set by deep-links (e.g. a Scout-routed improvement
  // click) — the row is highlighted + scrolled into view; clicking it dismisses.
  //
  // "Scrolled into view" is TWO mechanisms, because the list has two renderers:
  // the card list scrolls the row itself (`LoopRowView`), and the grid asks the
  // virtualizer (`ImproveGrid`'s `scrollToRowKey`). It cannot be one mechanism —
  // under virtualization the target row is usually not mounted, so it cannot run
  // an effect to scroll itself. This comment claimed the whole behaviour while
  // only the card half existed — on the path taken by a pot with FEWER than 4
  // open items, i.e. the one short enough not to need scrolling (WI-523949).
  const [lsel, setLsel] = useQueryState("lsel", parseAsString);
  // Absorbed from the retired Ideas view, both URL state so an agent can drive
  // them through ui:dispatch: the rail facet and the pipeline-trace expansion.
  const [traceOpen, setTraceOpen] = useQueryState("itrace", parseAsString);

  // ── Grading, absorbed from the Ideas view. The note popover's open-state is
  // URL state (`?grade=<ideaId>`) so agents can drive it; in-flight optimistic
  // grades and errors are transient lifecycle, so they stay in useState. A
  // grade from this surface is an OWNER grade (the server derives gradedBy from
  // the caller), and owner regrade is always allowed, so the stars stay
  // interactive on already-graded rows.
  //
  // This is the ONLY control on a row, by owner ruling: in a full-auto loop the
  // human teaches the generator and does not approve the work ["the learning
  // loops is designed to be full auto so needs a call makes no sense" — owner
  // 2026-07-27].
  const [gradeOpen, setGradeOpen] = useQueryState("grade", parseAsString);
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticGrade>>(
    {},
  );
  const [savingId, setSavingId] = useState("");
  const [gradeError, setGradeError] = useState("");
  const effectiveGrade = useCallback(
    (idea: ScoutRoutedItem): EffectiveGrade | null => {
      const opt = optimistic[idea.ideaId];
      // The overlay applies while the write is IN FLIGHT — that is the whole of
      // what it is for — and after that only until the read it is bridging
      // answers (see OptimisticGrade). The in-flight term is the primary one:
      // without it an unrelated snapshot arriving mid-POST expires the overlay
      // and flashes the pre-write grade back at the user. Once EITHER bound
      // breaks the ledger wins, because the ledger is the grade authority: this
      // same column is written by peer owner sessions and by the auto-grader, so
      // an overlay that never expires does not show "our write pending", it
      // shows a stale grade forever (WI-518795).
      if (
        opt &&
        (savingId === idea.ideaId ||
          (opt.snapshot === snap && idea.humanGrade === opt.supersedes))
      )
        return opt;
      if (idea.humanGrade == null) return null;
      return {
        grade: idea.humanGrade,
        feedback: idea.humanFeedback ?? null,
        gradedBy: idea.gradedBy ?? "owner",
      };
    },
    [optimistic, snap, savingId],
  );
  const submitGrade = async (
    idea: ScoutRoutedItem,
    grade: number,
    feedback: string | null,
  ) => {
    setGradeError("");
    setSavingId(idea.ideaId);
    const prevEntry = optimistic[idea.ideaId] ?? null;
    // Optimistic: show the new grade immediately; the refetched snapshot
    // supersedes it (or the catch below rolls it back). `snapshot`/`supersedes`
    // are what make "supersedes" true rather than aspirational — they record
    // exactly what the ledger read when we wrote, so the overlay expires the
    // moment that stops being what it reads.
    setOptimistic((m) => ({
      ...m,
      [idea.ideaId]: {
        grade,
        feedback,
        gradedBy: "owner",
        snapshot: snap,
        supersedes: idea.humanGrade,
      },
    }));
    try {
      const res = await fetch("/api/agent-tools/scout/grade-idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ideaId: idea.ideaId,
          grade,
          ...(feedback ? { feedback } : {}),
        }),
      });
      const raw: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = unwrapToolResult(raw);
      if (result.applied === false)
        throw new Error(String(result.reason ?? "grade not applied"));
      scoutSync.invalidate();
    } catch (e) {
      setOptimistic((m) => {
        const next = { ...m };
        if (prevEntry) next[idea.ideaId] = prevEntry;
        else delete next[idea.ideaId];
        return next;
      });
      setGradeError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId("");
    }
  };

  // ── Deep-links out of a trace (all nuqs, so ui:dispatch can drive the same
  // navigation). The merge simplifies the common case: an idea that routed to a
  // work item no longer navigates ANYWHERE — its work is a row on this very
  // list, so "open it" means select it here.
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setCreateView] = useQueryState("view", parseAsString);
  const [, setPlanSel] = useQueryState("plan", parseAsString);
  const [, setLviewTarget] = useQueryState("lview", parseAsString);
  const [, setTopBarSlug] = useQueryState("slug", parseAsString);
  const openPlan = useCallback(
    (slug: string) => {
      void setPlanSel(slug);
      void setCreateView("plans");
      void setTab("plans");
    },
    [setCreateView, setPlanSel, setTab],
  );
  // Select a work item ON THIS LIST, clearing the facets that could hide it —
  // a sticky lane or rail filter would swallow the click and read as a no-op.
  const openImprovement = useCallback(
    (id: string) => {
      void setLsel(id);
      void setLane(null);
      void setSrc(null);
      void setRailFilter(null);
    },
    [setLane, setLsel, setRailFilter, setSrc],
  );
  const openRouted = useCallback(
    (idea: ScoutRoutedItem) => {
      if (idea.rail === "plan" && idea.routedRef.startsWith("plan:")) {
        openPlan(idea.routedRef.slice("plan:".length));
      } else if (idea.rail === "gym") {
        // WI-5412: carry the idea's hive so the Gym opens on the seed's data.
        // The ledger doesn't stamp harness_slug consistently (EI-10520) — treat
        // absence as unknown and navigate without touching the selection.
        if (idea.harnessSlug) void setTopBarSlug(idea.harnessSlug);
        void setLviewTarget("gym");
      } else if (idea.rail === "instance") {
        void setLviewTarget("benchmark");
      } else {
        openImprovement(
          idea.routedRef.startsWith("wi:")
            ? idea.routedRef.slice("wi:".length)
            : idea.routedRef,
        );
      }
    },
    [openImprovement, openPlan, setLviewTarget, setTopBarSlug],
  );

  // ── The join. An idea records the artifact it became as a typed ref, so a
  // work-item routing is "wi:EI-…" and the two halves key on the work-item id.
  // Multiple ideas can be routed to the same item; retain every routing so each
  // idea keeps its own trace and grading control.
  const ideasByItemId = useMemo(() => {
    const byId = new Map<string, ScoutRoutedItem[]>();
    for (const idea of routed) {
      if (!idea.routedRef.startsWith("wi:")) continue;
      const id = idea.routedRef.slice("wi:".length);
      const ideas = byId.get(id);
      if (ideas) ideas.push(idea);
      else byId.set(id, [idea]);
    }
    return byId;
  }, [routed]);

  const allRows = useMemo<LoopRow[]>(() => {
    const nowMs = Date.now();
    const base = !digest
      ? []
      : lane === "auto"
        ? digest.autoEligible
        : lane === "human"
          ? digest.humanQueue
          : [...digest.autoEligible, ...digest.humanQueue];
    const workRows: LoopRow[] = base.flatMap((item): LoopRow[] => {
      const ideas = ideasByItemId.get(item.id) ?? [];
      if (ideas.length === 0) {
        return [{ key: item.id, item: item as SlimHumanQueueItem, idea: null }];
      }
      return ideas.map((idea) => ({
        key: `${item.id}:${idea.ideaId}`,
        item: item as SlimHumanQueueItem,
        idea,
      }));
    });
    // Ideas with no work-item row of their own — routed to a plan/gym/benchmark
    // rail, or not yet filed at all. These are the loop's output BEFORE it
    // becomes work, and the owner named them explicitly as in scope.
    //
    // The lane facet (auto-fixable / needs-review) is a WORK-ITEM triage
    // decision, so an idea-only row cannot satisfy it — selecting a lane
    // excludes them rather than showing rows the filter never judged. The
    // column filters need no such rule: their accessors read through `item`
    // and report "—" here, so an idea-only row drops out of a severity or
    // state filter on its own.
    const filed = new Set(workRows.map((row) => row.item?.id));
    const ideaRows: LoopRow[] =
      lane === "all"
        ? routed
            .filter((idea) => {
              if (!idea.routedRef.startsWith("wi:")) return true;
              return !filed.has(idea.routedRef.slice("wi:".length));
            })
            .map((idea) => ({ key: idea.ideaId, item: null, idea }))
        : [];
    // Most-recent first across BOTH halves. Work items carry a fractional
    // `ageDays` from the digest and ideas a routing instant, so age-in-days is
    // the one key both can answer; the sequential id suffix (the old Backlog
    // sort) stays as the tie-break for same-instant captures.
    const idNum = (s: string) => {
      const n = parseInt(s.split("-").pop() ?? "", 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [...workRows, ...ideaRows].sort((a, b) => {
      const d = rowAgeDays(a, nowMs) - rowAgeDays(b, nowMs);
      if (Math.abs(d) > 1e-9) return d;
      return idNum(b.item?.id ?? b.key) - idNum(a.item?.id ?? a.key);
    });
  }, [digest, ideasByItemId, lane, routed]);

  // WI-471938: a filter control's OPTION SET is a claim about what EXISTS, so every source
  // it can answer must come from the CORPUS — never from the rows this read happened to
  // load. Three tiers, corpus-wide first, and the window is only the last resort:
  //
  //   1. `improveSummary` facets — corpus-wide, with the source dimension omitted from its
  //      own selection (so picking a source does not collapse the set to that source).
  //      Present only while `serverPredicateActive`, i.e. NOT on the default landing view.
  //   2. `digest.sourceOptions` — the corpus-wide aggregate the unfiltered snapshot path
  //      carries for exactly that gap. Absent (not empty) if the aggregate failed.
  //   3. the loaded window — kept as the degraded fallback for both of those going missing.
  //
  // Tier 2 exists because tier 3 was silently wrong on the landing view: the window is
  // capped at 500 over a corpus that is thousands of rows, so a source whose rows all sit
  // past the cap rendered NO chip and could not be selected at all. Measured on the live
  // corpus 2026-08-28: `system` had 15 rows and none of them inside the window, while
  // `Scout`'s newest row sat at rank 474 of 500 — 27 more arrivals and the strip would have
  // rendered nothing at all (it is gated on `sources.length > 0`) over a corpus holding
  // 1,022 sourced rows. The rail chips beside these already take their option set from a
  // corpus-wide source (`snap.railCounts`); this closes the asymmetry.
  const sources = useMemo<string[]>(() => {
    const serverFacet = improveSummary?.facets?.find(
      (facet) => facet.key === "source",
    );
    if (serverFacet) return serverFacet.values.map((value) => value.value);
    if (digest?.sourceOptions)
      return digest.sourceOptions.map((option) => option.value);
    const s = new Set<string>();
    for (const it of [
      ...(digest?.autoEligible ?? []),
      ...(digest?.humanQueue ?? []),
    ]) {
      if (it.source) s.add(it.source);
    }
    return [...s].sort();
  }, [digest, improveSummary]);

  // The rows the RAIL facet runs on: everything the view loaded, narrowed only
  // by the upstream source chip. Split out of `rows` below so the rail chip
  // COUNTS and the rail FILTER are computed from one row set rather than two
  // derivations that can disagree (D-003).
  //
  // Who filed it (`?lsrc=`) — a chip row in the scope bar rather than the old
  // dropdown, so the provenance split is readable without opening a menu.
  const railScopedRows = useMemo<LoopRow[]>(
    () => (src ? allRows.filter((row) => row.item?.source === src) : allRows),
    [allRows, src],
  );
  // D-003: a number rendered ON a filter control is a promise about what
  // clicking it yields. These chips used to print `snap.railCounts` — a
  // CORPUS-wide tally from the scout snapshot — above a list that holds at most
  // the digest's window, so `improvement 992` clicked through to `17 of 503`.
  // Deriving the count from the rows the filter actually runs on is the same
  // invariant the Work Queue gets from `deriveEnumOptions(rows, col)`, and it
  // holds BY CONSTRUCTION here: this map and `rows` below read `railScopedRows`.
  // The corpus number is not lost — it moves to the chip's tooltip, where it is
  // context rather than a promise (and to the honest `N of total` denominators).
  const railCounts = useMemo(() => {
    const serverFacet = improveSummary?.facets?.find(
      (facet) => facet.key === "rail",
    );
    if (serverFacet) {
      return new Map(
        serverFacet.values.map((value) => [value.value, value.count]),
      );
    }
    const counts = new Map<string, number>();
    for (const row of railScopedRows) {
      const rail = row.idea?.rail;
      if (!rail) continue;
      counts.set(rail, (counts.get(rail) ?? 0) + 1);
    }
    return counts;
  }, [improveSummary, railScopedRows]);
  const rows = useMemo<LoopRow[]>(() => {
    // Which rail the idea routed into (`?irail=`, absorbed from Ideas). A rail
    // is a property of the IDEA, so filtering by one necessarily narrows to
    // idea-bearing rows — that is the question being asked.
    if (!railFilter) return railScopedRows;
    return railScopedRows.filter((row) => row.idea?.rail === railFilter);
  }, [railScopedRows, railFilter]);
  // The small-queue path: no dashboard, no facets, just the list. It must span
  // BOTH halves — a pot with routed ideas but nothing filed yet has a perfectly
  // non-empty Improve list, and rendering only the work items there would show
  // "the loop has not produced anything" while sitting on the loop's output.
  // (It ignores the lane facet by design: sparse mode renders no lane control.)
  const sparseRows = useMemo<LoopRow[]>(() => {
    const items = [
      ...(digest?.autoEligible ?? []),
      ...(digest?.humanQueue ?? []),
    ];
    const filed = new Set(items.map((item) => item.id));
    return [
      ...items.flatMap((item): LoopRow[] => {
        const ideas = ideasByItemId.get(item.id) ?? [];
        if (ideas.length === 0) {
          return [{ key: item.id, item: item as SlimHumanQueueItem, idea: null }];
        }
        return ideas.map((idea) => ({
          key: `${item.id}:${idea.ideaId}`,
          item: item as SlimHumanQueueItem,
          idea,
        }));
      }),
      ...routed
        .filter((idea) => {
          if (!idea.routedRef.startsWith("wi:")) return true;
          return !filed.has(idea.routedRef.slice("wi:".length));
        })
        .map((idea) => ({ key: idea.ideaId, item: null, idea })),
    ];
  }, [digest, ideasByItemId, routed]);
  // Shared column filters + quick-search (owner ask 2026-07-19: mimic the
  // Working tab's Work Queue): the shared filter engine (`impf` param) over
  // the lane/source-scoped rows, plus a global substring quick-search
  // (`impq`) as its own affordance — the same split WorkItemsPanel uses.
  // Accessors read THROUGH the work-item half: an idea-only row answers "—" to
  // every work-item column, so it drops out of any such filter by itself, and
  // the lens column is the one facet an idea-only row can actually answer.
  const improveCountEvidence = useMemo<CountEvidence>(() => {
    if (serverPredicateActive) {
      if (summarySync.error) return { kind: "unknown", reason: "failed" };
      if (!improveSummary || summarySync.loading)
        return { kind: "unknown", reason: "updating" };
      return {
        kind: "corpus",
        count: improveSummary.matched,
        total: improveSummary.total,
        population: "the complete scoped Improve corpus",
      };
    }
    return digest == null
      ? { kind: "unknown", reason: "loading" }
      : {
          kind: "window",
          count: rows.length,
          window:
            "the current bounded Improve digest window after source and rail scope",
        };
  }, [
    digest,
    improveSummary,
    rows.length,
    serverPredicateActive,
    summarySync.error,
    summarySync.loading,
  ]);
  const serverEnumOptions = useMemo(() => {
    if (!improveSummary || !Array.isArray(improveSummary.facets))
      return undefined;
    return new Map(
      improveSummary.facets.map((facet) => [
        facet.key,
        facet.values.map((value) => ({
          value: value.value,
          count: value.count,
        })),
      ]),
    );
  }, [improveSummary]);
  const cf = useColumnFilters(filterCols, rows, {
    ns: "imp",
    countEvidence: improveCountEvidence,
    serverEnumOptions,
  });
  const visibleRows = useMemo(() => {
    // Predicate-bearing server payloads carry `routedRows` (empty is still a
    // marker). The server already searched raw tierReason before interning it;
    // re-running q here would erase auto-lane tierReason-only hits because only
    // the human queue is interned on the legacy wire shape.
    if (digest?.routedRows !== undefined) return cf.rows;
    const q = (search ?? "").trim().toLowerCase();
    if (!q) return cf.rows;
    // Search spans BOTH halves — an idea's title is often the only text an
    // as-yet-unfiled row has.
    // `tierReason` is EXPANDED from its interned code here (WI-39773 / D-008).
    // It is never rendered, but it has always been searchable, and the whole
    // point of interning rather than dropping it is that this haystack keeps
    // matching the same text — a miss here costs no error, just quietly fewer
    // hits, which is why the expansion lives at the haystack and not at render.
    return cf.rows.filter((row) =>
      `${row.item?.id ?? ""} ${row.item?.title ?? ""} ${tierReasonOf(digest?.tierReasonLegend, row.item)} ${row.item?.scope ?? ""} ${row.idea?.title ?? ""} ${row.idea?.lens ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [cf.rows, search, digest]);
  const isFiltered = serverPredicateActive;

  // Everything a row needs, bundled once. A merged row draws on both halves of
  // the view's state (selection, trace, grading, navigation), and threading a
  // dozen props through the windowed list is how one of them silently goes
  // stale — the row components take this object and nothing else.
  // Deliberately NOT memoized: `onGrade` is a per-render closure over the
  // in-flight grade state, so a dependency list would either omit it (and
  // capture a stale rollback snapshot) or change every render anyway. The row
  // components are not memo()'d, so a fresh object costs nothing.
  const rowCtx: LoopRowContext = {
    railMetaMap: RAIL_META,
    groundingTitles,
    brainWord: t("brain"),
    traceOpen,
    onToggleTrace: (id) => void setTraceOpen(id),
    gradeOpen,
    onGradeOpenChange: (id) => void setGradeOpen(id),
    effectiveGrade,
    onGrade: submitGrade,
    savingId,
    onOpenRouted: openRouted,
    onOpenPlan: openPlan,
    onOpenImprovement: openImprovement,
    onDismissSelect: () => void setLsel(null),
  };

  const resolved = digest?.window.byState.resolved ?? 0;
  // A predicate-bearing zero result is still dashboard mode: the search,
  // filters, exact `0 of 0` evidence, and reset controls must remain mounted so
  // the user can recover from the empty result. Keying this only to the
  // FILTERED digest's `open` count made an exact zero unmount the very controls
  // that produced it (WI-40590 / EI-21160436085146708).
  const showDashboard = serverPredicateActive || (digest?.window.open ?? 0) >= 4;
  // The badge reports whether the LOOP is healthy, not whether the pile is big.
  // The drift markers (single-lens collapse, budget-exhausted streak, grading
  // starvation) are server-evaluated against the blender-release-readiness
  // rubric — they are the health spec, so they win over any row count here.
  //
  // The old "humanQueue is non-empty ⇒ warn" rule is deliberately GONE: it
  // nagged about a review queue the human is not supposed to action ["the
  // learning loops is designed to be full auto so needs a call makes no sense"
  // — owner 2026-07-27]. Retiring the queue's remaining vocabulary is P-004.
  useEffect(() => {
    onStatus?.(
      improveFault.failed ||
        scoutSync.error ||
        (serverPredicateActive && summarySync.error)
        ? "bad"
        : health.status !== "neutral"
          ? health.status
          : !digest
            ? "neutral"
            : digest.window.open === 0
              ? "good"
              : "neutral",
    );
  }, [
    digest,
    health.status,
    onStatus,
    scoutSync.error,
    serverPredicateActive,
    summarySync.error,
    improveFault.failed,
  ]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Sparkles}
        title="Improve"
        question="What the learning loop produced — each idea and the work it became. Grading an idea is what teaches the generator."
        signal={digest ? `${digest.window.open} open` : undefined}
        tone={
          health.status !== "neutral"
            ? health.status
            : digest && digest.window.open === 0
              ? "good"
              : "accent"
        }
        /* P-003: the reload moved onto the table's own toolbar below, where
           Retain keeps it. Two refresh buttons for one feed would have been the
           cost of adding it there and leaving this one. */
      />

      {/* ONE plain-language glance line, absorbed from the Ideas view: what the
          loop produced, what is still open, and when it next fires. Every gauge
          stays behind the labelled disclosure below. */}
      <p className="pc-learning__glance" aria-label="The loop at a glance">
        <span title="Every idea a cycle turned into an artifact (work item, plan, gym seed, benchmark).">
          <strong>{snap?.totalRouted ?? 0}</strong> ideas
        </span>
        {digest ? (
          <span
            title={`${PIPELINE_STATES.approved.desc} Includes work already in flight.`}
          >
            <strong>{digest.window.open}</strong> in the queue
          </span>
        ) : null}
        {snap?.improveFunnel ? (
          <span title={PIPELINE_STATES.shipped.desc}>
            <strong>{snap.improveFunnel.done}</strong>{" "}
            {PIPELINE_STATES.shipped.label}
          </span>
        ) : null}
        {health.markers.length > 0 ? (
          <span
            className="is-warn"
            title={health.markers
              .map((m) => `${m.key.replace(/-/g, " ")}: ${m.summary}`)
              .join("\n")}
          >
            <AlertTriangle size={11} aria-hidden />
            {health.markers.length} loop warning
            {health.markers.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>

      {/* ── The facet strip: triage lane, then provenance, in ONE segmented row
          (P-003, owner 2026-08-28 — "lets just adopt that look for the improve
          tab as well"). It is the same pc-learning__seg chrome the Retained
          ledger's type strip uses; what changed here is only that Improve's two
          axes previously sat in two unrelated bars — a pill row up here and a
          tab group buried in the toolbar — so the reader had to discover that
          they compose.

          The scope axis is still THE control that makes this list honest.
          Measured 2026-07-27: 8,202 rows — 99.93% of the old Backlog — were
          also on the Work tab, because this read applied no provenance filter
          at all. Scoping to the loop's own output is the default; everything
          else is one click away, and the way OUT is stated rather than left
          for the reader to wonder about. */}
      <div className="pc-learning__segrow">
        {showDashboard ? (
          <div
            className="pc-learning__seg"
            role="tablist"
            aria-label="Triage lane"
          >
            {LANES.filter(
              (l) =>
                l === "all" ||
                (l === "auto"
                  ? (digest?.autoEligible.length ?? 0) > 0
                  : (digest?.humanQueue.length ?? 0) > 0),
            ).map((l) => {
              // The badge is the lane's own population, so a lane never
              // advertises a number the click will not deliver.
              const badge =
                l === "all"
                  ? (digest?.census.total ?? null)
                  : l === "auto"
                    ? (digest?.autoEligible.length ?? null)
                    : (digest?.humanQueue.length ?? null);
              return (
                <Tooltip
                  key={l}
                  label={
                    l === "auto"
                      ? "Bugs agents may fix on their own"
                      : l === "human"
                        ? "Items waiting on your judgment"
                        : null
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={lane === l}
                    className={`pc-learning__segtab${lane === l ? " is-on" : ""}`}
                    onClick={() => void setLane(l)}
                  >
                    {l === "all"
                      ? "All"
                      : l === "auto"
                        ? "Auto-fixable"
                        : "Needs review"}
                    {badge !== null ? <em>{badge}</em> : null}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ) : null}
        {showDashboard ? <span className="pc-learning__segdiv" /> : null}
        <div
          className="pc-learning__seg"
          role="tablist"
          aria-label="Where these came from"
        >
          <Tooltip label="Only what the learning loop produced: ideas, and the work items they became.">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "loop"}
              className={`pc-learning__segtab${scope === "loop" ? " is-on" : ""}`}
              onClick={() => void setScope("loop")}
            >
              <Radar size={11} aria-hidden />
              From the loop
              {digest && scope === "loop" ? <em>{digest.census.total}</em> : null}
            </button>
          </Tooltip>
          <Tooltip label="Every capture in this workspace, including work that never came from the loop — the same population the Work tab lists.">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "all"}
              className={`pc-learning__segtab${scope === "all" ? " is-on" : ""}`}
              onClick={() => void setScope("all")}
            >
              Every capture
            </button>
          </Tooltip>
        </div>
        {sources.length > 0 ? (
          <>
            <span className="pc-learning__segdiv" />
            {/* NOT a tablist, deliberately: unlike the lane and scope segments
                (which always have exactly one selection), "Filed by" is a
                TOGGLE — clicking the active source clears it back to null, so
                the strip can legitimately have nothing selected. That is
                toggle-button-group semantics, not tab semantics. It keeps the
                shared Retain segment CHROME (pc-learning__seg/__segtab) while
                exposing the honest role + aria-pressed. */}
            <div
              className="pc-learning__seg"
              role="group"
              aria-label="Filed by"
            >
              {sources.map((s) => {
                // Display-map ONLY (P-009): 'Queen' is retired display
                // vocabulary but survives in stored payload sourceRole values —
                // the FILTER must keep matching the raw stored value, so only
                // the label maps.
                const label = s === "Queen" ? t("brain") : s;
                return (
                  <Tooltip key={s} label={`Filed by ${label}`}>
                    <button
                      type="button"
                      aria-pressed={src === s}
                      className={`pc-learning__segtab${src === s ? " is-on" : ""}`}
                      onClick={() => void setSrc(src === s ? null : s)}
                    >
                      {label}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </>
        ) : null}
        {scope === "loop" ? (
          <span
            className="pc-learning__segnote"
            title="Captures that did not come from the learning loop are work, not learning — they live on the Work tab."
          >
            work not from the loop lives in Work →
          </span>
        ) : null}
      </div>

      {/* Every gauge behind ONE labelled disclosure: the cycle engine that
          makes ideas, and the capture/resolve flow that burns them down.
          P-004 (owner 2026-08-28) groups them under the plain-language QUESTION
          each answers, instead of one unlabelled pile of chips. Nothing was
          removed — every instrument that was here is still here, now under a
          heading that says what it is for. */}
      <LearningDisclosure
        label="How the loop is doing"
        // Deliberately NOT "five questions": the "Did it stick?" card
        // (LearningEfficacyPanel) wraps itself and renders nothing while its
        // read is cold, so a hard count is wrong on screen exactly when the
        // loop is quietest. Verified live: four cards rendered against a
        // cold efficacy read.
        subtitle="one question per group, each answered in a line"
        aside={<LoopWarningsAside snap={snap} />}
      >
        <LoopEngineInstruments snap={snap} scoutWord={t("scout")} />
        {/* The two "did the work land" questions read side by side: both are
            retrospective, and neither needs full width. */}
        <div className="pc-learning__loopgrid">
          {digest?.flow ? (
            <LoopSection
              label="Is it keeping up?"
              answer={flowAnswer(digest.flow)}
            >
              <FlowStrip flow={digest.flow} />
            </LoopSection>
          ) : null}
          {/* Wraps itself in its own "Did it stick?" section — it is the only
              thing that knows when its read is empty. */}
          <LearningEfficacyPanel />
        </div>
      </LearningDisclosure>

      <LensWeights snap={snap} scoutWord={t("scout")} />

      {/* Rail facet — where each idea routed. Sits directly above the list it
          filters (owner ask 2026-07-19). */}
      {snap && rails.length > 0 ? (
        <div className="pc-learning__idea-filters" aria-label="Idea routing">
          {/* WI-469537. This number describes the CURRENT read, not the one
              clicking produces: clearing the rail drops `rails` from the server
              predicate and re-reads, so the result is the unfiltered window and
              not the rail-scoped set counted here. It is a live description of
              the list, never a promise about the click — so the promise goes in
              the title, where it can say what selecting this will actually do. */}
          <Tooltip
            label={
              railFilter
                ? `${railScopedRows.length} rows listed under the current rail; clearing it re-reads without the rail filter, so the list will grow.`
                : "Rows listed across every rail."
            }
          >
            <button
              type="button"
              aria-pressed={!railFilter}
              onClick={() => void setRailFilter(null)}
            >
              <Radar size={11} aria-hidden />
              All rails <strong>{railScopedRows.length}</strong>
            </button>
          </Tooltip>
          {rails.map((rail) => {
            const meta = RAIL_META[rail.rail];
            // WI-469537 — the mirror of D-003, and the correction of a comment
            // that used to stand here claiming `shown` is "what clicking this
            // chip actually leaves behind". It is not. `shown` counts the rows
            // ALREADY LOADED (railCounts falls back to railScopedRows whenever
            // no server facet exists, which is exactly the default landing
            // view, since summarySync is gated on serverPredicateActive).
            // Clicking enters `rails:[rail]` into the server predicate, and
            // projectLearningImproveRows filters the WHOLE corpus and only THEN
            // windows (learning-improve-view-query.ts:278-283) — so the click
            // yields min(corpus matches, limit), independent of what this
            // window held. D-003's original bug OVER-promised (992 -> 17 of
            // 503); pinning the number to the loaded rows fixed that and left
            // the UNDER-promise. So `shown` stays as the live description of
            // the list, and the title carries what selecting it will actually
            // do.
            const shown = railCounts.get(rail.rail) ?? 0;
            return (
              <Tooltip
                key={rail.rail}
                label={railChipPromise(
                  meta?.desc ?? meta?.label ?? rail.rail,
                  shown,
                  rail.count,
                )}
              >
                <button
                  type="button"
                  aria-pressed={railFilter === rail.rail}
                  onClick={() =>
                    void setRailFilter(
                      railFilter === rail.rail ? null : rail.rail,
                    )
                  }
                >
                  <i style={{ background: meta?.color }} aria-hidden />
                  {meta?.label ?? rail.rail} <strong>{shown}</strong>
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}

      {digest && showDashboard ? (
        // The header signal already carries the headline "N open"; this line is the
        // pipeline breakdown, with Review the one accent (only when it needs eyes).
        <LearningStatLine
          stats={[
            { label: "Captured", value: digest.census.total },
            { label: "Automatic", value: digest.autoEligible.length },
            {
              label: "Review",
              value: digest.humanQueue.length,
              tone: digest.humanQueue.length > 0 ? "warn" : undefined,
            },
            // D-005: landed work is no longer LISTED below — it moved to Retain. The
            // count still belongs here (this line is the pipeline breakdown, not a
            // description of the table), but an unqualified "Resolved" above a table
            // with zero resolved rows sends the reader hunting for rows that are one
            // tab over. The label says where they went.
            { label: "Resolved (on Retain)", value: resolved },
          ]}
        />
      ) : null}

      {showDashboard ? (
        // P-003: the same pc-advpanel__bar the Retained ledger sits under —
        // search, column filters, the live count, then reload. The lane tabs
        // that used to be buried at the end of this row now lead the segmented
        // strip above, with the scope axis they compose with.
        //
        // `pc-learning__improvebar` carries no styling. It is the scoping hook the
        // Retained ledger already gets for free from `.pc-learning__retained`:
        // sharing the chrome means both tabs now render `.pc-advpanel__count`, so a
        // verification selector needs to say WHICH one it means. Without it the only
        // options are an unscoped query (which verify-tauri-headless-quoting.test.ts
        // forbids, precisely because it can silently match the wrong tab) or a
        // structural `:has()` that breaks the moment the toolbar is rearranged.
        <div className="pc-advpanel__bar pc-learning__improvebar">
          <input
            type="text"
            className="pc-advpanel__input"
            value={search ?? ""}
            onChange={(e) => void setSearch(e.target.value)}
            placeholder="Search ideas and work…"
            aria-label="Search ideas and work"
          />
          <ColumnFilterBar
            controller={cf.controller}
            activeChips={cf.activeChips}
            hasActive={cf.hasActive}
            clearAll={cf.clearAll}
          />
          <span
            className="pc-advpanel__count"
            aria-live="polite"
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--fg-mute)",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}
            title={
              isFiltered && improveSummary
                ? `Exact server-authored match count over ${improveSummary.total} merged Improve rows; at most 500 rows cross the sync wire.`
                : isFiltered
                  ? "The paired exact summary is updating; no page-local denominator is substituted."
                  : digest?.window.windowed
                    ? // D-003 again, one level out: this tooltip ANNOTATES a number,
                      // so it may not describe a different population than the one
                      // rendered beside it. It used to say "the list holds the most
                      // recent {examined} of {total} captured", which is false here:
                      // `digest.window.examined` counts the work items the read
                      // projected (buildDigest's bounded `candidates.length` on
                      // the unfiltered path, equal to autoEligible + humanQueue on
                      // the wire), while `rows`
                      // ALSO carries the routed ideas not yet filed as work that
                      // `allRows` appends when lane === 'all'.
                      //
                      // ⚠ This branch is reachable ONLY when `isFiltered` is false —
                      // and `serverPredicateActive` is true for any lane, source,
                      // rail, search or column selection. So every NARROWING path
                      // renders one of the two filtered tooltips above, never this
                      // one, and the divergence here is one-directional: the listed
                      // count can only be >= the window figure. An earlier draft of
                      // this very string claimed "the lane, source and rail
                      // selections narrow that set" — false about the branch it sits
                      // in, which is the same defect it was written to fix.
                      `Rows listed: the ${digest.window.examined} most recent of ${digest.census.total} captured work items, plus any routed ideas not yet filed as work — so this count can exceed ${digest.window.examined}. Filters and counts here see only the loaded rows.`
                    : "Rows in scope — ideas and the work they became."
            }
          >
            {isFiltered
              ? improveSummary && !summarySync.loading
                ? `${visibleRows.length} of ${improveSummary.matched}`
                : "updating"
              : // "listed", not "loaded": on this branch `rows.length` is the loaded
                // work items PLUS the idea-only rows the read never loaded as work,
                // so calling it "loaded" made the visible number itself assert the
                // tooltip's false claim.
                `${rows.length}${digest?.window.windowed ? " listed" : " items"}`}
          </span>
          <Tooltip label="Reload the improve feed">
            <button
              type="button"
              className="pc-advpanel__iconbtn"
              aria-label="Reload the improve feed"
              disabled={sync.fetching || scoutSync.fetching}
              onClick={() => {
                sync.invalidate();
                scoutSync.invalidate();
              }}
            >
              <RefreshCw
                size={13}
                aria-hidden
                className={
                  sync.fetching || scoutSync.fetching
                    ? "pc-advpanel__spin"
                    : undefined
                }
              />
            </button>
          </Tooltip>
        </div>
      ) : null}

      {gradeError ? (
        <p className="pc-learning__empty" role="alert">
          Grade failed: {gradeError}
        </p>
      ) : null}

      {improveFault.failed ? (
        <LearningVisualError
          title="Improve unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : sync.loading && !digest ? (
        <p className="pc-learning__empty">Loading what the loop produced…</p>
      ) : (showDashboard ? visibleRows : sparseRows).length === 0 ? (
        <LearningVisualEmpty
          icon={CheckCircle2}
          title={
            isFiltered
              ? "Nothing matches the current filter / search"
              : "The loop has not produced anything here yet"
          }
          body={
            isFiltered
              ? undefined
              : `The ${t("scout")} reads this ${t("pot", { lower: true })}'s history on a cadence and routes surviving ideas here — cycles usually appear within the hour once armed.`
          }
          action={
            isFiltered
              ? undefined
              : { label: "Open Arming", onClick: openArming }
          }
        />
      ) : !showDashboard ? (
        <ul className="pc-learning__list pc-learning__list--direct">
          {sparseRows.map((row) => (
            <LoopRowView
              key={row.key}
              row={row}
              ctx={rowCtx}
              selected={isSelectedRow(row, lsel)}
            />
          ))}
        </ul>
      ) : (
        <ImproveGrid
          rows={visibleRows}
          lsel={lsel}
          traceOpen={traceOpen}
          ctx={rowCtx}
        />
      )}

      {/* Drafts in iteration (learning-tab-visibility P-005; moved here from
          the Ideas view, owner ask 2026-07-19): broad-scope ideas that became
          draft plans, with their revision state — the Queen↔Scout
          typed-revision loop, watchable instead of invisible. */}
      {draftsFault.failed ? (
        // Deliberately a quiet inline note, NOT a LearningVisualError: this is a
        // SECONDARY read, and blanking the primary improvements list because a
        // side section failed would be a worse lie than the one being fixed.
        // Honest and small beats loud and disproportionate.
        <p className="pc-learning__quietempty">
          {draftsFault.message ?? "Drafts in iteration unavailable"}
        </p>
      ) : drafts.length > 0 ? (
        <LearningDisclosure
          label="Drafts in iteration"
          subtitle="broad ideas that became draft plans, with revision state"
          count={drafts.length}
        >
          <ul
            className="pc-learning__draftlist"
            aria-label={`${t("scout")} draft plans in iteration`}
          >
            {drafts.map((d) => {
              const upMs = d.planUpdatedAt ? Date.parse(d.planUpdatedAt) : NaN;
              return (
                <li key={d.ideaId} className="pc-learning__draftrow">
                  <GitBranch size={11} aria-hidden />
                  <strong title={d.title ?? d.planSlug}>{d.planSlug}</strong>
                  {d.planStatus == null ? (
                    <em title="The draft plan row no longer exists (superseded or deleted).">
                      gone
                    </em>
                  ) : (
                    <em title={`Draft plan lifecycle status.`}>
                      {d.planStatus}
                    </em>
                  )}
                  {d.planVersion != null ? (
                    <span
                      className={`pc-learning__flowchip${d.revised ? " pc-learning__flowchip--wd-good" : ""}`}
                      title={
                        d.revised
                          ? `v${d.planVersion} — revised since ${t("scout", { lower: true })} drafted it: the grade/feedback → typed-revision loop has turned on this draft.`
                          : "v1 — no revision yet; awaiting review/feedback."
                      }
                    >
                      v{d.planVersion}
                      {d.revised ? " · revised" : ""}
                    </span>
                  ) : null}
                  {!Number.isNaN(upMs) ? (
                    <span className="pc-learning__draftwhen">
                      {whenLabel(upMs)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </LearningDisclosure>
      ) : null}
    </section>
  );
}

/* WI-523949: the `IMPROVEMENTS_PAGE = 60` constant that sat here is DELETED, not
 * re-tuned. It documented a first-page/disclosure pager that WI-39536 replaced
 * with virtualization, including a "the deep-link target (?lsel) is hoisted into
 * the first page so a selection is never hidden" guarantee — and it had no
 * remaining references, so that guarantee had been gone as long as the constant
 * had been dead. What replaces it is `ImproveGrid`'s `scrollToRowKey`: the same
 * promise, made where it can actually be kept. */

/** Everything a merged row needs from the view, in one object — see the note at
 *  its construction site for why it is passed whole rather than as props. */
interface LoopRowContext {
  railMetaMap: ReturnType<typeof railMeta>;
  /** Server-resolved titles for the opaque `wi:` grounding refs. */
  groundingTitles: Record<string, string>;
  /** Lexicon word for the grading brain — packs rename it. */
  brainWord: string;
  traceOpen: string | null;
  onToggleTrace: (ideaId: string | null) => void;
  gradeOpen: string | null;
  onGradeOpenChange: (ideaId: string | null) => void;
  effectiveGrade: (idea: ScoutRoutedItem) => EffectiveGrade | null;
  onGrade: (
    idea: ScoutRoutedItem,
    grade: number,
    feedback: string | null,
  ) => Promise<void>;
  savingId: string;
  onOpenRouted: (idea: ScoutRoutedItem) => void;
  onOpenPlan: (slug: string) => void;
  onOpenImprovement: (id: string) => void;
  onDismissSelect: () => void;
}

/** WI-39536: the merged Improve list rendered through the same grid engine as
 *  the Work-tab work queue, the Observations table, and the Retained ledger
 *  (VirtualGrid — the shared filter engine + `impq` quick-search already sit
 *  above it). The card's affordances survive as grid semantics: an idea-bearing
 *  row's title (or a click anywhere on the row) toggles its pipeline trace,
 *  which renders as the grid's expanded row; a `?lsel`-selected row highlights
 *  and dismisses on click; and the grade popover — THE one control on a row
 *  (owner ruling 2026-07-27) — is its own column, stopPropagation-guarded so
 *  grading never toggles the trace underneath it. The read arrives whole (the
 *  digest is one snapshot, not a paged feed), so there is no `onEndReached`:
 *  virtualization is what caps the DOM cost, not the fetch. */
function ImproveGrid({
  rows,
  lsel,
  traceOpen,
  ctx,
}: {
  rows: LoopRow[];
  lsel: string | null;
  traceOpen: string | null;
  ctx: LoopRowContext;
}) {
  // P-003: the same persisted, resizable widths the Retained ledger has, under
  // its own key — a reader who widens Title here is not re-widening it there.
  const [colWidths, setColWidths] = usePersistedColumnWidths(
    "pc-colw:learning:improve",
  );
  // Rebuilt per render on purpose: the defs close over `ctx`, itself a
  // per-render object (see the rowCtx note above) — memoizing on it would
  // change nothing.
  const columns: ColumnDef<LoopRow>[] = [
    {
      key: "item",
      header: "Item",
      // A FLOOR under the fraction (WI-10006513): a bare `1.1fr` shrank this
      // column to 132px on a 1536px-wide window, and the cell's `overflow:
      // hidden` cropped the last digits off every 19-character work-item id —
      // the distinguishing end of the id, with no ellipsis to say so. 160px
      // fits the id plus the cell's 10px padding each side.
      width: "minmax(160px, 1.1fr)",
      toCopyText: (r) =>
        r.item?.id ??
        (r.idea ? (ctx.railMetaMap[r.idea.rail]?.label ?? r.idea.rail) : ""),
      render: ({ row: r }) => {
        if (r.item) return <span className="pc-learning__id">{r.item.id}</span>;
        const meta = r.idea ? ctx.railMetaMap[r.idea.rail] : null;
        // The rail LEADS an idea-only row — where the idea went, since there
        // is no work-item id to act on yet.
        return (
          <span className="pc-learning__id" style={{ color: meta?.color }}>
            {meta?.label ?? r.idea?.rail ?? "idea"}
          </span>
        );
      },
    },
    {
      key: "title",
      header: "Title",
      width: 4,
      toCopyText: (r) =>
        r.item?.title ?? r.idea?.title ?? r.idea?.routedRef ?? "",
      render: ({ row: r }) => {
        const title = r.item?.title ?? r.idea?.title ?? r.idea?.routedRef ?? "";
        if (!r.idea) {
          return (
            <span className="pc-learning__title" title={title}>
              {title}
            </span>
          );
        }
        // Only an idea-bearing row is expandable — the trace IS the idea's
        // record. A real button keeps the affordance keyboard-reachable (the
        // row-level click is mouse-only); stopPropagation so the row click
        // underneath doesn't immediately toggle it back.
        const open = traceOpen === r.idea.ideaId;
        const ideaId = r.idea.ideaId;
        return (
          <button
            type="button"
            className="pc-learning__gridtitlebtn"
            aria-expanded={open}
            aria-label={
              open
                ? `Hide the trace for ${title}`
                : `Show where “${title}” came from — grounding, lens, route, grade, outcome`
            }
            onClick={(e) => {
              e.stopPropagation();
              ctx.onToggleTrace(open ? null : ideaId);
            }}
          >
            <span className="pc-learning__title" title={title}>
              {title}
            </span>
          </button>
        );
      },
    },
    {
      key: "lens",
      header: "Lens",
      width: 1.1,
      toCopyText: (r) => r.idea?.lens ?? "",
      render: ({ row: r }) =>
        r.idea ? (
          <span
            className="pc-learning__chip pc-learning__chip--idea"
            style={{
              color: lensColor(r.idea.lens),
              borderColor: lensColor(r.idea.lens),
            }}
            title="The creative lens that produced this idea"
          >
            {r.idea.lens}
          </span>
        ) : null,
    },
    {
      key: "severity",
      header: "Severity",
      width: 0.9,
      toCopyText: (r) => r.item?.severity ?? "",
      render: ({ row: r }) => {
        if (!r.item) return null;
        const solid = SEVERITY[r.item.severity ?? "minor"].solid;
        return (
          <span
            className="pc-learning__chip"
            style={{ color: solid, borderColor: solid }}
          >
            {r.item.severity ?? "—"}
          </span>
        );
      },
    },
    {
      key: "stage",
      header: "Stage",
      width: 1.1,
      toCopyText: (r) => PIPELINE_STATES[pipelineState(r)].label,
      render: ({ row: r }) => {
        const stage = pipelineState(r);
        return (
          <span
            className={`pc-learning__chip pc-learning__chip--stage-${stage}`}
            title={PIPELINE_STATES[stage].desc}
          >
            {PIPELINE_STATES[stage].label}
          </span>
        );
      },
    },
    {
      key: "age",
      header: "Age",
      // A floor under the fr share: at 1024px the bare 0.7fr track fell below
      // "just now" (44px) and the cell clipped it (WI-10006513).
      width: "minmax(64px, 0.7fr)",
      toCopyText: (r) =>
        r.item
          ? ageLabel(r.item.ageDays)
          : r.idea?.routedAt
            ? whenLabel(Date.parse(r.idea.routedAt))
            : "",
      render: ({ row: r }) => (
        <span className="pc-learning__age" title="How long ago this was filed">
          {r.item
            ? ageLabel(r.item.ageDays)
            : r.idea?.routedAt
              ? whenLabel(Date.parse(r.idea.routedAt))
              : ""}
        </span>
      ),
    },
    {
      key: "score",
      header: "Score",
      width: 0.6,
      align: "right",
      toCopyText: (r) => (r.item ? String(r.item.score) : ""),
      render: ({ row: r }) =>
        r.item ? (
          <span
            className="pc-learning__score"
            title="Triage priority (severity + age) — higher means more urgent"
          >
            {r.item.score}
          </span>
        ) : null,
    },
    {
      key: "grade",
      header: "Grade",
      // Floor = the capped chip (12em) + gap + the 22px note button, so the
      // note button is never pushed out of the cell when narrow windows take
      // width from the fr tracks; the ellipsizing title column gives way
      // instead (WI-10006513).
      width: "minmax(176px, 1.6fr)",
      toCopyText: (r) => {
        const eff = r.idea ? ctx.effectiveGrade(r.idea) : null;
        return eff
          ? `★${eff.grade} · ${graderLabel(eff.gradedBy, ctx.brainWord)}`
          : "";
      },
      render: ({ row: r }) => {
        const idea = r.idea;
        if (!idea) return null;
        const eff = ctx.effectiveGrade(idea);
        const isGradeOpen = ctx.gradeOpen === idea.ideaId;
        const saving = ctx.savingId === idea.ideaId;
        const title = r.item?.title ?? idea.title ?? idea.routedRef;
        return (
          <span
            className="pc-learning__grade"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {eff ? (
              <span
                className="pc-learning__gradechip"
                title={
                  eff.feedback
                    ? `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}: “${eff.feedback}”`
                    : `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}`
                }
              >
                ★{eff.grade} · {graderChipLabel(eff.gradedBy, ctx.brainWord)}
              </span>
            ) : null}
            <Popover
              open={isGradeOpen}
              onOpenChange={(open) =>
                ctx.onGradeOpenChange(open ? idea.ideaId : null)
              }
              trigger={
                <button
                  type="button"
                  className="pc-learning__notebtn"
                  aria-label={eff ? "Review idea grade" : "Grade this idea"}
                  aria-expanded={isGradeOpen}
                >
                  {eff ? (
                    <Star size={12} fill="currentColor" aria-hidden />
                  ) : (
                    <MessageSquarePlus size={12} aria-hidden />
                  )}
                </button>
              }
              tooltipLabel={eff ? "Review this grade" : "Grade this idea"}
              ariaLabel={`Grade ${title}`}
              contentClassName="pc-learning__gradepopover"
            >
              <GradePanel
                current={eff}
                busy={saving}
                onSave={(grade, feedback) => {
                  void ctx
                    .onGrade(idea, grade, feedback)
                    .then(() => ctx.onGradeOpenChange(null));
                }}
                onClose={() => ctx.onGradeOpenChange(null)}
              />
            </Popover>
          </span>
        );
      },
    },
  ];

  // `?itrace=` holds an ideaId; the grid keys rows by `key` (the work-item id
  // when an item has no routed idea, an item+idea pair when filed, else the
  // ideaId), so resolve the open trace to its row key.
  const expandedRowKey = traceOpen
    ? (rows.find((r) => r.idea?.ideaId === traceOpen)?.key ?? null)
    : null;
  // The `?lsel` target only IF this list holds it — see the scroll note below.
  // `lsel` carries the work-item id; when that item has multiple idea rows,
  // scroll to the first matching row.
  const selectedRowKey =
    lsel != null ? (rows.find((r) => r.item?.id === lsel)?.key ?? null) : null;

  return (
    // P-003: the bordered rounded frame the Retained ledger's grid sits in, so
    // the two tables read as one component rather than two house styles.
    <div className="pc-learning__gridframe">
      <VirtualGrid<LoopRow>
        columns={columns}
        rows={rows}
        resizableColumns
        columnWidths={colWidths}
        onColumnWidthsChange={setColWidths}
        getRowId={(r) => r.key}
        rowMinHeight={34}
        headerHeight={30}
        scrollStyle={{ maxHeight: "min(58vh, 640px)" }}
        onRowClick={(r) => {
          // Parity with the card: a selected (?lsel) row dismisses on click; an
          // idea-bearing row toggles its trace.
          if (isSelectedRow(r, lsel)) {
            ctx.onDismissSelect();
            return;
          }
          if (r.idea)
            ctx.onToggleTrace(
              traceOpen === r.idea.ideaId ? null : r.idea.ideaId,
            );
        }}
        getRowBg={(r) =>
          isSelectedRow(r, lsel)
            ? "color-mix(in oklab, var(--accent), transparent 80%)"
            : undefined
        }
        expandedRowKey={expandedRowKey}
        // WI-523949. Highlighting (`getRowBg`) and expanding (`expandedRowKey`)
        // are both no-ops for a row outside the mounted window, and this grid
        // shows ~18 rows (34px into `min(58vh, 640px)`) of a read bounded by
        // LEARNING_IMPROVE_ROW_LIMIT = 500 — so before this, a deep-link landed
        // on a row nobody could see. The trace's own grounding
        // chip is the loudest case: its tooltip says "select in this list", and
        // clicking it changed nothing on screen.
        //
        // `lsel` wins over the open trace because it is the newer intent: the
        // chip sets a selection while leaving `?itrace=` open, whereas opening a
        // trace is a click on an already-visible row that needs no scroll. Both
        // are row keys — a work row's key IS its item id — so either can be
        // handed to the grid as-is.
        //
        // It yields when the list does not hold that row, which is NOT the rare
        // case: a grounding chip's `wi:` ref is whatever work item seeded the
        // idea, and those are routinely resolved and therefore absent from a
        // digest of OPEN items. Without the check, one unreachable selection
        // would pin the scroll target forever and the open trace could never
        // claim it.
        scrollToRowKey={selectedRowKey ?? expandedRowKey}
        // WI-554962. 'auto', NOT VirtualGrid's 'center' default — and this is
        // load-bearing, not a preference. `expandedRowKey` is CLICK-driven, so
        // it feeds this scroll on every trace open; in @tanstack/virtual-core's
        // `getOffsetForIndex`, ONLY 'auto' short-circuits (`return [scrollOffset,
        // align]`) when the row is already fully visible. 'center'/'start'/'end'
        // all fall through and reposition unconditionally, which centred — and so
        // visibly yanked — the row the reader had just clicked.
        //
        // 'auto' is what makes the comment above TRUE rather than merely intended:
        // a click on an already-visible row now really does "need no scroll", while
        // an off-window `?itrace=` / `?lsel=` deep link still scrolls into view, so
        // the WI-523949 landing is preserved exactly.
        scrollToRowAlign="auto"
        renderExpandedRow={(r) =>
          r.idea ? (
            <div className="pc-learning__gridtrace">
              <IdeaTrace idea={r.idea} ctx={ctx} />
            </div>
          ) : null
        }
      />
    </div>
  );
}

/**
 * The pipeline trace: an idea's whole loop as one stack of stages — grounding
 * evidence → lens → routed artifact → grade → outcome. Every field comes from
 * the same ledger read the list renders, and a missing stage renders dimmed
 * because THE GAP IS THE SIGNAL (an "ungraded" row on a starving grading loop
 * is the finding, not a rendering hole to paper over).
 */
function IdeaTrace({
  idea,
  ctx,
}: {
  idea: ScoutRoutedItem;
  ctx: LoopRowContext;
}) {
  const meta = ctx.railMetaMap[idea.rail] ?? {
    label: idea.rail,
    desc: "Routed idea",
    color: "#94a3b8",
  };
  const refs = idea.addressesPatternRefs ?? [];
  const eff = ctx.effectiveGrade(idea);
  const outcome = idea.outcome ?? "pending";
  const outcomeTone =
    outcome === "won" ? "good" : outcome === "lost" ? "bad" : "missing";
  // Display the ref WITHOUT its rail prefix — the rail chip already names the
  // destination (owner ask 2026-07-19: "gym gym:SP-004" doubles were unreadable).
  const shortRef = idea.routedRef.replace(/^[a-z]+:/i, "");

  const groundingChip = (ref: string) => {
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "ref";
    const rest = sep > 0 ? ref.slice(sep + 1) : ref;
    if (kind === "wi") {
      const title = ctx.groundingTitles[ref];
      return (
        <Tooltip
          key={ref}
          label={
            title
              ? `${rest} — ${title} (select in this list)`
              : `${rest} — select in this list`
          }
        >
          <button
            type="button"
            className="pc-learning__tracechip pc-learning__tracechip--link"
            onClick={() => ctx.onOpenImprovement(rest)}
          >
            <i>{kind}</i>
            <span className="pc-learning__tracechip-text">{title ?? rest}</span>
          </button>
        </Tooltip>
      );
    }
    if (kind === "plan") {
      return (
        <Tooltip key={ref} label={`${rest} — open the plan in Create → Plans`}>
          <button
            type="button"
            className="pc-learning__tracechip pc-learning__tracechip--link"
            onClick={() => ctx.onOpenPlan(rest)}
          >
            <i>{kind}</i>
            <span className="pc-learning__tracechip-text">{rest}</span>
          </button>
        </Tooltip>
      );
    }
    return (
      <span key={ref} className="pc-learning__tracechip" title={ref}>
        <i>{kind}</i>
        <span className="pc-learning__tracechip-text">{rest}</span>
      </span>
    );
  };

  return (
    <div
      className="pc-learning__trace"
      aria-label={`Pipeline trace for ${idea.title ?? idea.routedRef}`}
    >
      <div
        className={`pc-learning__tracerow${refs.length === 0 ? " is-missing" : ""}`}
      >
        <em>grounded in</em>
        <span className="pc-learning__tracechips">
          {refs.length > 0 ? (
            refs.map(groundingChip)
          ) : (
            <strong title="No grounding evidence was recorded for this idea (su-ideate filings often ground informally).">
              none recorded
            </strong>
          )}
        </span>
      </div>
      <div className="pc-learning__tracerow">
        <em>lens</em>
        <strong
          title={
            idea.cycleId
              ? `Produced by the '${idea.lens}' lens in cycle ${idea.cycleId}`
              : `Produced by the '${idea.lens}' lens`
          }
        >
          {idea.lens}
          {idea.origin ? <i> · {idea.origin}</i> : null}
        </strong>
      </div>
      <div className="pc-learning__tracerow">
        <em>routed to</em>
        <span className="pc-learning__tracechips">
          <Tooltip label={`${meta.desc} — open ${idea.routedRef}`}>
            <button
              type="button"
              className="pc-learning__tracechip pc-learning__tracechip--link"
              onClick={() => ctx.onOpenRouted(idea)}
            >
              <i
                className="pc-learning__tracedot"
                style={{ background: meta.color }}
                aria-hidden
              />
              <span>{meta.label}</span>
              <b className="pc-learning__tracechip-text">{shortRef}</b>
            </button>
          </Tooltip>
        </span>
      </div>
      <div className={`pc-learning__tracerow${eff ? "" : " is-missing"}`}>
        <em>grade</em>
        <strong
          title={
            eff
              ? (eff.feedback ??
                `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}`)
              : "Ungraded — the grade→learn half of the loop has not seen this idea."
          }
        >
          {eff
            ? `★${eff.grade} · ${graderLabel(eff.gradedBy, ctx.brainWord)}`
            : "ungraded"}
        </strong>
      </div>
      <div
        className={`pc-learning__tracerow${outcomeTone === "missing" ? " is-missing" : ` is-${outcomeTone}`}`}
      >
        <em>outcome</em>
        <strong title="Outcome derived from the change feed (won / lost / pending) — did the routed artifact pan out?">
          {outcome}
        </strong>
      </div>
    </div>
  );
}

/**
 * One row of the merged list: the idea, the work it became, or both.
 *
 * The two old rows were near-identical shapes over the same population — the
 * Ideas row led with a rail and carried a grade, the Backlog row led with a
 * severity and carried a triage score. This renders whichever halves the row
 * actually has, so an idea that became work reads as ONE thing with one origin
 * and one fate, rather than as two rows on two tabs that never referenced each
 * other.
 */
function LoopRowView({
  row,
  ctx,
  selected = false,
}: {
  row: LoopRow;
  ctx: LoopRowContext;
  /** Deep-link target (?lsel) — highlighted + scrolled into view; click dismisses. */
  selected?: boolean;
}) {
  const { item, idea } = row;
  const meta = idea
    ? (ctx.railMetaMap[idea.rail] ?? {
        label: idea.rail,
        desc: "Routed idea",
        color: "#94a3b8",
      })
    : null;
  const sevColor = item ? SEVERITY[item.severity ?? "minor"].solid : null;
  const stage = pipelineState(row);
  const eff = idea ? ctx.effectiveGrade(idea) : null;
  const isTraceOpen = Boolean(idea) && ctx.traceOpen === idea?.ideaId;
  const isGradeOpen = Boolean(idea) && ctx.gradeOpen === idea?.ideaId;
  const saving = Boolean(idea) && ctx.savingId === idea?.ideaId;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);

  // The leading id: the work item when there is one (it is the thing you act
  // on), otherwise the rail the idea went to.
  const leadLabel = item ? item.id : (meta?.label ?? "idea");
  const leadColor = item ? undefined : meta?.color;
  const title = item?.title ?? idea?.title ?? idea?.routedRef ?? "";

  return (
    <li
      ref={ref}
      className={`pc-learning__row${selected ? " pc-learning__row--selected" : ""}`}
      // No row-level `title`: it used to carry `tierReason` ("… → human
      // review"), which now contradicts the stage chip's own tooltip. The chip
      // explains where the row is; nothing else on the row should re-explain it
      // in the retired approval vocabulary.
      onClick={selected ? ctx.onDismissSelect : undefined}
    >
      <span
        className="pc-learning__sev"
        style={{ background: sevColor ?? meta?.color ?? "#94a3b8" }}
        aria-hidden
      />
      {idea ? (
        // Only an idea-bearing row is expandable — the trace IS the idea's
        // record, so a capture with no idea behind it has nothing to expand.
        <Tooltip
          label={
            isTraceOpen
              ? "Hide this idea's trace"
              : "Show where this came from — grounding, lens, route, grade, outcome"
          }
        >
          <button
            type="button"
            className="pc-learning__rowmain"
            aria-expanded={isTraceOpen}
            onClick={() => ctx.onToggleTrace(isTraceOpen ? null : idea.ideaId)}
          >
            <span className="pc-learning__id" style={{ color: leadColor }}>
              {leadLabel}
            </span>
            <span className="pc-learning__title">{title}</span>
          </button>
        </Tooltip>
      ) : (
        <>
          <span className="pc-learning__id">{leadLabel}</span>
          <span className="pc-learning__title">{title}</span>
        </>
      )}
      <span className="pc-learning__meta">
        {idea ? (
          <span
            className="pc-learning__chip pc-learning__chip--idea"
            style={{
              color: lensColor(idea.lens),
              borderColor: lensColor(idea.lens),
            }}
            title="The creative lens that produced this idea"
          >
            {idea.lens}
          </span>
        ) : null}
        {item ? (
          <span
            className="pc-learning__chip"
            style={{
              color: sevColor ?? undefined,
              borderColor: sevColor ?? undefined,
            }}
          >
            {item.severity ?? "—"}
          </span>
        ) : null}
        {item?.ideaType ? (
          <span className="pc-learning__chip pc-learning__chip--idea">
            {item.ideaType}
          </span>
        ) : null}
        {item?.source ? (
          <span className="pc-learning__chip" title={`Filed by ${item.source}`}>
            {item.source}
          </span>
        ) : null}
        {/* Where this is in the loop (P-004). ONE chip, one vocabulary, on
            every row — replacing the old review/auto pair, which announced a
            human approval gate that does not exist. */}
        <span
          className={`pc-learning__chip pc-learning__chip--stage-${stage}`}
          title={PIPELINE_STATES[stage].desc}
        >
          {PIPELINE_STATES[stage].label}
        </span>
        <span className="pc-learning__age" title="How long ago this was filed">
          {item
            ? ageLabel(item.ageDays)
            : idea?.routedAt
              ? whenLabel(Date.parse(idea.routedAt))
              : ""}
        </span>
        {item ? (
          <span
            className="pc-learning__score"
            title="Triage priority (severity + age) — higher means more urgent"
          >
            {item.score}
          </span>
        ) : null}
        {/* The ONLY control on a row (owner ruling 2026-07-27): in a full-auto
            loop the human teaches the generator, never approves the work. */}
        {idea ? (
          <span
            className="pc-learning__grade"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {eff ? (
              <span
                className="pc-learning__gradechip"
                title={
                  eff.feedback
                    ? `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}: “${eff.feedback}”`
                    : `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}`
                }
              >
                ★{eff.grade} · {graderChipLabel(eff.gradedBy, ctx.brainWord)}
              </span>
            ) : null}
            <Popover
              open={isGradeOpen}
              onOpenChange={(open) =>
                ctx.onGradeOpenChange(open ? idea.ideaId : null)
              }
              trigger={
                <button
                  type="button"
                  className="pc-learning__notebtn"
                  aria-label={eff ? "Review idea grade" : "Grade this idea"}
                  aria-expanded={isGradeOpen}
                >
                  {eff ? (
                    <Star size={12} fill="currentColor" aria-hidden />
                  ) : (
                    <MessageSquarePlus size={12} aria-hidden />
                  )}
                </button>
              }
              tooltipLabel={eff ? "Review this grade" : "Grade this idea"}
              ariaLabel={`Grade ${title}`}
              contentClassName="pc-learning__gradepopover"
            >
              <GradePanel
                current={eff}
                busy={saving}
                onSave={(grade, feedback) => {
                  void ctx
                    .onGrade(idea, grade, feedback)
                    .then(() => ctx.onGradeOpenChange(null));
                }}
                onClose={() => ctx.onGradeOpenChange(null)}
              />
            </Popover>
          </span>
        ) : null}
      </span>
      {isTraceOpen && idea ? <IdeaTrace idea={idea} ctx={ctx} /> : null}
    </li>
  );
}

// ─── Flow strip (P-041 — flows, not stocks) ──────────────────────────────────

/** Watchdog liveness tone: green <30min since the last tick, amber <2h, red otherwise (incl. never). */
function watchdogHealth(
  lastTickAt: string | null,
  nowMs: number,
): { tone: "good" | "warn" | "bad"; label: string } {
  const ms = lastTickAt ? Date.parse(lastTickAt) : NaN;
  if (Number.isNaN(ms)) return { tone: "bad", label: "never" };
  const ageMin = Math.max(0, (nowMs - ms) / 60_000);
  const label =
    ageMin < 1
      ? "just now"
      : ageMin < 90
        ? `${Math.round(ageMin)}m ago`
        : ageMin < 48 * 60
          ? `${Math.round(ageMin / 60)}h ago`
          : `${Math.round(ageMin / (60 * 24))}d ago`;
  if (ageMin < 30) return { tone: "good", label };
  if (ageMin < 120) return { tone: "warn", label };
  return { tone: "bad", label };
}

/** The flow scoreboard — is the loop CYCLING (in vs out), not just how big the pile is. */
/**
 * The in-flow vs out-flow verdict in one sentence (P-004). `net7d` is
 * captured − resolved over the trailing 7 days — the same field the strip's own
 * ↑/↓ chip renders — so a NEGATIVE net means resolution outpaced capture and the
 * backlog shrank. Stated in words here precisely because the sign convention is
 * the opposite of what "net up is good" intuition suggests.
 */
function flowAnswer(flow: ImprovementFlow): string {
  const net = flow.net7d;
  const base = "in-flow vs out-flow";
  if (net < 0) return `${base} — the backlog shrank by ${-net} this week`;
  if (net > 0) return `${base} — the backlog grew by ${net} this week`;
  return `${base} — the backlog held level this week`;
}

function FlowStrip({ flow }: { flow: ImprovementFlow }) {
  const net = flow.net7d;
  const netTone: "good" | "warn" | "flat" =
    net < 0 ? "good" : net > 0 ? "warn" : "flat";
  const wd = watchdogHealth(flow.watchdog.lastTickAt, Date.now());
  return (
    <div
      className="pc-learning__flow"
      aria-label="Improvement flow (trailing window)"
    >
      <span
        className="pc-learning__flowchip"
        title="Items captured vs resolved in the trailing 7 days — the loop's in-flow vs out-flow. A shrinking backlog (↓) means resolution is keeping up with capture."
      >
        <Activity size={11} aria-hidden />
        <strong>{flow.captured7d}</strong> in /{" "}
        <strong>{flow.resolved7d}</strong> out
        <em>7d</em>
        <span
          className={`pc-learning__flownet pc-learning__flownet--${netTone}`}
          title="Net backlog change over 7 days (captured − resolved)"
        >
          {net > 0 ? (
            <ArrowUp size={10} aria-hidden />
          ) : net < 0 ? (
            <ArrowDown size={10} aria-hidden />
          ) : (
            <Minus size={10} aria-hidden />
          )}
          {net > 0 ? `+${net}` : net}
        </span>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Median age of the open items — fresh churn or sediment? Rising median = the backlog is silting up."
      >
        <Hourglass size={11} aria-hidden />
        median open{" "}
        <strong>
          {flow.medianOpenAgeDays == null
            ? "—"
            : ageLabel(flow.medianOpenAgeDays)}
        </strong>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Friction signatures captured more than once — the same problem coming back. Recurrence is the strongest 'fix this next' signal."
      >
        <Repeat2 size={11} aria-hidden />
        <strong>{flow.recurringSignatureCount}</strong> recurring
      </span>
      <span
        className={`pc-learning__flowchip pc-learning__flowchip--wd-${wd.tone}`}
        title={`The watchdog auto-files objective problems on a cadence — if it stops ticking, the capture feed has silently died. ${flow.watchdog.ticks24h} tick(s) and ${flow.watchdog.captured24h} capture(s) in the last 24h.`}
      >
        <span
          className={`pc-learning__flowdot pc-learning__flowdot--${wd.tone}`}
          aria-hidden
        />
        watchdog <strong>{wd.label}</strong>
        <em>
          {flow.watchdog.ticks24h} ticks / {flow.watchdog.captured24h} captured
          · 24h
        </em>
      </span>
      {flow.dispatch ? <DispatchChip d={flow.dispatch} /> : null}
    </div>
  );
}

/**
 * Auto-implement dispatch ledger chip (consume-edges P-010 / B-04) — the BACK
 * edge's vitals: fired vs actually fixed, workers in progress vs presumed dead.
 * Red when anything is dying silently (overdue / fire-failed / orphaned), green
 * when the lane is genuinely fixing things.
 */
function DispatchChip({ d }: { d: NonNullable<ImprovementFlow["dispatch"]> }) {
  const dead = d.overdue + d.fireFailed + d.orphaned;
  const tone: "good" | "warn" | "bad" =
    dead > 0 ? "bad" : d.fixed7d > 0 ? "good" : "warn";
  return (
    <span
      className={`pc-learning__flowchip pc-learning__flowchip--wd-${tone}`}
      title={
        `Auto-implement dispatch ledger: ${d.fired7d} dispatch(es) fired in 7d, ${d.resolved.fixed} fixed / ` +
        `${d.resolved.couldNotFix} could-not-fix / ${d.resolved.needsHuman} needs-human all-time; ` +
        `${d.inProgress + d.firing} in progress, ${d.overdue} overdue (worker presumed dead), ` +
        `${d.fireFailed} fire-failed, ${d.orphaned} orphaned. A dispatch that never reaches a terminal state is the EI-365 black hole this ledger exists to expose.`
      }
    >
      <Send size={11} aria-hidden />
      dispatch <strong>{d.fired7d}</strong> fired / <strong>{d.fixed7d}</strong>{" "}
      fixed
      <em>7d</em>
      {dead > 0 ? (
        <strong>{dead} dead</strong>
      ) : (
        <em>{d.inProgress + d.firing} live</em>
      )}
    </span>
  );
}

// ─── Gym view ────────────────────────────────────────────────────────────────

interface GymProposal {
  id: string;
  harnessSlug: string;
  cycle: number;
  role: string;
  variantId?: string | null;
  rationale: string | null;
  devAnchorDelta: number | null;
  costDelta: number | null;
  probeStatus?: string | null;
  proposedMd?: string | null;
  status: string; // pending | accepted | rejected | superseded
  createdAt: number;
  decidedAt: number | null;
}
interface GymAutoloop {
  harnessSlug: string;
  enabled: boolean;
  status: string; // idle | running | paused | exhausted
  budgetUsd: number | null;
  spentUsd: number;
  lastCycle: number | null;
}
interface GymArchiveSeed {
  candidateId: string;
  nicheKey: string;
  fitness: number;
  rationale: string | null;
  updatedAt: number;
  harnessSlug: string;
}
/** WI-5685: one completed gym cycle from the durable run-analytics — the record
 *  of a RUN having happened, independent of whether it minted a proposal (a
 *  losing candidate mints none, which used to make the whole run invisible). */
interface GymRecentCycle {
  /** WI-5799: run-scoped identity; `cycle` alone repeats across runs. */
  cycleId?: string;
  harnessSlug: string;
  cycle: number;
  parentId: string | null;
  candidateId: string | null;
  decision: string | null; // 'accept' | 'reject' | null
  runCount: number;
  startedAt: number | null;
  finishedAt: number | null;
}
/** WI-5808: one variant's runs within a cycle, straight from gym_runs. */
interface GymRecentRun {
  harnessSlug: string;
  variantId: string;
  cycle: number;
  runCount: number;
  states: string[];
  startedAt: number | null;
  finishedAt: number | null;
  decision: string | null;
  isBaseline: boolean;
}
interface GymSnapshot {
  proposals: GymProposal[];
  autoloops: GymAutoloop[];
  /** Scout-seeded MAP-Elites niches (WI-5412 item 4) — absent on older server snapshots. */
  archiveSeeds?: GymArchiveSeed[];
  /** Recent completed cycles (WI-5685) — absent on older server snapshots. */
  cycles?: GymRecentCycle[];
  /** WI-5808: recent RUN activity from gym_runs — the table that accumulates. */
  runs?: GymRecentRun[];
  /** ISO timestamp this snapshot was generated server-side. */
  generatedAt?: string;
  /**
   * WI-5420: true when the requested Hive's own gym-scoped read came back
   * empty and the server fell back to the workspace-wide rollup below (real
   * data recorded under a harness not scoped to this Hive — e.g. a manual
   * `gym-loop-run.ts` run — would otherwise render as "No gym experiments").
   * Absent/false ⇒ the data below is genuinely scoped to the requested Hive.
   */
  scopeFallback?: boolean;
}

/** Stable category color per creative lens (owner ask 2026-07-19d): the deck
 *  accent follows the CATEGORY, never the stack order. Hash into the theme's
 *  fixed categorical swatches so a lens keeps its hue across views/renders
 *  (same scheme SignalsPanel uses for lanes). */
const CATEGORICAL_HEXES = Object.values(CATEGORICAL).map((c) => c.hex);
function lensColor(lens: string): string {
  let h = 0;
  for (let i = 0; i < lens.length; i++) h = (h * 31 + lens.charCodeAt(i)) | 0;
  return CATEGORICAL_HEXES[Math.abs(h) % CATEGORICAL_HEXES.length];
}

function whenLabel(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function deltaLabel(d: number | null): {
  text: string;
  tone: "good" | "bad" | "flat";
} {
  if (d === null || d === undefined || Number.isNaN(d))
    return { text: "—", tone: "flat" };
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return {
    text: `${sign}${Math.abs(d).toFixed(3)}`,
    tone: d > 0 ? "good" : d < 0 ? "bad" : "flat",
  };
}

function GymView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const openArming = useOpenArming();
  // Collapsed challenger role groups — comma-separated roles, in the URL so the
  // view is shareable and agent-readable (repo convention: user-meaningful state
  // goes in nuqs, never useState).
  const [collapsedRolesRaw, setCollapsedRoles] = useQueryState(
    "gymroles",
    parseAsString,
  );
  const collapsedRoles = useMemo(
    () =>
      new Set(
        (collapsedRolesRaw ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [collapsedRolesRaw],
  );
  const toggleRole = (role: string) => {
    const next = new Set(collapsedRoles);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    void setCollapsedRoles(next.size ? [...next].sort().join(",") : null);
  };
  // P-042: scope the gym rollup to one hive's gym harness; '' ⇒ the whole
  // workspace (every gym harness). Gated on hiveReady (WI-5412) so the first
  // click never pays a wrong-lens fetch + refetch.
  const sync = useSyncQuery<GymSnapshot>({
    queryName: "learning.gym",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  // WI-5809 (owner report 2026-07-25): the client-side cross-tenant fallback is
  // GONE, matching the server. It used to refetch the workspace-wide rollup when
  // the selected pot's own read was empty — which is how selecting Oddsmith
  // rendered PAPERCUSP's gym experiments. A selected pot now shows only its own
  // data, or an honest empty state naming the pot.
  const snap = sync.data?.[0];
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points (pipeline /
  // observations / improvements / learnings): gated on the PRIMARY read
  // only, settles on a fault as well as success, gated on `active` so a
  // warm-but-inactive pane doesn't emit on a revisit that never remounts
  // (EI-19383745196363732).
  const gymSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    gymSettled,
    active,
  );
  const proposals = snap?.proposals ?? [];
  const autoloops = snap?.autoloops ?? [];
  const archiveSeeds = snap?.archiveSeeds ?? [];
  const cycles = snap?.cycles ?? [];
  // WI-5808: RUN activity, read from gym_runs — the table that actually
  // accumulates. This is what answers "is the gym doing anything lately";
  // `cycles` only gains a row when a cycle COMPLETES.
  const runs = snap?.runs ?? [];
  const activeAutoloops = autoloops.filter(
    (autoloop) => autoloop.enabled || autoloop.status === "running",
  );

  const champions = proposals.filter((p) => p.status === "accepted").length;
  const pending = proposals.filter((p) => p.status === "pending").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
  // Newest run instant across the listed groups — stamped into the sticky
  // "Recent challengers" header so recency is legible at any scroll position.
  const newestRunAtMs = useMemo<number | null>(() => {
    let newest: number | null = null;
    for (const r of runs) {
      const when = r.finishedAt ?? r.startedAt;
      if (when != null && (newest == null || when > newest)) newest = when;
    }
    return newest;
  }, [runs]);

  /**
   * ONE card per challenger (owner ask 2026-07-27: "why isn't RECENT CHALLENGERS
   * just cards like the other section?").
   *
   * The two blocks were the SAME events rendered twice: a compact line per
   * gym_runs group (execution: when, run count, terminal states, decision) and a
   * card per gym_proposals row (proposal: prompt, benchmark delta, cost, probes,
   * judge rationale) — measured 17 run groups vs 17 proposals with 15 overlapping.
   * WI-5696 added the lines only so a cycle that minted NO proposal stayed
   * visible, and promised they would "vanish via the dedupe" once every decision
   * minted one (WI-5697); the dedupe was never written, so both rendered and the
   * duplicate block pushed the cards out of the pane.
   *
   * Merge instead of choosing: each proposal card carries its own execution facts,
   * so nothing the lines conveyed is lost, and the compact line survives ONLY for
   * its designed exception (see `orphanRuns`).
   */
  const runByVariant = useMemo(() => {
    const at = (r: GymRecentRun) => r.finishedAt ?? r.startedAt ?? 0;
    const m = new Map<string, GymRecentRun>();
    for (const r of runs) {
      const prior = m.get(r.variantId);
      if (!prior || at(r) > at(prior)) m.set(r.variantId, r);
    }
    return m;
  }, [runs]);

  /** Challengers newest-first, each paired with the run group that executed it. */
  const challengerCards = useMemo(
    () =>
      proposals
        .map((p) => ({
          p,
          run: p.variantId ? (runByVariant.get(p.variantId) ?? null) : null,
        }))
        .sort((a, b) => (b.p.createdAt ?? 0) - (a.p.createdAt ?? 0)),
    [proposals, runByVariant],
  );

  /**
   * Executions with NO proposal card — the champion baseline (mints none by
   * design) and any cycle that minted nothing. This is the only case the compact
   * line was ever for, so it is the only case that still renders one.
   */
  const orphanRuns = useMemo(() => {
    const carded = new Set(
      proposals.map((p) => p.variantId).filter(Boolean) as string[],
    );
    return runs.filter((r) => !carded.has(r.variantId));
  }, [runs, proposals]);

  /**
   * Cards stay GROUPED BY ROLE (owner ask 2026-07-27: "why are the new cards not
   * collapsed by type like previously") — the flat grid lost the per-role stacks
   * the CardStack decks gave. Group ordering is by RECENCY of the group's newest
   * challenger, not by size, so the role the gym is actually working on leads;
   * within a group cards stay newest-first. Each group collapses (state in nuqs
   * per repo convention, so it is shareable + agent-visible).
   */
  const challengerGroups = useMemo(() => {
    const byRole = new Map<string, typeof challengerCards>();
    for (const entry of challengerCards) {
      const role = entry.p.role || "unknown";
      const bucket = byRole.get(role);
      if (bucket) bucket.push(entry);
      else byRole.set(role, [entry]);
    }
    return [...byRole.entries()]
      .map(([role, items]) => ({
        role,
        items,
        accent: lensColor(role),
        newestAt: items.reduce<number | null>((acc, { p, run }) => {
          const when = p.createdAt ?? run?.finishedAt ?? null;
          return when != null && (acc == null || when > acc) ? when : acc;
        }, null),
      }))
      .sort(
        (a, b) =>
          (b.newestAt ?? 0) - (a.newestAt ?? 0) || a.role.localeCompare(b.role),
      );
  }, [challengerCards]);
  const t = useLexicon();
  const running = activeAutoloops.length;
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : !snap
          ? "neutral"
          : pending > 0
            ? "warn"
            : running > 0 || champions > 0
              ? "good"
              : "neutral",
    );
  }, [champions, onStatus, pending, running, snap, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Dumbbell}
        title="Prompt gym"
        generatedAt={snap?.generatedAt}
        signal={running > 0 ? `${running} active` : undefined}
        tone={running > 0 ? "good" : "neutral"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the gym feed"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {/* How things reach the gym — the succinct two-path explanation, in the
          header-desc idiom (owner ask 2026-07-19); the fuller mechanics ride
          the tooltip. */}
      <p
        className="pc-learning__sectionsub pc-learning__gymhow"
        title={`Path 1 — ${t("scout")} routing: every fused idea carries a routeHint from the recombine step; small, cheaply testable (prompt-shaped) ideas route to the gym rail as challenger candidates + QD-archive niche seeds. Unhinted ideas default to the improvement rail; plans/benchmarks have their own rails. Path 2 — the autoloop: a per-${t("pot", { lower: true })} config (enabled + an explicit budget cap — no cap, no unattended runs); a 30-min routine round-robins enabled ${t("pot", { plural: true, lower: true })} and runs one budget-bounded challenger-vs-champion cycle, accumulating spend until the budget floor stops it. Winning challengers (positive benchmark delta) auto-promote to champion at end of run — owner mandate 2026-07-19; losers auto-reject; every decision stays in the ledger.`}
      >
        Two ways in: {t("scout")} routes small, cheaply testable ideas here
        (challengers + archive niche seeds), and each enabled, budgeted{" "}
        {t("pot", { lower: true })} autoloop runs challenger-vs-champion cycles
        (~every 30 min) until its budget is spent. Fully autonomous: a
        challenger that beats the champion on the benchmark is promoted
        automatically — the ledger below is the audit trail.
      </p>

      {snap && proposals.length >= 4 ? (
        // The header signal already carries "N active" (running loops); this line
        // is the experiment breakdown, Champions the one accent when there are any.
        <LearningStatLine
          stats={[
            {
              label: "Champions",
              value: champions,
              tone: champions > 0 ? "good" : undefined,
            },
            { label: "Tested", value: proposals.length },
            {
              label: "Pending",
              value: pending,
              tone: pending > 0 ? "warn" : undefined,
            },
            { label: "Rejected", value: rejected },
          ]}
        />
      ) : null}

      {/* ALL configured autoloops, parked ones included (P-009): a disabled
          loop used to vanish from this strip entirely, so a parked gym was
          indistinguishable from a never-armed one. The `off` chip + the banner
          below both derive from the live gym_autoloop_config rows in the
          snapshot — never a hardcoded dormant state (D-006 revived the loop;
          this must read "running" again the moment it is re-armed). */}
      {autoloops.length > 0 && (
        <div className="pc-learning__loops" aria-label="Gym autoloops">
          {autoloops.map((a) => (
            <span
              key={a.harnessSlug}
              className={`pc-learning__loop pc-learning__loop--${a.enabled ? a.status : "off"}`}
              title={
                a.enabled
                  ? `This gym runs experiment cycles on its own${a.budgetUsd != null ? ` — $${a.spentUsd.toFixed(2)} spent of a $${a.budgetUsd.toFixed(0)} budget` : ""}`
                  : `This autoloop is parked — no new cycles until it is re-armed${a.budgetUsd != null ? ` ($${a.spentUsd.toFixed(2)} of its $${a.budgetUsd.toFixed(0)} budget spent)` : ""}`
              }
            >
              <Dumbbell size={11} aria-hidden />
              {a.harnessSlug}
              <em>{a.enabled ? a.status : "off"}</em>
              {a.budgetUsd != null && (
                <span className="pc-learning__loopspend">
                  ${a.spentUsd.toFixed(2)}/${a.budgetUsd.toFixed(0)}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Dormant banner: nothing enabled AND nothing mid-cycle, while history
          exists below — without this the ledger reads as live activity. The
          all-empty case further down already carries its own "Arm the Gym"
          action, so it is excluded here. */}
      {snap &&
      !sync.error &&
      activeAutoloops.length === 0 &&
      (proposals.length > 0 ||
        archiveSeeds.length > 0 ||
        cycles.length > 0 ||
        runs.length > 0) ? (
        <div className="pc-learning__dormant" role="status">
          <Hourglass size={13} aria-hidden />
          <span>
            The gym is parked — no {t("pot", { lower: true })} autoloop is
            enabled, so no new challenger cycles will run. Everything below is
            history, not live activity.
          </span>
          <button
            type="button"
            className="pc-learning__orientaction"
            onClick={openArming}
          >
            Open Arming
          </button>
        </div>
      ) : null}

      {/* The empty state must require a RESOLVED-empty snapshot — never a
          not-yet-fetched one. Until the gym query has actually returned (`snap`
          defined), we are loading, NOT empty. Before this, a false `hiveReady`
          gate (or any pre-first-result gap) rendered undefined `snap` as "No gym
          experiments" even though the workspace had proposals (owner report
          2026-07-19; the server returns them correctly — verified end-to-end). */}
      {!snap && !sync.error ? (
        <p className="pc-learning__empty">Loading gym experiments…</p>
      ) : sync.error ? (
        <LearningVisualError
          title="Gym unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : proposals.length === 0 &&
        archiveSeeds.length === 0 &&
        cycles.length === 0 &&
        runs.length === 0 ? (
        <LearningVisualEmpty
          icon={Dumbbell}
          title={
            hive
              ? `No gym activity for ${hive} yet`
              : "No gym activity in this workspace yet"
          }
          body={`Armed ${t("pot", { plural: true, lower: true })} A/B-refine their blueprints under a budget you set — completed cycles land here with their verdicts.`}
          action={{
            // Not "Arm the Gym" (P-009): this opens the pot SCOPE picker, which
            // is a gate and cannot arm the gym lane (D-007). The label names
            // where it actually goes.
            label: "Check learning scope",
            onClick: openArming,
          }}
        />
      ) : (
        <>
          {proposals.length > 0 || runs.length > 0 ? (
            <>
              {/* STICKY + carries RECENCY (owner escalation 2026-07-26, ~20
                  reports of "no recent gym runs"): the runs list is newest-first
                  at the TOP of this scrolling pane, and the judge cards the user
                  actually reads are BELOW it — so reading a card necessarily
                  scrolls every recent run out of view. With a ~268px fixed header
                  (stage strip + tabs + subtitle + the orientation banner) the
                  scroll area is only ~800px, so a ~250px scroll already hides the
                  6 newest rows and leaves e.g. "9h ago" as the topmost visible
                  line — which reads as "the gym has produced nothing recent"
                  (REPRODUCED live at scrollTop 250). Pinning this header and
                  stamping the newest run's age into it means the answer to "is
                  anything recent?" is on screen at EVERY scroll position. */}
              <div className="pc-learning__sectionhead pc-learning__sectionhead--stickyruns">
                <h2>Recent challengers</h2>
                {newestRunAtMs != null ? (
                  <span
                    className="pc-learning__runsrecency"
                    title={`Newest gym run finished ${new Date(newestRunAtMs).toLocaleString()}. ${runs.length} run group(s) listed, newest first — scroll up for the newest.`}
                  >
                    newest {whenLabel(newestRunAtMs)}
                    {runs.length > 0 ? ` · ${runs.length} listed` : ""}
                  </span>
                ) : null}
              </div>
              {/* WI-5696's dedupe, finally implemented (owner ask 2026-07-27):
                  a compact line renders ONLY for an execution with no proposal
                  card — the champion baseline, or a cycle that minted nothing.
                  Every other challenger is a card below, carrying these same
                  execution facts, so this block no longer duplicates the cards
                  (it was 15 of 17 duplicates) or pushes them out of the pane. */}
              {orphanRuns.length > 0 ? (
                <div
                  className="pc-learning__gymcycles"
                  aria-label="Gym runs without a proposal"
                >
                  {orphanRuns.map((r) => {
                    const promoted =
                      r.decision === "accept" || r.decision === "promote";
                    const tone = r.isBaseline
                      ? "pending"
                      : promoted
                        ? "accepted"
                        : r.decision
                          ? "rejected"
                          : "pending";
                    const decisionColor = statusToneColor(tone);
                    const when = r.finishedAt ?? r.startedAt;
                    return (
                      <div
                        key={`${r.harnessSlug}:${r.variantId}:${r.cycle}`}
                        className="pc-learning__muted"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                          fontSize: 12,
                          padding: "2px 0",
                        }}
                        title={`${r.runCount} scored run(s) of ${r.variantId} in cycle ${r.cycle} on ${r.harnessSlug}${r.states.length ? ` — outcomes: ${r.states.join(", ")}` : ""}${when ? ` — ${new Date(when).toLocaleString()}` : ""}`}
                      >
                        {when ? (
                          <span className="pc-learning__age">
                            {whenLabel(when)}
                          </span>
                        ) : null}
                        <span
                          className="pc-learning__chip"
                          style={{
                            color: decisionColor,
                            borderColor: decisionColor,
                          }}
                        >
                          {r.isBaseline ? (
                            <Clock size={10} aria-hidden />
                          ) : promoted ? (
                            <CheckCircle2 size={10} aria-hidden />
                          ) : r.decision ? (
                            <XCircle size={10} aria-hidden />
                          ) : (
                            <Clock size={10} aria-hidden />
                          )}
                          {r.isBaseline
                            ? "champion baseline"
                            : promoted
                              ? "promoted"
                              : r.decision
                                ? "champion held"
                                : "evaluated"}
                        </span>
                        <span>
                          {r.variantId} · cycle {r.cycle} · {r.runCount} run
                          {r.runCount === 1 ? "" : "s"} · {r.harnessSlug}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
          {proposals.length > 0 ? (
            <>
              {/* A GRID of challenger cards, newest first — not a per-role
                  1-of-N carousel (owner ask 2026-07-27). The carousel showed one
                  card at a time, which is why the compact duplicate lines were
                  silently doing overview duty; a grid is the overview AND the
                  detail, so both jobs are done once. Role moves onto the card as
                  a chip + accent, so the per-role grouping information survives. */}
              {challengerGroups.map((group) => {
                const collapsed = collapsedRoles.has(group.role);
                return (
                  <section
                    key={group.role}
                    className="pc-learning__gymrolegroup"
                    aria-label={`${group.role} challengers`}
                  >
                    <button
                      type="button"
                      className="pc-learning__gymrolehead"
                      style={{ borderLeftColor: group.accent }}
                      onClick={() => toggleRole(group.role)}
                      aria-expanded={!collapsed}
                    >
                      {collapsed ? (
                        <ChevronRight size={12} aria-hidden />
                      ) : (
                        <ChevronDown size={12} aria-hidden />
                      )}
                      <span
                        className="pc-learning__gymrolename"
                        style={{ color: group.accent }}
                      >
                        {group.role}
                      </span>
                      <span className="pc-learning__chip">
                        {group.items.length}
                      </span>
                      {group.newestAt != null ? (
                        <span className="pc-learning__age">
                          newest {whenLabel(group.newestAt)}
                        </span>
                      ) : null}
                    </button>
                    {collapsed ? null : (
                      <div className="pc-learning__gymcardgrid">
                        {group.items.map(({ p, run }) => {
                          const role = p.role || "unknown";
                          const accent = lensColor(role);
                          const delta = deltaLabel(p.devAnchorDelta);
                          const statusColor = statusToneColor(p.status);
                          return (
                            <section
                              key={p.id}
                              className="pc-learning__gymcard"
                              style={{ borderLeftColor: accent }}
                              aria-label={`${role} challenger ${p.variantId ?? p.id}`}
                            >
                              <div className="pc-learning__ideacard">
                                <div className="pc-learning__ideacard-head">
                                  <span
                                    className="pc-learning__chip"
                                    style={{
                                      color: statusColor,
                                      borderColor: statusColor,
                                    }}
                                  >
                                    {p.status === "accepted" ? (
                                      <CheckCircle2 size={10} aria-hidden />
                                    ) : p.status === "rejected" ? (
                                      <XCircle size={10} aria-hidden />
                                    ) : (
                                      <Clock size={10} aria-hidden />
                                    )}
                                    {p.status === "accepted"
                                      ? "champion"
                                      : p.status}
                                  </span>
                                  <span
                                    className="pc-learning__chip"
                                    style={{
                                      color: accent,
                                      borderColor: accent,
                                    }}
                                    title="The agent role whose prompt this challenger rewrites"
                                  >
                                    {role}
                                  </span>
                                  <span
                                    className="pc-learning__chip"
                                    title="Gym cycle number"
                                  >
                                    cycle {p.cycle}
                                  </span>
                                  {/* The execution facts the compact line used to
                                    carry — folded in so removing the duplicate
                                    line loses nothing. */}
                                  {run ? (
                                    <span
                                      className="pc-learning__chip"
                                      title={`${run.runCount} scored run(s) of ${run.variantId}${run.states.length ? ` — outcomes: ${run.states.join(", ")}` : ""}`}
                                    >
                                      {run.runCount} run
                                      {run.runCount === 1 ? "" : "s"}
                                      {run.states.length
                                        ? ` · ${run.states.join(", ")}`
                                        : ""}
                                    </span>
                                  ) : null}
                                  <span className="pc-learning__age">
                                    {whenLabel(p.createdAt)}
                                    {p.decidedAt
                                      ? ` · decided ${whenLabel(p.decidedAt)}`
                                      : ""}
                                  </span>
                                </div>
                                <strong className="pc-learning__gymtitle">
                                  {p.rationale ?? p.variantId ?? p.id}
                                </strong>
                                <div className="pc-learning__gymdeltas">
                                  <span
                                    className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
                                    title="Judge-score change vs the current champion — positive means the challenger did better"
                                  >
                                    {delta.text} benchmark
                                  </span>
                                  {p.costDelta != null ? (
                                    <span
                                      className={`pc-learning__delta pc-learning__delta--${p.costDelta > 0 ? "bad" : p.costDelta < 0 ? "good" : "flat"}`}
                                      title="Per-task cost change vs the champion"
                                    >
                                      {p.costDelta > 0 ? "+" : ""}
                                      {p.costDelta.toFixed(2)} cost
                                    </span>
                                  ) : null}
                                  {p.probeStatus ? (
                                    <span
                                      className="pc-learning__chip"
                                      title="Regression-probe verdict — did the challenger still catch the planted failures?"
                                    >
                                      probes: {p.probeStatus}
                                    </span>
                                  ) : null}
                                  <span
                                    className="pc-learning__chip pc-learning__chip--idea"
                                    title="The gym harness that ran this experiment"
                                  >
                                    {p.harnessSlug}
                                  </span>
                                </div>
                                {p.proposedMd ? (
                                  <pre
                                    className="pc-learning__gymprompt"
                                    title="The challenger prompt (first lines)"
                                  >
                                    {p.proposedMd}
                                  </pre>
                                ) : null}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          ) : null}
          {/* WI-5412 item 4: the gym-rail pills in Ideas reference Scout-SEEDED
              archive niches (`gym:SP-…`), a different dataset from the
              prompt-optimization challengers above — this section is where
              those pills actually land. A seed absent here was superseded by a
              stronger candidate (its niche shows the winner). */}
          {archiveSeeds.length > 0 ? (
            <>
              <div className="pc-learning__sectionhead">
                <h2>Archive seeds</h2>
                <span
                  className="pc-learning__muted"
                  title="Scout-routed testable ideas are inserted straight into the MAP-Elites quality-diversity archive as niche seeds — they open unexplored idea territory rather than challenging a live prompt."
                >
                  Scout-seeded quality-diversity niches
                </span>
              </div>
              <div className="pc-learning__lensstacks">
                <section
                  className="pc-learning__lensgroup"
                  aria-label="Archive niche seeds"
                >
                  <CardStack
                    items={archiveSeeds}
                    getKey={(seed) => `${seed.harnessSlug}:${seed.nicheKey}`}
                    ariaLabel="Archive niche seeds"
                    accent={lensColor("niche seeds")}
                    header={
                      <>
                        <span className="pc-cardstack__header-label">
                          niche seeds
                        </span>
                        <span className="pc-cardstack__header-count">
                          {archiveSeeds.length}
                        </span>
                      </>
                    }
                    renderCard={(seed) => (
                      <div className="pc-learning__ideacard">
                        <div className="pc-learning__ideacard-head">
                          <span
                            className="pc-learning__chip pc-learning__chip--idea"
                            title="The MAP-Elites niche this seed holds (scope | domain | risk)"
                          >
                            {seed.nicheKey}
                          </span>
                          <span
                            className="pc-learning__chip"
                            title="The seed's fitness score in its niche"
                          >
                            fitness {seed.fitness.toFixed(2)}
                          </span>
                          <span className="pc-learning__age">
                            {whenLabel(seed.updatedAt)}
                          </span>
                        </div>
                        <strong className="pc-learning__gymtitle">
                          {seed.rationale ?? seed.candidateId}
                        </strong>
                        <div className="pc-learning__gymdeltas">
                          <span
                            className="pc-learning__chip"
                            title="The seeded candidate id"
                          >
                            {seed.candidateId}
                          </span>
                          <span
                            className="pc-learning__chip pc-learning__chip--idea"
                            title="The gym harness whose archive holds this niche"
                          >
                            {seed.harnessSlug}
                          </span>
                        </div>
                      </div>
                    )}
                  />
                </section>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Benchmark view (apiary / IQ-battery) ────────────────────────────────────

interface ApiaryInstance {
  instanceId: string;
  codeSha: string;
  createdAt: string;
  totalRuns: number;
  successfulRuns: number;
  successRate: number;
  meanComposite: number | null;
  meanTimeToGreenSecs: number | null;
  meanTokens: number | null;
  escalationRate: number | null;
  firstAttemptRate: number | null;
}

const pctLabel = (v: number | null): string =>
  v == null ? "—" : `${Math.round(v * 100)}%`;
const compositeLabel = (v: number | null): string =>
  v == null ? "—" : v.toFixed(3);
function secsLabel(v: number | null): string {
  if (v == null) return "—";
  return v < 90 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`;
}
function tokensLabel(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}
const shortSha = (s: string): string => (s ? s.slice(0, 7) : "—");
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ApiaryView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const sync = useSyncQuery<{ instances: ApiaryInstance[] }>({
    queryName: "learning.apiary",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const apiarySettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    apiarySettled,
    active,
  );
  const instances = sync.data?.[0]?.instances ?? [];
  // WI-6410: `sync.error` below covered the TRANSPORT half only. The resolver
  // catches its own failure and resolves with a degraded payload, so the error
  // branch was unreachable for exactly the failure mode most likely to happen.
  const fault = snapshotFault(sync.error, sync.data?.[0], "Benchmark");
  const newest = instances[0];
  const scored = instances.filter((instance) => instance.meanComposite != null);
  const latest = scored[0];
  const previous = scored[1];
  const pending = newest && newest.meanComposite == null ? newest : null;
  const currentDelta =
    latest?.meanComposite != null && previous?.meanComposite != null
      ? latest.meanComposite - previous.meanComposite
      : null;
  const currentDeltaMeta = deltaLabel(currentDelta);
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : pending
          ? "good"
          : latest && latest.successRate >= 0.8
            ? "good"
            : "neutral",
    );
  }, [latest, onStatus, pending, sync.error]);
  const renderInstance = (inst: ApiaryInstance, i: number) => {
    const prev = instances[i + 1];
    const dComposite =
      inst.meanComposite != null && prev?.meanComposite != null
        ? inst.meanComposite - prev.meanComposite
        : null;
    const delta = deltaLabel(dComposite);
    return (
      <li
        key={inst.instanceId}
        className="pc-learning__row pc-learning__row--bench"
        title={inst.instanceId}
      >
        <span
          className="pc-learning__sev"
          style={{ background: delta.tone === "bad" ? "#fb7185" : "#34d399" }}
          aria-hidden
        />
        <span className="pc-learning__id" title={inst.codeSha}>
          {shortSha(inst.codeSha)}
        </span>
        <span className="pc-learning__benchcell">
          <span className="pc-learning__benchnum">
            {compositeLabel(inst.meanComposite)}
          </span>
          {i < instances.length - 1 ? (
            <span
              className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
            >
              Δ {delta.text}
            </span>
          ) : null}
          <span className="pc-learning__benchmeta">
            {inst.successfulRuns}/{inst.totalRuns} solved
          </span>
        </span>
        <span className="pc-learning__meta">
          <span className="pc-learning__age">
            {secsLabel(inst.meanTimeToGreenSecs)}
          </span>
          <span className="pc-learning__age">
            {tokensLabel(inst.meanTokens)}
          </span>
          <span className="pc-learning__age">{dateLabel(inst.createdAt)}</span>
        </span>
      </li>
    );
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Gauge}
        title="Benchmark"
        question="Did the new build get better?"
        signal={
          latest
            ? `${latest.successfulRuns}/${latest.totalRuns} solved`
            : undefined
        }
        tone={latest && latest.successRate >= 0.8 ? "good" : "neutral"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the benchmark"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {sync.loading && !sync.data ? (
        <p className="pc-learning__empty">Loading the benchmark…</p>
      ) : fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Benchmark unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest && !pending ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
        <LearningVisualEmpty
          icon={Gauge}
          title="No benchmark runs"
          body="This view compares runs against the same benchmark set, so a regression shows up as a score drop. Runs appear here once a benchmark has been run."
        />
      ) : (
        <>
          {!latest && pending ? (
            <div className="pc-learning-visual__layout">
              <LearningHeroMetric
                eyebrow={shortSha(pending.codeSha)}
                value={`${pending.successfulRuns}/${pending.totalRuns}`}
                status="pending"
                tone="accent"
              >
                runs complete
              </LearningHeroMetric>
            </div>
          ) : null}
          {latest ? (
            <>
              <div className="pc-learning-visual__layout">
                <LearningHeroMetric
                  eyebrow={shortSha(latest.codeSha)}
                  value={compositeLabel(latest.meanComposite)}
                  status={
                    currentDelta == null
                      ? "baseline"
                      : currentDelta > 0
                        ? "improved"
                        : currentDelta < 0
                          ? "regressed"
                          : "unchanged"
                  }
                  tone={
                    currentDelta == null
                      ? "accent"
                      : currentDelta > 0
                        ? "good"
                        : currentDelta < 0
                          ? "bad"
                          : "neutral"
                  }
                >
                  <span>
                    {currentDelta != null
                      ? `Δ ${currentDeltaMeta.text}`
                      : "first generation"}
                  </span>
                  {pending ? (
                    <span
                      className="pc-learning__pendinginline"
                      role="status"
                      title={`${shortSha(pending.codeSha)} is awaiting a scored result`}
                    >
                      <Clock size={10} aria-hidden />
                      {shortSha(pending.codeSha)} · {pending.successfulRuns}/
                      {pending.totalRuns}
                    </span>
                  ) : null}
                </LearningHeroMetric>
                <LearningComparisonBars
                  title="Previous vs current"
                  baselineName="Previous"
                  treatmentName="Current"
                  rows={[
                    {
                      label: "Composite",
                      baseline: previous?.meanComposite ?? null,
                      treatment: latest.meanComposite,
                      baselineLabel: compositeLabel(
                        previous?.meanComposite ?? null,
                      ),
                      treatmentLabel: compositeLabel(latest.meanComposite),
                      max: 10,
                      treatmentWins:
                        latest.meanComposite != null &&
                        latest.meanComposite >=
                          (previous?.meanComposite ?? -Infinity),
                    },
                    {
                      label: "Success",
                      baseline: previous?.successRate ?? null,
                      treatment: latest.successRate,
                      baselineLabel: pctLabel(previous?.successRate ?? null),
                      treatmentLabel: pctLabel(latest.successRate),
                      max: 1,
                      treatmentWins:
                        latest.successRate >=
                        (previous?.successRate ?? -Infinity),
                    },
                    {
                      label: "Time to green",
                      baseline: previous?.meanTimeToGreenSecs ?? null,
                      treatment: latest.meanTimeToGreenSecs,
                      baselineLabel: secsLabel(
                        previous?.meanTimeToGreenSecs ?? null,
                      ),
                      treatmentLabel: secsLabel(latest.meanTimeToGreenSecs),
                      treatmentWins:
                        latest.meanTimeToGreenSecs != null &&
                        latest.meanTimeToGreenSecs <=
                          (previous?.meanTimeToGreenSecs ?? Infinity),
                    },
                  ]}
                />
                <LearningEvidenceRail>
                  <div className="pc-learning-visual__evidence-grid">
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Success</span>
                      <strong>{pctLabel(latest.successRate)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Time</span>
                      <strong>{secsLabel(latest.meanTimeToGreenSecs)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Tokens</span>
                      <strong>{tokensLabel(latest.meanTokens)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Escalations</span>
                      <strong>{pctLabel(latest.escalationRate)}</strong>
                    </div>
                  </div>
                </LearningEvidenceRail>
              </div>
            </>
          ) : null}

          <BenchmarkTrend instances={instances} />

          <div className="pc-learning__sectionhead">
            <h2>Recent generations</h2>
          </div>
          <ul className="pc-learning__list">
            {instances.slice(0, 5).map(renderInstance)}
          </ul>
          {instances.length > 5 ? (
            <LearningDisclosure
              label="Earlier generations"
              count={instances.length - 5}
            >
              <ul className="pc-learning__list">
                {instances
                  .slice(5)
                  .map((inst, i) => renderInstance(inst, i + 5))}
              </ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Hive orchestration trend (hive-eval battery — hive-run-evaluation HE-07) ──
//
// The SIBLING of the apiary trend: where the apiary scores how good the agents' CODE gets over
// generations, this scores how good the Hive's ORCHESTRATION gets (outcome quality · efficiency ·
// speed, gated un-gameably). Its own `learning.hiveEvalTrend` snapshot over the hive_eval tables;
// reuses the BenchmarkTrend surface. Owner-gated (P-051) — graceful-empty until the first armed run.

interface HiveEvalGeneration {
  instanceId: string;
  codeSha: string;
  createdAt: string;
  totalRuns: number;
  scoredRuns: number;
  meanComposite: number | null;
  meanEfficiency: number | null;
  meanSpeed: number | null;
  meanCriticalPathRatio: number | null;
  outcomeGatePassRate: number | null;
  fabricationRate: number | null;
}

const ratioLabel = (v: number | null): string =>
  v == null ? "—" : `${v.toFixed(2)}×`;

function HiveEvalTrendView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<{ instances: HiveEvalGeneration[] }>({
    queryName: "learning.hiveEvalTrend",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const hiveEvalTrendSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    hiveEvalTrendSettled,
    active,
  );
  const instances = sync.data?.[0]?.instances ?? [];
  // WI-6410: the resolver has carried degraded provenance since WI-6382, but
  // this view dropped it — `?? []` collapsed a FAILED read into the same value
  // as a genuinely empty one, so the empty state below claimed "a trend appears
  // after two or more evaluations" when the truth was that we could not read.
  const fault = snapshotFault(sync.error, sync.data?.[0], `${t("pot")} eval`);
  const latest = instances[0];
  const previous = instances[1];
  const compositeDelta =
    latest?.meanComposite != null && previous?.meanComposite != null
      ? latest.meanComposite - previous.meanComposite
      : null;
  const compositeDeltaMeta = deltaLabel(compositeDelta);
  // Reuse the BenchmarkTrend surface — the composite per generation, oldest→newest.
  const trendInstances: BenchmarkTrendInstance[] = instances.map((i) => ({
    instanceId: i.instanceId,
    codeSha: i.codeSha,
    createdAt: i.createdAt,
    totalRuns: i.totalRuns,
    successfulRuns: i.scoredRuns,
    meanComposite: i.meanComposite,
  }));
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : latest && (latest.fabricationRate ?? 0) === 0
          ? "good"
          : latest
            ? "warn"
            : "neutral",
    );
  }, [latest, onStatus, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Activity}
        title={`${t("pot")} scoring`}
        question="Are orchestration scores improving?"
        signal={
          latest ? `${latest.scoredRuns}/${latest.totalRuns} scored` : undefined
        }
        tone={latest && (latest.fabricationRate ?? 0) === 0 ? "good" : "warn"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label={`Reload the ${t("pot")}-orchestration trend`}
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? `${t("pot")} eval unavailable`}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
        // WI-6410: this branch now means a GENUINE empty — a failed read
        // renders as an error above.
        <LearningVisualEmpty
          icon={Activity}
          title={`No ${t("pot")}-eval runs`}
          body={`This view tracks how each ${t("pot", { lower: true })}'s evaluation scores move over time. A trend appears here after two or more evaluations.`}
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow={shortSha(latest.codeSha)}
              value={compositeLabel(latest.meanComposite)}
              status={
                compositeDelta == null
                  ? "baseline"
                  : compositeDelta > 0
                    ? "improved"
                    : compositeDelta < 0
                      ? "regressed"
                      : "unchanged"
              }
              tone={
                compositeDelta == null
                  ? "accent"
                  : compositeDelta > 0
                    ? "good"
                    : compositeDelta < 0
                      ? "bad"
                      : "neutral"
              }
            >
              {compositeDelta == null
                ? "first generation"
                : `Δ ${compositeDeltaMeta.text}`}
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Previous vs current"
              baselineName="Previous"
              treatmentName="Current"
              rows={[
                {
                  label: "Outcome gate",
                  baseline: previous?.outcomeGatePassRate ?? null,
                  treatment: latest.outcomeGatePassRate,
                  baselineLabel: pctLabel(
                    previous?.outcomeGatePassRate ?? null,
                  ),
                  treatmentLabel: pctLabel(latest.outcomeGatePassRate),
                  max: 1,
                  treatmentWins:
                    latest.outcomeGatePassRate != null &&
                    latest.outcomeGatePassRate >=
                      (previous?.outcomeGatePassRate ?? -Infinity),
                },
                {
                  label: "Critical path",
                  baseline: previous?.meanCriticalPathRatio ?? null,
                  treatment: latest.meanCriticalPathRatio,
                  baselineLabel: ratioLabel(
                    previous?.meanCriticalPathRatio ?? null,
                  ),
                  treatmentLabel: ratioLabel(latest.meanCriticalPathRatio),
                  treatmentWins:
                    latest.meanCriticalPathRatio != null &&
                    latest.meanCriticalPathRatio <=
                      (previous?.meanCriticalPathRatio ?? Infinity),
                },
                {
                  label: "Fabrication",
                  baseline: previous?.fabricationRate ?? null,
                  treatment: latest.fabricationRate,
                  baselineLabel: pctLabel(previous?.fabricationRate ?? null),
                  treatmentLabel: pctLabel(latest.fabricationRate),
                  max: 1,
                  treatmentWins:
                    latest.fabricationRate != null &&
                    latest.fabricationRate <=
                      (previous?.fabricationRate ?? Infinity),
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Efficiency</span>
                  <strong>{compositeLabel(latest.meanEfficiency)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Speed</span>
                  <strong>{compositeLabel(latest.meanSpeed)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Scored</span>
                  <strong>{latest.scoredRuns}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Runs</span>
                  <strong>{latest.totalRuns}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          <BenchmarkTrend instances={trendInstances} />
        </>
      )}
    </section>
  );
}

// ─── Framework bake-off trend (plan-implementation-framework-2026-06-15 P-014) ──
//
// The A/B proof per bet: flip a flag OFF vs ON over the scored hive-eval corpus, diff the gated
// composite + outcome-gate pass rate. The SIBLING of the apiary + hive-orchestration trends — its
// own `learning.bakeoff` snapshot over hive_eval_bakeoff_deltas (migration 293). A regressed verdict
// auto-reverts the flag (P-015). Owner-gated (a real bake-off spends budget + needs the operator
// runtime) — graceful-empty until the first run lands.

const BAKEOFF_VERDICT_META: Record<
  BakeoffTrendRow["verdict"],
  { label: string; tone: "good" | "bad" | "flat"; color: string }
> = {
  improved: {
    label: "improved",
    tone: "good",
    color: CATEGORICAL.emerald400.hex,
  },
  regressed: { label: "regressed", tone: "bad", color: CATEGORICAL.red400.hex },
  neutral: { label: "neutral", tone: "flat", color: CATEGORICAL.slate400.hex },
  inconclusive: {
    label: "inconclusive",
    tone: "flat",
    color: CATEGORICAL.slate500.hex,
  },
};

function BakeoffTrendView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const sync = useSyncQuery<{ rows: BakeoffTrendRow[] }>({
    queryName: "learning.bakeoff",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const bakeoffSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    bakeoffSettled,
    active,
  );
  const rows = sync.data?.[0]?.rows ?? [];
  // WI-6410: `sync.error` used to feed ONLY the onStatus tint, so a failed read
  // fell through to the "No bake-offs" empty state — whose body ("Results
  // appear here once one has finished") is an active lie when the truth is that
  // the read failed. The resolver already reports this; the view was discarding it.
  const fault = snapshotFault(sync.error, sync.data?.[0], "Framework bake-off");
  // Each bet's CURRENT standing — rows arrive newest-first, so the first verdict per flag is latest
  // (the same logic as the canonical latestVerdictByFlag formatter; inlined to keep the client bundle
  // free of an operator-core value import).
  const standings: Array<{
    flag: string;
    verdict: BakeoffTrendRow["verdict"];
  }> = [];
  const seenFlags = new Set<string>();
  for (const r of rows) {
    if (!seenFlags.has(r.flagKey)) {
      seenFlags.add(r.flagKey);
      standings.push({ flag: r.flagKey, verdict: r.verdict });
    }
  }
  const latest = rows[0];
  const latestMeta = latest ? BAKEOFF_VERDICT_META[latest.verdict] : null;
  const latestComposite = latest ? deltaLabel(latest.deltaMeanComposite) : null;
  const gateDeltaLabel = latest
    ? `${latest.deltaGatePassRate >= 0 ? "+" : "−"}${Math.abs(latest.deltaGatePassRate * 100).toFixed(1)}pp`
    : "—";
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : latest?.verdict === "improved"
          ? "good"
          : latest?.verdict === "regressed"
            ? "bad"
            : latest
              ? "neutral"
              : "neutral",
    );
  }, [latest, onStatus, sync.error]);
  const renderBakeoff = (r: BakeoffTrendRow, i: number) => {
    const dc = deltaLabel(r.deltaMeanComposite);
    const meta = BAKEOFF_VERDICT_META[r.verdict];
    return (
      <li
        key={`${r.flagKey}-${r.at}-${i}`}
        className="pc-learning__row pc-learning__row--bench"
        title={r.flagKey}
      >
        <span
          className="pc-learning__sev"
          style={{ background: meta.color }}
          aria-hidden
        />
        <span className="pc-learning__id" title={r.flagKey}>
          {r.flagKey.replace(/^papercusp-/, "")}
        </span>
        <span className="pc-learning__benchcell">
          <span
            className={`pc-learning__delta pc-learning__delta--${meta.tone}`}
          >
            {meta.label}
          </span>
          <span className={`pc-learning__delta pc-learning__delta--${dc.tone}`}>
            composite {dc.text}
          </span>
          {/* WI-6410: was `Δgate {toFixed(2)}` — the RAW fraction, while the hero
              metric above renders this SAME quantity ×100 as "pp". One number,
              two scales, one screen. Percentage points is the scale that reads,
              so both now use it. ("Δcomp"/"Δgate" also went to plain words: this
              is a public-release surface, and neither was defined anywhere on it.) */}
          <span className="pc-learning__benchmeta">
            outcome gate {r.deltaGatePassRate >= 0 ? "+" : "−"}
            {Math.abs(r.deltaGatePassRate * 100).toFixed(1)}pp
          </span>
        </span>
        <span className="pc-learning__meta">
          <span className="pc-learning__age">{whenLabel(r.at)}</span>
        </span>
      </li>
    );
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Repeat2}
        title="Framework bake-off"
        question="Did the bet pay off?"
        signal={latestMeta?.label}
        tone={
          latest?.verdict === "improved"
            ? "good"
            : latest?.verdict === "regressed"
              ? "bad"
              : "neutral"
        }
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the framework bake-off trend"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Framework bake-off unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest || !latestMeta || !latestComposite ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
        // WI-6410: reached only on a GENUINE empty now — a failed read renders
        // as an error above, so this copy's promise is honest again.
        <LearningVisualEmpty
          icon={Repeat2}
          title="No bake-offs"
          body="A bake-off runs two configurations against the same work and reports which did better. Results appear here once one has finished."
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow={latest.flagKey.replace(/^papercusp-/, "")}
              value={latestComposite.text}
              status={latestMeta.label}
              tone={
                latest.verdict === "improved"
                  ? "good"
                  : latest.verdict === "regressed"
                    ? "bad"
                    : "warn"
              }
            >
              {gateDeltaLabel} outcome gate
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Baseline vs treatment"
              rows={[
                {
                  label: "Composite lift",
                  baseline: 0,
                  treatment: Math.abs(latest.deltaMeanComposite),
                  baselineLabel: "0",
                  treatmentLabel: latestComposite.text,
                  max: Math.max(1, Math.abs(latest.deltaMeanComposite) * 1.25),
                  treatmentWins: latest.deltaMeanComposite > 0,
                },
                {
                  label: "Outcome gate",
                  baseline: 0,
                  treatment: Math.abs(latest.deltaGatePassRate),
                  baselineLabel: "0pp",
                  treatmentLabel: gateDeltaLabel,
                  max: Math.max(0.1, Math.abs(latest.deltaGatePassRate) * 1.25),
                  treatmentWins: latest.deltaGatePassRate > 0,
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Verdict</span>
                  <strong>{latestMeta.label}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Gate</span>
                  <strong>{gateDeltaLabel}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Flags</span>
                  <strong>{standings.length}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Runs</span>
                  <strong>{rows.length}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>

          <div className="pc-learning__sectionhead">
            <h2>Recent bake-offs</h2>
            <div
              className="pc-learning__standings"
              aria-label="Current flag standings"
            >
              {standings.slice(0, 4).map(({ flag, verdict }) => (
                <span
                  key={flag}
                  className={`pc-learning__delta pc-learning__delta--${BAKEOFF_VERDICT_META[verdict].tone}`}
                >
                  {flag.replace(/^papercusp-/, "")} ·{" "}
                  {BAKEOFF_VERDICT_META[verdict].label}
                </span>
              ))}
            </div>
          </div>
          <ul className="pc-learning__list">
            {rows.slice(0, 4).map(renderBakeoff)}
          </ul>
          {rows.length > 4 ? (
            <LearningDisclosure
              label="Earlier bake-offs"
              count={rows.length - 4}
            >
              <ul className="pc-learning__list">
                {rows.slice(4).map((row, i) => renderBakeoff(row, i + 4))}
              </ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Scout view (idea radar — routed ideas + tick health) ────────────────────

/**
 * WI-469537 — the text a rail chip shows when its visible count and the corpus
 * disagree.
 *
 * Extracted from the JSX purely so it is TESTABLE: the chip's tooltip is a Radix
 * `asChild` trigger whose content is portaled and rendered only on hover, so the
 * wording cannot be asserted from a render without driving pointer events. This
 * is the sentence that carries the chip's PROMISE, and the whole work-item is
 * about a promise that drifted from the code, so it needs to be pinned.
 *
 * `shown` describes the rows loaded right now; `routedTotal` is the corpus tally.
 * Selecting the rail re-reads the corpus (`rails:[…]` enters the server predicate
 * and `projectLearningImproveRows` filters the whole corpus BEFORE windowing), so
 * the click yields up to `routedTotal` — not `shown`. The sentence must say that:
 * framing `routedTotal` as mere background context is what made the chip
 * under-promise.
 */
export function railChipPromise(
  desc: string,
  shown: number,
  routedTotal: number,
): string {
  if (shown === routedTotal) return desc;
  return `${desc} — ${shown} of the rows loaded here; selecting it re-reads the corpus and lists up to ${routedTotal}.`;
}

/** Rail → human label + accent for the routed-ideas rows. The canonical set is
    RoutedRail ('plan' | 'gym' | 'improvement' | 'instance') — open set, render
    whatever arrives. Built per-render from the active lexicon so the agent-noun
    in the plan-draft copy tracks the FLAGS.THE_HIVE pack (restore-pot-lexicon P-006). */
function railMeta(
  t: ReturnType<typeof useLexicon>,
): Record<string, { label: string; desc: string; color: string }> {
  return {
    plan: {
      label: "plan draft",
      desc: `A draft plan awaiting ${t("brain")}/owner triage — open it in the Create tab`,
      color: "var(--accent-strong, var(--accent))",
    },
    gym: {
      label: "gym",
      desc: "Seeded into the gym quality-diversity experiment archive",
      color: CATEGORICAL.emerald400.hex,
    },
    improvement: {
      label: "improvement",
      desc: "Filed as an improvement work-item (EI-…) in the backlog",
      color: CATEGORICAL.violet400.hex,
    },
    instance: {
      label: "instance",
      desc: "Registered as a genome-variant candidate for the apiary eval-battery",
      color: CATEGORICAL.pink400.hex,
    },
  };
}

/** Tone for one tick-economics cell (learning-tab-alignment P-002): an errored
    tick is red; a ran cycle that exhausted its budget without routing anything
    is amber (the WI-4482 starvation signature — spend with no yield); a
    completed run is green; a self-gated tick is idle/neutral. */
function tickTone(tk: ScoutTickEconomics): "good" | "warn" | "bad" | "idle" {
  if (tk.status === "error") return "bad";
  if (tk.status === "ran")
    return tk.stop === "budget-exhausted" && tk.routed === 0 ? "warn" : "good";
  return "idle";
}

/** Compact lens initials for the strip's chips ("first-principles" → "fp",
    "analogical" → "a") — the full name + count rides the chip tooltip. */
/** The grade a row should display: an in-flight optimistic owner write wins,
    then the snapshot's stored grade, else null (ungraded). */
interface EffectiveGrade {
  grade: number;
  feedback: string | null;
  gradedBy: string;
}

/**
 * An optimistic grade PLUS the two facts that bound its life. The overlay is a
 * BRIDGE across one refetch — it exists only to cover the gap between the POST
 * and the snapshot `submitGrade` invalidates for — so it must yield the instant
 * the ledger answers. Both fields are that expiry, and either one alone ends it:
 *
 *  - `snapshot` — the snapshot object the write was made against. A different
 *    one means the refetch landed, so the ledger has spoken even if the value it
 *    reports is unchanged.
 *  - `supersedes` — the stored grade at write time. A different value means
 *    SOMEBODY's write landed (ours, confirmed — or a peer's), and the ledger is
 *    the grade authority either way.
 *
 * Checking both is not belt-and-braces for one hazard; each closes a hole the
 * other leaves. A cached refetch that returns the same object identity still
 * expires the overlay by value; and once `snapshot` has gone stale it can never
 * become current again, so a later snapshot that happens to read `supersedes`
 * once more (a peer regrading back to the prior value) cannot resurrect it.
 *
 * WI-518795: an overlay with no expiry outlives its own confirmation and wins
 * over `humanGrade` for the LIFE OF THE MOUNTED VIEW — so on a live SSE row, a
 * later grade from any other source (a peer owner session, the auto-grader, a
 * corrective regrade, the server's own clamped feedback) renders behind this
 * session's stale value with no stale marker and no way to clear it.
 */
interface OptimisticGrade extends EffectiveGrade {
  snapshot: ScoutSnapshot | undefined;
  supersedes: number | null;
}

const GRADE_MEANING: Record<number, string> = {
  1: "a bad call — counts as a full loss for this lens",
  2: "weak — mostly a loss",
  3: "neutral — half win, half loss",
  4: "useful — mostly a win",
  5: "excellent — counts as a full win for this lens",
};

/** Attribution label per C-1's graded_by values ('owner' | 'auto-grader').
    The raw auto-grader machine id is routed to the active lexicon's brain word
    for display so the public (Pot) build never surfaces internal vocabulary
    (restore-pot-lexicon P-006; the retired 'Queen' value was migrated —
    WI-39481). */
const graderLabel = (gradedBy: string, brainWord: string): string =>
  gradedBy === "owner"
    ? "Owner"
    : gradedBy === "auto-grader"
      ? brainWord
      : gradedBy;

/** The grade CHIP's short form of `graderLabel`. A peer agent grade carries
    the grader's full session id (`su-2f324ce6-c2d6-…`, ~40 chars), which made
    the nowrap chip ~250px and pushed the row's note button out of its cell at
    1366px (WI-10006513). The chip shows the presence-style short id
    (`su-2f324`); the full id stays in the chip's title. */
export const graderChipLabel = (gradedBy: string, brainWord: string): string => {
  const label = graderLabel(gradedBy, brainWord);
  const agent = /^([a-z]+)-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f-]+$/i.exec(label);
  return agent ? `${agent[1]}-${agent[2].slice(0, 5)}` : label;
};

/** The tool-proxy response envelope varies (the parsed result | {result} | MCP
    content text) — unwrap whichever the dispatcher returns. */
function unwrapToolResult(d: unknown): Record<string, unknown> {
  const o = d as {
    content?: Array<{ type?: string; text?: string }>;
    result?: unknown;
  } | null;
  const text = Array.isArray(o?.content)
    ? o.content.find((c) => c?.type === "text")?.text
    : undefined;
  if (typeof text === "string") {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const inner = o?.result ?? d;
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>)
    : {};
}

/** The 1–5 star radio row. Always interactive — the owner may regrade anything
    (D-004: owner grade is sovereign; the server derives gradedBy from the surface). */
function StarControl({
  value,
  onRate,
  busy = false,
  size = 13,
}: {
  value: number | null;
  onRate: (grade: number) => void;
  busy?: boolean;
  size?: number;
}) {
  return (
    <span
      className="pc-learning__stars"
      role="radiogroup"
      aria-label="Grade this idea 1 to 5"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Tooltip key={n} label={`★${n} — ${GRADE_MEANING[n]}`}>
          <button
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`Grade ${n} of 5`}
            className={`pc-learning__star${value != null && n <= value ? " is-on" : ""}`}
            disabled={busy}
            onClick={() => onRate(n)}
          >
            <Star
              size={size}
              aria-hidden
              fill={value != null && n <= value ? "currentColor" : "none"}
            />
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/** The note popover (open-state in nuqs `?grade=<ideaId>`): stars + a free-text
    critique saved together through `blender:grade-idea`. Mid-edit drafts are
    useState by design (nuqs is for the open-state only). */
function GradePanel({
  current,
  busy,
  onSave,
  onClose,
}: {
  current: EffectiveGrade | null;
  busy: boolean;
  onSave: (grade: number, feedback: string | null) => void;
  onClose: () => void;
}) {
  const t = useLexicon();
  const [grade, setGrade] = useState<number | null>(current?.grade ?? null);
  const [draft, setDraft] = useState(current?.feedback ?? "");
  return (
    <div
      className="pc-learning__gradepanel"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-learning__gradepanelrow">
        <StarControl value={grade} onRate={setGrade} size={16} />
        <span className="pc-learning__gradepanelhint">
          {grade == null
            ? "Pick a grade — 5 counts as a win for this lens, 1 as a loss."
            : `★${grade} — ${GRADE_MEANING[grade]}`}
        </span>
        <button
          type="button"
          className="pc-learning__panelbtn pc-learning__gradecancel"
          onClick={onClose}
        >
          cancel
        </button>
      </div>
      {grade != null ? (
        <>
          <textarea
            value={draft}
            rows={2}
            maxLength={2000}
            aria-label="Grading note"
            placeholder={`Why? ${t("scout")} quotes recent grading notes to the next cycle’s ideators.`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="pc-learning__gradepanelactions">
            <button
              type="button"
              className="pc-learning__panelbtn pc-learning__panelbtn--primary"
              disabled={busy}
              onClick={() => onSave(grade, draft.trim() ? draft.trim() : null)}
            >
              {busy ? "saving…" : "save grade"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** ms → compact human duration: "45s", "2m 0s", "1h 3m". */
function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Throughput view (queen-autonomous-execution B-11 / P-050): the Queen-loop's
 * operating-well yardstick — per-hive frontier depth, placements/wake,
 * cups-busy-vs-cap, stuck count, mean-time-to-complete, and the question-rung
 * split, read from hive_throughput_ticks (mig 261) via learning.hiveThroughput.
 */
function ThroughputView({
  hive = "",
  hiveReady = true,
  onStatus,
  active = true,
}: {
  /** Pot lens (pot-scope-all-learnings P-005): scopes the tick metrics and the
   *  soak verdicts to one pot; empty = every pot (no lens). */
  hive?: string;
  /** WI-5412 gate: don't fetch until the tab's hive lens is resolved. */
  hiveReady?: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<HiveThroughputSnapshot>({
    queryName: "learning.hiveThroughput",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const soak = useSyncQuery<PotSoakReportSnapshot>({
    queryName: "learning.soakReport",
    args: hive ? { hive } : {},
    staleTime: 60_000,
    enabled: hiveReady,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // gated on the PRIMARY read only (learning.hiveThroughput), deliberately
  // not on the soak-report leg: same rule as the sibling settle points in
  // ImprovementsView/LearningsView — a secondary read shouldn't have its cost
  // attributed to this interaction. Settles on a fault too, gated on `active`
  // so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732).
  const throughputSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    throughputSettled,
    active,
  );
  const snap = sync.data?.[0];
  const hives = snap?.hives ?? [];
  const soakByHive = new Map(
    (soak.data?.[0]?.hives ?? []).map((report) => [report.potSlug, report]),
  );
  // WI-6410: the throughput fault below folds in `soak.error` (the transport
  // half) but reads provenance from the THROUGHPUT snapshot only, so a soak read
  // that failed inside its own resolver was invisible. Checked separately
  // because the two reads fail independently and this one must not blank the view.
  const soakFault = snapshotFault(soak.error, soak.data?.[0], "Soak gate");
  // WI-6382/WI-6383: the resolver catches a read failure and returns a
  // SUCCESSFUL empty snapshot (never a 500), so `sync.error` alone left this
  // view's fault path unreachable — a broken or pre-migration install rendered
  // as the calm "no throughput recorded yet" card below, which then instructed
  // the reader to go start a pot and wait for data that could never arrive.
  // The degraded snapshot now carries provenance; fold it into the SAME branch.
  // Wiring it is part of restoring reachability, not scope creep: this view was
  // skipped by WI-6382's panel sweep precisely BECAUSE no user could open it.
  const fault = snapshotFault(sync.error ?? soak.error, snap, "Throughput");
  // The status is computed FIRST and the effect depends on the resulting STRING —
  // never on `hives`. This is the shape every sibling panel uses (FrontierPanel,
  // EkgPanel, …) and ThroughputView was the one that did not: it listed `hives` in
  // the deps, and `hives` is `snap?.hives ?? []`, a fresh array identity on every
  // render whenever the read has not landed. That re-fires the effect each render
  // instead of when the status actually changes — the ingredient a render loop
  // needs (WI-6383 found this view crashing the whole Learning tab live with React
  // #185, "Maximum update depth exceeded", while 86 jsdom tests stayed green).
  const status: LearningViewStatus = fault.failed
    ? "bad"
    : hives.some((hive) => !hive.operatingWell)
      ? "warn"
      : hives.length > 0
        ? "good"
        : "neutral";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  return (
    <section className="pc-learning__section">
      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Throughput unavailable"}
          onRetry={() => {
            sync.invalidate();
            soak.invalidate();
          }}
        />
      ) : hives.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <strong>No throughput recorded yet</strong>
          <span>
            The {t("brain")} {t("pot", { lower: true })} loop records a tick
            every ~30s while a {t("pot", { lower: true })} is{" "}
            <strong>started</strong> with queued work. Start a{" "}
            {t("pot", { lower: true })} (or wait for its next wake) and its
            placement metrics appear here.
          </span>
        </div>
      ) : (
        hives.map((h) => {
          const m = h.latest;
          const report = soakByHive.get(h.potSlug);
          const rungs = m?.questionRungs ?? {};
          const rungTotal = Object.values(rungs).reduce<number>(
            (a, b) => a + (Number(b) || 0),
            0,
          );
          const tickMs = m?.tickAt ? Date.parse(m.tickAt) : NaN;
          const utilPct = m ? Math.round(m.utilization * 100) : 0;
          const saturated =
            !!m &&
            !h.operatingWell &&
            m.utilization >= 1 &&
            m.frontierDepth > 0;
          return (
            <div key={h.potSlug} className="pc-learning__throughputhive">
              <div
                className="pc-learning__flow"
                aria-label={`${h.potSlug} throughput health`}
              >
                <span
                  className={`pc-learning__flowchip ${h.operatingWell ? "pc-learning__flowchip--wd-good" : "pc-learning__flowchip--wd-warn"}`}
                  title={`The ${t("pot", { lower: true })} whose ${t("brain")}-loop throughput this is, how recently it ticked, and whether the loop is operating well (frontier draining, fleet not pegged, no stuck placements).`}
                >
                  <Activity size={11} aria-hidden />
                  {h.potSlug}
                  <strong>
                    {m && !Number.isNaN(tickMs)
                      ? whenLabel(tickMs)
                      : "no ticks"}
                  </strong>
                  <em>
                    {h.operatingWell ? "operating well" : "needs attention"}
                  </em>
                </span>
                {!report && soakFault.failed ? (
                  // WI-6410: `learning.soakReport` is a SECOND degraded-capable
                  // read in this view, and the fault check above only ever saw
                  // the throughput one — so a failed soak read silently removed
                  // the readiness chip, which reads as "no gate" rather than "we
                  // could not check the gate". A missing safety verdict must not
                  // look like an absent one.
                  <span
                    className="pc-learning__flowchip pc-learning__flowchip--wd-warn"
                    title={soakFault.message ?? "Soak gate unavailable"}
                  >
                    <ShieldCheck size={11} aria-hidden />
                    soak gate
                    <strong>UNKNOWN</strong>
                  </span>
                ) : report ? (
                  <span
                    className={`pc-learning__flowchip ${report.ready ? "pc-learning__flowchip--wd-good" : "pc-learning__flowchip--wd-warn"}`}
                    title={
                      report.ready
                        ? `Production-readiness gate held green for ${report.windowHours}h`
                        : `NOT-READY: ${report.reasons.join(" · ")}`
                    }
                  >
                    <ShieldCheck size={11} aria-hidden />
                    soak gate
                    <strong>{report.ready ? "READY" : "NOT-READY"}</strong>
                    <em>{report.windowHours}h window</em>
                  </span>
                ) : null}
              </div>

              {report ? (
                <div
                  className="pc-learning__flow"
                  aria-label={`${h.potSlug} production readiness`}
                >
                  <span
                    className="pc-learning__flowchip"
                    title="Machine-checkable production-readiness verdict over the rolling soak window."
                  >
                    <ShieldCheck size={11} aria-hidden />
                    reasons
                  </span>
                  {report.reasons.length === 0 ? (
                    <span className="pc-learning__lens">
                      <em>all thresholds held</em>
                      <strong>0</strong>
                    </span>
                  ) : (
                    report.reasons.slice(0, 5).map((reason, i) => (
                      <span
                        key={`${report.potSlug}-reason-${i}`}
                        className="pc-learning__lens"
                        title={reason}
                      >
                        <em>{reason}</em>
                      </span>
                    ))
                  )}
                </div>
              ) : null}

              <div
                className="pc-learning__scoreboard"
                aria-label={`${h.potSlug} throughput`}
              >
                <Stat
                  label="frontier"
                  value={m ? m.frontierDepth : "—"}
                  hint={`Ready work waiting for placement (todo items) — the queue the ${t("brain")} pours from.`}
                />
                <Stat
                  label={`${t("contributor", { plural: true, lower: true })} busy`}
                  value={m ? `${m.cupsBusy}/${m.cupsCap}` : "—"}
                  tone={saturated ? "human" : "good"}
                  hint={`Live placed ${t("contributor", { plural: true, lower: true })} vs the fleet ceiling. Pegged at cap with work still queued = starvation (raise the ceiling / widen the credential pool, D-006).`}
                />
                <Stat
                  label="utilization"
                  value={m ? `${utilPct}%` : "—"}
                  hint={`Fleet utilization: ${t("contributor", { plural: true, lower: true })} busy ÷ cap.`}
                />
                <Stat
                  label="placed / wake"
                  value={m ? m.placements : "—"}
                  tone="auto"
                  hint={`${t("contributor", { plural: true })} newly placed since the previous tick — how fast the ${t("brain")} fans work out.`}
                />
                <Stat
                  label="completed"
                  value={m ? m.completed : "—"}
                  tone="auto"
                  hint={`${t("contributor", { plural: true })} that finished in the tick window.`}
                />
                <Stat
                  label="avg complete"
                  value={formatDurationMs(m?.mttcMs)}
                  hint={`Mean-time-to-complete over ${t("contributor", { plural: true, lower: true })} that finished — how long a placement takes.`}
                />
                <Stat
                  label="stuck"
                  value={m ? m.stuckCount : "—"}
                  {...(m && m.stuckCount > 0 ? { tone: "human" as const } : {})}
                  hint={`Placed ${t("contributor", { plural: true, lower: true })} with a stale heartbeat — placements that stopped advancing and need a recovery wake (the placement watchdog, P-020).`}
                />
                <Stat
                  label="questions"
                  value={rungTotal}
                  hint={`${t("contributor")} questions resolved this window, split by rung below. Lights up when the question-ladder (B-10/B-17) lands; 0 until then.`}
                />
              </div>

              {rungTotal > 0 ? (
                <div
                  className="pc-learning__flow"
                  aria-label={`${h.potSlug} question rungs`}
                >
                  <span
                    className="pc-learning__flowchip"
                    title={`Where ${t("contributor", { lower: true })} questions resolved: ${t("contributor", { lower: true })}-self / peer-vote / ${t("brain")} / owner. The lower the rung, the less the owner was needed.`}
                  >
                    <HelpCircle size={11} aria-hidden />
                    question rungs
                  </span>
                  {Object.entries(rungs).map(([rung, count]) => (
                    <span
                      key={rung}
                      className="pc-learning__lens"
                      title={`${String(count)} question(s) resolved at the ${rung} rung`}
                    >
                      <em>{rung}</em>
                      <strong>{String(count)}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      <button
        type="button"
        className="pc-learning__refresh"
        aria-label={`Reload ${t("pot", { lower: true })} throughput`}
        disabled={sync.fetching || soak.fetching}
        onClick={() => {
          sync.invalidate();
          soak.invalidate();
        }}
      >
        <RefreshCw size={13} aria-hidden />
      </button>
    </section>
  );
}

/**
 * Cadence card (learning-tab-visibility P-001): the live volume-gate state.
 * Score/threshold/lane counts arrive server-derived from the gate's own reader
 * (never re-computed here); this renders them as a score bar + per-lane chips.
 */
/**
 * The firing state in one sentence. Extracted (P-004) because the "Will it
 * fire?" section leads with this line and the CadenceCard repeats it beside the
 * gauge — two renderings of one verdict, so they derive from one function
 * rather than two hand-kept copies that can disagree.
 */
function cadenceVerdict(cadence: ScoutCadenceState): string {
  if (cadence.score >= cadence.threshold)
    return "ready — the next cycle fires within ~30s";
  if (cadence.score <= 0)
    return "quiet — no new signal, so nothing fires (and nothing is spent)";
  return "collecting signal — fires at the threshold, or on the hourly heartbeat";
}

function CadenceCard({
  cadence,
  scoutWord,
}: {
  cadence: ScoutCadenceState;
  scoutWord: string;
}) {
  const pct =
    cadence.threshold > 0
      ? Math.min(100, Math.round((cadence.score / cadence.threshold) * 100))
      : 0;
  const armed = cadence.score >= cadence.threshold;
  const wmMs = cadence.watermarkAt ? Date.parse(cadence.watermarkAt) : NaN;
  const verdict = cadenceVerdict(cadence);
  return (
    <div
      className="pc-learning__cadence"
      role="group"
      aria-label={`${scoutWord} firing state`}
      title={`${scoutWord} fires on DATA VOLUME, not a clock: a 30s sweep recounts per-lane "new signal since the last successful cycle"; the weighted score (shown here, from the gate's own reader) fires a cycle at ≥${cadence.threshold}, a zero score withholds everything, and a heartbeat fires at least every ${Math.round(cadence.maxIntervalSec / 60)}m regardless.`}
    >
      <span className="pc-learning__cadence-head">
        <Gauge size={12} aria-hidden />
        <strong>
          signal {Math.round(cadence.score * 10) / 10} of {cadence.threshold}{" "}
          needed
        </strong>
        <span
          className="pc-learning__cadence-bar"
          role="progressbar"
          aria-valuenow={Math.round(cadence.score)}
          aria-valuemin={0}
          aria-valuemax={cadence.threshold}
        >
          <span
            className={`pc-learning__cadence-fill${armed ? " pc-learning__cadence-fill--armed" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <em>{verdict}</em>
      </span>
      <span
        className="pc-learning__cadence-lanes"
        title={cadence.lanes
          .filter((l) => l.count > 0)
          .map(
            (l) =>
              `${l.count} ${l.lane.replace(/-/g, " ")} × weight ${l.weight} = ${l.count * l.weight}`,
          )
          .join("\n")}
      >
        {cadence.lanes.some((l) => l.count > 0) ? (
          <>
            counting:{" "}
            {cadence.lanes
              .filter((l) => l.count > 0)
              .map((l) => `${l.count} ${l.lane.replace(/-/g, " ")}`)
              .join(", ")}
          </>
        ) : null}
        {cadence.lanes.every((l) => l.count === 0) ? (
          <span
            className="pc-learning__flowchip"
            title="No lane has accumulated new signal since the last successful cycle."
          >
            no new signal in any lane
          </span>
        ) : null}
        {!Number.isNaN(wmMs) ? (
          <span
            className="pc-learning__flowchip"
            title="The accumulator baseline — counts are 'new since this instant' (the last successful cycle)."
          >
            since {whenLabel(wmMs)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// The ideation surface is mounted directly inside Improve → Ideas.
/**
 * The cycle engine's instruments, lifted out of the retired Ideas view.
 *
 * Everything here answers "is the machine that MAKES ideas working" — the
 * idea→work funnel, the drift markers, what will fire the next cycle, and the
 * per-tick economics. It lives behind the Improve view's one labelled
 * disclosure: the gauges are on demand, the plain summary is always up top.
 */
/**
 * The loop's health markers, compressed to one line for the disclosure header
 * (P-004). These used to render ONLY inside the collapsed body, so a starving
 * loop announced itself to nobody until someone thought to expand the section.
 * The full list still renders inside; this is the part you cannot miss.
 */
function LoopWarningsAside({ snap }: { snap: ScoutSnapshot | undefined }) {
  const markers = snap?.health?.markers ?? [];
  if (markers.length === 0) return null;
  const worst = markers.find((m) => m.severity === "bad") ?? markers[0];
  return (
    <span
      className={`pc-learning__loopwarnaside${worst.severity === "bad" ? " is-bad" : ""}`}
      title={markers.map((m) => m.summary).join(" · ")}
    >
      <AlertTriangle size={11} aria-hidden />
      {markers.length === 1
        ? worst.summary
        : `${markers.length} loop warnings`}
    </span>
  );
}

function LoopEngineInstruments({
  snap,
  scoutWord,
}: {
  snap: ScoutSnapshot | undefined;
  scoutWord: string;
}) {
  const tick = snap?.lastTick ?? null;
  const tickMs = tick?.at ? Date.parse(tick.at) : NaN;
  // Older server snapshots lack these fields — degrade to an empty strip or a
  // neutral verdict, never a crash.
  const econTicks = snap?.ticks ?? [];
  const health = snap?.health ?? { status: "neutral" as const, markers: [] };
  const cadence = snap?.cadence ?? null;
  const funnel = snap?.improveFunnel ?? null;
  return (
    <>
      {health.markers.length > 0 ? (
        <ul className="pc-learning__warnlist" aria-label="Loop health warnings">
          {health.markers.map((m) => (
            <li
              key={m.key}
              className={m.severity === "bad" ? "is-bad" : "is-warn"}
              title={`Instruments the '${m.rubricCriterion}' criterion of the blender-release-readiness rubric.`}
            >
              <AlertTriangle size={12} aria-hidden />
              {m.summary}
            </li>
          ))}
        </ul>
      ) : null}

      {/* "Will it fire?" leads (owner-approved board, 2026-08-28). This
          SUPERSEDES the 2026-07-19e ask that put the funnel first: the reader's
          first question about a loop turned out to be whether it is going to
          run at all, not what it has already produced. */}
      {cadence ? (
        <LoopSection label="Will it fire?" answer={cadenceVerdict(cadence)}>
          <CadenceCard cadence={cadence} scoutWord={scoutWord} />
        </LoopSection>
      ) : null}

      {/* The funnel speaks the SAME vocabulary as the row chips below it
          (P-004) — a reader should not have to translate between the summary
          and the list. Stage 1 is the mouth (every idea); the drop from it to
          `approved` is the "not ready yet" population, so that word needs no
          column of its own here. */}
      {funnel ? (
        <LoopSection
          label="What has it made?"
          answer={
            // The dropped population is named, not implied: it is excluded from
            // `shipped` by design, and an unexplained gap between stages reads
            // as a broken number.
            funnel.dropped > 0
              ? `ideas that became work, and how far they got — ${funnel.dropped} dropped along the way, never counted as shipped`
              : "ideas that became work, and how far they got"
          }
        >
        <div className="pc-learning__funnel" aria-label="Idea-to-work funnel">
          <span title="Every idea a cycle routed onto a rail (work item, gym seed, plan, benchmark).">
            <strong>{funnel.routed}</strong>
            <small>ideas</small>
          </span>
          <i aria-hidden>→</i>
          <span
            title={`Filed as work on the improvement rail. ${PIPELINE_STATES.approved.desc}`}
          >
            <strong>{funnel.filed}</strong>
            <small>{PIPELINE_STATES.approved.label}</small>
          </span>
          <i aria-hidden>→</i>
          <span title={PIPELINE_STATES["in-flight"].desc}>
            <strong>{funnel.claimed}</strong>
            <small>{PIPELINE_STATES["in-flight"].label}</small>
          </span>
          <i aria-hidden>→</i>
          <span
            className={funnel.done > 0 ? "is-good" : undefined}
            title={
              // Name the abandoned population rather than hiding it: it is
              // excluded from `shipped` by design (EI-18792873324746237), and
              // an unexplained gap between stages invites the reader to assume
              // the number is broken — which, until this fix, it was.
              funnel.dropped > 0
                ? `${PIPELINE_STATES.shipped.desc} ${funnel.dropped} more were dropped — abandoned, not shipped, and never counted here.`
                : PIPELINE_STATES.shipped.desc
            }
          >
            <strong>{funnel.done}</strong>
            <small>{PIPELINE_STATES.shipped.label}</small>
          </span>
        </div>
        </LoopSection>
      ) : null}

      {/* Tick economics: each recent tick's stop reason, spend, generated→routed
          funnel and lens mix — the columns where the 17-day WI-4482 lens
          collapse and the budget-exhausted starvation lived, invisibly.
          P-004 gave the rows the column headers they never had: the four
          positional fields were previously unlabelled, so the reader had to
          infer from a tooltip what each column meant. */}
      <LoopSection
        label="Recent cycles"
        answer="what each tick generated, routed, and spent — and why it stopped"
      >
        {econTicks.length > 0 ? (
          <div className="pc-learning__tickhead" aria-hidden>
            <span>when</span>
            <span>made → routed</span>
            <span>why it stopped</span>
            <span>spend</span>
          </div>
        ) : null}
      <div
        className="pc-learning__tickstrip pc-learning__tickstrip--rows"
        role="list"
        aria-label={`${scoutWord} tick economics, newest first`}
      >
        {econTicks.length === 0 ? (
          <span
            className="pc-learning__flowchip"
            title={`${scoutWord} records a row per tick (stop reason, spend, ideas generated/routed) — no ticks recorded yet.`}
          >
            <Radar size={11} aria-hidden />
            last tick{" "}
            <strong>
              {tick && !Number.isNaN(tickMs) ? whenLabel(tickMs) : "none yet"}
            </strong>
          </span>
        ) : (
          econTicks.map((tk, i) => {
            const ms = tk.at ? Date.parse(tk.at) : NaN;
            const tone = tickTone(tk);
            const lensPairs = Object.entries(tk.lenses).sort(
              (a, b) => b[1] - a[1],
            );
            const spend =
              tk.spendUsd != null ? `$${tk.spendUsd.toFixed(2)}` : null;
            const tip =
              tk.status === "ran"
                ? `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · ${tk.stop ?? "ran"} — generated ${tk.generated}, pruned ${tk.deduped}, routed ${tk.routed}${spend ? `, spend ${spend}` : ""}${lensPairs.length > 0 ? ` · lenses: ${lensPairs.map(([l, n]) => `${l}×${n}`).join(" ")}` : tk.routed === 0 ? " · nothing routed" : ""}`
                : tk.status === "gated"
                  ? `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · self-gated (${tk.stop ?? "gate"}) — no cycle ran, no spend`
                  : `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · tick errored${tk.stop ? `: ${tk.stop}` : ""}`;
            return (
              <span
                key={tk.cycleId ?? tk.at ?? i}
                role="listitem"
                className={`pc-learning__tickrow pc-learning__tickrow--${tone}`}
                title={tip}
              >
                <em>{!Number.isNaN(ms) ? whenLabel(ms) : "—"}</em>
                <strong>
                  {tk.status === "ran"
                    ? `${tk.generated}→${tk.routed}`
                    : (tk.status ?? "?")}
                </strong>
                <span className="pc-learning__tickwhat">
                  {tk.status === "ran"
                    ? `generated ${tk.generated}, routed ${tk.routed} · ${tk.stop ?? "ran"}`
                    : tk.status === "gated"
                      ? `skipped — ${tk.stop ?? "gate"}`
                      : `error — ${tk.stop ?? "unknown"}`}
                </span>
                {spend ? (
                  <span className="pc-learning__tickspend">{spend}</span>
                ) : null}
              </span>
            );
          })
        )}
      </div>
      </LoopSection>
    </>
  );
}

/** The ideator's learned creative-lens steering — always visible under a
 *  standard header (owner ask 2026-07-19: "should always be visible, it never
 *  takes up much space"). Shown as shares of the total so they read as "how the
 *  generator will lean" rather than as raw weights. */
function LensWeights({
  snap,
  scoutWord,
}: {
  snap: ScoutSnapshot | undefined;
  scoutWord: string;
}) {
  const lensEntries = useMemo<Array<[string, number]>>(() => {
    const w = snap?.lensWeights;
    if (!w) return [];
    const entries = Object.entries(w).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0 || sum <= 0) return [];
    return entries
      .map(([k, v]) => [k, Math.round((v / sum) * 100)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [snap]);
  if (lensEntries.length === 0) return null;
  return (
    <>
      <div className="pc-learning__sectionhead pc-learning__sectionhead--desc">
        <h2>Lens weights</h2>
        <span
          className="pc-learning__sectionsub"
          title={`${scoutWord} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades (a ★5 counts as a win, a ★1 as a loss; a grade beats the system's own outcome guess).`}
        >
          the ideator's learned creative-lens steering — raised by wins and good
          grades
        </span>
      </div>
      <div className="pc-learning__flow" aria-label="Lens sampling weights">
        {lensEntries.map(([lens, share]) => (
          <span
            key={lens}
            className="pc-learning__lens"
            title={`${lens}: ${share}% of next cycle's lens sampling — raised by wins and good grades, lowered by losses and poor grades.`}
          >
            <em>{lens}</em>
            <span className="pc-learning__lensbar" aria-hidden>
              <span style={{ width: `${share}%` }} />
            </span>
            <strong>{share}%</strong>
          </span>
        ))}
      </div>
    </>
  );
}

// ─── Learnings view (a hive's editable shared memory — knowledge-packs P-008) ──

/** What the RetainedLedgerCard reports up to LearningsView (WI-39535): the
 *  view's status dot, perf settle, and memories chip all derive from the ONE
 *  feed instead of a second data path. */
type RetainLedgerCardState = {
  settled: boolean;
  error: boolean;
  rowCount: number;
  memoriesCount: number | null;
};

function LearningsView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const [, setLviewNav] = useQueryState("lview", parseAsString);
  const [, setTabNav] = useQueryState("tab", parseAsString);
  const [, setCreateViewNav] = useQueryState("view", parseAsString);

  // WI-39535: the shared-memory pool is a KIND in the Retained ledger below
  // (learning.retainFeed 'memory' leg) — the standalone learning.hive list this
  // view used to render is gone. The card reports its state up through ONE
  // callback so the view keeps its status dot, header signal, and the
  // banked-strip memories chip without a second data path.
  const [ledgerState, setLedgerState] = useState<RetainLedgerCardState>({
    settled: false,
    error: false,
    rowCount: 0,
    memoriesCount: null,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — same contract
  // as the improvements view above (EI-19375505819043214): gated on the PRIMARY
  // read (now the retainFeed page 1), settles on a fault as well as success.
  //
  // Gated on `active` as well: this pane is kept MOUNTED when the user switches
  // away (warmViews), so on a revisit the settled flag is already true and
  // never changes — an effect keyed on it alone would never re-run and the
  // switch would measure nothing (EI-19383745196363732).
  // Named variable on purpose: LearningTab.perf-begin-order.test.tsx pins the
  // settle point by scanning for `learningsSettled` in this source.
  const learningsSettled = ledgerState.settled;
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    learningsSettled,
    active,
  );
  // The rest of what the colony keeps (WI-5412, owner ask: lens weights,
  // rubric changes, insight docs, and recipes are retained learning too) +
  // the banked-this-week strip counts. One slim read; every leg degrades
  // independently server-side.
  const extras = useSyncQuery<RetainExtrasSnapshot | undefined>({
    queryName: "learning.retain",
    args: hive ? { hive } : {},
    enabled: hiveReady,
    staleTime: 60_000,
  });
  // Shape-guard the extras row: a server without the learning.retain resolver
  // (or a mis-routed read) must degrade to "sections absent", never crash the
  // whole Retain render.
  const extrasRaw = extras.data?.[0] as RetainExtrasSnapshot | undefined;
  const extrasSnap =
    extrasRaw && typeof extrasRaw === "object" && extrasRaw.banked
      ? extrasRaw
      : undefined;
  // Same share-of-total render as the Ideas view's lens strip — one visual
  // language for "how the ideator will lean".
  const retainLensEntries = useMemo<Array<[string, number]>>(() => {
    const w = extrasSnap?.lensWeights;
    if (!w) return [];
    const entries = Object.entries(w).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0 || sum <= 0) return [];
    return entries
      .map(([k, v]) => [k, Math.round((v / sum) * 100)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [extrasSnap]);
  useEffect(() => {
    onStatus?.(
      ledgerState.error ? "bad" : ledgerState.rowCount > 0 ? "good" : "neutral",
    );
  }, [onStatus, ledgerState.error, ledgerState.rowCount]);

  return (
    <>
      <section className="pc-learning__section">
        {/* WI-5412 item 5 kept its spirit through WI-39535: ONE concept, one
            heading. The heading now names the whole unified ledger — the
            shared-memory pool is a tab inside it, not a second surface. Search
            and refresh live on the ledger's own bar. */}
        <LearningPageHeader
          icon={Brain}
          title="Retained"
          signal={
            ledgerState.memoriesCount != null
              ? `${ledgerState.memoriesCount} memories`
              : undefined
          }
          tone={ledgerState.rowCount > 0 ? "good" : "neutral"}
        />

        {/* Fleet-lessons candidate review (learning-tab-visibility P-002): the
            retention loop's human gate — cross-hive recurring lessons staged by
            the recurrence-escalation sweep, awaiting owner adopt/dismiss into
            the fleet-lessons pack. Self-labeling; renders nothing when empty. */}
        <KnowledgePackCandidates />

        {/* "What stuck?" — the banked-this-week strip (WI-5412, owner: "add
            this"). Counts + link-outs only; never a queue duplicate. */}
        <div className="pc-learning__flow" aria-label="Banked this week">
          <span
            className="pc-learning__flowchip"
            title={`Rows in this ${t("pot", { lower: true })}'s shared memory pool — every agent recalls these while working. The Memories tab below lists them.`}
          >
            <Brain size={11} aria-hidden />
            <strong>{ledgerState.memoriesCount ?? "—"}</strong> learnings
            retained
          </span>
          <Tooltip label="Improvements filed in the trailing 7 days — open the Improvements backlog.">
            <button
              type="button"
              className="pc-learning__flowchip pc-learning__flowchip--link"
              onClick={() => void setLviewNav("improvements")}
            >
              <Sparkles size={11} aria-hidden />
              <strong>
                {extrasSnap?.banked.improvementsFiled7d ?? "—"}
              </strong>{" "}
              improvements filed
              <em>7d</em>
            </button>
          </Tooltip>
          <Tooltip label="Plans drafted in the trailing 7 days — open the Plans board.">
            <button
              type="button"
              className="pc-learning__flowchip pc-learning__flowchip--link"
              onClick={() => {
                void setCreateViewNav("plans");
                void setTabNav("plans");
              }}
            >
              <GitBranch size={11} aria-hidden />
              <strong>{extrasSnap?.banked.plansDrafted7d ?? "—"}</strong> plans
              drafted
              <em>7d</em>
            </button>
          </Tooltip>
        </div>

        {/* WI-39493 Variant D → WI-39535: EVERYTHING the colony keeps —
            shared-memory rows, routed plans and work items, rubric changes,
            insight runbooks, code recipes — as ONE recency-interleaved,
            keyset-paged "Retained" ledger, rendered through the same grid +
            column-filter components as the Work tab's work-item queue (owner
            ask 2026-08-16). Lens weights stays separate below: it is the
            distribution the loop steers by, not a feed. */}
        <RetainedLedgerCard
          hive={hive}
          enabled={hiveReady}
          onState={setLedgerState}
        />
        {retainLensEntries.length > 0 ? (
          <section
            className="pc-learning__lensstrip"
            aria-label="Lens sampling weights"
          >
            <header>
              <Sparkles size={11} aria-hidden />
              <span>Lens weights</span>
              <span
                className="pc-learning__muted"
                title={`${t("scout")} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades.`}
              >
                the sampling distribution the ideator draws lenses from
              </span>
            </header>
            <div className="pc-learning__flow">
              {retainLensEntries.map(([lens, share]) => (
                <span
                  key={lens}
                  className="pc-learning__lens"
                  title={`${lens}: ${share}% of next cycle's lens sampling.`}
                >
                  <em>{lens}</em>
                  <span className="pc-learning__lensbar" aria-hidden>
                    <span style={{ width: `${share}%` }} />
                  </span>
                  <strong>{share}%</strong>
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </section>
    </>
  );
}

// ─── Retained ledger (WI-39493, Variant D) ───────────────────────────────────

const RETAIN_TAB_LABELS: Record<RetainFeedTab, string> = {
  all: "All",
  memories: "Memories",
  plans: "Plans",
  wi: "Work items",
  rubrics: "Rubrics",
  runbooks: "Runbooks",
  recipes: "Recipes",
};

const RETAIN_KIND_ICON: Record<RetainFeedKind, typeof GitBranch> = {
  memory: Brain,
  plan: GitBranch,
  wi: CircleDot,
  rubric: Gauge,
  runbook: BookOpen,
  recipe: FlaskConical,
};

/** rsel URL param codec: `<kind>:<id>` (ids may themselves contain ':'). */
function parseRetainSel(
  sel: string | null,
): { kind: RetainFeedKind; id: string } | null {
  if (!sel) return null;
  const i = sel.indexOf(":");
  if (i <= 0) return null;
  const kind = sel.slice(0, i);
  const id = sel.slice(i + 1);
  if (!id || !(kind in RETAIN_KIND_ICON)) return null;
  return { kind: kind as RetainFeedKind, id };
}

/** Column-filter URL namespace — the hook owns ONE param, `rtf`. */
const RETAIN_FILTER_NS = "rt";

/** Grid-cell truncation, same recipe as the work queue's CELL_TRUNCATE. */
const RETAIN_CELL_TRUNCATE: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** A grid row: a ledger row, or a plan-born child spliced in under its
 *  expanded plan — the grid stays flat + virtualized; expansion is a splice. */
type RetainGridRow =
  | { rowType: "item"; row: RetainFeedRow }
  | { rowType: "child"; parentId: string; child: RetainPlanChild };

const retainTitleForFilter = (row: RetainGridRow): string =>
  row.rowType === "item" ? row.row.title : row.child.title;
const retainStatusForFilter = (row: RetainGridRow): string =>
  row.rowType === "item" ? (row.row.status ?? "") : row.child.status;
const retainLensForFilter = (row: RetainGridRow): string =>
  row.rowType === "item" ? (row.row.meta.lens ?? "") : "";

/** Stable parser contract for the `rtf` URL param. The rendered grid columns
 * reuse these accessors, so client chips and server args cannot drift on what
 * title/status/lens mean. */
const RETAIN_FILTER_COLUMNS: FilterableColumn<RetainGridRow>[] = [
  {
    key: "title",
    header: "Title",
    filter: { type: "text", accessor: retainTitleForFilter },
  },
  {
    key: "status",
    header: "Status",
    filter: { type: "enum", accessor: retainStatusForFilter },
  },
  {
    key: "lens",
    header: "Lens",
    filter: { type: "enum", accessor: retainLensForFilter },
  },
];

function retainGridRowId(r: RetainGridRow): string {
  return r.rowType === "item"
    ? `${r.row.kind}:${r.row.id}`
    : `child:${r.parentId}:${r.child.id}`;
}

/** 13561 → "13.6k" — tab badges carry the real corpus sizes; a null count is a
 *  degraded read and renders as absence, never 0. */
function fmtRetainCount(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 1000) return String(n);
  return `${Math.round(n / 100) / 10}k`;
}

function buildRetainColumns(opts: {
  rplanOpen: string | null;
  onTogglePlan: (slug: string) => void;
  onOpenPlan: (slug: string) => void;
}): ColumnDef<RetainGridRow>[] {
  const { rplanOpen, onTogglePlan, onOpenPlan } = opts;
  return [
    {
      key: "kind",
      header: "Kind",
      width: 1,
      toCopyText: (r) => (r.rowType === "item" ? r.row.kind : "wi"),
      // NO `filter` here, deliberately (WI-39675, D-003). Kind is ALREADY an
      // axis — the `rtab` segmented control, applied SERVER-side. A second
      // client-side kind filter over the loaded page could only ever be a
      // strictly worse duplicate of it, and it actively lied: the tab badges
      // read the corpus ("Memories 544 / Recipes 2.8k") while this enum offered
      // only what the current page happened to contain (recipe 13 / rubric 2 /
      // runbook 1 / wi 8), never listing `memory` or `plan` at all. Per D-003 a
      // number on a filter control is a promise about what clicking it yields;
      // this control could not keep that promise, so the control goes and the
      // tabs keep the axis.
      render: ({ row: r }) => {
        if (r.rowType === "child") return null;
        const Icon = RETAIN_KIND_ICON[r.row.kind];
        return (
          <span className="pc-learning__retainedkindcell">
            <Icon size={11} aria-hidden />
            {r.row.kind}
          </span>
        );
      },
    },
    {
      key: "title",
      header: "Title",
      width: 4,
      toCopyText: (r) => (r.rowType === "item" ? r.row.title : r.child.title),
      filter: {
        type: "text",
        accessor: retainTitleForFilter,
      },
      render: ({ row: r }) => {
        if (r.rowType === "child") {
          return (
            <span
              className="pc-learning__retainedchildcell"
              style={RETAIN_CELL_TRUNCATE}
              title={`${r.child.id} — born from plan ${r.parentId}`}
            >
              ↳ {r.child.title}
            </span>
          );
        }
        const { row } = r;
        if (row.kind === "plan") {
          const open = rplanOpen === row.id;
          return (
            <span className="pc-learning__retainedplancell">
              <button
                type="button"
                className="pc-learning__retainedchev"
                aria-expanded={open}
                aria-label={
                  open
                    ? "Collapse plan-born work items"
                    : "Expand plan-born work items"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePlan(row.id);
                }}
              >
                {open ? (
                  <ChevronDown size={11} aria-hidden />
                ) : (
                  <ChevronRight size={11} aria-hidden />
                )}
              </button>
              <Tooltip label={`${row.id} — open on the Plans board`}>
                <button
                  type="button"
                  className="pc-learning__retainlink"
                  style={RETAIN_CELL_TRUNCATE}
                  aria-label={`${row.id} — open on the Plans board`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPlan(row.id);
                  }}
                >
                  {row.title}
                </button>
              </Tooltip>
            </span>
          );
        }
        const origin = row.meta.ideaTitle
          ? ` · from idea: ${row.meta.ideaTitle}`
          : "";
        return (
          <span style={RETAIN_CELL_TRUNCATE} title={`${row.id}${origin}`}>
            {row.title}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: 1.1,
      toCopyText: (r) =>
        r.rowType === "item" ? (r.row.status ?? "") : r.child.status,
      filter: {
        type: "enum",
        accessor: retainStatusForFilter,
      },
      render: ({ row: r }) => {
        const status = r.rowType === "item" ? r.row.status : r.child.status;
        const shipped = r.rowType === "item" ? r.row.shipped : r.child.shipped;
        if (!status) return null;
        return (
          <span
            className={`pc-learning__chip${shipped ? " pc-learning__chip--stage-shipped" : ""}`}
            title="Server-classified outcome (EI-18792873324746237: never re-typed client-side)"
          >
            {status}
          </span>
        );
      },
    },
    {
      key: "lens",
      header: "Lens",
      width: 1.2,
      toCopyText: (r) => (r.rowType === "item" ? (r.row.meta.lens ?? "") : ""),
      filter: {
        type: "enum",
        accessor: retainLensForFilter,
      },
      render: ({ row: r }) =>
        r.rowType === "item" && r.row.meta.lens ? (
          <span
            style={RETAIN_CELL_TRUNCATE}
            title={`Origin idea lens${r.row.meta.ideaId ? ` — ${r.row.meta.ideaId}` : ""}`}
          >
            {r.row.meta.lens}
          </span>
        ) : null,
    },
    {
      key: "detail",
      header: "Detail",
      width: 1,
      toCopyText: () => "",
      render: ({ row: r }) => {
        if (r.rowType === "child") {
          return <em className="pc-learning__retainedroll">from this plan</em>;
        }
        const { row } = r;
        if (
          row.kind === "plan" &&
          row.meta.childTotal != null &&
          row.meta.childTotal > 0
        ) {
          return (
            <span
              className="pc-learning__retainedroll"
              title="Plan-born work items: done / total"
            >
              {row.meta.childDone ?? 0}/{row.meta.childTotal} done
            </span>
          );
        }
        if (row.kind === "recipe" && row.meta.runCount != null) {
          return (
            <span
              className="pc-learning__retainedroll"
              title="Total recorded runs"
            >
              ×{row.meta.runCount}
            </span>
          );
        }
        if (row.kind === "runbook" && row.meta.discovered) {
          return (
            <span
              className="pc-learning__retainedroll"
              title="Discovered date from the runbook's frontmatter"
            >
              {row.meta.discovered}
            </span>
          );
        }
        if (row.kind === "memory" && (row.meta.memKind || row.meta.packId)) {
          return (
            <span
              className="pc-learning__retainedroll"
              title={
                row.meta.packId
                  ? `Pack-seeded (${row.meta.packId})`
                  : "The memory's own kind tag"
              }
            >
              {row.meta.memKind ?? `pack:${row.meta.packId}`}
            </span>
          );
        }
        return null;
      },
    },
    {
      key: "when",
      header: "When",
      width: 0.8,
      toCopyText: (r) => (r.rowType === "item" ? r.row.ts : r.child.ts),
      render: ({ row: r }) => {
        const ms = Date.parse(r.rowType === "item" ? r.row.ts : r.child.ts);
        return Number.isNaN(ms) ? null : (
          <span className="pc-learning__age">{whenLabel(ms)}</span>
        );
      },
    },
  ];
}

/** WI-39534: one ledger row's expanded detail, ONE aside for every kind —
 *  prose body, recipe code, rubric criteria, provenance fields; memory rows
 *  keep the standalone pool's edit/remove (WI-39535). */
function RetainDetailAside({
  sel,
  detail,
  loading,
  error,
  onClose,
  onEdit,
  onRemove,
}: {
  sel: { kind: RetainFeedKind; id: string };
  detail: RetainDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const SelIcon = RETAIN_KIND_ICON[sel.kind];
  const tsMs = detail?.ts ? Date.parse(detail.ts) : Number.NaN;
  return (
    <aside
      className="pc-learning__retaindetail"
      aria-label="Retained item detail"
    >
      <header>
        <span
          className="pc-learning__retainedkindcell"
          title={`${sel.kind} ${sel.id}`}
        >
          <SelIcon size={11} aria-hidden />
          {sel.kind}
        </span>
        <button type="button" aria-label="Close detail" onClick={onClose}>
          <XCircle size={14} aria-hidden />
        </button>
      </header>
      {detail ? (
        <>
          <strong className="pc-learning__retaindetailtitle">
            {detail.title}
          </strong>
          <div className="pc-learning__retaindetailmeta">
            {detail.status ? (
              <span className="pc-learning__chip">{detail.status}</span>
            ) : null}
            {!Number.isNaN(tsMs) ? (
              <span className="pc-learning__age">{whenLabel(tsMs)}</span>
            ) : null}
            {detail.bodyTruncated ? (
              <span
                className="pc-learning__muted"
                title="Long body clamped server-side — open the item on its own board for the full text."
              >
                excerpt
              </span>
            ) : null}
          </div>
          {detail.body ? <p>{detail.body}</p> : null}
          {detail.code ? (
            <pre className="pc-learning__retaindetailcode">{detail.code}</pre>
          ) : null}
          {detail.listItems?.length ? (
            <ul className="pc-learning__retaindetaillist">
              {detail.listItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {detail.fields.length > 0 ? (
            <div className="pc-learning__retaindetailfields">
              {detail.fields.map((f) => (
                <div key={f.label}>
                  <span>{f.label}</span>
                  <span>{f.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {detail.editable ? (
            <footer>
              <button type="button" onClick={onEdit}>
                edit
              </button>
              <button type="button" onClick={onRemove}>
                remove
              </button>
            </footer>
          ) : null}
        </>
      ) : loading ? (
        <p>Loading detail…</p>
      ) : (
        // Name the cause when we have one — an unexplained dead end is the
        // documented failure mode of the old "unavailable" states.
        <p>Detail unavailable{error ? ` — ${error}` : ""}.</p>
      )}
    </aside>
  );
}

/**
 * The unified "Retained" ledger (WI-39493 Variant D): shared-memory rows
 * (WI-39535), plans, idea-routed work items, rubrics, insight runbooks, and
 * code recipes as ONE recency-interleaved
 * keyset-paged feed, rendered through the SAME components as the Work tab's
 * work-item queue — VirtualGrid + useColumnFilters/ColumnFilterBar (owner ask
 * 2026-08-16). The type tabs + Shipped∕In-flight narrowing stay SERVER-side
 * args: with 13.5k recipes a filtered page must be filtered at the source, and
 * shipped classification is server-stamped (EI-18792873324746237). Tab, filter,
 * quick-search, the expanded plan, and the selected row (WI-39534) are URL
 * state; the accumulated pages and
 * their keyset cursor are render state — a shared link reloads from page 1.
 */
function RetainedLedgerCard({
  hive,
  enabled,
  onState,
}: {
  hive: string;
  enabled: boolean;
  /** WI-39535: LearningsView derives its status dot, perf settle, and the
   *  memories chip from the feed through this — one data path, no sibling
   *  learning.hive read. */
  onState?: (state: RetainLedgerCardState) => void;
}) {
  const [rtab, setRtab] = useQueryState(
    "rtab",
    parseAsStringEnum<RetainFeedTab>([...RETAIN_FEED_TABS]).withDefault("all"),
  );
  // (`rship` — the Shipped ∕ In-flight param — is gone with its control, D-001.
  //  A stale `?rship=` in an old link is now simply ignored.)
  const [rplanOpen, setRplanOpen] = useQueryState("rplan", parseAsString);
  // WI-39534: the selected row (`<kind>:<id>`) — nuqs so agents and shared
  // links see the same selection (CLAUDE.md: user-meaningful state → URL).
  const [rsel, setRsel] = useQueryState("rsel", parseAsString);
  const [search, setSearch] = useQueryState(
    "rq",
    parseAsString.withDefault(""),
  );
  const retainFilterBinding = useColumnFilterState(
    RETAIN_FILTER_COLUMNS,
    RETAIN_FILTER_NS,
  );
  const retainServerFilters = useMemo<RetainFeedColumnFilters>(() => {
    const state = retainFilterBinding.state;
    const title = typeof state.title === "string" ? state.title.trim() : "";
    const statuses = Array.isArray(state.status)
      ? state.status.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : [];
    const lenses = Array.isArray(state.lens)
      ? state.lens.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : [];
    return {
      ...(title ? { title } : {}),
      ...(statuses.length > 0 ? { statuses } : {}),
      ...(lenses.length > 0 ? { lenses } : {}),
    };
  }, [retainFilterBinding.state]);
  // Deep-link params the Plans board already reads — the same trio the old
  // "Plans from ideas" rows set.
  const [, setTabNav] = useQueryState("tab", parseAsString);
  const [, setCreateViewNav] = useQueryState("view", parseAsString);
  const [, setPlanNav] = useQueryState("plan", parseAsString);

  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<RetainFeedRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string[]>([]);

  // The Shipped ∕ In-flight axis is GONE (D-001, owner 2026-08-28: "we can just
  // remove the in flight status"). Retain now means one thing — what LANDED —
  // so the server applies the shipped population rule to the two statusful
  // kinds and retains the other four unconditionally. There is no per-tab
  // outcome state left to compute, and therefore no control that can disagree
  // with the query about what a click will yield.
  //
  // This supersedes WI-39900's fix rather than reverting it. That fix answered
  // the owner's 2026-08-19 report ("for runbooks im seeing 706 but both filters
  // of shipped and in flight are showing 0 … this is an issue with all the tabs
  // except plans and work items") by DISABLING the control where it could not
  // apply. Removing the axis removes the condition that made it inapplicable,
  // so the disabled state, the explanatory note and the cross-tab leak of a
  // stale `?rship=` all go with it.
  const retainPredicateActive =
    Boolean((search ?? "").trim()) ||
    Boolean(retainServerFilters.title) ||
    Boolean(retainServerFilters.statuses?.length) ||
    Boolean(retainServerFilters.lenses?.length);
  const retainBaseArgs = useMemo<RetainFeedQueryArgs & Record<string, unknown>>(
    () => ({
      tab: rtab,
      ...((search ?? "").trim() ? { q: (search ?? "").trim() } : {}),
      ...(Object.keys(retainServerFilters).length > 0
        ? { filters: retainServerFilters }
        : {}),
      ...(hive ? { hive } : {}),
    }),
    [hive, retainServerFilters, rtab, search],
  );
  const retainPredicateKey = JSON.stringify(retainBaseArgs);

  // Every selected scope/predicate switch restarts the ledger from page 1.
  // Keeping a cursor from the prior predicate can skip the only matching row.
  useEffect(() => {
    setCursor(null);
    setNextCursor(null);
    setRows([]);
  }, [retainPredicateKey]);

  const feed = useSyncQuery<RetainFeedPage | undefined>({
    queryName: "learning.retainFeed",
    args: {
      ...retainBaseArgs,
      ...(cursor ? { cursor } : {}),
    },
    enabled,
    staleTime: 30_000,
  });
  const summaryQ = useSyncQuery<CompanionListSummary>({
    queryName: "learning.retainFeed.summary",
    args: retainBaseArgs,
    enabled,
    staleTime: 30_000,
  });
  // WI-39900: the tab badges are their own read, deliberately NOT part of the
  // page above. Inline they were the whole of the ledger's latency (Runbooks
  // first page 4.79s with them vs 0.024s without) and they coupled every tab's
  // rows to the memory backend's ~10.9s p50. Args carry NO tab/filter/cursor —
  // a badge is a CORPUS size — so this stays cached across tab and filter
  // switches instead of refetching on every click.
  const countsQ = useSyncQuery<RetainFeedCounts | undefined>({
    queryName: "learning.retainCounts",
    args: { ...(hive ? { hive } : {}) },
    enabled,
    staleTime: 120_000,
  });
  const page = feed.data?.[0];
  const loading = feed.loading;
  useEffect(() => {
    if (loading || !page || !Array.isArray(page.rows)) return;
    setRows((prev) => {
      // Page 1 replaces, a cursored page appends; the kind:id dedupe makes a
      // re-delivered page (SSE invalidate, effect re-run) idempotent.
      const base = cursor ? prev : [];
      const seen = new Set(base.map((x) => `${x.kind}:${x.id}`));
      const fresh = page.rows.filter((x) => !seen.has(`${x.kind}:${x.id}`));
      return cursor && fresh.length === 0 ? prev : [...base, ...fresh];
    });
    setNextCursor(page.nextCursor ?? null);
    setDegraded(Array.isArray(page.degraded) ? page.degraded : []);
  }, [page, loading, cursor, retainPredicateKey]);
  const counts = countsQ.data?.[0] ?? null;
  const retainSummaryCandidate = summaryQ.data?.[0];
  const retainSummary =
    retainSummaryCandidate &&
    Number.isSafeInteger(retainSummaryCandidate.total) &&
    Number.isSafeInteger(retainSummaryCandidate.matched) &&
    Array.isArray(retainSummaryCandidate.facets)
      ? retainSummaryCandidate
      : undefined;

  // Gated on the SAME readiness gate as every sibling read (the lens-guard
  // enforces one gate per view); an un-expanded ledger sends planSlug '' and
  // the resolver short-circuits to [] without touching the DB. `hive` rides
  // along for lens consistency — a plan's children are lens-invariant, but the
  // read must carry the pot like its siblings.
  const children = useSyncQuery<RetainPlanChild>({
    queryName: "learning.retainPlanChildren",
    args: { planSlug: rplanOpen ?? "", ...(hive ? { hive } : {}) },
    enabled,
  });
  const childRows = useMemo(
    () => (rplanOpen ? (children.data ?? []) : []),
    [rplanOpen, children.data],
  );

  // WI-39534: the selected row's detail — mounted under the view's ONE
  // readiness gate like every sibling read (lens-guard); an empty id
  // short-circuits server-side to [] without touching a store. `hive` rides
  // along for lens consistency exactly like retainPlanChildren above — one
  // row's detail is lens-invariant, but every read in the view carries the pot.
  const sel = parseRetainSel(rsel);
  const detailQ = useSyncQuery<RetainDetail | undefined>({
    queryName: "learning.retainDetail",
    args: {
      kind: sel?.kind ?? "plan",
      id: sel?.id ?? "",
      ...(hive ? { hive } : {}),
    },
    enabled,
    staleTime: 30_000,
  });
  const detail = sel ? (detailQ.data?.[0] ?? null) : null;

  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();
  // The standalone pool's inline edit/remove, preserved on memory rows
  // (WI-39535): same /api/user/memory routes, now invalidating the feed +
  // detail reads instead of learning.hive.
  const editMemory = useCallback(async () => {
    if (!sel || !detail || detail.kind !== "memory") return;
    const next = await askPrompt({
      title: "Edit learning",
      label: "Learning text",
      body: "Agents recall the exact text.",
      defaultValue: detail.body ?? "",
      submitLabel: "Save",
      validate: (value) => (value.trim() ? null : "Learning text is required."),
    });
    if (next == null || !next.trim() || next === detail.body) return;
    try {
      await fetch("/api/user/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sel.id, text: next.trim() }),
      });
    } finally {
      detailQ.invalidate();
      feed.invalidate();
      summaryQ.invalidate();
      countsQ.invalidate();
    }
  }, [sel, detail, askPrompt, detailQ, feed, summaryQ, countsQ]);
  const removeMemory = useCallback(async () => {
    if (!sel || !detail || detail.kind !== "memory") return;
    const ok = await askConfirm({
      title: "Remove this learning?",
      body: (detail.body ?? "").slice(0, 160),
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetch(`/api/user/memory?id=${encodeURIComponent(sel.id)}`, {
        method: "DELETE",
      });
    } finally {
      void setRsel(null);
      detailQ.invalidate();
      feed.invalidate();
      summaryQ.invalidate();
      countsQ.invalidate();
    }
  }, [sel, detail, askConfirm, setRsel, detailQ, feed, summaryQ, countsQ]);

  const onTogglePlan = useCallback(
    (slug: string) => void setRplanOpen((cur) => (cur === slug ? null : slug)),
    [setRplanOpen],
  );
  const onOpenPlan = useCallback(
    (slug: string) => {
      void setPlanNav(slug);
      void setCreateViewNav("plans");
      void setTabNav("plans");
    },
    [setPlanNav, setCreateViewNav, setTabNav],
  );

  const gridRows = useMemo<RetainGridRow[]>(() => {
    const out: RetainGridRow[] = [];
    for (const row of rows) {
      out.push({ rowType: "item", row });
      if (row.kind === "plan" && rplanOpen === row.id) {
        for (const child of childRows) {
          out.push({ rowType: "child", parentId: row.id, child });
        }
      }
    }
    return out;
  }, [rows, rplanOpen, childRows]);

  const columns = useMemo(
    () => buildRetainColumns({ rplanOpen, onTogglePlan, onOpenPlan }),
    [rplanOpen, onTogglePlan, onOpenPlan],
  );
  // The row and companion-summary reads use the SAME rq/rtf predicate. While
  // either half refetches, suppress the number instead of mixing adjacent
  // snapshots; a page length is never a fallback for the exact summary.
  const retainCountEvidence = useMemo<CountEvidence>(() => {
    if (feed.error || summaryQ.error)
      return { kind: "unknown", reason: "failed" };
    if (!retainSummary) {
      return {
        kind: "unknown",
        reason: loading && page === undefined ? "loading" : "updating",
      };
    }
    if (feed.fetching || summaryQ.fetching) {
      return { kind: "unknown", reason: "updating" };
    }
    return {
      kind: "corpus",
      count: retainSummary.matched,
      total: retainSummary.total,
      population: "the complete selected Retain corpus",
    };
  }, [
    feed.error,
    feed.fetching,
    loading,
    page,
    retainSummary,
    summaryQ.error,
    summaryQ.fetching,
  ]);
  const retainServerEnumOptions = useMemo(() => {
    if (!retainSummary) return undefined;
    return new Map(
      retainSummary.facets.map((facet) => [
        facet.key,
        facet.values.map((value) => ({
          value: value.value,
          count: value.count,
        })),
      ]),
    );
  }, [retainSummary]);
  const cf = useColumnFiltersFromState(
    columns,
    gridRows,
    {
      ns: RETAIN_FILTER_NS,
      countEvidence: retainCountEvidence,
      serverEnumOptions: retainServerEnumOptions,
    },
    retainFilterBinding,
  );
  const filtered = useMemo(() => {
    // Reapply q only to preserve the expanded-plan CHILD behavior. Item rows
    // already passed this exact server predicate before LIMIT, so this is
    // idempotent for the paged corpus and cannot erase a server-only field hit.
    const q = (search ?? "").trim().toLowerCase();
    if (!q) return cf.rows;
    return cf.rows.filter((r) => {
      const hay =
        r.rowType === "item"
          ? `${r.row.id} ${r.row.title} ${r.row.status ?? ""}`
          : `${r.child.id} ${r.child.title} ${r.child.status}`;
      return hay.toLowerCase().includes(q);
    });
  }, [cf.rows, search]);
  const [colWidths, setColWidths] = usePersistedColumnWidths(
    "pc-colw:learning:retained",
  );

  const countLabel = filterCountLabel(retainCountEvidence, "retained item");

  // Report the feed's state up to LearningsView (status dot, perf settle,
  // memories chip) — see RetainLedgerCardState.
  const settled = !loading && (page !== undefined || Boolean(feed.error));
  const memoriesCount = counts?.memories ?? null;
  useEffect(() => {
    onState?.({
      settled,
      error: Boolean(feed.error),
      rowCount: rows.length,
      memoriesCount,
    });
  }, [onState, settled, feed.error, rows.length, memoriesCount]);

  return (
    <section className="pc-learning__retained" aria-label="Retained ledger">
      <div className="pc-learning__retainedhead">
        <div
          className="pc-learning__seg"
          role="tablist"
          aria-label="Retained type"
        >
          {RETAIN_FEED_TABS.map((tab) => {
            const badge =
              tab === "all" ? null : fmtRetainCount(counts?.[tab] ?? null);
            const btn = (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={rtab === tab}
                className={`pc-learning__segtab${rtab === tab ? " is-on" : ""}`}
                onClick={() => void setRtab(tab)}
              >
                {RETAIN_TAB_LABELS[tab]}
                {badge ? <em>{badge}</em> : null}
              </button>
            );
            // WI-5416: "Memories" is the one tab whose provenance isn't
            // self-evident from its label — rows come from two different
            // origins (agents' own memory:remember calls during work, and
            // knowledge-pack seeds), same explainer tier as the segment above
            // ("Where these came from").
            return tab === "memories" ? (
              <Tooltip
                key={tab}
                label="Rows agents write with memory:remember while they work (organic, provenance-tagged), plus knowledge-pack seeds."
              >
                {btn}
              </Tooltip>
            ) : (
              btn
            );
          })}
        </div>
        {/* The Shipped ∕ In-flight segment stood here (D-001). It is replaced
            by a STATEMENT rather than another control: the boundary is now a
            property of the tab, not a choice the reader has to make and then
            reason about per kind. Said once, where the population is decided. */}
        <p className="pc-learning__retainedfilternote">
          Everything here landed — in-flight work lives in Improve.
        </p>
      </div>
      <div className="pc-advpanel__bar">
        <input
          type="text"
          className="pc-advpanel__input"
          value={search}
          onChange={(e) => void setSearch(e.target.value)}
          placeholder="Filter retained…"
          aria-label="Filter retained items"
        />
        <ColumnFilterBar
          controller={cf.controller}
          activeChips={cf.activeChips}
          hasActive={cf.hasActive}
          clearAll={cf.clearAll}
        />
        <span
          className="pc-advpanel__count"
          aria-live="polite"
          aria-label={countLabel.ariaLabel}
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--fg-mute)",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {countLabel.summary}
        </span>
        <Tooltip label="Refresh the retained ledger">
          <button
            type="button"
            className="pc-advpanel__iconbtn"
            onClick={() => {
              feed.invalidate();
              summaryQ.invalidate();
              countsQ.invalidate();
            }}
            disabled={loading}
            aria-label="Refresh retained ledger"
          >
            <RefreshCw
              size={13}
              aria-hidden
              className={loading ? "pc-advpanel__spin" : undefined}
            />
          </button>
        </Tooltip>
      </div>
      {feed.error ? (
        <div className="pc-advpanel__empty pc-advpanel__empty--err">
          Could not load the retained ledger: {String(feed.error)}
        </div>
      ) : rows.length === 0 && loading ? (
        // WI-39675 (owner 2026-08-17: "in the retain tab, it just says 'loading
        // retained items...' forever"). It was not forever, but the difference
        // was invisible: `loading` is TanStack's isLoading (isPending &&
        // isFetching), which stays TRUE across the whole retry sequence while
        // `error` stays NULL until the last retry is exhausted. With 3 default
        // retries, 1s/2s/4s backoff and a 10s server-side timeout, a feed whose
        // every attempt times out shows this branch for ~47s and the error
        // branch above never gets a turn. Measured: this read is fast when warm
        // (~0.5s) but its COLD path intermittently crosses that 10s timeout —
        // on staging as well as on the desktop sidecar — so a first paint after
        // a restart is exactly when a user meets it.
        //
        // So: never claim a bare "loading" once an attempt has actually failed.
        // failureCount/failureReason are the only signals that separate the two
        // (see SyncQueryResult), and a manual retry beats waiting out a backoff.
        <div className="pc-advpanel__empty">
          {feed.failureCount > 0 ? (
            <>
              Still loading retained items — {feed.failureCount} attempt
              {feed.failureCount === 1 ? "" : "s"} failed, retrying…
              <button
                type="button"
                className="pc-learning__retainretry"
                onClick={() => feed.invalidate()}
              >
                Retry now
              </button>
              {feed.failureReason ? (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: "var(--fg-mute)",
                  }}
                >
                  Last attempt:{" "}
                  {String(feed.failureReason.message ?? feed.failureReason)}
                </div>
              ) : null}
            </>
          ) : (
            "Loading retained items…"
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="pc-advpanel__empty">
          {rows.length === 0 && !retainPredicateActive
            ? "Nothing retained yet under this view."
            : "No retained items match the filter."}
        </div>
      ) : (
        <div className={`pc-learning__retainlayout${sel ? " has-detail" : ""}`}>
          <div className="pc-learning__retainindex">
            <VirtualGrid<RetainGridRow>
              columns={columns}
              rows={filtered}
              resizableColumns
              columnWidths={colWidths}
              onColumnWidthsChange={setColWidths}
              getRowId={retainGridRowId}
              onRowClick={(r) => {
                // WI-39534: every row opens its detail; a plan's CHILD row is
                // itself a work item, so it selects as one. The plan chevron
                // (expand) and title (Plans board) keep their own buttons.
                const next =
                  r.rowType === "item"
                    ? `${r.row.kind}:${r.row.id}`
                    : `wi:${r.child.id}`;
                void setRsel((cur) => (cur === next ? null : next));
              }}
              getRowBg={(r) => {
                const key =
                  r.rowType === "item"
                    ? `${r.row.kind}:${r.row.id}`
                    : `wi:${r.child.id}`;
                return key === rsel
                  ? "color-mix(in oklab, var(--accent), transparent 80%)"
                  : undefined;
              }}
              rowMinHeight={30}
              headerHeight={30}
              scrollStyle={{ maxHeight: 340 }}
              onEndReached={
                nextCursor ? () => setCursor(nextCursor) : undefined
              }
            />
          </div>
          {sel ? (
            <RetainDetailAside
              sel={sel}
              detail={detail}
              loading={detailQ.loading}
              error={detailQ.error ? String(detailQ.error) : null}
              onClose={() => void setRsel(null)}
              onEdit={editMemory}
              onRemove={removeMemory}
            />
          ) : null}
        </div>
      )}
      {confirmEl}
      {promptEl}
      {degraded.length > 0 ? (
        <p
          className="pc-learning__retaineddegraded"
          title="These legs failed to read; the rest of the ledger is live."
        >
          degraded: {degraded.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone?: "auto" | "human" | "good";
  hint?: string;
}) {
  return (
    <div
      className={`pc-learning__stat${tone ? ` pc-learning__stat--${tone}` : ""}`}
      title={hint}
    >
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function LearningStyles() {
  return (
    <style>{`
      .pc-learning { container: learning / inline-size; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 8px 14px 14px; gap: 7px; overflow: hidden; }

      .pc-learning__stage-list {
        /* Auto-flow columns: every stage stays on ONE row regardless of how
           many STAGES holds (repeat(4) wrapped Retain when Analyze landed). */
        display: grid; grid-auto-flow: column; grid-auto-columns: minmax(90px, 1fr);
        align-items: start; width: 100%; max-width: 720px; margin: 0 auto; padding: 0 22px; box-sizing: border-box;
      }
      /* WI-39501 put the loop control at this row's right edge, absolutely
         positioned. It is a real FLEX MEMBER now (owner, 2026-09-07: "fit it
         all on one line"): the stepper, the verdict and the pause controls
         share one line and negotiate width, which is what let the pot rail's
         whole extra row go away. The stepper keeps its 720px ceiling but may
         shrink; the control cluster takes what is left and right-aligns. */
      .pc-learning__stagerow { display: flex; align-items: center; gap: 14px; }
      .pc-learning__stages { flex: 0 1 720px; min-width: 0; }
      /* Paused learning loop = the header's EXISTING dormant vocabulary applied
         loop-wide, keyed off the control's state class via :has() so the
         LearningTab hotspot itself needs no extra sync hook. */
      .pc-learning:has(.pc-lloop--paused) .pc-learning__stage-icon { border-style: dashed; box-shadow: none; opacity: .72; }
      .pc-learning:has(.pc-lloop--paused) .pc-learning__stage-label { opacity: .72; }
      .pc-learning__stage {
        --stage-accent: var(--accent);
        position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px;
        min-width: 0; padding: 0 8px; border: 0; background: transparent;
        color: var(--fg-mute); cursor: pointer; font: inherit;
      }
      .pc-learning__stage:nth-child(2) { --stage-accent: var(--warn); }
      .pc-learning__stage:nth-child(3) { --stage-accent: var(--good); }
      .pc-learning__stage:nth-child(4) { --stage-accent: var(--accent-strong); }
      .pc-learning__stage-icon {
        position: relative; z-index: 1; display: grid; place-items: center; width: 30px; height: 30px;
        border: 1px solid var(--border-strong); border-radius: 50%; background: var(--bg-1); color: var(--fg-mute);
        transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast), box-shadow var(--dur-fast);
      }
      .pc-learning__stage-line {
        position: absolute; z-index: 0; top: 15px; left: calc(50% + 15px); width: calc(100% - 30px); height: 1px;
        background: var(--border-strong); pointer-events: none;
      }
      .pc-learning__stage-label { font-size: 11px; font-weight: 650; }
      .pc-learning__statusmark { position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border: 2px solid var(--bg-1); border-radius: 50%; background: var(--fg-mute); }
      .pc-learning__statusdesc { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .pc-learning__stage-icon.has-active, .pc-learning__view-icon.has-active { --learning-status: var(--accent); }
      .pc-learning__stage-icon.has-attention, .pc-learning__view-icon.has-attention { --learning-status: #fbbf24; }
      .pc-learning__stage-icon.has-failure, .pc-learning__view-icon.has-failure { --learning-status: #fb7185; }
      .pc-learning__stage-icon.has-dormant, .pc-learning__view-icon.has-dormant { --learning-status: var(--fg-mute); }
      .pc-learning__stage-icon[class*="has-"], .pc-learning__view-icon[class*="has-"] { border-color: color-mix(in srgb, var(--learning-status) 64%, var(--border)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--learning-status) 8%, transparent); }
      .pc-learning__stage-icon.has-dormant, .pc-learning__view-icon.has-dormant { border-style: dashed; box-shadow: none; opacity: .78; }
      .pc-learning__stage-icon .pc-learning__statusmark, .pc-learning__view-icon .pc-learning__statusmark { background: var(--learning-status); }
      .pc-learning__stage:hover .pc-learning__stage-icon { color: var(--fg); border-color: var(--stage-accent); background: var(--bg-2); }
      .pc-learning__stage[aria-selected="true"] { color: var(--fg); }
      .pc-learning__stage[aria-selected="true"] .pc-learning__stage-icon {
        color: var(--stage-accent); border-color: var(--stage-accent);
        background: color-mix(in oklab, var(--stage-accent), transparent 88%);
      }
      .pc-learning__controls { min-height: 30px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pc-learning__view-tabs { min-width: 0; max-width: 100%; }
      /* Real TAB shapes (owner ask 2026-07-19: "make the tabs inside all the
         steps look more like tabs"): each view tab is a top-rounded box that
         sits ON the strip's baseline rail; the selected one adopts the panel
         background and punches a hole through the rail so it reads as
         physically connected to the content below, instead of the previous
         underline-only treatment. */
      .pc-learning__view-list { display: inline-flex; align-items: flex-end; gap: 3px; max-width: 100%; padding: 0 3px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; border-bottom: 1px solid var(--border); background: transparent; }
      .pc-learning__view-tab {
        display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 5px 11px 6px;
        border: 1px solid transparent; border-bottom: 1px solid transparent;
        border-radius: 8px 8px 0 0; margin-bottom: -1px;
        background: color-mix(in srgb, var(--fg-mute) 7%, transparent);
        color: var(--fg-mute); cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 620;
        transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
      }
      .pc-learning__view-icon { position: relative; display: grid; place-items: center; width: 18px; height: 18px; flex: none; border: 1px solid transparent; border-radius: 50%; }
      .pc-learning__view-icon .pc-learning__statusmark { right: -3px; bottom: -3px; width: 6px; height: 6px; border-width: 1.5px; }
      .pc-learning__view-tab:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 10%, transparent); }
      .pc-learning__view-tab[aria-selected="true"] {
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, var(--bg, transparent));
        border-color: var(--border);
        /* Erase the rail beneath the active tab — the "connected" tab look. */
        border-bottom-color: color-mix(in srgb, var(--accent) 8%, var(--bg, transparent));
        box-shadow: inset 0 2px 0 var(--accent);
      }
      /* Overflow affordance (P-007): fade the clipped edge of the view strip so
         hidden tabs read as "more this way" (background-independent CSS mask,
         -webkit- prefixed for the WebKitGTK desktop) — same pattern as
         AdvShell's top-level tab strip. */
      .pc-learning__view-tabs[data-of-left][data-of-right] .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
      }
      .pc-learning__view-tabs[data-of-left]:not([data-of-right]) .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px);
        mask-image: linear-gradient(90deg, transparent 0, #000 22px);
      }
      .pc-learning__view-tabs:not([data-of-left])[data-of-right] .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
      }

      .pc-learning__hivepick {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; font-size: 11.5px; font-weight: 600; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg-2); color: var(--fg-mute);
      }
      /* Picker moved to the row START (owner ask 2026-07-26); the health chip
         takes over the right edge so the row keeps a stable anchor there. */
      .pc-learning__controls > .pc-lihealth { margin-left: auto; }
      .pc-learning__hivepicklabel { text-transform: uppercase; font-size: 10px; letter-spacing: 0; }
      .pc-learning__body { flex: 1; min-height: 240px; overflow: hidden; }
      .pc-learning__viewpane { height: 100%; min-height: 0; overflow: auto; }
      .pc-learning__viewpane[data-view="observations"] { overflow: hidden; }
      .pc-learning__rubricsplit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; height: 100%; min-height: 0; overflow: hidden; }
      .pc-learning__rubricsplit:has(.pc-learning__rubricdetail) { grid-template-columns: minmax(310px, .78fr) minmax(0, 1.22fr); }
      .pc-learning__rubricdetail { min-width: 0; overflow: auto; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-1); }

      .pc-learning__viewpane:not([data-view="learnings"]):not([data-view="throughput"]) .pc-learning-visual__head h2 {
        position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
      }

      @container learning (max-width: 720px) {
        .pc-learning__stage-list { padding-inline: 4px; }
        .pc-learning__stage { padding-inline: 2px; }
        .pc-learning__stage-line { left: calc(50% + 15px); width: calc(100% - 30px); }
        .pc-learning__rubricsplit:has(.pc-learning__rubricdetail) { grid-template-columns: 1fr; overflow: auto; }
        .pc-learning__rubricdetail { min-height: 420px; }
      }
      /* P-007: the former ≤1100px Verify-only icon-pill collapse (labels
         clip-path-hidden except the selected tab) is deliberately GONE — it was
         mystery-meat. Labels stay visible at every width; a crowded strip
         scrolls, with the edge-fade affordance above signalling clipped tabs. */
      @container learning (max-width: 1100px) {
        .pc-learning__view-tab { padding-inline: 7px; }
      }
      @container learning (max-width: 560px) {
        .pc-learning { padding-inline: 9px; }
        .pc-learning__stage-list { grid-auto-columns: minmax(44px, 1fr); }
        .pc-learning__stage-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .pc-learning__controls { flex-wrap: nowrap; }
        .pc-learning__view-tabs { flex: 1 1 auto; overflow: hidden; }
        .pc-learning__hivepicklabel { display: none; }
      }

      /* Release-readiness strip (learning-tab-alignment P-001) — the Verify stage's GO/NO-GO gate. */
      .pc-learning__readiness {
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
        padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-1);
      }
      .pc-learning__readiness-verdict {
        display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px;
        border: 1px solid transparent; border-radius: 999px;
        font-size: 10.5px; font-weight: 740; text-transform: uppercase; letter-spacing: 0;
      }
      .pc-learning__readiness-verdict em { font-style: normal; font-weight: 620; font-variant-numeric: tabular-nums; opacity: .85; }
      .pc-learning__readiness-verdict--pass { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); background: color-mix(in srgb, var(--good) 10%, transparent); }
      .pc-learning__readiness-verdict--fail { color: #fb7185; border-color: color-mix(in srgb, #fb7185 45%, transparent); background: color-mix(in srgb, #fb7185 10%, transparent); }
      .pc-learning__readiness-verdict--incomplete { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 45%, transparent); background: color-mix(in srgb, #fbbf24 10%, transparent); }
      .pc-learning__readiness-verdict--unknown { color: var(--fg-mute); border-color: var(--border); background: var(--bg-2); }
      .pc-learning__readiness-bar {
        display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
        border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
        font-size: 10.5px; font-weight: 620; color: var(--fg-mute); cursor: default;
      }
      .pc-learning__readiness-bar--pass svg { color: var(--good); }
      .pc-learning__readiness-bar--fail { color: var(--fg-dim); border-color: color-mix(in srgb, #fb7185 40%, var(--border)); }
      .pc-learning__readiness-bar--fail svg { color: #fb7185; }
      .pc-learning__readiness-bar--unknown svg { color: var(--fg-mute); }
      .pc-learning__readiness-rubric {
        margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
        font-size: 10.5px; font-weight: 620; color: var(--fg-mute); cursor: default;
      }
      .pc-learning__readiness-rubric--active svg { color: var(--good); }
      .pc-learning__readiness-rubric--proposed svg { color: #fbbf24; }
      @container learning (max-width: 720px) {
        .pc-learning__readiness-rubric { margin-left: 0; }
      }

      /* Flow strip (P-041) — compact in/out chips above the stock scoreboard. */
      .pc-learning__flow { display: flex; flex-wrap: wrap; gap: 6px; }
      .pc-learning__flowchip {
        display: inline-flex; align-items: center; gap: 5px;
        /* Squared chip language (owner design pass 2026-07-19) — pills are
           reserved for tiny STATUS badges, refs/metrics ride rounded rects. */
        padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__flowchip strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__flowchip em { font-style: normal; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flowchip--link { cursor: pointer; }
      .pc-learning__flowchip--link:hover { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent); color: var(--fg-dim, #b9d4e8); }
      .pc-learning__gradednote { margin: 2px 2px 6px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__retainextras { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__retainextras li {
        display: flex; align-items: center; gap: 7px; padding: 4px 9px;
        border-radius: 6px; font-size: 11.5px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
      }
      .pc-learning__retainextras li strong { font-weight: 620; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .pc-learning__retainextras li .pc-learning__age { margin-left: auto; flex-shrink: 0; }
      .pc-learning__retainlink {
        all: unset; cursor: pointer; font-weight: 620; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; flex: 1; color: inherit;
      }
      .pc-learning__retainlink:hover, .pc-learning__retainlink:focus-visible { text-decoration: underline; color: var(--fg, #e7eef5); }
      .pc-learning__retainidea {
        display: inline-flex; align-items: center; gap: 3px; font-style: normal;
        color: var(--fg-faint, #7d93a6); font-size: 10.5px; max-width: 34%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1;
      }
      .pc-learning__flownet { display: inline-flex; align-items: center; gap: 1px; font-weight: 740; font-variant-numeric: tabular-nums; }
      .pc-learning__flownet--good { color: var(--good); }
      .pc-learning__flownet--warn { color: var(--warn); }
      .pc-learning__flownet--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flowchip--wd-good { border-color: rgba(52, 211, 153, 0.4); }
      .pc-learning__flowchip--wd-warn { border-color: rgba(252, 211, 77, 0.45); }
      .pc-learning__flowchip--wd-bad { border-color: rgba(248, 113, 113, 0.5); }

      /* WI-39493 Variant D: the unified Retained ledger card + lens strip. */
      .pc-learning__retained {
        display: flex; flex-direction: column; min-height: 0;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        border-radius: 10px; background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-learning__retainedhead {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 7px 10px; border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.12));
      }
      /* P-003: the segmented strip is SHARED chrome, not Retain's own — Improve
         renders its lane + scope axes through these same classes, which is why
         the names are neutral. Restyle here and both tables move together.
         (The --filters modifier and the .is-inert outcome-filter states went
         with the Shipped / In-flight segment itself, D-001.) */
      .pc-learning__seg {
        display: inline-flex; align-items: center; gap: 2px; padding: 2px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        border-radius: 8px; background: rgba(255, 255, 255, 0.02);
      }
      .pc-learning__segtab {
        display: inline-flex; align-items: center; gap: 5px; border: 0;
        background: transparent; color: var(--fg-mute, #7f9bb4);
        font-size: 11px; font-weight: 620; padding: 3px 9px; border-radius: 6px; cursor: pointer;
      }
      .pc-learning__segtab:hover { color: var(--fg-dim, #b9d4e8); }
      .pc-learning__segtab.is-on { background: rgba(125, 211, 252, 0.14); color: var(--fg, #e7eef5); }
      .pc-learning__segtab em { font-style: normal; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      /* Improve's strip carries two axes (lane, then provenance) in one row;
         the rule says "these are different questions" without a second border. */
      .pc-learning__segdiv { width: 1px; height: 16px; background: var(--border, rgba(125, 211, 252, 0.15)); margin: 0 6px; flex: none; }
      .pc-learning__segrow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .pc-learning__segnote { margin-left: auto; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      /* The bordered frame both grids sit in. */
      .pc-learning__gridframe {
        border: 1px solid var(--border, rgba(125, 211, 252, 0.15));
        border-radius: 8px; overflow: hidden; min-width: 0;
      }

      /* P-004: "How the loop is doing" — one card per QUESTION, each leading
         with its answer in words. The instruments inside are unchanged; only
         the grouping and these labels are new. */
      .pc-learning__loopsec {
        display: flex; flex-direction: column; gap: 7px; min-width: 0;
        padding: 10px 12px; margin-top: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        border-radius: 8px; background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-learning__loopsechead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      /* Tracking would be the obvious way to set a small uppercase label apart;
         it is not an approved primitive here (lint:design-primitives), so the
         separation comes from case + size + weight, as chat-controls.css does. */
      .pc-learning__loopseclabel {
        font-size: 10px; font-weight: 700; letter-spacing: 0;
        text-transform: uppercase; color: var(--accent, #7dd3fc); flex: none;
      }
      .pc-learning__loopsecanswer { font-size: 12px; color: var(--fg-dim, #b9d4e8); min-width: 0; }
      .pc-learning__loopgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
      @container learning (max-width: 820px) { .pc-learning__loopgrid { grid-template-columns: minmax(0, 1fr); } }
      /* The tick rows' column headers — the four positional fields were
         unlabelled until P-004, readable only by hovering a row. Tracks the
         pc-learning__tickrow grid below so the headings sit over their data. */
      .pc-learning__tickhead {
        display: grid; grid-template-columns: 60px 90px 1fr 60px; gap: 9px; padding: 0 9px;
        font-size: 9.5px; font-weight: 700; letter-spacing: 0;
        text-transform: uppercase; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__loopwarnaside {
        display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px;
        color: var(--warn, #fbbf24); max-width: 46ch; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-learning__loopwarnaside.is-bad { color: var(--bad, #f87171); }
      .pc-learning__retainedfilternote { margin: 4px 0 0; font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__retainedkindcell { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__retainedkindcell svg { flex-shrink: 0; }
      .pc-learning__retainedplancell { display: inline-flex; align-items: center; gap: 5px; min-width: 0; width: 100%; }
      .pc-learning__retainedplancell .pc-learning__retainlink { min-width: 0; flex: 1; text-align: left; }
      /* WI-39675: the retry affordance on a stalled/retrying Retain load. */
      .pc-learning__retainretry {
        margin-inline-start: 8px; border: 1px solid var(--border, #29465e); border-radius: 6px;
        background: transparent; color: var(--fg-dim, #b9d4e8); cursor: pointer;
        padding: 1px 7px; font-size: 11px; font-weight: 600;
      }
      .pc-learning__retainretry:hover, .pc-learning__retainretry:focus-visible { color: var(--fg, #e7eef5); border-color: var(--accent, #4aa3df); }
      .pc-learning__retainedchev { border: 0; background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer; padding: 0; display: inline-flex; flex-shrink: 0; }
      .pc-learning__retainedchev:hover { color: var(--fg, #e7eef5); }
      .pc-learning__retainedchildcell { padding-left: 22px; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__retainedroll { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; white-space: nowrap; font-style: normal; }
      .pc-learning__retaineddegraded { margin: 0; padding: 4px 10px 7px; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__lensstrip {
        display: flex; flex-direction: column; gap: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        border-radius: 10px; background: var(--bg-2, rgba(255, 255, 255, 0.04));
        padding: 9px 12px;
      }
      .pc-learning__lensstrip header { display: flex; align-items: baseline; gap: 7px; font-size: 11.5px; font-weight: 700; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__lensstrip header svg { align-self: center; flex-shrink: 0; }
      .pc-learning__flowdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .pc-learning__flowdot--good { background: var(--good); box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
      .pc-learning__flowdot--warn { background: var(--warn); box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
      .pc-learning__flowdot--bad { background: var(--bad); box-shadow: 0 0 5px rgba(248, 113, 113, 0.6); }

      /* Cadence card (learning-tab-visibility P-001) — live volume-gate state:
         score bar vs threshold + per-lane pending-signal chips. */
      .pc-learning__cadence {
        display: flex; flex-direction: column; gap: 5px; padding: 7px 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 8px;
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-learning__cadence-head {
        display: inline-flex; align-items: center; gap: 8px; font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__cadence-head strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-learning__cadence-head em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__cadence-bar {
        flex: 0 1 140px; min-width: 60px; height: 5px; border-radius: 999px;
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4) 18%, transparent); overflow: hidden;
      }
      .pc-learning__cadence-fill { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width 300ms ease; }
      .pc-learning__cadence-fill--armed { background: var(--good, #34d399); }
      .pc-learning__cadence-lanes { display: flex; flex-wrap: wrap; gap: 4px; }

      /* Drafts-in-iteration list (learning-tab-visibility P-005). */
      .pc-learning__draftlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .pc-learning__draftrow {
        display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px;
        color: var(--fg-dim, #b9d4e8); padding: 2px 2px;
      }
      .pc-learning__draftrow strong { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
      .pc-learning__draftrow em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__draftwhen { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }

      /* Tick-economics strip (learning-tab-alignment P-002) — one cell per scout
         tick: when · gen→routed funnel · stop reason · spend · lens chips. */
      .pc-learning__tickstrip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
      .pc-learning__tick {
        display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
        padding: 3px 7px; font-size: 10.5px; font-weight: 600; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
        cursor: default; white-space: nowrap;
      }
      .pc-learning__tick em { font-style: normal; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__tick strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__tickstop { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
      .pc-learning__tickspend { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__ticklens {
        font-style: normal; font-size: 9px; font-weight: 700; padding: 1px 5px;
        border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
        color: var(--accent-strong, var(--accent)); background: color-mix(in srgb, var(--accent) 10%, transparent);
      }
      .pc-learning__tick--good { border-color: rgba(52, 211, 153, 0.4); }
      .pc-learning__tick--good strong { color: #86efac; }
      .pc-learning__tick--warn { border-color: color-mix(in srgb, #fbbf24 45%, transparent); background: color-mix(in srgb, #fbbf24 7%, transparent); }
      .pc-learning__tick--warn strong { color: #fbbf24; }
      .pc-learning__tick--bad { border-color: color-mix(in srgb, #fb7185 50%, transparent); background: color-mix(in srgb, #fb7185 7%, transparent); }
      .pc-learning__tick--bad strong { color: #fb7185; }
      .pc-learning__tick--idle { opacity: 0.75; }

      /* P-004 pipeline trace: the idea's loop as one row of stages. Spans the
         scout row's grid; stages wrap on narrow panes (the arrows ride along). */
      /* The pipeline trace as a clean label/value grid (owner ask 2026-07-19:
         "the whole design needs a lot of work") — one aligned row per stage,
         no arrow soup, labels in a fixed column so five stages scan as a card
         ledger in the stacked-card width. */
      .pc-learning__trace {
        grid-column: 1 / -1;
        display: grid; grid-template-columns: max-content minmax(0, 1fr);
        gap: 7px 12px; align-items: start;
        margin-top: 9px; padding: 10px 12px; border-radius: 9px;
        background: color-mix(in srgb, var(--bg-1, #0d151d) 60%, transparent);
      }
      /* WI-39536: the Improve grid's expanded-row trace + in-cell trace toggle. */
      .pc-learning__gridtrace { padding: 0 10px 10px; }
      .pc-learning__gridtrace .pc-learning__trace { margin-top: 0; }
      .pc-learning__gridtitlebtn { all: unset; cursor: pointer; display: inline-flex; min-width: 0; max-width: 100%; }
      .pc-learning__gridtitlebtn:focus-visible { outline: 2px solid var(--accent, #7dd3fc); outline-offset: 2px; border-radius: 4px; }
      .pc-learning__tracerow { display: contents; }
      .pc-learning__tracerow > em {
        font-style: normal; font-size: 8.5px; font-weight: 720; text-transform: uppercase;
        letter-spacing: 0; color: var(--fg-mute, #7f9bb4); padding-top: 3px; white-space: nowrap;
      }
      .pc-learning__tracerow > strong {
        font-size: 11px; font-weight: 620; color: var(--fg-dim, #b9d4e8);
        min-width: 0; overflow-wrap: anywhere;
      }
      .pc-learning__tracerow > strong i { font-style: normal; font-size: 9.5px; font-weight: 600; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__tracerow.is-missing > strong { color: var(--fg-mute, #7f9bb4); font-weight: 520; font-style: italic; }
      .pc-learning__tracerow.is-good > strong { color: #86efac; }
      .pc-learning__tracerow.is-bad > strong { color: #fb7185; }
      .pc-learning__tracechips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
      .pc-learning__tracechips > strong {
        font-size: 11px; font-weight: 520; font-style: italic; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__tracedot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .pc-learning__tracechip-text {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-learning__tracechip b { font-weight: 680; color: var(--fg, #e7eef5); overflow: hidden; text-overflow: ellipsis; }
      .pc-learning__tracechip {
        display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px;
        font-size: 10.5px; font-weight: 600; border-radius: 6px; font-family: inherit;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); color: var(--fg-dim, #b9d4e8);
        /* FIXED width + end-ellipsis (owner ask 2026-07-19e): the raw id/slug
           is never needed in full on the card — the tooltip and the artifact
           itself carry it. The child -text span does the truncating. */
        max-width: 200px; white-space: nowrap; text-align: left;
        transition: border-color 130ms ease, color 130ms ease, background 130ms ease;
      }
      .pc-learning__tracechip i {
        font-style: normal; font-size: 8.5px; font-weight: 720; text-transform: uppercase;
        letter-spacing: 0; color: var(--fg-mute, #7f9bb4); flex-shrink: 0;
      }
      .pc-learning__tracechip--link { cursor: pointer; }
      .pc-learning__tracechip--link:hover, .pc-learning__tracechip--link:focus-visible {
        border-color: var(--accent, rgba(125, 211, 252, 0.45)); color: var(--accent, #7dd3fc);
      }

      .pc-learning__scoreboard { display: flex; flex-wrap: wrap; gap: 8px; }
      .pc-learning__throughputhive { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; }
      .pc-learning__throughputhive + .pc-learning__throughputhive { border-top: 1px solid var(--border, rgba(125, 211, 252, 0.12)); padding-top: 12px; }
      .pc-learning__stat {
        display: flex; flex-direction: column; gap: 2px; min-width: 96px;
        padding: 9px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
      }
      .pc-learning__stat strong { font-size: 20px; font-weight: 760; line-height: 1; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; }
      .pc-learning__stat span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__stat--auto strong { color: #86efac; }
      .pc-learning__stat--human strong { color: #fcd34d; }
      .pc-learning__stat--good strong { color: var(--accent-strong, var(--accent)); }

      .pc-learning__section { display: flex; flex-direction: column; gap: 7px; }
      .pc-learning__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      /* Pin the runs header inside the scrolling view-pane so the newest-run
         recency stays on screen while the user scrolls down to the judge cards
         (owner escalation 2026-07-26: scrolling hid every recent run and the
         list appeared to start hours ago). Opaque background + z-index so rows
         slide UNDER it rather than through it. */
      .pc-learning__sectionhead--stickyruns {
        position: sticky; top: 0; z-index: 3;
        background: var(--bg, #07101d); padding: 4px 0 5px;
        box-shadow: 0 6px 10px -8px rgba(0,0,0,0.85);
      }
      /* Challenger cards as a GRID, newest first (owner ask 2026-07-27) — replaces
         the per-role 1-of-N CardStack carousel so the list IS the overview. Wide
         panes get columns; a narrow dock pane collapses to one column via the
         container query below. */
      .pc-learning__gymcardgrid {
        display: grid; gap: 8px; margin-top: 6px;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        align-items: start;
      }
      .pc-learning__gymcard {
        min-width: 0; border-left: 3px solid var(--border, #2a2a2a);
        border-radius: 8px; background: var(--bg-1, #0b1220);
      }
      /* Per-role challenger groups (owner ask 2026-07-27) — the stacks the
         CardStack decks used to give, but collapsible instead of 1-of-N. */
      .pc-learning__gymrolegroup { margin-top: 8px; min-width: 0; }
      .pc-learning__gymrolehead {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 4px 8px; border: 0; border-left: 3px solid var(--border, #2a2a2a);
        border-radius: 6px; background: var(--bg-2, #0b1220);
        color: var(--fg, #e7f7ff); cursor: pointer; text-align: left;
      }
      .pc-learning__gymrolehead:hover { background: var(--bg-3, #101a28); }
      .pc-learning__gymrolename {
        font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
      }
      .pc-learning__gymcard .pc-learning__gymprompt {
        max-height: 148px; overflow: auto;
      }
      @container learning (max-width: 560px) {
        .pc-learning__gymcardgrid { grid-template-columns: minmax(0, 1fr); }
      }
      .pc-learning__runsrecency {
        font-size: 11px; font-weight: 600; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, #2a2a2a); border-radius: 999px;
        padding: 1px 8px; white-space: nowrap;
      }
      .pc-learning__sectionhead h2 { margin: 0; font-size: 13px; font-weight: 740; text-transform: uppercase; letter-spacing: 0; color: var(--fg, #e7eef5); }
      /* P-003 removed the bespoke Improve toolbar these dressed — the search
         pill, its match count, the inline-tools row and the rounded lane pills.
         Improve now renders that row as pc-advpanel__bar and its lane axis as a
         pc-learning__seg segment, so nothing referenced them any more. */
      .pc-learning__refresh {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; flex-shrink: 0;
        border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
        border-radius: 8px; background: var(--bg-popover, #0d1829); color: var(--fg-dim, #b9d4e8); cursor: pointer;
      }
      .pc-learning__refresh:disabled { opacity: 0.5; cursor: default; }

      .pc-learning__loops { display: flex; flex-wrap: wrap; gap: 6px; }
      .pc-learning__loop {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 9px; font-size: 11px; font-weight: 600; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__loop em { font-style: normal; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__loop--running { border-color: rgba(52, 211, 153, 0.5); }
      .pc-learning__loop--running em { color: #86efac; }
      .pc-learning__loop--off { border-style: dashed; opacity: 0.8; }
      .pc-learning__loopspend { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__dormant {
        display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 12px;
        border: 1px dashed color-mix(in srgb, var(--warn, #f59e0b) 40%, var(--border, rgba(125, 211, 252, 0.2)));
        border-radius: 10px; background: color-mix(in srgb, var(--warn, #f59e0b) 6%, transparent);
        color: var(--fg-mute, #7f9bb4); font-size: 11.5px; line-height: 1.45;
      }
      .pc-learning__dormant > svg { flex: none; color: var(--warn, #f59e0b); }
      .pc-learning__dormant span { max-width: 68ch; }
      .pc-learning__dormant .pc-learning__orientaction { margin: 0 0 0 auto; align-self: center; flex: none; }

      .pc-learning__scopenote {
        margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; font-size: 11px;
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.25)); background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }

      .pc-learning__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__row {
        display: grid; grid-template-columns: 4px auto 1fr auto; align-items: center; gap: 9px;
        padding: 6px 9px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.13));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-learning__sev { width: 4px; height: 100%; min-height: 18px; border-radius: 3px; }
      .pc-learning__row--link { cursor: pointer; }
      .pc-learning__row--selected { border-color: #f59e0b; box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35); cursor: pointer; }
      .pc-learning__row--link:hover, .pc-learning__row--link:focus-visible { border-color: var(--accent, rgba(125, 211, 252, 0.45)); background: var(--bg-3, rgba(255, 255, 255, 0.06)); }
      .pc-learning__id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__title { font-size: 12.5px; color: var(--fg, #e7f7ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__muted { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__meta { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .pc-learning__chip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; font-size: 10px; font-weight: 600; text-transform: lowercase;
        border-radius: 999px; border: 1px solid currentColor; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__chip--idea { color: #a78bfa; border-color: rgba(167, 139, 250, 0.5); }
      /* Pipeline stage (P-004). The ramp reads as progress — inert grey while
         the loop has only had the idea, cool blue once it is queued work, warm
         amber while an agent is on it, green when it lands. Colour is redundant
         with the chip's own text, never the sole carrier of the state.
         (--auto/--human were removed with the approval chip they styled.) */
      .pc-learning__chip--stage-not-ready { color: #94a3b8; border-color: rgba(148, 163, 184, 0.45); }
      .pc-learning__chip--stage-approved { color: var(--accent, #7dd3fc); border-color: var(--accent, rgba(125, 211, 252, 0.5)); }
      .pc-learning__chip--stage-in-flight { color: #fcd34d; border-color: rgba(252, 211, 77, 0.5); }
      .pc-learning__chip--stage-shipped { color: #86efac; border-color: rgba(134, 239, 172, 0.5); }
      .pc-learning__chip--stage-dropped { color: #94a3b8; border-color: rgba(148, 163, 184, 0.35); text-decoration: line-through; }
      .pc-learning__delta { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-learning__delta--good { color: var(--good); }
      .pc-learning__delta--bad { color: var(--bad); }
      .pc-learning__delta--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__age { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__score { font-size: 11px; font-weight: 700; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }

      /* Scout grading (B-07, scout-idea-grading-2026-06-12): the routed-idea row
         splits into a clickable main area + a grade cluster, so stars/note/chip
         never fight the open-the-artifact click. */
      .pc-learning__row--scout { grid-template-columns: minmax(0, 1fr) auto; }
      .pc-learning__row--scout .pc-learning__meta { flex-wrap: wrap; justify-content: flex-end; }
      .pc-learning__rowmain { width: 100%; display: grid; grid-template-columns: 4px auto minmax(0, 1fr); align-items: center; gap: 9px; min-width: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
      .pc-learning__rowmain:hover .pc-learning__title, .pc-learning__rowmain:focus-visible .pc-learning__title { color: var(--accent, #7dd3fc); }
      .pc-learning__grade { display: inline-flex; align-items: center; gap: 5px; }
      .pc-learning__stars { display: inline-flex; }
      .pc-learning__star { display: inline-flex; align-items: center; padding: 1px; background: none; border: none; border-radius: 3px; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
      .pc-learning__star.is-on { color: #fbbf24; }
      .pc-learning__star:hover { color: #fcd34d; }
      .pc-learning__star:disabled { opacity: 0.5; cursor: default; }
      /* Block-level (not inline-flex) so text-overflow can ellipsize: a long
         grader label must never push the note button out of the cell
         (WI-10006513). The full label is in the chip's title. */
      .pc-learning__gradechip { display: inline-block; vertical-align: middle; max-width: 12em; overflow: hidden; text-overflow: ellipsis; padding: 1px 7px; font-size: 10px; font-weight: 700; border-radius: 999px; border: 1px solid rgba(251, 191, 36, 0.5); color: #fbbf24; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-learning__notebtn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; min-height: 22px; background: none; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 6px; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
      .pc-learning__notebtn:hover { color: var(--fg-dim, #b9d4e8); border-color: var(--border-strong, rgba(125, 211, 252, 0.32)); }
      .pc-learning__gradepanel { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 7px; margin-top: 7px; padding-top: 9px; border-top: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); cursor: default; }
      .pc-learning__gradepanelrow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
      .pc-learning__gradecancel { margin-left: auto; }
      .pc-learning__gradepanelhint { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__gradepanel textarea { background: var(--bg-2, rgba(255, 255, 255, 0.03)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); border-radius: 7px; color: var(--fg, #e7f7ff); font-size: 12px; font-family: inherit; line-height: 1.45; padding: 6px 9px; resize: vertical; }
      .pc-learning__gradepanelactions { display: flex; justify-content: flex-end; gap: 8px; }
      .pc-learning__gradepopover { width: min(430px, calc(100vw - 28px)); padding: 10px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-popover); box-shadow: 0 14px 40px rgba(0,0,0,.42); }
      .pc-learning__gradepopover .pc-learning__gradepanel { margin: 0; padding: 0; border: 0; }
      .pc-learning__panelbtn { padding: 4px 11px; font-size: 11.5px; font-weight: 650; border-radius: 7px; cursor: pointer; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: transparent; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__panelbtn--primary { border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); color: #fcd34d; }
      .pc-learning__panelbtn:disabled { opacity: 0.5; cursor: default; }
      /* Ungraded ideas as per-lens overlapping stacks (owner ask 2026-07-19). */
      /* Section headers that carry their explanation inline (owner ask
         2026-07-19): title + a small readable line NEXT to it, never a
         standing block of copy. */
      .pc-learning__sectionhead--desc { justify-content: flex-start; align-items: baseline; }
      .pc-learning__sectionsub {
        flex: 1 1 auto; min-width: 0;
        font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__gymhow { margin: -2px 2px 6px; }
      .pc-learning__gymtitle {
        font-size: 13px; font-weight: 660; line-height: 1.42;
        color: var(--fg, #e7eef5); overflow-wrap: anywhere;
      }
      .pc-learning__gymdeltas { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .pc-learning__gymprompt {
        margin: 2px 0 0; padding: 8px 10px; border-radius: 8px;
        font-family: ui-monospace, monospace; font-size: 10px; line-height: 1.5;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--bg-1, #0d151d) 60%, transparent);
        white-space: pre-wrap; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
      }
      /* ── Inline star grader on the idea card (owner ask 2026-07-19d) ───── */
      .pc-learning__stargrade {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px;
        padding: 6px 9px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, #fbbf24 22%, var(--border, rgba(125, 211, 252, 0.16)));
        background: color-mix(in srgb, #fbbf24 5%, transparent);
      }
      .pc-learning__stargrade.is-graded {
        border-color: color-mix(in srgb, #fbbf24 40%, transparent);
        background: color-mix(in srgb, #fbbf24 8%, transparent);
      }
      .pc-learning__stars { display: inline-flex; gap: 2px; }
      .pc-learning__star {
        display: inline-flex; padding: 2px; border: 0; background: none; cursor: pointer;
        color: color-mix(in srgb, var(--fg-mute, #7f9bb4) 65%, transparent);
        transition: color 120ms ease, transform 120ms ease;
      }
      .pc-learning__star:hover { transform: scale(1.2); color: #fbbf24; }
      .pc-learning__star.is-on { color: #fbbf24; }
      .pc-learning__star:disabled { opacity: 0.5; cursor: default; }
      .pc-learning__starmeta {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
      }
      .pc-learning__stargrade.is-ungraded .pc-learning__starmeta { color: var(--fg-mute, #7f9bb4); font-style: italic; }
      .pc-learning__starnote {
        flex: none; padding: 2px 9px; border-radius: 6px; cursor: pointer;
        font: inherit; font-size: 10px; font-weight: 600;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: none; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__starnote:hover { color: var(--fg-dim, #b9d4e8); border-color: color-mix(in srgb, #fbbf24 45%, var(--border)); }
      .pc-learning__stargrade-note { display: flex; gap: 6px; width: 100%; }
      .pc-learning__stargrade-note input {
        flex: 1 1 auto; min-width: 0; padding: 4px 9px; border-radius: 6px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-1, #0d151d); color: var(--fg, #e7eef5); font: inherit; font-size: 11px;
      }
      .pc-learning__stargrade-note button {
        padding: 4px 12px; border-radius: 6px; cursor: pointer; font: inherit;
        font-size: 11px; font-weight: 700;
        border: 1px solid color-mix(in srgb, #fbbf24 50%, transparent);
        background: color-mix(in srgb, #fbbf24 14%, transparent); color: #fbbf24;
      }
      .pc-learning__stargrade-note button:disabled { opacity: 0.4; cursor: default; }
      /* Outcome chips: won/lost unmistakably green/red (owner ask 2026-07-19d). */
      .pc-learning__score--won {
        min-width: 0; padding: 1px 9px; border-radius: 6px; text-align: center;
        color: #052e1b; background: var(--good, #34d399); font-weight: 760;
      }
      .pc-learning__score--lost {
        min-width: 0; padding: 1px 9px; border-radius: 6px; text-align: center;
        color: #fff; background: #ef4444; font-weight: 760;
      }
      /* Plain-sentence loop warnings. */
      .pc-learning__warnlist { list-style: none; margin: 2px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__warnlist li {
        display: flex; align-items: baseline; gap: 7px;
        font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8);
        padding: 6px 10px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--warn, #fbbf24) 30%, transparent);
        background: color-mix(in srgb, var(--warn, #fbbf24) 6%, transparent);
      }
      .pc-learning__warnlist li.is-bad {
        border-color: color-mix(in srgb, #ef4444 40%, transparent);
        background: color-mix(in srgb, #ef4444 7%, transparent);
      }
      .pc-learning__warnlist li svg { flex: none; align-self: center; color: var(--warn, #fbbf24); }
      .pc-learning__warnlist li.is-bad svg { color: #ef4444; }
      /* Readable per-run rows (replaces the tick chip soup). */
      .pc-learning__tickstrip--rows { display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
      .pc-learning__tickrow {
        display: flex; align-items: baseline; gap: 9px;
        padding: 4px 9px; border-radius: 7px; font-size: 11px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.1));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__tickrow em { flex: none; width: 52px; font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__tickrow strong { flex: none; width: 38px; font-weight: 720; font-variant-numeric: tabular-nums; color: var(--fg, #e7eef5); }
      .pc-learning__tickrow--warn strong { color: var(--warn, #fbbf24); }
      .pc-learning__tickrow--bad strong { color: #ef4444; }
      .pc-learning__tickwhat { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__tickrow .pc-learning__tickspend { flex: none; font-variant-numeric: tabular-nums; color: var(--fg-mute, #7f9bb4); }
      /* The idea→work funnel: stage tiles, big numbers, arrows between
         (owner ask 2026-07-19e — leads the cycle-engine section). */
      .pc-learning__funnel {
        display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
        margin: 2px 0 10px;
      }
      .pc-learning__funnel > span {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; min-width: 86px; padding: 9px 14px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-learning__funnel > span > strong {
        font-size: 17px; font-weight: 760; line-height: 1;
        color: var(--fg, #e7eef5); font-variant-numeric: tabular-nums;
      }
      .pc-learning__funnel > span > small {
        font-size: 9.5px; font-weight: 700; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__funnel > span.is-good {
        border-color: color-mix(in srgb, var(--good, #34d399) 45%, transparent);
        background: color-mix(in srgb, var(--good, #34d399) 8%, transparent);
      }
      .pc-learning__funnel > span.is-good > strong { color: var(--good, #34d399); }
      .pc-learning__funnel > i {
        align-self: center; font-style: normal; font-size: 14px;
        color: var(--fg-mute, #7f9bb4);
      }
      /* The one-line plain-language glance replacing the instrument stack
         (owner ask 2026-07-19). */
      .pc-learning__glance {
        display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px;
        margin: 2px 2px 4px; font-size: 12px; color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__glance > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      .pc-learning__glance > span + span::before { content: "·"; margin-right: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__glance strong { font-weight: 700; color: var(--fg, #e7eef5); font-variant-numeric: tabular-nums; }
      .pc-learning__glance .is-warn { color: var(--warn, #fbbf24); font-weight: 600; }
      .pc-learning__lensstacks {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px; margin-top: 8px;
      }
      /* The lens label + count render as CardStack's on-card header badge
         (pc-cardstack__header-*), so the group carries no separate head row. */
      .pc-learning__lensgroup { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      /* Card content hierarchy (owner ask 2026-07-19, continued polish):
         quiet meta row up top, the TITLE as the loudest element, the trace
         ledger recessed below — readable at a glance, roomy, consistent. */
      .pc-learning__ideacard {
        display: flex; flex-direction: column; gap: 8px;
        padding: 0 14px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      /* Graded cards read at deck distance (design pass 2026-07-19g): a green
         check badge rides the band's right corner. */
      .pc-learning__ideacard { position: relative; }
      .pc-learning__ideacard.is-graded::after {
        content: "✓"; position: absolute; top: 6px; right: 8px;
        display: flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%;
        font-size: 11px; font-weight: 800; line-height: 1;
        color: #052e1b; background: var(--good, #34d399);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        pointer-events: none;
      }
      /* Accent header BAND (design pass 2026-07-19f): the category color (the
         deck's --cs-accent, cascading in) structures the card's top — meta on
         a tinted strip, content below a hairline. */
      .pc-learning__ideacard-head {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 22px;
        margin: 0 -14px 2px; padding: 9px 14px 8px;
        background: linear-gradient(
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 10%, transparent),
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 3%, transparent));
        border-bottom: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 16%, var(--border, rgba(125, 211, 252, 0.16)));
      }
      .pc-learning__ideacard-head .pc-learning__id {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 9.5px; font-weight: 720; text-transform: uppercase;
        opacity: 0.9;
      }
      .pc-learning__ideacard-head .pc-learning__sev {
        width: 7px; height: 7px; min-height: 0; border-radius: 50%;
      }
      .pc-learning__ideacard-head .pc-learning__age { font-size: 10px; opacity: 0.85; margin-right: 14px; }
      .pc-learning__ideacard-head .pc-learning__grade { margin-left: auto; }
      .pc-learning__ideacard-title {
        text-align: left; font: inherit; font-size: 13px; font-weight: 660; line-height: 1.42;
        color: var(--fg, #e7eef5); background: none; border: 0; padding: 0; cursor: pointer;
      }
      .pc-learning__ideacard-title:hover { color: var(--accent, #7dd3fc); }

      .pc-learning__row--retained { grid-template-columns: 4px minmax(0, 1fr) auto; }
      .pc-learning__row--retained.is-selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
      .pc-learning__retainedmain { width: 100%; min-width: 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
      .pc-learning__retainedmain:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
      .pc-learning__retainedtext { display: -webkit-box; overflow: hidden; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
      .pc-learning__retainedtext.is-expanded { display: block; overflow: visible; -webkit-line-clamp: unset; }
      .pc-learning__retainedsummary { display: grid; gap: 2px; min-width: 0; }
      .pc-learning__retainedsummary > strong, .pc-learning__retainedsummary > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__retainedsummary > strong { color: var(--fg); font-size: 11.5px; font-weight: 680; }
      .pc-learning__retainedsummary > span { color: var(--fg-mute); font-size: 10.5px; }
      .pc-learning__retainedactions { display: inline-flex; gap: 5px; margin-top: 1px; }
      .pc-learning__retainlayout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
      .pc-learning__retainlayout.has-detail { grid-template-columns: minmax(320px, .9fr) minmax(360px, 1.1fr); }
      .pc-learning__retainindex { min-width: 0; }
      .pc-learning__retaindetail { min-width: 0; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 9px; background: var(--bg-2); }
      .pc-learning__retaindetail > header { display: flex; align-items: center; justify-content: space-between; min-height: 24px; }
      .pc-learning__retaindetail > header button { display: grid; place-items: center; width: 24px; height: 24px; min-height: 24px; padding: 0; border: 0; background: transparent; color: var(--fg-mute); cursor: pointer; }
      .pc-learning__retaindetail > p { margin: 7px 0 10px; color: var(--fg); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
      .pc-learning__retaindetail > footer { display: flex; justify-content: flex-end; gap: 5px; margin-top: 10px; }
      .pc-learning__retaindetail > footer button { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); cursor: pointer; font-size: 11px; padding: 1px 7px; }
      /* WI-39534 detail aside internals — scrolls beside the 340px grid. */
      .pc-learning__retaindetail { max-height: 340px; overflow-y: auto; }
      .pc-learning__retaindetailtitle { display: block; margin-top: 7px; color: var(--fg-dim, #b9d4e8); font-size: 12px; line-height: 1.4; }
      .pc-learning__retaindetailmeta { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
      .pc-learning__retaindetailcode { margin: 7px 0 0; padding: 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-1); font-size: 10.5px; line-height: 1.45; overflow: auto; max-height: 180px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .pc-learning__retaindetaillist { margin: 7px 0 0; padding-left: 16px; color: var(--fg); font-size: 11.5px; line-height: 1.5; }
      .pc-learning__retaindetailfields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 10px; margin-top: 9px; font-size: 11px; }
      .pc-learning__retaindetailfields > div { display: contents; }
      .pc-learning__retaindetailfields span:first-child { color: var(--fg-mute); }
      .pc-learning__retaindetailfields span:last-child { color: var(--fg-dim); overflow-wrap: anywhere; }
      .pc-learning__retaincontrols { display: flex; align-items: center; gap: 4px; }
      .pc-learning__retaincontrols input { width: min(220px, 28vw); height: 26px; padding: 3px 8px; font-size: 10.5px; }
      @container learning (max-width: 820px) { .pc-learning__retainlayout.has-detail { grid-template-columns: 1fr; } .pc-learning__retaindetail { grid-row: 1; } }

      /* Lens sampling weights (P-007 steering visibility). */
      .pc-learning__lens { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4); }
      .pc-learning__lens em { font-style: normal; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__lens strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__lensbar { width: 44px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
      .pc-learning__lensbar span { display: block; height: 100%; border-radius: 2px; background: #a78bfa; }

      /* P-009 first-run: the visible view gloss + the once-per-workspace orientation banner. */
      .pc-learning__strap { margin: 2px 0 0; color: var(--fg-mute, #7f9bb4); font-size: 11px; line-height: 1.4; }
      .pc-learning__orient { display: flex; align-items: flex-start; gap: 10px; margin-top: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 7%, transparent); }
      .pc-learning__orientbody { display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__orientbody strong { color: var(--fg-dim, #b9d4e8); font-size: 12px; }
      .pc-learning__orientbody p { margin: 0; max-width: 72ch; color: var(--fg-mute, #7f9bb4); font-size: 11px; line-height: 1.5; }
      .pc-learning__orientaction { align-self: flex-start; margin-top: 4px; display: inline-flex; align-items: center; min-height: 25px; padding: 3px 11px; border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border)); border-radius: 7px; background: color-mix(in srgb, var(--accent) 12%, var(--bg-2)); color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; font-weight: 650; }
      .pc-learning__orientaction:hover { background: color-mix(in srgb, var(--accent) 20%, var(--bg-2)); }
      .pc-learning__orientaction:focus-visible, .pc-learning__orientdismiss:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .pc-learning__orientdismiss { margin-left: auto; display: grid; place-items: center; width: 22px; height: 22px; min-height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer; font-size: 12px; }
      .pc-learning__orientdismiss:hover { color: var(--fg, #e6f1fa); background: var(--bg-2); }
      .pc-learning__empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 16px 12px; color: var(--fg-mute, #7f9bb4); font-size: 12px; }
      .pc-learning__empty--card { border: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); border-radius: 12px; }
      .pc-learning__empty strong { color: var(--fg-dim, #b9d4e8); font-size: 13px; }
      .pc-learning__empty span { max-width: 58ch; }
      .pc-learning__quietempty { min-height: 34px; display: flex; align-items: center; justify-content: center; gap: 7px; margin: 0; border: 1px dashed color-mix(in srgb, var(--border) 70%, transparent); border-radius: 8px; color: var(--fg-mute); font-size: 11px; }
      .pc-learning__packtools { flex-wrap: wrap; padding: 3px 0 6px; }

      /* Benchmark (apiary) trend rows + knowledge cross-link. */
      .pc-learning__benchcell { display: inline-flex; align-items: baseline; gap: 9px; min-width: 0; overflow: hidden; }
      .pc-learning__benchnum { font-size: 14px; font-weight: 760; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; }
      .pc-learning__benchmeta { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__knowledge { align-items: flex-start; text-align: left; }
      .pc-learning__knowledge strong { font-size: 14px; }
      .pc-learning__cta {
        display: inline-flex; align-items: center; gap: 6px; margin-top: 4px;
        padding: 7px 13px; font-size: 12px; font-weight: 650; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.14); color: #86efac;
      }
      .pc-learning__cta:hover { background: rgba(52, 211, 153, 0.24); color: #e7f7ff; }

      .pc-learning__footnote { margin: 2px 0 0; font-size: 11px; font-style: italic; color: var(--fg-mute, #7f9bb4); }

      .pc-learning__memorymap {
        min-height: 120px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-2);
      }
      .pc-learning__lanegrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
      .pc-learning__lanegrid.is-single { grid-template-columns: minmax(0, 1fr); }
      .pc-learning__lanecol { min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--bg-2) 88%, transparent); overflow: hidden; }
      .pc-learning__lanecol > header { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border-bottom: 1px solid var(--border); color: var(--fg-mute); font-size: 10px; font-weight: 750; text-transform: uppercase; }
      .pc-learning__lanecol.is-auto > header strong { color: var(--accent); }
      .pc-learning__lanecol.is-human > header strong { color: #fbbf24; }
      .pc-learning__lanecol > .pc-learning__list { padding: 6px; }
      .pc-learning__lanecol .pc-learning__row { grid-template-columns: 4px auto minmax(0, 1fr); }
      .pc-learning__lanecol .pc-learning__meta { grid-column: 2 / -1; justify-content: flex-end; }
      .pc-learning__idea-filters { display: flex; align-items: center; gap: 5px; overflow-x: auto; padding: 2px 0; }
      .pc-learning__idea-filters button { display: inline-flex; align-items: center; gap: 5px; flex: none; min-height: 27px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 10px; cursor: pointer; }
      .pc-learning__idea-filters button:hover, .pc-learning__idea-filters button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background: color-mix(in srgb, var(--accent) 8%, var(--bg-2)); color: var(--fg); }
      .pc-learning__idea-filters button > i { width: 6px; height: 6px; border-radius: 50%; }
      .pc-learning__idea-filters strong { color: var(--fg); font-size: 10px; font-variant-numeric: tabular-nums; }
      .pc-learning__pendingrun { display: flex; align-items: center; gap: 7px; min-height: 30px; padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--fg-mute); font-size: 10.5px; }
      .pc-learning__pendingrun svg { color: var(--accent); }
      .pc-learning__pendingrun strong { color: var(--fg); font-family: var(--font-mono, ui-monospace, monospace); }
      .pc-learning__pendingrun em { margin-left: auto; color: var(--fg-mute); font-style: normal; font-variant-numeric: tabular-nums; }
      .pc-learning__pendinginline { display: inline-flex; align-items: center; gap: 4px; margin-left: 7px; padding-left: 7px; border-left: 1px solid var(--border); color: var(--accent); font-size: 9px; font-variant-numeric: tabular-nums; }
      .pc-learning__provenance { display: inline-grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 50%; color: var(--fg-mute); }
      .pc-learning__provenance.is-owner { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
      .pc-learning__provenance.is-brain { color: #34d399; border-color: color-mix(in srgb, #34d399 42%, var(--border)); }
      .pc-learning__provenance.is-scout { color: #a78bfa; border-color: color-mix(in srgb, #a78bfa 42%, var(--border)); }
      .pc-learning__provenance.is-system { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 42%, var(--border)); }
      .pc-learning__provenance.is-reference { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
      .pc-learning__memorymap { display: grid; grid-template-columns: repeat(16, minmax(5px, 1fr)); grid-auto-rows: 1fr; gap: 3px; padding: 12px; }
      .pc-learning__memorymap i { min-height: 10px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 58%, transparent); opacity: .78; }
      .pc-learning__memorymap i.is-organic { background: #34d399; }
      .pc-learning__memorymap i:hover { opacity: 1; transform: scale(1.08); }
      .pc-learning__standings { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; font-size: 9px; }
      @container learning (max-width: 920px) { .pc-learning__lanegrid { grid-template-columns: 1fr; } }
    `}</style>
  );
}
