"use client";

/**
 * RubricsPanel — every rubric in the store with its grading rollup
 * (rubrics-tab-scorecard-ui-2026-07-09 P-001). Reads via `@papercusp/sync`
 * (rubrics.list) — the resolver reuses the SAME store reads rubrics:list /
 * scorecards:list serve agents, so this panel never diverges from what
 * graders see. Row click drills into grading history + scorecard detail
 * (P-002/P-003 — the scorecards.list / rubrics.trend queries are already
 * live server-side).
 */
import { useSyncQuery } from "@papercusp/sync";
import { useEffect, type CSSProperties } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { Table, type TableColumn } from "../harness/Table";
import { Tooltip } from "../harness/Tooltip";
import { PERF_INTERACTIONS } from "./perf/perf-marks";
import { useInteractionSettle } from "./perf/use-interaction-settle";

interface RubricRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: string;
  // Governance provenance (WI-4506): who authored the current document vs who ratified it.
  // The author≠ratifier split (D-012) is the point of the gate rubric's governance.
  proposedBy: string | null;
  ratifiedBy: string | null;
  criteriaCount: number;
  ratingScale: string[];
  methodRef: string | null;
  updatedAt: string;
  scorecardCount: number;
  latestScorecardAt: string | null;
  latestScore10: number | null;
  avgScore10: number | null;
}

// A rubric is LIVE (its spec governs grading) only once `active`. Any other status —
// `proposed`, `draft`, `superseded` — is NOT the enforced spec. The one that is a
// governance ACTION is `proposed`/`draft`: a spec awaiting an independent ratifier
// (D-012 author≠ratifier). We surface that state prominently rather than as one more
// grey row (WI-4506).
function isActive(status: string): boolean {
  return status === "active" || status === "ratified";
}
function awaitsRatification(status: string): boolean {
  return status === "proposed" || status === "draft";
}

