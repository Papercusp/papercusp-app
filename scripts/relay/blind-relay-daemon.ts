/**
 * Standalone blind-relay daemon for the Papercusp-run relay VM
 * (plan public-blind-relay-2026-10-01, P-001). Runs the same server wiring the
 * operator uses in-process (packages/operator-core/lib/voice-node/blind-relay-core.ts)
 * with the seed read from a file, so the VM needs no Postgres and no operator.
 *
 * Egress budget (WI-10004956): the relay is open to anyone on the public DHT, so
 * the VM's internet egress is the cost risk. The daemon measures the VM's transmit
 * bytes each check, persists the UTC month's usage next to the seed, and SUSPENDS
 * relaying (closes the relay and its DHT node, so egress stops too) once the month's
 * budget is spent. It resumes on its own when the month rolls over. Every stats
 * line carries the month's usage so the cost is read from the log, not assumed.
 *
 * Bundled by scripts/relay/build-relay-daemon.mjs into one .mjs with only
 * hyperdht + blind-relay as runtime deps. Logs JSON lines on stdout.
 *
 * usage: node blind-relay-daemon.mjs --seed-file <path> [--port <udp>] [--stats-sec <n>]
 *          [--egress-budget-gb <n, 0=off>] [--egress-state <path>] [--egress-iface <name>]
 *          [--egress-check-sec <n>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBlindRelayServer, parseRelaySeedHex } from '../../packages/operator-core/lib/voice-node/blind-relay-core';
import {
  advanceEgress,
  BYTES_PER_GB,
  type EgressTick,
  parseProcNetDevTx,
  readEgressState,
  writeEgressState,
} from './egress-budget';

/** Default monthly budget: at a $0.12/GB premium-tier list price this caps relay egress near $6/month. */
export const DEFAULT_EGRESS_BUDGET_GB = 50;

export interface DaemonArgs {
  seedFile: string;
  port?: number;
  statsSec: number;
  /** Monthly egress budget in GB (decimal); 0 disables the guard. */
  egressBudgetGb: number;
  /** Where the month's usage persists across restarts. */
  egressStateFile: string;
  /** Count only this interface; omitted → every non-loopback interface. */
  egressIface?: string;
  /** How often egress is measured; bounds the overshoot past the budget. */
  egressCheckSec: number;
}

function positiveNumber(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be > 0, got ${v}`);
  return n;
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  let seedFile: string | undefined;
  let port: number | undefined;
  let statsSec = 300;
  let egressBudgetGb = DEFAULT_EGRESS_BUDGET_GB;
  let egressStateFile: string | undefined;
  let egressIface: string | undefined;
  let egressCheckSec = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--seed-file' && v) {
      seedFile = v;
      i++;
    } else if (a === '--port' && v) {
      port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be 1-65535, got ${v}`);
      i++;
    } else if (a === '--stats-sec' && v) {
      statsSec = positiveNumber('--stats-sec', v);
      i++;
    } else if (a === '--egress-budget-gb' && v) {
      egressBudgetGb = Number(v);
      if (!Number.isFinite(egressBudgetGb) || egressBudgetGb < 0) {
        throw new Error(`--egress-budget-gb must be >= 0 (0 disables the guard), got ${v}`);
      }
      i++;
    } else if (a === '--egress-state' && v) {
      egressStateFile = v;
      i++;
    } else if (a === '--egress-iface' && v) {
      egressIface = v;
      i++;
    } else if (a === '--egress-check-sec' && v) {
      egressCheckSec = positiveNumber('--egress-check-sec', v);
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!seedFile) throw new Error('--seed-file <path> is required');
  return {
    seedFile,
    ...(port !== undefined ? { port } : {}),
    statsSec,
    egressBudgetGb,
    egressStateFile: egressStateFile ?? join(dirname(seedFile), 'egress-state.json'),
    ...(egressIface !== undefined ? { egressIface } : {}),
    egressCheckSec,
  };
}

export interface RelayHandle {
  publicKey: string;
  stats(): unknown;
  address(): { host: string | null; port: number | null; firewalled: boolean | null };
  close(): Promise<void>;
}

export interface DaemonDeps {
  createRelay: () => Promise<RelayHandle>;
  readProcNetDev: () => string;
  now: () => Date;
  log: (o: Record<string, unknown>) => void;
}

