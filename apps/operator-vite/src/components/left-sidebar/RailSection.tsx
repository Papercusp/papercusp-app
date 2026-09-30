/**
 * RailSection — the left rail's shared COLLAPSIBLE section (owner ask 2026-07-25).
 *
 * WHY it exists: the Mug tab already had this exact idiom (a chevron + icon +
 * title + a right-aligned summary chip, body hidden until opened — see
 * ThrottleSection / ModelTiersOverride / AutonomySurfacing), but it was written
 * three times against the Mug's PRIVATE `pc-queen__*` class namespace. Two more
 * surfaces now need it — the Pots tab (whose stacked Local-pots + Federation
 * panels pushed the p2p roster off-screen) and the Blender/Docs automation pane
 * (which the owner asked to look like the Mug tab) — so the idiom is lifted here
 * ONCE under neutral `pclsb-sect__*` classes rather than forked a fourth time or
 * borrowed from the Mug's namespace.
 *
 * Open-state lives in the URL via nuqs, per the repo's state rule: a panel's
 * open/closed state is user-meaningful, so it must be deep-linkable AND readable
 * by the agent control surface (ui:get_state / ui:dispatch). `useState` here
 * would make these sections invisible to agents.
 *
 * `summary` is the whole point of the collapsed state: a section the owner has
 * closed must still tell them whether it needs attention ("2/4 running",
 * "⚠ 1 degraded"), so the collapsed header is never a dead label.
 */
import type { ComponentType, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { parseAsBoolean, useQueryState } from 'nuqs';

export interface RailSectionProps {
  /** nuqs query-param key holding this section's open state (e.g. `potsLocal`). */
  paramKey: string;
  /** lucide icon component rendered beside the title. */
  icon: ComponentType<{ size?: number | string; 'aria-hidden'?: boolean }>;
  title: string;
  /** Collapsed-state signal — the reason it is safe to leave this closed. */
  summary?: ReactNode;
  /** Tints the summary chip when the section is reporting a problem. */
  tone?: 'good' | 'warn' | 'bad' | 'mute';
  /** Sections default to CLOSED — the whole point is reclaiming vertical space. */
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}

export default function RailSection({
  paramKey,
  icon: Icon,
  title,
  summary,
  tone = 'mute',
  defaultOpen = false,
  testId,
  children,
}: RailSectionProps) {
  const [open, setOpen] = useQueryState(paramKey, parseAsBoolean.withDefault(defaultOpen));

  return (
    <section className="pclsb-sect" data-testid={testId} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="pclsb-sect__head"
        onClick={() => void setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <Icon size={12} aria-hidden />
        <span className="pclsb-sect__title">{title}</span>
        {summary != null && (
          <span className={`pclsb-sect__summary pclsb-sect__summary--${tone}`}>{summary}</span>
        )}
      </button>
      {open && <div className="pclsb-sect__body">{children}</div>}
    </section>
  );
}
