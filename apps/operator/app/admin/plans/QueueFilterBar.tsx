'use client';

/**
 * QueueFilterBar — the Queue's single, collapsed Filter (queue redesign).
 *
 * One "Filter" trigger (with an active-count badge) replaces the old always-on
 * tier bar + 11 item-status chips. Expanded, it offers per-kind narrowing of the
 * "Other" attention items plus two opt-in backlog toggles (pickable todos /
 * blocked) — default off, so the Queue defaults to "what needs attention", not
 * the whole work backlog. When a cross-app deep-link set a tier (?inboxTier from
 * the overview tiles) a clear-chip surfaces it.
 *
 * Shared by the live /adv Create-dock `QueuePanel` and the legacy admin
 * `PlansClient` so the two Queue surfaces can't diverge.
 */

import * as Collapsible from '@radix-ui/react-collapsible';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';
import { TIER_LABEL, type AttentionKind, type AttentionTier } from './plans-api';
import { resolveLex } from '../../adv/create/use-create-data';

/** The kind facet inside the Filter — the non-plan-item attention kinds.
 *  Plan-items always show in the buckets, so they're not here. */
const QUEUE_KIND_CHIPS: { id: AttentionKind; label: string }[] = [
  { id: 'coord-escalation', label: 'Escalations' },
  { id: 'coord-message', label: 'Messages' },
  { id: 'smoke-fail', label: 'Smoke' },
  { id: 'operator-report', label: 'Reports' },
  { id: 'improvement', label: 'Improvements' },
  { id: 'standing-approval', label: 'Approvals' },
  { id: 'conversation', label: 'Questions' },
  // {scout} → active cast word at render ("Blender" in classic/Pot) via resolveLex.
  { id: 'scout-grade', label: '{scout}' },
];

export interface QueueFilterBarProps {
  kinds: AttentionKind[];
  onToggleKind: (k: AttentionKind) => void;
  /** Per-kind counts, keyed by AttentionKind id. */
  counts: Record<string, number>;
  showTodos: boolean;
  showBlocked: boolean;
  onToggleTodos: () => void;
  onToggleBlocked: () => void;
  todoCount: number;
  blockedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional cross-app tier deep-link (?inboxTier); a clear-chip is shown when set. */
  tierFilter?: AttentionTier | 'all';
  onClearTier?: () => void;
}

export default function QueueFilterBar({
  kinds,
  onToggleKind,
  counts,
  showTodos,
  showBlocked,
  onToggleTodos,
  onToggleBlocked,
  todoCount,
  blockedCount,
  open,
  onOpenChange,
  tierFilter,
  onClearTier,
}: QueueFilterBarProps) {
  const t = useLexicon();
  const tier = tierFilter ?? 'all';
  const activeCount =
    kinds.length + (showTodos ? 1 : 0) + (showBlocked ? 1 : 0) + (tier !== 'all' ? 1 : 0);
  return (
    <Collapsible.Root className="pc-queue__filterbar" open={open} onOpenChange={onOpenChange}>
      <div className="pc-queue__filterhead">
        <Collapsible.Trigger asChild>
          <button type="button" className="pc-queue__filtertoggle" aria-expanded={open}>
            <SlidersHorizontal size={13} aria-hidden />
            <span>Filter</span>
            {activeCount > 0 ? <span className="pc-queue__filteractive">{activeCount}</span> : null}
            <ChevronDown size={13} aria-hidden className="pc-queue__filterchev" />
          </button>
        </Collapsible.Trigger>
        {tier !== 'all' && onClearTier ? (
          <Tooltip label="A linked-in view filtered the Queue to this tier. Click to clear." side="bottom">
            <button type="button" className="pc-queue__tierchip" onClick={onClearTier}>
              {TIER_LABEL[tier]} ✕
            </button>
          </Tooltip>
        ) : null}
      </div>
      <Collapsible.Content className="pc-queue__filterpanel">
        <div className="pc-queue__filtergroup">
          <span className="pc-queue__filterlabel">Kinds</span>
          {QUEUE_KIND_CHIPS.map((c) => {
            const active = kinds.includes(c.id);
            const count = counts[c.id] ?? 0;
            return (
              <button
                key={c.id}
                type="button"
                className={`pc-queue__filter${active ? ' is-active' : ''}`}
                aria-pressed={active}
                aria-label={`${resolveLex(c.label, t)}, ${count}`}
                onClick={() => onToggleKind(c.id)}
              >
                <span className="pc-queue__filter-label">{resolveLex(c.label, t)}</span>
                <span className="pc-queue__filter-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="pc-queue__filtergroup">
          <span className="pc-queue__filterlabel">Backlog</span>
          <Tooltip
            label="Show the agent-pickable todo backlog. The default Queue stays focused on pending attention."
            side="bottom"
          >
            <button
              type="button"
              className={`pc-queue__filter${showTodos ? ' is-active' : ''}`}
              aria-pressed={showTodos}
              aria-label={`Pickable todos, ${todoCount}`}
              onClick={onToggleTodos}
            >
              <span className="pc-queue__filter-label">Pickable todos</span>
              <span className="pc-queue__filter-count">{todoCount}</span>
            </button>
          </Tooltip>
          <Tooltip label="Show blocked plan items." side="bottom">
            <button
              type="button"
              className={`pc-queue__filter${showBlocked ? ' is-active' : ''}`}
              aria-pressed={showBlocked}
              aria-label={`Blocked, ${blockedCount}`}
              onClick={onToggleBlocked}
            >
              <span className="pc-queue__filter-label">Blocked</span>
              <span className="pc-queue__filter-count">{blockedCount}</span>
            </button>
          </Tooltip>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
