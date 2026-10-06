"use client";

import { useEffect, useRef, useState } from "react";
import { Joyride } from "react-joyride";

export type HighlightStatus = "waiting" | "missing" | "ready";

// The persistent Guide owns the explanation and controls. Use Joyride's supported
// custom renderer rather than a second tooltip or private library state.
function PanelOwnedTooltip() { return null; }

/** Highlighting observes the app. It never clicks a target or advances a lesson. */
export function CloudTutorialHighlight({
  target,
  active,
  contextKey,
  reducedMotion = false,
  onStatus,
}: {
  target: string;
  active: boolean;
  contextKey: string;
  reducedMotion?: boolean;
  onStatus?: (status: HighlightStatus) => void;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  useEffect(() => {
    setElement(null);
    if (!active) return;
    const focus = document.activeElement as HTMLElement | null;
    let current: HTMLElement | null = null;
    let disposed = false;
    let timeout: number | undefined;
    const waitForTarget = () => {
      window.clearTimeout(timeout);
      statusRef.current?.("waiting");
      timeout = window.setTimeout(() => {
        if (!disposed && !current) statusRef.current?.("missing");
      }, 1500);
    };
    const observe = () => {
      if (disposed) return;
      const found = document.querySelector<HTMLElement>(target);
      const visible = found && getComputedStyle(found).display !== "none" && getComputedStyle(found).visibility !== "hidden";
      const next = visible ? found : null;
      if (next === current) return;
      current = next;
      setElement(next);
      if (next) {
        window.clearTimeout(timeout);
        statusRef.current?.("ready");
      } else {
        waitForTarget();
      }
    };
    waitForTarget();
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    observe();
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
  }, [target, active, contextKey]);
  return <div ref={setPortal} data-cloud-tutorial-highlight data-reduced-motion={reducedMotion}>
    <style>{`
      [data-cloud-tutorial-highlight] .react-joyride__overlay path { pointer-events: none !important; }
      [data-cloud-tutorial-highlight][data-reduced-motion="true"] .react-joyride__spotlight path { transition: none !important; }
      @media (prefers-reduced-motion: reduce) {
        [data-cloud-tutorial-highlight] .react-joyride__spotlight path { transition: none !important; }
      }
    `}</style>
    {active && element && portal && <Joyride key={`${contextKey}:${target}`} run stepIndex={0}
      portalElement={portal} tooltipComponent={PanelOwnedTooltip}
      steps={[{ target: element, content: "", skipBeacon: true, disableFocusTrap: true,
        blockTargetInteraction: false, skipScroll: true, targetWaitTimeout: 1500,
        // Position the maintained floater outside ResizeObserver delivery.
        // Frame tracking also covers targets that move without resizing.
        floatingOptions: { autoUpdate: { elementResize: false, animationFrame: true } } }]}
      options={{ dismissKeyAction: false, overlayClickAction: false, scrollDuration: 0,
        overlayColor: "rgba(0, 0, 0, 0.12)", spotlightRadius: 8 }} />}
  </div>;
}
