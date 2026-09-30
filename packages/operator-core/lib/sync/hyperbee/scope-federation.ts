/**
 * hyperbee/scope-federation.ts — the P-108 / P-006 CONNECTION COORDINATOR that
 * wires the pure disclosure layer (scope-disclosure.ts), the scoped-core
 * registry + serve gate (scope-cores.ts), and the roster seam (p2p/scope-roster.ts)
 * onto live peer connections. boot.ts owns a single instance and calls into it;
 * all the §5.2/§5.3/D-017 logic lives HERE so boot.ts stays a thin hook and the
 * whole flow is unit-testable without a swarm.
 *
 * THE FLOW, per inbound announce on a connection (muxer):
 *   1. SERVE (§5.3): for each of OUR participating scopes the peer's verified id
 *      is a member of, attach that scope's cores (own + admitted remotes) to
 *      this muxer through the registry's fail-closed serve gate.
 *   2. ADMIT (§5.2 receive belt): admit the peer's disclosed `scoped_logs` iff
 *      WE are a member of each — open + attach the remote scoped cores; a
 *      disclosure for a scope we didn't opt into is a loud refusal (M15 counter).
 *   3. DISCLOSE (§5.2 send): the first announce is identity-blind, so we send a
 *      DIRECTED follow-up announce back to THIS peer carrying only the scoped_logs
 *      it may see — LOOP-DAMPED: sent only when the set changed vs what we last
 *      disclosed to this connection (else A→B→A→… ping-pong forever).
 *
 * D-017 n1 — `redisclose()`: after ANY roster/epoch mutation, re-run disclosure
 * on EVERY live connection; a scope newly hidden from a peer is DETACHED
 * (stop-serving) at once (revocation edge) and a fresh follow-up is sent.
 *
 * Structural inertness (FS-D5): with no participating scopes (the tier-1 default
 * until P-101 populates a fleet directory) `ownDisclosures()` is empty, so
 * nothing is ever served or disclosed — the machinery is live but dark, no flag.
 */

import { formatScopeId, type ScopeId } from '../pot-git/scope-repo';
import type { SignedAnnounce } from './announce';
import { ScopeCoreRegistry, type ScopeCoreRefusal } from './scope-cores';
import type { ScopeRoster } from '../../p2p/scope-roster';
import {
  admitScopedAnnounce,
  packScopedLog,
  type ScopedAdmissionRefusal,
  type ScopedLogDisclosure,
} from './scope-disclosure';
import type { AnnounceConnectionContext } from './swarm';

/** Any refused scoped decision the caller should turn into an M15 counter. */
export type ScopeFederationRefusal =
  | { kind: 'inbound-announce'; refusal: ScopedAdmissionRefusal }
  | { kind: 'serve' | 'admit-core'; refusal: ScopeCoreRefusal };

export interface ScopeFederationDeps {
  registry: ScopeCoreRegistry;
  roster: ScopeRoster;
  /** OUR verified numeric github id (the receive-side membership self, §5.2). */
  selfGithubUserId: number;
  /** Build a signed announce carrying `scopedLogs` (boot binds identity+signer). */
  buildScopedAnnounce: (scopedLogs: string[]) => Promise<SignedAnnounce>;
  /** M15/D-004: one counter per refused scoped entry. Best-effort, never throws. */
  onRefusal?: (r: ScopeFederationRefusal) => void;
}

interface ConnRecord {
  peerGithubUserId: number;
  send: (frame: SignedAnnounce) => void;
  /** The packed entries we last disclosed to this connection (damping state). */
  lastDisclosed: string[];
}

