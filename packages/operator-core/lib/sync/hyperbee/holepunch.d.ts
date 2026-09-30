/**
 * Minimal type shims for the Holepunch native deps used by the
 * Hyperbee substrate. Upstream packages don't ship .d.ts files;
 * declaring the surface we actually use here gets us strict-mode
 * type safety on the substrate code while leaving the rest of the
 * surfaces `any` where consumers don't need them.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string | unknown, opts?: Record<string, unknown>);
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: { name?: string; key?: Buffer; valueEncoding?: string } | string): unknown;
    // `replicate(initiator: boolean)` returns a duplex stream to pipe by hand.
    // `replicate(stream)` plugs into an EXTERNAL stream (a Hyperswarm
    // connection / secret-stream) — it both replicates AND attaches the shared
    // muxer at `stream.userData` (Model B announce channel rides that muxer).
    replicate(initiatorOrStream: boolean | unknown): unknown;
    /**
     * The underlying hypercore-storage `CorestoreStorage`.
     *
     * ⚠ DELIBERATELY DOES NOT DECLARE `storage.flush()`. That method exists at
     * runtime (hypercore-storage index.js:766 → `this.rocks.flush()`) but is NOT the
     * durability flush anyone reaching for it wants: a rocksdb-native flush is scoped
     * to the column family of the session it is called on
     * (rocksdb-native/lib/state.js:225 —
     * `binding.flush(this._handle, db._columnFamily._handle, …)`), and the root `rocks`
     * session is pinned to the **'default'** column family (state.js:19/134), while ALL
     * hypercore data lives in the **'corestore'** column family
     * (hypercore-storage:10/509/1167).
     *
     * MEASURED (45×64KB appends, counting new .sst files on disk):
     *   `storage.flush()`     → 0 new SSTs — flushes nothing
     *   `storage.db.flush()`  → 1 new SST  — actually flushes the data
     *
     * So `storage.flush()` typechecks, ships, and silently does nothing. It is left
     * undeclared on purpose so that mistake cannot compile. Use `storage.db.flush()`,
     * which is what corestore's own `suspend()` calls (corestore/index.js:312).
     */
    readonly storage: {
      readonly readOnly: boolean;
      /** The **'corestore'** column-family session — the one that must be flushed. */
      readonly db: { flush(): Promise<void> };
    };
  }
}

declare module 'protomux' {
  // Minimal surface — the Model B announce channel rides the SAME muxer that
  // corestore.replicate(socket) attaches at `socket.userData`. We open one
  // extra channel + one JSON message on it.
  export interface ProtomuxMessage<T = unknown> {
    send(value: T): void;
  }
  export interface ProtomuxChannel {
    addMessage<T = unknown>(opts: {
      encoding: unknown;
      onmessage: (value: T) => void;
    }): ProtomuxMessage<T>;
    open(): void;
    close(): void;
  }
  export default class Protomux {
    static from(stream: unknown): Protomux;
    /**
     * Open a channel. `onopen` (when supplied) fires once the channel is fully
     * paired — i.e. the REMOTE peer has opened the matching protocol — which is
     * the only safe point to send a message that must not be dropped on a
     * fresh connection (a `message.send()` synchronously after `open()` can be
     * lost before the peer's channel exists).
     *
     * `id` keys the channel WITHIN the protocol — pairing matches on
     * `(protocol, id)`, so distinct ids (e.g. distinct directory topics) get
     * distinct paired channels on one muxer. Returns NULL when a channel with
     * the same `(protocol, id)` is already open on this muxer (`unique`).
     */
    createChannel(opts: {
      protocol: string;
      id?: Buffer | null;
      onopen?: () => void;
      onclose?: () => void;
      /**
       * Fires when the muxer's underlying stream drains, i.e. it can accept
       * more bytes after a `send()` returned `false`. Together with that
       * return value this is protomux's flow-control surface — a channel that
       * streams bulk data (pot-git's per-fetch sessions) MUST honour both or
       * it writes without limit into a backed-up connection.
       */
      ondrain?: () => void;
    }): ProtomuxChannel | null;
    /**
     * Register a LAZY-ACCEPT notifier: when the remote opens `(protocol, id)`
     * and no matching local channel exists, protomux REJECTS the open unless a
     * pair-notifier is registered for the exact id (or for the protocol with no
     * id — the any-id fallback) — corestore uses this to accept replication
     * channels lazily. The notify callback must createChannel SYNCHRONOUSLY
     * (before returning/awaiting) to consume the pending open, else the open is
     * rejected when the notify resolves.
     */
    pair(opts: { protocol: string; id?: Buffer | null }, notify: (id: Buffer | null) => void | Promise<void>): void;
    unpair(opts: { protocol: string; id?: Buffer | null }): void;
    /**
     * Batch outgoing writes: while corked, this mux's channel-open/message
     * frames accumulate in an internal buffer instead of hitting
     * `stream.write()` individually; `uncork()` flushes them as ONE
     * `_sendBatch` write, decoded on the peer via protomux's own
     * multi-message `_onbatch` loop. Used (WI-3583) to make a raw,
     * unframed test socket immune to the peer's `_ondata` path decoding
     * only ONE message per 'data' event — real production transports
     * (NoiseSecretStream) don't need this since they frame every write.
     * `cork`/`uncork` nest (paired calls only flush at the outermost).
     */
    cork(): void;
    uncork(): void;
  }
}

