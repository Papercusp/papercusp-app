/**
 * hyperbee/scope-disclosure.ts — the P-006 §5.2 disclosure gate for scoped
 * log announces (ratified D-017; design
 * docs/plans/DESIGN-P-006-federation-scope-2026-07-02.md).
 *
 * THE MECHANISM (sender-side scoping — the H16 flood / M14 storage fix lives
 * at the SOURCE, never in receiver filtering):
 *   - a peer's announce carries `scoped_logs` entries ONLY for scopes the
 *     REMOTE connection's verified identity is a member of — a non-member
 *     never learns a scoped core key, so it never requests, never stores;
 *   - the receive side re-checks (belt): an inbound scoped entry for a scope
 *     WE are not a member of is a protocol error → refused with a reason the
 *     caller must surface as a counter (M15: unauthenticated → counters) —
 *     never a silent drop (D-004);
 *   - D-017 n1: a roster mutation must re-disclose on LIVE connections —
 *     `computeRedisclosure` diffs each live connection's last-disclosed set
 *     against the current roster answer so the connection layer re-announces
 *     exactly the changed peers, immediately, not at next reconnect.
 *
 * ROSTER SEAM: membership is an injected async predicate. Implementations MUST
 * resolve identity → membership from the scope roster with CACHE-BYPASSING
 * reads on enforcement paths (C6/FS-D6, WI-1547 class) and key by GitHub
 * NUMERIC user id (X9). This module never caches.
 *
 * WIRE ENTRY: `scope_id|log_core_key_hex|scope_epoch` — one STRING per scope
 * (announce.ts signs string[] primitives; the '|' delimiter cannot occur in
 * any field: scope ids are `fleet:<digits>/<slug[a-z0-9-]>`, core keys 64-hex,
 * epochs decimal digits). Pack/parse round-trip here; parse is FAIL-CLOSED.
 */

import { type ScopeId, formatScopeId, parseScopeId } from '../pot-git/scope-repo';

/** One scoped-log declaration (the parsed form of a wire entry). */
export interface ScopedLogDisclosure {
  scope: ScopeId;
  /** 64-hex Hypercore key of the sender's log for this scope. */
  logCoreKeyHex: string;
  /** The scope's current epoch AT ANNOUNCE TIME (X6 — receivers track
   *  high-water per grantor; a trailing epoch is refusable by spawn-class
   *  consumers). */
  scopeEpoch: number;
}

const CORE_KEY_RE = /^[0-9a-f]{64}$/;

/** Pack a disclosure into its canonical signed wire string. Throws on a
 *  malformed input — packing happens sender-side on trusted data, where a bad
 *  value is a programming error, not wire noise. */
export function packScopedLog(d: ScopedLogDisclosure): string {
  if (!CORE_KEY_RE.test(d.logCoreKeyHex)) {
    throw new Error(`scope-disclosure: log core key must be 64-hex (got ${JSON.stringify(d.logCoreKeyHex)})`);
  }
  if (!Number.isSafeInteger(d.scopeEpoch) || d.scopeEpoch < 0) {
    throw new Error(`scope-disclosure: scope epoch must be a non-negative integer (got ${d.scopeEpoch})`);
  }
  return `${formatScopeId(d.scope)}|${d.logCoreKeyHex}|${d.scopeEpoch}`;
}

/** Parse an untrusted wire entry. FAIL-CLOSED: null on any malformation — the
 *  caller refuses the entry (with a counter), never guesses. */
export function parseScopedLog(entry: string): ScopedLogDisclosure | null {
  if (typeof entry !== 'string' || entry.length > 300) return null;
  const parts = entry.split('|');
  if (parts.length !== 3) return null;
  const scope = parseScopeId(parts[0]);
  if (!scope) return null;
  if (!CORE_KEY_RE.test(parts[1])) return null;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(parts[2])) return null;
  const epoch = Number(parts[2]);
  if (!Number.isSafeInteger(epoch)) return null;
  return { scope, logCoreKeyHex: parts[1], scopeEpoch: epoch };
}

/** The injected roster predicate (C6: cache-bypassing; X9: numeric ids). */
export type IsScopeMember = (scope: ScopeId, githubUserId: number) => Promise<boolean> | boolean;

