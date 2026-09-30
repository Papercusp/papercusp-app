'use client';

/**
 * /settings/pot-customization — the owner control surface for a hive's per-instance
 * customization (domain-generic-hive-architecture-2026-06-18 P-015 / D-005, D-007).
 *
 * TWO editors, because a hive customizes along two axes that need different shapes:
 *   1. PROSE role personas — a per-role markdown delta appended to the built-in
 *      blueprint persona (`promptOverride.<role>`, D-007). This is how a hive words its
 *      Queen / bee / su / overwatch / operator for its domain. Consumed both ways
 *      (P-012/P-013): autonomous agents read a materialized local-tier file, the
 *      interactive psu reads the appended delta.
 *   2. STRUCTURED config — a scout tuning delta (`localBlueprint.scout`, a
 *      ScoutConfigOverride). Scout's customization is config, not prose, so a prose-only
 *      page can't express it (D-005) — that's why this editor exists. Stored + federated
 *      over the Hive peer-log; the per-hive scout cycle layers it onto its run
 *      (scout-cycle-action merges it into the tick payload's `scout` block).
 *
 * Both halves write through the loopback `/api/agent-mcp/pot-override-set` route (which
 * federates via hive_settings + invalidates `hive.overrides`); the page reads
 * `hive.overrides` via useSyncQuery. nuqs holds the hive / role / section selectors
 * (the agent → UI control surface reads the URL — repo convention). Flag-gated behind
 * `papercusp-blueprint-aware-settings` (ON by default).
 */
import { useCallback, useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { toast } from 'sonner';
import { useLexicon } from '@/lib/useLexicon';
import {
  hiveOverrideSetRest,
  type HiveOverrideRow,
  type HiveOverrideSetArgs,
  type HiveOverrideSetResp,
} from '@/lib/hive-override-set';
import { Select } from '../../harness/Select';
import { agentRoleLabel } from '../../harness/agent-display';
import { PotPolicyPanel } from './PotPolicyPanel';

interface HiveRow {
  slug: string;
  remote: boolean;
}
/**
 * The row/arg/response shapes and the REST fallback now live in
 * `@/lib/hive-override-set`, because the per-pot learning drawer performs this
 * same write (P-013 / D-011) and a mirrored copy of an endpoint path is exactly
 * the code-describing duplicate that drifts. Local aliases keep the rest of this
 * file reading as it did.
 */
type OverrideRow = HiveOverrideRow;
type SetArgs = HiveOverrideSetArgs;
type SetResp = HiveOverrideSetResp;

/** Roles whose persona a hive can override. Any already-overridden role outside this
 *  set is surfaced too (below), so nothing a hive set is ever hidden. */
const ROLE_OPTIONS = ['su', 'mug', 'cup', 'overwatch', 'operator', 'kettle'] as const;
/** Structured config sections (D-005 + learning-settings 2026-07-19):
 *  `scout` = judgment tuning (lenses/buckets/routing/framing/models);
 *  `cadence` = the FIRE knobs (threshold, heartbeat, floors — ScoutCadenceOptions).
 *  scout-cycle-action layers these onto the tick payload, so they are the live knobs.
 *
 *  ⚠ `budget` IS DELIBERATELY ABSENT (P-013 / D-011), not forgotten. It is still
 *  a live config section — the scout cadence reads it every cycle and rebuilds
 *  the `blender:<pot>` governor row from it — but it is no longer edited as raw
 *  JSON here. Its three keys now have typed, unit-labelled fields on the per-pot
 *  learning drawer, which say which value is UNSET (engine default) and which is
 *  an override: `maxCostUsd: 0` means "no spend this cycle" and unset means "use
 *  the default", and a JSON textarea gave no way to see the difference. Putting
 *  it back here would mean two writable editors for one value with no lock
 *  between them, each able to clobber the other's keys on save. */
const CONFIG_SECTIONS = ['scout', 'cadence'] as const;

const CADENCE_PLACEHOLDER = `{
  "signalScoreThreshold": 25,
  "maxIntervalSec": 3600,
  "minIntervalSec": 3600,
  "minVolumeIntervalSec": 900,
  "frictionThreshold": 3
}`;

const SCOUT_PLACEHOLDER = `{
  "lenses": ["analogical", "first-principles", "inversion"],
  "buckets": { "moonshotNoveltyFloor": 0.8 },
  "routing": { "defaultRail": "improvement", "wholeSystemMarkers": [] }
}`;

const TEXTAREA_STYLE = {
  width: '100%',
  minHeight: 280,
  fontSize: 12,
  fontFamily: 'monospace',
  padding: 10,
  lineHeight: 1.5,
  background: 'var(--bg-1)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'inherit',
  resize: 'vertical' as const,
  boxSizing: 'border-box' as const,
};

const BTN_STYLE = { fontSize: 12, padding: '5px 14px', cursor: 'pointer' };

/* ── Prose role-persona editor (keyed by hive:role → remounts on selection change) ── */
function ProseOverrideEditor({
  initialValue,
  onSave,
  onClear,
}: {
  initialValue: string;
  onSave: (md: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const t = useLexicon();
  const [draft, setDraft] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== initialValue;

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  }, [draft, onSave]);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await onClear();
      setDraft('');
    } finally {
      setBusy(false);
    }
  }, [onClear]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={`Markdown delta appended after the built-in role persona for this ${t('pot', { lower: true })}. Leave empty to use the blueprint default.`}
        style={TEXTAREA_STYLE}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={() => void save()} disabled={!dirty || busy} style={BTN_STYLE}>
          {busy ? 'Saving…' : 'Save override'}
        </button>
        <button
          type="button"
          onClick={() => void clear()}
          disabled={busy || initialValue.length === 0}
          style={{ ...BTN_STYLE, opacity: initialValue.length === 0 ? 0.5 : 1 }}
        >
          Clear override
        </button>
        {dirty && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>unsaved</span>}
        {!dirty && initialValue.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>override set</span>
        )}
      </div>
    </div>
  );
}

