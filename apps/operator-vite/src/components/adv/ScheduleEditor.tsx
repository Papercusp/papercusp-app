/**
 * Schedule editor (scheduled-recurring-plans-2026-06-16 P-020) — the authoring
 * surface for a plan's schedule. Two modes:
 *   - One-shot: a single fire time (scheduledAt) — the "drag onto a day" gesture
 *     seeds this with the dropped date.
 *   - Recurring: an RRULE built from frequency / interval / weekdays / start, with
 *     an optional expiry. The backend (rrule lib) is the single source of truth and
 *     computes occurrences from this — we only emit the RFC-5545 string.
 *
 * Writes go through plans:set-schedule (authoring; does NOT arm) and the
 * autonomy-gated plans:arm-schedule / plans:disarm-schedule for the on/off toggle
 * (the owner arms directly from their own session). `schedule:null` clears.
 *
 * The RRULE/payload construction is the pure `buildSchedulePayload` (unit-tested);
 * the component is the thin form + the run-tool POST around it.
 */
import { useMemo, useState } from 'react';
import { Select } from '@/app/harness/Select';

export type ScheduleMode = 'one-shot' | 'recurring';
export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export const WEEKDAYS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'MO', label: 'Mon' },
  { id: 'TU', label: 'Tue' },
  { id: 'WE', label: 'Wed' },
  { id: 'TH', label: 'Thu' },
  { id: 'FR', label: 'Fri' },
  { id: 'SA', label: 'Sat' },
  { id: 'SU', label: 'Sun' },
];

export interface RecurrenceForm {
  mode: ScheduleMode;
  /** datetime-local string 'YYYY-MM-DDTHH:mm' for the one-shot fire. */
  oneShotAt: string;
  freq: Freq;
  /** Every N periods (≥1). */
  interval: number;
  /** BYDAY for weekly (e.g. ['MO','WE']); empty ⇒ recur on dtstart's weekday. */
  weekdays: string[];
  /** datetime-local 'YYYY-MM-DDTHH:mm' — DTSTART anchor (time-of-day matters). */
  startAt: string;
  /** date 'YYYY-MM-DD' — optional expiry; the schedule deactivates after it. */
  until: string;
  /** IANA tz id for DST-safe calendar-time recurrence. */
  tzid: string;
}

export interface SchedulePayloadSchedule {
  kind: 'rrule';
  rrule: string;
  dtstart: string;
  tzid: string;
}

export interface SchedulePayload {
  schedule: SchedulePayloadSchedule | null;
  scheduledAt: string | null;
  expiresAt: string | null;
}

