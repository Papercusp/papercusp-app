/**
 * Canonical shape for the four-element report a GOAL holder delivers to the
 * owner. The parser is intentionally pure: reporting tools use it before a
 * write, while evidence readers use the same semantics for the bounded legacy
 * compatibility path.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 (P-006, A-03/A-05).
 */

export const GOAL_OWNER_REPORT_SCHEMA_VERSION = 'goal-owner-report-v1' as const;
export const GOAL_OWNER_REPORT_FIELD = 'goalOwnerReport' as const;

export const GOAL_OWNER_REPORT_FIELDS = ['moved', 'cost', 'ownerWalled', 'killed'] as const;
export type GoalOwnerReportField = (typeof GOAL_OWNER_REPORT_FIELDS)[number];

/**
 * The heading an author actually types for each field. Refusals quote these, so
 * they must round-trip through {@link parseGoalOwnerReport} rather than being a
 * second hand-maintained spelling of the contract; a guard test pins that.
 */
export const GOAL_OWNER_REPORT_HEADINGS: Readonly<Record<GoalOwnerReportField, string>> = Object.freeze({
  moved: 'MOVED',
  cost: 'COST',
  ownerWalled: 'OWNER-WALLED',
  killed: 'KILLED',
});

/** Human-facing rendering of the whole contract, e.g. "MOVED / COST / OWNER-WALLED / KILLED". */
export const GOAL_OWNER_REPORT_HEADING_LIST = GOAL_OWNER_REPORT_FIELDS.map(
  (field) => GOAL_OWNER_REPORT_HEADINGS[field],
).join(' / ');

/**
 * P-021: a report draft is assembled from one timestamped portfolio read and
 * explicit artifact-read receipts. A status label alone cannot certify a
 * completed result. The caller may present that label, but this assembler
 * refuses to call it complete until the exact artifact was read after its last
 * update. These are inputs to the existing four-field report, not another
 * reporting ledger or transport.
 */
export interface GoalOwnerReportDraftInput {
  goalId: string;
  observedAt: string;
  previousReportAt: string | null;
  movements: Array<{
    ref: string;
    state: string;
    updatedAt: string;
    artifact?: { ref: string; updatedAt: string } | null;
  }>;
  cost: {
    spentCents: number | null;
    budgetCents: number | null;
    source: string | null;
    coverage: string;
    unmeasuredPricedSpend: boolean;
  };
  ownerWalls: Array<{ ref: string; action: string }> | null;
  killed: Array<{ ref: string; criterion: string | null; at: string }> | null;
  artifactReads: Array<{ ref: string; readAt: string }>;
  movementTruncated?: boolean;
  killedTruncated?: boolean;
}

export interface GoalOwnerReportDraft {
  fields: Record<GoalOwnerReportField, string>;
  /** Exact refs whose unread/old artifact prevents a completion assertion. */
  unreadArtifacts: string[];
  /** The four field report, accepted by the canonical parser and coord stamp. */
  text: string;
}

const TERMINAL_REPORT_STATES = new Set(['done', 'passed', 'resolved', 'closed', 'shipped', 'achieved']);

