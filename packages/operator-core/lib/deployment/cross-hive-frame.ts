/**
 * cross-hive-frame.ts — the per-frame program for the LIVE cross-machine cross-Hive
 * E2E (cross-hive-boundary-2026-06-08 P-005). Run on each Hetzner frame via
 * `node --import tsx`, configured by the `XPOT_FRAME` env (JSON). It stands up a
 * real Hyperswarm on the PUBLIC DHT, wires a cross-Hive boundary for THIS frame's
 * Hive identity, and plays one of two roles:
 *
 *   role 'B' (receiver/grantor): grants the peer Hive 'ask' (in-memory loadGrants),
 *     subscribes, and on an ADMITTED ask prints `XHIVE_ADMITTED <json>` then replies
 *     (answer) to the peer. An ungranted kind is silently rejected by receiveCrossHive.
 *   role 'A' (sender): sends a single 'ask' to the peer Hive and prints
 *     `XHIVE_REPLY <json>` when the peer's answer arrives.
 *
 * Both print `XHIVE_READY` once joined, and `XHIVE_DONE` before exit. The
 * orchestrator (cross-hive-cross-machine.integration.test.ts) SSH-launches B then A,
 * scrapes these stdout markers, and asserts the round-trip. Public DHT = no
 * bootstrap; the two frames rendezvous on deriveHiveFederationTopic(peerPubkey).
 *
 * Self-contained (no peer-child ndjson protocol) — it signs with a passed-in
 * Ed25519 private key (PKCS8 DER, base64) so the orchestrator owns both keypairs.
 */
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import { makeSwarmCrossHiveTransport } from '../cross-hive-swarm-transport';
import { wireCrossHiveBoundary } from '../cross-hive-wiring';
import { InMemoryCrossHiveOutbox, NULL_CROSS_HIVE_ASK_LEDGER } from '../cross-hive-transport';
import type { CrossHiveBoundaryPorts, CrossHiveGrant } from '../cross-hive-boundary';
import type { HyperswarmLike } from '../sync/hyperbee/swarm';

interface FrameCfg {
  role: 'A' | 'B';
  /** This frame's Hive pubkey (raw-32-byte base64). */
  selfPubkey: string;
  /** This frame's Hive private key (PKCS8 DER, base64) — signs envelopes. */
  selfPrivPkcs8B64: string;
  /** The peer Hive's pubkey (raw-32-byte base64) — who A dials / who B grants. */
  peerPubkey: string;
  /** Stable correlation id shared by A (the ask) and B (the reply). */
  corr: string;
  /** Seconds to run before giving up (default 120). */
  ttlSec?: number;
  /** Local-testnet bootstrap (the $0 smoke). Omitted on a real frame → public DHT. */
  bootstrap?: Array<{ host: string; port: number }>;
}

function out(line: string): void {
   
  console.log(line);
}

