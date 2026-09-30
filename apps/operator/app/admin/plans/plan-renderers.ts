'use client';

/**
 * P-106 read-mode decorations for plan markdown rendered by
 * Vditor.preview(). DOM-walking post-render (the documented zero-risk
 * path per D-003 of plans-admin-ui-2026-05-20); no Lute walker
 * protocol involved. P-202 will register the equivalent decorations
 * into IR's Md2VditorIRDOM pipeline once D-003's spike resolves.
 *
 *   1. <code>todo</code> → <code data-plan-status="todo"
 *      class="pc-plan-status pc-plan-status--todo">todo</code>
 *   2. <li><strong>P-001</strong>...</li> → <li data-plan-item="P-001">,
 *      plus a sibling <sup class="pc-plan-badge"> rendering
 *      effectiveStatus when it differs from storedStatus.
 *   3. text "P-001" / "D-001" (outside its own item header, outside
 *      existing anchors / code / pre) → <a class="pc-plan-ref"
 *      data-plan-ref="P-001">P-001</a>.
 *
 * Click on a [data-plan-ref] scrolls the matching [data-plan-item] (or
 * its decision heading for D-NNN) into view and pulses
 * .pc-plan-highlight for 1.5s.
 */

import {
  attachPlanDocumentRefClickHandler,
  decoratePlanDocumentDom,
  findPlanDocumentHeading,
  scrollPlanDocumentTarget,
  stripPlanFrontmatter,
} from '@papercusp/ui-primitives';
import type { PlanItem } from './plans-api';

export function decoratePlanDom(root: HTMLElement, items: PlanItem[] | undefined): void {
  decoratePlanDocumentDom(root, items);
}

/**
 * Attach a delegated click listener on the rendered preview root.
 * Returns a teardown the caller invokes before re-attaching or on
 * unmount.
 */
export function attachPlanRefClickHandler(root: HTMLElement): () => void {
  return attachPlanDocumentRefClickHandler(root);
}

// ---------------------------------------------------------------------------
// P-006 — Plan-item feature status badges (per P-NNN item, via linkedFeatures)
// ---------------------------------------------------------------------------

const ITEM_STATUS_META: Record<string, { color: string; label: string }> = {
  todo:        { color: 'var(--fg-mute)',  label: 'todo'       },
  in_progress: { color: '#7aa2f7',         label: 'working'    },
  validating:  { color: '#c084fc',         label: 'validating' },
  failing:     { color: '#f7768e',         label: 'failing'    },
  passed:      { color: '#9ece6a',         label: 'passed'     },
  blocked:     { color: '#e0af68',         label: 'blocked'    },
};

/**
 * After decoratePlanDom runs (which sets data-plan-item on each <li>),
 * inject a live feature status badge next to each item that has a
 * linked feature in the linkedFeatures map from plans:get.
 *
 * Idempotent: removes previously injected badges before re-decorating.
 */
export function decoratePlanItemBadges(
  root: HTMLElement,
  linkedFeatures: Record<string, { featureId: string; status: string }>,
): void {
  if (Object.keys(linkedFeatures).length === 0) return;

  for (const old of Array.from(root.querySelectorAll('.pc-item-feature-badge'))) {
    old.remove();
  }

  for (const li of Array.from(root.querySelectorAll<HTMLElement>('li[data-plan-item]'))) {
    const itemId = li.dataset.planItem;
    if (!itemId) continue;
    const link = linkedFeatures[itemId];
    if (!link) continue;

    const status = link.status ?? 'todo';
    const meta = ITEM_STATUS_META[status] ?? ITEM_STATUS_META['todo'];

    const badge = document.createElement('span');
    badge.className = 'pc-item-feature-badge';
    badge.textContent = `${link.featureId} · ${meta.label}`;
    badge.style.cssText = [
      `color: ${meta.color}`,
      `background: color-mix(in oklab, ${meta.color}, transparent 85%)`,
      `border: 1px solid color-mix(in oklab, ${meta.color}, transparent 58%)`,
      'font-size: 10px',
      'font-weight: 500',
      'padding: 1px 6px',
      'border-radius: 3px',
      'margin-left: 8px',
      'vertical-align: middle',
      'white-space: nowrap',
      'cursor: pointer',
    ].join(';');
    badge.title = `Feature ${link.featureId} — status: ${status}`;
    badge.dataset.featureId = link.featureId;

    // Insert after the first <strong> (the P-NNN id), or at end of li.
    const firstStrong =
      li.querySelector<HTMLElement>(':scope > strong') ??
      li.querySelector<HTMLElement>(':scope > p > strong');
    if (firstStrong) {
      firstStrong.after(badge);
    } else {
      li.appendChild(badge);
    }
  }
}

