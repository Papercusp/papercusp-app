'use client';

/**
 * PlanInputsPanel — the human-facing half of plan inputs
 * (plan-structured-inputs-2026-08-01 P-013).
 *
 * The rest of that plan built a start gate that refuses a parameterized plan whose
 * required arguments are unset. A gate with no way to SEE what it wants, and no way to
 * supply it without opening an agent session and calling plans:set-template-data by
 * hand, is hostile to the operator it is protecting — so this panel renders the
 * declared schema as a form, marks what is required, says what is still missing, and
 * writes the values back.
 *
 * Everything judgemental comes from the server. `required`, `missing` and `ready` are
 * the start gate's own oracle (plans:get-input-schema P-013 widening), so this panel
 * cannot tell the human they are ready and then watch the start be refused — the
 * failure mode of any UI that re-derives a rule it does not own.
 *
 * SCOPE. Renders the small slice of JSON Schema that plan inputs actually use:
 * string (+ enum → select), number/integer, boolean, and array-of-string (one entry
 * per line — the shape `for_each: { from_input }` fans out over, so it is the single
 * most load-bearing field type here). Anything else falls back to a JSON textarea
 * that is parsed and validated on save, so an exotic schema degrades to "edit the
 * JSON" rather than to a field the human cannot fill at all. A plan with no declared
 * schema renders nothing — most plans, hence the early return.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import {
  fetchPlanInputs,
  savePlanInputs,
  type JsonSchemaProperty,
  type PlanInputSchemaInfo,
} from './plans-api';

export interface PlanInputsPanelProps {
  slug: string;
  harnessSlug?: string | null;
  /** Bumped by the caller to force a refetch (e.g. after a refused start). */
  refreshToken?: number;
  /** Fired after a successful save so the caller can re-enable/retry a start. */
  onSaved?: () => void;
  /** Shares the server-owned readiness verdict with a containing start dialog. */
  onReadinessChange?: (ready: boolean) => void;
}

type FieldKind = 'string' | 'enum' | 'number' | 'boolean' | 'string-array' | 'json';

/** Which editor a property gets. Widening this is the extension point; the `json`
 *  fallback means an unrecognized schema is always still editable. */
export function fieldKindOf(prop: JsonSchemaProperty | undefined): FieldKind {
  if (!prop) return 'json';
  const type = Array.isArray(prop.type) ? prop.type.find((t) => t !== 'null') : prop.type;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return 'enum';
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') {
    const itemType = Array.isArray(prop.items?.type)
      ? prop.items?.type.find((t) => t !== 'null')
      : prop.items?.type;
    // Only string arrays get the line-per-entry editor; an array of objects would be
    // silently mangled by it, so that falls through to JSON.
    if (itemType === 'string' || itemType === undefined) return 'string-array';
  }
  return 'json';
}

/** A form value (always a string, as the DOM gives it) back to its JSON type.
 *  Returns `undefined` for an empty optional field so an absent value stays ABSENT
 *  rather than becoming `""` — the gate tests for undefined, and a blank string
 *  would satisfy a required check while meaning nothing. */
export function coerceFieldValue(
  kind: FieldKind,
  raw: string,
  checked?: boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (kind === 'boolean') return { ok: true, value: !!checked };
  const trimmed = raw.trim();
  if (trimmed === '' && kind !== 'json') return { ok: true, value: undefined };
  switch (kind) {
    case 'number': {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'not a number' };
    }
    case 'string-array':
      return {
        ok: true,
        value: raw
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      };
    case 'json': {
      if (trimmed === '') return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
      }
    }
    default:
      return { ok: true, value: raw };
  }
}

