"use client";

/**
 * The persistent left rail.
 *
 * This is a STATUS column, not a breadcrumb: every step reports its own
 * condition at all times, so a problem in a step you are not looking at still
 * surfaces. It renders no derivation of its own — `railModel` and
 * `recentActivity` in `workspace-view-model.ts` own every judgement here, and
 * this file owns only how that judgement looks.
 *
 * Narrow viewports collapse it to a 74px icon strip (see the container query
 * in the stylesheet); the labels survive as hover/focus tooltips and the
 * accessible name never changes, so the collapse costs no information to a
 * screen-reader user. That second half only holds because an unreachable step
 * is marked `aria-disabled` rather than `disabled` — see the note on the
 * button.
 */

import { Cloud, Server, SlidersHorizontal } from "lucide-react";
import { Tooltip } from "@/app/harness/Tooltip";
import {
  formatMoney,
  formatTimestamp,
  type ActivityEntry,
  type RailModel,
  type RailStep,
  type StepId,
} from "./workspace-view-model";
import { FocusSafeButton } from "./stage-primitives";
import styles from "./cloud-workspaces.module.css";

const STEP_ICONS: Record<StepId, typeof Cloud> = {
  connect: Cloud,
  configure: SlidersHorizontal,
  operate: Server,
};

/** Announced beside the step name so status is not carried by colour alone. */
const STATUS_LABELS: Record<RailStep["status"], string> = {
  todo: "not started",
  current: "current step",
  done: "complete",
  attention: "needs attention",
};

export function WorkspaceRail({
  model,
  activity,
  activeStep,
  onSelectStep,
}: {
  model: RailModel;
  activity: readonly ActivityEntry[];
  activeStep: StepId;
  onSelectStep: (step: StepId) => void;
}) {
  const { steps, stats } = model;

  return (
    <nav className={styles.rail} aria-label="Cloud workspace setup">
      <ol className={styles.railSteps}>
        {steps.map((step) => {
          const Icon = STEP_ICONS[step.id];
          const active = step.id === activeStep;
          const label = `${step.index} ${step.label}`;
          return (
            <li key={step.id}>
              {/*
               * The collapsed rail hides the text labels, so the tooltip is
               * what carries them at narrow widths. It supplements the
               * accessible name rather than replacing it — `aria-label` below
               * states the same thing unconditionally, which is what keeps the
               * collapse lossless for keyboard and screen-reader users.
               */}
              <Tooltip
                label={step.reachable ? label : `${label} — ${step.evidence}`}
                side="right"
              >
                <FocusSafeButton
                  type="button"
                  className={styles.railStep}
                  unavailable={!step.reachable}
                  data-status={step.status}
                  data-active={active ? "true" : "false"}
                  aria-current={active ? "step" : undefined}
                  /*
                   * A step whose precondition does not hold is inert — but
                   * inert via `aria-disabled`, NEVER the native `disabled`
                   * attribute, and that distinction is load-bearing rather
                   * than stylistic.
                   *
                   * The tooltip above is the ONLY channel carrying `evidence`
                   * to a sighted pointer user once the container query
                   * collapses `.railStepBody` away at <=1100px, and it is
                   * enriched with that reason precisely in the unreachable
                   * case. `Tooltip` is Radix (`Trigger asChild`), so it hangs
                   * pointer and focus listeners on this element — and a
                   * natively `disabled` button dispatches no pointer events
                   * and takes no focus. Marking it `disabled` therefore
                   * suppressed the explanation in exactly the state that
                   * needed one, and removed the step from the tab order so a
                   * keyboard user could not discover it either.
                   *
                   * `aria-disabled` keeps the step announced as unavailable
                   * while leaving it hoverable and focusable; the
                   * `FocusSafeButton` click guard preserves the original
                   * guarantee that a click cannot strand the operator in an
                   * empty stage.
                   */
                  aria-label={`${label}: ${STATUS_LABELS[step.status]}. ${step.evidence}`}
                  onClick={() => onSelectStep(step.id)}
                >
                  <span className={styles.railStepIcon} aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className={styles.railStepBody}>
                    <span className={styles.railStepIndex} aria-hidden="true">
                      {step.index}
                    </span>
                    <span className={styles.railStepLabel}>{step.label}</span>
                    {/*
                     * Evidence, never a bare tick: "2 hosts running" says more
                     * than a checkmark, and a failing step says what failed.
                     */}
                    <span className={styles.railStepEvidence}>
                      {step.evidence}
                    </span>
                  </span>
                  <span className={styles.railStepDot} aria-hidden="true" />
                </FocusSafeButton>
              </Tooltip>
            </li>
          );
        })}
      </ol>

      <section className={styles.railStats} aria-label="Fleet posture">
        <div className={styles.railStat}>
          <span>Running</span>
          <strong>{stats.running}</strong>
        </div>
        <div className={styles.railStat}>
          <span>Stopped</span>
          <strong>{stats.stopped}</strong>
        </div>
        <div
          className={styles.railStat}
          data-tone={stats.drifting > 0 ? "warn" : undefined}
        >
          <span>Drifting</span>
          <strong>{stats.drifting}</strong>
        </div>
        <div className={styles.railStat}>
          <span>Monthly</span>
          <strong>{formatMoney(stats.monthlyUsd)}</strong>
        </div>
      </section>

      <section className={styles.railActivity} aria-label="Recent activity">
        <h2 className={styles.railActivityHeading}>Recent activity</h2>
        {activity.length === 0 ? (
          <p className={styles.railActivityEmpty}>
            Nothing has run yet on this control plane.
          </p>
        ) : (
          <ol className={styles.railActivityList}>
            {activity.map((entry) => (
              <li key={entry.id}>
                <span
                  className={`${styles.activityDot} ${styles[entry.tone]}`}
                  aria-hidden="true"
                />
                <span className={styles.activityBody}>
                  <strong>{entry.subject}</strong>
                  <span>{entry.detail}</span>
                  <time dateTime={entry.ts}>{formatTimestamp(entry.ts)}</time>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </nav>
  );
}
