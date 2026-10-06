/**
 * The blind-relay server wiring, with no Postgres or operator dependency
 * (WI-10004904, plan public-blind-relay-2026-10-01).
 *
 * Two callers share it:
 *   • `startVoiceRelayServer` (voice-relay.ts) — an operator serving the relay
 *     in-process, seed persisted in PG `voice_relay.serverSeed`.
 *   • `scripts/relay/blind-relay-daemon.ts` — the standalone daemon on the
 *     Papercusp-run relay VM, seed read from a file. It is bundled with only
 *     hyperdht + blind-relay as runtime deps, so this module must import
 *     nothing else.
 *
 * The relay is BLIND: it forwards the UDX packets of a peer↔peer
 * NoiseSecretStream it cannot decrypt.
 */

// The untyped holepunch modules are declared in this shim. Referencing it here
// keeps the declarations visible to every program that compiles this file,
// including the agent-mcp typecheck, which reaches it across packages.
/// <reference path="../sync/hyperbee/holepunch.d.ts" />

export interface BlindRelayServerOpts {
  /** 32-byte keypair seed. The public key is derived from it, so the same seed gives the same key. */
  seed: Buffer;
  /** Custom DHT bootstrap (a testnet or an isolated rig). Omitted → the public DHT. */
  bootstrap?: Array<{ host: string; port: number }>;
  /** Fixed UDP port for the DHT node (so a firewall rule can open it). Omitted → any free port. */
  port?: number;
  /**
   * Called when a relay session errors (a peer resetting its stream is routine).
   * The error is always contained either way: an unhandled session 'error'
   * would crash the whole process (WI-10004904 — it killed the VM daemon).
   */
  onSessionError?: (err: unknown) => void;
}

export interface BlindRelayServer {
  /** The relay's public key (hex): the value peers put in their relay key set. */
  publicKey: string;
  /** Cumulative blind-relay stats (sessions / pairings / streams). */
  stats(): unknown;
  /** The DHT node's view of itself once bootstrapped. */
  address(): { host: string | null; port: number | null; firewalled: boolean | null };
  close(): Promise<void>;
}

interface RelaySocket {
  remotePublicKey: Buffer;
  on(ev: 'error', cb: (e: unknown) => void): unknown;
}

interface DhtNode {
  createServer(onconnection: (socket: RelaySocket) => void): {
    listen(keyPair: unknown): Promise<void>;
    close(): Promise<void>;
  };
  createRawStream(opts: Record<string, unknown>): unknown;
  ready(): Promise<void>;
  destroy(): Promise<void>;
  host?: string | null;
  port?: number | null;
  firewalled?: boolean;
}

interface DhtModule {
  default: (new (o?: Record<string, unknown>) => DhtNode) & {
    keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer };
  };
}

interface BlindRelaySession {
  on(ev: 'error', cb: (e: unknown) => void): unknown;
}

interface BlindRelayModule {
  Server: new (o: { createStream: (so: Record<string, unknown>) => unknown }) => {
    accept(socket: RelaySocket, o: { id: Buffer }): BlindRelaySession;
    close(): Promise<void>;
    stats: unknown;
  };
}

/** The public key (hex) a seed produces — what a relay started from that seed announces. */
export async function relayPublicKeyForSeed(seed: Buffer): Promise<string> {
  assertSeed(seed);
  const DHT = ((await import('hyperdht')) as unknown as DhtModule).default;
  return DHT.keyPair(seed).publicKey.toString('hex');
}

function assertSeed(seed: Buffer): void {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error(`blind relay seed must be 32 bytes, got ${Buffer.isBuffer(seed) ? seed.length : typeof seed}`);
  }
}

/** Parse a hex seed file's contents (whitespace tolerated). Throws on anything but 64 hex chars. */
export function parseRelaySeedHex(raw: string): Buffer {
  const hex = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('blind relay seed must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Run a blind-relay server on a dedicated hyperdht node and resolve once it is
 * announced (listening on the DHT under the seed-derived key).
 */
export async function createBlindRelayServer(opts: BlindRelayServerOpts): Promise<BlindRelayServer> {
  assertSeed(opts.seed);
  const DHT = ((await import('hyperdht')) as unknown as DhtModule).default;
  const { Server } = (await import('blind-relay')) as unknown as BlindRelayModule;

  const keyPair = DHT.keyPair(opts.seed);
  const dht = new DHT({
    ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });
  const relayServer = new Server({
    // The canonical wiring (mirrors hyperdht's own relayed-stream shape): each
    // relayed leg is a framed UDX raw stream on this node.
    createStream: (so) => dht.createRawStream({ ...so, framed: true }),
  });
  const server = dht.createServer((socket) => {
    socket.on('error', () => {
      /* sessions tear down on their own */
    });
    // blind-relay re-emits every relayed stream's error (ECONNRESET when a peer
    // drops) on the session. With no listener Node throws it as uncaught.
    const session = relayServer.accept(socket, { id: socket.remotePublicKey });
    session.on('error', (err) => {
      try {
        opts.onSessionError?.(err);
      } catch {
        /* a reporting hook must not take the relay down either */
      }
    });
  });
  try {
    await server.listen(keyPair);
  } catch (e) {
    await dht.destroy().catch(() => {});
    throw e;
  }

  return {
    publicKey: keyPair.publicKey.toString('hex'),
    stats: () => relayServer.stats,
    address: () => ({ host: dht.host ?? null, port: dht.port ?? null, firewalled: dht.firewalled ?? null }),
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
