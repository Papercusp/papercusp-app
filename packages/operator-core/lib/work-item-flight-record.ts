/**
 * Bounded, privacy-safe work-item flight records (EI-6142 / P-004).
 *
 * The record deliberately reuses existing recovery substrates: session_briefs
 * supplies intent/files, tool_invocations supplies the newest call metadata,
 * and the work-item checkpoint remains the one successor-read path. Raw
 * arguments, messages, results, and transcripts never enter the checkpoint.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { getSessionBrief } from './session-brief';
import { MECHANICAL_CHECKPOINT_MARKER } from './turn-end-tracking';
import { setWorkItemCheckpointWithPrior } from './work-item-checkpoint';
import { resolveConcreteWorkspaceId } from './workspace-registry';

export const WORK_ITEM_FLIGHT_RECORD_BEGIN = '⟦work-item-flight-record v1 begin⟧';
export const WORK_ITEM_FLIGHT_RECORD_END = '⟦work-item-flight-record v1 end⟧';
export const WORK_ITEM_FLIGHT_RECORD_LIMIT = 3;
export const WORK_ITEM_FLIGHT_TOOL_LIMIT = 12;

const CHECKPOINT_SEPARATOR = '\n\n---\n';
const STRUCTURED_CARRY_SECTION_RE = /^##\s+(?:Checks|Walls)\s*$/im;

export type WorkItemFlightRecordCause = 'lease-release' | 'forced-interrupt';

export interface WorkItemFlightRef {
  id: string;
  harness: string | null;
}

export interface WorkItemFlightToolInvocation {
  tool: string;
  status: string | null;
  invokedAt: string;
  durationMs: number | null;
  errorCode: string | null;
  argsJson: unknown;
}

export interface WorkItemFlightRecordInput {
  ownerId: string;
  cause: WorkItemFlightRecordCause;
  capturedAt: string;
  intent: string;
  currentFiles: string[];
  tools: WorkItemFlightToolInvocation[];
  /**
   * EI-21360972070006156: the OTHER held items this same record is being stamped
   * onto. One record is composed per capture and cloned across every held item, so
   * whenever this is non-empty the `intent` line above is a SESSION-level lane note,
   * NOT a reading of this item. Both confirmed instances (WI-41347, WI-41351) were
   * exactly this shape — one lane note, two items — which is why the machine half
   * appeared to corroborate the false human claim: both came from ONE
   * non-measurement. Optional so existing callers are unaffected.
   */
  alsoStampedOnItemIds?: string[];
  /**
   * EI-21360972070006156: whether agent-authored prose sits above this record in the
   * merged checkpoint. That prose is BY DEFINITION pre-capture text, but it renders
   * directly above this record's fresh `captured_at`, which lends a claim-time
   * assertion ("no source edits yet") release-time authority. Stating it is purely
   * derived — it needs no timestamp and cannot race, unlike reading the checkpoint's
   * updated_at outside the store's lock.
   */
  priorAuthoredProse?: 'present' | 'absent';
}

export interface ArgsKeyDigest {
  /** Sorted top-level key names only; never argument values. */
  keys: string[];
  /** Hash of the key names only, so even a low-entropy secret value cannot be brute-forced from it. */
  digest: string;
}

/** Privacy-safe argument shape: sorted top-level keys plus a hash of those keys only. */
export function digestTopLevelArgKeys(args: unknown): ArgsKeyDigest {
  const keys =
    args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args as Record<string, unknown>).sort() : [];
  const digest = createHash('sha256')
    .update(keys.join('\0') || '(no-top-level-keys)')
    .digest('hex')
    .slice(0, 12);
  return { keys, digest };
}

function oneLine(value: unknown, cap: number): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '(none)';
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

