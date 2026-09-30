/**
 * FrontierPanel — the Verify-stage frontier lane-status grid
 * (learning-tab-visibility-2026-07-18 P-003/P-004).
 *
 * One row per workspace-singleton learning loop (`learning.frontier` sync
 * query), answering the relight audit's three-gate question at a glance — a
 * loop is genuinely live only when routine active + flag ON + governor budget:
 *
 *   lane · liveness (firing / pending / stale / dark-by-design /
 *   should-be-on-but-dark / absent, from the SAME reader
 *   improvements:learning_loops uses) · flag gate · governor budget
 *   (READ-ONLY, owner decision 2026-07-18) · last activity.
 *
 * Self-contained (own sync query + pc-frontier__* styles, the
 * RedQueenPanel/EkgPanel idiom) so the LearningTab wiring stays at two lines.
 * Defensive about the snapshot shape — anything unexpected renders the empty
 * state, never a crash.
 */
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { Radar, RefreshCw } from "lucide-react";
import type { FrontierSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-frontier-read";
import { snapshotFault } from "./snapshot-fault";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualError,
} from "./LearningVisuals";

const STATUS_META: Record<
  string,
  { label: string; tone: "good" | "warn" | "bad" | "mute"; hint: string }
> = {
  firing: {
    label: "firing",
    tone: "good",
    hint: "Active and fired within the stale window.",
  },
  pending: {
    label: "pending",
    tone: "mute",
    hint: "Just armed — its first fire is still ahead.",
  },
  stale: {
    label: "stale",
    tone: "bad",
    hint: "Active but has NOT fired within the stale window — a wedge; investigate.",
  },
  "dark-by-design": {
    label: "dark",
    tone: "mute",
    hint: "A frontier loop, deliberately inactive until armed.",
  },
  "should-be-on-but-dark": {
    label: "DARK (should be on)",
    tone: "bad",
    hint: "An always-on loop that is inactive — a real gap.",
  },
  absent: {
    label: "absent",
    tone: "warn",
    hint: "No routine row seeded at all — registration never happened.",
  },
};

function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
}

