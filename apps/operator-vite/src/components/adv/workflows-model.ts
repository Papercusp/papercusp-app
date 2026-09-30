import type {
  AutomationCatalog,
  AutomationRoutine,
} from '@papercusp/operator-core/lib/automation/catalog';
import type {
  ExternalTriggerAdminSnapshot,
  ExternalTriggerBindingAdminRow,
} from '@papercusp/operator-core/lib/external-triggers/admin';

export type AutomationKind =
  | "triggered-plan"
  | "triggered-operation"
  | "ai-routine"
  | "system-task";
export type AutomationFilter = 'all' | 'triggered' | 'ai' | 'system' | 'paused';

export interface AutomationPlanRow {
  slug: string;
  title?: string;
  harness: string;
  status: string;
  nextAction?: string;
  startStatus?: string;
  maxImportance?: string;
  scheduled?: boolean;
  scheduleActive?: boolean;
  scheduleKind?: 'recurring' | 'one-shot';
  triggered?: boolean;
  triggerSources?: Array<'schedule' | 'external' | 'manual'>;
}

export interface AutomationScheduleRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  schedule: {
    kind?: string;
    rrule?: string;
    cron?: string;
    dtstart?: string;
    tzid?: string;
  } | null;
  scheduledAt: string | null;
  expiresAt: string | null;
  tzid: string | null;
  scheduleActive: boolean;
}

export interface AutomationOccurrenceRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  occurrenceMs: number;
  kind: 'recurring' | 'one-shot';
  scheduleActive: boolean;
  lastOutcome: string | null;
}

export interface AutomationTrigger {
  id: string;
  kind: 'schedule' | 'external';
  provider: string;
  label: string;
  detail: string;
  armed: boolean | null;
  bindingId?: string;
}

export interface AutomationFlowSummary {
  sourceLabel: string;
  sourceDetail: string;
  sourceState: 'ready' | 'paused' | 'needs-attention';
  planDetail: string;
  outcomeLabel: string;
  outcomeDetail: string;
  outcomeState: 'running' | 'completed' | 'failed' | 'waiting';
}

export type AutomationOperationTarget = NonNullable<
  ExternalTriggerAdminSnapshot["recentRuns"][number]["blueprintOperation"]
>["target"];

export interface AutomationOperation {
  harnessSlug: string;
  operationId: string;
  specificationRevision: string | null;
  target: AutomationOperationTarget | null;
}

export interface AutomationItem {
  id: string;
  kind: AutomationKind;
  label: string;
  description: string;
  harness: string | null;
  planSlug: string | null;
  operation: AutomationOperation | null;
  routine: AutomationRoutine | null;
  triggers: AutomationTrigger[];
  running: boolean;
  paused: boolean;
  needsAttention: boolean;
  nextAt: number | null;
  lastAt: number | null;
  timingLabel: string;
  spendLabel: string;
  flow: AutomationFlowSummary | null;
}

export interface AutomationActivityItem {
  id: string;
  automationId: string | null;
  label: string;
  detail: string;
  status: string;
  at: number;
  costUsd: number | null;
}

export interface AutomationSourceItem {
  id: string;
  kind: 'schedule' | 'external';
  label: string;
  status: string;
  detail: string;
  bindingCount: number;
  armedCount: number;
}

export interface BuildAutomationModelInput {
  catalog: AutomationCatalog | null;
  plans: readonly AutomationPlanRow[];
  schedules: readonly AutomationScheduleRow[];
  occurrences: readonly AutomationOccurrenceRow[];
  external: ExternalTriggerAdminSnapshot | null;
  nowMs?: number;
}

function planKey(harness: string, slug: string): string {
  return `${harness}:${slug}`;
}

function operationKey(harness: string, operationId: string): string {
  return `${harness}:${operationId}`;
}

