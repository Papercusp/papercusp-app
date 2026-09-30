/**
 * PotSteeringTree — the nested hive→plan steering picker
 * (steering-nested-hive-plan-tree-2026-06-17, P-002).
 *
 * The owner's two steering axes — Eligible HIVES (the placement scope) and
 * Eligible PLANS (the plan allow-list) — are actually a TREE: a plan belongs to
 * a hive. The old two FLAT lists let you express a contradiction (an eligible
 * plan under an excluded hive — a dead no-op the survey silently drops). This
 * renders them AS the hierarchy: hives at top, their plans nested beneath, a
 * plan checkable ONLY under a checked hive — so the illegal state can't be typed.
 *
 * Purely presentational: it renders a {@link SteeringTree} (built by
 * buildSteeringTree from the unchanged persisted pair) and reports clicks back as
 * the pure toggle intents. MugTab owns the (eligibleHives, eligiblePlans) state
 * + the serialized optimistic write. Reuses the parent's `.pc-queen__*` tokens.
 */
import { useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { AlertTriangle, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { Checkbox } from '@/app/harness/Checkbox';
import { useLexicon } from '@/lib/useLexicon';
import type { SteeringTree, TreeHive, TreePlan } from './pot-steering-tree';

export interface HiveSteeringTreeProps {
  tree: SteeringTree;
  /** Count of dead eligible-plan entries detected (their hive is excluded) — surfaced. */
  illegalCount: number;
  busy: boolean;
  loading: boolean;
  onToggleHive: (potSlug: string) => void;
  onTogglePlan: (potSlug: string, planSlug: string) => void;
  onSetHivePlans: (potSlug: string, on: boolean) => void;
  onSetAllHives: (on: boolean) => void;
}

/** A checkbox that renders the tri-state `some` as the native indeterminate dash. */
function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <Checkbox
      className="pc-queen__check"
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      onChange={onChange}
      ariaLabel={ariaLabel}
    />
  );
}

function PlanRow({ plan, potSlug, busy, onTogglePlan }: { plan: TreePlan; potSlug: string; busy: boolean; onTogglePlan: HiveSteeringTreeProps['onTogglePlan'] }) {
  return (
    <li className={`pc-queen__plan pc-queen__tree-plan${plan.checked ? ' pc-queen__plan--on' : ''}`}>
      <label className="pc-queen__planlabel pc-queen__selection-label">
        <Checkbox
          className="pc-queen__check"
          checked={plan.checked}
          disabled={busy}
          onChange={() => onTogglePlan(potSlug, plan.slug)}
          ariaLabel={plan.title}
        />
        <span className="pc-queen__planslug" title={plan.slug}>{plan.title}</span>
      </label>
      <span
        className="pc-queen__planstatus"
        data-status={plan.inActive ? (plan.startStatus === 'started' ? 'started' : plan.status ?? '') : 'stale'}
      >
        {plan.inActive ? (plan.startStatus === 'started' ? 'live' : plan.status ?? '') : 'not active'}
      </span>
    </li>
  );
}