export interface Daemon {
  /** One measurement: charge egress, suspend/resume the relay, emit stats when due. */
  tick(): Promise<void>;
  serving(): boolean;
  stop(): Promise<void>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Start serving (or start suspended, when the persisted month is already over
 * budget). An unreadable transmit counter with the guard on is fatal here: a cost
 * guard that cannot measure must fail loudly at boot, not serve unbounded.
 */
export async function startDaemon(args: DaemonArgs, deps: DaemonDeps): Promise<Daemon> {
  const budgetBytes = args.egressBudgetGb * BYTES_PER_GB;
  const guardOn = budgetBytes > 0;
  const readTx = () => parseProcNetDevTx(deps.readProcNetDev(), args.egressIface);

  let egress: EgressTick | null = null;
  if (guardOn) {
    egress = advanceEgress(readEgressState(args.egressStateFile), readTx(), deps.now(), budgetBytes);
    writeEgressState(args.egressStateFile, egress.state);
  }
  const egressFields = () =>
    egress
      ? {
          month: egress.state.month,
          usedBytes: egress.state.usedBytes,
          budgetBytes,
          usedPct: Math.round((egress.state.usedBytes / budgetBytes) * 1000) / 10,
        }
      : { budgetBytes: 0 };

  let relay: RelayHandle | null = null;
  const startRelay = async () => {
    relay = await deps.createRelay();
    deps.log({ ev: 'listening', publicKey: relay.publicKey, ...relay.address(), egress: egressFields() });
  };
  const suspend = async () => {
    deps.log({ ev: 'egress-budget-exhausted', egress: egressFields() });
    const r = relay;
    relay = null;
    await r?.close().catch((e: unknown) => deps.log({ ev: 'close-error', error: errText(e) }));
  };

  if (egress?.overBudget) {
    deps.log({ ev: 'egress-budget-exhausted', egress: egressFields() });
  } else {
    await startRelay();
  }

  let lastStatsAt = deps.now().getTime();
  let busy = false;
  return {
    serving: () => relay !== null,
    async tick() {
      if (busy) return;
      busy = true;
      try {
        if (egress) {
          try {
            egress = advanceEgress(egress.state, readTx(), deps.now(), budgetBytes);
            writeEgressState(args.egressStateFile, egress.state);
          } catch (e) {
            // Keep the last measurement; the next check retries. Logged every time so
            // a guard that stopped measuring is visible in the journal.
            deps.log({ ev: 'egress-unmeasured', error: errText(e) });
          }
          if (egress.overBudget && relay) {
            await suspend();
          } else if (!egress.overBudget && !relay) {
            deps.log({ ev: 'egress-budget-reset', egress: egressFields() });
            await startRelay().catch((e: unknown) => deps.log({ ev: 'resume-error', error: errText(e) }));
          }
        }
        const now = deps.now().getTime();
        if (now - lastStatsAt >= args.statsSec * 1000) {
          lastStatsAt = now;
          // A relay that drifts into firewalled:true cannot serve peers behind randomized
          // NATs, so the address is part of every stats line, not only the first.
          const r: RelayHandle | null = relay;
          deps.log({
            ev: 'stats',
            serving: r !== null,
            ...(r ? r.address() : {}),
            stats: r ? r.stats() : null,
            egress: egressFields(),
          });
        }
      } finally {
        busy = false;
      }
    },
    async stop() {
      const r = relay;
      relay = null;
      await r?.close().catch((e: unknown) => deps.log({ ev: 'close-error', error: errText(e) }));
    },
  };
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseDaemonArgs(argv);
  const seed = parseRelaySeedHex(readFileSync(args.seedFile, 'utf8'));
  const daemon = await startDaemon(args, {
    createRelay: () =>
      createBlindRelayServer({
        seed,
        ...(args.port !== undefined ? { port: args.port } : {}),
        // A peer resetting its stream is routine; log it, never die of it.
        onSessionError: (e: unknown) => log({ ev: 'session-error', error: errText(e) }),
      }),
    readProcNetDev: () => readFileSync('/proc/net/dev', 'utf8'),
    now: () => new Date(),
    log,
  });

  const checkSec = args.egressBudgetGb > 0 ? Math.min(args.statsSec, args.egressCheckSec) : args.statsSec;
  const timer = setInterval(() => void daemon.tick(), checkSec * 1000);
  const stop = async (signal: string) => {
    clearInterval(timer);
    log({ ev: 'stopping', signal });
    await daemon.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

// The bundle runs off-tree on the relay VM, so it cannot import operator-core's
// isCliEntry; pin our own basename (the sanctioned form for a copied-out entry).
function isDirectCliInvocation(entryPath = process.argv[1]): boolean {
  return typeof entryPath === 'string' && /(?:^|[\\/])blind-relay-daemon\.(?:mjs|ts)$/.test(entryPath);
}
if (isDirectCliInvocation()) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    log({ ev: 'fatal', error: errText(e) });
    process.exit(1);
  });
}
