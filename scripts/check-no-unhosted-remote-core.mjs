#!/usr/bin/env node
/**
 * lint:no-unhosted-remote-core — a REMOTE hypercore is opened BY KEY only through
 * the `openRemoteLog` seam, never straight off a Corestore.
 *
 * ## The invariant, and why it is not a style preference
 *
 * A Protomux carries AT MOST ONE `hypercore/alpha` channel per discovery key.
 * hypercore's replicator `_makePeer()` bails out first via
 * `protomux.opened({ protocol: 'hypercore/alpha', id: discoveryKey })`, and
 * `protomux.createChannel` defaults `unique = true` and returns `null` when a
 * channel for that (protocol, id) pair is already open.
 *
 * Every harness on this machine shares ONE process-wide Hyperswarm, so one peer
 * is reached over ONE socket ⇒ ONE muxer for all of them, and each harness holds
 * its OWN Corestore. So two local replicas of the SAME remote key can never both
 * replicate: whichever opens first wins the single slot and the loser sits at
 * `peersCount === 0` FOREVER while the socket stays fully handshaken and live.
 *
 * `remote-core-host.ts` closes that by opening a remote log in exactly ONE
 * Corestore per machine and handing siblings a SESSION on it — one core, one
 * channel, every sibling reads the same blocks. `openRemoteLog` (peer-log.ts) is
 * the ONLY caller of `resolveRemoteCoreHost`, which makes it the seam: a remote
 * core opened by any other route is invisible to the host registry and re-arms
 * the collision.
 *
 * ⚠ THE FAILURE IS SILENT AND IT ESCALATES. The starved replica is not merely
 * idle — it drives a churn engine: it trips the `replication_stalled` detector,
 * which runs repair-on-detect (structurally incapable here: re-attaching a
 * session that still cannot win the one slot), then repair-exhaustion escalates
 * to a FORCED TOPIC REJOIN, which destroys the SHARED socket and kills
 * replication for the co-tenant harnesses that were perfectly healthy. The
 * reconnect reshuffles which store wins each key, so a different sibling starves
 * next round. That is the intermittent, order-dependent, direction-selective
 * federation failure behind WI-183 / WI-5371 / WI-5673 / WI-5481.
 *
 * Because the loser looks healthy on every other surface, nothing fails loudly
 * at the call site. This guard is the only thing standing between a one-line
 * `store.get({ key })` and that whole cascade coming back.
 *
 * ## What it flags
 *
 * `<store>.get({ key: … })` — opening a core BY KEY, i.e. a core this machine
 * does not author.
 *
 * ## What it deliberately does NOT flag
 *
 *  - `store.get({ name: … })` — a harness's OWN writable log. Per-harness by
 *    construction, so it can never collide, and `remote-core-host` deliberately
 *    does not dedup it.
 *  - `core.get(3)` / `core.get(i, { wait: true })` — a BLOCK read on an
 *    already-open core, which is not an open at all.
 *  - Test files. A hermetic test that simulates two machines in one process
 *    legitimately mints two independent replicas of one key — that is exactly
 *    what `shared-socket-multi-corestore-clobber.test.ts` does to pin the
 *    upstream invariant, and flagging it would be flagging the proof.
 *  - Comments and string literals (masked via `stripCommentsOnly`), so the
 *    prose in peer-log.ts that SPELLS the banned call is not a violation.
 *
 * ## Known blind spot — stated because a detector's silence is not evidence
 *
 * The match needs a LITERAL `key` property in the call's object literal, so an
 * open whose options arrive indirectly is invisible:
 *
 *     store.get(opts)                       // opts built elsewhere
 *     store.get({ ...opts, valueEncoding }) // ← the SEAM itself does this
 *
 * That second form is why `peer-log.ts` is NOT in ALLOW: its `getCore()` helper
 * spreads, so the detector never sees the seam and never needed to exempt it.
 * The cost is symmetric — a copycat that spreads its options evades this guard.
 * Widening to "any `.get(` whose argument is not a number" was rejected as
 * mostly false positives (every `core.get(i)` block read), so the honest
 * statement of coverage is: this catches the DIRECT form, which is the form
 * every site in the measured population actually uses. A clean run means "no
 * new direct open-by-key", never "no new replica".
 *
 * ## The allowlist
 *
 * ALLOW maps a repo-relative path to the REASON it is exempt — a bare path
 * would let a future reader assume every entry is as safe as the seam itself,
 * and they are not. Two distinct justifications appear below and only one of
 * them is airtight; the honest reason travels with the entry so the weaker case
 * is re-examined rather than inherited.
 *
 * Exit 0 clean / 1 on a new violation. `--list` prints the measured population
 * (that is how ALLOW is re-seeded — never from a hand-run grep).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['libs', 'packages', 'apps'];
const LIST_ONLY = process.argv.includes('--list');

/** Directories never worth walking. */
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'dist-sidecar', 'build', '.next', 'target',
  '_retired', 'coverage', '.git', 'out',
]);