/** Shorten a long agent ownerId (su-eb9b7ae3-…) to a stable, readable handle. */
function shortActor(actor: string | null): string {
  if (!actor) return "—";
  const m = /^([a-z]+-[0-9a-f]{4,8})/i.exec(actor);
  return m ? m[1] : actor.length > 16 ? `${actor.slice(0, 15)}…` : actor;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / (60 * 24))}d ago`;
}

export default function RubricsPanel({
  onSelect,
  selectedId = null,
  compact = false,
  collapseUnscored = false,
  onStatus,
  active = true,
}: {
  onSelect?: (rubricId: string) => void;
  selectedId?: string | null;
  compact?: boolean;
  collapseUnscored?: boolean;
  onStatus?: (status: "neutral" | "good" | "warn" | "bad") => void;
  /** True when this pane is the SELECTED Learning-tab view — see
   *  useInteractionSettle (WI-7263). Defaults true for the other consumer of
   *  this panel (the standalone /rubrics page), which is always "active". */
  active?: boolean;
}) {
  const { data, error, loading } = useSyncQuery<RubricRow>({
    queryName: "rubrics.list",
    args: {},
  });
  const rowCount = data?.length ?? 0;
  useEffect(() => {
    onStatus?.(error ? "bad" : rowCount > 0 ? "good" : "neutral");
  }, [error, onStatus, rowCount]);
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points in LearningTab:
  // gated on the PRIMARY read only, settles on a fault as well as success,
  // gated on `active` so a warm-but-inactive pane doesn't emit on a revisit
  // that never remounts (EI-19383745196363732).
  const rubricsSettled = !loading && (data !== undefined || Boolean(error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    rubricsSettled,
    active,
  );

  if (loading) {
    return (
      <div className="pc-rubrics" role="status">
        Loading rubrics…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-rubrics pc-rubrics--error" role="status">
        Rubrics unavailable — {String(error)}
      </div>
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="pc-rubrics" role="status">
        No rubrics in the store yet.
      </div>
    );
  }

  // Prominence (WI-4506): rubrics awaiting an independent ratifier are a governance
  // action, not just another row — hoist them into a banner above the table.
  const awaiting = rows.filter((row) => awaitsRatification(row.status));
  const graded = rows.filter((row) => row.avgScore10 != null);
  const avgScore =
    graded.length > 0
      ? graded.reduce((sum, row) => sum + (row.avgScore10 ?? 0), 0) /
        graded.length
      : null;
  const coverage = rows.length > 0 ? graded.length / rows.length : 0;
  const fresh = rows.filter((row) => {
    if (!row.latestScorecardAt) return false;
    const age = Date.now() - new Date(row.latestScorecardAt).getTime();
    return Number.isFinite(age) && age <= 30 * 24 * 60 * 60 * 1000;
  }).length;

  const columns: TableColumn<RubricRow>[] = [
    {
      key: "rubric",
      header: "Rubric",
      render: (row) => (
        <span className="pc-rubrics__identity">
          <i
            className={`is-${row.status}${awaitsRatification(row.status) ? " is-awaiting" : ""}`}
            aria-hidden
          />
          <span>
            <strong>{row.title}</strong>
            <small>{row.rubricId}</small>
          </span>
        </span>
      ),
    },
    {
      key: "governance",
      header: "Governance",
      render: (row) => (
        <span
          className={`pc-rubrics__gov pc-rubrics__gov--${isActive(row.status) ? "active" : awaitsRatification(row.status) ? "awaiting" : "inactive"}`}
        >
          <span className="pc-rubrics__gov-status">
            {isActive(row.status)
              ? "Active"
              : awaitsRatification(row.status)
                ? "Awaiting ratification"
                : row.status}
          </span>
          <span
            className="pc-rubrics__gov-chain"
            title={`proposed by ${row.proposedBy ?? "unknown"}${
              row.ratifiedBy ? ` · ratified by ${row.ratifiedBy}` : ""
            }`}
          >
            <em>prop</em> {shortActor(row.proposedBy)}
            {isActive(row.status) ? (
              <>
                {" "}
                <em>·&nbsp;ratif</em>{" "}
                {shortActor(row.ratifiedBy)}
                {row.ratifiedBy &&
                row.proposedBy &&
                row.ratifiedBy !== row.proposedBy ? (
                  <b
                    className="pc-rubrics__gov-split"
                    title="Independent ratifier — author ≠ ratifier (D-012)"
                  >
                    ✓ split
                  </b>
                ) : null}
              </>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: "domain",
      header: "Domain",
      render: (row) => (
        <span className="pc-rubrics__domain">{row.characteristic}</span>
      ),
    },
    {
      key: "criteria",
      header: "Coverage",
      render: (row) => (
        <span
          className="pc-rubrics__criteria"
          title={`${row.criteriaCount} criteria`}
        >
          {Array.from(
            { length: Math.min(8, Math.max(1, row.criteriaCount)) },
            (_, index) => (
              <i key={index} />
            ),
          )}
          <small>{row.criteriaCount}</small>
        </span>
      ),
    },
    {
      key: "avgScore",
      header: "Score",
      render: (row) => (
        <span className="pc-rubrics__score">
          <i>
            <span
              style={{
                width: `${Math.max(0, Math.min(100, (row.avgScore10 ?? 0) * 10))}%`,
              }}
            />
          </i>
          <strong>{row.avgScore10?.toFixed(1) ?? "—"}</strong>
        </span>
      ),
      cellStyle: { fontVariantNumeric: "tabular-nums" },
      cellTitle: () =>
        "Read-time 0–10 projection (scale-aware: 3-level pass=10/partial=5/fail=0; extended exemplary=10/pass=8/partial=5/fail=2/severe=0; unknown excluded)",
    },
    {
      key: "scorecards",
      header: "Evidence",
      render: (row) => (
        <span className="pc-rubrics__evidence">{row.scorecardCount}</span>
      ),
    },
    {
      key: "lastGraded",
      header: "Freshness",
      render: (row) => (
        <span
          className={`pc-rubrics__freshness${row.latestScorecardAt ? "" : " is-stale"}`}
        >
          <i aria-hidden />
          {formatWhen(row.latestScorecardAt)}
        </span>
      ),
    },
  ];
  const visibleColumns = compact
    ? columns.filter((column) =>
        ["rubric", "avgScore", "lastGraded"].includes(column.key),
      )
    : columns;
  const primaryRows = collapseUnscored
    ? rows
        .filter((row) => row.avgScore10 != null || row.rubricId === selectedId)
        .sort((a, b) => {
          const aTime = a.latestScorecardAt
            ? new Date(a.latestScorecardAt).getTime()
            : 0;
          const bTime = b.latestScorecardAt
            ? new Date(b.latestScorecardAt).getTime()
            : 0;
          return bTime - aTime || a.title.localeCompare(b.title);
        })
    : rows;
  const unscoredRows = collapseUnscored
    ? rows.filter(
        (row) => row.avgScore10 == null && row.rubricId !== selectedId,
      )
    : [];

  return (
    <section
      className={`pc-rubrics${compact ? " is-compact" : ""}`}
      aria-label="Rubric coverage"
    >
      {!compact && awaiting.length > 0 ? (
        <div
          className="pc-rubrics__awaiting"
          role="status"
          aria-label={`${awaiting.length} rubric${awaiting.length === 1 ? "" : "s"} awaiting ratification`}
        >
          <ShieldAlert size={13} aria-hidden />
          <span className="pc-rubrics__awaiting-lead">
            <strong>{awaiting.length}</strong> awaiting ratification
          </span>
          <span className="pc-rubrics__awaiting-list">
            {awaiting.slice(0, 3).map((row) => (
              <Tooltip
                key={row.rubricId}
                label={`${row.title} — proposed by ${row.proposedBy ?? "unknown"}; needs an independent ratifier (D-012)`}
              >
                <button
                  type="button"
                  className="pc-rubrics__awaiting-item"
                  onClick={onSelect ? () => onSelect(row.rubricId) : undefined}
                >
                  {row.title}
                  <em>prop {shortActor(row.proposedBy)}</em>
                </button>
              </Tooltip>
            ))}
            {awaiting.length > 3 ? (
              <span className="pc-rubrics__awaiting-more">
                +{awaiting.length - 3}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {compact ? (
        <div className="pc-rubrics__compact-summary">
          <span>
            <strong>{rows.length}</strong> rubrics
          </span>
          <span>
            <strong>{avgScore == null ? "—" : avgScore.toFixed(1)}</strong>{" "}
            average
          </span>
          <span>
            <strong>{fresh}</strong> fresh
          </span>
        </div>
      ) : (
        <div className="pc-rubrics__overview">
          <div className="pc-rubrics__hero">
            <span>Average</span>
            <strong>{avgScore == null ? "—" : avgScore.toFixed(1)}</strong>
            <i>/10</i>
          </div>
          <div
            className="pc-rubrics__ring"
            style={
              {
                "--pc-rubric-coverage": `${coverage * 360}deg`,
              } as CSSProperties
            }
          >
            <strong>{Math.round(coverage * 100)}%</strong>
            <span>covered</span>
          </div>
          <div
            className="pc-rubrics__pulse"
            aria-label={`${fresh} recently graded rubrics`}
          >
            {rows.map((row) => (
              <i
                key={row.rubricId}
                className={
                  row.latestScorecardAt &&
                  Date.now() - new Date(row.latestScorecardAt).getTime() <=
                    30 * 24 * 60 * 60 * 1000
                    ? "is-fresh"
                    : undefined
                }
                title={row.title}
              />
            ))}
          </div>
        </div>
      )}
      <div className="pc-rubrics__tablewrap">
        <Table
          caption={`${primaryRows.length} ${collapseUnscored ? "scored " : ""}rubric${primaryRows.length === 1 ? "" : "s"}`}
          columns={visibleColumns}
          rows={primaryRows}
          getRowKey={(row) => row.rubricId}
          onRowClick={onSelect ? (row) => onSelect(row.rubricId) : undefined}
          isRowSelected={
            selectedId ? (row) => row.rubricId === selectedId : undefined
          }
        />
        {unscoredRows.length > 0 ? (
          <Collapsible.Root className="pc-rubrics__unscored">
            <Collapsible.Trigger className="pc-rubrics__unscored-trigger">
              <ChevronDown size={12} aria-hidden />
              <span>Unscored rubrics</span>
              <strong>{unscoredRows.length}</strong>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Table
                caption={`${unscoredRows.length} unscored rubric${unscoredRows.length === 1 ? "" : "s"}`}
                columns={visibleColumns}
                rows={unscoredRows}
                getRowKey={(row) => row.rubricId}
                onRowClick={
                  onSelect ? (row) => onSelect(row.rubricId) : undefined
                }
              />
            </Collapsible.Content>
          </Collapsible.Root>
        ) : null}
      </div>
      <style>{`
        .pc-rubrics { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
        .pc-rubrics__tablewrap { min-height: 0; overflow: auto; }
        .pc-rubrics.is-compact { gap: 7px; }
        .pc-rubrics__compact-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
        .pc-rubrics__compact-summary span { display: inline-flex; align-items: baseline; gap: 4px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--fg-mute); font-size: 9.5px; }
        .pc-rubrics__compact-summary strong { color: var(--fg); font-size: 10.5px; font-variant-numeric: tabular-nums; }
        .pc-rubrics.is-compact table { table-layout: fixed; }
        .pc-rubrics.is-compact th, .pc-rubrics.is-compact td { padding: 5px 6px !important; }
        .pc-rubrics.is-compact th:first-child { width: 54%; }
        .pc-rubrics.is-compact .pc-rubrics__score { grid-template-columns: minmax(32px, 1fr) 24px; gap: 4px; }
        .pc-rubrics__unscored { margin-top: 5px; }
        .pc-rubrics__unscored-trigger { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 6px; padding: 4px 7px; border: 1px dashed var(--border); border-radius: 7px; background: transparent; color: var(--fg-mute); font: inherit; font-size: 10px; cursor: pointer; }
        .pc-rubrics__unscored-trigger svg { transition: transform 140ms ease; }
        .pc-rubrics__unscored-trigger[data-state="open"] svg { transform: rotate(180deg); }
        .pc-rubrics__unscored-trigger strong { margin-left: auto; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
        .pc-rubrics__overview { display: grid; grid-template-columns: minmax(150px, .55fr) 116px minmax(220px, 1.8fr); gap: 10px; align-items: stretch; }
        .pc-rubrics__hero, .pc-rubrics__ring, .pc-rubrics__pulse { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2); }
        .pc-rubrics__hero { display: grid; grid-template-columns: auto 1fr auto; align-items: end; gap: 5px; padding: 13px 15px; }
        .pc-rubrics__hero span { grid-column: 1 / -1; color: var(--fg-mute); font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
        .pc-rubrics__hero strong { color: var(--accent); font-size: 32px; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: 0; }
        .pc-rubrics__hero i { color: var(--fg-mute); font-size: 11px; font-style: normal; }
        .pc-rubrics__ring { position: relative; display: grid; place-content: center; justify-items: center; margin: 0; }
        .pc-rubrics__ring::before { content: ''; position: absolute; inset: 11px; border-radius: 50%; background: conic-gradient(#34d399 var(--pc-rubric-coverage), color-mix(in srgb, var(--fg) 7%, transparent) 0); mask: radial-gradient(circle, transparent 52%, #000 54%); }
        .pc-rubrics__ring strong { color: var(--fg); font-size: 16px; font-variant-numeric: tabular-nums; }
        .pc-rubrics__ring span { color: var(--fg-mute); font-size: 9px; text-transform: uppercase; }
        .pc-rubrics__pulse { display: grid; grid-template-columns: repeat(auto-fit, minmax(8px, 1fr)); align-items: end; gap: 3px; padding: 12px; overflow: hidden; }
        .pc-rubrics__pulse i { min-height: 18px; height: 34%; border-radius: 2px; background: color-mix(in srgb, var(--fg) 9%, transparent); }
        .pc-rubrics__pulse i.is-fresh { height: 86%; background: color-mix(in srgb, var(--accent) 68%, #34d399); }
        /* flex + max-width (not inline-flex): an inline-flex keeps its intrinsic
           content width inside a fixed-layout td, so a long title paints ACROSS
           the neighboring Score cell (owner screenshot 2026-07-18). Block-level
           flex constrained to the cell lets the strong/small ellipsis rules bite. */
        .pc-rubrics__identity { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
        .pc-rubrics__identity > i { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--fg-mute); }
        .pc-rubrics__identity > i.is-ratified, .pc-rubrics__identity > i.is-active { background: #34d399; box-shadow: 0 0 0 3px color-mix(in srgb, #34d399 12%, transparent); }
        .pc-rubrics__identity > i.is-awaiting { background: #fbbf24; box-shadow: 0 0 0 3px color-mix(in srgb, #fbbf24 15%, transparent); }
        .pc-rubrics__awaiting { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px; padding: 7px 10px; border: 1px solid color-mix(in srgb, #fbbf24 45%, var(--border)); border-radius: 9px; background: color-mix(in srgb, #fbbf24 9%, var(--bg-2)); color: var(--fg); }
        .pc-rubrics__awaiting > svg { color: #f59e0b; flex: none; }
        .pc-rubrics__awaiting-lead { font-size: 10.5px; color: var(--fg-mute); }
        .pc-rubrics__awaiting-lead strong { color: #f59e0b; font-size: 12px; font-variant-numeric: tabular-nums; }
        .pc-rubrics__awaiting-list { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; }
        .pc-rubrics__awaiting-item { display: inline-flex; align-items: baseline; gap: 5px; max-width: 260px; padding: 3px 8px; border: 1px solid color-mix(in srgb, #fbbf24 40%, var(--border)); border-radius: 999px; background: var(--bg-1); color: var(--fg); font: inherit; font-size: 10px; cursor: pointer; overflow: hidden; }
        .pc-rubrics__awaiting-item:hover { border-color: #f59e0b; }
        .pc-rubrics__awaiting-item em { color: var(--fg-mute); font-style: normal; font-family: var(--font-mono, ui-monospace, monospace); font-size: 8.5px; white-space: nowrap; }
        .pc-rubrics__awaiting-more { color: var(--fg-mute); font-size: 9.5px; }
        .pc-rubrics__gov { display: inline-grid; gap: 2px; min-width: 0; }
        .pc-rubrics__gov-status { font-size: 9.5px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
        .pc-rubrics__gov--active .pc-rubrics__gov-status { color: #34d399; }
        .pc-rubrics__gov--awaiting .pc-rubrics__gov-status { color: #f59e0b; }
        .pc-rubrics__gov--inactive .pc-rubrics__gov-status { color: var(--fg-mute); }
        .pc-rubrics__gov-chain { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 3px; color: var(--fg-mute); font-family: var(--font-mono, ui-monospace, monospace); font-size: 9px; }
        .pc-rubrics__gov-chain em { color: color-mix(in srgb, var(--fg-mute) 75%, transparent); font-style: normal; }
        .pc-rubrics__gov-split { display: inline-flex; align-items: center; margin-left: 3px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, #34d399 16%, transparent); color: #34d399; font-size: 8.5px; font-weight: 700; }
        .pc-rubrics__identity span { min-width: 0; }
        .pc-rubrics__identity strong, .pc-rubrics__identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-rubrics__identity small { margin-top: 2px; color: var(--fg-mute); font-family: var(--font-mono, ui-monospace, monospace); font-size: 9px; }
        .pc-rubrics__domain { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--fg-mute); font-size: 10px; }
        .pc-rubrics__criteria { display: inline-flex; align-items: center; gap: 2px; }
        .pc-rubrics__criteria i { width: 4px; height: 13px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 62%, transparent); }
        .pc-rubrics__criteria small { margin-left: 4px; color: var(--fg-mute); font-size: 9px; }
        .pc-rubrics__score { display: grid; grid-template-columns: minmax(52px, 1fr) 26px; align-items: center; gap: 7px; }
        .pc-rubrics__score > i { height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--fg) 7%, transparent); }
        .pc-rubrics__score > i span { display: block; height: 100%; border-radius: inherit; background: #34d399; }
        .pc-rubrics__score strong { color: var(--fg); font-size: 10px; text-align: right; }
        .pc-rubrics__evidence { display: inline-grid; place-items: center; min-width: 28px; height: 22px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); font-size: 10px; font-weight: 700; }
        .pc-rubrics__freshness { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-mute); font-size: 10px; }
        .pc-rubrics__freshness i { width: 6px; height: 6px; border-radius: 50%; background: #34d399; }
        .pc-rubrics__freshness.is-stale i { background: #fbbf24; }
        @container learning (max-width: 760px) { .pc-rubrics__overview { grid-template-columns: 1fr 100px; } .pc-rubrics__pulse { grid-column: 1 / -1; min-height: 54px; } }
      `}</style>
    </section>
  );
}
