/**
 * session-dir-gc.ts — periodic GC for the per-session isolation dirs that the
 * launch paths materialize and then NEVER clean up (the EI-155 follow-on the
 * unify-launch-mechanics work surfaced).
 *
 * Every tracked agent launch mints persistent per-session dirs under
 * `~/.papercusp/` — and each one is DELIBERATELY persistent (the wake-executor
 * reads them after the launch process dies, to resume the session), so no leg of
 * the launch/resume path can clean them up: the dir must outlive the process. The
 * roots, all keyed by session identity:
 *
 *   - `session-claude/<ownerId>`        — the per-session `CLAUDE_CONFIG_DIR`
 *                                          (interactive EI-155 symlink-mirror +
 *                                          the headless bee creds-only dir).
 *   - `session-mcp/<ownerId>`           — the per-session signed `.mcp.json`.
 *   - `su-codex-homes/session-<id>`     — the per-session `CODEX_HOME` (su + role).
 *   - `role-codex-homes/session-<id>`   — LEGACY codex-home root (no longer
 *                                          written since unify-launch-mechanics
 *                                          P-004 folded role homes into
 *                                          su-codex-homes — so everything left in
 *                                          it is stale by definition).
 *
 * Left unmanaged these accumulate unboundedly — measured ~1.7 GB on the standing
 * dev box (the codex homes dominate: each carries its session's rollout). This is
 * the janitor: a SWEEP that removes a session dir once it can no longer back a
 * live or resumable session, gated by BOTH a precise protected-set AND a coarse
 * mtime retention window so it can never delete a dir still in play.
 *
 * ── Safety: what is NEVER collected ──────────────────────────────────────────
 * A dir is PROTECTED (never collected, regardless of age) when its session is
 * live or could still be resumed:
 *   - its owner is LIVE in coord_presence (an active interactive/SU session);
 *   - its owner is a non-terminal `spawned_agents` row (a running headless bee);
 *   - it backs an OPEN `adv_sessions` row (`ended_at IS NULL` — still running);
 *   - its owner has an ACTIVE `event_awaits` row (a registered wake — the
 *     wake-executor will `claude --resume` / `codex resume` it into THIS dir) or
 *     an in-flight `event_wake_deliveries` row (a wake mid-delivery). This is the
 *     resume-safety edge: a session whose process has exited but whose dir the
 *     wake path will re-enter.
 *
 * On TOP of the protected-set, a dir is only collected once its mtime is older
 * than `retentionMs` (default 7d). The mtime is the dir's last *materialization*
 * (a long-running session writes transcripts in `projects/**`, not the top-level
 * dir) — which is exactly right here: the retention gate only ever applies to a
 * dir NOT in the protected set, i.e. a session that is already not-live and
 * not-resumable, so "materialized > 7d ago" is a sound "abandoned" proxy and the
 * window gives a human time to manually resume a crashed session first.
 *
 * Removing a `session-claude/<owner>` dir is SAFE even though it is a symlink
 * mirror of `~/.claude`: `fs.rm(recursive)` unlinks symlink entries rather than
 * following them, so only the isolated real `projects/` (this session's
 * transcripts) + the symlinks themselves are removed — the user's real
 * `~/.claude/*` targets are untouched.
 *
 * The planner is PURE (no I/O, injected clock) so the keep/collect decision is
 * unit-tested without PG or a filesystem; the sweep + gather wrap it with real fs
 * + PG reads. Server-only.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listLiveHosts, type PsuPtyHost } from './events/await/psu-pty-discovery';
import {
  sessionClaudeRoot,
  sessionMcpRoot,
  codexHomesRoot,
} from '@papercusp/orchestrator/session-launch-dirs';

/** Default retention: a not-live, not-resumable dir is collected once it has not
 *  been (re)materialized for this long. With archive-at-death
 *  (session-db-archive-retire-dirs P-012) deletion is LOSSLESS — every ended
 *  session's files live in `harness_shared.session_archives` and
 *  `rematerializeSession` restores them byte-exact on resume — so the old 7-day
 *  "window for a human to resume a crashed session" rationale is obsolete.
 *
 *  The mtime gate that remains is ONLY a materialization-race guard: a dir
 *  created for a session that hasn't registered its adv row/presence yet must
 *  never be swept. That race closes in seconds, so 2h is generous.
 *
 *  Why not 24h (P-012's first cut)? The steady-state dir population is
 *  `live + retention-window churn` whenever the sweep cadence <= retention —
 *  the *retention*, not the cadence, sets the floor. At 24h × ~650 ended
 *  sessions/day this box floors at ~900 dirs; at 2h (swept hourly) it floors at
 *  ~tens, which is the plan's actual goal (P-013) and what keeps the fs-watch
 *  set small. Safe to tighten only because two guards now backstop it: the
 *  archive guard ({@link findUnarchivedSessionDirs}) refuses to delete
 *  un-committed sessions, and a degraded protected-set aborts the sweep
 *  outright.
 *
 *  Callers running WITHOUT the archive flag ON should pass
 *  {@link LEGACY_RETENTION_MS} instead — without an archive, deletion is lossy
 *  and deserves the old generous window. */