export function buildGoalOwnerReportDraft(input: GoalOwnerReportDraftInput): GoalOwnerReportDraft {
  const cutoff = input.previousReportAt ? Date.parse(input.previousReportAt) : NaN;
  const observed = Date.parse(input.observedAt);
  const unreadArtifacts: string[] = [];
  const moved = input.movements
    .filter((row) => Number.isFinite(cutoff) && Date.parse(row.updatedAt) > cutoff && Date.parse(row.updatedAt) <= observed)
    .map((row) => {
      const terminal = TERMINAL_REPORT_STATES.has(row.state);
      // An updated record proves a changed record, not that its current state
      // began at that timestamp. Keep the two claims separate in the report.
      if (!terminal) return `${row.ref}: record updated ${row.updatedAt}; current state=${row.state} (state transition unverified)`;
      const artifact = row.artifact;
      const read = artifact && input.artifactReads.find((candidate) =>
        candidate.ref === artifact.ref &&
        Date.parse(candidate.readAt) >= Date.parse(artifact.updatedAt) &&
        Date.parse(candidate.readAt) <= observed,
      );
      if (!artifact || !read) {
        unreadArtifacts.push(artifact?.ref ?? row.ref);
        return `${row.ref}: record updated ${row.updatedAt}; terminal label ${row.state}; completion unverified (artifact unread)`;
      }
      return `${row.ref}: record updated ${row.updatedAt}; current state=${row.state}; artifact ${artifact.ref} read ${read.readAt}`;
    });
  const cost = input.cost;
  const costText = cost.spentCents == null
    ? `unknown; coverage=${cost.coverage}; source=${cost.source ?? 'unavailable'}`
    : `${cost.spentCents}c / ${cost.budgetCents ?? 'undeclared'}c; coverage=${cost.coverage}; source=${cost.source ?? 'unmarked'}${cost.unmeasuredPricedSpend ? '; unmeasured priced spend remains' : ''}`;
  const fields: Record<GoalOwnerReportField, string> = {
    moved: `${moved.length ? moved.join('; ') : Number.isFinite(cutoff)
      ? 'none evidenced since the previous report in this snapshot'
      : 'unknown (no previous report watermark; current status is not a movement)'}${input.movementTruncated
      ? '; partial coverage: more changed records exist; read the rest before claiming complete movement coverage'
      : ''}`,
    cost: costText,
    ownerWalled: input.ownerWalls === null ? 'unknown (owner-wall read unavailable)'
      : input.ownerWalls.length ? input.ownerWalls.map((wall) => `${wall.ref}: ${wall.action}`).join('; ')
      : 'none evidenced in the current portfolio',
    killed: input.killed === null ? 'unknown (kill/disposition read unavailable)'
      : input.killed.length ? input.killed.map((row) =>
        `${row.ref} at ${row.at}; criterion=${row.criterion ?? 'unverified'}`,
      ).join('; ') + (input.killedTruncated ? '; partial coverage: more stopped work exists; read the rest' : '')
      : input.killedTruncated ? 'partial coverage: more stopped work exists; read the rest'
      : 'none evidenced in the current portfolio',
  };
  const text = [
    `Goal ${input.goalId}; portfolio read ${input.observedAt}`,
    ...GOAL_OWNER_REPORT_FIELDS.map((field) => `${GOAL_OWNER_REPORT_HEADINGS[field]}: ${fields[field]}`),
  ].join('\n');
  return { fields, unreadArtifacts, text };
}

export interface GoalOwnerReportStamp {
  schemaVersion: typeof GOAL_OWNER_REPORT_SCHEMA_VERSION;
  goalId: string;
  moved: string;
  cost: string;
  ownerWalled: string;
  killed: string;
}

export interface GoalOwnerReportParseResult {
  /** At least one report label was used as a line/section heading. */
  attempted: boolean;
  complete: boolean;
  fields: Partial<Record<GoalOwnerReportField, string>>;
  missing: GoalOwnerReportField[];
  empty: GoalOwnerReportField[];
  duplicate: GoalOwnerReportField[];
}

export type GoalOwnerReportTextInput = string | readonly string[] | readonly { text?: unknown }[] | null | undefined;

const LABEL_TO_FIELD: Readonly<Record<string, GoalOwnerReportField>> = {
  MOVED: 'moved',
  COST: 'cost',
  OWNERWALLED: 'ownerWalled',
  KILLED: 'killed',
};

/**
 * SQL readers keep a narrow compatibility arm for reports written before the
 * structured stamp existed. These patterns deliberately require a report
 * label at a line boundary AND a non-empty value; an arbitrary to-human ping,
 * or prose that merely repeats "MOVED / COST / OWNER-WALLED / KILLED", cannot
 * satisfy them. Modern writes never depend on these regexes: they carry the
 * server-authored stamp above.
 */
export const GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS: Readonly<Record<GoalOwnerReportField, string>> = Object.freeze({
  moved:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?MOVED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  cost: '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?COST([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  ownerWalled:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?OWNER[[:space:]_-]*WALLED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  killed:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?KILLED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
});

