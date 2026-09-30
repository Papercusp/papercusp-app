/**
 * Resolve the CALLING agent's own live transcript file — the `session:'self'`
 * sugar (session-search-scope-2026-07-05 P-005; compaction-context-loss D-002).
 *
 * Why this exists: after a compaction the agent's pre-compaction turns are
 * gone from context but STILL ON DISK in its transcript JSONL. The agent
 * cannot know its own transcript path (psu isolates Claude sessions under
 * ~/.papercusp/session-claude/<ownerId>/…, and the psu-launched agent never
 * sees that path) — so the server resolves it from the caller's coord
 * ownerId, client-neutrally:
 *
 *   1. The psu-pty discovery record (~/.papercusp/psu-pty/<owner>.json)
 *      names the hosted CLI (`command`: claude | omp | codex) and its args —
 *      a `--resume <uuid>`-style arg pins the exact session id.
 *   2. claude → ~/.papercusp/session-claude/<ownerId>/projects/** (per-owner
 *      isolation dirs — dir name IS the coord ownerId), falling back to
 *      ~/.claude/projects/** for non-isolated sessions.
 *      omp    → ~/.omp/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
 *      codex  → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   3. No uuid in args (a fresh, un-resumed session) → the newest .jsonl in
 *      the owner's isolation dir (claude only — omp/codex have no per-owner
 *      dir, so without a uuid we return null and the caller degrades to an
 *      owner-filtered index search).
 *
 * Read-only + fail-soft: any miss returns null; callers degrade gracefully.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const HOME = homedir();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelfSession {
  sourceKind: 'claude' | 'omp' | 'codex';
  sessionId: string;
  filePath: string;
}

interface ActiveSessionRow {
  id: number;
  agent: string | null;
  session_id: string | null;
  omp_thread_id: string | null;
}

export interface ResolveSelfSessionOptions {
  home?: string;
  loadActiveSessions?: (ownerId: string) => Promise<ActiveSessionRow[]>;
  /** All recent sessions in this owner's carry/respawn chain. Unlike
   * loadActiveSessions, this deliberately includes ended predecessor rows so
   * a durable turn ref can resolve after a fresh successor gets a new
   * managed CODEX_HOME. */
  loadOwnerSessions?: (ownerId: string) => Promise<ActiveSessionRow[]>;
  codexHomeForSession?: (id: number) => string;
  /** WI-5681 coord-id-drift bridge: read a live hosted process's environment
   *  (Linux `/proc/<pid>/environ`). Injectable so the drift path is unit-testable
   *  without a real process. Default reads /proc; returns null on any miss. */
  readProcEnviron?: (pid: number) => Promise<Record<string, string> | null>;
}

/** Mirror of psu-pty-discovery's sanitizeKey (kept trivial on purpose). */
function sanitizeKey(ownerId: string): string {
  return String(ownerId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Read a process's env from Linux `/proc/<pid>/environ` (NUL-separated
 *  KEY=VALUE). Fail-soft: any error (non-Linux, dead pid, EPERM) → null. */
async function readProcEnvironDefault(pid: number): Promise<Record<string, string> | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, 'utf8');
    const env: Record<string, string> = {};
    for (const kv of raw.split('\0')) {
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

async function listJsonlUnder(root: string): Promise<string[]> {
  try {
    const names = (await readdir(root, { recursive: true })) as string[];
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(root, n));
  } catch {
    return [];
  }
}

async function newestOf(paths: string[]): Promise<string | null> {
  let best: { p: string; m: number } | null = null;
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (!best || s.mtimeMs > best.m) best = { p, m: s.mtimeMs };
    } catch {
      /* raced */
    }
  }
  return best?.p ?? null;
}

