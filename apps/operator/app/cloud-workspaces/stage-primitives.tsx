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
 * node (or throwing during server rendering). Restoration preserves scroll by
 * default; opening a surface can opt into revealing its newly mounted target.
 */
export function focusSafely(
  target: HTMLElement | null | undefined,
  options: FocusOptions = { preventScroll: true },
): boolean {
  if (
    !target ||
    typeof document === "undefined" ||
    !document.contains(target)
  ) {
    return false;
  }

  target.focus(options);
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
    if (!open && !wasOpen) return;

    const resolve = open
      ? resolversRef.current.onOpenFocus
      : resolversRef.current.onCloseFocus;
    // Newly mounted forms/menus may be outside the scrollport. Reveal opening
    // focus, but keep the user's scroll position when returning to a trigger.
    const target = resolve?.();
    if (open !== wasOpen && !focusSafely(target, { preventScroll: !open })) return;
    if (!open || !target || document.activeElement !== target) return;

    // Docked rails can reserve width after this commit, wrapping the provider
    // rows above a newly focused field. Keep that field visible as its surface
    // resizes, only while it still holds focus. Scrolling alone never triggers
    // this, so the user can scroll away or move to another control freely.
    let frame: number | undefined;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", revealAfterLayout);
      target.removeEventListener("blur", stop);
    };
    const revealAfterLayout = () => {
      if (stopped) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!target.isConnected || document.activeElement !== target) { stop(); return; }
        const rect = target.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth)
          target.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(revealAfterLayout);
      observer.observe(target.closest("form, [role=menu], [role=dialog]") ?? target.parentElement ?? target);
    }
    window.addEventListener("resize", revealAfterLayout);
    target.addEventListener("blur", stop, { once: true });
    return stop;
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
