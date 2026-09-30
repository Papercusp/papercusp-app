/**
 * commerce-peer-launcher.ts — launch `commerce-peer-child.ts` over a chosen
 * transport (P-036), the commerce analog of `loop-launcher.ts`.
 *
 * `localCommercePeerLauncher` spawns N peers as LOCAL child processes — real OS
 * processes, one throwaway corestore root each, which is what makes the run
 * "not in-process". `sshCommercePeerLauncher` runs one peer per remote host
 * against its public IP; identical binary, identical ndjson protocol, so the
 * orchestrator never branches on transport and a genuinely two-HOST run is a
 * launcher swap rather than a second code path.
 *
 * `ClaimAgentHandle` is reused verbatim: it is a transport-agnostic ndjson
 * process wrapper with no claim-specific behaviour, and forking it would mean
 * maintaining two copies of the same line-buffered event matcher.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSshStreamArgs, createSshRemoteExec, type SshTarget } from '../../deployment/remote-exec';
import { ClaimAgentHandle } from '../../deployment/p2p-perf-tier3/claim-launcher';
import type { CommercePeerConfig } from './commerce-peer-child';

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface CommercePeerSlot {
  readonly index: number;
  readonly label: string;
  /** Throwaway corestore root for this peer (fresh per run — D-057). */
  readonly root: string;
  launch(cfg: CommercePeerConfig): ClaimAgentHandle;
  /** Forcibly stop this slot's peer (the "machine dies" event). */
  kill(): Promise<void>;
}

export interface CommercePeerLauncher {
  readonly slots: readonly CommercePeerSlot[];
  cleanup(): Promise<void>;
}

const CHILD_LOCAL = (): string => new URL('./commerce-peer-child.ts', import.meta.url).pathname;

/**
 * The parent's env MINUS every vitest marker.
 *
 * These children are the whole point of this rig: they must be REAL,
 * production-shaped peer processes, and this repo's code deliberately branches
 * on `process.env.VITEST` in the sync/swarm path. A plain `{ ...process.env }`
 * spread therefore hands each "real peer" the test-runner's identity and it
 * stops behaving like production — so the rig measures something other than the
 * thing it claims to measure.
 *
 * MEASURED, not theorised (2026-09-06): identical code, one variable changed.
 *   CLI:                 11/11 scenarios pass, probe propagates in 3008ms.
 *   CLI + `VITEST=true`: mesh forms, then the probe is accepted on the EMITTER
 *                        and never reaches the other peer in 120_000ms.
 *   Under vitest:        same failure, reproducible 2/2.
 * Stripping the markers is what makes the in-vitest run agree with the CLI.
 *
 * The ssh launcher below needs no equivalent: ssh does not forward the local
 * environment, and it builds its remote command's env explicitly.
 */
function productionShapedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return env;
}

/** Local parity launcher: N peers as separate child processes on this box. */
export function localCommercePeerLauncher(opts: {
  readonly count: number;
  readonly log?: (line: string) => void;
}): CommercePeerLauncher {
  const log = opts.log ?? (() => {});
  const handles: ClaimAgentHandle[] = [];
  const roots: string[] = [];
  const childPath = CHILD_LOCAL();
  const slots: CommercePeerSlot[] = Array.from({ length: opts.count }, (_, i) => {
    const root = mkdtempSync(join(tmpdir(), `commerce-peer-${i}-`));
    roots.push(root);
    return {
      index: i,
      label: `local-${i}`,
      root,
      launch(cfg: CommercePeerConfig): ClaimAgentHandle {
        // process.execPath, not bare 'node' — immune to a minimal sidecar PATH
        // that omits node's dir (the loop-launcher precedent).
        const proc = spawn(process.execPath, ['--import', 'tsx', childPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...productionShapedEnv(), COMMERCE_PEER: JSON.stringify(cfg), NODE_ENV: 'test' },
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
      for (const root of roots) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          /* a leaked temp dir must never fail the run it was measuring */
        }
      }
    },
  };
}

export interface SshCommercePeerSpec {
  readonly label: string;
  readonly target: SshTarget;
  /** Remote path of a checkout that contains commerce-peer-child.ts. */
  readonly childPath: string;
  readonly runtimeDir: string;
  /** Remote corestore root. Distinct per co-located slot. */
  readonly root: string;
}

/** SSH launcher: one peer per real host — the genuine two-HOST posture. */
export function sshCommercePeerLauncher(opts: {
  readonly slots: readonly SshCommercePeerSpec[];
  readonly log?: (line: string) => void;
}): CommercePeerLauncher {
  const log = opts.log ?? (() => {});
  const handles: Array<ClaimAgentHandle | null> = opts.slots.map(() => null);
  const slots: CommercePeerSlot[] = opts.slots.map((f, i) => ({
    index: i,
    label: f.label,
    root: f.root,
    launch(cfg: CommercePeerConfig): ClaimAgentHandle {
      // The root is echoed into argv purely as a pkill marker; the child reads
      // its config from the environment, exactly as loop-agent does.
      const remoteCommand =
        `mkdir -p ${shq(cfg.root)} && cd ${shq(f.runtimeDir)} && ` +
        `COMMERCE_PEER=${shq(JSON.stringify(cfg))} NODE_ENV=test ` +
        `exec node --import tsx ${shq(f.childPath)} ${shq(cfg.root)}`;
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
        // The leading character is bracketed so the pattern cannot match the
        // remote shell's OWN argv, which contains this very script. An
        // unbracketed `pkill -f` here kills the ssh shell that is running it:
        // ssh then exits 255 with no output and every later line of the
        // teardown is silently skipped, leaving the host half torn down.
        await exec.runScript(`pkill -f '[c]ommerce-peer-child.ts ${f.root}' || true\n`);
      } catch (e) {
        log(`[commerce kill ${f.label}] ${e instanceof Error ? e.message : String(e)}`);
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
