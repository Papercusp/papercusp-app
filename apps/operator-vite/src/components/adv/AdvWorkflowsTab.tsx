/**
 * AdvWorkflowsTab — the Workflows tab, as ONE frame.
 *
 * Plan: workflows-tab-one-frame-2026-08-28, governed by D-001..D-005.
 *
 * The tab used to route five sub-views through `?wfView=` (landing | flow | catalog |
 * activity | sources) and carry TWO detail surfaces for the same object. It is now one
 * frame: masthead → composer → needs-you strip → facet bar → ledger beside a persistent
 * inspector. Kind and state are FACETS (D-001), the inspector is THE detail surface with
 * `?wfId=` as its expansion (D-002), and source health lives in the masthead (D-003).
 *
 * ── WHAT THE SHAPE OF THIS FILE IS FOR ──────────────────────────────────────────────────
 * Everything derivable lives in workflows-ledger-model.ts, so this component is the frame,
 * the URL state and the write paths — nothing that needs a DOM to be tested. The two
 * dialogs (agent composer, advanced manual setup) and every mutation route are carried over
 * unchanged: this plan redesigns the surface, not the audited writes beneath it.
 *
 * ── URL STATE IS NOT A STYLE CHOICE ─────────────────────────────────────────────────────
 * The agent control surface (ui:get_state / ui:dispatch) reads the URL, so every
 * user-meaningful selection here is nuqs: mode, facets, source filter, sort, query, the
 * inspected row, and the expanded workflow. A facet in useState would be invisible to the
 * agents this surface exists to collaborate with.
 */

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import * as Tabs from '@radix-ui/react-tabs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import { CalendarClock, DatabaseZap, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { AutomationCatalog } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import type { PlanInputSchemaInfo } from '@/app/admin/plans/plans-api';
import { fetchPlanInputs } from '@/app/admin/plans/plans-api';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { Modal } from '@/app/harness/Modal';
import { Select } from '@/app/harness/Select';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { runScheduleTool } from './ScheduleEditor';
import {
  buildAutomationActivity,
  buildAutomationItems,
  buildAutomationSources,
  relativeTime,
  type AutomationItem,
  type AutomationOccurrenceRow,
  type AutomationPlanRow,
  type AutomationScheduleRow,
} from './workflows-model';
import {
  buildFacetCounts,
  buildLedgerRows,
  buildNeedsYou,
  buildPopulationSummary,
  buildSourceHealth,
  buildSuggestionChips,
  collapseNeedsYou,
  filterLedgerRows,
  sortLedgerRows,
  type KindFacet,
  type LedgerSort,
  type NeedsYouItem,
  type StateFacet,
} from './workflows-ledger-model';
import WorkflowsLedger, { ActivityList } from './WorkflowsLedger';
import WorkflowInspector, { type RunHistoryRow } from './WorkflowInspector';
import WorkflowComposerDialog from './WorkflowComposerDialog';
import WorkflowDetailView from './WorkflowDetailView';
import './adv-workflows.css';

type Mode = 'workflows' | 'activity';

/**
 * How many ledger rows are put in the DOM at once.
 *
 * Measured in the desktop shell against the real workspace: the unbounded ledger rendered
 * 4,441 rows and 99,597 DOM nodes. The facets, the search and the sort are the instruments
 * for finding a row; a five-figure DOM is not. What is held back is always DISCLOSED — a
 * silently truncated ledger would be a worse lie than a slow one.
 */
const ROW_RENDER_CAP = 200;

const STATE_FACETS: ReadonlyArray<{ id: StateFacet; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'running', label: 'Running' },
  { id: 'paused', label: 'Paused' },
];

const KIND_FACETS: ReadonlyArray<{ id: KindFacet; label: string }> = [
  { id: 'all', label: 'Every kind' },
  { id: 'triggered', label: 'Triggered' },
  { id: 'routine', label: 'Routines' },
  { id: 'system', label: 'System' },
];

const SORTS: ReadonlyArray<{ id: LedgerSort; label: string }> = [
  { id: 'attention', label: 'Attention first' },
  { id: 'next', label: 'Next to fire' },
  { id: 'last', label: 'Recently fired' },
  { id: 'name', label: 'Name' },
];

type CreateTriggerKind = 'schedule' | 'external';
type CreatePlanMode = 'existing' | 'new';
type CreateTargetKind = 'plan' | 'goal' | 'email-work-item';
type SchedulePreset = 'every-15-minutes' | 'hourly' | 'daily' | 'weekly';

interface CreatePlanRef {
  slug: string;
  harness: string;
  title: string;
}

interface PendingArm {
  kind: CreateTriggerKind;
  target: CreateTargetKind;
  plan: CreatePlanRef | null;
  targetLabel: string;
  sourceLabel: string;
  bindingId?: string;
}

interface CreationResult extends PendingArm {
  armed: true;
}

