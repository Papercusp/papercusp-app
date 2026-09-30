#!/usr/bin/env node
/**
 * sni-relay-proxy — an HTTP CONNECT proxy that tunnels every CONNECT through a
 * local SOCKS5 port (an `ssh -N -D` to a machine off this box's network).
 *
 * Why: this dev box's network drops TLS handshakes whose SNI names a
 * papercusp-family host (EI-16742), so a release publish to
 * cupboard.papercusp.com stalls. Node's built-in fetch honours
 * NODE_USE_ENV_PROXY=1 + HTTPS_PROXY, but only for an HTTP CONNECT proxy — this
 * bridges that to the SOCKS tunnel. Runbook:
 * agent-insights/su-box-sni-tls-blackhole-not-outage.
 *
 *   node scripts/sni-relay-proxy.mjs <listenPort> <socksPort>
 */
import http from 'node:http';
import net from 'node:net';

const listenPort = Number(process.argv[2] ?? 47180);
const socksPort = Number(process.argv[3] ?? 47181);

// Minimal SOCKS5 CONNECT (RFC 1928, no-auth, domain-name target) — enough for
// `ssh -D`, and keeps this script free of a transitive-only dependency.
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, '127.0.0.1');
    let buffered = Buffer.alloc(0);
    let stage = 'greeting';
    const fail = (message) => { socket.destroy(); reject(new Error(message)); };
    socket.setTimeout(20_000, () => fail('socks timeout'));
    socket.on('error', (error) => reject(error));
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === 'greeting') {
        if (buffered.length < 2) return;
        if (buffered[0] !== 0x05 || buffered[1] !== 0x00) return fail('socks auth refused');
        buffered = buffered.subarray(2);
        stage = 'connect';
        const name = Buffer.from(host);
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([port >> 8, port & 0xff]),
        ]));
      }
      if (stage === 'connect') {
        if (buffered.length < 5) return;
        if (buffered[1] !== 0x00) return fail(`socks connect refused (rep ${buffered[1]})`);
        const addressLength = { 0x01: 4, 0x03: 1 + buffered[4], 0x04: 16 }[buffered[3]];
        if (addressLength === undefined) return fail('socks bad address type');
        const replyLength = 4 + addressLength + 2;
        if (buffered.length < replyLength) return;
        socket.off('data', onData);
        socket.setTimeout(0);
        const rest = buffered.subarray(replyLength);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      }
    };
    socket.on('data', onData);
  });
}

const server = http.createServer((req, res) => {
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('CONNECT only\n');
});

server.on('connect', async (req, clientSocket, head) => {
  const [host, portText] = req.url.split(':');
  const port = Number(portText || 443);
  try {
    const socket = await socksConnect(host, port);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.write(head);
    socket.pipe(clientSocket);
    clientSocket.pipe(socket);
    const close = () => { socket.destroy(); clientSocket.destroy(); };
    socket.on('error', close);
    clientSocket.on('error', close);
    console.log(`${new Date().toISOString()} CONNECT ${host}:${port} ok`);
  } catch (error) {
    console.log(`${new Date().toISOString()} CONNECT ${host}:${port} FAILED ${error.message}`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  }
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`sni-relay-proxy listening 127.0.0.1:${listenPort} -> socks5 127.0.0.1:${socksPort}`);
});
