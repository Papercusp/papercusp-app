/**
 * _multi-session-testbed.ts — the KEYSTONE reusable harness for the coordination
 * test suite (coordination-test-suite-2026-06-08 P-002 / D-003).
 *
 * NOT a test file (no `.test.ts` suffix) — imported by the C1 (cross-agent
 * isolation) and C3 (multi-session concurrency) suites.
 *
 * ## Why this exists
 * EI-152 and EI-153 shipped past 27 green wake-executor tests because every one
 * was a SINGLE-agent unit test with the real seams mocked. Nothing ever asserted
 * "agent A's wake / message / lock / claim CANNOT reach agent B," and nothing
 * exercised the REAL per-session socket / config-dir isolation. This harness is
 * the missing primitive: it mints N genuinely-isolated sessions (each with its
 * own coord identity, its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and — on
 * demand — its own live control socket in an isolated discovery dir) and gives
 * the suites the helpers to drive every channel against them and assert isolation.
 *
 * ## Two tiers (both real, neither mocks the seam under test)
 *  1. **Identity sessions** (`session()`) — a `{ ownerId, advSessionId, configDir,
 *     codexHome, cwd }` tuple. Cheap; no process. Drive coord / locks / claims /
 *     the wake STORE against N of these and assert per-owner isolation.
 *  2. **Live control hosts** (`spawnSocketHost()`) — a real unix-domain socket +
 *     discovery `.json` in this testbed's ISOLATED `psuPtyDir`, speaking the REAL
 *     psu-pty-host v1 wire envelope. The operator's REAL `findLiveHost` +
 *     `injectIntoHost` (imported, never mocked) discover + inject into it. This
 *     is the seam EI-152 lived in. The stand-in plays only the COUNTERPARTY (the
 *     agent's pty host, an external process) — it decodes the exact v1 envelope a
 *     real host would, so executeWake's `psu-socket-inject` rung runs for real.
 *     (The FULL real `psu-pty-host.mjs` — idle-gate + CR-submit — is exercised by
 *     the dedicated apps/operator test; here we keep the operator side real and
 *     the counterparty a protocol-faithful double, with no cross-package dep.)
 *
 * The isolated `psuPtyDir` matters twice over: it keeps the suite from clobbering
 * (or being confused by) the LIVE fleet's `~/.papercusp/psu-pty` sockets on this
 * shared dev box, and it is exactly how a cross-agent isolation test proves
 * `findLiveHost(A)` never returns B's socket.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  findLiveHost,
  injectIntoHost,
  type PsuPtyHost,
} from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';
import type {
  DeliveryWork,
  WakeHandle,
} from '@papercusp/operator-core/lib/events/await/types';

/** One isolated session's identity + per-session storage roots. */
export interface TestSession {
  /** Coord ownerId / PAPERCUSP_SID — the cross-agent isolation key. Unique. */
  ownerId: string;
  /** A stable adv_sessions-style numeric id (handles key wake delivery by this). */
  advSessionId: number;
  /** This session's isolated CLAUDE_CONFIG_DIR (claude conversation store). */
  configDir: string;
  /** This session's isolated CODEX_HOME. */
  codexHome: string;
  /** The session's cwd (shared across the fleet by design — the EI-153 trap). */
  cwd: string;
  /** A short human label. */
  label: string;
}

/** A live control-socket host bound to one session in the testbed's isolated dir. */
export interface SocketHost {
  ownerId: string;
  sock: string;
  metaPath: string;
  /** Envelopes received over the socket, in order (the real v1 wire shape). */
  received: Array<{ v: number; mode: 'turn' | 'raw'; data: string }>;
  /** Tear this host down: close the server + remove the discovery file. */
  stop: () => Promise<void>;
}

const decoder = new TextDecoder();

export class MultiSessionTestbed {
  /** Isolated discovery dir — the operator's `findLiveHost(owner, dir)` reads here. */
  readonly psuPtyDir: string;
  /** Shared fleet cwd (every session shares it — reproduces the EI-153 topology). */
  readonly sharedCwd: string;
  private readonly root: string;
  private readonly sessions: TestSession[] = [];
  private readonly hosts: SocketHost[] = [];
  private seq = 0;

