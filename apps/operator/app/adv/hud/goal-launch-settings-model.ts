/**
 * The goal launch-settings editor's model — form state in, a settings DOCUMENT
 * out (goal-mode-hardening-2026-08-10 P-005, editing P-004's store per D-009).
 *
 * WHY A MODEL FILE AND NOT STATE INSIDE THE COMPONENT. What this form produces is
 * validated server-side by `goalLaunchSettingsSchema`, which is `.strict()` on
 * both levels — so the conversion from "what the owner typed" to "what the store
 * accepts" is the part that can be WRONG, and it is the part a component test can
 * only reach through the DOM. Every rule below (blank means absent, not empty
 * string; a role with no pinned keys is not a role; a duplicate role name is a
 * silent overwrite) is a defect that would otherwise present as "the setting I
 * typed did not take effect" with nothing failing.
 *
 * ABSENT, NOT EMPTY. The store's own docblock explains why the schema is strict:
 * "a typo'd key that is silently accepted reads back as 'the setting is there'
 * while the launch ignores it". The same trap exists one level down for VALUES —
 * `{ model: '' }` is a pinned model of empty string, which `foldLaunchProfile`
 * would skip but which reads back into this form as a value the owner set. So a
 * blank input emits NO KEY, and a profile with no keys emits no profile.
 */

// WI-39514: import from the CLIENT-SAFE shared module, never from
// `goal-launch-settings` itself — that one value-imports `@papercusp/db-org`,
// whose chain reaches `embedded-pg-discovery` -> `node:path`, which is a
// throwing stub in the browser and white-screened this whole route.
import {
  GOAL_LAUNCH_ROLES,
  isGoalLaunchRole,
  type GoalLaunchRole,
} from '@papercusp/operator-core/lib/goal-launch-settings-shared';

import type {
  GoalDetailLaunchDefaults,
  GoalDetailLaunchProfile,
  GoalDetailLaunchSettings,
} from './goal-detail-model';

/**
 * The explicit "no ceiling" value, matching the server's `UNLIMITED_CEILING`.
 *
 * The one string this file spells that the server also spells. It is a wire
 * CONSTANT, not a closed set the way the profile options are, so shipping it in
 * the payload would be ceremony — but it is pinned by
 * `goal-launch-settings-unlimited-literal.test.ts`, which compares the two
 * spellings directly, so a rename on either side fails rather than silently
 * producing a form value the validator rejects.
 */
export const UNLIMITED = 'unlimited';

/** One profile's fields, as the form holds them: strings, blank for unset. */
export interface LaunchProfileForm {
  agent: string;
  model: string;
  effort: string;
  account: string;
  carry: string;
  /**
   * `''` (unpinned) | `'headless'` | `'headed'` — the members of
   * LAUNCH_PROFILE_HEADLESS, not stringly booleans.
   *
   * A STRING here even though the document stores a boolean: the form is
   * uniformly string-valued so one loop can render and diff every field, and
   * blank has to stay a distinct third state (D-002). Converted at the boundary
   * by profileToForm / formToProfile.
   */
  headless: string;
  contextSize: string;
  /**
   * WI-2140338: the compaction ceiling in tokens, held as a STRING like every
   * other field (blank = unpinned) and parsed at the boundary by
   * formToProfile — the second key the document stores as a non-string.
   */
  compactionLimit: string;
}

export interface LaunchRoleForm extends LaunchProfileForm {
  /** Stable across edits so React keys survive renaming a role. */
  key: string;
  role: string;
}

export interface LaunchSettingsForm {
  maxAgents: string;
  maxPerFleet: string;
  intendedParallelPlanFleets: string;
  defaults: LaunchProfileForm;
  roles: LaunchRoleForm[];
}

export const EMPTY_PROFILE_FORM: LaunchProfileForm = {
  agent: '',
  model: '',
  effort: '',
  account: '',
  carry: '',
  headless: '',
  contextSize: '',
  compactionLimit: '',
};

/** The profile keys, in the order the form renders them. */
export const PROFILE_FIELDS = [
  'agent',
  'model',
  'effort',
  'account',
  'carry',
  'headless',
  'contextSize',
  'compactionLimit',
] as const;

