/**
 * ExperimentsPanel — the Benchmark view's experiment scoreboard
 * (experiment-registry-invocation-api-2026-06-14 P-051).
 *
 * Renders the experiment_runs ledger (`learning.experiments` sync query): each
 * `experiment:run` — its test + tier, the compared arms with their judge scores
 * (winner highlighted), total spend, and the decision (a winner is a proposal until
 * the apply path graduates it, D-006). Until an experiment is run the ledger is empty
 * and the panel renders its nothing-run state.
 *
 * Self-contained on purpose (own sync query + pc-experiments__* styles, mirroring
 * DemandPanel) so the LearningTab wiring stays one line. Defensive about the row
 * shape — anything unexpected renders the empty state, never a crash.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { FlaskConical, RefreshCw } from "lucide-react";
import type { ExperimentRunSummary } from "@papercusp/operator-core/lib/experiment/ledger";
import {
  LearningComparisonBars,
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";
import { snapshotFault } from "./snapshot-fault";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";

const TIER_TONE: Record<string, string> = {
  offline: "var(--accent-strong, var(--accent))",
  shadow: "#c4b5fd",
  live: "#fbbf24",
};

const DECISION_TONE: Record<string, string> = {
  proposed: "#fbbf24",
  applied: "#34d399",
  rejected: "#f87171",
};

function dateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function scoreLabel(n: number | null): string {
  return n === null || Number.isNaN(n) ? "—" : n.toFixed(1);
}

export function ExperimentsPanel({
  onStatus,
  active = true,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263). */
  active?: boolean;
} = {}) {
  // WI-6395: the read is now enveloped (`[{ items, unavailable? }]`) so a failed
  // or pre-migration read can say so instead of arriving as an empty list. The
  // row filter stays: it guards against a malformed row, which is a different
  // risk from a failed read and is still worth guarding.
  const sync = useSyncQuery<{ items?: ExperimentRunSummary[] }>({
    queryName: "learning.experiments",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const runs = Array.isArray(snap?.items)
    ? snap.items.filter((r) => r && typeof r.batteryId === "string")
    : [];
  const fault = snapshotFault(sync.error, snap, "The experiment registry");
  const latest = runs[0];
  const latestArms = latest && Array.isArray(latest.arms) ? latest.arms : [];
  const winnerArm = latestArms.find((arm) => arm.id === latest?.winner) ?? null;
  const baselineArm =
    latestArms.find((arm) => arm.id !== latest?.winner) ?? null;
  const visible = runs.slice(0, 4);
  const earlier = runs.slice(4);
  // `fault.failed`, not `sync.error`: the resolver converts a data-layer failure
  // into a SUCCESSFUL empty read, so sync.error only ever fired for transport.
  const status = fault.failed
    ? "bad"
    : !latest
      ? "neutral"
      : latest.decision === "applied"
        ? "good"
        : latest.decision === "rejected"
          ? "bad"
          : "warn";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732).
  const experimentsSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    experimentsSettled,
    active,
  );

  const renderRun = (r: (typeof runs)[number]) => {
    const arms = Array.isArray(r.arms) ? r.arms : [];
    return (
      <li
        key={`${r.batteryId}`}
        className="pc-experiments__row"
        title={r.batteryId}
      >
        <span className="pc-experiments__test">{r.testId}</span>
        <span
          className="pc-experiments__tier"
          style={{ color: TIER_TONE[r.tier] ?? "#7f9bb4" }}
        >
          {r.tier}
        </span>
        <span className="pc-experiments__arms">
          {arms.map((a) => (
            <span
              key={a.id}
              className={
                a.id === r.winner
                  ? "pc-experiments__arm pc-experiments__arm--win"
                  : "pc-experiments__arm"
              }
              title={a.label}
            >
              {a.id} {scoreLabel(a.meanScore)}
            </span>
          ))}
        </span>
        <span className="pc-experiments__meta">
          <span className="pc-experiments__winner" title="Winning arm">
            {r.winner ? `▲ ${r.winner}` : "no winner"}
          </span>
          <span title="Total spend">${r.totalCostUsd.toFixed(3)}</span>
          <span
            className="pc-experiments__decision"
            style={{ color: DECISION_TONE[r.decision] ?? "#7f9bb4" }}
            title="A winner is a proposal until the apply path graduates it"
          >
            {r.decision}
          </span>
          <span className="pc-experiments__age">{dateShort(r.createdAt)}</span>
        </span>
      </li>
    );
  };

  return (
    <section
      className="pc-learning__section pc-experiments"
      aria-label="Experiment scoreboard"
    >
      <LearningPageHeader
        icon={FlaskConical}
        title="Experiments"
        question="Which arm won?"
        signal={latest?.decision}
        tone={
          latest?.decision === "applied"
            ? "good"
            : latest?.decision === "rejected"
              ? "bad"
              : "warn"
        }
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the experiment scoreboard"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Experiments unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest ? (
        // WI-6388: see EkgPanel — teaching copy per the component's contract.
        <LearningVisualEmpty
          icon={FlaskConical}
          title="No experiment runs"
          body="This view scores head-to-head experiments — which variant won, and what it cost. Runs appear here once an experiment has completed."
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow={latest.testId}
              value={scoreLabel(winnerArm?.meanScore ?? null)}
              status={latest.winner ? `winner · ${latest.winner}` : "no winner"}
              tone={latest.winner ? "good" : "warn"}
            >
              {latest.tier} tier
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Baseline vs winner"
              baselineName={baselineArm?.id ?? "Baseline"}
              treatmentName={winnerArm?.id ?? "Winner"}
              rows={[
                {
                  label: "Mean score",
                  baseline: baselineArm?.meanScore ?? null,
                  treatment: winnerArm?.meanScore ?? null,
                  baselineLabel: scoreLabel(baselineArm?.meanScore ?? null),
                  treatmentLabel: scoreLabel(winnerArm?.meanScore ?? null),
                  max: 10,
                  treatmentWins:
                    winnerArm?.meanScore != null &&
                    winnerArm.meanScore >=
                      (baselineArm?.meanScore ?? -Infinity),
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Tier</span>
                  <strong>{latest.tier}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Spend</span>
                  <strong>${latest.totalCostUsd.toFixed(3)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Arms</span>
                  <strong>{latestArms.length}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Decision</span>
                  <strong>{latest.decision}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          <div className="pc-learning__sectionhead">
            <h2>Recent experiments</h2>
          </div>
          <ul className="pc-experiments__list">{visible.map(renderRun)}</ul>
          {earlier.length > 0 ? (
            <LearningDisclosure
              label="Earlier experiments"
              count={earlier.length}
            >
              <ul className="pc-experiments__list">{earlier.map(renderRun)}</ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
      <style>{`
        .pc-experiments__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-experiments__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-experiments__test { flex: none; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: var(--accent-ink, #06121a); background: var(--accent-strong, var(--accent)); border-radius: 4px; padding: 1px 5px; }
        .pc-experiments__tier { flex: none; font-size: 10.5px; font-weight: 600; }
        .pc-experiments__arms { flex: 1 1 auto; min-width: 0; display: inline-flex; flex-wrap: wrap; gap: 6px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
        .pc-experiments__arm { color: var(--fg-mute, #7f9bb4); }
        .pc-experiments__arm--win { color: #34d399; font-weight: 650; }
        .pc-experiments__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-experiments__winner { color: var(--fg, #cfe6ff); }
        .pc-experiments__age { opacity: 0.85; }
      `}</style>
    </section>
  );
}

export default ExperimentsPanel;