/** Read the native thread id from Codex's bounded prompt-history tail. */
async function newestCodexHistorySessionId(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const s = await fh.stat();
    const size = Math.min(s.size, 1024 * 1024);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, s.size - size);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      try {
        const row = JSON.parse(lines[i]) as { session_id?: unknown };
        if (typeof row.session_id === 'string' && UUID_RE.test(row.session_id)) return row.session_id;
      } catch {
        /* a bounded tail may begin mid-line */
      }
    }
  } catch {
    /* absent / raced */
  } finally {
    await fh?.close().catch(() => undefined);
  }
  return null;
}

async function defaultActiveSessions(ownerId: string): Promise<ActiveSessionRow[]> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    return await sql<ActiveSessionRow[]>`
      SELECT id, agent, session_id, omp_thread_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 5`;
  } catch {
    return [];
  }
}

async function defaultOwnerSessions(ownerId: string): Promise<ActiveSessionRow[]> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    return await sql<ActiveSessionRow[]>`
      SELECT id, agent, session_id, omp_thread_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 50`;
  } catch {
    return [];
  }
}

/**
 * Resolve a SPECIFIC past session belonging to ownerId's claude isolation
 * directory, identified by a prefix of its native session id — as opposed to
 * resolveSelfSession, which always returns only the newest/current one.
 *
 * Scoped ONLY to the per-owner isolation dir
 * (~/.papercusp/session-claude/<ownerId>/projects/**), which is intrinsically
 * owner-scoped by directory path — deliberately never the shared
 * ~/.claude/projects, ~/.omp, or ~/.codex roots, where a bare prefix match
 * could resolve to a DIFFERENT owner's session (a worse bug than the one this
 * fixes: reading and disclosing a stranger's transcript text as if it were
 * the caller's own cited turn). A ref into a non-isolated / omp / codex OLDER
 * session still reports unresolvable — narrower coverage, but never a
 * cross-owner leak.
 *
 * Fixes EI-19297300002186512: work_items:checkpoint's turn-provenance
 * verifier reported found:false for a GENUINE owner anchor that lived in an
 * OLDER session of the same owner's carry-respawn chain — verifyTurnRefs
 * previously only ever checked the current/newest transcript
 * (resolveSelfSession's return), so any ref older than the latest respawn
 * was unconditionally unverifiable even when the cited turn was real and
 * still on disk, one directory over.
 *
 * Read-only + fail-soft, same contract as resolveSelfSession: any miss
 * (no owner dir, no matching prefix, a raced/unreadable directory) returns
 * null rather than throwing.
 */
export async function resolveOwnerIsolatedSessionByPrefix(
  ownerId: string,
  sessionPrefix: string,
  opts: Pick<
    ResolveSelfSessionOptions,
    'home' | 'loadActiveSessions' | 'loadOwnerSessions' | 'codexHomeForSession'
  > = {},
): Promise<SelfSession | null> {
  if (!ownerId || !sessionPrefix) return null;
  const home = opts.home ?? HOME;
  const pfx = sessionPrefix.toLowerCase();
  const isoFiles = await listJsonlUnder(join(home, '.papercusp', 'session-claude', ownerId, 'projects'));
  const hit = isoFiles.find((f) => basename(f, '.jsonl').toLowerCase().startsWith(pfx));
  if (hit) return { sourceKind: 'claude', sessionId: basename(hit, '.jsonl'), filePath: hit };

  // Codex fleet sessions are isolated by the owner's active adv-session id,
  // exactly like resolveSelfSession's `session:'self'` path below. Reusing
  // that mapping here keeps carry-surface [turn:codex-prefix@timestamp]
  // verification aligned with sessions:read instead of falling through a
  // Claude-only owner-chain lookup (EI-21394895717783013).
  const ownerSessions = await (
    opts.loadOwnerSessions ?? opts.loadActiveSessions ?? defaultOwnerSessions
  )(ownerId);
  for (const row of ownerSessions.filter((candidate) => candidate.agent === 'codex')) {
    const codexHome = opts.codexHomeForSession
      ? opts.codexHomeForSession(row.id)
      : join(home, '.papercusp', 'su-codex-homes', `session-${row.id}`);
    const codexFiles = await listJsonlUnder(join(codexHome, 'sessions'));
    const codexHit = codexFiles.find((file) => {
      const stem = basename(file, '.jsonl');
      const sessionId = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1];
      return sessionId?.toLowerCase().startsWith(pfx);
    });
    if (codexHit) {
      const sessionId = basename(codexHit, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1];
      if (sessionId) return { sourceKind: 'codex', sessionId, filePath: codexHit };
    }
  }
  return null;
}