/** datetime-local (no tz) → ISO. Returns null for blank/invalid. */
function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A 'YYYY-MM-DD' end date → end-of-day ISO (so the whole day is included). */
function untilToIso(until: string): string | null {
  if (!until) return null;
  const d = new Date(`${until}T23:59:59`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Pure: turn the form into the exact plans:set-schedule payload. The RRULE is kept
 * minimal — FREQ + INTERVAL (+ BYDAY for weekly with explicit weekdays). The expiry
 * lives in expiresAt (engine deactivates on it), not an iCal UNTIL, to avoid
 * fragile UNTIL formatting. Returns scheduledAt-only for one-shot.
 */
export function buildSchedulePayload(f: RecurrenceForm): SchedulePayload {
  if (f.mode === 'one-shot') {
    return { schedule: null, scheduledAt: localToIso(f.oneShotAt), expiresAt: null };
  }
  const interval = Math.max(1, Math.floor(f.interval) || 1);
  const parts = [`FREQ=${f.freq}`, `INTERVAL=${interval}`];
  if (f.freq === 'WEEKLY' && f.weekdays.length > 0) {
    // Preserve canonical weekday order regardless of click order.
    const ordered = WEEKDAYS.filter((d) => f.weekdays.includes(d.id)).map((d) => d.id);
    parts.push(`BYDAY=${ordered.join(',')}`);
  }
  const dtstart = localToIso(f.startAt) ?? new Date().toISOString();
  return {
    schedule: { kind: 'rrule', rrule: parts.join(';'), dtstart, tzid: f.tzid },
    scheduledAt: null,
    expiresAt: untilToIso(f.until),
  };
}

/** A human summary of what the form will do — shown before saving. */
export function describeForm(f: RecurrenceForm): string {
  if (f.mode === 'one-shot') {
    const at = f.oneShotAt ? new Date(f.oneShotAt).toLocaleString() : '—';
    return `Fires once at ${at}, then deactivates.`;
  }
  const n = Math.max(1, Math.floor(f.interval) || 1);
  const unit = f.freq === 'DAILY' ? 'day' : f.freq === 'WEEKLY' ? 'week' : 'month';
  const every = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  const days =
    f.freq === 'WEEKLY' && f.weekdays.length > 0
      ? ` on ${WEEKDAYS.filter((d) => f.weekdays.includes(d.id)).map((d) => d.label).join(', ')}`
      : '';
  const ends = f.until ? `, until ${f.until}` : '';
  return `Repeats ${every}${days}${ends}.`;
}

/** The raw authored schedule the editor pre-fills from (the plans.schedule row shape). */
export interface RawSchedule {
  schedule: {
    kind?: string;
    rrule?: string;
    dtstart?: string;
    tzid?: string;
    rdate?: string[];
    exdate?: string[];
    cron?: string;
  } | null;
  scheduledAt: string | null;
  expiresAt: string | null;
  tzid: string | null;
}

/** Parse an RRULE string back into the editor's form fields (inverse of buildSchedulePayload). */
export function parseRrule(rrule: string): { freq: Freq; interval: number; weekdays: string[] } {
  const map: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) map[k.trim().toUpperCase()] = v.trim();
  }
  const freq = (['DAILY', 'WEEKLY', 'MONTHLY'].includes(map.FREQ) ? map.FREQ : 'WEEKLY') as Freq;
  const interval = Math.max(1, parseInt(map.INTERVAL ?? '1', 10) || 1);
  const weekdays = map.BYDAY
    ? map.BYDAY.split(',').map((s) => s.trim().toUpperCase()).filter((s) => WEEKDAYS.some((d) => d.id === s))
    : [];
  return { freq, interval, weekdays };
}

/** ISO → 'YYYY-MM-DD' for the <input type="date"> "until" field. */
function isoToDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pure: the editor's initial form. An explicit seedMode (a day-click → one-shot)
 * wins; otherwise pre-fill from the plan's current schedule when present; else a
 * fresh recurring default.
 */
export function deriveInitialForm(opts: {
  initial?: RawSchedule | null;
  seedDate?: string;
  seedMode?: ScheduleMode;
  tzid: string;
}): RecurrenceForm {
  const { initial, seedDate, seedMode, tzid } = opts;
  const seedLocal = defaultStart(seedDate);
  const fresh: RecurrenceForm = {
    mode: seedMode ?? 'recurring',
    oneShotAt: seedLocal,
    freq: 'WEEKLY',
    interval: 1,
    weekdays: [],
    startAt: seedLocal,
    until: '',
    tzid,
  };
  // A day-click forces one-shot; don't override it with the existing recurrence.
  if (seedMode || !initial) return fresh;
  if (initial.scheduledAt) {
    return { ...fresh, mode: 'one-shot', oneShotAt: defaultStart(initial.scheduledAt), tzid: initial.tzid ?? tzid };
  }
  if (initial.schedule?.rrule) {
    const p = parseRrule(initial.schedule.rrule);
    return {
      ...fresh,
      mode: 'recurring',
      freq: p.freq,
      interval: p.interval,
      weekdays: p.weekdays,
      startAt: defaultStart(initial.schedule.dtstart ?? undefined),
      until: isoToDateInput(initial.expiresAt),
      tzid: initial.tzid ?? initial.schedule.tzid ?? tzid,
    };
  }
  return fresh;
}

export interface RunScheduleToolResult {
  ok: boolean;
  message?: string;
  /** Parsed successful tool payload, when the caller needs the created run/ref. */
  data?: Record<string, unknown>;
}

/**
 * Interpret the JSON text returned by an agent-MCP tool.
 *
 * Bulk tools deliberately keep the envelope request successful while reporting
 * item refusals in `results[]`/`counts.failed`. Treating only `payload.error` as
 * failure made plans:arm-schedule look green when every requested plan was
 * refused by the start gate. Keep the shared browser writer honest for every
 * ScheduleEditor/Automations caller.
 */
