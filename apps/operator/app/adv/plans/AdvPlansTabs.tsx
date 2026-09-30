'use client';

/**
 * AdvPlansTabs — VSCode-style tab strip sitting above PlansClient.
 *
 * Tab model:
 *   - `index` (pinned, leftmost, not closeable) — the rail + plan
 *     browser; active when no plan is open and the query is empty.
 *   - `search` (pinned, not closeable) — active whenever the query
 *     input is non-empty; mounts PlanSearchResults via PlansClient's
 *     existing behavior.
 *   - `plan:<slug>` (additive, closeable) — one per opened plan;
 *     active when its plan is the open one.
 *
 * The strip is a *view layer* over PlansClient's existing nuqs state
 * (`plan`/`q`/`tabs`): clicking a tab adjusts those query params, and
 * the strip observes them to keep the active highlight + open-plan
 * list in sync. The list of currently-open plan tabs persists in
 * `?tabs=` so a reload restores them; the active tab is derived from
 * (plan, q) so we don't keep an authoritative `activeTab` query
 * separately — single source of truth wins. The main-pane Plans/Inbox
 * mode is PlansClient's own `?view=` and is intentionally not driven
 * from here.
 */

import { useEffect, useMemo } from 'react';
import {
  parseAsArrayOf,
  parseAsString,
  parseAsStringEnum,
  useQueryState,
} from 'nuqs';
import { usePlanList } from '../../admin/plans/plans-api';

type PaneMode = 'read' | 'edit';

interface Tab {
  id: string;
  label: string;
  hint?: string;
  closeable: boolean;
}

export default function AdvPlansTabs({ children }: { children: React.ReactNode }) {
  // The OPEN-PLAN slug. Lives on `?plan=`, NOT `?slug=` — `?slug=` is
  // AdvShell's active-harness key, shared across every /adv tab.
  const [slug, setSlug] = useQueryState('plan', parseAsString);
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [, setPane] = useQueryState(
    'pane',
    parseAsStringEnum<PaneMode>(['read', 'edit']).withDefault('read'),
  );
  const [openSlugs, setOpenSlugs] = useQueryState(
    'tabs',
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  const queryTrimmed = q.trim();

  // Pull plan titles so tab labels are human-readable, not raw slugs.
  // PlansClient already mounts a copy of this hook for the rail — the
  // shared SWR/Zero cache (whatever usePlanList is built on) makes the
  // second mount cheap.
  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const titleBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of planList.data?.plans ?? []) {
      if (p.title) map.set(p.slug, p.title);
    }
    return map;
  }, [planList.data]);

  // Push every newly-opened plan onto the tab stack (de-duped, order
  // preserved). This is the "click a plan in the rail → it appears
  // as a new tab" wiring.
  useEffect(() => {
    if (slug && !openSlugs.includes(slug)) {
      void setOpenSlugs([...openSlugs, slug]);
    }
  }, [slug, openSlugs, setOpenSlugs]);

  // Derive the active tab from PlansClient state. Order matters:
  //   - open plan wins (user is reading a plan)
  //   - then search if the query is non-empty
  //   - then index
  const activeTabId: string = slug
    ? `plan:${slug}`
    : queryTrimmed
      ? 'search'
      : 'index';

  const tabs: Tab[] = useMemo(() => {
    const base: Tab[] = [
      { id: 'index', label: 'Plans', closeable: false },
      {
        id: 'search',
        label: queryTrimmed ? `Search: "${truncate(queryTrimmed, 28)}"` : 'Search',
        closeable: false,
      },
    ];
    for (const s of openSlugs) {
      const label = labelForPlan(s, titleBySlug.get(s) ?? null);
      base.push({ id: `plan:${s}`, label, hint: s, closeable: true });
    }
    return base;
  }, [queryTrimmed, openSlugs, titleBySlug]);

  const focus = (tabId: string) => {
    if (tabId === 'index') {
      void setPane('read');
      void setSlug(null);
      void setQ('');
    } else if (tabId === 'search') {
      void setPane('read');
      void setSlug(null);
      if (!queryTrimmed) {
        // Search tab focused with no query — focus the search input
        // so the user can immediately type. PlansClient's PlanFilters
        // owns the input and tags it with `data-plan-search-input`.
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLInputElement>('[data-plan-search-input]');
          el?.focus();
        });
      }
    } else if (tabId.startsWith('plan:')) {
      const next = tabId.slice('plan:'.length);
      void setPane('read');
      void setSlug(next);
    }
  };

  const close = (tabId: string) => {
    if (!tabId.startsWith('plan:')) return;
    const planSlug = tabId.slice('plan:'.length);
    const idx = openSlugs.indexOf(planSlug);
    const remaining = openSlugs.filter((s) => s !== planSlug);
    void setOpenSlugs(remaining);
    if (activeTabId !== tabId) return;
    // Closing the active tab — fall back to the neighbor on the right,
    // then left, then to the index tab.
    const fallback = remaining[idx] ?? remaining[idx - 1];
    if (fallback) {
      void setSlug(fallback);
    } else {
      void setSlug(null);
    }
  };

  return (
    <div className="pc-adv-plans">
      <div className="pc-adv-tabstrip" role="tablist" aria-label="Open plans">
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          return (
            <span
              key={t.id}
              className={`pc-adv-tab${isActive ? ' is-active' : ''}${t.closeable ? '' : ' is-pinned'}`}
              role="tab"
              aria-selected={isActive}
              aria-label={t.hint ?? t.label}
            >
              <button
                type="button"
                className="pc-adv-tab__label"
                onClick={() => focus(t.id)}
              >
                {t.label}
              </button>
              {t.closeable ? (
                <button
                  type="button"
                  className="pc-adv-tab__close"
                  aria-label={`Close ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      <div className="pc-adv-plans__body">{children}</div>
      <style>{`
        .pc-adv-plans {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .pc-adv-plans__body {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .pc-adv-tabstrip {
          flex: 0 0 auto;
          display: flex;
          align-items: stretch;
          gap: 3px;
          overflow-x: auto;
          padding: 6px 10px 0;
          border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          scrollbar-width: thin;
        }
        .pc-adv-tab {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 28px;
          max-width: 240px;
          padding: 0 6px 0 10px;
          border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          border-bottom-color: transparent;
          border-radius: 8px 8px 0 0;
          background: color-mix(in oklab, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 25%);
          color: var(--fg-dim, #b9d4e8);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0;
          white-space: nowrap;
        }
        .pc-adv-tab.is-pinned {
          background: color-mix(in oklab, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 20%);
        }
        .pc-adv-tab.is-active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
          border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 48%);
        }
        .pc-adv-tab__label {
          all: unset;
          cursor: pointer;
          padding: 0 4px;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pc-adv-tab__label:focus-visible { outline: 1px dashed var(--accent-strong, #7dd3fc); }
        .pc-adv-tab__close {
          all: unset;
          cursor: pointer;
          padding: 0 6px;
          color: var(--fg-mute, #7f9bb4);
          border-radius: 4px;
        }
        .pc-adv-tab__close:hover { color: var(--fg, #e7f7ff); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%); }
      `}</style>
    </div>
  );
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Pick a readable label for a plan tab:
 *   - plan title (best — what a human wrote)
 *   - else slug with the trailing `-YYYY-MM-DD` date suffix stripped
 *   - else slug verbatim
 * Capped at 32 chars with an ellipsis.
 */
export function labelForPlan(slug: string, title: string | null): string {
  if (title && title.trim()) return truncate(title.trim(), 32);
  const stripped = slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return truncate(stripped, 32);
}
