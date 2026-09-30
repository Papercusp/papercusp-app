/**
 * AddPanelCatalog — picker popover for "+ Add panel".
 *
 * Lists every registered panel type and opens the chosen one. Renders
 * as a popover anchored to the trigger button. Click outside or Esc
 * closes. Each type carries an icon for quick scanning; a type that is
 * already open in the dock is marked and re-focuses (rather than
 * duplicating) on click.
 *
 * The catalog excludes the MissingPanel sentinel + the SamplePanel
 * stubs by default; pass `includeStubs` to show them too.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.2 (+
 * Round-5 audit gap: no top-level + button).
 */

'use client';

import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  BookOpen,
  CircleAlert,
  FileText,
  GitBranch,
  GitCommitVertical,
  GitPullRequest,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Palette,
  PanelRight,
  Plus,
  Puzzle,
  Gauge,
  ScrollText,
  SlidersHorizontal,
  SquareDashed,
  TrendingUp,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { panelRegistry } from './panel-registry';
import { openPanel, focusPanel, listPanels } from './dock-actions';
import { Popover } from '../Popover';
import { useLexicon } from '@/lib/useLexicon';

interface AddPanelCatalogProps {
  /** Default slug to pass as params.harnessSlug for opened panels. */
  defaultSlug?: string;
  /** Optional className for the trigger button. */
  className?: string;
  /** Show stub panel types (view:design/proposals/etc) in the catalog. */
  includeStubs?: boolean;
  /**
   * When provided, only these panel types are shown. Useful for context-
   * scoped catalogs (e.g. adv harnesses dock only shows adv:* panels).
   */
  allowedTypes?: string[];
}

const HUMAN_LABELS: Record<string, string> = {
  'data:features': 'Features',
  'data:issues': 'Issues',
  'data:agents': 'Agents',
  'data:logs': 'Logs',
  'data:git': 'Git graph',
  'data:chat': 'Chat',
  'view:harness-overview': 'Harness overview',
  'view:dashboard-overview': 'Dashboard summary',
  'view:docs': 'Docs',
  'view:design': 'Design',
  'view:proposals': 'Proposals',
  'view:summary': 'Summary',
  'view:insights': 'Insights',
  'view:config': 'Config',
  'adv:work-items': 'Work items',
  'adv:detail': 'Detail',
  'adv:git': 'Git',
  'adv:agents': 'Agents',
  'adv:logs': 'Run log',
  'adv:contributors': 'Contributors',
  'adv:insights': 'Insights',
  'adv:sync-health': 'Sync health',
  'adv:chat': 'Chat',
};

// Per-type icon for at-a-glance scanning. Every lookup falls back to a
// neutral glyph (`?? SquareDashed`) so a new/unmapped type can't render
// `<undefined/>` and crash the catalog.
const ICON_MAP: Record<string, LucideIcon> = {
  'data:features': ListChecks,
  'adv:work-items': ListChecks,
  'data:issues': CircleAlert,
  'adv:detail': PanelRight,
  'data:git': GitBranch,
  'adv:git': GitBranch,
  'adv:git-graph': GitCommitVertical,
  'adv:prs': GitPullRequest,
  'data:agents': Bot,
  'adv:agents': Bot,
  'data:logs': ScrollText,
  'adv:logs': ScrollText,
  'adv:contributors': Users,
  'adv:insights': TrendingUp,
  'adv:sync-health': Gauge,
  'view:harness-overview': LayoutDashboard,
  'view:dashboard-overview': LayoutDashboard,
  'data:chat': MessageSquare,
  'adv:chat': MessageSquare,
  'view:docs': BookOpen,
  'view:design': Palette,
  'view:proposals': Lightbulb,
  'view:summary': FileText,
  'view:insights': TrendingUp,
  'view:config': SlidersHorizontal,
};

// Multi-instance slot types (chat): several can coexist, so a BUSY slot
// (one already bound to a chatId) must not block opening another. Only a
// FREE slot (no chatId yet) counts as "already open" and gets re-focused.
const MULTI_INSTANCE_FREE_PARAM = new Map<string, string>([['adv:chat', 'chatId']]);

