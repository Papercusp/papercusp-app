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
 *     ∪ the PG operator-state row `voice_relay.relayKeys`. The manager passes
 *     them as the dedicated voice swarm's `relayThrough`.
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
 * The relay public keys for the voice swarm's `relayThrough`, as Buffers.
 * Env wins ∪ PG; [] (→ pass `undefined` to hyperswarm) when none configured.
 */
export async function getVoiceRelayKeys(): Promise<Buffer[]> {
  const fromEnv = parseHexKeys(process.env.PAPERCUSP_VOICE_RELAY_KEYS);
  const state = await readVoiceRelayState();
  const fromState = (state.relayKeys ?? []).map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{64}$/.test(s));
  const all = [...new Set([...fromEnv, ...fromState])];
  return all.map((hex) => Buffer.from(hex, 'hex'));
}

export interface VoiceRelayServer {
  /** The relay's public key (hex) — what peers put in their relayKeys. */
  publicKey: string;
  /** Cumulative blind-relay stats (sessions / pairings / streams). */
  stats(): unknown;
  close(): Promise<void>;
}

export interface StartVoiceRelayOpts {
  /** Test seam: bootstrap nodes for an isolated DHT (testnet). */
  bootstrap?: Array<{ host: string; port: number }>;
  /** Test seam: explicit seed (skips PG persistence). */
  seed?: Buffer;
}

interface DhtLike {
  createServer(onconnection: (socket: RelaySocket) => void): {
    listen(keyPair: unknown): Promise<void>;
    close(): Promise<void>;
  };
  createRawStream(opts: Record<string, unknown>): unknown;
  destroy(): Promise<void>;
}
interface RelaySocket {
  remotePublicKey: Buffer;
  on(ev: 'error', cb: (e: unknown) => void): unknown;
}

/**
 * Run a blind-relay server over a dedicated hyperdht node. The keypair
 * persists (PG seed) so the published public key survives restarts.
 */
export async function startVoiceRelayServer(opts: StartVoiceRelayOpts = {}): Promise<VoiceRelayServer> {
  const dhtMod = (await import('hyperdht')) as unknown as {
    default: (new (o?: unknown) => DhtLike) & { keyPair(seed?: Buffer): { publicKey: Buffer } };
  };
  const DHT = dhtMod.default;
  const relayMod = (await import('blind-relay')) as unknown as {
    Server: new (o: { createStream: (so: Record<string, unknown>) => unknown }) => {
      accept(socket: RelaySocket, o: { id: Buffer }): unknown;
      close(): Promise<void>;
      stats: unknown;
    };
  };

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
  const keyPair = (DHT as unknown as { keyPair(s: Buffer): unknown }).keyPair(seed);

  const dht = new DHT(opts.bootstrap ? { bootstrap: opts.bootstrap } : undefined);
  const relayServer = new relayMod.Server({
    // The canonical wiring (mirrors hyperdht's own relayed-stream shape):
    // each relayed leg is a framed UDX raw stream on this node.
    createStream: (so) => dht.createRawStream({ ...so, framed: true }),
  });
  const server = dht.createServer((socket) => {
    socket.on('error', () => {
      /* sessions tear down on their own */
    });
    relayServer.accept(socket, { id: socket.remotePublicKey });
  });
  await server.listen(keyPair);
  const publicKey = (keyPair as { publicKey: Buffer }).publicKey.toString('hex');
  console.log(`[voice-relay] blind relay listening — publicKey ${publicKey}`);

  return {
    publicKey,
    stats: () => relayServer.stats,
    async close() {
      try {
        await relayServer.close();
      } catch {
        /* sessions already gone */
      }
      try {
        await server.close();
      } catch {
        /* server already closed */
      }
      await dht.destroy();
    },
  };
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
