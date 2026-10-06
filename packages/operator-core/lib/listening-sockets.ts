/**
 * listening-sockets — the TCP listen table with owning process, for
 * `dev:listening_ports` (plan `bash-to-tool-substitution-2026-07-26`, D-010
 * item 3 / D-017).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * 125 `ss`/`lsof`/`netstat` atoms across 23 sessions had no tool form at all.
 * 79% of a frozen 24-atom sample asked for the OWNING PROCESS, not merely
 * whether something was bound. So owner resolution is the primary feature here,
 * not a decoration — a version without it would miss the actual question.
 *
 * ── Why a separate module from service-health.ts ─────────────────────────────
 * D-017: `dev:service_health` probes a FIXED registry of endpoints and feeds an
 * ALARM path. This answers a point-in-time question about an ARBITRARY port —
 * the corpus is full of ephemeral, agent-allocated ports (:15070, :18213,
 * :23706, :19045 were all gone by the time this was written) that no fixed
 * registry can contain. Keeping them apart also keeps a query from ever
 * becoming an alarm source, which is the boundary WI-6146 pinned.
 *
 * ── The visibility limit, which the return shape must not hide ───────────────
 * The kernel reveals a socket's owning process only to the same uid (or root).
 * Measured on this host as the operator user: 240 listening sockets, 96 with a
 * readable owner, 144 (60%) WITHOUT. Those 144 are system/other-user services
 * (:25, :53, :80, :143, :587, :631, …) plus, notably, :5432 — Postgres, a port
 * agents genuinely ask about.
 *
 * A naive implementation returns `pid: null` for those and an agent reads it as
 * "nothing owns this port", which is worse than an error because it is a
 * confident wrong answer. So `ownerVisible` is a SEPARATE field from `pid`:
 *   { listening: true,  ownerVisible: true,  pid: 47585 }  → owned by that pid
 *   { listening: true,  ownerVisible: false, pid: null  }  → bound, owner is
 *                                                            another user's
 *   (no row at all)                                        → nothing is bound
 * Never collapse the middle case into the third.
 */

import { readlinkSync } from 'node:fs';
import { execFileViaSidecar } from './fleet/git-via-sidecar';
import { isReservedServicePort } from './reserved-service-ports';
import {
  attributeSocket,
  viewableUrl,
  type AppProject,
  type CwdReader,
  type SocketAttribution,
} from './listening-socket-apps';


/** Default cap on returned rows — this host has ~240 listening sockets. */
export const LISTENING_SOCKETS_DEFAULT_LIMIT = 60;

/**
 * The exact `ss` invocation: -t TCP · -l listening · -n numeric · -p process ·
 * -H no header.
 *
 * Exported so a guard can assert the LISTEN-ONLY scope MECHANICALLY rather than
 * by grepping prose. That scope is load-bearing well outside this module: the
 * `service.listening-ports` substitution pair refuses 9 of its 24 sampled atoms
 * with "reports LISTEN sockets only", and that refusal — and the
 * `needs-widening` verdict resting on it — becomes wrong the moment `-l` is
 * dropped here. Nothing else in the audit consults the implementation, so this
 * constant is the seam that ties the two together.
 */
export const SS_ARGV = ['-tlnpH'] as const;

export interface ListeningSocket {
  /** The bound port. */
  port: number;
  /** The bind address exactly as the kernel reports it (0.0.0.0, 127.0.0.1, ::, …). */
  address: string;
  family: 'ipv4' | 'ipv6';
  /**
   * The representative owning pid, or null when the owner is not readable by
   * this uid. With SO_REUSEPORT this is the first of `pids`.
   */
  pid: number | null;
  /**
   * EVERY pid listening on this (port, address). A cluster server binds one
   * socket per worker and `ss` prints a row for each — the live operator on
   * :3070 has 16. Reporting them as 16 near-identical rows would make the
   * dominant question ("who owns this port") harder to answer, not easier, and
   * would let one clustered server swamp a whole-table listing. So the rows are
   * grouped and the pids kept here.
   */
  pids: number[];
  /** How many sockets are bound to this (port, address) — `pids.length` when visible. */
  listeners: number;
  /** Owning process name, or null when not readable. */
  command: string | null;
  /**
   * FALSE means "bound, but owned by another user" — NOT "unowned". A row is
   * only absent when nothing is listening. See the header note.
   */
  ownerVisible: boolean;
  /** A port in RESERVED_SERVICE_PORTS — a long-lived core service owns it. */
  reserved: boolean;
  /**
   * The kernel's ACCEPT QUEUE for this listener, read from `ss`'s Recv-Q/Send-Q
   * columns. On a LISTEN socket those columns do NOT mean bytes (EI-19465075959589134):
   *   • `pending` (Recv-Q) — connections the kernel has fully established and
   *     queued, waiting for the process to call `accept()`.
   *   • `backlog` (Send-Q) — the accept-queue limit from `listen(2)` (511 here).
   *
   * A healthy server drains `pending` to 0 continuously, so a SUSTAINED non-zero
   * `pending` is the signature of a process that is listening but not accepting —
   * a blocked event loop. That state is invisible to every other liveness signal
   * at once: the port is open, `systemctl is-active` says active, the pid is
   * alive, and a TCP connect SUCCEEDS (the kernel completes the handshake on the
   * process's behalf). Only this queue distinguishes WEDGED from UP, and its
   * ceiling — `pending` pinned at `backlog` — is where new clients start being
   * refused outright.
   *
   * Summed across a SO_REUSEPORT group (`pending`) since the question is "how
   * many connections are waiting on this port"; `backlog` is the group max.
   */
  acceptQueue: { pending: number; backlog: number };
}