/**
 * Exempt sites, each with the reason it is safe. NOT shrink-only in the usual
 * sense — the seam entry is permanent — but every ADDITION must carry a reason
 * that survives the question "what stops this from starving a sibling?".
 */
const ALLOW = new Map([
  [
    'packages/operator-core/lib/sync/hyperbee/scope-cores.ts',
    'P-006 federation-scope cores. This store is a SEPARATE, deliberately NEVER-replicate()d ' +
      'Corestore: it registers no lazy ondiscoverykey path and serves only via explicit ' +
      'per-core×connection attach, which is the §5.3 fail-closed serve gate. Its key population ' +
      '(scope logs) is disjoint from the admitted peer-logs remote-core-host dedups, so the ' +
      'machine-wide host registry deliberately does not cover it. ' +
      '⚠ Its attachSafely() guard tests `session.replicator.attached(mux)` — the SAME predicate ' +
      'WI-5371 proved reads true for a channel whose open was silently refused — so if a scope ' +
      'core key ever coincides with a key already channelled on that muxer, the refusal is ' +
      'swallowed and reads as "already attached". Not reachable today given disjoint key ' +
      'populations; tracked separately rather than assumed away.',
  ],
  [
    'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts',
    'Seed cutting/restoring. The cores are opened in a FRESH staging Corestore (or a readOnly ' +
      'seed store) that is fed by a LOCAL pipeReplicate — its own stream, its own muxer, never ' +
      'the shared peer socket — so the single-channel-per-muxer limit cannot bite. ' +
      '⚠ NOT airtight for computeSparseFrom(), which reads the SOURCE harness store directly: ' +
      'if a sibling hosts that key, the blocks live in the sibling\'s store dir and this store ' +
      'may see a short/empty core. Narrow in practice (cut-seed-cli opens its own unregistered ' +
      'Corestore in a separate process, and the default cut ships the owner OWN-log only, which ' +
      'is never deduped) — tracked separately, do not widen this entry to cover new call sites.',
  ],
  [
    'packages/operator-core/lib/sync/hyperbee/substrate-sidecar-host.ts',
    'handleGetCoreInfo — an RPC DIAGNOSTIC that opens a caller-named key in an explicitly ' +
      'addressed store to report its length/blocks. Read-only inspection on a store the caller ' +
      'already identified, not a replication participant being wired up.',
  ],
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec)\.[cm]?tsx?$/.test(name)) {
      yield full;
    }
  }
}

/**
 * Opens-by-key in one file's source.
 *
 * `.get(` followed by an object literal carrying a `key` property. The `[^})]*`
 * body deliberately spans newlines (a negated class matches them) so a
 * multi-line options object is not a blind spot, and stops at `)` so a plain
 * block read `core.get(i, { wait: true })` cannot be dragged into a later
 * object literal's `key:`.
 */