  private constructor(root: string) {
    this.root = root;
    this.psuPtyDir = join(root, 'psu-pty');
    this.sharedCwd = join(root, 'shared-cwd');
    mkdirSync(this.psuPtyDir, { recursive: true });
    mkdirSync(this.sharedCwd, { recursive: true });
  }

  /** Stand up a fresh testbed under an OS tmp dir. */
  static create(): MultiSessionTestbed {
    const root = mkdtempSync(join(tmpdir(), 'coord-testbed-'));
    return new MultiSessionTestbed(root);
  }

  /** Mint one isolated identity session (no process). */
  session(label?: string): TestSession {
    const n = ++this.seq;
    const ownerId = `su-${randomUUID()}`;
    const configDir = join(this.root, 'session-claude', ownerId);
    const codexHome = join(this.root, 'codex-homes', `session-${1000 + n}`);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const s: TestSession = {
      ownerId,
      advSessionId: 1000 + n,
      configDir,
      codexHome,
      cwd: this.sharedCwd, // deliberately shared — the EI-153 same-cwd trap
      label: label ?? `s${n}`,
    };
    this.sessions.push(s);
    return s;
  }

  /** Mint N isolated identity sessions at once. */
  sessions_(count: number): TestSession[] {
    return Array.from({ length: count }, (_, i) => this.session(`s${i + 1}`));
  }

  /**
   * Bind a REAL live control socket to `ownerId` in the isolated discovery dir,
   * writing the discovery `.json` with a live pid so the operator's real
   * `findLiveHost(ownerId, psuPtyDir)` returns it. The server decodes the exact
   * v1 envelope `injectIntoHost` writes. `hostPid` defaults to this process (alive).
   */
  async spawnSocketHost(
    ownerId: string,
    opts: { hostPid?: number; advSessionId?: number } = {},
  ): Promise<SocketHost> {
    const sock = join(this.psuPtyDir, `${sanitize(ownerId)}.sock`);
    const metaPath = join(this.psuPtyDir, `${sanitize(ownerId)}.json`);
    const received: SocketHost['received'] = [];

    const server = net.createServer((c) => {
      const chunks: Buffer[] = [];
      c.on('data', (d) => chunks.push(d));
      c.on('end', () => {
        try {
          const env = JSON.parse(decoder.decode(Buffer.concat(chunks)));
          received.push(env);
        } catch {
          /* a malformed write — record nothing, mirrors a host ignoring junk */
        }
      });
      c.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => resolve());
    });

