/**
 * Launch settings, in the goal detail popup (goal-mode-hardening-2026-08-10
 * P-005, editing P-004's store).
 *
 * WHY HERE. D-007: "Goal settings live in the goal detail popup, beside
 * Subdirectives" [owner, interactive: "I meant inside the conversation popup
 * where it currently shows SUBDIRECTIVES"] — explicitly NOT the left rail, whose
 * Goals tab the owner removed on 2026-08-09; restoring it would re-create the
 * two-boards duplication that cut.
 *
 * WHAT THESE NUMBERS ARE. D-004 removed the GOAL contract's "capacity preflight,
 * ramp one at a time" clause and told the goal agent to parallelize maximally
 * instead. That is only safe because D-005 replaced the preflight with two
 * BINDING ceilings the machine enforces. So this form is not a preferences pane:
 * it is the only place a human sets the number that stops a goal agent from
 * launching an unbounded fleet, which is why the ceilings sit first.
 *
 * EACH CEILING HAS THREE STATES, AND THE FORM MUST KEEP THEM APART (D-015).
 * Blank means "the owner has not pinned one" and resolves to the SYSTEM DEFAULT;
 * "No ceiling" is a deliberate opt-out; a number is that number. Before the
 * defaults existed, blank WAS unlimited and this file said so out loud. Now the
 * most dangerous state and the most common one would both render as an empty box,
 * so the opt-out gets its own control and every field states in words which of
 * the three it is currently in.
 *
 * WHY IT WRITES THROUGH goals:update. The same reasoning admin/goals.ts gives for
 * proxying rather than hand-writing: `goals:update` merges partial fields, so
 * saving settings cannot clear a kill criterion, and the route already
 * invalidates `goals.detail` + `goals.list` on success. A dedicated settings
 * endpoint would be a second write path to the one row whose state decides
 * whether a fleet runs.
 *
 * THE OPTION LISTS COME FROM THE SERVER (D-011). `agent`, `carry` and
 * `contextSize` are closed sets in `launchProfileSchema`, and this file
 * deliberately does not spell them: they arrive as `launchSettingsOptions`,
 * derived from the schema's own constants. A hand-spelled copy here would be the
 * measured failure that decision is about — a list that falls behind the registry
 * and offers a value the write refuses, or hides one it accepts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { toast } from 'sonner';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import type {
  GoalDetailLaunchDefaults,
  GoalDetailLaunchOptions,
  GoalDetailLaunchSettings,
} from './goal-detail-model';
import {
  ceilingHint,
  emptyRoleForm,
  formToSettings,
  isSettingsDirty,
  isUnlimited,
  settingsSummary,
  settingsToForm,
  GOAL_LAUNCH_ROLE_OPTIONS,
  PROFILE_CHOICE_FIELDS,
  PROFILE_FIELDS,
  PROFILE_FIELD_LABEL,
  UNLIMITED,
  type LaunchProfileForm,
  type LaunchRoleForm,
  type LaunchSettingsForm,
  type ProfileField,
} from './goal-launch-settings-model';

/* The stored value for "unset" is the empty string, but Radix Select THROWS on
   an Item whose value is '' (the wrapper drops such options defensively, which
   would silently swallow this one). So the empty string cannot be an option
   value, and it travels through the menu as this sentinel instead, mapped back
   on the way out.
   `placeholder` alone would not do: it only DISPLAYS the unset state, while the
   native <option value="">system default</option> this replaces was also how a
   user CLEARED a field they had already set. Dropping it would take that
   affordance away with no visible sign. */
const SYSTEM_DEFAULT_CHOICE = '__system_default__';

