"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { toast } from "sonner";
import { FLAGS } from "@papercusp/flags";
import type {
  ExternalTriggerAdminSnapshot,
  ExternalTriggerBindingAdminRow,
  ExternalTriggerRunAdminRow,
  ExternalTriggerSocialAdminFacts,
} from "@papercusp/operator-core/lib/external-triggers/admin";
import { Table, type TableColumn } from "@/app/harness/Table";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { useFlag } from "@/lib/flag-hooks";
import {
  TriggerBindingCard,
  formatTriggerTime as formatTime,
  numberFromPolicy,
} from "./TriggerBindingCard";
import { fetchTriggerAdminSnapshot, patchTriggerAdmin } from "./trigger-admin-api";
import "./triggers.css";

type View = "bindings" | "sources" | "runs";
type LoadState = "loading" | "ok" | "error";
/** Sources view filter. Social sources are the ones with a rate budget worth watching. */
type SourceScope = "all" | "social";

export const MANUAL_REVIEW_IDLE_MS = 24 * 60 * 60 * 1_000;

/**
 * Runs with durable open work and no current agent are the manual-review queue.
 * The progress fraction remains the canonical detail; this ageing projection
 * makes unattended work visible before it quietly becomes archaeology.
 */
export function idleManualReviewRuns(
  runs: readonly ExternalTriggerRunAdminRow[],
  nowMs = Date.now(),
): ExternalTriggerRunAdminRow[] {
  return runs.filter((run) => {
    const planRun = run.planRun;
    if (!planRun || planRun.workItems.open <= 0 || planRun.agents.length > 0) return false;
    const triggeredAtMs = Date.parse(run.triggeredAt);
    return Number.isFinite(triggeredAtMs) && nowMs - triggeredAtMs >= MANUAL_REVIEW_IDLE_MS;
  });
}

/**
 * Render a cursor-freshness verdict (P-027).
 *
 * The four states are NOT collapsed into "last synced <time>" on purpose:
 * `position-only` means the platform's cursor carries no timestamp at all
 * (reddit's `t3_…` fullname, a bluesky `seq` before any event landed), so
 * showing it as "never synced" would report a healthy integration as dead.
 */
function cursorLabel(cursor: ExternalTriggerSocialAdminFacts["cursor"]): {
  tone: "ok" | "warn" | "idle";
  text: string;
} {
  switch (cursor.state) {
    case "synced":
      return { tone: "ok", text: `synced · ${formatAge(cursor.ageMs)}` };
    case "position-only":
      return { tone: "ok", text: `advancing · ${cursor.position} · no timestamp on this platform` };
    case "never-synced":
      return { tone: "idle", text: "never synced — no cursor persisted yet" };
    case "unrecognized":
      return { tone: "warn", text: `unreadable cursor — ${cursor.detail}` };
    default:
      return { tone: "warn", text: cursor.detail };
  }
}

/** Compact age. Negative means the provider instant is AHEAD of us — a skew signal, shown not hidden. */
function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "unknown age";
  if (ageMs < 0) return `${formatAge(-ageMs)} in the future (clock skew)`;
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function SocialSourceFacts({ social }: { social: ExternalTriggerSocialAdminFacts }) {
  const cursor = cursorLabel(social.cursor);
  const budget = social.rateBudget;
  return (
    <div className="tr-social" data-platform={social.platformId}>
      <div className="tr-meta">
        <span className="tr-badge tr-social-platform">{social.label}</span>
        <span className="tr-social-tag">wave {social.wave}</span>
        <span className="tr-social-tag">{social.authMode}</span>
        <span className="tr-social-tag">{social.readTransport}</span>
        {!social.verified && (
          <span className="tr-badge status-error" title="Registry row is not verified against its cited sources">
            unverified
          </span>
        )}
        {social.blockedOn && (
          // An owner-side wall (Meta app review, a TikTok audit). Distinct from
          // "not connected": nobody can clear this from the pane.
          <span className="tr-badge status-degraded" title={social.blockedOn}>
            blocked: {social.blockedOn}
          </span>
        )}
      </div>
      <div className={`tr-meta tr-social-cursor tone-${cursor.tone}`}>cursor: {cursor.text}</div>
      <div className="tr-meta">
        {budget.hold ? (
          // A hold is not a cap of zero: the provider told us to stop, and it expires.
          <span className="tr-social-hold">
            budget HELD: {budget.hold.reason}
            {budget.hold.retryForbidden ? " · retry forbidden (retrying extends the block)" : ""}
            {budget.hold.untilMs === null ? " · no stated duration" : ` · ~${formatAge(-budget.hold.untilMs)}`}
          </span>
        ) : (
          <>
            budget: up to {budget.maxRuns} run{budget.maxRuns === 1 ? "" : "s"} / {budget.windowSeconds}s
            {" "}({budget.basis})
          </>
        )}
      </div>
      <div className="tr-meta">
        write: {social.writeVerbs.length ? social.writeVerbs.join(", ") : "none"}
        {" · "}
        {social.writeVerified ? "verified" : "UNVERIFIED — writes refused"}
      </div>
    </div>
  );
}

