/**
 * Relay fallback for the shared sync swarm (WI-10004827).
 *
 * Two peers that cannot holepunch each other never connect directly: two
 * machines behind the same NAT whose router does not hairpin UDP, a
 * client-isolating guest Wi-Fi, CGNAT mobile peers, cloud VMs behind one Cloud
 * NAT. Measured 2026-10-01 with two netns behind one MASQUERADE uplink: stock
 * hyperdht aborts with HOLEPUNCH_ABORTED every time, so without a relay those
 * peers silently never replicate.
 *
 * Voice already solves this with blind-relay servers passed as hyperswarm's
 * `relayThrough` (voice-node/voice-relay.ts). A blind relay forwards an
 * end-to-end encrypted hyperdht stream without reading it, so the same relay
 * set serves sync traffic too; this module reuses it rather than adding a
 * second relay registry.
 *
 * Fallback-only is hyperswarm's own semantics for a static key list (checked
 * against hyperswarm 4.17.0, `toRelayFunction` + `shouldForceRelaying`): the
 * relays are used only when a direct connect failed with HOLEPUNCH_ABORTED,
 * HOLEPUNCH_DOUBLE_RANDOMIZED_NATS or REMOTE_NOT_HOLEPUNCHABLE, or when this
 * node's own NAT is randomized. A reachable peer still connects directly.
 * sync-relay.test.ts pins that behaviour against the real module so an upgrade
 * that changes it fails loudly.
 */

import { getVoiceRelayKeys } from '../../voice-node/voice-relay';

/**
 * The `relayThrough` constructor option for the shared sync swarm. Omitted
 * entirely when no relay is configured: an empty array is truthy to hyperswarm,
 * so passing `[]` would make every forced retry "relay through nothing".
 */
export function syncRelayThroughOption(keys: readonly Buffer[]): { relayThrough?: Buffer[] } {
  return keys.length > 0 ? { relayThrough: [...keys] } : {};
}

/**
 * The reader the shared sync swarm uses: the voice relay set (env
 * PAPERCUSP_VOICE_RELAY_KEYS ∪ PG voice_relay.relayKeys ∪ the shipped defaults
 * when `dhtBootstrap` means the public DHT and the operator did not declare a
 * private DHT that failed to parse — `bootstrapMisconfigured`, see RelayKeyScope).
 */
export function syncRelayKeyReader(
  dhtBootstrap: readonly unknown[] | undefined,
  bootstrapMisconfigured: boolean,
): () => Promise<Buffer[]> {
  return () => getVoiceRelayKeys({ dhtBootstrap, bootstrapMisconfigured });
}

/**
 * The relay keys for the sync swarm, from `read` (normally
 * {@link syncRelayKeyReader}). Never throws: a read failure must not block
 * swarm construction, it only loses the fallback.
 */
