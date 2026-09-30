/**
 * hyperbee/scope-cores.ts — the P-006 §5.1 scoped log cores + the §5.3
 * SERVE-SIDE ROSTER GATE (ratified FS-D1/FS-D3/FS-D6; design
 * docs/plans/DESIGN-P-006-federation-scope-2026-07-02.md; consumed by P-108).
 *
 * WHY A SEPARATE, NEVER-`replicate()`d CORESTORE (the fail-closed mechanism —
 * verified against corestore 7.9.2 / hypercore 11 / protomux source):
 *   - `store.replicate(socket)` serves EVERY open/stored core to ANY connection
 *     via the lazy `ondiscoverykey → _attachMaybe` path — there is no per-core
 *     ACL, and a `detachFrom` is silently RE-attachable by a hostile re-request
 *     of the discovery key. A scoped core inside the main store is therefore
 *     FAIL-OPEN the moment its key leaks (exactly the leak §5.3 exists for).
 *   - protomux `pair()` is a Map SET keyed (protocol,id): a second corestore's
 *     `replicate()` on the same stream CLOBBERS the first's hypercore/alpha
 *     pairing — so the scoped store must never `replicate()` a shared socket.
 *   - The ONLY fail-closed serve primitive on public APIs: an EXPLICIT
 *     per-core×connection attach — `session.replicate(muxer)` (a Protomux
 *     instance routes to `_attachToMuxer` → `core.replicator.attachTo(mux)` and
 *     registers NO ondiscoverykey) — and `session.replicator.detachFrom(mux)`
 *     to stop serving NOW. With no lazy path registered for the scoped store,
 *     an unattached (or detached) scoped core is structurally UNSERVABLE on
 *     that connection, no matter who knows its key. That IS the §5.3 gate.
 *
 * The roster check (FS-D6/C6) is an injected `IsScopeMember` predicate whose
 * implementations MUST read the roster cache-bypassingly (see
 * lib/p2p/scope-roster.ts); this module re-checks it at EVERY serve decision
 * and never caches a membership answer.
 *
 * Mesh property: a member connection gets the peer's own scope log AND every
 * ADMITTED remote core of that scope attached (scope members relay each other),
 * and a remote core admitted LATER is attached to every connection already
 * serving that scope. Refusals are returned structurally — the caller emits the
 * M15 counter / P-004 receipt (D-004: never a silent drop).
 *
 * X6: a re-disclosure of an already-admitted core whose scope_epoch TRAILS the
 * recorded high-water is refused (replayed pre-revocation disclosure).
 */

import { formatScopeId, type ScopeId } from '../pot-git/scope-repo';
import type { ScopedLogDisclosure } from './scope-disclosure';
import type { IsScopeMember } from './scope-disclosure';

/** The name a peer's OWN writable log core for a scope is minted under (§5.1). */
export function ownScopeLogName(scope: ScopeId): string {
  return `peer-log:scope:${formatScopeId(scope)}`;
}

/**
 * Minimal structural view of a corestore SESSION (hypercore) — the bits the
 * registry touches. `replicate(mux)` with a Protomux instance attaches the core
 * to that muxer (hypercore index.js `_attachToMuxer`); `replicator.detachFrom`
 * stops serving it there. Narrowed at the boundary (peer-log.ts convention) so
 * unit tests run on fakes.
 */
export interface ScopedSessionLike {
  ready(): Promise<void>;
  /** Attach this core's replicator to a Protomux muxer (serve + fetch). */
  replicate(mux: object): unknown;
  readonly key: Buffer;
  readonly writable: boolean;
  /** hypercore session replicator accessor — used for detach + attached(). */
  readonly replicator?: {
    attached(mux: object): boolean;
    detachFrom(mux: object): void;
  };
}

/** Minimal structural view of the SCOPED corestore (never `replicate()`d). */
export interface ScopedStoreLike {
  get(opts: { name?: string; key?: Buffer; valueEncoding?: string }): ScopedSessionLike;
}