const VIEW_LABELS: Record<View, string> = {
  bindings: "Bindings",
  sources: "Sources",
  runs: "Recent runs",
};

const RUN_COLUMNS = [
  {
    key: "status",
    header: "Policy",
    render: (run) => (
      <span className={`tr-badge run-${run.policyDisposition ?? run.status}`}>
        {run.policyDetail ?? run.status}
      </span>
    ),
  },
  {
    key: "event",
    header: "Event",
    render: (run) => (
      <>
        <code>{run.eventPattern}</code>
        <small>{run.causeSummary ?? run.sourceKind}</small>
      </>
    ),
  },
  {
    key: "plan",
    header: "Target",
    render: (run) => {
      const operation = run.blueprintOperation;
      const instance = run.planRun?.instancePlanSlug;
      const progress = run.planRun?.workItems.total
        ? `${run.planRun.workItems.passed}/${run.planRun.workItems.total}`
        : null;
      return (
        <>
          {operation?.target.kind === "work-item" ? (
            <a href={`/admin/work-items?item=${encodeURIComponent(operation.target.id)}`}>
              {operation.harnessSlug}#{operation.operationId} → {operation.target.id}
            </a>
          ) : operation?.target.kind === "plan" ? (
            <a href={`/admin/plans?plan=${encodeURIComponent(operation.target.instanceSlug)}`}>
              {operation.harnessSlug}#{operation.operationId} → {operation.target.instanceSlug}
            </a>
          ) : instance ? (
            <a href={`/admin/plans?plan=${encodeURIComponent(instance)}`}>{instance}</a>
          ) : run.workItemHarnessSlug && run.workItemKind ? (
            `${run.workItemHarnessSlug}/${run.workItemKind}`
          ) : run.goalId ? (
            `goal ${run.goalId}`
          ) : `${run.planHarnessSlug ?? "unknown"}/${run.planSlug ?? "unknown"}`}
          {run.planRun ? (
            <small>
              {[run.planRun.status, progress, run.planRun.agents.length ? `${run.planRun.agents.length} agent${run.planRun.agents.length === 1 ? "" : "s"}` : null]
                .filter(Boolean)
                .join(" · ")}
            </small>
          ) : null}
        </>
      );
    },
  },
  { key: "attempts", header: "Attempts", render: (run) => run.attempts },
  {
    key: "triggered",
    header: "Triggered",
    render: (run) => formatTime(run.triggeredAt),
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (run) => {
      const link = run.outcomeLinks?.[0];
      if (link?.href) return <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>;
      return run.error ?? link?.label ?? (run.planRunRef ? `plan run ${run.planRunRef}` : "—");
    },
  },
] satisfies TableColumn<ExternalTriggerRunAdminRow>[];