async function saveLaunchSettings(
  goalId: string,
  settings: GoalDetailLaunchSettings | null,
): Promise<void> {
  const res = await fetch('/api/admin/goals/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: goalId, launchSettings: settings }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON body — the status alone is what we have */
    }
    throw new Error(detail);
  }
  /* ⚠ 200 IS NOT SUCCESS ON ITS OWN. The route replies with the tool's result
     VERBATIM, and `goals:update` reports a failed settings write as
     `degraded: true` with the reason — precisely so a caller cannot render a
     ceiling as saved when it was not. Flattening that to "ok" here would
     re-create the bug that seam exists to prevent. */
  const body = (await res.json().catch(() => null)) as
    | { degraded?: boolean; degradedReasons?: string[] }
    | null;
  if (body?.degraded) {
    throw new Error(body.degradedReasons?.join('; ') || 'the write reported itself degraded');
  }
}

/**
 * One ceiling, with all three of its states reachable (D-015).
 *
 * A bare number input could only express two of them. Blank now means "use the
 * system default" and no-ceiling is an explicit choice, so the opt-out needs its
 * own control — and the hint line underneath has to say which of the three the
 * field is currently in, since the most dangerous state (deliberately unlimited)
 * and the most common one (unset) would otherwise both render as an empty box.
 */