/** Why a serve/admit decision refused (each is an M15 counter at the caller). */
export type ScopeCoreRefusal =
  | { reason: 'not-a-member'; scopeId: string; peerGithubUserId: number }
  | { reason: 'epoch-trails-high-water'; scopeId: string; logCoreKeyHex: string; offered: number; highWater: number };

export interface ServeScopeResult {
  ok: boolean;
  /** Cores attached to the connection by this call (0 on refusal / already-attached). */
  attached: number;
  refusal?: ScopeCoreRefusal;
}

interface RemoteEntry {
  session: ScopedSessionLike;
  keyHex: string;
  /** X6 high-water of the disclosures we admitted this core at. */
  epoch: number;
}

interface ServedConn {
  /** scopeId → verified peer uid the scope is served to on this muxer. */
  scopes: Map<string, number>;
}

/**
 * The per-boot registry of scoped cores + which connections they are served on.
 * One instance per booted harness substrate, over ITS scoped store.
 */
export class ScopeCoreRegistry {
  private readonly store: ScopedStoreLike;
  /** scopeId → own writable log session (minted lazily, §5.1). */
  private readonly own = new Map<string, { session: ScopedSessionLike; keyHex: string }>();
  /** scopeId → admitted remote cores (keyHex → entry). */
  private readonly remotes = new Map<string, Map<string, RemoteEntry>>();
  /** live muxer → the scopes served on it (Map so revocation can iterate). */
  private readonly served = new Map<object, ServedConn>();

  constructor(store: ScopedStoreLike) {
    this.store = store;
  }

  /** Mint (or return) OUR writable log core for a scope. Never auto-served —
   *  serving happens only through serveScopeOnConnection's roster gate. */
  async ensureOwnScopeCore(scope: ScopeId): Promise<{ keyHex: string }> {
    const id = formatScopeId(scope);
    const existing = this.own.get(id);
    if (existing) return { keyHex: existing.keyHex };
    const session = this.store.get({ name: ownScopeLogName(scope), valueEncoding: 'json' });
    await session.ready();
    const keyHex = session.key.toString('hex');
    this.own.set(id, { session, keyHex });
    return { keyHex };
  }

  /** The scopes we currently hold an own log for (disclosure inputs). */
  ownScopeIds(): string[] {
    return [...this.own.keys()];
  }

  /** Own log core key for a scope, or null when not minted. */
  ownCoreKeyHex(scopeId: string): string | null {
    return this.own.get(scopeId)?.keyHex ?? null;
  }

  /**
   * Admit a peer's disclosed scoped core (AFTER admitScopedAnnounce membership
   * validation — this layer only handles cores/attach + the X6 epoch fence).
   * Opens the remote core in the scoped store and attaches it to every
   * connection ALREADY serving this scope (late-admit mesh property).
   */
  async admitRemoteScopedCore(
    d: ScopedLogDisclosure,
  ): Promise<{ ok: true; newlyAdmitted: boolean } | { ok: false; refusal: ScopeCoreRefusal }> {
    const id = formatScopeId(d.scope);
    let byKey = this.remotes.get(id);
    if (!byKey) {
      byKey = new Map();
      this.remotes.set(id, byKey);
    }
    const existing = byKey.get(d.logCoreKeyHex);
    if (existing) {
      // X6: a re-disclosure must never REGRESS the epoch (replay of a
      // pre-revocation announce). Equal/greater advances the high-water.
      if (d.scopeEpoch < existing.epoch) {
        return {
          ok: false,
          refusal: {
            reason: 'epoch-trails-high-water',
            scopeId: id,
            logCoreKeyHex: d.logCoreKeyHex,
            offered: d.scopeEpoch,
            highWater: existing.epoch,
          },
        };
      }
      existing.epoch = d.scopeEpoch;
      return { ok: true, newlyAdmitted: false };
    }
    const session = this.store.get({
      key: Buffer.from(d.logCoreKeyHex, 'hex'),
      valueEncoding: 'json',
    });
    await session.ready();
    byKey.set(d.logCoreKeyHex, { session, keyHex: d.logCoreKeyHex, epoch: d.scopeEpoch });
    // Late-admit mesh: attach to every muxer already serving this scope.
    for (const [mux, conn] of this.served) {
      if (conn.scopes.has(id)) this.attachSafely(session, mux);
    }
    return { ok: true, newlyAdmitted: true };
  }