// P-083 — Per-plan-item test-coverage badge (the plan↔test rollup via the VAL).
// Sibling to decoratePlanItemBadges; data comes from plans:get's `planItemTests`
// map (computed server-side from harness_plan_assertions ⋈ harness_tests).
interface ItemTestCoverage {
  valsRequiringTest: number;
  valsCovered: number;
  valsPassing: number;
}

/**
 * Inject a `✓ pass/required` test-coverage badge next to each P-NNN item that
 * has test-requiring VAL assertions. Green = all passing, amber = partial,
 * red = covered-but-none-passing, grey = none covered yet. Items with no
 * test-requiring VAL get no badge. Idempotent.
 */
export function decoratePlanItemTestBadges(
  root: HTMLElement,
  planItemTests: Record<string, ItemTestCoverage>,
): void {
  for (const old of Array.from(root.querySelectorAll('.pc-item-test-badge'))) {
    old.remove();
  }
  if (!planItemTests || Object.keys(planItemTests).length === 0) return;

  for (const li of Array.from(root.querySelectorAll<HTMLElement>('li[data-plan-item]'))) {
    const itemId = li.dataset.planItem;
    if (!itemId) continue;
    const cov = planItemTests[itemId];
    if (!cov || cov.valsRequiringTest === 0) continue; // nothing to gate on

    const { valsRequiringTest: req, valsCovered: covered, valsPassing: pass } = cov;
    const color =
      pass === req ? 'var(--good, #34d399)'
      : covered === 0 ? 'var(--fg-mute, #7f9bb4)'
      : pass === 0 ? 'var(--bad, #f87171)'
      : 'var(--warn, #fbbf24)';

    const badge = document.createElement('span');
    badge.className = 'pc-item-test-badge';
    badge.textContent = `✓ ${pass}/${req}`;
    badge.style.cssText = [
      `color: ${color}`,
      `background: color-mix(in oklab, ${color}, transparent 85%)`,
      `border: 1px solid color-mix(in oklab, ${color}, transparent 58%)`,
      'font-size: 10px',
      'font-weight: 500',
      'padding: 1px 6px',
      'border-radius: 3px',
      'margin-left: 6px',
      'vertical-align: middle',
      'white-space: nowrap',
    ].join(';');
    badge.title = `Tests: ${pass}/${req} VAL(s) passing · ${covered}/${req} covered`;

    // Sit after the feature-status badge if present, else after the P-NNN id.
    const featureBadge = li.querySelector<HTMLElement>(':scope > .pc-item-feature-badge');
    const firstStrong =
      li.querySelector<HTMLElement>(':scope > strong') ??
      li.querySelector<HTMLElement>(':scope > p > strong');
    if (featureBadge) featureBadge.after(badge);
    else if (firstStrong) firstStrong.after(badge);
    else li.appendChild(badge);
  }
}

/**
 * Attach a delegated click listener for feature badges injected by
 * `decoratePlanItemBadges`. Clicks on `[data-feature-id]` call back
 * with the feature ID. Returns a teardown fn.
 */