export const DEFAULT_RETENTION_MS = 2 * 60 * 60 * 1000;

/** The pre-archive retention (7d) — the safe window when archive-at-death is
 *  DISABLED (kill-switch) and collecting a dir actually destroys data. */
export const LEGACY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How a root's child-dir name maps to the identity matched against a protected
 *  set: `owner` roots are named by the coord owner id verbatim; `session` roots
 *  are named `session-<advSessionId>` (the codex homes). */
export type SessionDirKeyKind = 'owner' | 'session';

export interface SessionDirRoot {
  /** Absolute path to the root that holds the per-session child dirs. */
  root: string;
  /** How a child dir's name maps to its protected-set key. */
  keyKind: SessionDirKeyKind;
  /** Short label for logs/diagnostics. */
  label: string;
}

/** One candidate per-session dir discovered under a root. */
export interface SessionDirCandidate {
  /** Absolute path of the dir. */
  path: string;
  /** Which protected dimension this dir is keyed by. */
  keyKind: SessionDirKeyKind;
  /** The identity matched against the protected set (owner id, or the bare
   *  session key with the `session-` prefix stripped). */
  key: string;
  /** Dir mtime (ms) — last materialization, the retention clock. */
  mtimeMs: number;
}

/** The set of identities whose dirs must never be collected (live/resumable). */
export interface ProtectedSessionIdentity {
  /** Coord owner ids (for `owner`-keyed roots). */
  ownerIds: Set<string>;
  /** adv-session keys (for `session-`-keyed codex roots). */
  sessionKeys: Set<string>;
  /**
   * TRUE when any protected-set read FAILED, so this set is incomplete.
   *
   * The reads fail OPEN (a dead PG contributes no protected ids), which makes
   * the sweep MORE aggressive exactly when it can least afford to be. A dir
   * holding archivable files is still shielded by the archive guard, but a
   * BARE dir (a session mid-launch, before its first jsonl exists) has nothing
   * to verify and would be collected. `runSessionDirGc` therefore refuses to
   * sweep on a degraded set — a skipped sweep costs a day of disk; a wrong one
   * kills live sessions.
   */
  degraded?: boolean;
}

/** A live PTY host is a stronger liveness witness than an adv row or a recent
 * coord heartbeat. Those rows can be ended or reaped while the process still
 * owns its socket. Protect both its owner-keyed dirs and its Codex home keyed
 * by advSessionId, even if every DB-derived protected-set source says "ended".
 * Shared by the periodic janitor and Storage prune so neither path can delete
 * a live host's instructions under a stale lifecycle row. */
export function protectLivePtyHostHomes(
  identity: ProtectedSessionIdentity,
  hosts: readonly Pick<PsuPtyHost, 'ownerId' | 'advSessionId'>[],
): ProtectedSessionIdentity {
  for (const host of hosts) {
    if (host.ownerId) identity.ownerIds.add(host.ownerId);
    const key = String(host.advSessionId ?? '');
    if (/^[1-9]\d*$/.test(key)) identity.sessionKeys.add(key);
  }
  return identity;
}

export interface SessionDirGcPlan {
  /** Dirs to remove: not protected AND older than retention. */
  remove: SessionDirCandidate[];
  /** Kept because the session is live/resumable. */
  keptProtected: SessionDirCandidate[];
  /** Kept because still within the retention window. */
  keptFresh: SessionDirCandidate[];
  /**
   * Kept because the dir still holds session files with NO committed archive
   * stamp — deleting them would be LOSSY. The archive-at-death safety net is a
   * precondition to be VERIFIED here, not an assumption inherited from another
   * component: the fast path can miss (kill -9 between end + hook), the
   * reconciler's disk sweep is bounded per tick, and a `dbFailed` row archives
   * nothing at all. Retention alone would delete those 24h later.
   */
  keptUnarchived: SessionDirCandidate[];
}