/**
 * The schema's bounds on `compactionLimit`, restated here so the form can refuse
 * an out-of-range value with a sentence instead of a zod path. PINNED, not
 * derived: `goal-launch-settings-model.test.ts` probes `launchProfileSchema` at
 * each edge, so a bound moved on the server fails there rather than shipping a
 * form that accepts what the save refuses.
 */
export const COMPACTION_LIMIT_MIN = 50_000;
export const COMPACTION_LIMIT_MAX = 2_000_000;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Which profile fields are closed sets (rendered as a select) vs free text. */
export const PROFILE_CHOICE_FIELDS: ReadonlySet<ProfileField> = new Set<ProfileField>([
  'agent',
  'carry',
  'contextSize',
  'headless',
]);

export const PROFILE_FIELD_LABEL: Record<ProfileField, string> = {
  agent: 'Agent',
  model: 'Model',
  effort: 'Effort',
  account: 'Account',
  carry: 'Carry',
  headless: 'Window',
  contextSize: 'Context',
  compactionLimit: 'Token ceiling',
};

/**
 * D-016 (WI-38048): the role field is a CLOSED set, so the form renders it as a
 * select — never free text.
 *
 * This is the UI half of that ruling, and without it the server half is a
 * regression rather than a fix: `roles` is now keyed by the launch-slot
 * vocabulary, so a hand-typed name is REFUSED by the schema. Before, the same
 * typed name was accepted and bound nothing — the failure the ruling exists to
 * kill — but an owner who can only reach the setting through a text box with no
 * way to discover the eight legal values has simply traded a silent
 * mis-binding for an unexplained save error. A select makes the vocabulary the
 * only thing you can express.
 *
 * `Record<GoalLaunchRole, …>` is deliberately exhaustive: any slot added to
 * `GOAL_LAUNCH_ROLES` fails THIS typecheck until it is given a label, so the
 * picker cannot silently fall behind the contract it is supposed to present.
 * That guard has now fired once in earnest — P-005's four paired slots landed
 * here because this Record refused to compile without them.
 */
export const GOAL_LAUNCH_ROLE_LABEL: Record<GoalLaunchRole, string> = {
  goal: 'Goal agent (the goal’s own driver)',
  'plan-fleet-leader': 'Plan fleet — leader',
  'plan-fleet-member': 'Plan fleet — member',
  // The paired slots (P-005). They apply only when the goal's `fleetType` is
  // 'paired'; the labels say "paired" so the picker cannot read as though a
  // single fleet has directors sitting unused alongside its members.
  'plan-fleet-director': 'Plan fleet — director (paired)',
  'plan-fleet-implementer': 'Plan fleet — implementer (paired)',
  'drain-fleet-leader': 'Drain fleet — leader',
  'drain-fleet-member': 'Drain fleet — member',
  'drain-fleet-director': 'Drain fleet — director (paired)',
  'drain-fleet-implementer': 'Drain fleet — implementer (paired)',
  grading: 'Grading',
  test: 'Test',
  misc: 'Misc',
};

/** The slots the picker offers, in contract order. */
export const GOAL_LAUNCH_ROLE_OPTIONS: readonly { value: GoalLaunchRole; label: string }[] =
  GOAL_LAUNCH_ROLES.map((value) => ({ value, label: GOAL_LAUNCH_ROLE_LABEL[value] }));

let roleKeySeq = 0;
function nextRoleKey(): string {
  roleKeySeq += 1;
  return `role-${roleKeySeq}`;
}

function profileToForm(p: GoalDetailLaunchProfile | null | undefined): LaunchProfileForm {
  return {
    agent: p?.agent ?? '',
    model: p?.model ?? '',
    effort: p?.effort ?? '',
    account: p?.account ?? '',
    carry: p?.carry ?? '',
    // `== null` and NOT `?? ''`: `false` is a PINNED value the owner chose
    // ("headed"), and collapsing it to blank would silently demote a deliberate
    // setting back to unpinned. Spelled explicitly so the three states stay
    // visibly three.
    headless: p?.headless == null ? '' : p.headless ? 'headless' : 'headed',
    contextSize: p?.contextSize ?? '',
    compactionLimit: p?.compactionLimit == null ? '' : String(p.compactionLimit),
  };
}

