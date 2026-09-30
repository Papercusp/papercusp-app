'use client';

/**
 * PlanEditor — the decorated markdown surface for one plan.
 *
 * Read mode (default, D-007): the shared `PlanDocumentView` owns Vditor,
 * core plan decoration, outline, and reference navigation. This adapter adds
 * only operator-specific live badges, status actions, and perf timing.
 *
 * Edit mode: MarkdownEditor with IR-mode Lute renderers registered via
 * `inst.vditor.lute.SetJSRenderers({ Md2VditorIRDOM })` on instance
 * mount (P-202). The P-001 spike confirmed `Md2VditorIRDOM` re-applies
 * on every IR re-spin; `WalkSkipChildren` is the right return value
 * for selective overrides. Edit-mode v1 decorates status pills only —
 * `[data-plan-item]` anchors and prose ref-wrapping stay read-mode-
 * only (D-003's preferred fallback for the IR markers that a full
 * `renderListItem` override would lose).
 *
 * The status-flip popover (P-203) hangs off the delegated click handler
 * via the `onStatusClick` prop — when consumers (PlanDetail) pass one,
 * clicks on `[data-plan-status]` in either mode call back with the
 * target element and current status.
 */

import { useCallback, useEffect, useRef } from 'react';
import { PlanDocumentView } from '@papercusp/ui-primitives';
import {
  MarkdownEditor,
  type MarkdownEditorToolbar,
} from '@/app/_components/MarkdownEditor';
import { endInteraction, markInteractionPhase, PERF_INTERACTIONS } from '@/app/_components/perf/perf-marks';
import type { PlanItem } from './plans-api';
import { decoratePromotedBlock, decoratePlanItemBadges, decoratePlanItemTestBadges, attachFeatureBadgeClickHandler, type PromotedFeature } from './plan-renderers';
import {
  attachStatusClickHandler,
  buildPlanIRRenderers,
  readLuteWalk,
} from './plan-renderers-ir';

export interface PlanEditorProps {
  /** Canonical plan markdown (from plans:get). */
  value: string;
  /** Fired on every edit when not read-only. */
  onChange?: (next: string) => void;
  /** Read mode (default, D-007) vs raw-prose Edit mode. */
  readOnly?: boolean;
  /** Outline panel position, or `false` to omit it. Defaults to 'left'.
   *  The stripped read-only item-preview pane (PlanItemPreview) passes
   *  `false` to drop the outline. */
  outline?: 'left' | 'right' | false;
  /** Plan slug — used by decoration handlers and the toolbar buttons. */
  slug?: string;
  /** Parsed items from plans:get — drives the effective-status badge
   *  and the lookup target for P-NNN ref scrolling (P-106). */
  items?: PlanItem[];
  /** P-013: features promoted from this plan — drives live status badges
   *  in the ## Promoted block. */
  promotedFeatures?: PromotedFeature[];
  /** P-006: map of P-NNN → { featureId, status } from plans:get — drives
   *  inline feature status badges next to each linked plan item. */
  linkedFeatures?: Record<string, { featureId: string; status: string }>;
  /** P-083: map of P-NNN → test-coverage counts from plans:get — drives the
   *  inline `✓ pass/required` test-coverage badge next to each item. */
  planItemTests?: Record<string, { valsRequiringTest: number; valsCovered: number; valsPassing: number }>;
  /** Optional P-203 hook: invoked when a `[data-plan-status]` pill is
   *  clicked in either mode. Receives the target element + the current
   *  status token. The consumer opens the status-flip popover. */
  onStatusClick?: (target: HTMLElement, status: string) => void;
  /** P-007: invoked when a feature status badge is clicked. */
  onFeatureClick?: (featureId: string) => void;
}

const PLAN_TOOLBAR: MarkdownEditorToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', '|',
  'code', 'inline-code', 'link', 'table', '|',
  'outline', 'preview', 'edit-mode',
  // P-204: append custom { name, icon, tip, hotkey, click } entries.
];

