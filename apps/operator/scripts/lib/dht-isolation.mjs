/**
 * Shared DHT isolation predicate — "is this routing table actually private?"
 *
 * WHY THIS EXISTS (EI-20584279536840151, 2026-08-16). `papercup-isolated-dht`
 * ran `createTestnet(3, { host: '172.31.44.1', port: 49838 })`, and its unit
 * description reads "3-node testnet on the bridge interface". It was not:
 * hyperdht's testnet.js coerces the BIND address for any non-loopback host —
 *
 *     const bindHost = host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0'
 *
 * so the nodes bound 0.0.0.0, reached the public internet, and their routing
 * tables filled with public hyperdht nodes. Every client that bootstrapped
 * there was handed the PUBLIC DHT while believing it sat on a private testnet.
 * Measured on the live rig: routing table = 62 nodes, 62 public / 0 private,
 * and a topic lookup answered `via 138.68.147.8` — literally
 * hyperdht BOOTSTRAP_NODES[2] (hyperdht/lib/constants.js).
 *
 * A CLIENT CANNOT DEFEND ITSELF against this, which is why the check lives
 * here rather than in a dial path: hyperdht's constructor passes its OWN
 * `filterNode` AFTER `...opts` (hyperdht/index.js:31), so a caller-supplied
 * filter is silently discarded. Isolation has to be enforced at the socket
 * BIND (dht-rpc binds both its server and client sockets to `host`,
 * lib/io.js:244/265) and then VERIFIED by measuring the routing table. This
 * module is the measuring half, shared by the bootstrap service and the
 * liveness probe so the two can never disagree about what "isolated" means.
 *
 * The failure this guards against is silent: nothing throws, discovery still
 * resolves, and every same-box rig degrades to a public-DHT hairpin where two
 * peers behind one egress IP never complete a holepunch.
 */

/** Bridge subnet + loopback: the only addresses a private rig DHT may know. */
export const DEFAULT_ALLOWED_CIDRS = ['172.31.44.0/24', '127.0.0.0/8'];

/** Parse dotted-quad IPv4 to a uint32, or null when it is not an IPv4 literal. */
export function ipv4ToInt(host) {
  const parts = String(host ?? '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** True when `host` falls inside `cidr` (IPv4 only; a non-IPv4 host is never inside). */
export function inCidr(host, cidr) {
  const [base, bitsRaw] = String(cidr ?? '').split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const hostInt = ipv4ToInt(host);
  const baseInt = ipv4ToInt(base);
  if (hostInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  // Shift counts are taken mod 32 in JS, so bits===0 must be handled above.
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((hostInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** True when this node's address is one the isolated rig is allowed to know. */
export function isAllowedNode(host, allowedCidrs = DEFAULT_ALLOWED_CIDRS) {
  return allowedCidrs.some((cidr) => inCidr(host, cidr));
}

/**
 * Audit a hyperdht/dht-rpc routing table (`node.table.toArray()`).
 *
 * Returns `isolated:false` the moment ANY node sits outside the allowed CIDRs —
 * one public node is enough to hand a client the public network, so this is
 * deliberately not a ratio or a threshold.
 *
 * An EMPTY table is reported `isolated: true` but `empty: true`. Callers that
 * are asserting health must check `empty` too: a table of zero nodes is a dead
 * DHT, and "no public nodes" is trivially true of it. Keeping those two
 * verdicts separate is what stops a dead bootstrap from reading as a clean one.
 */
export function auditRoutingTable(nodes, allowedCidrs = DEFAULT_ALLOWED_CIDRS) {
  const rows = Array.isArray(nodes) ? nodes : [];
  const foreign = rows.filter((node) => !isAllowedNode(node?.host, allowedCidrs));
  return {
    total: rows.length,
    foreign: foreign.length,
    isolated: foreign.length === 0,
    empty: rows.length === 0,
    foreignSample: foreign.slice(0, 5).map((node) => `${node?.host}:${node?.port}`),
  };
}
