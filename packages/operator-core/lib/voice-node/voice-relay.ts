/**
 * Explicit voice relay / reachable-peer story (P-013 / D-009).
 *
 * The D-009 measurement: hyperdht does NOT auto-relay — a firewalled↔
 * firewalled peer pair simply fails to connect. The fix the stack already
 * carries: hyperswarm's `relayThrough` option relays a connection through a
 * **blind relay** (TURN-analog) when hole-punching fails
 * (HOLEPUNCH_ABORTED / DOUBLE_RANDOMIZED_NATS / REMOTE_NOT_HOLEPUNCHABLE —
 * hyperswarm retries through the relay automatically) or when the local NAT
 * is randomized. The relay is BLIND: it forwards UDX packets of the
 * peer↔peer NoiseSecretStream and never holds keys — D-012's E2E-encryption
 * guarantee is preserved through it by construction.
 *
 * Two halves, both here:
 *
 *   • **Client** — `getVoiceRelayKeys()` resolves the relay public keys the
 *     voice swarm should be able to fall back through:
 *     `PAPERCUSP_VOICE_RELAY_KEYS` (comma-separated hex, fleet provisioning)
 *     ∪ the PG operator-state row `voice_relay.relayKeys`
 *     ∪ {@link DEFAULT_RELAY_KEYS} when the swarm is on the PUBLIC DHT. The
 *     manager passes them as the dedicated voice swarm's `relayThrough`; the
 *     sync swarm reuses the same set (sync-relay.ts).
 *
 *   • **Server** — `startVoiceRelayServer()` makes THIS operator the
 *     designated reachable peer (D-009's natural candidate: the WG-hub box —
 *     one UDP-reachable host per fleet): a hyperdht server with a persistent
 *     keypair (seed in PG `voice_relay.serverSeed`) accepting blind-relay
 *     sessions. Enable via `voice_relay.serve = true` (or the test seam).
 *     Its printed public key is what the other operators put in their
 *     `relayKeys`.
 *
 * Remaining field work (hardware-gated, recorded on the plan): the
 * NAT-diversity hole-punch success rate across real CGNAT/symmetric pairs —
 * a beta-fleet measurement, not a code path.
 */
import { randomBytes } from 'node:crypto';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { createBlindRelayServer, type BlindRelayServer } from './blind-relay-core';

/**
 * Relays Papercusp runs on the public DHT (plan public-blind-relay-2026-10-01,
 * D-001/D-002). `voice_relay` is per-peer local state and is not replicated, so
 * a relay only helps a peer that already knows its key: shipping the key here
 * is how a fresh install gets a working fallback before it has ever connected
 * to anyone. Served by `papercusp-blind-relay.service` on the VM that
 * `scripts/relay/provision-relay-vm.sh` manages; the seed lives off-tree at
 * `~/.papercusp/relay/seed.hex`. Rotating the key means a new release.
 */
export const DEFAULT_RELAY_KEYS: readonly string[] = Object.freeze([
  'b1015b569f617f58d68a41542a3f42ba0765909ffee43379a96d4c7c9cf49f4c',
]);

export interface RelayKeyScope {
  /**
   * The DHT bootstrap list the swarm is constructed with. `undefined` or empty
   * means the public DHT (hyperdht's own default). A custom list (an isolated
   * rig or a testnet) cannot reach a public-DHT relay, so the defaults stay out
   * there: they could only ever produce a not-found warning.
   */
  dhtBootstrap: readonly unknown[] | undefined;
  /**
   * The operator declared a private DHT (`PAPERCUSP_DHT_BOOTSTRAP` or its file is set), but it
   * resolved to no usable node, so the swarm silently falls back to the PUBLIC DHT (swarm.ts
   * `resolveDhtUniverseState` → `'misconfigured'`). The defaults stay out here as well, failing
   * closed: an operator who asked for a private universe is never routed through Papercusp's
   * public relay because of a config typo (plan public-blind-relay-2026-10-01 D-002, R-4).
   * Required, so every caller has to answer it.
   */
  bootstrapMisconfigured: boolean;
}