function inputTexts(input: GoalOwnerReportTextInput): string[] {
  if (typeof input === 'string') return [input];
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    return typeof entry.text === 'string' ? [entry.text] : [];
  });
}

function normalizeLabel(label: string): GoalOwnerReportField | null {
  return LABEL_TO_FIELD[label.toUpperCase().replace(/[\s_-]+/g, '')] ?? null;
}

/** Remove presentation-only Markdown around a heading without touching value text. */
function normalizeHeadingLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(/^#{1,6}[ \t]+/, '');
  line = line.replace(/^(?:[-+*]|>)[ \t]+/, '');
  line = line.replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)(.*)$/, '$1$2');
  return line.trim();
}

function reportHeading(raw: string): { field: GoalOwnerReportField; remainder: string } | null {
  const line = normalizeHeadingLine(raw);
  // A value on the heading line needs punctuation. Without that constraint,
  // ordinary prose such as "moved the build" becomes a report attempt.
  const match = line.match(/^(MOVED|COST|OWNER(?:[\s_-]+)?WALLED|KILLED)(?:[ \t]*(?::|：|—|–|-)[ \t]*(.*)|[ \t]*)$/i);
  if (!match) return null;
  const field = normalizeLabel(match[1]!);
  return field ? { field, remainder: (match[2] ?? '').trim() } : null;
}

function normalizeValue(lines: readonly string[]): string {
  return lines
    .join('\n')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Parse report headings from structured coord sections or legacy flat text.
 * Explicit "none" and "unknown (…)" are valid values: the contract requires
 * honesty, not invented activity. Duplicate headings are refused because there
 * would be no canonical field value to stamp.
 */
export function parseGoalOwnerReport(input: GoalOwnerReportTextInput): GoalOwnerReportParseResult {
  const occurrences = new Map<GoalOwnerReportField, string[]>();

  for (const text of inputTexts(input)) {
    let current: GoalOwnerReportField | null = null;
    let buffer: string[] = [];
    const flush = () => {
      if (!current) return;
      const values = occurrences.get(current) ?? [];
      values.push(normalizeValue(buffer));
      occurrences.set(current, values);
      current = null;
      buffer = [];
    };

    for (const line of text.split(/\r?\n/)) {
      const heading = reportHeading(line);
      if (heading) {
        flush();
        current = heading.field;
        buffer = heading.remainder ? [heading.remainder] : [];
      } else if (current) {
        buffer.push(line);
      }
    }
    flush();
  }

  const attempted = occurrences.size > 0;
  const fields: Partial<Record<GoalOwnerReportField, string>> = {};
  const missing: GoalOwnerReportField[] = [];
  const empty: GoalOwnerReportField[] = [];
  const duplicate: GoalOwnerReportField[] = [];
  for (const field of GOAL_OWNER_REPORT_FIELDS) {
    const values = occurrences.get(field);
    if (!values) {
      missing.push(field);
      continue;
    }
    if (values.length !== 1) duplicate.push(field);
    const value = values[0] ?? '';
    if (!value) empty.push(field);
    else fields[field] = value;
  }

  return {
    attempted,
    complete: attempted && missing.length === 0 && empty.length === 0 && duplicate.length === 0,
    fields,
    missing,
    empty,
    duplicate,
  };
}

export function stampGoalOwnerReport(goalId: string, parsed: GoalOwnerReportParseResult): GoalOwnerReportStamp {
  const id = goalId.trim();
  if (!id) throw new Error('goal owner report stamp requires a goal id');
  if (!parsed.complete) throw new Error('cannot stamp an incomplete goal owner report');
  return {
    schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
    goalId: id,
    moved: parsed.fields.moved!,
    cost: parsed.fields.cost!,
    ownerWalled: parsed.fields.ownerWalled!,
    killed: parsed.fields.killed!,
  };
}

export function isGoalOwnerReportStamp(value: unknown, goalId?: string): value is GoalOwnerReportStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stamp = value as Partial<Record<keyof GoalOwnerReportStamp, unknown>>;
  if (stamp.schemaVersion !== GOAL_OWNER_REPORT_SCHEMA_VERSION) return false;
  if (typeof stamp.goalId !== 'string' || !stamp.goalId.trim()) return false;
  if (goalId !== undefined && stamp.goalId !== goalId) return false;
  return GOAL_OWNER_REPORT_FIELDS.every(
    (field) => typeof stamp[field] === 'string' && Boolean((stamp[field] as string).trim()),
  );
}

