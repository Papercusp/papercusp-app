/**
 * Operational briefs — a shared PROJECTION convention, not a store.
 *
 * Plan use-existing-router-for-review-requests-2026-09-08, D-008 / D-009:
 * where an agent or owner waits across turns on an asynchronous lifecycle
 * (a review, a plan, a work-item, a deploy/gate, a materially blocking
 * lock/await), give them a fleet-brief-style view projected from that
 * surface's EXISTING durable state. There is deliberately no brief table and
 * no duplicated lifecycle state: every surface builds its brief at read time
 * from records it already owns, through this one shape.
 *
 * Missing-data honesty is the load-bearing rule. A field the source did not
 * measure is `{ status: 'unknown', reason }`, never a default: an empty
 * blocker list, a zero count or a null owner are all confident CLAIMS, and a
 * reader cannot tell "measured, none" from "not measured" unless the shape
 * keeps them apart. `unknowns` lists every unknown field by path so a reader
 * scanning the brief sees the gaps without walking the object.
 */

export const OPERATIONAL_BRIEF_SCHEMA = 'operational-brief-v1' as const;

export type OperationalBriefSurface = 'review-wait' | 'plan' | 'work-item' | 'gate-wait' | 'lock-wait' | 'await-wait';

/** A measured value with the source that measured it, or an explicit gap. */
export type BriefField<T> =
  | { status: 'known'; value: T; source: string }
  | { status: 'unknown'; reason: string };

export function known<T>(value: T, source: string): BriefField<T> {
  return { status: 'known', value, source };
}

export function unknown<T = never>(reason: string): BriefField<T> {
  return { status: 'unknown', reason };
}

export function isBriefField(value: unknown): value is BriefField<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  if (status === 'known') return 'value' in value && typeof (value as { source?: unknown }).source === 'string';
  if (status === 'unknown') return typeof (value as { reason?: unknown }).reason === 'string';
  return false;
}

export interface BriefVerifiedEvidence {
  ref: string;
  at: string | null;
  summary: string;
}

export interface OperationalBrief<Facts extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: typeof OPERATIONAL_BRIEF_SCHEMA;
  surface: OperationalBriefSurface;
  /** Exact subject identity (plan slug, work-item id, gate name, lock/await key). */
  subject: string;
  /** Current state/phase in the surface's own vocabulary. */
  state: BriefField<string>;
  /** Who holds or owns the lifecycle; a known `null` means measured-unowned. */
  owner: BriefField<string | null>;
  /** The single next action a waiting reader should take. */
  nextAction: BriefField<string>;
  /** Measured blockers; a known empty list means measured-none. */
  blockers: BriefField<string[]>;
  /** The last verified transition or evidence, never an unverified claim. */
  lastVerified: BriefField<BriefVerifiedEvidence>;
  /** Wake/recovery deadline; a known `null` means the lifecycle has none. */
  deadline: BriefField<string | null>;
  /** Surface-specific projected facts; BriefField values here are gap-scanned too. */
  facts: Facts;
  /** Dotted paths of every unknown field, core and facts alike. */
  unknowns: string[];
}

export type OperationalBriefInput<Facts extends Record<string, unknown>> = Omit<
  OperationalBrief<Facts>,
  'schemaVersion' | 'unknowns'
>;

const CORE_FIELDS = ['state', 'owner', 'nextAction', 'blockers', 'lastVerified', 'deadline'] as const;

/** Stamp the schema version and derive `unknowns` from the fields themselves,
 * so the gap list can never disagree with the values it summarizes. */
export function finalizeOperationalBrief<Facts extends Record<string, unknown>>(
  input: OperationalBriefInput<Facts>,
): OperationalBrief<Facts> {
  const unknowns: string[] = [];
  for (const key of CORE_FIELDS) {
    if (input[key].status === 'unknown') unknowns.push(key);
  }
  for (const [key, value] of Object.entries(input.facts)) {
    if (isBriefField(value) && value.status === 'unknown') unknowns.push(`facts.${key}`);
  }
  return { schemaVersion: OPERATIONAL_BRIEF_SCHEMA, ...input, unknowns };
}

function renderField<T>(field: BriefField<T>, format: (value: T) => string): string {
  return field.status === 'known' ? format(field.value) : `unknown (${field.reason})`;
}

/** Compact line rendering for turn text, carry notes and coord bodies. */
export function renderOperationalBrief(brief: OperationalBrief): string {
  const lines = [
    `[${brief.surface}] ${brief.subject} — ${renderField(brief.state, (v) => v)}`,
    `next: ${renderField(brief.nextAction, (v) => v)}`,
    `owner: ${renderField(brief.owner, (v) => v ?? 'none')}`,
    `blockers: ${renderField(brief.blockers, (v) => (v.length === 0 ? 'none' : v.join('; ')))}`,
    `last verified: ${renderField(brief.lastVerified, (v) => `${v.summary} [${v.ref}${v.at ? ` @ ${v.at}` : ''}]`)}`,
    `deadline: ${renderField(brief.deadline, (v) => v ?? 'none')}`,
  ];
  if (brief.unknowns.length > 0) lines.push(`unknown: ${brief.unknowns.join(', ')}`);
  return lines.join('\n');
}