const OPEN_BY_KEY = /\.get\(\s*\{[^})]*\bkey\b\s*[,:]/g;

export function findOpensByKey(source, fileName = 'x.ts') {
  const masked = stripCommentsOnly(source, fileName);
  const hits = [];
  for (const m of masked.matchAll(OPEN_BY_KEY)) {
    hits.push({ index: m.index, line: masked.slice(0, m.index).split('\n').length });
  }
  return hits;
}

function scanTree() {
  const violations = [];
  const everyOpen = [];
  const allowedSeen = new Set();

  for (const r of ROOTS) {
    for (const file of walk(join(ROOT, r))) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('.get(')) continue;
      const rel = relative(ROOT, file);
      const hits = findOpensByKey(src, rel);
      if (hits.length === 0) continue;
      for (const h of hits) everyOpen.push({ rel, line: h.line });
      if (ALLOW.has(rel)) {
        allowedSeen.add(rel);
        continue;
      }
      for (const h of hits) violations.push({ rel, line: h.line });
    }
  }

  const stale = [...ALLOW.keys()].filter((f) => !allowedSeen.has(f));
  return { violations, everyOpen, allowedSeen, stale };
}

const { violations, everyOpen, allowedSeen, stale } = scanTree();

if (LIST_ONLY) {
  everyOpen.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  const files = new Set(everyOpen.map((p) => p.rel));
  console.log(`${everyOpen.length} open-by-key site(s) across ${files.size} file(s):\n`);
  for (const p of everyOpen) console.log(`  ${p.rel}:${p.line}`);
  console.log('\nALLOW seed (paste into this script, and give each entry a REASON):\n');
  for (const f of [...files].sort()) console.log(`  ['${f}', 'REASON REQUIRED'],`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error('\n✖ lint:no-unhosted-remote-core — remote core(s) opened outside the seam:\n');
  for (const v of violations) console.error(`  ${v.rel}:${v.line}`);
  console.error(`
Open a remote log through the seam instead:

    import { openRemoteLog } from '<…>/sync/hyperbee/peer-log';
    const log = await openRemoteLog(store, keyHex);

A direct \`store.get({ key })\` mints a SECOND local replica of a key a sibling
harness may already host. A Protomux carries at most one hypercore/alpha channel
per discovery key, so the loser never attaches a replicator — it sits at
peersCount 0 forever while the socket stays live and every health surface reads
healthy. It then trips replication_stalled → repair-on-detect (which cannot win
the slot) → repair-exhausted → a FORCED TOPIC REJOIN that tears down the SHARED
socket for the healthy co-tenant harnesses too.

\`openRemoteLog\` routes through resolveRemoteCoreHost(), which keeps ONE core per
(machine, key) and hands you a session on it. You still get your own Corestore
session, so close()/refcount semantics are unchanged.

Mechanism + the negative control: packages/operator-core/lib/sync/hyperbee/remote-core-host.ts
                                 packages/operator-core/lib/sync/hyperbee/shared-socket-multi-corestore-clobber.test.ts
If your site genuinely cannot collide (its own muxer, e.g. a local pipeReplicate),
add it to ALLOW in scripts/check-no-unhosted-remote-core.mjs WITH THE REASON.
`);
  process.exit(1);
}

if (stale.length > 0) {
  console.log('✔ lint:no-unhosted-remote-core — no unhosted remote-core opens.');
  console.log(
    `\n  ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer match — ` +
      'moved or migrated. Remove from ALLOW in scripts/check-no-unhosted-remote-core.mjs ' +
      '(a stale entry silently exempts a path that may come back):',
  );
  for (const f of stale) console.log(`    ${f}`);
  process.exit(0);
}

console.log(
  `✔ lint:no-unhosted-remote-core — every remote-core open goes through the seam ` +
    `(${allowedSeen.size} reasoned exemption${allowedSeen.size === 1 ? '' : 's'}).`,
);
