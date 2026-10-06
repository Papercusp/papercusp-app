/**
 * claude-credential-sync.ts — newest-wins reconciliation of the Claude OAuth
 * credential bundle across the user-global `~/.claude/.credentials.json` and
 * every per-session `CLAUDE_CONFIG_DIR` fork under `~/.papercusp/session-claude/`
 * (claude-credential-sync-2026-06-10 P-001).
 *
 * WHY THIS EXISTS. The interactive per-session `CLAUDE_CONFIG_DIR` mirror
 * (interactive-claude-config.ts, EI-153/EI-155) symlinks `.credentials.json`
 * back to `~/.claude` so an OAuth refresh "passes through". In practice claude
 * rewrites the file by REPLACING it (write-temp + rename), which swaps the
 * symlink for a divergent real-file fork. Anthropic refresh tokens are
 * single-use and rotate: once one fork refreshes, every other copy (including
 * the global file) holds a consumed refresh token, fails its next refresh, and
 * forces `/login` — and refresh-token REUSE can revoke the whole token family
 * (upstream anthropics/claude-code#48786, #54443). On a box running a fleet of
 * sessions this cascades into "every terminal demands its own login" and 401s
 * for every headless spawn (memory: claude-p-headless-never-refreshes-oauth).
 *
 * THE FIX. Treat all copies as ONE logical credential: whenever any copy gets a
 * newer `claudeAiOauth` bundle (later `expiresAt`), propagate that bundle to
 * the global file and every real-file fork. Convergence makes the forks
 * harmless — by the time any session needs its token it already holds the
 * newest family member. Symlinked entries are skipped (they resolve to the
 * global file, which is reconciled directly).
 *
 * Safety properties:
 *  - ONLY the `claudeAiOauth` member is propagated — `mcpOAuth` (per-session
 *    MCP server tokens) and any other top-level keys stay per-file.
 *  - A bundle must look like a live rotating-family member to win: `sk-ant-`
 *    accessToken, a refreshToken (a `claude setup-token` bundle has none and
 *    must never clobber the interactive family), a finite `expiresAt` within
 *    a 30-day plausibility cap (garbage/forged-future guard).
 *  - Writes are atomic (same-dir temp + rename, 0600) and strictly monotonic
 *    (target updated only when its bundle is strictly older), so a converged
 *    tree produces zero writes — the fs.watch feedback loop terminates.
 *  - Nothing is ever deleted and absence is never propagated: a `/logout` in
 *    one session stays local to that session.
 *
 * ── macOS Keychain bridge (REQ B: reuse the login across consoles like Linux) ──
 * On macOS Claude Code stores its OAuth in the login KEYCHAIN, not in a
 * `.credentials.json` file — so the file scan above finds NOTHING and a psu
 * session's `CLAUDE_CONFIG_DIR` fork inherits no login, forcing `/login` in every
 * new console (the owner's exact report). The darwin branch adds the Keychain
 * bundle as a READ-ONLY candidate (winner-eligible, never a write target): it
 * seeds the global `~/.claude/.credentials.json` + every session fork, which
 * claude reads by CLAUDE_CONFIG_DIR file-precedence (verified live: claude 2.1.201
 * honours `$CLAUDE_CONFIG_DIR/.credentials.json`). When a fork later refreshes and
 * its bundle out-dates the Keychain, the newer bundle is WRITTEN BACK to the
 * Keychain (best-effort) so the owner's direct `claude` — which reads the Keychain —
 * stays on the live token: one logical credential across Keychain + file + forks.
 */
import { mkdirSync, watch } from 'node:fs';
import { lstat, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import chokidar, { type FSWatcher as ChokidarFSWatcher } from 'chokidar';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { pinModuleState } from '@papercusp/module-singleton';
import { basename, dirname, join, relative, sep } from 'node:path';
import { sessionClaudeRoot } from '@papercusp/orchestrator/session-launch-dirs';
// The ASYNC Keychain helpers: this reconcile runs on the operator main thread (boot, every watch
// kick, every 5 min), where a spawnSync of `security` blocks the whole host (WI-10005231).
import { readClaudeKeychainOAuthBundleAsync, writeClaudeKeychainOAuthBundleAsync } from './agent-auth-detect';
import { subscriptionRelayAllowed } from './anthropic-auth-policy';

/** Upper bound on a plausible interactive-OAuth `expiresAt` distance: real
 *  access tokens live ~8h; anything claiming >30d out is garbage or forged. */
const MAX_PLAUSIBLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The interactive Claude OAuth bundle inside `.credentials.json`. */
interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [k: string]: unknown;
}