/* ── Structured config editor (JSON; keyed by hive:section) ── */
function ConfigOverrideEditor({
  section,
  initialValue,
  onSave,
  onClear,
}: {
  section: string;
  initialValue: unknown | null;
  onSave: (value: unknown) => Promise<SetResp>;
  onClear: () => Promise<void>;
}) {
  const t = useLexicon();
  const initialText = initialValue == null ? '' : JSON.stringify(initialValue, null, 2);
  const [draft, setDraft] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SetResp | null>(null);
  const dirty = draft !== initialText;

  const parsed = useMemo<{ value?: unknown; error?: string }>(() => {
    const t = draft.trim();
    if (t.length === 0) return { value: null };
    try {
      const v = JSON.parse(t);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { error: 'Must be a JSON object' };
      }
      return { value: v };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [draft]);

  const save = useCallback(async () => {
    if (parsed.error || parsed.value == null) return;
    setBusy(true);
    try {
      const resp = await onSave(parsed.value);
      setFeedback(resp);
    } finally {
      setBusy(false);
    }
  }, [parsed, onSave]);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await onClear();
      setDraft('');
      setFeedback(null);
    } finally {
      setBusy(false);
    }
  }, [onClear]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={
          section === 'scout'
            ? SCOUT_PLACEHOLDER
            : section === 'cadence'
              ? CADENCE_PLACEHOLDER
              : '{ }'
        }
        style={TEXTAREA_STYLE}
      />
      {parsed.error && draft.trim().length > 0 && (
        <span role="alert" style={{ fontSize: 11.5, color: 'var(--bad)' }}>
          Invalid JSON: {parsed.error}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy || !!parsed.error || parsed.value == null}
          style={BTN_STYLE}
        >
          {busy ? 'Saving…' : 'Save config'}
        </button>
        <button
          type="button"
          onClick={() => void clear()}
          disabled={busy || initialValue == null}
          style={{ ...BTN_STYLE, opacity: initialValue == null ? 0.5 : 1 }}
        >
          Clear config
        </button>
        {dirty && !parsed.error && <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>unsaved</span>}
        {!dirty && initialValue != null && (
          <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>config set</span>
        )}
      </div>
      {feedback && (feedback.dropped?.length || feedback.accepted != null) && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--fg-mute)',
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 10,
          }}
        >
          {feedback.dropped && feedback.dropped.length > 0 ? (
            <div style={{ color: 'var(--warn)' }}>
              Dropped unknown/invalid keys: {feedback.dropped.join(', ')} — the {t('scout', { lower: true })} loop
              ignores these (it parses defensively).
            </div>
          ) : (
            <div>Accepted — the {t('scout', { lower: true })} loop reads this on its next per-{t('pot', { lower: true })} cycle.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PotCustomizationPage() {
  const t = useLexicon();
  // Role ids are internal (D-001 — never renamed); only their DISPLAYED label routes
  // through the lexicon, so the dropdown reads in the active vocabulary (queen→brain,
  // bee→cup). Lower-cased to match the other raw role ids shown (su/overwatch/operator,
  // whose classic label is unchanged). The Select `value` stays the raw role id.
  const roleLabel = (r: string): string => agentRoleLabel(r, t, { lower: true });
  const { data: hiveData, loading: hivesLoading } = useSyncQuery<HiveRow>({ queryName: 'learning.hiveList' });
  const hives = useMemo<HiveRow[]>(() => hiveData ?? [], [hiveData]);

  const [hive, setHive] = useQueryState('hive', parseAsString);
  const [role, setRole] = useQueryState('role', parseAsString.withDefault('su'));
  const [rawSection, setSection] = useQueryState('section', parseAsString.withDefault('scout'));
  /**
   * An unrecognised `?section=` resolves to the first real one. This is not
   * defensive tidying: a URL saved while `budget` was still a JSON section
   * (P-013 retired it) would otherwise render a full editor that no selector can
   * reach — a second writable surface for a value the learning drawer now owns,
   * whose whole-object save would silently clobber the drawer's keys.
   */
  const section = (CONFIG_SECTIONS as readonly string[]).includes(rawSection)
    ? rawSection
    : CONFIG_SECTIONS[0];

  // `hive` is null until one is picked from the URL, so without the gate this
  // fetches `{potSlug:''}` on every poll — a round-trip whose result the
  // `rows` memo below then discards anyway (no-http-anywhere-2026-07-28 P-027).
  const { data: overrideData, error } = useSyncQuery<OverrideRow>({
    queryName: 'hive.overrides',
    args: { potSlug: hive ?? '' },
    enabled: Boolean(hive),
  });
  const rows = useMemo<OverrideRow[]>(() => (hive ? (overrideData ?? []) : []), [overrideData, hive]);

  const promptByRole = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of rows) if (r.kind === 'prompt') m[r.name] = typeof r.value === 'string' ? r.value : String(r.value);
    return m;
  }, [rows]);
  const configBySection = useMemo(() => {
    const m: Record<string, unknown> = {};
    for (const r of rows) if (r.kind === 'config') m[r.name] = r.value;
    return m;
  }, [rows]);

  // Role options = the known set + any already-overridden role outside it (never hide a set override).
  const roleOptions = useMemo(() => {
    const set = new Set<string>(ROLE_OPTIONS);
    for (const r of Object.keys(promptByRole)) set.add(r);
    return [...set];
  }, [promptByRole]);

  const setOverride = useSyncMutate<SetArgs, SetResp>('hive.overrideSet', hiveOverrideSetRest);

  const saveProse = useCallback(
    async (md: string) => {
      if (!hive) return;
      try {
        await setOverride({ potSlug: hive, kind: 'prompt', name: role, value: md });
        toast.success(`Saved ${role} persona override`);
      } catch (e) {
        toast.error(`Couldn't save: ${e instanceof Error ? e.message : 'failed'}`);
      }
    },
    [hive, role, setOverride],
  );
  const clearProse = useCallback(async () => {
    if (!hive) return;
    try {
      await setOverride({ potSlug: hive, kind: 'prompt', name: role, value: '' });
      toast.success(`Cleared ${role} persona override`);
    } catch (e) {
      toast.error(`Couldn't clear: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }, [hive, role, setOverride]);

  const saveConfig = useCallback(
    async (value: unknown): Promise<SetResp> => {
      if (!hive) return { ok: false };
      try {
        const resp = await setOverride({ potSlug: hive, kind: 'config', name: section, value });
        toast.success(`Saved ${section} config`);
        return resp;
      } catch (e) {
        toast.error(`Couldn't save: ${e instanceof Error ? e.message : 'failed'}`);
        return { ok: false, error: e instanceof Error ? e.message : 'failed' };
      }
    },
    [hive, section, setOverride],
  );
  const clearConfig = useCallback(async () => {
    if (!hive) return;
    try {
      await setOverride({ potSlug: hive, kind: 'config', name: section, value: null });
      toast.success(`Cleared ${section} config`);
    } catch (e) {
      toast.error(`Couldn't clear: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }, [hive, section, setOverride]);

  const hiveOptions = useMemo(
    () => hives.map((h) => ({ value: h.slug, label: h.remote ? `${h.slug} (remote)` : h.slug })),
    [hives],
  );

  return (
    <div>
      <h1>{t('pot')} customization</h1>
      <p className="pc-settings-intro">
        Specialize a {t('pot', { lower: true })}'s agents for its domain without forking the shared blueprint. The {t('pot', { lower: true })}'s
        reusable blueprint personas stay generic; only this {t('pot', { lower: true })}'s deltas live here, and they federate
        to every node of a shared {t('pot', { lower: true })}. Two editors: a <strong>prose</strong> per-role persona delta,
        and a <strong>structured</strong> {t('scout', { lower: true })}-tuning config (which prose can't express).
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', marginBottom: 16, fontSize: 13 }}>
          Couldn't load this {t('pot', { lower: true })}'s overrides: {error.message}
        </p>
      )}

      <section className="pc-settings-section" aria-label={`${t('pot')} selector`} style={{ marginBottom: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ color: 'var(--fg-mute)' }}>{t('pot')}</span>
          <Select
            value={hive ?? ''}
            onChange={(v) => void setHive(v || null)}
            ariaLabel={t('pot')}
            options={
              hiveOptions.length > 0
                ? hiveOptions
                : [{ value: '', label: hivesLoading ? 'Loading…' : `No ${t('pot', { plural: true, lower: true })}`, disabled: true }]
            }
          />
        </label>
      </section>

      {!hive ? (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Pick a {t('pot', { lower: true })} to edit its per-instance overrides.
        </p>
      ) : (
        <>
          <section className="pc-settings-section" aria-label="Role persona override" style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Role persona (prose)</h2>
              <Select
                value={role}
                onChange={(v) => void setRole(v)}
                ariaLabel="Role"
                options={roleOptions.map((r) => ({
                  value: r,
                  label: promptByRole[r] ? `${roleLabel(r)} ●` : roleLabel(r),
                }))}
              />
            </div>
            <ProseOverrideEditor
              key={`${hive}:${role}`}
              initialValue={promptByRole[role] ?? ''}
              onSave={saveProse}
              onClear={clearProse}
            />
          </section>

          <section className="pc-settings-section" aria-label="Structured config override">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Structured config</h2>
              <Select
                value={section}
                onChange={(v) => void setSection(v)}
                ariaLabel="Config section"
                options={CONFIG_SECTIONS.map((s) => ({
                  value: s,
                  label: configBySection[s] != null
                    ? `${agentRoleLabel(s, t, { lower: true })} ●`
                    : agentRoleLabel(s, t, { lower: true }),
                }))}
              />
            </div>
            <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '0 0 10px' }}>
              {section === 'scout'
                ? `How this ${t('pot', { lower: true })}'s ${t('scout', { lower: true })} loop ideates, critiques, and routes — lenses, novelty/verdict thresholds, and routing. A partial override; omitted keys keep the engine default.`
                : 'JSON config delta for this section.'}
            </p>
            <ConfigOverrideEditor
              key={`${hive}:${section}`}
              section={section}
              initialValue={configBySection[section] ?? null}
              onSave={saveConfig}
              onClear={clearConfig}
            />
          </section>

          {/* EN-1: the owner-enforcement policy surface (claim-gated, signed + federated). */}
          <PotPolicyPanel key={`policy:${hive}`} hive={hive} />
        </>
      )}
    </div>
  );
}
