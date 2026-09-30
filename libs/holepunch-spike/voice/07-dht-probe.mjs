/**
 * voice/07 — DHT self-probe: what does the public DHT think we are?
 * Prints our reflexive address + firewalled/NAT status after full bootstrap.
 */
import DHT from 'hyperdht';

const dht = new DHT();
await dht.ready();
const t0 = Date.now();
try { await dht.fullyBootstrapped(); } catch {}
const info = {
  bootstrappedMs: Date.now() - t0,
  host: dht.host ?? null,           // reflexive (public) host as seen by the DHT
  port: dht.port ?? null,           // reflexive port
  firewalled: dht.firewalled ?? null,
  localAddresses: (() => { try { return dht.localAddress?.() ?? null; } catch { return null; } })(),
};
console.log(JSON.stringify(info, null, 2));
await dht.destroy();
process.exit(0);