/** Resolve the caller's live transcript. Fail-soft: null when unresolvable. */
export async function resolveSelfSession(
  ownerId: string,
  opts: ResolveSelfSessionOptions = {},
): Promise<SelfSession | null> {
  if (!ownerId) return null;
  const home = opts.home ?? HOME;
  const activeSessions = await (opts.loadActiveSessions ?? defaultActiveSessions)(ownerId);

  // 1. The psu-pty discovery record → hosted CLI + a session uuid when present,
  //    plus the live process pids (the WI-5681 coord-id-drift bridge).
  let command: string | null = null;
  let uuid: string | null = null;
  const livePids: number[] = [];
  try {
    const raw = await readFile(join(home, '.papercusp', 'psu-pty', `${sanitizeKey(ownerId)}.json`), 'utf8');
    const rec = JSON.parse(raw) as { command?: string; args?: unknown; pid?: unknown; ptyPid?: unknown };
    command = typeof rec.command === 'string' ? rec.command : null;
    // ptyPid is the hosted CLI itself (its env carries CLAUDE_CONFIG_DIR); pid is
    // the wrapper — try the CLI first.
    for (const p of [rec.ptyPid, rec.pid]) {
      if (typeof p === 'number' && Number.isInteger(p) && p > 0) livePids.push(p);
    }
    if (Array.isArray(rec.args)) {
      for (const a of rec.args) if (typeof a === 'string' && UUID_RE.test(a)) { uuid = a; break; }
    }
  } catch {
    /* no live pty record — fall through to the claude isolation-dir path */
  }

  // A fresh psu Codex launch has an adv-session row before it has a native
  // session id or discovery record. The row still identifies its client and
  // isolated CODEX_HOME; defaulting such a launch to Claude made self-recall
  // impossible by construction.
  if (!command) command = activeSessions.find((r) => r.agent)?.agent ?? null;
  if (!uuid) {
    const native = activeSessions.find((r) => r.session_id && UUID_RE.test(r.session_id))?.session_id;
    if (native) uuid = native;
  }

  const kind: SelfSession['sourceKind'] =
    command === 'omp' ? 'omp' : command === 'codex' ? 'codex' : 'claude';

  if (kind === 'claude') {
    // The per-owner isolation dir holds ONLY this owner's sessions, so the
    // NEWEST transcript is the current live one — authoritative even across
    // cold carry-respawns, which mint a FRESH native session id each relaunch
    // while the recorded --session-id (discovery args) and adv_sessions id go
    // STALE (WI-5644 / cold-carry-self-recall-2026-07-20). Pinning the stale
    // uuid here resolved `session:'self'` to the ORIGINAL transcript (or null
    // when that file had been archive-reaped), so self-recall silently missed
    // ALL post-respawn history. A file's mtime never goes stale; prefer it.
    const isoFiles = await listJsonlUnder(join(home, '.papercusp', 'session-claude', ownerId, 'projects'));
    if (isoFiles.length) {
      const newest = await newestOf(isoFiles);
      if (newest) return { sourceKind: 'claude', sessionId: basename(newest, '.jsonl'), filePath: newest };
    }
    // WI-5681 coord-id-drift bridge: after a carry-respawn / identity rebind the
    // isolation dir is named by the coord id AT LAUNCH (session-launch-dirs keys
    // it that way), which can diverge from the CURRENT coord id — so the dir
    // above is empty and self-recall silently misses EVERYTHING (the exact
    // failure: `session:'self'` degraded to a 0-hit owner search for a respawned
    // leader whose id drifted su-d838f112 → su-791667d4). The LIVE hosted process
    // still carries the real CLAUDE_CONFIG_DIR in its own environment; read it
    // (Linux /proc, fail-soft) and take the newest transcript there. Only a dir
    // under a session-claude isolation root is trusted (never the shared
    // ~/.claude, which would cross-contaminate owners).
    const readEnviron = opts.readProcEnviron ?? readProcEnvironDefault;
    for (const pid of livePids) {
      const env = await readEnviron(pid);
      const dir = env?.CLAUDE_CONFIG_DIR;
      if (dir && dir.includes('/session-claude/')) {
        const driftFiles = await listJsonlUnder(join(dir, 'projects'));
        const newest = await newestOf(driftFiles);
        if (newest) return { sourceKind: 'claude', sessionId: basename(newest, '.jsonl'), filePath: newest };
      }
    }
    // A non-isolated interactive session shares ~/.claude/projects across
    // owners, so THERE the recorded uuid is the only safe disambiguator.
    if (uuid) {
      const globalFiles = await listJsonlUnder(join(home, '.claude', 'projects'));
      const hit = globalFiles.find((f) => basename(f, '.jsonl') === uuid);
      if (hit) return { sourceKind: 'claude', sessionId: uuid, filePath: hit };
    }
    return null;
  }

  if (kind === 'omp') {
    if (!uuid) return null;
    const files = await listJsonlUnder(join(home, '.omp', 'agent', 'sessions'));
    const hit = files.find((f) => basename(f, '.jsonl').endsWith(`_${uuid}`));
    return hit ? { sourceKind: 'omp', sessionId: uuid, filePath: hit } : null;
  }
  const files: string[] = [];
  // Fleet codex sessions live in PER-SESSION homes (su-codex-homes/session-
  // <advId>), not the shared ~/.codex — resolve via the owner's open adv rows
  // first (session-db-archive-retire-dirs P-015; before this a live fleet
  // codex session could never resolve `session:'self'`). Fail-soft to the
  // shared root.
  for (const r of activeSessions.filter((row) => row.agent === 'codex')) {
    const codexHome = opts.codexHomeForSession
      ? opts.codexHomeForSession(r.id)
      : join(home, '.papercusp', 'su-codex-homes', `session-${r.id}`);
    const isolated = await listJsonlUnder(join(codexHome, 'sessions'));
    files.push(...isolated);
    // A cold carry-respawn keeps the original adv_sessions.session_id while
    // Codex writes the successor rollout into this same managed home. The
    // recorded id is therefore stale while the old rollout remains on disk;
    // self-recall must follow the newest live transcript.
    const newest = await newestOf(isolated);
    if (newest) {
      const stem = basename(newest, '.jsonl');
      const parsed = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? uuid;
      if (parsed) return { sourceKind: 'codex', sessionId: parsed, filePath: newest };
    }

    // Codex 0.144+ can update state_5.sqlite/history.jsonl while the recorded
    // rollout_path is absent. history.jsonl is user-turn-only, but pinning and
    // indexing it is strictly better than an unscoped owner fallback.
    const historyPath = join(codexHome, 'history.jsonl');
    const historyId = await newestCodexHistorySessionId(historyPath);
    if (historyId) return { sourceKind: 'codex', sessionId: historyId, filePath: historyPath };
  }
  if (!uuid) return null;
  files.push(...(await listJsonlUnder(join(home, '.codex', 'sessions'))));
  const hit = files.find((f) => basename(f, '.jsonl').toLowerCase().endsWith(uuid.toLowerCase()));
  return hit ? { sourceKind: 'codex', sessionId: uuid, filePath: hit } : null;
}