interface Candidate {
  path: string;
  /** Parsed full-file JSON (base for the merge-write); `{}` if unreadable. */
  json: Record<string, unknown>;
  /** The valid bundle, or null (missing / malformed / implausible). */
  bundle: ClaudeAiOauth | null;
  isGlobal: boolean;
  /** A synthetic, READ-ONLY source (the macOS Keychain): winner-eligible but NEVER a write
   *  target (it has no real file path). Written back separately via `security add-generic-password`. */
  readOnly?: boolean;
  /** For a Keychain candidate: the `security` service label to write a newer bundle back to. */
  keychainService?: string;
}

export interface ReconcileResult {
  /** Real credential files examined (symlink aliases excluded). */
  scanned: number;
  /** Paths whose bundle was replaced by the winner this pass. */
  updated: string[];
  /** Winner provenance, or null when no valid bundle exists anywhere. */
  winner: { path: string; expiresAt: number } | null;
  /** darwin only — set when a newer file bundle was written back to the login Keychain this
   *  pass (so the owner's direct `claude` stays fresh); null/absent otherwise. */
  keychainWriteBack?: { service: string; expiresAt: number } | null;
}

export interface ReconcileOptions {
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
  /** Session-config root (testability); defaults to `sessionClaudeRoot()`. */
  sessionRoot?: string;
  /** Clock override (testability). */
  now?: number;
  /** Platform override (testability); defaults to `process.platform`. Drives the Keychain bridge. */
  platform?: NodeJS.Platform;
  /** Keychain account for write-back (testability); defaults to the login user (`$USER`). */
  keychainAccount?: string;
  /** Test-only: awaited after the scan, immediately before each target's write, so a
   *  test can simulate a fork refreshing between the scan read and the write. */
  _beforeWriteForTests?: (path: string) => void | Promise<void>;
}

function globalCredentialsPath(home: string): string {
  return join(home, '.claude', '.credentials.json');
}

function parseBundle(json: Record<string, unknown>, now: number): ClaudeAiOauth | null {
  const o = json.claudeAiOauth;
  if (!o || typeof o !== 'object') return null;
  const b = o as Record<string, unknown>;
  if (typeof b.accessToken !== 'string' || !b.accessToken.startsWith('sk-ant-')) return null;
  if (typeof b.refreshToken !== 'string' || b.refreshToken.length === 0) return null;
  if (typeof b.expiresAt !== 'number' || !Number.isFinite(b.expiresAt)) return null;
  if (b.expiresAt > now + MAX_PLAUSIBLE_TTL_MS) return null;
  return b as unknown as ClaudeAiOauth;
}

/** Read a REAL credentials file (caller has excluded symlinks). Unreadable /
 *  unparseable content yields `json: {}` — a later merge-write heals it. */
async function readCandidate(path: string, isGlobal: boolean, now: number): Promise<Candidate> {
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
  } catch {
    /* corrupt or vanished mid-read — treat as empty base */
  }
  return { path, json, bundle: parseBundle(json, now), isGlobal };
}

/** True when the path exists and is NOT a symlink (a fork worth reconciling).
 *  Symlinks resolve to the global file and are reconciled through it. */
async function isRealFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** True when ANYTHING is at `path`, following symlinks (a dangling link reads absent). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic merge-write of `bundle` into `target` — same-dir temp + rename, 0600.
 *
 * Compare-before-swap: the target is RE-READ immediately before the write, and the
 * write is skipped when the target now holds a bundle at least as new as `bundle`.
 * The scan read can be long stale by the time the write runs (the pass is async and
 * a claude session may refresh its fork in between); overwriting a freshly rotated
 * bundle with an older one would hand that session a consumed refresh token. The
 * fresh read is also the merge base, so sibling keys (`mcpOAuth`) written since the
 * scan survive. Returns false when skipped.
 */
