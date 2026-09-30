/**
 * Same-turn proof for carry-surface coordination-action claims.
 *
 * The provenance lint deliberately warns when a checkpoint says that the writer
 * messaged/posted/pinged a coordination target without a turn ref.  A successful
 * tool-ledger row is stronger evidence than the checkpoint's prose, so this
 * module supplies a narrow, fail-soft proof path for the two coordination tools
 * whose input arguments contain the target of the side effect.
 *
 * The query is intentionally scoped to one concrete workspace and, when
 * available, the caller's spawn. Interactive continuations can carry an
 * absent/ephemeral spawn id, so an empty spawn-scoped read falls back to the
 * stable coordination owner id. Only successful rows are read. Returned ids
 * (await_id/msg_id) are not stored in args_json and therefore cannot prove a
 * claim by themselves.
 */

import type { ProvenanceLintMatch, ProvenanceLintResult } from './carry-surface-provenance-lint';

export const ACTION_PROOF_TOOL_NAMES = ['events:await', 'coord:send'] as const;
export const ACTION_PROOF_SCAN_ROWS = 64;

export interface SuccessfulActionInvocation {
  toolName: string | null | undefined;
  args: unknown;
}

type StampedProvenanceLint = {
  flagged: true;
  note: string;
  matches: ProvenanceLintMatch[];
};

export interface ActionProofReadOptions {
  workspaceId?: string | null;
  spawnId?: string | null;
  /** Stable coordination identity used when spawn_id is absent or has no rows. */
  coordOwnerId?: string | null;
  limit?: number;
}

/** Normalize the colon and client-prefixed spellings found in telemetry. */
export function normalizeActionToolName(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  const unprefixed = raw.replace(/^mcp__.+?__/, '');
  return unprefixed.replace(/_/g, ':');
}

const ACTION_VERB_RE =
  /\b(?:posted|messaged|commented|notified|pinged|dispatched|replied|escalated|sent|handed(?:\s+it)?\s+off|reached\s+out|wrote\s+to)\b/i;

// Keep this narrower than the lint's target grammar.  Generic words such as
// "peer" or "fleet leader" are not stable enough to prove that a particular
// side effect happened; concrete ids/refs in the tool args are.
const STABLE_TARGET_RE =
  /\b(?:WI|EI|F)-\d+\b|\bsu-[0-9a-f]{4,}\b|\bposts?\s*[-:#]?\s*\d+\b/gi;

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const parsed = value.trim() ? parseJsonString(value) : value;
    if (parsed !== value) return stringLeaves(parsed, out);
    out.push(value);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) stringLeaves(child, out);
  }
  return out;
}