function operationBindingTarget(
  binding: ExternalTriggerBindingAdminRow,
): { harnessSlug: string; operationId: string } | null {
  if (binding.action?.type !== "blueprint-operation") return null;
  const harnessSlug =
    typeof binding.action.operationHarnessSlug === "string"
      ? binding.action.operationHarnessSlug.trim()
      : "";
  const operationId =
    typeof binding.action.operationId === "string"
      ? binding.action.operationId.trim()
      : "";
  return harnessSlug && operationId ? { harnessSlug, operationId } : null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function relativeTime(value: number | null, nowMs = Date.now()): string {
  if (value == null) return 'No upcoming run';
  const delta = value - nowMs;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? 'in' : 'ago';
  if (abs < 60_000) return delta >= 0 ? 'now' : 'just now';
  const minutes = Math.max(1, Math.round(abs / 60_000));
  if (minutes < 90) return delta >= 0 ? `${suffix} ${minutes}m` : `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return delta >= 0 ? `${suffix} ${hours}h` : `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return delta >= 0 ? `${suffix} ${days}d` : `${days}d ${suffix}`;
}

function scheduleLabel(row: AutomationScheduleRow | undefined): string {
  if (!row) return 'Scheduled';
  if (row.scheduledAt) return `Once · ${new Date(row.scheduledAt).toLocaleString()}`;
  const raw = row.schedule?.rrule ?? row.schedule?.cron;
  if (!raw) return 'Recurring schedule';
  return raw.replace(/^RRULE:/i, '').replaceAll(';', ' · ');
}

function sourceForBinding(
  binding: ExternalTriggerBindingAdminRow,
  external: ExternalTriggerAdminSnapshot | null,
): AutomationTrigger {
  const source = external?.sources.find((candidate) => candidate.id === binding.sourceId);
  const provider = binding.sourceKind.replaceAll('-', ' ');
  return {
    id: `external:${binding.id}`,
    kind: 'external',
    provider,
    label: binding.eventPattern,
    detail: source
      ? `${source.status}${source.lastError ? ` · ${source.lastError}` : ''}`
      : binding.sourceStatus,
    armed: binding.armed,
    bindingId: binding.id,
  };
}

function planTriggers(
  plan: AutomationPlanRow,
  schedule: AutomationScheduleRow | undefined,
  bindings: readonly ExternalTriggerBindingAdminRow[],
  external: ExternalTriggerAdminSnapshot | null,
): AutomationTrigger[] {
  const sources = new Set(plan.triggerSources ?? []);
  const triggers: AutomationTrigger[] = [];
  if (sources.has('schedule') || schedule) {
    triggers.push({
      id: `schedule:${planKey(plan.harness, plan.slug)}`,
      kind: 'schedule',
      provider: 'schedule',
      label: scheduleLabel(schedule),
      detail: schedule?.tzid ?? schedule?.schedule?.tzid ?? 'Workspace time zone',
      armed: schedule?.scheduleActive ?? plan.scheduleActive ?? false,
    });
  }
  for (const binding of bindings) triggers.push(sourceForBinding(binding, external));
  return triggers;
}

function hasAutomaticPlanTrigger(
  plan: AutomationPlanRow,
  schedule: AutomationScheduleRow | undefined,
  bindings: readonly ExternalTriggerBindingAdminRow[],
): boolean {
  const sources = new Set(plan.triggerSources ?? []);
  return sources.has('schedule') || sources.has('external') || plan.scheduled === true || schedule != null || bindings.length > 0;
}

function routineSpendLabel(routine: AutomationRoutine): string {
  if (routine.spend === 'none') return '$0 model spend';
  if (routine.spend === 'unknown') return 'Spend classification unknown';
  return 'Model spend possible';
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll('-', ' ').trim();
  return normalized ? `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}` : normalized;
}

function flowSourceLabel(triggers: readonly AutomationTrigger[]): string {
  const providers = [...new Set(triggers.map((trigger) => sentenceCase(trigger.provider)))];
  if (providers.length === 0) return 'No installed trigger';
  if (providers.length <= 3) return providers.join(' + ');
  return `${providers.slice(0, 2).join(' + ')} + ${providers.length - 2} more`;
}

function planItem(
  plan: AutomationPlanRow,
  schedule: AutomationScheduleRow | undefined,
  occurrences: readonly AutomationOccurrenceRow[],
  bindings: readonly ExternalTriggerBindingAdminRow[],
  external: ExternalTriggerAdminSnapshot | null,
  nowMs: number,
): AutomationItem {
  const triggers = planTriggers(plan, schedule, bindings, external);
  const nextAt = occurrences
    .filter((row) => row.occurrenceMs >= nowMs)
    .reduce<number | null>((current, row) => current == null || row.occurrenceMs < current ? row.occurrenceMs : current, null);
  const bindingRuns = bindings.map((binding) => binding.lastRun).filter((run) => run != null);
  const lastAt = bindingRuns.reduce<number | null>((current, run) => {
    const value = parseTime(run.triggeredAt);
    return value != null && (current == null || value > current) ? value : current;
  }, null);
  const running = plan.startStatus === 'started' || bindingRuns.some((run) => run.status === 'running');
  const paused = triggers.length > 0 && triggers.every((trigger) => trigger.armed === false);
  const needsAttention =
    plan.maxImportance === 'urgent' ||
    bindingRuns.some((run) => run.status === 'failed' || Boolean(run.error));
  const latestBindingRun = bindingRuns.reduce<(typeof bindingRuns)[number] | null>((current, run) => {
    const at = parseTime(run.triggeredAt) ?? 0;
    const currentAt = current ? parseTime(current.triggeredAt) ?? 0 : -1;
    return at > currentAt ? run : current;
  }, null);
  const observedOutcome = latestBindingRun?.error
    ? 'failed'
    : latestBindingRun?.status ?? occurrences.find((row) => row.lastOutcome)?.lastOutcome ?? null;
  const automaticArmed = triggers.filter((trigger) => trigger.armed === true).length;
  const outcomeState: AutomationFlowSummary['outcomeState'] = running
    ? 'running'
    : observedOutcome === 'failed' || observedOutcome === 'error'
      ? 'failed'
      : observedOutcome
        ? 'completed'
        : 'waiting';
  return {
    id: `plan:${planKey(plan.harness, plan.slug)}`,
    kind: "triggered-plan",
    label: plan.title ?? plan.slug,
    description: plan.nextAction ?? `Triggered plan in ${plan.harness}`,
    harness: plan.harness,
    planSlug: plan.slug,
    operation: null,
    routine: null,
    triggers,
    running,
    paused,
    needsAttention,
    nextAt,
    lastAt,
    timingLabel: paused
      ? "Automatic triggers paused"
      : nextAt != null
        ? `Next ${relativeTime(nextAt, nowMs)}`
        : `${triggers.length} installed trigger${triggers.length === 1 ? "" : "s"}`,
    spendLabel: "Run-linked cost available in details",
    flow: {
      sourceLabel: flowSourceLabel(triggers),
      sourceDetail:
        triggers.length > 0
          ? `${automaticArmed}/${triggers.length} automatic armed`
          : "Automatic trigger details unavailable",
      sourceState: needsAttention
        ? "needs-attention"
        : paused
          ? "paused"
          : "ready",
      planDetail: `${plan.harness} · ${sentenceCase(plan.status)}`,
      outcomeLabel: plan.nextAction?.trim() || "No next action declared",
      outcomeDetail: running
        ? "Run in progress now"
        : observedOutcome
          ? `Last observed outcome · ${sentenceCase(observedOutcome)}`
          : "No observed run yet",
      outcomeState,
    },
  };
}

function targetOutcome(target: AutomationOperationTarget | null): {
  label: string;
  detail: string;
  state: AutomationFlowSummary["outcomeState"];
  running: boolean;
  failed: boolean;
} {
  if (!target) {
    return {
      label: "Awaiting first operation target",
      detail: "No accepted operation run yet",
      state: "waiting",
      running: false,
      failed: false,
    };
  }
  if (target.kind === "work-item") {
    const status = target.status ?? "status unavailable";
    const completed = ["done", "passed", "resolved"].includes(status);
    const failed = ["failed", "dropped", "deprecated", "closed"].includes(
      status,
    );
    return {
      label: `Work item ${target.id}`,
      detail: sentenceCase(status),
      state: failed ? "failed" : completed ? "completed" : "running",
      running: !completed && !failed && target.status != null,
      failed,
    };
  }
  const status = target.status ?? "status unavailable";
  const failed =
    status === "failed" ||
    (status === "done" &&
      target.outcome != null &&
      target.outcome !== "success");
  const completed = status === "done" && !failed;
  return {
    label: `Plan ${target.instanceSlug}`,
    detail: target.outcome
      ? `${sentenceCase(status)} · ${sentenceCase(target.outcome)}`
      : sentenceCase(status),
    state: failed
      ? "failed"
      : completed
        ? "completed"
        : target.status
          ? "running"
          : "waiting",
    running: !completed && !failed && target.status != null,
    failed,
  };
}

function operationItem(
  target: { harnessSlug: string; operationId: string },
  bindings: readonly ExternalTriggerBindingAdminRow[],
  external: ExternalTriggerAdminSnapshot | null,
): AutomationItem {
  const triggers = bindings.map((binding) =>
    sourceForBinding(binding, external),
  );
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const runs = (external?.recentRuns ?? [])
    .filter((run) => bindingIds.has(run.bindingId))
    .filter(
      (run) =>
        run.blueprintOperation?.harnessSlug === target.harnessSlug &&
        run.blueprintOperation.operationId === target.operationId,
    )
    .sort(
      (left, right) =>
        (parseTime(right.triggeredAt) ?? 0) -
        (parseTime(left.triggeredAt) ?? 0),
    );
  const latest = runs[0] ?? null;
  const operation = latest?.blueprintOperation ?? null;
  const outcome = targetOutcome(operation?.target ?? null);
  const triggerFailed = latest?.status === "failed" || Boolean(latest?.error);
  const paused =
    triggers.length > 0 && triggers.every((trigger) => trigger.armed === false);
  const automaticArmed = triggers.filter(
    (trigger) => trigger.armed === true,
  ).length;
  return {
    id: `operation:${operationKey(target.harnessSlug, target.operationId)}`,
    kind: "triggered-operation",
    label: target.operationId,
    description: `Registered blueprint operation in ${target.harnessSlug}`,
    harness: target.harnessSlug,
    planSlug: null,
    operation: {
      harnessSlug: target.harnessSlug,
      operationId: target.operationId,
      specificationRevision: operation?.specificationRevision ?? null,
      target: operation?.target ?? null,
    },
    routine: null,
    triggers,
    running: latest?.status === "running" || outcome.running,
    paused,
    needsAttention: triggerFailed || outcome.failed,
    nextAt: null,
    lastAt: latest ? parseTime(latest.triggeredAt) : null,
    timingLabel: paused
      ? "Automatic triggers paused"
      : `${triggers.length} installed trigger${triggers.length === 1 ? "" : "s"}`,
    spendLabel: "Run-linked cost available in details",
    flow: {
      sourceLabel: flowSourceLabel(triggers),
      sourceDetail: `${automaticArmed}/${triggers.length} automatic armed`,
      sourceState:
        triggerFailed || outcome.failed
          ? "needs-attention"
          : paused
            ? "paused"
            : "ready",
      planDetail: `${target.harnessSlug} · blueprint operation`,
      outcomeLabel: outcome.label,
      outcomeDetail: operation?.specificationRevision
        ? `${outcome.detail} · spec ${operation.specificationRevision.slice(0, 8)}`
        : outcome.detail,
      outcomeState: triggerFailed ? "failed" : outcome.state,
    },
  };
}

function routineItem(routine: AutomationRoutine, nowMs: number): AutomationItem {
  const nextAt = parseTime(routine.nextFireAt);
  const lastAt = parseTime(routine.lastFiredAt);
  const kind: AutomationKind = routine.spend === 'none' ? 'system-task' : 'ai-routine';
  return {
    id: `routine:${routine.name}:${routine.installSlug}`,
    kind,
    label: routine.name,
    description: routine.controlWhy,
    harness: routine.installSlug || null,
    planSlug: null,
    operation: null,
    routine,
    triggers: [
      {
        id: `routine-trigger:${routine.name}:${routine.installSlug}`,
        kind: routine.kind === "triggered" ? "external" : "schedule",
        provider: routine.source,
        label: routine.triggerLabel ?? routine.cadence ?? "Event-driven",
        detail: routine.controlWhy,
        armed:
          routine.armedState === "unknown"
            ? null
            : routine.armedState === "armed",
      },
    ],
    running: routine.liveness === "running",
    paused: routine.armedState === "disarmed" || !routine.active,
    needsAttention: routine.needsAttention,
    nextAt,
    lastAt,
    timingLabel:
      routine.liveness === "stalled"
        ? `Stalled · last ${relativeTime(lastAt, nowMs)}`
        : nextAt != null
          ? `Next ${relativeTime(nextAt, nowMs)}`
          : (routine.triggerLabel ?? routine.cadence ?? "Event-driven"),
    spendLabel: routineSpendLabel(routine),
    flow: null,
  };
}

export function buildAutomationFlows(items: readonly AutomationItem[]): AutomationItem[] {
  return items.filter(
    (item) =>
      (item.kind === "triggered-plan" || item.kind === "triggered-operation") &&
      item.flow != null,
  );
}

export function nextFutureAutomationAt(items: readonly AutomationItem[], nowMs = Date.now()): number | null {
  return items.reduce<number | null>((current, item) => {
    if (item.nextAt == null || item.nextAt < nowMs) return current;
    return current == null || item.nextAt < current ? item.nextAt : current;
  }, null);
}

export function buildAutomationItems(input: BuildAutomationModelInput): AutomationItem[] {
  const nowMs = input.nowMs ?? Date.now();
  const schedules = new Map(input.schedules.map((row) => [planKey(row.harnessSlug, row.templateSlug), row]));
  const occurrences = new Map<string, AutomationOccurrenceRow[]>();
  for (const row of input.occurrences) {
    const key = planKey(row.harnessSlug, row.templateSlug);
    const group = occurrences.get(key) ?? [];
    group.push(row);
    occurrences.set(key, group);
  }
  const bindings = new Map<string, ExternalTriggerBindingAdminRow[]>();
  const operationBindings = new Map<
    string,
    {
      target: { harnessSlug: string; operationId: string };
      bindings: ExternalTriggerBindingAdminRow[];
    }
  >();
  for (const row of input.external?.bindings ?? []) {
    const operation = operationBindingTarget(row);
    if (operation) {
      const key = operationKey(operation.harnessSlug, operation.operationId);
      const group = operationBindings.get(key) ?? {
        target: operation,
        bindings: [],
      };
      group.bindings.push(row);
      operationBindings.set(key, group);
      continue;
    }
    // Goal/direct-item bindings have no plan or operation key. They remain
    // visible in the global trigger ledger and activity feed.
    if (!row.planHarnessSlug || !row.planSlug) continue;
    const key = planKey(row.planHarnessSlug, row.planSlug);
    const group = bindings.get(key) ?? [];
    group.push(row);
    bindings.set(key, group);
  }

  const items: AutomationItem[] = [];
  for (const plan of input.plans) {
    const key = planKey(plan.harness, plan.slug);
    const schedule = schedules.get(key);
    const planBindings = bindings.get(key) ?? [];
    if (!hasAutomaticPlanTrigger(plan, schedule, planBindings)) continue;
    items.push(planItem(
      plan,
      schedule,
      occurrences.get(key) ?? [],
      planBindings,
      input.external,
      nowMs,
    ));
  }
  for (const group of operationBindings.values()) {
    items.push(operationItem(group.target, group.bindings, input.external));
  }
  for (const routine of input.catalog?.routines ?? []) items.push(routineItem(routine, nowMs));

  return items.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    if ((a.nextAt ?? Infinity) !== (b.nextAt ?? Infinity)) return (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity);
    return a.label.localeCompare(b.label);
  });
}