const SCHEDULE_PRESETS: Record<SchedulePreset, { label: string; cron: string }> = {
  'every-15-minutes': { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  hourly: { label: 'Hourly', cron: '0 * * * *' },
  daily: { label: 'Daily at 09:00', cron: '0 9 * * *' },
  weekly: { label: 'Weekly · Monday at 09:00', cron: '0 9 * * 1' },
};

function planRefKey(plan: Pick<CreatePlanRef, 'harness' | 'slug'>): string {
  return `${plan.harness}:${plan.slug}`;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function uniqueDatedPlanSlug(title: string, plans: readonly AutomationPlanRow[]): string {
  const normalized = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'automation-plan';
  const base = normalized.length >= 3 ? normalized : `automation-${normalized}`;
  const date = new Date().toISOString().slice(0, 10);
  const existing = new Set(plans.map((plan) => plan.slug));
  let candidate = `${base}-${date}`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}-${date}`;
    suffix += 1;
  }
  return candidate;
}

/** Search the already-loaded workspace-wide plan directory without changing plan identity. */
export function filterWorkflowPlans(
  plans: readonly AutomationPlanRow[],
  query: string,
): AutomationPlanRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...plans];
  return plans.filter((plan) => [plan.title, plan.slug, plan.harness]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}

function planDisplayLabel(plan: Pick<AutomationPlanRow, 'title' | 'slug' | 'harness'>): string {
  return `${plan.title ?? plan.slug} · ${plan.harness}`;
}

/**
 * A compact, keyboard-accessible plan combobox. Native Select is intentionally not used:
 * this list is workspace-wide and can contain hundreds of plans, while the selected value
 * remains the canonical harness/slug key used by the binding writer.
 */
function SearchablePlanPicker({
  plans,
  value,
  onChange,
  disabled,
}: {
  plans: readonly AutomationPlanRow[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const selected = plans.find((plan) => planRefKey(plan) === value) ?? null;
  const filtered = useMemo(() => filterWorkflowPlans(plans, query), [plans, query]);

  useEffect(() => {
    setHighlightedIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const choose = (plan: AutomationPlanRow) => {
    onChange(planRefKey(plan));
    setQuery('');
    setOpen(false);
    setHighlightedIndex(0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((current) => Math.min(current + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter' && open && filtered[highlightedIndex]) {
      event.preventDefault();
      choose(filtered[highlightedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="pc-workflows-create__plan-picker">
      <div className="pc-workflows-create__plan-search-wrap">
        <Search size={15} aria-hidden />
        <input
          role="combobox"
          aria-label="Plan to run"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={open && filtered[highlightedIndex] ? `${listboxId}-${planRefKey(filtered[highlightedIndex])}` : undefined}
          disabled={disabled}
          value={open ? query : ''}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onBlur={() => { window.setTimeout(() => setOpen(false), 0); }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlightedIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search plans by name, slug, or harness…"
        />
      </div>
      {selected ? (
        <div className="pc-workflows-create__plan-selected" role="status">
          <span>Selected</span>
          <strong>{planDisplayLabel(selected)}</strong>
        </div>
      ) : null}
      {open ? (
        <div className="pc-workflows-create__plan-options" id={listboxId} role="listbox" aria-label="Matching plans">
          {filtered.length > 0 ? filtered.map((plan, index) => (
            <button
              type="button"
              role="option"
              id={`${listboxId}-${planRefKey(plan)}`}
              aria-selected={planRefKey(plan) === value}
              data-highlighted={index === highlightedIndex || undefined}
              key={planRefKey(plan)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => choose(plan)}
            >
              <span className="pc-workflows-create__plan-option-inner">
                <strong>{plan.title ?? plan.slug}</strong>
                <small>{plan.slug} · {plan.harness}</small>
              </span>
            </button>
          )) : (
            <p className="pc-workflows-create__plan-empty" role="status">No plans match “{query}”.</p>
          )}
        </div>
      ) : null}
      {!disabled && plans.length === 0 ? (
        <p className="pc-workflows-create__plan-empty" role="status">No plans are available in this workspace.</p>
      ) : null}
    </div>
  );
}

function inlinePlanContent(outcome: string, triggerLabel: string): string {
  const delivery = outcome.replace(/\s+/g, ' ').trim();
  return [
    '## Now',
    '',
    `State: Ready for its ${triggerLabel.toLocaleLowerCase()} trigger.`,
    `Next: ${delivery}`,
    '',
    '## Background',
    '',
    `Created in place from Workflows for a real ${triggerLabel.toLocaleLowerCase()} trigger.`,
    '',
    '## Delivery',
    '',
    `- **P-001** \`todo\` ${delivery} importance: normal`,
    '',
    '## Decisions',
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function AdvWorkflowsTab() {
  const resolvedHarnessSlug = useResolvedHarnessSlug();
  const [mode, setMode] = useQueryState(
    'wfMode',
    parseAsStringEnum<Mode>(['workflows', 'activity']).withDefault('workflows'),
  );
  const [stateFacet, setStateFacet] = useQueryState(
    'wfState',
    parseAsStringEnum<StateFacet>(['all', 'attention', 'running', 'paused']).withDefault('all'),
  );
  const [kindFacet, setKindFacet] = useQueryState(
    'wfKind',
    parseAsStringEnum<KindFacet>(['all', 'triggered', 'routine', 'system']).withDefault('all'),
  );
  const [sourceFacet, setSourceFacet] = useQueryState('wfSource', parseAsString);
  const [sort, setSort] = useQueryState(
    'wfSort',
    parseAsStringEnum<LedgerSort>(['attention', 'next', 'last', 'name']).withDefault('attention'),
  );
  const [query, setQuery] = useQueryState('wfQ', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('wfSelId', parseAsString);
  // The EXPANSION of the inspector (D-002): the full topology + agent chat. A distinct
  // param from `wfSelId` because it is a destination, not a row highlight.
  const [wfId, setWfId] = useQueryState('wfId', parseAsString);
  const [, setAdvTab] = useQueryState('tab', parseAsString);
  const [, setCalendarPlan] = useQueryState('calPlan', parseAsString);
  const { confirm, element: confirmElement } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const [lastTestRun, setLastTestRun] = useState<{ workflowId: string; runId: string } | null>(null);
  // Dialog open-state is nuqs, not useState: the repo's split lists drawer/dialog
  // open-state as user-meaningful, and an agent driving this tab through ui:dispatch can
  // neither observe nor open a modal held in component state. One scalar rather than two
  // booleans, because the two dialogs are mutually exclusive and hand off to each other.
  const [dialog, setDialog] = useQueryState(
    'wfDialog',
    parseAsStringEnum<'compose' | 'create'>(['compose', 'create']),
  );
  // Mid-edit intent handed into the canonical workflow-agent conversation — genuinely
  // mid-edit text, so it stays useState by that same split, as does the composer draft.
  const [composerPrompt, setComposerPrompt] = useState('');
  const [draft, setDraft] = useState('');

  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 15_000,
  });
  const catalog = catalogQuery.data?.[0] ?? null;

  const plansQuery = useSyncQuery<AutomationPlanRow>({
    queryName: 'plans.list',
    // No args is the canonical active-workspace superset: callPlansReadRaw injects
    // workspaceWide:true. Do not fan out the project registry here — harness_slugs is
    // capped at 64 and a large workspace would strand this view in Loading.
    args: {},
  });
  const schedulesQuery = useSyncQuery<AutomationScheduleRow>({
    queryName: 'plans.schedule',
    args: {},
  });
  const occurrenceWindow = useMemo(() => {
    const now = Date.now();
    return { rangeStartMs: now, rangeEndMs: now + 30 * 24 * 60 * 60 * 1000 };
  }, []);
  const occurrencesQuery = useSyncQuery<AutomationOccurrenceRow>({
    queryName: 'plans.scheduledOccurrences',
    args: occurrenceWindow,
  });

  const [external, setExternal] = useState<ExternalTriggerAdminSnapshot | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const loadExternal = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/triggers', { cache: 'no-store' });
      const body = await response.json() as ExternalTriggerAdminSnapshot & { detail?: string };
      if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
      setExternal(body);
      setExternalError(null);
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => { void loadExternal(); }, [loadExternal]);

  const modelInput = useMemo(() => ({
    catalog,
    plans: plansQuery.data ?? [],
    schedules: schedulesQuery.data ?? [],
    occurrences: occurrencesQuery.data ?? [],
    external,
  }), [catalog, external, occurrencesQuery.data, plansQuery.data, schedulesQuery.data]);

  const items = useMemo(() => buildAutomationItems(modelInput), [modelInput]);
  const rows = useMemo(() => buildLedgerRows(items), [items]);
  const counts = useMemo(() => buildFacetCounts(rows), [rows]);
  const activity = useMemo(() => buildAutomationActivity(modelInput), [modelInput]);
  const sources = useMemo(() => buildAutomationSources(modelInput), [modelInput]);
  const sourceHealth = useMemo(() => buildSourceHealth(sources), [sources]);
  const landingSources = external?.sources ?? [];
  const needsYou = useMemo(
    () => collapseNeedsYou(buildNeedsYou({ sources: landingSources, rows })),
    [landingSources, rows],
  );
  const chips = useMemo(() => buildSuggestionChips(landingSources), [landingSources]);

  const visibleRows = useMemo(
    () => sortLedgerRows(
      filterLedgerRows(rows, { state: stateFacet, kind: kindFacet, source: sourceFacet, query }),
      sort,
    ),
    [rows, stateFacet, kindFacet, sourceFacet, query, sort],
  );

  // The inspected workflow: the explicit selection when it still exists, else the first
  // visible row. Falling through keeps the inspector populated as facets change instead of
  // emptying it under the operator.
  const selectedRow = visibleRows.find((row) => row.id === selectedId)
    ?? rows.find((row) => row.id === selectedId)
    ?? visibleRows[0]
    ?? null;
  const inspected = selectedRow ? items.find((item) => item.id === selectedRow.id) ?? null : null;

  const inspectedBinding = useMemo(() => {
    if (!inspected || !external) return null;
    return (
      external.bindings.find((binding) =>
        inspected.operation
          ? binding.action?.type === "blueprint-operation" &&
            binding.action.operationHarnessSlug ===
              inspected.operation.harnessSlug &&
            binding.action.operationId === inspected.operation.operationId
          : inspected.planSlug != null &&
            binding.planSlug === inspected.planSlug,
      ) ?? null
    );
  }, [external, inspected]);

  const [inputs, setInputs] = useState<PlanInputSchemaInfo | null>(null);
  useEffect(() => {
    let live = true;
    setInputs(null);
    if (!inspected?.planSlug) return () => { live = false; };
    void fetchPlanInputs(inspected.planSlug, inspected.harness)
      .then((result) => {
        if (live && result.ok) setInputs(result);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [inspected?.harness, inspected?.planSlug]);

  const runHistoryQuery = useSyncQuery<RunHistoryRow>({
    queryName: 'plans.runHistory',
    args: inspected?.planSlug
      ? { planSlug: inspected.planSlug, ...(inspected.harness ? { harnessSlug: inspected.harness } : {}) }
      : { planSlug: '__none__' },
    enabled: Boolean(inspected?.planSlug),
  });
  const runHistory = runHistoryQuery.data?.[0] ?? null;

  const refreshAll = useCallback(() => {
    void catalogQuery.invalidate?.();
    void plansQuery.invalidate?.();
    void schedulesQuery.invalidate?.();
    void occurrencesQuery.invalidate?.();
    void runHistoryQuery.invalidate?.();
    void loadExternal();
  }, [catalogQuery, loadExternal, occurrencesQuery, plansQuery, runHistoryQuery, schedulesQuery]);

  const invoke = useCallback(async (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(key);
    try {
      const result = await runScheduleTool(tool, args);
      if (!result.ok) throw new Error(result.message ?? `${tool} failed`);
      toast.success(success);
      refreshAll();
    } catch (error) {
      toast.error('Workflow control failed', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }, [refreshAll]);

  const setBindingArmed = useCallback(async (bindingId: string, armed: boolean) => {
    setBusy(`binding:${bindingId}`);
    try {
      const response = await fetch('/api/admin/triggers', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'set-armed', id: bindingId, armed, confirm: true }),
      });
      const body = await response.json() as { detail?: string; error?: string };
      if (!response.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${response.status}`);
      toast.success(armed ? 'Trigger armed' : 'Trigger paused');
      refreshAll();
    } catch (error) {
      toast.error('Trigger control failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [refreshAll]);

  const runWithLastEvent = useCallback(async (
    workflowId: string,
    workflowLabel: string,
    bindingId: string,
  ) => {
    if (!(await confirm({
      title: `Test ${workflowLabel} with its last event?`,
      body: 'This queues a new plan run from the last settled provider event. The workflow may perform its configured provider write, such as creating a Gmail draft or posting a Slack thread reply. The source event itself is not re-ingested.',
      confirmLabel: 'Queue test run',
    }))) return;
    setBusy(`run:${workflowId}`);
    try {
      const result = await runScheduleTool('triggers:run-with-last-event', {
        bindingId,
        confirm: true,
      });
      if (!result.ok) throw new Error(result.message ?? 'Run with last event failed');
      const run = result.data?.run;
      const runId = run && typeof run === 'object' && !Array.isArray(run)
        && typeof (run as { id?: unknown }).id === 'string'
        ? (run as { id: string }).id
        : null;
      if (!runId) throw new Error('Run with last event returned no trigger-run id');
      setLastTestRun({ workflowId, runId });
      toast.success('Test run queued', { description: `Trigger run ${runId.slice(0, 8)} is visible in Activity.` });
      refreshAll();
    } catch (error) {
      toast.error('Workflow test failed', { description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  const toggleRoutine = useCallback(async (item: AutomationItem) => {
    const routine = item.routine;
    if (!routine || !routine.controllable) return;
    const next = !routine.active;
    if (!next && !(await confirm({
      title: `Pause ${item.label}?`,
      body: 'Its schedule remains visible, but it will stop firing until resumed.',
      confirmLabel: 'Pause workflow',
      destructive: true,
    }))) return;
    setBusy(`routine:${item.id}`);
    try {
      if (routine.control === 'flag') {
        if (!routine.flagKey) throw new Error('Flag-controlled workflow has no flag key');
        const result = await runScheduleTool('flags:set', {
          key: routine.flagKey,
          enabled: next,
          reason: `Changed from the Workflows tab`,
        });
        if (!result.ok) throw new Error(result.message ?? 'Flag update failed');
      } else {
        for (const installSlug of routine.installs) {
          const result = await runScheduleTool('routines:set', {
            name: routine.name,
            installSlug,
            active: next,
            ...(next ? {} : { reason: 'Paused from the Workflows tab' }),
          });
          if (!result.ok) throw new Error(result.message ?? `Routine update failed for ${installSlug}`);
        }
      }
      toast.success(next ? 'Workflow resumed' : 'Workflow paused');
      refreshAll();
    } catch (error) {
      toast.error('Workflow control failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  const pauseAutomaticTriggers = useCallback(async (item: AutomationItem) => {
    const automatic = item.triggers.filter((trigger) => trigger.armed === true);
    if (automatic.length === 0) return;
    if (!(await confirm({
      title: `Pause automatic triggers for ${item.label}?`,
      body: 'Schedules and external event bindings will stop firing. Run manually remains available.',
      confirmLabel: 'Pause triggers',
      destructive: true,
    }))) return;
    setBusy(`pause:${item.id}`);
    try {
      for (const trigger of automatic) {
        if (trigger.kind === 'schedule') {
          if (!item.planSlug)
            throw new Error("Scheduled workflow has no plan target");
          const result = await runScheduleTool('plans:disarm-schedule', {
            slug: item.planSlug,
            ...(item.harness ? { harness: item.harness } : {}),
          });
          if (!result.ok) throw new Error(result.message ?? 'Schedule pause failed');
        } else if (trigger.bindingId) {
          const response = await fetch('/api/admin/triggers', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'set-armed', id: trigger.bindingId, armed: false, confirm: true }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { detail?: string };
            throw new Error(body.detail ?? `External trigger pause failed (${response.status})`);
          }
        }
      }
      toast.success('Automatic triggers paused');
      refreshAll();
    } catch (error) {
      toast.error('Pause failed', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, [confirm, refreshAll]);

  /** Toggle every automatic trigger on a row from the ledger's single arm control. */
  const toggleRowArm = useCallback((rowId: string) => {
    const item = items.find((candidate) => candidate.id === rowId);
    if (!item) return;
    if (item.routine?.controllable) { void toggleRoutine(item); return; }
    const anyArmed = item.triggers.some((trigger) => trigger.armed === true);
    if (anyArmed) { void pauseAutomaticTriggers(item); return; }
    const schedule = item.triggers.find((trigger) => trigger.kind === 'schedule');
    if (schedule && item.planSlug) {
      void invoke(
        `schedule:${item.id}`,
        'plans:arm-schedule',
        { slug: item.planSlug, ...(item.harness ? { harness: item.harness } : {}) },
        'Schedule armed',
      );
      return;
    }
    const binding = item.triggers.find((trigger) => trigger.kind === 'external' && trigger.bindingId);
    if (binding?.bindingId) void setBindingArmed(binding.bindingId, true);
  }, [invoke, items, pauseAutomaticTriggers, setBindingArmed, toggleRoutine]);

  const openComposer = useCallback((prompt: string) => {
    setComposerPrompt(prompt);
    void setDialog('compose');
  }, [setDialog]);

  const closeDialog = useCallback(() => {
    void setDialog(null);
    setComposerPrompt('');
  }, [setDialog]);

  /**
   * The needs-you strip's action.
   *
   * `review-runs` switches to the Activity mode — the runs are right there in the same
   * frame. `reconnect` opens the workflow agent seeded with the strip's own sentence:
   * chasing a broken provider connection is exactly the agent-mediated work D-016 routes
   * through the chat, and the tab itself has never had a reconnect write of its own.
   */
  const onNeedsYouAction = useCallback((entry: NeedsYouItem) => {
    if (entry.kind === 'reconnect') {
      openComposer(`${entry.message}. Check the connection and tell me what it needs to be restored.`);
      return;
    }
    // The collapsed aggregate stands for N workflows, so its action is the attention FACET —
    // the list of the very rows it counted — not the run feed.
    if (entry.id === 'needs-you:workflows-attention') {
      void setStateFacet('attention');
      void setMode('workflows');
      return;
    }
    void setMode('activity');
  }, [openComposer, setMode, setStateFacet]);

  const submitComposer = useCallback((event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt) return;
    openComposer(prompt);
    setDraft('');
  }, [draft, openComposer]);

  const loading = catalogQuery.loading || plansQuery.loading || schedulesQuery.loading;
  const planHarnesses = [...new Set((plansQuery.data ?? []).map((plan) => plan.harness).filter(Boolean))];
  const creationHarness = resolvedHarnessSlug ?? (planHarnesses.length === 1 ? planHarnesses[0] : null);
  const filtered = stateFacet !== 'all' || kindFacet !== 'all' || sourceFacet != null || query.trim() !== '';
  const populationEmpty = !loading && rows.length === 0;

  // The expansion (D-002). A `wfId` that resolves to nothing (a stale URL) falls through to
  // the frame rather than rendering an empty shell.
  const expandedWorkflow = wfId ? items.find((item) => item.id === wfId) ?? null : null;
  const expandedBinding =
    expandedWorkflow && external
      ? (external.bindings.find((binding) =>
          expandedWorkflow.operation
            ? binding.action?.type === "blueprint-operation" &&
              binding.action.operationHarnessSlug ===
                expandedWorkflow.operation.harnessSlug &&
              binding.action.operationId ===
                expandedWorkflow.operation.operationId
            : expandedWorkflow.planSlug != null &&
              binding.planSlug === expandedWorkflow.planSlug,
        ) ?? null)
      : null;

  if (expandedWorkflow) {
    const armBusyKey = expandedBinding ? `binding:${expandedBinding.id}` : null;
    return (
      <section className="pc-wf" aria-label="Workflow detail">
        {confirmElement}
        <WorkflowDetailView
          workflowLabel={expandedWorkflow.label}
          planSlug={expandedWorkflow.planSlug ?? null}
          harnessSlug={expandedWorkflow.harness ?? null}
          binding={expandedBinding}
          bindingLoaded={external !== null}
          operationTarget={expandedWorkflow.operation?.target ?? null}
          lastFiredLabel={
            expandedWorkflow.lastAt == null
              ? null
              : `last fired ${relativeTime(expandedWorkflow.lastAt)}`
          }
          lastTestRunId={
            lastTestRun?.workflowId === expandedWorkflow.id
              ? lastTestRun.runId
              : null
          }
          busy={
            armBusyKey !== null && busy === armBusyKey
              ? "arm"
              : busy === `run:${expandedWorkflow.id}`
                ? "test"
                : null
          }
          onBack={() => void setWfId(null)}
          onToggleArm={() =>
            expandedBinding &&
            void setBindingArmed(expandedBinding.id, !expandedBinding.armed)
          }
          onTest={() =>
            expandedBinding &&
            void runWithLastEvent(
              expandedWorkflow.id,
              expandedWorkflow.label,
              expandedBinding.id,
            )
          }
        />
      </section>
    );
  }

  return (
    <section className="pc-wf" aria-label="Workflows">
      {confirmElement}
      {dialog === 'compose' ? (
        <WorkflowComposerDialog
          harnessSlug={creationHarness}
          sources={external?.sources ?? []}
          intent={composerPrompt}
          onClose={closeDialog}
          onAdvancedSetup={() => void setDialog('create')}
        />
      ) : null}
      {dialog === 'create' ? (
        <CreateAutomationModal
          plans={plansQuery.data ?? []}
          sources={external?.sources ?? []}
          defaultHarness={creationHarness}
          initialOutcome={composerPrompt}
          onClose={closeDialog}
          onCreated={(plan) => {
            refreshAll();
            if (plan) void setSelectedId(`plan:${planRefKey(plan)}`);
          }}
        />
      ) : null}

      <header className="pc-wf__mast">
        <div className="pc-wf__mast-copy">
          <span className="pc-wf__eyebrow">Automation control</span>
          <div className="pc-wf__mast-ident">
            <h1 className="pc-wf__title">Workflows</h1>
            <span className="pc-wf__summary" data-loading={loading || undefined}>
              {loading ? 'Loading workflow inventory…' : buildPopulationSummary(counts)}
            </span>
          </div>
          <p className="pc-wf__lede">Create, monitor, and repair everything that runs without you.</p>
          {sourceHealth.length > 0 ? (
            <span className="pc-wf__sources" role="group" aria-label="Source health">
              {sourceHealth.map((entry) => {
                const active = sourceFacet === entry.token;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="pc-wf__source"
                    data-tone={entry.tone}
                    data-active={active}
                    aria-pressed={active}
                    aria-label={`${entry.label}: ${entry.status}, ${entry.armedCount} of ${entry.bindingCount} armed`}
                    onClick={() => void setSourceFacet(active ? null : entry.token)}
                  >
                    <span className="pc-wf__btn-inner">
                      <i className="pc-wf__dot" data-tone={entry.tone} aria-hidden />
                      <span className="pc-wf__source-name">{entry.label}</span>
                      <span className="pc-wf__source-count">
                        {entry.bindingCount > 0 ? `${entry.armedCount}/${entry.bindingCount}` : entry.status}
                      </span>
                    </span>
                  </button>
                );
              })}
            </span>
          ) : null}
        </div>
        <div className="pc-wf__mast-actions">
          <button type="button" className="pc-wf__btn" onClick={refreshAll} aria-label="Refresh workflows">
            <span className="pc-wf__btn-inner"><RefreshCw size={14} aria-hidden /> Refresh</span>
          </button>
          <button type="button" className="pc-wf__btn pc-wf__btn--primary" onClick={() => openComposer('')}>
            <span className="pc-wf__btn-inner"><Plus size={14} aria-hidden /> New workflow</span>
          </button>
        </div>
      </header>

      <section className="pc-wf__composer" aria-label="Describe a workflow">
        <div className="pc-wf__composer-head">
          <span className="pc-wf__composer-icon" aria-hidden><Sparkles size={17} /></span>
          <div>
            <h2 className="pc-wf__composer-title">Build with the workflow agent</h2>
            <p className="pc-wf__composer-copy">Describe the trigger and outcome. The agent assembles the workflow for review.</p>
          </div>
        </div>
        <div className="pc-wf__composer-work">
          <form onSubmit={submitComposer}>
            <label className="pc-wf__composer-label" htmlFor="pc-wf-compose">
              What should happen automatically?
            </label>
            <div className="pc-wf__composer-row">
              <input
                id="pc-wf-compose"
                className="pc-wf__composer-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="When an email from a client arrives…"
              />
              <button type="submit" className="pc-wf__btn pc-wf__btn--tint" disabled={draft.trim().length === 0}>
                <span className="pc-wf__btn-inner">Wire it</span>
              </button>
            </div>
          </form>
          {chips.length > 0 ? (
            <div className="pc-wf__chips" data-testid="workflows-chips">
              {chips.map((chip) => (
                <button key={chip.id} type="button" className="pc-wf__suggest" onClick={() => setDraft(chip.text)}>
                  <span className="pc-wf__btn-inner">{chip.text}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* D-018, preserved by D-004: rendered ONLY when non-empty. No empty-state branch.
          Bounded by collapseNeedsYou so it stays an interrupt rather than a wall. */}
      {needsYou.rows.length > 0 ? (
        <section className="pc-wf__needs" aria-label="Needs you" data-testid="workflows-needs-you">
          <span className="pc-wf__needs-lead">Needs you</span>
          <ul className="pc-wf__needs-list">
            {needsYou.rows.map((entry) => (
              <li key={entry.id} className="pc-wf__needs-item" data-severity={entry.severity}>
                <i className="pc-wf__dot" data-state={entry.severity === 'bad' ? 'attention' : 'paused'} aria-hidden />
                <span className="pc-wf__needs-msg">{entry.message}</span>
                <button type="button" className="pc-wf__btn pc-wf__btn--sm" onClick={() => onNeedsYouAction(entry)}>
                  <span className="pc-wf__btn-inner">{entry.actionLabel}</span>
                </button>
              </li>
            ))}
          </ul>
          {needsYou.hiddenCount > 0 ? (
            <button
              type="button"
              className="pc-wf__btn pc-wf__btn--sm pc-wf__btn--ghost"
              onClick={() => { void setStateFacet('attention'); void setMode('workflows'); }}
            >
              <span className="pc-wf__btn-inner">{needsYou.hiddenCount} more</span>
            </button>
          ) : null}
        </section>
      ) : null}

      {externalError ? (
        <div className="pc-wf__notice" role="status">
          External sources are temporarily unavailable: {externalError}. Routine and schedule data remain live.
        </div>
      ) : null}

      <section className="pc-wf__controls" aria-label="Workflow controls" data-testid="workflows-control-deck">
        <div className="pc-wf__control-row">
          <div className="pc-wf__control-cluster">
            <span className="pc-wf__control-label">View</span>
            <Tabs.Root value={mode} onValueChange={(next) => void setMode(next as Mode)}>
              <Tabs.List className="pc-wf__seg" aria-label="Workflows view">
                <Tabs.Trigger value="workflows" className="pc-wf__seg-tab">Workflows</Tabs.Trigger>
                <Tabs.Trigger value="activity" className="pc-wf__seg-tab">Activity</Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>
          </div>

          {mode === 'workflows' ? (
            <div className="pc-wf__control-cluster pc-wf__control-cluster--grow">
              <span className="pc-wf__control-label">State</span>
              <div className="pc-wf__facet-group" role="group" aria-label="Filter by state">
                {STATE_FACETS.map((facet) => (
                  <button
                    key={facet.id}
                    type="button"
                    className="pc-wf__facet"
                    aria-pressed={stateFacet === facet.id}
                    onClick={() => void setStateFacet(facet.id)}
                  >
                    <span className="pc-wf__btn-inner">
                      {facet.label}
                      <span className="pc-wf__facet-n">
                        {loading ? '—' : facet.id === 'all' ? counts.all : counts[facet.id]}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {mode === 'workflows' ? (
          <div className="pc-wf__control-row pc-wf__control-row--secondary">
            <div className="pc-wf__control-cluster">
              <span className="pc-wf__control-label">Kind</span>
              <div className="pc-wf__facet-group pc-wf__kind-facets" role="group" aria-label="Filter by kind">
                {KIND_FACETS.map((facet) => (
                  <button
                    key={facet.id}
                    type="button"
                    className="pc-wf__facet"
                    aria-pressed={kindFacet === facet.id}
                    onClick={() => void setKindFacet(facet.id)}
                  >
                    <span className="pc-wf__btn-inner">
                      {facet.label}
                      <span className="pc-wf__facet-n">
                        {loading ? '—' : facet.id === 'all' ? counts.all : counts[facet.id]}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="pc-wf__kind-select">
                <Select
                  value={kindFacet}
                  onChange={(value) => void setKindFacet(value as KindFacet)}
                  ariaLabel="Filter workflows by kind"
                  triggerClassName="pc-wf__sort pc-wf__kind-select-trigger"
                  options={KIND_FACETS.map((entry) => ({ value: entry.id, label: entry.label }))}
                />
              </div>
            </div>
            <div className="pc-wf__control-cluster pc-wf__control-cluster--search">
              <span className="pc-wf__control-label">Find</span>
              <label className="pc-wf__search">
                <Search size={13} aria-hidden />
                <input
                  value={query}
                  onChange={(event) => void setQuery(event.target.value)}
                  placeholder="Search workflows"
                  aria-label="Search workflows"
                />
              </label>
            </div>
            <div className="pc-wf__control-cluster">
              <span className="pc-wf__control-label">Sort</span>
              <Select
                value={sort}
                onChange={(value) => void setSort(value as LedgerSort)}
                ariaLabel="Sort workflows"
                triggerClassName="pc-wf__sort"
                options={SORTS.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
            </div>
          </div>
        ) : null}
      </section>

      <div className="pc-wf__body" data-population-empty={populationEmpty || undefined}>
        {mode === 'activity' ? (
          <ActivityList
            activity={activity.slice(0, ROW_RENDER_CAP)}
            hiddenCount={Math.max(0, activity.length - ROW_RENDER_CAP)}
            onOpen={(entry) => { if (entry.automationId) void setSelectedId(entry.automationId); }}
          />
        ) : (
          <WorkflowsLedger
            rows={visibleRows.slice(0, ROW_RENDER_CAP)}
            hiddenCount={Math.max(0, visibleRows.length - ROW_RENDER_CAP)}
            selectedId={selectedRow?.id ?? null}
            loading={loading}
            emptyTitle={filtered ? 'No matching workflows' : 'Your workflow control center starts here'}
            emptyLabel={filtered
              ? 'No workflows match these filters.'
              : 'No workflows are installed yet. Describe one above and the agent will wire it.'}
            onSelect={(row) => void setSelectedId(row.id)}
            onToggleArm={(row) => toggleRowArm(row.id)}
            busyRowId={busy?.startsWith('schedule:') || busy?.startsWith('pause:') || busy?.startsWith('routine:')
              ? busy.slice(busy.indexOf(':') + 1)
              : null}
          />
        )}
        {!populationEmpty ? (
          <WorkflowInspector
            item={inspected}
            row={selectedRow}
            inputs={inputs}
            runs={runHistory}
            binding={inspectedBinding}
            bindingLoaded={external !== null}
            loading={loading}
            emptyReason={filtered && visibleRows.length === 0 ? 'filtered' : 'selection'}
            busy={busy}
            onRun={() => inspected?.planSlug && void invoke(
              `run:${inspected.id}`,
              'plans:run-now',
              { slug: inspected.planSlug, ...(inspected.harness ? { harness: inspected.harness } : {}) },
              `${inspected.label} started`,
            )}
            onToggleSchedule={(armed) => inspected?.planSlug && void invoke(
              `schedule:${inspected.id}`,
              armed ? 'plans:arm-schedule' : 'plans:disarm-schedule',
              { slug: inspected.planSlug, ...(inspected.harness ? { harness: inspected.harness } : {}) },
              armed ? 'Schedule armed' : 'Schedule paused',
            )}
            onToggleBinding={(id, armed) => void setBindingArmed(id, armed)}
            onToggleRoutine={() => inspected && void toggleRoutine(inspected)}
            onPauseAll={() => inspected && void pauseAutomaticTriggers(inspected)}
            onEditSchedule={() => {
              if (!inspected?.planSlug) return;
              void setCalendarPlan(inspected.planSlug);
              void setAdvTab('calendar');
            }}
            onExpand={() => inspected && void setWfId(inspected.id)}
            onAsk={() => {
              if (!inspected) return;
              openComposer(`About the workflow "${inspected.label}": `);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

async function mutateExternalTrigger(args: Record<string, unknown>): Promise<{
  ok: boolean;
  message?: string;
  bindingId?: string;
}> {
  try {
    const response = await fetch('/api/admin/triggers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await response.json().catch(() => ({})) as {
      ok?: boolean;
      error?: string;
      detail?: string;
      binding?: { id?: unknown };
    };
    if (!response.ok || body.ok === false) {
      return { ok: false, message: body.detail ?? body.error ?? `HTTP ${response.status}` };
    }
    return {
      ok: true,
      ...(typeof body.binding?.id === 'string' ? { bindingId: body.binding.id } : {}),
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function CreateAutomationModal({
  plans,
  sources,
  defaultHarness,
  initialOutcome = '',
  onClose,
  onCreated,
}: {
  plans: AutomationPlanRow[];
  sources: ExternalTriggerAdminSnapshot['sources'];
  defaultHarness: string | null;
  /** Seed for the outcome field, handed over from the agent composer. */
  initialOutcome?: string;
  onClose: () => void;
  onCreated: (plan: CreatePlanRef | null) => void;
}) {
  const availablePlans = useMemo(
    () => plans
      .filter((plan) => plan.status !== 'shipped' && plan.status !== 'superseded')
      .sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug)),
    [plans],
  );
  const connectedSources = useMemo(
    () => sources.filter((source) => source.status === 'connected'),
    [sources],
  );
  const [triggerKind, setTriggerKind] = useState<CreateTriggerKind>('schedule');
  // The trigger engine has three real target contracts. Schedules can only launch
  // plans; external events may additionally activate a goal or create the
  // Gmail-specific bounded Email work item.
  const [targetKind, setTargetKind] = useState<CreateTargetKind>('plan');
  const [planMode, setPlanMode] = useState<CreatePlanMode>(availablePlans.length > 0 ? 'existing' : 'new');
  const [selectedPlanKey, setSelectedPlanKey] = useState(availablePlans[0] ? planRefKey(availablePlans[0]) : '');
  const [goalId, setGoalId] = useState('');
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('every-15-minutes');
  const [tzid, setTzid] = useState(browserTimeZone);
  const [sourceId, setSourceId] = useState(connectedSources[0]?.id ?? '');
  const [eventPattern, setEventPattern] = useState(
    connectedSources[0] ? `ext:${connectedSources[0].kind}:` : '',
  );
  const [planName, setPlanName] = useState('');
  const [outcome, setOutcome] = useState(initialOutcome);
  const [createdPlan, setCreatedPlan] = useState<CreatePlanRef | null>(null);
  const [pendingArm, setPendingArm] = useState<PendingArm | null>(null);
  const [result, setResult] = useState<CreationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPlanKey && availablePlans[0]) setSelectedPlanKey(planRefKey(availablePlans[0]));
  }, [availablePlans, selectedPlanKey]);
  useEffect(() => {
    if (!sourceId && connectedSources[0]) {
      setSourceId(connectedSources[0].id);
      setEventPattern(`ext:${connectedSources[0].kind}:`);
    }
  }, [connectedSources, sourceId]);
  useEffect(() => {
    // A schedule is persisted by the plan schedule subsystem and has no goal or
    // direct-work-item target column. Keep the form from ever constructing an
    // impossible schedule payload when the trigger kind changes.
    if (triggerKind === 'schedule' && targetKind !== 'plan') setTargetKind('plan');
  }, [targetKind, triggerKind]);

  const selectedPlan = availablePlans.find((plan) => planRefKey(plan) === selectedPlanKey) ?? null;
  const selectedSource = connectedSources.find((source) => source.id === sourceId) ?? null;
  const timeZones = [...new Set([browserTimeZone(), 'America/New_York', 'UTC'])];
  const newPlanReady = Boolean(createdPlan || (defaultHarness && planName.trim() && outcome.trim()));
  const planReady = planMode === 'existing' ? Boolean(selectedPlan) : newPlanReady;
  const triggerReady = triggerKind === 'schedule' || Boolean(selectedSource && eventPattern.trim());
  const targetReady = targetKind === 'plan'
    ? planReady
    : targetKind === 'goal'
      ? Boolean(goalId.trim())
      : triggerKind === 'external' && selectedSource?.kind === 'gmail';
  const canSubmit = targetReady && triggerReady && !pendingArm;
  const chooseTarget = (next: CreateTargetKind) => {
    // Goal and direct-work-item actions are external-trigger contracts. Selecting
    // one from the default schedule view switches the trigger mode with the
    // target, so a valid action is never hidden behind a disabled card.
    if (next !== 'plan') setTriggerKind('external');
    setTargetKind(next);
    setError(null);
  };

  const finishArmed = (target: PendingArm) => {
    setPendingArm(null);
    setError(null);
    setResult({ ...target, armed: true });
    onCreated(target.plan);
  };

  const armTarget = async (target: PendingArm): Promise<boolean> => {
    setPendingArm(target);
    setStep(target.kind === 'schedule' ? 'Arming schedule…' : 'Arming external event…');
    const armed = target.kind === 'schedule'
      ? await runScheduleTool('plans:arm-schedule', {
          slug: target.plan?.slug,
          harness: target.plan?.harness,
        })
      : target.bindingId
        ? await mutateExternalTrigger({
            op: 'set-armed',
            id: target.bindingId,
            armed: true,
            confirm: true,
          })
        : { ok: false, message: 'The created external binding did not return an id.' };
    if (!armed.ok) {
      setError(target.kind === 'schedule'
        ? `Schedule saved for ${target.targetLabel}, but it is not armed. ${armed.message ?? 'Arming failed.'}`
        : `External trigger saved for ${target.targetLabel}, but it is not armed. ${armed.message ?? 'Arming failed.'}`);
      return false;
    }
    finishArmed(target);
    return true;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    let plan: CreatePlanRef | null = targetKind === 'plan'
      ? planMode === 'existing' && selectedPlan
        ? { slug: selectedPlan.slug, harness: selectedPlan.harness, title: selectedPlan.title ?? selectedPlan.slug }
        : createdPlan
      : null;
    let createdThisAttempt = false;
    try {
      if (targetKind === 'plan' && !plan && planMode === 'new') {
        if (!defaultHarness) throw new Error('Select an owning pot before creating a plan in place.');
        const title = planName.trim();
        const delivery = outcome.trim();
        if (!title || !delivery) throw new Error('Name the workflow and describe the plan outcome.');
        const slug = uniqueDatedPlanSlug(title, plans);
        setStep('Creating plan…');
        const created = await runScheduleTool('plans:new', {
          slug,
          title,
          harness: defaultHarness,
          status: 'ready',
          rationale: 'Created in place from the Workflows production surface.',
          content: inlinePlanContent(delivery, triggerKind === 'schedule' ? 'Schedule' : 'External event'),
        });
        if (!created.ok) throw new Error(created.message ?? 'Plan creation failed.');
        plan = { slug, harness: defaultHarness, title };
        createdThisAttempt = true;
        setCreatedPlan(plan);
      }
      if (targetKind === 'plan' && !plan) throw new Error('Choose a plan to run.');

      if (triggerKind === 'schedule') {
        if (!plan) throw new Error('Schedules can only launch a plan.');
        const preset = SCHEDULE_PRESETS[schedulePreset];
        setStep('Saving schedule…');
        const scheduled = await runScheduleTool('plans:set-schedule', {
          slug: plan.slug,
          harness: plan.harness,
          schedule: { kind: 'cron', cron: preset.cron, tzid },
          scheduledAt: null,
          expiresAt: null,
          tzid,
        });
        if (!scheduled.ok) {
          throw new Error(`${createdThisAttempt ? `Plan ${plan.title} was created, but ` : ''}the schedule was not saved. ${scheduled.message ?? 'Schedule authoring failed.'}`);
        }
        await armTarget({
          kind: 'schedule',
          target: 'plan',
          plan,
          targetLabel: plan.title,
          sourceLabel: `${preset.label} · ${tzid}`,
        });
      } else {
        if (!selectedSource) throw new Error('Choose a connected external source.');
        const targetPayload = targetKind === 'plan'
          ? plan
            ? { planHarnessSlug: plan.harness, planSlug: plan.slug }
            : null
          : targetKind === 'goal'
            ? { goalId: goalId.trim() }
            : { workItemHarnessSlug: 'email', workItemKind: 'email-draft-proposal' };
        if (!targetPayload) throw new Error('Choose a plan to run.');
        if (targetKind === 'email-work-item' && selectedSource.kind !== 'gmail') {
          throw new Error('Email direct work-item triggers require a connected Gmail source.');
        }
        setStep('Attaching external event…');
        const attached = await mutateExternalTrigger({
          op: 'attach-external',
          sourceId: selectedSource.id,
          ...targetPayload,
          eventPattern: eventPattern.trim(),
          eventFilter: {},
          maxRuns: null,
          windowSeconds: 60,
        });
        if (!attached.ok || !attached.bindingId) {
          throw new Error(`${createdThisAttempt && plan ? `Plan ${plan.title} was created, but ` : ''}the external binding was not attached. ${attached.message ?? 'The binding id was missing.'}`);
        }
        await armTarget({
          kind: 'external',
          target: targetKind,
          plan,
          bindingId: attached.bindingId,
          targetLabel: targetKind === 'plan'
            ? plan?.title ?? 'Selected plan'
            : targetKind === 'goal'
              ? `Goal ${goalId.trim()}`
              : 'Email · email-draft-proposal',
          sourceLabel: `${selectedSource.kind} · ${eventPattern.trim()}`,
        });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  };

  const retryArm = async () => {
    if (!pendingArm || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await armTarget(pendingArm);
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next && !submitting) onClose(); }}
      title="Create a workflow"
      description="Choose a real automatic trigger and the plan it will run."
      srOnlyTitle
      closeOnEscape={!submitting}
      closeOnOutsideClick={!submitting}
      contentClassName="pc-workflows-create"
      contentStyle={{ width: 'min(760px, calc(100vw - 32px))' }}
    >
      <form onSubmit={submit}>
        <header className="pc-workflows-create__head">
          <div>
            <div className="pc-workflows-create__eyebrow">New workflow</div>
            <h2>Create a workflow</h2>
            <p>Choose a real automatic trigger and the plan it will run. Nothing leaves this popup.</p>
          </div>
          <button type="button" aria-label="Close create workflow dialog" disabled={submitting} onClick={onClose}>
            <span className="pc-workflows-create__close-inner"><X size={18} aria-hidden /></span>
          </button>
        </header>

        {result ? (
          <div className="pc-workflows-create__success" role="status">
            <div className="pc-workflows-create__success-icon" aria-hidden>✓</div>
            <div>
              <h3>Workflow armed</h3>
              <p><strong>{result.targetLabel}</strong> is attached to {result.sourceLabel}.</p>
              <dl>
                {result.plan ? <div><dt>Plan</dt><dd>{result.plan.harness} · {result.plan.slug}</dd></div> : <div><dt>Target</dt><dd>{result.targetLabel}</dd></div>}
                <div><dt>State</dt><dd>Armed</dd></div>
              </dl>
              <button type="button" className="pc-workflows-create__primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="pc-workflows-create__body">
              <section aria-labelledby="create-automation-trigger-label">
                <div className="pc-workflows-create__step">1 · What starts it?</div>
                <div className="pc-workflows-create__section-title" id="create-automation-trigger-label">
                  <strong>Automatic trigger</strong><span>Manual launch is an action, not a trigger.</span>
                </div>
                <div className="pc-workflows-create__choice-grid" role="group" aria-label="Automatic trigger">
                  <button type="button" aria-pressed={triggerKind === 'schedule'} onClick={() => { setTriggerKind('schedule'); setError(null); }}>
                    <span className="pc-workflows-create__choice-inner"><CalendarClock size={18} aria-hidden /><strong>Schedule</strong><span>Recurring cadence at a real time zone.</span><em>Uses the existing plan schedule system</em></span>
                  </button>
                  <button type="button" aria-pressed={triggerKind === 'external'} onClick={() => { setTriggerKind('external'); setError(null); }}>
                    <span className="pc-workflows-create__choice-inner"><DatabaseZap size={18} aria-hidden /><strong>External event</strong><span>Use a connected source and audited event pattern.</span><em>Creates an external binding</em></span>
                  </button>
                </div>

                {triggerKind === 'schedule' ? (
                  <div className="pc-workflows-create__form-grid">
                    <label className="pc-workflows-create__field">
                      <span>Frequency</span>
                      <Select
                        value={schedulePreset}
                        onChange={(value) => setSchedulePreset(value as SchedulePreset)}
                        ariaLabel="Frequency"
                        triggerClassName="pc-workflows-create__select"
                        options={Object.entries(SCHEDULE_PRESETS).map(([value, preset]) => ({ value, label: preset.label }))}
                      />
                    </label>
                    <label className="pc-workflows-create__field">
                      <span>Time zone</span>
                      <Select
                        value={tzid}
                        onChange={setTzid}
                        ariaLabel="Time zone"
                        triggerClassName="pc-workflows-create__select"
                        options={timeZones.map((value) => ({ value, label: value }))}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="pc-workflows-create__form-grid">
                    <label className="pc-workflows-create__field">
                      <span>Connected source</span>
                      <Select
                        value={sourceId}
                        onChange={(value) => {
                          setSourceId(value);
                          const next = connectedSources.find((source) => source.id === value);
                          if (next) setEventPattern(`ext:${next.kind}:`);
                        }}
                        ariaLabel="Connected source"
                        disabled={connectedSources.length === 0}
                        placeholder="No connected sources"
                        triggerClassName="pc-workflows-create__select"
                        options={connectedSources.map((source) => ({ value: source.id, label: `${source.kind} · ${source.status}` }))}
                      />
                    </label>
                    <label className="pc-workflows-create__field">
                      <span>Event pattern</span>
                      <input aria-label="Event pattern" value={eventPattern} onChange={(event) => setEventPattern(event.target.value)} required />
                    </label>
                    {connectedSources.length === 0 ? <p className="pc-workflows-create__empty-source">No connected external source is available. Connect one in Sources, or use a schedule.</p> : null}
                  </div>
                )}
              </section>

              <section aria-labelledby="create-automation-target-label">
                <div className="pc-workflows-create__step">2 · What runs?</div>
                <div className="pc-workflows-create__section-title" id="create-automation-target-label">
                  <strong>Action and target</strong><span>Choose a supported trigger action.</span>
                </div>
                <div className="pc-workflows-create__choice-grid pc-workflows-create__target-grid" role="group" aria-label="Workflow action">
                  <button
                    type="button"
                    data-target-kind="plan"
                    aria-pressed={targetKind === 'plan'}
                    onClick={() => chooseTarget('plan')}
                  >
                    <span className="pc-workflows-create__choice-inner"><CalendarClock size={18} aria-hidden /><strong>Launch an existing plan</strong><span>Run an existing plan or create one here.</span><em>Action: launch-plan</em></span>
                  </button>
                  <button
                    type="button"
                    data-target-kind="goal"
                    aria-pressed={targetKind === 'goal'}
                    onClick={() => chooseTarget('goal')}
                  >
                    <span className="pc-workflows-create__choice-inner"><Sparkles size={18} aria-hidden /><strong>Activate a goal</strong><span>Start the selected goal when an external event arrives.</span><em>Action: start-goal</em></span>
                  </button>
                  <button
                    type="button"
                    data-target-kind="email-work-item"
                    aria-pressed={targetKind === 'email-work-item'}
                    disabled={selectedSource?.kind !== 'gmail'}
                    onClick={() => chooseTarget('email-work-item')}
                  >
                    <span className="pc-workflows-create__choice-inner"><DatabaseZap size={18} aria-hidden /><strong>Create an Email work item</strong><span>Make the bounded Email draft proposal from Gmail.</span><em>Action: create-work-item</em></span>
                  </button>
                </div>
                <p className="pc-workflows-create__boundary-note" role="note">
                  Arbitrary tool-name dispatch is not available in the external-trigger engine yet. This popup exposes only the three actions the backend validates.
                </p>

                {targetKind === 'plan' ? (
                  <>
                    <div className="pc-workflows-create__plan-mode" role="group" aria-label="Plan choice" id="create-automation-plan-label">
                      <button type="button" aria-pressed={planMode === 'existing'} disabled={availablePlans.length === 0} onClick={() => { setPlanMode('existing'); setError(null); }}>Use an existing plan</button>
                      <button type="button" aria-pressed={planMode === 'new'} onClick={() => { setPlanMode('new'); setError(null); }}>Create the plan here</button>
                    </div>
                    {planMode === 'existing' ? (
                      <label className="pc-workflows-create__field is-full">
                        <span>Plan to run</span>
                        <SearchablePlanPicker
                          plans={availablePlans}
                          value={selectedPlanKey}
                          onChange={(value) => { setSelectedPlanKey(value); setError(null); }}
                          disabled={availablePlans.length === 0}
                        />
                      </label>
                    ) : createdPlan ? (
                      <div className="pc-workflows-create__created-plan" role="status">
                        <strong>Plan created</strong>
                        <span>{createdPlan.title} · {createdPlan.harness}</span>
                        <small>Retrying will reuse this plan rather than create a duplicate.</small>
                      </div>
                    ) : (
                      <div className="pc-workflows-create__new-plan-grid">
                        <label className="pc-workflows-create__field is-full">
                          <span>Workflow name</span>
                          <input aria-label="Workflow name" value={planName} maxLength={160} onChange={(event) => setPlanName(event.target.value)} placeholder="e.g. Summarize support escalations" required />
                        </label>
                        <label className="pc-workflows-create__field is-full">
                          <span>What should the plan produce?</span>
                          <input aria-label="What should the plan produce?" value={outcome} maxLength={500} onChange={(event) => setOutcome(event.target.value)} placeholder="Describe the concrete outcome" required />
                        </label>
                        <p className="pc-workflows-create__scope-note">
                          {defaultHarness ? <>The plan will be created in <strong>{defaultHarness}</strong>.</> : <>Select a pot in the workspace before creating a plan here.</>}
                        </p>
                      </div>
                    )}
                  </>
                ) : targetKind === 'goal' ? (
                  <div className="pc-workflows-create__target-detail">
                    <label className="pc-workflows-create__field is-full">
                      <span>Goal ID</span>
                      <input aria-label="Goal ID" value={goalId} maxLength={240} onChange={(event) => setGoalId(event.target.value)} placeholder="Paste the goal id to activate" required />
                    </label>
                    <p className="pc-workflows-create__scope-note">The external event will use <code>start-goal</code> to activate this existing goal. Schedules cannot target goals.</p>
                  </div>
                ) : (
                  <div className="pc-workflows-create__target-detail" role="status">
                    <strong>Gmail → Email draft proposal</strong>
                    <span>This creates the validated <code>email</code> / <code>email-draft-proposal</code> work item directly; no plan is required.</span>
                    {selectedSource?.kind !== 'gmail' ? <small>Connect or select Gmail above to enable this target.</small> : null}
                  </div>
                )}
              </section>

              <div className="pc-workflows-create__truth-note">
                <strong>Creation behavior:</strong> the trigger is authored, attached to the selected plan, and then armed. A partial failure is reported as saved or attached but not armed—never as success.
              </div>
              {error ? (
                <div className="pc-workflows-create__error" role="alert">
                  <div><strong>Couldn’t finish creating the workflow</strong><p>{error}</p></div>
                  {pendingArm ? <button type="button" disabled={submitting} onClick={() => void retryArm()}>Retry arming</button> : null}
                </div>
              ) : null}
            </div>

            <footer className="pc-workflows-create__foot">
              <span aria-live="polite">{step ?? 'The final action explicitly creates and arms the workflow.'}</span>
              <div>
                <button type="button" disabled={submitting} onClick={onClose}>Cancel</button>
                <button type="submit" className="pc-workflows-create__primary" disabled={submitting || !canSubmit}>
                  {submitting ? step ?? 'Working…' : 'Create & arm workflow'}
                </button>
              </div>
            </footer>
          </>
        )}
      </form>
    </Modal>
  );
}