declare module 'compact-encoding' {
  // We only use the `json` codec for the announce frame — PLUS the raw
  // primitives (P-201, hive-git serve-wiring.ts) for a hand-rolled binary frame
  // encoding (a git pack is tens of MB; JSON/base64 would double it on the wire).
  export interface CompactEncodingState {
    start: number;
    end: number;
    buffer: Buffer | null;
  }
  export interface CompactEncoding<T> {
    preencode(state: CompactEncodingState, value: T): void;
    encode(state: CompactEncodingState, value: T): void;
    decode(state: CompactEncodingState): T;
  }
  const c: {
    json: unknown;
    uint: CompactEncoding<number>;
    int: CompactEncoding<number>;
    string: CompactEncoding<string>;
    buffer: CompactEncoding<Buffer>;
    [k: string]: unknown;
  };
  export default c;
}

declare module 'autobase' {
  export default class Autobase {
    constructor(
      store: unknown,
      bootstrap: Buffer | null,
      opts: {
        apply: (
          nodes: ReadonlyArray<{ value: unknown }>,
          view: { append: (op: unknown) => Promise<void>; length?: number },
          host: { addWriter: (key: Buffer) => Promise<void> },
        ) => Promise<void>;
        open: (store: unknown) => unknown;
      },
    );
    ready(): Promise<void>;
    close(): Promise<void>;
    append(op: unknown): Promise<void>;
    view: { length: number; append: (op: unknown) => Promise<void> };
    local: { key: Buffer };
    key: Buffer;
  }
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  // Minimal surface — we use join/leave/destroy + the 'connection' event.
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: Record<string, unknown>);
    join(
      topic: Buffer,
      opts?: { server?: boolean; client?: boolean },
    ): { flushed(): Promise<void> };
    leave(topic: Buffer): Promise<void> | void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (socket: unknown, info: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module 'hyperdht/testnet.js' {
  import type Hyperswarm from 'hyperswarm';
  // Minimal surface — `createTestnet(size)` spins up a LOCAL DHT (loopback,
  // offline) and returns `{ bootstrap, destroy() }`. `bootstrap` is fed to a
  // `new Hyperswarm({ bootstrap })` so two same-box peers discover each other
  // without touching the public DHT. Used by `two-peer-swarm.test.ts`.
  export interface Testnet {
    bootstrap: Array<{ host: string; port: number }>;
    nodes: unknown[];
    createNode(opts?: Record<string, unknown>): unknown;
    destroy(): Promise<void>;
  }
  export default function createTestnet(
    size?: number,
    opts?: Record<string, unknown>,
  ): Promise<Testnet>;
}

declare module 'hyperbee' {
  export default class Hyperbee {
    constructor(feed: unknown, opts?: Record<string, unknown>);
    ready(): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    get(key: string): Promise<{ key: string; value: unknown } | null>;
    del(key: string): Promise<void>;
  }
}

declare module '@hyperswarm/secret-stream' {
  import type { Duplex } from 'node:stream';
  // The Noise-encrypted, MESSAGE-FRAMED duplex a real Hyperswarm connection hands to
  // `store.replicate(socket)`. Tests construct one directly over a raw socket pair to
  // reproduce the real wire without touching the DHT (serve-wiring.integration.test.ts,
  // shared-socket-multi-corestore-clobber.test.ts) — a bare net.Socket is byte-streamed,
  // not framed, so protomux mis-parses it (WI-3490).
  //
  // Declared here rather than suppressed at the import site: it was carried as a permanent
  // baselined TS7016 in one test and a `@ts-ignore` in the other, and a suppression also
  // discards the TYPE (the clobber test annotates a pair with it), so the annotation was
  // silently `any`. Minimal surface — construct, await `opened`, and the Duplex members;
  // corestore/protomux take the stream as `unknown`, so nothing else needs typing.
  export default class NoiseSecretStream extends Duplex {
    constructor(isInitiator: boolean, rawStream?: unknown, opts?: Record<string, unknown>);
    /** Resolves when the Noise handshake completes. */
    readonly opened: Promise<boolean>;
    /** Where `corestore.replicate(stream)` attaches the shared muxer. */
    userData: unknown;
  }
}

// hyperdht + blind-relay: the Holepunch DHT + hole-punch relay used by the P2P
// voice relay (voice-node/voice-relay.ts) and the swarm (sync/hyperbee/swarm.ts).
// Upstream ships no .d.ts, so a bare import is implicit-`any` (TS7016). Declared
// here (surfaces intentionally `any` — no consumer needs strict types on them,
// per this file's stated convention) to keep the operator-core typecheck clean.
declare module 'hyperdht';
declare module 'blind-relay';
