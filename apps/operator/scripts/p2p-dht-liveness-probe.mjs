#!/usr/bin/env node
/**
 * p2p-dht-liveness-probe.mjs — a REAL two-process (optionally two-HOST)
 * hyperswarm announce/lookup probe against the isolated DHT testnet's bootstrap
 * node (EI-8892), hardened for P-302 (EI-20584279536840151).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY (the original class — still covered)
 *
 * `papercup-isolated-dht.service` can wedge (unit stays `active`, bootstrap node
 * stops actually servicing DHT traffic) with ZERO signal — a plain "is the unit
 * active" check cannot see this, and hyperswarm rides UDX/UDP so `ss`/`netstat`
 * show nothing useful either (2026-07-06→07-09: wedged for 3 days,
 * cross-machine federation dead the whole time, caught only by a hand-rolled
 * probe). Design + gotchas from su-4dc3befd's live incident response
 * (msg mre8bpam, 2026-07-09), all still enforced below:
 *
 *   - a WEDGED bootstrap still ACCEPTS joins and flush() still completes — the
 *     ONLY reliable health signal is "did the other peer actually receive a
 *     'connection' event within the timeout". Nothing weaker works.
 *   - hyperswarm is UDX/UDP — do not attempt any socket-level (`ss`/`netstat`)
 *     liveness check; it will show nothing either way.
 *   - always destroy() the swarm in a `finally`, with a hard `process.exit`
 *     backstop — a wedged DHT can hang teardown too.
 *   - WI-4077: `discovery.flushed()` / `swarm.flush()` carry NO timeout of their
 *     own and can hang well past the connect budget. Race the WHOLE sequence
 *     (announce + flush + connect), not just the connection-wait, so the probe
 *     always self-reports inside its stated budget whichever stage hangs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE REWRITE (P-302)
 *
 * The previous version built swarmA AND swarmB in ONE process on ONE host. That
 * answers "is the bootstrap routing" and NOTHING else:
 *
 *   - it passes on ANY DHT topology, public or isolated — so it read green at
 *     07:34:30Z while the isolated-bootstrap pin had silently stopped applying;
 *   - it never emits a packet across a machine boundary — so it would have read
 *     green throughout the entire multi-day outage in which the Mac side of the
 *     rig could not send a datagram to anyone (macOS Local Network privacy was
 *     dropping every one, while still allowing inbound).
 *
 * Two structural changes fix that, and both matter:
 *
 *   1. THE PEERS ARE SEPARATE PROCESSES, addressed BY PUBLIC KEY. The client
 *      must connect to the exact key the server announced. "A connection event
 *      fired" — the old assertion — is trivially satisfied by two swarms in one
 *      process; connecting to a specific remote key is not.
 *   2. THE CLIENT LEG CAN RUN ON ANOTHER HOST (over ssh, using that host's own
 *      node). The client is the dialling side on purpose: its own dht-rpc
 *      counters are what expose a transmit-blocked host, so the leg that runs
 *      on the suspect machine is the leg that reports the diagnosis.
 *
 * All judgement lives in `p2p-dht-liveness-verdict.mjs` (pure + unit-tested,
 * with a permanent wrong-implementation control). This file only OBSERVES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *   # local-only (two processes on this host) — the EI-8892 wedge detector
 *   node p2p-dht-liveness-probe.mjs --host <ip> --port <port>
 *
 *   # cross-host — the client leg runs on another machine over ssh
 *   node p2p-dht-liveness-probe.mjs --host <ip> --port <port> \
 *     --remote-host user@172.31.44.2 \
 *     --remote-node '/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/node' \
 *     --remote-cwd /path/on/remote/with/node_modules
 *
 *   --require-cross-host   refuse to report health without a cross-host proof
 *   --timeout-ms <n>       per-stage budget (default 15000)
 *   --json                 emit the machine-readable verdict on stdout
 *
 * EXIT CODES — note there are FOUR, not three:
 *   0 healthy   1 FAIL (wedged/unreachable/degenerate)
 *   2 bad usage 3 INCONCLUSIVE (could not run the experiment)
 * 3 is deliberately NOT 1: "I could not tell" must never be filed as "the DHT
 * is wedged", and must never be read as a pass either.
 *
 * Bootstrap host/port should be read from the LIVE unit, never hardcoded here —
 * see the `--host`/`--port` args and the wrapper script that resolves them via
 * `systemctl --user show papercup-isolated-dht.service`.
 */
