'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * QueueCardActions — the Queue detail-pane action buttons, rendered in the
 * toolbar (next to "View full plan") instead of inside the AskChoiceCard (#4).
 *
 * Driven by the same `attentionItemToCardSpec(item).options` the card used, so
 * the dispatch is unchanged: terminal options fire `submit` (resolve/drop),
 * navigate options (terminal:false — e.g. Answer / 💬 Chat) fire `navigate`.
 * The parent's existing onResponse handler does the rest. Once the item is
 * answered/resolved, the buttons collapse to a "✓ <picks>" summary.
 */

import type {
  AskChoiceArgs,
  AskChoiceResponse,
  AskChoiceAnswered,
} from '@/app/_components/chat/AskChoiceCard';

export function QueueCardActions({
  options,
  answered,
  busy = false,
  onResponse,
}: {
  options: AskChoiceArgs['options'];
  answered?: AskChoiceAnswered;
  busy?: boolean;
  onResponse: (r: AskChoiceResponse) => void;
}) {
  if (answered) {
    return (
      <span className="pc-items__action-done" aria-live="polite">
        ✓ {answered.picks.map((p) => p.label).join(' · ')}
      </span>
    );
  }
  if (!options.length) return null;
  return (
    <div className="pc-items__detail-actions" role="group" aria-label="Item actions">
      {options.map((opt) => {
        const isNav = opt.terminal === false;
        return (
          <Tooltip key={opt.id} label={opt.hint ?? opt.label}><button

            type="button"
            disabled={busy}
            className={`pc-items__action pc-items__action--${opt.style ?? 'default'}${isNav ? ' pc-items__action--nav' : ''}`}

            onClick={() =>
              onResponse(
                isNav
                  ? { action: 'navigate', option_id: opt.id, label: opt.label }
                  : { action: 'submit', picks: [{ option_id: opt.id, label: opt.label }] },
              )
            }
          >
            {opt.label}
          </button></Tooltip>
        );
      })}
    </div>
  );
}
