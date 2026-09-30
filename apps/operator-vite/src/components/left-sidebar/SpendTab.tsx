/**
 * SpendTab — the ONE place that answers "what did the agents cost".
 *
 * WHY IT EXISTS (owner correction 2026-07-25): Blender, Docs and Agents each grew
 * their own "Spend" lane, and the owner rightly challenged it — "Why is the spend
 * tab inside blender? is that showing only blender related spend? It looks like
 * not." It was not. Spend is recorded per agent ROLE, and there is no foreign key
 * from a usage row back to the routine that spawned the agent, so each pane had to
 * hand-pick roles: Blender claimed ['scout','gym','worker','mug','kettle'] while
 * Agents claimed ['worker','mug','kettle','release-fixer','cup']. The overlapping
 * worker/mug/kettle dollars were therefore counted in BOTH panes and presented to
 * the owner as each pane's own cost — three different, all-wrong answers to one
 * question.
 *
 * So cost is now a peer tab, sitting right of Agents: every role, unfiltered, one
 * total, with the attribution limit stated instead of papered over. If a per-routine
 * number is ever wanted, it needs a real routine→usage link in the data (see
 * lib/automation/catalog.ts) — not another role filter.
 *
 * Data: the SAME `automation.catalog` query the automation panes already read, so
 * this adds a surface, not a resolver.
 */
import { useMemo } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useSyncQuery } from '@papercusp/sync';
import { AlertTriangle, Coins } from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import type { AutomationCatalog, AutomationRoleSpend } from '@papercusp/operator-core/lib/automation/catalog';

export function usd(n: number): string {
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/** Compact turn counts — a 5-digit number would blow the narrow rail's column. */
export function turnsLabel(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Costliest first — the rail is short, so the money must be at the top. Pure. */
export function rankSpend(rows: readonly AutomationRoleSpend[]): AutomationRoleSpend[] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd || a.role.localeCompare(b.role));
}

export default function SpendTab({ active }: { active: boolean }) {
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });

  const data = cat.data?.[0] ?? null;
  const rows = useMemo(() => rankSpend(data?.spend7d ?? []), [data]);

  if (!active) return null;

  // Prefer the resolver's own total over re-summing the rows: the rows are a
  // per-(role, modelClass) breakdown and the server already computes the
  // authoritative figure, so the two can never disagree on screen.
  const total = data?.spend7dTotalUsd ?? rows.reduce((a, b) => a + b.costUsd, 0);

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-auto" data-testid="left-sidebar-spend">
        <header className="pc-auto__bar">
          <Coins size={14} aria-hidden />
          <span className="pc-auto__identity">
            <span className="pc-auto__title">Spend</span>
            <span className="pc-auto__subtitle">What the agents cost</span>
          </span>
          <Tooltip label="Every agent in this workspace, across all pots — not one pot and not one pane">
            <span className="pc-auto__scope">workspace</span>
          </Tooltip>
          <span className="pc-auto__spacer" />
        </header>

        <div className="pc-auto__panel">
          {cat.error && <div className="pc-auto__err" role="alert">{String(cat.error)}</div>}
          {cat.loading && !data && <div className="pc-auto__placeholder">Loading…</div>}

          {data && (
            <section className="pc-auto__section">
              <div className="pc-auto__section-head">
                <Coins size={12} aria-hidden />
                <span className="pc-auto__section-title">Last 7 days</span>
                <span className="pc-auto__count" data-testid="spend-total">{usd(total)}</span>
              </div>

              {rows.length === 0 ? (
                <div className="pc-auto__placeholder">
                  No recorded agent usage in the last 7 days.
                </div>
              ) : (
                rows.map((s) => (
                  <div className="pc-auto__spend-row" key={`${s.role}:${s.modelClass ?? ''}`} data-testid={`spend-role-${s.role}`}>
                    <span className="pc-auto__spend-role">
                      {s.role}
                      {s.modelClass && <em> · {s.modelClass}</em>}
                    </span>
                    <span className="pc-auto__spend-turns">{turnsLabel(s.turns)} turns</span>
                    <span className="pc-auto__spend-usd">{usd(s.costUsd)}</span>
                  </div>
                ))
              )}

              {/* The honesty note is not decoration: without it a reader assumes the
                  breakdown attributes cost to schedules, which the data cannot do. */}
              <p className="pc-auto__foot">
                <AlertTriangle size={10} aria-hidden /> Grouped by agent ROLE, not by
                routine or by tab — a usage row carries no link back to the schedule that
                spawned it, so a per-routine cost would be a guess. Pause specific
                schedules in the Blender, Docs and Agents tabs.
              </p>
            </section>
          )}
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
