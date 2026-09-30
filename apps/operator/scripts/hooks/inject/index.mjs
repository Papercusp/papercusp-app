#!/usr/bin/env node
/**
 * papercusp-inject — THE single context-injection dispatcher.
 *
 * Plan: codex-context-injection-parity-2026-08-09, D-001 (FROZEN, shared
 * verbatim with omp-context-injection-parity-2026-08-09).
 *
 * Owner directive [owner 2026-08-09]: "Make sure this is implemented in
 * abstracted way like we do in other places, so like there is a single inject
 * context function that calls the appropriate function for each tui."
 *
 * ── CLI CONTRACT (frozen; clients are installed against this) ──
 *     papercusp-inject --client=<claude|codex|omp> --event=<native-event>
 *   stdin  : the client's native hook event, as JSON
 *   stdout : the client's native injection payload, or NOTHING
 *   exit   : ALWAYS 0
 *
 * `--event` is required and explicit rather than sniffed from the payload:
 * three clients spell their events differently (claude PascalCase, codex both
 * PascalCase in-payload and kebab-case in-config, omp its own), and a
 * dispatcher that guesses would fail SILENTLY — which, on a fail-silent path,
 * is indistinguishable from "there was nothing to inject". Making the caller
 * name the event means a wiring mistake is a wiring mistake, not a mystery.
 *
 * ── EXIT 0 AND EMPTY STDOUT IS THE CONTRACT (D-001 invariant 1) ──
 * Not exit-0-on-success. Exit 0 ALWAYS: unparseable stdin, unknown client,
 * unknown event, no PAPERCUSP_SID, operator down, operator slow, adapter bug.
 * A context hook that errors can wedge a turn, and it would do so exactly when
 * the operator is already unhealthy. The paired assertion (exit 0 AND empty
 * stdout) is what the tests check, because either alone passes trivially.
 *
 * ── IN-PROCESS CLIENTS DO NOT NEED THIS FILE ──
 * This is the process entry. A client that loads hooks in-process (omp) can
 * import `adapters/<client>.mjs` + `core.mjs` directly and skip the CLI
 * entirely; the adapter contract is the seam, the CLI is one way to reach it.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runInjection } from './core.mjs';
import { openDeliveryLedger } from './delivery-ledger.mjs';

/**
 * @typedef {import('./ports.mjs').InjectionPort} InjectionPort
 *
 * @typedef {object} InjectionAdapter
 * @property {'claude'|'codex'|'omp'} client
 * @property {(nativeEvent: string) => InjectionPort | null} portForEvent
 * @property {(port: InjectionPort, event: unknown) => object | null} parse
 * @property {(port: InjectionPort, text: string, event: unknown) => string | null} render
 */

/**
 * Adapters are loaded LAZILY, one per invocation.
 *
 * A static import map would load all three on every hook fire. This runs on the
 * hot path of every prompt and every tool batch, so it loads exactly the one
 * adapter it needs — and a syntax error in a sibling adapter (say, one that is
 * mid-edit by another agent on this shared tree) cannot take down a client that
 * does not use it.
 *
 * The allow-list is explicit rather than interpolating `--client` into the
 * import path: that would be an arbitrary-file-read primitive driven by a CLI
 * flag, on a path that runs inside every agent session.
 *
 * @param {string} client
 * @returns {Promise<InjectionAdapter | null>}
 */
async function loadAdapter(client) {
  try {
    switch (client) {
      case 'claude':
        return (await import('./adapters/claude.mjs')).default;
      case 'codex':
        return (await import('./adapters/codex.mjs')).default;
      case 'omp':
        return (await import('./adapters/omp.mjs')).default;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** @param {string[]} argv @returns {Record<string, string>} */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return out;
}

/** @param {NodeJS.ReadableStream} stream @returns {Promise<string>} */
function readStdin(stream) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', finish);
    // A client that opens the pipe and never closes it must not hang the turn.
    // The per-port wall in core.mjs cannot help here: it only starts once we
    // have an event to send.
    stream.on('error', finish);
  });
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {NodeJS.ReadableStream} [opts.stdin]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {Parameters<typeof runInjection>[0]['openDeliveryLedger']} [opts.openDeliveryLedger]
 *   see runInjection; the CLI entry below is the only caller that can commit it
 * @returns {Promise<string | null>} the stdout payload, or null to emit nothing
 */
export async function dispatch(opts = {}) {
  const {
    argv = process.argv.slice(2),
    stdin = process.stdin,
    env = process.env,
    openDeliveryLedger,
    fetchImpl,
  } = opts;
  // TEST-ONLY SEAM (EI-19989482108652654): dispatch()'s own try/catch below
  // absorbs every error a real invocation can produce, so nothing in this repo
  // can exercise the CLI entry's OUTER catch (`.catch(() => process.exit(0))`
  // at the bottom of this file) without it. Throwing here — before that
  // try/catch — is the cheapest way to simulate a genuinely unexpected
  // rejection reaching the outer guard. Never set outside a test harness.
  if (env.PAPERCUSP_INJECT_TEST_FORCE_THROW === '1') {
    throw new Error('PAPERCUSP_INJECT_TEST_FORCE_THROW (test-only seam)');
  }
  try {
    const args = parseArgs(argv);
    const client = args.client;
    const nativeEvent = args.event;
    if (!client || !nativeEvent) return null;

    const adapter = await loadAdapter(client);
    if (!adapter) return null;

    // Cheap pre-check: if this event maps to no port, never read stdin at all.
    if (!adapter.portForEvent(nativeEvent)) return null;

    const raw = await readStdin(stdin);
    if (!raw || !raw.trim()) return null;

    /** @type {unknown} */
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }

    return await runInjection({ adapter, nativeEvent, event, env, fetchImpl, openDeliveryLedger });
  } catch {
    return null;
  }
}

// Entry point. Guarded so importing this module (tests, an in-process client)
// never executes the CLI.
//
// ⚠ The guard must be SYMLINK-ROBUST, and the naive form is not. Node resolves
// `import.meta.url` through symlinks (realpath) while `process.argv[1]` keeps
// the path as invoked, so a bare
//     import.meta.url === `file://${process.argv[1]}`
// compares a resolved path against an unresolved one and silently yields FALSE
// when reached through a symlink. This repo is reachable as both
// `papercupai-workspace/papercup` and `.../papercusp`, and the installed hook
// copies live under ~/.papercusp/hooks — so the naive form would make the CLI
// do nothing at all, exit 0, and emit no output: indistinguishable, on this
// fail-silent path, from "there was nothing to inject". realpath both sides.
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // ACK-ON-PROOF (delivery-ledger.mjs): the offered token is committed from the
  // stdout write's own callback, so it is recorded only once the payload has
  // actually left this process. Killed before that, nothing is recorded and the
  // operator re-delivers the block next turn.
  /** @type {import('./delivery-ledger.mjs').DeliveryLedger | null} */
  let ledger = null;
  dispatch({
    openDeliveryLedger: (owner, env) => (ledger = openDeliveryLedger(owner, env)),
  })
    .then((payload) => {
      if (!payload) process.exit(0);
      process.stdout.write(payload + '\n', (err) => {
        if (!err) ledger?.commit();
        process.exit(0);
      });
    })
    .catch(() => process.exit(0));
}