export function attachFeatureBadgeClickHandler(
  root: HTMLElement,
  onFeatureClick: (featureId: string) => void,
): () => void {
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const badge = target?.closest<HTMLElement>('[data-feature-id]');
    if (!badge) return;
    const featureId = badge.dataset.featureId;
    if (!featureId) return;
    e.preventDefault();
    e.stopPropagation();
    onFeatureClick(featureId);
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

// ---------------------------------------------------------------------------
// P-013 — Promoted-block feature status badges
// ---------------------------------------------------------------------------

export interface PromotedFeature {
  featureId: string;
  title: string | null;
  status: string | null;
  harnessSlug: string;
}

const FEATURE_ID_RE = /\bF-[A-Z0-9]+-?\d*[A-Z0-9]*\b/g;

const PROMOTED_STATUS_META: Record<string, { color: string; label: string }> = {
  todo:        { color: 'var(--fg-mute)',  label: 'todo'       },
  in_progress: { color: '#7aa2f7',         label: 'working'    },
  validating:  { color: '#c084fc',         label: 'validating' },
  failing:     { color: '#f7768e',         label: 'failing'    },
  passed:      { color: '#9ece6a',         label: 'passed'     },
  blocked:     { color: '#e0af68',         label: 'blocked'    },
};

/**
 * After Vditor renders the plan in read-mode, find the `## Promoted`
 * section and inject a live status badge next to each feature ID found
 * in the checklist items.
 *
 * Idempotent: clears previously injected badges before re-decorating,
 * so calling this on every re-render is safe.
 */
export function decoratePromotedBlock(
  root: HTMLElement,
  features: PromotedFeature[],
): void {
  if (features.length === 0) return;

  // Remove any badges from a previous decoration pass.
  for (const old of Array.from(root.querySelectorAll('.pc-promoted-badge'))) {
    old.remove();
  }

  // Build a fast lookup: featureId → feature.
  const byId = new Map<string, PromotedFeature>();
  for (const f of features) byId.set(f.featureId, f);

  // Find the ## Promoted heading.
  let promotedHeading: HTMLElement | null = null;
  for (const h of Array.from(root.querySelectorAll<HTMLElement>('h2, h3'))) {
    if ((h.textContent ?? '').trim() === 'Promoted') {
      promotedHeading = h;
      break;
    }
  }
  if (!promotedHeading) return;

  // Collect list items under the Promoted heading until the next heading.
  const items: HTMLElement[] = [];
  let node: Element | null = promotedHeading.nextElementSibling;
  while (node && !node.matches('h2, h3')) {
    for (const li of Array.from(node.querySelectorAll<HTMLElement>('li'))) {
      items.push(li);
    }
    node = node.nextElementSibling;
  }

  for (const li of items) {
    const text = li.textContent ?? '';
    const matches = Array.from(text.matchAll(FEATURE_ID_RE));
    for (const m of matches) {
      const fid = m[0];
      const feature = byId.get(fid);
      if (!feature) continue;
      const status = feature.status ?? 'todo';
      const meta = PROMOTED_STATUS_META[status] ?? PROMOTED_STATUS_META['todo'];

      const badge = document.createElement('span');
      badge.className = 'pc-promoted-badge';
      badge.textContent = meta.label;
      badge.style.cssText = [
        `color: ${meta.color}`,
        `background: color-mix(in oklab, ${meta.color}, transparent 82%)`,
        `border: 1px solid color-mix(in oklab, ${meta.color}, transparent 55%)`,
        'font-size: 10px',
        'font-weight: 500',
        'padding: 1px 5px',
        'border-radius: 3px',
        'margin-left: 6px',
        'vertical-align: middle',
        'white-space: nowrap',
      ].join(';');
      badge.title = `${fid}: ${feature.title ?? ''} (${feature.harnessSlug})`;

      // Find the text node containing the feature ID and insert after it.
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let injected = false;
      let textNode: Text | null;
      while ((textNode = walker.nextNode() as Text | null) !== null) {
        const idx = textNode.textContent?.indexOf(fid) ?? -1;
        if (idx === -1) continue;
        const after = textNode.splitText(idx + fid.length);
        after.parentNode?.insertBefore(badge, after);
        injected = true;
        break;
      }
      if (!injected) {
        // Fallback: append badge at end of li.
        li.appendChild(badge);
      }
    }
  }
}

/**
 * Compute a human-readable summary of promoted features for the NowHero
 * strip. E.g. "5 features: 2 in-flight · 3 todo".
 */
export function buildFeatureSummary(features: PromotedFeature[]): string | null {
  if (features.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const f of features) {
    const s = f.status ?? 'todo';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const parts: string[] = [];
  const inflight = (counts['in_progress'] ?? 0) + (counts['validating'] ?? 0);
  if (inflight > 0) parts.push(`${inflight} in-flight`);
  if (counts['failing']) parts.push(`${counts['failing']} failing`);
  if (counts['passed']) parts.push(`${counts['passed']} passed`);
  if (counts['todo']) parts.push(`${counts['todo']} todo`);
  if (counts['blocked']) parts.push(`${counts['blocked']} blocked`);
  return parts.length > 0
    ? `${features.length} features: ${parts.join(' · ')}`
    : `${features.length} features`;
}

// ---------------------------------------------------------------------------
// Scroll-to-item + frontmatter helpers (shared by PlanDetail's full view and
// the PlanItemPreview read-only detail pane — one implementation, no drift).
// ---------------------------------------------------------------------------

/** Leading `---\nyaml\n---\n` YAML frontmatter — Vditor renders this as a
 *  low-contrast paragraph in read mode. The parsed values are already
 *  available via plans:get → data.frontmatter, so strip them from the prose. */
export function stripFrontmatter(src: string): string {
  return stripPlanFrontmatter(src);
}

/** Scroll a rendered plan body to a P-NNN item (`[data-plan-item]`) or a
 *  D-NNN decision (heading id / heading text), with a brief highlight pulse.
 *  Returns false if the anchor isn't in the DOM yet (caller retries). */
export function scrollPlanTarget(scope: HTMLElement | null, id: string): boolean {
  return scrollPlanDocumentTarget(scope, id);
}

export function findHeadingByText(scope: HTMLElement, id: string): HTMLElement | null {
  return findPlanDocumentHeading(scope, id);
}
