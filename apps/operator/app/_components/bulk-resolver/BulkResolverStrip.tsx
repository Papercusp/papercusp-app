"use client";

/**
 * Generalized bulk-resolver command strip shared by Inbox resolve and Plans
 * clean-up. Consumers own run semantics and backend actions; this component
 * owns the idle/running/review visual grammar so the two tabs cannot drift.
 */
import type { ReactNode } from "react";
import { ChevronRight, Loader2, Sparkles, Square, X } from "lucide-react";
import "../inbox/inbox-bulk.css";

export type BulkResolverMetricTone = "good" | "review" | "muted";

export interface BulkResolverMetric {
  id: string;
  value: ReactNode;
  label: ReactNode;
  tone?: BulkResolverMetricTone;
}

export interface BulkResolverNotice {
  message: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/**
 * `strip` (default) is the full-width band between a masthead and a toolbar.
 * `card` is the same three states as a compact card for a ~210px rail
 * (inbox-three-column-resolver-states-2026-09-06 P-003): an eyebrow, the copy
 * as text rather than inside the button, full-width actions stacked, and the
 * running state's Stop under its counts. Same test ids, same handlers.
 */
export type BulkResolverStripVariant = "strip" | "card";

interface BulkResolverStripBaseProps {
  settings: ReactNode;
  testId?: string;
  notice?: BulkResolverNotice | null;
  variant?: BulkResolverStripVariant;
}

export interface BulkResolverIdleStripProps extends BulkResolverStripBaseProps {
  state: "idle";
  actionTestId: string;
  ariaLabel: string;
  icon: ReactNode;
  busy: boolean;
  disabled: boolean;
  title: ReactNode;
  subtitle: ReactNode;
  /** Card only: the button's own label (the strip's button IS the title). */
  actionLabel?: ReactNode;
  /** Card only: the eyebrow above the copy. */
  eyebrow?: ReactNode;
  onStart: () => void;
}

export interface BulkResolverRunningStripProps extends BulkResolverStripBaseProps {
  state: "running";
  title: ReactNode;
  stopTestId: string;
  stopDisabled?: boolean;
  onStop: () => void;
  progress: {
    percent?: number;
    width?: string;
    ariaLabel: string;
    ariaValueText?: string;
  };
  /** One line under the bar ("98 of 158 decided"). */
  caption?: ReactNode;
  metrics: readonly BulkResolverMetric[];
  metricsTestId: string;
}

export interface BulkResolverReviewStripProps extends BulkResolverStripBaseProps {
  state: "review";
  icon?: ReactNode;
  /** Card only: the eyebrow above the headline ("Review ready"). */
  eyebrow?: ReactNode;
  headline: ReactNode;
  headlineTestId: string;
  elapsed?: string | null;
  metrics: readonly BulkResolverMetric[];
  metricsTestId: string;
  metricsAriaLabel: string;
  actions: ReactNode;
  hint?: ReactNode;
}

export type BulkResolverStripProps =
  | BulkResolverIdleStripProps
  | BulkResolverRunningStripProps
  | BulkResolverReviewStripProps;

function MetricList({
  metrics,
  testId,
  ariaLabel,
  accounting = false,
}: {
  metrics: readonly BulkResolverMetric[];
  testId: string;
  ariaLabel?: string;
  accounting?: boolean;
}) {
  return (
    <div
      className={`op-inbox__bulk-counts${accounting ? " op-inbox__bulk-counts--accounting" : ""}`}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {metrics.map((metric) => (
        <span
          key={metric.id}
          className={`op-inbox__bulk-count op-inbox__bulk-count--${
            metric.tone === "good"
              ? "good"
              : metric.tone === "review"
                ? "review"
                : "left"
          }`}
        >
          <i aria-hidden="true" />
          {metric.value} {metric.label}
        </span>
      ))}
    </div>
  );
}

function Notice({ notice }: { notice: BulkResolverNotice }) {
  return (
    <div
      className="op-inbox__bulk-notice"
      role={notice.role ?? "alert"}
      data-testid={notice.testId}
    >
      <span>{notice.message}</span>
      {notice.onDismiss ? (
        <button
          type="button"
          className="op-inbox__bulk-notice-x"
          aria-label={notice.dismissLabel ?? "Dismiss message"}
          onClick={notice.onDismiss}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export default function BulkResolverStrip(props: BulkResolverStripProps) {
  const variant: BulkResolverStripVariant = props.variant ?? "strip";
  const card = variant === "card";

  if (props.state === "idle") {
    const spinnerOrIcon = props.busy ? (
      <span className="op-inbox__bulk-spin">
        <Loader2 size={card ? 14 : 17} />
      </span>
    ) : (
      props.icon
    );
    return (
      <div
        className={`op-inbox__bulk-slot${card ? " op-inbox__bulk-slot--card" : ""}`}
        data-testid={props.testId}
        data-bulk-resolver-strip-state="idle"
        data-bulk-resolver-strip-variant={variant}
      >
        {props.settings}
        {card ? (
          <>
            {/* Card: the copy is text and the button is a button — a 210px
                column cannot carry a two-line label INSIDE a button. */}
            {props.eyebrow ? (
              <p className="op-inbox__bulk-card-hd">
                <span className="op-inbox__bulk-icon" aria-hidden="true">
                  {props.icon}
                </span>
                {props.eyebrow}
              </p>
            ) : null}
            <span className="op-inbox__bulk-start-copy">
              <span className="op-inbox__bulk-start-title">{props.title}</span>
              <span className="op-inbox__bulk-start-sub">{props.subtitle}</span>
            </span>
            <button
              type="button"
              className="op-inbox__bulk-start op-inbox__bulk-start--card"
              data-testid={props.actionTestId}
              disabled={props.disabled}
              aria-label={props.ariaLabel}
              onClick={props.onStart}
            >
              {props.busy ? (
                <span className="op-inbox__bulk-icon" aria-hidden="true">
                  {spinnerOrIcon}
                </span>
              ) : null}
              {props.actionLabel ?? props.title}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="op-inbox__bulk-start"
            data-testid={props.actionTestId}
            disabled={props.disabled}
            aria-label={props.ariaLabel}
            onClick={props.onStart}
          >
            <span className="op-inbox__bulk-icon" aria-hidden="true">
              {spinnerOrIcon}
            </span>
            <span className="op-inbox__bulk-start-copy">
              <span className="op-inbox__bulk-start-title">{props.title}</span>
              <span className="op-inbox__bulk-start-sub">{props.subtitle}</span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}
        {props.notice ? <Notice notice={props.notice} /> : null}
      </div>
    );
  }

  if (props.state === "running") {
    const progressWidth =
      props.progress.width ?? `${props.progress.percent ?? 0}%`;
    const stop = (
      <button
        type="button"
        className={`op-inbox__bulk-ghost${card ? " op-inbox__bulk-stop--card" : ""}`}
        data-testid={props.stopTestId}
        disabled={props.stopDisabled}
        onClick={props.onStop}
      >
        <Square size={11} aria-hidden="true" />
        Stop
      </button>
    );
    return (
      <div
        className={`op-inbox__bulk op-inbox__bulk--running${card ? " op-inbox__bulk--card" : ""}`}
        data-testid={props.testId}
        data-bulk-resolver-strip-state="running"
        data-bulk-resolver-strip-variant={variant}
      >
        {props.settings}
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-spin" aria-hidden="true">
            <Loader2 size={card ? 13 : 15} />
          </span>
          <span className="op-inbox__bulk-title">{props.title}</span>
          <span className="op-inbox__bulk-spacer" />
          {card ? null : stop}
        </div>
        <div
          className="op-inbox__bulk-track"
          role="progressbar"
          aria-valuenow={props.progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={props.progress.ariaValueText}
          aria-label={props.progress.ariaLabel}
        >
          <div
            className="op-inbox__bulk-fill"
            style={{ width: progressWidth }}
          />
        </div>
        {props.caption ? (
          <p className="op-inbox__bulk-caption">{props.caption}</p>
        ) : null}
        <MetricList metrics={props.metrics} testId={props.metricsTestId} />
        {/* Card: Stop is the card's last, full-width control — the head has no
            room for it beside the title. */}
        {card ? stop : null}
        {props.notice ? <Notice notice={props.notice} /> : null}
      </div>
    );
  }

  return (
    <div
      className={`op-inbox__bulk op-inbox__bulk--review${card ? " op-inbox__bulk--card" : ""}`}
      data-testid={props.testId}
      data-bulk-resolver-strip-state="review"
      data-bulk-resolver-strip-variant={variant}
    >
      {props.settings}
      {card && props.eyebrow ? (
        <p className="op-inbox__bulk-card-hd">
          <span
            className="op-inbox__bulk-icon op-inbox__bulk-icon--review"
            aria-hidden="true"
          >
            {props.icon ?? <Sparkles size={13} />}
          </span>
          {props.eyebrow}
        </p>
      ) : null}
      <div className="op-inbox__bulk-head">
        {card && props.eyebrow ? null : (
          <span
            className="op-inbox__bulk-icon op-inbox__bulk-icon--review"
            aria-hidden="true"
          >
            {props.icon ?? <Sparkles size={16} />}
          </span>
        )}
        <span
          className="op-inbox__bulk-title"
          data-testid={props.headlineTestId}
        >
          {props.headline}
        </span>
        <span className="op-inbox__bulk-spacer" />
        {props.elapsed ? (
          <span className="op-inbox__bulk-elapsed">run {props.elapsed}</span>
        ) : null}
      </div>
      <MetricList
        metrics={props.metrics}
        testId={props.metricsTestId}
        ariaLabel={props.metricsAriaLabel}
        accounting
      />
      <div className="op-inbox__bulk-actions">{props.actions}</div>
      {props.hint ? <p className="op-inbox__bulk-hint">{props.hint}</p> : null}
      {props.notice ? <Notice notice={props.notice} /> : null}
    </div>
  );
}