/** A stored value into the string the editor shows. */
export function displayFieldValue(kind: FieldKind, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (kind === 'string-array') return Array.isArray(value) ? value.join('\n') : String(value);
  if (kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

export default function PlanInputsPanel({
  slug,
  harnessSlug,
  refreshToken = 0,
  onSaved,
  onReadinessChange,
}: PlanInputsPanelProps) {
  const [info, setInfo] = useState<PlanInputSchemaInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bools, setBools] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    void (async () => {
      try {
        const r = await fetchPlanInputs(slug, harnessSlug, ac.signal);
        if (!live) return;
        if (!r.ok) {
          setInfo(null);
          return;
        }
        const next = r as PlanInputSchemaInfo;
        setInfo(next);
        const props = next.inputSchema?.properties ?? {};
        const values = next.values ?? {};
        const d: Record<string, string> = {};
        const b: Record<string, boolean> = {};
        for (const [name, prop] of Object.entries(props)) {
          const kind = fieldKindOf(prop);
          if (kind === 'boolean') b[name] = values[name] === true;
          else d[name] = displayFieldValue(kind, values[name]);
        }
        setDraft(d);
        setBools(b);
      } catch (e) {
        if (!live || ac.signal.aborted) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [slug, harnessSlug, refreshToken]);

  const properties = useMemo(
    () => Object.entries(info?.inputSchema?.properties ?? {}),
    [info],
  );
  const requiredSet = useMemo(() => new Set(info?.required ?? []), [info]);
  const missingSet = useMemo(() => new Set(info?.missing ?? []), [info]);

  useEffect(() => {
    onReadinessChange?.(info?.ready === true);
    return () => onReadinessChange?.(false);
  }, [info?.ready, onReadinessChange]);

  const onSave = useCallback(async () => {
    if (!info || saving) return;
    const data: Record<string, unknown> = {};
    for (const [name, prop] of properties) {
      const kind = fieldKindOf(prop);
      const r = coerceFieldValue(kind, draft[name] ?? '', bools[name]);
      if (!r.ok) {
        toast.error(`${name}: ${r.error}`);
        return;
      }
      // An absent optional field is omitted rather than written as null — the
      // schema's own `default` (if any) then applies, and `missing` stays truthful.
      if (r.value !== undefined) data[name] = r.value;
    }
    setSaving(true);
    try {
      const res = await savePlanInputs(slug, data, harnessSlug);
      if ('error' in res) {
        // set-template-data validates on write, so this is a real schema violation —
        // surface it rather than a generic failure.
        // The error variant is an open record, so `hint` is `unknown` — read it
        // through the index signature and narrow, rather than asserting a shape the
        // server is not obliged to send.
        const hint = res.hint;
        const detail = typeof hint === 'string' ? hint : String(res.error);
        toast.error(`Save failed: ${detail}`, { duration: 10000 });
        return;
      }
      toast.success('Inputs saved.');
      onSaved?.();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [info, saving, properties, draft, bools, slug, harnessSlug, onSaved]);

  // The overwhelmingly common case: a plan that declares no inputs has nothing to
  // show, and an empty panel on every plan would be pure noise.
  if (!info || info.source === 'none') return null;

  // A `template:` (code-registry zod) plan has no readable property list to render a
  // form from — its schema lives in TypeScript. Report the status honestly instead of
  // rendering an empty form that looks broken.
  if (info.source === 'template' && properties.length === 0) {
    return (
      <section className="pc-plan-inputs" aria-labelledby="pc-plan-inputs-h">
        <h3 id="pc-plan-inputs-h" className="pc-plan-inputs__title">
          Inputs
        </h3>
        <p className="pc-plan-inputs__note">
          This plan takes its inputs from the registered template type{' '}
          <code>{info.template}</code>, whose schema is defined in code. Set its values
          with <code>plans:set-template-data</code>.
        </p>
        {!info.ready && info.hint ? (
          <p className="pc-plan-inputs__refusal" role="status">
            {info.hint}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="pc-plan-inputs" aria-labelledby="pc-plan-inputs-h">
      <h3 id="pc-plan-inputs-h" className="pc-plan-inputs__title">
        Inputs
        {info.ready ? (
          <span className="pc-plan-inputs__badge pc-plan-inputs__badge--ready">ready to start</span>
        ) : (
          <span className="pc-plan-inputs__badge pc-plan-inputs__badge--blocked">
            {missingSet.size > 0 ? `${missingSet.size} required missing` : 'not startable'}
          </span>
        )}
      </h3>

      {!info.ready && info.hint ? (
        <p className="pc-plan-inputs__refusal" role="status">
          {info.hint}
        </p>
      ) : null}
      {info.issues && info.issues.length > 0 ? (
        <ul className="pc-plan-inputs__issues">
          {info.issues.map((iss) => (
            <li key={iss}>{iss}</li>
          ))}
        </ul>
      ) : null}

      <div className="pc-plan-inputs__fields">
        {properties.map(([name, prop]) => {
          const kind = fieldKindOf(prop);
          const isRequired = requiredSet.has(name);
          const isMissing = missingSet.has(name);
          const id = `pc-plan-input-${name}`;
          const describedBy = prop.description ? `${id}-desc` : undefined;
          return (
            <div
              key={name}
              className={`pc-plan-inputs__field${isMissing ? ' pc-plan-inputs__field--missing' : ''}`}
            >
              <label className="pc-plan-inputs__label" htmlFor={id}>
                {prop.title || name}
                {isRequired ? (
                  <span className="pc-plan-inputs__req" aria-label="required">
                    *
                  </span>
                ) : null}
              </label>
              {prop.description ? (
                <p className="pc-plan-inputs__desc" id={describedBy}>
                  {prop.description}
                </p>
              ) : null}
              {kind === 'boolean' ? (
                <Checkbox
                  id={id}
                  checked={!!bools[name]}
                  describedBy={describedBy}
                  onChange={(checked) => setBools((s) => ({ ...s, [name]: checked }))}
                />
              ) : kind === 'enum' ? (
                <Select
                  id={id}
                  value={draft[name] ?? ''}
                  describedBy={describedBy}
                  placeholder="—"
                  onChange={(v) => setDraft((s) => ({ ...s, [name]: v }))}
                  options={(prop.enum ?? []).map((opt) => ({
                    value: String(opt),
                    label: String(opt),
                  }))}
                />
              ) : kind === 'string-array' || kind === 'json' ? (
                <textarea
                  id={id}
                  rows={kind === 'json' ? 6 : 4}
                  value={draft[name] ?? ''}
                  aria-describedby={describedBy}
                  placeholder={kind === 'string-array' ? 'One entry per line' : '{ }'}
                  onChange={(e) => setDraft((s) => ({ ...s, [name]: e.target.value }))}
                />
              ) : (
                <input
                  id={id}
                  type={kind === 'number' ? 'number' : 'text'}
                  value={draft[name] ?? ''}
                  aria-describedby={describedBy}
                  onChange={(e) => setDraft((s) => ({ ...s, [name]: e.target.value }))}
                />
              )}
              {isMissing ? (
                <span className="pc-plan-inputs__missing-tag">required — not supplied</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {loadError ? <p className="pc-plan-inputs__refusal">{loadError}</p> : null}

      <button
        type="button"
        className="pc-plan-inputs__save"
        onClick={onSave}
        disabled={saving || properties.length === 0}
      >
        {saving ? 'Saving…' : 'Save inputs'}
      </button>
    </section>
  );
}
