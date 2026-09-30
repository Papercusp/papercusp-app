/**
 * HumanQueueDrain — the "decide next" panel over the human review queue
 * (self-improvement-consume-edges-2026-06-12 P-022 / B-08).
 *
 * The Learning tab's human lane arrives from `learning.improvements` ALREADY
 * ordered by blocking impact (blocking-impact.ts — what is actually waiting on
 * each item, not just severity/age). This panel surfaces the top of that order
 * as the owner's drain ritual: the top card is the one thing to decide now,
 * each with its "why this ranks here" reasons. Clicking a card highlights the
 * full row in the list below (the existing `?lsel` deep-link).
 *
 * Render-only — data and ordering come from the resolver; the weekly
 * owner digest (human-queue-digest-action.ts) sends the same top-5.
 */
import { ListOrdered } from 'lucide-react';
import type { ScoredItem } from '@papercusp/operator-core/lib/harness/improvements/digest';
import type { BlockingImpact } from '@papercusp/operator-core/lib/harness/improvements/blocking-impact';
import { Tooltip } from '@/app/harness/Tooltip';

const TOP_N = 5;

/** The resolver enriches human-lane items with `impact`; older cached shapes may lack it. */
function impactOf(item: ScoredItem): BlockingImpact | null {
  const impact = (item as ScoredItem & { impact?: BlockingImpact }).impact;
  return impact && typeof impact.score === 'number' ? impact : null;
}

export default function HumanQueueDrain({
  items,
  onSelect,
}: {
  /** The human queue, in resolver (blocking-impact) order. */
  items: ScoredItem[];
  /** Highlight an item in the main list (sets `?lsel`). */
  onSelect?: (id: string) => void;
}) {
  const top = items.slice(0, TOP_N);
  if (top.length === 0) return null;
  return (
    <aside className="pc-hqdrain" aria-label="Decide next — highest blocking impact first">
      <div className="pc-hqdrain__head">
        <h3>
          <ListOrdered size={13} aria-hidden /> Decide next
        </h3>
        <span className="pc-hqdrain__hint" title="Ranked by what is waiting on each item: blocks-edges, references, open re-captures of the same friction, watchdog persistence — aged up the longer it sits.">
          by blocking impact{items.length > top.length ? ` · ${items.length} waiting` : ''}
        </span>
      </div>
      <ol className="pc-hqdrain__list">
        {top.map((it) => {
          const impact = impactOf(it);
          return (
            <li key={it.id}>
              <Tooltip label={impact?.reasons.length ? impact.reasons.join('; ') : 'No downstream signals yet — ranked by severity and age'}>
                <button
                  type="button"
                  className="pc-hqdrain__item"
                  onClick={onSelect ? () => onSelect(it.id) : undefined}
                >
                  <span className="pc-hqdrain__id">{it.id}</span>
                  <span className="pc-hqdrain__title">{it.title}</span>
                  {impact ? (
                    <span className="pc-hqdrain__score" aria-label={`Blocking impact ${impact.score}`}>
                      {impact.score}
                    </span>
                  ) : null}
                  {impact?.reasons.length ? <span className="pc-hqdrain__why">{impact.reasons.join(' · ')}</span> : null}
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
      <style>{`
        .pc-hqdrain {
          display: flex; flex-direction: column; gap: 7px;
          padding: 11px 13px; border-radius: 10px;
          border: 1px solid rgba(252, 211, 77, 0.28);
          background: rgba(252, 211, 77, 0.05);
        }
        .pc-hqdrain__head { display: flex; align-items: baseline; gap: 8px; }
        .pc-hqdrain__head h3 {
          display: inline-flex; align-items: center; gap: 5px; margin: 0;
          font-size: 12px; font-weight: 740; color: #fcd34d;
          text-transform: uppercase; letter-spacing: 0;
        }
        .pc-hqdrain__hint { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-hqdrain__list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 0 0 18px; }
        .pc-hqdrain__item {
          display: grid; grid-template-columns: auto 1fr auto; align-items: baseline;
          column-gap: 8px; width: 100%; padding: 3px 6px; border: 0; border-radius: 7px;
          background: none; text-align: left; cursor: pointer; font: inherit;
        }
        .pc-hqdrain__item:hover { background: rgba(252, 211, 77, 0.08); }
        .pc-hqdrain__id { font-size: 11px; font-weight: 700; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .pc-hqdrain__title { font-size: 12.5px; color: var(--fg, #e7f7ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-hqdrain__score { font-size: 11px; font-weight: 760; color: #fcd34d; font-variant-numeric: tabular-nums; }
        .pc-hqdrain__why { grid-column: 2 / -1; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
    </aside>
  );
}
