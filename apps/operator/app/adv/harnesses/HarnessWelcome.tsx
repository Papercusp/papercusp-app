'use client';

/**
 * HarnessWelcome — the harness-tab no-work welcome empty-state.
 *
 * Plan: spec-md-ui-deprecation-cleanup-2026-05-30 P-005 (copy decided
 * verbatim by the owner in D-002/D-003). Shown as an overlay on the
 * harness dock when the focused harness has loaded with ZERO features
 * and ZERO issues — i.e. nothing for agents to work on yet. The old
 * SPEC.md bootstrap CTA this replaces died with HarnessDashboard
 * (ad5897d58); this is its plans-era successor.
 *
 * Gating is deliberately conservative: while the exact work-item aggregate
 * is loading or errored, the welcome stays hidden so it can never mask a real
 * dashboard. Dismissal rides nuqs (`?welcome=0`) per the
 * state-in-the-URL rule; the brainstorm/plans CTAs write the same
 * `?tab=` param the /adv index reads (plain strings — `@/app` cannot
 * import operator-vite's AdvTabId).
 */

import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';

type WorkItemStatRow = { n?: number | string | null };

/**
 * True only when the exact server-side work-item count has loaded cleanly and
 * is zero — "this harness has no work yet". This reuses workItems.stats rather
 * than mounting the complete feature and issue corpora just to ask `length ===
 * 0`. Loading and error states return false so the overlay never covers a
 * dashboard whose contents are merely unknown.
 */
export function useHarnessHasNoWork(slug: string): boolean {
  const { data, loading, error } = useSyncQuery<WorkItemStatRow>({
    queryName: 'workItems.stats',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: Boolean(slug),
  });
  if (!slug || loading || error || !Array.isArray(data)) return false;
  return data.reduce((total, row) => total + Math.max(0, Number(row.n) || 0), 0) === 0;
}

export interface HarnessWelcomeCardProps {
  onOpenBrainstorm: () => void;
  onOpenPlans: () => void;
  onDismiss: () => void;
}

/** Presentational card — the D-002 copy verbatim + tab CTAs. */
export function HarnessWelcomeCard({
  onOpenBrainstorm,
  onOpenPlans,
  onDismiss,
}: HarnessWelcomeCardProps) {
  const t = useLexicon();
  return (
    <div className="pc-harness-welcome" data-testid="harness-welcome" role="status">
      <div className="pc-harness-welcome__card">
        <h2 className="pc-harness-welcome__title">Welcome to your {t('pot')}.</h2>
        <p className="pc-harness-welcome__copy">
          Come up with ideas in the brainstorm tab, plan them in the plan tab.
          Start them, and then watch agents work on them in the {t('pot')} tab.
        </p>
        <div className="pc-harness-welcome__actions">
          <button
            type="button"
            className="pc-harness-welcome__cta"
            onClick={onOpenBrainstorm}
          >
            Open Brainstorm
          </button>
          <button
            type="button"
            className="pc-harness-welcome__cta"
            onClick={onOpenPlans}
          >
            Open Plans
          </button>
        </div>
        <button
          type="button"
          className="pc-harness-welcome__dismiss"
          onClick={onDismiss}
        >
          Explore the empty dashboard anyway
        </button>
      </div>
      <style>{`
        .pc-harness-welcome {
          position: absolute;
          inset: 0;
          z-index: 4;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: color-mix(in oklab, var(--bg, #0b0b14), transparent 18%);
          backdrop-filter: blur(2px);
        }
        .pc-harness-welcome__card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          max-width: 460px;
          padding: 28px 32px;
          background: var(--bg-2, #14141f);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 70%);
          border-radius: 10px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
          text-align: center;
        }
        .pc-harness-welcome__title {
          margin: 0;
          font-size: 17px;
          font-weight: 700;
          color: var(--fg, #ece9ff);
        }
        .pc-harness-welcome__copy {
          margin: 0;
          font-size: 13px;
          line-height: 1.6;
          color: var(--fg-dim, #b9d4e8);
        }
        .pc-harness-welcome__actions {
          display: flex;
          gap: 10px;
        }
        .pc-harness-welcome__cta {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%);
          color: var(--fg, #e7f7ff);
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .pc-harness-welcome__cta:hover {
          background: color-mix(in oklab, var(--accent, #38bdf8), transparent 65%);
        }
        .pc-harness-welcome__dismiss {
          background: none;
          border: none;
          padding: 2px 4px;
          font-size: 11.5px;
          color: var(--fg-mute, #7f9bb4);
          text-decoration: underline;
          cursor: pointer;
        }
        .pc-harness-welcome__dismiss:hover {
          color: var(--fg-dim, #b9d4e8);
        }
      `}</style>
    </div>
  );
}

/**
 * Gated welcome overlay for the harness tab. Renders null unless the
 * focused harness has provably no work and the user hasn't dismissed
 * it (`?welcome=0`). Mount as a sibling of HarnessesDock inside the
 * relative `.pc-adv-harnesses__dock` wrapper.
 */
export default function HarnessWelcome({ slug }: { slug: string }) {
  const [, setTab] = useQueryState('tab', parseAsString.withDefault('overview'));
  const [showWelcome, setShowWelcome] = useQueryState(
    'welcome',
    parseAsBoolean.withDefault(true),
  );
  const noWork = useHarnessHasNoWork(slug);
  if (!slug || !noWork || !showWelcome) return null;
  return (
    <HarnessWelcomeCard
      onOpenBrainstorm={() => void setTab('brainstorm')}
      onOpenPlans={() => void setTab('plans')}
      onDismiss={() => void setShowWelcome(false)}
    />
  );
}
