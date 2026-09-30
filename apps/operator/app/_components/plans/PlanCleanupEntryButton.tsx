'use client';

/**
 * The shared one-plan entry for cleanup-report-flows P-009. Both the plan-row
 * broom and the plan-dashboard action seed the existing clean-up machinery with
 * exactly one slug, then hand its durable run id to the URL-owned `?opcln=`
 * state. The report host takes over automatically if that run reaches review.
 */
import { useState } from 'react';
import { BrushCleaning, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip } from '@/app/harness/Tooltip';
import { usePlanCleanupOps } from './use-plan-cleanup-run';

export interface PlanCleanupEntryButtonProps {
  planSlug: string;
  harness: string | null;
  title: string;
  appearance: 'row' | 'dashboard';
  onRunStarted: (runId: string) => void;
  active?: boolean;
}

export default function PlanCleanupEntryButton({
  planSlug,
  harness,
  title,
  appearance,
  onRunStarted,
  active = false,
}: PlanCleanupEntryButtonProps) {
  const { start } = usePlanCleanupOps();
  const [starting, setStarting] = useState(false);
  const busy = starting || active;

  const onStart = async () => {
    if (busy) return;
    setStarting(true);
    try {
      const result = await start(
        [planSlug],
        {
          scope: 'single-plan',
          entryPoint: appearance === 'row' ? 'plans-row' : 'plan-dashboard',
          shownCount: 1,
          planSlug,
          harness,
        },
        harness,
      );
      if (!result.ok) {
        toast.error(`Could not start clean-up: ${result.error ?? 'unknown error'}`);
        return;
      }
      if (!result.runId) {
        toast.error('Clean-up started without a durable run id.');
        return;
      }

      onRunStarted(result.runId);
      if (result.resolverNeeded === false && !result.launchError) {
        const applied = result.deterministic?.applied ?? 0;
        toast.success(
          applied > 0
            ? `Clean-up finished deterministically for “${title}” · ${applied} fix${applied === 1 ? '' : 'es'} applied.`
            : `“${title}” is already clean — no resolver needed.`,
        );
        return;
      }
      if (!result.launched) {
        toast.error(
          `Clean-up run saved, but its resolver could not start${result.launchError ? `: ${result.launchError}` : '.'}`,
        );
        return;
      }
      toast.success(`Clean-up started for “${title}”.`);
    } finally {
      setStarting(false);
    }
  };

  if (appearance === 'row') {
    const tooltip = active ? 'Clean-up is running for this plan' : 'Clean up this plan';
    return (
      <Tooltip label={tooltip}>
        <button
          type="button"
          className="plans-pane__cleanup"
          onClick={() => void onStart()}
          disabled={busy}
          aria-label={active ? `Clean-up running for ${title}` : `Clean up ${title}`}
          data-testid={`plans-pane-cleanup-${planSlug}`}
        >
          <span className="plans-pane__row-action-icon" aria-hidden="true">
            {busy ? <Loader2 size={12} /> : <BrushCleaning size={12} />}
          </span>
        </button>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      className="plan-dash__btn plan-dash__btn--ghost"
      onClick={() => void onStart()}
      disabled={busy}
      data-testid="plan-dash-cleanup"
    >
      {busy ? (
        <Loader2 size={11} aria-hidden="true" />
      ) : (
        <BrushCleaning size={11} aria-hidden="true" />
      )}
      {busy ? 'Cleaning…' : 'Clean up'}
    </button>
  );
}