export default function PlanEditor({
  value,
  onChange,
  readOnly = true,
  outline = 'left',
  slug,
  items,
  promotedFeatures,
  linkedFeatures,
  planItemTests,
  onStatusClick,
  onFeatureClick,
}: PlanEditorProps) {
  void slug;
  // Read-mode delegated click teardown (P-106 ref scroll + optional
  // status click). Edit-mode click teardown (status click only).
  const readDetachRef = useRef<(() => void) | null>(null);
  const editDetachRef = useRef<(() => void) | null>(null);
  // Hold onStatusClick in a ref so registering / re-registering the IR
  // renderers does not depend on the prop identity.
  const onStatusClickRef = useRef(onStatusClick);
  onStatusClickRef.current = onStatusClick;
  const onFeatureClickRef = useRef(onFeatureClick);
  onFeatureClickRef.current = onFeatureClick;

  const promotedFeaturesRef = useRef(promotedFeatures);
  promotedFeaturesRef.current = promotedFeatures;
  const linkedFeaturesRef = useRef(linkedFeatures);
  linkedFeaturesRef.current = linkedFeatures;
  const planItemTestsRef = useRef(planItemTests);
  planItemTestsRef.current = planItemTests;

  const handleParsed = useCallback(
    (root: HTMLElement) => {
      // Close the "open a plan" interaction timing the instant the plan body
      // is rendered (WI-5547 / desktop-performance-suite P-001). No-op unless a
      // matching beginInteraction ran (the Plans dashboard popup click sets it),
      // so this is inert in PlanDetail's other mount contexts.
      endInteraction(PERF_INTERACTIONS.planPopupOpen);
      if (promotedFeaturesRef.current?.length) {
        decoratePromotedBlock(root, promotedFeaturesRef.current);
      }
      if (linkedFeaturesRef.current && Object.keys(linkedFeaturesRef.current).length > 0) {
        decoratePlanItemBadges(root, linkedFeaturesRef.current);
      }
      if (planItemTestsRef.current && Object.keys(planItemTestsRef.current).length > 0) {
        decoratePlanItemTestBadges(root, planItemTestsRef.current);
      }
      // Vditor.preview re-renders the container's children on every value
      // change — detach the previous handlers before re-attaching so each
      // post-render pass owns exactly one listener per concern.
      readDetachRef.current?.();
      const detachStatus = onStatusClickRef.current
        ? attachStatusClickHandler(root, (t, s) => onStatusClickRef.current?.(t, s))
        : () => {};
      const detachFeature = onFeatureClickRef.current
        ? attachFeatureBadgeClickHandler(root, (id) => onFeatureClickRef.current?.(id))
        : () => {};
      readDetachRef.current = () => {
        detachStatus();
        detachFeature();
      };
    },
    [items],
  );

  const handleInstance = useCallback((inst: any | null) => {
    if (!inst) {
      editDetachRef.current?.();
      editDetachRef.current = null;
      return;
    }
    const walk = readLuteWalk();
    if (!walk) return;
    const renderers = buildPlanIRRenderers(walk);
    try {
      inst.vditor?.lute?.SetJSRenderers({ renderers: { Md2VditorIRDOM: renderers } });
    } catch {
      // If SetJSRenderers throws (older vditor / wrong shape), drop
      // silently — the editor still works without decorations.
      return;
    }
    // Force a re-spin so the renderers apply to the already-rendered
    // initial value. Vditor preserves cursor position across setValue.
    try {
      inst.setValue(inst.getValue());
    } catch {
      /* ignore */
    }
    const irEl = inst.vditor?.ir?.element as HTMLElement | undefined;
    if (irEl) {
      editDetachRef.current?.();
      editDetachRef.current = attachStatusClickHandler(irEl, (t, s) =>
        onStatusClickRef.current?.(t, s),
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      readDetachRef.current?.();
      readDetachRef.current = null;
      editDetachRef.current?.();
      editDetachRef.current = null;
    };
  }, []);

  if (readOnly) {
    return (
      <div className="pc-plan-editor">
        <PlanDocumentView
          value={value}
          items={items}
          outline={outline}
          showJump={false}
          showFrontmatter={false}
          onRenderPhase={(phase) => markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, phase)}
          onParsed={handleParsed}
        />
      </div>
    );
  }

  return (
    <div className="pc-plan-editor">
      <MarkdownEditor
        value={value}
        onChange={onChange}
        mode="ir"
        readOnly={false}
        outline={outline}
        toolbar={PLAN_TOOLBAR}
        onInstance={handleInstance}
      />
    </div>
  );
}