export function emptyRoleForm(): LaunchRoleForm {
  return { key: nextRoleKey(), role: '', ...EMPTY_PROFILE_FORM };
}

/**
 * The stored document as the form holds it.
 *
 * A NULL document and an EMPTY one produce the same form on purpose: both mean
 * "nothing pinned", and there is no edit that distinguishes them. The difference
 * only matters on the way OUT, where an all-blank form clears the column rather
 * than storing `{}`.
 */
export function settingsToForm(s: GoalDetailLaunchSettings | null | undefined): LaunchSettingsForm {
  return {
    maxAgents: s?.maxAgents == null ? '' : String(s.maxAgents),
    maxPerFleet: s?.maxPerFleet == null ? '' : String(s.maxPerFleet),
    intendedParallelPlanFleets: s?.intendedParallelPlanFleets == null ? '' : String(s.intendedParallelPlanFleets),
    defaults: profileToForm(s?.defaults),
    roles: Object.entries(s?.roles ?? {}).map(([role, p]) => ({
      key: nextRoleKey(),
      role,
      ...profileToForm(p),
    })),
  };
}

/**
 * The compaction ceiling, parsed the way `launchProfileSchema` will judge it:
 * blank omits the key; anything else must be a whole number of tokens inside
 * the schema's bounds, or it comes back as a PROBLEM the owner can act on.
 */
function parseCompactionLimit(raw: string, label: string): { value?: number; problem?: string } {
  const t = raw.trim();
  if (!t) return {};
  if (!/^\d+$/.test(t)) return { problem: `${label} must be a whole number of tokens.` };
  const n = Number(t);
  if (n < COMPACTION_LIMIT_MIN || n > COMPACTION_LIMIT_MAX) {
    return {
      problem: `${label} must be between ${COMPACTION_LIMIT_MIN} and ${COMPACTION_LIMIT_MAX} tokens.`,
    };
  }
  return { value: n };
}

interface ProfileResult {
  profile: GoalDetailLaunchProfile | null;
  /** Non-empty means the profile is unsaveable as typed; shown verbatim. */
  problems: string[];
}

function formToProfile(f: LaunchProfileForm, label: string): ProfileResult {
  const out: Record<string, string | boolean | number> = {};
  const problems: string[] = [];
  for (const k of PROFILE_FIELDS) {
    const v = f[k].trim();
    // Blank emits NO KEY — see the file docblock. `{ model: '' }` would read
    // back as a pinned value while pinning nothing.
    if (!v) continue;
    if (k === 'compactionLimit') {
      // The second non-string key: an integer in the document. Refused here
      // for the cases the owner can fix by looking at the field, so the save
      // never fails with a zod path the owner has to decode.
      const parsed = parseCompactionLimit(v, `${label} ${PROFILE_FIELD_LABEL[k].toLowerCase()}`);
      if (parsed.problem) problems.push(parsed.problem);
      else if (parsed.value !== undefined) out[k] = parsed.value;
      continue;
    }
    // `headless` is the one key stored as a boolean (it matches the fleet
    // layer's spelling). Emitting the STRING here would be the worst outcome
    // available: `.strict()` rejects the save outright, or — if it ever slipped
    // through — every non-empty string is truthy, so "headed" would read back
    // as headless and mean the exact opposite of what the owner picked.
    out[k] = k === 'headless' ? v === 'headless' : v;
  }
  return {
    profile: Object.keys(out).length ? (out as GoalDetailLaunchProfile) : null,
    problems,
  };
}

/**
 * A ceiling field, parsed the way the schema will judge it.
 *
 * THREE outcomes, because the field has three meanings (D-015):
 *   blank        → `undefined`, the key is omitted → the SYSTEM DEFAULT applies
 *   'unlimited'  → the explicit opt-out → no ceiling enforced
 *   a number     → that ceiling
 *
 * Blank stopped meaning "unlimited" when the defaults landed, and the two states
 * now sit at opposite ends of the same field — so they must not collapse. That is
 * why no-ceiling is a value the form carries rather than the absence of one.
 *
 * A PROBLEM comes back for anything the schema would reject, rather than sending
 * it and letting the save fail with a zod message the owner has to decode. `0` is
 * rejected explicitly: it is the one wrong value that looks deliberate, and it
 * would mean "this goal may run no agents at all".
 */
