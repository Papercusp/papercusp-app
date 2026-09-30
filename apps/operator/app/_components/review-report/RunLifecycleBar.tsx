"use client";

/**
 * RunLifecycleBar (bulk-review-report-legibility-and-lifecycle-2026-08-31
 * P-007, D-004) — the run's own state and the controls that act on the RUN,
 * as opposed to the findings inside it.
 *
 * Why this exists: `stop`, `restart`, `resume`, `recheck-finding` and
 * `dismiss-finding` have always been on the plan-cleanup route, but the only
 * surface wiring them is the progress strip — and the strip is REPLACED by the
 * report takeover the moment the run settles. So from the report, the entire
 * action set was Apply-selected and Close, and a run that stopped halfway was a
 * dead end.
 *
 * It is deliberately a PURE projection of `phase` + `liveness` + counts, all of
 * which both run shapes already carry, and it emits typed intents rather than
 * calling ops itself. That is what lets Plans and Inbox share one bar without
 * sharing their data layers (D-002).
 */
import type { ReactNode } from "react";
import type { RunLiveness } from "@papercusp/operator-core/lib/attention/bulk-run-store";
import "./run-lifecycle-bar.css";

export type RunLifecycleIntent =
  /** Start a fresh run over the same scope. */
  | "rerun"
  /** Assess what this run never reached. */
  | "resume"
  /** Relaunch a resolver that stopped reporting, keeping the run. */
  | "restart"
  /** Settle an executing run now, keeping what it has found. */
  | "stop"
  /** Re-derive every pending finding against current state. */
  | "recheck"
  /** Deliberately bypass the recorded-state precondition after a real refusal. */
  | "apply-anyway"
  /** Reveal the rows a summary line is talking about. */
  | "reveal";

export type RunLifecycleTone = "live" | "good" | "warn" | "bad";

export interface RunLifecycleActionSpec {
  intent: RunLifecycleIntent;
  label: string;
  tone?: "primary" | "warn" | "danger" | "ghost";
}

export interface RunLifecycleState {
  tone: RunLifecycleTone;
  icon: string;
  headline: string;
  detail: string;
  actions: RunLifecycleActionSpec[];
  /** 0–1, or null when the run's own progress is not measurable yet. */
  progress?: number | null;
}

export interface RunLifecycleInput {
  phase: "pending" | "running" | "review" | "complete" | "failed";
  liveness?: RunLiveness | null;
  /** Total findings/items the run has produced so far. */
  total: number;
  /** Decided one way or another (applied, dismissed, recommended). */
  decided: number;
  /** Produced but never judged — the resume target. */
  notAssessed: number;
  /** Auto-applied without asking. */
  autoApplied: number;
  /** Still awaiting the owner. */
  open: number;
  /** Run-level failure text, when the run itself failed. */
  error?: string | null;
  /** Age of the run's newest evidence, for the staleness warning. */
  ageMs?: number | null;
  /** Findings whose recorded `from` no longer matches current state. */
  staleRows?: number;
  /** Applying right now: how many of how many have been written. */
  applying?: { done: number; total: number; current?: string } | null;
  /** The result of the apply that just finished. */
  applyResult?: { applied: number; failed: number } | null;
  /** The word for one unit in this flow: "finding" or "item". */
  unit?: string;
}

/** Older than this and a report's recorded `from` states are worth re-checking
 *  before they are written over newer work. Deliberately generous: the
 *  precondition on the write is the real guard (D-003), and this banner only
 *  saves the owner a round trip. */
export const REPORT_STALE_AFTER_MS = 6 * 60 * 60_000;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

/**
 * The state machine, exported so it is testable without React.
 *
 * Order matters and encodes priority: what is happening NOW (an apply in
 * flight, its result) outranks what the run is, and a resolver that stopped
 * reporting outranks the phase it is nominally still in.
 */
