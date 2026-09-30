/**
 * Rematerialize an ENDED session's transcript from the session archive and
 * return the on-disk path it restored to — the "the archive is now the only
 * surviving copy" leg of the `/adv/session/thinking` stream (WI-3990), carved
 * out of `streams.ts` so the per-backend ARCHIVE KEYING is testable on its own
 * (WI-6581).
 *
 * The keying is NOT uniform across backends, which is why this exists as its
 * own module rather than a ternary at the call site:
 *
 *  - **claude** — archived under its jsonl session uuid, i.e. exactly the
 *    `sessionId` the stream is keyed by. Restores into the per-session
 *    CLAUDE_CONFIG_DIR, which is what `resolveInteractiveTranscript` scans.
 *  - **omp** — archived under its thread id; same 1:1 shape as claude.
 *  - **codex** — TWO differences, both load-bearing:
 *      1. the archive `session_id` is the ROLLOUT UUID (the trailing uuid of
 *         `rollout-<ts>-<uuid>.jsonl`), *not* the adv-session row id the
 *         roster streams inactive codex sessions by. A `codexSessionKey`
 *         stream therefore has to go through the archive's `adv_session_id`
 *         index to find its key at all.
 *      2. the restore lands in the session's OWN `CODEX_HOME`
 *         (`stamp.session_root` — `~/.papercusp/su-codex-homes/session-<advId>`),
 *         never the global `~/.codex`. `findCodexRolloutPathByUuid` defaults to
 *         the global home, so a by-uuid re-resolve after a restore MUST be
 *         pointed at the root the archive actually wrote to or it misses the
 *         file it just put there.
 *
 * Both codex legs were previously skipped outright ("codex's archive keying
 * differs so it's skipped here"), so an ended codex session whose rollout had
 * been GC'd off disk rendered empty even though its archive was intact.
 *
 * `session-archive` is imported LAZILY on purpose: it fails loud at import time
 * when zstd is unavailable, and neither this module nor `streams.ts` should
 * carry that on its load path.
 */
import { join } from 'node:path';
import {
  findCodexRolloutPath,
  findCodexRolloutPathByUuid,
  findOmpSessionPath,
} from './session-transcript-resolvers';

/** How the caller identified the session it wants a transcript for. */
export type TranscriptStreamKey =
  | { kind: 'claude'; sessionId: string; owner?: string }
  /**
   * `sessionKey` (WI-41496) is the omp session's adv-row id, which names its
   * per-session home. Optional because a deep-link legitimately has only the
   * thread id — the resolver's per-session-home sweep covers that case.
   */
  | { kind: 'omp'; threadId: string; sessionKey?: string | number }
  /** A codex session keyed by its rollout uuid (transcript-search deep-link). */
  | { kind: 'codex-rollout'; rolloutId: string }
  /** A codex session keyed by its adv-session row id (the roster/inactive list). */
  | { kind: 'codex-session-key'; sessionKey: string };

export type RematReason =
  | 'restored'
  /** No archive row for the resolved key. */
  | 'not_archived'
  /** Archived, but the key could not be resolved (codex adv-id → rollout uuid). */
  | 'no_archive_key'
  /** The archive restored, but no transcript was found under the restored root. */
  | 'restored_but_unresolved'
  /** rematerializeSession refused (sha mismatch / incomplete / bad relpath). */
  | 'restore_failed'
  /** The archive module or PG was unavailable. */
  | 'unavailable';

export interface RematTranscriptResult {
  path: string | null;
  reason: RematReason;
  /** The root the archive restored into, when it got that far. */
  root?: string;
}

/** Seams the unit tests inject; production uses the real archive + resolvers. */
export interface RematTranscriptDeps {
  rematerializeSession: (key: {
    sourceKind: 'claude' | 'codex' | 'omp';
    sessionId: string;
    targetRoot?: string;
  }) => Promise<{ ok: boolean; reason?: string; root?: string }>;
  /** Newest archived native session id for an adv-session row id. */
  findArchivedSessionIdForAdv: (advSessionId: number) => Promise<string | null>;
  /**
   * `root`, when given, is the CLAUDE_CONFIG_DIR the restore actually wrote
   * into (`restored.root` — the archive's own `session_root`, EI-16982). It
   * must be consulted DIRECTLY and cannot be replaced by `owner`: an archive
   * can be stamped with an `owner` that no longer matches the directory its
   * bytes physically live under (a stale/misattributed `session_archives.owner`
   * — observed live, e.g. a forked session whose CLAUDE_CONFIG_DIR stayed
   * pointed at its parent's isolated dir), in which case an owner-only
   * re-resolve searches the WRONG directory and reports the session
   * unrecoverable even though the restore just wrote it to disk.
   */
  resolveClaude: (sessionId: string, owner?: string, root?: string) => Promise<string | null>;
  /**
   * WI-41496: `root` is the sessions root the restore actually wrote into
   * (omp archives stamp `session_root` as the `…/agent/sessions` dir itself),
   * and `sessionKey` names the per-session home for a live re-resolve. Both
   * were missing — this leg called `findOmpSessionPath(threadId)` bare, which
   * searches ONLY the shared `~/.omp` home, so a restored psu omp transcript
   * was reported unresolvable while sitting on disk. The codex legs below
   * already took the restored root for exactly this reason (EI-16982).
   */
  resolveOmp: (
    threadId: string,
    root?: string,
    sessionKey?: string | number,
  ) => Promise<string | null>;
  resolveCodexByUuid: (rolloutId: string, root: string) => Promise<string | null>;
  resolveCodexBySessionKey: (sessionKey: string, root: string) => Promise<string | null>;
  /** Optional override root — tests restore into a scratch dir. */
  targetRoot?: string;
}