function parseCeiling(raw: string, label: string): { value?: number | typeof UNLIMITED; problem?: string } {
  const t = raw.trim();
  if (!t) return {};
  if (t.toLowerCase() === UNLIMITED) return { value: UNLIMITED };
  if (!/^\d+$/.test(t)) return { problem: `${label} must be a whole number, or “${UNLIMITED}”.` };
  const n = Number(t);
  if (n < 1) return { problem: `${label} must be at least 1 — 0 would forbid every launch.` };
  if (n > 1000) return { problem: `${label} may not exceed 1000.` };
  return { value: n };
}

function parseIntendedPlanFleets(raw: string): { value?: number; problem?: string } {
  const text = raw.trim();
  if (!text) return {};
  if (!/^\d+$/.test(text)) return { problem: 'Concurrent plan fleets must be a whole number.' };
  const value = Number(text);
  if (value < 1 || value > 100) return { problem: 'Concurrent plan fleets must be between 1 and 100.' };
  return { value };
}

/** Is this ceiling field currently set to the explicit no-ceiling? */
export function isUnlimited(raw: string): boolean {
  return raw.trim().toLowerCase() === UNLIMITED;
}

/**
 * What one ceiling field resolves to, said in words for the owner.
 *
 * The editor's job here is to make a BLANK field legible. Blank is the state an
 * owner is most likely to misread — it looks like nothing is in force, and since
 * D-015 it is the state where the system's own number is.
 */
export function ceilingHint(
  raw: string,
  fallback: number | undefined,
  noun: string,
): string {
  if (isUnlimited(raw)) return `No ceiling — this goal may run unlimited ${noun}.`;
  const t = raw.trim();
  if (t) return '';
  return fallback == null ? '' : `Unset — the system default of ${fallback} applies.`;
}

export interface SettingsDocumentResult {
  /** The document to save. `null` CLEARS the goal's settings back to unlimited. */
  settings: GoalDetailLaunchSettings | null;
  /** Non-empty means do not save — each string is shown to the owner verbatim. */
  problems: string[];
}

/**
 * Form → the document the store will accept, or the problems that stop it.
 *
 * Refuses locally for the cases the owner can fix by looking at the form (a
 * non-numeric ceiling, an unnamed role, two roles with the same name). Everything
 * else is left to the server schema, which is the authority — this is a
 * first-pass filter, deliberately not a second copy of the validation.
 */
export function formToSettings(form: LaunchSettingsForm): SettingsDocumentResult {
  const problems: string[] = [];
  const doc: Record<string, unknown> = {};

  const maxAgents = parseCeiling(form.maxAgents, 'Max agents');
  if (maxAgents.problem) problems.push(maxAgents.problem);
  else if (maxAgents.value !== undefined) doc.maxAgents = maxAgents.value;

  const maxPerFleet = parseCeiling(form.maxPerFleet, 'Max per fleet');
  if (maxPerFleet.problem) problems.push(maxPerFleet.problem);
  else if (maxPerFleet.value !== undefined) doc.maxPerFleet = maxPerFleet.value;

  const intendedPlanFleets = parseIntendedPlanFleets(form.intendedParallelPlanFleets);
  if (intendedPlanFleets.problem) problems.push(intendedPlanFleets.problem);
  else if (intendedPlanFleets.value !== undefined) doc.intendedParallelPlanFleets = intendedPlanFleets.value;

  const defaults = formToProfile(form.defaults, 'Default');
  problems.push(...defaults.problems);
  if (defaults.profile) doc.defaults = defaults.profile;

  const roles: Record<string, GoalDetailLaunchProfile> = {};
  const seen = new Set<string>();
  for (const r of form.roles) {
    const role = r.role.trim();
    const parsedProfile = formToProfile(r, role ? `Role “${role}”` : 'Role');
    problems.push(...parsedProfile.problems);
    const profile = parsedProfile.profile;
    // A row the owner started and abandoned is not an error — it is nothing.
    if (!role && !profile) continue;
    if (!role) {
      problems.push('A role profile has no role name.');
      continue;
    }
    if (!profile) {
      // A row whose only filled field was REFUSED already has its problem
      // listed; "pins no settings" on top would tell the owner to fill a field
      // they just filled.
      if (parsedProfile.problems.length) continue;
      // Named but pinning nothing. Silently dropping it would leave the owner
      // looking at a row that vanishes on save with no explanation.
      problems.push(`Role “${role}” pins no settings — fill a field or remove the row.`);
      continue;
    }
    if (seen.has(role)) {
      // Object keys collapse, so the later row would silently overwrite the
      // earlier one and the owner would see one row where they typed two.
      problems.push(`Role “${role}” appears twice.`);
      continue;
    }
    if (!isGoalLaunchRole(role)) {
      // D-016 (WI-38048): the server schema refuses an unknown key, so without
      // this the owner's only signal is a raw validation error naming a zod
      // path. Documents written before the vocabulary closed can also carry a
      // free-text key (a psu persona like `engineer`), and they load into this
      // form — so this refusal is reachable from a stored doc, not just from a
      // fresh typo, and it has to name the legal values to be actionable.
      problems.push(
        `Role “${role}” is not a launch slot. Pick one of: ${GOAL_LAUNCH_ROLES.join(', ')}.`,
      );
      continue;
    }
    seen.add(role);
    roles[role] = profile;
  }
  if (Object.keys(roles).length) doc.roles = roles;

  if (problems.length) return { settings: null, problems };
  // Nothing pinned at all → clear the column rather than storing `{}`, so
  // "no settings" is one state in the database instead of two.
  return { settings: Object.keys(doc).length ? (doc as GoalDetailLaunchSettings) : null, problems: [] };
}

