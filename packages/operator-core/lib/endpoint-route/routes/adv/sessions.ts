/**
 * /api/adv/sessions/* — read + control routes for the /adv/sessions
 * UI. Backed by harness_shared.adv_sessions (migration 079).
 *
 *   GET /api/adv/sessions                 → list rows
 *   POST /api/adv/sessions/focus           → bring a window to front
 *   POST /api/adv/sessions/rename          → set/clear a session's display name
 *   GET /api/adv/sessions/alive?pid=N      → is the pid still alive?
 *
 * Public endpoints — operator binds loopback-only. Mirrors the
 * /api/admin/* pattern (no extra principal gate at the route layer).
 */

import os from 'node:os';
import { createHash } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import type { SearchFilters, RecencyRank, MatchProvenance } from '@papercusp/search';
import type { TranscriptTurnHit } from '../../../adv-session-search';
import { createQueryEmbedderWarmup } from '../../../search/query-embedder-warmup';
import { fitsProseColumns } from '../../../search/prose-vector-dims';
import { closeWindowId } from '../../../adv-session-windows';
import { focusSessionWindow, resolveSessionWindowId } from '../../../adv-session-focus';
import {
  advSessionRowCaveats,
  fallbackCodexLaunchSpecFromAdvSession,
  getAdvSession,
  getAdvSessionInWorkspace,
  listAdvSessions,
  listEndedAdvSessions,
  listPendingWorkbenchLaunches,
  listResumableSessions,
  listStartingTerminalLaunches,
  advSessionsByIdToken,
  markAdvSessionLaunched,
  setAdvSessionOmpThreadId,
  updateAdvSessionPortStatus,
} from '../../../adv-sessions';
import { withFieldReliability } from '../../../field-reliability';
import { notifySyncInvalidate } from '../../../sync-sse';
import {
  mergeRosterWithAssignments,
  resolveThinkingForEntries,
  dedupeEndedAgainstActive,
  pendingLaunchesToRosterEntries,
  startingLaunchesToRosterEntries,
  readStartingLaunchLogHints,
  dedupeStartingAgainstActive,
} from '../../../adv-roster';
// Pure recency-param parsing (WI-5097) + the pure id-search half (WI-37204 —
// `parseSessionIdQuery` has to run BEFORE the search so the id lookup can start
// concurrently with it). The rest of adv-session-search stays dynamically
// imported inside the handler with the other search-only deps.
import {
  parseRecencyParams,
  parseSessionIdQuery,
  buildIdMatchResults,
  mergeIdMatches,
} from '../../../adv-session-search';
import { gatherOnDesktopSessions } from '../../../desktop-window-liveness';
import { setOnDesktopWindowsCache, type WindowsDesktopWindow } from '../../../windows-desktop-windows';
import { readOmpConfig } from '../../../omp-config';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TRANSFORM_VERSION } from '../../../session-port/types';
import { evidenceIncarnationOwnedBy } from '../../../session-port/source';
export { evidenceIncarnationOwnedBy } from '../../../session-port/source';
import { normalizeSuContextSize } from '../../../su-context-size.mjs';
import {
  classifySessionPortFailure,
  recordSessionPortTelemetry,
  telemetryFromInspection,
} from '../../../session-port/telemetry';
import {
  findOmpSessionNear,
  getOmpSessionRowSummary,
  getOmpSessionState,
  searchOmpSessions,
} from '../../../omp-sessions';
import type {
  ArchiveSourceKind,
  ArchiveStampRow,
  RematerializeResult,
  SessionArchiveStore,
} from '../../../session-archive';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/**
 * Process-local query-embedder selection for the interactive transcript search.
 *
 * `runHybridSearch` resolves P-017 defaults before its legs start, so the
 * engine must receive the exact stamped embedder function when warm. While
 * cold, the selector hands it a throw-only embedder: lexical retrieval still
 * returns immediately and the semantic leg is explicitly marked blocked while
 * one shared warmup prepares the next request.
 */
const transcriptQueryEmbedderWarmup = createQueryEmbedderWarmup({
  warmupText: 'transcript search embedder warmup',
  retryTokenPrefix: 'transcript-search-embedder-warmup',
  resolve: async () => {
    const { buildQueryEmbedderResolved } = await import('../../../agent-tools/search/embedder');
    return await buildQueryEmbedderResolved();
  },
  validate: (resolved) =>
    fitsProseColumns(resolved.dims)
      ? null
      : `query embedder dims ${resolved.dims} do not fit the prose embedding columns`,
  retryAfterMs: 1_000,
});

type RematerializeJobResult = RematerializeResult & {
  sourceKind: ArchiveSourceKind;
  owner: string | null;
  cwd: string | null;
  sessionRoot: string;
};

/**
 * A client can time out while the synchronous archive restore is still
 * running. Keep the promise observable until its final disk write settles so
 * the status route can distinguish that state from a missing archive.
 */
const rematerializeInFlight = new Map<string, Promise<RematerializeJobResult>>();

function rematerializeJobKey(sourceKind: ArchiveSourceKind, sessionId: string): string {
  return `${sourceKind}:${sessionId}`;
}

async function startRematerializeJob({
  sourceKind,
  sessionId,
  stamp,
  store,
  rematerializeSession,
}: {
  sourceKind: ArchiveSourceKind;
  sessionId: string;
  stamp: ArchiveStampRow;
  store: SessionArchiveStore;
  rematerializeSession: (key: { sourceKind: ArchiveSourceKind; sessionId: string }, store: SessionArchiveStore) => Promise<RematerializeResult>;
}): Promise<RematerializeJobResult> {
  const key = rematerializeJobKey(sourceKind, sessionId);
  const existing = rematerializeInFlight.get(key);
  if (existing) return existing;

  const job = (async () => {
    const result = await rematerializeSession({ sourceKind, sessionId }, store);
    // psu-resume-relogin leg 2 (owner-reported 2026-07-12): the archive holds
    // ONLY the transcript, so a claude rematerialize yielded a config dir with
    // no `.claude.json`/settings/credentials — an INTERACTIVE `psu --resume`
    // then boots claude into first-run onboarding (a login screen) despite a
    // healthy system login. Re-ensure the full interactive dir (idempotent —
    // keeps the restored transcript and any parked playbook) so a
    // rematerialized dir is launch-ready, not just transcript-bearing.
    // Guarded to the conventional per-owner dir so a foreign session_root is
    // never shadowed; best-effort — the restore itself already succeeded.
    if (result.ok && sourceKind === 'claude' && stamp.owner) {
      try {
        const [{ ensureInteractiveClaudeConfig }, { sessionClaudeConfigDir }] = await Promise.all([
          import('../../../interactive-claude-config'),
          import('@papercusp/orchestrator/session-launch-dirs'),
        ]);
        if (sessionClaudeConfigDir(stamp.owner) === stamp.session_root) {
          await ensureInteractiveClaudeConfig({ sid: stamp.owner });
        }
      } catch (e) {
        console.warn(`[rematerialize] interactive-config seed failed for ${sessionId}: ${(e as Error)?.message ?? e}`);
      }
    }
    return { ...result, sourceKind, owner: stamp.owner, cwd: stamp.cwd, sessionRoot: stamp.session_root };
  })();
  rematerializeInFlight.set(key, job);
  void job.finally(() => {
    if (rematerializeInFlight.get(key) === job) rematerializeInFlight.delete(key);
  }).catch(() => {
    // The original request reports the failure; the registry cleanup must not
    // create an unhandled rejection when a client has already timed out.
  });
  return job;
}
type SessionPortRequestBody = {
  protocolVersion?: unknown;
  transformVersion?: unknown;
  workspace?: unknown;
  sourceAdvSessionId?: unknown;
  targetBackend?: unknown;
  targetModel?: unknown;
  targetAccount?: unknown;
  targetOwnerId?: unknown;
  contextSize?: unknown;
  launchContext?: unknown;
  expectedSourceHash?: unknown;
  currentInstruction?: unknown;
  consultEvidenceSpan?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A claude/codex native session uuid — the only shape `/adv/sessions/resumable?sessionId=` resolves. */
const RESUMABLE_NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionPortProtocolError(version: unknown, transformVersion: unknown): Response | null {
  if (version === SESSION_PORT_PROTOCOL_VERSION && transformVersion === SESSION_PORT_TRANSFORM_VERSION) return null;
  return json({
    ok: false,
    error: `unsupported session-port protocol/transform ${String(version)}/${String(transformVersion)}; upgrade psu/operator together`,
    supportedProtocolVersions: [SESSION_PORT_PROTOCOL_VERSION],
    supportedTransformVersions: [SESSION_PORT_TRANSFORM_VERSION],
  }, 426);
}

async function parseSessionPortBody(req: Request): Promise<SessionPortRequestBody | Response> {
  try {
    const body = await req.json() as SessionPortRequestBody;
    return body && typeof body === 'object' ? body : json({ ok: false, error: 'JSON object required' }, 400);
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }
}

async function resolveSessionPortInspection(req: Request, body: SessionPortRequestBody) {
  const protocolError = sessionPortProtocolError(body.protocolVersion, body.transformVersion);
  if (protocolError) return { response: protocolError } as const;
  const sourceAdvSessionId = Number(body.sourceAdvSessionId);
  if (!Number.isSafeInteger(sourceAdvSessionId) || sourceAdvSessionId <= 0) {
    return { response: json({ ok: false, error: 'sourceAdvSessionId must be a positive integer' }, 400) } as const;
  }
  const targetBackend = body.targetBackend;
  if (targetBackend !== 'claude' && targetBackend !== 'codex' && targetBackend !== 'omp') {
    return { response: json({ ok: false, error: 'targetBackend must be claude|codex|omp' }, 400) } as const;
  }
  const normalizedContextSize = normalizeSuContextSize(body.contextSize);
  if (!normalizedContextSize.ok) {
    return { response: json({ ok: false, error: `contextSize: ${normalizedContextSize.error}` }, 400) } as const;
  }
  const contextSize = normalizedContextSize.contextSize;
  const [{ activeWorkspaceId }, { getOrgPg }, { buildLaunchSpec }, service, budgetModule, store] = await Promise.all([
    import('../../../workspace-registry'),
    import('@papercusp/db-org'),
    import('../../../role-launch-spec'),
    import('../../../session-port/service'),
    import('../../../model-context-budget.mjs'),
    import('../../../session-port/store'),
  ]);
  const workspaceId = typeof body.workspace === 'string' && body.workspace.trim()
    ? body.workspace.trim()
    : activeWorkspaceId();
  await store.assertSessionPortStorageReady();
  const trackedRow = await getAdvSessionInWorkspace(sourceAdvSessionId, workspaceId);
  if (!trackedRow) return { response: json({ ok: false, error: 'tracked source session not found in target workspace' }, 404) } as const;
  service.resolveSessionPortTargetOwner(trackedRow.coordOwnerId ?? '', body.targetOwnerId);
  // The row whose transcript this port reads. Normally the tracked row itself;
  // for an evidence span in an earlier carry-respawn incarnation, the same row
  // re-pointed at that incarnation's native session (see
  // evidenceIncarnationOwnedBy). Identity, workspace and plan stay the row's.
  const sourceNativeId = trackedRow.agent === 'omp' ? trackedRow.ompThreadId ?? trackedRow.sessionId : trackedRow.sessionId;
  let sourceRow = { ...trackedRow, sessionId: sourceNativeId };
  let evidenceSpan: import('../../../session-port/service').SessionPortEvidenceSpan | undefined;
  if (body.consultEvidenceSpan != null) {
    const raw = body.consultEvidenceSpan;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { response: json({ ok: false, error: 'consultEvidenceSpan must be an object' }, 400) } as const;
    }
    const value = raw as { sessionId?: unknown; turnIndices?: unknown; contextTurns?: unknown };
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
    const turnIndices = Array.isArray(value.turnIndices) ? [...new Set(value.turnIndices)] : [];
    const contextTurns = value.contextTurns;
    if (!sessionId || turnIndices.length < 1 || turnIndices.length > 12 ||
        !turnIndices.every((index) => Number.isSafeInteger(index) && Number(index) >= 0) ||
        !Number.isSafeInteger(contextTurns) || Number(contextTurns) < 0 || Number(contextTurns) > 8) {
      return { response: json({ ok: false, error: 'consultEvidenceSpan must name this exact source session, 1–12 valid turn indices, and a context window from 0–8' }, 400) } as const;
    }
    const { sql } = getOrgPg();
    if (sessionId !== sourceNativeId) {
      if (!RESUMABLE_NATIVE_SESSION_ID_RE.test(sessionId) ||
          !(await evidenceIncarnationOwnedBy(sql as unknown as import('postgres').Sql, trackedRow, sessionId))) {
        return {
          response: json({
            ok: false,
            error: `consultEvidenceSpan must name this exact source session or an earlier incarnation of its owner: ` +
              `session ${sessionId} is neither tracked source #${trackedRow.id}'s current session nor latest-owned by ` +
              `${trackedRow.coordOwnerId ?? '(no owner)'}`,
          }, 400),
        } as const;
      }
      sourceRow = { ...trackedRow, sessionId, ...(trackedRow.agent === 'omp' ? { ompThreadId: sessionId } : {}) };
    }
    const indexed = await sql<Array<{ turn_idx: number; timestamp: string | Date | null; speaker: string; text: string }>>`
      SELECT t.turn_idx, t.ts AS timestamp, t.speaker, t.text
        FROM harness_shared.session_turns t
       WHERE (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
         AND t.source_kind = ${sourceRow.agent}
         AND t.session_id = ${sessionId}
         AND t.turn_idx = ANY(${turnIndices as number[]}::int[])
    `;
    if (indexed.length !== turnIndices.length) {
      return { response: json({ ok: false, error: `consult evidence refs are not all present in the exact source session (${indexed.length}/${turnIndices.length})` }, 409) } as const;
    }
    evidenceSpan = {
      sessionId,
      turnIndices: turnIndices as number[],
      contextTurns: Number(contextTurns),
      evidenceTurns: indexed.map((row) => ({
        turnIdx: row.turn_idx,
        timestamp: row.timestamp,
        speaker: row.speaker,
        text: row.text,
      })),
    };
  }
  const targetModel = typeof body.targetModel === 'string' && body.targetModel.trim() ? body.targetModel.trim() : null;
  const targetAccount = typeof body.targetAccount === 'string' && body.targetAccount.trim() ? body.targetAccount.trim() : 'default';
  const launchContextPath = typeof body.launchContext === 'string' && body.launchContext.trim() ? body.launchContext.trim() : null;
  let launchContextText = '';
  try {
    launchContextText = budgetModule.readLaunchContextText(launchContextPath);
  } catch (error) {
    return { response: json({ ok: false, error: `read launchContext: ${error instanceof Error ? error.message : String(error)}` }, 400) } as const;
  }
  const spec = await buildLaunchSpec({
    kind: 'su',
    agent: targetBackend,
    workspaceId,
    operatorBaseUrl: new URL(req.url).origin,
    harnessSlug: null,
    profile: 'engineer',
    contextSize,
    model: targetModel,
    planSlug: sourceRow.planSlug,
    planTitle: null,
    planNow: null,
  });
  const budget = budgetModule.buildContextBudget({
    agent: targetBackend,
    model: targetModel,
    contextSize,
    promptText: targetBackend === 'codex'
      ? budgetModule.appendCodexLaunchContextPrompt(spec.promptText, launchContextText)
      : spec.promptText,
    additionalPromptText: targetBackend === 'codex' ? '' : launchContextText,
    home: os.homedir(),
  });
  if (budget.level === 'refuse') throw new Error('target launch prompt already exhausts the selected context window');
  const stableSource = await service.acquireTrackedSessionSource(sourceRow);
  const modelProvider = targetBackend === 'codex'
    ? 'openai'
    : targetBackend === 'claude' ? 'anthropic'
    : (targetModel?.includes('/') ? targetModel.split('/')[0] : 'omp-configured-provider');
  const inspection = service.inspectAcquiredSessionPort({
    sourceRow,
    stableSource,
    target: {
      backend: targetBackend,
      provider: modelProvider,
      model: targetModel,
      account: targetAccount,
      contextWindow: budget.window,
      availableInputTokens: budget.availableInputTokens,
      contextSize,
      launchContextHash: createHash('sha256').update(launchContextText).digest('hex'),
      ...(body.targetOwnerId === undefined ? {} : { ownerId: body.targetOwnerId as string }),
    },
    currentInstruction: typeof body.currentInstruction === 'string' ? body.currentInstruction : null,
    ...(evidenceSpan ? { evidenceSpan } : {}),
  });
  return {
    inspection,
    service,
    budget,
    contextSizeNormalization: normalizedContextSize.normalizedLegacyFull
      ? { requested: 'full' as const, effective: 'trimmed' as const, deprecated: true as const }
      : null,
  } as const;
}

