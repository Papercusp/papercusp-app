/**
 * session-audit.ts — structured session-audit digest (WI-4958).
 *
 * soak-report.ts's `contextBurn` metrics answer ONE workspace-level question:
 * "is per-wake overhead within budget right now?" (a READY/NOT-READY gate).
 * This module answers the deeper "why" a peer currently has to answer by
 * grepping raw session JSONL by hand:
 *
 *   - compactions: the disciplined `session:request-compaction` path (a durable
 *     PG row) reconciled against the REAL count — every compaction, requested
 *     or Claude's own native auto-compact, writes the SAME `isCompactSummary`
 *     transcript marker (compaction-usage.ts's COMPACT_BOUNDARY_MARKER). A
 *     session that hits its limit and auto-compacts without ever calling the
 *     tool leaves NO PG row, so `requested` alone silently undercounts —
 *     scanning transcripts for the marker is what closes that gap.
 *   - invalid-call clusters: the SAME tool failing repeatedly for ONE session
 *     within a short window — a stuck retry loop, not a one-off.
 *   - gate transitions: green-checkpoint / deploy status flips in the window.
 *   - recurring friction: the SAME failure signature recurring across
 *     DIFFERENT sessions — a systemic problem worth fixing once, not N times.
 *
 * Same split as soak-report.ts: pure compute (unit-testable, no PG/FS) vs.
 * PG/FS orchestration (`readSessionAuditDigest`, integration-tested for the PG
 * half; the transcript scan is unit-tested directly against real temp files —
 * see session-audit.test.ts).
 */
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { resolvePotMembership } from './survey';
import { findSessionTranscript } from '../claude-sessions';
import { COMPACT_BOUNDARY_MARKER } from '../compaction-usage';

// ── invalid-call clustering (pure) ──────────────────────────────────────────

export interface FailedCallRow {
  ownerId: string;
  toolName: string;
  invokedAtMs: number;
  errorMessage: string | null;
}

export interface InvalidCallCluster {
  ownerId: string;
  toolName: string;
  count: number;
  firstAtMs: number;
  lastAtMs: number;
  sampleError: string | null;
}

/** A cluster needs at least this many failed calls of the SAME tool by the
 *  SAME owner to be reported — 1-2 isolated failures are noise, not a stuck
 *  loop. */
export const INVALID_CALL_CLUSTER_MIN_COUNT = 3;
/** Consecutive failures more than this far apart are two separate incidents,
 *  not one run. */
export const INVALID_CALL_CLUSTER_GAP_MS = 10 * 60_000;

/**
 * Group failed tool_invocations rows into CLUSTERS: consecutive-in-time runs of
 * the same (ownerId, toolName) failing repeatedly, gap-bounded so two unrelated
 * incidents hours apart never merge into one. Pure — no PG/FS — so the
 * clustering LOGIC is directly unit-testable against synthetic rows.
 */
export function clusterInvalidCalls(
  rows: readonly FailedCallRow[],
  opts: { minCount?: number; gapMs?: number } = {},
): InvalidCallCluster[] {
  const minCount = opts.minCount ?? INVALID_CALL_CLUSTER_MIN_COUNT;
  const gapMs = opts.gapMs ?? INVALID_CALL_CLUSTER_GAP_MS;

  const byGroup = new Map<string, FailedCallRow[]>();
  for (const row of rows) {
    const key = `${row.ownerId}\0${row.toolName}`;
    const list = byGroup.get(key);
    if (list) list.push(row);
    else byGroup.set(key, [row]);
  }

  const clusters: InvalidCallCluster[] = [];
  for (const groupRows of byGroup.values()) {
    const sorted = [...groupRows].sort((a, b) => a.invokedAtMs - b.invokedAtMs);
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const brokeRun = i === sorted.length || sorted[i].invokedAtMs - sorted[i - 1].invokedAtMs > gapMs;
      if (!brokeRun) continue;
      const run = sorted.slice(runStart, i);
      if (run.length >= minCount) {
        clusters.push({
          ownerId: run[0].ownerId,
          toolName: run[0].toolName,
          count: run.length,
          firstAtMs: run[0].invokedAtMs,
          lastAtMs: run[run.length - 1].invokedAtMs,
          sampleError: run.find((r) => r.errorMessage)?.errorMessage ?? null,
        });
      }
      runStart = i;
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

// ── recurring friction (pure) ───────────────────────────────────────────────

export interface FrictionSignature {
  toolName: string;
  signature: string;
  occurrences: number;
  distinctOwners: number;
  sampleError: string | null;
}

/** A friction signature needs at least this many occurrences... */
export const RECURRING_FRICTION_MIN_OCCURRENCES = 3;
/** ...spread across at least this many DISTINCT sessions to count as
 *  "recurring" (systemic) rather than one session repeatedly hitting its own
 *  bug (that case is an invalid-call CLUSTER, not friction). */
export const RECURRING_FRICTION_MIN_OWNERS = 2;

/**
 * Collapse volatile tokens (uuids, numbers, quoted literals) out of an error
 * message so the SAME class of failure — e.g. "relation X does not exist" for
 * different table names, or "not found: <id>" for different ids — groups
 * together instead of every exact string standing alone as its own signature.
 * Deliberately coarse: false-merges (two genuinely different failures grouped
 * together) are cheap to eyeball via `sampleError`; false-splits (the same
 * failure counted many times over) are what actually hides a recurring
 * problem, so this errs toward merging.
 */
export function normalizeErrorSignature(message: string | null | undefined): string {
  if (!message) return '(no error message)';
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/"[^"]*"/g, '"<value>"')
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/\b\d+\b/g, '<n>')
    .trim()
    .slice(0, 200);
}