import Hyperswarm from 'hyperswarm';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { EXIT, judgeLivenessProbe } from './p2p-dht-liveness-verdict.mjs';

/** Peer legs emit exactly one of these lines; everything else is free-form log. */
const SENTINEL = '[p2p-dht-probe-json]';

const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_DIR = path.dirname(SELF_PATH);
const VERDICT_PATH = path.join(SELF_DIR, 'p2p-dht-liveness-verdict.mjs');

function log(msg) {
  process.stderr.write(`[p2p-dht-probe] ${msg}\n`);
}

function emit(payload) {
  process.stdout.write(`${SENTINEL} ${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const out = {
    role: 'orchestrate',
    host: null,
    port: null,
    timeoutMs: 15_000,
    topic: null,
    expectKey: null,
    remoteHost: null,
    remoteNode: 'node',
    remoteCwd: null,
    sshOpt: [],
    requireCrossHost: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') out.role = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--topic') out.topic = argv[++i];
    else if (a === '--expect-key') out.expectKey = argv[++i];
    else if (a === '--remote-host') out.remoteHost = argv[++i];
    else if (a === '--remote-node') out.remoteNode = argv[++i];
    else if (a === '--remote-cwd') out.remoteCwd = argv[++i];
    else if (a === '--ssh-opt') out.sshOpt.push(argv[++i]);
    else if (a === '--require-cross-host') out.requireCrossHost = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

async function withHardExit(promise, hardExitMs, exitCode) {
  // A wedged DHT can hang teardown (destroy()) too — never let cleanup itself
  // hang the probe forever. This backstop fires ONLY if the promise doesn't
  // settle in time; it does not affect a normal, fast destroy().
  const timer = setTimeout(() => {
    log(`teardown did not complete within ${hardExitMs}ms — hard exit`);
    process.exit(exitCode);
  }, hardExitMs);
  timer.unref?.();
  try {
    await promise;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the live dht-rpc counters off a swarm. Mirrors
 * `sampleDhtReachability` in packages/operator-core/lib/sync/hyperbee/swarm.ts.
 *
 * ABSTAINS (null) rather than reporting zeroes when the shape is
 * unrecognisable: a hyperdht version bump moving these internals must not
 * manufacture a false `tx-blocked` diagnosis on every run.
 */
function sampleCounters(swarm) {
  try {
    const dht = swarm?.dht;
    const stats = dht?.io?.stats?.requests;
    const table = dht?.table;
    if (!stats || typeof stats.total !== 'number' || !table || typeof table.size !== 'number') {
      return null;
    }
    return {
      routingTableSize: table.size,
      requestsTotal: stats.total,
      responses: typeof stats.responses === 'number' ? stats.responses : 0,
      timeouts: typeof stats.timeouts === 'number' ? stats.timeouts : 0,
    };
  } catch {
    return null;
  }
}

// ───────────────────────────── peer legs ──────────────────────────────────────

/**
 * SERVER leg: announce on the topic and stay up, reporting every peer that
 * connects. Emits its public key as soon as the announce has flushed so the
 * orchestrator knows when it is safe to start the client (the hyperswarm README
 * ordering — the server must be fully announced BEFORE the client joins).
 */
async function runServer({ host, port, topic, timeoutMs }) {
  const swarm = new Hyperswarm({ bootstrap: [{ host, port }] });
  const publicKey = Buffer.from(swarm.keyPair.publicKey).toString('hex');
  const peers = new Set();

  // Every connection socket MUST get its own 'error' listener — an unhandled
  // 'error' event on a Node stream crashes the whole process. A reset AFTER a
  // 'connection' event still counts: the DHT did its job (found + connected the
  // peer); a reset is a transport hiccup on an already-healthy path.
  swarm.on('connection', (conn) => {
    conn.on('error', () => {});
    peers.add(Buffer.from(conn.remotePublicKey).toString('hex'));
  });

  let exitCode = EXIT.HEALTHY;
  try {
    const disc = swarm.join(Buffer.from(topic, 'hex'), { server: true, client: false });
    // WI-4077 again, on the announcing side: `discovery.flushed()` has NO
    // timeout of its own. Against a bootstrap wedged badly enough not to ack the
    // announce it hangs indefinitely, and a server that hangs here NEVER REPORTS
    // — which downgrades a real, actionable wedge into "the probe told us
    // nothing". Race it so the failure is always reported, WITH the counters
    // that say whether the fault is the bootstrap or this host's own TX path.
    const flushed = disc.flushed().then(
      () => 'announced',
      (err) => {
        log(`announce rejected: ${err instanceof Error ? err.message : String(err)}`);
        return 'announce-failed';
      },
    );
    const announceTimeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve('announce-failed'), timeoutMs);
      t.unref?.();
    });
    if ((await Promise.race([flushed, announceTimeout])) !== 'announced') {
      emit({
        role: 'server',
        event: 'announce-failed',
        publicKey,
        hostname: hostname(),
        counters: sampleCounters(swarm),
      });
      await withHardExit(swarm.destroy(), 5_000, EXIT.FAIL);
      process.exit(EXIT.FAIL);
    }
    emit({ role: 'server', event: 'announced', publicKey, hostname: hostname() });

    // Stay up for the orchestrator's whole budget; it kills us when the client
    // is done. The +5s margin keeps the server alive across the client's own
    // full timeout rather than dying underneath it.
    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs + 5_000);
      t.unref?.();
      process.on('SIGTERM', resolve);
      process.on('SIGINT', resolve);
    });
  } catch (err) {
    log(`server leg error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    exitCode = EXIT.FAIL;
  } finally {
    emit({
      role: 'server',
      event: 'final',
      publicKey,
      hostname: hostname(),
      connectedPeerKeys: [...peers],
      counters: sampleCounters(swarm),
    });
    await withHardExit(swarm.destroy(), 5_000, exitCode);
  }
  process.exit(exitCode);
}

