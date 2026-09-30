'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/app/harness/Modal';
import { Select } from '@/app/harness/Select';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import type {
  ExternalTriggerBindingAdminRow,
  ExternalTriggerSocialAdminFacts,
  ExternalTriggerSourceAdminRow,
} from '@papercusp/operator-core/lib/external-triggers/admin';
import {
  TriggerBindingCard,
  formatTriggerTime,
} from '../triggers/TriggerBindingCard';
import {
  fetchTriggerAdminSnapshot,
  patchTriggerAdmin,
  type PlanTriggerAdminResponse,
} from '../triggers/trigger-admin-api';
import PlanInputsPanel from './PlanInputsPanel';
import {
  armPlanSchedule,
  authorPlanSchedule,
  clearPlanTemplateTrigger,
  disarmPlanSchedule,
  isPlanStartRefusal,
  setPlanInputSchema,
  startPlan,
  type JsonSchemaObject,
  type PlanScheduleSpec,
  type PlanTriggerMutationResult,
} from './plans-api';
import '../triggers/triggers.css';

type Composer = 'schedule' | 'external' | 'manual-schema' | 'manual-start' | null;

function mutationError(result: PlanTriggerMutationResult): string | null {
  if (result.error) return result.detail ?? result.error;
  const failed = result.results?.find((row) => row.ok !== true);
  return failed ? failed.detail ?? failed.error ?? 'mutation failed' : null;
}

function scheduleLabel(plan: NonNullable<PlanTriggerAdminResponse['plan']>): string {
  if (plan.scheduledAt && !plan.schedule) return `once · ${formatTriggerTime(plan.scheduledAt)}`;
  if (plan.schedule?.kind === 'cron') return `cron · ${plan.schedule.cron ?? 'unset'}`;
  if (plan.schedule?.kind === 'rrule') return `RRULE · ${plan.schedule.rrule ?? 'unset'}`;
  return 'not installed';
}

function schedulePolicy(plan: NonNullable<PlanTriggerAdminResponse['plan']>): string {
  const schedule = plan.schedule;
  if (!schedule) return 'one-shot';
  const parts = [
    `overlap ${schedule.concurrency ?? 'skip'}`,
    `catch-up ${schedule.catchup ?? 'skip-old'}`,
  ];
  if (typeof schedule.costCapCents === 'number') parts.push(`cap $${(schedule.costCapCents / 100).toFixed(2)}`);
  if (schedule.operation) parts.push(`target ${schedule.operation.harnessSlug}#${schedule.operation.operationId}`);
  return parts.join(' · ');
}

