/**
 * loop-launcher.ts — launch loop-agent.ts over a chosen transport, the full-loop
 * analog of claim-launcher.ts (shared-hive-loop-e2e-testing P-008/P-009/P-011).
 *
 * `localLoopLauncher` spawns N agents as LOCAL child processes on loopback ports
 * (the $0 parity path); `sshLoopLauncher` runs one agent per slot on a real Hetzner
 * bench frame against its PUBLIC IP. Identical agent binary, identical ndjson
 * protocol — the orchestrator (run-full-loop.ts) never branches on transport.
 *
 * Reuses ClaimAgentHandle (the ndjson process wrapper is agent-agnostic) and the
 * claim-launcher slot/kill discipline: the SSH kill pkills by a port argv marker so
 * co-located agents on one frame die individually.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSshStreamArgs, createSshRemoteExec, type SshTarget } from '../remote-exec';
import { benchRuntimeDir, remoteLoopAgentPath } from './bench-bootstrap';
import { ClaimAgentHandle } from './claim-launcher';
import type { LoopAgentConfig } from './loop-agent';

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One launch site for a loop-agent. */
export interface LoopSlot {
  index: number;
  label: string;
  /** Host used to build the agent's authority base URL (`http://<host>:<port>`). */
  host: string;
  /** Address the agent binds its HTTP server to. */
  bindHost: string;
  httpPort: number;
  /** Corestore root the agent should use (fresh per scenario). */
  root: string;
  launch(cfg: LoopAgentConfig): ClaimAgentHandle;
  /** Forcibly stop this slot's agent (the "machine dies" event). */
  kill(): Promise<void>;
}

export interface LoopLauncher {
  slots: LoopSlot[];
  cleanup(): Promise<void>;
}

const LOOP_AGENT_LOCAL = (): string => new URL('./loop-agent.ts', import.meta.url).pathname;

/** Local parity launcher: N agents as child processes on 127.0.0.1. */
export function localLoopLauncher(opts: {
  count: number;
  basePort: number;
  log?: (line: string) => void;
}): LoopLauncher {
  const log = opts.log ?? (() => {});
  const handles: ClaimAgentHandle[] = [];
  const agentPath = LOOP_AGENT_LOCAL();
  const slots: LoopSlot[] = Array.from({ length: opts.count }, (_, i) => {
    const httpPort = opts.basePort + i;
    return {
      index: i,
      label: `local-${i}`,
      host: '127.0.0.1',
      bindHost: '127.0.0.1',
      httpPort,
      root: mkdtempSync(join(tmpdir(), `loop-agent-${i}-`)),
      launch(cfg: LoopAgentConfig): ClaimAgentHandle {
        // process.execPath, not bare 'node' — immune to a minimal sidecar PATH
        // that omits node's dir (B-DEPLOY-FIX; see harness-invoke-once.ts).
        const proc = spawn(process.execPath, ['--import', 'tsx', agentPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, LOOP_AGENT: JSON.stringify(cfg), NODE_ENV: 'test' },
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
      await new Promise((r) => setTimeout(r, 800));
      for (const h of handles) h.sigkill();
    },
  };
}

export interface SshLoopSlotSpec {
  label: string;
  /** The frame's public IP (the agent's reachable host + bind 0.0.0.0). */
  host: string;
  target: SshTarget;
  /** The port THIS slot's agent serves on. Co-located slots MUST differ. */
  httpPort: number;
  installRoot?: string;
}

/** SSH launcher: one agent per slot on a real frame (claim-launcher parity). */
export function sshLoopLauncher(opts: { slots: SshLoopSlotSpec[]; log?: (line: string) => void }): LoopLauncher {
  const log = opts.log ?? (() => {});
  const handles: Array<ClaimAgentHandle | null> = opts.slots.map(() => null);
  const slots: LoopSlot[] = opts.slots.map((f, i) => ({
    index: i,
    label: f.label,
    host: f.host,
    bindHost: '0.0.0.0',
    httpPort: f.httpPort,
    // Per-slot, per-port corestore root on the frame — fresh per scenario because the
    // orchestrator varies the port base per scenario.
    root: `/tmp/loop-agent-${f.httpPort}`,
    launch(cfg: LoopAgentConfig): ClaimAgentHandle {
      const runtimeDir = benchRuntimeDir(f.installRoot);
      const agentPath = remoteLoopAgentPath(f.installRoot);
      // Port argv marker (the agent reads env only) → a precise pkill on shared hosts.
      const remoteCommand =
        `mkdir -p ${shq(cfg.root)} && cd ${shq(runtimeDir)} && ` +
        `LOOP_AGENT=${shq(JSON.stringify(cfg))} NODE_ENV=test ` +
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
      try {
        const exec = createSshRemoteExec({ ...f.target, sudo: false });
        await exec.runScript(`pkill -f 'loop-agent.ts ${f.httpPort}' || true\n`);
      } catch (e) {
        log(`[loop kill ${f.label}] ${e instanceof Error ? e.message : String(e)}`);
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
      await new Promise((r) => setTimeout(r, 800));
    },
  };
}