function parseRunScheduleToolPayload(payload: unknown): RunScheduleToolResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: true };
  const value = payload as {
    ok?: boolean;
    error?: unknown;
    detail?: unknown;
    message?: unknown;
    results?: unknown;
    counts?: unknown;
  };
  const directMessage = typeof value.detail === 'string'
    ? value.detail
    : typeof value.message === 'string'
      ? value.message
      : typeof value.error === 'string'
        ? value.error
        : undefined;
  if (value.ok === false || value.error != null) {
    return { ok: false, message: directMessage ?? 'Tool request failed' };
  }

  const results = Array.isArray(value.results) ? value.results : [];
  const failures = results.filter((row): row is Record<string, unknown> => (
    Boolean(row) && typeof row === 'object' && !Array.isArray(row) && (row as { ok?: unknown }).ok === false
  ));
  if (failures.length > 0) {
    const first = failures[0];
    const firstMessage = typeof first.detail === 'string'
      ? first.detail
      : typeof first.message === 'string'
        ? first.message
        : typeof first.error === 'string'
          ? first.error
          : 'Tool item failed';
    return {
      ok: false,
      message: failures.length === 1 ? firstMessage : `${firstMessage} (${failures.length} items failed)`,
    };
  }

  if (value.counts && typeof value.counts === 'object' && !Array.isArray(value.counts)) {
    const failed = (value.counts as { failed?: unknown }).failed;
    if (typeof failed === 'number' && failed > 0) {
      return { ok: false, message: `${failed} tool item${failed === 1 ? '' : 's'} failed` };
    }
  }
  return { ok: true, data: value };
}

export async function runScheduleTool(name: string, args: Record<string, unknown>): Promise<RunScheduleToolResult> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  if (!res.ok || body.ok === false) return { ok: false, message: body.message ?? body.error ?? `HTTP ${res.status}` };
  const text = body.result?.content?.[0]?.text;
  if (text) {
    try {
      const parsed = parseRunScheduleToolPayload(JSON.parse(text) as unknown);
      if (!parsed.ok) return parsed;
    } catch {
      /* non-JSON tool text — treat as success */
    }
  }
  if (body.result?.isError) return { ok: false, message: body.message ?? text ?? `${name} failed` };
  return { ok: true };
}