const STUB_TYPES = new Set([
  'view:dashboard-overview',
  'view:design',
  'view:proposals',
  'view:summary',
  'view:insights',
  'view:config',
  'data:chat',
  // spawned programmatically via pin action — not user-openable
  'adv:pinned',
]);

function labelFor(type: string, lex?: ReturnType<typeof useLexicon>): string {
  // Lexicon-routed panels: the registry title is a static 'Hive…' string, so
  // resolve the classic-pack term at the render site when THE_HIVE is off
  // (restore-pot-lexicon-public-release P-007). The panels themselves also set a
  // live title via api.setTitle once open; this covers the catalog menu label.
  if (lex) {
    if (type === 'adv:work-items') return lex('workUnit', { plural: true });
    if (type === 'adv:hive-content') return `${lex('pot')} content`;
    if (type === 'workbench:hive-directory') return lex('pot', { plural: true });
  }
  if (HUMAN_LABELS[type]) return HUMAN_LABELS[type];
  const registryTitle = panelRegistry.get(type)?.meta.title;
  if (registryTitle) return registryTitle;
  if (type.startsWith('plugin:')) {
    const parts = type.split(':');
    // plugin:<name>:<id>
    return `${parts[1]?.replace(/^@/, '')} · ${parts[2] ?? ''}`;
  }
  return type;
}

function iconFor(type: string): LucideIcon {
  if (ICON_MAP[type]) return ICON_MAP[type];
  if (type.startsWith('plugin:')) return Puzzle;
  return SquareDashed;
}