/**
 * Why a stored envelope did or did not register as this goal's owner report.
 *
 * A bare "no report" verdict is indistinguishable from "you sent four, and all
 * four parsed as non-attempts" — the failure this type exists to end
 * (EI-23742424491420721). Readers that refuse on the evidence quote the reason,
 * so the reason must be computed by the same pass that decides.
 */
export type GoalOwnerReportEnvelopeDiagnosis =
  /** Registers as this goal's report. */
  | { kind: 'complete' }
  /** Not an object envelope at all; nothing to parse. */
  | { kind: 'unreadable-envelope' }
  /** A complete report, but vouched for another subject (or naming no goal). */
  | { kind: 'wrong-goal'; stampedGoalId: string | null }
  /** Parses complete but carries no server stamp, so nothing vouches for the subject. */
  | { kind: 'unstamped-complete' }
  /** At least one heading was used, but the four-element contract is unmet. */
  | {
      kind: 'incomplete';
      missing: GoalOwnerReportField[];
      empty: GoalOwnerReportField[];
      duplicate: GoalOwnerReportField[];
    }
  /** Carried none of the four headings: delivered prose, never a report attempt. */
  | { kind: 'not-attempted' };

/** Higher means "got closer to satisfying the contract"; used to pick what to explain. */
export const GOAL_OWNER_REPORT_DIAGNOSIS_RANK: Readonly<Record<GoalOwnerReportEnvelopeDiagnosis['kind'], number>> =
  Object.freeze({
    complete: 5,
    'unstamped-complete': 4,
    'wrong-goal': 3,
    incomplete: 2,
    'not-attempted': 1,
    'unreadable-envelope': 0,
  });

/**
 * Canonical evidence reader for stored coord envelopes. Modern evidence is the
 * server-authored stamp. Legacy evidence must contain all four labeled values
 * AND name the exact goal in its body; this preserves the old subject rule
 * without letting a wrong-goal report clear a new window.
 *
 * This returns the REASON as well as the verdict so a refusal can name the
 * schema instead of emitting a bare token.
 */
export function diagnoseGoalOwnerReportEnvelope(envelope: unknown, goalId: string): GoalOwnerReportEnvelopeDiagnosis {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { kind: 'unreadable-envelope' };
  const record = envelope as Record<string, unknown>;

  const stamp = record[GOAL_OWNER_REPORT_FIELD];
  if (isGoalOwnerReportStamp(stamp, goalId)) return { kind: 'complete' };
  // A well-formed stamp for a DIFFERENT subject is a complete report aimed
  // elsewhere — a materially different repair from "your report was malformed".
  if (isGoalOwnerReportStamp(stamp)) return { kind: 'wrong-goal', stampedGoalId: stamp.goalId };

  // No usable stamp. Parse the body in whatever shape it was stored: a modern
  // coord:send persists an array of sections, a legacy write a flat string.
  const parsed = parseGoalOwnerReport(record.body as GoalOwnerReportTextInput);
  if (!parsed.attempted) return { kind: 'not-attempted' };
  if (!parsed.complete) {
    return { kind: 'incomplete', missing: parsed.missing, empty: parsed.empty, duplicate: parsed.duplicate };
  }
  if (typeof record.body === 'string') {
    return record.body.includes(goalId) ? { kind: 'complete' } : { kind: 'wrong-goal', stampedGoalId: null };
  }
  return { kind: 'unstamped-complete' };
}

/**
 * Boolean face of {@link diagnoseGoalOwnerReportEnvelope}. Deriving it from the
 * one pass keeps the verdict and the explanation from ever disagreeing.
 */
export function envelopeHasCompleteGoalOwnerReport(envelope: unknown, goalId: string): boolean {
  return diagnoseGoalOwnerReportEnvelope(envelope, goalId).kind === 'complete';
}
