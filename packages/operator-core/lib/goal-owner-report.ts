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

/**
 * The WRITE-TIME contract: every heading a report must carry before the send /
 * escalate gates stamp it. NEXT WAKE was added by WI-10005205: graded holders
 * kept omitting what will wake them next (the rubric
 * work-on-everything-stewardship-health owner-steering-and-reporting requires
 * it), and they did so because this gate never asked for it. A gate that names
 * only four headings teaches the holder that a four-heading report is complete.
 */
export const GOAL_OWNER_REPORT_FIELDS = ['moved', 'cost', 'ownerWalled', 'killed', 'nextWake'] as const;
export type GoalOwnerReportField = (typeof GOAL_OWNER_REPORT_FIELDS)[number];

/**
 * The EVIDENCE contract: the fields a stored stamp must carry to count as a
 * delivered report. Kept at the original four so stamps written before
 * NEXT WAKE existed (schema v1 has no version bump for the additive field)
 * still satisfy the cadence watchdog and kickoff evidence; the write gate above
 * is where the fifth field is enforced.
 */
export const GOAL_OWNER_REPORT_STAMP_CORE_FIELDS = ['moved', 'cost', 'ownerWalled', 'killed'] as const;
export type GoalOwnerReportCoreField = (typeof GOAL_OWNER_REPORT_STAMP_CORE_FIELDS)[number];

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
  nextWake: 'NEXT WAKE',
});

/** Human-facing rendering of the whole contract, e.g. "MOVED / COST / OWNER-WALLED / KILLED / NEXT WAKE". */
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
    /** Timestamp attached to the goal spend snapshot, when the writer supplied one. */
    measuredAt?: string | null;
    unmeasuredPricedSpend: boolean;
  };
  ownerWalls: Array<{ ref: string; action: string }> | null;
  killed: Array<{ ref: string; criterion: string | null; at: string }> | null;
  artifactReads: Array<{ ref: string; readAt: string }>;
  movementTruncated?: boolean;
  killedTruncated?: boolean;
  /**
   * What will wake the holder next and roughly when (loop interval, awaited
   * event, owner reply). Null/absent renders an explicit unknown rather than a
   * guessed wake: the reader must not be told a wake exists when none was read.
   */
  nextWake?: string | null;
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
    ? `unknown; coverage=${cost.coverage}; source=${cost.source ?? 'unavailable'}; measured at=${cost.measuredAt ?? 'unknown'}; read at=${input.observedAt}`
    : `${cost.spentCents}c / ${cost.budgetCents ?? 'undeclared'}c; coverage=${cost.coverage}; source=${cost.source ?? 'unmarked'}; measured at=${cost.measuredAt ?? 'unknown'}; read at=${input.observedAt}${cost.unmeasuredPricedSpend ? '; unmeasured priced spend remains' : ''}`;
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
    nextWake: input.nextWake?.trim() || 'unknown (no wake source was read for this draft)',
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
  /** Absent on stamps written before WI-10005205; always present on new stamps. */
  nextWake?: string;
  /**
   * State of every work-item ref the MOVED field cited, read at send time. The
   * NEXT report is checked against it: a ref reported as done that has since
   * regressed must be corrected explicitly (P-005 (c), WI-10005610). Absent on
   * stamps written before that check existed, and when the state read failed.
   */
  citedRefStates?: GoalReportCitedRef[];
  /** What the send-time truth checks could establish (P-005); absent on older stamps. */
  truth?: GoalOwnerReportTruthSummary;
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
  NEXTWAKE: 'nextWake',
};

/**
 * SQL readers keep a narrow compatibility arm for reports written before the
 * structured stamp existed. These patterns deliberately require a report
 * label at a line boundary AND a non-empty value; an arbitrary to-human ping,
 * or prose that merely repeats "MOVED / COST / OWNER-WALLED / KILLED", cannot
 * satisfy them. Modern writes never depend on these regexes: they carry the
 * server-authored stamp above.
 */
