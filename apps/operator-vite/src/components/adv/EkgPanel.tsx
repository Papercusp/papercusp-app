/**
 * EkgPanel — the Benchmark view's fleet behavioral heartbeat
 * (self-learning-frontier-2026-06-12 P-030 / FB-10).
 *
 * Renders the Fleet EKG's output (`learning.ekg` sync query): detected
 * distribution shifts in the fleet's session behavior — which named feature
 * moved, how hard, and WHICH behavior-change-ledger entries are the candidate
 * causes. Unattributable shifts (no ledgered mutation in the lookback) carry
 * the alarm chip — those are the D-003 attribution holes. Until the frontier
 * arming gate (the plan's P-001) flips the scan's flag the store is empty and
 * the panel renders its nothing-scanned state.
 *
 * Self-contained on purpose (own sync query + pc-ekg__* styles, mirroring
 * DemandPanel's self-carried idiom) so the LearningTab wiring stays at two
 * lines. Defensive about the snapshot shape — anything but the expected
 * {shifts: []} renders the empty state, never a crash.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { Activity, RefreshCw } from "lucide-react";
import type { EkgSnapshot } from "@papercusp/operator-core/lib/fleet-ekg/ekg-read";
import { snapshotFault } from "./snapshot-fault";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";

function metricValue(feature: string, value: number | null): string {
  if (value == null) return "";
  const key = feature.toLowerCase();
  if (key.endsWith("ms")) {
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
    if (value < 3_600_000) return `${(value / 60_000).toFixed(1)}m`;
    return `${(value / 3_600_000).toFixed(1)}h`;
  }
  if (key.includes("rate") || key.includes("share")) {
    return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3);
}

function dateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function EkgPanel({
  onStatus,
  active = true,
}: {
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263). */
  active?: boolean;
} = {}) {
  const sync = useSyncQuery<EkgSnapshot>({
    queryName: "learning.ekg",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const shifts = Array.isArray(snap?.shifts) ? snap.shifts : [];
  const major = shifts.filter((shift) => shift.severity === "major").length;
  const visible = shifts.slice(0, 8);
  const earlier = shifts.slice(8);
  // WI-6382: a data-layer failure now reaches this branch too. It used to be
  // swallowed server-side into a successful empty snapshot, so `sync.error`
  // stayed null and the panel reported "No behavioral shifts" — calm, confident
  // and false — while the substrate was unreadable.
  const fault = snapshotFault(sync.error, snap, "EKG");
  useEffect(() => {
    onStatus?.(
      fault.failed
        ? "bad"
        : shifts.length === 0
          ? "neutral"
          : major > 0 || (snap?.unattributedShifts ?? 0) > 0
            ? "warn"
            : "good",
    );
  }, [major, onStatus, shifts.length, snap?.unattributedShifts, fault.failed]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732).
  const ekgSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(PERF_INTERACTIONS.learningViewSwitch, ekgSettled, active);

  const renderShift = (s: (typeof shifts)[number]) => (
    <li key={s.id} className="pc-ekg__row">
      <span className={`pc-ekg__severity is-${s.severity}`}>{s.severity}</span>
      <span className="pc-ekg__feature">
        {s.feature}
        {s.direction ? (
          <em className="pc-ekg__dir">{s.direction === "up" ? "↑" : "↓"}</em>
        ) : null}
      </span>
      <span className="pc-ekg__meta">
        <span title="Drift score (PSI for numeric, JSD for distributions)">
          {s.score.toFixed(3)}
        </span>
        {s.baselineSummary != null && s.windowSummary != null ? (
          <span title="Baseline median → window median">
            {metricValue(s.feature, s.baselineSummary)}→
            {metricValue(s.feature, s.windowSummary)}
          </span>
        ) : null}
        <span title="Window vs baseline cohort sizes">
          {s.windowSessions}/{s.baselineSessions}
        </span>
        <span className="pc-ekg__age" title="Shift window day">
          {dateShort(s.windowDate)}
        </span>
        {s.attributed ? (
          <span
            className="pc-ekg__attributed"
            title={s.ledgerCandidates
              .map(
                (c) =>
                  `${c.source} ${c.target}${c.summary ? ` — ${c.summary}` : ""}`,
              )
              .join("\n")}
          >
            {s.ledgerCandidates.length} cause
            {s.ledgerCandidates.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span
            className="pc-ekg__alarm"
            title="No behavior-change-ledger entry in the lookback window"
          >
            unattributable
          </span>
        )}
      </span>
    </li>
  );

  return (
    <section
      className="pc-learning__section pc-ekg"
      aria-label="Fleet EKG behavioral shifts"
    >
      <LearningPageHeader
        icon={Activity}
        title="Fleet EKG"
        signal={
          major > 0
            ? `${major} major`
            : shifts.length > 0
              ? `${shifts.length} shifts`
              : undefined
        }
        tone={major > 0 ? "bad" : shifts.length > 0 ? "warn" : "good"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the EKG"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "EKG unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : shifts.length === 0 ? (
        // WI-6388: `body` is the design system's own contract for this
        // component (LearningVisuals.tsx: "what this view shows → what makes
        // data appear"), and 10 of 12 uses were title-only. On a fresh install
        // the empty state IS the view, so a bare title is most of the tab's
        // first-run experience. Note this branch now means a GENUINE empty —
        // a failed read renders as an error above (WI-6382).
        <LearningVisualEmpty
          icon={Activity}
          title="No behavioral shifts"
          body="This view compares how the fleet is behaving now against its recent baseline, and flags what changed. Shifts appear here once there is enough recent activity to compare."
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout pc-learning-visual__layout--ekg">
            <LearningHeroMetric
              eyebrow="Current window"
              value={String(shifts.length)}
              status={major > 0 ? "major drift" : "monitor"}
              tone={major > 0 ? "bad" : "warn"}
            >
              {snap!.totalShifts} total · {snap!.unattributedShifts}{" "}
              unattributed
            </LearningHeroMetric>
            <div
              className="pc-ekg__wave"
              aria-label="Behavioral shift magnitude"
            >
              {shifts.slice(0, 28).map((shift) => (
                <i
                  key={shift.id}
                  className={`is-${shift.severity}`}
                  style={{
                    height: `${Math.max(12, Math.min(100, shift.score * 100))}%`,
                  }}
                  title={`${shift.feature}: ${shift.score.toFixed(3)}`}
                />
              ))}
            </div>
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Window</span>
                  <strong>{shifts.length}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>All shifts</span>
                  <strong>{snap!.totalShifts}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Unattributed</span>
                  <strong>{snap!.unattributedShifts}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Major</span>
                  <strong>{major}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          <div className="pc-learning__sectionhead">
            <h2>Detected shifts</h2>
          </div>
          <ul className="pc-ekg__list">{visible.map(renderShift)}</ul>
          {earlier.length > 0 ? (
            <LearningDisclosure label="Earlier shifts" count={earlier.length}>
              <ul className="pc-ekg__list">{earlier.map(renderShift)}</ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
      <style>{`
        .pc-ekg__wave { min-height: 120px; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-2); }
        .pc-ekg__wave::before { content: ''; width: 1px; height: 100%; background: var(--border); }
        .pc-ekg__wave i { width: min(16px, 4%); min-height: 10px; border-radius: 2px; background: #fbbf24; }
        .pc-ekg__wave i.is-major { background: #fb7185; }
        .pc-ekg__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .pc-ekg__row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-top: 1px solid rgba(255, 255, 255, 0.04); }
        .pc-ekg__severity { flex: none; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: #06121a; border-radius: 4px; padding: 1px 5px; background: #fcd34d; }
        .pc-ekg__severity.is-major { background: #fb7185; }
        .pc-ekg__feature { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
        .pc-ekg__dir { margin-left: 4px; font-style: normal; color: var(--fg-mute, #7f9bb4); }
        .pc-ekg__meta { flex: none; display: inline-flex; gap: 8px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-ekg__age { opacity: 0.85; }
        .pc-ekg__attributed { color: #34d399; font-weight: 650; }
        .pc-ekg__alarm { color: #fb7185; font-weight: 650; }
      `}</style>
    </section>
  );
}

export default EkgPanel;