/**
 * A listen-table row plus the workspace app serving it and the URL to open.
 * See `listening-socket-apps.ts` for why the app is DERIVED from the owning
 * process's cwd rather than stored on the registry project row.
 */
export type AttributedListeningSocket = ListeningSocket & SocketAttribution;

/**
 * Read a process's cwd from `/proc`. Same-uid only — an unreadable link means
 * "cannot see", never "no cwd", which is why the caller distinguishes
 * `cwd-unreadable` from `no-registry-project`.
 */
export function procCwdReader(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * How to attribute sockets to apps. `projects: null` states that the registry
 * could not be READ (every row reports `registry-unavailable`) and is
 * deliberately distinct from `[]`, an empty registry that legitimately
 * attributes nothing.
 */
export interface AppAttributionSeam {
  projects: readonly AppProject[] | null;
  /** Defaults to {@link procCwdReader}; injected in tests so no /proc is touched. */
  readCwd?: CwdReader;
}

export interface ListeningSocketsResult {
  sockets: AttributedListeningSocket[];
  /** Rows matching the filter BEFORE the limit was applied. */
  matched: number;
  /** Every listening socket on the host, regardless of filter. */
  totalListening: number;
  truncated: boolean;
  /**
   * How many matched rows had an unreadable owner. Surfaced so a caller can
   * say "bound by another user" instead of misreporting an empty owner.
   */
  ownerHidden: number;
  /**
   * Present only when an `app` filter was used. Without it, zero rows is
   * ambiguous in exactly the way this module refuses to be elsewhere:
   * "that app is not registered" and "that app is registered but nothing is
   * serving it right now" are different answers with different next actions,
   * and an empty `sockets` array alone cannot tell them apart.
   */
  appFilter?: {
    slug: string;
    /** Is there a registry project with this slug at all? */
    known: boolean;
    /** Its registered path when known — where to go start it. */
    path: string | null;
  };
}

export class ListeningSocketsError extends Error {}

/**
 * One `users:(("name",pid=N,fd=N),…)` entry. Multiple appear under SO_REUSEPORT;
 * the first is reported and the rest are ignored — the question being asked is
 * "who owns this port", and a second worker of the same server is not a
 * different answer.
 */
const PROCESS_ENTRY = /\("([^"]*)",pid=(\d+)/;

/**
 * `ss -H` output row: State Recv-Q Send-Q Local Peer [Process].
 * Kept deliberately loose about the trailing process column, which is absent
 * entirely for sockets this uid cannot resolve.
 */
const SS_ROW = /^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;

/** Split `127.0.0.1:3070` / `[::1]:3070` / `*:80` into address + port. */
export function splitHostPort(local: string): { address: string; port: number } | null {
  const bracketed = /^\[(.*)\]:(\d+)$/.exec(local);
  if (bracketed) return { address: bracketed[1], port: Number(bracketed[2]) };
  const idx = local.lastIndexOf(':');
  if (idx <= 0) return null;
  const port = Number(local.slice(idx + 1));
  if (!Number.isInteger(port)) return null;
  return { address: local.slice(0, idx), port };
}

/** Parse `ss -tlnpH` output into rows. Exported for direct unit testing. */
export function parseSsOutput(stdout: string): ListeningSocket[] {
  const rows: ListeningSocket[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = SS_ROW.exec(trimmed);
    if (!m) continue;
    const [, state, recvQ, sendQ, local, , processCol] = m;
    // `-l` should already restrict this, but a stray non-LISTEN row must never
    // be reported as a listener.
    if (state.toUpperCase() !== 'LISTEN') continue;

    const hostPort = splitHostPort(local);
    if (!hostPort) continue;

    const owner = processCol ? PROCESS_ENTRY.exec(processCol) : null;
    rows.push({
      port: hostPort.port,
      address: hostPort.address,
      family: hostPort.address.includes(':') ? 'ipv6' : 'ipv4',
      pid: owner ? Number(owner[2]) : null,
      pids: owner ? [Number(owner[2])] : [],
      listeners: 1,
      command: owner ? owner[1] : null,
      ownerVisible: Boolean(owner),
      reserved: isReservedServicePort(hostPort.port),
      acceptQueue: { pending: Number(recvQ), backlog: Number(sendQ) },
    });
  }
  return groupReusePort(rows);
}