/**
 * SENDER side: which of OUR scoped logs does THIS connection's verified peer
 * get to see? Returns the packed entries for the peer's announce. A scope the
 * peer is not a member of is simply absent — capability non-disclosure, the
 * primary layer (§5.2), not a refusal (nothing was requested).
 */
export async function discloseScopedLogsForPeer(
  own: ScopedLogDisclosure[],
  peerGithubUserId: number,
  isScopeMember: IsScopeMember,
): Promise<string[]> {
  const out: string[] = [];
  for (const d of own) {
    if (await isScopeMember(d.scope, peerGithubUserId)) out.push(packScopedLog(d));
  }
  return out;
}

/** Why an inbound scoped entry was refused (each is a COUNTER — M15). */
export type ScopedAdmissionRefusal =
  | { entry: string; reason: 'malformed' }
  | { entry: string; reason: 'not-a-member'; scopeId: string };

export interface ScopedAnnounceAdmission {
  /** Entries we may act on (open/replicate the scoped core). */
  admitted: ScopedLogDisclosure[];
  /** Refused entries + why — the caller MUST emit a counter per refusal
   *  (D-004 no-silent-drops; M15 unauthenticated failures get counters). */
  refused: ScopedAdmissionRefusal[];
}

/**
 * RECEIVE side (belt over the §5.2 capability layer): admit an inbound
 * announce's scoped entries iff WE are a member of each scope. A disclosure
 * for a scope we didn't opt into means the sender's gate is broken or hostile
 * — refuse it loudly; never open the core.
 */
export async function admitScopedAnnounce(
  scopedLogs: readonly string[] | undefined,
  selfGithubUserId: number,
  isScopeMember: IsScopeMember,
): Promise<ScopedAnnounceAdmission> {
  const admitted: ScopedLogDisclosure[] = [];
  const refused: ScopedAdmissionRefusal[] = [];
  for (const entry of scopedLogs ?? []) {
    const parsed = parseScopedLog(entry);
    if (!parsed) {
      refused.push({ entry, reason: 'malformed' });
      continue;
    }
    if (!(await isScopeMember(parsed.scope, selfGithubUserId))) {
      refused.push({ entry, reason: 'not-a-member', scopeId: formatScopeId(parsed.scope) });
      continue;
    }
    admitted.push(parsed);
  }
  return { admitted, refused };
}

/** A live connection's disclosure state, as the connection layer tracks it. */
export interface LiveConnectionDisclosure {
  /** The connection's verified peer identity (numeric, X9). */
  peerGithubUserId: number;
  /** The packed entries LAST disclosed to this peer (what they currently know). */
  lastDisclosed: readonly string[];
}

export interface RedisclosureOrder {
  peerGithubUserId: number;
  /** The packed entries the NEXT announce to this peer must carry. */
  next: string[];
  /** Entries newly visible to the peer (roster add / epoch advance). */
  added: string[];
  /** Entries no longer visible (revocation/downgrade — the connection layer
   *  additionally STOPS SERVING the affected cores at once, §5.3). */
  removed: string[];
}

/**
 * D-017 n1: after ANY roster mutation (or scope-epoch advance), compute which
 * LIVE connections need an immediate re-announce — never wait for reconnect.
 * Pure diff: a connection appears in the result iff its disclosure set
 * changed. Epoch advances change the packed string, so a rekey (5.4) also
 * re-discloses — exactly the property revocation needs.
 */
export async function computeRedisclosure(
  connections: readonly LiveConnectionDisclosure[],
  own: ScopedLogDisclosure[],
  isScopeMember: IsScopeMember,
): Promise<RedisclosureOrder[]> {
  const orders: RedisclosureOrder[] = [];
  for (const conn of connections) {
    const next = await discloseScopedLogsForPeer(own, conn.peerGithubUserId, isScopeMember);
    const prev = new Set(conn.lastDisclosed);
    const nextSet = new Set(next);
    const added = next.filter((e) => !prev.has(e));
    const removed = [...prev].filter((e) => !nextSet.has(e));
    if (added.length === 0 && removed.length === 0) continue;
    orders.push({ peerGithubUserId: conn.peerGithubUserId, next, added, removed });
  }
  return orders;
}