function defaultStart(seedDate?: string): string {
  // datetime-local wants 'YYYY-MM-DDTHH:mm' in LOCAL time.
  const d = seedDate ? new Date(seedDate) : new Date();
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleEditor({
  planSlug,
  planTitle,
  harness,
  seedDate,
  seedMode,
  initial,
  isArmed,
  onClose,
  onSaved,
}: {
  planSlug: string;
  planTitle?: string | null;
  /** The plan's harness — threaded to the write tools so a non-primary-harness plan
   *  targets the right pot (D-020). Omit ⇒ the write resolves the primary harness. */
  harness?: string;
  /** ISO date the editor opens on (from a calendar dateClick); seeds one-shot + dtstart. */
  seedDate?: string;
  /** Force initial mode (a day-click seeds 'one-shot'). */
  seedMode?: ScheduleMode;
  /** The plan's current schedule (plans.schedule row) — pre-fills the form for editing. */
  initial?: RawSchedule | null;
  /** Current armed state, if known — drives the Arm/Pause toggle label. */
  isArmed?: boolean;
  onClose: () => void;
  /** Called after a successful write so the caller can invalidate the occurrences query. */
  onSaved?: () => void;
}) {
  const tzid = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  // Pre-fill from the plan's current schedule when editing (deriveInitialForm); a
  // day-click's seedMode forces a fresh one-shot. Initial form computed once.
  const [form, setForm] = useState<RecurrenceForm>(() =>
    deriveInitialForm({ initial, seedDate, seedMode, tzid }),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patch = (p: Partial<RecurrenceForm>) => setForm((f) => ({ ...f, ...p }));
  const toggleWeekday = (id: string) =>
    setForm((f) => ({ ...f, weekdays: f.weekdays.includes(id) ? f.weekdays.filter((d) => d !== id) : [...f.weekdays, id] }));

  const valid =
    form.mode === 'one-shot' ? !!localToIso(form.oneShotAt) : !!localToIso(form.startAt);

  const doWrite = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await run();
      if (!r.ok) {
        setErr(r.message ?? 'Write failed');
        return false;
      }
      onSaved?.();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const hArg = harness ? { harness } : {};

  const onSave = async () => {
    const payload = buildSchedulePayload(form);
    const ok = await doWrite(() =>
      runScheduleTool('plans:set-schedule', {
        slug: planSlug,
        ...hArg,
        schedule: payload.schedule,
        scheduledAt: payload.scheduledAt,
        expiresAt: payload.expiresAt,
      }),
    );
    if (ok) onClose();
  };

  const onClear = async () => {
    const ok = await doWrite(() => runScheduleTool('plans:set-schedule', { slug: planSlug, ...hArg, schedule: null, scheduledAt: null }));
    if (ok) onClose();
  };

  const onArmToggle = async () => {
    await doWrite(() => runScheduleTool(isArmed ? 'plans:disarm-schedule' : 'plans:arm-schedule', { slug: planSlug, ...hArg }));
  };

  return (
    <div className="pc-sched-editor" role="region" aria-label={`Schedule ${planTitle ?? planSlug}`}>
      <div className="pc-sched-editor__head">
        <strong>Schedule</strong>
        <span className="pc-sched-editor__slug" title={planSlug}>{planTitle ?? planSlug}</span>
        <button type="button" className="pc-sched-editor__x" onClick={onClose} aria-label="Close schedule editor">×</button>
      </div>

      <div className="pc-sched-editor__modes" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={form.mode === 'recurring'}
          className={`pc-sched-editor__mode${form.mode === 'recurring' ? ' is-on' : ''}`}
          onClick={() => patch({ mode: 'recurring' })}
        >
          Repeats…
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={form.mode === 'one-shot'}
          className={`pc-sched-editor__mode${form.mode === 'one-shot' ? ' is-on' : ''}`}
          onClick={() => patch({ mode: 'one-shot' })}
        >
          One-shot
        </button>
      </div>

      {form.mode === 'one-shot' ? (
        <label className="pc-sched-editor__field">
          <span>Fire once at</span>
          <input
            type="datetime-local"
            value={form.oneShotAt}
            onChange={(e) => patch({ oneShotAt: e.target.value })}
          />
        </label>
      ) : (
        <>
          <div className="pc-sched-editor__row">
            <label className="pc-sched-editor__field">
              <span>Every</span>
              <input
                type="number"
                min={1}
                value={form.interval}
                onChange={(e) => patch({ interval: Number(e.target.value) })}
                aria-label="Interval"
                style={{ width: 56 }}
              />
            </label>
            <label className="pc-sched-editor__field">
              <span>Frequency</span>
              <Select
                value={form.freq}
                onChange={(value) => patch({ freq: value as Freq })}
                options={[
                  { value: 'DAILY', label: 'day(s)' },
                  { value: 'WEEKLY', label: 'week(s)' },
                  { value: 'MONTHLY', label: 'month(s)' },
                ]}
                ariaLabel="Frequency"
              />
            </label>
          </div>

          {form.freq === 'WEEKLY' && (
            <div className="pc-sched-editor__weekdays" role="group" aria-label="On weekdays">
              {WEEKDAYS.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  className={`pc-sched-editor__wd${form.weekdays.includes(d.id) ? ' is-on' : ''}`}
                  aria-pressed={form.weekdays.includes(d.id)}
                  onClick={() => toggleWeekday(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}

          <label className="pc-sched-editor__field">
            <span>Starting</span>
            <input type="datetime-local" value={form.startAt} onChange={(e) => patch({ startAt: e.target.value })} />
          </label>
          <label className="pc-sched-editor__field">
            <span>Until (optional)</span>
            <input type="date" value={form.until} onChange={(e) => patch({ until: e.target.value })} />
          </label>
        </>
      )}

      <p className="pc-sched-editor__summary">{describeForm(form)}</p>
      <p className="pc-sched-editor__tz">Timezone: {form.tzid}</p>

      {err && <p className="pc-sched-editor__err" role="alert">{err}</p>}

      <div className="pc-sched-editor__actions">
        <button type="button" className="pc-sched-editor__save" disabled={busy || !valid} onClick={onSave}>
          {busy ? 'Saving…' : 'Save schedule'}
        </button>
        <button type="button" className="pc-sched-editor__arm" disabled={busy} onClick={onArmToggle}>
          {isArmed ? 'Pause (disarm)' : 'Arm (start firing)'}
        </button>
        <span className="pc-sched-editor__spacer" />
        <button type="button" className="pc-sched-editor__clear" disabled={busy} onClick={onClear}>
          Un-schedule
        </button>
      </div>
      <p className="pc-sched-editor__hint">
        Saving authors the schedule; it does not start firing until armed. Arming is owner-gated.
      </p>

      <ScheduleEditorStyles />
    </div>
  );
}

function ScheduleEditorStyles() {
  return (
    <style>{`
      .pc-sched-editor { display: flex; flex-direction: column; gap: 9px; padding: 12px; font-size: 12px; color: var(--fg, #e7f7ff); }
      .pc-sched-editor__head { display: flex; align-items: center; gap: 8px; }
      .pc-sched-editor__head strong { font-size: 11px; text-transform: uppercase; letter-spacing: 0; }
      .pc-sched-editor__slug { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: var(--fg-mute, #7f9bb4); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-sched-editor__x { background: none; border: none; color: var(--fg-mute, #7f9bb4); font-size: 16px; cursor: pointer; line-height: 1; }
      .pc-sched-editor__modes { display: flex; gap: 4px; }
      .pc-sched-editor__mode { flex: 1; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-weight: 700; font-size: 11px;
        color: var(--fg-dim, #b9d4e8); background: var(--bg-2, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(125,211,252,0.18)); }
      .pc-sched-editor__mode.is-on { color: var(--accent, #38bdf8); border-color: color-mix(in srgb, var(--accent), transparent 50%); background: color-mix(in srgb, var(--accent), transparent 88%); }
      .pc-sched-editor__row { display: flex; gap: 10px; }
      .pc-sched-editor__field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
      .pc-sched-editor__field > span { font-size: 10px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-sched-editor__field input, .pc-sched-editor__field select {
        font: inherit; font-size: 12px; padding: 5px 7px; border-radius: 6px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125,211,252,0.3)); }
      .pc-sched-editor__weekdays { display: flex; gap: 3px; flex-wrap: wrap; }
      .pc-sched-editor__wd { padding: 4px 7px; border-radius: 6px; cursor: pointer; font-size: 10.5px; font-weight: 700;
        color: var(--fg-dim, #b9d4e8); background: var(--bg-2, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(125,211,252,0.18)); }
      .pc-sched-editor__wd.is-on { color: #fcd34d; border-color: rgba(251,191,36,0.5); background: rgba(251,191,36,0.12); }
      .pc-sched-editor__summary { margin: 2px 0 0; font-size: 11.5px; color: var(--fg-dim, #b9d4e8); }
      .pc-sched-editor__tz { margin: 0; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-sched-editor__err { margin: 0; font-size: 11px; color: #fca5a5; }
      .pc-sched-editor__actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 2px; }
      .pc-sched-editor__spacer { flex: 1; }
      .pc-sched-editor__save { font-weight: 700; font-size: 11.5px; padding: 6px 11px; border-radius: 7px; cursor: pointer;
        color: #c7d2fe; background: rgba(99,102,241,0.18); border: 1px solid rgba(99,102,241,0.45); }
      .pc-sched-editor__arm { font-weight: 700; font-size: 11.5px; padding: 6px 11px; border-radius: 7px; cursor: pointer;
        color: #86efac; background: rgba(34,197,94,0.14); border: 1px solid rgba(34,197,94,0.4); }
      .pc-sched-editor__clear { font-size: 11px; padding: 6px 9px; border-radius: 7px; cursor: pointer;
        color: var(--fg-mute, #7f9bb4); background: var(--bg-2, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(125,211,252,0.18)); }
      .pc-sched-editor__save:disabled, .pc-sched-editor__arm:disabled, .pc-sched-editor__clear:disabled { opacity: 0.55; cursor: default; }
      .pc-sched-editor__hint { margin: 0; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
    `}</style>
  );
}
