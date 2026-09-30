'use client';

/**
 * InsightsTab — Phase 8 P-073, extended with sub-tabs in B-TOK-UI
 * (token-tracking-plan-and-briefs-2026-06-20).
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 — pinned-top sidebar tab; post-install default landing.
 *
 * Two sub-views (nuqs `?insightView=overview|tokens`, the LearningTab `?lview`
 * pattern — all user-meaningful state in the URL, CLAUDE.md):
 *
 *   - **Overview** (default): the canonical six-card layout —
 *
 *       ┌─────────────────────────────────────────────────┐
 *       │  ProjectCard (full width)                        │
 *       ├─────────────────────────┬───────────────────────┤
 *       │  ActivityFeedCard       │  YourPlaceCard         │
 *       │  (large left col)       │  SpendCard             │
 *       ├─────────────────────────┼───────────────────────┤
 *       │  PeopleCard             │                        │
 *       ├─────────────────────────┴───────────────────────┤
 *       │  HowItWorksHereCard (full width)                 │
 *       └─────────────────────────────────────────────────┘
 *
 *     Pure UI; consumer feeds pre-computed props per card.
 *
 *   - **Tokens**: the cache-inclusive token/cost dashboard (TokensView),
 *     self-fetching through the `insights.tokens` sync resolver by harness slug —
 *     the SpendCard's single total, broken down by model / role / day.
 *
 * The Overview path stays render-only; only the Tokens sub-view fetches. The
 * harness `slug` (held by every caller — the Vite route + the two /adv panels)
 * is threaded in so the Tokens view can scope its query.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { BarChart3, Coins } from 'lucide-react';
import type { InsightsTabProps } from '@papercusp/operator-core/lib/harness-insights/card-types';
import { ProjectCard } from './ProjectCard';
import { ActivityFeedCard } from './ActivityFeedCard';
import { PeopleCard } from './PeopleCard';
import { YourPlaceCard } from './YourPlaceCard';
import { HowItWorksHereCard } from './HowItWorksHereCard';
import { SpendCard } from './SpendCard';
import { TokensView } from './TokensView';

const INSIGHT_VIEWS = ['overview', 'tokens'] as const;
type InsightView = (typeof INSIGHT_VIEWS)[number];

const CONTAINER: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 16,
  padding: 16,
};

const TWO_COL: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2fr 1fr',
  gap: 16,
};

const ONE_COL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const SUBNAV: CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: '12px 16px 0',
  borderBottom: '1px solid var(--border)',
};

function subtabStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 12px',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: active ? 'var(--fg)' : 'var(--fg-dim)',
    borderBottom: active ? '2px solid var(--accent, #6366f1)' : '2px solid transparent',
    marginBottom: -1,
  };
}

export type { InsightsTabProps };

/** The canonical six-card Overview — render-only, prop-fed (unchanged from P-073). */
function OverviewView(props: InsightsTabProps): ReactNode {
  const { project, activity, people, yourPlace, howItWorks, spend } = props;
  return (
    <div style={CONTAINER} data-testid="insights-overview">
      <ProjectCard {...project} />
      <div style={TWO_COL}>
        <ActivityFeedCard {...activity} />
        <div style={ONE_COL}>
          <YourPlaceCard {...yourPlace} />
          <SpendCard {...spend} />
        </div>
      </div>
      <div style={TWO_COL}>
        <PeopleCard {...people} />
        {/* right slot reserved for future card; for now intentionally empty */}
        <div />
      </div>
      <HowItWorksHereCard {...howItWorks} />
    </div>
  );
}

export function InsightsTab(props: InsightsTabProps & { slug: string }): ReactNode {
  const { slug, ...cards } = props;
  const [view, setView] = useQueryState(
    'insightView',
    parseAsStringEnum<InsightView>([...INSIGHT_VIEWS]).withDefault('overview'),
  );
  const active: InsightView = (INSIGHT_VIEWS as readonly string[]).includes(view) ? view : 'overview';

  return (
    <div data-testid="insights-tab">
      <div style={SUBNAV} role="tablist" aria-label="Insights view">
        <button
          type="button"
          role="tab"
          aria-selected={active === 'overview'}
          style={subtabStyle(active === 'overview')}
          onClick={() => void setView('overview')}
        >
          <BarChart3 size={14} aria-hidden /> Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={active === 'tokens'}
          style={subtabStyle(active === 'tokens')}
          onClick={() => void setView('tokens')}
        >
          <Coins size={14} aria-hidden /> Tokens
        </button>
      </div>

      {active === 'tokens' ? <TokensView slug={slug} /> : <OverviewView {...cards} />}
    </div>
  );
}
