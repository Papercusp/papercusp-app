/**
 * Probe relay keys on the PUBLIC DHT (plan public-blind-relay-2026-10-01, R-2 / P-004).
 *
 * Runs the SAME check a swarm runs at boot — sync-relay.ts runRelayLivenessCheck,
 * which probes each key with probeRelayKey and logs the boot-format lines
 * (`[swarm] relay <key8> is live on the DHT`, the fallback summary) — then prints
 * one JSON verdict per key. That makes this the tower's record of the boot
 * liveness line: the tower's bg-host joins an ISOLATED DHT, where the default
 * public key is deliberately withheld (D-002), so it never logs this line itself.
 *
 * usage: npx tsx scripts/relay/probe-relay-key.ts [<hex key> ...]
 *        (no keys → the shipped DEFAULT_RELAY_KEYS)
 * exit:  0 every key live · 1 some key not-found · 2 some key unknown (DHT unreachable / timeout)
 */
/// <reference path="../../packages/operator-core/lib/sync/hyperbee/holepunch.d.ts" />
import DHT from 'hyperdht';
import { isCliEntry } from '../../packages/operator-core/lib/util/cli-entry';
import {
  runRelayLivenessCheck,
  type RelayLivenessLog,
  type RelayLookupDht,
} from '../../packages/operator-core/lib/sync/hyperbee/sync-relay';
import { DEFAULT_RELAY_KEYS } from '../../packages/operator-core/lib/voice-node/voice-relay';

type ProbeDht = RelayLookupDht & { ready(): Promise<void>; destroy(): Promise<void> };

export interface ProbeRelayKeyOptions {
  /** A DHT to probe through; defaults to a fresh public-DHT node, destroyed afterwards. */
  dht?: ProbeDht;
  log?: RelayLivenessLog;
  /** Where the per-key JSON verdicts go (default stdout). */
  emit?: (line: string) => void;
  timeoutMs?: number;
}

export async function main(keysHex: readonly string[], opts: ProbeRelayKeyOptions = {}): Promise<number> {
  const hexes = keysHex.length > 0 ? keysHex : DEFAULT_RELAY_KEYS;
  for (const hex of hexes) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`not a 64-hex relay key: ${hex}`);
  }
  const emit = opts.emit ?? ((line: string) => console.log(line));
  const ownDht = opts.dht === undefined;
  const dht = opts.dht ?? new (DHT as unknown as new () => ProbeDht)();
  try {
    await dht.ready();
    const results = await runRelayLivenessCheck(
      { dht },
      hexes.map((hex) => Buffer.from(hex, 'hex')),
      { log: opts.log ?? console, timeoutMs: opts.timeoutMs },
    );
    if (results === null) return 2;
    let exit = 0;
    for (const { key, liveness } of results) {
      emit(JSON.stringify({ key: key.toString('hex'), ...liveness }));
      if (liveness.status === 'unknown') exit = Math.max(exit, 2);
      else if (liveness.status === 'not-found') exit = Math.max(exit, 1);
    }
    return exit;
  } finally {
    if (ownDht) await dht.destroy();
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
