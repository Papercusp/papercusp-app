/**
 * claim-launcher.ts — launch claim-agent.ts over a chosen transport, the claim-E2E
 * analog of remote-peer.ts (decentralized-dispatch-scaling-2026-06-08 P-013).
 *
 * `localClaimLauncher` spawns N agents as LOCAL child processes on loopback ports (the
 * $0 parity path — every line of the orchestration runs with no cloud). `sshClaimLauncher`
 * runs ONE agent per real Hetzner bench frame against its PUBLIC IP — the SAME agent
 * binary, so the orchestrator never branches on transport.
 *
 * Each launcher exposes per-slot: the `host` used to build the agent's authority base URL
 * (loopback vs the frame's public IP), a `launch(cfg)` returning a `ClaimAgentHandle`, and
 * a `kill()` that forcibly stops THAT slot's agent — the "a Swarm machine dies mid-run"
 * event the kill-authority test needs. Local kill = SIGKILL the child; SSH kill = `pkill`
 * the remote agent over a fresh SSH (its HTTP authority server dies → survivors' RPC to it
 * is refused → fail-open, exactly the production failure).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildSshStreamArgs, createSshRemoteExec, type SshTarget } from '../remote-exec';
import { benchRuntimeDir, remoteClaimAgentPath } from './bench-bootstrap';
import type { ClaimAgentConfig } from './claim-agent';

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A structured event line emitted by a claim-agent. */
export interface ClaimAgentEvent {
  evt: string;
  [k: string]: unknown;
}

/**
 * Wraps one launched claim-agent process: parses its ndjson stdout into `events`, lets the
 * orchestrator `send` stdin lines + `waitFor` an event, and `kill`/`close` it. Transport-
 * agnostic (a local child or an ssh child — both pipe the agent's ndjson over stdio).
 */
export class ClaimAgentHandle {
  readonly events: ClaimAgentEvent[] = [];
  private buf = '';
  private waiters: Array<{ match: (e: ClaimAgentEvent) => boolean; resolve: (e: ClaimAgentEvent | null) => void }> = [];
  private closed = false;

  constructor(
    readonly index: number,
    private readonly proc: ChildProcess,
    private readonly log: (line: string) => void = () => {},
  ) {
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => this.log(`[agent ${index} stderr] ${d.trimEnd()}`));
    proc.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.resolve(null);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let evt: ClaimAgentEvent;
      try {
        evt = JSON.parse(line) as ClaimAgentEvent;
      } catch {
        this.log(`[agent ${this.index}] non-json: ${line}`);
        continue;
      }
      this.events.push(evt);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(evt)) {
          this.waiters.splice(i, 1)[0].resolve(evt);
        }
      }
    }
  }

  /** Send a command line to the agent's stdin (`go` / `stop`). */
  send(line: string): void {
    if (!this.closed) this.proc.stdin?.write(line + '\n');
  }

  /** Resolve with the first event matching `evt`/predicate (incl. one already seen), or
   *  null on timeout / process close. */
  waitFor(evt: string | ((e: ClaimAgentEvent) => boolean), timeoutMs: number): Promise<ClaimAgentEvent | null> {
    const match = typeof evt === 'string' ? (e: ClaimAgentEvent) => e.evt === evt : evt;
    const already = this.events.find(match);
    if (already) return Promise.resolve(already);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs).unref?.();
    });
  }

  /** SIGKILL the local child (used by localClaimLauncher's kill). */
  sigkill(): void {
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /** Close the SSH/child stdio (end its stdin → the agent's `stop`/EOF path). */
  end(): void {
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
  }
}

/** One launch site for a claim-agent. */
export interface ClaimSlot {
  index: number;
  label: string;
  /** Host used to build the agent's authority base URL (`http://<host>:<port>`). */
  host: string;
  /** Address the agent binds its HTTP server to. */
  bindHost: string;
  /** The HTTP port this slot's agent serves /api/authority/rpc on. */
  httpPort: number;
  launch(cfg: ClaimAgentConfig): ClaimAgentHandle;
  /** Forcibly stop this slot's agent (the "machine dies" event). */
  kill(): Promise<void>;
}

export interface ClaimLauncher {
  slots: ClaimSlot[];
  cleanup(): Promise<void>;
}

const REPO_RUNTIME_LOCAL = (): string => {
  // operator-core/lib/deployment/p2p-perf-tier3 → repo root is 5 up; but locally we run
  // the source file directly, so resolve relative to THIS module's dir at call time.
  return new URL('./claim-agent.ts', import.meta.url).pathname;
};

/**
 * Local parity launcher: N agents as child processes on 127.0.0.1, each with a
 * pre-assigned loopback port. Drives the whole orchestration with zero cloud cost.
 */