async function writeBundle(target: Candidate, bundle: ClaudeAiOauth, now: number): Promise<boolean> {
  let base = target.json;
  if (await isRealFile(target.path)) {
    const fresh = await readCandidate(target.path, target.isGlobal, now);
    if (fresh.bundle && fresh.bundle.expiresAt >= bundle.expiresAt) return false;
    base = fresh.json;
  }
  const merged = { ...base, claudeAiOauth: bundle };
  const tmp = join(
    dirname(target.path),
    `.credentials.json.credsync-${process.pid}-${Math.floor(Math.random() * 1e9)}`,
  );
  try {
    await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    await rename(tmp, target.path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return true;
}

// Passes run one at a time per process. The periodic/watch pass and the launch path
// (writeInteractiveClaudeConfig) can now overlap in time; two overlapping passes would
// double the I/O on every fork. Each caller still gets its OWN full pass (a pass that
// started before a fork refreshed must not stand in for one that starts after it).
const reconcileQueue = pinModuleState('@papercusp/operator-core.claude-credential-sync.queue', () => ({
  tail: Promise.resolve() as Promise<unknown>,
}));

/**
 * One reconcile pass, fully asynchronous (node:fs/promises).
 *
 * WI-10005186: this used to be synchronous. It runs on the operator MAIN THREAD
 * (the background pass below, and `writeInteractiveClaudeConfig` on the
 * bootstrap/resume request paths), and a pass that propagates a refreshed bundle
 * does one temp-write + rename per real-file fork — 76 on the dev box. Under ext4
 * journal pressure each rename can wait seconds in `wait_transaction_locked`, so
 * one pass froze the event loop (observed: STALLED D, syscall rename, path
 * `<owner>/.credentials.json.credsync-*`, :3170 2026-10-02 02:00:07Z). Async I/O
 * moves that wait onto a libuv worker. Forks are processed SEQUENTIALLY on purpose:
 * one worker at a time, so a journal stall cannot also saturate the threadpool.
 *
 * ⚠ Keep this module free of synchronous fs on the pass path — guarded by a
 * code-shape test in claude-credential-sync.test.ts.
 */
export function reconcileClaudeCredentials(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const run = reconcileQueue.tail.then(
    () => reconcileOnce(opts),
    () => reconcileOnce(opts),
  );
  reconcileQueue.tail = run.catch(() => {});
  return run;
}

async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const home = opts.home ?? homedir();
  const sessionRoot = opts.sessionRoot ?? sessionClaudeRoot();
  const now = opts.now ?? Date.now();
  const platform = opts.platform ?? process.platform;

  const candidates: Candidate[] = [];
  const globalPath = globalCredentialsPath(home);
  if (await isRealFile(globalPath)) candidates.push(await readCandidate(globalPath, true, now));

  let sessionDirs: string[] = [];
  try {
    sessionDirs = await readdir(sessionRoot);
  } catch {
    /* no session root yet */
  }
  for (const dir of sessionDirs) {
    const p = join(sessionRoot, dir, '.credentials.json');
    if (await isRealFile(p)) candidates.push(await readCandidate(p, false, now));
  }

  // macOS Keychain bridge (REQ B): Claude Code keeps the OAuth bundle in the login Keychain,
  // not a file — so on a Mac the scan above finds nothing and a psu fork inherits no login. Add
  // the Keychain bundle as a READ-ONLY candidate so it seeds the global file + every fork (which
  // claude reads by CLAUDE_CONFIG_DIR file-precedence). Fail-soft: an ACL-blocked / non-macOS
  // read returns null and this is a no-op, leaving the pure-file behaviour byte-identical.
  let keychainCandidate: Candidate | null = null;
  if (platform === 'darwin') {
    const kc = await readClaudeKeychainOAuthBundleAsync(platform);
    if (kc) {
      const json = kc.bundle as Record<string, unknown>;
      keychainCandidate = {
        path: `keychain:${kc.service}`,
        json,
        bundle: parseBundle(json, now),
        isGlobal: false,
        readOnly: true,
        keychainService: kc.service,
      };
      if (keychainCandidate.bundle) candidates.push(keychainCandidate);
    }
  }

  // Winner: newest expiresAt; ties prefer global, then lexicographic path —
  // deterministic, and a tie with the global file means "no churn".
  let winner: Candidate | null = null;
  for (const c of candidates) {
    if (!c.bundle) continue;
    if (
      !winner ||
      c.bundle.expiresAt > winner.bundle!.expiresAt ||
      (c.bundle.expiresAt === winner.bundle!.expiresAt &&
        (c.isGlobal || (!winner.isGlobal && c.path < winner.path)))
    ) {
      winner = c;
    }
  }
  if (!winner) return { scanned: candidates.length, updated: [], winner: null };

  const updated: string[] = [];
  const winningBundle = winner.bundle!;

  // Restore a missing global file from the freshest fork (the documented
  // recovery for "global broke for every headless spawn") — but only when
  // ~/.claude exists; never materialize a .claude dir on a box without one.
  if (
    !(await isRealFile(globalPath)) &&
    !(await pathExists(globalPath)) &&
    (await pathExists(dirname(globalPath)))
  ) {
    candidates.push({ path: globalPath, json: {}, bundle: null, isGlobal: true });
  }

  for (const c of candidates) {
    if (c === winner) continue;
    if (c.readOnly) continue; // the Keychain source is written back separately (below), not via writeBundle
    if (c.bundle && c.bundle.expiresAt >= winningBundle.expiresAt) continue;
    try {
      await opts._beforeWriteForTests?.(c.path);
      if (await writeBundle(c, winningBundle, now)) updated.push(c.path);
    } catch (e) {
      console.warn(
        `[claude-cred-sync]   ! ${c.path}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  // Keychain write-back (REQ B): when a FILE member (typically a session fork that just
  // refreshed) is strictly newer than the Keychain bundle, push it back so the owner's direct
  // `claude` — which reads the Keychain — stays on the live token family. Skipped when the
  // Keychain itself is the winner (it is already the source). Best-effort: an ACL-blocked write
  // returns false and degrades to a single re-login at next expiry, never a throw.
  let keychainWriteBack: ReconcileResult['keychainWriteBack'] = null;
  if (
    platform === 'darwin' &&
    keychainCandidate?.bundle &&
    winner !== keychainCandidate &&
    winningBundle.expiresAt > keychainCandidate.bundle.expiresAt
  ) {
    try {
      const account = opts.keychainAccount ?? userInfo().username;
      const merged = { ...keychainCandidate.json, claudeAiOauth: winningBundle };
      const ok = await writeClaudeKeychainOAuthBundleAsync(
        keychainCandidate.keychainService!,
        account,
        JSON.stringify(merged),
        platform,
      );
      if (ok) keychainWriteBack = { service: keychainCandidate.keychainService!, expiresAt: winningBundle.expiresAt };
    } catch {
      /* best-effort — a failed Keychain write just means the owner's direct claude re-logs once */
    }
  }

  return {
    scanned: candidates.length,
    updated,
    winner: { path: winner.path, expiresAt: winningBundle.expiresAt },
    keychainWriteBack,
  };
}

// Module-scoped mutable state in a bundled package: pinned per the shared-lib
// singleton rule, so a second module record (tsx's CJS preflight, a bare vs
// relative specifier, a bundled copy beside source) cannot start a SECOND
// credential sync — duplicate watchers and intervals over the same files —
// while each record believes it holds the process-wide singleton.
const syncGuard = pinModuleState('@papercusp/operator-core.claude-credential-sync', () => ({
  handle: null as CredentialSyncHandle | null,
}));
const DEBOUNCE_MS = 1_500;
const FALLBACK_INTERVAL_MS = 5 * 60 * 1000;

export interface CredentialSyncHandle {
  stop(): void;
  /** Test-only: the depth-bounded session-root watcher (null if it failed to start).
   *  Lets tests assert the watch SET stays O(owner dirs) — the 2026-07-10 regression
   *  guard (recursive watch → 94.5k watches/process → host meltdown). */
  _sessionWatcherForTests?: ChokidarFSWatcher | null;
}

/**
 * Start the background sync: an initial reconcile, fs.watch on the global
 * `~/.claude` dir + a depth-1 chokidar watch on the session-claude root (the
 * creds forks live at exactly `<root>/<owner>/.credentials.json`; recursive
 * fs.watch is Node's userland tree-walk on Linux and caused the 2026-07-10
 * host meltdown — see the watcher block below), a debounce so claude's own
 * temp+rename bursts coalesce into one pass, and a 5-minute interval fallback
 * for missed events. Idempotent per process.
 *
 * `isEnabled` is consulted per PASS (not at start), so a feature-flag flip
 * takes effect without an operator restart.
 */
export function startClaudeCredentialSync(opts: {
  home?: string;
  sessionRoot?: string;
  /** Per-pass gate (feature flag). Defaults to always-on. */
  isEnabled?: () => Promise<boolean> | boolean;
} = {}): CredentialSyncHandle {
  if (syncGuard.handle) return syncGuard.handle;

  const home = opts.home ?? homedir();
  const sessionRoot = opts.sessionRoot ?? sessionClaudeRoot();
  const isEnabled = opts.isEnabled ?? (() => true);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const pass = async (trigger: string) => {
    if (stopped) return;
    try {
      // D-005 (open-source-release-2026-09-29): a public build never rewrites Claude.ai
      // OAuth bundles on a user's behalf unless they opt in for their own accounts.
      if (!subscriptionRelayAllowed('credential-sync')) return;
      if (!(await isEnabled())) return;
      const r = await reconcileClaudeCredentials({ home, sessionRoot });
      if (r.updated.length > 0 && r.winner) {
        console.log(
          `[claude-cred-sync] ${trigger}: winner=${r.winner.path} ` +
            `exp=${new Date(r.winner.expiresAt).toISOString()} → updated ${r.updated.length} file(s)`,
        );
      }
    } catch (e) {
      console.warn(`[claude-cred-sync] pass failed: ${(e as Error)?.message ?? e}`);
    }
  };

  const kick = (trigger: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void pass(trigger), DEBOUNCE_MS);
    debounce.unref?.();
  };

  const watchers: Array<{ close(): unknown }> = [];
  try {
    watchers.push(
      watch(join(home, '.claude'), { persistent: false }, (_ev, file) => {
        if (file === '.credentials.json') kick('watch:global');
      }),
    );
  } catch (e) {
    console.warn(`[claude-cred-sync] global watch unavailable: ${(e as Error)?.message ?? e}`);
  }
  let sessionWatcher: ChokidarFSWatcher | null = null;
  try {
    mkdirSync(sessionRoot, { recursive: true });
    // depth: 1 — credential forks live at EXACTLY sessionRoot/<owner>/.credentials.json
    // (reconcileClaudeCredentials reads only that shape), so root + owner dirs is the
    // complete watch set. ⚠ NEVER a recursive fs.watch here: Linux has no kernel
    // recursive watch, so Node falls back to a userland walk that watches EVERY
    // directory and re-stats subtrees on events — against the fleet's
    // <owner>/projects/** transcript churn that held ~94.5k inotify watches PER
    // PROCESS × 16 cluster workers and rescan-stormed the host to load >1100
    // (the 2026-07-10 meltdown). chokidar depth-1 keeps the same ≤debounce
    // propagation latency with O(owner dirs) inert watches and zero events from
    // the deep transcript trees.
    const depthUnder = (p: string): number => {
      const rel = relative(sessionRoot, p);
      return !rel || rel.startsWith('..') ? 0 : rel.split(sep).length;
    };
    sessionWatcher = chokidar.watch(sessionRoot, {
      depth: 1,
      ignoreInitial: true,
      persistent: false,
      // Prune HARD below the owner level (depth 1 alone still tracks owner
      // SUBdirs as watch entries — ~10×/owner): a dir deeper than <owner>/ is
      // never walked or watched, and the only file that exists for us is the
      // fork's creds file at exactly <owner>/.credentials.json — everything
      // else (cache/, chrome/, .claude.json, deep transcript trees) is noise.
      ignored: (p, stats) => {
        if (!stats) return false; // path-only pre-check — decide once stats arrive
        const d = depthUnder(p);
        if (stats.isDirectory()) return d >= 2;
        return d !== 2 || basename(p) !== '.credentials.json';
      },
    });
    const onCreds = (p: string) => {
      if (basename(p) === '.credentials.json') kick('watch:session');
    };
    sessionWatcher.on('add', onCreds);
    sessionWatcher.on('change', onCreds);
    // An unhandled 'error' on an EventEmitter throws — degrade to the interval instead.
    sessionWatcher.on('error', (e) => {
      console.warn(`[claude-cred-sync] session watch error: ${(e as Error)?.message ?? e}`);
    });
    watchers.push(sessionWatcher);
  } catch (e) {
    console.warn(`[claude-cred-sync] session watch unavailable: ${(e as Error)?.message ?? e}`);
  }

  const interval = managedSetInterval('claude-credential-sync', FALLBACK_INTERVAL_MS, () => pass('interval'), {
    category: 'watchdog',
  });
  void pass('boot');

  const handle: CredentialSyncHandle = {
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      interval.stop();
      for (const w of watchers) void w.close();
      syncGuard.handle = null;
    },
    _sessionWatcherForTests: sessionWatcher,
  };
  syncGuard.handle = handle;
  return handle;
}
