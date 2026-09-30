/**
 * smoke:swarm — two Hyperswarm peers find each other on a shared topic
 * via the public DHT and exchange a single message.
 *
 * Pass = both peers connect within 30s and echo a payload.
 * Fail = no connection inside the timeout (DHT bootstrap unreachable,
 *        UDP firewall, or the swarm doesn't converge).
 *
 * This is the closest thing to a real network test we can run in a
 * single process: each peer runs its own Hyperswarm instance, opens
 * its own UDP socket, and goes through the public DHT to find the
 * other. Same code path the production app would use.
 */

import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import crypto from 'node:crypto';

const TIMEOUT_MS = 30_000;
const topic = crypto.randomBytes(32); // shared 32-byte topic

let alicePassed = false;
let bobPassed = false;
const startedAt = Date.now();

function done() {
  const ms = Date.now() - startedAt;
  if (alicePassed && bobPassed) {
    console.log(`\nBoth peers exchanged payload in ${ms}ms. smoke:swarm PASSED.`);
    process.exit(0);
  } else {
    console.error(
      `\nFAIL after ${ms}ms — alice=${alicePassed} bob=${bobPassed}`,
    );
    process.exit(1);
  }
}

const timer = setTimeout(() => {
  console.error(`\nTIMEOUT after ${TIMEOUT_MS}ms`);
  done();
}, TIMEOUT_MS);

async function peer(label) {
  const swarm = new Hyperswarm();
  swarm.on('connection', (conn, info) => {
    const remoteHex = b4a.toString(info.publicKey, 'hex').slice(0, 8);
    console.log(`[${label}] connected to peer ${remoteHex}`);
    conn.write(b4a.from(`hello from ${label}`));
    conn.on('data', (data) => {
      const text = b4a.toString(data);
      console.log(`[${label}] received: ${text}`);
      if (text.startsWith('hello from ')) {
        if (label === 'alice') alicePassed = true;
        else bobPassed = true;
        if (alicePassed && bobPassed) {
          clearTimeout(timer);
          // graceful close
          Promise.resolve()
            .then(() => swarm.destroy())
            .then(done);
        }
      }
    });
    conn.on('error', () => {}); // swallow noisy peer-side closes
  });
  const discovery = swarm.join(topic, { server: true, client: true });
  await discovery.flushed();
  console.log(`[${label}] joined topic ${b4a.toString(topic, 'hex').slice(0, 12)}…`);
  return swarm;
}

console.log(`smoke:swarm — two peers, shared topic, ${TIMEOUT_MS}ms budget\n`);
await peer('alice');
await peer('bob');
console.log('(both joined; waiting for DHT-mediated discovery + connection)');