export const GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS: Readonly<Record<GoalOwnerReportCoreField, string>> = Object.freeze({
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
  const match = line.match(
    /^(MOVED|COST|OWNER(?:[\s_-]+)?WALLED|KILLED|NEXT(?:[\s_-]+)?WAKE)(?:[ \t]*(?::|：|—|–|-)[ \t]*(.*)|[ \t]*)$/i,
  );
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

export function stampGoalOwnerReport(
  goalId: string,
  parsed: GoalOwnerReportParseResult,
  truth?: { citedRefStates?: GoalReportCitedRef[] | null; summary?: GoalOwnerReportTruthSummary | null },
): GoalOwnerReportStamp {
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
    nextWake: parsed.fields.nextWake!,
    ...(truth?.citedRefStates ? { citedRefStates: truth.citedRefStates } : {}),
    ...(truth?.summary ? { truth: truth.summary } : {}),
  };
}

export function isGoalOwnerReportStamp(value: unknown, goalId?: string): value is GoalOwnerReportStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stamp = value as Partial<Record<keyof GoalOwnerReportStamp, unknown>>;
  if (stamp.schemaVersion !== GOAL_OWNER_REPORT_SCHEMA_VERSION) return false;
  if (typeof stamp.goalId !== 'string' || !stamp.goalId.trim()) return false;
  if (goalId !== undefined && stamp.goalId !== goalId) return false;
  // Evidence contract: the four core fields. A stamp written before NEXT WAKE
  // was required still counts as a delivered report (see STAMP_CORE_FIELDS).
  return GOAL_OWNER_REPORT_STAMP_CORE_FIELDS.every(
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
  // Stored evidence is judged on the core four (the evidence contract), so a
  // pre-NEXT-WAKE body is not retroactively demoted to incomplete.
  const core = (fields: GoalOwnerReportField[]) =>
    fields.filter((field) => (GOAL_OWNER_REPORT_STAMP_CORE_FIELDS as readonly string[]).includes(field));
  const missing = core(parsed.missing);
  const empty = core(parsed.empty);
  const duplicate = core(parsed.duplicate);
  if (missing.length || empty.length || duplicate.length) {
    return { kind: 'incomplete', missing, empty, duplicate };
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

// ---------------------------------------------------------------------------
// Send-time truth checks
//
// Plan goal-holder-plans-ideation-truthful-reports-2026-10-03 P-005. The shape
// checks above prove a report HAS five sections; they cannot tell the owner a
// section is false. Three falsities were measured on goal 60d3a8:
//   (a) COST said "not measured per goal; pot-wide $4266/24h" while the goal's
//       own lineage spend (313180c, goal-lineage-rollup) was measured;
//   (b) OWNER-WALLED listed bare ids, so the owner had to open each item to
//       learn what was being asked of them;
//   (c) a MOVED line known to be false stayed uncorrected for 44 minutes and
//       was then handed to the successor (WI-10005610).
// Each check below takes values the platform has measured, never the holder's
// prose, and an unreadable input skips its check instead of refusing.
// ---------------------------------------------------------------------------

/** The goal's measured spend as the spend rollup stored it on the goal row. */
export interface GoalReportMeasuredSpend {
  spentCents: number | null;
  /** True only for an authoritative lineage rollup with no unmeasured remainder. */
  measured: boolean;
  source: string | null;
  measuredAt: string | null;
}

/**
 * Map the goal row's spend columns (metadata spentCents / spentCentsSource / spentCentsAt /
 * spentCentsUnmeasuredReason) to a {@link GoalReportMeasuredSpend}. The ONE rule for "is the
 * goal's spend measured", shared by the send-time truth gate and the holder-behavior metric so
 * the two cannot disagree (WI-10006542). `snapshotSource` is the authoritative rollup's source
 * tag (GOAL_SPEND_SNAPSHOT_SOURCE in @papercusp/db-org), passed in to keep this module pure.
 */
export function goalSpendFromGoalRow(
  row: { spent: unknown; source: string | null; at: string | null; unmeasured: string | null },
  snapshotSource: string,
): GoalReportMeasuredSpend {
  const spentCents = typeof row.spent === 'number' && Number.isFinite(row.spent) ? Math.round(row.spent) : null;
  return {
    spentCents,
    measured: spentCents != null && row.source === snapshotSource && !row.unmeasured,
    source: row.source,
    measuredAt: row.at,
  };
}

/** An open owner-walled work-item of the goal and the owner action recorded on it. */
export interface GoalReportOwnerWall {
  ref: string;
  /** The recorded owner ask (ownerAction / ownerAsk / active human blocker); null when none was recorded. */
  action: string | null;
}

export interface GoalReportCitedRef {
  ref: string;
  state: string;
}

export interface GoalOwnerReportTruthInputs {
  /** null = the spend read failed; the cost check is skipped, not passed. */
  spend: GoalReportMeasuredSpend | null;
  /** null = the wall read failed. */
  ownerWalls: GoalReportOwnerWall[] | null;
  /** The goal's previous stamped report (any holder), with the ref states it recorded. */
  previousReport: { at: string; citedRefStates: GoalReportCitedRef[] | null } | null;
  /** Current state of every ref in previousReport.citedRefStates; null = read failed. */
  currentRefStates: Record<string, string> | null;
}

export type GoalOwnerReportTruthViolation =
  | { check: 'cost'; kind: 'measured-spend-not-cited'; expected: string; message: string }
  | { check: 'owner-walled'; kind: 'wall-not-listed' | 'wall-without-action'; ref: string; expected: string | null; message: string }
  | {
      check: 'correction';
      kind: 'correction-owed';
      ref: string;
      reportedState: string;
      currentState: string;
      reportedAt: string;
      message: string;
    };

export interface GoalOwnerReportTruthSummary {
  cost: 'cited-measured' | 'goal-spend-unmeasured' | 'unread';
  ownerWalls: 'all-listed-with-action' | 'none-open' | 'unread';
  corrections: 'none-owed' | 'carried' | 'no-baseline' | 'unread';
}

/** Absolute floor and relative band within which a cited amount matches the measured spend. */
export const GOAL_REPORT_COST_TOLERANCE = Object.freeze({ absCents: 1000, relative: 0.03 });

/** Report states that assert the work is finished; a later non-success state falsifies them. */
export const GOAL_REPORT_SUCCESS_STATES: ReadonlySet<string> = TERMINAL_REPORT_STATES;

/** A COST line that admits it did not measure the goal's spend. */
export function costLineIsUnmeasured(cost: string | null | undefined): boolean {
  if (!cost || !cost.trim()) return true;
  return /\bnot\s+(?:measured|attributable|goal-attributable)\b|\bunmeasured\b/i.test(cost);
}

const WORK_ITEM_REF = /\b(?:WI|EI|F)-\d+\b/g;

/** Work-item refs (WI-/EI-/F-) in prose, deduplicated in first-seen order. */
export function workItemRefsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(text.match(WORK_ITEM_REF) ?? [])];
}

/**
 * Split an ownerWalled section into entries and flag those that are only ids. "WI-10004856,
 * WI-10004875, WI-10005042" and "WI-10004856/4875/5042" name no action for the owner;
 * "hud P-003 route (solo/fleet/drop)" does.
 */
export function walledEntries(text: string | null | undefined): { entry: string; bare: boolean }[] {
  if (!text || !text.trim()) return [];
  return text
    .split(/;|\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !/^(?:none|nothing|n\/a)\.?$/i.test(entry))
    .map((entry) => {
      const hasRef = workItemRefsIn(entry).length > 0;
      const residue = entry.replace(WORK_ITEM_REF, ' ').replace(/[^A-Za-z]+/g, ' ').trim();
      return { entry, bare: hasRef && residue.split(/\s+/).filter((word) => word.length > 1).length === 0 };
    });
}

/**
 * Every money amount written in a COST line, in cents. Recognizes "$3,131.80",
 * "$3.1k", "313180c" / "313180 cents" / "313180¢" and "3131.80 USD". A bare
 * number is NOT money ("24h", "4 owner walls"), so it never matches by accident.
 */
export function moneyAmountsInCents(text: string): number[] {
  const out: number[] = [];
  const num = (raw: string) => Number(raw.replace(/,/g, ''));
  for (const match of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(\s?[kK]\b)?/g)) {
    const value = num(match[1]!);
    if (Number.isFinite(value)) out.push(Math.round(value * (match[2] ? 1000 : 1) * 100));
  }
  for (const match of text.matchAll(/(?<![\w$.,])(\d[\d,]*(?:\.\d+)?)\s?(?:USD\b|dollars?\b)/gi)) {
    const value = num(match[1]!);
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  for (const match of text.matchAll(/(?<![\w$.,])(\d[\d,]*)\s?(?:c\b|¢|cents?\b)/gi)) {
    const value = num(match[1]!);
    if (Number.isFinite(value)) out.push(Math.round(value));
  }
  return out;
}

export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** True when some amount in the COST text is within tolerance of the measured goal spend. */
export function costCitesMeasuredSpend(costText: string, spentCents: number): boolean {
  const tolerance = Math.max(GOAL_REPORT_COST_TOLERANCE.absCents, Math.round(spentCents * GOAL_REPORT_COST_TOLERANCE.relative));
  return moneyAmountsInCents(costText).some((amount) => Math.abs(amount - spentCents) <= tolerance);
}

/** The work-item refs the MOVED field cites, paired with their state at send time. */
export function citedRefStatesFor(
  moved: string,
  states: Record<string, string> | null,
): GoalReportCitedRef[] | null {
  if (!states) return null;
  return workItemRefsIn(moved)
    .filter((ref) => typeof states[ref] === 'string')
    .slice(0, 50)
    .map((ref) => ({ ref, state: states[ref]! }));
}

const wallActionHint = (action: string | null) =>
  action ? `"${action.length > 200 ? `${action.slice(0, 197)}...` : action}"` : 'the action it asks of the owner (none is recorded on the item: set it with work_items:set_blocker)';

/**
 * Judge a complete report against measured goal state. Returns the violations
 * (empty = truthful on every check that could be read) and a summary for the
 * stamp. Pure: the caller does the reads.
 */
export function checkGoalOwnerReportTruth(
  fields: Pick<Record<GoalOwnerReportField, string>, GoalOwnerReportField>,
  inputs: GoalOwnerReportTruthInputs,
): { violations: GoalOwnerReportTruthViolation[]; summary: GoalOwnerReportTruthSummary } {
  const violations: GoalOwnerReportTruthViolation[] = [];
  const summary: GoalOwnerReportTruthSummary = { cost: 'unread', ownerWalls: 'unread', corrections: 'unread' };

  // (a) COST: a measured lineage spend must be cited (any matching amount).
  const spend = inputs.spend;
  if (spend) {
    if (spend.measured && spend.spentCents != null) {
      if (costCitesMeasuredSpend(fields.cost, spend.spentCents)) {
        summary.cost = 'cited-measured';
      } else {
        const expected = `${formatUsdCents(spend.spentCents)} (${spend.source ?? 'goal-lineage-rollup'}, measured ${spend.measuredAt ?? 'at an unrecorded time'})`;
        violations.push({
          check: 'cost',
          kind: 'measured-spend-not-cited',
          expected,
          message:
            `COST does not cite this goal's measured spend ${expected}. A pot-wide figure or "not measured" is false while ` +
            'the goal lineage rollup has a value; state the goal figure (pot-wide context may follow it).',
        });
      }
    } else {
      summary.cost = 'goal-spend-unmeasured';
    }
  }

  // (b) OWNER-WALLED: every open wall is listed, each with words beyond its id.
  if (inputs.ownerWalls) {
    const entries = walledEntries(fields.ownerWalled);
    const flagged = new Set<string>();
    for (const wall of inputs.ownerWalls) {
      const pattern = new RegExp(`\\b${wall.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const containing = entries.filter((entry) => pattern.test(entry.entry));
      if (containing.length === 0) {
        flagged.add(wall.ref);
        violations.push({
          check: 'owner-walled',
          kind: 'wall-not-listed',
          ref: wall.ref,
          expected: wall.action,
          message: `OWNER-WALLED omits open owner wall ${wall.ref}; list it with ${wallActionHint(wall.action)}.`,
        });
      } else if (containing.every((entry) => entry.bare)) {
        flagged.add(wall.ref);
        violations.push({
          check: 'owner-walled',
          kind: 'wall-without-action',
          ref: wall.ref,
          expected: wall.action,
          message: `OWNER-WALLED names ${wall.ref} by id only; say what the owner must do: ${wallActionHint(wall.action)}.`,
        });
      }
    }
    for (const entry of entries) {
      if (!entry.bare) continue;
      for (const ref of workItemRefsIn(entry.entry)) {
        if (flagged.has(ref)) continue;
        flagged.add(ref);
        violations.push({
          check: 'owner-walled',
          kind: 'wall-without-action',
          ref,
          expected: null,
          message: `OWNER-WALLED names ${ref} by id only; say what the owner must do about it.`,
        });
      }
    }
    if (!violations.some((violation) => violation.check === 'owner-walled')) {
      summary.ownerWalls = inputs.ownerWalls.length ? 'all-listed-with-action' : 'none-open';
    }
  }

  // (c) CORRECTIONS: a ref the previous report cited as done that is no longer
  // done must be named in this report, whoever sent the previous one.
  const previous = inputs.previousReport;
  if (!previous || !previous.citedRefStates) {
    summary.corrections = 'no-baseline';
  } else if (inputs.currentRefStates) {
    const reportText = GOAL_OWNER_REPORT_FIELDS.map((field) => fields[field]).join('\n');
    let carried = false;
    for (const cited of previous.citedRefStates) {
      if (!GOAL_REPORT_SUCCESS_STATES.has(cited.state)) continue;
      const current = inputs.currentRefStates[cited.ref];
      if (current === undefined || GOAL_REPORT_SUCCESS_STATES.has(current)) continue;
      if (workItemRefsIn(reportText).includes(cited.ref)) {
        carried = true;
        continue;
      }
      violations.push({
        check: 'correction',
        kind: 'correction-owed',
        ref: cited.ref,
        reportedState: cited.state,
        currentState: current,
        reportedAt: previous.at,
        message:
          `The report at ${previous.at} told the owner ${cited.ref} was ${cited.state}; it is now ${current}. ` +
          `Correct that line explicitly in this report (name ${cited.ref}, what was wrong, and its true state).`,
      });
    }
    if (!violations.some((violation) => violation.check === 'correction')) {
      summary.corrections = carried ? 'carried' : 'none-owed';
    }
  }

  return { violations, summary };
}

/** One refusal message for a set of violations, in check order. */
export function describeGoalOwnerReportTruthViolations(goalId: string, violations: readonly GoalOwnerReportTruthViolation[]): string {
  const lines = violations.map((violation, index) => `${index + 1}. ${violation.message}`);
  return (
    `GOAL owner report for ${goalId} contradicts measured goal state; nothing was sent. Fix and resend:\n` +
    lines.join('\n')
  );
}