export function FrontierPanel({
  hive = "",
  hiveReady = true,
  onStatus,
  active = true,
}: {
  /** Pot lens (pot-scope-all-learnings P-005): lanes belonging to another pot
   *  are filtered server-side; empty = workspace-wide (no lens). */
  hive?: string;
  /** WI-5412 gate: don't fetch until the tab's hive lens is resolved. */
  hiveReady?: boolean;
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263). */
  active?: boolean;
} = {}) {
  const sync = useSyncQuery<FrontierSnapshot>({
    queryName: "learning.frontier",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const snap = sync.data?.[0];
  const lanes = Array.isArray(snap?.lanes) ? snap.lanes : [];

  // View health for the stage chip: an always-on loop dark/stale/absent is bad;
  // a collision, a stale frontier lane, or an armed-but-unbudgeted lane warns.
  // WI-6382: a degraded read is a FAULT, not an idle "no lanes yet".
  const fault = snapshotFault(sync.error, snap, "The frontier read");
  const status: "neutral" | "good" | "warn" | "bad" =
    lanes.length === 0
      ? fault.failed
        ? "bad"
        : "neutral"
      : lanes.some(
            (l) =>
              l.status === "should-be-on-but-dark" ||
              l.status === "stale" ||
              (l.status === "absent" && l.expectedMaterialized),
          )
        ? "bad"
        : lanes.some(
              (l) =>
                l.collision ||
                (l.active && l.flagOn === false) ||
                (l.active && l.governor != null && l.governor.budgetUsd == null),
            )
          ? "warn"
          : "good";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732). `enabled: hiveReady` above means settled
  // correctly stays false while the lens is unresolved.
  const frontierSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    frontierSettled,
    active,
  );

  return (
    <section className="pc-learning__section pc-frontier" aria-label="Frontier learning lanes">
      <LearningPageHeader
        icon={Radar}
        title="Frontier lanes"
        generatedAt={snap?.generatedAt}
        question="Which learning loops are actually alive — routine firing, flag ON, budget set?"
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload frontier lanes"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "The frontier read failed"}
          onRetry={() => sync.invalidate()}
        />
      ) : sync.loading && !snap ? (
        <p className="pc-learning__quietempty">Loading frontier lanes…</p>
      ) : lanes.length === 0 ? (
        // WI-6388: the old title asserted a CAUSE it cannot establish — "the
        // singleton materializer has not run on this workspace". Two problems.
        // (a) A public user has no idea what a singleton materializer is; it is
        // a debugging note addressed to whoever wrote the subsystem. (b) It is
        // a specific, authoritative diagnosis that may simply be FALSE: until
        // WI-6382 an unreadable substrate arrived here as a normal empty, so
        // this line confidently sent the reader to investigate the wrong thing.
        // Now that a degraded read renders as an error above, THIS branch means
        // a genuine observed empty — so say what the view is for and what makes
        // data appear, and claim nothing about why it hasn't yet.
        <LearningVisualEmpty
          icon={Radar}
          title="No learning loops yet"
          body="This view tracks each automated learning loop in the workspace — whether it is running, and whether what it produces is actually used. Loops appear here once one has run at least once."
        />
      ) : (
        <div className="pc-frontier__scroll">
          <table className="pc-frontier__grid">
            <thead>
              <tr>
                <th scope="col">lane</th>
                <th scope="col">liveness</th>
                <th scope="col">flag</th>
                <th scope="col">budget</th>
                <th scope="col">spent</th>
                <th scope="col" title="What the lane has actually PRODUCED — and whether that output loop closes. A lane can fire forever and produce nothing; this column is the difference.">
                  produced
                </th>
                <th scope="col">last activity</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((l) => {
                const meta = STATUS_META[l.status] ?? {
                  label: l.status,
                  tone: "mute" as const,
                  hint: "",
                };
                const lastAt = l.activityLastAt ?? l.lastFiredAt;
                return (
                  <tr key={l.blueprintId}>
                    <th scope="row">
                      <span
                        title={
                          l.alwaysOn
                            ? "Always-on workspace loop."
                            : "Frontier loop (armed deliberately, per-lane)."
                        }
                      >
                        {l.blueprintId}
                        {l.alwaysOn ? <em> · always-on</em> : null}
                        {l.collision ? (
                          <em
                            className="pc-frontier__flag--warn"
                            title="BOTH a @singleton and a legacy routine row exist — the migration double-state."
                          >
                            {" "}
                            · collision
                          </em>
                        ) : null}
                      </span>
                    </th>
                    <td>
                      <span
                        className={`pc-frontier__pill pc-frontier__pill--${meta.tone}`}
                        title={meta.hint}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td>
                      {l.flagKey == null ? (
                        <span title="No flag gate — on by construction.">—</span>
                      ) : (
                        <span
                          className={
                            l.flagOn === false
                              ? "pc-frontier__flag--warn"
                              : undefined
                          }
                          title={`${l.flagKey} — flip via /admin/features (never from here).`}
                        >
                          {l.flagOn == null ? "?" : l.flagOn ? "ON" : "OFF"}
                        </span>
                      )}
                    </td>
                    <td
                      title={
                        l.governor
                          ? `Governor registration '${l.governor.loopId}' (${l.governor.budgetKind}, ${l.governor.enforcement}${l.governor.enabled ? "" : ", disabled"}). Budgets are read-only here — set them via the learning-governor tools.`
                          : "No governor registration — the unattended path refuses an unbudgeted loop."
                      }
                    >
                      {l.governor ? (
                        l.governor.budgetUsd == null ? (
                          <span className="pc-frontier__flag--warn">
                            unbudgeted
                          </span>
                        ) : (
                          money(l.governor.budgetUsd)
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{l.governor ? money(l.governor.spentUsd) : "—"}</td>
                    {/* WI-5800: the outcome column. A lane with no wired outcome
                        table reads "—" rather than a fabricated zero. */}
                    <td className="pc-frontier__produced">
                      {l.outcome ? (
                        <>
                          <span className="pc-frontier__prodhead">
                            <strong>{l.outcome.total}</strong>
                            {l.outcome.recent7d > 0 ? (
                              <em title="Produced in the last 7 days.">
                                {" "}
                                +{l.outcome.recent7d} this week
                              </em>
                            ) : (
                              <em title="Nothing produced in the last 7 days.">
                                {" "}
                                none this week
                              </em>
                            )}
                          </span>
                          <span className="pc-frontier__chips">
                            {l.outcome.breakdown.map((b) => (
                              <span
                                key={b.label}
                                className={`pc-frontier__pill pc-frontier__pill--${b.tone ?? "mute"}`}
                              >
                                {b.n} {b.label}
                              </span>
                            ))}
                          </span>
                          <em
                            className={`pc-frontier__closure pc-frontier__closure--${l.outcome.closureTone}`}
                            title="Does this loop CLOSE? A loop that produces findings it never validates is not learning."
                          >
                            {l.outcome.closure}
                          </em>
                        </>
                      ) : (
                        <span title="No outcome table wired for this lane yet — not a zero, an unknown.">
                          —
                        </span>
                      )}
                    </td>
                    <td
                      title={
                        l.activitySource
                          ? `From ${l.activitySource}.`
                          : "From the routine's last_fired_at."
                      }
                    >
                      {ago(lastAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {snap && snap.unmatchedGovernor.length > 0 ? (
            <p
              className="pc-frontier__unmatched"
              title={snap.unmatchedGovernor
                .map((g) => `${g.loopId} (${money(g.budgetUsd)} budget, ${money(g.spentUsd)} spent)`)
                .join(" · ")}
            >
              {snap.unmatchedGovernor.length} governor row
              {snap.unmatchedGovernor.length === 1 ? "" : "s"} matching no lane:{" "}
              {snap.unmatchedGovernor
                .slice(0, 3)
                .map((g) => g.loopId)
                .join(" · ")}
              {snap.unmatchedGovernor.length > 3
                ? ` · +${snap.unmatchedGovernor.length - 3} more (hover for all)`
                : ""}
            </p>
          ) : null}
        </div>
      )}
      <style>{`
      .pc-frontier__scroll { overflow-x: auto; }
      .pc-frontier__grid { width: 100%; border-collapse: collapse; font-size: 11.5px; }
      .pc-frontier__grid th, .pc-frontier__grid td {
        text-align: left; padding: 5px 10px; white-space: nowrap;
        border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.12));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-frontier__grid thead th {
        font-size: 10px; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4); font-weight: 700;
      }
      .pc-frontier__grid tbody th { font-weight: 650; }
      .pc-frontier__grid tbody th em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__pill {
        display: inline-block; padding: 1px 8px; border-radius: 999px;
        font-size: 10px; font-weight: 700;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
      }
      .pc-frontier__pill--good { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 45%, transparent); }
      .pc-frontier__pill--warn { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent); }
      .pc-frontier__pill--bad { color: var(--bad, #f87171); border-color: color-mix(in srgb, var(--bad, #f87171) 45%, transparent); }
      .pc-frontier__pill--mute { color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__flag--warn { color: var(--warn, #fbbf24); font-weight: 700; }
      /* WI-5800 produced column — the one cell allowed to wrap, so the
         breakdown chips + closure line stay legible without widening the grid. */
      .pc-frontier__produced { white-space: normal; min-width: 230px; max-width: 360px; }
      .pc-frontier__prodhead { display: block; }
      .pc-frontier__prodhead strong { font-size: 12.5px; color: var(--fg, #dbeafe); }
      .pc-frontier__prodhead em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__chips { display: flex; flex-wrap: wrap; gap: 3px; margin: 3px 0 2px; }
      .pc-frontier__chips .pc-frontier__pill { font-size: 9.5px; padding: 0 6px; }
      .pc-frontier__closure { display: block; font-style: normal; font-size: 10px; line-height: 1.35; }
      .pc-frontier__closure--good { color: var(--good, #34d399); }
      .pc-frontier__closure--warn { color: var(--warn, #fbbf24); }
      .pc-frontier__closure--bad { color: var(--bad, #f87171); font-weight: 700; }
      .pc-frontier__closure--mute { color: var(--fg-mute, #7f9bb4); }
      .pc-frontier__unmatched { margin: 6px 2px 0; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      `}</style>
    </section>
  );
}