/**
 * Collapse the per-worker rows a SO_REUSEPORT cluster produces into one row per
 * (port, address, command). Order is preserved — the first row seen for a group
 * stays in place — so output remains in `ss`'s own ordering.
 *
 * Grouping includes `command` on purpose: two DIFFERENT programs bound to the
 * same port (possible across address families or via SO_REUSEPORT) is a real
 * finding an agent debugging a port conflict must see, not a detail to merge
 * away.
 */
function groupReusePort(rows: ListeningSocket[]): ListeningSocket[] {
  const byKey = new Map<string, ListeningSocket>();
  for (const row of rows) {
    // NOTE: `\x00` as an ESCAPE, never a literal NUL byte in the source. A raw
    // NUL makes the whole file read as BINARY — `file(1)` calls it "data", and
    // the agent-facing `grep` shim (ugrep -I) then SILENTLY SKIPS IT, returning
    // "no match" for text that is plainly there. That cost a real diagnosis:
    // every grep against this file came back empty while `rg` and `sed` found
    // the same string fine. NUL is still the right delimiter (it cannot occur
    // in a command name or address) — it just has to be written as an escape.
    const key = `${row.port}\x00${row.address}\x00${row.command ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, pids: [...row.pids], acceptQueue: { ...row.acceptQueue } });
      continue;
    }
    existing.listeners += 1;
    for (const pid of row.pids) if (!existing.pids.includes(pid)) existing.pids.push(pid);
    // "How many connections are waiting on this port" sums across the cluster —
    // a single wedged worker still leaves clients unserved. The backlog limit is
    // per-socket and identical across the group; max is the honest single number.
    existing.acceptQueue.pending += row.acceptQueue.pending;
    existing.acceptQueue.backlog = Math.max(existing.acceptQueue.backlog, row.acceptQueue.backlog);
  }
  return [...byKey.values()];
}

export interface ListListeningOptions {
  /** Only sockets bound to this port. */
  port?: number;
  /** Only sockets owned by this pid (resolvable only for same-uid processes). */
  pid?: number;
  /** Only sockets served by this registry app/harness slug. Requires `apps`. */
  app?: string;
  /** Registry projects + cwd reader used to attribute sockets to apps. */
  apps?: AppAttributionSeam;
  limit?: number;
}

/**
 * Read the TCP listen table. Uses `ss`, deliberately: it is what agents run
 * today, so the tool's answer matches the answer they would otherwise get, and
 * it resolves socket→pid far more cheaply than walking every /proc/<pid>/fd.
 */
export async function listListeningSockets(
  opts: ListListeningOptions = {},
): Promise<ListeningSocketsResult> {
  let stdout: string;
  try {
    // Forked by the spawner sidecar where this host has one (WI-10005424): service-health
    // probes call this from the bg-host main thread, where a local fork measured
    // 128-256 ms at 8 GB RSS (2026-10-02 10:25Z). A sick sidecar falls back to a counted
    // local fork, and the seam imports node:child_process lazily, so a test that mocks
    // it narrowly still loads this module.
    ({ stdout } = await execFileViaSidecar('ss', [...SS_ARGV], {
      timeoutMs: 5000,
      subsystem: 'listening-sockets',
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ListeningSocketsError(
      code === 'ENOENT'
        ? '`ss` is not available on this host, so the listen table cannot be read.'
        : `could not read the listen table: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const all = parseSsOutput(stdout);
  const portPidRows = all.filter(
    (s) =>
      (opts.port === undefined || s.port === opts.port) &&
      // Match ANY listener in the group, not just the representative pid —
      // otherwise a `pid` filter for worker 12 of a cluster finds nothing.
      (opts.pid === undefined || s.pids.includes(opts.pid)),
  );

  const seam = opts.apps;
  const readCwd = seam?.readCwd ?? procCwdReader;
  const attribute = (s: ListeningSocket): AttributedListeningSocket =>
    seam
      ? { ...s, ...attributeSocket(s, seam.projects, readCwd) }
      : {
          ...s,
          app: null,
          appUnknownReason: 'not-attempted',
          // Independent of the registry, so it is always answerable.
          localUrl: viewableUrl(s.address, s.port),
        };

  const attributed = portPidRows.map(attribute);
  const matchedRows =
    opts.app === undefined ? attributed : attributed.filter((s) => s.app?.slug === opts.app);
  const limit = opts.limit ?? LISTENING_SOCKETS_DEFAULT_LIMIT;

  // An `app` filter that matched nothing must say WHICH kind of nothing, so the
  // caller can tell "no such app" from "registered but not running".
  let appFilter: ListeningSocketsResult['appFilter'];
  if (opts.app !== undefined) {
    const project = (seam?.projects ?? []).find((p) => p.slug === opts.app) ?? null;
    appFilter = { slug: opts.app, known: project !== null, path: project?.path ?? null };
  }

  return {
    sockets: matchedRows.slice(0, limit),
    matched: matchedRows.length,
    totalListening: all.length,
    truncated: matchedRows.length > limit,
    ownerHidden: matchedRows.filter((s) => !s.ownerVisible).length,
    ...(appFilter ? { appFilter } : {}),
  };
}