/**
 * CLIENT leg: look the topic up and dial. This is the leg that runs on the
 * SUSPECT host, because its own counters are the transmit-blocked diagnosis.
 *
 * It reports OBSERVATIONS ONLY — it never decides whether the run passed. That
 * separation is deliberate: a remote leg that could judge itself is a remote
 * leg that can report success for the wrong reason.
 */
async function runClient({ host, port, topic, timeoutMs, expectKey }) {
  const swarm = new Hyperswarm({ bootstrap: [{ host, port }] });
  const localKey = Buffer.from(swarm.keyPair.publicKey).toString('hex');
  const peers = new Set();
  let inboundAnswered = false;

  const sawExpected = new Promise((resolve) => {
    swarm.on('connection', (conn) => {
      conn.on('error', () => {});
      const key = Buffer.from(conn.remotePublicKey).toString('hex');
      peers.add(key);
      inboundAnswered = true;
      if (!expectKey || key === expectKey) resolve(true);
    });
  });

  // WI-4077: bound the WHOLE sequence, not just the connection-wait. Against a
  // bootstrap wedged badly enough not to ack the initial lookup, flush() can
  // hang far past the connect budget and the wrapper's outer `timeout` kills
  // the process before it ever reaches its own report branch — which is how an
  // escalation once got filed with a completely empty diagnostic body.
  const stageTimeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve('stage-timeout'), timeoutMs);
    t.unref?.();
  });

  let stage = 'joining';
  try {
    const attempt = (async () => {
      swarm.join(Buffer.from(topic, 'hex'), { server: false, client: true });
      stage = 'flushing';
      await swarm.flush();
      stage = 'awaiting-connection';
      return sawExpected;
    })();
    const outcome = await Promise.race([attempt, stageTimeout]);
    if (outcome === 'stage-timeout') {
      log(`timed out in stage '${stage}' after ${timeoutMs}ms`);
    }
  } catch (err) {
    log(`client leg error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    emit({
      role: 'client',
      event: 'final',
      publicKey: localKey,
      hostname: hostname(),
      connectedPeerKeys: [...peers],
      counters: sampleCounters(swarm),
      inboundAnswered,
      stage,
    });
    await withHardExit(swarm.destroy(), 5_000, EXIT.HEALTHY);
  }
  // The client always exits 0 after REPORTING — the orchestrator judges.
  // A non-zero here would be indistinguishable from ssh/transport failure,
  // and "the remote leg could not run" must stay distinguishable from
  // "the remote leg ran and found nothing".
  process.exit(EXIT.HEALTHY);
}

// ──────────────────────────── orchestration ───────────────────────────────────

function collectSentinels(buffer, onPayload) {
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf('\n');
    if (nl === -1) break;
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    const at = line.indexOf(SENTINEL);
    if (at !== -1) {
      try {
        onPayload(JSON.parse(line.slice(at + SENTINEL.length)));
      } catch {
        /* a partial/garbled line is not a result — ignore it */
      }
    }
  }
  return rest;
}

/** Spawn a peer leg and stream its sentinel payloads back. */
function spawnLeg(cmd, args, { onPayload, label, spawnOpts = {} }) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
  let out = '';
  let errTail = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out = collectSentinels(out + chunk, onPayload);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errTail = (errTail + chunk).slice(-4000);
  });
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: null, spawnError: err.message, errTail }));
    child.on('close', (code) => resolve({ code, spawnError: null, errTail }));
  });
  return { child, done, label };
}

/**
 * Stage the probe onto the remote host and run the client leg there.
 *
 * The two module files are COPIED EVERY RUN rather than assumed present. That
 * is not defensiveness — it is what makes a cross-host result trustworthy: both
 * legs provably execute the same code, so a green can never come from a stale
 * copy on the far side. They land INSIDE `--remote-cwd` because Node resolves
 * bare specifiers (`hyperswarm`) by walking up from the SCRIPT's directory —
 * staging to /tmp would look for /tmp/node_modules and fail.
 */
async function runRemoteClient(cfg, { topic, expectKey, onPayload }) {
  const { remoteHost, remoteNode, remoteCwd, timeoutMs, sshOpt, host, port } = cfg;
  const sshBase = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...sshOpt.flatMap((o) => ['-o', o])];
  const stageDir = `${remoteCwd}/.p2p-dht-probe`;

  const sh = (script) =>
    new Promise((resolve) => {
      const c = spawn('ssh', [...sshBase, remoteHost, script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let so = '';
      let se = '';
      c.stdout.on('data', (d) => (so += d));
      c.stderr.on('data', (d) => (se += d));
      c.on('error', (err) => resolve({ code: null, so, se: se + err.message }));
      c.on('close', (code) => resolve({ code, so, se }));
      return c;
    });

  const put = (localPath, remotePath) =>
    new Promise((resolve) => {
      const c = spawn('ssh', [...sshBase, remoteHost, `cat > '${remotePath}'`], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let se = '';
      c.stderr.on('data', (d) => (se += d));
      c.on('error', (err) => resolve({ code: null, se: se + err.message }));
      c.on('close', (code) => resolve({ code, se }));
      try {
        c.stdin.end(readFileSync(localPath));
      } catch (err) {
        resolve({ code: null, se: `could not read ${localPath}: ${err.message}` });
      }
    });

  const mk = await sh(`mkdir -p '${stageDir}' && echo STAGED`);
  if (mk.code !== 0 || !mk.so.includes('STAGED')) {
    return { launched: false, error: `could not stage on ${remoteHost}: ${(mk.se || mk.so || 'ssh failed').trim().slice(0, 300)}` };
  }
  for (const [local, name] of [
    [SELF_PATH, 'p2p-dht-liveness-probe.mjs'],
    [VERDICT_PATH, 'p2p-dht-liveness-verdict.mjs'],
  ]) {
    const r = await put(local, `${stageDir}/${name}`);
    if (r.code !== 0) {
      return { launched: false, error: `could not copy ${name} to ${remoteHost}: ${(r.se || 'scp-over-ssh failed').trim().slice(0, 300)}` };
    }
  }

  const remoteCmd =
    `cd '${remoteCwd}' && '${remoteNode}' '${stageDir}/p2p-dht-liveness-probe.mjs' ` +
    `--role client --host '${host}' --port ${port} --topic ${topic} ` +
    `--expect-key ${expectKey} --timeout-ms ${timeoutMs}`;

  const leg = spawnLeg('ssh', [...sshBase, remoteHost, remoteCmd], { onPayload, label: 'remote-client' });
  const res = await leg.done;
  if (res.spawnError) return { launched: false, error: `ssh could not start: ${res.spawnError}` };
  // A non-zero ssh exit with NO payload means the leg never ran (bad node path,
  // missing hyperswarm, refused connection) — that is INCONCLUSIVE, not a DHT
  // failure. If a payload did arrive, the leg ran and its observation stands.
  return { launched: true, exit: res.code, errTail: res.errTail };
}

async function orchestrate(cfg) {
  const { host, port, timeoutMs, remoteHost, requireCrossHost } = cfg;
  const wantCrossHost = Boolean(remoteHost) || requireCrossHost;

  if (requireCrossHost && !remoteHost) {
    const v = judgeLivenessProbe({ scope: 'cross-host', remoteConfigured: false });
    report(cfg, v);
    process.exit(v.exitCode);
  }

  // RANDOM topic per run (never the prod harness topic) — this probe must never
  // be discoverable by / interfere with real hive traffic on the testnet.
  const topic = randomBytes(32).toString('hex');

  let serverKey = null;
  let serverHostname = null;
  let serverCounters = null;
  let clientObs = null;

  // The orchestrator waits LONGER than the server's own announce budget on
  // purpose: the server races its own flush at `timeoutMs` and then reports
  // `announce-failed` WITH counters. If this timer fired first we would discard
  // that report and lose the discriminator between "bootstrap wedged" and "this
  // host's TX is blocked" — the exact distinction the run is worth making.
  const announced = new Promise((resolve) => {
    const t = setTimeout(() => resolve('orchestrator-timeout'), timeoutMs + 5_000);
    t.unref?.();
    onServerPayload.resolve = resolve;
  });
  function onServerPayload(p) {
    if (p?.role !== 'server') return;
    if (p.publicKey) serverKey = p.publicKey;
    if (p.hostname) serverHostname = p.hostname;
    if (p.counters) serverCounters = p.counters;
    if (p.event === 'announced') onServerPayload.resolve?.('announced');
    if (p.event === 'announce-failed') onServerPayload.resolve?.('announce-failed');
  }

  const server = spawnLeg(
    process.execPath,
    [SELF_PATH, '--role', 'server', '--host', host, '--port', String(port), '--topic', topic, '--timeout-ms', String(timeoutMs)],
    { onPayload: onServerPayload, label: 'server' },
  );

  try {
    // Race the announce against the server process DYING: a leg that crashed on
    // startup (missing native module, bad runtime) is a harness fault, while a
    // leg that ran and could not announce is a real finding about the DHT path.
    // Collapsing those two into one "no key" branch is what produced a wedged
    // bootstrap being reported as INCONCLUSIVE.
    const outcome = await Promise.race([
      announced,
      server.done.then((r) => ({ died: r })),
    ]);

    if (typeof outcome === 'object' && outcome?.died) {
      const r = outcome.died;
      const v = judgeLivenessProbe({
        scope: wantCrossHost ? 'cross-host' : 'local-only',
        remoteConfigured: Boolean(remoteHost),
        serverLegLaunched: false,
        serverLegError: r.spawnError
          ? `server leg could not start: ${r.spawnError}`
          : `server leg exited ${r.code} before announcing: ${(r.errTail || '').trim().slice(-300) || 'no stderr'}`,
      });
      report(cfg, v, { serverKey });
      process.exit(v.exitCode);
    }

    if (outcome !== 'announced' || !serverKey) {
      const v = judgeLivenessProbe({
        scope: wantCrossHost ? 'cross-host' : 'local-only',
        remoteConfigured: Boolean(remoteHost),
        serverLegLaunched: true,
        serverAnnounced: false,
        serverCounters,
      });
      report(cfg, v, { serverKey, serverHostname, counters: serverCounters });
      process.exit(v.exitCode);
    }

    const onClientPayload = (p) => {
      if (p?.role === 'client' && p.event === 'final') clientObs = p;
    };

    let launched = true;
    let launchError = null;
    if (remoteHost) {
      const r = await runRemoteClient(cfg, { topic, expectKey: serverKey, onPayload: onClientPayload });
      if (!r.launched) {
        launched = false;
        launchError = r.error;
      } else if (!clientObs) {
        launched = false;
        launchError = `remote client exited ${r.exit} without reporting: ${(r.errTail || '').trim().slice(-300) || 'no stderr'}`;
      }
    } else {
      const client = spawnLeg(
        process.execPath,
        [SELF_PATH, '--role', 'client', '--host', host, '--port', String(port), '--topic', topic,
         '--expect-key', serverKey, '--timeout-ms', String(timeoutMs)],
        { onPayload: onClientPayload, label: 'client' },
      );
      const r = await client.done;
      if (!clientObs) {
        launched = false;
        launchError = r.spawnError
          ? `local client could not start: ${r.spawnError}`
          : `local client exited ${r.code} without reporting: ${(r.errTail || '').trim().slice(-300) || 'no stderr'}`;
      }
    }

    // Same-host detection is MEASURED (both legs report their own hostname),
    // never inferred from "--remote-host was set" — `--remote-host localhost`
    // must not be able to buy a cross-host verdict.
    const serverHostIsRemote = Boolean(
      serverHostname && clientObs?.hostname && serverHostname !== clientObs.hostname,
    );

    const verdict = judgeLivenessProbe({
      scope: wantCrossHost ? 'cross-host' : 'local-only',
      remoteConfigured: Boolean(remoteHost),
      remoteLegLaunched: launched,
      remoteLegError: launchError,
      serverLegLaunched: true,
      // Reaching here means the server's announce FLUSHED, which is a positive
      // observation that the bootstrap answers. That second vantage point is
      // what lets a silent client be attributed to the client rather than
      // guessed at — see `diagnoseSilence`.
      serverAnnounced: true,
      bootstrapProvenReachable: true,
      expectedRemoteKey: serverKey,
      connectedPeerKeys: clientObs?.connectedPeerKeys ?? [],
      clientLocalKey: clientObs?.publicKey ?? null,
      serverHostIsRemote,
      clientCounters: clientObs?.counters ?? null,
      inboundAnswered: Boolean(clientObs?.inboundAnswered),
    });

    report(cfg, verdict, {
      serverKey,
      serverHostname,
      clientHostname: clientObs?.hostname ?? null,
      counters: clientObs?.counters ?? null,
    });
    process.exit(verdict.exitCode);
  } finally {
    server.child.kill('SIGTERM');
  }
}

function report(cfg, verdict, extra = {}) {
  const scope = cfg.remoteHost || cfg.requireCrossHost ? 'cross-host' : 'local-only';
  if (cfg.json) {
    process.stdout.write(`${JSON.stringify({ ...verdict, scope, bootstrap: `${cfg.host}:${cfg.port}`, ...extra })}\n`);
  }
  const tag = verdict.level === 'ok' ? 'OK' : verdict.level === 'fail' ? 'FAIL' : 'INCONCLUSIVE';
  process.stdout.write(
    `[p2p-dht-probe] ${tag} [${verdict.code}] bootstrap ${cfg.host}:${cfg.port} — ${verdict.message}\n` +
      `[p2p-dht-probe] proved: ${verdict.proved}\n`,
  );
  if (extra.note) process.stdout.write(`[p2p-dht-probe] note: ${extra.note}\n`);
  if (extra.counters) {
    const c = extra.counters;
    process.stdout.write(
      `[p2p-dht-probe] client dht counters: table=${c.routingTableSize} requests=${c.requestsTotal} responses=${c.responses} timeouts=${c.timeouts}\n`,
    );
  }
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg.host || !Number.isFinite(cfg.port) || cfg.port <= 0) {
    process.stderr.write(
      'usage: p2p-dht-liveness-probe.mjs --host <ip> --port <port> [--timeout-ms 15000]\n' +
        '       [--remote-host user@host --remote-node <path> --remote-cwd <dir>] [--require-cross-host] [--json]\n',
    );
    process.exit(EXIT.USAGE);
  }
  if (cfg.remoteHost && !cfg.remoteCwd) {
    process.stderr.write('--remote-host requires --remote-cwd (a directory on the remote host from which `hyperswarm` resolves)\n');
    process.exit(EXIT.USAGE);
  }

  if (cfg.role === 'server') {
    if (!cfg.topic) process.exit(EXIT.USAGE);
    return runServer(cfg);
  }
  if (cfg.role === 'client') {
    if (!cfg.topic) process.exit(EXIT.USAGE);
    return runClient(cfg);
  }
  return orchestrate(cfg);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  // A crash in the harness is INCONCLUSIVE, not a DHT verdict — filing it as a
  // wedge sends the next responder hunting a fault that never existed (WI-5804).
  process.exit(EXIT.INCONCLUSIVE);
});