export function filterAutomationItems(
  items: readonly AutomationItem[],
  filter: AutomationFilter,
  query: string,
): AutomationItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (
      filter === "triggered" &&
      item.kind !== "triggered-plan" &&
      item.kind !== "triggered-operation"
    )
      return false;
    if (filter === 'ai' && item.kind !== 'ai-routine') return false;
    if (filter === 'system' && item.kind !== 'system-task') return false;
    if (filter === 'paused' && !item.paused) return false;
    if (!needle) return true;
    return [item.label, item.description, item.harness, item.planSlug, ...item.triggers.flatMap((trigger) => [trigger.provider, trigger.label])]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}

export function buildAutomationActivity(input: BuildAutomationModelInput): AutomationActivityItem[] {
  const items: AutomationActivityItem[] = [];
  for (const run of input.external?.recentRuns ?? []) {
    const operation = run.blueprintOperation;
    const operationLabel = operation
      ? `${operation.harnessSlug}#${operation.operationId}`
      : null;
    items.push({
      id: `external-run:${run.id}`,
      automationId:
        run.planHarnessSlug && run.planSlug
          ? `plan:${planKey(run.planHarnessSlug, run.planSlug)}`
          : operation
            ? `operation:${operationKey(operation.harnessSlug, operation.operationId)}`
            : null,
      label: `${operationLabel ?? run.planSlug ?? run.workItemKind ?? run.goalId ?? "automation"} · ${run.sourceKind}`,
      detail: run.error ?? run.eventPattern,
      status: run.status,
      at: parseTime(run.triggeredAt) ?? 0,
      costUsd: null,
    });
  }
  for (const routine of input.catalog?.routines ?? []) {
    const at = parseTime(routine.lastFiredAt);
    if (at == null) continue;
    items.push({
      id: `routine-run:${routine.name}:${routine.installSlug}:${at}`,
      automationId: `routine:${routine.name}:${routine.installSlug}`,
      label: routine.name,
      detail: `${routine.source} · ${routine.cadence ?? routine.triggerLabel ?? 'event-driven'}`,
      status: routine.needsAttention ? 'needs attention' : routine.liveness,
      at,
      costUsd: null,
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

export function buildAutomationSources(input: BuildAutomationModelInput): AutomationSourceItem[] {
  const scheduled = new Map<string, boolean>();
  for (const plan of input.plans) {
    if (plan.triggerSources?.includes('schedule') || plan.scheduled) {
      scheduled.set(planKey(plan.harness, plan.slug), plan.scheduleActive === true);
    }
  }
  for (const schedule of input.schedules) {
    const key = planKey(schedule.harnessSlug, schedule.templateSlug);
    scheduled.set(key, scheduled.get(key) === true || schedule.scheduleActive);
  }
  const armedSchedules = [...scheduled.values()].filter(Boolean).length;
  const result: AutomationSourceItem[] = [
    {
      id: 'source:schedule',
      kind: 'schedule',
      label: 'Schedule',
      status: `${armedSchedules} armed`,
      detail: 'Recurring and one-shot plan schedules',
      bindingCount: scheduled.size,
      armedCount: armedSchedules,
    },
  ];
  for (const source of input.external?.sources ?? []) {
    result.push({
      id: `source:${source.id}`,
      kind: 'external',
      label: source.kind.replaceAll('-', ' '),
      status: source.status,
      detail: source.lastError ?? (source.lastConnectedAt ? `Last connected ${new Date(source.lastConnectedAt).toLocaleString()}` : 'Not connected yet'),
      bindingCount: source.bindingCount,
      armedCount: source.armedBindingCount,
    });
  }
  return result;
}