/**
 * The friction signal: failure SIGNATURES (toolName + normalized error) that
 * recur across MULTIPLE distinct sessions in the window — a systemic issue an
 * individual session's own retry-cluster (clusterInvalidCalls above) cannot
 * surface, since it never groups across owners.
 */
export function computeRecurringFriction(
  rows: readonly FailedCallRow[],
  opts: { minOccurrences?: number; minOwners?: number } = {},
): FrictionSignature[] {
  const minOccurrences = opts.minOccurrences ?? RECURRING_FRICTION_MIN_OCCURRENCES;
  const minOwners = opts.minOwners ?? RECURRING_FRICTION_MIN_OWNERS;

  const byKey = new Map<
    string,
    { toolName: string; signature: string; owners: Set<string>; count: number; sampleError: string | null }
  >();
  for (const row of rows) {
    const signature = normalizeErrorSignature(row.errorMessage);
    const key = `${row.toolName}\0${signature}`;
    let g = byKey.get(key);
    if (!g) {
      g = { toolName: row.toolName, signature, owners: new Set(), count: 0, sampleError: row.errorMessage ?? null };
      byKey.set(key, g);
    }
    g.owners.add(row.ownerId);
    g.count += 1;
  }

  return [...byKey.values()]
    .filter((g) => g.count >= minOccurrences && g.owners.size >= minOwners)
    .map((g) => ({
      toolName: g.toolName,
      signature: g.signature,
      occurrences: g.count,
      distinctOwners: g.owners.size,
      sampleError: g.sampleError,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.distinctOwners - a.distinctOwners);
}

// ── native-compaction transcript scan (fs, unit-testable against real files) ─

/** A transcript above this size is read via a streaming line reader rather
 *  than slurped whole — the marker-count scan never needs the whole file in
 *  memory at once regardless of transcript size. */
const STREAM_READ_THRESHOLD_BYTES = 2 * 1024 * 1024;

/**
 * Count occurrences of Claude's raw compaction-boundary marker in a transcript
 * file — one per REAL compaction (requested or native auto-compact; both write
 * the identical marker, see request-compaction.ts's `/compact` injection).
 * Line-based (JSONL is one record per line; the marker never spans lines), so
 * this is exact regardless of file size, and memory-bounded via a streaming
 * reader for anything past a small threshold. Returns null on any read error
 * (missing/rotated file, permission) — callers must treat null as "unknown",
 * never silently fold it into 0 (the bg-host journalError convention: absent
 * evidence must never masquerade as evidence of absence).
 */
export async function countCompactionMarkersInTranscript(pathStr: string): Promise<number | null> {
  try {
    const stats = await stat(pathStr);
    if (stats.size < STREAM_READ_THRESHOLD_BYTES) {
      const text = await readFile(pathStr, 'utf8');
      let count = 0;
      for (const line of text.split('\n')) {
        if (line.includes(COMPACT_BOUNDARY_MARKER)) count += 1;
      }
      return count;
    }
    let count = 0;
    const rl = createInterface({ input: createReadStream(pathStr, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.includes(COMPACT_BOUNDARY_MARKER)) count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

// ── compaction reconciliation (PG requested-count + FS native-count) ───────

export interface SessionCompactionDetail {
  ownerId: string;
  agent: string | null;
  /** session:request-compaction calls this owner made in the window (PG). */
  requested: number;
  /** isCompactSummary markers found in this owner's transcript (FS scan; null
   *  when the transcript could not be resolved/read — see scanError). */
  nativeDetected: number | null;
  scanError: string | null;
}

export interface CompactionAudit {
  /** Total session:request-compaction calls in the window (the disciplined
   *  path — mirrors soak-report's ContextBurnMetrics.requestedCompactions). */
  requestedTotal: number;
  /** Sum of nativeDetected over every session successfully scanned — the REAL
   *  compaction count (requested calls ALSO write this marker, so this is a
   *  superset, not an addition). */
  nativeTotal: number;
  /** Owners resolved as candidates to scan (bounded by maxSessions). */
  sessionsCandidates: number;
  /** Owners actually scanned successfully (nativeDetected != null). */
  sessionsScanned: number;
  /** Owners whose transcript could not be read — visibility, never silently
   *  folded into 0 (the bg-host journalError convention). */
  scanErrors: number;
  /** Candidates dropped by the maxSessions cap — never silently invisible. */
  sessionsSkippedCap: number;
  /** requestedTotal / nativeTotal — the fraction of REAL compactions that went
   *  through the disciplined tool call. null when nativeTotal is 0 (nothing to
   *  divide) so a caller never mistakes "no evidence" for "1.0 disciplined". */
  disciplinedRatio: number | null;
  perSession: SessionCompactionDetail[];
}

/** Bound the number of transcripts scanned per digest call — a large pot can
 *  have hundreds of sessions in a 24h window, and this reads real files off
 *  disk (unlike the rest of the digest, which is pure PG). Overflow is
 *  reported via `sessionsSkippedCap`, never silently dropped. */
export const MAX_COMPACTION_SESSIONS_SCANNED = 60;

type RequestedCompactionRow = { coord_owner_id: string | null; n: number };
type CandidateSessionRow = { coord_owner_id: string; agent: string | null; session_id: string };

/**
 * Reconcile the disciplined (PG) compaction count against the REAL (transcript
 * marker) count for sessions active in the window. WORKSPACE-scoped, matching
 * soak-report's ContextBurnMetrics compaction query (compactions key on owner
 * ids, not harness membership).
 */
export async function readCompactionAudit(
  sql: Sql,
  opts: { workspaceId: string; windowHours: number; maxSessions?: number },
): Promise<CompactionAudit> {
  const { workspaceId, windowHours } = opts;
  const maxSessions = opts.maxSessions ?? MAX_COMPACTION_SESSIONS_SCANNED;

  const [requestedRows, candidateRows] = await Promise.all([
    sql<RequestedCompactionRow[]>`
      SELECT coord_owner_id, count(*)::int AS n
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId}
         AND tool_name = 'session:request-compaction'
         AND status = 'ok'
         AND invoked_at >= now() - make_interval(hours => ${windowHours})
       GROUP BY coord_owner_id
    `,
    // The most recent session per owner active in (or still live past) the
    // window — the candidate set to scan for the native marker. Claude-only
    // in v1 (matches compaction-usage.ts's scope: OMP self-compacts natively
    // with no isCompactSummary-equivalent wired here, Codex has no compaction).
    sql<CandidateSessionRow[]>`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, agent, session_id
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${workspaceId}
         AND coord_owner_id IS NOT NULL
         AND session_id IS NOT NULL
         AND (agent IS NULL OR agent = 'claude')
         AND (started_at >= now() - make_interval(hours => ${windowHours}) OR ended_at IS NULL)
       ORDER BY coord_owner_id, started_at DESC
    `,
  ]);

  const requestedByOwner = new Map<string, number>();
  let requestedTotal = 0;
  for (const row of requestedRows) {
    if (!row.coord_owner_id) continue;
    const n = Number(row.n ?? 0);
    requestedByOwner.set(row.coord_owner_id, n);
    requestedTotal += n;
  }

  const sessionsCandidates = candidateRows.length;
  const toScan = candidateRows.slice(0, maxSessions);
  const sessionsSkippedCap = Math.max(0, sessionsCandidates - toScan.length);

  const perSession = await Promise.all(
    toScan.map(async (row): Promise<SessionCompactionDetail> => {
      const requested = requestedByOwner.get(row.coord_owner_id) ?? 0;
      try {
        const p = await findSessionTranscript(row.session_id, { owner: row.coord_owner_id });
        if (!p) {
          return { ownerId: row.coord_owner_id, agent: row.agent, requested, nativeDetected: null, scanError: 'transcript not found' };
        }
        const nativeDetected = await countCompactionMarkersInTranscript(p);
        return {
          ownerId: row.coord_owner_id,
          agent: row.agent,
          requested,
          nativeDetected,
          scanError: nativeDetected == null ? 'transcript unreadable' : null,
        };
      } catch (e) {
        return {
          ownerId: row.coord_owner_id,
          agent: row.agent,
          requested,
          nativeDetected: null,
          scanError: e instanceof Error ? e.message : 'transcript resolution failed',
        };
      }
    }),
  );

  let nativeTotal = 0;
  let sessionsScanned = 0;
  let scanErrors = 0;
  for (const s of perSession) {
    if (s.nativeDetected != null) {
      nativeTotal += s.nativeDetected;
      sessionsScanned += 1;
    } else {
      scanErrors += 1;
    }
  }

  return {
    requestedTotal,
    nativeTotal,
    sessionsCandidates,
    sessionsScanned,
    scanErrors,
    sessionsSkippedCap,
    disciplinedRatio: nativeTotal > 0 ? requestedTotal / nativeTotal : null,
    perSession,
  };
}

// ── gate transitions (PG) ───────────────────────────────────────────────────

export interface GateTransition {
  kind: string;
  status: string;
  createdAtMs: number;
}

/** Bound the transitions returned — a digest is a recent-activity read, not a
 *  full history export. */
export const MAX_GATE_TRANSITIONS = 200;

type GateTransitionRow = { kind: string; status: string; created_at: string | Date };

export async function readGateTransitions(
  sql: Sql,
  opts: { potSlug: string; windowHours: number; limit?: number },
): Promise<GateTransition[]> {
  const { potSlug, windowHours } = opts;
  const limit = opts.limit ?? MAX_GATE_TRANSITIONS;
  const rows = await sql<GateTransitionRow[]>`
    SELECT kind, status, created_at
      FROM harness_shared.pipeline_events
     WHERE install_slug = ${potSlug}
       AND kind IN ('green_checkpoint', 'deploy')
       AND created_at >= now() - make_interval(hours => ${windowHours})
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    kind: r.kind,
    status: r.status,
    createdAtMs: r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime(),
  }));
}

// ── failed-call rows (PG) — feeds BOTH clusterInvalidCalls and computeRecurringFriction ─

/** Bound how many failed-call rows a single digest pulls from PG — clustering
 *  and friction are both cheap over this, and a pathological window (a fleet
 *  wide incident) must not make the digest itself expensive to compute. */
export const MAX_FAILED_CALL_ROWS = 5_000;

type FailedCallDbRow = { coord_owner_id: string | null; tool_name: string; invoked_at: string | Date; error_message: string | null };

export async function readFailedCallRows(
  sql: Sql,
  opts: { workspaceId: string; surveySlugs: string[]; windowHours: number; limit?: number },
): Promise<FailedCallRow[]> {
  const { workspaceId, surveySlugs, windowHours } = opts;
  const limit = opts.limit ?? MAX_FAILED_CALL_ROWS;
  const rows = await sql<FailedCallDbRow[]>`
    SELECT coord_owner_id, tool_name, invoked_at, error_message
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ANY(${sql.array(surveySlugs)})
       AND status <> 'ok'
       AND coord_owner_id IS NOT NULL
       AND invoked_at >= now() - make_interval(hours => ${windowHours})
     ORDER BY invoked_at DESC
     LIMIT ${limit}
  `;
  return rows
    .filter((r): r is FailedCallDbRow & { coord_owner_id: string } => r.coord_owner_id != null)
    .map((r) => ({
      ownerId: r.coord_owner_id,
      toolName: r.tool_name,
      invokedAtMs: r.invoked_at instanceof Date ? r.invoked_at.getTime() : new Date(r.invoked_at).getTime(),
      errorMessage: r.error_message,
    }));
}

// ── the assembled digest ────────────────────────────────────────────────────

export interface SessionAuditDigest {
  potSlug: string;
  surveyScope: 'members' | 'workspace';
  surveySlugs: string[];
  windowHours: number;
  generatedAt: string;
  compactions: CompactionAudit;
  invalidCallClusters: InvalidCallCluster[];
  gateTransitions: GateTransition[];
  recurringFriction: FrictionSignature[];
}

export async function readSessionAuditDigest(
  potSlug: string,
  opts: { windowHours?: number; sql?: Sql } = {},
): Promise<SessionAuditDigest> {
  const windowHours = Math.min(Math.max(Math.trunc(opts.windowHours ?? 24), 1), 24 * 7);
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = activeWorkspaceId();
  const membership = await resolvePotMembership(workspaceId, potSlug);
  const surveySlugs = membership.surveySlugs.length > 0 ? membership.surveySlugs : [potSlug];

  const [compactions, failedCallRows, gateTransitions] = await Promise.all([
    readCompactionAudit(sql, { workspaceId, windowHours }),
    readFailedCallRows(sql, { workspaceId, surveySlugs, windowHours }),
    readGateTransitions(sql, { potSlug, windowHours }),
  ]);

  return {
    potSlug,
    surveyScope: membership.scope,
    surveySlugs,
    windowHours,
    generatedAt: new Date().toISOString(),
    compactions,
    invalidCallClusters: clusterInvalidCalls(failedCallRows),
    gateTransitions,
    recurringFriction: computeRecurringFriction(failedCallRows),
  };
}