function canonicalTarget(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (/^(?:wi|ei|f)-\d+$/.test(value)) return value.toUpperCase();
  if (/^su-[0-9a-f]{4,}$/.test(value)) return value;
  const post = /^posts?\s*[-:#]?\s*(\d+)$/.exec(value);
  if (post) return `post:${post[1]}`;
  return null;
}

/** Extract only concrete coordination ids/refs from prose or args_json. */
export function stableActionTargets(value: unknown): string[] {
  const targets = new Set<string>();
  for (const leaf of stringLeaves(value)) {
    for (const match of leaf.matchAll(STABLE_TARGET_RE)) {
      const target = canonicalTarget(match[0]);
      if (target) targets.add(target);
    }
  }
  return [...targets];
}

/** Cheap gate used by checkpoint writes to avoid a ledger query for ordinary prose. */
export function hasPotentialActionClaim(text: string | null | undefined): boolean {
  if (!text || !ACTION_VERB_RE.test(text)) return false;
  return stableActionTargets(text).length > 0;
}

/** A successful invocation proves a line only when its concrete target is in args_json. */
export function provesActionClaim(
  line: string,
  invocation: SuccessfulActionInvocation,
): boolean {
  if (!ACTION_PROOF_TOOL_NAMES.includes(normalizeActionToolName(invocation.toolName) as (typeof ACTION_PROOF_TOOL_NAMES)[number])) {
    return false;
  }
  const lineTargets = stableActionTargets(line);
  if (lineTargets.length === 0) return false;
  const argTargets = new Set(stableActionTargets(invocation.args));
  return lineTargets.some((target) => argTargets.has(target));
}

/** Remove only proven first-person action matches; peer-reported and unmatched findings remain. */
export function suppressProvenActionClaims(
  lint: StampedProvenanceLint | undefined,
  invocations: readonly SuccessfulActionInvocation[] | null | undefined,
): StampedProvenanceLint | undefined;
export function suppressProvenActionClaims(
  lint: ProvenanceLintResult | undefined,
  invocations: readonly SuccessfulActionInvocation[] | null | undefined,
): ProvenanceLintResult | undefined;
export function suppressProvenActionClaims(
  lint: ProvenanceLintResult | StampedProvenanceLint | undefined,
  invocations: readonly SuccessfulActionInvocation[] | null | undefined,
): ProvenanceLintResult | StampedProvenanceLint | undefined {
  if (!lint?.flagged || !invocations?.length) return lint;
  const matches = lint.matches.filter(
    (match: ProvenanceLintMatch) =>
      match.kind !== 'unverified-action-claim' || !invocations.some((invocation) => provesActionClaim(match.line, invocation)),
  );
  return matches.length ? ({ ...lint, matches, flagged: true } as typeof lint) : undefined;
}

/**
 * Read successful same-turn action calls.  `null` means the read was unavailable;
 * callers must preserve the lint in that case rather than treating it as proof of
 * absence.  Empty arrays are a successful read with no matching calls.
 */
export async function readSuccessfulActionInvocations(
  options: ActionProofReadOptions,
): Promise<SuccessfulActionInvocation[] | null> {
  const workspaceId = options.workspaceId?.trim();
  const spawnId = options.spawnId?.trim();
  const coordOwnerId = options.coordOwnerId?.trim();
  if (!workspaceId || (!spawnId && !coordOwnerId)) return null;
  const limit = Math.min(Math.max(options.limit ?? ACTION_PROOF_SCAN_ROWS, 1), ACTION_PROOF_SCAN_ROWS);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const readRows = async (
      scope: 'spawn' | 'owner',
    ): Promise<Array<{ tool_name: string | null; args_json: unknown }>> => {
      if (scope === 'spawn') {
        const scopedSpawnId = spawnId;
        if (!scopedSpawnId) return [];
        return await sql<Array<{ tool_name: string | null; args_json: unknown }>>`
          SELECT tool_name, args_json
            FROM harness_shared.tool_invocations
           WHERE workspace_id = ${workspaceId}
             AND spawn_id = ${scopedSpawnId}
             AND status = 'ok'
             AND tool_name = ANY(${[...ACTION_PROOF_TOOL_NAMES]})
           ORDER BY invoked_at DESC
           LIMIT ${limit}
        `;
      }
      const scopedOwnerId = coordOwnerId;
      if (!scopedOwnerId) return [];
      return await sql<Array<{ tool_name: string | null; args_json: unknown }>>`
        SELECT tool_name, args_json
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND coord_owner_id = ${scopedOwnerId}
           AND status = 'ok'
           AND tool_name = ANY(${[...ACTION_PROOF_TOOL_NAMES]})
         ORDER BY invoked_at DESC
         LIMIT ${limit}
      `;
    };

    // Prefer the narrow spawn key. An empty result means this continuation's
    // action rows were stamped under another/ephemeral spawn, so consult the
    // stable owner key before declaring the ledger empty. A non-empty result
    // is authoritative for the current spawn and avoids widening the proof
    // surface unnecessarily.
    const rows = spawnId ? await readRows('spawn') : [];
    const scopedRows = rows.length > 0 || !coordOwnerId ? rows : await readRows('owner');
    return scopedRows.map((row) => ({ toolName: row.tool_name, args: row.args_json }));
  } catch {
    return null;
  }
}
