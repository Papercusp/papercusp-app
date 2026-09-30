'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { Popover } from '@/app/harness/Popover';
/**
 * NewPlanButton — the "New plan" launcher with an EXPLICIT owning-hive choice
 * (steering-nested-hive-plan-tree-2026-06-17, P-005).
 *
 * Plan creation launches a drafting agent scoped to a harness; the plan it
 * authors inherits that harness. The old button silently used the active-pot
 * scope, so with NO active pot it drafted at the operator/workspace (`all`)
 * scope — the exact failure that created 4 orphan plans on 2026-06-17 (plans the
 * Queen's eligibleHives didn't cover, so they were silently un-workable).
 *
 * Fix: when the active scope is CONCRETE, launch in it (unchanged). When it is
 * AMBIGUOUS (no active pot), make the owning hive an EXPLICIT choice — a small
 * menu of the workspace's hives (+ an explicit "Workspace-level") — instead of a
 * silent default. The chosen slug becomes the drafting agent's harness.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { groupByHive, type HiveGroupProject } from '@papercusp/operator-core/lib/harness/hive-groups';

export interface NewPlanProject {
  slug: string;
  harness_kind?: string | null;
  hive_slug?: string | null;
  parent_slug?: string | null;
}

export interface NewPlanButtonProps {
  /** The active harness/pot scope, or null when ambiguous (no active pot). */
  resolvedHarnessSlug: string | null;
  /** The workspace projects (from /api/harness/projects/lite). */
  projects: readonly NewPlanProject[];
  launching: boolean;
  /** Lower-case pot label for the no-active-scope hint. */
  potLabel: string;
  /** Launch the drafting agent in `ownerSlug` (null ⇒ workspace-level, explicit). */
  onLaunch: (ownerSlug: string | null) => void;
}

/** Flatten the hive groups into selectable owning-hive options (root then members). Pure. */
export function ownerHiveOptions(
  projects: readonly NewPlanProject[],
): Array<{ value: string; label: string; member: boolean }> {
  const out: Array<{ value: string; label: string; member: boolean }> = [];
  for (const group of groupByHive(projects as HiveGroupProject[])) {
    out.push({ value: group.root.slug, label: group.root.slug, member: false });
    for (const member of group.members) {
      if (member.slug === group.root.slug) continue;
      out.push({ value: member.slug, label: member.slug, member: true });
    }
  }
  return out;
}

export default function NewPlanButton({ resolvedHarnessSlug, projects, launching, potLabel, onLaunch }: NewPlanButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hiveOptions = useMemo(() => ownerHiveOptions(projects), [projects]);

  // Concrete scope (or no hives to choose from) → the plain button, unchanged.
  const concrete = !!resolvedHarnessSlug || hiveOptions.length === 0;
  if (concrete) {
    return (
      <Tooltip label={resolvedHarnessSlug
            ? `Launch an agent session to draft a new plan in ${resolvedHarnessSlug}`
            : `Launch an agent session to draft a new plan (no active ${potLabel} — agent will ask)`}><button
        type="button"
        className="pc-plans__new-plan"
        onClick={() => onLaunch(resolvedHarnessSlug ?? null)}
        disabled={launching}

      >
        <Plus size={14} aria-hidden />
        {launching ? 'Launching…' : 'New plan'}
      </button></Tooltip>
    );
  }

  // Ambiguous scope → require an EXPLICIT owning-hive choice.
  const pick = (slug: string | null) => {
    setMenuOpen(false);
    onLaunch(slug);
  };
  return (
    <Popover
      open={menuOpen}
      onOpenChange={setMenuOpen}
      side="bottom"
      align="start"
      sideOffset={4}
      ariaLabel={`New plan in ${potLabel}`}
      contentStyle={{
        minWidth: 220,
        display: 'flex',
        flexDirection: 'column',
        padding: 4,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-popover)',
        boxShadow: '0 8px 24px color-mix(in oklab, black, transparent 60%)',
        maxHeight: 320,
        overflowY: 'auto',
      }}
      trigger={
      <button
        type="button"
        className="pc-plans__new-plan"
        disabled={launching}
        aria-haspopup="menu"
        aria-expanded={menuOpen}

      >
        <Plus size={14} aria-hidden />
        {launching ? 'Launching…' : 'New plan'}
        <ChevronDown size={12} aria-hidden style={{ marginLeft: 'auto' }} />
      </button>
      }
    >
        <div role="menu" aria-label={`New plan in ${potLabel}`} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--fg-mute)', padding: '4px 8px' }}>
            New plan in…
          </div>
          {hiveOptions.map((h) => (
            <button
              key={h.value}
              type="button"
              role="menuitem"
              className="pc-plans__newplan-item"
              onClick={() => pick(h.value)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: h.member ? '5px 8px 5px 20px' : '5px 8px',
                fontSize: 12,
                color: 'var(--fg)',
                background: 'none',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {h.member ? `↳ ${h.label}` : h.label}
            </button>
          ))}
          <Tooltip label={`Draft at the workspace level (no owning ${potLabel}) — explicit, not the silent default`}><button
            type="button"
            role="menuitem"
            className="pc-plans__newplan-item"
            onClick={() => pick(null)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '5px 8px',
              marginTop: 4,
              fontSize: 11.5,
              color: 'var(--fg-mute)',
              background: 'none',
              border: 'none',
              borderTop: '1px solid var(--border)',
              borderRadius: 0,
              cursor: 'pointer',
            }}

          >
            Workspace-level (no {potLabel})
          </button></Tooltip>
        </div>
    </Popover>
  );
}
