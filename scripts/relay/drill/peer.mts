// Live blind-relay drill peer (driven by scripts/relay/drill/run.sh). Builds the sync swarm's relay
// option through the REAL repo module (resolveSyncRelayKeys + syncRelayThroughOption), so each arm
// exercises shipped code, and logs one JSON line per event (relay config, dials, connection, data).
// usage: tsx scripts/relay/drill/peer.mts server|client <topicHex> <durSec>
// env: PAPERCUSP_VOICE_RELAY_KEYS / PAPERCUSP_RELAY_DEFAULTS (PG is unreachable inside the netns).
import Hyperswarm from 'hyperswarm';
import {
  describeSyncRelayFallback,
  resolveSyncRelayKeys,
  syncRelayKeyReader,
  syncRelayThroughOption,
} from '../../../packages/operator-core/lib/sync/hyperbee/sync-relay';

const [, , role, topicHex, durArg] = process.argv;
const t0 = Date.now();
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), role, ...o }));

// Public DHT (no bootstrap, none declared), exactly as the shared sync swarm resolves it: env ∪ PG ∪
// shipped defaults.
const keys = await resolveSyncRelayKeys(syncRelayKeyReader(undefined, false));
log({ ev: 'relay-config', keys: keys.map((k) => k.toString('hex').slice(0, 8)), desc: describeSyncRelayFallback(keys) });
const swarm = new Hyperswarm({ ...syncRelayThroughOption(keys) });

// Observe every dial hyperswarm makes: was it a relayed (forced) retry, and how did it fail?
type DialStream = { on(ev: 'error', fn: (e: { code?: string }) => void): unknown };
type DrillDht = {
  connect: (pk: Buffer, o?: Record<string, unknown>) => DialStream;
  host: string;
  port: number;
  firewalled: boolean;
  ready(): Promise<void>;
};
type DrillConn = {
  rawStream?: { remoteHost: string; remotePort: number };
  udxRelayed?: boolean;
  udxPunchPath?: unknown;
  remotePublicKey?: Buffer;
  on(ev: 'error', fn: (e: { code?: string }) => void): unknown;
  on(ev: 'data', fn: (d: Buffer) => void): unknown;
  write(d: string): unknown;
};
const dht = (swarm as unknown as { dht: DrillDht }).dht;
const origConnect = dht.connect.bind(dht);
let dials = 0;
dht.connect = (pk: Buffer, o?: Record<string, unknown>) => {
  const n = ++dials;
  const s = origConnect(pk, o);
  log({ ev: 'dial', n, relayThrough: o?.relayThrough ? 'set' : 'none' });
  s.on('error', (e) => log({ ev: 'dial-error', n, code: e.code }));
  return s;
};

swarm.on('connection', (socket) => {
  const conn = socket as unknown as DrillConn;
  const raw = conn.rawStream;
  log({
    ev: 'connection',
    relayed: conn.udxRelayed,
    path: conn.udxPunchPath,
    remote: raw ? `${raw.remoteHost}:${raw.remotePort}` : null,
    peer: conn.remotePublicKey?.toString('hex').slice(0, 8),
  });
  conn.on('error', (e) => log({ ev: 'conn-error', code: e.code }));
  conn.on('data', (d) => {
    log({ ev: 'data', d: d.toString() });
    if (role === 'server') conn.write(`pong:${d.toString()}`);
    else void finish(0);
  });
  if (role === 'client') conn.write(`ping-${Date.now()}`);
});

await dht.ready();
log({ ev: 'ready', host: dht.host, port: dht.port, firewalled: dht.firewalled });
const discovery = swarm.join(Buffer.from(topicHex, 'hex'), { server: role === 'server', client: role === 'client' });
if (role === 'server') await discovery.flushed();
log({ ev: 'joined' });

async function finish(code: number) {
  log({ ev: 'end', dials, code });
  await swarm.destroy().catch(() => {});
  process.exit(code);
}
setTimeout(() => void finish(role === 'client' ? 1 : 0), Number(durArg) * 1000);