/** Whether a swarm built with `scope` should fall back through {@link DEFAULT_RELAY_KEYS}. */
export function defaultRelayKeysApply(scope: RelayKeyScope, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PAPERCUSP_RELAY_DEFAULTS?.trim() === '0') return false;
  if (scope.bootstrapMisconfigured) return false;
  return !scope.dhtBootstrap || scope.dhtBootstrap.length === 0;
}

export interface VoiceRelayState {
  /** Hex public keys of blind-relay servers to fall back through. */
  relayKeys?: string[];
  /** Run a blind-relay server on this operator (the reachable peer). */
  serve?: boolean;
  /** Persistent seed (hex, 32 bytes) for the relay server keypair. */
  serverSeed?: string;
}

const STATE_KEY = 'voice_relay';

function parseHexKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

/** PG-stored relay state (empty defaults when unset / PG unreachable). */
export async function readVoiceRelayState(): Promise<VoiceRelayState> {
  try {
    return (await readOperatorState<VoiceRelayState>(STATE_KEY)) ?? {};
  } catch {
    return {};
  }
}

/**
 * The relay public keys for a swarm's `relayThrough`, as Buffers: env ∪ PG ∪
 * the shipped defaults (public DHT only, see {@link defaultRelayKeysApply}),
 * deduped, configured keys first. [] (→ pass `undefined` to hyperswarm) when
 * none apply. `scope` is required so every caller states which DHT its swarm
 * is on; a caller that guessed would hand an isolated swarm a key it can
 * never reach.
 */
export async function getVoiceRelayKeys(scope: RelayKeyScope): Promise<Buffer[]> {
  const fromEnv = parseHexKeys(process.env.PAPERCUSP_VOICE_RELAY_KEYS);
  const state = await readVoiceRelayState();
  const fromState = (state.relayKeys ?? []).map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s));
  const defaults = defaultRelayKeysApply(scope) ? DEFAULT_RELAY_KEYS : [];
  const all = [...new Set([...fromEnv, ...fromState, ...defaults])];
  return all.map((hex) => Buffer.from(hex, 'hex'));
}

export type VoiceRelayServer = Pick<BlindRelayServer, 'publicKey' | 'stats' | 'close'>;

export interface StartVoiceRelayOpts {
  /** Test seam: bootstrap nodes for an isolated DHT (testnet). */
  bootstrap?: Array<{ host: string; port: number }>;
  /** Test seam: explicit seed (skips PG persistence). */
  seed?: Buffer;
}

/**
 * Run a blind-relay server over a dedicated hyperdht node. The keypair
 * persists (PG seed) so the published public key survives restarts. The
 * wiring itself lives in blind-relay-core.ts, shared with the standalone
 * relay daemon.
 */
export async function startVoiceRelayServer(opts: StartVoiceRelayOpts = {}): Promise<VoiceRelayServer> {
  let seed = opts.seed ?? null;
  if (!seed) {
    const state = await readVoiceRelayState();
    if (state.serverSeed && /^[0-9a-f]{64}$/.test(state.serverSeed)) {
      seed = Buffer.from(state.serverSeed, 'hex');
    } else {
      seed = randomBytes(32);
      try {
        await writeOperatorState(STATE_KEY, { ...state, serverSeed: seed.toString('hex') });
      } catch (e) {
        console.warn('[voice-relay] could not persist server seed (key rotates on restart):', e);
      }
    }
  }
  const relay = await createBlindRelayServer({ seed, ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}) });
  console.log(`[voice-relay] blind relay listening — publicKey ${relay.publicKey}`);
  return { publicKey: relay.publicKey, stats: relay.stats, close: relay.close };
}

/** Boot hook: start the relay server when PG state opts this operator in. */
export async function maybeStartVoiceRelayServer(): Promise<VoiceRelayServer | null> {
  const state = await readVoiceRelayState();
  if (!state.serve) return null;
  try {
    return await startVoiceRelayServer();
  } catch (e) {
    console.error('[voice-relay] serve=true but the relay failed to start:', e);
    return null;
  }
}
