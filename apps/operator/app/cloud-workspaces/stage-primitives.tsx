"use client";

/**
 * Presentation primitives shared by the three rail stages.
 *
 * Lifted verbatim (behaviour-wise) out of `page.tsx` so a stage never has to
 * re-implement label/hint/describedby wiring — the describedby contract is an
 * accessibility invariant the suite pins, and one implementation is the only
 * way it stays true across three files.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ComponentProps,
} from "react";
import { Button } from "@/app/harness/Button";
import {
  formatSignal,
  isLifecycleState,
  stateTone,
  type ConnectionStatus,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

type FocusTargetResolver = () => HTMLElement | null | undefined;

/**
 * Focus an element only while it is still mounted in this document.
 *
 * Cloud Workspaces renders panels and menus conditionally, so a close action
 * can race a render that removes the element that held focus. Keeping this
 * guard in one place prevents every caller from accidentally focusing a stale
 * node (or throwing during server rendering) and preserves the user's scroll
 * position when focus is restored.
 */
export function focusSafely(target: HTMLElement | null | undefined): boolean {
  if (
    !target ||
    typeof document === "undefined" ||
    !document.contains(target)
  ) {
    return false;
  }

  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

type FocusSafeButtonProps = Omit<ComponentProps<typeof Button>, "disabled"> & {
  /** Keep an unavailable control discoverable without allowing activation. */
  unavailable?: boolean;
};

/**
 * A focusable, inert button for controls whose explanation lives in a tooltip.
 *
 * Native `disabled` suppresses both focus and pointer events, which makes a
 * tooltip attached with Radix `Trigger asChild` unreachable. `aria-disabled`
 * keeps the control in the tab order; the click guard preserves the inert
 * behavior while still allowing sighted and keyboard users to discover why it
 * is unavailable.
 */
export const FocusSafeButton = forwardRef<
  HTMLButtonElement,
  FocusSafeButtonProps
>(function FocusSafeButton(
  { unavailable = false, onClick, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      {...props}
      aria-disabled={unavailable ? true : props["aria-disabled"]}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
});

/**
 * Shared open/close focus contract for transient Cloud Workspaces surfaces.
 *
 * The resolvers run after the state transition commits, when the open target
 * exists and the close target is back in the DOM. They are kept in refs so a
 * caller can resolve dynamic provider/row triggers without retriggering the
 * lifecycle effect on every render.
 */
export function useFocusLifecycle({
  open,
  onOpenFocus,
  onCloseFocus,
}: {
  open: boolean;
  onOpenFocus?: FocusTargetResolver;
  onCloseFocus?: FocusTargetResolver;
}): void {
  const previousOpenRef = useRef(false);
  const resolversRef = useRef({ onOpenFocus, onCloseFocus });
  resolversRef.current = { onOpenFocus, onCloseFocus };

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open === wasOpen) return;

    const resolve = open
      ? resolversRef.current.onOpenFocus
      : resolversRef.current.onCloseFocus;
    if (resolve) focusSafely(resolve());
  }, [open]);
}

export function SignalList({
  items,
  empty,
}: {
  items?: unknown[];
  empty: string;
}) {
  if (!items?.length) return <p className={styles.telemetryEmpty}>{empty}</p>;
  return (
    <ul className={styles.signalList}>
      {items.map((item, index) => (
        <li key={`${index}:${formatSignal(item)}`}>{formatSignal(item)}</li>
      ))}
    </ul>
  );
}

export function StatusBadge({
  state,
  prefix,
}: {
  state: string;
  prefix?: string;
}) {
  const normalized = isLifecycleState(state)
    ? state
    : (state as ConnectionStatus);
  return (
    <span className={`${styles.badge} ${styles[stateTone(normalized)]}`}>
      {prefix ? `${prefix}: ` : ""}
      {state}
    </span>
  );
}

/**
 * A labelled control whose hint is wired to it by id. `children` may be a
 * render function so the caller can spread the generated hint id onto whatever
 * control it owns — that is what keeps `aria-describedby` correct without the
 * primitive knowing the control's type.
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode | ((hintId: string | undefined) => React.ReactNode);
  hint?: string;
}) {
  const generatedHintId = useId();
  const hintId = hint ? generatedHintId : undefined;

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {typeof children === "function" ? children(hintId) : children}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/** The heading every stage opens with: step index, name, and what it does. */
export function StageHeader({
  id,
  step,
  eyebrow,
  title,
  description,
}: {
  id: string;
  step: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.stageHeader}>
      <div className={styles.stageHeaderCopy}>
        <p className={styles.stageEyebrow}>
          <span className={styles.stageNumber} aria-hidden="true">
            {step}
          </span>
          {eyebrow}
        </p>
        <h2 id={id}>{title}</h2>
        <p className={styles.stageDescription}>{description}</p>
      </div>
    </div>
  );
}

/** A group of related fields inside a stage — Placement, Capacity, Storage. */
export function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.fieldGroup} aria-labelledby={headingId}>
      <div className={styles.fieldGroupHeading}>
        <h3 id={headingId}>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
      <div className={styles.fieldGroupBody}>{children}</div>
    </section>
  );
}