    const meta: PsuPtyHost = {
      ownerId,
      advSessionId: opts.advSessionId != null ? String(opts.advSessionId) : null,
      pid: opts.hostPid ?? process.pid,
      ptyPid: process.pid,
      sock,
      command: 'test-host',
      startedAt: 1_700_000_000_000,
    };
    writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });

    const host: SocketHost = {
      ownerId,
      sock,
      metaPath,
      received,
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          if (existsSync(metaPath)) rmSync(metaPath);
        } catch {
          /* best-effort */
        }
        try {
          if (existsSync(sock)) rmSync(sock);
        } catch {
          /* best-effort */
        }
      },
    };
    this.hosts.push(host);
    return host;
  }

  /**
   * Write ONLY the discovery `.json` (no listening socket / a dead host pid) —
   * used by the liveness matrix to assert `findLiveHost` rejects a lingered file
   * (crashed host: pid dead or socket absent → must return null, never misroute).
   */
  writeLingeredHostFile(ownerId: string, opts: { hostPid?: number; sockExists?: boolean } = {}): string {
    const sock = join(this.psuPtyDir, `${sanitize(ownerId)}.sock`);
    const metaPath = join(this.psuPtyDir, `${sanitize(ownerId)}.json`);
    if (opts.sockExists) writeFileSync(sock, '');
    const meta: PsuPtyHost = {
      ownerId,
      advSessionId: null,
      pid: opts.hostPid ?? 0,
      ptyPid: 0,
      sock,
      command: 'test-host',
      startedAt: 1_700_000_000_000,
    };
    writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    return metaPath;
  }

  /** The operator's REAL discovery, pointed at this testbed's isolated dir.
   *  verifyIdentity:()=>true bypasses the WI-2339 pidIsPsuHost /proc-cmdline gate:
   *  the testbed records `process.pid` (the vitest process) as its live-host
   *  stand-in, whose cmdline carries no psu-launcher/psu-pty-host marker, so the
   *  real gate would reject it. The socket IS genuinely bound to this process, so
   *  trusting the pid is correct here — the identity gate has its own dedicated
   *  coverage (psu-pty-discovery.test.ts, pid-reuse-reachability-gap.test.ts). */
  findHost(ownerId: string): PsuPtyHost | null {
    return findLiveHost(ownerId, this.psuPtyDir, { verifyIdentity: () => true });
  }

  /** The operator's REAL socket inject (unchanged transport — exercises the seam). */
  inject(sock: string, msg: { mode: 'turn' | 'raw'; data: string }): Promise<boolean> {
    return injectIntoHost(sock, msg);
  }

  /**
   * `ExecuteWakeDeps.findPsuHost` bound to this testbed's isolated dir, so
   * `executeWake` runs its REAL psu-socket-inject rung against our real sockets
   * without touching the live fleet's `~/.papercusp/psu-pty`. (The behavior is
   * the real `findLiveHost`; only the search directory is redirected, and the
   * WI-2339 pidIsPsuHost gate is bypassed — see `findHost` for why: the stand-in
   * host records `process.pid`, whose cmdline lacks the psu-host marker.)
   */
  findPsuHostDep(): (ownerId: string) => PsuPtyHost | null {
    return (ownerId: string) => findLiveHost(ownerId, this.psuPtyDir, { verifyIdentity: () => true });
  }

  async destroy(): Promise<void> {
    for (const h of this.hosts) await h.stop().catch(() => {});
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Mirror of psu-pty-discovery.sanitizeKey — kept private to avoid coupling tests. */
function sanitize(ownerId: string): string {
  return String(ownerId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

/**
 * Build a `DeliveryWork` (the pump's unit) for a session, with sane defaults.
 * The wake executor only reads a handful of fields; this keeps the matrix tests
 * declarative. Pass `wakeHandle: null` for the handle-less (always-armed
 * inbox-wake) case — the one EI-152 lived in.
 */
export function makeDelivery(
  partial: Partial<DeliveryWork> & { subscriberId: string },
): DeliveryWork {
  return {
    id: partial.id ?? Math.floor(Math.random() * 1_000_000) + 1,
    workspaceId: partial.workspaceId ?? 'default',
    awaitId: partial.awaitId ?? 1,
    subscriberId: partial.subscriberId,
    eventKey: partial.eventKey ?? `coord:inbox-wake:${partial.subscriberId}`,
    payload: partial.payload ?? null,
    summary: partial.summary ?? null,
    status: partial.status ?? 'delivering',
    channel: partial.channel ?? null,
    attempts: partial.attempts ?? 1,
    lastError: partial.lastError ?? null,
    nextAttemptAt: partial.nextAttemptAt ?? new Date(0).toISOString(),
    createdAt: partial.createdAt ?? new Date(0).toISOString(),
    deliveredAt: partial.deliveredAt ?? null,
    urgent: partial.urgent ?? false,
    minSleepSec: partial.minSleepSec ?? null,
    coalescedCount: partial.coalescedCount ?? 1,
    source: partial.source ?? null,
    wakeHandle: partial.wakeHandle ?? null,
    note: partial.note ?? null,
  };
}

/** A handle for a session that backs an adv-session (claude by default). */
export function advSessionHandle(
  s: TestSession,
  over: Partial<Extract<WakeHandle, { kind: 'adv-session' }>> = {},
): WakeHandle {
  // Spread `over` LAST so an explicit `sessionId: null` (the "no native id" case)
  // wins — a `?? default` would treat the nullish null as "use the default" and
  // silently re-add an id, masking the not-resumable cells.
  return {
    kind: 'adv-session',
    advSessionId: s.advSessionId,
    agent: 'claude',
    sessionId: `native-${s.ownerId}`,
    ompThreadId: null,
    cwd: s.cwd,
    pid: null,
    ...over,
  };
}

/**
 * Spawn a real OS process and immediately kill it, returning its now-dead pid —
 * a GUARANTEED-dead pid for the liveness matrix (`alive(pid) === false`) that
 * cannot accidentally collide with a live process the way a random high number
 * could. Synchronous-ish: the caller awaits the kill.
 */
export async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
  // Give the OS a tick to reap it.
  await new Promise((r) => setTimeout(r, 20));
  return pid;
}
