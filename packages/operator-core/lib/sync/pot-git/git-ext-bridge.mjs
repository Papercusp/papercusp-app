#!/usr/bin/env node
/**
 * git-ext-bridge.mjs — the `ext::` transport helper for pot-git fetch (Phase 7
 * G-2, cross-machine-coord-parity-and-trust-2026-07-01 / P-026).
 *
 * `git fetch "ext::node <this> <sockPath>" …` spawns THIS process as the
 * connection command: git speaks the pkt-line protocol on our stdin/stdout. We
 * are pure plumbing — cross-pipe that stdio to a Unix-domain socket the PARENT
 * (fetchOverDuplex) is listening on, and the parent bridges that socket to the
 * peer's per-fetch Protomux stream. No git logic here; upload-pack runs on the
 * peer.
 *
 * Kept as a standalone .mjs (not bundled TS) precisely because git execs it as
 * an external command — it must be a runnable node script on disk. Everything is
 * best-effort/quiet: a broken pipe just ends the fetch.
 *
 * allowHalfOpen:true is LOAD-BEARING: git's pack is delimited IN-BAND (a flush
 * pkt), so the stream must not be destroyed on the first FIN — a half-open close
 * lets every buffered byte flush before teardown. Default `pipe` (end:true) then
 * propagates each half-close cleanly.
 */
import net from 'node:net';

const sockPath = process.argv[2];
if (!sockPath) {
  process.stderr.write('git-ext-bridge: missing socket path arg\n');
  process.exit(2);
}

const sock = net.connect({ path: sockPath, allowHalfOpen: true });
sock.on('error', (e) => {
  process.stderr.write(`git-ext-bridge: socket error: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
// Swallow EPIPE on our std streams (the far end can hang up first).
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

// git → us (stdin) → peer (socket); peer (socket) → us (stdout) → git.
// Default end:true half-closes each direction as its source ends.
process.stdin.pipe(sock);
sock.pipe(process.stdout);

// WI-6189: peer EOF MUST reach git, or the fetch hangs until its ceiling.
//
// Two Node behaviours conspire to swallow it, and neither is obvious:
//   1. `readable.pipe(process.stdout)` NEVER ends the destination — Node's
//      pipe() explicitly excludes process.stdout/stderr from its end:true
//      contract. So the "default end:true half-closes each direction" note
//      above is simply not true for this leg.
//   2. `allowHalfOpen:true` (load-bearing, see the header) means a FIN from the
//      peer emits 'end' and NOT 'close' — so the `sock.on('close')` exit below
//      never fires either.
// Net effect: the peer goes away, git keeps blocking on a stdout that is never
// closed, and the fetch dies only when the 120 s ceiling SIGKILLs it. With
// pot-git channels closing 23–36x/min that made the cold-join ladder
// un-climbable — every interrupted rung cost a full ceiling instead of ~10 ms.
//
// 'end' fires only after every byte the peer sent has been delivered to the
// pipe, so flushing stdout and exiting cannot truncate the in-band pack: a
// SUCCESSFUL fetch has the whole pack in flight before this ever runs. The
// zero-length write's callback is the flush barrier.
sock.on('end', () => {
  process.stdout.write(Buffer.alloc(0), () => process.exit(0));
});

sock.on('close', () => process.exit(0));