async function defaultDeps(): Promise<RematTranscriptDeps> {
  const { pgSessionArchiveStore, rematerializeSession, findArchivedSessionIdForAdv } =
    await import('./session-archive');
  const { resolveInteractiveTranscript } = await import('./claude-sessions');
  return {
    rematerializeSession: (key) => rematerializeSession(key, pgSessionArchiveStore()),
    findArchivedSessionIdForAdv,
    // EI-16982: search the ACTUAL restored root directly (in addition to the
    // owner-hint fast path) — `root` is the archive's own `session_root`, so
    // it finds the file even when `owner` is stale/misattributed relative to
    // where the bytes actually live on disk.
    resolveClaude: (sessionId, owner, root) =>
      resolveInteractiveTranscript(sessionId, { owner, ...(root ? { roots: [join(root, 'projects')] } : {}) }),
    resolveOmp: (threadId, root, sessionKey) =>
      findOmpSessionPath(threadId, {
        // An omp archive stamps `session_root` as the sessions dir itself, so
        // it is a rootOverride directly — no `agent/sessions` suffix to add.
        ...(root ? { rootOverride: root } : {}),
        ...(sessionKey != null ? { sessionKey } : {}),
      }),
    // Point the by-uuid walk at the root the restore actually wrote to — its
    // default is the GLOBAL ~/.codex, where a per-session rollout never lives.
    resolveCodexByUuid: (rolloutId, root) =>
      findCodexRolloutPathByUuid(rolloutId, { homeOverride: root }),
    resolveCodexBySessionKey: (sessionKey, root) =>
      findCodexRolloutPath(sessionKey, { homeOverride: root }),
  };
}

/**
 * Resolve `key` to an archive key, restore it, and re-resolve the transcript
 * under the root the restore wrote to. Never throws — every failure is a
 * `reason` the caller can log and fall through on.
 */
export async function rematerializeTranscript(
  key: TranscriptStreamKey,
  depsIn?: Partial<RematTranscriptDeps>,
): Promise<RematTranscriptResult> {
  const REQUIRED = [
    'rematerializeSession',
    'findArchivedSessionIdForAdv',
    'resolveClaude',
    'resolveOmp',
    'resolveCodexByUuid',
    'resolveCodexBySessionKey',
  ] as const;
  let deps: RematTranscriptDeps;
  if (depsIn && REQUIRED.every((k) => typeof depsIn[k] === 'function')) {
    // A COMPLETE injected set — never touch the real archive module. Keeps the
    // keying unit-testable without zstd/PG on the test's load path.
    deps = depsIn as RematTranscriptDeps;
  } else {
    try {
      deps = { ...(await defaultDeps()), ...depsIn } as RematTranscriptDeps;
    } catch {
      // session-archive throws at import when zstd is unavailable.
      return { path: null, reason: 'unavailable' };
    }
  }

  // ── 1) stream key → archive key ────────────────────────────────────────────
  let sourceKind: 'claude' | 'codex' | 'omp';
  let sessionId: string;
  switch (key.kind) {
    case 'claude':
      sourceKind = 'claude';
      sessionId = key.sessionId;
      break;
    case 'omp':
      sourceKind = 'omp';
      sessionId = key.threadId;
      break;
    case 'codex-rollout':
      sourceKind = 'codex';
      sessionId = key.rolloutId;
      break;
    case 'codex-session-key': {
      // The adv-session row id is NOT an archive key. The rollout uuid that is
      // one normally lives only in the on-disk filename this lifecycle deleted,
      // so recover it from the archive's own adv_session_id index.
      const advId = Number(key.sessionKey);
      if (!Number.isInteger(advId) || advId <= 0) return { path: null, reason: 'no_archive_key' };
      const rolloutId = await deps.findArchivedSessionIdForAdv(advId).catch(() => null);
      if (!rolloutId) return { path: null, reason: 'no_archive_key' };
      sourceKind = 'codex';
      sessionId = rolloutId;
      break;
    }
  }
  if (!sessionId) return { path: null, reason: 'no_archive_key' };

  // ── 2) restore ─────────────────────────────────────────────────────────────
  let restored: { ok: boolean; reason?: string; root?: string };
  try {
    restored = await deps.rematerializeSession({
      sourceKind,
      sessionId,
      ...(deps.targetRoot ? { targetRoot: deps.targetRoot } : {}),
    });
  } catch {
    return { path: null, reason: 'unavailable' };
  }
  if (!restored.ok) {
    return { path: null, reason: restored.reason === 'not_archived' ? 'not_archived' : 'restore_failed' };
  }
  const root = restored.root;
  if (!root) return { path: null, reason: 'restore_failed' };

  // ── 3) re-resolve UNDER THE RESTORED ROOT ──────────────────────────────────
  let path: string | null = null;
  try {
    switch (key.kind) {
      case 'claude':
        path = await deps.resolveClaude(key.sessionId, key.owner, root);
        break;
      case 'omp':
        path = await deps.resolveOmp(key.threadId, root, key.sessionKey);
        break;
      case 'codex-rollout':
        path = await deps.resolveCodexByUuid(key.rolloutId, root);
        break;
      case 'codex-session-key':
        path = await deps.resolveCodexBySessionKey(key.sessionKey, root);
        break;
    }
  } catch {
    path = null;
  }
  return path
    ? { path, reason: 'restored', root }
    : { path: null, reason: 'restored_but_unresolved', root };
}