export function deriveRunLifecycleState(
  input: RunLifecycleInput,
): RunLifecycleState {
  const unit = input.unit ?? "finding";

  if (input.applying) {
    const { done, total, current } = input.applying;
    return {
      tone: "live",
      icon: "◐",
      headline: `Applying ${total} ${total === 1 ? "fix" : "fixes"} — ${done} done`,
      detail: current ? `Writing ${current}` : "Writing changes one at a time.",
      progress: total > 0 ? done / total : null,
      actions: [{ intent: "stop", label: "Stop after this one", tone: "warn" }],
    };
  }

  if (input.applyResult && input.applyResult.failed > 0) {
    const { applied, failed } = input.applyResult;
    return {
      tone: "warn",
      icon: "!",
      headline: `${applied} applied, ${failed} failed`,
      detail: "Nothing was left half-written. Each failed row says why, below.",
      actions: [
        {
          intent: "recheck",
          label: `Re-check and retry ${failed}`,
          tone: "warn",
        },
        { intent: "reveal", label: "Show only failures", tone: "ghost" },
      ],
    };
  }

  if (input.phase === "failed") {
    return {
      tone: "bad",
      icon: "✕",
      headline: "This run failed",
      detail:
        input.error?.trim() ||
        "The resolver stopped with an error that was not recorded.",
      actions: [{ intent: "rerun", label: "Re-run", tone: "danger" }],
    };
  }

  // A resolver that has gone quiet outranks its nominal phase: the run still
  // says "running" precisely because nothing is left alive to settle it.
  if (input.liveness?.state === "stale") {
    const since =
      input.liveness.measuredFrom === "heartbeat"
        ? `Last reported ${humanDuration(input.liveness.ageMs)} ago.`
        : `It never reported after launching ${humanDuration(input.liveness.ageMs)} ago.`;
    return {
      tone: "bad",
      icon: "⚠",
      headline: "The resolver stopped reporting",
      detail:
        input.notAssessed > 0
          ? `${since} ${plural(input.notAssessed, unit)} were left unassessed.`
          : since,
      actions: [
        { intent: "restart", label: "Restart the resolver", tone: "danger" },
        {
          intent: "stop",
          label: `Keep the ${input.total} it finished`,
          tone: "ghost",
        },
      ],
    };
  }

  if (input.phase === "pending" || input.phase === "running") {
    return {
      tone: "live",
      icon: "◐",
      headline:
        input.phase === "pending"
          ? "Waiting to start"
          : input.total === 0
            ? "Scanning…"
            : `Assessing — ${input.decided} of ${input.total}`,
      detail:
        input.phase === "pending"
          ? "The run is saved; its resolver has not started yet."
          : `${plural(input.total, unit)} found so far.`,
      progress:
        input.phase === "running" && input.total > 0
          ? input.decided / input.total
          : null,
      actions: [{ intent: "stop", label: "Stop", tone: "warn" }],
    };
  }

  // Settled with work never reached — the owner stopped it, or the resolver
  // died and was settled. Either way `resume` is the answer, not "manual".
  if (input.notAssessed > 0) {
    return {
      tone: "warn",
      icon: "⏸",
      headline: `This run stopped before it finished`,
      detail: `${plural(input.decided, unit)} assessed and kept. ${plural(
        input.notAssessed,
        unit,
      )} were never judged.`,
      actions: [
        {
          intent: "resume",
          label: `Assess the remaining ${input.notAssessed}`,
          tone: "warn",
        },
        { intent: "rerun", label: "Re-run from scratch", tone: "ghost" },
      ],
    };
  }

  if ((input.staleRows ?? 0) > 0) {
    return {
      tone: "warn",
      icon: "⧗",
      headline: `${plural(input.staleRows ?? 0, "row")} changed since the scan`,
      detail:
        "Applying them now would write over newer work. Re-check them, or explicitly apply anyway.",
      actions: [
        { intent: "recheck", label: "Re-check all", tone: "warn" },
        {
          intent: "apply-anyway",
          label: `Apply ${input.staleRows ?? 0} anyway`,
          tone: "danger",
        },
        { intent: "reveal", label: "Show the changed rows", tone: "ghost" },
      ],
    };
  }

  if (
    input.ageMs != null &&
    input.ageMs > REPORT_STALE_AFTER_MS &&
    input.open > 0
  ) {
    return {
      tone: "warn",
      icon: "⧗",
      headline: `This report is ${humanDuration(input.ageMs)} old`,
      detail:
        "Plans may have moved since it ran. Re-check before applying anything.",
      actions: [
        { intent: "recheck", label: "Re-check all", tone: "warn" },
        { intent: "rerun", label: "Run again", tone: "ghost" },
      ],
    };
  }

  // `complete` used to render NOTHING at all: the one run that changed the
  // owner's work without asking was the one run they could never open (D-004).
  if (input.phase === "complete" || input.open === 0) {
    return {
      tone: "good",
      icon: "✓",
      headline:
        input.total === 0
          ? "Nothing to clean up"
          : `Papercup fixed ${plural(input.autoApplied || input.total, unit)} on its own`,
      detail:
        input.total === 0
          ? "The scan found no problems in this scope."
          : "Nothing needs you. Every change is listed below with its evidence.",
      actions: [{ intent: "rerun", label: "Run again", tone: "ghost" }],
    };
  }

  return {
    tone: "live",
    icon: "◆",
    headline: `${plural(input.open, unit)} waiting on you`,
    detail:
      input.autoApplied > 0
        ? `${plural(input.autoApplied, unit)} were fixed automatically.`
        : "Review the recommendations below, then apply the ones you want.",
    actions: [{ intent: "rerun", label: "Re-run", tone: "ghost" }],
  };
}

export interface RunLifecycleBarProps extends RunLifecycleInput {
  onIntent: (intent: RunLifecycleIntent) => void;
  /** Which intents this consumer can actually service. An intent it cannot
   *  perform is not rendered — a control that does nothing is the bug this
   *  whole plan is about (D-001). */
  supports: ReadonlyArray<RunLifecycleIntent>;
  busy?: boolean;
  /** Extra controls (a Runs history menu, say) pinned after the actions. */
  trailing?: ReactNode;
}

export default function RunLifecycleBar({
  onIntent,
  supports,
  busy = false,
  trailing,
  ...input
}: RunLifecycleBarProps) {
  const state = deriveRunLifecycleState(input);
  const actions = state.actions.filter((action) =>
    supports.includes(action.intent),
  );

  return (
    <div
      className={`run-lifecycle run-lifecycle--${state.tone}`}
      data-testid="run-lifecycle-bar"
      data-tone={state.tone}
      role="status"
      aria-live="polite"
    >
      <span className="run-lifecycle__icon" aria-hidden="true">
        {state.icon}
      </span>
      <div className="run-lifecycle__text">
        <b data-testid="run-lifecycle-headline">{state.headline}</b>
        <div data-testid="run-lifecycle-detail">{state.detail}</div>
        {state.progress != null ? (
          <div
            className="run-lifecycle__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
            aria-label="Run progress"
          >
            <i style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </div>
        ) : null}
      </div>
      <div className="run-lifecycle__actions">
        {actions.map((action) => (
          <button
            key={action.intent}
            type="button"
            className={`run-lifecycle__btn run-lifecycle__btn--${action.tone ?? "ghost"}`}
            data-testid={`run-lifecycle-${action.intent}`}
            disabled={busy}
            onClick={() => onIntent(action.intent)}
          >
            {action.label}
          </button>
        ))}
        {trailing}
      </div>
    </div>
  );
}
