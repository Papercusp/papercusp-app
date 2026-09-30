/**
 * RedQueenPanel — the Benchmark view's MTTSH vital sign
 * (self-learning-frontier-2026-06-12 P-031 / FB-20).
 *
 * Renders the Red Queen drill vitals (`learning.redQueen` sync query):
 * per-class mean-time-to-self-heal medians across detect → triage → fix,
 * resolve rate, triage accuracy against planted ground truth, and the
 * zero-leak record. A failed leak check renders a loud alarm chip — a drill
 * artifact visible to an organic consumer is exactly what the provenance
 * rails exist to prevent. Until the frontier arming gate (the plan's P-001)
 * flips the drill cadence's flag the store is empty and the panel renders its
 * no-drills state.
 *
 * Self-contained on purpose (own sync query + pc-rq__* styles, mirroring
 * EkgPanel's idiom) so the LearningTab wiring stays at two lines. Defensive
 * about the snapshot shape — anything but the expected {classes: []} renders
 * the empty state, never a crash.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { HeartPulse, RefreshCw } from "lucide-react";
import type { MttshVitals } from "@papercusp/operator-core/lib/red-queen/mttsh";
import { snapshotFault } from "./snapshot-fault";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";

function ms(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v / 60_000)}m`;
}

function dateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RedQueenPanel({
  onStatus,
  active = true,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263). */
  active?: boolean;
} = {}) {
  const sync = useSyncQuery<MttshVitals>({
    queryName: "learning.redQueen",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const classes = Array.isArray(snap?.classes) ? snap.classes : [];
  const phaseAverage = (key: "detectMs" | "triageMs" | "fixMs"): number => {
    const values = classes
      .map((row) => row[key])
      .filter((value): value is number => value != null);
    return values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  };
  const detect = phaseAverage("detectMs");
  const triage = phaseAverage("triageMs");
  const fix = phaseAverage("fixMs");
  const phaseTotal = Math.max(1, detect + triage + fix);
  const unresolved = snap
    ? Math.max(0, snap.totalRuns - snap.totalResolved)
    : 0;
  // WI-6382: a data-layer failure reaches this branch too — it used to be
  // converted server-side into a successful empty snapshot, so `sync.error`
  // stayed null and the panel said "No self-heal drills" while the substrate
  // was unreadable.
  const fault = snapshotFault(sync.error, snap, "Red Queen");
  useEffect(() => {
    onStatus?.(
      fault.failed
        ? "bad"
        : classes.length === 0 || !snap
          ? "neutral"
          : snap.leakFailures > 0
            ? "bad"
            : unresolved > 0
              ? "warn"
              : "good",
    );
  }, [classes.length, onStatus, snap, fault.failed, unresolved]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732).
  const redQueenSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    redQueenSettled,
    active,
  );

  return (
    <section
      className="pc-learning__section pc-rq"
      aria-label="Red Queen MTTSH vitals"
    >
      <LearningPageHeader
        icon={HeartPulse}
        title="Red Queen"
        signal={
          classes.length > 0 && snap
            ? unresolved > 0
              ? `${unresolved} unresolved`
              : `${snap.totalResolved}/${snap.totalRuns} healed`
            : undefined
        }
        tone={
          snap && snap.leakFailures > 0
            ? "bad"
            : unresolved > 0
              ? "warn"
              : "good"
        }
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the MTTSH vitals"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Red Queen unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : classes.length === 0 ? (
        // WI-6388: see EkgPanel — teaching copy per the component's contract.
        <LearningVisualEmpty
          icon={HeartPulse}
          title="No self-heal drills"
          body="This view measures how quickly the system detects and repairs deliberately planted faults. Results appear here after a drill has run."
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout pc-learning-visual__layout--rq">
            <LearningHeroMetric
              eyebrow="Median self-heal"
              value={ms(snap!.medianTotalMs)}
              status={
                snap!.leakFailures > 0
                  ? "leak detected"
                  : unresolved > 0
                    ? `${unresolved} unresolved`
                    : "fully healed"
              }
              tone={
                snap!.leakFailures > 0
                  ? "bad"
                  : unresolved > 0
                    ? "warn"
                    : "good"
              }
            >
              {snap!.totalResolved}/{snap!.totalRuns} healed ·{" "}
              {snap!.leakFailures} leaks
            </LearningHeroMetric>
            <div
              className="pc-rq__waterfall"
              aria-label="Self-heal phase timing"
            >
              {[
                ["Detect", detect, "#38bdf8"],
                ["Triage", triage, "#fbbf24"],
                ["Fix", fix, "#34d399"],
              ].map(([label, value, color]) => (
                <span
                  key={String(label)}
                  style={{
                    width: `${Math.max(12, (Number(value) / phaseTotal) * 100)}%`,
                  }}
                >
                  <i style={{ background: String(color) }} />
                  <small>{label}</small>
                  <strong>{ms(Number(value))}</strong>
                </span>
              ))}
            </div>
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Resolved</span>
                  <strong>{snap!.totalResolved}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Unresolved</span>
                  <strong>{unresolved}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Leaks</span>
                  <strong>{snap!.leakFailures}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Runs</span>
                  <strong>{snap!.totalRuns}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          <div className="pc-learning__sectionhead">
            <h2>Drill classes</h2>
          </div>
          <ul className="pc-rq__list">
            {classes.map((c) => (
              <li key={c.drillClass} className="pc-rq__row">
                <span className="pc-rq__class">{c.drillClass}</span>
                <span className="pc-rq__meta">
                  <span title="Healed / total runs">
                    {c.resolved}/{c.runs}
                  </span>
                  <span title="Median detect → triage → fix (resolved runs)">
                    {ms(c.detectMs)} → {ms(c.triageMs)} → {ms(c.fixMs)}
                  </span>
                  <span title="Median total MTTSH">{ms(c.totalMs)}</span>
                  {c.triageJudged > 0 ? (
                    <span title="Triage decisions matching the planted expectation">
                      triage {c.triageMatches}/{c.triageJudged}
                    </span>
                  ) : null}
                  {c.leakFailures > 0 ? (
                    <span className="pc-rq__leak">LEAK ×{c.leakFailures}</span>
                  ) : null}
                  <span className="pc-rq__age" title="Last run">
                    {dateShort(c.lastRunAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{`
        .pc-rq__waterfall { min-height: 120px; display: flex; align-items: center; gap: 4px; padding: 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-2); }
        .pc-rq__waterfall > span { min-width: 70px; display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: end; }
        .pc-rq__waterfall i { grid-column: 1 / -1; display: block; height: 22px; border-radius: 4px; opacity: .85; }
        .pc-rq__waterfall small { color: var(--fg-mute); font-size: 9px; text-transform: uppercase; }
        .pc-rq__waterfall strong { color: var(--fg); font-size: 10px; font-variant-numeric: tabular-nums; }
        .pc-rq__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-rq__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-rq__class { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
        .pc-rq__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-rq__age { opacity: 0.85; }
        .pc-rq__leak { color: #fb7185; font-weight: 700; }
      `}</style>
    </section>
  );
}

export default RedQueenPanel;