export function AddPanelCatalog({
  defaultSlug,
  className,
  includeStubs = false,
  allowedTypes,
}: AddPanelCatalogProps) {
  const lex = useLexicon();
  const [open, setOpen] = useState(false);
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => panelRegistry.subscribe(() => setRegistryTick((t) => t + 1)), []);

  const types = useMemo(() => {
    void registryTick;
    return panelRegistry
      .list()
      .filter((t) => t !== '__missing__')
      .filter((t) => includeStubs || !STUB_TYPES.has(t))
      .filter((t) => !allowedTypes || allowedTypes.includes(t));
  }, [registryTick, includeStubs, allowedTypes]);

  // Which panel types are already mounted in the dock — clicking one of
  // these focuses the existing panel instead of opening a duplicate.
  const openByType = useMemo(() => {
    if (!open) return new Map<string, string>();
    void registryTick;
    const m = new Map<string, string>();
    try {
      for (const p of listPanels()) {
        const freeParam = MULTI_INSTANCE_FREE_PARAM.get(p.type);
        if (freeParam && p.params[freeParam]) continue; // busy slot — never blocks a new instance
        if (!m.has(p.type)) m.set(p.type, p.id);
      }
    } catch {
      /* dock not hydrated yet */
    }
    return m;
  }, [open, registryTick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleAdd = (type: string) => {
    setOpen(false);
    try {
      const existingId = openByType.get(type);
      if (existingId) {
        focusPanel(existingId);
        return;
      }
      const id = openPanel({
        type,
        params: defaultSlug ? { harnessSlug: defaultSlug } : {},
        title: labelFor(type, lex),
      });
      focusPanel(id);
    } catch (err) {
      console.error('[AddPanelCatalog] openPanel failed', err);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      ariaLabel="Panel catalog"
      contentStyle={{
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%))',
        borderRadius: 12,
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.5)',
        overflow: 'hidden',
      }}
      trigger={
        <button
          type="button"
          aria-label="Add panel"
          className={className}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 11 }}
        >
          <Plus size={12} aria-hidden />
          Add panel
        </button>
      }
    >
      <div className="pc-add-panel">
        <div className="pc-add-panel__head">
          <span className="pc-add-panel__title">Open panel</span>
          <button type="button" className="pc-add-panel__close" onClick={() => setOpen(false)} aria-label="Close">
            <X size={13} aria-hidden />
          </button>
        </div>
        <div className="pc-add-panel__list">
          {types.length === 0 ? (
            <div className="pc-add-panel__empty">No panel types registered.</div>
          ) : (
            types.map((t) => {
              const Icon = iconFor(t);
              const isOpen = openByType.has(t);
              return (
                <Tooltip key={t} label={isOpen ? 'Already open — focus it' : `Open ${labelFor(t, lex)}`}><button

                  type="button"
                  className="pc-add-panel__item"
                  onClick={() => handleAdd(t)}

                >
                  <span className="pc-add-panel__icon">
                    <Icon size={15} aria-hidden strokeWidth={1.75} />
                  </span>
                  <span className="pc-add-panel__text">
                    <span className="pc-add-panel__label">{labelFor(t, lex)}</span>
                    <span className="pc-add-panel__type">{t}</span>
                  </span>
                  {isOpen ? (
                    <span className="pc-add-panel__open" aria-label="already open">
                      open
                    </span>
                  ) : (
                    <Plus className="pc-add-panel__plus" size={13} aria-hidden />
                  )}
                </button></Tooltip>
              );
            })
          )}
        </div>
        <style>{`
          .pc-add-panel {
            width: 252px;
            max-height: 380px;
            display: flex;
            flex-direction: column;
            color: var(--fg, #e7f7ff);
            font-size: 12px;
          }
          .pc-add-panel__head {
            display: flex;
            align-items: center;
            padding: 9px 12px;
            border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
            background: var(--bg-2, rgba(255, 255, 255, 0.045));
          }
          .pc-add-panel__title {
            font-size: 10px;
            font-weight: 760;
            letter-spacing: 0;
            text-transform: uppercase;
            color: var(--fg-mute, #7f9bb4);
          }
          .pc-add-panel__close {
            margin-left: auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 3px;
            color: var(--fg-mute, #7f9bb4);
            background: transparent;
            border: 0;
            border-radius: 5px;
            cursor: pointer;
          }
          .pc-add-panel__close:hover { color: var(--fg, #e7f7ff); background: var(--bg-3, rgba(255, 255, 255, 0.075)); }
          .pc-add-panel__list { overflow-y: auto; padding: 5px; min-height: 0; }
          .pc-add-panel__empty { padding: 12px; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
          .pc-add-panel__item {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 7px 8px;
            text-align: left;
            color: var(--fg, #e7f7ff);
            background: transparent;
            border: 1px solid transparent;
            border-radius: 8px;
            cursor: pointer;
          }
          .pc-add-panel__item:hover {
            background: color-mix(in oklab, var(--accent, #38bdf8), transparent 88%);
            border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 64%);
          }
          .pc-add-panel__item:focus-visible {
            outline: none;
            border-color: var(--accent, #38bdf8);
          }
          .pc-add-panel__icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            flex-shrink: 0;
            color: var(--accent-strong, #7dd3fc);
            background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
            border-radius: 7px;
          }
          .pc-add-panel__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
          .pc-add-panel__label { font-size: 12px; font-weight: 600; line-height: 1.25; }
          .pc-add-panel__type {
            font-size: 9.5px;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            color: var(--fg-mute, #7f9bb4);
            line-height: 1.2;
          }
          .pc-add-panel__open {
            margin-left: auto;
            flex-shrink: 0;
            font-size: 9px;
            font-weight: 700;
            letter-spacing: 0;
            text-transform: uppercase;
            color: var(--good, #4ade80);
            background: color-mix(in oklab, var(--good, #4ade80), transparent 84%);
            border: 1px solid color-mix(in oklab, var(--good, #4ade80), transparent 64%);
            border-radius: 999px;
            padding: 1px 7px;
          }
          .pc-add-panel__plus {
            margin-left: auto;
            flex-shrink: 0;
            color: var(--fg-mute, #7f9bb4);
            opacity: 0;
            transition: opacity 0.1s var(--ease-out, ease);
          }
          .pc-add-panel__item:hover .pc-add-panel__plus { opacity: 1; color: var(--accent-strong, #7dd3fc); }
        `}</style>
      </div>
    </Popover>
  );
}