export default function TriggersClient() {
  const flagEnabled = useFlag(FLAGS.TRIGGERS_ADMIN);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [view, setView] = useQueryState(
    "view",
    parseAsStringEnum<View>(["bindings", "sources", "runs"]).withDefault(
      "bindings",
    ),
  );
  const [selectedBindingId, setSelectedBindingId] = useQueryState(
    "binding",
    parseAsString,
  );
  // nuqs, not useState: a filter is user-meaningful state, so it must survive a
  // reload AND be drivable by an agent through ui:get_state / ui:dispatch.
  const [sourceScope, setSourceScope] = useQueryState(
    "sources",
    parseAsStringEnum<SourceScope>(["all", "social"]).withDefault("all"),
  );
  const [payload, setPayload] = useState<ExternalTriggerAdminSnapshot | null>(
    null,
  );
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [maxRuns, setMaxRuns] = useState("");
  const [windowSeconds, setWindowSeconds] = useState("60");

  const load = useCallback(async () => {
    if (!flagEnabled) return;
    setState("loading");
    try {
      const body = await fetchTriggerAdminSnapshot();
      setPayload(body);
      setState("ok");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [flagEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedBinding = useMemo(
    () =>
      payload?.bindings.find((binding) => binding.id === selectedBindingId) ??
      null,
    [payload, selectedBindingId],
  );

  const visibleSources = useMemo(
    () =>
      (payload?.sources ?? []).filter((source) =>
        sourceScope === "social" ? source.social !== null : true,
      ),
    [payload, sourceScope],
  );
  const idleReviewRuns = useMemo(
    () => idleManualReviewRuns(payload?.recentRuns ?? []),
    [payload],
  );

  useEffect(() => {
    if (!selectedBinding) return;
    const limit = numberFromPolicy(
      selectedBinding.stormPolicy,
      "maxRuns",
      "max_runs",
    );
    const window = numberFromPolicy(
      selectedBinding.stormPolicy,
      "windowSeconds",
      "window_seconds",
    );
    setMaxRuns(limit === null ? "" : String(limit));
    setWindowSeconds(String(window ?? 60));
  }, [selectedBinding]);

  const patch = useCallback((body: Record<string, unknown>) => patchTriggerAdmin(body), []);

  const setArmed = useCallback(
    async (binding: ExternalTriggerBindingAdminRow, armed: boolean) => {
      const verb = armed ? "Arm" : "Disarm";
      const consequence = armed
        ? "Matching events may immediately start this plan."
        : "Matching events will stop starting this plan until it is armed again.";
      if (
        !(await askConfirm({
          title: `${verb} ${binding.eventPattern}?`,
          body: consequence,
          confirmLabel: verb,
          destructive: armed,
        }))
      )
        return;
      setBusy(`armed:${binding.id}`);
      try {
        await patch({ op: "set-armed", id: binding.id, armed, confirm: true });
        toast.success(
          `${binding.eventPattern} ${armed ? "armed" : "disarmed"}`,
        );
        await load();
      } catch (cause) {
        toast.error(`${verb} failed`, {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(null);
      }
    },
    [askConfirm, load, patch],
  );

  const saveStormPolicy = useCallback(async () => {
    if (!selectedBinding) return;
    const parsedMax = maxRuns.trim() === "" ? null : Number(maxRuns);
    const parsedWindow = Number(windowSeconds);
    if (
      (parsedMax !== null &&
        (!Number.isInteger(parsedMax) || parsedMax <= 0)) ||
      !Number.isInteger(parsedWindow) ||
      parsedWindow <= 0
    ) {
      toast.error("Storm policy needs positive whole numbers");
      return;
    }
    setBusy(`storm:${selectedBinding.id}`);
    try {
      await patch({
        op: "set-storm-policy",
        id: selectedBinding.id,
        maxRuns: parsedMax,
        windowSeconds: parsedWindow,
      });
      toast.success("Storm policy saved");
      await load();
      await setSelectedBindingId(null);
    } catch (cause) {
      toast.error("Storm policy update failed", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  }, [
    load,
    maxRuns,
    patch,
    selectedBinding,
    setSelectedBindingId,
    windowSeconds,
  ]);

  if (!flagEnabled) {
    return (
      <div className="tr-shell tr-disabled">
        External trigger administration is switched off.
      </div>
    );
  }

  return (
    <main className="tr-shell">
      {confirmEl}
      <section className="tr-intro" aria-labelledby="tr-title">
        <div>
          <span className="tr-kicker">Triggered plans</span>
          <h2 id="tr-title">External trigger control</h2>
          <p>
            Review source health and plan bindings. New bindings stay off until
            an owner deliberately arms them.
          </p>
        </div>
        <button
          type="button"
          className="tr-button tr-button-secondary"
          onClick={() => void load()}
          disabled={state === "loading"}
        >
          Refresh
        </button>
      </section>

      {state === "loading" && (
        <div className="tr-state" role="status" aria-live="polite">
          Loading triggers…
        </div>
      )}
      {state === "error" && (
        <div className="tr-state tr-state-error" role="alert">
          <span>Trigger data could not be loaded: {error}</span>
          <button
            type="button"
            className="tr-button tr-button-secondary"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}
      {state === "ok" && payload && !payload.enabled && (
        <div className="tr-state">
          External trigger administration is switched off.
        </div>
      )}
      {state === "ok" && payload?.enabled && (
        <>
          <section className="tr-metrics" aria-label="Trigger summary">
            <Metric label="Sources" value={payload.counts.sources} />
            <Metric label="Bindings" value={payload.counts.bindings} />
            <Metric label="Armed" value={payload.counts.armed} tone="good" />
            <Metric
              label="Failures · 24h"
              value={payload.counts.recentFailures}
              tone={payload.counts.recentFailures > 0 ? "bad" : "neutral"}
            />
          </section>

          <nav className="tr-tabs" aria-label="Trigger admin views">
            {(Object.keys(VIEW_LABELS) as View[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`tr-tab${view === candidate ? " active" : ""}`}
                aria-pressed={view === candidate}
                onClick={() => void setView(candidate)}
              >
                {VIEW_LABELS[candidate]}
              </button>
            ))}
          </nav>

          {view === "bindings" && (
            <section className="tr-list" aria-label="Trigger bindings">
              {payload.bindings.length === 0 && (
                <Empty message="No trigger bindings yet. Create one with the triggers agent verbs; it will start off." />
              )}
              {payload.bindings.map((binding) => (
                <TriggerBindingCard
                  key={binding.id}
                  binding={binding}
                  busy={busy !== null}
                  onSetArmed={(row, armed) => void setArmed(row, armed)}
                  onStormPolicy={(row) => void setSelectedBindingId(row.id)}
                />
              ))}
            </section>
          )}

          {view === "sources" && (
            <section className="tr-list" aria-label="Trigger sources">
              <div className="tr-filter-row" role="group" aria-label="Filter sources">
                {(["all", "social"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    className={`tr-filter${sourceScope === scope ? " is-active" : ""}`}
                    aria-pressed={sourceScope === scope}
                    onClick={() => void setSourceScope(scope)}
                  >
                    {scope === "all"
                      ? `All (${payload.sources.length})`
                      : `Social (${payload.sources.filter((s) => s.social).length})`}
                  </button>
                ))}
              </div>
              {visibleSources.length === 0 && (
                <Empty
                  message={
                    sourceScope === "social"
                      ? "No social sources are connected yet."
                      : "No external sources are configured yet."
                  }
                />
              )}
              {visibleSources.map((source) => (
                <article key={source.id} className="tr-card">
                  <div className="tr-card-main">
                    <div className="tr-card-heading">
                      <strong>{source.kind}</strong>
                      <span className={`tr-badge status-${source.status}`}>
                        {source.status}
                      </span>
                    </div>
                    <div className="tr-meta">
                      {source.bindingCount} binding
                      {source.bindingCount === 1 ? "" : "s"} ·{" "}
                      {source.armedBindingCount} armed
                    </div>
                    <div className="tr-meta">
                      last connected: {formatTime(source.lastConnectedAt)}
                    </div>
                    <div className="tr-meta">
                      credential:{" "}
                      {source.credentialRef ? "configured" : "not configured"} ·
                      failures 24h: {source.failedDeliveries24h}
                    </div>
                    {source.social && <SocialSourceFacts social={source.social} />}
                    {source.lastError && (
                      <div className="tr-error-copy">{source.lastError}</div>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}

          {view === "runs" && (
            <section className="tr-table-wrap" aria-label="Recent trigger runs">
              {idleReviewRuns.length > 0 && (
                <div className="tr-state" role="status">
                  Needs review: {idleReviewRuns.length} trigger run
                  {idleReviewRuns.length === 1 ? " has" : "s have"} open work and no agent for at least 24h.
                </div>
              )}
              {payload.recentRuns.length === 0 ? (
                <Empty message="No external-trigger runs have fired yet." />
              ) : (
                <Table
                  className="tr-table"
                  columns={RUN_COLUMNS}
                  rows={payload.recentRuns}
                  getRowKey={(run) => run.id}
                />
              )}
            </section>
          )}
        </>
      )}

      {selectedBinding && (
        <div
          className="tr-drawer-backdrop"
          role="presentation"
          onMouseDown={() => void setSelectedBindingId(null)}
        >
          <aside
            className="tr-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tr-storm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="tr-drawer-head">
              <div>
                <span className="tr-kicker">
                  {selectedBinding.eventPattern}
                </span>
                <h3 id="tr-storm-title">Storm policy</h3>
              </div>
              <button
                type="button"
                className="tr-close"
                aria-label="Close storm policy"
                onClick={() => void setSelectedBindingId(null)}
              >
                ×
              </button>
            </div>
            <p>
              Bound how many plan runs this binding may start inside a rolling
              window. Leave maximum runs blank for no bound.
            </p>
            <label>
              Maximum runs
              <input
                type="number"
                min={1}
                value={maxRuns}
                onChange={(event) => setMaxRuns(event.target.value)}
                placeholder="Unlimited"
              />
            </label>
            <label>
              Window in seconds
              <input
                type="number"
                min={1}
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(event.target.value)}
              />
            </label>
            <div className="tr-drawer-actions">
              <button
                type="button"
                className="tr-button tr-button-secondary"
                onClick={() => void setSelectedBindingId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="tr-button"
                disabled={busy !== null}
                onClick={() => void saveStormPolicy()}
              >
                Save policy
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div className={`tr-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <div className="tr-empty">{message}</div>;
}