export default function PlanTriggersPanel({
  slug,
  harnessSlug,
}: {
  slug: string;
  harnessSlug?: string | null;
}) {
  const harness = harnessSlug ?? 'papercusp';
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [payload, setPayload] = useState<PlanTriggerAdminResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer>(null);
  const [inputsRefresh, setInputsRefresh] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await fetchTriggerAdminSnapshot({
        planSlug: slug,
        planHarnessSlug: harness,
        signal,
      });
      setPayload(next);
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [harness, slug]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const bindings = useMemo(
    () =>
      (payload?.bindings ?? []).filter(
        (binding) => binding.planSlug === slug && binding.planHarnessSlug === harness,
      ),
    [harness, payload?.bindings, slug],
  );
  const plan = payload?.plan;

  const setExternalArmed = useCallback(async (
    binding: ExternalTriggerBindingAdminRow,
    armed: boolean,
  ) => {
    const verb = armed ? 'Arm' : 'Disarm';
    if (!(await askConfirm({
      title: `${verb} ${binding.eventPattern}?`,
      body: armed
        ? 'Matching events may immediately start this plan.'
        : 'Matching events will stop starting this plan until it is armed again.',
      confirmLabel: verb,
      destructive: armed,
    }))) return;
    setBusy(`external:${binding.id}`);
    try {
      await patchTriggerAdmin({ op: 'set-armed', id: binding.id, armed, confirm: true });
      toast.success(`${binding.eventPattern} ${armed ? 'armed' : 'disarmed'}`);
      await load();
    } catch (cause) {
      toast.error(`${verb} failed`, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }, [askConfirm, load]);

  const detachExternal = useCallback(async (binding: ExternalTriggerBindingAdminRow) => {
    if (!(await askConfirm({
      title: `Detach ${binding.eventPattern}?`,
      body: 'The binding will be disarmed and removed from this plan. Existing run history is retained.',
      confirmLabel: 'Detach',
      destructive: true,
    }))) return;
    setBusy(`external:${binding.id}`);
    try {
      await patchTriggerAdmin({ op: 'detach-external', id: binding.id, confirm: true });
      toast.success('External trigger detached');
      await load();
    } catch (cause) {
      toast.error('Detach failed', { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }, [askConfirm, load]);

  const setScheduleArmed = useCallback(async (armed: boolean) => {
    if (!plan) return;
    const verb = armed ? 'Arm' : 'Disarm';
    if (!(await askConfirm({
      title: `${verb} schedule?`,
      body: armed
        ? 'The next occurrence may start this plan without another prompt.'
        : 'The authored schedule is kept, but no occurrences will fire.',
      confirmLabel: verb,
      destructive: armed,
    }))) return;
    setBusy('schedule');
    try {
      const result = armed
        ? await armPlanSchedule(slug, harness)
        : await disarmPlanSchedule(slug, harness);
      const err = mutationError(result);
      if (err) throw new Error(err);
      toast.success(`Schedule ${armed ? 'armed' : 'disarmed'}`);
      await load();
    } catch (cause) {
      toast.error(`${verb} failed`, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }, [askConfirm, harness, load, plan, slug]);

  const detachSchedule = useCallback(async () => {
    if (!(await askConfirm({
      title: 'Detach schedule?',
      body: 'The authored cadence and its materialized routine will be removed. Prior run history is retained.',
      confirmLabel: 'Detach',
      destructive: true,
    }))) return;
    setBusy('schedule');
    try {
      const result = await authorPlanSchedule(
        slug,
        { schedule: null, scheduledAt: null, expiresAt: null, tzid: null },
        harness,
      );
      const err = mutationError(result);
      if (err) throw new Error(err);
      toast.success('Schedule detached');
      await load();
    } catch (cause) {
      toast.error('Detach failed', { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }, [askConfirm, harness, load, slug]);

  const detachManual = useCallback(async () => {
    if (!plan?.manualSource) return;
    if (!(await askConfirm({
      title: 'Detach manual trigger?',
      body: plan.manualSource === 'template'
        ? 'The plan template type will be cleared. Stored values remain, but the manual-start contract is removed.'
        : 'The plan input schema will be cleared. Stored values remain, but the manual-start contract is removed.',
      confirmLabel: 'Detach',
      destructive: true,
    }))) return;
    setBusy('manual');
    try {
      const result = plan.manualSource === 'template'
        ? await clearPlanTemplateTrigger(slug, harness)
        : await setPlanInputSchema(slug, null, harness);
      const err = mutationError(result);
      if (err) throw new Error(err);
      toast.success('Manual trigger detached');
      await load();
    } catch (cause) {
      toast.error('Detach failed', { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  }, [askConfirm, harness, load, plan?.manualSource, slug]);

  if (loading) return <div className="pc-plan-triggers__state" role="status">Loading triggers…</div>;
  if (error) {
    return (
      <div className="pc-plan-triggers__state pc-plan-triggers__state--error" role="alert">
        <span>Trigger data could not be loaded: {error}</span>
        <button type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (!payload?.enabled || !plan) {
    return <div className="pc-plan-triggers__state">Trigger administration is unavailable.</div>;
  }

  const hasSchedule = plan.schedule !== null || plan.scheduledAt !== null;
  return (
    <section className="pc-plan-triggers" aria-labelledby="pc-plan-triggers-title">
      {confirmEl}
      <header className="pc-plan-triggers__head">
        <div>
          <span className="tr-kicker">Triggered plan</span>
          <h3 id="pc-plan-triggers-title">Triggers</h3>
          <p>Attach sources first, then arm only the ones that should fire unattended.</p>
        </div>
        <button type="button" className="tr-button tr-button-secondary" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      <section className="pc-plan-triggers__group" aria-labelledby="pc-trigger-schedule-h">
        <div className="pc-plan-triggers__group-head">
          <h4 id="pc-trigger-schedule-h">Schedule</h4>
          {!hasSchedule ? <button type="button" className="tr-button" onClick={() => setComposer('schedule')}>Attach schedule</button> : null}
        </div>
        {hasSchedule ? (
          <article className={`tr-card${plan.scheduleActive ? '' : ' muted'}`}>
            <div className="tr-card-main">
              <div className="tr-card-heading">
                <strong>{scheduleLabel(plan)}</strong>
                <span className="tr-badge">schedule</span>
              </div>
              <div className="tr-meta">policy: {schedulePolicy(plan)}</div>
              <div className="tr-meta">last fire: {formatTriggerTime(plan.lastFire)}</div>
              <div className="tr-meta">next fire: {formatTriggerTime(plan.nextFire)}</div>
            </div>
            <div className="tr-card-actions">
              <button
                type="button"
                role="switch"
                aria-checked={plan.scheduleActive}
                aria-label={`${plan.scheduleActive ? 'Disarm' : 'Arm'} schedule`}
                className={`tr-switch${plan.scheduleActive ? ' on' : ''}`}
                disabled={busy !== null}
                onClick={() => void setScheduleArmed(!plan.scheduleActive)}
              ><span /></button>
              <strong className={plan.scheduleActive ? 'tr-good' : ''}>{plan.scheduleActive ? 'Armed' : 'Off'}</strong>
              <button type="button" className="tr-link" onClick={() => setComposer('schedule')}>Edit</button>
              <button type="button" className="tr-link tr-link-danger" disabled={busy !== null} onClick={() => void detachSchedule()}>Detach</button>
            </div>
          </article>
        ) : <EmptyTrigger source="schedule" />}
      </section>

      <section className="pc-plan-triggers__group" aria-labelledby="pc-trigger-external-h">
        <div className="pc-plan-triggers__group-head">
          <h4 id="pc-trigger-external-h">External events</h4>
          <button type="button" className="tr-button" disabled={payload.sources.length === 0} onClick={() => setComposer('external')}>Attach event</button>
        </div>
        {bindings.length > 0 ? bindings.map((binding) => (
          <TriggerBindingCard
            key={binding.id}
            binding={binding}
            busy={busy !== null}
            showPlan={false}
            onSetArmed={(row, armed) => void setExternalArmed(row, armed)}
            onDetach={(row) => void detachExternal(row)}
          />
        )) : <EmptyTrigger source={payload.sources.length ? 'external event' : 'external event (connect a source first)'} />}
      </section>

      <section className="pc-plan-triggers__group" aria-labelledby="pc-trigger-manual-h">
        <div className="pc-plan-triggers__group-head">
          <h4 id="pc-trigger-manual-h">Manual</h4>
          {!plan.manualSource ? <button type="button" className="tr-button" onClick={() => setComposer('manual-schema')}>Attach manual</button> : null}
        </div>
        {plan.manualSource ? (
          <article className="tr-card">
            <div className="tr-card-main">
              <div className="tr-card-heading">
                <strong>Start with declared inputs</strong>
                <span className="tr-badge">manual</span>
                <span className="tr-badge status-connected">available</span>
              </div>
              <div className="tr-meta">schema source: {plan.manualSource}</div>
              <div className="tr-meta">arguments are validated by the existing plan-inputs start gate</div>
            </div>
            <div className="tr-card-actions">
              <button type="button" className="tr-button" onClick={() => setComposer('manual-start')}>Start manually</button>
              <button type="button" className="tr-link tr-link-danger" disabled={busy !== null} onClick={() => void detachManual()}>Detach</button>
            </div>
          </article>
        ) : <EmptyTrigger source="manual" />}
      </section>

      <ScheduleComposer
        open={composer === 'schedule'}
        existing={plan.schedule}
        scheduledAt={plan.scheduledAt}
        harness={harness}
        slug={slug}
        onClose={() => setComposer(null)}
        onSaved={async () => { setComposer(null); await load(); }}
      />
      <ExternalComposer
        open={composer === 'external'}
        sources={payload.sources}
        harness={harness}
        slug={slug}
        onClose={() => setComposer(null)}
        onSaved={async () => { setComposer(null); await load(); }}
      />
      <ManualSchemaComposer
        open={composer === 'manual-schema'}
        harness={harness}
        slug={slug}
        onClose={() => setComposer(null)}
        onSaved={async () => { setComposer(null); await load(); }}
      />
      <ManualStartComposer
        open={composer === 'manual-start'}
        harness={harness}
        slug={slug}
        refreshToken={inputsRefresh}
        onInputsSaved={() => setInputsRefresh((n) => n + 1)}
        onClose={() => setComposer(null)}
      />
    </section>
  );
}

function EmptyTrigger({ source }: { source: string }) {
  return <div className="pc-plan-triggers__empty">No {source} trigger attached.</div>;
}

function ScheduleComposer({
  open, existing, scheduledAt, harness, slug, onClose, onSaved,
}: {
  open: boolean;
  existing: PlanScheduleSpec | null;
  scheduledAt: string | null;
  harness: string;
  slug: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initialKind = scheduledAt && !existing ? 'one-shot' : existing?.kind ?? 'cron';
  const [kind, setKind] = useState<'cron' | 'rrule' | 'one-shot'>(initialKind);
  const [expression, setExpression] = useState(existing?.cron ?? existing?.rrule ?? '0 9 * * 1-5');
  const [oneShot, setOneShot] = useState(scheduledAt ? scheduledAt.slice(0, 16) : '');
  const [tzid, setTzid] = useState(existing?.tzid ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [concurrency, setConcurrency] = useState<'queue' | 'skip' | 'cancel-prev'>(existing?.concurrency ?? 'skip');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(scheduledAt && !existing ? 'one-shot' : existing?.kind ?? 'cron');
    setExpression(existing?.cron ?? existing?.rrule ?? '0 9 * * 1-5');
    setOneShot(scheduledAt ? scheduledAt.slice(0, 16) : '');
    setTzid(existing?.tzid ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    setConcurrency(existing?.concurrency ?? 'skip');
    setError(null);
  }, [existing, open, scheduledAt]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const schedule: PlanScheduleSpec | null = kind === 'one-shot' ? null : {
        kind,
        ...(kind === 'cron' ? { cron: expression.trim() } : { rrule: expression.trim() }),
        tzid: tzid.trim() || undefined,
        concurrency,
        catchup: 'skip-old',
        ...(existing?.operation ? { operation: existing.operation } : {}),
      };
      const result = await authorPlanSchedule(slug, {
        schedule,
        scheduledAt: kind === 'one-shot' ? new Date(oneShot).toISOString() : null,
        tzid: tzid.trim() || null,
      }, harness);
      const err = mutationError(result);
      if (err) throw new Error(err);
      toast.success('Schedule saved off — arm it when ready');
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()} title="Attach schedule" srOnlyTitle contentClassName="pc-plan-dialog">
      <form className="pc-plan-dialog__form" onSubmit={submit}>
        <header className="pc-plan-dialog__head"><h3>Schedule trigger</h3><p>Saving installs the cadence off. Arming is a separate confirmation.</p></header>
        <label className="pc-plan-dialog__field">
          <span>Kind</span>
          <Select
            value={kind}
            onChange={(value) => setKind(value as typeof kind)}
            ariaLabel="Kind"
            options={[
              { value: 'cron', label: 'Cron' },
              { value: 'rrule', label: 'RRULE' },
              { value: 'one-shot', label: 'One shot' },
            ]}
          />
        </label>
        {kind === 'one-shot' ? (
          <label className="pc-plan-dialog__field"><span>Fire at</span><input type="datetime-local" value={oneShot} onChange={(event) => setOneShot(event.target.value)} required /></label>
        ) : (
          <label className="pc-plan-dialog__field"><span>{kind === 'cron' ? 'Cron expression' : 'RRULE'}</span><input value={expression} onChange={(event) => setExpression(event.target.value)} required /></label>
        )}
        <label className="pc-plan-dialog__field"><span>Timezone</span><input value={tzid} onChange={(event) => setTzid(event.target.value)} /></label>
        {kind !== 'one-shot' ? (
          <label className="pc-plan-dialog__field">
            <span>Overlap policy</span>
            <Select
              value={concurrency}
              onChange={(value) => setConcurrency(value as typeof concurrency)}
              ariaLabel="Overlap policy"
              options={[
                { value: 'skip', label: 'Skip while running' },
                { value: 'queue', label: 'Queue' },
                { value: 'cancel-prev', label: 'Cancel prior' },
              ]}
            />
          </label>
        ) : null}
        <ComposerFooter error={error} submitting={submitting} submitLabel="Save schedule" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function ExternalComposer({
  open, sources, harness, slug, onClose, onSaved,
}: {
  open: boolean;
  sources: ExternalTriggerSourceAdminRow[];
  harness: string;
  slug: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0];
  const [pattern, setPattern] = useState(source ? `ext:${source.kind}:` : '');
  const [filter, setFilter] = useState('{}');
  const [maxRuns, setMaxRuns] = useState('');
  const [windowSeconds, setWindowSeconds] = useState('60');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = sources[0];
    setSourceId(first?.id ?? '');
    setPattern(first ? `ext:${first.kind}:` : '');
    setFilter('{}');
    const defaults = stormDefaultsFor(first);
    setMaxRuns(defaults.maxRuns);
    setWindowSeconds(defaults.windowSeconds);
    setError(null);
  }, [open, sources]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const parsedFilter = JSON.parse(filter) as unknown;
      if (!parsedFilter || Array.isArray(parsedFilter) || typeof parsedFilter !== 'object') throw new Error('Event filter must be a JSON object');
      await patchTriggerAdmin({
        op: 'attach-external',
        sourceId,
        planHarnessSlug: harness,
        planSlug: slug,
        eventPattern: pattern.trim(),
        eventFilter: parsedFilter,
        maxRuns: maxRuns.trim() ? Number(maxRuns) : null,
        windowSeconds: Number(windowSeconds),
      });
      toast.success('External trigger installed off — arm it when ready');
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()} title="Attach external event" srOnlyTitle contentClassName="pc-plan-dialog">
      <form className="pc-plan-dialog__form" onSubmit={submit}>
        <header className="pc-plan-dialog__head"><h3>External event trigger</h3><p>Choose an existing source. New bindings are always installed off.</p></header>
        <label className="pc-plan-dialog__field">
          <span>Source</span>
          <Select
            value={sourceId}
            onChange={(id) => {
              const selected = sources.find((candidate) => candidate.id === id);
              setSourceId(id);
              if (selected) {
                setPattern(`ext:${selected.kind}:`);
                const defaults = stormDefaultsFor(selected);
                setMaxRuns(defaults.maxRuns);
                setWindowSeconds(defaults.windowSeconds);
              }
            }}
            ariaLabel="Source"
            options={sources.map((candidate) => ({
              value: candidate.id,
              label: `${candidate.kind} · ${candidate.status}`,
            }))}
          />
        </label>
        {source?.social && <SocialSourceNote social={source.social} />}
        <label className="pc-plan-dialog__field"><span>Event pattern</span><input value={pattern} onChange={(event) => setPattern(event.target.value)} required /></label>
        <label className="pc-plan-dialog__field"><span>Event filter</span><textarea rows={4} value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <label className="pc-plan-dialog__field"><span>Storm max runs <em className="pc-plan-dialog__opt">(blank = this source&rsquo;s safe default; never unbounded)</em></span><input type="number" min="1" value={maxRuns} onChange={(event) => setMaxRuns(event.target.value)} /></label>
        <label className="pc-plan-dialog__field"><span>Storm window seconds</span><input type="number" min="1" value={windowSeconds} onChange={(event) => setWindowSeconds(event.target.value)} required /></label>
        <ComposerFooter error={error} submitting={submitting} submitLabel="Attach off" onCancel={onClose} />
      </form>
    </Modal>
  );
}

/**
 * Storm-policy defaults for a newly attached binding (P-027).
 *
 * A social source gets the cap its PLATFORM budget actually funds, rather than
 * the generic default. That generic one is the wrong cap here in a way that is
 * invisible until it bites: a too-loose coalesce cap on a metered platform
 * spends the whole quota day on one storm, and the integration then stops
 * entirely until the quota rolls over.
 *
 * Blank no longer means UNBOUNDED. Until 2026-08-26 it did, and leaving that
 * field blank is how a live Gmail binding came to hold a rate window with no
 * cap and mint 228 autonomous plan runs in 68s when a poller closed a resync
 * gap (EI-21500982767775449). Blank now means "let the source decide": the
 * server sends no storm policy at all, so a social source gets its per-platform
 * coalesce-with-cap default and everything else gets the engine's bounded
 * floor (DEFAULT_STORM_MAX_RUNS). Keep the field blank rather than typing a
 * number you do not have a reason for.
 */
export function stormDefaultsFor(
  source: ExternalTriggerSourceAdminRow | undefined,
): { maxRuns: string; windowSeconds: string } {
  if (!source?.social) return { maxRuns: '', windowSeconds: '60' };
  return {
    maxRuns: String(source.social.rateBudget.maxRuns),
    windowSeconds: String(source.social.rateBudget.windowSeconds),
  };
}

/**
 * The constraints that decide whether arming this binding can actually work.
 *
 * Shown at the moment of ATTACHING, because that is when the owner is choosing
 * — a wall discovered later, from a failed run, costs far more than a line here.
 */
function SocialSourceNote({ social }: { social: ExternalTriggerSocialAdminFacts }) {
  return (
    <div className="pc-plan-dialog__note" data-platform={social.platformId}>
      <div>
        <strong>{social.label}</strong> · wave {social.wave} · {social.authMode}
      </div>
      {social.blockedOn && (
        <div className="pc-plan-dialog__warn">
          Blocked on {social.blockedOn} — bindings can be attached, but this source cannot
          connect until that clears.
        </div>
      )}
      {!social.writeVerified && (
        <div className="pc-plan-dialog__warn">
          Write path unverified — a reply/post action on this source is refused at run time.
          Read-only triggers still work.
        </div>
      )}
      <div>
        Storm defaults set from this platform&rsquo;s rate budget:{' '}
        {social.rateBudget.maxRuns} run{social.rateBudget.maxRuns === 1 ? '' : 's'} /{' '}
        {social.rateBudget.windowSeconds}s ({social.rateBudget.basis}). Raising them past the
        budget spends the quota day early.
      </div>
    </div>
  );
}

function ManualSchemaComposer({ open, harness, slug, onClose, onSaved }: {
  open: boolean;
  harness: string;
  slug: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [schema, setSchema] = useState('{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const parsed = JSON.parse(schema) as JsonSchemaObject;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Input schema must be a JSON object');
      const result = await setPlanInputSchema(slug, parsed, harness);
      const err = mutationError(result);
      if (err) throw new Error(err);
      toast.success('Manual trigger attached');
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()} title="Attach manual trigger" srOnlyTitle contentClassName="pc-plan-dialog">
      <form className="pc-plan-dialog__form" onSubmit={submit}>
        <header className="pc-plan-dialog__head"><h3>Manual trigger inputs</h3><p>Declare the arguments the start dialog will render and validate.</p></header>
        <label className="pc-plan-dialog__field"><span>JSON Schema</span><textarea rows={12} value={schema} onChange={(event) => setSchema(event.target.value)} /></label>
        <ComposerFooter error={error} submitting={submitting} submitLabel="Attach manual" onCancel={onClose} />
      </form>
    </Modal>
  );
}

function ManualStartComposer({ open, harness, slug, refreshToken, onInputsSaved, onClose }: {
  open: boolean;
  harness: string;
  slug: string;
  refreshToken: number;
  onInputsSaved: () => void;
  onClose: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await startPlan(slug, harness);
      if (isPlanStartRefusal(result)) throw new Error(result.hint);
      toast.success('Manual start accepted');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()} title="Start manually" srOnlyTitle contentClassName="pc-plan-dialog pc-plan-manual-start">
      <div className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head"><h3>Start manually</h3><p>Supply and save the declared arguments, then start through the existing plan-inputs gate.</p></header>
        <PlanInputsPanel slug={slug} harnessSlug={harness} refreshToken={refreshToken} onSaved={onInputsSaved} onReadinessChange={setReady} />
        <ComposerFooter error={error} submitting={starting} submitLabel="Start plan" onCancel={onClose} onSubmit={() => void start()} canSubmit={ready} />
      </div>
    </Modal>
  );
}

function ComposerFooter({ error, submitting, submitLabel, onCancel, onSubmit, canSubmit = true }: {
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit?: () => void;
  canSubmit?: boolean;
}) {
  return (
    <footer className="pc-plan-dialog__foot">
      {error ? <p className="pc-plan-dialog__error">{error}</p> : null}
      <div className="pc-plan-dialog__buttons">
        <button type="button" className="pc-plan-dialog__btn" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type={onSubmit ? 'button' : 'submit'} className="pc-plan-dialog__btn pc-plan-dialog__btn--primary" disabled={submitting || !canSubmit} onClick={onSubmit}>{submitting ? 'Submitting…' : submitLabel}</button>
      </div>
    </footer>
  );
}
