/**
 * Papercusp isolated DHT testnet — bridge-bound bootstrap service.
 *
 * Replaces the previous inline `createTestnet(3, { host, port })` ExecStart,
 * which did NOT deliver the isolation its own unit description claimed:
 * hyperdht's testnet.js coerces the bind address to `0.0.0.0` for any
 * non-loopback host, so the "isolated" nodes were reachable from — and could
 * reach — the public internet. Their routing tables filled with public
 * hyperdht nodes and every client bootstrapping here was silently handed the
 * PUBLIC DHT (EI-20584279536840151; measured 62/62 public).
 *
 * THE FIX IS THE BIND, not a filter. dht-rpc binds both of its sockets — the
 * server socket and the client socket it makes outbound queries from — to
 * `host` (dht-rpc/lib/io.js:244, :265). Bound to the bridge address, a packet
 * sent toward a public peer carries an RFC1918 source, so the reply can never
 * return and the node cannot learn a public peer in the first place. A
 * `filterNode` option cannot be used for this: hyperdht passes its own
 * `filterNode` AFTER `...opts` (hyperdht/index.js:31), discarding the
 * caller's.
 *
 * Three nodes, not one, is deliberate and pre-existing (WI-1910/16e4c):
 * dht-rpc never commits announces to bootstrap-ONLY nodes, so a single-node
 * testnet can drop announces under quorum edge cases ("Too few nodes
 * responded").
 */
import DHT from 'hyperdht';
import { auditRoutingTable } from './lib/dht-isolation.mjs';

const host = process.env.PAPERCUSP_DHT_HOST || '172.31.44.1';
const port = Number(process.env.PAPERCUSP_DHT_PORT || 49838);
const size = Number(process.env.PAPERCUSP_DHT_SIZE || 3);
const auditMs = Number(process.env.PAPERCUSP_DHT_AUDIT_MS || 60_000);

const nodes = [];

const first = new DHT({ ephemeral: false, firewalled: false, bootstrap: [], port, host });
await first.fullyBootstrapped();
nodes.push(first);

const bootstrap = [{ host, port: first.address().port }];

while (nodes.length < size) {
  const node = new DHT({ ephemeral: false, firewalled: false, bootstrap, host });
  await node.fullyBootstrapped();
  nodes.push(node);
}

// Same stdout contract as the old inline ExecStart — other tooling greps it.
console.log('BOOTSTRAP=' + bootstrap.map((b) => `${b.host}:${b.port}`).join(','));
console.log(`[isolated-dht] ${nodes.length} node(s) bound to ${host} (bridge-only, not 0.0.0.0)`);

/**
 * Standing isolation audit. The original breach was invisible for days because
 * nothing ever measured it — the service stayed `active`, and the liveness
 * probe it shipped with connects two swarms inside ONE process, which passes
 * on a public DHT just as happily as on a private one. So the service now
 * reports on itself: any node outside the bridge subnet is a breach, and one
 * is enough to hand a client the public network.
 */
setInterval(() => {
  const rows = [];
  for (const node of nodes) {
    try {
      rows.push(...node.table.toArray());
    } catch {
      /* a node mid-teardown must never take the audit down */
    }
  }
  const audit = auditRoutingTable(rows);
  if (!audit.isolated) {
    console.error(
      `[isolated-dht] ⚠ ISOLATION BREACH: ${audit.foreign}/${audit.total} routing-table node(s) ` +
        `outside the bridge subnet — sample ${audit.foreignSample.join(', ')}. Clients bootstrapping ` +
        `at ${host}:${port} are being handed a PUBLIC DHT, so same-box rigs will hairpin and never ` +
        `pair (EI-20584279536840151).`,
    );
  }
}, auditMs);