/** Is this candidate's session live or resumable (→ never collect)? Pure. */
export function isProtected(
  c: Pick<SessionDirCandidate, 'keyKind' | 'key'>,
  prot: ProtectedSessionIdentity,
): boolean {
  return c.keyKind === 'owner' ? prot.ownerIds.has(c.key) : prot.sessionKeys.has(c.key);
}

/**
 * The PURE keep/collect decision: partition candidates into remove / kept by the
 * protected-set first, then the retention window. No I/O — `nowMs` + `retentionMs`
 * injected so the boundary is unit-tested deterministically.
 */
export function planSessionDirGc(opts: {
  candidates: SessionDirCandidate[];
  protectedIdentity: ProtectedSessionIdentity;
  nowMs: number;
  retentionMs: number;
  /**
   * Paths whose session files are NOT yet committed to `session_archives`
   * (computed by {@link findUnarchivedSessionDirs}). Omitted ⇒ no archive guard
   * (legacy/lossy mode), preserving the pre-archive behaviour exactly.
   */
  unarchivedPaths?: ReadonlySet<string>;
}): SessionDirGcPlan {
  const { candidates, protectedIdentity, nowMs, retentionMs, unarchivedPaths } = opts;
  const plan: SessionDirGcPlan = { remove: [], keptProtected: [], keptFresh: [], keptUnarchived: [] };
  for (const c of candidates) {
    if (isProtected(c, protectedIdentity)) {
      plan.keptProtected.push(c);
    } else if (nowMs - c.mtimeMs < retentionMs) {
      plan.keptFresh.push(c);
    } else if (unarchivedPaths?.has(c.path)) {
      // Retention expired, but the archive does not (yet) hold these files.
      // Keep: the reconciler will archive them on a later tick, and the NEXT
      // sweep collects the dir. Never trade a lossless invariant for a day.
      plan.keptUnarchived.push(c);
    } else {
      plan.remove.push(c);
    }
  }
  return plan;
}

/** The bare protected-set key for a child dir name under a root of `keyKind`. A
 *  `session-`-keyed dir contributes its id (`session-637` → `637`); an `owner`
 *  dir contributes its name verbatim. */
export function sessionDirKey(name: string, keyKind: SessionDirKeyKind): string {
  return keyKind === 'session' ? name.replace(/^session-/, '') : name;
}

/** The default roots swept on this box. `role-codex-homes` is the retired codex
 *  root (kept so the sweep mops up its leftovers). The active roots resolve via
 *  the shared `session-launch-dirs` helpers (which honor the test env overrides),
 *  so a test that points those at a tmp root sweeps the tmp root. */
export function defaultSessionDirRoots(): SessionDirRoot[] {
  return [
    { root: sessionClaudeRoot(), keyKind: 'owner', label: 'session-claude' },
    { root: sessionMcpRoot(), keyKind: 'owner', label: 'session-mcp' },
    { root: codexHomesRoot(), keyKind: 'session', label: 'su-codex-homes' },
    {
      root: join(homedir(), '.papercusp', 'role-codex-homes'),
      keyKind: 'session',
      label: 'role-codex-homes (legacy)',
    },
  ];
}

/** Scan the roots for candidate per-session dirs (real fs). A missing root is
 *  simply skipped; an unreadable child is skipped (never throws). */
export function discoverSessionDirCandidates(roots: SessionDirRoot[]): SessionDirCandidate[] {
  const out: SessionDirCandidate[] = [];
  for (const { root, keyKind } of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue; // root absent on this box
    }
    for (const name of names) {
      const path = join(root, name);
      let mtimeMs: number;
      try {
        const st = statSync(path);
        if (!st.isDirectory()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // raced removal / permission — skip
      }
      out.push({ path, keyKind, key: sessionDirKey(name, keyKind), mtimeMs });
    }
  }
  return out;
}

export interface SessionDirGcResult {
  scanned: number;
  removed: string[];
  keptProtected: number;
  keptFresh: number;
  /** Past retention but withheld: session files not yet in `session_archives`. */
  keptUnarchived: number;
  dryRun: boolean;
  errors: Array<{ path: string; error: string }>;
  /** Set when the sweep was ABORTED before removing anything (fail-closed). */
  skipped?: 'degraded-protected-set';
}

/**
 * The FS sweep: discover candidates under `roots`, plan against an
 * ALREADY-GATHERED protected set, and `rm -rf` the collectible ones (unless
 * `dryRun`). Pure-of-PG (the protected set is injected), so it unit-tests against
 * a tmp root with explicit protected ids + clock. Removal is best-effort per dir
 * — one failure is recorded and the sweep continues.
 */