  /**
   * §5.3 THE SERVE GATE. Attach every core of `scope` (own + admitted remotes)
   * to `mux` IFF the connection's VERIFIED peer id is in the scope roster —
   * re-checked cache-bypassingly on EVERY call (FS-D6); this module never
   * caches a membership answer. Refusal is returned for the caller's counter.
   */
  async serveScopeOnConnection(
    mux: object,
    scope: ScopeId,
    peerGithubUserId: number,
    isScopeMember: IsScopeMember,
  ): Promise<ServeScopeResult> {
    const id = formatScopeId(scope);
    if (!(await isScopeMember(scope, peerGithubUserId))) {
      // Belt: if we were serving this scope here (roster changed under us),
      // stop NOW — a serve check is also a revocation edge (§5.3).
      this.stopServingScope(mux, id);
      return {
        ok: false,
        attached: 0,
        refusal: { reason: 'not-a-member', scopeId: id, peerGithubUserId },
      };
    }
    let conn = this.served.get(mux);
    if (!conn) {
      conn = { scopes: new Map() };
      this.served.set(mux, conn);
    }
    conn.scopes.set(id, peerGithubUserId);
    let attached = 0;
    const ownEntry = this.own.get(id);
    if (ownEntry && this.attachSafely(ownEntry.session, mux)) attached++;
    for (const r of this.remotes.get(id)?.values() ?? []) {
      if (this.attachSafely(r.session, mux)) attached++;
    }
    return { ok: true, attached };
  }

  /** Stop serving ONE scope on ONE connection (detach every core of it). */
  stopServingScope(mux: object, scopeId: string): void {
    const conn = this.served.get(mux);
    if (conn) conn.scopes.delete(scopeId);
    const ownEntry = this.own.get(scopeId);
    if (ownEntry) this.detachSafely(ownEntry.session, mux);
    for (const r of this.remotes.get(scopeId)?.values() ?? []) {
      this.detachSafely(r.session, mux);
    }
  }

  /**
   * D-017 n1 revocation edge: a peer left the roster of `scopeId` — stop
   * serving that scope on EVERY connection bound to that peer id, immediately
   * (never wait for reconnect). Returns how many connections were cut.
   */
  revokePeerFromScope(scopeId: string, peerGithubUserId: number): number {
    let cut = 0;
    for (const [mux, conn] of this.served) {
      if (conn.scopes.get(scopeId) === peerGithubUserId) {
        this.stopServingScope(mux, scopeId);
        cut++;
      }
    }
    return cut;
  }

  /** Transport died — forget its tracking (detach is moot on a dead stream). */
  dropConnection(mux: object): void {
    this.served.delete(mux);
  }

  /** The scopes currently served on a connection (redisclosure bookkeeping). */
  servedScopeIds(mux: object): string[] {
    return [...(this.served.get(mux)?.scopes.keys() ?? [])];
  }

  /** attach unless already attached; never throws (a bad core must not take
   *  down the connection handler). Returns true when a NEW attach happened. */
  private attachSafely(session: ScopedSessionLike, mux: object): boolean {
    try {
      if (session.replicator?.attached(mux)) return false;
      session.replicate(mux);
      return true;
    } catch {
      return false;
    }
  }

  private detachSafely(session: ScopedSessionLike, mux: object): void {
    try {
      if (session.replicator && session.replicator.attached(mux)) {
        session.replicator.detachFrom(mux);
      }
    } catch {
      // best-effort — a dead muxer/core can't block the revocation sweep
    }
  }
}