function HiveNode({
  hive,
  expanded,
  busy,
  onOpenChange,
  onToggleHive,
  onTogglePlan,
  onSetHivePlans,
}: {
  hive: TreeHive;
  expanded: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleHive: HiveSteeringTreeProps['onToggleHive'];
  onTogglePlan: HiveSteeringTreeProps['onTogglePlan'];
  onSetHivePlans: HiveSteeringTreeProps['onSetHivePlans'];
}) {
  const t = useLexicon();
  const hasPlans = hive.plans.length > 0;
  const eligibleCount = hive.plans.filter((p) => p.checked).length;
  const groupActionLabel = hive.planMode === 'some'
    ? `Select every plan in ${hive.slug}`
    : hive.checked
      ? `Remove ${hive.slug} from work focus`
      : `Include ${hive.slug} in work focus`;
  return (
    <li className={`pc-queen__tree-hive${hive.checked ? ' pc-queen__tree-hive--on' : ''}`}>
      <Collapsible.Root open={hasPlans ? expanded : false} onOpenChange={(open) => hasPlans && onOpenChange(open)}>
        <div className="pc-queen__tree-hiverow">
          <Collapsible.Trigger asChild>
            <button
              type="button"
              className="pc-queen__tree-caret"
              aria-label={expanded ? `Collapse ${t('pot', { lower: true })}` : `Expand ${t('pot', { lower: true })}`}
              disabled={!hasPlans}
            >
              {hasPlans ? (expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />) : <span className="pc-queen__tree-caret-spacer" />}
            </button>
          </Collapsible.Trigger>
          <label className="pc-queen__planlabel pc-queen__tree-hivelabel pc-queen__selection-label">
            <TriCheckbox
              checked={hive.checked}
              indeterminate={hive.planMode === 'some'}
              disabled={busy}
              onChange={() => hive.planMode === 'some' ? onSetHivePlans(hive.slug, true) : onToggleHive(hive.slug)}
              ariaLabel={groupActionLabel}
            />
            <span className="pc-queen__tree-hivename" title={hive.slug}>{hive.label.trim()}</span>
          </label>
          <span className="pc-queen__tree-hivemeta">
            {hive.checked
              ? hive.planMode === 'all'
                ? hasPlans ? 'all plans' : 'in scope'
                : `${eligibleCount}/${hive.plans.length}`
              : `${hive.plans.length} plan${hive.plans.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {hasPlans && (
          <Collapsible.Content className="pc-queen__tree-branch">
            <ul className={`pc-queen__plans pc-queen__tree-plans${hive.checked ? '' : ' pc-queen__tree-plans--off'}`}>
              {hive.plans.map((p) => (
                <PlanRow key={p.slug} plan={p} potSlug={hive.slug} busy={busy || !hive.checked} onTogglePlan={onTogglePlan} />
              ))}
            </ul>
          </Collapsible.Content>
        )}
      </Collapsible.Root>
    </li>
  );
}

export default function PotSteeringTree({
  tree,
  illegalCount,
  busy,
  loading,
  onToggleHive,
  onTogglePlan,
  onSetHivePlans,
  onSetAllHives,
}: HiveSteeringTreeProps) {
  const t = useLexicon();
  // Per-hive expand/collapse — render-only ephemeral UI (not user-meaningful
  // navigation), so useState. Default: checked hives open, the rest collapsed.
  const defaultExpanded = useMemo(
    () => new Set(tree.hives.filter((h) => h.checked).map((h) => h.slug)),
    [tree.hives],
  );
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (slug: string) => manualExpanded[slug] ?? defaultExpanded.has(slug);
  const setExpanded = (slug: string, open: boolean) =>
    setManualExpanded((m) => ({ ...m, [slug]: open }));

  const anyHiveChecked = tree.hives.some((h) => h.checked);
  const restricted = anyHiveChecked;
  const checkedCount = tree.hives.filter((h) => h.checked).length;
  const hiveNoun = (n: number) => (n === 1 ? t('pot', { lower: true }) : t('pot', { plural: true, lower: true }));

  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <ListChecks size={12} aria-hidden />
        <span className="pc-queen__section-title">{t('pot', { plural: true })} &amp; plans</span>
        <span className={`pc-queen__count${restricted ? ' pc-queen__count--on' : ''}`}>
          {restricted ? `${checkedCount} ${hiveNoun(checkedCount)} focused` : 'all work'}
        </span>
        <span className="pc-queen__spacer" />
        {restricted && (
          <button type="button" className="pc-queen__chip" onClick={() => onSetAllHives(false)} disabled={busy} aria-label="Clear work focus">All work</button>
        )}
      </div>

      {illegalCount > 0 && (
        <div className="pc-queen__tree-illegal" role="alert">
          <AlertTriangle size={12} aria-hidden />
          {illegalCount} eligible plan{illegalCount === 1 ? '' : 's'} {illegalCount === 1 ? 'is' : 'are'} in an excluded {t('pot', { lower: true })} — ignored by the {t('brain')}. Cleared on your next change.
        </div>
      )}

      {loading ? (
        <div className="pc-queen__placeholder">Loading {t('pot', { plural: true, lower: true })} + plans…</div>
      ) : tree.hives.length === 0 ? (
        <div className="pc-queen__placeholder">No {t('pot', { plural: true, lower: true })} with plans.</div>
      ) : (
        <ul className="pc-queen__plans pc-queen__tree">
          {tree.hives.map((hive) => (
            <HiveNode
              key={hive.slug}
              hive={hive}
              expanded={isExpanded(hive.slug)}
              busy={busy}
              onOpenChange={(open) => setExpanded(hive.slug, open)}
              onToggleHive={onToggleHive}
              onTogglePlan={onTogglePlan}
              onSetHivePlans={onSetHivePlans}
            />
          ))}
        </ul>
      )}

      {tree.unassigned.length > 0 && (
        <div className="pc-queen__tree-unassigned">
          <div className="pc-queen__tree-unassigned-head">
            <AlertTriangle size={11} aria-hidden />
            <span>No {t('pot', { lower: true })} — not steerable</span>
            <span className="pc-queen__count">{tree.unassigned.length}</span>
          </div>
          <ul className="pc-queen__plans pc-queen__tree-plans pc-queen__tree-plans--off">
            {tree.unassigned.map((p) => (
              <li key={p.slug} className="pc-queen__plan pc-queen__tree-plan">
                <span className="pc-queen__planslug" title={p.slug}>{p.title}</span>
                <span className="pc-queen__planstatus" data-status="stale">no {t('pot', { lower: true })}</span>
              </li>
            ))}
          </ul>
          <span className="pc-queen__hint">These plans aren&apos;t under any {t('pot', { lower: true })} (e.g. created at the workspace scope). Move them into a {t('pot', { lower: true })} to steer them.</span>
        </div>
      )}

      <TreeStyles />
    </section>
  );
}

function TreeStyles() {
  return (
    <style>{`
      .pc-queen__tree {
        max-height: 340px; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable;
        padding-right: 2px;
      }
      .pc-queen__tree-hive { display: block; padding: 0; border: none; background: none; }
      .pc-queen__tree-hive + .pc-queen__tree-hive { margin-top: 3px; }
      .pc-queen__tree-hiverow {
        display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-queen__tree-hive--on .pc-queen__tree-hiverow {
        border-color: color-mix(in srgb, var(--accent), transparent 56%);
        background: color-mix(in srgb, var(--accent), transparent 93%);
      }
      .pc-queen__tree-caret {
        display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; min-height: 16px;
        padding: 0; border: none; background: none; cursor: pointer; color: var(--fg-mute, #7f9bb4); flex-shrink: 0;
      }
      .pc-queen__tree-caret:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-queen__tree-caret:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
      .pc-queen__tree-caret:disabled { cursor: default; opacity: 0.4; }
      .pc-queen__tree-caret-spacer { display: inline-block; width: 13px; }
      .pc-queen__tree-hivelabel { flex: 1; min-width: 0; }
      .pc-queen__tree-hivename {
        font-size: 11.5px; font-weight: 650; color: var(--fg, #e7f7ff);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-queen__tree-hivemeta { flex-shrink: 0; font-size: 9px; color: var(--fg-mute, #7f9bb4); }
      .pc-queen__tree-branch {
        margin: 3px 0 2px 8px; padding: 2px 0 2px 12px;
        border-left: 1px solid color-mix(in srgb, var(--border-strong), transparent 52%);
      }
      .pc-queen__tree-plans {
        margin: 0; padding-left: 0; max-height: none; overflow: visible; gap: 3px;
      }
      .pc-queen__tree-plans--off { opacity: 0.55; }
      .pc-queen__tree-plan { padding: 4px 7px; }
      .pc-queen__tree-illegal {
        display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 1.3; color: var(--fg, #e7f7ff);
        padding: 5px 8px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 62%);
        background: color-mix(in srgb, var(--queen-accent, var(--warn, #fbbf24)), transparent 90%);
      }
      .pc-queen__tree-unassigned {
        display: flex; flex-direction: column; gap: 5px; padding: 7px 8px; border-radius: 8px;
        border: 1px dashed color-mix(in srgb, var(--bad, #f43f5e), transparent 62%);
        background: color-mix(in srgb, var(--bad, #f43f5e), transparent 94%);
      }
      .pc-queen__tree-unassigned-head { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 0; color: #fca5a5; }
      .pc-queen__tree-unassigned-head svg { color: #fca5a5; }
      .pc-queen__tree-unassigned .pc-queen__plan { border-color: color-mix(in srgb, var(--bad, #f43f5e), transparent 78%); }
    `}</style>
  );
}
