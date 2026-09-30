'use client';


/**
 * PotMemberRail — the in-tab member selector for the Harnesses tab
 * (harnesses-tab-hive-model-2026-06-07 P-002).
 *
 * THIS is the "place to select the harnesses" the tab was missing: a
 * collapsible left rail listing the selected hive's members (root first, then
 * its `parent_slug` children — supplied by `hiveMembers` in ./harness-axis).
 * Clicking a member sets `?harness=` (the member-focus axis from P-001) so the
 * dock swaps to that member.
 *
 * Zero-regression for solo harnesses: a single-member hive renders nothing
 * (there is nothing to pick) — the dock looks exactly as it did before this
 * plan. Multi-member hives render the rail; the open/closed state lives in the
 * URL (`?rail=`, nuqs house rule) so it survives reload and is agent-driveable.
 *
 * Presentational + flag-gated labels only (D-006): the hive/member words route
 * through `useLexicon` ("Pot"/"Hive", "Harness"/"Harnesses"). The liveness dot
 * reuses the `hasState` flag already in the projects/lite payload — no new
 * poller (the brief's explicit constraint).
 */

import { parseAsBoolean, useQueryState } from 'nuqs';
import { ChevronLeft, ChevronRight, Home, Share2 } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import { Tooltip } from '../../harness/Tooltip';
import type { HiveMember } from './harness-axis';

export interface HiveMemberRailProps {
  /** The hive's members, root-first (from `hiveMembers`). */
  members: readonly HiveMember[];
  /** The currently-focused member (the resolved `dockSlug`). */
  activeSlug: string | null;
  /** Select a member → the caller writes `?harness=`. */
  onSelect: (slug: string) => void;
  /**
   * Optional zero-new-poller liveness hint, keyed by slug — `hasState` from
   * the already-fetched projects/lite payload (the harness has been set up).
   */
  livenessBySlug?: Record<string, boolean>;
}

export default function PotMemberRail({
  members,
  activeSlug,
  onSelect,
  livenessBySlug,
}: HiveMemberRailProps) {
  const t = useLexicon();
  // Open/closed in the URL (house rule: user-meaningful UI state → nuqs, so
  // agents can drive it and it survives reload). Default open for a
  // multi-member hive.
  const [open, setOpen] = useQueryState('rail', parseAsBoolean.withDefault(true));

  // Solo hive (root only, or nothing): no member choice exists — render
  // nothing so the dock is byte-identical to the pre-plan single-harness view.
  if (members.length <= 1) return null;

  const hiveLabel = t('pot');
  const membersLabel = t('harness', { plural: true });

  if (!open) {
    return (
      <aside
        className="pc-pot-rail pc-pot-rail--collapsed"
        data-testid="pot-member-rail"
        data-collapsed="true"
        aria-label={`${hiveLabel} ${membersLabel.toLowerCase()}`}
      >
        <Tooltip label={`Show ${membersLabel.toLowerCase()} (${members.length})`}>
          <button
            type="button"
            className="pc-pot-rail__expand"
            onClick={() => void setOpen(true)}
          >
            <ChevronRight size={14} aria-hidden />
            <span className="pc-pot-rail__count">{members.length}</span>
          </button>
        </Tooltip>
        <RailStyles />
      </aside>
    );
  }

  return (
    <aside
      className="pc-pot-rail"
      data-testid="pot-member-rail"
      data-collapsed="false"
      aria-label={`${hiveLabel} ${membersLabel.toLowerCase()}`}
    >
      <div className="pc-pot-rail__head">
        <span className="pc-pot-rail__title">
          {membersLabel}
          <span className="pc-pot-rail__title-count">{members.length}</span>
        </span>
        <Tooltip label={`Hide ${membersLabel.toLowerCase()}`}>
          <button
            type="button"
            className="pc-pot-rail__collapse"
            aria-label={`Hide ${membersLabel.toLowerCase()}`}
            onClick={() => void setOpen(false)}
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <ul className="pc-pot-rail__list" role="list">
        {members.map((m) => {
          const active = m.slug === activeSlug;
          const live = livenessBySlug?.[m.slug] ?? false;
          return (
            <li key={m.slug}>
              <Tooltip label={m.slug}><button
                type="button"
                data-testid={`hive-member-${m.slug}`}
                className={`pc-pot-rail__item${active ? ' is-active' : ''}`}
                aria-current={active ? 'true' : undefined}

                onClick={() => onSelect(m.slug)}
              >
                <span
                  className={`pc-pot-rail__dot${live ? ' is-live' : ''}`}
                  title={live ? 'Harness has state' : 'Not set up yet'}
                  aria-hidden
                />
                <span className="pc-pot-rail__name">{m.slug}</span>
                {m.isRoot && (
                  <Home
                    size={12}
                    className="pc-pot-rail__root"
                    aria-label={`${hiveLabel} root`}
                  />
                )}
                {m.harness_kind && m.harness_kind !== 'harness' && (
                  <span className="pc-pot-rail__kind">{m.harness_kind}</span>
                )}
                {m.is_shared && (
                  <Share2
                    size={11}
                    className="pc-pot-rail__shared"
                    aria-label="Shared"
                  />
                )}
              </button></Tooltip>
            </li>
          );
        })}
      </ul>
      <RailStyles />
    </aside>
  );
}

function RailStyles() {
  return (
    <style>{`
      .pc-pot-rail {
        flex: 0 0 auto;
        width: 196px;
        min-width: 0;
        display: flex;
        flex-direction: column;
        border-right: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 82%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 94%);
        overflow: hidden;
      }
      .pc-pot-rail--collapsed {
        width: 34px;
        align-items: center;
        padding-top: 8px;
      }
      .pc-pot-rail__expand {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 6px 0;
        width: 100%;
        background: transparent;
        border: none;
        color: var(--accent-strong, #7dd3fc);
        cursor: pointer;
      }
      .pc-pot-rail__expand:hover { color: var(--fg, #e7f7ff); }
      .pc-pot-rail__count {
        font-size: 11px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .pc-pot-rail__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
      }
      .pc-pot-rail__title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 760;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-pot-rail__title-count {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-pot-rail__collapse {
        display: inline-flex;
        background: transparent;
        border: none;
        color: var(--fg-mute, #7f9bb4);
        cursor: pointer;
        padding: 2px;
        border-radius: 4px;
      }
      .pc-pot-rail__collapse:hover { color: var(--fg, #e7f7ff); }
      .pc-pot-rail__list {
        list-style: none;
        margin: 0;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow-y: auto;
        min-height: 0;
      }
      .pc-pot-rail__item {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 6px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        color: var(--fg-dim, #b9d4e8);
        font-size: 12.5px;
        text-align: left;
        cursor: pointer;
      }
      .pc-pot-rail__item:hover {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        color: var(--fg, #e7f7ff);
      }
      .pc-pot-rail__item.is-active {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 74%);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 52%);
        color: var(--fg, #e7f7ff);
        font-weight: 650;
      }
      .pc-pot-rail__dot {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--fg-dim, #b9d4e8), transparent 72%);
        box-shadow: inset 0 0 0 1px var(--bg-3, rgba(255, 255, 255, 0.075));
      }
      .pc-pot-rail__dot.is-live {
        background: var(--good, #34d399);
        box-shadow: 0 0 6px color-mix(in srgb, var(--good, #34d399), transparent 40%);
      }
      .pc-pot-rail__name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-pot-rail__root { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-pot-rail__kind {
        flex: 0 0 auto;
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-pot-rail__shared { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
    `}</style>
  );
}