export async function resolveSyncRelayKeys(read: () => Promise<Buffer[]>): Promise<Buffer[]> {
  try {
    return await read();
  } catch (e) {
    console.warn(
      `[swarm] ⚠ could not read relay keys — the sync swarm has NO relay fallback this boot: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}

/** One-line construction log so "can unreachable peers connect at all?" is visible. */
export function describeSyncRelayFallback(keys: readonly Buffer[]): string {
  return keys.length > 0
    ? `[swarm] relay fallback: ${keys.length} blind-relay key(s), used only after a direct holepunch fails`
    : '[swarm] relay fallback: NONE configured — peers that cannot holepunch (same NAT without hairpin, CGNAT) will never connect';
}

/*
 * Relay-key liveness (WI-10004904). A CONFIGURED relay key is not a WORKING
 * fallback. Measured 2026-10-01: this workspace's only relay key had been
 * PEER_NOT_FOUND on the DHT since it was set in June, while every boot logged
 * "1 blind-relay key(s)" — the line above reports configuration, not reality.
 * This probes each key once per boot and says out loud which keys nobody serves.
 *
 * hyperdht's `findPeer` yields only nodes that HOLD the key's announcement
 * (`mapFindPeer` drops value-less replies; checked against hyperdht 6.32.0 /
 * dht-rpc 6.27.0). So zero holders after nodes answered means nobody announces
 * the key. Zero holders when NO node answered means this process's DHT reached
 * nobody: that is UNKNOWN, never a dead relay — otherwise a broken bootstrap
 * would be misreported as a dead relay and send the reader after the wrong fix.
 */

export type RelayKeyLiveness =
  | { status: 'live' }
  | { status: 'not-found'; responders: number }
  | { status: 'unknown'; reason: string };

/** The slice of a hyperdht `findPeer` query (a dht-rpc Query stream) this probe reads. */
export interface RelayFindPeerQuery extends AsyncIterable<unknown> {
  /** dht-rpc: count of nodes that answered the lookup. */
  successes?: number;
  destroy?: () => void;
}

export interface RelayLookupDht {
  findPeer(publicKey: Buffer): RelayFindPeerQuery;
}

/** Upper bound on one key's lookup. A lookup that outlives it is UNKNOWN, not dead. */
export const RELAY_PROBE_TIMEOUT_MS = 20_000;

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? `${code}: ${e.message}` : e.message;
}

/** One bounded DHT lookup for one relay key. Never throws. */
export async function probeRelayKey(
  dht: RelayLookupDht,
  key: Buffer,
  timeoutMs: number = RELAY_PROBE_TIMEOUT_MS,
): Promise<RelayKeyLiveness> {
  let query: RelayFindPeerQuery;
  try {
    query = dht.findPeer(key);
  } catch (e) {
    return { status: 'unknown', reason: `findPeer threw: ${errorText(e)}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<RelayKeyLiveness>((resolve) => {
    timer = setTimeout(() => {
      query.destroy?.();
      resolve({ status: 'unknown', reason: `lookup timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const lookup = (async (): Promise<RelayKeyLiveness> => {
    try {
      // The first holder settles it; leaving the loop ends the query.
      for await (const _holder of query) return { status: 'live' };
    } catch (e) {
      return { status: 'unknown', reason: `lookup failed: ${errorText(e)}` };
    }
    const responders = typeof query.successes === 'number' ? query.successes : 0;
    return responders > 0
      ? { status: 'not-found', responders }
      : { status: 'unknown', reason: 'no DHT node answered the lookup (is the DHT reachable?)' };
  })();
  try {
    return await Promise.race([lookup, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RelayLivenessLine {
  level: 'info' | 'warn';
  line: string;
}

/** The per-key log line. Only a confirmed NOT-FOUND warns; UNKNOWN is never an alarm. */
export function describeRelayKeyLiveness(key: Buffer, liveness: RelayKeyLiveness): RelayLivenessLine {
  const key8 = key.toString('hex').slice(0, 8);
  switch (liveness.status) {
    case 'live':
      return { level: 'info', line: `[swarm] relay ${key8} is live on the DHT` };
    case 'not-found':
      return {
        level: 'warn',
        line:
          `[swarm] ⚠ relay ${key8} is NOT on the DHT (PEER_NOT_FOUND: ${liveness.responders} node(s) ` +
          `answered, none announce it) — nothing serves this relay; serve it or remove it from voice_relay.relayKeys`,
      };
    case 'unknown':
      return {
        level: 'info',
        line: `[swarm] relay ${key8} liveness UNKNOWN (${liveness.reason}) — not confirmed either way`,
      };
  }
}

/** The one-line verdict across every configured key. Null when no key is configured. */
export function summarizeRelayLiveness(
  results: ReadonlyArray<{ key: Buffer; liveness: RelayKeyLiveness }>,
): RelayLivenessLine | null {
  const n = results.length;
  if (n === 0) return null;
  const live = results.filter((r) => r.liveness.status === 'live').length;
  const dead = results.filter((r) => r.liveness.status === 'not-found').length;
  const unknown = n - live - dead;
  if (live > 0) {
    return { level: 'info', line: `[swarm] relay fallback: ${live} of ${n} relay key(s) live on the DHT` };
  }
  if (dead === n) {
    return {
      level: 'warn',
      line:
        `[swarm] ⚠ relay fallback is INERT: none of the ${n} configured relay key(s) is on the DHT — ` +
        'peers that cannot holepunch will never connect',
    };
  }
  if (dead > 0) {
    return {
      level: 'warn',
      line: `[swarm] ⚠ relay fallback may be INERT: ${dead} of ${n} relay key(s) not on the DHT, ${unknown} unconfirmed`,
    };
  }
  return { level: 'info', line: `[swarm] relay fallback liveness UNKNOWN for all ${n} key(s) — not confirmed` };
}

export interface RelayLivenessLog {
  info(line: string): void;
  warn(line: string): void;
}

/**
 * Probe every relay key through the swarm's own DHT and log the verdicts.
 * Never throws. Returns the per-key results, or null when the swarm exposes no
 * usable DHT (logged as UNKNOWN, not as a failure).
 */
export async function runRelayLivenessCheck(
  swarm: unknown,
  keys: readonly Buffer[],
  opts: { timeoutMs?: number; log?: RelayLivenessLog } = {},
): Promise<Array<{ key: Buffer; liveness: RelayKeyLiveness }> | null> {
  const log = opts.log ?? console;
  if (keys.length === 0) return [];
  const dht = (swarm as { dht?: unknown } | null | undefined)?.dht as Partial<RelayLookupDht> | undefined;
  if (!dht || typeof dht.findPeer !== 'function') {
    log.info('[swarm] relay liveness UNKNOWN: the swarm exposes no DHT findPeer (unrecognised hyperswarm shape)');
    return null;
  }
  const lookupDht = dht as RelayLookupDht;
  const results = await Promise.all(
    keys.map(async (key) => ({ key, liveness: await probeRelayKey(lookupDht, key, opts.timeoutMs) })),
  );
  for (const r of results) {
    const { level, line } = describeRelayKeyLiveness(r.key, r.liveness);
    log[level](line);
  }
  const summary = summarizeRelayLiveness(results);
  if (summary) log[summary.level](summary.line);
  return results;
}

/**
 * After the DHT bootstrap grace window, check that each configured relay key is
 * actually served. One-shot and `unref`'d like scheduleDhtReachabilityCheck:
 * never holds the process open, never recurs, never blocks swarm construction.
 */
export function scheduleRelayLivenessCheck(swarm: unknown, keys: readonly Buffer[], graceMs: number): void {
  if (keys.length === 0) return;
  const timer = setTimeout(() => {
    runRelayLivenessCheck(swarm, keys).catch((e: unknown) => {
      console.info(`[swarm] relay liveness check failed: ${errorText(e)} — liveness UNKNOWN`);
    });
  }, graceMs);
  (timer as { unref?: () => void }).unref?.();
}