export function sweepStaleSessionDirs(opts: {
  protectedIdentity: ProtectedSessionIdentity;
  roots?: SessionDirRoot[];
  /** Pre-discovered candidates (avoids a second 17k-dir walk when the caller
   *  already discovered them to compute the archive guard). */
  candidates?: SessionDirCandidate[];
  nowMs: number;
  retentionMs?: number;
  dryRun?: boolean;
  /** See {@link planSessionDirGc}. Omitted ⇒ unguarded (legacy) removal. */
  unarchivedPaths?: ReadonlySet<string>;
}): SessionDirGcResult {
  const roots = opts.roots ?? defaultSessionDirRoots();
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const dryRun = opts.dryRun ?? false;
  const candidates = opts.candidates ?? discoverSessionDirCandidates(roots);
  const plan = planSessionDirGc({
    candidates,
    protectedIdentity: opts.protectedIdentity,
    nowMs: opts.nowMs,
    retentionMs,
    unarchivedPaths: opts.unarchivedPaths,
  });
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const c of plan.remove) {
    if (dryRun) {
      removed.push(c.path);
      continue;
    }
    try {
      // recursive rm unlinks symlink entries rather than following them — the
      // symlink-mirror's real `~/.claude/*` targets are untouched; only the
      // isolated real `projects/` + the links go.
      rmSync(c.path, { recursive: true, force: true });
      removed.push(c.path);
    } catch (e) {
      errors.push({ path: c.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    scanned: candidates.length,
    removed,
    keptProtected: plan.keptProtected.length,
    keptFresh: plan.keptFresh.length,
    keptUnarchived: plan.keptUnarchived.length,
    dryRun,
    errors,
  };
}

/**
 * Gather the protected-set from PG: every identity whose dir must survive because
 * its session is live or resumable. Each read is best-effort (a failed read
 * contributes nothing rather than aborting the whole sweep) — but note that a
 * read failing OPEN here makes the sweep MORE aggressive, so the caller passes a
 * generous retention as the backstop. Lazy imports keep this module importable
 * (tsx) without eagerly pulling the PG/coord graph.
 */
export async function gatherProtectedSessionIdentity(): Promise<ProtectedSessionIdentity> {
  const ownerIds = new Set<string>();
  const sessionKeys = new Set<string>();
  let degraded = false;

  // Live interactive/SU sessions — coord_presence is the primary roster.
  try {
    const { listPresence } = await import('./agent-tools/coordination/presence');
    for (const p of await listPresence()) ownerIds.add(p.ownerId);
  } catch (e) {
    degraded = true;
    console.warn('[session-dir-gc] presence read failed:', (e as Error).message);
  }

  // Open adv_sessions (still running) + running headless bees + active wakes —
  // one connection, a few cheap reads. coord_owner_id protects owner-keyed dirs;
  // the adv-session id protects the codex `session-<id>` homes; for an active
  // wake we also resolve the owner's adv-session id so a codex home mid-resume
  // is protected too.
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();

    const open = await sql<Array<{ coord_owner_id: string | null; id: number }>>`
      SELECT coord_owner_id, id FROM harness_shared.adv_sessions WHERE ended_at IS NULL
    `;
    for (const r of open) {
      if (r.coord_owner_id) ownerIds.add(r.coord_owner_id);
      sessionKeys.add(String(r.id));
    }

    const bees = await sql<Array<{ spawn_id: string }>>`
      SELECT spawn_id FROM harness_shared.spawned_agents
       WHERE status IN ('running', 'restarting')
    `;
    for (const r of bees) ownerIds.add(r.spawn_id);

    // Owners with a registered (unfired, uncancelled) wake OR an in-flight wake
    // delivery — the wake-executor will resume them into their dir.
    const awaiters = await sql<Array<{ subscriber_id: string }>>`
      SELECT DISTINCT subscriber_id FROM harness_shared.event_awaits
        WHERE fired_at IS NULL AND cancelled_at IS NULL
      UNION
      SELECT DISTINCT subscriber_id FROM harness_shared.event_wake_deliveries
        WHERE status IN ('pending', 'parked', 'delivering')
    `;
    const awaiterIds = awaiters.map((r) => r.subscriber_id).filter(Boolean);
    for (const id of awaiterIds) ownerIds.add(id);

    // Map those owners → their adv-session id so a codex home awaiting resume is
    // protected (codex homes are keyed by adv-session id, not owner id).
    if (awaiterIds.length) {
      const sessOfAwaiters = await sql<Array<{ id: number }>>`
        SELECT id FROM harness_shared.adv_sessions
         WHERE coord_owner_id = ANY(${awaiterIds})
      `;
      for (const r of sessOfAwaiters) sessionKeys.add(String(r.id));
    }
  } catch (e) {
    degraded = true;
    console.warn('[session-dir-gc] PG protected-set read failed:', (e as Error).message);
  }

  protectLivePtyHostHomes({ ownerIds, sessionKeys }, listLiveHosts());
  return { ownerIds, sessionKeys, degraded };
}

/**
 * Which of `candidates` still hold session files with NO committed archive
 * stamp? Those dirs are NOT safe to delete — returned as a set of paths for
 * {@link planSessionDirGc}.
 *
 * A dir with no session files at all is safe (nothing to lose) and is absent
 * from the result. Reads FAIL CLOSED: an unreadable dir or a failed stamp read
 * marks the dir unarchived (kept), because the cost of a wrong "keep" is one
 * more day of disk while the cost of a wrong "remove" is permanent data loss.
 * (Contrast `gatherProtectedSessionIdentity`, which fails OPEN — hence this
 * guard, which makes the tight 24h retention safe.)
 *
 * Lazy imports: `session-archive-reconciler` imports FROM this module, so a
 * static import of `session-archive` here would close a cycle.
 */
export async function findUnarchivedSessionDirs(
  candidates: SessionDirCandidate[],
  deps: { store?: { readStamp(kind: string, id: string): Promise<unknown> } } = {},
): Promise<Set<string>> {
  const unarchived = new Set<string>();
  if (!candidates.length) return unarchived;

  const { listClaudeSessionIds, listCodexRolloutSessionIds, pgSessionArchiveStore } = await import(
    './session-archive'
  );
  const store = deps.store ?? pgSessionArchiveStore();

  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = candidates[cursor++];
      if (!c) return;
      const sourceKind = c.keyKind === 'owner' ? 'claude' : 'codex';
      try {
        const ids =
          sourceKind === 'claude'
            ? await listClaudeSessionIds(c.path)
            : await listCodexRolloutSessionIds(c.path);
        for (const sessionId of ids) {
          if (!(await store.readStamp(sourceKind, sessionId))) {
            unarchived.add(c.path); // at least one un-committed session → keep the dir
            break;
          }
        }
      } catch (e) {
        unarchived.add(c.path); // fail CLOSED
        console.warn(`[session-dir-gc] archive-guard read failed for ${c.path}: ${(e as Error)?.message ?? e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return unarchived;
}

/**
 * The top-level entry the `system:session-dir-gc` routine fires: gather the
 * protected set from PG, verify the archive actually holds each collectible
 * dir's sessions, then sweep. `nowMs` is read here (the one impure clock read)
 * so the rest of the pipeline stays injectable.
 *
 * `archiveGuard: false` restores the pre-archive (lossy) behaviour — only
 * correct when paired with {@link LEGACY_RETENTION_MS}.
 */
export async function runSessionDirGc(
  opts: {
    retentionMs?: number;
    dryRun?: boolean;
    archiveGuard?: boolean;
    /** Injected for tests; production gathers it from PG. */
    protectedIdentity?: ProtectedSessionIdentity;
  } = {},
): Promise<SessionDirGcResult> {
  const protectedIdentity = opts.protectedIdentity ?? (await gatherProtectedSessionIdentity());

  // FAIL CLOSED: an incomplete protected set cannot distinguish a dead dir from
  // a live session's home. Skip this tick entirely — the next one sweeps.
  if (protectedIdentity.degraded) {
    console.warn(
      '[session-dir-gc] protected-set read DEGRADED (presence/PG unavailable) — sweep SKIPPED, nothing removed',
    );
    return {
      scanned: 0,
      removed: [],
      keptProtected: 0,
      keptFresh: 0,
      keptUnarchived: 0,
      dryRun: opts.dryRun ?? false,
      errors: [],
      skipped: 'degraded-protected-set',
    };
  }

  const nowMs = Date.now();
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const candidates = discoverSessionDirCandidates(defaultSessionDirRoots());

  // Only the dirs retention would actually collect need the (PG-hitting) guard.
  let unarchivedPaths: ReadonlySet<string> | undefined;
  if (opts.archiveGuard !== false) {
    const provisional = planSessionDirGc({ candidates, protectedIdentity, nowMs, retentionMs });
    unarchivedPaths = await findUnarchivedSessionDirs(provisional.remove);
  }

  return sweepStaleSessionDirs({
    protectedIdentity,
    candidates,
    nowMs,
    retentionMs,
    dryRun: opts.dryRun,
    unarchivedPaths,
  });
}