export function localClaimLauncher(opts: {
  count: number;
  basePort: number;
  log?: (line: string) => void;
}): ClaimLauncher {
  const log = opts.log ?? (() => {});
  const handles: ClaimAgentHandle[] = [];
  const agentPath = REPO_RUNTIME_LOCAL();
  const slots: ClaimSlot[] = Array.from({ length: opts.count }, (_, i) => {
    const httpPort = opts.basePort + i;
    return {
      index: i,
      label: `local-${i}`,
      host: '127.0.0.1',
      bindHost: '127.0.0.1',
      httpPort,
      launch(cfg: ClaimAgentConfig): ClaimAgentHandle {
        // process.execPath, not bare 'node' — immune to a minimal sidecar PATH
        // that omits node's dir (B-DEPLOY-FIX; see harness-invoke-once.ts).
        const proc = spawn(process.execPath, ['--import', 'tsx', agentPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAIM_AGENT: JSON.stringify(cfg), NODE_ENV: 'test' },
        });
        const h = new ClaimAgentHandle(i, proc, log);
        handles.push(h);
        return h;
      },
      async kill(): Promise<void> {
        handles[i]?.sigkill();
      },
    };
  });
  return {
    slots,
    async cleanup(): Promise<void> {
      for (const h of handles) {
        h.send('stop');
        h.end();
      }
      // Give them a beat to close their HTTP servers, then SIGKILL any stragglers.
      await new Promise((r) => setTimeout(r, 500));
      for (const h of handles) h.sigkill();
    },
  };
}

export interface SshClaimSlotSpec {
  label: string;
  /** The frame's public IP (the agent's reachable host + bind 0.0.0.0). */
  host: string;
  target: SshTarget;
  /** The port THIS slot's agent serves on. Co-located slots (same host) MUST differ. */
  httpPort: number;
  installRoot?: string;
}

/**
 * SSH launcher: one agent per slot on a real frame's public IP. Mirrors sshPeerLauncher —
 * the agent config rides an inline env assignment, `exec node` replaces the remote shell.
 *
 * A slot list — NOT a frame list — so ≥3 Swarms can run across FEWER instances when a cloud
 * account caps the server count (e.g. Hetzner's 2-server limit): place the authority alone on
 * one frame and the survivors on another, each its own port. The agent's port is appended as
 * an argv marker so `kill()` can pkill EXACTLY that one agent (precise even when two share a
 * host) — its HTTP authority server dies → the survivors' RPC to it is refused → they fail open.
 */
export function sshClaimLauncher(opts: { slots: SshClaimSlotSpec[]; log?: (line: string) => void }): ClaimLauncher {
  const log = opts.log ?? (() => {});
  const handles: Array<ClaimAgentHandle | null> = opts.slots.map(() => null);
  const slots: ClaimSlot[] = opts.slots.map((f, i) => ({
    index: i,
    label: f.label,
    host: f.host,
    bindHost: '0.0.0.0',
    httpPort: f.httpPort,
    launch(cfg: ClaimAgentConfig): ClaimAgentHandle {
      const runtimeDir = benchRuntimeDir(f.installRoot);
      const agentPath = remoteClaimAgentPath(f.installRoot);
      // The port is also passed as an argv marker (the agent ignores argv, reading env) so a
      // precise `pkill -f 'claim-agent.ts <port>'` kills only this agent on a shared host.
      const remoteCommand =
        `cd ${shq(runtimeDir)} && ` +
        `CLAIM_AGENT=${shq(JSON.stringify(cfg))} NODE_ENV=test ` +
        `exec node --import tsx ${shq(agentPath)} ${f.httpPort}`;
      const target: SshTarget = {
        ...f.target,
        sudo: false,
        extraArgs: [
          ...(f.target.extraArgs ?? []),
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=8',
          '-o',
          'TCPKeepAlive=yes',
        ],
      };
      const { cmd, args } = buildSshStreamArgs(target, remoteCommand);
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const h = new ClaimAgentHandle(i, proc, log);
      handles[i] = h;
      return h;
    },
    async kill(): Promise<void> {
      // pkill EXACTLY this agent (by its port marker) — its HTTP authority server dies →
      // unreachable → the survivors fail open. The VM stays up for teardown.
      try {
        const exec = createSshRemoteExec({ ...f.target, sudo: false });
        await exec.runScript(`pkill -f 'claim-agent.ts ${f.httpPort}' || true\n`);
      } catch (e) {
        log(`[claim kill ${f.label}] ${e instanceof Error ? e.message : String(e)}`);
      }
      handles[i]?.end();
    },
  }));
  return {
    slots,
    async cleanup(): Promise<void> {
      for (const h of handles) {
        h?.send('stop');
        h?.end();
      }
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}