/** Render one automatic record. Only bounded metadata is admitted. */
export function formatWorkItemFlightRecord(input: WorkItemFlightRecordInput): string {
  const lines = [
    WORK_ITEM_FLIGHT_RECORD_BEGIN,
    `captured_at: ${oneLine(input.capturedAt, 64)}`,
    `cause: ${input.cause}`,
    `owner: ${oneLine(input.ownerId, 160)}`,
    `intent: ${oneLine(input.intent, 1_000)}`,
    ...(input.alsoStampedOnItemIds?.length
      ? [
          `intent_scope: session-lane — this record was stamped identically onto ${input.alsoStampedOnItemIds.length + 1} items, so the intent line above is NOT a reading of this item`,
          `also_stamped_on: ${JSON.stringify(input.alsoStampedOnItemIds.slice(0, 20).map((id) => oneLine(id, 80)))}`,
        ]
      : []),
    ...(input.priorAuthoredProse
      ? [
          `authored_prose_above: ${
            input.priorAuthoredProse === 'present'
              ? 'PRESENT and PREDATES this capture — it was written before captured_at, not at it; date any absence claim in it against the file history before trusting it'
              : 'none'
          }`,
        ]
      : []),
    `current_files: ${input.currentFiles.length ? JSON.stringify(input.currentFiles.slice(0, 50).map((p) => oneLine(p, 240))) : '[]'}`,
    `tools_newest_first (max ${WORK_ITEM_FLIGHT_TOOL_LIMIT}):`,
  ];
  for (const row of input.tools.slice(0, WORK_ITEM_FLIGHT_TOOL_LIMIT)) {
    const args = digestTopLevelArgKeys(row.argsJson);
    lines.push(
      `- at=${oneLine(row.invokedAt, 64)} tool=${oneLine(row.tool, 160)}` +
        ` status=${oneLine(row.status ?? 'unknown', 40)}` +
        ` duration_ms=${Number.isFinite(row.durationMs) ? row.durationMs : 'unknown'}` +
        ` error_code=${oneLine(row.errorCode ?? 'none', 120)}` +
        ` args_keys=${JSON.stringify(args.keys)}` +
        ` args_key_digest=${args.digest}`,
    );
  }
  if (input.tools.length === 0) lines.push('- (no recent tool invocation metadata)');
  lines.push(WORK_ITEM_FLIGHT_RECORD_END);
  return lines.join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RECORD_RE = new RegExp(
  `${escapeRegExp(WORK_ITEM_FLIGHT_RECORD_BEGIN)}[\\s\\S]*?${escapeRegExp(WORK_ITEM_FLIGHT_RECORD_END)}`,
  'g',
);
const RECORD_WITH_SEPARATOR_RE = new RegExp(
  `(?:\\n\\n---\\n)?${escapeRegExp(WORK_ITEM_FLIGHT_RECORD_BEGIN)}[\\s\\S]*?${escapeRegExp(WORK_ITEM_FLIGHT_RECORD_END)}`,
  'g',
);

/**
 * Insert a record atomically into the checkpoint text. Agent-authored prose is
 * retained, only the newest three automatic records survive, and an existing
 * legacy mechanical tail remains the final block. Automatic records stay before
 * structured Checks/Walls sections so their telemetry lines cannot be parsed as
 * carry rows on the next wake.
 */
export function mergeWorkItemFlightRecord(
  priorCheckpoint: string | null | undefined,
  record: string,
  limit = WORK_ITEM_FLIGHT_RECORD_LIMIT,
): string {
  const { existingRecords, authoredBody, structuredSections, mechanicalTail } = splitPriorCheckpoint(priorCheckpoint);
  const boundedRecords = [...existingRecords, record].slice(-Math.max(1, limit));
  const merged = [authoredBody, ...boundedRecords, structuredSections].filter(Boolean).join(CHECKPOINT_SEPARATOR);
  return mechanicalTail ? `${merged}${mechanicalTail}` : merged;
}

/**
 * Split a prior checkpoint into its agent-authored prose and its machine-appended
 * parts. Factored out so {@link hasPriorAuthoredProse} and
 * {@link mergeWorkItemFlightRecord} share ONE parse: a record that claims prose sits
 * above it can then never disagree with what the merge actually kept
 * (EI-21360972070006156).
 */
function splitPriorCheckpoint(priorCheckpoint: string | null | undefined): {
  existingRecords: string[];
  authoredBody: string;
  structuredSections: string;
  mechanicalTail: string;
} {
  const prior = priorCheckpoint ?? '';
  const markerAt = prior.indexOf(MECHANICAL_CHECKPOINT_MARKER);
  const separatorAt = markerAt >= 0 ? prior.lastIndexOf(CHECKPOINT_SEPARATOR, markerAt) : -1;
  const mechanicalStart = markerAt < 0 ? -1 : separatorAt >= 0 ? separatorAt : markerAt;
  const beforeMechanical = mechanicalStart >= 0 ? prior.slice(0, mechanicalStart) : prior;
  const mechanicalTail = mechanicalStart >= 0 ? prior.slice(mechanicalStart) : '';

  const existingRecords = Array.from(beforeMechanical.matchAll(RECORD_RE), (match) => match[0]);
  const authored = beforeMechanical.replace(RECORD_WITH_SEPARATOR_RE, '').trimEnd();
  const sectionMatch = STRUCTURED_CARRY_SECTION_RE.exec(authored);
  const structuredStart = sectionMatch?.index ?? -1;
  const authoredBody = structuredStart >= 0 ? authored.slice(0, structuredStart).trimEnd() : authored;
  const structuredSections = structuredStart >= 0 ? authored.slice(structuredStart).trimStart() : '';
  return { existingRecords, authoredBody, structuredSections, mechanicalTail };
}

/**
 * Does agent-authored prose sit above the flight records in this checkpoint?
 * Deliberately shares {@link splitPriorCheckpoint} with the merge, so the record's
 * `authored_prose_above` line is DERIVED from the same text the merge preserves
 * rather than asserted independently (EI-21360972070006156).
 */
export function hasPriorAuthoredProse(priorCheckpoint: string | null | undefined): boolean {
  return splitPriorCheckpoint(priorCheckpoint).authoredBody.trim().length > 0;
}

/** `engineer_issues.scope` is the canonical source of an issue-family item's harness. */
export function harnessFromIssueScope(scope: string | null | undefined): string | null {
  const prefix = 'harness:';
  return scope?.startsWith(prefix) && scope.length > prefix.length ? scope.slice(prefix.length) : null;
}

interface ToolInvocationRow {
  tool_name: string | null;
  status: string | null;
  invoked_at: string;
  duration_ms: number | null;
  error_code: string | null;
  args_json: unknown;
}

async function recentToolInvocations(ownerId: string, workspaceId: string): Promise<WorkItemFlightToolInvocation[]> {
  const rows = await getOrgPg().sql<ToolInvocationRow[]>`
    SELECT tool_name, status, invoked_at::text AS invoked_at, duration_ms, error_code, args_json
      FROM harness_shared.tool_invocations
     WHERE coord_owner_id = ${ownerId}
       AND workspace_id IN (${workspaceId}, '*')
     ORDER BY tool_invocations.invoked_at DESC
     LIMIT ${WORK_ITEM_FLIGHT_TOOL_LIMIT}
  `;
  return rows.map((row) => ({
    tool: row.tool_name ?? '?',
    status: row.status,
    invokedAt: row.invoked_at,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    argsJson: row.args_json,
  }));
}

/** Compose once, then atomically merge the same bounded record into each held item. Never throws. */
export async function captureWorkItemFlightRecordsForItems(input: {
  ownerId: string;
  workspaceId: string;
  cause: WorkItemFlightRecordCause;
  items: WorkItemFlightRef[];
}): Promise<{ capturedIds: string[] }> {
  const capturedIds: string[] = [];
  try {
    const workspaceId = resolveConcreteWorkspaceId(input.workspaceId);
    if (!workspaceId || !input.ownerId || input.items.length === 0) return { capturedIds };
    const [brief, tools] = await Promise.all([
      getSessionBrief({ ownerId: input.ownerId }),
      recentToolInvocations(input.ownerId, workspaceId).catch(() => []),
    ]);
    // EI-21360972070006156: `capturedAt` is still computed ONCE so every item in this
    // capture shares one instant — but the RECORD is no longer composed once and cloned.
    // Cloning persisted a session-level `intent` onto every held item as though it were
    // a per-item reading, which is the machine half of both confirmed false
    // "no source edits yet" records (WI-41347, WI-41351): one lane note, two items, two
    // surfaces that appeared to corroborate each other from ONE non-measurement.
    const base = {
      ownerId: input.ownerId,
      cause: input.cause,
      capturedAt: new Date().toISOString(),
      intent: brief?.intent ?? '',
      currentFiles: brief?.currentFiles ?? [],
      tools,
    };
    const unique = new Map(input.items.map((item) => [`${item.harness ?? '*'}:${item.id}`, item]));
    const uniqueItems = [...unique.values()];
    for (const [index, item] of uniqueItems.entries()) {
      try {
        await setWorkItemCheckpointWithPrior(
          { harness: item.harness, workItemId: item.id, workspaceId },
          formatWorkItemFlightRecord(base),
          {
            // Compose INSIDE the transform: `prior` is reachable only under the store's
            // lock, so this is the only non-racy way to state whether the authored prose
            // sitting above this record predates it. Reading the checkpoint's updated_at
            // separately would sit outside that lock and could itself stamp a stale date
            // — the very failure being fixed.
            transform: (prior) =>
              mergeWorkItemFlightRecord(
                prior,
                formatWorkItemFlightRecord({
                  ...base,
                  alsoStampedOnItemIds: uniqueItems.filter((_, i) => i !== index).map((other) => other.id),
                  priorAuthoredProse: hasPriorAuthoredProse(prior) ? 'present' : 'absent',
                }),
              ),
          },
        );
        capturedIds.push(item.id);
      } catch {
        /* fail-soft per item: lifecycle/interrupt handling must continue */
      }
    }
  } catch {
    /* fail-soft: this is recovery evidence, never a new availability dependency */
  }
  return { capturedIds };
}

/** Resolve the target's currently held items, then capture without releasing any claim. Never throws. */
export async function captureHeldWorkItemFlightRecordsForOwner(input: {
  ownerId: string;
  workspaceId: string;
  cause: WorkItemFlightRecordCause;
}): Promise<{ capturedIds: string[] }> {
  try {
    const workspaceId = resolveConcreteWorkspaceId(input.workspaceId);
    if (!workspaceId || !input.ownerId) return { capturedIds: [] };
    const { sql } = getOrgPg();
    const [features, issues] = await Promise.all([
      sql<Array<{ id: string; harness: string }>>`
        SELECT feature_id AS id, harness_slug AS harness
          FROM harness_shared.harness_features_consolidated
         WHERE workspace_id = ${workspaceId} AND taken_by = ${input.ownerId}`,
      sql<Array<{ id: string; scope: string | null }>>`
        SELECT issue_id AS id, scope
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${workspaceId} AND assignee = ${input.ownerId}`,
    ]);
    return captureWorkItemFlightRecordsForItems({
      ...input,
      workspaceId,
      items: [
        ...features.map((row) => ({ id: row.id, harness: row.harness })),
        ...issues.map((row) => ({ id: row.id, harness: harnessFromIssueScope(row.scope) })),
      ],
    });
  } catch {
    return { capturedIds: [] };
  }
}