async function readOmpMemoryConfig(): Promise<Record<string, unknown>> {
  const wanted = new Set([
    'memory.backend',
    'hindsight.apiUrl',
    'hindsight.scoping',
    'hindsight.autoRecall',
    'hindsight.autoRetain',
    'hindsight.retainMode',
    'hindsight.recallBudget',
    'hindsight.recallMaxTokens',
  ]);
  try {
    const sections = await readOmpConfig();
    const values: Record<string, { value: unknown; raw: string; isUnset: boolean }> = {};
    for (const section of sections) {
      for (const setting of section.settings) {
        if (!wanted.has(setting.key)) continue;
        values[setting.key] = {
          value: setting.parsed,
          raw: setting.raw,
          isUnset: setting.isUnset,
        };
      }
    }
    return {
      ok: true,
      backend: values['memory.backend']?.value ?? null,
      hindsight: {
        apiUrl: values['hindsight.apiUrl']?.value ?? null,
        scoping: values['hindsight.scoping']?.value ?? null,
        autoRecall: values['hindsight.autoRecall']?.value ?? null,
        autoRetain: values['hindsight.autoRetain']?.value ?? null,
        retainMode: values['hindsight.retainMode']?.value ?? null,
        recallBudget: values['hindsight.recallBudget']?.value ?? null,
        recallMaxTokens: values['hindsight.recallMaxTokens']?.value ?? null,
      },
      values,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function resolveOmpSessionForRequest(req: Request): Promise<{
  advSession: Awaited<ReturnType<typeof getAdvSession>> | null;
  sessionId: string | null;
  filePath: string | null;
  match: ReturnType<typeof findOmpSessionNear> | null;
}> {
  const url = new URL(req.url);
  const advId = Number(url.searchParams.get('id') ?? NaN);
  const directSessionId = url.searchParams.get('sessionId');
  const directFilePath = url.searchParams.get('filePath');

  if (directSessionId || directFilePath) {
    return {
      advSession: null,
      sessionId: directSessionId,
      filePath: directFilePath,
      match: null,
    };
  }

  if (!Number.isFinite(advId) || advId <= 0) {
    return { advSession: null, sessionId: null, filePath: null, match: null };
  }

  const advSession = await getAdvSession(advId);
  if (!advSession || advSession.mode !== 'omp') {
    return { advSession, sessionId: null, filePath: null, match: null };
  }

  if (advSession.ompThreadId) {
    return { advSession, sessionId: advSession.ompThreadId, filePath: null, match: null };
  }

  const match = findOmpSessionNear({
    startedAtMs: new Date(advSession.startedAt).getTime(),
    cwd: advSession.cwd ?? undefined,
    windowMs: 5 * 60_000,
  });
  if (match?.id) {
    await setAdvSessionOmpThreadId(advSession.id, match.id);
  }
  return {
    advSession: match?.id ? { ...advSession, ompThreadId: match.id } : advSession,
    sessionId: match?.id ?? null,
    filePath: match?.filePath ?? null,
    match,
  };
}

function requestHasExplicitSessionScope(url: URL): boolean {
  return (
    url.searchParams.has('id') ||
    url.searchParams.has('sessionId') ||
    url.searchParams.has('filePath')
  );
}

const list = defineTool({
  method: 'GET',
  path: '/adv/sessions',
  auth: 'public',
  async handler() {
    const rows = await listAdvSessions(200);
    // Which of these sessions currently have a live OS window (a desktop the user
    // is looking at). Best-effort → empty set on a headless box / wmctrl failure,
    // so the column is simply absent rather than wrong.
    const onDesktop = await gatherOnDesktopSessions().catch(() => null);
    const onDesktopIds = onDesktop?.advSessionIds ?? new Set<number>();
    // For every OMP row, attach a lightweight row-summary read from
    // the JSONL. Done server-side so the client sees the final filtered
    // list on first paint — the previous client-side filter ran AFTER
    // a per-row lazy /state fetch and caused empty rows to flash in
    // and out as the summaries arrived.
    //
    // Filter rule (only applies to OMP rows):
    //   - If the JSONL is found AND has 0 user messages → drop (truly empty).
    //   - A missing JSONL (summary === null) is NOT proof of emptiness —
    //     the file may have been in a different path, cleaned up, or the
    //     ompThreadId hasn't been lazily resolved yet. Keep these rows.
    //   - The DB-level filter already removes truly dead-on-arrival rows
    //     (ended in <5s with no ompThreadId), so no additional startup-
    //     grace check is needed here.
    const withSummary = await Promise.all(
      rows.map(async (row) => {
        if (row.mode !== 'omp') return { row, summary: null };
        const summary = row.ompThreadId
          ? getOmpSessionRowSummary({ id: row.ompThreadId })
          : null;
        return { row, summary };
      }),
    );
    const STARTUP_GRACE_MS = 60_000;
    const now = Date.now();
    const filtered = withSummary.filter(({ row, summary }) => {
      if (row.mode !== 'omp') return true;
      // JSONL found with real content → definitely keep.
      if (summary && summary.userMessages > 0) return true;
      // JSONL found but confirmed empty (0 user messages) → drop unless
      // the session is fresh enough to still be initializing.
      if (summary !== null && summary.userMessages === 0) {
        const startedMs = Date.parse(row.startedAt);
        const inStartupGrace =
          Number.isFinite(startedMs) && now - startedMs < STARTUP_GRACE_MS;
        return inStartupGrace;
      }
      // summary === null: JSONL missing or ompThreadId not yet resolved.
      // Keep — the UI shows "state unavailable" gracefully; hiding the
      // row entirely loses the row from the user's session history.
      return true;
    });
    const responseRows = filtered.map(({ row, summary }) =>
      withFieldReliability(
        {
          ...row,
          summary,
          // true ⇒ this session has a live OS window on screen right now (and is
          // hard-exempt from the idle-session reaper).
          onDesktop: onDesktopIds.has(row.id),
        },
        // EI-22176001691325872: `endedAt`/`exitCode` are a sweeper's NOTICE, not an
        // observation, whenever the row's endedBy says so — see advSessionRowCaveats.
        advSessionRowCaveats(row),
      ),
    );
    return new Response(JSON.stringify({ rows: responseRows }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/** A JSON object body, or {} for an empty/invalid/non-object one. */
async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch { /* ignore — an unusable body is handled by each route's own validation */ }
  return {};
}

async function parseControlBody(
  req: Request,
): Promise<{ id?: number; pid?: number; windowId?: string | null }> {
  // Empty/invalid bodies land as {} and are handled by the resolver returning null.
  return (await parseJsonBody(req)) as { id?: number; pid?: number; windowId?: string | null };
}

const focus = defineTool({
  method: 'POST',
  path: '/adv/sessions/focus',
  auth: 'loopback',
  async handler(req) {
    const body = await parseControlBody(req);
    const latestRow =
      typeof body.id === 'number' && body.id > 0 ? await getAdvSession(body.id) : null;
    const result = await focusSessionWindow(body, latestRow);
    if (!result.focused) {
      return new Response(
        JSON.stringify({
          status: 'error',
          code: result.code,
          error: result.reason,
          windowId: result.windowId,
        }),
        { status: result.code === 'no_window' ? 404 : 500, headers: JSON_HEADERS },
      );
    }
    return new Response(
      JSON.stringify({ status: 'ok', windowId: result.windowId }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

// "Kill agent" for a windowed session — resolve the window exactly like focus
// (the SHARED resolveSessionWindowId chain), then GRACEFULLY close it
// (wmctrl -ic → WM_DELETE_WINDOW → the terminal tears down and SIGHUPs the CLI).
// The roster's bulk-kill (owner ask 2026-07-11). Because it reuses the focus
// chain, a fleet/psu-launched agent whose windowId wasn't pre-resolved — matched
// by its coord-owner short id in the title — is still killable. A headless agent
// has no window ⇒ 404 'no window' (the caller reports it un-killable rather than
// the endpoint guessing at a pid).
const closeWindow = defineTool({
  method: 'POST',
  path: '/adv/sessions/close-window',
  auth: 'loopback',
  async handler(req) {
    const body = await parseControlBody(req);
    const latestRow =
      typeof body.id === 'number' && body.id > 0 ? await getAdvSession(body.id) : null;
    const wid = await resolveSessionWindowId(body, latestRow);
    if (!wid) {
      return new Response(
        JSON.stringify({
          status: 'error',
          error: 'could not resolve a window to close (headless agent, wmctrl missing, or no DISPLAY)',
        }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    const ok = await closeWindowId(wid);
    return new Response(
      JSON.stringify({ status: ok ? 'ok' : 'error', windowId: wid }),
      { status: ok ? 200 : 500, headers: JSON_HEADERS },
    );
  },
});

// Set (or clear) a session's manual display name — the write half of plan
// hud-session-display-names-2026-08-31, ruled by D-002 (the control lives only
// in the conversation popup header) and D-003 (the name is OWNER-keyed).
//
// Deliberately NOT shaped like focus/close-window above: those resolve a WINDOW
// (id → pid → title fragment) because they act on an X11 client. A name is an
// attribute of the AGENT, so this route is keyed by ownerId and works for a
// headless session that has no window at all.
const rename = defineTool({
  method: 'POST',
  path: '/adv/sessions/rename',
  auth: 'loopback',
  async handler(req) {
    const body = await parseJsonBody(req);
    const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : '';
    if (!ownerId) {
      return new Response(
        JSON.stringify({ status: 'error', error: 'ownerId is required' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    const [{ setAgentDisplayName, resolveOwnerWorkspaceId }, { activeWorkspaceId }] = await Promise.all([
      import('../../../display-names/store'),
      import('../../../workspace-registry'),
    ]);
    // The owner's OWN presence workspace first, because that is the key both
    // readers use; the operator's ambient workspace is only the last resort, and
    // picking it when they differ would store the name where nothing reads it.
    const explicit = typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null;
    const workspaceId =
      explicit ?? (await resolveOwnerWorkspaceId(ownerId).catch(() => null)) ?? activeWorkspaceId();
    try {
      const result = await setAgentDisplayName({
        workspaceId,
        ownerId,
        // Whitespace-only (or absent) CLEARS — R6. The store owns that rule so
        // this route and the sessions:rename tool cannot disagree about it.
        name: typeof body.name === 'string' ? body.name : null,
        // A human at the popup. An agent naming ITSELF goes through the
        // sessions:rename agent tool, which stamps its own coord ownerId.
        setBy: 'owner',
      });
      // The card must show the new name without a reload; the roster query is
      // the one every session card reads through.
      void notifySyncInvalidate('roster').catch(() => {});
      return new Response(
        JSON.stringify({ status: 'ok', workspaceId, ...result }),
        { status: 200, headers: JSON_HEADERS },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
        { status: 500, headers: JSON_HEADERS },
      );
    }
  },
});

const alive = defineTool({
  method: 'GET',
  path: '/adv/sessions/alive',
  auth: 'public',
  async handler(req) {
    const pidStr = new URL(req.url).searchParams.get('pid');
    const pid = pidStr ? Number(pidStr) : NaN;
    if (!Number.isFinite(pid) || pid <= 0) {
      return new Response(JSON.stringify({ alive: false }), { status: 200, headers: JSON_HEADERS });
    }
    let live = false;
    try {
      // process.kill(pid, 0) throws if the pid is gone; succeeds (and
      // sends no signal) if alive + we have permission.
      process.kill(pid, 0);
      live = true;
    } catch { live = false; }
    return new Response(JSON.stringify({ alive: live }), { status: 200, headers: JSON_HEADERS });
  },
});

const state = defineTool({
  method: 'GET',
  path: '/adv/sessions/state',
  auth: 'public',
  async handler(req) {
    const resolved = await resolveOmpSessionForRequest(req);
    const sessionState =
      resolved.sessionId || resolved.filePath
        ? getOmpSessionState({ id: resolved.sessionId ?? undefined, filePath: resolved.filePath ?? undefined })
        : null;
    const memory = await readOmpMemoryConfig();
    return new Response(
      JSON.stringify({
        ok: sessionState !== null,
        advSession: resolved.advSession,
        match: resolved.match,
        state: sessionState,
        memory,
        error: sessionState ? null : 'omp_session_not_found',
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

const search = defineTool({
  method: 'GET',
  path: '/adv/sessions/search',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.trim() ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!query) {
      return new Response(
        JSON.stringify({ ok: true, query, matches: [], truncated: false, searchedSessions: 0 }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const resolved = await resolveOmpSessionForRequest(req);
    const scoped = requestHasExplicitSessionScope(url);
    if (scoped && !resolved.sessionId && !resolved.filePath) {
      return new Response(
        JSON.stringify({
          ok: false,
          query,
          matches: [],
          truncated: false,
          searchedSessions: 0,
          advSession: resolved.advSession,
          match: resolved.match,
          error: 'omp_session_not_found',
        }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const result = searchOmpSessions({
      query,
      sessionId: resolved.sessionId ?? undefined,
      filePath: resolved.filePath ?? undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      context: 1,
    });
    return new Response(
      JSON.stringify({ ok: true, advSession: resolved.advSession, match: resolved.match, ...result }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/ended — the paged "inactive sessions" feed for the
 * agents-running popover (agents-pill-inactive-search-2026-07-09 P-001).
 * ended_at DESC with a keyset cursor: `?before=<iso>` returns rows that ended
 * strictly before it; the response's `nextBefore` is the cursor for the next
 * page (null ⇒ no more). `limit+1` probe ⇒ `hasMore` without a COUNT.
 * Workspace-scoped via `?workspace=<id>`; omit or `all` for every workspace.
 */
const ended = defineTool({
  method: 'GET',
  path: '/adv/sessions/ended',
  // Consistent with the sibling /adv/* UI content routes: the operator binds
  // loopback-only and the desktop webview has no principal/bearer path.
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const wsParam = url.searchParams.get('workspace');
    const workspaceId = wsParam && wsParam !== 'all' ? wsParam : null;
    const before = url.searchParams.get('before')?.trim() || null;
    if (before && Number.isNaN(Date.parse(before))) {
      return new Response(
        JSON.stringify({ ok: false, error: 'invalid_before_cursor' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? 30);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 30));
    const rows = await listEndedAdvSessions({ workspaceId, before, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    // Computed from the raw page, BEFORE field-reliability wrapping — the cursor is an
    // internal pagination detail, not a value read out of the JSON a caller receives.
    const nextBefore = hasMore && page.length > 0 ? page[page.length - 1].endedAt : null;
    // EI-22176001691325872: every row on this feed IS an ended session, so this is the
    // single highest-density surface for the endedAt/exitCode caveats to reach a reader.
    const sessions = page.map((row) => withFieldReliability(row, advSessionRowCaveats(row)));
    return new Response(
      JSON.stringify({ ok: true, sessions, hasMore, nextBefore }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/search-transcripts — the agents-pill "search ANYTHING
 * in the sessions" endpoint (agents-pill-inactive-search-2026-07-09 P-002).
 *
 * Runs the SHARED search engine — `runHybridSearch` over the `session_turn`
 * source of the @papercusp/search SEARCH_SOURCES registry, the exact engine +
 * corpus the `sessions:search` agent tool and /api/user/search use (BM25 +
 * embeddings via the buildQueryEmbedder cascade; degrades to BM25-only when no
 * embedder is available). Turn-level hits are rolled up per SESSION and
 * classified against the live roster (active → the popover groups by fleet)
 * and adv_sessions rows (inactive metadata + open handles); ts_headline
 * `<mark>` highlights ride through for the UI.
 *
 * SECURITY (auth: 'loopback'): hits carry transcript excerpts — the same
 * sensitivity as /adv/session/thinking (full agent reasoning can hold file
 * contents + secrets), so the same loopback gate applies.
 */
const searchTranscripts = defineTool({
  method: 'GET',
  path: '/adv/sessions/search-transcripts',
  auth: 'loopback',
  async handler(req, { signal }) {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500);
    if (!q) {
      return new Response(
        JSON.stringify({ ok: true, query: '', sessions: [] }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    const limitRaw = Number(url.searchParams.get('limit') ?? 30);
    const hitLimit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 30));

    // owner-plans-single-pane-2026-07-17 P-006: `?plan=<slug>` scopes the
    // search to ONE plan's sessions — the plan popup's Sessions-tab search.
    // We resolve the plan's OWNER set (the same listPlanSessions two-leg
    // attribution the popup's list uses) and push it into the engine as
    // `filters.owners` (the session_turn source ANDs `owner = ANY(owners)` in
    // BOTH rankers). Engine-level scoping — NOT a post-filter — so the ranking
    // happens only within the plan's turns; a common term (e.g. "escalation")
    // whose plan hits would rank below the GLOBAL top-N still surfaces. Absent
    // → unscoped (today's behavior).
    const planScope = (url.searchParams.get('plan') ?? '').trim().slice(0, 200);
    let planOwners: string[] | null = null;
    if (planScope) {
      const { listPlanSessions } = await import('../../../adv-sessions');
      const planSessions = await listPlanSessions(planScope, { workspaceId: null });
      planOwners = [...new Set(planSessions.map((s) => s.coordOwnerId).filter((o): o is string => !!o))];
      // A plan with no attributable owners can match nothing — short-circuit
      // (an empty owners filter would otherwise mean "no narrowing" = unscoped).
      if (planOwners.length === 0) {
        return new Response(
          /* `hiddenMachineHits` is present on EVERY 200 from this route, zeroed
             here rather than omitted: an absent field and a "nothing was
             hidden" field are the same value to a client, so omitting it would
             make "the filter hid nothing" indistinguishable from "this build
             does not report it". */
          JSON.stringify({
            ok: true, query: q, plan: planScope, totalHits: 0,
            hiddenMachineHits: { count: 0, truncatedByLimit: false }, sessions: [],
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
    }

    // ── Recency (owner ask 2026-07-12): recency is a first-class variable for
    // THIS search, so it composes across three tiers ──────────────────────────
    // 1. HARD FILTER — ?since / ?until (ISO) → engine SearchFilters window
    //    (session_turn already honors it). The time-window facet pill re-queries
    //    with these.
    const sinceParam = (url.searchParams.get('since') ?? '').trim();
    const untilParam = (url.searchParams.get('until') ?? '').trim();
    const filters: SearchFilters | undefined =
      sinceParam || untilParam || planOwners
        ? {
            ...(sinceParam ? { since: sinceParam } : {}),
            ...(untilParam ? { until: untilParam } : {}),
            // P-006 plan scope → engine-level owner narrowing (see above).
            ...(planOwners ? { owners: planOwners } : {}),
          }
        : undefined;
    // 2. SOFT RE-RANK + FRESH-CANDIDATE LEG — a recency decay blended into the
    //    fused score before the top-N cut, plus a recent-window BM25 candidate
    //    list so same-day matches can't be crowded out of the relevance-cut
    //    pool by old high-term-density turns (WI-5097). DEFAULT-ON for this
    //    route; ?recency=off disables, ?recencyHalfLifeH / ?recencyWeight /
    //    ?recencyFreshWindowH tune. Parsing lives in parseRecencyParams
    //    (adv-session-search.ts) — pure + unit-tested, after the inline
    //    Number(null)=0 parse silently disabled the whole re-rank (WI-5097).
    const recency: RecencyRank | undefined = parseRecencyParams(url.searchParams);

    /* ── ID leg (WI-37204, owner ask 2026-08-08) ────────────────────────────
       "search by the su id and the session id". The engine above searches turn
       TEXT, so an id query returned NOTHING even for a session sitting in the
       roster — measured on the live operator before this landed:
       `?q=su-bc38a419` → `{ totalHits: 0, sessions: [] }`.

       An id resolves against two stores, and BOTH are needed: the live roster
       (a running agent, which is what the HUD board and the pill's roster show)
       and adv_sessions (an ENDED session — the common case when the id came out
       of a log or a work-item, and the one the client roster can never answer).

       This MERGES with the text results rather than replacing them: ids do
       appear in transcript prose, and those hits are often exactly what the
       searcher wants. See `mergeIdMatches`. */
    const idToken = parseSessionIdQuery(q);

    // Per-stage timing breakdown (WI-3924 follow-up C): the endpoint's cold
    // baseline was ~3.3s even with a BM25-only (no-embed) hit, and the cost
    // was suspected to live OUTSIDE runHybridSearch (roster merge / session
    // metadata hydration / classifySessionGroups). Always-on (Date.now()
    // deltas — negligible cost) so any caller can see exactly where the
    // budget went without spinning up separate profiling; kept out of the
    // JSON body's hot fields (top-level `_stageTimingsMs`, ignorable by the
    // client) so it never has to be toggled on to be useful.
    const t0 = Date.now();
    const stageTimingsMs: Record<string, number> = {};
    const mark = (label: string) => { stageTimingsMs[label] = Date.now() - t0; };

    const [{ runHybridSearch }, { SEARCH_SOURCES }, { rerankCandidateCount, rerankPageHead }, { parseTurnRef }, { activeWorkspaceId }, { getOrgPg }] =
      await Promise.all([
        import('@papercusp/search'),
        import('../../../agent-tools/search/sources'),
        // Dynamic like its siblings — this route's whole search stack is loaded
        // per request, not at module scope.
        import('../../../agent-tools/search/rerank'),
        import('../../../agent-tools/sessions/_shared'),
        import('../../../workspace-registry'),
        import('@papercusp/db-org'),
      ]);
    const {
      groupHitsBySession, classifySessionGroups, buildActiveEntryMatchFilter,
      // WI-37883 — the owner-visibility filter and the amount of turn text it
      // needs, taken from ONE module so the SQL below cannot under-hydrate it.
      ownerVisiblePage, OWNER_VISIBILITY_DECIDING_PREFIX_CHARS, ownerVisibleCandidateCount,
    } = await import('../../../adv-session-search');
    const { advSessionsByTranscriptHandles } = await import('../../../adv-sessions');
    const { retrieveSessionTurnLiteralTiers, composeSessionTurnTiers, tieredHitToWire, SESSION_TURN_LITERAL_POLICY } =
      await import('../../../agent-tools/search/session-turn-literal');

    /* `?includeMachineTurns=1` opts OUT of the owner-visibility filter — for
       debugging a wake or a hook wall, where the plumbing IS the thing you are
       looking for. Read here rather than at the filter because it also decides
       how much to RETRIEVE (see the engine `limit` below). Not wired to any UI;
       an engineer reaching for it knows what they are asking for. The AGENT
       search path (`sessions:search`) is a different entry point entirely and
       is untouched: agents legitimately search their own machine turns. */
    const includeMachineTurns = url.searchParams.get('includeMachineTurns') === '1';
    const candidateBudget = ownerVisibleCandidateCount(hitLimit);

    const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');
    const { sql } = getOrgPg();

    // WI-4734: the roster merge's fan-out of presence/assignment/session reads
    // depends on NOTHING the search produces, yet it used to run AFTER the
    // search — a pure serialization tax (~160ms warm). Start it NOW, fully
    // concurrent with embed+search; only the per-entry "thinking" resolution
    // needs the hit set, and that runs post-hoc below for JUST the matched
    // entries (same safety condition as the WI-3924 `thinkingFor` gate: an
    // unmatched entry is never surfaced by this endpoint).
    const rosterP = mergeRosterWithAssignments({ workspaceId: null, thinkingFor: () => false });
    rosterP.catch(() => {}); // re-awaited below; never an unhandled rejection
    /* Fired NOW, alongside the roster and the search, for the same reason the
       roster merge was hoisted in WI-4734: it depends on nothing the engine
       produces, so serializing it behind the search would be a pure latency
       tax. Fail-soft — a broken id lookup degrades to the text results rather
       than failing the whole search. */
    const idRowsP = idToken
      ? advSessionsByIdToken(idToken).catch(() => [] as Awaited<ReturnType<typeof advSessionsByIdToken>>)
      : Promise.resolve([] as Awaited<ReturnType<typeof advSessionsByIdToken>>);
    // A HUMAN is typing in the desktop pill, so a cold query-embedder must not
    // block lexical retrieval. `select` starts one background warmup and hands
    // the engine a rejecting embedder until the exact stamped instance is ready.
    // The engine's budget now bounds only the actual embed call once warm.
    const selectedEmbedder = transcriptQueryEmbedderWarmup.select();
    const embedder = selectedEmbedder.embedder;
    mark('embedAcquire'); // selection is synchronous; warmup continues in background
    const embedTimeoutMs = Number(process.env.PAPERCUSP_TRANSCRIPT_EMBED_BUDGET_MS) || 4000;
    /* EXACT + FUZZY literal tiers (plan session-transcript-exact-fuzzy-search-2026-09-14 P-004;
       D-001 precedence, D-003 bounded branches, D-005 readiness/degrade). The hybrid engine
       tokenizes, so a literal INSIDE a lexeme (`furnishedfinder` in `www.furnishedfinder.com`) or a
       one-letter typo never reaches it; these two index-backed tiers do, and they are composed AHEAD
       of the hybrid remainder below. Started NOW, concurrent with embed + search — it depends on
       nothing the engine produces (same reasoning as the roster hoist, WI-4734). Each tier carries
       its own hard deadline (exact 2s; fuzzy 1s expand + 2s resolve), so no signal is threaded in.

       ⚠ `filters` is passed through UNCHANGED (since/until/plan owners) but `ownerCandidates` is NOT
       added: OWNER_CANDIDATE_TURN_VERDICTS would also drop every ASSISTANT turn in SQL, while the
       owner-visibility rule is applied post-hydration by `ownerVisiblePage` and deliberately fails
       open (adv-session-search.ts must not have it restated in SQL). Machine-turn drops are
       disclosed through `hiddenMachineHits`.

       Fail-soft: the retrieval function already degrades per tier; this catch only covers an
       unexpected throw so the hybrid results always still serve. */
    const workspaceId = activeWorkspaceId();
    const literalP = retrieveSessionTurnLiteralTiers(sql, { workspaceId, query: q, scopeFilter: null, filters }).catch(
      (err: unknown): Awaited<ReturnType<typeof retrieveSessionTurnLiteralTiers>> => {
        const failed = { status: 'error' as const, returned: 0, elapsedMs: 0, error: (err as Error)?.message ?? String(err) };
        return { exact: [], fuzzy: [], receipt: { policy: SESSION_TURN_LITERAL_POLICY, exact: failed, fuzzy: failed } };
      },
    );
    // The route's aborted-catch path may return before `literalP` is awaited below.
    literalP.catch(() => {});
    // The route watchdog's signal is threaded into the engine so a timed-out
    // search stops running instead of grinding all sources to completion
    // after the 408 already went out (2026-07-09 incident: 34–69s server
    // burn past the 30s budget under host load). Abort → throw → the route
    // stack's aborted-catch path returns the 408.
    const { results } = await runHybridSearch(sources, {
      caller: 'adv:sessions-search',
      sql,
      query: q,
      workspaceId,
      scopeFilter: null,
      // Retrieve a POOL, not the page. Two independent over-fetches want a
      // say here and the budget is the larger of them:
      //
      //   · P-010 Stage-B (`rerankCandidateCount`) — a pool for the reranker to
      //     REORDER. A no-op at this route's page sizes: it is capped at
      //     RERANK_MAX_CANDIDATES (24), so at 30 (pill) or 50 (HUD) it returns
      //     `limit` unchanged and bites only on a small page.
      //   · WI-37912 (`ownerVisibleCandidateCount`) — a pool for the
      //     owner-visibility filter below to SURVIVE. That filter runs after
      //     retrieval, and with no surplus every machine turn it drops was a
      //     permanently empty result slot: measured at a mean 32.8% of a
      //     30-slot page, and 100% for one real query.
      //
      // On the `?includeMachineTurns=1` debug path nothing is filtered, so the
      // second budget would just retrieve rows to throw away.
      limit: includeMachineTurns
        ? rerankCandidateCount(hitLimit)
        : Math.max(rerankCandidateCount(hitLimit), candidateBudget),
      mode: 'hybrid',
      embedder,
      embedTimeoutMs,
      filters,
      recency,
      // The response renders SESSION CARDS, not independent turn rows. Roll
      // up inside the engine, before its top-N cut, so several strong turns
      // from one session cannot consume slots that should represent other
      // matching sessions. The later groupHitsBySession fold is still needed
      // to shape the wire response, but it cannot backfill rows already cut.
      groupBy: (hit) => parseTurnRef(hit.source_id)?.sessionId ?? hit.source_id,
      signal,
      // WI-4734: highlights only for the final top-N (one batched ts_headline
      // hydration) instead of inline for the whole limit*3 × 2-ranker
      // candidate pool — ~6× fewer headline computations per search.
      //
      // ⚠ LOAD-BEARING FOR THE RERANK BELOW, not just a perf knob: the deferred
      // hydration runs over exactly the hits this call returns, so every
      // candidate handed to the cross-encoder has its `highlight` populated.
      // `rerankText` scores the MATCH-CENTRED highlight in preference to the
      // head-of-document excerpt; narrowing deferHighlight to a slice smaller
      // than the returned page would silently drop Stage B back to scoring
      // "is this turn's OPENING about the query?" with no test failing.
      deferHighlight: true,
    });
    mark('hybridSearch');

    // ── Stage B: cross-encoder rerank (P-010) ─────────────────────────────────
    // The engine stops at RRF; this is the same seam /api/user/search and the
    // search:fulltext / search:semantic agent tools already run, which this
    // owner-facing route simply never called.
    //
    // Fail-safe throughout — no engine, a sick sidecar, or a blown 4s stage
    // budget all degrade to the retrieval order rather than failing the search.
    // Checked for abort first so a request the watchdog has already given up on
    // does not pay for a rerank nobody will read.
    signal.throwIfAborted();
    /* ⚠ `candidateBudget`, NOT `hitLimit` — the pool must survive the
       owner-visibility filter below, which cannot backfill a slot from a page
       that was already cut to size.

       This stage is order-stable under a bigger limit (rerankPageHead scores
       `hits.slice(0, RERANK_MAX_CANDIDATES)` whatever the limit, then appends
       the remainder), but RETRIEVAL above is not: over-fetching deepens each
       RRF leg and measurably reorders the fused pool this reranks. See
       `ownerVisiblePage`'s header — the accepted trade, and the wrong claim it
       replaced. */
    const ordered = await rerankPageHead(q, results, Math.max(hitLimit, candidateBudget));
    mark('rerank');

    // Engine hits → turn refs (source_id = `<sourceKind>:<sessionId>:<turnIdx>`).
    const turnHits: Array<{
      sourceKind: string; sessionId: string; turnIdx: number;
      excerpt: string; highlight: string; score: number;
      matchedBy?: MatchProvenance; lexicalScore?: number; semanticScore?: number;
      // P-004 tier wire fields (see TranscriptTurnHit): the winning precedence tier, the other
      // tiers that also found the turn, the literal a deep-link must anchor on, the fuzzy match.
      tier?: TranscriptTurnHit['tier']; alsoMatchedBy?: TranscriptTurnHit['alsoMatchedBy'];
      focusTerm?: string; fuzzy?: TranscriptTurnHit['fuzzy'];
      ts?: string | null; speaker?: string | null; owner?: string | null;
      // WI-37883 — hydrated below, read only by filterOwnerVisibleTurnHits and
      // then STRIPPED before the rollup (`groups` is serialized hit-for-hit).
      textHead?: string | null;
      // WI-37909 — full user-turn text used to locate the marked match inside
      // the rendered owner span; also stripped before serialization.
      fullText?: string | null;
    }> = [];
    // ⚠ `ordered`, NOT `results` — post-Stage-B the ARRAY ORDER is the relevance
    // order and `score` is only the retrieval score it was reranked out of.
    // groupHitsBySession preserves this order for exactly that reason.
    /* EXACT > FUZZY > the hybrid remainder (D-001/D-006), composed here so everything
       DOWNSTREAM — hydration, owner-visibility, rollup, classify — is unchanged and sees one
       homogeneous list. The hybrid order (`ordered`, post-Stage-B) is kept inside the remainder;
       `composeSessionTurnTiers` classifies WHY each hybrid turn matched through the same
       `hitProvenance` this loop used to call (the engine's ranker names stay engine-side, and a
       vector-only hit's `highlight` is the head of the turn, not the match — the card must say
       so). A literal-only turn carries `matchedBy: 'unknown'` ("no claim") with `tier` as the real
       claim. `maxPerSession`: this endpoint pages by SESSION CARD, and the engine's groupBy gave
       the hybrid pool one hit per session — an uncapped literal tier could otherwise spend the whole
       page on one chatty session. */
    const literal = await literalP;
    mark('literalTiers');
    const composed = composeSessionTurnTiers({
      exact: literal.exact,
      fuzzy: literal.fuzzy,
      hybrid: ordered,
      limit: Math.max(hitLimit, candidateBudget),
      maxPerSession: 2,
    });
    for (const c of composed.hits) turnHits.push(tieredHitToWire(c));

    // Hydrate per-turn metadata (ts/speaker/owner) — ts anchors the deep-link
    // into the transcript viewer; owner matches claude isolation transcripts to
    // their roster agent. One batched unnest join, never per-hit queries.
    //
    // WI-37883 adds a bounded HEAD of the turn text to the same join, for the
    // whole-turn owner-visibility filter. WI-37909 additionally hydrates the
    // full text only for user turns: owner-chat notes are trailing and may lie
    // beyond the deciding prefix, so the search filter must compare the marked
    // match with the exact rendered span. Both fields are internal and stripped
    // before serialization. See OWNER_VISIBILITY_DECIDING_PREFIX_CHARS.
    signal.throwIfAborted(); // watchdog fired mid-search → stop, don't hydrate
    if (turnHits.length > 0) {
      try {
        const kinds = turnHits.map((h) => h.sourceKind);
        const sids = turnHits.map((h) => h.sessionId);
        const idxs = turnHits.map((h) => h.turnIdx);
        const metaRows = await sql<
          Array<{ source_kind: string; session_id: string; turn_idx: number; ts: string | null; speaker: string | null; owner: string | null; text_head: string | null; full_text: string | null }>
        >`
          SELECT st.source_kind, st.session_id, st.turn_idx, st.ts::text AS ts, st.speaker, st.owner,
                 left(st.text, ${OWNER_VISIBILITY_DECIDING_PREFIX_CHARS}) AS text_head,
                 CASE WHEN st.speaker = 'user' THEN st.text ELSE NULL END AS full_text
            FROM harness_shared.session_turns st
            JOIN unnest(${kinds}::text[], ${sids}::text[], ${idxs}::int[]) AS t(k, s, i)
              ON st.source_kind = t.k AND st.session_id = t.s AND st.turn_idx = t.i
        `;
        const metaByKey = new Map(metaRows.map((m) => [`${m.source_kind}:${m.session_id}:${m.turn_idx}`, m]));
        for (const h of turnHits) {
          const m = metaByKey.get(`${h.sourceKind}:${h.sessionId}:${h.turnIdx}`);
          if (m) {
            h.ts = m.ts;
            h.speaker = m.speaker;
            h.owner = m.owner;
            h.textHead = m.text_head;
            h.fullText = m.full_text;
          }
        }
      } catch (err) {
        if (signal.aborted) throw err; // abort outranks the bonus-metadata degradation
        /* metadata is a bonus — never fail the search */
      }
    }
    mark('metadataHydration');

    /* WI-37883: drop hits inside turns the owner's chat pane hides.
       This route is OWNER-FACING on both its consumers (the HUD board and the
       plan popup's Sessions tab), and EI-20135573616431912 established that a
       machine-authored `user` turn is not part of the owner's conversation. An
       unfiltered search re-leaks it as an excerpt AND offers a deep-link that
       cannot anchor, because the target message is no longer rendered.

       Filtering HERE, before the rollup, is what makes `totalHits` and the
       session groups agree — a session whose only matches were machine turns
       must not appear at all, rather than appear with nothing to show.

       WI-37912: filter the POOL and slice to the page, never the reverse. The
       cut used to happen upstream, so a dropped machine turn cost a result slot
       nothing could refill — a mean 32.8% of a 30-slot page, measured through
       this route. `hidden` reports what that cost, and carries its own
       boundedness marker because the count is taken over a capped pool. */
    const page = includeMachineTurns
      ? { hits: turnHits.slice(0, hitLimit), hidden: { count: 0, truncatedByLimit: false } }
      : ownerVisiblePage(turnHits, hitLimit, candidateBudget);
    const visibleHits = page.hits
      /* STRIP the head once the verdict is taken. `groups` is serialized to the
         client hit-for-hit, so leaving it on would ship the machine text this
         filter exists to keep off the wire — and would do it on the
         `?includeMachineTurns=1` path too, where the hits are kept. It is an
         INPUT to a server-side decision, never part of the answer. */
      .map(({ textHead: _textHead, fullText: _fullText, ...hit }) => hit);
    const groups = groupHitsBySession(visibleHits);
    // Await the t0-started roster (usually already settled — it ran concurrent
    // with the search) + the hit-dependent session-row hydration.
    const [{ active }, sessionRows, idRows] = await Promise.all([
      rosterP,
      advSessionsByTranscriptHandles({
        sessionIds: groups.filter((g) => g.sourceKind === 'claude').map((g) => g.sessionId),
        ompThreadIds: groups.filter((g) => g.sourceKind === 'omp').map((g) => g.sessionId),
      }),
      idRowsP,
    ]);
    mark('rosterAndSessionRows');
    /* Resolved BEFORE the thinking gate below so an id-matched live entry gets
       its liveness resolved too — otherwise a session found by its own id would
       render with a false/idle dot, which is precisely the state a human
       searching for that agent is checking. `?plan=` scoping applies here as
       well: the plan popup must not surface a session outside its plan just
       because the id happened to match. */
    const idMatches = idToken
      ? buildIdMatchResults(
          idToken,
          planOwners
            ? active.filter((a) => planOwners!.includes((a as { ownerId?: string }).ownerId ?? ''))
            : active,
          planOwners ? idRows.filter((r) => r.coordOwnerId && planOwners!.includes(r.coordOwnerId)) : idRows,
        )
      : [];
    mark('idMatches');
    // WI-3924 (now post-hoc, WI-4734): only the entries a search hit could
    // actually resolve to (via matchActiveEntry downstream) need the expensive
    // per-agent "thinking" resolution — the roster merge above skipped ALL of
    // it so it could start before the hit set existed. buildActiveEntryMatchFilter
    // mirrors matchActiveEntry's exact match rules, so this is a pure perf
    // gate, not a behavior change.
    const textThinkingFor = buildActiveEntryMatchFilter(groups);
    const idMatchedOwners = new Set(
      idMatches.map((m) => (m.active as { ownerId?: string } | null)?.ownerId).filter(Boolean) as string[],
    );
    const thinkingFor = (e: Parameters<typeof textThinkingFor>[0]) =>
      textThinkingFor(e) || (!!e.ownerId && idMatchedOwners.has(e.ownerId));
    signal.throwIfAborted();
    await resolveThinkingForEntries(active.filter(thinkingFor));
    mark('thinking');
    const sessions = mergeIdMatches(idMatches, classifySessionGroups(groups, active, sessionRows));
    mark('classify');
    return new Response(
      JSON.stringify({
        ok: true,
        query: q,
        plan: planScope || undefined,
        // The id the query resolved AS, when it did. Lets a client say "no
        // session has that id" instead of the generic "no matches in any
        // session", which reads as a search failure rather than an answer.
        idToken: idToken ?? undefined,
        /* WI-37883: the RETURNED hits, not the retrieved ones. Counting
           `turnHits` here would report matches the response does not contain —
           the client renders "N hits" beside a list that is missing the
           owner-invisible ones, which reads as a rendering bug rather than as
           the filter working. A count must describe what was actually handed
           over. */
        totalHits: visibleHits.length,
        /* WI-37912: why the page may be SHORT. Over-fetching refills most
           filtered slots, but a query whose matches are nearly all machine text
           ("Stop hook feedback" — measured 100%) legitimately has little to
           show, and a silently short page is indistinguishable from a bad
           ranker. `truncatedByLimit: true` means the candidate pool was
           saturated, so `count` is a FLOOR — a client must render it as "at
           least N", never as a total. */
        hiddenMachineHits: page.hidden,
        sessions,
        /* P-004 receipt: what the literal tiers did for THIS query (ran / skipped + why /
           deadline / error), what they returned, and what composition kept — so "why did exact
           not appear" is a read, not a guess (D-005: a tier whose index is absent is skipped, never
           a seq scan). Ignorable by clients, like `_stageTimingsMs`. */
        _tiers: {
          exact: literal.receipt.exact,
          fuzzy: literal.receipt.fuzzy,
          counts: composed.counts,
          sessionCapped: composed.sessionCapped,
        },
        _stageTimingsMs: stageTimingsMs,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * GET /api/adv/sessions/resumable — recent psu-tracked sessions (agent +
 * cwd present), cross-workspace, most-recent first. Feeds the
 * `psu --resume` picker, which `cd`s to each row's cwd and resumes the
 * agent there.
 */
const resumable = defineTool({
  method: 'GET',
  path: '/adv/sessions/resumable',
  auth: 'public',
  async handler(req) {
    const searchParams = new URL(req.url).searchParams;
    const limit = Number(searchParams.get('limit') ?? 30);
    const requestedId = Number(searchParams.get('id') ?? NaN);
    const exactRowId = Number.isSafeInteger(requestedId) && requestedId > 0 ? requestedId : null;
    // WI-10003198: an exact read by NATIVE session id. psu finds a transcript on
    // disk, but the row that owns it can be invisible to it: older than the
    // bounded window below, or — for every earlier incarnation of a
    // carry-respawn chain — carrying a DIFFERENT native id, because a respawn
    // rewrites its owner's row in place. resolveResumeTarget bridges that uuid
    // through session_turns.owner to the owner's current row, the same
    // authority the consult dispatcher already resolved its source with, so psu
    // and the dispatcher cannot disagree about which row a transcript belongs to.
    const requestedSessionId = (searchParams.get('sessionId') ?? '').trim();
    let exactBySession: { id: number; ownerId: string | null; requestedSessionId: string } | null = null;
    if (exactRowId == null && RESUMABLE_NATIVE_SESSION_ID_RE.test(requestedSessionId)) {
      const { resolveResumeTarget } = await import('../../../agent-launch-core');
      const target = await resolveResumeTarget({ sessionId: requestedSessionId });
      if (target.ok) {
        exactBySession = { id: target.advSessionId, ownerId: target.ownerId, requestedSessionId };
      }
    }
    const exactId = exactRowId ?? exactBySession?.id ?? null;
    const sessions = await listResumableSessions(Number.isFinite(limit) && limit > 0 ? limit : 30, { exactId });
    // Enrich each session with `hasArchive` — whether its transcript exists in the
    // DB session-archive. The archive-at-death lifecycle deletes an ended session's
    // on-disk transcript ~15s after end, so a resumable claude/codex session may
    // have its ONLY copy in the DB. The psu picker's transcript check is on-disk-
    // only (sessionHasTranscript), so without this flag it misclassifies every
    // off-disk session as a permanent "ghost" and HIDES it (owner-hit 2026-07-13:
    // `psu --resume` reported "hiding 21 session(s) with no persisted transcript"
    // after the move-sessions-off-disk-to-DB change — those sessions ARE resumable,
    // they just need rematerializing first). The picker keeps a session that is on
    // disk OR archived, and rematerializes an archived one on selection.
    const archivedIds = new Set<string>();
    try {
      // Lazy: session-archive fails LOUD at import when zstd is unavailable —
      // keep that off this module's load path (mirrors the rematerialize route).
      const { pgSessionArchiveStore } = await import('../../../session-archive');
      const store = pgSessionArchiveStore();
      await Promise.all(
        sessions.map(async (s) => {
          // Only claude/codex sessions are keyed by a session_id in the archive;
          // omp resumes by thread name and is never ghost-filtered by the picker.
          if (!s.sessionId || (s.agent !== 'claude' && s.agent !== 'codex')) return;
          try {
            // Read the stamp with the SAME key the writer writes. The archive
            // ref built at archive-at-death carries no workspaceId, so every row
            // lands under WS_DEFAULT ('default') — measured 2026-08-12: 17,147
            // archive rows, 100% 'default', none under any workspace slug. Passing
            // `s.workspaceId` ('papercusp-workspace') here therefore matched
            // NOTHING, so `hasArchive` was false for every session that had one
            // (measured on live :3070: 29 claude/codex rows, 0 flagged). That made
            // this whole enrichment inert and left the picker hiding every
            // off-disk-but-archived session as an unresumable "ghost" — the exact
            // 2026-07-13 owner bug it was added to fix. Omitting the argument
            // defaults to WS_DEFAULT, which is also how /adv/sessions/rematerialize
            // already reads (and why restoring worked while detection did not).
            const stamp = await store.readStamp(s.agent, s.sessionId);
            if (stamp) archivedIds.add(s.sessionId);
          } catch {
            /* best-effort per session — a read failure just leaves hasArchive false */
          }
        }),
      );
    } catch {
      /* archive module unavailable ⇒ no enrichment (every hasArchive stays false) */
    }
    const enriched = sessions.map((s) => ({
      ...s,
      hasArchive: s.sessionId ? archivedIds.has(s.sessionId) : false,
    }));
    return new Response(
      JSON.stringify({
        sessions: enriched,
        // Present only when a `sessionId` lookup resolved a row, so an older
        // psu (or a miss) reads exactly the response it always did.
        ...(exactBySession ? { exact: exactBySession } : {}),
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  },
});

/**
 * POST /api/adv/sessions/ensure-claude-config — make a session's per-owner
 * `CLAUDE_CONFIG_DIR` launch-ready for an INTERACTIVE claude resume, and report
 * whether it had to be repaired. Body: `{ owner: string }` (the coord owner id
 * / `PAPERCUSP_SID`). Returns `{ ok, configDir, repaired }`.
 *
 * EI-12938. A FRESH psu launch gets its dir materialized server-side by
 * bootstrap-su (`writeInteractiveClaudeConfig`); a RESUME does no bootstrap POST
 * — the asymmetry this whole bug family lives in. `psu --resume` therefore has
 * no way to (re)build the mirror itself: psu-launcher.mjs is plain node running
 * outside the operator-core TS package, so it cannot import the writer (see the
 * launcher's dependency-surface note; `rehealResumeCredentials` is the same
 * logic re-implemented locally, and doing that a SECOND time for the whole
 * symlink mirror is exactly the duplication this endpoint avoids).
 *
 * So: this route gives the resume leg the same server-materializes-the-dir
 * contract the fresh leg already has, with ONE implementation of the mirror.
 * Idempotent + non-destructive — a healthy dir is left byte-identical and the
 * call reports `repaired: false` (see `ensureInteractiveClaudeConfig`).
 * `loopback` auth, matching the sibling control routes: it materializes a dir
 * under the operator user's own home and is only ever called by a local
 * launcher.
 */
const ensureClaudeConfig = defineTool({
  method: 'POST',
  path: '/adv/sessions/ensure-claude-config',
  auth: 'loopback',
  async handler(req) {
    let body: { owner?: string } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* validated below */ }
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    if (!owner) {
      return new Response(JSON.stringify({ ok: false, error: 'owner required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    // Containment: `owner` keys a path, so refuse anything that isn't a plain
    // session-id token before it reaches join() — a `../` would materialize a
    // symlink farm outside the session-claude root.
    if (!/^[A-Za-z0-9._-]+$/.test(owner) || owner === '.' || owner === '..') {
      return new Response(JSON.stringify({ ok: false, error: 'invalid owner' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const { ensureInteractiveClaudeConfig } = await import('../../../interactive-claude-config');
    const { configDir, repaired } = await ensureInteractiveClaudeConfig({ sid: owner });
    return new Response(JSON.stringify({ ok: true, owner, configDir, repaired }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * POST /api/adv/sessions/ensure-codex-home — make a session's per-session
 * `CODEX_HOME` launch-ready for a codex resume, and report whether it had to be
 * repaired. Body: `{ owner: string, advSessionId: number, requireGatewayProvider?: boolean, model?: string }`.
 * Returns `{ ok, codexHome, repaired, reason? }`.
 *
 * WI-38706, and the exact codex counterpart of `ensure-claude-config` above —
 * same asymmetry, same remedy: a FRESH psu launch has its home materialized
 * server-side by bootstrap-su (`writeSuCodexHome`), a RESUME does no bootstrap
 * POST, and psu-launcher.mjs is plain node outside operator-core so it can
 * neither sign the MCP url nor read the superuser bearer. Without this the
 * resume leg simply trusted the home to be intact — and when the archiver had
 * unlinked its `config.toml`, codex re-created an 87-byte trust-only stub and
 * `thread/resume` died on the missing model provider (11 homes, 89 rollouts).
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION. It calls `ensureSuCodexHomeConfig`, which
 * writes ONE file into an EXISTING home — never `writeSuCodexHome`, whose
 * `freshCodexHome` rm -rf's the directory and would delete the very rollouts
 * being resumed. A healthy home is left byte-identical (`repaired: false`).
 *
 * `requireGatewayProvider` is set by the launcher when the rollout it is about to
 * resume names `papercusp-codex-gateway` in its `session_meta`. The rebuilt
 * config then carries the UNPINNED provider table: the original account pin is
 * not recorded anywhere replayable, and the gateway auto-selects when no pin
 * header is present, so the thread resumes on the pool instead of failing shut.
 * A pinned resume re-pins immediately afterwards via the launcher's own
 * `applyCodexGatewayRoute`.
 *
 * `loopback` auth, matching its claude sibling: it writes under the operator
 * user's own home and is only ever called by a local launcher.
 */
const ensureCodexHome = defineTool({
  method: 'POST',
  path: '/adv/sessions/ensure-codex-home',
  auth: 'loopback',
  async handler(req) {
    let body: {
      owner?: unknown;
      advSessionId?: unknown;
      requireGatewayProvider?: unknown;
      model?: unknown;
      headless?: unknown;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* validated below */ }
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    const advSessionId = Number(body.advSessionId);
    if (!owner || !Number.isSafeInteger(advSessionId) || advSessionId <= 0) {
      return new Response(JSON.stringify({ ok: false, error: 'owner + advSessionId required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    // `owner` is baked into the MCP url's &client=; keep it a plain token.
    if (!/^[A-Za-z0-9._-]+$/.test(owner)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid owner' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const [{ readSuLaunchSpecByOwner, recordSuLaunchSpec }, { parseSuLaunchSpecRecord, pinnedSuRecoveryPrompt, rebuildSuLaunchArtifact }, { composeModePromptSection }, { ensureSuCodexHomeConfig }, { readSuperuserToken }, { requestSessionIdentityActivation }, { CODEX_DEFAULT_MODEL, resolveCodexModel }, { buildLaunchSpec }] =
      await Promise.all([
        import('../../../adv-sessions'),
        import('../../../su-persona-render'),
        import('../agent-mcp/bootstrap-su'),
        import('../../../role-codex-home'),
        import('../../../superuser-token'),
        import('../../../agent-tools/coordination/control-anchor'),
        import('../../../model-context-budget.mjs'),
        import('../../../role-launch-spec'),
      ]);
    const persistedRecord = parseSuLaunchSpecRecord(await readSuLaunchSpecByOwner(owner));
    const sessionRow = await getAdvSession(advSessionId);
    if (sessionRow?.coordOwnerId && sessionRow.coordOwnerId !== owner) {
      return new Response(JSON.stringify({ ok: true, repaired: false, reason: 'owner-mismatch' }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    const record = persistedRecord ?? fallbackCodexLaunchSpecFromAdvSession(sessionRow, owner);
    // Fail SOFT like persona-refresh: the caller's only sane response to any of
    // these is "launch anyway with what is on disk", and a resume that died
    // because the spec was unreadable would be strictly worse than one that
    // boots degraded. `reason` keeps it diagnosable rather than silent.
    if (!record) {
      const reason =
        sessionRow?.coordOwnerId && sessionRow.coordOwnerId !== owner
          ? 'owner-mismatch'
          : sessionRow?.agent && sessionRow.agent !== 'codex'
            ? 'unsupported-agent'
            : 'no-launch-spec';
      return new Response(JSON.stringify({ ok: true, repaired: false, reason }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    if (record.agent !== 'codex') {
      return new Response(JSON.stringify({ ok: true, repaired: false, reason: 'unsupported-agent', agent: record.agent }), { status: 200, headers: JSON_HEADERS });
    }
    // Legacy ADV rows predate launch_spec and carry no model. Prefer the
    // launcher's current model when supplied; otherwise explicitly select the
    // approved configured default. Passing null to the canonical config writer
    // throws before it can restore a missing home or prompt.
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const repairModel = requestedModel ? resolveCodexModel(requestedModel) : record.model ?? CODEX_DEFAULT_MODEL;
    const repairHeadless = typeof body.headless === 'boolean'
      ? body.headless
      : typeof record.headless === 'boolean'
        ? record.headless
        : sessionRow?.launchArgv?.includes('--headless') === true;
    const repairRecord = requestedModel || !record.model ? {
      ...record,
      model: repairModel,
      modelSource: requestedModel ? 'inherited' as const : 'configured-default' as const,
    } : record;
    const modelChanged = repairRecord.model !== record.model ||
      repairRecord.modelSource !== record.modelSource;
    const ensureConfig = (mcpUrl: string, promptText: string) => ensureSuCodexHomeConfig({
      sessionKey: advSessionId,
      mcpUrl,
      sid: owner,
      model: repairModel,
      token: readSuperuserToken(),
      codexGatewayAuto: body.requireGatewayProvider === true,
      codexGatewayPriority: body.requireGatewayProvider === true ? 'su' : null,
      headless: repairHeadless,
      trustDir: null, // the home's inherited trust tables already cover the cwd
      projectDir: sessionRow?.cwd,
      promptText,
      recoverMissingHome: sessionRow?.coordOwnerId === owner,
    });
    let rebuilt;
    // agent-economy-flywheel P-016 (D-012): a repair is a restart. An unfunded
    // priced identity is dropped from the repaired render (never kept by the
    // fail-soft paths below) and reported; a refusal that cannot be cured by
    // dropping stack entries is answered as a typed 402.
    let identityActivation: { identityActivationRefusal: unknown; removedLayerRefs: readonly string[] } | null = null;
    try {
      const { rebuildSuLaunchArtifactFunded } = await import('../../../cupboard/identity-activation-restart');
      const funded = await rebuildSuLaunchArtifactFunded({
        ownerId: owner,
        operatorBaseUrl: new URL(req.url).origin,
        record: repairRecord,
        modeSection: composeModePromptSection({
          autoMode: record.autoMode,
          drainMode: record.drainMode,
          loopArmed: record.loopArmed,
        }),
      }, { rebuild: rebuildSuLaunchArtifact });
      rebuilt = funded.rebuilt;
      if (funded.identityActivationRefusal) {
        identityActivation = {
          identityActivationRefusal: funded.identityActivationRefusal,
          removedLayerRefs: funded.removedLayerRefs,
        };
      }
    } catch (error) {
      const { isIdentityActivationRefusedError } = await import('../../../cupboard/identity-activation-gate');
      if (isIdentityActivationRefusedError(error)) {
        return new Response(JSON.stringify({
          ok: false, owner, advSessionId, error: error.code, detail: error.message, refused: error.refused,
        }), { status: 402, headers: JSON_HEADERS });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('selected identity ')) throw error;
      const pinned = pinnedSuRecoveryPrompt(repairRecord);
      if (!pinned) throw error;
      // The pinned bytes are the prior render, so the same gate applies to them
      // (P-016 D-012). They cannot be degraded, only refused.
      const { admitIdentityActivation } = await import('../../../cupboard/identity-activation-gate-io');
      const pinnedAdmission = await admitIdentityActivation({
        stack: repairRecord.stack ?? [],
        repoDir: sessionRow?.cwd ?? undefined,
        workspaceId: record.workspaceId,
      });
      if (!pinnedAdmission.ok) {
        return new Response(JSON.stringify({
          ok: false, owner, advSessionId, error: pinnedAdmission.code, detail: pinnedAdmission.detail,
          refused: pinnedAdmission.refused,
        }), { status: 402, headers: JSON_HEADERS });
      }
      // Only the MCP connection settings come from a fresh, unselected spec.
      // The instruction bytes come from the verified prior artifact; a source
      // update must never silently apply a new identity during home recovery.
      const connection = await buildLaunchSpec({
        kind: 'su', agent: 'codex', workspaceId: record.workspaceId,
        operatorBaseUrl: new URL(req.url).origin,
        harnessSlug: record.harnessSlug, profile: record.profile,
        contextSize: record.contextSize, personaTier: record.personaTier,
        model: repairModel, stack: [], modes: [],
      });
      const recovered = ensureConfig(connection.mcpUrl, pinned.promptText);
      // Model selection is independent of instruction activation. Preserve the
      // pinned identity while recording the model this resume actually chose.
      if (modelChanged && !(await recordSuLaunchSpec(advSessionId, owner, repairRecord))) {
        throw new Error('repaired Codex model receipt was not persisted');
      }
      return new Response(JSON.stringify({
        ok: true, owner, advSessionId, ...recovered,
        reason: 'pinned-source-stale',
        preservedSpecificationRevision: pinned.specificationRevision,
      }), { status: 200, headers: JSON_HEADERS });
    }
    const r = ensureConfig(rebuilt.spec.mcpUrl, rebuilt.promptText);
    if (r.promptRepaired || modelChanged) {
      const artifact = rebuilt.artifact;
      const updatedRecord = r.promptRepaired ? {
        ...repairRecord,
        stack: artifact.stack,
        specificationRevision: artifact.specificationRevision,
        stateRevision: artifact.stateRevision,
        specificationArtifact: artifact.specificationArtifact,
      } : repairRecord;
      if (!(await recordSuLaunchSpec(advSessionId, owner, updatedRecord))) {
        throw new Error('repaired Codex launch specification receipt was not persisted');
      }
    }
    if (r.promptRepaired) {
      const artifact = rebuilt.artifact;
      await requestSessionIdentityActivation({
        ownerId: owner,
        workspaceId: record.workspaceId,
        revision: {
          specificationRevision: artifact.specificationRevision,
          stateRevision: artifact.stateRevision,
        },
        attribution: {
          actorId: owner,
          principalId: record.principalId ?? owner,
          sessionId: owner,
        },
        source: 'restart',
        restart: true,
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        owner,
        advSessionId,
        ...r,
        ...(persistedRecord ? {} : { recoveredFrom: 'adv-session-row' }),
        ...(identityActivation ?? {}),
      }),
      {
        status: 200,
        headers: JSON_HEADERS,
      },
    );
  },
});

/**
 * POST /api/adv/sessions/rematerialize — restore an ARCHIVED session's files
 * from harness_shared.session_archives back onto disk (WI-3859 F4). The
 * archive-at-death lifecycle deletes an ended session's transcript ~15s after
 * end; the wake-executor rematerializes on ITS resume path, but `psu --resume`
 * / raw `claude --resume` read the disk directly and would otherwise fail
 * "no session found" on a session that is safely archived. Body:
 * `{ sessionId: string, sourceKind?: 'claude'|'codex'|'omp' }` — sourceKind
 * omitted ⇒ probe all three stamps. Returns the rematerialize result plus the
 * stamp's owner/cwd/sessionRoot so the caller can rebuild resume identity.
 */
const rematerialize = defineTool({
  method: 'POST',
  path: '/adv/sessions/rematerialize',
  auth: 'loopback',
  async handler(req) {
    let body: { sessionId?: string; sourceKind?: string } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* validated below */ }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const kinds = (['claude', 'codex', 'omp'] as const).filter(
      (k) => !body.sourceKind || body.sourceKind === k,
    );
    if (!kinds.length) {
      return new Response(JSON.stringify({ ok: false, error: `unknown sourceKind "${body.sourceKind}"` }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    // Lazy: session-archive fails LOUD at import when zstd is unavailable —
    // keep that blast radius off this module's load path.
    const { pgSessionArchiveStore, rematerializeSession } = await import('../../../session-archive');
    const store = pgSessionArchiveStore();
    for (const sourceKind of kinds) {
      const stamp = await store.readStamp(sourceKind, sessionId);
      if (!stamp) continue;
      const r = await startRematerializeJob({ sourceKind, sessionId, stamp, store, rematerializeSession });
      return new Response(
        JSON.stringify(r),
        { status: r.ok ? 200 : 409, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ ok: false, reason: 'not_archived', sessionId }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * GET /api/adv/sessions/rematerialize/status — observe a restore after the
 * POST caller timed out. `pending` is deliberately distinct from
 * `not_archived`; the synchronous POST may still be writing a large archive.
 */
const rematerializeStatus = defineTool({
  method: 'GET',
  path: '/adv/sessions/rematerialize/status',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
    if (!sessionId) {
      return new Response(JSON.stringify({ ok: false, error: 'sessionId required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const sourceKindParam = url.searchParams.get('sourceKind')?.trim() || null;
    const kinds = (['claude', 'codex', 'omp'] as const).filter(
      (kind) => !sourceKindParam || sourceKindParam === kind,
    );
    if (!kinds.length) {
      return new Response(JSON.stringify({ ok: false, error: `unknown sourceKind "${sourceKindParam}"` }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const { inspectArchiveReadiness, pgSessionArchiveStore } = await import('../../../session-archive');
    const store = pgSessionArchiveStore();
    const statuses = await Promise.all(kinds.map(async (sourceKind) => {
      const inFlight = rematerializeInFlight.has(rematerializeJobKey(sourceKind, sessionId));
      if (inFlight) {
        return {
          sourceKind,
          state: 'pending' as const,
          inFlight: true,
          archived: true,
          ready: false,
          reason: 'in_flight' as const,
          missing: [] as string[],
          conflicts: [] as string[],
        };
      }
      const readiness = await inspectArchiveReadiness({ sourceKind, sessionId }, store);
      return {
        sourceKind,
        state: readiness.ready ? 'ready' as const : readiness.reason === 'not_archived' ? 'not_archived' as const : 'not_ready' as const,
        inFlight: false,
        ...readiness,
      };
    }));
    const pending = statuses.some((status) => status.state === 'pending');
    const ready = statuses.some((status) => status.ready);
    return new Response(JSON.stringify({
      ok: true,
      sessionId,
      sourceKind: sourceKindParam,
      state: pending ? 'pending' : ready ? 'ready' : 'not_ready',
      pending,
      ready,
      statuses,
    }), { status: 200, headers: JSON_HEADERS });
  },
});

/**
 * GET /api/adv/roster — the live "who's active, on what" roster (plan
 * adv-sessions-live-roster, P-003). coord_presence is the primary source (every
 * active psu agent heartbeats per tool call), LEFT-joined to adv_sessions on
 * coord_owner_id for plan/role/feature + Focus/Resume handles. Returns:
 *   - active: RosterEntry[]  (presence-primary, liveness from heartbeat)
 *   - ended:  AdvSessionRow[] (recently-ended terminals not already live above)
 * Workspace-scoped via `?workspace=<id>`; omit or `all` for every workspace.
 * Non-breaking: leaves GET /adv/sessions intact until the UI rewires (P-005).
 */
const roster = defineTool({
  method: 'GET',
  path: '/adv/roster',
  // auth:'public' is deliberate + consistent with the 6 sibling /adv routes and
  // the whole /coord/* surface: the operator binds loopback-only (127.0.0.1) and
  // the desktop webview has no principal/bearer path to these UI content routes.
  // The data is already public via GET /coord/presence (the presence half) and
  // GET /adv/sessions (the session half), and is single-user (no tenant boundary
  // to IDOR; ?workspace= only selects among the one owner's own workspaces).
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const wsParam = url.searchParams.get('workspace');
    const workspaceId = !wsParam || wsParam === 'all' ? null : wsParam;
    const endedLimitRaw = Number(url.searchParams.get('endedLimit') ?? 50);
    const endedLimit = Number.isFinite(endedLimitRaw) && endedLimitRaw > 0 ? endedLimitRaw : 50;

    const [{ active, orphanedClaims }, endedAll, pendingRows, startingRows] = await Promise.all([
      mergeRosterWithAssignments({ workspaceId }),
      listEndedAdvSessions({ workspaceId, limit: endedLimit }),
      listPendingWorkbenchLaunches({ workspaceId }),
      listStartingTerminalLaunches({ workspaceId }),
    ]);
    const ended = dedupeEndedAgainstActive(endedAll, active);
    const host = os.hostname();
    // Pending workbench launches (pui-reactive-session-panes D-006): recorded but
    // not-yet-running sessions the pui reactively opens a pane for. Synthesized as
    // RosterEntry-shaped rows (liveness 'pending', local host) in a SEPARATE tier
    // so the human roster (`active`) is untouched; only the pui consumes `pending`.
    const pending = pendingLaunchesToRosterEntries(pendingRows, host);
    // WI-6376: terminal-spawned launches still inside their boot window, in a
    // THIRD tier. Deliberately not folded into `pending` — the pui panes that
    // tier, and these sessions already own a terminal. Rows whose session has
    // come online are dropped so presence renders it exactly once.
    // EI-24748208098755918: log diagnostics are read off the event loop first;
    // the mapper itself does no file I/O.
    const starting = dedupeStartingAgainstActive(
      startingLaunchesToRosterEntries(
        startingRows,
        host,
        await readStartingLaunchLogHints(startingRows),
      ),
      active,
    );

    // Each active entry carries `claims` from the canonical fleet_assignment
    // view; `orphanedClaims` is the claim-keyed remainder — active claims whose
    // holder is absent/stale from the roster (state-not-chat-fleet-state D-002).
    return new Response(JSON.stringify({ active, ended, orphanedClaims, pending, starting }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * POST /api/adv/sessions/mark-launched — the pui consumed a pending workbench
 * launch by opening its pane (pui-reactive-session-panes D-006). Stamps
 * launched_at so the row drops out of the `pending` roster tier (idempotent —
 * a roster-refresh race can't double-consume). Body: `{ id: number }`.
 */
const markLaunched = defineTool({
  method: 'POST',
  path: '/adv/sessions/mark-launched',
  auth: 'loopback',
  async handler(req) {
    let body: { id?: number } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — validated below */ }
    const id = typeof body.id === 'number' ? body.id : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      return new Response(JSON.stringify({ status: 'error', error: 'id required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const stamped = await markAdvSessionLaunched(id);
    return new Response(JSON.stringify({ status: 'ok', stamped }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/**
 * GET /api/adv/roster/agent?owner=<ownerId> — the lazy Tier-3 dossier for ONE
 * agent (plan adv-sessions-live-roster, P-009). Joins across stores that the
 * cheap roster query deliberately skips: SU file-locks (held + waiting, with
 * blockers) and coord state (last message, unread, open handoffs/escalations).
 * Fetched on demand when a detail pane opens, keyed by coord owner id.
 */
const agentDetail = defineTool({
  method: 'GET',
  path: '/adv/roster/agent',
  auth: 'public',
  async handler(req) {
    const owner = new URL(req.url).searchParams.get('owner')?.trim() ?? '';
    if (!owner) {
      return new Response(JSON.stringify({ error: 'owner_required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    // Lazy import: the dossier joins the heavy locks + coord graph, but it's
    // hit only when a detail pane opens. Keeping it out of the route module's
    // top-level import keeps registration (and the roster route) light.
    const { getAgentDetail } = await import('../../../adv-agent-detail');
    const detail = await getAgentDetail(owner);
    return new Response(JSON.stringify(detail), { status: 200, headers: JSON_HEADERS });
  },
});

/**
 * POST /api/adv/on-desktop-windows — the Session-1 Tauri renderer pushes the
 * native desktop window list here (WI-1675, D-002 part 2). On Windows the
 * operator runs inside the WSL2 distro (Session 0) and CANNOT enumerate the
 * interactive desktop, so the renderer invokes the `list_windows_by_title` Rust
 * command on a timer and POSTs the result; this seeds the in-process cache that
 * windows-desktop-windows.ts's listWindowsByTitle — and thus the reaper's
 * on-desktop exemption (gatherOnDesktopSessions) — reads. Body:
 * `{ windows: { title: string; pid: number; hwnd: string }[] }`. Coerces
 * defensively (never trust a POST body) and is a no-op-safe [] push.
 */
const onDesktopWindows = defineTool({
  method: 'POST',
  path: '/adv/on-desktop-windows',
  auth: 'loopback',
  async handler(req) {
    let body: { windows?: unknown } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — validated below */ }
    const raw = Array.isArray(body.windows) ? body.windows : null;
    if (!raw) {
      return new Response(JSON.stringify({ status: 'error', error: 'windows[] required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const windows: WindowsDesktopWindow[] = [];
    for (const w of raw) {
      if (!w || typeof w !== 'object') continue;
      const { title, pid, hwnd } = w as { title?: unknown; pid?: unknown; hwnd?: unknown };
      if (typeof title === 'string' && typeof pid === 'number' && typeof hwnd === 'string') {
        windows.push({ title, pid, hwnd });
      }
    }
    setOnDesktopWindowsCache(windows);
    return new Response(JSON.stringify({ status: 'ok', count: windows.length }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  },
});

/** Read-only stage: stable snapshot + omissions/redactions/budget disclosure.
 * No summarizer call, artifact, or lifecycle row is created here; the only
 * write is content-free audit telemetry. */
const sessionPortInspect = defineTool({
  method: 'POST',
  path: '/adv/sessions/port/inspect',
  auth: 'loopback',
  async handler(req) {
    const parsed = await parseSessionPortBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const resolved = await resolveSessionPortInspection(req, parsed);
      if ('response' in resolved && resolved.response) return resolved.response;
      await recordSessionPortTelemetry(telemetryFromInspection(
        resolved.inspection.source.workspaceId,
        'inspected',
        resolved.inspection,
      ));
      return json({
        ok: true,
        inspection: resolved.service.publicSessionPortInspection(resolved.inspection),
        targetBudget: resolved.budget,
        ...(resolved.contextSizeNormalization ? { contextSizeNormalization: resolved.contextSizeNormalization } : {}),
      });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409);
    }
  },
});

/** Write stage: reacquire and require the exact inspected source hash, then fit,
 * summarize if necessary, and issue an opaque preparation token. */
const sessionPortPrepare = defineTool({
  method: 'POST',
  path: '/adv/sessions/port/prepare',
  auth: 'loopback',
  async handler(req) {
    const parsed = await parseSessionPortBody(req);
    if (parsed instanceof Response) return parsed;
    const expectedSourceHash = typeof parsed.expectedSourceHash === 'string' ? parsed.expectedSourceHash.trim() : '';
    if (!/^[0-9a-f]{64}$/i.test(expectedSourceHash)) {
      return json({ ok: false, error: 'expectedSourceHash from inspect is required' }, 400);
    }
    try {
      const resolved = await resolveSessionPortInspection(req, parsed);
      if ('response' in resolved && resolved.response) return resolved.response;
      const { readSuperuserToken } = await import('../../../superuser-token');
      const tokenKey = readSuperuserToken();
      if (!tokenKey) return json({ ok: false, error: 'server session-port token key is unavailable' }, 503);
      const gatewayPort = Number(process.env.PAPERCUSP_GATEWAY_PORT ?? 8788);
      const summarizer = resolved.inspection.requiresSummary
        ? async ({
            text,
            maxOutputTokens,
            signal,
          }: {
            text: string;
            maxOutputTokens: number;
            signal: AbortSignal;
          }) => {
            const response = await fetch(`http://127.0.0.1:${gatewayPort}/maintenance/summarize`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                systemPrompt: resolved.service.SESSION_PORT_SUMMARIZER_SYSTEM_PROMPT,
                prompt: text,
                maxTokens: maxOutputTokens,
              }),
              signal,
            });
            const payload = await response.json().catch(() => ({})) as { summary?: unknown; model?: unknown; error?: unknown };
            if (!response.ok || typeof payload.summary !== 'string' || !payload.summary.trim()) {
              throw new Error(`session-port summarizer failed (${response.status}): ${JSON.stringify(payload.error ?? payload).slice(0, 300)}`);
            }
            return {
              text: payload.summary,
              model: typeof payload.model === 'string' ? payload.model : 'maintenance-default',
              provider: 'papercusp-inference-gateway',
              costUsd: null,
            };
          }
        : null;
      const prepared = await resolved.service.prepareInspectedSessionPort({
        inspection: resolved.inspection,
        expectedSourceHash,
        tokenKey,
        summarizer,
      });
      await recordSessionPortTelemetry({
        ...telemetryFromInspection(
          resolved.inspection.source.workspaceId,
          'prepared',
          resolved.inspection,
          prepared.summary,
        ),
        portId: prepared.port.id,
        estimatedTokens: Number(prepared.port.metadata.estimatedTokens ?? null),
        idempotentReuse: prepared.reused,
      });
      return json({
        ok: true,
        portId: prepared.port.id,
        attemptId: prepared.port.id,
        token: prepared.token,
        reused: prepared.reused,
        retryOfPortId: prepared.port.retryOfPortId,
        targetAdvSessionId: prepared.port.targetAdvSessionId,
        expiresAt: prepared.port.expiresAt,
        status: prepared.port.status,
        fidelity: prepared.summary.fidelity,
        hashes: prepared.summary.hashes,
        stats: prepared.summary.stats,
        summary: prepared.summary.summary,
      });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409);
    }
  },
});

const sessionPortStatus = defineTool({
  method: 'GET',
  path: '/adv/sessions/port/status',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id')?.trim() ?? '';
    const workspace = url.searchParams.get('workspace')?.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: 'valid port id required' }, 400);
    const [{ activeWorkspaceId }, { getSessionPort }] = await Promise.all([
      import('../../../workspace-registry'),
      import('../../../session-port/store'),
    ]);
    const port = await getSessionPort(id, workspace || activeWorkspaceId());
    if (!port) return json({ ok: false, error: 'session port not found' }, 404);
    return json({
      ok: true,
      port: {
        id: port.id,
        protocolVersion: port.protocolVersion,
        status: port.status,
        sourceAdvSessionId: port.sourceAdvSessionId,
        targetAdvSessionId: port.targetAdvSessionId,
        sourceBackend: port.sourceBackend,
        targetBackend: port.targetBackend,
        targetModel: port.targetModel,
        sourceHash: port.sourceHash,
        normalizedHash: port.normalizedHash,
        renderedHash: port.renderedHash,
        error: port.error,
        expiresAt: port.expiresAt,
      },
    });
  },
});

/** Managed-PTY delivery acknowledgement. `proof.persisted=true` is emitted
 * only after the launcher finds the exact marker/hash in the target backend's
 * native transcript; output activity alone never calls this route. */
const sessionPortDelivery = defineTool({
  method: 'POST',
  path: '/adv/sessions/port/delivery',
  auth: 'loopback',
  async handler(req) {
    let body: {
      protocolVersion?: unknown;
      transformVersion?: unknown;
      workspace?: unknown;
      portId?: unknown;
      targetAdvSessionId?: unknown;
      status?: unknown;
      preparationToken?: unknown;
      proof?: unknown;
      error?: unknown;
    };
    try { body = await req.json() as typeof body; }
    catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }
    const protocolError = sessionPortProtocolError(body.protocolVersion, body.transformVersion);
    if (protocolError) return protocolError;
    const portId = typeof body.portId === 'string' ? body.portId : '';
    if (!/^[0-9a-f-]{36}$/i.test(portId)) {
      return json({ ok: false, error: 'valid portId required' }, 400);
    }
    const [{ activeWorkspaceId }, store, artifact] = await Promise.all([
      import('../../../workspace-registry'),
      import('../../../session-port/store'),
      import('../../../session-port/artifact'),
    ]);
    const workspaceId = typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : activeWorkspaceId();
    const current = await store.getSessionPort(portId, workspaceId);
    if (!current) return json({ ok: false, error: 'session port not found' }, 404);

    // A launcher can fail after /prepare but before bootstrap has minted a target
    // adv_sessions row (the exact September 5 default-model mismatch). Reuse this
    // disposition route instead of leaving a prepared row + 0600 seed stranded
    // until TTL. With no target identity to bind, the opaque preparation token is
    // the authority: verify both its embedded port id and its stored secret hash.
    // A replay after a lost response is idempotent and retries artifact deletion.
    if (
      body.status === 'failed' &&
      current.targetAdvSessionId == null &&
      (current.status === 'prepared' || current.status === 'failed')
    ) {
      const preparationToken = typeof body.preparationToken === 'string'
        ? body.preparationToken.trim()
        : '';
      const parsedToken = artifact.parsePortToken(preparationToken);
      if (
        parsedToken?.portId !== portId ||
        !artifact.verifyPortToken(preparationToken, current.tokenHash)
      ) {
        return json({ ok: false, error: 'valid preparationToken for this port is required' }, 401);
      }
      const message = typeof body.error === 'string' && body.error.trim()
        ? body.error.trim().slice(0, 1000)
        : 'target bootstrap/spawn failed after preparation';
      const port = current.status === 'prepared'
        ? await store.transitionSessionPort(portId, workspaceId, 'failed', { error: message })
        : current;
      const artifactDeleted = await artifact.deleteSessionPortArtifact(current.artifactPath);
      if (current.status === 'prepared') {
        await recordSessionPortTelemetry({
          workspaceId,
          stage: 'failed',
          portId,
          sourceAdvSessionId: current.sourceAdvSessionId,
          targetAdvSessionId: null,
          sourceBackend: current.sourceBackend,
          targetBackend: current.targetBackend,
          targetModel: current.targetModel,
          protocolVersion: current.protocolVersion,
          sourceHash: current.sourceHash,
          renderedHash: current.renderedHash,
          persistenceLatencyMs: Math.max(0, Date.now() - Date.parse(current.preparedAt)),
          cleanupOutcome: artifactDeleted ? 'deleted' : 'already-absent',
          failureClass: classifySessionPortFailure(message),
        });
      }
      return json({
        ok: true,
        status: port.status,
        targetAdvSessionId: null,
        artifactDeleted,
      });
    }

    const targetAdvSessionId = Number(body.targetAdvSessionId);
    if (!Number.isSafeInteger(targetAdvSessionId) || targetAdvSessionId <= 0) {
      return json({ ok: false, error: 'valid targetAdvSessionId required' }, 400);
    }
    if (current.targetAdvSessionId !== targetAdvSessionId) {
      return json({ ok: false, error: 'pending session port/target mismatch' }, 409);
    }
    if (body.status === 'delivered') {
      const proof = body.proof as { persisted?: unknown; renderedHash?: unknown; nativeRef?: unknown } | null;
      if (proof?.persisted !== true || proof.renderedHash !== current.renderedHash || typeof proof.nativeRef !== 'string') {
        return json({ ok: false, error: 'native persistence proof/hash required' }, 409);
      }
      const port = await store.transitionSessionPort(portId, workspaceId, 'delivered', {
        metadata: { persistenceProof: proof, persistenceVerifiedAt: new Date().toISOString() },
      });
      await updateAdvSessionPortStatus(targetAdvSessionId, workspaceId, 'delivered', { persistenceProof: proof });
      const artifactDeleted = await artifact.deleteSessionPortArtifact(current.artifactPath);
      await recordSessionPortTelemetry({
        workspaceId,
        stage: 'delivered',
        portId,
        sourceAdvSessionId: current.sourceAdvSessionId,
        targetAdvSessionId,
        sourceBackend: current.sourceBackend,
        targetBackend: current.targetBackend,
        targetModel: current.targetModel,
        protocolVersion: current.protocolVersion,
        sourceHash: current.sourceHash,
        renderedHash: current.renderedHash,
        persistenceLatencyMs: Math.max(0, Date.now() - Date.parse(current.preparedAt)),
        cleanupOutcome: artifactDeleted ? 'deleted' : 'already-absent',
      });
      return json({ ok: true, status: port.status, artifactDeleted });
    }
    if (body.status === 'failed') {
      const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 1000) : 'native persistence verification failed';
      const port = await store.transitionSessionPort(portId, workspaceId, 'failed', { error: message });
      await updateAdvSessionPortStatus(targetAdvSessionId, workspaceId, 'failed', { deliveryError: message });
      const artifactDeleted = await artifact.deleteSessionPortArtifact(current.artifactPath);
      await recordSessionPortTelemetry({
        workspaceId,
        stage: 'failed',
        portId,
        sourceAdvSessionId: current.sourceAdvSessionId,
        targetAdvSessionId,
        sourceBackend: current.sourceBackend,
        targetBackend: current.targetBackend,
        targetModel: current.targetModel,
        protocolVersion: current.protocolVersion,
        sourceHash: current.sourceHash,
        renderedHash: current.renderedHash,
        persistenceLatencyMs: Math.max(0, Date.now() - Date.parse(current.preparedAt)),
        cleanupOutcome: artifactDeleted ? 'deleted' : 'already-absent',
        failureClass: classifySessionPortFailure(message),
      });
      return json({ ok: true, status: port.status, artifactDeleted });
    }
    return json({ ok: false, error: 'status must be delivered|failed' }, 400);
  },
});

export default [list, focus, closeWindow, rename, alive, state, search, ended, searchTranscripts, resumable, rematerialize, rematerializeStatus, ensureClaudeConfig, ensureCodexHome, roster, markLaunched, agentDetail, onDesktopWindows, sessionPortInspect, sessionPortPrepare, sessionPortStatus, sessionPortDelivery];