function CeilingField({
  id,
  label,
  noun,
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** What the ceiling counts, for the hint sentence: "agents" / "agents per fleet". */
  noun: string;
  value: string;
  /** The system default this resolves to when blank. Absent on a pre-D-015 payload. */
  fallback: number | undefined;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const unlimited = isUnlimited(value);
  const hint = ceilingHint(value, fallback, noun);
  return (
    <div className="hud-goal__set-field">
      <label className="hud-goal__set-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="hud-goal__set-in"
        type="number"
        min={1}
        max={1000}
        step={1}
        /* An unlimited ceiling shows an EMPTY number box (it cannot hold the
           word), which is why the checkbox beside it carries the state and the
           hint says so in words. */
        value={unlimited ? '' : value}
        disabled={disabled || unlimited}
        placeholder={fallback == null ? '' : String(fallback)}
        onChange={(e) => onChange(e.target.value)}
      />
      <label className="hud-goal__set-check" htmlFor={`${id}-unlimited`}>
        {/* The shared primitive, not a native <input type="checkbox"> — that is
            an ENFORCED design lint here, not a preference. */}
        <Checkbox
          id={`${id}-unlimited`}
          checked={unlimited}
          disabled={disabled}
          ariaLabel={`${label}: no ceiling`}
          /* Unchecking returns the field to BLANK, not to a number: the owner
             has expressed "not unlimited", not "this specific ceiling". Blank
             then resolves to the system default, which is the safe landing. */
          onChange={(next) => onChange(next ? UNLIMITED : '')}
        />
        <span>No ceiling</span>
      </label>
      {hint ? <p className="hud-goal__set-hint">{hint}</p> : null}
    </div>
  );
}

function ProfileFields({
  idPrefix,
  value,
  options,
  disabled,
  onChange,
}: {
  idPrefix: string;
  value: LaunchProfileForm;
  options: GoalDetailLaunchOptions | null | undefined;
  disabled: boolean;
  onChange: (field: ProfileField, next: string) => void;
}) {
  return (
    <div className="hud-goal__set-grid">
      {PROFILE_FIELDS.map((field) => {
        const id = `${idPrefix}-${field}`;
        // Indexed by `keyof GoalDetailLaunchOptions` rather than a re-spelled
        // union of field names: the previous hardcoded list silently omitted any
        // choice field added later, which is the panel-vs-validator drift D-011
        // is about, expressed as a cast instead of as a copied array.
        const choices = PROFILE_CHOICE_FIELDS.has(field)
          ? (options?.[field as keyof GoalDetailLaunchOptions] ?? null)
          : null;
        return (
          <label key={field} className="hud-goal__set-field" htmlFor={id}>
            <span className="hud-goal__set-label">{PROFILE_FIELD_LABEL[field]}</span>
            {/* A closed-set field falls back to free text when the payload did
                not carry its options, rather than rendering an empty select the
                owner cannot use. Degraded, but still editable — and it cannot
                offer a wrong value, since the server validates either way. */}
            {choices && choices.length ? (
              <Select
                id={id}
                className="hud-goal__set-in"
                value={value[field] === '' ? SYSTEM_DEFAULT_CHOICE : value[field]}
                disabled={disabled}
                placeholder="system default"
                onChange={(next: string) =>
                  onChange(field, next === SYSTEM_DEFAULT_CHOICE ? '' : next)
                }
                options={[
                  { value: SYSTEM_DEFAULT_CHOICE, label: 'system default' },
                  ...choices.map((c) => ({ value: c, label: c })),
                ]}
              />
            ) : (
              <input
                id={id}
                className="hud-goal__set-in"
                value={value[field]}
                disabled={disabled}
                placeholder="system default"
                maxLength={120}
                onChange={(e) => onChange(field, e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function GoalSettingsSection({
  goalId,
  settings,
  settingsInvalid,
  settingsUnknownKeys,
  options,
  defaults,
}: {
  goalId: string;
  /** Null = nothing pinned, which since D-015 means the SYSTEM DEFAULT ceilings
   *  apply — not that the goal is ungoverned. NOT an error either way. */
  settings: GoalDetailLaunchSettings | null | undefined;
  /** Non-null = the stored document is unreadable, so NO ceiling is in force. */
  settingsInvalid?: string | null;
  /** WI-2140573: dotted paths the server STRIPPED as unknown on read. Every
   *  other key is in force; these bind nothing on that server. */
  settingsUnknownKeys?: string[] | null;
  options?: GoalDetailLaunchOptions | null;
  /** What an unpinned ceiling resolves to, from the server (D-015). Absent on a
   *  payload that predates it — the editor then says nothing about defaults
   *  rather than printing a number it would have to keep in step by hand. */
  defaults?: GoalDetailLaunchDefaults | null;
}) {
  // Expansion state in the URL, per the repo's nuqs rule — which also makes the
  // editor reachable from the agent → UI control surface, since anything in
  // useState is invisible to `ui:get_state` / `ui:dispatch`.
  const [open, setOpen] = useQueryState('goalSettings', parseAsBoolean.withDefault(false));
  const [form, setForm] = useState<LaunchSettingsForm>(() => settingsToForm(settings));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  /* TWO DIFFERENT QUESTIONS, AND CONFLATING THEM BREAKS THE RE-SYNC BELOW.
     `dirty` asks "does the form differ from what is STORED" — that is what the
     Save button is for. `edited` asks "has the owner typed since we loaded this
     form", measured against the document we last loaded FROM. They come apart
     exactly when the server changes underneath an untouched form: `dirty` goes
     true because the stored document moved, not because anyone typed. Guarding
     the re-sync on `dirty` therefore treats every external change as an edit in
     progress and the form never updates again. */
  const dirty = useMemo(() => isSettingsDirty(form, settings ?? null), [form, settings]);
  const syncedRef = useRef<GoalDetailLaunchSettings | null>(settings ?? null);
  const edited = useMemo(() => isSettingsDirty(form, syncedRef.current), [form]);

  /* RE-SYNC FROM THE SERVER, BUT NEVER OVER AN EDIT IN PROGRESS. `goals.detail`
     re-pulls on every invalidation — including ones this popup did not cause —
     so without this the form would keep showing a stale document after someone
     else changed it. The opposite failure is worse, which is why an edit wins:
     re-initialising mid-edit would delete what the owner is typing.

     `!dirty` is the second way in, and it is what un-sticks the form after our
     OWN save: the form then already equals the incoming document, so adopting
     it changes nothing on screen but advances the ref — without it, `edited`
     would stay true against a stale ref forever and later external changes
     would never land. */
  useEffect(() => {
    const incoming = settings ?? null;
    if (JSON.stringify(incoming) === JSON.stringify(syncedRef.current)) return;
    if (edited && dirty) return;
    syncedRef.current = incoming;
    setForm(settingsToForm(incoming));
    setProblems([]);
  }, [settings, edited, dirty]);

  const setDefaultsField = useCallback((field: ProfileField, next: string) => {
    setForm((f) => ({ ...f, defaults: { ...f.defaults, [field]: next } }));
  }, []);

  const setRoleField = useCallback((key: string, field: ProfileField | 'role', next: string) => {
    setForm((f) => ({
      ...f,
      roles: f.roles.map((r) => (r.key === key ? { ...r, [field]: next } : r)),
    }));
  }, []);

  const addRole = useCallback(() => {
    setForm((f) => ({ ...f, roles: [...f.roles, emptyRoleForm()] }));
  }, []);

  const removeRole = useCallback((key: string) => {
    setForm((f) => ({ ...f, roles: f.roles.filter((r) => r.key !== key) }));
  }, []);

  const reset = useCallback(() => {
    setForm(settingsToForm(settings));
    setProblems([]);
  }, [settings]);

  const save = useCallback(async () => {
    if (busy) return;
    const { settings: doc, problems: found } = formToSettings(form);
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      await saveLaunchSettings(goalId, doc);
      // No local cache write: the route invalidates goals.detail server-side, so
      // the re-sync above pulls the stored document back and the form ends up
      // showing what was actually persisted rather than what we sent.
      toast.success(doc ? 'Launch settings saved' : 'Launch settings cleared');
    } catch (e) {
      toast.error('Could not save launch settings', { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, form, goalId]);

  const summary = settingsSummary(settings, defaults);

  return (
    <section className="hud-goal__section" data-testid="goal-settings-section">
      <h3 className="pc-zone-title">
        Launch settings
        <button
          type="button"
          className="hud-goal__set-toggle"
          aria-expanded={open}
          onClick={() => void setOpen(open ? null : true)}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </h3>

      {/* The ceilings restated as a sentence, because a number in a form field
          does not say what it governs — and this one governs whether the agent
          may keep launching. */}
      <p className="hud-goal__note">
        What this goal’s agent may launch. The ceilings count EVERY live session on the goal, fleet
        members included, and a launch that would breach one is refused. Leave a ceiling blank to
        use the system default; tick “No ceiling” to let this goal run unbounded.
      </p>

      {settingsInvalid ? (
        /* Not folded into "no settings": an unreadable document means the
           owner's ceiling is NOT being enforced, and the two states look
           identical while meaning opposite things. Saying so is the whole
           point — see the store's fail-open note. */
        <p className="hud-goal__set-alarm" data-testid="goal-settings-invalid">
          ⚠ The stored launch settings could not be read, so <strong>no ceiling is in force</strong>.
          Saving below replaces the unreadable document. ({settingsInvalid})
        </p>
      ) : null}

      {settingsUnknownKeys && settingsUnknownKeys.length > 0 ? (
        /* WI-2140573: the server read the document leniently — every KNOWN key
           is in force and these were stripped. They must never render as
           configured: a key that binds nothing is exactly the state the strict
           schema exists to prevent. */
        <p className="hud-goal__set-alarm" data-testid="goal-settings-unknown-keys">
          ⚠ Not recognised by the server, so <strong>not in force</strong>:{' '}
          {settingsUnknownKeys.join(', ')}. Every other setting applies. Usually the server is older
          than the schema that wrote the key (a deploy or restart clears this); otherwise it is a typo.
          Saving below writes the settings shown here and drops the unrecognised keys.
        </p>
      ) : null}

      {!open ? (
        <p className="hud-goal__set-summary" data-testid="goal-settings-summary">
          {summary}
        </p>
      ) : (
        <div className="hud-goal__set">
          <div className="hud-goal__set-grid">
            <CeilingField
              id={`gs-${goalId}-maxAgents`}
              label="Max agents"
              noun="agents"
              value={form.maxAgents}
              fallback={defaults?.maxAgents}
              disabled={busy}
              onChange={(next) => setForm((f) => ({ ...f, maxAgents: next }))}
            />
            <CeilingField
              id={`gs-${goalId}-maxPerFleet`}
              label="Max per fleet"
              noun="agents in any one fleet"
              value={form.maxPerFleet}
              fallback={defaults?.maxPerFleet}
              disabled={busy}
              onChange={(next) => setForm((f) => ({ ...f, maxPerFleet: next }))}
            />
            <div className="hud-goal__set-field">
              <label className="hud-goal__set-label" htmlFor={`gs-${goalId}-intendedParallelPlanFleets`}>
                Concurrent plan fleets intended
              </label>
              <input
                id={`gs-${goalId}-intendedParallelPlanFleets`}
                className="hud-goal__set-in"
                type="number"
                min={1}
                max={100}
                step={1}
                value={form.intendedParallelPlanFleets}
                disabled={busy}
                onChange={(event) => setForm((f) => ({ ...f, intendedParallelPlanFleets: event.target.value }))}
              />
              <span className="hud-goal__set-hint">The holder's chosen number of concurrent plan fleets. The agent ceilings still limit each launch.</span>
            </div>
          </div>

          <h4 className="hud-goal__set-h">Default launch profile</h4>
          <p className="hud-goal__note">
            Applied to every agent this goal launches. A launch that asks for something specific
            still wins — these are the goal’s standing policy, not an override.
          </p>
          <ProfileFields
            idPrefix={`gs-${goalId}-def`}
            value={form.defaults}
            options={options}
            disabled={busy}
            onChange={setDefaultsField}
          />

          <h4 className="hud-goal__set-h">Per-role profiles</h4>
          <p className="hud-goal__note">
            Override the defaults for one launch slot — the JOB an agent is launched to do, not its
            psu persona. More specific than the defaults, less than what a launch explicitly asks
            for.
          </p>
          {form.roles.length === 0 ? (
            <p className="hud-goal__empty">No per-role profiles — every role uses the defaults.</p>
          ) : (
            form.roles.map((r: LaunchRoleForm) => (
              <div key={r.key} className="hud-goal__set-role">
                <div className="hud-goal__set-rolehead">
                  <label className="hud-goal__set-field" htmlFor={`gs-${goalId}-${r.key}-role`}>
                    <span className="hud-goal__set-label">Role</span>
                    {/*
                      D-016 (WI-38048): a SELECT, not a text box. These keys are a
                      closed contract vocabulary; the old free-text field invited
                      a psu persona (its placeholder read “e.g. engineer”), which
                      is not a launch slot and bound nothing.
                      A stored doc written before the vocabulary closed can still
                      carry such a value, so an unrecognised one is kept as a
                      disabled option rather than silently re-pointed at a real
                      slot the owner never chose — it stays visible, and
                      `formToSettings` refuses it by name on save.
                    */}
                    <Select
                      id={`gs-${goalId}-${r.key}-role`}
                      className="hud-goal__set-in"
                      value={r.role}
                      disabled={busy}
                      onChange={(value) => setRoleField(r.key, 'role', value)}
                      placeholder="Choose a launch slot…"
                      options={[
                        ...(r.role && !GOAL_LAUNCH_ROLE_OPTIONS.some((o) => o.value === r.role)
                          ? [{ value: r.role, label: `${r.role} (not a launch slot)`, disabled: true }]
                          : []),
                        ...GOAL_LAUNCH_ROLE_OPTIONS,
                      ]}
                    />
                  </label>
                  <button
                    type="button"
                    className="hud-goal__set-remove"
                    disabled={busy}
                    onClick={() => removeRole(r.key)}
                    aria-label={`Remove role profile ${r.role || '(unnamed)'}`}
                  >
                    Remove
                  </button>
                </div>
                <ProfileFields
                  idPrefix={`gs-${goalId}-${r.key}`}
                  value={r}
                  options={options}
                  disabled={busy}
                  onChange={(field, next) => setRoleField(r.key, field, next)}
                />
              </div>
            ))
          )}
          <button type="button" className="hud-goal__set-add" disabled={busy} onClick={addRole}>
            Add role profile
          </button>

          {problems.length ? (
            <ul className="hud-goal__set-problems" data-testid="goal-settings-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}

          <div className="hud-goal__set-actions">
            <button
              type="button"
              className="hud-goal__addsub-go"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save settings'}
            </button>
            <button
              type="button"
              className="hud-goal__set-remove"
              disabled={busy || !dirty}
              onClick={reset}
            >
              Revert
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