/** Order-independent set equality over packed disclosure strings. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

export class ScopeFederation {
  private readonly registry: ScopeCoreRegistry;
  private readonly roster: ScopeRoster;
  private readonly selfUid: number;
  private readonly buildScopedAnnounce: (scopedLogs: string[]) => Promise<SignedAnnounce>;
  private readonly onRefusal?: (r: ScopeFederationRefusal) => void;
  /** Participating scopes (we mint + own a log core per one), by scope id. */
  private readonly scopes = new Map<string, ScopeId>();
  /** Live connections, keyed by the shared Protomux muxer object. */
  private readonly conns = new Map<object, ConnRecord>();

  constructor(deps: ScopeFederationDeps) {
    this.registry = deps.registry;
    this.roster = deps.roster;
    this.selfUid = deps.selfGithubUserId;
    this.buildScopedAnnounce = deps.buildScopedAnnounce;
    this.onRefusal = deps.onRefusal;
  }

  /** Declare the scopes WE participate in — mints an own writable log core per
   *  one (idempotent). P-101's directory drives this set; tier-1 leaves it empty. */
  async ensureOwnScopes(scopes: readonly ScopeId[]): Promise<void> {
    for (const s of scopes) {
      this.scopes.set(formatScopeId(s), s);
      await this.registry.ensureOwnScopeCore(s);
    }
  }

  /** OUR scope disclosures with LIVE epochs (X6 — read cache-bypassingly). */
  private async ownDisclosures(): Promise<ScopedLogDisclosure[]> {
    const out: ScopedLogDisclosure[] = [];
    for (const [id, scope] of this.scopes) {
      const keyHex = this.registry.ownCoreKeyHex(id);
      if (!keyHex) continue;
      const scopeEpoch = await this.roster.currentEpoch(scope);
      out.push({ scope, logCoreKeyHex: keyHex, scopeEpoch });
    }
    return out;
  }

  /** The subset of OUR disclosures a given peer is a member of (what it may see). */
  private async visibleTo(peerGithubUserId: number): Promise<ScopedLogDisclosure[]> {
    const own = await this.ownDisclosures();
    const visible: ScopedLogDisclosure[] = [];
    for (const d of own) {
      if (await this.roster.isMember(d.scope, peerGithubUserId)) visible.push(d);
    }
    return visible;
  }

  /**
   * Handle an inbound announce on a connection: serve → admit → directed
   * follow-up (see the module header). Never throws (best-effort per step).
   */
  async onPeerAnnounce(frame: SignedAnnounce, ctx: AnnounceConnectionContext): Promise<void> {
    this.pruneDeadConnections();
    const peerUid = frame.github_user_id;
    if (!Number.isInteger(peerUid) || peerUid <= 0) return; // identity-blind base frame

    let rec = this.conns.get(ctx.muxer);
    if (!rec) {
      rec = { peerGithubUserId: peerUid, send: ctx.send, lastDisclosed: [] };
      this.conns.set(ctx.muxer, rec);
    } else {
      rec.peerGithubUserId = peerUid;
      rec.send = ctx.send; // a reconnect reuses the record but refreshes the sink
    }

    // 1. SERVE the scopes this peer may see (§5.3, fail-closed serve gate). We
    //    serve exactly the disclosure set — a scope the peer is NOT in is simply
    //    not served + not disclosed (capability non-disclosure, never a refusal).
    const visible = await this.visibleTo(peerUid);
    for (const d of visible) {
      const r = await this.registry.serveScopeOnConnection(
        ctx.muxer,
        d.scope,
        peerUid,
        this.roster.predicate,
      );
      if (!r.ok && r.refusal) this.onRefusal?.({ kind: 'serve', refusal: r.refusal });
    }

    // 2. ADMIT the peer's disclosed scoped logs (belt over §5.2 — loud refusals).
    const admission = await admitScopedAnnounce(frame.scoped_logs, this.selfUid, this.roster.predicate);
    for (const refusal of admission.refused) {
      this.onRefusal?.({ kind: 'inbound-announce', refusal });
    }
    for (const d of admission.admitted) {
      const res = await this.registry.admitRemoteScopedCore(d);
      if (!res.ok) this.onRefusal?.({ kind: 'admit-core', refusal: res.refusal });
    }

    // 3. DIRECTED FOLLOW-UP (§5.2 send) — loop-damped.
    await this.sendDisclosureIfChanged(rec, visible);
  }

  /** Send a fresh follow-up to `rec`'s peer iff `visible` differs from what we
   *  last disclosed to it. Updates the damping state on send. */
  private async sendDisclosureIfChanged(
    rec: ConnRecord,
    visible: ScopedLogDisclosure[],
  ): Promise<void> {
    const next = visible.map(packScopedLog);
    if (sameSet(next, rec.lastDisclosed)) return;
    rec.lastDisclosed = next;
    try {
      rec.send(await this.buildScopedAnnounce(next));
    } catch {
      // best-effort — a dropped follow-up self-heals on the next inbound/reflush
    }
  }

  /**
   * D-017 n1: a roster/epoch mutation happened — re-disclose EVERY live
   * connection. A scope no longer visible to a peer is DETACHED immediately
   * (revocation edge, §5.3), then a fresh follow-up is sent if anything changed.
   */
  async redisclose(): Promise<void> {
    this.pruneDeadConnections();
    for (const [muxer, rec] of this.conns) {
      const visible = await this.visibleTo(rec.peerGithubUserId);
      const next = visible.map(packScopedLog);
      const nextSet = new Set(next);
      // Stop serving any scope we USED to disclose but no longer do (immediate).
      for (const prev of rec.lastDisclosed) {
        if (!nextSet.has(prev)) {
          // lastDisclosed came from packScopedLog(our own scope) — recover the id.
          const scopeId = prev.split('|')[0];
          this.registry.stopServingScope(muxer, scopeId);
        }
      }
      // Serve any newly-visible scope on this connection.
      for (const d of visible) {
        const r = await this.registry.serveScopeOnConnection(
          muxer,
          d.scope,
          rec.peerGithubUserId,
          this.roster.predicate,
        );
        if (!r.ok && r.refusal) this.onRefusal?.({ kind: 'serve', refusal: r.refusal });
      }
      await this.sendDisclosureIfChanged(rec, visible);
    }
  }

  /** A connection died — forget its record + registry serve-tracking. */
  dropConnection(muxer: object): void {
    this.conns.delete(muxer);
    this.registry.dropConnection(muxer);
  }

  /** The swarm layer has no per-connection close hook into this coordinator, so
   *  dead muxers are swept lazily on every announce/redisclose — a Protomux
   *  whose underlying noise stream is destroyed (the same liveness signal
   *  swarm.ts's reflush tracker keys on) is pruned within one ANNOUNCE_REFLUSH,
   *  bounding conn-record growth under connection churn. */
  private pruneDeadConnections(): void {
    for (const muxer of [...this.conns.keys()]) {
      const stream = (muxer as { stream?: { destroyed?: boolean } }).stream;
      if (stream?.destroyed === true) this.dropConnection(muxer);
    }
  }

  /** Live connection count (diagnostics/tests). */
  get connectionCount(): number {
    return this.conns.size;
  }
}
