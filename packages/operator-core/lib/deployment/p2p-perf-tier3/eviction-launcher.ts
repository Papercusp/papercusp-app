/**
 * eviction-launcher.ts — launch eviction-agent.ts over a chosen transport, the eviction-E2E
 * analog of claim-launcher.ts (P-016 of shared-hive-hardening-2026-06-13, D-010).
 *
 * `localEvictionLauncher` spawns N agents as LOCAL child processes on loopback ports (the
 * $0 parity path). `sshEvictionLauncher` runs ONE agent per real Hetzner bench frame against
 * its PUBLIC IP — the SAME agent binary, so the orchestrator never branches on transport.
 *
 * Each slot exposes the `host` used to build the agent's base URL (loopback vs the frame's
 * public IP), a `launch(cfg)` returning a generic ndjson agent handle (reused from
 * claim-launcher — it is transport- and payload-agnostic), and a `kill()` that forcibly
 * stops THAT slot's agent — the "a peer machine crashes" event the eviction proof needs.
 * Local kill = SIGKILL the child; SSH kill = `pkill` the remote agent over a fresh SSH (its
 * HTTP server dies → `GET /alive` is refused → its presence freezes on the survivors → φ
 * rises → witness-confirmed eviction).
 */

import { spawn } from 'node:child_process';
import { buildSshStreamArgs, createSshRemoteExec, type SshTarget } from '../remote-exec';
import { benchRuntimeDir, remoteEvictionAgentPath } from './bench-bootstrap';
import { ClaimAgentHandle as AgentHandle } from './claim-launcher';
import type { EvictionAgentConfig } from './eviction-agent';

export { AgentHandle };

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One launch site for an eviction-agent. */
export interface EvictionSlot {
  index: number;
  label: string;
  /** Host used to build the agent's base URL (`http://<host>:<port>`). */
  host: string;
  /** Address the agent binds its HTTP server to. */
  bindHost: string;
  /** The HTTP port this slot's agent serves on. Co-located slots (same host) MUST differ. */
  httpPort: number;
  launch(cfg: EvictionAgentConfig): AgentHandle;
  /** Forcibly stop this slot's agent (the "machine crashes" event). */
  kill(): Promise<void>;
}

export interface EvictionLauncher {
  slots: EvictionSlot[];
  cleanup(): Promise<void>;
}

const LOCAL_AGENT_PATH = (): string => new URL('./eviction-agent.ts', import.meta.url).pathname;

/**
 * Local parity launcher: N agents as child processes on 127.0.0.1, each on a pre-assigned
 * loopback port. Drives the whole orchestration with zero cloud cost.
 */
export function localEvictionLauncher(opts: {
  count: number;
  basePort: number;
  log?: (line: string) => void;
}): EvictionLauncher {
  const log = opts.log ?? (() => {});
  const handles: AgentHandle[] = [];
  const agentPath = LOCAL_AGENT_PATH();
  const slots: EvictionSlot[] = Array.from({ length: opts.count }, (_, i) => {
    const httpPort = opts.basePort + i;
    return {
      index: i,
      label: `local-${i}`,
      host: '127.0.0.1',
      bindHost: '127.0.0.1',
      httpPort,
      launch(cfg: EvictionAgentConfig): AgentHandle {
        // process.execPath, not bare 'node' — immune to a minimal sidecar PATH
        // that omits node's dir (B-DEPLOY-FIX; see harness-invoke-once.ts).
        const proc = spawn(process.execPath, ['--import', 'tsx', agentPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, EVICTION_AGENT: JSON.stringify(cfg), NODE_ENV: 'test' },
        });
        const h = new AgentHandle(i, proc, log);
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
      await new Promise((r) => setTimeout(r, 500));
      for (const h of handles) h.sigkill();
    },
  };
}

export interface SshEvictionSlotSpec {
  label: string;
  /** The frame's public IP (the agent's reachable host + bind 0.0.0.0). */
  host: string;
  target: SshTarget;
  /** The port THIS slot's agent serves on. Co-located slots (same host) MUST differ. */
  httpPort: number;
  installRoot?: string;
}

/**
 * SSH launcher: one agent per slot on a real frame's public IP. Mirrors sshClaimLauncher —
 * the agent config rides an inline env assignment, `exec node` replaces the remote shell, and
 * the port is appended as an argv marker so `kill()` can `pkill` EXACTLY that one agent (precise
 * even when two co-located agents share a host).
 *
 * A slot list — NOT a frame list — so ≥3 peers can run across FEWER instances when a cloud
 * account caps the server count (e.g. Hetzner's 2-server limit): place the authority alone on
 * one frame and the survivors on another, each its own port. Killing the authority's agent
 * partitions it across a real machine boundary from the surviving peers.
 */
export function sshEvictionLauncher(opts: {
  slots: SshEvictionSlotSpec[];
  log?: (line: string) => void;
}): EvictionLauncher {
  const log = opts.log ?? (() => {});
  const handles: Array<AgentHandle | null> = opts.slots.map(() => null);
  const slots: EvictionSlot[] = opts.slots.map((f, i) => ({
    index: i,
    label: f.label,
    host: f.host,
    bindHost: '0.0.0.0',
    httpPort: f.httpPort,
    launch(cfg: EvictionAgentConfig): AgentHandle {
      const runtimeDir = benchRuntimeDir(f.installRoot);
      const agentPath = remoteEvictionAgentPath(f.installRoot);
      const remoteCommand =
        `cd ${shq(runtimeDir)} && ` +
        `EVICTION_AGENT=${shq(JSON.stringify(cfg))} NODE_ENV=test ` +
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
      const h = new AgentHandle(i, proc, log);
      handles[i] = h;
      return h;
    },
    async kill(): Promise<void> {
      try {
        const exec = createSshRemoteExec({ ...f.target, sudo: false });
        await exec.runScript(`pkill -f 'eviction-agent.ts ${f.httpPort}' || true\n`);
      } catch (e) {
        log(`[eviction kill ${f.label}] ${e instanceof Error ? e.message : String(e)}`);
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