async function main(): Promise<void> {
  const cfg = JSON.parse(
    process.env.XPOT_FRAME ?? process.env.XHIVE_FRAME /* legacy env name — dual-accept until callers migrate */ ?? '{}',
  ) as FrameCfg;
  if (!cfg.role || !cfg.selfPubkey || !cfg.selfPrivPkcs8B64 || !cfg.peerPubkey) {
    out('XHIVE_ERROR missing config');
    process.exit(2);
  }
  const privKey = createPrivateKey({
    key: Buffer.from(cfg.selfPrivPkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signer = async (bytes: Buffer) => nodeSign(null, bytes, privKey);

  // Public DHT (real frame) unless a local-testnet bootstrap is supplied ($0 smoke).
  const swarm = new Hyperswarm(
    cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : {},
  ) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  const transport = makeSwarmCrossHiveTransport({
    swarm,
    selfHivePubkey: cfg.selfPubkey,
    sendWaitMs: 90_000,
    pollMs: 250,
  });

  let done = false;
  const finish = async (code: number): Promise<void> => {
    if (done) return;
    done = true;
    out('XHIVE_DONE');
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  if (cfg.role === 'B') {
    // B grants the peer (A) the 'ask' kind; admission re-reads this each envelope.
    const grants: CrossHiveGrant[] = [{ peerHivePubkey: cfg.peerPubkey, allowedKinds: ['ask'] }];
    let replied = false;
    const recordingPorts: CrossHiveBoundaryPorts = {
      async openAsk(env) {
        out(`XHIVE_ADMITTED ${JSON.stringify({ from: env.fromHivePubkey.slice(0, 12), subject: env.subject })}`);
        if (!replied) {
          replied = true;
          // Reply (answer) back to A, correlated to the agreed id.
          void wiring
            .reply(cfg.peerPubkey, { kind: 'answer', subject: 're: ' + env.subject, body: 'admitted-ok', correlationId: cfg.corr })
            .then(() => out('XHIVE_REPLIED'))
            .catch((e) => out('XHIVE_REPLY_ERR ' + (e instanceof Error ? e.message : String(e))));
          // Give the reply time to deliver, then exit.
          setTimeout(() => void finish(0), 8_000);
        }
        return { ref: 'conv-1' };
      },
      async createWorkRequest(env) {
        out(`XHIVE_ADMITTED_WR ${JSON.stringify({ from: env.fromHivePubkey.slice(0, 12) })}`);
        return { ref: 'wi-1' };
      },
    };
    const wiring = wireCrossHiveBoundary({
      workspaceId: 'xhive-e2e', potSlug: 'hive-b', hivePubkey: cfg.selfPubkey,
      transport, signer, requestPorts: recordingPorts,
      loadGrants: async () => grants, outbox: new InMemoryCrossHiveOutbox(),
      askLedger: NULL_CROSS_HIVE_ASK_LEDGER, // $0 frame: never touch PG, even if reachable
    });
    out('XHIVE_READY');
  } else {
    // A: send one ask to B and await the answer. The B-05 egress default-deny means
    // A's own config must carry the `out` grant for (B, ask) — the frame's stand-in
    // for the owner's pot:cross_grant.
    const outboundGrants: CrossHiveGrant[] = [{ peerHivePubkey: cfg.peerPubkey, allowedKinds: ['ask'] }];
    const wiring = wireCrossHiveBoundary({
      workspaceId: 'xhive-e2e', potSlug: 'hive-a', hivePubkey: cfg.selfPubkey,
      transport, signer,
      requestPorts: { async openAsk() { return { ref: 'x' }; }, async createWorkRequest() { return { ref: 'x' }; } },
      loadGrants: async () => [],
      loadOutboundGrants: async () => outboundGrants,
      outbox: new InMemoryCrossHiveOutbox(),
      askLedger: NULL_CROSS_HIVE_ASK_LEDGER, // $0 frame: never touch PG, even if reachable
      onReply: (r) => {
        out(`XHIVE_REPLY ${JSON.stringify({ replyKind: r.replyKind, correlationId: r.correlationId, body: r.body })}`);
        void finish(0);
      },
    });
    out('XHIVE_READY');
    // Retry the send until delivered (store-and-forward queues until the channel pairs).
    const r = await wiring.send(cfg.peerPubkey, { id: cfg.corr, kind: 'ask', subject: 'cross-machine ask', body: 'hello B' });
    out(`XHIVE_SENT ${JSON.stringify({ delivered: r.delivered, queued: r.queued })}`);
    if (!r.delivered) {
      const t0 = Date.now();
      const flushLoop = setInterval(() => {
        if (done) { clearInterval(flushLoop); return; }
        void wiring.flushOutbox().catch(() => {});
        if (Date.now() - t0 > (cfg.ttlSec ?? 120) * 1000) { clearInterval(flushLoop); }
      }, 3_000);
    }
  }

  // Safety TTL.
  setTimeout(() => void finish(done ? 0 : 3), (cfg.ttlSec ?? 120) * 1000);
}

void main().catch((e) => {
  out('XHIVE_ERROR ' + (e instanceof Error ? e.message : String(e)));
  process.exit(2);
});