/**
 * Whether the form differs from what is stored.
 *
 * Compared as DOCUMENTS, not as form fields: re-typing a value that was already
 * there, or adding then clearing a field, is not a change, and a Save button lit
 * by keystrokes rather than by difference invites a pointless write on every
 * visit. Invalid input counts as dirty so the owner can still press Save and be
 * told what is wrong.
 */
export function isSettingsDirty(
  form: LaunchSettingsForm,
  stored: GoalDetailLaunchSettings | null | undefined,
): boolean {
  const next = formToSettings(form);
  if (next.problems.length) return true;
  return stableJson(next.settings) !== stableJson(stored ?? null);
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return val as unknown;
  });
}

/**
 * The one-line summary the section header shows when the editor is collapsed.
 *
 * Says what is IN FORCE, not how many keys are set: "3 agents max" is the fact
 * the owner came to check.
 *
 * THE THREE STATES STAY DISTINGUISHABLE HERE (D-015), because this line is the
 * only one most visits read. An unpinned ceiling reports the system default it
 * resolves to and says it is a default; a deliberately ungoverned goal reports
 * "No agent ceiling". Collapsing those two — which is what this said before the
 * defaults existed — would print the same words for a goal the system is holding
 * at 12 and a goal running unbounded.
 */
export function settingsSummary(
  s: GoalDetailLaunchSettings | null | undefined,
  defaults?: GoalDetailLaunchDefaults | null,
): string {
  const parts: string[] = [];
  const agents = s?.maxAgents;
  if (agents === UNLIMITED) parts.push('No agent ceiling');
  else if (typeof agents === 'number') parts.push(`Max ${agents} agent${agents === 1 ? '' : 's'}`);
  else if (defaults) parts.push(`Max ${defaults.maxAgents} agents (default)`);
  else parts.push('Agent ceiling unset');

  const perFleet = s?.maxPerFleet;
  if (perFleet === UNLIMITED) parts.push('no fleet ceiling');
  else if (typeof perFleet === 'number') parts.push(`${perFleet}/fleet`);
  else if (defaults) parts.push(`${defaults.maxPerFleet}/fleet (default)`);

  if (s?.intendedParallelPlanFleets != null) {
    parts.push(`${s.intendedParallelPlanFleets} concurrent plan fleet${s.intendedParallelPlanFleets === 1 ? '' : 's'} intended`);
  } else {
    parts.push('Plan fleet width undecided');
  }

  const pinned = s?.defaults ? Object.keys(s.defaults).length : 0;
  if (pinned) parts.push(`${pinned} default${pinned === 1 ? '' : 's'}`);
  const roles = s?.roles ? Object.keys(s.roles).length : 0;
  if (roles) parts.push(`${roles} role profile${roles === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
