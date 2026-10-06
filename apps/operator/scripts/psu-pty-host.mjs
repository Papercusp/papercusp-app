/**
 * psu-pty-host — the production managed-PTY host for interactive psu sessions
 * (turn-lifecycle-control-2026-06-08 Phase 3, P-012/P-013/P-014; D-006/D-011).
 *
 * Why: by default `psu` launches the agent with `stdio:'inherit'` straight into
 * the user's terminal, so the operator doesn't own its stdin — a wake can only
 * PARK + inbox-nudge the live session (wake-executor Channel 3: "alive but not
 * an injectable managed pty"). This module instead launches the agent attached
 * to a `@lydell/node-pty` managed pty and bridges the user's real TTY <-> the
 * pty, exposing an owner-only control socket. The operator reaches that socket
 * to INJECT a wake turn (or, Phase 4, an interrupt) into the LIVE session.
 *
 * Crucial ownership boundary (D-006): the pty + control socket live IN THE PSU
 * PROCESS, not the operator. The operator only CONNECTS to the socket; an
 * operator restart never disturbs the human's session. This sidesteps the
 * operator-lifecycle coupling an operator-hosted pty would have.
 *
 * Security (D-011): the control socket lets a connector inject keystrokes into
 * an agent running with permissions bypassed — an injected line is effectively
 * command execution as this user. So the dir is 0700, the socket is 0600, and a
 * tight umask wraps the bind so the node is never even briefly world-accessible.
 * Same-UID is the OS boundary; per-agent auth/audit/rate-limit is layered on top
 * by the operator-mediated `turn:interrupt` tool (D-008, Phase 4).
 *
 * Discovery (P-014): the host writes a discovery file
 *   ~/.papercusp/psu-pty/<ownerId>.json  =  { ownerId, advSessionId, pid, ptyPid, sock, command, startedAt }
 * keyed by the session's coord ownerId (PAPERCUSP_SID — the same key the wake
 * handle joins on). The operator's wake-executor reads this dir to find a live
 * session's socket. The contract (dir + filename + {ownerId,pid,sock}) is
 * mirrored read-side in packages/operator-core/lib/events/await/psu-pty-discovery.ts —
 * keep the two in lockstep. A local-FS discovery file (not PG) is deliberate:
 * the socket is a same-host, process-lifetime-bound IPC resource that must be
 * removed on process exit, exactly like ~/.papercusp/voice-ipc.json /
 * embedded-pg.json.
 *
 * Derived from the validated psupty.mjs spike (which proved the feel + the
 * inject path end-to-end); this is the reusable, gated, operator-discoverable
 * version wired into psu-launcher's runWrapper.
 */

import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
// Keep the interactive bootstrap independent of operator packages while using
// the same dependency-free signature as the governed turn taxonomy.
import { makeModelCapacityDetector } from '../../../libs/papercusp-shared/src/agent/model-capacity.mjs';
import {
  AGENT_IDENTITY_SPEC_ENV,
  stageAgentIdentityTty,
} from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  chmodSync,
  renameSync,
  appendFileSync,
  closeSync,
  fsyncSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';

/** Environment fragments injected by launchers and tests need not carry every
 * ambient key that an application framework merges into NodeJS.ProcessEnv.
 * @typedef {Record<string, string | undefined>} EnvironmentMap
 */

/**
 * The environment key used by a headless spawn to give this host a separate,
 * grep-safe copy of the child PTY stream. The ordinary stdout path remains
 * byte-oriented/raw for the existing lifecycle and activity consumers.
 */
export const HEADLESS_NORMALIZED_LOG_ENV = 'PAPERCUSP_PSU_HEADLESS_NORMALIZED_LOG';

const require = createRequire(import.meta.url);

/** This script's own directory — used to locate sibling scripts (the session-compacted
 *  emit CLI) and the checkout root. */
const HOST_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** This script's own path — the file whose LOADED contents this process runs.
 *  Separate from HOST_SCRIPT_DIR because WI-38292 needs the file, not the dir. */
const HOST_SCRIPT_PATH = fileURLToPath(import.meta.url);
const LAUNCHER_SCRIPT_PATH = join(HOST_SCRIPT_DIR, 'psu-launcher.mjs');

/** WI-38292: sha256 of a host script ON DISK, or null when unreadable.
 *  `path` is overridable so the staleness guard below can be proven falsifiable
 *  against a COPY outside the checkout — never by mutating this file in the
 *  shared tree, which git-sync would sweep into a commit mid-probe. */
export function hashHostScript(path = HOST_SCRIPT_PATH) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** WI-38292: the psu-pty-host version THIS PROCESS IS ACTUALLY RUNNING, frozen at
 *  module load. psu-launcher.mjs imports this module ONCE into a long-lived process
 *  and `recycleChild` only ever replaces the CLI child, so a deployed host fix stays
 *  inert here until the whole launcher restarts. Capturing the hash at load is what
 *  makes that detectable at all: it is the only value in the process that still
 *  describes the code actually executing after the file on disk moves on. */
export const LOADED_HOST_CODE_VERSION = hashHostScript();

/**
 * Persist only this closed classification of the operator target. The full URL can
 * contain credentials, paths, or query tokens and is never host-event evidence.
 *
 * @param {EnvironmentMap} [env]
 * @returns {'direct-3170'|'other'|'unset'}
 */
export function operatorPinEvidence(env = process.env) {
  const raw = typeof env?.PAPERCUSP_OPERATOR_URL === 'string'
    ? env.PAPERCUSP_OPERATOR_URL.trim()
    : '';
  if (!raw) return 'unset';
  try {
    const url = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      loopback &&
      url.port === '3170' &&
      ['/', '/api/mcp'].includes(path)
    ) {
      return 'direct-3170';
    }
  } catch {
    // An invalid or non-local target is deliberately reduced to the fixed enum.
  }
  return 'other';
}

// The launcher supplies the long-lived carry/model callbacks. Replacing only
// that sibling leaves this process on its old callbacks until it also adopts.
const LOADED_LAUNCHER_CODE_VERSION = hashHostScript(LAUNCHER_SCRIPT_PATH);

/** WI-38292: is this host or its launcher executing code older than disk?
 *  `stale` is true when either component's known hashes differ — an unreadable file
 *  degrades to "not stale" so a transient fs error can never turn a working respawn
 *  path into a warning storm. Pure + exported for tests. */
export function hostCodeStaleness({
  loaded = LOADED_HOST_CODE_VERSION,
  path = HOST_SCRIPT_PATH,
  launcherLoaded = LOADED_LAUNCHER_CODE_VERSION,
  launcherPath = LAUNCHER_SCRIPT_PATH,
} = {}) {
  const onDisk = hashHostScript(path);
  const launcherOnDisk = hashHostScript(launcherPath);
  const launcher = {
    stale: Boolean(launcherLoaded && launcherOnDisk && launcherLoaded !== launcherOnDisk),
    loaded: launcherLoaded,
    onDisk: launcherOnDisk,
  };
  return {
    stale: Boolean(loaded && onDisk && loaded !== onDisk) || launcher.stale,
    loaded,
    onDisk,
    launcher,
  };
}

/** WI-38292: the exit code that asks the psu shim's re-exec loop to re-run the
 *  launcher from disk. MIRRORS `PSU_REEXEC_EXIT_CODE` in
 *  packages/operator-core/lib/desktop-install/papercusp-files.ts — this file is
 *  bare ESM run by `node` and cannot import TS, so the two copies are pinned
 *  together by a test rather than by the module system. */
export const PSU_REEXEC_EXIT_CODE = 87;

/** WI-38292: does the process that launched us promise to re-run us if we exit
 *  with the sentinel? The shim exports `PAPERCUSP_PSU_REEXEC=<code>`; anything
 *  else (an old shim, an operator-spawned headless member, a packaged CLI
 *  wrapper, a direct `node psu-launcher.mjs`) means NOBODY would re-run us, so
 *  the adopting path must never be taken. Returns the code to exit with, or
 *  null. `PAPERCUSP_PSU_HOST_ADOPT=0` is the kill switch — same boot-mode-select
 *  role as PAPERCUSP_CACHE_PROXY_ROUTE, not a product feature gate.
 *  @param {EnvironmentMap} [env]
 */
export function reexecExitCodeFrom(env = process.env, ppid = process.ppid) {
  if (String(env.PAPERCUSP_PSU_HOST_ADOPT ?? '').trim() === '0') return null;
  // Number(), NOT parseInt(): parseInt('87.5') is 87 and parseInt('87abc') is 87,
  // so a malformed advertisement would read as a valid promise to re-run us.
  const advertised = Number(String(env.PAPERCUSP_PSU_REEXEC ?? '').trim() || NaN);
  if (!(Number.isInteger(advertised) && advertised > 0 && advertised < 256)) return null;
  // The advertisement must come from OUR OWN PARENT. Environment variables are
  // inherited by every descendant, so without this a nested launch — an agent
  // running `psu` from inside a psu terminal, a direct `node psu-launcher.mjs`,
  // anything spawned by the CLI child — would read a psu shim's promise as if it
  // had been made to IT. Exiting on that inherited promise kills the session
  // outright: the loop that would have re-run it belongs to a different process
  // entirely. The shim publishes its own pid, and bash is still alive as our
  // parent precisely because the loop does not `exec`.
  const advertiser = Number(String(env.PAPERCUSP_PSU_REEXEC_PPID ?? '').trim() || NaN);
  if (!Number.isInteger(advertiser) || advertiser !== ppid) return null;
  return advertised;
}

/**
 * WI-10001537: explain WHY `reexecExitCodeFrom` returned null, and say whether
 * that null is a DEFECT or expected.
 *
 * The null is load-bearing and usually correct — a headless operator-spawned
 * member, a nested `psu` inside a psu terminal, or the explicit kill switch all
 * legitimately have no re-exec loop. But one cause is a real, silent fault: an
 * unmanaged/stale shim that never advertised the loop at all. That is what
 * killed a live interactive session mid-`AskUserQuestion` — `~/.local/bin/psu`
 * (a retired install-standalone-mcp.sh one-liner) shadowed the managed shim on
 * PATH, so no loop existed, `onReexec` was wired null by design, and the host's
 * clean hand-off to a fresh process became a hard death. Nothing said a word.
 *
 * `actionable` is deliberately narrow, because a warning that also fires on the
 * three benign causes would be pure noise on every headless spawn and every
 * nested launch — and a detector nobody trusts is worse than none. In
 * particular `nested` is EXPECTED and common (env vars are inherited by every
 * descendant, so a psu launched from inside a psu terminal reads its parent's
 * advertisement and correctly rejects it).
 *
 * @param {EnvironmentMap} [env]
 * @param {number} [ppid]
 * @returns {null | { reason: 'kill-switch'|'unadvertised'|'malformed'|'nested', actionable: boolean, detail: string }}
 *   null when the loop IS wired (nothing to explain).
 */
export function missingReexecLoopDiagnosis(env = process.env, ppid = process.ppid) {
  if (reexecExitCodeFrom(env, ppid) != null) return null;

  if (String(env.PAPERCUSP_PSU_HOST_ADOPT ?? '').trim() === '0') {
    return { reason: 'kill-switch', actionable: false, detail: 'PAPERCUSP_PSU_HOST_ADOPT=0' };
  }

  const raw = String(env.PAPERCUSP_PSU_REEXEC ?? '').trim();
  if (!raw) {
    return {
      reason: 'unadvertised',
      actionable: true,
      detail: 'PAPERCUSP_PSU_REEXEC is not set: the process that launched us runs no re-exec loop',
    };
  }

  const advertised = Number(raw || NaN);
  if (!(Number.isInteger(advertised) && advertised > 0 && advertised < 256)) {
    return {
      reason: 'malformed',
      actionable: true,
      detail: `PAPERCUSP_PSU_REEXEC=${JSON.stringify(raw)} is not a usable exit code`,
    };
  }

  const advertiser = Number(String(env.PAPERCUSP_PSU_REEXEC_PPID ?? '').trim() || NaN);
  return {
    reason: 'nested',
    actionable: false,
    detail: `the advertisement came from pid ${Number.isInteger(advertiser) ? advertiser : 'unknown'}, not our parent ${ppid}`,
  };
}

/**
 * WI-10001537: the operator-facing warning for an `actionable`
 * missingReexecLoopDiagnosis on an INTERACTIVE launch.
 *
 * Interactivity is the second half of the filter: the whole cost of a missing
 * re-exec loop is that a hand-off becomes a hard death, and only a session with
 * a human attached loses anything when that happens (a headless member is
 * relaunched by its supervisor). A TTY is the honest test for that.
 *
 * Returns the message it emitted, or null when it stayed silent — so a test can
 * assert BOTH directions without capturing stderr.
 *
 * @param {{ diagnosis?: ReturnType<typeof missingReexecLoopDiagnosis>, interactive?: boolean, write?: (s: string) => void }} [opts]
 */
export function warnMissingReexecLoop({
  diagnosis = missingReexecLoopDiagnosis(),
  interactive = Boolean(process.stderr?.isTTY),
  write = (s) => process.stderr.write(s),
} = {}) {
  if (!diagnosis || !diagnosis.actionable || !interactive) return null;
  const message =
    `papercusp superuser launcher (psu): ⚠ no host re-exec loop (${diagnosis.reason}) — ${diagnosis.detail}.\n` +
    `  This session cannot hand off to a fresh process cleanly; an adopt/respawn becomes a HARD EXIT that\n` +
    `  destroys anything on screen (an open question dialog included). Usual cause: an unmanaged 'psu'\n` +
    `  earlier on PATH shadowing ~/.papercusp/bin/psu. Check with: command -v psu  (WI-10001537)\n`;
  try {
    write(message);
  } catch {
    /* a closed stderr must never take the launch down */
  }
  return message;
}

/**
 * A host-code adoption re-exec is safe only when no human terminal is bridged.
 * Interactive carry-respawns must stay inside the current PTY host: exiting the
 * launcher visibly tears down the TUI and a missed successor handoff falls into
 * the fresh-session wizard. Headless hosts have no such continuity boundary and
 * may still adopt current on-disk host code.
 *
 * ── P-009: WHY INTERACTIVE ADOPTION STAYS OFF BY DEFAULT (plan D-008) ──────────
 * Measured 2026-09-22: 69 hosts logged `host-code-stale`, with
 * `notAdoptingReason:'interactive-tty'` x302 — i.e. a long-lived interactive host
 * NEVER adopts a new build, which is the mechanism behind "we shipped a fix and it
 * recurred". The tempting fix is to let it adopt anyway. That is rejected, because
 * the host process OWNS the pty the human is looking at: adoption means re-execing
 * it, and if the successor handoff misses, the owner's session does not degrade —
 * it dies, taking the screen (and any open dialog) with it. Trading a stale but
 * WORKING session for a chance of a dead one is a bad trade at any staleness.
 *
 * Note the asymmetry that makes this different from the headless case: an
 * interactive host has a HUMAN attached who can restart it deliberately, at a
 * moment of their choosing, at zero risk. A headless host has nobody, which is
 * exactly why adoption is worth the risk there and not here.
 *
 * The residual gap — a stale interactive host nobody KNOWS is stale — is closed by
 * detection and durable accountability over the `host-code-stale` rows (P-007's
 * Postgres tier + P-008's filing), NOT by a terminal warning: P-006 removed host
 * diagnostics from the owner's terminal, so re-adding one here would undo a
 * shipped item in this same plan.
 *
 * `allowInteractive` is the deliberate operator opt-in for someone who wants
 * adoption anyway (a dev box, an unattended-but-bridged host). It is additionally
 * gated on the re-exec loop being present: `onReexec && reexecCode` is what makes
 * a handoff possible at all, so the opt-in cannot be enabled INTO the hard-exit
 * configuration that `warnMissingReexecLoop` exists to warn about.
 *
 * @param {{ onReexec?: unknown, reexecCode?: unknown, bridgeTty?: unknown,
 *           allowInteractive?: boolean }} args
 */
export function shouldAdoptHostCode({ onReexec, reexecCode, bridgeTty, allowInteractive = false }) {
  if (!onReexec || !reexecCode) return false;
  if (!bridgeTty) return true;
  return Boolean(allowInteractive);
}

/**
 * The operator opt-in behind {@link shouldAdoptHostCode}'s `allowInteractive`.
 *
 * Read from the environment at call time rather than captured at module load so a
 * long-lived host picks up the choice on its next respawn boundary instead of only
 * at the boot it can no longer perform.
 */
export function interactiveAdoptionOptIn(env = process.env) {
  return env.PAPERCUSP_PSU_PTY_ADOPT_INTERACTIVE === '1';
}

/** The discovery dir. Owner-only (0700). Shared contract with the read side
 *  (operator-core psu-pty-discovery.ts). */
// Integration tests and disposable probes must never write lifecycle evidence
// into the operator's live corpus. Production keeps the home-directory default;
// PAPERCUSP_PSU_PTY_DIR is an explicit, process-scoped override for isolated
// test/probe hosts.
export const PSU_PTY_DIR = process.env.PAPERCUSP_PSU_PTY_DIR || join(homedir(), '.papercusp', 'psu-pty');

/** How long the host waits for the user's input line to go idle before writing
 *  an injected turn into the pty (P-013 mid-keystroke safety). A burst of typing
 *  defers the inject until this much quiet has passed. */
const DEFAULT_IDLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS) || 750;
/** Cap on how long an inject will wait for idle before giving up and writing
 *  anyway — a wake must not be deferred forever by a user who keeps typing. */
const DEFAULT_IDLE_WAIT_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS) || 8_000;

/** Hard ceiling for one control-socket message. The socket is same-UID, but it
 * is still an untrusted streaming boundary: buffering until EOF without a cap
 * lets a wedged or compromised connector grow this long-lived host without
 * bound. Eight MiB is deliberately large enough for the biggest supported
 * session-port seed while keeping the allocation deterministic. Mirrored by
 * operator-core/lib/events/await/psu-pty-discovery.ts. */
export const MAX_CONTROL_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Environment keys for the optional detached kickoff-proof rendezvous. Keep
 * these string-identical to operator-core/lib/console-spawn.ts: this host is a
 * standalone ESM process and cannot import the TypeScript module. */
export const KICKOFF_PROOF_PATH_ENV = 'PAPERCUSP_KICKOFF_PROOF_PATH';
export const KICKOFF_PROOF_TOKEN_ENV = 'PAPERCUSP_KICKOFF_PROOF_TOKEN';
const KICKOFF_PROOF_TOKEN_RE = /^[a-f0-9]{48}$/i;

/**
 * Publish the parent-visible proof for a plain launch kickoff.
 *
 * The parent creates an empty 0600 file before detaching the child and passes
 * its path plus a random token through the existing PAPERCUSP_* environment
 * chain. Treat both values as untrusted at this boundary: only replace an
 * absolute, same-UID, regular 0600 empty placeholder, and never follow a
 * symlink. The receipt is written to a unique same-directory 0600 temporary
 * file, fsynced, and atomically renamed over that exact placeholder. A failed
 * publication is returned as a negative result so a receipt problem can never
 * tear down an otherwise usable host.
 *
 * @param {{persisted?: boolean, nativeRef?: string | null, reason?: string | null}} proof
 * @param {EnvironmentMap} [env]
 * @returns {{published: boolean, reason?: string, errorMessage?: string, errorCode?: string | null}}
 */
export function publishKickoffProofReceipt(proof, env = process.env) {
  const rawPath = env?.[KICKOFF_PROOF_PATH_ENV];
  const rawToken = env?.[KICKOFF_PROOF_TOKEN_ENV];
  if (rawPath == null && rawToken == null) {
    return { published: false, reason: 'kickoff-proof-request-missing' };
  }
  if (typeof rawPath !== 'string' || typeof rawToken !== 'string') {
    return { published: false, reason: 'kickoff-proof-request-malformed' };
  }
  const path = rawPath;
  const token = rawToken;
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) {
    return { published: false, reason: 'kickoff-proof-path-invalid' };
  }
  if (!KICKOFF_PROOF_TOKEN_RE.test(token)) {
    return { published: false, reason: 'kickoff-proof-token-invalid' };
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const assertPlaceholder = () => {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('kickoff-proof placeholder is not a regular file');
    }
    if ((before.mode & 0o777) !== 0o600 || before.size !== 0) {
      throw new Error('kickoff-proof placeholder is not an empty 0600 file');
    }
    if (currentUid == null || before.uid !== currentUid) {
      throw new Error('kickoff-proof placeholder is not owned by this parent uid');
    }
    const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size !== 0 ||
        opened.uid !== currentUid
      ) {
        throw new Error('kickoff-proof placeholder changed during secure open');
      }
      return { dev: opened.dev, ino: opened.ino };
    } finally {
      closeSync(fd);
    }
  };

  let tempPath = null;
  let tempFd = null;
  try {
    const original = assertPlaceholder();
    const persisted = proof?.persisted === true;
    const nativeRef = typeof proof?.nativeRef === 'string' ? proof.nativeRef : null;
    const reason =
      typeof proof?.reason === 'string'
        ? proof.reason
        : persisted
          ? null
          : 'native-turn-marker-timeout';
    const receipt = JSON.stringify({ token, persisted, nativeRef, reason });
    const dir = dirname(path);
    const base = path.slice(path.lastIndexOf('/') + 1);
    tempPath = join(
      dir,
      '.' + base + '.tmp-' + process.pid + '-' + randomBytes(12).toString('hex'),
    );
    tempFd = openSync(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(tempFd, receipt, { encoding: 'utf8' });
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    chmodSync(tempPath, 0o600);

    // Re-check the inode after the potentially slow receipt write. This closes
    // the ordinary replacement race; rename itself never follows a symlink.
    const stillPlaceholder = assertPlaceholder();
    if (stillPlaceholder.dev !== original.dev || stillPlaceholder.ino !== original.ino) {
      throw new Error('kickoff-proof placeholder changed before atomic publish');
    }
    renameSync(tempPath, path);
    tempPath = null;
    return { published: true };
  } catch (error) {
    return {
      published: false,
      reason: 'kickoff-proof-receipt-publish-failed',
      errorMessage: String(error?.message ?? error).slice(0, 500),
      errorCode: typeof error?.code === 'string' ? error.code : null,
    };
  } finally {
    if (tempFd != null) {
      try { closeSync(tempFd); } catch { /* best-effort */ }
    }
    if (tempPath) {
      try { unlinkSync(tempPath); } catch { /* best-effort */ }
    }
  }
}

/** Byte-accurate (not JS-code-unit) wire limit check. Exported so the exact
 * UTF-8 boundary is regression-tested without weakening the runtime guard. */
export function controlPayloadWithinLimit(payload, maxBytes = MAX_CONTROL_PAYLOAD_BYTES) {
  const bytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload), 'utf8');
  return bytes <= maxBytes;
}

/** Read a server-owned session-port seed without following a same-UID symlink.
 * The file is deliberately kept until the operator accepts native-persistence
 * proof; reading it is not delivery and therefore never consumes it. */
export function readManagedKickoffFile(path, expectedRenderedHash) {
  if (!path || !/^[0-9a-f]{64}$/i.test(String(expectedRenderedHash ?? ''))) {
    throw new Error('managed kickoff requires a file and rendered hash');
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('managed kickoff is not a regular file');
  if ((before.mode & 0o077) !== 0) throw new Error('managed kickoff permissions are broader than 0600');
  if (before.size <= 0 || before.size > MAX_CONTROL_PAYLOAD_BYTES) {
    throw new Error(`managed kickoff exceeds ${MAX_CONTROL_PAYLOAD_BYTES} byte cap`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('managed kickoff changed during secure open');
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size || bytes.length > MAX_CONTROL_PAYLOAD_BYTES) {
      throw new Error('managed kickoff changed size during read');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('managed kickoff is not valid UTF-8');
    const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${expectedRenderedHash}]`;
    if (!text.includes(marker)) throw new Error('managed kickoff checksum marker mismatch');
    return { text, marker, renderedHash: expectedRenderedHash, bytes: bytes.length };
  } finally {
    closeSync(fd);
  }
}

/** Dedicated verified provenance for the imported-history first turn. It is
 * neither owner input nor a fleet kickoff. Mirror the turn-provenance JSONL
 * envelope/ledger protocol; write the ledger row before PTY submission.
 * @param {string} text
 * @param {string} sid
 * @param {EnvironmentMap} [env]
 * @param {number} [nowMs]
 */
export function tagSessionPortTurn(text, sid, env = process.env, nowMs = Date.now()) {
  if (!text || !sid) throw new Error('session-port provenance requires seed text and target sid');
  const nonce = randomBytes(8).toString('hex');
  const sha256 = createHash('sha256')
    .update(String(text).replace(/\r\n?/g, '\n').trim(), 'utf8')
    .digest('hex');
  const dir = env.PAPERCUSP_TURN_PROVENANCE_DIR || join(homedir(), '.papercusp', 'turn-provenance');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const safe = sanitizeKey(sid);
  appendFileSync(
    join(dir, `${safe}.jsonl`),
    JSON.stringify({ sid, nonce, origin: 'session-port', sha256, ts: nowMs }) + '\n',
    { mode: 0o600 },
  );
  return `⟦turn-origin:session-port nonce:${nonce}⟧\n${text}`;
}

/** Chunk a large paste without splitting a UTF-16 surrogate pair. 16k code
 * units is at most 64 KiB of UTF-8, keeping node-pty writes bounded while the
 * concatenated stream remains byte-identical. */
export function ptyWriteChunks(value, maxCodeUnits = 16 * 1024) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxCodeUnits);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    if (end <= start) end = Math.min(text.length, start + 2);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const KICKOFF_MARKER_ECHO_TIMEOUT_MS = 2_000;
const KICKOFF_MARKER_ECHO_POLL_MS = 25;

/**
 * Confirm a fresh Codex kickoff reached the visible composer before Enter can
 * submit it. A backend frame proves the TUI rendered; child.write only proves
 * the host attempted input. Neither proves the composer accepted the marker.
 *
 * @param {{
 *   read?: () => unknown,
 *   text?: string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   headLossGraceMs?: number,
 *   shouldCancel?: () => boolean,
 *   onPending?: (state: { elapsedMs: number, observedChars: number, markerTailSeen: boolean }) => void,
 * }} [options]
 */
export async function waitForPtyTextEcho({
  read,
  text,
  timeoutMs = KICKOFF_MARKER_ECHO_TIMEOUT_MS,
  pollMs = KICKOFF_MARKER_ECHO_POLL_MS,
  headLossGraceMs = KICKOFF_MARKER_ECHO_TIMEOUT_MS,
  shouldCancel = () => false,
  onPending = () => {},
} = {}) {
  const expected = String(text ?? '');
  if (!expected || typeof read !== 'function') {
    return { echoed: false, reason: 'invalid-echo-check', elapsedMs: 0 };
  }
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1, Number(timeoutMs) || KICKOFF_MARKER_ECHO_TIMEOUT_MS);
  let observedChars = 0;
  let markerTailSeen = false;
  let pendingReported = false;
  let visible = '';
  while (true) {
    if (shouldCancel()) return { echoed: false, cancelled: true, elapsedMs: Date.now() - startedAt };
    visible = stripAnsi(String(read() ?? '')).replace(/[\r\n]/g, '');
    observedChars = Math.max(observedChars, visible.length);
    markerTailSeen ||= visible.includes(expected.slice(-12));
    if (visible.includes(expected)) {
      return { echoed: true, elapsedMs: Date.now() - startedAt, observedChars, markerTailSeen };
    }
    // WI-10005331: a composer that word-wraps the marker at its only space renders
    // every other byte in order; waiting cannot bring the break space back.
    const markerWhitespaceLost = composerEchoMarkerWhitespaceLoss(expected, visible);
    if (markerWhitespaceLost != null) {
      return { echoed: true, markerWhitespaceLost, elapsedMs: Date.now() - startedAt, observedChars, markerTailSeen };
    }
    const elapsedMs = Date.now() - startedAt;
    // WI-10005331: the exact proof gets the first grace window. After it, a marker
    // that lost only its head is this kickoff's own echo; waiting cannot complete it.
    // The post-submit native proof already accepts the same loss (WI-10002745).
    if (elapsedMs >= headLossGraceMs) {
      const markerHeadLost = composerEchoMarkerHeadLoss(expected, visible);
      if (markerHeadLost != null) {
        return { echoed: true, markerHeadLost, elapsedMs, observedChars, markerTailSeen };
      }
    }
    if (!pendingReported && elapsedMs >= KICKOFF_MARKER_ECHO_TIMEOUT_MS) {
      pendingReported = true;
      onPending({ elapsedMs, observedChars, markerTailSeen });
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), remainingMs)));
  }
  return {
    echoed: false,
    reason: 'timeout',
    elapsedMs: Date.now() - startedAt,
    observedChars,
    markerTailSeen,
    // Bounded evidence of WHICH bytes were missing: head loss, a dropped middle
    // byte and a composer that never rendered the marker need different fixes.
    visibleTail: visible.slice(-80),
  };
}

/**
 * P-006 (psu-pty-turn-boundary-generalization-2026-09-22): may a ROUTINE host
 * diagnostic be written to stderr right now?
 *
 * psu-launcher.mjs imports this host IN-PROCESS, and `bridgeTty` defaults to
 * `stdin.isTTY`, so a bare `process.stderr.write` from a gated-delivery defer
 * interleaves straight into the agent TUI the OWNER is reading — which is how
 * the busy-gate defer line became a user-visible "error" for a defer that was
 * working exactly as designed (owner report 2026-09-22, session 25a7969c).
 * These outcomes are already recorded durably by appendHostEvent(), so the
 * terminal copy is redundant, not load-bearing.
 *
 * ⚠ Deliberately does NOT quote the emitted line verbatim. psu-pty-busy-gate-
 * durable-evidence.test.ts anchors the busy-gate handler with a bare
 * `src.indexOf('DEFERRED/' + 'REFUSED')` and documents that literal as "unique
 * in the file"; a prose copy ABOVE the real call site silently captures that
 * anchor and makes the guard fail with `no enclosing if (atPrompt.deferred)`.
 * Measured here on 2026-09-22 — 6 tests broke on a comment, not on code.
 *
 * Suppression is scoped to the ROUTINE defer diagnostics only. Host lifecycle
 * and genuinely-unexpected failures keep writing unconditionally: silencing
 * those would trade a cosmetic problem for an undiagnosable one.
 *
 * `PAPERCUSP_PTY_HOST_DIAG=1` forces them back on for interactive debugging.
 * Pure + exported so the gate is unit-testable without a pty.
 *
 * @param {{ bridgeTty?: boolean, env?: EnvironmentMap }} [options] the explicit
 *   JSDoc is load-bearing: destructuring defaults alone make gen:declarations
 *   infer the param type from `env = process.env` ONLY, dropping `bridgeTty`
 *   and rejecting every real caller (same failure mode as waitAtPrompt's
 *   `verifiedBoundary = null` below).
 * @returns {boolean}
 */
export function shouldWriteHostDiagnostic({ bridgeTty, env = process.env } = {}) {
  if (String(env?.PAPERCUSP_PTY_HOST_DIAG ?? '') === '1') return true;
  return !bridgeTty;
}

function nativeTranscriptRoot(agent, env, home) {
  if (agent === 'claude') {
    const root = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
    return join(root, 'projects');
  }
  if (agent === 'codex') {
    const root = env.CODEX_HOME ? String(env.CODEX_HOME) : join(home, '.codex');
    return join(root, 'sessions');
  }
  if (agent === 'omp') {
    if (env.PI_CODING_AGENT_DIR) return join(String(env.PI_CODING_AGENT_DIR), 'sessions');
    const configured = String(env.PI_CONFIG_DIR || '.omp');
    const root = isAbsolute(configured) ? configured : join(home, configured);
    return join(root, 'agent', 'sessions');
  }
  return null;
}

/** The carry prompt's unique first line is the strongest cross-backend proof
 * that the fresh native transcript accepted THIS successor turn. */
// Match the canonical turn-provenance envelope grammar's origin and nonce
// alphabet. `coord-inject:owner` is valid; a narrower host-only parser falsely
// reports its native carry as missing provenance.
const LEADING_TURN_ORIGIN_RE = /^⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧$/;

/** WI-10005628: Claude Code stores a large bracketed paste in its native transcript
 * as `\n\n<pasted_content id="3e9a">\n⟦turn-origin:…⟧\n…\n</pasted_content id="3e9a">\n`.
 * Every scripted kickoff typed through the PTY arrives in that wrapper, so the
 * first line is empty and the marker proof never matched: the host declared the
 * kickoff unverified and killed a child that was already working (54 kills on
 * 2026-10-02 from 16:00Z, freshly elected goal holders among them). Same grammar
 * as the canonical PASTE_WRAPPER_SOURCE in
 * packages/operator-core/lib/turn-provenance/envelope-grammar.ts (WI-10002461),
 * pinned by envelope-grammar-cross-language.test.ts. WHOLE-PROMPT ONLY: words
 * outside the paste leave the text unchanged. */
const PASTE_WRAPPER_RE = /^\s*<pasted_content id="([A-Za-z0-9_-]{1,64})">\r?\n?([\s\S]*?)\r?\n?<\/pasted_content id="\1">\s*$/;

/** The pasted text when `text` is entirely one Claude Code paste block; otherwise `text`. */
export function unwrapWholePaste(text) {
  const value = String(text ?? '');
  const m = PASTE_WRAPPER_RE.exec(value);
  return m ? m[2] : value;
}

export function leadingTurnOriginMarker(text) {
  const firstLine = unwrapWholePaste(text).replace(/\r\n?/g, '\n').split('\n', 1)[0].trim();
  return LEADING_TURN_ORIGIN_RE.test(firstLine)
    ? firstLine
    : null;
}

/** WI-10002752: Codex has no system-prompt CLI flag, so a carry-respawn's carry
 * document rides in the first TYPED turn (`mintCarryRespawnArgs` returns it as
 * `carryText`: the carry document plus a lineage line). That minted text has no
 * provenance line of its own. Replacing the operator's first prompt with it
 * wholesale dropped the leading ⟦turn-origin⟧ line and the continuation body:
 * `verifyNativeTurnStartWithRetry` then refused before checking anything
 * ('missing-leading-turn-origin'), so every Codex carry was recorded as dropped
 * although Codex received it, and a machine-injected turn reached the transcript
 * with nothing to distinguish it from owner input. Compose instead: the original
 * marker line FIRST, then the original body, then the minted carry text.
 * When the mint already starts with the complete original body, retain that
 * body only once; the mint may append a lineage/recovery reference to it.
 * Without a leading marker on the original there is nothing to preserve, so the
 * minted text is used as before. Pure and exported for tests. */
export function composeCarryTurnText(originalText, mintedCarryText) {
  const original = String(originalText ?? '');
  const minted = String(mintedCarryText ?? '');
  if (!minted.trim()) return original;
  const marker = leadingTurnOriginMarker(original);
  if (!marker || leadingTurnOriginMarker(minted)) return minted;
  const body = original.replace(/\r\n?/g, '\n').split('\n').slice(1).join('\n').trim();
  if (body && (minted === body || minted.startsWith(`${body}\n\n`))) {
    return `${marker}\n${minted}`;
  }
  return body ? `${marker}\n${body}\n\n${minted}` : `${marker}\n${minted}`;
}

/** Find the exact port marker in a target-native JSONL row written for this
 * injection. File mtime alone is not proof: unrelated metadata can update an
 * old transcript and make an earlier marker appear fresh. This is the delivery
 * authority; PTY output/activity is intentionally insufficient.
 * @param {{agent: string, env?: EnvironmentMap, marker: string, sinceMs: number,
 *   home?: string, nativeId?: string | null}} options
 */
export function findNativeTranscriptMarker({
  agent,
  env = process.env,
  marker,
  sinceMs,
  home = homedir(),
  nativeId = null,
}) {
  return scanNativeTranscriptMarker({ agent, env, marker, sinceMs, home, nativeId })?.nativeRef ?? null;
}

/** WI-10002745: how many trailing nonce characters a truncated provenance
 * marker must still carry to count as this injection's. 8 hex characters are
 * 32 random bits, and the row must also pass the same timestamp fence and
 * native-id restriction as an exact match. */
export const TRUNCATED_MARKER_MIN_NONCE_CHARS = 8;

/** WI-10002745: a Codex kickoff can reach the native transcript missing its
 * first 34-47 characters (measured on 21 of 82 Codex launches on 2026-09-23;
 * one rollout began `bd294b2da8⟧`, the tail of
 * `⟦turn-origin:fleet-kickoff nonce:87d062bd294b2da8⟧`). The turn DID start, but
 * the exact-marker proof never matched, so the host declared the kickoff
 * unverified and tore down an auditor that was mid-work (310K input tokens,
 * last rollout write 4s before the teardown).
 *
 * Returns how many leading characters of `marker` were lost when `value`
 * begins with a proper suffix of it that still keeps at least `minNonceChars`
 * nonce characters and the closing bracket; otherwise null. An exact marker
 * returns null because the exact proof owns that case. Pure and exported for
 * tests. */
export function truncatedTurnOriginMarkerLoss(
  marker,
  value,
  { minNonceChars = TRUNCATED_MARKER_MIN_NONCE_CHARS } = {},
) {
  const exact = String(marker ?? '');
  if (!LEADING_TURN_ORIGIN_RE.test(exact)) return null;
  const text = String(value ?? '');
  const minSuffixLength = minNonceChars + 1; // nonce tail + closing bracket
  for (let lost = 1; lost <= exact.length - minSuffixLength; lost++) {
    if (text.startsWith(exact.slice(lost))) return lost;
  }
  return null;
}

/** WI-10005331: the pre-submit composer echo loses leading marker bytes the same
 * way the native transcript does (WI-10002745). Measured 2026-10-02: Codex resolver
 * su-df88c37b echoed 49 of 50 marker characters with the tail visible, the exact
 * proof could never match, and the host waited ~557s and then dropped the kickoff,
 * so inbox-resolve run bulk-bf4040d6 failed with every item undecided.
 *
 * Returns how many leading characters of `marker` were lost when `visible` holds a
 * proper suffix of it that keeps at least `minNonceChars` nonce characters and the
 * closing bracket; otherwise null (including when the exact marker is present, which
 * the exact proof owns). Unlike truncatedTurnOriginMarkerLoss the suffix may sit
 * anywhere in `visible`: the echo tap holds only output written after this kickoff's
 * own write, so its leading bytes are composer chrome rather than a transcript row
 * that could quote another injection, and the nonce tail is this injection's own
 * random value. The suffix must start the text or follow chrome: when the nearest
 * preceding non-space character could belong to a marker, the echo is either another
 * nonce that shares this tail or a marker that lost a MIDDLE byte (which the
 * post-submit proof rejects), so it is refused. Pure and exported for tests. */
export function composerEchoMarkerHeadLoss(
  marker,
  visible,
  { minNonceChars = TRUNCATED_MARKER_MIN_NONCE_CHARS } = {},
) {
  const exact = String(marker ?? '');
  if (!LEADING_TURN_ORIGIN_RE.test(exact)) return null;
  const text = String(visible ?? '');
  if (text.includes(exact)) return null;
  const minSuffixLength = minNonceChars + 1; // nonce tail + closing bracket
  for (let lost = 1; lost <= exact.length - minSuffixLength; lost++) {
    const suffix = exact.slice(lost);
    for (let at = text.indexOf(suffix); at !== -1; at = text.indexOf(suffix, at + 1)) {
      const before = text.slice(0, at).trimEnd();
      if (!before || !/[⟦⟧A-Za-z0-9:._@-]$/u.test(before)) return lost;
    }
  }
  return null;
}

/** WI-10005331: the composer word-wraps a long kickoff, and a wrap that lands on the
 * marker's only space renders the two halves on separate rows with the break space
 * omitted. The echo tap strips ANSI and row breaks, so the visible text holds every
 * other marker byte in order. Measured 2026-10-02 15:11:07Z on a host already running
 * the head-loss fix: visibleTail `⟦turn-origin:fleet-kickoffnonce:b413517be82f7380⟧`
 * (49 of 50 characters, the space missing), and the kickoff was dropped after ~586s.
 *
 * Returns how many of `marker`'s whitespace characters are missing when `visible`
 * holds the marker with only its whitespace changed (dropped, or padded to the row
 * end, which counts 0 lost); otherwise null, including when the exact marker is
 * present (the exact proof owns that case). Only turn-origin markers qualify: their
 * random nonce keeps the whitespace-insensitive match specific to this injection.
 * Any non-whitespace loss (a dropped head or middle byte) does not match. Pure and
 * exported for tests. */
export function composerEchoMarkerWhitespaceLoss(marker, visible) {
  const exact = String(marker ?? '');
  if (!LEADING_TURN_ORIGIN_RE.test(exact)) return null;
  const text = String(visible ?? '');
  if (text.includes(exact)) return null;
  const pattern = exact
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const match = new RegExp(pattern, 'u').exec(text);
  if (!match) return null;
  const whitespaceIn = (value) => (value.match(/\s/gu) ?? []).length;
  return Math.max(0, whitespaceIn(exact) - whitespaceIn(match[0]));
}

/** Read the user-message content from Claude, Codex, or OMP native row shapes. */
function nativeUserPromptContent(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : null;
  let content;
  if (row?.type === 'user' && row?.message?.role === 'user') content = row.message.content;
  else if (row?.type === 'response_item' && payload?.type === 'message' && payload?.role === 'user') {
    content = payload.content;
  } else if (row?.type === 'message' && row?.role === 'user') content = row.content;
  else if (row?.message?.role === 'user') content = row.message.content;
  else return null;
  if (Array.isArray(content)) {
    // Claude resume writes interrupted tool results as fresh user rows.
    // Tool output must neither end the first-task scan nor certify a marker;
    // genuine user text in a mixed row still owns that prompt's proof barrier.
    const promptBlocks = content.filter((block) => block?.type !== 'tool_result');
    return promptBlocks.length ? promptBlocks : null;
  }
  return content;
}

/** Flatten native user text blocks without reading metadata or assistant rows. */
function nativeUserPromptText(content, depth = 0) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object' || depth > 8) return '';
  if (Array.isArray(content)) return content.map((part) => nativeUserPromptText(part, depth + 1)).join('');
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string' || Array.isArray(content.content)) {
    return nativeUserPromptText(content.content, depth + 1);
  }
  return '';
}

/** Codex stores its injected AGENTS.md launch context as a user row before the
 * first task prompt. It is setup context, not a submitted task turn. */
/** WI-10005628: Claude Code records a local slash command typed before the kickoff
 * (the host's `/mcp` reconnect, `/clear`, …) as user rows ahead of the first task
 * prompt: an `isMeta` `<local-command-caveat>` row, then `<command-name>/mcp…` and
 * `<local-command-stdout>…`. They are not task turns. Treating the caveat as "the
 * first fresh task prompt" ended the scan before the real kickoff row (measured
 * su-fbcd9de3 20:11:08Z: the auditor was working 7s later and was still killed). */
const CLAUDE_LOCAL_COMMAND_ROW_RE =
  /^\s*<(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;
function isClaudeLocalCommandRow(row, text) {
  return row?.isMeta === true || CLAUDE_LOCAL_COMMAND_ROW_RE.test(String(text ?? ''));
}

function isNativeLaunchContextPrompt(text, agent) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (normalized.startsWith('# AGENTS.md instructions\n')) return true;
  // WI-10006270: Codex resume writes a separate environment setup user row
  // after AGENTS.md and before the kickoff. It must not end the first-task
  // proof scan. Only a complete standalone block is setup; owner text around
  // the tags, incomplete blocks, and other backends remain task prompts.
  return agent === 'codex' && /^<environment_context>\n[\s\S]*\n<\/environment_context>$/.test(normalized);
}

/** The ONE native-transcript scan behind marker and exact-prompt proofs.
 * An untagged Claude owner-request prompt qualifies only as an exact user row
 * in the newly minted native session. It does not gain a machine-origin tag.
 * With `allowTruncated`, a marker row may begin with a truncated suffix (see
 * truncatedTurnOriginMarkerLoss). All paths share the recency and native-id gates.
 * @returns {{nativeRef: string, lostChars: number} | null} */
function scanNativeTranscriptMarker({
  agent,
  env = process.env,
  marker,
  exactPrompt = null,
  sinceMs,
  home = homedir(),
  nativeId = null,
  allowTruncated = false,
}) {
  const root = nativeTranscriptRoot(agent, env, home);
  const expectedPrompt = typeof exactPrompt === 'string'
    ? exactPrompt.replace(/\r\n?/g, '\n').trimEnd()
    : '';
  if (!root || !existsSync(root) || (!marker && !expectedPrompt)) return null;
  // Generic text is not a unique marker. Require Claude's fresh native id and
  // match the entire user row; never certify an assistant echo or another file.
  if (expectedPrompt && (agent !== 'claude' || !nativeId ||
      !String(env?.CLAUDE_CONFIG_DIR ?? '').trim())) return null;
  const nonceTail = allowTruncated
    ? /nonce:([a-f0-9]{16,64})⟧$/i.exec(marker)?.[1]?.slice(-TRUNCATED_MARKER_MIN_NONCE_CHARS) ?? null
    : null;
  if (allowTruncated && !nonceTail) return null;
  const needle = expectedPrompt ? null : (allowTruncated ? nonceTail : marker);
  const markerBytes = needle ? Buffer.from(needle, 'utf8') : null;
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 4096) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 4096) break;
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < 10) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      // A carry-respawn mints a fresh native id. Restricting the proof to that
      // file prevents a coincidental marker in an older transcript from
      // certifying the successor that actually stayed mute.
      if (nativeId && !entry.name.includes(String(nativeId))) continue;
      try {
        const st = statSync(path);
        if (st.size < (markerBytes?.length ?? 1) || st.size > 64 * 1024 * 1024) continue;
        const body = readFileSync(path, 'utf8');
        let firstFreshTruncatedProof = null;
        for (const line of body.split(/\r?\n/)) {
          let row;
          try { row = JSON.parse(line); }
          catch { continue; }
          let userPromptText = null;
          if (expectedPrompt) {
            if (row?.type !== 'user' || row?.message?.role !== 'user' ||
                typeof row?.message?.content !== 'string') continue;
            // WI-10005628: a long typed prompt lands wrapped in a paste block.
            const nativePrompt = row.message.content.replace(/\r\n?/g, '\n').trimEnd();
            if (nativePrompt !== expectedPrompt &&
                unwrapWholePaste(nativePrompt).trimEnd() !== expectedPrompt) continue;
          } else {
            const userContent = nativeUserPromptContent(row);
            if (userContent == null) continue;
            userPromptText = nativeUserPromptText(userContent);
            if (isNativeLaunchContextPrompt(userPromptText, agent)) continue;
            if (isClaudeLocalCommandRow(row, userPromptText)) continue;
          }
          const rawTimestamp = row?.timestamp ?? row?.time ?? row?.createdAt ?? row?.created_at;
          let rowIsFresh = false;
          if (rawTimestamp != null) {
            let rowTimestampMs = typeof rawTimestamp === 'number'
              ? rawTimestamp
              : Date.parse(String(rawTimestamp));
            if (Number.isFinite(rowTimestampMs) && rowTimestampMs > 0 && rowTimestampMs < 10_000_000_000) {
              rowTimestampMs *= 1_000; // numeric Unix seconds
            }
            if (Number.isFinite(rowTimestampMs) && rowTimestampMs > 0) rowIsFresh = rowTimestampMs >= sinceMs;
            // An explicitly old or malformed row must never fall back to the
            // file's mtime; a later metadata append cannot refresh its proof.
            else continue;
          } else {
            // Legacy native rows without their own timestamp are usable only when
            // the transcript itself was created after this injection began.
            rowIsFresh = Number.isFinite(st.birthtimeMs) && st.birthtimeMs >= sinceMs;
          }
          if (!rowIsFresh) continue;
          if (expectedPrompt) return { nativeRef: path, lostChars: 0 };

          // The first fresh task prompt is the primary proof. If its marker lost
          // its head but kept this injection's nonce, only the immediately
          // following fresh user prompt may upgrade that degraded proof with
          // the exact marker. Any other prompt closes that upgrade window, so a
          // later unrelated user turn cannot certify this injection.
          const promptMarker = leadingTurnOriginMarker(userPromptText);
          // Managed session ports prove a checksum line in the submitted seed,
          // distinct from its leading turn-origin marker. Keep this within the
          // same first fresh user prompt and native-id fence; arbitrary text,
          // inline quotations and later user/assistant echoes are not proof.
          if (/^\[PAPERCUSP SESSION PORT CHECKSUM [a-f0-9]{64}\]$/.test(marker) &&
              unwrapWholePaste(userPromptText).replace(/\r\n?/g, '\n')
                .split('\n').some((line) => line.trim() === marker)) {
            return { nativeRef: path, lostChars: 0 };
          }
          if (promptMarker === marker) return { nativeRef: path, lostChars: 0 };
          const lostChars = truncatedTurnOriginMarkerLoss(marker, unwrapWholePaste(userPromptText));
          if (lostChars != null) {
            if (firstFreshTruncatedProof) return allowTruncated ? firstFreshTruncatedProof : null;
            firstFreshTruncatedProof = { nativeRef: path, lostChars };
            continue;
          }
          if (firstFreshTruncatedProof) return allowTruncated ? firstFreshTruncatedProof : null;
          break;
        }
        if (allowTruncated && firstFreshTruncatedProof) return firstFreshTruncatedProof;
      } catch {
        /* a concurrently-rotated transcript is simply not proof yet */
      }
    }
  }
  return null;
}

/** A carry requested in THIS turn may use its exact native completion as a
 * safe boundary even while the terminal keeps repainting. Never scan other
 * sessions or accept an older turn's completion. Missing/partial proof falls
 * back to the existing output gate. */
export function codexCarryTurnCompleted({ agent, env, transcriptPath, receivedAtMs }) {
  if (agent !== 'codex') return false;
  return nativeTurnCompletedInTranscript({ agent, env, transcriptPath, receivedAtMs });
}

/**
 * P-001/P-002 (psu-pty-turn-boundary-generalization-2026-09-22): the ONE
 * backend-agnostic native-transcript turn-boundary verifier. Everything that is
 * dangerous or fiddly — isolated-root resolution, symlink + containment guards,
 * the bounded tail read, partial-line rejection, the recency fence and error
 * containment — lives HERE, once. A backend contributes only a pure row
 * classifier, so a new agent can never re-introduce a subtly different copy of
 * the file/IO/safety logic (which is exactly how this stayed codex-only).
 *
 * @typedef {'turn-completed' | 'turn-started' | 'ignore'} TurnRowVerdict
 */

/** Bytes of transcript tail a boundary probe will read. */
const NATIVE_TURN_TAIL_BYTES = 256 * 1024;

/**
 * D-002: the per-session ISOLATED native-root env var per backend. A classifier
 * is reachable ONLY when its backend's isolated root is set.
 *
 * This is a safety gate, not a convenience. `nativeTranscriptRoot()` falls back
 * to the SHARED user-level home (`~/.codex`, `~/.claude`) when the per-session
 * var is absent — and "newest transcript wins" against a shared root would read
 * a DIFFERENT live session's completed turn and certify a boundary for a session
 * that is still mid-turn. That is the precise wedge this gate exists to prevent,
 * but with false authority, so it is strictly worse than no verifier at all.
 * Refusing here reproduces codex's original `!env?.CODEX_HOME` bail exactly.
 *
 * Measured 2026-09-22: 110 live processes carry a per-session
 * `CLAUDE_CONFIG_DIR=~/.papercusp/session-claude/role-<uuid>`
 * (psu-launcher.mjs `sessionClaudeConfigDir`, EI-155), so claude genuinely
 * satisfies this — it is not an aspiration.
 */
const NATIVE_ISOLATED_ROOT_ENV = Object.freeze({
  codex: 'CODEX_HOME',
  claude: 'CLAUDE_CONFIG_DIR',
});

/**
 * codex row classifier — the VERIFIED pre-existing logic, moved verbatim.
 *
 * A `task_complete`/`turn_completed` row that FAILS the fence returns
 * 'turn-started', not 'ignore'. That is deliberate and preserves the original
 * behaviour exactly: the old loop ASSIGNED `completed = <predicate>` on such a
 * row, so a failing predicate actively cleared a previously-latched completion.
 * 'ignore' would instead leave it latched — a real behaviour change, and in the
 * unsafe direction (an older completion could survive a newer failed one).
 *
 * @param {any} row
 * @param {{receivedAtMs: number, nowMs: number}} ctx
 * @returns {TurnRowVerdict}
 */
export function classifyCodexTranscriptRow(row, { receivedAtMs, nowMs }) {
  if (row?.type !== 'event_msg') return 'ignore';
  const kind = row.payload?.type;
  if (kind === 'task_started' || kind === 'user_message' || kind === 'turn_aborted') return 'turn-started';
  if (kind === 'task_complete' || kind === 'turn_completed') {
    const at = Date.parse(row.timestamp);
    const ok = Number.isFinite(at) && at >= receivedAtMs && at <= nowMs
      && typeof row.payload?.turn_id === 'string' && row.payload.turn_id.length > 0;
    return ok ? 'turn-completed' : 'turn-started';
  }
  return 'ignore';
}

/**
 * claude row classifier — D-003, derived from MEASUREMENT, not from porting the
 * codex rule (which would have been silently wrong here).
 *
 * Completion is `type:'assistant'` with `message.stop_reason === 'end_turn'`.
 * Measured over three real transcripts: 913 `tool_use` vs 29 `end_turn` on a
 * 3,071-row session — `end_turn` is rare and genuinely terminal.
 *
 * ⚠ The trap: Claude Code writes TOOL RESULTS as `type:'user'` rows (449 of 489
 * user rows on that same transcript; only 31 were real owner turns). Porting
 * codex's "user_message resets" rule literally would therefore reset the latch
 * once per tool call, so a user row resets only when it is a genuine turn start.
 *
 * ⚠⚠ BUT DO NOT OVERSTATE THE PAYOFF — D-009 retracts the original claim here,
 * which said the naive port "could never latch" and would return false FOREVER.
 * Measured (.papercusp/scratch/d003-divergence-probe.mts, replaying the
 * production tail window at every poll point of that 3,071-row transcript):
 * polls=3066, divergences=1 (0.03%). Claude Code always writes the `end_turn`
 * row AFTER the final tool_result, so each spurious reset is immediately
 * overwritten by the completion that follows it; a tool_result row following an
 * end_turn with no genuine start between occurs ZERO times in the file. The one
 * real divergence is the `isMeta` branch below, not this one.
 *
 * The carve-out stays anyway, and the reason is worth keeping straight: it makes
 * the classifier correct BY CONSTRUCTION rather than correct by luck of the
 * current row ordering. If a backgrounded tool ever lands a tool_result after an
 * end_turn, the naive port breaks catastrophically and this does not.
 *
 * Every other row type ('system', 'queue-operation', 'last-prompt', 'mode',
 * 'cost-state', 'attachment', …) must be 'ignore': several of them legitimately
 * occur AFTER the final `end_turn`, and resetting on one would discard a true
 * completion. This is why the contract is three-valued rather than boolean.
 *
 * @param {any} row
 * @param {{receivedAtMs: number, nowMs: number}} ctx
 * @returns {TurnRowVerdict}
 */
export function classifyClaudeTranscriptRow(row, { receivedAtMs, nowMs }) {
  if (row?.type === 'user') {
    if (row.isMeta) return 'ignore';
    const content = row.message?.content;
    // A tool RESULT is not a new owner turn, however much it looks like one.
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return 'ignore';
    return 'turn-started';
  }
  if (row?.type !== 'assistant') return 'ignore';
  if (row.message?.stop_reason !== 'end_turn') return 'ignore';
  const at = Date.parse(row.timestamp);
  // `uuid` is claude's structural analogue of codex's non-empty `turn_id`: a
  // row without one is malformed and must not certify a boundary.
  const ok = Number.isFinite(at) && at >= receivedAtMs && at <= nowMs
    && typeof row.uuid === 'string' && row.uuid.length > 0;
  return ok ? 'turn-completed' : 'turn-started';
}

/**
 * The registered row classifiers, by agent. Absent ⇒ unsupported backend.
 *
 * P-010: EXPORTED so the fixture test can ENUMERATE the registry rather than
 * hardcoding the two agents it happens to know about today. A registry no test
 * can enumerate is one that grows a third backend with no fixture and no
 * coverage, silently — and "silent" is the failure mode that matters here,
 * because an unverified classifier does not throw, it just returns false.
 *
 * ⚠ Do NOT cite D-003 as the authority for that, as this comment previously
 * did. D-009 RETRACTED D-003's "returns false FOREVER" mechanism for the naive
 * codex port — measured at polls=3066, divergences=1 (0.03%) — so D-003 is
 * superseded in part and reads as a stronger warrant than it is. The claim that
 * survives the measurement is narrower and is the one that actually motivates
 * this export: a classifier that is genuinely WRONG fails QUIETLY rather than
 * loudly, so absence of noise is not evidence of coverage. The enumerating
 * guard fails the moment a key is added without a captured transcript to prove
 * it against.
 */
export const TURN_ROW_CLASSIFIERS = Object.freeze({
  codex: classifyCodexTranscriptRow,
  claude: classifyClaudeTranscriptRow,
});

/**
 * P-002: is native turn-boundary verification available for this backend right
 * now, and if not, WHY? Pure and cheap — safe to call on every gated delivery.
 *
 * The two negative reasons are kept distinct on purpose. 'no-classifier' is a
 * permanent capability gap (omp/tui/pui have no verified completion marker and
 * one must NOT be invented); 'no-isolated-root' is a configuration state that a
 * correctly-launched session does satisfy. Collapsing them into one "not
 * supported" would hide a misconfigured claude session inside a population of
 * legitimately-unsupported omp ones.
 *
 * @param {string | undefined} agent
 * @param {EnvironmentMap} [env]
 * @returns {{supported: boolean, reason: 'no-classifier' | 'no-isolated-root' | null}}
 */
export function nativeTurnVerifierSupport(agent, env = process.env) {
  const key = NATIVE_ISOLATED_ROOT_ENV[/** @type {string} */ (agent)];
  if (!agent || !TURN_ROW_CLASSIFIERS[agent] || !key) {
    return { supported: false, reason: 'no-classifier' };
  }
  if (!env?.[key]) return { supported: false, reason: 'no-isolated-root' };
  return { supported: true, reason: null };
}

/** Open one transcript under the backend's isolated root, behind the shared
 * containment, symlink and regular-file guards. Both native readers below go
 * through this, so neither can accidentally certify another live session.
 * Returns an open fd the caller MUST close, or null. */
function openIsolatedNativeTranscript({ agent, env = process.env, transcriptPath, home = homedir() }) {
  if (!nativeTurnVerifierSupport(agent, env).supported || !transcriptPath) return null;
  let fd;
  try {
    const rootDir = nativeTranscriptRoot(agent, env, home);
    if (!rootDir) return null;
    const root = realpathSync(rootDir);
    const path = realpathSync(transcriptPath);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !path.endsWith('.jsonl')) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0) {
      closeSync(fd);
      return null;
    }
    return { fd, info };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    return null;
  }
}

/** Read a bounded, complete TAIL from one isolated transcript. Used by the
 * turn-boundary probe, which only needs the newest rows. */
function readIsolatedNativeTranscriptWindow(options) {
  const opened = openIsolatedNativeTranscript(options);
  if (!opened) return null;
  const { fd, info } = opened;
  try {
    const length = Math.min(info.size, NATIVE_TURN_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, info.size - length);
    let tailBytes = bytes.subarray(0, read);
    if (!tailBytes.length || tailBytes[tailBytes.length - 1] !== 0x0a) return null; // newest row is being written
    if (info.size > length) {
      const firstNewline = tailBytes.indexOf(0x0a);
      if (firstNewline < 0) return null; // the first complete row is outside the bounded window
      tailBytes = tailBytes.subarray(firstNewline + 1);
    }
    const rows = [];
    let cursor = 0;
    while (cursor < tailBytes.length) {
      const newline = tailBytes.indexOf(0x0a, cursor);
      if (newline < 0) return null;
      const line = tailBytes.subarray(cursor, newline).toString('utf8');
      if (line.trim()) rows.push(JSON.parse(line));
      cursor = newline + 1;
    }
    return rows;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Read parsed rows from the bounded native tail window. */
function readIsolatedNativeTranscriptRows(options) {
  return readIsolatedNativeTranscriptWindow(options);
}

/** WI-10004982: how far one launch-activity probe call reads FORWARD. It
 * matches the 64 MiB cap of the marker proof scan, so any transcript whose
 * marker the proof could find is one this probe can also read from the start. */
export const NATIVE_KICKOFF_SCAN_BYTES = 64 * 1024 * 1024;

/** Read COMPLETE rows FORWARD from a row boundary of one isolated transcript.
 * `fromOffset` must be 0 or the end offset of an earlier complete row; the
 * byte before it is checked to be a newline, so a stale or wrong offset is
 * refused rather than parsed mid-row. A trailing row still being written is
 * left out (it is not evidence yet) and `nextOffset` stops before it. Lines
 * are returned unparsed so a caller can prefilter cheaply. */
function readIsolatedNativeTranscriptForward({
  agent,
  env = process.env,
  transcriptPath,
  home = homedir(),
  fromOffset = 0,
  maxBytes = NATIVE_KICKOFF_SCAN_BYTES,
}) {
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0 || !(maxBytes > 0)) return null;
  const opened = openIsolatedNativeTranscript({ agent, env, transcriptPath, home });
  if (!opened) return null;
  const { fd, info } = opened;
  try {
    if (fromOffset > info.size) return null; // the file shrank under the anchor
    const lead = fromOffset > 0 ? 1 : 0;
    const start = fromOffset - lead;
    const length = Math.min(info.size - start, maxBytes + lead);
    const bytes = Buffer.alloc(length);
    const view = bytes.subarray(0, readSync(fd, bytes, 0, length, start));
    if (lead && view[0] !== 0x0a) return null; // not a row boundary
    const lines = [];
    let cursor = lead;
    while (cursor < view.length) {
      const newline = view.indexOf(0x0a, cursor);
      if (newline < 0) break; // still being written, or past the bound
      const text = view.subarray(cursor, newline).toString('utf8');
      if (text.trim()) lines.push({ text, startOffset: start + cursor, endOffset: start + newline + 1 });
      cursor = newline + 1;
    }
    return { lines, fileIdentity: `${info.dev}:${info.ino}`, size: info.size, nextOffset: start + cursor };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Is this native row the kickoff PROMPT itself?
 *
 * WI-10004982: for claude this must be the real `type:'user'` prompt row.
 * Claude also copies the prompt into other rows: `last-prompt` bookkeeping
 * rows (measured on transcript 98404f60: rows 14, 21 and 34, written before
 * AND after the reply) and a `queue-operation` row when the prompt is queued
 * behind a running turn. Binding to a queued copy would count the PREVIOUS
 * turn's assistant row as this kickoff's activity. Codex keeps the original
 * any-row match, because no codex copy written after the turn is measured. */
export function kickoffMarkerPromptRow(agent, row, markerText) {
  if (!markerText) return false;
  if (agent === 'claude') {
    if (row?.type !== 'user' || row.isMeta) return false;
    const content = row.message?.content;
    if (typeof content === 'string') return content.includes(markerText);
    if (!Array.isArray(content) || content.some((block) => block?.type === 'tool_result')) return false;
    return content.some((block) => typeof block?.text === 'string' && block.text.includes(markerText));
  }
  try { return JSON.stringify(row).includes(markerText); }
  catch { return false; }
}

/** Does this native row prove the model started working? */
function kickoffModelActivityRow(agent, row) {
  if (agent === 'codex') {
    if (row?.type === 'event_msg' &&
      ['task_started', 'task_complete', 'turn_completed'].includes(row.payload?.type)) {
      return true;
    }
    return row?.type === 'response_item' && row.payload?.type === 'message' && row.payload?.role === 'assistant';
  }
  return row?.type === 'assistant';
}

/** A plain launch's marker proves submission. A native task-start or assistant
 * row AFTER that exact marker proves model activity, including a short turn
 * that completed before the marker scan returned. PTY output is not used as
 * execution proof when this isolated transcript is available.
 *
 * WI-10004982: this reads FORWARD from the prompt row. It used to read only
 * the last 256 KiB, but a fresh Claude session writes rows far larger than
 * that right after the reply (measured: `instructions` 276 KB, then
 * `prompt_snapshot` rows of 168 KB and 258 KB). The window then started PAST
 * the reply, bound to a later `last-prompt` copy of the marker, saw no
 * assistant row, and the host re-sent the kickoff 40 s later as a duplicate
 * turn. Now the first call scans from the file start to the first real prompt
 * row and records it in `anchor`. Later calls re-check that exact row, then read
 * only the bytes not yet scanned (`anchor.scannedEndOffset`), so the cost stays
 * flat as the transcript grows.
 *
 * A `started:true` answer does not advance the cursor, so repeated calls keep
 * answering true. Every unreadable or inconsistent case returns
 * `available:false`, which keeps the existing retry path.
 *
 * @typedef {{fileIdentity: string | null, markerStartOffset: number | null,
 *   markerEndOffset: number | null, scannedEndOffset: number | null}} KickoffMarkerAnchor
 * @param {{agent?: string, env?: EnvironmentMap, transcriptPath?: string | null,
 *   marker?: string | null, markerLostChars?: number, anchor?: KickoffMarkerAnchor | null,
 *   home?: string, maxScanBytes?: number}} options
 * @returns {{available: boolean, started: boolean}} */
export function nativeKickoffTurnActivityAfterMarker({
  agent,
  env = process.env,
  transcriptPath,
  marker,
  markerLostChars = 0,
  anchor = null,
  home = homedir(),
  maxScanBytes = NATIVE_KICKOFF_SCAN_BYTES,
}) {
  const unavailable = { available: false, started: false };
  if (!['codex', 'claude'].includes(agent) || !marker) return unavailable;
  const markerText = markerLostChars > 0 ? marker.slice(markerLostChars) : marker;
  // The nonce tail is ASCII, so it prefilters raw lines no matter how the
  // backend escaped the brackets; the parsed row is then checked exactly.
  const prefilter = /([0-9a-f]{8,})⟧$/i.exec(markerText)?.[1] ?? markerText;
  const readOptions = { agent, env, transcriptPath, home };
  try {
    if (anchor?.fileIdentity) {
      const { markerStartOffset, markerEndOffset } = anchor;
      if (!Number.isSafeInteger(markerStartOffset) || !Number.isSafeInteger(markerEndOffset) ||
          markerEndOffset <= markerStartOffset) {
        return unavailable;
      }
      // Refuse unless the same file still holds the same prompt row.
      const head = readIsolatedNativeTranscriptForward({
        ...readOptions, fromOffset: markerStartOffset, maxBytes: markerEndOffset - markerStartOffset,
      });
      if (!head || head.fileIdentity !== anchor.fileIdentity || head.lines.length !== 1 ||
          head.lines[0].endOffset !== markerEndOffset ||
          !kickoffMarkerPromptRow(agent, JSON.parse(head.lines[0].text), markerText)) {
        return unavailable;
      }
      const from = Math.max(markerEndOffset, Number.isSafeInteger(anchor.scannedEndOffset) ? anchor.scannedEndOffset : 0);
      const rest = readIsolatedNativeTranscriptForward({ ...readOptions, fromOffset: from, maxBytes: maxScanBytes });
      if (!rest || rest.fileIdentity !== anchor.fileIdentity) return unavailable;
      for (const line of rest.lines) {
        if (kickoffModelActivityRow(agent, JSON.parse(line.text))) return { available: true, started: true };
      }
      anchor.scannedEndOffset = rest.nextOffset;
      return { available: true, started: false };
    }

    const scan = readIsolatedNativeTranscriptForward({ ...readOptions, fromOffset: 0, maxBytes: maxScanBytes });
    if (!scan) return unavailable;
    const markerIndex = scan.lines.findIndex(({ text }) =>
      text.includes(prefilter) && kickoffMarkerPromptRow(agent, JSON.parse(text), markerText));
    if (markerIndex < 0) return unavailable;
    const markerLine = scan.lines[markerIndex];
    if (anchor) {
      anchor.fileIdentity = scan.fileIdentity;
      anchor.markerStartOffset = markerLine.startOffset;
      anchor.markerEndOffset = markerLine.endOffset;
      anchor.scannedEndOffset = null;
    }
    for (const line of scan.lines.slice(markerIndex + 1)) {
      if (kickoffModelActivityRow(agent, JSON.parse(line.text))) return { available: true, started: true };
    }
    if (anchor) anchor.scannedEndOffset = scan.nextOffset;
    return { available: true, started: false };
  } catch {
    // A malformed complete row is not evidence either way.
    return unavailable;
  }
}

/** A queued kickoff retry may wait behind the original turn. At the final
 * write boundary only positive native execution proof cancels the retry;
 * missing or unreadable evidence preserves the existing bounded recovery. */
export function firstKickoffTurnStartedBeforeRetry(nativeTurnActivity) {
  if (typeof nativeTurnActivity !== 'function') return false;
  try { return nativeTurnActivity()?.started === true; }
  catch { return false; }
}

/**
 * Did the agent's native turn genuinely complete, per THIS transcript?
 *
 * Fail-soft by construction: every refusal path returns false, which falls back
 * to the existing output-silence gate rather than releasing an inject.
 *
 * @param {{agent?: string, env?: EnvironmentMap, transcriptPath?: string | null,
 *   receivedAtMs?: number, home?: string, nowMs?: number}} options
 */
export function nativeTurnCompletedInTranscript({
  agent,
  env = process.env,
  transcriptPath,
  receivedAtMs,
  home = homedir(),
  nowMs = Date.now(),
}) {
  if (!Number.isFinite(receivedAtMs)) return false;
  const rows = readIsolatedNativeTranscriptRows({ agent, env, transcriptPath, home });
  if (!rows) return false;
  const classify = TURN_ROW_CLASSIFIERS[/** @type {string} */ (agent)];
  let completed = false;
  for (const row of rows) {
    const verdict = classify(row, { receivedAtMs: /** @type {number} */ (receivedAtMs), nowMs });
    if (verdict === 'turn-completed') completed = true;
    else if (verdict === 'turn-started') completed = false;
  }
  return completed;
}

/** Return the newest regular native transcript beneath this session's ISOLATED
 * root (D-002). A resumed/carry chain can contain several native threads in the
 * same home, so an ordinary warm wake must follow the current writer rather
 * than pinning the predecessor path forever. Symlinks and paths outside the
 * root are never candidates; traversal shares the native-proof cap.
 *
 * P-001: generalized from the codex-only original. The isolated-root gate is
 * what makes "newest wins" safe — against a SHARED root it would happily return
 * another live session's transcript.
 *
 * @param {string | undefined} agent
 * @param {EnvironmentMap} [env]
 * @param {string} [home]
 * @returns {string | null}
 */
function newestNativeTranscriptPath(agent, env = process.env, home = homedir()) {
  if (!nativeTurnVerifierSupport(agent, env).supported) return null;
  const rootDir = nativeTranscriptRoot(agent, env, home);
  if (!rootDir) return null;
  let root;
  try { root = realpathSync(rootDir); }
  catch { return null; }
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  let newest = null;
  while (stack.length && visited < 4096) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 4096) break;
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < 10) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size === 0 || st.size > 64 * 1024 * 1024) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs || (st.mtimeMs === newest.mtimeMs && path > newest.path)) {
          newest = { path, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* a concurrently-rotated rollout is simply not a boundary candidate */
      }
    }
  }
  return newest?.path ?? null;
}

/** An ordinary warm Codex wake may use the CURRENT native turn's settled state
 * as its prompt boundary when idle TUI repaint prevents OUTPUT_QUIET_MS from
 * ever elapsing. Unlike the carry-specific probe above, this follows the newest
 * rollout in the session's isolated CODEX_HOME and accepts a completion that
 * predates the arriving wake. `completedAtOrAfterMs` fences out the preceding
 * completion after any newer owner/machine submit, so a mid-turn wake cannot
 * use stale history to bypass the anti-wedge gate. Missing/partial proof stays
 * false and falls back to the existing output-silence gate. */
export function codexLatestTurnCompleted({
  agent,
  env,
  completedAtOrAfterMs = 0,
}) {
  if (agent !== 'codex') return false;
  return nativeLatestTurnCompleted({ agent, env, completedAtOrAfterMs });
}

/**
 * P-001: the backend-agnostic form of the probe above — an ordinary warm wake
 * on ANY registered backend may use the current native turn's settled state as
 * its prompt boundary when idle TUI repaint prevents OUTPUT_QUIET_MS from ever
 * elapsing.
 *
 * This is the call that makes the fix real for claude. Before it, every
 * claude/omp session gated on output-silence alone — a proxy a repainting TUI
 * defeats by construction, which is why a wake could be deferred for the full
 * 180s cap against an agent that was in fact idle at its prompt.
 *
 * @param {{agent?: string, env?: EnvironmentMap, completedAtOrAfterMs?: number,
 *   home?: string, nowMs?: number}} options
 */
export function nativeLatestTurnCompleted({
  agent,
  env = process.env,
  completedAtOrAfterMs = 0,
  home = homedir(),
  nowMs = Date.now(),
}) {
  if (!Number.isFinite(completedAtOrAfterMs)) return false;
  const transcriptPath = newestNativeTranscriptPath(agent, env, home);
  return transcriptPath
    ? nativeTurnCompletedInTranscript({
      agent, env, transcriptPath, receivedAtMs: completedAtOrAfterMs, home, nowMs,
    })
    : false;
}

/**
 * @param {{agent: string, env?: EnvironmentMap, marker: string, sinceMs: number,
 *   home?: string, timeoutMs?: number, pollMs?: number, nativeId?: string | null}} options
 */
export async function waitForNativeTranscriptMarker({
  agent,
  env = process.env,
  marker,
  sinceMs,
  home = homedir(),
  timeoutMs = 30_000,
  pollMs = 250,
  nativeId = null,
}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const nativeRef = findNativeTranscriptMarker({ agent, env, marker, sinceMs, home, nativeId });
    if (nativeRef) return { persisted: true, nativeRef };
    // WI-10002745: the turn started even though its first characters were
    // lost. It is delivered, with degraded provenance the caller must report.
    const truncated = scanNativeTranscriptMarker({
      agent, env, marker, sinceMs, home, nativeId, allowTruncated: true,
    });
    if (truncated) {
      return {
        persisted: true,
        nativeRef: truncated.nativeRef,
        markerTruncated: { lostChars: truncated.lostChars },
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  return { persisted: false, nativeRef: null };
}

/** Prove an untagged owner-request carry without changing its owner authorship.
 * The exact user text must appear after the respawn in Claude's fresh native id.
 * This deliberately shares the bounded scanner and timestamp fence above. */
async function waitForNativeTranscriptPrompt({ agent, env, text, sinceMs, home, timeoutMs, nativeId }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const proof = scanNativeTranscriptMarker({ agent, env, exactPrompt: text, sinceMs, home, nativeId });
    if (proof) return { persisted: true, nativeRef: proof.nativeRef };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
  return { persisted: false, nativeRef: null };
}

/**
 * Prove that a provenance-tagged turn actually entered the backend's native
 * transcript. PTY output is not authority: pressing Enter can repaint the TUI
 * while leaving the staged text unsubmitted (EI-21653971965333993 / WI-2930).
 *
 * One raw-CR retry mirrors the operator's documented stuck-composer recovery.
 * Callers decide how to dispose a still-unverified child; this helper only
 * returns the execution-backed verdict. Pure apart from the injected wait/write
 * callbacks, so launch and carry paths share one tested contract.
 */
export async function verifyNativeTurnStartWithRetry({
  agent,
  env = process.env,
  text,
  sinceMs,
  home = homedir(),
  timeoutMs = 30_000,
  nativeId = null,
  requireNativeId = false,
  waitForMarker = waitForNativeTranscriptMarker,
  writeCr = () => {},
  onRetry = () => {},
}) {
  const marker = leadingTurnOriginMarker(text);
  const proofSupported = ['claude', 'codex', 'omp'].includes(String(agent || ''));
  // P-010 replays an unresolved owner's words as the first Claude prompt,
  // intentionally without a machine-origin envelope. The native session id,
  // exact user-row content and timestamp together prove that turn's submission.
  const exactOwnerPrompt = !marker && agent === 'claude' && Boolean(nativeId);
  if (!marker && !exactOwnerPrompt) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'missing-leading-turn-origin',
    };
  }
  if (requireNativeId && !nativeId) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'missing-native-id',
    };
  }
  if (!proofSupported) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'unsupported-backend',
    };
  }
  const readProof = () =>
    exactOwnerPrompt
      ? waitForNativeTranscriptPrompt({ agent, env, text, sinceMs, home, timeoutMs, nativeId })
      : waitForMarker({
      agent,
      env,
      marker,
      sinceMs,
      home,
      timeoutMs,
      nativeId,
    });
  // WI-10002745: carry a truncated-marker proof through so callers can
  // report the degraded provenance instead of silently treating it as exact.
  const truncation = (p) => (p?.markerTruncated ? { markerTruncated: p.markerTruncated } : {});
  let proof = await readProof();
  if (proof?.persisted) {
    return {
      persisted: true,
      nativeRef: proof.nativeRef ?? null,
      retried: false,
      reason: null,
      ...truncation(proof),
    };
  }
  try {
    onRetry({ marker, nativeId, proofKind: exactOwnerPrompt ? 'exact-prompt' : 'marker' });
  } catch {
    /* retry observability must never block the recovery keystroke */
  }
  try {
    writeCr();
  } catch {
    /* the child may have exited while native persistence was checked */
  }
  proof = await readProof();
  return {
    persisted: Boolean(proof?.persisted),
    nativeRef: proof?.nativeRef ?? null,
    retried: true,
    reason: proof?.persisted ? null : (exactOwnerPrompt ? 'native-turn-prompt-timeout' : 'native-turn-marker-timeout'),
    ...truncation(proof),
  };
}

/** WI-2140591: how long the host watches for the model to actually START the
 *  kickoff turn, once the native marker has proven the prompt was accepted.
 *
 *  The marker proof establishes SUBMISSION, never EXECUTION — and the two come
 *  apart exactly under load. Codex can accept the prompt, exhaust its sampling
 *  retries (`codex_core::responses_retry: stream disconnected — retrying
 *  sampling request 5/5, sampling_error="high demand"`) and then emit no
 *  assistant turn at all. The marker is still in the transcript, so the host
 *  printed "kickoff delivered" and returned, leaving a LIVE child idle forever:
 *  seven consecutive fleet goal holders on 2026-09-01 (12:29–14:02Z) each
 *  produced nothing but their boot `activity:report`.
 *
 *  Cadence deliberately mirrors the submit verifier (WI-2975): requiring an
 *  ENTIRE budget of ZERO new output is a far stronger "nothing happened" signal
 *  than a short quiet threshold, because a generating agent repaints its TUI
 *  continuously (spinner / elapsed counter) and a merely slow one still repaints
 *  while it retries. Set POLLS to 0 to disable the observation outright. */
const KICKOFF_TURN_START_POLL_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS) || 5_000;
const KICKOFF_TURN_START_POLLS = (() => {
  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and
  // silently removes the kill switch for a path every fleet launch runs.
  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 6;
})();

/**
 * Did the model actually begin the kickoff turn? A post-marker native transcript
 * row is authoritative when an isolated Codex/Claude transcript is available;
 * PTY output is only a fallback when native activity cannot be inspected.
 * @param {{lastOutputAt?: () => number, wait?: (ms: number) => Promise<any>,
 *   pollMs?: number, polls?: number,
 *   nativeTurnActivity?: (() => {available: boolean, started: boolean}) | null}} [options]
 *
 * A task-start/assistant row after the unique marker counts even if its PTY
 * bytes arrived before the post-proof baseline. A marker with no native activity
 * remains retryable; unsupported transcript formats keep the PTY fallback.
 *
 * Fails SAFE: a disabled or zero-length budget reports `started:true` with
 * `observed:false`, so a caller never takes recovery action on an observation
 * that never ran. Pure apart from the injected reader/wait.
 */
export async function observeKickoffModelTurnStart({
  lastOutputAt = () => 0,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = KICKOFF_TURN_START_POLL_MS,
  polls = KICKOFF_TURN_START_POLLS,
  nativeTurnActivity = null,
} = {}) {
  const budgetMs = Math.max(0, pollMs) * Math.max(0, polls);
  let nativeAuthority = false;
  const inspectNative = () => {
    if (typeof nativeTurnActivity !== 'function') return { available: false, started: false };
    try {
      const result = nativeTurnActivity();
      if (result?.available) nativeAuthority = true;
      return result ?? { available: false, started: false };
    } catch {
      return { available: false, started: false };
    }
  };
  const initialNative = inspectNative();
  if (initialNative.available && initialNative.started) {
    return { started: true, observed: true, polls: 0, budgetMs, reason: null };
  }
  if (!(pollMs > 0) || !(polls > 0)) {
    return { started: true, observed: false, polls: 0, budgetMs: 0, reason: 'observation-disabled' };
  }
  const baseline = Number(lastOutputAt()) || 0;
  for (let poll = 0; poll < polls; poll += 1) {
    await wait(pollMs);
    const native = inspectNative();
    if (native.available && native.started) {
      return { started: true, observed: true, polls: poll + 1, budgetMs, reason: null };
    }
    if (!nativeAuthority && (Number(lastOutputAt()) || 0) > baseline) {
      return { started: true, observed: true, polls: poll + 1, budgetMs, reason: null };
    }
  }
  return {
    started: false,
    observed: true,
    polls,
    budgetMs,
    reason: nativeAuthority
      ? 'no-native-turn-activity-after-kickoff'
      : 'no-model-output-after-kickoff',
  };
}

/** A carry-respawn can bind transcript proof to a native session id only when
 * the backend actually mints one. Claude does; Codex deliberately starts a
 * fresh thread without exposing its id, so its unique turn-origin marker plus
 * the post-respawn mtime floor is the strongest available native proof. Unknown
 * backends stay fail-closed. */
export function carryTurnProofRequiresNativeId(agent) {
  return String(agent ?? '').trim().toLowerCase() !== 'codex';
}

/** Is a carry failure safe to retry on a freshly minted child? Only transient
 * fresh-child failures qualify. Missing provenance/native-id is deterministic,
 * owner input must never be overwritten, and drills remain one-shot.
 * @param {object} [opts]
 * @param {string} [opts.drillId]
 * @param {string} [opts.reason]
 * @param {string|null} [opts.proofReason]
 * @param {number} [opts.retryCount]
 * @param {number} [opts.maxRetries]
 */
export function shouldRetryCarryOnFreshEpoch({
  drillId = '',
  reason = '',
  proofReason = null,
  retryCount = 0,
  maxRetries = 1,
} = {}) {
  if (drillId || retryCount >= maxRetries) return false;
  if (reason === 'never-settled' ||
      reason === 'no-startup-ready-marker' ||
      reason === 'no-startup-ready-marker-last-resort-failed' ||
      // A restart can outlast both bounded /mcp attempts on this child. The
      // fresh epoch reuses the same shared verifier rather than adding a loop.
      reason === 'carry-mcp-unavailable' ||
      // WI-10005106: a Codex child stuck at its `Starting` footer is a per-child
      // state; a fresh child usually boots in seconds.
      reason === 'codex-startup-still-starting') return true;
  return reason === 'turn-start-unverified' &&
    (proofReason === 'native-turn-marker-timeout' || proofReason === 'native-turn-prompt-timeout');
}

/** After writing an injected TURN's text, the host sends the submit Enter (CR)
 *  as a SEPARATE keystroke this long later. A single `text + CR` burst is
 *  swallowed by the Claude Code TUI's paste detector — the CR lands as a literal
 *  newline in the input box and the turn sits UNSUBMITTED until a human presses
 *  Enter ("the wake text appeared but the turn didn't start"). An isolated CR,
 *  arriving after the paste settles, registers as a real submit. */
const TURN_SUBMIT_CR_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS) || 150;
/** Codex's compose box needs a longer settle before the submit CR. With the
 *  Claude-tuned delay, live coord injections can leave the text sitting in
 *  Codex's input box until a human presses Enter. */
const CODEX_TURN_SUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS) || 500;
/** If Codex treats the first submit CR as paste/input, the text is visibly left
 *  in the compose box. A second delayed CR is the same manual action the user
 *  had to take, but delivered by the host. Codex-only; Claude/OMP stay single-CR. */
const CODEX_TURN_RESUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS) || 300;

/** WI-2930 submit VERIFICATION. An injected submit's CR can be SWALLOWED on any
 *  backend — the paste-settle race exists on Claude too, and a compact/reset
 *  carry can be typed into a TUI whose submission is momentarily locked (the
 *  agent-busy gate reads "compaction done" off output-quiet, which a silent
 *  summarizer gap / the post-compaction context-restore can fake). The failure
 *  is invisible-but-fatal: the turn text sits staged in the composer and the
 *  session parks until a human presses Enter (owner-reported, 6h stall).
 *  So after the FINAL CR of any injected submit the host VERIFIES instead of
 *  firing-and-forgetting: it polls the pty-output activity for a bounded window
 *  and, at each poll that finds the output QUIET (no turn running — a submitted
 *  turn repaints continuously), injects one bare resubmit CR. A bare CR at an
 *  idle prompt with an EMPTY composer is a no-op, so a redundant resubmit is
 *  harmless; one with staged text is exactly the Enter a human would press.
 *  WI-2975 ADDENDUM: "harmless" covered the retype-safety, not the noise — the
 *  quiet check originally reused OUTPUT_QUIET_MS (the busy-gate's short
 *  "back-at-prompt" threshold), so an ordinary silent thinking/latency gap
 *  after a genuine submit was misread as a stall on nearly every compaction,
 *  printing spurious "submit not confirmed" resubmit lines even on a fully
 *  successful compact + carry-note. The verifier now uses its own, larger,
 *  independently-tunable SUBMIT_VERIFY_QUIET_MS for that check. */
const SUBMIT_VERIFY_POLL_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS) || 5_000;
const SUBMIT_VERIFY_POLLS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS) || 6;
const SUBMIT_VERIFY_MAX_RESUBMITS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR) || 3;
/** WI-2975: the verifier's OWN "is a turn genuinely running" quiet threshold —
 *  deliberately DECOUPLED from OUTPUT_QUIET_MS. OUTPUT_QUIET_MS is tuned SHORT
 *  (1500ms) for a different question — "has the agent gone back to an idle
 *  prompt?" — where reacting fast matters. Reusing that same short threshold
 *  here was the bug: a genuinely-submitted turn commonly goes silent for
 *  several seconds (network latency / silent "thinking" before the first
 *  repaint, especially right after a large-transcript /compact), which is
 *  completely normal — but at 1500ms almost ANY such gap landing on a 5s poll
 *  boundary read as "nothing happened" and fired a resubmit CR. Live evidence
 *  (WI-2975): a fully successful /compact + carry-note + COMPACTED-RESUMED
 *  STILL printed three "submit not confirmed" resubmit lines — pure noise,
 *  every single compaction, on every backend (not only omp/codex). Defaulting
 *  this to a full poll interval means "quiet" requires an ENTIRE poll cycle of
 *  zero output — a much stronger "truly nothing happened" signal — while a
 *  submit that really was swallowed is still caught within the same bounded
 *  window (just one poll later). Env-tunable independently of both
 *  OUTPUT_QUIET_MS and SUBMIT_VERIFY_POLL_MS. */
const SUBMIT_VERIFY_QUIET_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS) || 6_000;

/** Mid-turn inject safety (coord-wake-mid-turn-2026-06-30). A wake `turn` (text +
 *  CR) written into a TUI that is MID-TURN — the agent is generating / mid
 *  tool-call — wedges the turn: the line lands as queued/garbled input and the
 *  session needs a manual ESC to recover. THIS was the multi-recipient
 *  `coord:send {wake:'required'}` broadcast hang — a broadcast wakes/keeps-busy
 *  many sessions at once, so a wake is far more likely to land on a mid-turn
 *  recipient (and the always-armed inbox-wake await is re-armed on every tool
 *  call, so a working agent is still wakeable). The host's existing idle gate only
 *  defers on the HUMAN's keystrokes (makeIdleGate) — it never sees the agent's
 *  turn state. The pty OUTPUT stream IS that state: a generating agent repaints
 *  its TUI constantly (spinner / elapsed-time counter), an idle-at-prompt agent is
 *  silent (agent-liveness-heartbeat-hardening P-006). So the host ALSO defers a
 *  `turn` inject until the agent's output has been quiet this long — i.e. it is
 *  back at its prompt. Must exceed the agent's busy repaint cadence (Claude Code's
 *  elapsed counter repaints ~1/s) so a working agent never reads as idle. */
const OUTPUT_QUIET_MS = Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS) || 1500;
/** Cap on how long a `turn` inject waits for the agent to return to its prompt.
 *  On cap we DO NOT write into the still-busy turn (that is the wedge) — we DROP
 *  the live inject: the wake message is already durably in the recipient's inbox
 *  and is seen on its next natural turn ("queue to next-turn", the sanctioned safe
 *  default). Generous by default so a normal multi-minute turn still gets a clean
 *  live re-invoke the moment it ends; only a pathologically long turn drops. */
const TURN_INJECT_BUSY_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS) || 180_000;

/** RESET-CONTEXT settle (su-cold-auto-mode P-004a). After the host submits the
 *  context-clear command (`/clear`) it waits this long before typing the
 *  carry-note turn, so the TUI has processed the clear and repainted a fresh
 *  prompt. Too short and the carry text lands in the clearing/animating TUI;
 *  the clear itself is fast, so this is a repaint budget, not a compute one. */
const CLEAR_SETTLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS) || 1_500;
/** How long a RECYCLE waits for the killed child to actually exit before it
 *  spawns the fresh one, so we never double-spawn into a still-dying pty
 *  (su-cold-auto-mode P-004b). Fail-safe: on cap we spawn anyway (the old pid is
 *  being torn down regardless). */
const RECYCLE_KILL_TIMEOUT_MS = Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS) || 5_000;
/** After the graceful recycle signal's cap, give the forced process-tree kill a
 * short bounded hand-off window to report the pty child exit before spawning its
 * successor. SIGKILL itself is the lifetime fence; this wait only lets node-pty
 * reap the leader cleanly when it can. */
const RECYCLE_FORCE_KILL_WAIT_MS = Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS) || 1_000;

/**
 * Bound the launcher-side respawn re-anchor acknowledgement. The callback is
 * awaited before the successor's metadata, output wiring, and carry delivery
 * are published, so those observations cannot get ahead of the authoritative
 * adv-session mapping. A broken operator request must not hold a live successor
 * forever, though; after this deadline the host records the miss and continues
 * the ordinary respawn path.
 */
const RESPAWN_REPORT_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS) || 2_500;

/** WI-1941: total wall-clock budget the recycle carry-note inject retries across
 *  before it is dropped LOUDLY. A fresh COLD child can stay busy past one
 *  agent-busy cap (large compacted-context replay, MCP load, an auto-continued
 *  boot turn) and THEN settle — the old single-shot waitAtPrompt() dropped the
 *  iteration SILENTLY the instant it first deferred ('the wc8 recycle left no
 *  trace'). Generous, but kept < the loop interval so a retry can't outrun the
 *  next scheduled wake. Env-overridable like the sibling timings. */
const RECYCLE_CARRY_INJECT_BUDGET_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS) || 600_000;
/** Backoff between deferred carry-inject attempts (WI-1941). Each attempt's
 *  agent-busy cap already paces the bulk of the wait; this just avoids a tight
 *  requeue when an attempt defers fast. */
const RECYCLE_CARRY_RETRY_BACKOFF_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS) || 3_000;
/** WI-10004943 (d): hard ceiling on how long a fresh Codex LAUNCH KICKOFF is held
 *  past its ordinary budget while the Codex footer positively reads `Starting`.
 *  The footer means the TUI is alive and its composer is still unavailable (MCP
 *  servers booting), so dropping the kickoff at the 600s budget threw the session's
 *  first turn away and left it idle at its prompt. Measured in production: the
 *  footer read `Starting` for 10-20 minutes before the session frame appeared.
 *  30 minutes covers that with margin. Measured from the start of the kickoff
 *  attempt, not from the end of the ordinary budget. Env-overridable. */
const CODEX_STARTING_KICKOFF_HOLD_CEILING_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS) || 1_800_000;
/** WI-10005106: how long a recycle CARRY child may sit at the Codex `Starting`
 *  footer before the host stops waiting on it and retries the carry on a fresh
 *  child epoch (only while such a retry remains; the last attempt holds like a
 *  launch kickoff instead). Measured 2026-10-01 from ~/.papercusp/psu-pty event
 *  logs: over 3,368 Codex boots, footer-to-frame was p50 3s, p99 296s; of the 41
 *  boots slower than 120s, 28 were slower than 600s, so a child that is still
 *  `Starting` after a few minutes is usually stuck. A fresh successor booted at
 *  p50 1s, p90 3s (42 of 43 under 300s). Every one of the 59 carry/kickoff drops
 *  had at least 3 other sessions' Codex children booting in under 60s inside the
 *  same window, so the stuck state belongs to the child, not to a shared outage:
 *  replacing the child fixes it, while waiting cost 10-50 minutes. Env-overridable. */
const CODEX_CARRY_STARTING_STUCK_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS) || 180_000;
/** WI-10004943: how many times a plain fresh Codex LAUNCH KICKOFF may replace a
 *  child still at the `Starting` footer after CODEX_CARRY_STARTING_STUCK_MS (the
 *  same measured threshold, same env override) before its last attempt falls back
 *  to the (d) hold. Measured 2026-10-01: the hold alone rescued 0 of 3 stuck
 *  launches in 36h (all still `Starting` at the hold ceiling), while a fresh child
 *  boots in seconds (see CODEX_CARRY_STARTING_STUCK_MS). Per-host override:
 *  PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES; `0` turns the replacement off. */
const CODEX_LAUNCH_STARTING_FRESH_CHILD_RETRIES = 1;

/** WI-10004943: the per-host retry budget for a launch kickoff's fresh-child
 *  replacement. A missing, empty, or malformed value keeps the default; an explicit
 *  integer >= 0 wins, so `0` is the kill switch. Pure; exported for tests.
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function codexLaunchStartingRetryMax(value, fallback = CODEX_LAUNCH_STARTING_FRESH_CHILD_RETRIES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** WI-10004943: should an undelivered launch kickoff be retried on a fresh child?
 *  Only a plain fresh Codex launch qualifies: a managed kickoff (session-port seed)
 *  has a native-transcript proof that owns its own timeout and child kill, and a
 *  resume/fork may already be running a turn. Only the stuck `Starting` footer
 *  qualifies, because that state belongs to the child: every measured drop had other
 *  sessions' Codex children booting in under 60s alongside it. Pure; exported for tests.
 * @param {object} [opts]
 * @param {string} [opts.agent]
 * @param {string} [opts.reason]
 * @param {boolean} [opts.managedKickoff]
 * @param {boolean} [opts.isResume]
 * @param {number} [opts.retryCount]
 * @param {number} [opts.maxRetries]
 */
export function shouldRetryLaunchKickoffOnFreshChild({
  agent = '',
  reason = '',
  managedKickoff = false,
  isResume = false,
  retryCount = 0,
  maxRetries = 0,
} = {}) {
  if (managedKickoff || isResume || retryCount >= maxRetries) return false;
  if (String(agent ?? '').trim().toLowerCase() !== 'codex') return false;
  return reason === 'codex-startup-still-starting';
}

/** EI-24818010361425604: how many times one launch kickoff may follow its owner
 *  into the successor of a same-host respawn. One: a successor that is itself
 *  replaced before its kickoff lands is a respawn loop, not a delivery problem. */
export const LAUNCH_KICKOFF_RESPAWN_REDELIVERY_MAX = 1;

/** EI-24818010361425604: should an undelivered launch kickoff be re-delivered to
 *  the successor of a same-host respawn? `superseded` means THIS host replaced the
 *  child the kickoff targeted (a managed carry-respawn, a loop recycle) while the
 *  kickoff was in flight. The owner continues in the successor, so the kickoff
 *  belongs there; publishing `kickoff-not-submitted:superseded` instead makes the
 *  launching parent kill the task, successor included. Measured 2026-10-02
 *  20:44Z: a resumed Codex thread's first turn tripped native auto-compaction,
 *  the PreCompact bridge turned it into a managed carry-respawn 1s after the
 *  kickoff was written, and capability:launch-agent stopped the healthy successor.
 *  A host that is tearing down has no successor, and a managed kickoff's native
 *  transcript proof owns its own verdict and child kill. Pure; exported for tests.
 * @param {object} [opts]
 * @param {string} [opts.reason]
 * @param {boolean} [opts.managedKickoff]
 * @param {boolean} [opts.hostShuttingDown]
 * @param {number} [opts.redeliveries]
 * @param {number} [opts.maxRedeliveries]
 */
export function shouldRedeliverLaunchKickoffAfterRespawn({
  reason = '',
  managedKickoff = false,
  hostShuttingDown = false,
  redeliveries = 0,
  maxRedeliveries = LAUNCH_KICKOFF_RESPAWN_REDELIVERY_MAX,
} = {}) {
  if (managedKickoff || hostShuttingDown) return false;
  if (redeliveries >= maxRedeliveries) return false;
  return reason === 'superseded';
}

/** WI-10004943: the Codex `Starting` options for one launch-kickoff attempt. While a
 *  fresh-child retry remains, give up early on a child still at `Starting` after
 *  `stuckMs` so the host can replace it (the WI-10005106 carry remedy). The last
 *  attempt, and any launch that cannot be retried, keeps the (d) hold for the frame.
 *  Pure; exported for tests.
 * @param {object} [opts]
 * @param {string} [opts.agent]
 * @param {boolean} [opts.managedKickoff]
 * @param {boolean} [opts.isResume]
 * @param {number} [opts.retryCount]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.stuckMs]
 * @param {number} [opts.holdCeilingMs]
 */
export function launchKickoffCodexStartingOptions({
  agent = '',
  managedKickoff = false,
  isResume = false,
  retryCount = 0,
  maxRetries = 0,
  stuckMs = CODEX_CARRY_STARTING_STUCK_MS,
  holdCeilingMs = CODEX_STARTING_KICKOFF_HOLD_CEILING_MS,
} = {}) {
  const retryRemains = shouldRetryLaunchKickoffOnFreshChild({
    agent,
    managedKickoff,
    isResume,
    retryCount,
    maxRetries,
    reason: 'codex-startup-still-starting',
  });
  return retryRemains
    ? { codexStartingStuckMs: stuckMs }
    : { codexStartingHoldCeilingMs: holdCeilingMs };
}
/** Native transcript proof or MCP readiness can lag a freshly painted TUI.
 * Give the carry one fresh child epoch to retry the whole submission before
 * recording a terminal drop. Each epoch uses the existing bounded two-attempt
 * MCP verifier; persistent failures remain loud. */
const CARRY_PROOF_RETRY_MAX = 1;
/** A backend readiness marker is the strongest proof that its composer exists,
 * but it is not a permanent liveness dependency. UI chrome changes across CLI
 * releases, so a healthy successor can emit output forever without matching
 * the marker. After this much time from the successor's FIRST output, fall back
 * to the ordinary output-quiescence proof. The delay remains longer than the
 * observed Codex onboarding/typewriter animation; the quiet gate still has to
 * pass before any carry text is written. */
const STARTUP_MARKER_FALLBACK_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS) || 15_000;

/** EI-22123519641932348: bounded watchdog on the inject-mutex hold itself
 *  (makeInjectMutex — EI-8822). Every individual gate/verify step downstream
 *  of acquire() (idle/composer/busy gates, submit verifier, recycleChild's
 *  kill+respawn+carry sequence) is independently bounded — confirmed by
 *  reading each one — but `acquire()`'s own `await prev` has NO bound: if any
 *  holder's critical section fails to reach its `finally` release for a
 *  reason none of those bounds cover, every later gated inject (a wake
 *  `turn`, a recycle, a session:request-compaction carry-respawn) queues
 *  BEHIND it silently and forever — observed live as a ~6h TOTAL SILENCE in
 *  one host's event log (zero rows of any kind, vs a ~3.5/hr baseline),
 *  spanning 4 stacked wake fires that all reported `delivered` yet started no
 *  turn. WARN_MS must clear the legitimate worst case with real margin: the
 *  slowest single hold is a `carry-respawn` recycle — kill (RECYCLE_KILL_
 *  TIMEOUT_MS) + force-kill wait (RECYCLE_FORCE_KILL_WAIT_MS) + the carry
 *  inject's own budget (RECYCLE_CARRY_INJECT_BUDGET_MS, 10min by design) +
 *  submit verification (~SUBMIT_VERIFY_POLLS × SUBMIT_VERIFY_POLL_MS) ≈ ~11min
 *  — so WARN_MS sits well above that (loud, cheap, no side effect beyond a
 *  host-event + stderr line) and FORCE_RELEASE_MS sits far above WARN_MS (a
 *  force-release lets the NEXT waiter's acquire() proceed as though the
 *  wedged holder had released; the wedged holder's own eventual/never release
 *  call becomes a harmless no-op on an already-superseded tail promise — see
 *  makeInjectMutex's doc comment). Any real force-release is still a rare,
 *  loud, diagnosable event — a session dark for tens of minutes instead of
 *  hours (or forever) is the trade this makes. */
const INJECT_MUTEX_WARN_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_WARN_MS) || 900_000; // 15min
const INJECT_MUTEX_FORCE_RELEASE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_FORCE_RELEASE_MS) || 2_700_000; // 45min

/** EI-18109211232286833: max age a `carry-respawn` control message may reach
 *  before delivery, measured from the moment this host first received it
 *  (`msg.receivedAtMs`, stamped in `conn.on('end')`) to the instant it is
 *  ABOUT to be delivered (immediately before `recycleChild`, in both the
 *  first attempt and its one `makeCarryRearmController` retry — both legs
 *  reuse the same `msg` object, so this measures TOTAL elapsed wait, not
 *  per-attempt). A `session:request-compaction` carry-respawn never carries
 *  `routineId`/`fireNumber` (WI-5510's stale-fire guard is a structural no-op
 *  for it — loop-fire wakes are the only sender that stamps those fields), so
 *  a single message held stale-long by the busy-gate re-arm previously delivered
 *  an outdated carry document with no staleness check at all — the live instance
 *  of the EI-15777 wake-churn family this guards against (see isCarryRespawnStale).
 *  WI-5623: a PRODUCTION carry-respawn now RE-POLLS across successive busy-gate
 *  windows (makeCarryRearmController) instead of dropping after one retry — an
 *  autonomous/headless session is near-continuously busy and rarely presents the
 *  1.5s idle window inside a single window, so a pending respawn must SURVIVE long
 *  enough to catch the session's next idle/recycle boundary (fleet bug-drain
 *  members recycle their window ~every 22-33min). The old 10-min cap dropped every
 *  such respawn just before that boundary (0/22 delivered), so the default is now
 *  30 minutes — past the fleet recycle cadence, still bounding a genuinely stale
 *  carry (the successor re-orients via coord:orient { afterCompaction }, so a
 *  modestly-old carry is fine; a >30-min-busy session is pathological and
 *  stale-drops to the hard-wall watchdog). Env-overridable. */
const CARRY_RESPAWN_MAX_AGE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS) || 1_800_000;

/** Orphan watchdog poll (WI-3141). A bridged interactive host exists ONLY to
 *  bridge the user's terminal to the agent under psu's own pty; once its
 *  launching shell dies it has no human to serve and MUST tear down — else it
 *  lingers as an orphan forwarding its live child's output to a /dev/pts fd the
 *  OS has recycled to the owner's NEXT terminal (the 2026-07-05 "random
 *  characters appear without typing" report). SIGHUP is the nominal signal but
 *  is NOT reliably delivered on a WSL/console-session teardown (the orphan was
 *  reparented to init with no SIGHUP), so this cheap unref'd poll is the
 *  belt-and-suspenders: only a TRANSITION to init (ppid 1) triggers teardown, so
 *  a host deliberately launched under init is left alone. Env-tunable. */
const ORPHAN_POLL_MS = Number(process.env.PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS) || 2_000;

/** Filename-safe key for an ownerId (SIDs are already `[a-z0-9-]`-ish, but a
 *  defensive sanitize keeps a stray char from escaping the dir). Pure. */
export function sanitizeKey(ownerId) {
  return String(ownerId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Parse the visible console shell pid inherited from console-spawn. This is a
 *  discovery candidate only; fleet:kill revalidates its boot/process-start
 *  identity and harness marker immediately before sending any signal. */
export function terminalPidFromEnv(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** EI-10412: per-owner durable host-event log. The host's stderr is the owner's
 *  terminal (/dev/pts/N) — every lifecycle diagnostic written there is LOST the
 *  moment the screen repaints, which is why the 2026-07-12 carry-note-drop
 *  epidemic (10 lost auto-continuations across 7 agents in one day) had to be
 *  reconstructed from transcript archaeology. Lifecycle verbs (compact/reset/
 *  recycle) now ALSO append one JSONL row per outcome here, so "did the carry
 *  ever get typed, and if not why" is a one-file read. */
export function eventLogPathForOwner(ownerId, dir = PSU_PTY_DIR) {
  return join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
}

/** Size cap for the per-owner event log — front-truncated (oldest rows dropped)
 *  on breach, same spirit as the turn-provenance ledger compaction. */
const EVENT_LOG_MAX_BYTES = 256 * 1024;

/** The persona-refresh `reason` the operator returns when a restart would activate a
 *  priced Cupboard identity that has no funds behind it and cannot be dropped from the
 *  stack (agent-economy-flywheel P-016, D-012). The respawn is refused on it, never
 *  fail-soft. Mirrors IDENTITY_ACTIVATION_REFUSED_REASON in
 *  packages/operator-core/lib/cupboard/identity-activation-restart.ts. */
export const IDENTITY_ACTIVATION_REFUSED_REASON = 'identity-activation-refused';

/** Append one durable host-event row ({ ts, kind, ...extra }) for `ownerId`.
 *  FAIL-SOFT by contract: an event-log write must never break the session —
 *  any fs error is swallowed (the stderr diagnostic still fires next to it). */
export function appendHostEvent(ownerId, kind, extra = {}, dir = PSU_PTY_DIR) {
  try {
    const p = eventLogPathForOwner(ownerId, dir);
    const row = JSON.stringify({ ts: new Date().toISOString(), kind, ...extra });
    try {
      if (statSync(p).size > EVENT_LOG_MAX_BYTES) {
        const tail = readFileSync(p, 'utf8');
        writeFileSync(p, tail.slice(Math.floor(tail.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      /* no log yet — the append below creates it */
    }
    appendFileSync(p, row + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** EI-24353430528930250: process-scoped startup evidence for Codex's isolated
 * SQLite homes. Host-wide paging samples could not distinguish the failed
 * launch wave from a later successful one. */
export function readLinuxStartupCounters(pid, readFile = readFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat;
  try {
    stat = readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0 || stat[close + 1] !== ' ') return null;
  // /proc/PID/stat has a parenthesized comm that can contain spaces or ')'.
  // The remaining array starts at field 3 (state); majflt is field 12 and
  // delayacct_blkio_ticks is field 42.
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const numberAt = (field) => {
    const value = Number(fields[field - 3]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const majorFaults = numberAt(12);
  if (majorFaults === null) return null;
  let io = '';
  try {
    io = readFile(`/proc/${pid}/io`, 'utf8');
  } catch {
    // The stat counters remain useful if procfs denies the optional IO file.
  }
  const ioNumber = (key) => {
    const match = io.match(new RegExp(`^${key}:\\s*(\\d+)$`, 'm'));
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  return {
    pid,
    comm: stat.slice(stat.indexOf('(') + 1, close).slice(0, 64),
    majorFaults,
    blockIoTicks: numberAt(42),
    readBytes: ioNumber('read_bytes'),
    writeBytes: ioNumber('write_bytes'),
  };
}

/** Resolve the Rust Codex runtime behind the npm/node launcher that owns the
 * PTY. The launcher stays alive for the whole session, so sampling its PID
 * produces a confident but irrelevant zero-IO trace. Linux exposes a cheap,
 * race-tolerant descendant index at /proc/PID/task/PID/children; walk only a
 * few generations and accept a process whose kernel comm identifies Codex. */
export function resolveLinuxCodexStartupPid(rootPid, {
  readFile = readFileSync,
  readCounters = readLinuxStartupCounters,
  maxDepth = 4,
} = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const queue = [{ pid: rootPid, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.pid)) continue;
    seen.add(current.pid);
    const counters = readCounters(current.pid, readFile);
    if (counters && (counters.comm === 'codex' || counters.comm?.startsWith('codex-'))) {
      return current.pid;
    }
    if (current.depth >= maxDepth) continue;
    let children = '';
    try {
      children = readFile(`/proc/${current.pid}/task/${current.pid}/children`, 'utf8');
    } catch {
      continue;
    }
    for (const token of String(children).trim().split(/\s+/)) {
      if (!token) continue;
      const childPid = Number(token);
      if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) {
        queue.push({ pid: childPid, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

/** Bound the trace to startup, stop it on child replacement, and never let a
 * diagnostic timer keep a finished agent alive. One row every 500 ms for at
 * most 30 s is small enough for the existing capped per-owner event log. */
export function startCodexStartupProcessTrace({
  agent,
  ownerId,
  pid,
  readCounters = readLinuxStartupCounters,
  resolveTargetPid = resolveLinuxCodexStartupPid,
  emit = appendHostEvent,
  now = Date.now,
  interval = setInterval,
  clear = clearInterval,
  platform = process.platform,
} = {}) {
  if (agent !== 'codex' || platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) {
    return () => {};
  }
  const startedAt = now();
  let samples = 0;
  let targetPid = null;
  let stopped = false;
  let timer;
  const sample = () => {
    if (stopped) return;
    const elapsedMs = now() - startedAt;
    let counters = targetPid === null ? null : readCounters(targetPid);
    if (targetPid === null || counters === null) {
      const resolved = resolveTargetPid(pid, { readCounters });
      if (Number.isInteger(resolved) && resolved > 0 && resolved !== targetPid) {
        targetPid = resolved;
        emit(ownerId, 'codex-startup-process-target-selected', { rootPid: pid, pid: targetPid, elapsedMs });
      }
      counters = targetPid === null ? null : readCounters(targetPid);
    }
    if (counters) {
      samples++;
      emit(ownerId, 'codex-startup-process-sample', { elapsedMs, rootPid: pid, ...counters });
    }
    if (elapsedMs >= 30_000) stop(samples > 0 ? 'window-ended' : 'target-not-found');
  };
  const stop = (reason = 'child-exit') => {
    if (stopped) return;
    stopped = true;
    if (timer) clear(timer);
    emit(ownerId, 'codex-startup-process-trace-ended', {
      rootPid: pid, pid: targetPid, elapsedMs: now() - startedAt, samples, reason,
    });
  };
  sample();
  if (!stopped) {
    timer = interval(sample, 500);
    timer.unref?.();
  }
  return stop;
}

/* WI-10004943 (b): evidence for WHY a Codex child sits at its `Starting` footer.
 * Codex starts a fresh CODEX_HOME/log/codex-tui.log at every launch (measured
 * 2026-10-01: in every su-codex-home, log/'s mtime equals the file's first
 * line), so the stuck child's own log is destroyed by the very respawn that
 * replaces it, and the 30s startup trace ends long before a 180-600s stall is
 * declared. Snapshot the evidence at the drop instead: the log tail plus the
 * child's process tree, where Codex's MCP servers live, with each process's
 * state and kernel wait channel. Host events reach a shared store, so every
 * string is bounded and credential-shaped values are redacted. */
const SNAPSHOT_SECRET_KEY = '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[-_]?key|authorization|cookie|credential)[A-Za-z0-9_.-]*';
const SNAPSHOT_SECRET_FLAG_RE = new RegExp(`^--?${SNAPSHOT_SECRET_KEY}$`, 'i');
const SNAPSHOT_SECRET_PAIR_RE = new RegExp(`(${SNAPSHOT_SECRET_KEY})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"']+)`, 'gi');

export function redactSnapshotText(text, maxChars = 240) {
  const s = String(text ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '<redacted>')
    .replace(SNAPSHOT_SECRET_PAIR_RE, '$1$2<redacted>');
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** argv -> one bounded, redacted string. A credential-named flag also redacts
 * the separate argument that follows it (`--token abc`). */
export function redactSnapshotArgv(argv, { maxArgs = 6, maxChars = 200 } = {}) {
  const out = [];
  let redactNext = false;
  for (let i = 0; i < argv.length; i++) {
    if (out.length >= maxArgs) {
      out.push(`…+${argv.length - i}`);
      break;
    }
    const arg = String(argv[i]);
    if (redactNext) {
      out.push('<redacted>');
      redactNext = false;
      continue;
    }
    if (SNAPSHOT_SECRET_FLAG_RE.test(arg)) redactNext = true;
    out.push(redactSnapshotText(arg, 120));
  }
  return redactSnapshotText(out.join(' '), maxChars);
}

function readProcText(readFile, path) {
  try {
    return String(readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const PROC_NET_TCP_STATES = {
  '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING',
};

/** Decode a /proc/net/tcp{,6} address ("0100007F:23C3") to "127.0.0.1:9155".
 * The kernel prints each 32-bit word in host (little-endian) byte order.
 * @param {string} value */
export function decodeProcNetAddress(value) {
  const [hex = '', portHex = ''] = String(value).split(':');
  const port = Number.parseInt(portHex, 16);
  /** @param {string} w */
  const wordBytes = (w) => [w.slice(6, 8), w.slice(4, 6), w.slice(2, 4), w.slice(0, 2)].map((b) => Number.parseInt(b, 16));
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return `${wordBytes(hex).join('.')}:${port}`;
  if (/^[0-9A-Fa-f]{32}$/.test(hex)) {
    const bytes = [0, 8, 16, 24].flatMap((i) => wordBytes(hex.slice(i, i + 8)));
    if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
      return `${bytes.slice(12).join('.')}:${port}`;
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return `[${groups.join(':')}]:${port}`;
  }
  return String(value).slice(0, 64);
}

/**
 * Socket inventory of one process (WI-10005178): which TCP peers it holds, in what
 * state, plus a unix-socket count. A Codex child stuck at "Starting" logs nothing
 * and is recycled within minutes, so the snapshot is the only place this evidence
 * can be caught. Reads the process's fd links and its OWN network namespace's
 * /proc/<pid>/net tables, parsed once per namespace via `netCache`. Never throws;
 * null when the fd list is unreadable.
 * @param {number} pid
 * @param {{ readFile?: SnapshotReadFile, readDir?: SnapshotReadDir, readLink?: (path: string) => unknown, netCache?: Map<string, { tcp: Map<string, { remote: string, state: string }>, unix: Set<string> }>, maxTcp?: number }} [options]
 */
export function collectProcSockets(pid, {
  readFile = readFileSync,
  readDir = readdirSync,
  readLink = readlinkSync,
  netCache = new Map(),
  maxTcp = 8,
} = {}) {
  let fds;
  try {
    fds = readDir(`/proc/${pid}/fd`).map(String);
  } catch {
    return null;
  }
  const inodes = new Set();
  for (const fd of fds) {
    let target;
    try {
      target = String(readLink(`/proc/${pid}/fd/${fd}`));
    } catch {
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  if (inodes.size === 0) return { total: 0, tcp: [], unix: 0, other: 0 };
  let nsKey = `pid:${pid}`;
  try {
    nsKey = String(readLink(`/proc/${pid}/ns/net`));
  } catch {
    // Unknown namespace: parse this process's tables uncached.
  }
  let tables = netCache.get(nsKey);
  if (!tables) {
    tables = { tcp: new Map(), unix: new Set() };
    for (const name of ['tcp', 'tcp6']) {
      const text = readProcText(readFile, `/proc/${pid}/net/${name}`) ?? '';
      for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10) continue;
        tables.tcp.set(cols[9], {
          remote: decodeProcNetAddress(cols[2]),
          state: PROC_NET_TCP_STATES[cols[3]] ?? cols[3],
        });
      }
    }
    const unixText = readProcText(readFile, `/proc/${pid}/net/unix`) ?? '';
    for (const line of unixText.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 7) tables.unix.add(cols[6]);
    }
    netCache.set(nsKey, tables);
  }
  /** @type {Map<string, { remote: string, state: string, count: number }>} */
  const tcp = new Map();
  let tcpCount = 0;
  let unix = 0;
  for (const inode of inodes) {
    const entry = tables.tcp.get(inode);
    if (entry) {
      tcpCount += 1;
      const key = `${entry.remote} ${entry.state}`;
      const prior = tcp.get(key);
      if (prior) prior.count += 1;
      else tcp.set(key, { ...entry, count: 1 });
    } else if (tables.unix.has(inode)) {
      unix += 1;
    }
  }
  const peers = [...tcp.values()].sort((a, b) => b.count - a.count);
  return {
    total: inodes.size,
    tcp: peers.slice(0, maxTcp),
    ...(peers.length > maxTcp ? { tcpTruncated: peers.length - maxTcp } : {}),
    unix,
    other: inodes.size - tcpCount - unix,
  };
}

/** Walk the descendants of `rootPid` breadth-first. Children are read from
 * EVERY thread's /proc/PID/task/TID/children: the kernel lists a child under the
 * thread that forked it, and Codex (a multithreaded Rust runtime) forks its MCP
 * servers from worker threads, so the main thread's list alone is empty
 * (measured on a live Codex: 156 threads, main-thread children empty, three
 * worker threads holding all of them). */
/** @typedef {(path: string, encoding: 'utf8') => string | Buffer} SnapshotReadFile */
/** @typedef {(path: string) => ReadonlyArray<unknown>} SnapshotReadDir */
/** @typedef {(path: string, maxBytes: number) => ({ text: string, size: number, truncatedHead: boolean } | null)} SnapshotReadTail */
/** @typedef {{ path: string, present: false } | { path: string, present: true, bytes: number, totalLinesInTail: number, lastTs: string | null, tail: string[] }} CodexTuiLogTail */

/**
 * @param {number | undefined} rootPid
 * @param {{ readFile?: SnapshotReadFile, readDir?: SnapshotReadDir, readLink?: (path: string) => unknown, maxDepth?: number, maxProcs?: number }} [options]
 */
export function collectCodexStuckProcessTree(rootPid, {
  readFile = readFileSync,
  readDir = readdirSync,
  readLink = readlinkSync,
  maxDepth = 5,
  maxProcs = 20,
} = {}) {
  const procs = [];
  const netCache = new Map();
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { procs, truncated: false };
  const queue = [{ pid: rootPid, ppid: null, depth: 0 }];
  const seen = new Set();
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.pid)) continue;
    seen.add(current.pid);
    if (procs.length >= maxProcs) {
      truncated = true;
      break;
    }
    const stat = readProcText(readFile, `/proc/${current.pid}/stat`);
    if (stat === null) continue;
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < open) continue;
    const wchan = readProcText(readFile, `/proc/${current.pid}/wchan`)?.trim() ?? null;
    const cmdline = readProcText(readFile, `/proc/${current.pid}/cmdline`);
    let threads = null;
    let tids = [String(current.pid)];
    try {
      const listed = readDir(`/proc/${current.pid}/task`).map(String).filter((t) => /^\d+$/.test(t));
      if (listed.length > 0) {
        tids = listed;
        threads = listed.length;
      }
    } catch {
      // Fall back to the main thread's own child list.
    }
    procs.push({
      pid: current.pid,
      ppid: current.ppid,
      depth: current.depth,
      comm: stat.slice(open + 1, close).slice(0, 64),
      state: stat.slice(close + 2).trim().split(/\s+/)[0] || null,
      wchan: wchan && wchan !== '0' ? wchan.slice(0, 64) : null,
      threads,
      cmd: cmdline ? redactSnapshotArgv(cmdline.split('\0').filter(Boolean)) : null,
      sockets: collectProcSockets(current.pid, { readFile, readDir, readLink, netCache }),
    });
    if (current.depth >= maxDepth) continue;
    for (const tid of tids) {
      const children = readProcText(readFile, `/proc/${current.pid}/task/${tid}/children`) ?? '';
      for (const token of children.trim().split(/\s+/)) {
        const childPid = Number(token);
        if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) {
          queue.push({ pid: childPid, ppid: current.pid, depth: current.depth + 1 });
        }
      }
    }
  }
  return { procs, truncated };
}

/** Last `maxBytes` of a file as utf8 text, or null when it cannot be read.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {{ text: string, size: number, truncatedHead: boolean } | null}
 */
export function readFileTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.subarray(0, read).toString('utf8'), size, truncatedHead: size > length };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const CODEX_LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

/** The tail of the CURRENT child's codex-tui.log, which covers only this
 * child's startup because Codex starts the file fresh at launch.
 * @param {string | undefined} codexHome
 * @param {{ readTail?: SnapshotReadTail, maxLines?: number, maxLineChars?: number, maxBytes?: number }} [options]
 * @returns {CodexTuiLogTail | null}
 */
export function readCodexTuiLogTail(codexHome, {
  readTail = readFileTail,
  maxLines = 30,
  maxLineChars = 240,
  maxBytes = 64 * 1024,
} = {}) {
  if (!codexHome) return null;
  const path = join(String(codexHome), 'log', 'codex-tui.log');
  const raw = readTail(path, maxBytes);
  if (!raw) return { path, present: false };
  const lines = stripAnsi(String(raw.text)).split('\n').filter((line) => line.trim());
  // A tail cut mid-file starts with a partial line.
  if (raw.truncatedHead) lines.shift();
  const tail = lines.slice(-maxLines).map((line) => redactSnapshotText(line, maxLineChars));
  const lastTs = [...lines].reverse().map((line) => line.match(CODEX_LOG_TS_RE)?.[1]).find(Boolean) ?? null;
  return { path, present: true, bytes: raw.size, totalLinesInTail: lines.length, lastTs, tail };
}

/** One bounded, never-throwing snapshot of a Codex child stuck at `Starting`.
 * @param {{ rootPid?: number, codexHome?: string, platform?: string, readFile?: SnapshotReadFile, readDir?: SnapshotReadDir, readLink?: (path: string) => unknown, readTail?: SnapshotReadTail, startupOutput?: string, screenDims?: { rows?: number, cols?: number } }} [options]
 */
export function collectCodexStartingStuckSnapshot({
  rootPid,
  codexHome,
  platform = process.platform,
  readFile = readFileSync,
  readDir = readdirSync,
  readLink = readlinkSync,
  readTail = readFileTail,
  // WI-10005178: the pty output the `Starting` verdict was read from.
  startupOutput,
  // The child's PTY size, so the footer is read off the same grid it painted.
  screenDims,
} = {}) {
  try {
    const tree = platform === 'linux'
      ? collectCodexStuckProcessTree(rootPid, { readFile, readDir, readLink })
      : { procs: [], truncated: false };
    return {
      rootPid: Number.isInteger(rootPid) ? rootPid : null,
      procs: tree.procs,
      procsTruncated: tree.truncated,
      log: readCodexTuiLogTail(codexHome, { readTail }),
      footer: codexStartingFooterEvidence(startupOutput, { dims: screenDims }),
    };
  } catch (error) {
    return { rootPid: Number.isInteger(rootPid) ? rootPid : null, error: hostErrorEvidence(error) };
  }
}

/** Small, non-secret error identity for durable host events. Exception messages can
 * contain command arguments or credentials; the local stderr keeps the full
 * diagnostic while the shared event store gets only a stable error class/code. */
export function hostErrorEvidence(error) {
  const value = error && typeof error === 'object' ? error : {};
  const tag = (raw, max) =>
    typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)
      ? raw.slice(0, max)
      : null;
  const errorName = tag(value.name, 64) ?? 'Error';
  const errorCode = tag(value.code, 64);
  return { errorName, ...(errorCode ? { errorCode } : {}) };
}

/** Shared drill-lifecycle roll-up file — the SAME carry-drills.events.jsonl the
 *  tool side (cold-boot-drill-live.ts) writes requested/queued rows into. */
const DRILL_LEDGER_MAX_BYTES = 1024 * 1024;
export function sharedDrillLedgerPath(dir = PSU_PTY_DIR) {
  return join(dir, 'carry-drills.events.jsonl');
}

/** EI-12655 (fix b): mirror a carry-drill lifecycle event into the SHARED drill
 *  ledger. The tool side records only requested/queued there; every HOST-side
 *  outcome (respawned / respawn-failed / carry-delivered / carry-dropped)
 *  previously lived ONLY in the per-owner event log — so
 *  `session:carry-drill { op:'report' }` (which reads the shared ledger) saw
 *  perClass:[] even after real drills, and a vanished host left NO terminal row
 *  anywhere. Call this NEXT TO every carry-drill-* appendHostEvent. Row shape
 *  matches ColdBootDrillLedgerEvent ({ ts, kind, ownerId, drillId,
 *  sessionClass, reason?, nativeId?, ... }). FAIL-SOFT like appendHostEvent —
 *  a ledger write must never break the session. */
export function appendSharedDrillLedgerEvent(ownerId, kind, extra = {}, dir = PSU_PTY_DIR) {
  try {
    const p = sharedDrillLedgerPath(dir);
    const row = JSON.stringify({ ts: new Date().toISOString(), kind, ownerId, ...extra });
    try {
      if (statSync(p).size > DRILL_LEDGER_MAX_BYTES) {
        const tail = readFileSync(p, 'utf8');
        writeFileSync(p, tail.slice(Math.floor(tail.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      /* no ledger yet — the append below creates it */
    }
    appendFileSync(p, row + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Control-socket path for an ownerId. Pure. */
export function socketPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
}

/** Discovery-metadata path for an ownerId. Pure. */
export function metaPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
}

/** WI-38292: where a host about to re-exec leaves the successor's marching
 *  orders. A FILE, not an env var: the successor is spawned by the shim's bash
 *  loop, not by us, so we cannot put anything in its environment. Pure. */
export function handoffPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.handoff.json`);
}

/**
 * WI-38292: persist the successor's marching orders — the child argv this host
 * had already minted (rotated native session id + the carry's
 * --append-system-prompt-file), so the carry survives the process swap without
 * riding memory. Returns the path, or null when it could not be written (the
 * caller must then NOT exit: a successor with no orders would boot a bare
 * session and drop the carry).
 */
/** WI-38292: the child env keys a host-code handoff carries to the re-exec'd successor.
 *  The shim re-runs the launcher with its ORIGINAL environment, not the child environment
 *  assembled after bootstrap, so everything the launch tail set for the child that the
 *  successor must reproduce has to travel in the handoff. Deliberately NOT the whole child
 *  env (it carries unrelated credentials) — but every key here is a copy of a truth the
 *  launcher's fresh path owns, so it DRIFTS: the list predated the context-trimming trio
 *  (ENABLE_TOOL_SEARCH / PAPERCUSP_TOOLS / PAPERCUSP_CONTEXT_TIER) and, on the first
 *  adoption after a pty-host edit, every headless fleet member re-booted with the whole
 *  ~581-tool catalog inline — 756k tokens on turn 1, respawned every ~10 min (WI-2140943
 *  lane 2, 2026-09-02). Two rails keep it honest now: the launcher's handoff successor
 *  re-derives that trio when absent (healContextTrimmingEnv), and
 *  psu-host-handoff-env.test.ts pins this list ⊇ contextTrimmingEnv's keys. */
export const HOST_HANDOFF_ENV_KEYS = Object.freeze([
  'PAPERCUSP_SID',
  'PAPERCUSP_AGENT',
  'PAPERCUSP_ADV_SESSION_ID',
  HEADLESS_NORMALIZED_LOG_ENV,
  'PAPERCUSP_WORKSPACE',
  'PAPERCUSP_HARNESS_SLUG',
  'PAPERCUSP_PROFILE',
  'PAPERCUSP_FLEET_SLUG',
  'PAPERCUSP_FLEET_ROLE',
  'PAPERCUSP_ACCOUNT_ID',
  'PAPERCUSP_ACCOUNT_ROUTING_MODE',
  'PAPERCUSP_OPERATOR_URL',
  'PAPERCUSP_OPERATOR_URL_PROVENANCE',
  'PAPERCUSP_AGENT_SESSION',
  'PAPERCUSP_AUTO_MODE',
  'PAPERCUSP_DRAIN_MODE',
  'PAPERCUSP_MODEL',
  // context-trimming keys (WI-2140943 lane 2) — see contextTrimmingEnv in psu-launcher.mjs.
  // NOT a fixed "trio": this list is PINNED ⊇ that helper's key set by
  // psu-host-handoff-env.test.ts, so every key the fresh path adds must be added here too or
  // it falls out of the handoff exactly the way the original trio did.
  'ENABLE_TOOL_SEARCH',
  'PAPERCUSP_TOOLS',
  // Added 2026-09-22: contextTrimmingEnv began emitting the compact delivery tier alongside
  // PAPERCUSP_TOOLS, but this allowlist was not updated with it — so a successor adopting
  // updated host code silently lost it across a handoff. That is the WI-2140943 regression
  // verbatim, caught by the pin rather than in production this time.
  'PAPERCUSP_TOOLS_COMPACT',
  'PAPERCUSP_CONTEXT_TIER',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
  // Console-history preservation (launcher terminalRenderEnv, owner terminal
  // 2026-09-06): a successor that boots into Claude Code's fullscreen TUI paints on
  // the alternate screen and its whole epoch vanishes from the console at the next
  // cut. Pinned ⊇ terminalRenderEnv's keys by psu-host-handoff-env.test.ts.
  'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
]);

export function writeHostHandoff(ownerId, record) {
  try {
    ensureDir();
    const p = handoffPathFor(ownerId);
    writeFileSync(
      p,
      JSON.stringify({
        ownerId,
        fromPid: process.pid,
        createdAt: new Date().toISOString(),
        ...record,
        // The successor is launched by the shim, not by this process. Its
        // parent pid is therefore the one stable rendezvous key available to
        // the next launcher before it has reconstructed PAPERCUSP_SID. Keep
        // this server-derived value authoritative even if a caller supplies a
        // similarly named field in its opaque record.
        parentPid: process.ppid,
      }),
      { mode: 0o600 },
    );
    return p;
  } catch {
    return null;
  }
}

function readHostHandoffFile(
  p,
  expectedOwnerId,
  { maxAgeMs = 120_000, now = Date.now, isAlive = pidAlive } = {},
) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    unlinkSync(p);
  } catch {
    /* consumed either way — a re-readable handoff is worse than a lost one */
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  if (expectedOwnerId && rec.ownerId && rec.ownerId !== expectedOwnerId) return null;
  // A LIVE writer means we are not its successor — that host is running and owns
  // the session, and acting on its argv would put a second child behind a live
  // discovery key. No self-exemption: a process is never its own successor, so
  // `fromPid === process.pid` is refused by the same rule rather than waved past
  // it (the exemption also made this guard untestable, which is how it was found).
  if (rec.fromPid && isAlive(rec.fromPid)) return null;
  const age = now() - Date.parse(rec.createdAt ?? '');
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  if (!Array.isArray(rec.args) || rec.args.length === 0) return null;
  return rec;
}

/**
 * WI-38292: read AND consume (unlink) this owner's handoff. Single-shot by
 * construction — the file is removed before its contents are returned, so a
 * successor that crashes mid-boot cannot have the same carry replayed into it on
 * every subsequent launch.
 *
 * Rejects a record that is not ours to act on: a different ownerId (a copied
 * file), one written by a STILL-LIVE host (we are not its successor — that host
 * is running and owns the session), or one older than `maxAgeMs` (a re-exec that
 * never completed, whose argv now names a rotated session id nothing will
 * accept). A rejected record is still consumed: leaving it behind means the next
 * launch re-litigates the same stale orders.
 * @param {string} ownerId
 * @param {{maxAgeMs?: number, now?: () => number, isAlive?: (pid: number) => boolean}} [opts]
 */
export function readHostHandoff(ownerId, opts = {}) {
  return readHostHandoffFile(handoffPathFor(ownerId), ownerId, opts);
}

/**
 * Read the single handoff written by this launcher's parent shim. A host
 * re-exec starts the launcher with the shim's original argv and environment,
 * so the numeric adv id/CODEX_HOME that were resolved after bootstrap are not
 * otherwise available yet. The handoff records the shim pid as a rendezvous
 * key, allowing the launcher to consume its own orders before running a fresh
 * bootstrap and accidentally minting a sibling adv row.
 *
 * Refuse an ambiguous parent match: selecting the newest file would recreate
 * the same cross-session identity split this handoff path is meant to prevent.
 * @param {number} parentPid
 * @param {{maxAgeMs?: number, now?: () => number, isAlive?: (pid: number) => boolean}} [opts]
 */
export function readHostHandoffForParentPid(parentPid, opts = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let names;
  try {
    names = readdirSync(PSU_PTY_DIR);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.handoff.json')) continue;
    const p = join(PSU_PTY_DIR, name);
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed?.parentPid === parentPid) {
        candidates.push({
          path: p,
          ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : null,
        });
      }
    } catch {
      /* a malformed file is not evidence for this parent */
    }
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return readHostHandoffFile(candidate.path, candidate.ownerId, opts);
}

/** Is a pid alive? (signal 0 probe.) */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours (shouldn't happen same-UID); treat as alive.
    return e && e.code === 'EPERM';
  }
}

/** Read a pid's /proc cmdline (NULs → spaces); null when unreadable. Injectable
 *  for tests. Mirrors operator-core psu-pty-discovery's defaultReadCmdline. */
const readPidCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
};

/**
 * Process-IDENTITY check (WI-3455; mirrors operator-core psu-pty-discovery's
 * pidIsPsuHost — keep the two in lockstep): is `pid` actually a psu session
 * host, or an unrelated process that inherited a recycled pid? FAIL-OPEN where
 * identity cannot be read (no /proc ⇒ non-Linux dev: trust pid-alive as
 * before); on Linux an unreadable cmdline means the pid vanished / is a zombie
 * ⇒ not a verifiable live host ⇒ reject.
 */
export function pidLooksLikePsuHost(pid, readCmdline = readPidCmdline) {
  if (!pid) return false;
  const cmdline = readCmdline(pid);
  if (cmdline == null) return !existsSync('/proc');
  return /psu-(launcher|pty-host)/.test(cmdline);
}

/** Parse an ownerId's discovery file, or null (missing / partial / corrupt). */
export function readDiscoveryMeta(ownerId) {
  try {
    return JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The LIVE psu host currently registered for `ownerId`, or null (WI-3455).
 * Self-validating like operator-core's findLiveHost: recorded ownerId must
 * match, the pid must be alive AND actually be a psu host, and the socket must
 * still exist on disk. Used by the launcher's resume-of-live guard — a non-fork
 * resume of a session that is STILL RUNNING in another window would boot a
 * second host on the same discovery key and strand the live one.
 */
export function findLiveHostFor(ownerId, { verifyIdentity = pidLooksLikePsuHost } = {}) {
  const m = readDiscoveryMeta(ownerId);
  if (!m || (m.ownerId && m.ownerId !== ownerId)) return null;
  if (m.sock && existsSync(m.sock) && m.pid && pidAlive(m.pid) && verifyIdentity(m.pid)) return m;
  return null;
}

/**
 * Admission verdict for a second host targeting the same logical owner.
 *
 * A discovery record is blocking only when it belongs to this owner, points at
 * another live process, and that process is identity-verified as a psu host.
 * Missing/corrupt, owner-mismatched, self, dead, and PID-reuse records stay
 * admissible so pruneDead/the ordinary stale-socket cleanup can recover them.
 */
export function duplicateHostAdmission(
  ownerId,
  priorMeta,
  { currentPid = process.pid, isAlive = pidAlive, verifyIdentity = pidLooksLikePsuHost } = {},
) {
  const pid = Number(priorMeta?.pid);
  const duplicate =
    priorMeta?.ownerId === ownerId &&
    Number.isInteger(pid) &&
    pid > 0 &&
    pid !== currentPid &&
    isAlive(pid) &&
    verifyIdentity(pid);
  return duplicate
    ? { admitted: false, reason: 'live-duplicate-host', ownerId, pid }
    : { admitted: true, reason: 'no-verified-live-duplicate' };
}

/**
 * How long a live host has been INERT, from the activity stamps its own
 * discovery record already carries (EI-20289007209260909).
 *
 * `findLiveHostFor` answers "does a process exist?", which is the wrong
 * question to hand a human on its own. Measured 2026-08-12: a headless session
 * whose kickoff said "acknowledge and stop" did exactly that, then sat in the
 * launcher's process tree for 4h15m holding its socket and identity while the
 * CLI waited on a stdin nobody would ever write to. The resume guard read
 * pid-alive, said "STILL LIVE in another window", and told the owner to go use
 * a window where nothing was happening — while `coord:presence` called the same
 * session `ended`. Both surfaces were locally correct and the owner still could
 * not tell what was true, because neither reported the deciding fact: 178
 * minutes with no output.
 *
 * Returns null when NO stamp is readable. That case must not be reported as
 * idle: the guard's dangerous error is the opposite of the composer breaker's
 * — there, absent evidence means break the line; here, absent evidence means
 * keep refusing, because wrongly waving a resume past a genuinely live host
 * boots a second one onto its discovery key and strands it (WI-3455). Same
 * "missing measurement" shape, opposite safe direction, and the direction is a
 * property of what the failure costs, not of the code.
 *
 * Pure (injectable clock, no I/O); exported for tests.
 *
 * @param {{ lastActivityAt?: number, lastOutputAt?: number, lastInputAt?: number, startedAt?: number }} meta
 * @param {number} [now]
 */
export function hostIdleMs(meta, now = Date.now()) {
  const stamps = [meta?.lastActivityAt, meta?.lastOutputAt, meta?.lastInputAt, meta?.startedAt].filter(
    (t) => typeof t === 'number' && Number.isFinite(t) && t > 0,
  );
  if (!stamps.length) return null;
  return Math.max(0, now - Math.max(...stamps));
}

function ensureDir() {
  mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(PSU_PTY_DIR, 0o700);
  } catch {
    /* best-effort on a pre-existing dir */
  }
}

/** Read every discovery file; annotate each with `alive`. Skips unreadable. */
export function listHosts() {
  const out = [];
  let names;
  try {
    names = readdirSync(PSU_PTY_DIR);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(PSU_PTY_DIR, f), 'utf8'));
      meta.alive = pidAlive(meta.pid) && !!meta.sock && existsSync(meta.sock);
      meta.metaPath = join(PSU_PTY_DIR, f);
      out.push(meta);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Remove discovery files + sockets whose host process is gone. */
export function pruneDead() {
  for (const m of listHosts()) {
    if (pidAlive(m.pid)) continue;
    for (const p of [m.sock, m.metaPath]) {
      try {
        if (p && existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * owner-presence-human-turn-signal-2026-07-11 P-003: report a human-turn presence
 * signal, throttled to ≤1/60s per host process, when a human types into an agent's
 * terminal. This is the backend-agnostic owner-present signal (claude/codex/omp all
 * route through this pty bridge): stdin bytes here are REAL keystrokes — socket-
 * injected agent wakes take the control-socket path (conn.on('data') → child.write),
 * never stdin — so no human-vs-agent disambiguation is needed. Fire-and-forget: never
 * awaited, never throws into the keystroke path; a wedged operator can't stall typing.
 * The caller additionally gates this on `bridgeTty` (a real terminal), so a headless
 * background session with a piped stdin never reports presence.
 */
const OWNER_PRESENCE_REPORT_THROTTLE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_OWNER_PRESENCE_THROTTLE_MS) || 60_000;
let lastOwnerPresenceReportAt = 0;
export function reportOwnerHumanTurn(now = Date.now()) {
  if (now - lastOwnerPresenceReportAt < OWNER_PRESENCE_REPORT_THROTTLE_MS) return;
  lastOwnerPresenceReportAt = now;
  try {
    const base = process.env.PAPERCUSP_OPERATOR_URL || 'http://127.0.0.1:3270';
    const ws = process.env.PAPERCUSP_WORKSPACE || 'default';
    const url = `${base}/api/admin/owner-presence/touch?workspace=${encodeURIComponent(ws)}`;
    // 1.5s timeout so a hung operator releases the socket rather than leaking it.
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    if (typeof t.unref === 'function') t.unref();
    fetch(url, { method: 'POST', signal: ac.signal })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  } catch {
    /* presence reporting must never disturb the terminal */
  }
}

/**
 * Read the effective per-agent wake mode through the loopback admin coord
 * read-only verb. A missing route, failed request, or malformed response is
 * deliberately `null`: carry-rearm must retain its payload unless the server
 * confirms that automatic wakes are enabled.
 */
export async function readEffectiveWakeMode(
  ownerId,
  { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {},
) {
  const agent = typeof ownerId === 'string' ? ownerId.trim() : '';
  if (!agent || typeof fetchImpl !== 'function') return null;
  const rawBase = typeof env?.PAPERCUSP_OPERATOR_URL === 'string'
    ? env.PAPERCUSP_OPERATOR_URL.trim()
    : '';
  let url;
  try {
    url = new URL('/api/admin/coord/wake-mode', rawBase || 'http://127.0.0.1:3270').toString();
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 1500));
  if (typeof timeout.unref === 'function') timeout.unref();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The admin route rejects mode/reason writes on this read-only verb.
      body: JSON.stringify({ agent }),
      signal: controller.signal,
    });
    if (!response?.ok) return null;
    const result = await response.json();
    return result?.ok === true && (result.mode === 'auto' || result.mode === 'manual')
      ? result.mode
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The mid-keystroke idle gate (P-013). `touch()` on every stdin byte records
 * activity; `waitIdle()` resolves once `idleMs` of quiet has elapsed (or the cap
 * is hit). Pure-ish (uses timers + an injectable clock for tests).
 */
export function makeIdleGate({ idleMs = DEFAULT_IDLE_MS, capMs = DEFAULT_IDLE_WAIT_CAP_MS, now = Date.now } = {}) {
  let lastActivity = 0; // never-typed => immediately idle
  return {
    touch() {
      lastActivity = now();
    },
    /** ms until idle from `t` (0 = idle now). Pure helper, exported for tests. */
    remainingIdleMs(t = now()) {
      const since = t - lastActivity;
      return since >= idleMs ? 0 : idleMs - since;
    },
    /** Resolve once the input line has been idle for idleMs (bounded by capMs). */
    async waitIdle() {
      const deadline = now() + capMs;
      // Re-check in case typing continues during a wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rem = this.remainingIdleMs();
        if (rem <= 0) return { deferred: false };
        if (now() >= deadline) return { deferred: true, reason: 'idle-cap' };
        const wait = Math.min(rem, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
  };
}

/**
 * ECMA-48 "string" control sequences: an introducer, an arbitrary payload, and
 * a String Terminator (ST = ESC \, or BEL for OSC). Their payloads are TERMINAL
 * DATA — a reply the emulator wrote in answer to a query the TUI made — and are
 * NEVER owner-authored text.
 *
 * This is deliberately the CLOSED ECMA-48 set rather than the families we have
 * been bitten by. Enumerating observed families is what caused this bug to
 * recur: the CSI/OSC/SS3 handling below was added for Codex's cursor-report
 * replies (EI-20199370837439455), which left DCS unhandled — so when the TUI
 * asked gnome-terminal for its version (XTVERSION, `CSI > 0 q`) and VTE replied
 * `ESC P > | VTE(7600) ESC \`, the parser fell through to "ordinary two-byte
 * ESC sequence" and counted `>|VTE(7600)` as ELEVEN characters of owner text.
 * Nothing clears a staged line except CR/LF/Ctrl-C/Ctrl-U, so every bridged
 * host wedged permanently and deferred every wake with `owner-input-cap`
 * (WI-38156: 532 deferrals in 9h; one session sat dead for 2h).
 */
const STRING_SEQUENCE_INTRODUCERS = new Set([
  0x50, // ESC P — DCS (XTVERSION, DA3 and DECRQSS replies)
  0x58, // ESC X — SOS
  0x5d, // ESC ] — OSC (window title, color queries)
  0x5e, // ESC ^ — PM
  0x5f, // ESC _ — APC (kitty graphics)
]);

/**
 * Split a terminal byte stream into ZONES so that "is this byte owner-authored
 * text?" is answered in exactly one place. Stateful across chunks: a reply can
 * be split over two reads, and a stateless classifier would mis-read the tail
 * of a sequence as owner text — the same failure one level up.
 *
 * Each byte is reported as one of:
 *   'text'   — outside any escape sequence (owner keystrokes live here)
 *   'esc'    — a bare ESC whose family is not yet known (the next byte decides)
 *   'csi'    — inside ESC [ … ; also produced by arrow/function keys, so this
 *              zone is AMBIGUOUS: a human pressing Left and a terminal
 *              answering a cursor query are indistinguishable here.
 *   'ss3'    — inside ESC O …; ambiguous for the same reason (keypad keys).
 *   'string' — inside a string sequence; UNAMBIGUOUSLY terminal-authored.
 *
 * Pure (no I/O); exported for tests.
 */
export function makeAnsiZoneScanner() {
  let escapeMode = null;
  return {
    /** Feed a chunk; `onByte(code, zone)` is called once per byte, in order. */
    scan(data, onByte) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (escapeMode === 'esc') {
          if (code === 0x5b) escapeMode = 'csi'; // ESC [
          else if (code === 0x4f) escapeMode = 'ss3'; // ESC O
          else if (STRING_SEQUENCE_INTRODUCERS.has(code)) escapeMode = 'string';
          else escapeMode = null; // ordinary two-byte ESC sequence
          onByte(code, escapeMode === 'string' ? 'string' : escapeMode || 'csi');
          continue;
        }
        if (escapeMode === 'csi') {
          // ECMA-48 CSI: parameter/intermediate bytes, then one final byte.
          if (code >= 0x40 && code <= 0x7e) escapeMode = null;
          onByte(code, 'csi');
          continue;
        }
        if (escapeMode === 'ss3') {
          // SS3 is ESC O plus one final key byte.
          escapeMode = null;
          onByte(code, 'ss3');
          continue;
        }
        if (escapeMode === 'string') {
          if (code === 0x07) escapeMode = null; // BEL terminator (OSC)
          else if (code === 0x1b) escapeMode = 'string-esc';
          onByte(code, 'string');
          continue;
        }
        if (escapeMode === 'string-esc') {
          // The other terminator is ST (ESC \). A non-ST byte keeps the string
          // open; it is still terminal data, never owner-authored text.
          escapeMode = code === 0x5c ? null : 'string';
          onByte(code, 'string');
          continue;
        }
        if (code === 0x1b) {
          escapeMode = 'esc';
          // The family is not known until the NEXT byte, so this one is its own
          // zone. Attributing it to a family here is what made a DCS reply read
          // as owner input: its leading ESC was counted before `P` disclosed
          // that everything following was terminal data.
          onByte(code, 'esc');
          continue;
        }
        onByte(code, 'text');
      }
    },
    /** Drop any half-parsed sequence (used when the composer is force-reset). */
    reset() {
      escapeMode = null;
    },
  };
}

/**
 * Does this stdin chunk contain anything a HUMAN could have produced?
 *
 * Used to keep terminal replies out of the owner-presence signals. It is
 * deliberately conservative: only the unambiguous 'string' zone is treated as
 * definitely-not-human, so arrow keys, function keys and keypad input (CSI/SS3)
 * still count as owner activity exactly as they did before. The one behaviour
 * given up is a LONE Escape keypress followed by nothing else, ever — its
 * family never resolves, and paying that to stop every terminal reply forging
 * owner presence is the right trade.
 *
 * Stateful across chunks — construct one per stdin stream.
 */
export function makeOwnerInputDetector() {
  const scanner = makeAnsiZoneScanner();
  return {
    /** true when the chunk could be owner-authored; false = pure terminal reply. */
    sawOwnerInput(data) {
      let human = false;
      scanner.scan(data, (_code, zone) => {
        if (zone !== 'string' && zone !== 'esc') human = true;
      });
      return human;
    },
  };
}

/**
 * Does this stdin chunk contain a DEFINITE owner interruption of a fresh
 * successor's first prompt?
 *
 * This is intentionally narrower than makeOwnerInputDetector. A bridged
 * terminal writes CSI/SS3 replies (cursor position, device attributes, etc.)
 * to the same stdin stream during every fresh Codex boot. Those bytes are
 * indistinguishable from arrow/function keys, so they remain owner activity
 * for presence/idle accounting, but they cannot safely cancel the deterministic
 * carry: doing so strands every successor before its first submission. Only
 * bytes outside an escape sequence can change/submit/cancel the fresh
 * composer's line, and therefore interrupt its carry prompt. Enter, Ctrl-C,
 * Ctrl-U and ordinary owner text all remain definite interruptions.
 *
 * Stateful across chunks — construct one per stdin stream.
 */
export function makeFreshChildOwnerInterruptionDetector() {
  const scanner = makeAnsiZoneScanner();
  return {
    /** true only when the chunk contains definite line-affecting owner input. */
    sawOwnerInput(data) {
      let human = false;
      scanner.scan(data, (_code, zone) => {
        if (zone === 'text') human = true;
      });
      return human;
    },
  };
}

/**
 * Detect a composer that is no longer tracking a real person (WI-38156).
 *
 * The parser fix above removes the KNOWN phantom source; this exists for the
 * next unknown one. The original incident was silent for hours — 532 deferrals
 * across 9h, one session dead for 2h — because each individual defer is
 * perfectly legitimate ("the owner is mid-line, don't corrupt their input"),
 * and nothing ever asked the follow-up question: has that same untouched line
 * been blocking wakes all morning?
 *
 * The signature that separates a phantom from a person: the staged length
 * never changes AND no owner-authored byte has arrived for a long time. A real
 * person who walked away mid-line trips this too — which is CORRECT. The agent
 * is equally stuck either way, and somebody should be told.
 *
 * Pure (no clock, no I/O — the caller supplies the measurements); exported for
 * tests.
 */
export function makeComposerWedgeDetector({ minDefers = 3, minQuietMs = 5 * 60_000 } = {}) {
  let consecutive = 0;
  let lastLength = -1;
  let reported = false;
  return {
    /**
     * Record one deferral. Returns a report payload the first time a wedge is
     * suspected for a given staged line, otherwise null (so a wedged host logs
     * once per episode instead of once per wake).
     *
     * The param is typed explicitly rather than left to inference: a
     * destructured field with NO default (`pendingLength`) is dropped from the
     * inferred object type entirely, so the generated .d.mts declared a shape
     * without it and every caller that passed it became a type error — while
     * vitest stayed green, because it never typechecks.
     *
     * @param {{ pendingLength: number, ownerQuietMs?: number, pendingAgeMs?: number }} sample
     */
    note(sample) {
      const { pendingLength, ownerQuietMs = Infinity, pendingAgeMs = 0 } = sample ?? {};
      if (pendingLength !== lastLength) {
        // The line moved, so somebody is editing it. Start the count over.
        lastLength = pendingLength;
        consecutive = 1;
        reported = false;
        return null;
      }
      consecutive += 1;
      if (reported || consecutive < minDefers || ownerQuietMs < minQuietMs) return null;
      reported = true;
      return {
        pendingLength,
        consecutiveDefers: consecutive,
        pendingAgeMs,
        ownerQuietMs: ownerQuietMs === Infinity ? null : ownerQuietMs,
        // The single most diagnostic fact, and the one that took a live pty
        // capture to establish the first time: no owner byte was EVER seen.
        ownerBytesEverSeen: ownerQuietMs !== Infinity,
      };
    },
    /**
     * How many consecutive wakes have been deferred against the CURRENT staged
     * length. Exposed because `note()` deliberately reports once per episode —
     * after the first report it returns null forever, so the count it is still
     * maintaining becomes invisible to the caller at exactly the point the
     * episode gets bad. The breaker needs the running value, not the one-shot
     * report: this is the only wedge signal that requires no clock at all, and
     * therefore the only one that survives a host whose measurements are absent.
     */
    consecutiveDefers() {
      return consecutive;
    },
  };
}

/**
 * Decide whether a staged composer line has stopped tracking a person and may
 * be CLEARED so wakes can flow again (WI-38257).
 *
 * makeComposerWedgeDetector above answers "should somebody be TOLD?". This
 * answers "may the host ACT?", and they are deliberately separate questions
 * because the detector's entire remedy is a stderr line reading "press Ctrl-U
 * here to clear it" — which asks the very human whose absence IS the failure. A
 * detector whose only actuator is an absent human is not a recovery path.
 *
 * Measured on the 2026-08-12 incident: a 53-char line sat staged while every
 * wake deferred with `owner-input-cap` for 112s+, the agent took no turn at all,
 * and the episode ended only because the owner typed. The detector never even
 * fired — `owner-composer-wedge-suspected` count was 0 in that ledger, because
 * its default quiet window is 5 min, longer than the strand a human was willing
 * to sit through. A threshold above human patience reports nothing, ever.
 *
 * The predicate is deliberately NOT "no owner byte was ever seen". That reading
 * is the tempting one and it is WRONG: the incident recorded ownerQuietMs=102321
 * — finite, so owner-classified bytes HAD arrived — and a never-saw-a-byte guard
 * would have sat out the very event it was written for. What actually separates
 * a wedge from a person is the pair below: a line whose length has not moved AND
 * which has received no owner byte for the whole window. A person who walked
 * away mid-line trips it too, and that is the correct trade — they lose a line
 * they had already abandoned, where the alternative is an agent dead until
 * somebody notices. ownerQuietMs is Infinity when no owner byte was ever seen,
 * which satisfies any threshold, so a pure phantom clears as soon as it is old
 * enough.
 *
 * Pure (the caller supplies the measurements); exported for tests.
 *
 * The param is typed EXPLICITLY, for the reason its sibling above records: a
 * destructured field with no default (`pending`) is dropped from the inferred
 * object type entirely, so the generated .d.mts would declare a shape without
 * it and every caller passing it becomes a type error — while vitest stays
 * green, because it never typechecks. Same trap, one function down.
 *
 * ## The wake-loss fallback (EI-20287339148365013)
 *
 * Both measurements above are TIMING PROXIES for the harm. The harm itself is
 * "wakes are being thrown away", and `consecutiveDefers` measures that directly
 * — which matters because each proxy has a way to be silently defeated, and one
 * of them already was:
 *
 *  - MEASUREMENTS ABSENT. Measured 2026-08-12: ten hosts deferred every wake for
 *    up to 259 minutes with `pendingAgeMs`/`ownerQuietMs` missing from every
 *    event they emitted (they predated the commit that added the fields). The
 *    destructuring defaults then resolve to `pendingAgeMs = 0`, the age guard
 *    fails, and the breaker CAN NEVER FIRE. A missing measurement must not read
 *    as "nothing is wrong": for a liveness guard, absent evidence is the case
 *    that most needs breaking, not the one that most needs caution.
 *  - QUIET RESET BY A REPEATING EMITTER. `ownerQuietMs` is reset by any byte
 *    classified as text, so a terminal reply family the scanner does not yet
 *    recognise — the exact bug that staged these lines — holds the quiet window
 *    below threshold indefinitely while the line sits there. The proxy reports
 *    "a person is here" precisely when a machine is.
 *
 * The counter is only incremented against an UNCHANGED staged length (see
 * makeComposerWedgeDetector), which is what keeps it off a person: a human's
 * line moves as they type. A human whose line has not moved across N wakes has
 * walked away from it, and the doc above already settles that trade — they lose
 * a line they had abandoned, where the alternative is an agent dead until
 * somebody notices.
 *
 * @param {{ pending: boolean, pendingAgeMs?: number, ownerQuietMs?: number, consecutiveDefers?: number }} sample
 * @param {{ minAgeMs?: number, minQuietMs?: number, maxDefers?: number }} [thresholds]
 */
export function shouldBreakComposerWedge(
  sample,
  { minAgeMs = 90_000, minQuietMs = 90_000, maxDefers = 5 } = {},
) {
  const { pending, pendingAgeMs = 0, ownerQuietMs = Infinity, consecutiveDefers = 0 } = sample ?? {};
  if (!pending) return false;
  // Checked BEFORE the timing rule, and deliberately depending on neither
  // measurement: this is the path that still works on a host whose forensics
  // fields are absent, which is the population that stayed wedged for hours.
  if (consecutiveDefers >= maxDefers) return true;
  if (!(pendingAgeMs >= minAgeMs)) return false;
  return ownerQuietMs >= minQuietMs;
}

/**
 * Track a bridged owner's line-editor state separately from keystroke activity.
 * The idle gate only knows that typing stopped; it cannot tell whether the
 * owner pressed Enter. Injecting a wake into a quiet-but-unsubmitted line
 * appends the machine envelope after owner text, so provenance is then
 * misclassified as owner-typed and the TUI receives a corrupted turn.
 *
 * Escape sequences are ignored as terminal editing controls. The conservative
 * fallback is to keep a line pending until an explicit submit/cancel arrives;
 * a false defer is safe, while appending machine bytes to owner text is not.
 */
export function makeOwnerComposerGate({ capMs = DEFAULT_IDLE_WAIT_CAP_MS, now = Date.now } = {}) {
  let pending = false;
  let lineLength = 0;
  const scanner = makeAnsiZoneScanner();
  const waiters = new Set();
  // Wedge forensics (WI-38156). A staged line that never changes and receives
  // no further owner bytes is the signature of a phantom: a real person either
  // finishes the line or abandons it. Recording WHEN it was staged and when it
  // last moved is what makes "this host is stuck" falsifiable from the event
  // log instead of a 2h silent halt nobody notices.
  let pendingSinceMs = 0;
  let lastOwnerByteMs = 0;

  const setPending = (next) => {
    pending = next;
    if (!pending) {
      pendingSinceMs = 0;
      for (const resolve of waiters) resolve({ deferred: false });
      waiters.clear();
    } else if (!pendingSinceMs) {
      pendingSinceMs = now();
    }
  };

  const observe = (data) => {
    scanner.scan(data, (code, zone) => {
      // Only bytes OUTSIDE an escape sequence can be owner-typed text.
      if (zone !== 'text') return;
      lastOwnerByteMs = now();
      if (code === 0x0d || code === 0x0a || code === 0x03 || code === 0x15) {
        // Enter/newline submits; Ctrl-C and Ctrl-U cancel the current line.
        lineLength = 0;
        setPending(false);
        return;
      }
      if (code === 0x08 || code === 0x7f) {
        lineLength = Math.max(0, lineLength - 1);
        setPending(lineLength > 0);
        return;
      }
      if (code === 0x09 || code >= 0x20) {
        lineLength += 1;
        setPending(true);
      }
    });
  };

  return {
    observe,
    hasPending() {
      return pending;
    },
    pendingLength() {
      return lineLength;
    },
    /** How long the current line has been staged (0 when nothing is pending). */
    pendingAgeMs(t = now()) {
      return pendingSinceMs ? t - pendingSinceMs : 0;
    },
    /** How long since ANY owner-authored byte arrived (Infinity when never). */
    ownerQuietMs(t = now()) {
      return lastOwnerByteMs ? t - lastOwnerByteMs : Infinity;
    },
    markSubmitted() {
      lineLength = 0;
      scanner.reset();
      setPending(false);
    },
    /** Wait for an owner submit/cancel, bounded so a parked line cannot wedge a host. */
    waitClear() {
      if (!pending) return Promise.resolve({ deferred: false });
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(finish);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ deferred: true, reason: 'owner-input-cap' }), capMs);
        waiters.add(finish);
      });
    },
  };
}

/**
 * psu-process-free-parking-2026-10-06 P-016: how long a Claude child must sit
 * idle at its prompt before the host PARKS it (SIGKILLs the CLI to free its
 * ~215 MB while the host, socket and terminal stay up; D-002). 15 minutes:
 * long enough that an attended session the owner is reading is not parked
 * under them, short enough that an idle fleet sheds its CLI memory. A park
 * costs no tokens inside the 1h prompt-cache TTL and ~1 s of wake latency
 * (D-018/D-025 of agent-capacity-and-cost-gcp-2026-09-30).
 */
export const DEFAULT_PARK_IDLE_MS = 15 * 60_000;

/**
 * Resolve the park threshold from PAPERCUSP_PSU_PARK_IDLE_MS. Unset/blank or
 * unparseable falls back to the default (the feature ships ON); an explicit
 * `0` is the kill-switch. Pure; exported for tests.
 * @param {Record<string, string | undefined>} [env]
 */
export function parkIdleMsFromEnv(env = process.env) {
  const raw = env?.PAPERCUSP_PSU_PARK_IDLE_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PARK_IDLE_MS;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PARK_IDLE_MS;
  return Math.floor(n);
}

/**
 * Count the live descendant processes of `rootPid` from /proc (one ppid map
 * built from every /proc/<pid>/stat, then a walk down from the root). The park
 * policy refuses while the CLI has ANY descendant: a running background shell,
 * an in-flight hook or a stdio MCP server is work a SIGKILL of the tree would
 * destroy. Returns null when the count cannot be taken (no /proc, unreadable
 * root), and the policy FAILS CLOSED on null. Exported for tests (procRoot and
 * the fs readers are injectable).
 * @param {number} rootPid
 * @param {{ procRoot?: string, readdir?: (p: string) => string[], readFile?: (p: string, enc: 'utf8') => string }} [opts]
 * @returns {number | null}
 */
export function countProcessDescendants(
  rootPid,
  { procRoot = '/proc', readdir = readdirSync, readFile = readFileSync } = {},
) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  let entries;
  try {
    entries = readdir(procRoot);
  } catch {
    return null;
  }
  const childrenOf = new Map();
  let sawRoot = false;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFile(`${procRoot}/${name}/stat`, 'utf8');
    } catch {
      continue; // exited between readdir and read — not a descendant any more
    }
    // `pid (comm) state ppid …` — comm may contain spaces or ')', so split
    // after the LAST ')'.
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]);
    const pid = Number(name);
    if (pid === rootPid) sawRoot = true;
    if (!Number.isInteger(ppid)) continue;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  if (!sawRoot) return null;
  let count = 0;
  const stack = [...(childrenOf.get(rootPid) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    count++;
    for (const kid of childrenOf.get(pid) ?? []) stack.push(kid);
  }
  return count;
}

/**
 * psu-process-free-parking-2026-10-06 P-016: should the host park its child
 * NOW? Every refusal names its reason (reported on the host event so "why
 * didn't it park" is a read, not a guess). Ordered cheapest-first; the caller
 * only pays for the /proc descendant walk when every other gate passed (pass a
 * `descendants` thunk). Pure; exported for tests.
 *
 * @param {{
 *   idleMs: number,
 *   agent?: string | null,
 *   now: number,
 *   lastActivityAt: number,
 *   childPromptReady: boolean,
 *   parked?: boolean,
 *   busy?: boolean,
 *   quotaBlocked?: boolean,
 *   composerPending?: boolean,
 *   resumable?: boolean,
 *   descendants: () => number | null,
 * }} input
 * @returns {{ park: boolean, reason: string, idleForMs?: number, descendants?: number | null }}
 */
export function parkVerdict({
  idleMs,
  agent = null,
  now,
  lastActivityAt,
  childPromptReady,
  parked = false,
  busy = false,
  quotaBlocked = false,
  composerPending = false,
  resumable = true,
  descendants,
}) {
  if (!(Number.isFinite(idleMs) && idleMs > 0)) return { park: false, reason: 'disabled' };
  if (String(agent ?? '').trim().toLowerCase() !== 'claude') {
    return { park: false, reason: 'agent-not-parkable' };
  }
  if (parked) return { park: false, reason: 'already-parked' };
  if (busy) return { park: false, reason: 'busy' };
  // D-005: a quota-walled Claude TUI can hold a submission it auto-continues at
  // the reset ("continuing automatically at 1pm"). That pending turn lives only
  // in the CLI's memory, so a SIGKILL would drop it silently. Stay resident
  // until the wall clears; the reset turn then runs and the child parks after.
  if (quotaBlocked) return { park: false, reason: 'quota-wait' };
  if (!resumable) return { park: false, reason: 'no-resumable-session-id' };
  if (!childPromptReady) return { park: false, reason: 'prompt-not-ready' };
  if (composerPending) return { park: false, reason: 'composer-pending' };
  const idleForMs = Math.max(0, now - (Number(lastActivityAt) || 0));
  if (idleForMs < idleMs) return { park: false, reason: 'not-idle-long-enough', idleForMs };
  const n = typeof descendants === 'function' ? descendants() : null;
  if (n === null || n === undefined) {
    return { park: false, reason: 'descendants-unknown', idleForMs, descendants: null };
  }
  if (n > 0) return { park: false, reason: 'child-has-descendants', idleForMs, descendants: n };
  return { park: true, reason: 'idle', idleForMs, descendants: 0 };
}

/**
 * psu-process-free-parking P-017: the id of the newest top-level Claude
 * transcript in a PER-SESSION config dir (`<configDir>/projects/<cwd>/<id>.jsonl`).
 * An in-TUI `/clear` starts a new conversation under a new id that the launch
 * argv never learns, so resuming the argv's id alone could revive the wrong
 * conversation. Only trusted when the config dir is this session's isolation
 * dir (its path names `ownerId`): in a shared dir the newest file can belong to
 * another session. Returns null when it cannot tell. Exported for tests.
 * @param {string | null | undefined} configDir
 * @param {{ ownerId?: string | null, readdir?: (p: string) => string[], stat?: (p: string) => { mtimeMs: number, isFile: () => boolean } }} [opts]
 * @returns {{ id: string, mtimeMs: number } | null}
 */
export function newestSessionTranscriptId(
  configDir,
  { ownerId = null, readdir = readdirSync, stat = statSync } = {},
) {
  if (!configDir || !ownerId || !String(configDir).includes(String(ownerId))) return null;
  const projects = `${configDir}/projects`;
  let dirs;
  try {
    dirs = readdir(projects);
  } catch {
    return null;
  }
  /** @type {{ id: string, mtimeMs: number } | null} */
  let best = null;
  for (const dir of dirs) {
    let files;
    try {
      files = readdir(`${projects}/${dir}`);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      let st;
      try {
        st = stat(`${projects}/${dir}/${file}`);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { id: file.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/**
 * Session activity tracker (agent-liveness-heartbeat-hardening-2026-06-12
 * P-006): the OUTPUT-side sibling of makeIdleGate. The pty stream is a true
 * mid-turn signal — a generating agent repaints its TUI constantly — so
 * `lastOutputAt` distinguishes *generating* from *idle-at-prompt*, which
 * process-aliveness alone cannot. ANNOTATE-ONLY by design (plan D-002):
 * this feeds the discovery file / roster display, never the claim-release
 * rule — an attended-but-quiet session keeps its claims.
 * Pure (injectable clock); exported for tests.
 */
export function makeActivityTracker({ now = Date.now } = {}) {
  let lastInputAt = 0;
  let lastOutputAt = 0;
  return {
    touchInput() {
      lastInputAt = now();
    },
    touchOutput() {
      lastOutputAt = now();
    },
    snapshot() {
      return {
        lastInputAt: lastInputAt || null,
        lastOutputAt: lastOutputAt || null,
        lastActivityAt: Math.max(lastInputAt, lastOutputAt) || null,
      };
    },
  };
}

/**
 * How long a SHUTDOWN gives the child to exit on SIGHUP before the host escalates
 * to a whole-process-tree SIGKILL. A claude TUI flushes its transcript on SIGHUP,
 * so the pause is what makes the exit clean rather than lossy.
 */
export const SHUTDOWN_GRACE_MS = Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_GRACE_MS) || 4_000;

/**
 * How long an accepted SHUTDOWN waits before it starts killing, so the control
 * connection's ACK is written and flushed first. Without this the shutdown tears
 * down its own socket mid-ack and the requester reads a SUCCESSFUL shutdown as a
 * transport miss — the exact confusion that makes a caller retry a session that is
 * already on its way out.
 */
export const SHUTDOWN_ACK_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_ACK_DELAY_MS) || 250;

/**
 * PURE: may this host honour a `mode:'shutdown'` request? Returns `null` to
 * proceed, or the REFUSAL REASON string (WI-6638).
 *
 * This is the ONLY thing standing between "close a finished agent's tab" and
 * "close the window the owner is typing in", so it is deliberately strict and
 * fails toward REFUSING. Both human guards are unconditional — `force` waives
 * ONLY the mid-turn check, never them:
 *
 *  1. `launchedBy` — set from `PAPERCUSP_LAUNCHED_BY`, which `injectLaunchedByArg`
 *     (agent-launch-core) stamps onto EVERY tool-driven psu launch and which an
 *     owner-typed `psu` never carries. This is a STRUCTURAL discriminator, not a
 *     heuristic. A structurally headless host bound to a named fleet is the one
 *     equivalent discriminator: it has no human TTY to own and the fleet stamp is
 *     injected by bootstrap. This covers operator-spawned headless members whose
 *     launch path predates `PAPERCUSP_LAUNCHED_BY` without weakening interactive
 *     sessions, which still fail closed when the marker is absent.
 *  2. `lastInputAt` — real stdin bytes on a bridged TTY (makeActivityTracker's
 *     touchInput; socket-injected agent wakes never reach stdin). ANY human
 *     keystroke, ever, makes this session the owner's. A headless member has no
 *     stdin bridge, so this stays 0 and never blocks it.
 *
 * Why not reuse the idle-session reaper's policy instead: measured 2026-08-03,
 * `findIdleLiveSessions()` returns 0 for this whole cohort — every psu session
 * classifies `driveMode:'responsive'` (agent-pane-kind rule 5) and is excluded by
 * the queen-fleet-authority-boundary ruling P-001/D-001 before the window guard is
 * ever consulted. A system reaper may not kill these; only the session itself may
 * exit. Nothing here loosens `terminalWindowAlive`/`cgroupWindowProtects` — this
 * path never signals a process it does not own.
 */
export function shutdownRefusalReason({
  launchedBy = '',
  headless = false,
  fleetSlug = '',
  lastInputAt = 0,
  agentQuietMs = Infinity,
  force = false,
  quietMs = OUTPUT_QUIET_MS,
} = {}) {
  const structurallyAgentOwned =
    Boolean(String(launchedBy || '').trim()) ||
    (headless === true && Boolean(String(fleetSlug || '').trim()));
  if (!structurallyAgentOwned) return 'not-agent-launched';
  if (Number(lastInputAt) > 0) return 'human-attended';
  if (!force && Number(agentQuietMs) < quietMs) return 'agent-busy';
  return null;
}

/**
 * Agent-busy (mid-turn) inject gate (coord-wake-mid-turn-2026-06-30). The
 * OUTPUT-side sibling of makeIdleGate: makeIdleGate defers a `turn` while the
 * HUMAN is mid-keystroke; THIS gate defers it while the AGENT is mid-turn. A
 * `turn` (text + CR) written into a generating TUI wedges it (needs ESC) — so we
 * hold the inject until the agent is back at its prompt, read off the pty output
 * stream (the established mid-turn signal — makeActivityTracker, P-006).
 *
 *   lastOutputAt() → ms epoch of the agent's most recent pty output (0 = none yet,
 *                    treated as "quiet"/at-prompt).
 *   waitAtPrompt() → resolves { deferred:false } once output has been quiet for
 *                    quietMs (agent at prompt → safe to inject), or
 *                    { deferred:true, reason:'agent-busy' } if the agent stays busy
 *                    past capMs (caller SKIPS the live inject; the durable inbox
 *                    message stands for the next natural turn).
 *
 * Pure (injectable clock + getter); exported for tests.
 *
 * The `@param` tags below are LOAD-BEARING, not decoration: gen:declarations
 * infers this signature into psu-pty-host.d.mts, and with prose-only JSDoc it
 * derived the options type from DEFAULTS ALONE — silently dropping
 * `lastOutputAt` (the one option with no default) from the emitted type while
 * leaving it in the binding pattern. Every typed caller passing it then failed
 * TS2353 against a parameter the implementation has always accepted.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.lastOutputAt] ms epoch of the agent's most recent
 *   pty output; 0 / absent ⇒ never seen ⇒ treated as quiet (at its prompt).
 * @param {number} [opts.quietMs]
 * @param {number} [opts.capMs]
 * @param {() => number} [opts.now]
 */
export function makeAgentBusyGate({
  lastOutputAt,
  quietMs = OUTPUT_QUIET_MS,
  capMs = TURN_INJECT_BUSY_CAP_MS,
  now = Date.now,
} = {}) {
  const getLast = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  return {
    /** ms the agent output has been quiet (huge when never seen ⇒ at-prompt).
     *  Pure helper, exported for tests. */
    quietForMs(t = now()) {
      return t - (getLast() || 0);
    },
    /** Resolve once output has been quiet for quietMs (agent at its prompt), or
     *  defer after capMs (agent still mid-turn — drop the live inject).
     *  WI-1872 (1): `overrideCapMs` lets a caller use a DIFFERENT completion
     *  budget than this gate's own construction-time `capMs` without needing a
     *  second gate instance over the same activity tracker.
     *
     *  @param {number | null} [overrideCapMs]
     *  @param {(() => boolean) | null} [verifiedBoundary] predicate proving the
     *    agent's native turn genuinely completed (see the `verifiedBoundary?.()`
     *    call below). The bare `= null` default alone made gen:declarations infer
     *    the LITERAL type `null`, which rejected every real caller — including
     *    this file's own at the codex carry and verified-boundary sites. */
    async waitAtPrompt(overrideCapMs, verifiedBoundary = null) {
      const effectiveCapMs = overrideCapMs ?? capMs;
      const deadline = now() + effectiveCapMs;
      // EI-19480099650947832: track the LONGEST quiet window actually observed,
      // and report it on a defer. Without it, "the busy-gate expired" is an
      // unfalsifiable verdict — a carry-respawn can re-poll for 14 minutes and
      // the log says only `busy-gate-expired`, leaving no way to tell a genuinely
      // busy agent (gaps ≈ 0ms, a TUI spinner redrawing) from a near-miss
      // (gaps ≈ quietMs, i.e. the threshold is simply too tight). Those two have
      // OPPOSITE fixes, and reconstructing which one happened after the fact is
      // impossible — measured live on 2026-08-04, where a respawn died with no
      // evidence either way.
      let maxQuietForMs = 0;
      // Re-check in case the agent keeps emitting during the wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (verifiedBoundary?.()) {
          await new Promise((resolve) => setImmediate(resolve));
          if (verifiedBoundary()) return { deferred: false, boundary: 'native-turn-complete' };
        }
        const quietFor = this.quietForMs();
        if (quietFor > maxQuietForMs) maxQuietForMs = quietFor;
        if (quietFor >= quietMs) {
          // EI-22806311344295685: an expired timer can run before libuv's poll
          // phase drains an already-buffered node-pty onData callback. Yield to
          // the check phase once, then re-read the output timestamp; otherwise
          // the stale pre-poll value can release an inject into a child that is
          // still emitting. setImmediate is deliberate here: unlike another
          // timer, it runs after the current iteration's poll callbacks.
          //
          // P-004 / D-005: this stays a SINGLE confirmation on purpose. The
          // plan originally called for retrying it a bounded number of times to
          // rescue the 629/3,485 defers (18.0%) that had already observed a
          // quiet window >= quietMs. Simulating the loop showed that cannot
          // work: a collapsed confirmation means a buffered onData callback was
          // just drained, and draining it stamps lastOutputAt = now, so every
          // additional setImmediate re-read sees ~0ms of quiet. A retry adds
          // ticks and recovers nothing. (One setImmediate is also sufficient by
          // construction — a poll phase drains ALL queued callbacks, not one.)
          // Those defers are fixed by the NATIVE boundary proof (P-003), which
          // does not depend on the pty ever going quiet.
          await new Promise((resolve) => setImmediate(resolve));
          const confirmedQuietFor = this.quietForMs();
          if (confirmedQuietFor > maxQuietForMs) maxQuietForMs = confirmedQuietFor;
          if (confirmedQuietFor >= quietMs) return { deferred: false };
        }
        if (now() >= deadline) return { deferred: true, reason: 'agent-busy', maxQuietForMs, quietMs };
        // P-004 (the part that IS a real defect): recompute the sleep from the
        // CURRENT quiet window, not the stale pre-confirmation `quietFor`.
        //
        // When quietFor >= quietMs but the confirmation collapsed, the old
        // `quietMs - quietFor` was <= 0, so `Math.max(10, wait)` slept 10ms.
        // MEASURED: that costs exactly ONE wasted 10ms iteration, not a spin to
        // the cap — the next pass reads the fresh value and sleeps properly
        // (10, 1490, 1500, 1500, …). So this is a micro-correction, NOT the
        // false-defer fix; see D-005 for the retraction of that claim.
        const need = Math.max(0, quietMs - this.quietForMs());
        const wait = Math.min(need, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
    /** WI-1872 (2): the START-RACE fix. Resolves as soon as output goes BUSY
     *  (quietForMs drops below quietMs — the agent started emitting), so a
     *  caller can safely gate the NEXT wait (waitAtPrompt, for completion) on
     *  actual activity instead of a fixed delay. Falls back to `{ started:
     *  false }` after `capMs` if busy is never observed — the caller should
     *  treat that exactly like the old fixed-delay behavior (proceed anyway;
     *  the completion-wait's own quiet check still protects against writing
     *  into a truly still-busy TUI). Pure — exported via the gate object. */
    async waitUntilBusy(capMs) {
      const deadline = now() + capMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.quietForMs() < quietMs) return { started: true };
        if (now() >= deadline) return { started: false };
        await new Promise((r) => setTimeout(r, Math.max(10, Math.min(50, deadline - now()))));
      }
    },
  };
}

/**
 * Carry-respawn drill RE-ARM controller (EI-12754, the leader-concurred re-arm
 * leg deferred out of the EI-12655 diff). A carry-respawn DRILL refused at the
 * busy-gate bail used to terminally drop on the FIRST refusal — correct for a
 * wake `turn` (the durable inbox stands for the next natural turn) but lossy
 * for a drill, whose whole point is the cut. This schedules exactly ONE
 * deferred retry at the next settled turn:
 *
 *   - same clean-boundary discipline (the retry re-acquires the inject mutex
 *     and re-waits the SAME agent-busy gate — no timer polling of its own, the
 *     gate's quiet check is the settle detector; D-006 never-kill-mid-turn holds);
 *   - once-only per drillId (a permanently-busy session drops LOUD on the
 *     re-armed attempt instead of looping);
 *   - every path emits a durable event: 'carry-drill-rearm-queued' when the
 *     retry is scheduled (non-terminal — op:'report'/'verify' ignore it), then
 *     either recycle()'s own terminal delivered/dropped events, or a terminal
 *     'carry-drill-carry-dropped' { rearmed:true } when the retry also defers
 *     or throws.
 *
 * WI-5368/WI-5530: this ALSO covers the PRODUCTION (non-drill) carry-respawn —
 * the session:request-compaction path every real agent uses, which carries no
 * drillId. It re-queues/retries identically, under a shared non-drill sentinel
 * key, and emits 'respawn-rearm-queued' / 'respawn-carry-dropped' rows (the
 * mode-keyed analogs of the drill rows). Previously schedule()'s `!drillId`
 * early-return made every production respawn report 'duplicate' and silently
 * drop — the busy-gate-deferred real compaction left ZERO durable trace and no
 * retry, even though op:report had already told the caller `respawn:true`.
 *
 * Pure factory (injected deps) in the makeAgentBusyGate style; exported for tests.
 */
// Shared dedupe key for non-drill (production) carry-respawns — they have no
// drillId, so concurrent production respawns collapse to ONE pending retry
// under this sentinel instead of colliding with the old `!drillId` early-return.
const NON_DRILL_REARM_KEY = '__non-drill__';

// WI-5623: optional anti-spin backstop for the production carry-respawn
// re-poll loop. Production compaction carries are MUST-DELIVER and therefore
// have no age-based expiry; the default is unbounded because the real gate
// sleeps between attempts. Tests may inject a finite value to exercise the
// terminal drill/backstop behavior without creating an infinite promise loop.
export function makeCarryRearmController({
  acquireInject, // () => Promise<release()>  — the host's gated-inject mutex
  waitIdle = /** @type {null | (() => Promise<{ deferred: boolean, reason?: string } | void>)} */ (null),
  hasPendingOwnerInput = () => false,
  waitForOwnerInputClear = /** @type {null | (() => Promise<{ deferred: boolean, reason?: string } | void>)} */ (null),
  waitAtPrompt, // (capMs?) => Promise<{ deferred }>
  recycle, // (data, { systemPromptAddendum, drillId, sessionClass }) => Promise<void>
  // P-005: how a re-armed message is actually DELIVERED once the agent finally
  // idles. `recycle` above is carry-respawn's action (replace the child), which
  // is why the re-arm was carry-only: a deferred `turn` must be RE-INJECTED,
  // not recycled, and recycling one would destroy the very turn it was meant to
  // deliver. Injecting this as a callback keeps every mode's delivery semantics
  // owned by the host (which already has the verified primitives) while the
  // supersede/duplicate/settle/anti-spin machinery stays here, shared.
  //
  // Defaulting to null preserves the existing unit callers that construct this
  // controller with `recycle` alone.
  /** @type {null | ((message: any, ctx: {drillId: string, mode: string, key: string}) => Promise<{delivered: boolean, reason?: string} | void>)} */
  performDelivery = null,
  emitEvent, // (kind, extra) => void — writes BOTH the per-owner host log + shared ledger
  capMs = TURN_INJECT_BUSY_CAP_MS * 2,
  maxProductionAttempts = Number.POSITIVE_INFINITY,
  // Production retries are unbounded. When staged owner input is already
  // known, yield to the host's timers/input events instead of spinning only
  // through immediately-resolved promise microtasks.
  yieldAfterDefer = () => new Promise((resolve) => setImmediate(resolve)),
  // The detached re-arm owns the eventual delivery-id settlement after the
  // first busy-gate attempt returns. The host wires this to its dedup table;
  // unit callers can omit it.
  onSettlement = (_messages, _outcome) => {},
  // EI-18109211232286833: (msg) => boolean — re-checked right before this
  // retry finally recycles, since the whole point of the retry is that a LOT
  // of wall-clock time (the first busy-gate wait + this re-arm's) may have
  // passed since the message first arrived. Default always-false preserves
  // every existing controller unit test unchanged; the real host wires
  // isCarryRespawnStale at construction (see carryRearm below).
  isStale = () => false,
  // Age may not expire a production continuation. Epoch supersession MUST:
  // an obsolete request must neither suppress wakes nor replace its successor.
  isSuperseded = (_msg) => false,
  // Production carry-respawns are admitted only when the effective per-owner
  // wake mode is explicitly `auto`. Null/throws fail closed and leave the carry
  // pending for a paced re-read; non-carry wake modes keep their own delivery
  // policy and are not gated here.
  readWakeMode = async () => 'auto',
  wakeModeRetryMs = 30_000,
  waitWakeModeRetry = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  const pending = new Set();
  // EI-18681914950138372: a SEPARATE tracking set, covering the carry-respawn's
  // FIRST delivery attempt — from the moment the host accepts the message
  // through to that attempt's conclusion (delivered / dropped / handed off to
  // a retry). `pending` (above) only covers the RETRY phase, which begins only
  // once `schedule()` runs — i.e. only after the first busy-gate wait has
  // already timed out. shouldDeferWakeForPendingRespawn's whole purpose is to
  // stop a fresh wake `turn` from winning the inject-mutex FIFO race against
  // this carry-respawn, but during that entire first wait (which can run the
  // full busy-gate cap, e.g. minutes) `pending` is still empty — a wake
  // arriving in that window sailed through the guard unfiltered, queued on the
  // mutex BEFORE the eventual retry does, and won it every time (see
  // beginFirstAttempt/endFirstAttempt call sites for the exact mechanics).
  // `inFlight` closes that gap; `pendingCount()` below reports the union.
  // Identity, not the shared production sentinel: finishing one accepted
  // request must not erase another. Set.delete keeps duplicate finalization safe.
  const inFlight = new Set();
  // EI-19480099650947832: the FRESHEST carry message per key. A production
  // respawn's re-poll loop re-reads this at the top of every attempt, so a
  // second request-compaction arriving mid-re-poll SUPERSEDES the payload
  // instead of being terminally dropped (see schedule() below).
  const latest = new Map();
  const pendingMessages = new Map();
  /**
   * P-005: the re-arm now covers EVERY gated mode, so the non-drill sentinel
   * must be namespaced BY MODE.
   *
   * Sharing one `__non-drill__` slot across modes would make a deferred `turn`
   * collide with a pending carry-respawn: whichever arrived second would be
   * reported 'duplicate'/'superseded' by the other and never delivered —
   * re-creating the exact drop this item removes, disguised as correct dedupe.
   * Drills still dedupe per drillId, which is already unique.
  */
  const rearmModeOf = (msg) => String(msg?.mode || 'carry-respawn');
  const carryWakeModePauseReason = async (msg) => {
    if (rearmModeOf(msg) !== 'carry-respawn') return null;
    let currentMode = null;
    try {
      currentMode = await readWakeMode(msg);
    } catch {
      // Unreadable mode is not evidence of auto; preserve the pending carry.
    }
    if (currentMode === 'auto') return null;
    return currentMode === 'manual' ? 'wake-mode-manual' : 'wake-mode-unavailable';
  };
  const keyFor = (msg) => {
    const drillId = String(msg?.drillId || '');
    return drillId || `${NON_DRILL_REARM_KEY}:${rearmModeOf(msg)}`;
  };
  const settle = (key, outcome) => {
    const messages = [...(pendingMessages.get(key) ?? [])];
    onSettlement(messages, outcome);
  };
  return {
    /** Live count of accepted first attempts and re-armed retries.
     *  Filter carry-respawn for wake arbitration: the controller also owns
     *  turn retries, which must never suppress themselves as pending carries.
     *  @param {string | null} [mode]
     */
    pendingCount(mode = null) {
      if (mode == null) return pending.size + inFlight.size;
      return [...pending].filter((key) => rearmModeOf(latest.get(key)) === mode).length +
        [...inFlight].filter((msg) => rearmModeOf(msg) === mode).length;
    },
    /** Whether a message is still owned by the detached re-arm loop. */
    isPendingMessage(msg) {
      const key = keyFor(msg);
      return pendingMessages.get(key)?.has(msg) === true;
    },
    /**
     * Refresh an already-queued retry only when the same delivery is still the
     * current payload. A later distinct delivery may have superseded it, so a
     * delayed duplicate of the older id must never roll the re-arm backwards.
     * Keep the original receipt time: retrying the delivery updates its snapshot,
     * not its age or ordering against a newer host generation.
     */
    refreshPendingMessage(msg) {
      const key = keyFor(msg);
      const deliveryId = String(msg?.deliveryId ?? '');
      if (!deliveryId || !pending.has(key)) return false;
      const current = latest.get(key);
      if (String(current?.deliveryId ?? '') !== deliveryId) return false;
      latest.set(key, {
        ...current,
        ...msg,
        receivedAtMs: current.receivedAtMs,
      });
      return true;
    },
    /** EI-18681914950138372: call the MOMENT a carry-respawn control message is
     *  accepted by the host, before it enters its own busy-gate wait — marks it
     *  in-flight so a wake arriving during that wait is correctly deferred. */
    beginFirstAttempt(msg) {
      inFlight.add(msg);
    },
    /** EI-18681914950138372: call exactly once, when that first attempt has
     *  fully concluded (delivered, dropped, errored, or handed off to
     *  schedule() below) — safe to call unconditionally: schedule() always
     *  adds to `pending` before this fires, so pendingCount() never dips to 0
     *  mid-handoff, and a duplicate/idempotent delete on an already-cleared
     *  key is a no-op. */
    endFirstAttempt(msg) {
      inFlight.delete(msg);
    },
    /**
     * Schedule the one-shot retry for a busy-gate-refused carry-respawn drill.
     * Returns 'queued' when scheduled, 'duplicate' when a retry for this drillId
     * is already pending (the caller should terminally drop instead), or
     * 'superseded' when a PRODUCTION respawn replaced the payload of an
     * already-pending re-poll (EI-19480099650947832 — nothing is dropped).
     */
    schedule(msg) {
      const drillId = String(msg?.drillId || '');
      const isDrill = !!drillId;
      // Drills dedupe per-drillId; a production respawn (no drillId) dedupes
      // under the shared sentinel — so a drill and a production respawn can be
      // pending independently, but two production respawns collapse to one.
      const mode = rearmModeOf(msg);
      const key = keyFor(msg);
      if (pending.has(key)) {
        // EI-19480099650947832: a SECOND production respawn arriving while the
        // first is still re-polling used to be terminally DROPPED as a
        // duplicate — which KEPT the older carry (already failing, and destined
        // to age out at CARRY_RESPAWN_MAX_AGE_MS) and DISCARDED the fresher one
        // the agent had just built. Measured 2026-08-04 on session
        // su-4a6e2255-…: `respawn-carry-dropped {reason:'busy-gate-expired',
        // capMs:180000, rearmed:true}` at 00:38:29, while the re-poll queued at
        // 00:28:00 ran on fruitlessly for another 14 minutes. The newest
        // request is strictly the better one to deliver (newer carry document,
        // newer receivedAtMs, so it also survives the staleness guard longer),
        // so the in-flight re-poll ADOPTS it. A DRILL still dedupes terminally:
        // a drill is a one-shot test whose whole point is that single shot.
        if (isDrill) return 'duplicate';
        pendingMessages.get(key)?.add(msg);
        latest.set(key, msg);
        return 'superseded';
      }
      pending.add(key);
      pendingMessages.set(key, new Set([msg]));
      latest.set(key, msg);
      // P-005: carry-respawn keeps its EXISTING kind names verbatim — the
      // drill ledger, op:'report'/op:'verify' and the historical event census
      // all key off them, so renaming would silently orphan that history. The
      // newly-covered modes get their own kinds instead of being folded into a
      // 'respawn-*' name that would misreport what was retried.
      const queuedKind = isDrill
        ? 'carry-drill-rearm-queued'
        : mode === 'carry-respawn' ? 'respawn-rearm-queued' : 'wake-rearm-queued';
      const droppedKind = isDrill
        ? 'carry-drill-carry-dropped'
        : mode === 'carry-respawn' ? 'respawn-carry-dropped' : 'wake-rearm-dropped';
      // Drill rows carry drillId + sessionClass (P-020 correlation); a production
      // row is keyed by `mode` instead — never a fabricated/empty drillId.
      const extra = isDrill
        ? { drillId, sessionClass: msg.sessionClass ?? '', reason: 'busy-gate-expired', capMs }
        : {
          mode,
          reason: 'busy-gate-expired',
          capMs,
          ...(msg?.deliveryId ? { deliveryId: String(msg.deliveryId) } : {}),
        };
      // R-1 JOIN KEY. Every terminal row of a production re-arm names EVERY
      // delivery id it settles (a supersede folds later messages into the same
      // key), so a census can prove each queued deferral reached exactly one
      // outcome. Without it, "N queued, M delivered" is existence-only: one
      // abandoned deferral among hundreds of deliveries reads as healthy.
      const settledIds = () => [...(pendingMessages.get(key) ?? [])]
        .map((m) => m?.deliveryId)
        .filter(Boolean)
        .map(String);
      // Drill rows keep their P-020 shape; only production rows gain the key.
      const terminalIds = () => (isDrill ? {} : { deliveryIds: settledIds() });
      emitEvent(queuedKind, extra);
      void (async () => {
        // WI-5623: a DRILL is a one-shot test — it re-arms ONCE then drops
        // (unchanged, EI-12754). A PRODUCTION (non-drill) carry-respawn is a
        // MUST-DELIVER: the session called session:request-compaction and runs
        // to the hard context wall if it never compacts. An autonomous/headless
        // session rarely presents the 1.5s idle window inside a SINGLE busy-gate
        // window, so a single retry meant 0% delivery (every production respawn
        // dropped 'busy-gate-expired'). Instead it RE-POLLS across successive
        // windows — RELEASING the inject mutex between attempts so coord/loop
        // wakes to this session are never wedged — until the agent idles and
        // the carry is delivered. Production has no age-based drop; drills
        // remain bounded by their one-shot contract.
        // Production compaction is a MUST-DELIVER continuation. A live session
        // may spend longer than the historical 30-minute stale/attempt budget
        // in one continuously-rendering turn; dropping the carry then strands
        // the session at its context ceiling. Drills remain bounded experiments.
        const maxAttempts = isDrill ? 1 : maxProductionAttempts;
        // EI-19480099650947832: carried onto every terminal row so a drop says
        // WHY it could never fire — see waitAtPrompt's maxQuietForMs comment.
        let observedMaxQuietMs = 0;
        let attemptsMade = 0;
        let deferReason = 'busy-gate-expired';
        const dropSuperseded = (candidate) => {
          if (!isSuperseded(candidate)) return false;
          emitEvent(droppedKind, {
            ...extra, rearmed: true, reason: 'superseded',
            observedMaxQuietMs, attempts: attemptsMade, ...terminalIds(),
          });
          settle(key, { delivered: false, reason: 'superseded' });
          return true;
        };
        try {
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            attemptsMade = attempt + 1;
            const release = await acquireInject();
            // EI-19480099650947832: re-read the payload EVERY attempt — a later
            // request-compaction may have superseded it since the last one, and
            // the freshest carry document is always the right one to deliver.
            const current = latest.get(key) ?? msg;
            let deferred = false;
            let wakeModePauseReason = null;
            try {
              // Check BEFORE waiting on the successor's output. Otherwise an
              // obsolete retry can retain pending wake suppression indefinitely.
              if (dropSuperseded(current)) return;
              if (waitIdle) {
                const idle = await waitIdle();
                if (dropSuperseded(latest.get(key) ?? current)) return;
                if (idle?.deferred) {
                  deferReason = idle.reason || 'owner-input-cap';
                  await yieldAfterDefer();
                  continue;
                }
              }
              if (hasPendingOwnerInput()) {
                const clear = waitForOwnerInputClear ? await waitForOwnerInputClear() : null;
                if (dropSuperseded(latest.get(key) ?? current)) return;
                if (clear?.deferred || hasPendingOwnerInput()) {
                  deferReason = clear?.reason || 'owner-input-cap';
                  await yieldAfterDefer();
                  continue;
                }
                deferReason = 'busy-gate-expired';
              }
              // Check immediately before and after the potentially long prompt
              // wait. A manual flip or a failed read pauses this retry without
              // consuming the carry or holding the inject mutex.
              let atPrompt = null;
              wakeModePauseReason = await carryWakeModePauseReason(current);
              if (wakeModePauseReason) deferReason = wakeModePauseReason;
              if (!wakeModePauseReason) {
                atPrompt = await waitAtPrompt(capMs, current);
                if (dropSuperseded(latest.get(key) ?? current)) return;
                // The owner may have started composing during the prompt wait.
                if (hasPendingOwnerInput()) {
                  // Re-enter through the composer wait AND a fresh prompt check.
                  // Enter may have started a new owner turn: the prompt proof we
                  // observed before that input is no longer a safe cut boundary.
                  deferReason = 'owner-input-cap';
                  await yieldAfterDefer();
                  continue;
                }
                if (Number.isFinite(atPrompt?.maxQuietForMs) && atPrompt.maxQuietForMs > observedMaxQuietMs) {
                  observedMaxQuietMs = atPrompt.maxQuietForMs;
                }
                wakeModePauseReason = await carryWakeModePauseReason(latest.get(key) ?? current);
                if (wakeModePauseReason) deferReason = wakeModePauseReason;
              }
              if (!wakeModePauseReason) {
                deferred = !!atPrompt?.deferred;
                deferReason = 'busy-gate-expired';
              }
              if (!wakeModePauseReason && !deferred) {
                // EI-19480099650947832: re-read ONCE MORE at the delivery point.
                // `current` was read before the wait, and a supersede can land at
                // ANY await — including the one we just returned from. This is
                // the branch where the carry document is actually consumed, so
                // reading a stale `current` here would cut in the older carry
                // even though a fresher one had already arrived.
                const deliver = latest.get(key) ?? current;
                // EI-18109211232286833: re-check staleness right before the cut —
                // a lot of wall-clock may have passed across these waits, so a
                // message fresh at schedule() time can cross the threshold.
                if (isDrill && isStale(deliver)) {
                  emitEvent(droppedKind, {
                    ...extra,
                    rearmed: true,
                    reason: 'carry-stale',
                    observedMaxQuietMs,
                    attempts: attemptsMade,
                  });
                  settle(key, { delivered: false, reason: 'carry-stale' });
                  return;
                }
                const result = performDelivery
                  ? await performDelivery(deliver, { drillId, mode, key })
                  : await recycle(deliver.data, {
                    systemPromptAddendum: deliver.systemPromptAddendum ?? '',
                    drillId,
                    sessionClass: deliver.sessionClass ?? '',
                  });
                const outcome = result ?? { delivered: false, reason: 'recycle-outcome-unavailable' };
                // R-1: the newly-covered modes had NO terminal row on this path.
                // A performDelivery that returned delivered:false (the turn
                // verifier aborted or exhausted) settled silently — the one
                // outcome the re-arm exists to make impossible. carry-respawn
                // keeps its existing recycle-side rows (renaming would orphan
                // the drill ledger), and drills keep their P-020 shape.
                if (performDelivery && !isDrill && mode !== 'carry-respawn') {
                  emitEvent(outcome.delivered ? 'wake-rearm-delivered' : droppedKind, {
                    ...extra,
                    rearmed: true,
                    reason: outcome.delivered ? 'delivered' : String(outcome.reason ?? 'undelivered'),
                    observedMaxQuietMs,
                    attempts: attemptsMade,
                    ...terminalIds(),
                  });
                }
                settle(key, outcome);
                return;
              }
            } finally {
              // Release BETWEEN attempts — never hold the gated-inject mutex
              // across the re-poll, or this session's wakes would wedge for the
              // whole (potentially many-window) wait.
              release();
            }
            if (wakeModePauseReason) {
              // Do not spin on an unavailable admin read or stage a carry that
              // was already accepted. Release first, then re-read at a paced
              // interval so owner wakes can still acquire the shared mutex.
              try {
                await waitWakeModeRetry(wakeModeRetryMs, wakeModePauseReason);
              } catch {
                // A test/custom waiter failure must not turn a pause into a
                // terminal drop; preserve the payload and retain the cadence.
                await new Promise((resolve) => setTimeout(resolve, wakeModeRetryMs));
              }
              continue;
            }
            // Deferred: the agent stayed mid-turn past the cap. Production
            // carries continue to the next window; drills fall out after their
            // one shot.
            // EI-19480099650947832: re-read AGAIN here — a supersede that landed
            // DURING this attempt must not be killed off by the staleness of the
            // message this attempt happened to start with. That is the whole
            // point of superseding: the fresher carry resets the clock.
            if (isDrill && isStale(latest.get(key) ?? current)) {
              emitEvent(droppedKind, {
                ...extra,
                rearmed: true,
                reason: 'carry-stale',
                observedMaxQuietMs,
                attempts: attemptsMade,
              });
              settle(key, { delivered: false, reason: 'carry-stale' });
              return;
            }
          }
          // A drill's single shot deferred, or a production respawn exhausted the
          // anti-spin cap without ever idling — terminal, loud.
          emitEvent(droppedKind, {
            ...extra, rearmed: true, reason: deferReason,
            observedMaxQuietMs, attempts: attemptsMade, ...terminalIds(),
          });
          settle(key, { delivered: false, reason: deferReason });
        } catch (error) {
          emitEvent(droppedKind, {
            ...extra,
            rearmed: true,
            reason: 'rearm-error',
            detail: String(error?.message ?? error).slice(0, 200),
            ...terminalIds(),
          });
          settle(key, { delivered: false, reason: 'rearm-error' });
        } finally {
          pending.delete(key);
          latest.delete(key);
          pendingMessages.delete(key);
        }
      })();
      return 'queued';
    },
  };
}

/**
 * Submit verifier (WI-2930) — the POST-submit sibling of makeAgentBusyGate. The
 * gates above decide when it is safe to WRITE an injected turn; nothing verified
 * the submit actually TOOK (the CR can be swallowed by paste-settle, or land in a
 * briefly-locked TUI right around a compaction). This polls the output activity
 * for a bounded window after the final CR and, at each poll that finds the output
 * quiet (no turn running), writes one bare resubmit CR — capped, and harmless
 * when the composer is empty.
 *
 * Deliberately NO early-exit on a busy observation: around a compaction, "busy"
 * can be residual summarizer/context-restore output resuming after the quiet gap
 * that let the carry through — exactly the trap that strands the text. Polling
 * the full window costs seconds on a rare path and covers it.
 *
 * `quietMs` (WI-2975) is deliberately NOT the busy-gate's OUTPUT_QUIET_MS — that
 * threshold is tuned short, for "has the agent returned to an idle prompt?", a
 * different question. Here it means "did this submit start a turn at all?",
 * and a genuinely-running turn routinely goes silent for a few seconds (network
 * latency / silent thinking) without being stalled — treating that ordinary gap
 * as failure was the WI-2975 bug (spurious resubmit noise on every compaction,
 * including fully successful ones). Default to the caller's own
 * SUBMIT_VERIFY_QUIET_MS, not OUTPUT_QUIET_MS.
 *
 * Human-input abort: any human keystroke after verification starts cancels the
 * remaining polls (never fight a human who is editing the staged line —
 * `lastInputAt` is the same signal makeIdleGate defers on).
 *
 * Pure (injectable clock/sleep + getters); exported for tests.
 * @param {object} [opts]
 * @param {() => number} [opts.lastOutputAt]
 * @param {(data: string) => void} [opts.writeCr]
 * @param {() => number} [opts.lastInputAt]
 * @param {() => boolean} [opts.isQuotaBlocked]
 * @param {() => boolean} [opts.isSubmitted] exact native-transcript proof of this turn
 * @param {number} [opts.quietMs]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.polls]
 * @param {number} [opts.maxResubmits]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(resubmits: number) => void} [opts.onResubmit]
 * @param {(details: {polls: number, resubmits: number, outputObservedAfterResubmit: boolean}) => void} [opts.onExhausted]
 */
export function makeSubmitVerifier({
  lastOutputAt,
  writeCr,
  lastInputAt = () => 0,
  isQuotaBlocked = () => false,
  isSubmitted = () => false,
  quietMs = SUBMIT_VERIFY_QUIET_MS,
  pollMs = SUBMIT_VERIFY_POLL_MS,
  polls = SUBMIT_VERIFY_POLLS,
  maxResubmits = SUBMIT_VERIFY_MAX_RESUBMITS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onResubmit = () => {},
  onExhausted = () => {},
} = {}) {
  const getOut = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  const getIn = typeof lastInputAt === 'function' ? lastInputAt : () => 0;
  return {
    /** Poll for the verify window; resubmit a bare CR at each quiet observation.
     *  Returns { polls, resubmits, aborted, exhausted } (aborted = 'human-input' | 'quota-blocked' | null;
     *  exhausted = no output was observed after the maximum resubmits). */
    async verify() {
      const inputAtStart = getIn() || 0;
      let resubmits = 0;
      let outputObservedAfterResubmit = false;
      let outputAtLastResubmit = null;
      let exhaustionNotified = false;
      let exhausted = false;
      let i = 0;
      const quotaAbort = () => ({ polls: i, resubmits, aborted: 'quota-blocked', exhausted: false });
      const notifyExhausted = () => {
        // A resubmit can legitimately wake a previously silent turn. Once any
        // output is observed after a resubmit, this verifier must never turn a
        // later quiet interval into a host-killing exhaustion signal.
        if (
          exhaustionNotified ||
          outputObservedAfterResubmit ||
          resubmits < maxResubmits
        ) {
          return;
        }
        exhaustionNotified = true;
        exhausted = true;
        try {
          onExhausted({
            polls: i,
            resubmits,
            outputObservedAfterResubmit,
          });
        } catch {
          /* an exhaustion observer must never break verifier cleanup */
        }
      };
      for (; i < polls; i++) {
        if (isQuotaBlocked()) return quotaAbort();
        await sleep(pollMs);
        // The first submit can itself paint the quota wall. Read the live
        // detector after each wait, before either retrying or declaring failure.
        if (isQuotaBlocked()) return quotaAbort();
        const outputAtPoll = getOut() || 0;
        if (
          outputAtLastResubmit != null &&
          outputAtPoll > outputAtLastResubmit
        ) {
          outputObservedAfterResubmit = true;
        }
        if ((getIn() || 0) > inputAtStart) return { polls: i + 1, resubmits, aborted: 'human-input' };
        // PTY silence is not submission failure. A model may already be in a
        // long silent turn, or back at an idle prompt after a short one. For a
        // provenance-tagged turn the isolated native transcript is the stronger
        // proof: once its exact marker persists, another CR is unnecessary and
        // can submit unrelated staged input.
        if (isSubmitted()) {
          return { polls: i + 1, resubmits, aborted: null, exhausted: false, confirmed: 'native' };
        }
        const quietFor = now() - outputAtPoll;
        if (quietFor < quietMs) continue; // output flowing — a turn is running
        if (resubmits >= maxResubmits) {
          notifyExhausted();
          break;
        }
        resubmits++;
        const outputBeforeResubmit = getOut() || 0;
        try {
          writeCr();
        } catch {
          /* child may have exited mid-verify */
        }
        const outputAfterResubmit = getOut() || 0;
        if (outputAfterResubmit > outputBeforeResubmit) {
          outputObservedAfterResubmit = true;
        }
        outputAtLastResubmit = outputAfterResubmit;
        onResubmit(resubmits);
      }
      // If the bounded poll window ends on the final resubmit, there is no
      // following iteration to observe a quiet poll. Treat the window itself as
      // exhausted, but keep the same output-after-resubmit suppression rule.
      if (isQuotaBlocked()) return quotaAbort();
      if (i >= polls) notifyExhausted();
      return { polls: i, resubmits, aborted: null, exhausted };
    },
  };
}

/** WI-1378748: may a verifier exhaustion for THIS submit label kill the host?
 *
 *  WI-41044 made every exhaustion host-fatal. That is defensible for a STARTUP
 *  submit (a launch kickoff / recycle carry-note / session-port seed that never
 *  took leaves a session that exists but can never work — tearing it down frees
 *  the discovery key, socket and child subtree, and the launcher records a
 *  nonzero outcome). It is NOT defensible for a WAKE inject, and the difference
 *  is the whole bug:
 *
 *  A `turn`/`reset` inject is a NOTIFICATION delivered into a session that is
 *  usually alive and mid-work. The verifier's sole evidence is "the pty stayed
 *  quiet", and it cannot see WHY. Quiet has causes other than a swallowed CR —
 *  the one that bit us is a RATE-LIMITED agent: a Claude Code sitting on a
 *  weekly/5h quota wall repaints nothing at all, so a wake injected into it can
 *  never take, and the host answered by SIGTERMing a live agent mid-edit.
 *  Measured 2026-08-30: 160 hosts killed this way since WI-41044 landed, 102 of
 *  them on a `turn inject`, arriving in mass clusters (6 sessions inside 3s at
 *  20:22, 3 more at 21:04) because ONE coord broadcast wakes every session at
 *  once and every quota-silent recipient dies together.
 *
 *  The costs are wildly asymmetric. Not killing loses at most one coord wake —
 *  and loses nothing silently, because the delivery failure is still recorded
 *  (`submit-verify-unconfirmed`) and the sender already has to verify pickup.
 *  Killing destroys in-flight work and respawns the session straight back into
 *  the same wall. So a wake inject may never be host-fatal; only a startup
 *  submit may.
 *
 *  Deliberately the DEFAULT (not a per-call-site flag): a future caller that
 *  forgets the argument gets the safe behaviour for a wake label. Pure;
 *  exported for tests. */
export function submitExhaustionTerminatesHost(label) {
  const normalized = String(label ?? '')
    .trim()
    .toLowerCase();
  return !(normalized === 'turn inject' || normalized === 'turn re-arm' || normalized === 'reset inject');
}

/** Translate the submit verifier's semantic negative outcomes into the stable
 * delivery reasons consumed by launch/recycle callers. A human-input abort is
 * not proof that the injected turn landed, so it must remain distinguishable
 * from both success and bounded exhaustion. Pure; exported for tests. */
export function submitVerificationFailureReason(result) {
  if (result?.exhausted) return 'submit-verification-exhausted';
  if (result?.aborted) return `submit-verification-aborted-${result.aborted}`;
  return null;
}

/** WI-10004926: human text for each startup-turn drop reason, printed inside
 *  the parentheses of the `<label> DROPPED for <owner> (...)` stderr receipt.
 *  `submit-verification-aborted-<why>` is handled by prefix in
 *  describeStartupTurnDropReason; any other unmapped reason is still NAMED
 *  (WI-10004919: an unnamed reason hid a 75s frame-budget drop behind the
 *  generic text). */
export const STARTUP_TURN_DROP_REASON_TEXT = Object.freeze({
  'no-startup-ready-marker-last-resort-failed':
    'the child never emitted its startup-ready marker AND the last-resort attempt found no prompt',
  'no-startup-ready-marker': 'the child never emitted its startup-ready marker',
  'kickoff-marker-echo-unconfirmed': 'the exact Codex kickoff marker never appeared in the composer echo',
  'submit-verification-exhausted': 'submit verification exhausted without observing output after a resubmit',
  'fresh-child-owner-input': 'the owner used the fresh child before its carry prompt was submitted',
  'resume-compaction-timeout':
    'Claude resume compaction recovery timed out before a standalone composer prompt appeared',
  'codex-backend-frame-not-observed':
    'the Codex session frame, a Ready footer or model header, never appeared in its backend-frame budget',
  'codex-startup-still-starting': 'the Codex footer still read Starting, MCP servers booting, at the kickoff deadline',
  'never-settled': 'the child never settled to its prompt',
});

/** @param {string} dropReason @returns {string} */
export function describeStartupTurnDropReason(dropReason) {
  const reason = String(dropReason ?? '');
  if (Object.hasOwn(STARTUP_TURN_DROP_REASON_TEXT, reason)) return STARTUP_TURN_DROP_REASON_TEXT[reason];
  if (reason.startsWith('submit-verification-aborted-')) {
    return `submit verification aborted (${reason.slice('submit-verification-aborted-'.length)})`;
  }
  return `the child never settled to its prompt [reason ${reason}]`;
}

/** WI-10004926: the ONE writer of the startup-turn drop receipt.
 *  packages/operator-core/lib/acceptance-grader.ts parses this exact line with
 *  `$`-anchored regexes (LAUNCHER_QUOTA_KICKOFF_DROP_RE,
 *  LAUNCHER_KICKOFF_DROP_RE). Keep the parenthesised tail
 *  `within <N>ms over <N> attempt(s))` LAST. Anything appended inside or after
 *  it silently stops grader drop detection;
 *  apps/operator/lib/psu-pty-host-drop-line-contract.test.ts pins this.
 *  @param {{ label: string, ownerId: string, dropReason: string, budgetMs: number, attempts: number }} drop
 *  @returns {string} */
export function formatStartupTurnDroppedLine({ label, ownerId, dropReason, budgetMs, attempts }) {
  return (
    `psu-pty-host: ${label} DROPPED for ${ownerId} (${describeStartupTurnDropReason(dropReason)} ` +
    `within ${budgetMs}ms over ${attempts} attempt(s))\n`
  );
}

/** WI-1386682 (1): does this pty screen text show Claude Code's OWN
 *  usage-wall copy (weekly or 5-hour)? This is the missing half of
 *  WI-1378748's fix — that item stopped a wake exhaustion from being
 *  host-fatal; it did not stop the host from reading "the pty is quiet" as
 *  "the agent is at its prompt" when the true cause is "the agent is alive
 *  but rate-limited and cannot generate at all".
 *
 *  ⚠ THE PATTERNS ARE PER-AGENT, AND THAT IS LOAD-BEARING (WI-2140984). These
 *  are CLAUDE CODE's copy, and the original code matched them against EVERY
 *  pty. A codex child ships ordinary, non-wall chrome that hits them — its
 *  slash-command list alone carries "view account usage or use a usage limit
 *  reset", plus " Consumes usage limits faster" and "Goal hit usage limits
 *  (/goal resume)" — so a perfectly healthy codex member was read as walled.
 *
 *  That also FALSIFIES the original cost model ("a false POSITIVE costs at
 *  most one deferred wake, recoverable"). That is true only of a STATIC
 *  banner, which is what the ring buffer below assumes. Chrome is REPAINTED,
 *  so it refills the window as fast as it is evicted, `isBlocked()` never
 *  clears, and every turn/reset is deferred FOREVER — the session boots
 *  healthy, reports fresh, and can never take a single turn. Measured
 *  2026-09-02: two headless codex fleet members logged one
 *  quota-block-detected at boot then 110 straight turn-deferred-quota-blocked
 *  with zero clears, ~52min unbroken, while the account read util7d 0.03 with
 *  no 429s. So a false positive is the FAR more expensive direction here, and
 *  an agent we have no captured wall copy for gets NO patterns rather than a
 *  guess borrowed from a different product.
 *
 *  Matches survive ANSI styling because the caller strips it first. Pure;
 *  exported for tests. */
const CLAUDE_QUOTA_LIMIT_BANNER_PATTERNS = [
  /weekly limit/i,
  /5-hour limit/i,
  /usage limit/i,
  // Captured gateway 429 from the routed BAR reviewer (EI-24930415587482619).
  /usage credits are required for long context requests/i,
  /you'?ve reached your fable(?:\s+\d+(?:\.\d+)?)?\s+limit\b/i,
  /\blimit\b[^\n]{0,60}\breset(?:s|ting)?\b/i,
];

/** Codex's OWN wall copy, read off the shipped binary's strings (2026-09-02).
 *  Anchored on WHOLE SENTENCES on purpose: codex renders the bare phrase
 *  "usage limit" as routine chrome, so any looser pattern reproduces
 *  WI-2140984. Widen only against captured raw text from a REAL codex wall,
 *  and re-check the new pattern against `codex`'s own strings first. */
const CODEX_QUOTA_LIMIT_BANNER_PATTERNS = [
  /you'?ve hit your usage limit/i,
  /usage limit reached/i,
  /you'?ve reached your workspace credit limit/i,
  /your workspace is out of credits/i,
];

/** Claude's ROUTINE USAGE ADVISORY, which shares its wall's vocabulary:
 *    "You've used 75% of your weekly limit · resets Sep 17, 7am (America/New_York)"
 *  That is a progress notice with quota REMAINING — the opposite of a block — but it
 *  contains "weekly limit", and "limit … resets", so TWO of the claude patterns above
 *  fire on it. The detector then latches blocked=true and `injectTurnAtPrompt` drops
 *  every gated injection with `submit-verification-aborted-quota-blocked`, so the
 *  session is never compacted or carry-respawned and instead runs past its context
 *  ceiling until it dies. Measured 2026-09-11T16:51:45Z on
 *  su-cb1f92db-…: matchedPattern /weekly limit/i, excerpt exactly the line above, at
 *  75% used — an account with a quarter of its week left, blocked for the rest of a
 *  ~35min session (WI-10000288's own compaction was one of the casualties).
 *
 *  This is WI-2140984 again, one product over: the CODEX set immediately above was
 *  anchored to WHOLE SENTENCES precisely because codex renders "usage limit" as
 *  routine chrome, and that lesson was never carried across to the claude set, which
 *  is still bare phrases. Anchoring claude's patterns the same way is the deeper fix,
 *  but it needs captured raw text from a REAL claude wall to do safely (widening on a
 *  guess risks the far worse failure: missing a real wall and hammering it). A
 *  precise NEGATIVE guard needs no such sample and cannot mask a real wall, because
 *  it is applied PER MATCH-LINE, not to the whole screen.
 *
 *  Keep this list to the percentage-used advisory shape only. Anything that states
 *  exhaustion ("limit reached", "you've hit") must keep matching. */
const QUOTA_USAGE_ADVISORY_PATTERNS = [
  /\bused\s+\d{1,3}\s*%\s+of\s+your\b/i,
  /\b\d{1,3}\s*%\s+of\s+your\s+(?:weekly|5-hour|usage)\b/i,
];

/** Is THIS line a usage advisory rather than a wall? Scoped to the single line
 *  carrying the match so an advisory cannot suppress a real wall elsewhere on the
 *  same screen. Pure; exported for tests. */
/**
 * A quota detector is intentionally fail-closed for a real usage wall, but a
 * latched detector can otherwise turn every future gated injection into a
 * silent no-op. Keep a separate, outcome-driven liveness guard so a wall that
 * lasts long enough without one successful gated injection becomes a loud
 * health signal. The guard does not inspect PTY bytes: callers feed it the
 * detector level and the result of an actual gated delivery.
 *
 * The threshold is deliberately bounded by an attempted delivery. A quiet
 * session with no pending wake has no starvation to report; the first queued
 * wake after the threshold makes the stuck episode observable. A successful
 * gated injection during the episode suppresses the zero-success verdict.
 * Pure except for the injected onStarvation callback; exported for tests.
 */
export const QUOTA_BLOCK_STARVATION_THRESHOLD_MS = 5 * 60_000;

export function makeQuotaBlockStarvationGuard({
  thresholdMs = QUOTA_BLOCK_STARVATION_THRESHOLD_MS,
  now = Date.now,
  onStarvation = () => {},
} = {}) {
  const threshold = positiveNumber(thresholdMs, QUOTA_BLOCK_STARVATION_THRESHOLD_MS);
  let blockedSinceMs = null;
  let attemptedGatedInjections = 0;
  let successfulGatedInjections = 0;
  let alerted = false;
  let lastSignal = null;

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const reset = () => {
    blockedSinceMs = null;
    attemptedGatedInjections = 0;
    successfulGatedInjections = 0;
    alerted = false;
    lastSignal = null;
  };

  /**
   * Observe the current detector level and, optionally, one completed gated
   * injection. gatedInjection.successful must mean the host has a positive
   * delivery/submit result; an early socket ACK is not sufficient.
   */
  const observe = ({
    quotaBlocked = false,
    observedBlockedSinceMs = null,
    gatedInjection = null,
  } = {}) => {
    const atMs = clock();
    if (!quotaBlocked) {
      reset();
      return null;
    }

    const suppliedSince = Number(observedBlockedSinceMs);
    if (blockedSinceMs == null) {
      blockedSinceMs = Number.isFinite(suppliedSince) ? suppliedSince : atMs;
    }

    const attempted = gatedInjection?.attempted === true || gatedInjection?.successful === true;
    if (attempted) attemptedGatedInjections += 1;
    if (gatedInjection?.successful === true) successfulGatedInjections += 1;

    const ageMs = Math.max(0, atMs - blockedSinceMs);
    if (
      !alerted &&
      attemptedGatedInjections > 0 &&
      successfulGatedInjections === 0 &&
      ageMs >= threshold
    ) {
      alerted = true;
      lastSignal = {
        reason: 'quota-block-starvation',
        blockedSinceMs,
        ageMs,
        thresholdMs: threshold,
        attemptedGatedInjections,
        successfulGatedInjections,
      };
      try {
        onStarvation(lastSignal);
      } catch {
        // A health signal must never break the delivery path it diagnoses.
      }
      return lastSignal;
    }
    return null;
  };

  return {
    observe,
    snapshot() {
      const atMs = clock();
      return {
        quotaBlocked: blockedSinceMs != null,
        blockedSinceMs,
        blockedAgeMs: blockedSinceMs == null ? null : Math.max(0, atMs - blockedSinceMs),
        thresholdMs: threshold,
        attemptedGatedInjections,
        successfulGatedInjections,
        alerted,
        lastSignal,
      };
    },
    reset,
  };
}

export function quotaLineIsUsageAdvisory(line) {
  const text = String(line ?? '');
  return QUOTA_USAGE_ADVISORY_PATTERNS.some((re) => re.test(text));
}

/** The banner set for one agent. An UNKNOWN agent gets [] — never another
 *  product's copy (see the cost model above). An unset agent keeps the
 *  historical claude behaviour, matching how the rest of this host reads
 *  PAPERCUSP_AGENT (it only branches on an EXPLICIT non-claude value).
 *  Pure; exported for tests. */
export function quotaBannerPatternsForAgent(agent = '') {
  const a = String(agent ?? '')
    .trim()
    .toLowerCase();
  if (!a || a === 'claude') return CLAUDE_QUOTA_LIMIT_BANNER_PATTERNS;
  if (a === 'codex') return CODEX_QUOTA_LIMIT_BANNER_PATTERNS;
  return [];
}

/** The matching half of `quotaLimitBannerVisible`, returning WHICH pattern hit
 *  and a short excerpt around it. A bare `quota-block-detected` row is what
 *  made WI-2140984 cost a fleet leader an escalation and a full investigation:
 *  the event recorded that a wall was seen but nothing about what was seen, so
 *  a false positive was indistinguishable from a real wall. Pure; exported for
 *  tests. */
export function quotaLimitBannerMatch(text, agent = '') {
  const visible = stripAnsi(String(text ?? ''));
  for (const re of quotaBannerPatternsForAgent(agent)) {
    // Scan EVERY occurrence, not just the first: a usage advisory and a real wall can
    // share one screen, and returning on the first hit would let whichever came first
    // decide. Skipping an advisory line must never skip the wall below it.
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = scan.exec(visible); m; m = scan.exec(visible)) {
      const at = m.index ?? 0;
      const lineStart = visible.lastIndexOf('\n', at) + 1;
      const lineEndRaw = visible.indexOf('\n', at);
      const lineEnd = lineEndRaw === -1 ? visible.length : lineEndRaw;
      if (quotaLineIsUsageAdvisory(visible.slice(lineStart, lineEnd))) {
        // Zero-length matches cannot happen with these patterns, but a guard here keeps
        // a future pattern edit from spinning this loop forever.
        if (scan.lastIndex <= at) scan.lastIndex = at + 1;
        continue;
      }
      return {
        matched: true,
        pattern: String(re),
        excerpt: visible.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return { matched: false, pattern: null, excerpt: null };
}

export function quotaLimitBannerVisible(text, agent = '') {
  return quotaLimitBannerMatch(text, agent).matched;
}

/** WI-10003875: how often a LATCHED quota block re-consults its corroborator. */
export const QUOTA_CORROBORATE_TTL_MS = 15_000;

/** The rendered text of one Claude Code transcript row: assistant/user text
 *  blocks, tool_use inputs and tool_result bodies — everything the TUI can
 *  echo onto the screen. Pure; exported for tests. */
export function claudeTranscriptRowText(row) {
  const content = row?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_use') {
      try {
        parts.push(JSON.stringify(block.input ?? {}));
      } catch {
        /* an unserialisable input simply contributes nothing */
      }
    } else if (block.type === 'tool_result') {
      const body = block.content;
      if (typeof body === 'string') parts.push(body);
      else if (Array.isArray(body)) {
        for (const piece of body) if (typeof piece?.text === 'string') parts.push(piece.text);
      }
    }
  }
  return parts.join('\n');
}

/** Claude Code records a real usage wall as a SYNTHETIC assistant row
 *  (`isApiErrorMessage:true`, `error:'rate_limit'`, model `<synthetic>`), e.g.
 *  "You've hit your session limit · resets 7:20am (America/New_York)" —
 *  measured across this box's transcripts 2026-09-29. */
function claudeRowIsApiError(row) {
  return row?.isApiErrorMessage === true || row?.error != null || row?.message?.model === '<synthetic>';
}

/** WI-10003875: is a latched claude quota match a REAL wall, or the TUI echoing
 *  the transcript's own words? The bare-phrase banner patterns match the
 *  model's prose: su-be77f2f5's final message "its own 11.5-hour limit ran
 *  out" hit /5-hour limit/i, the static idle screen never evicted it, and every
 *  wake for ~18h was turn-deferred-quota-blocked.
 *
 *  Newest row first, over user/assistant rows:
 *    - an API-error row that is a rate limit (error 'rate_limit', or its text
 *      matches the banner set)                          → 'walled'
 *    - an ordinary row whose text matches the banner set → 'echo'
 *  Non-matching rows and non-quota API errors are skipped; nothing decisive →
 *  'unknown'. Only 'echo' may dismiss a latch, and it requires the matching
 *  words to BE transcript content newer than any rate-limit error, so a real
 *  wall (whose synthetic row is newer than whatever preceded it) still wins.
 *  Pure; exported for tests. */
/** WI-10003875: the corroborator the host wires into its claude quota
 *  detector — the newest transcript under THIS owner's isolated
 *  CLAUDE_CONFIG_DIR (never the shared ~/.claude, so it cannot read another
 *  session's wall), bounded tail, verdict above. No isolated root, no
 *  transcript, or a half-written newest row ⇒ 'unknown' (fail closed).
 *  Exported for tests. */
export function makeClaudeQuotaCorroborator(env = process.env, home = homedir()) {
  return () =>
    claudeQuotaTranscriptVerdict(
      readIsolatedNativeTranscriptRows({
        agent: 'claude',
        env,
        home,
        transcriptPath: newestNativeTranscriptPath('claude', env, home),
      }),
    );
}

export function claudeQuotaTranscriptVerdict(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'unknown';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.type !== 'assistant' && row?.type !== 'user') continue;
    const text = claudeTranscriptRowText(row);
    if (claudeRowIsApiError(row)) {
      if (row.error === 'rate_limit' || quotaLimitBannerVisible(text, 'claude')) return 'walled';
      continue;
    }
    if (row.isMeta) continue;
    if (quotaLimitBannerVisible(text, 'claude')) return 'echo';
  }
  return 'unknown';
}

/** How large a recent-screen window quotaBlockDetector keeps. Bounded (like
 *  makeOutputTap's capBytes) but deliberately smaller than
 *  childStartupOutput's 32_768-char window: the whole point is that the
 *  window EVICTS the banner once genuine new output resumes, so a smaller
 *  cap means "quota-blocked" clears after a modest amount of real churn
 *  rather than requiring many KB of it. */
const QUOTA_BLOCK_BUFFER_CHARS = 8_192;

/** WI-1386682 (1): quota-wall detector. Feed it the SAME raw pty bytes the
 *  activity tracker sees (child.onData); `isBlocked()` reports whether
 *  Claude Code's own usage-limit banner is currently visible in the recent
 *  screen. Deliberately a bounded ring buffer, not an edge-triggered
 *  one-shot: a session truly sitting on a wall emits NOTHING further (the
 *  banner is a static paint, not a redrawing spinner), so the buffer simply
 *  stops growing and stays blocked; once genuine new output resumes — the
 *  wall lifted, a recycle replaced the child, a human intervened — the
 *  detector does not need to know which; enough of that new text evicts the
 *  banner from the window and `isBlocked()` clears on its own. This is the
 *  "clear-on-output rule" the parent item asks for: not an immediate
 *  single-byte clear (which would be wrong — a redraw is routinely split
 *  across several small writes) but a level check against the current
 *  screen. Pure (no timers, no I/O); exported for tests. */
export function makeQuotaBlockDetector({
  capBytes = QUOTA_BLOCK_BUFFER_CHARS,
  agent = '',
  now = Date.now,
  deferUntilSubmit = false,
  corroborate = /** @type {null | ((match: { matched: boolean, pattern: string | null, excerpt: string | null }) => string)} */ (null),
  corroborateTtlMs = QUOTA_CORROBORATE_TTL_MS,
  onDismiss = /** @type {null | ((dismissed: { matched: boolean, pattern: string | null, excerpt: string | null, blockedSinceMs: number | null }) => unknown)} */ (null),
} = {}) {
  let buffer = '';
  let blocked = false;
  let awaitingSubmit = deferUntilSubmit;
  /** @type {number | null} */
  let blockedSinceMs = null;
  let lastMatch = { matched: false, pattern: null, excerpt: null };
  /** @type {{ atMs: number, value: string } | null} */
  let verdict = null;
  /** WI-10003875: a screen match is only a CANDIDATE wall. While latched,
   *  consult the injected corroborator (the native transcript for claude) at
   *  most once per TTL. 'echo' — the matched words are the transcript's own
   *  content, newer than any rate_limit API error — dismisses the latch and
   *  drops the stale window so the same static bytes cannot re-latch it.
   *  Anything else ('walled', 'unknown', a throw) keeps today's fail-closed
   *  level. Without a corroborator this is exactly the old `() => blocked`. */
  const isBlockedNow = () => {
    if (!blocked || typeof corroborate !== 'function') return blocked;
    const t = now();
    if (!verdict || t - verdict.atMs >= corroborateTtlMs) {
      let value = 'unknown';
      try {
        value = String(corroborate(lastMatch) ?? 'unknown');
      } catch {
        value = 'unknown';
      }
      verdict = { atMs: t, value };
    }
    if (verdict.value !== 'echo') return true;
    const dismissed = { ...lastMatch, blockedSinceMs };
    buffer = '';
    blocked = false;
    blockedSinceMs = null;
    verdict = null;
    lastMatch = { matched: false, pattern: null, excerpt: null };
    if (typeof onDismiss === 'function') {
      try {
        onDismiss(dismissed);
      } catch {
        /* a failed trace must not re-latch or break the gate */
      }
    }
    return false;
  };
  return {
    /** Feed one raw pty chunk. Returns the transition ('detected' | 'cleared')
     *  or null when the level didn't change, so a caller can log transitions
     *  without re-deriving state on every chunk. */
    observe(chunk) {
      // A resumed Codex TUI replays old provider errors before its first new
      // request. Those bytes are history, not a current account measurement.
      if (awaitingSubmit) return null;
      buffer = `${buffer}${String(chunk ?? '')}`;
      if (buffer.length > capBytes) buffer = buffer.slice(-capBytes);
      const hit = quotaLimitBannerMatch(buffer, agent);
      if (hit.matched) lastMatch = hit;
      if (hit.matched === blocked) return null;
      blocked = hit.matched;
      blockedSinceMs = blocked ? now() : null;
      verdict = null;
      return blocked ? 'detected' : 'cleared';
    },
    /** Arm once per child at the standalone submit keystroke. Pasted history
     * and terminal probes cannot arm it; later submits cannot clear a wall. */
    observeInput(input) {
      if (awaitingSubmit && /^[\r\n]+$/.test(String(input))) awaitingSubmit = false;
    },
    isBlocked: isBlockedNow,
    /** Corroborates too: the discovery file is refreshed on a timer, so a
     *  prose false positive is dismissed within one refresh even when no wake
     *  is pending, instead of advertising quotaBlocked to the operator. */
    snapshot: () => {
      const quotaBlocked = isBlockedNow();
      return { quotaBlocked, quotaBlockedSinceMs: blockedSinceMs };
    },
    /** WI-2140984: WHICH pattern last matched, and the text around it — so a
     *  `quota-block-detected` row says what was actually on screen and a false
     *  positive is diagnosable from the event log alone. */
    lastMatch: () => lastMatch,
    /** Reset to a fresh, un-walled state. Call on recycle: a fresh child has
     *  no screen history and cannot inherit the old child's wall. */
    reset() {
      buffer = '';
      blocked = false;
      awaitingSubmit = deferUntilSubmit;
      blockedSinceMs = null;
      verdict = null;
      lastMatch = { matched: false, pattern: null, excerpt: null };
    },
  };
}

/** How often the discovery file's activity fields are refreshed. Coarse on
 *  purpose — the consumer question is "active or idle for minutes?", and a
 *  per-byte rewrite would turn the pty bridge into an fs hot loop. */
export const ACTIVITY_PERSIST_MS = 15_000;

/**
 * Control-socket wire protocol (v1). A connector writes ONE UTF-8 payload then
 * half-closes. If it parses as a `{ v:1, mode, data }` envelope we act on the
 * mode; otherwise the whole payload is treated as a legacy idle-gated turn (so
 * the psupty spike's raw `text\r` inject still works).
 *
 *   mode:'turn' → a wake turn: idle-gated (P-013), then `data` + CR submits it.
 *   mode:'raw'  → verbatim + IMMEDIATE (bypasses the idle gate): force-interrupt
 *                 control bytes (Ctrl-C '\x03' / Esc '\x1b') for the
 *                 operator-mediated `turn:interrupt` (Phase 4, D-007). data is
 *                 written exactly, no CR appended.
 *
 * The read side (host server below) and the operator's connectors
 * (wake-executor + turn:interrupt) share this format — mirrored in
 * operator-core/lib/events/await/psu-pty-discovery.ts. Pure — exported for tests.
 */
export function encodeControl({ mode, data, ...extra }) {
  return JSON.stringify({ v: 1, mode, data, ...extra });
}

/** Parse `{ fireNumber, routineId }` off a raw envelope object, or `{}` when
 *  either is absent/malformed — the WI-5510 fire-identity fields threaded onto
 *  a loop-wake delivery (turn/reset/recycle/carry-respawn) so the STALE-FIRE
 *  GUARD below can tell a superseded delivery from a fresh one. Both fields
 *  travel together: `routineId` names WHICH loop instance (a fresh loop after
 *  loop:end + re-arm gets a new id, so its fire #1 is never confused with a
 *  prior loop's higher fire count), `fireNumber` is that loop's 1-based fire
 *  count at DECIDE time (loop-fire.ts). Absent on any pre-WI-5510 sender or a
 *  non-loop wake ⇒ the guard is a no-op for that message (unchanged behavior).
 *  Pure — exported for tests. */
function decodeFireIdentity(o) {
  const fireNumber =
    typeof o?.fireNumber === 'number' && Number.isFinite(o.fireNumber) && o.fireNumber > 0
      ? o.fireNumber
      : undefined;
  const routineId =
    typeof o?.routineId === 'string' && o.routineId.length > 0 ? o.routineId.slice(0, 200) : undefined;
  const out = {};
  if (fireNumber !== undefined) out.fireNumber = fireNumber;
  if (routineId !== undefined) out.routineId = routineId;
  return out;
}

/** Parse `{ ownerId }` off a raw envelope object, or `{}` when absent/malformed
 *  (EI-153: the sender's addressed-recipient assertion — see injectIntoHost's
 *  `ownerId` doc in psu-pty-discovery.ts). Absent on any pre-EI-153 sender or a
 *  legacy non-envelope payload ⇒ the receiver's identity check below is a no-op
 *  for that message (unchanged behavior) — mirrors decodeFireIdentity exactly.
 *  Pure — exported for tests. */
export function decodeOwnerIdentity(o) {
  const ownerId = typeof o?.ownerId === 'string' && o.ownerId.length > 0 ? o.ownerId.slice(0, 200) : undefined;
  return ownerId !== undefined ? { ownerId } : {};
}

/** Parse `{ deliveryId }` off a raw envelope object, or `{}` when absent/malformed
 *  (EI-19311270129974785: the sender's `event_wake_deliveries.id` for this wake,
 *  when the message represents one — see injectIntoHostWithConfirmation's
 *  `deliveryId` doc in psu-pty-discovery.ts). Absent on any pre-fix sender, a
 *  legacy non-envelope payload, or a one-shot raw/osc/compact/mcp-reconnect call
 *  (no delivery row) ⇒ the receiver's dedup check below is a no-op for that
 *  message (unchanged behavior) — mirrors decodeOwnerIdentity exactly.
 *  Pure — exported for tests. */
export function decodeDeliveryId(o) {
  const deliveryId =
    typeof o?.deliveryId === 'string' && o.deliveryId.length > 0 ? o.deliveryId.slice(0, 200) : undefined;
  return deliveryId !== undefined ? { deliveryId } : {};
}

/** Parse the additive quota-recovery descriptor carried only by a durable
 * mode:recycle wake. Every identity is repeated and cross-checked here: a
 * mutated operation id or owner must degrade to an ordinary recycle, never
 * gain permission to kill/restart a different session. Pure for mutation tests. */
export function decodeQuotaRecovery(o) {
  const q = o?.quotaRecovery;
  if (!q || typeof q !== 'object') return {};
  const operationId =
    typeof q.operationId === 'string' && q.operationId.length > 0
      ? q.operationId.slice(0, 200)
      : undefined;
  const recoveryOwnerId =
    typeof q.ownerId === 'string' && q.ownerId.length > 0
      ? q.ownerId.slice(0, 200)
      : undefined;
  const startedAtMs =
    typeof q.startedAtMs === 'number' && Number.isFinite(q.startedAtMs) && q.startedAtMs > 0
      ? q.startedAtMs
      : undefined;
  if (
    operationId === undefined ||
    recoveryOwnerId === undefined ||
    startedAtMs === undefined ||
    operationId !== o?.deliveryId ||
    recoveryOwnerId !== o?.ownerId
  ) return {};
  return { quotaRecovery: { operationId, ownerId: recoveryOwnerId, startedAtMs } };
}

/** Parse a control payload into { mode, data, gated }. A non-envelope payload is
 *  a legacy idle-gated turn. Pure — exported for tests. */
export function decodeControl(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  try {
    const o = JSON.parse(text);
    if (
      o &&
      o.v === 1 &&
      (o.mode === 'turn' ||
        o.mode === 'raw' ||
        o.mode === 'osc' ||
        o.mode === 'reset' ||
        o.mode === 'recycle' ||
        o.mode === 'carry-respawn' ||
        o.mode === 'compact' ||
        o.mode === 'shutdown' ||
        o.mode === 'mcp-reconnect')
    ) {
      // SHUTDOWN (WI-6638): wind this session down and EXIT. psu is `exec`'d
      // inside `gnome-terminal --wait`, so the host exiting IS the tab closing —
      // which is the whole point: an agent session whose work is finished closes
      // its own window instead of idling in an open tab forever.
      //
      // UNGATED at decode (the handler applies its OWN guards, which are stricter
      // than the turn gates and must run even when the agent is quiet): a shutdown
      // must never queue behind the coalescer or the wake gates, because the
      // request is precisely "there is no more work".
      if (o.mode === 'shutdown')
        return {
          mode: 'shutdown',
          data: String(o.data ?? ''),
          force: o.force === true,
          gated: false,
          ...decodeOwnerIdentity(o),
        };
      if (o.mode === 'raw')
        return { mode: 'raw', data: String(o.data ?? ''), gated: false, ...decodeOwnerIdentity(o) };
      // osc = recolor escape bytes for the terminal DISPLAY (not the agent) —
      // ungated + immediate, routed to the host stdout (see the handler sink).
      if (o.mode === 'osc')
        return { mode: 'osc', data: String(o.data ?? ''), gated: false, ...decodeOwnerIdentity(o) };
      // reset (RESET-CONTEXT) / recycle — the cold-auto verbs (su-cold-auto-mode
      // P-004). Both are GATED like a turn (P-006 clean-boundary: fire ONLY at a
      // settled turn, never mid-turn) — the host's idle + agent-busy gates defer
      // them exactly as they defer a wake turn. `data` is the carry-note the fresh
      // context opens on. reset = in-place `/clear` (drop transcript, keep the
      // process + MCP warm); recycle = kill + respawn the child in this same host.
      // Both also carry the WI-5510 fire identity (decodeFireIdentity) so the
      // STALE-FIRE GUARD applies to them exactly like a warm turn, and the EI-153
      // addressed-recipient assertion (decodeOwnerIdentity) so the MISDELIVERY
      // guard below applies to them too.
      if (o.mode === 'reset')
        return {
          mode: 'reset',
          data: String(o.data ?? ''),
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
        };
      if (o.mode === 'recycle')
        return {
          mode: 'recycle',
          data: String(o.data ?? ''),
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
          ...decodeQuotaRecovery(o),
        };
      // carry-respawn (deterministic-context-carry P-018): a clean-boundary
      // RECYCLE whose fresh Claude child receives the deterministic carry as a
      // system-prompt addendum. `data` is the optional successor first prompt.
      if (o.mode === 'carry-respawn')
        return {
          mode: 'carry-respawn',
          data: String(o.data ?? ''),
          systemPromptAddendum: String(o.systemPromptAddendum ?? ''),
          ...(typeof o.sourceTranscriptPath === 'string' && o.sourceTranscriptPath
            ? { sourceTranscriptPath: o.sourceTranscriptPath.slice(0, 4096) } : {}),
          // P-020 drill correlation is additive on the v1 envelope. An ordinary
          // P-018 carry-respawn omits both fields and stays byte-for-byte inert.
          drillId: o.drillId != null ? String(o.drillId).slice(0, 200) : '',
          sessionClass: o.sessionClass != null ? String(o.sessionClass).slice(0, 200) : '',
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
        };
      // compact — RETIRED (P-022): still DECODED so a stale pre-cutover sender's
      // message reaches the handler's loud drop instead of falling through to the
      // legacy path below, which would TYPE the raw envelope at the agent as a turn.
      if (o.mode === 'compact')
        return {
          mode: 'compact',
          data: String(o.data ?? ''),
          focus: o.focus != null ? String(o.focus) : '',
          gated: true,
          ...decodeOwnerIdentity(o),
        };
      // mcp-reconnect (mcp-transport-resilience P-003, 2026-07-13): drive the
      // claude TUI's /mcp dialog to reconnect a dead HTTP-MCP server IN PLACE
      // (headed sessions keep their terminal — the owner-mandated alternative
      // to kill+resume). GATED like a turn (never mid-turn, never over a
      // half-typed owner line). `data` = the target server name (default
      // 'papercusp-su' applied by the handler).
      if (o.mode === 'mcp-reconnect')
        return { mode: 'mcp-reconnect', data: String(o.data ?? ''), gated: true, ...decodeOwnerIdentity(o) };
      return {
        mode: 'turn',
        data: String(o.data ?? ''),
        gated: true,
        ...decodeFireIdentity(o),
        ...decodeOwnerIdentity(o),
        ...decodeDeliveryId(o),
      };
    }
  } catch {
    /* not an envelope — fall through to legacy */
  }
  return { mode: 'turn', data: text, gated: true };
}

/** The full logical bytes a decoded control message represents (raw: verbatim;
 *  turn: text + CR). Pure — kept for tests / one-shot external callers. NOTE the
 *  host no longer writes a turn in one shot; see controlWrites. */
export function controlBytes(decoded) {
  return decoded.mode === 'raw' ? decoded.data : `${decoded.data}\r`;
}

// ── mcp-reconnect macro (mcp-transport-resilience P-003, 2026-07-13) ─────────
//
// A Claude Code self-re-exec (auto-update relaunch / TUI fullscreen switch)
// severs the session's HTTP-MCP transport: tools vanish, and the armed loop's
// events:await registration dies with it — the session runs DARK until a human
// types /mcp (the su-39f07 5h incident). There is no scriptable reconnect in
// the CLI (verified 2.1.208: `claude mcp` manages config only), so the host —
// the one process that owns the pty and SEES the TUI's output — drives the
// /mcp dialog itself: closed-loop (parse → keypress → re-parse), never blind
// keystrokes. Truth of the heal is judged OPERATOR-side (presence beat
// advancing, mcp-dark-watchdog P-005); the host result is advisory. Every step
// is bounded and fail-soft: any unmet expectation → Esc Esc + a durable host
// event — worst case is exactly the pre-macro status quo.

/** Strip ANSI escapes (CSI / OSC / simple ESC pairs) + normalize \r so a TUI
 *  byte stream reads as plain lines. Pure — exported for tests. */
export function stripAnsi(s) {
  return String(s ?? '')
    // OSC: ESC ] … terminated by BEL or ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '')
    // remaining simple ESC pairs (charset selects, keypad modes, bare ESC)
    .replace(/\x1b[@-Z\\-_]?/g, '')
    // carriage returns are line-rewrites in a TUI — treat as newlines
    .replace(/\r\n?/g, '\n')
    // drop other control chars except newline/tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Bounds for the diagnostic companion log. A PTY frame can contain an
 * arbitrarily long carriage-return redraw, so line boundaries alone are not
 * enough: a frame with no newline must be chunked before it reaches disk.
 */
export const HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES = 16 * 1024;
export const HEADLESS_NORMALIZED_LOG_MAX_BYTES = 4 * 1024 * 1024;
const HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES = 64 * 1024;

/**
 * Normalize a PTY stream without making chunk boundaries observable.
 *
 * The Codex TUI emits ANSI paint sequences and carriage-return redraw frames.
 * Applying {@link stripAnsi} independently to each `onData` chunk is not
 * sufficient: an escape sequence or CRLF pair may be split across two chunks.
 * This small state machine carries only those incomplete protocol fragments,
 * strips terminal controls, turns CR redraws into physical lines, and chunks
 * a line at a bounded UTF-8 byte size while preserving its visible text.
 *
 * @param {{maxLineBytes?: number}} [options]
 * @returns {{push:(chunk?: any)=>string, flush:()=>string, reset:()=>void}}
 */
export function makeHeadlessLogNormalizer({
  maxLineBytes = HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES,
} = {}) {
  const lineLimit =
    Number.isFinite(Number(maxLineBytes)) && Number(maxLineBytes) > 0
      ? Math.floor(Number(maxLineBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES;
  let ansiState = 'normal';
  let line = '';
  let lineBytes = 0;
  let suppressLf = false;
  let emitted = [];

  const emitLine = () => {
    emitted.push(`${line}\n`);
    line = '';
    lineBytes = 0;
  };

  const appendVisible = (char) => {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (lineBytes > 0 && lineBytes + bytes > lineLimit) emitLine();
    line += char;
    lineBytes += bytes;
  };

  const consume = (chunk) => {
    for (const char of String(chunk ?? '')) {
      const code = char.codePointAt(0) ?? 0;

      if (ansiState === 'escape') {
        if (char === '[' || char === '\u009b') ansiState = 'csi';
        else if (char === ']' || char === '\u009d') ansiState = 'osc';
        else ansiState = 'normal'; // simple ESC pair: drop both bytes
        continue;
      }
      if (ansiState === 'csi') {
        // CSI final bytes are in the inclusive @–~ range. Parameters and
        // intermediates are all discarded until that final byte arrives.
        if (code >= 0x40 && code <= 0x7e) ansiState = 'normal';
        continue;
      }
      if (ansiState === 'osc') {
        if (char === '\x07') ansiState = 'normal';
        else if (char === '\x1b') ansiState = 'osc-escape';
        continue;
      }
      if (ansiState === 'osc-escape') {
        ansiState = char === '\\' ? 'normal' : 'osc';
        continue;
      }

      // A CR is a logical frame boundary. Consume the LF in a subsequent CRLF
      // pair exactly once, even when the pair straddles two PTY chunks.
      if (suppressLf) {
        suppressLf = false;
        if (char === '\n') continue;
      }
      if (char === '\r') {
        emitLine();
        suppressLf = true;
        continue;
      }
      if (char === '\n') {
        emitLine();
        continue;
      }
      if (char === '\x1b') {
        ansiState = 'escape';
        continue;
      }
      // Keep tabs for readable command output; discard all other C0/DEL
      // controls. Visible Unicode is iterated by code point, so the byte bound
      // never splits a surrogate pair.
      if (char === '\t' || (code >= 0x20 && code !== 0x7f)) {
        appendVisible(char);
      }
    }
  };

  const drain = () => {
    const result = emitted.join('');
    emitted = [];
    return result;
  };

  return {
    push(chunk) {
      consume(chunk);
      return drain();
    },
    flush() {
      // A dangling escape/control sequence is not visible text. Flush the
      // visible line at a child/recycle boundary, then reset all protocol state
      // so a successor child cannot inherit a partial sequence.
      ansiState = 'normal';
      suppressLf = false;
      if (line.length > 0) emitLine();
      return drain();
    },
    reset() {
      ansiState = 'normal';
      line = '';
      lineBytes = 0;
      suppressLf = false;
      emitted = [];
    },
  };
}

/**
 * Open the normalized companion log for a headless PTY host.
 *
 * Writes are synchronous and bounded because this path is a diagnostic
 * side-channel: a failed or full companion log must never interrupt the
 * managed PTY. The file is retained as a tail-bounded, newline-delimited
 * artifact; raw PTY bytes still travel through the original stdout fd.
 *
 * @param {string} path
 * @param {{maxLineBytes?: number, maxBytes?: number, maxWriteBytes?: number}} [options]
 * @returns {{path:string, enabled:boolean, push:(chunk?:any)=>void, flush:()=>void, close:()=>void}}
 */
export function createHeadlessNormalizedLogWriter(path, {
  maxLineBytes = HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES,
  maxBytes = HEADLESS_NORMALIZED_LOG_MAX_BYTES,
  maxWriteBytes = HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES,
} = {}) {
  const target = typeof path === 'string' ? path.trim() : '';
  const maxFileBytes =
    Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Math.floor(Number(maxBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_BYTES;
  const maxChunkBytes =
    Number.isFinite(Number(maxWriteBytes)) && Number(maxWriteBytes) > 0
      ? Math.floor(Number(maxWriteBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES;
  const normalizer = makeHeadlessLogNormalizer({ maxLineBytes });
  let fd = null;
  let fileBytes = 0;

  const disabled = {
    path: target,
    enabled: false,
    push() {},
    flush() {},
    close() {},
  };
  if (!target) return disabled;

  try {
    mkdirSync(dirname(target), { recursive: true });
    // Read access is required by the tail-trim path below. `a` is write-only
    // on POSIX, so its fd makes readSync throw as soon as the cap is crossed,
    // disabling the sidecar exactly when it needs bounding most.
    fd = openSync(target, 'a+', 0o600);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* best-effort permissions; the host still owns the diagnostic path */
    }
    fileBytes = fstatSync(fd).size;
  } catch {
    try {
      if (fd != null) closeSync(fd);
    } catch {
      /* ignore */
    }
    return disabled;
  }

  const disable = () => {
    try {
      if (fd != null) closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = null;
  };

  const trimFileIfNeeded = () => {
    if (fd == null || fileBytes <= maxFileBytes + maxChunkBytes) return;
    const keep = Math.min(fileBytes, maxFileBytes);
    const buffer = Buffer.alloc(keep);
    const read = readSync(fd, buffer, 0, keep, Math.max(0, fileBytes - keep));
    let body = buffer.subarray(0, read);
    if (fileBytes > keep) {
      const firstLine = body.indexOf(0x0a);
      if (firstLine >= 0) body = body.subarray(firstLine + 1);
    }
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, body, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      closeSync(fd);
      fd = openSync(target, 'a', 0o600);
      fileBytes = body.length;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        /* ignore */
      }
      // Keep the existing fd if the atomic trim failed. A diagnostic side
      // channel is allowed to grow until the next successful trim, but must
      // never take down the pty host.
    }
  };

  const writeBounded = (text) => {
    if (fd == null || !text) return;
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(maxChunkBytes, bytes.length - offset);
      const written = writeSync(fd, bytes, offset, length);
      if (!(written > 0)) break;
      offset += written;
      fileBytes += written;
    }
    trimFileIfNeeded();
  };

  const writeNormalized = (text) => {
    try {
      writeBounded(text);
    } catch {
      disable();
    }
  };

  return {
    path: target,
    enabled: true,
    push(chunk) {
      if (fd == null) return;
      writeNormalized(normalizer.push(chunk));
    },
    flush() {
      if (fd == null) return;
      writeNormalized(normalizer.flush());
    },
    close() {
      if (fd == null) return;
      writeNormalized(normalizer.flush());
      disable();
    },
  };
}

/** Codex can offer a newly available model before it installs the composer.
 * A headless launch must keep its explicitly selected model and advance this
 * one startup menu before the ordinary composer gate can submit the kickoff.
 * Never answer an interactive session or a later turn. */
// Codex may paint the model offer well after its loading frame. Keep the
// startup choice handler alive for the launcher's bounded first-turn window;
// a real composer disarms it as soon as startup succeeds.
export const HEADLESS_CODEX_MODEL_CHOICE_STARTUP_MS = 600_000;
const HEADLESS_CODEX_MODEL_CHOICE_BUFFER_CHARS = 32_768;

export function headlessCodexModelChoiceEnabled(env = process.env) {
  return (
    String(env?.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1' &&
    String(env?.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex'
  );
}

/** Match the two actual menu choices, not Codex's earlier loading frame. The
 * pty may split ANSI sequences and cursor-positioned words across chunks. */
export function makeHeadlessCodexModelChoiceStateMachine({
  enabled = true,
  startupMs = HEADLESS_CODEX_MODEL_CHOICE_STARTUP_MS,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const windowMs = positiveNumber(startupMs, HEADLESS_CODEX_MODEL_CHOICE_STARTUP_MS);
  const startedAt = clock();
  let phase = enabled ? 'watching' : 'disabled';
  let observed = '';
  const snapshot = (action = 'none') => ({ action, phase, active: phase === 'watching' || phase === 'await-existing' });
  return {
    observe(chunk, at = clock()) {
      if (phase !== 'watching' && phase !== 'await-existing') return snapshot();
      if (at - startedAt >= windowMs) {
        phase = 'expired';
        observed = '';
        return snapshot('expired');
      }
      observed = `${observed}${String(chunk ?? '')}`.slice(-HEADLESS_CODEX_MODEL_CHOICE_BUFFER_CHARS);
      const visible = stripAnsi(observed).replace(/[\s\u00a0]+/g, '');
      if (phase === 'await-existing') {
        if (/›2\.Useexistingmodel/i.test(visible)) {
          phase = 'complete';
          observed = '';
          return snapshot('confirm-existing');
        }
        return snapshot();
      }
      if (!/Meet/i.test(visible) || !/1\.Trynewmodel/i.test(visible) || !/2\.Useexistingmodel/i.test(visible)) {
        return snapshot();
      }
      if (/›2\.Useexistingmodel/i.test(visible)) {
        phase = 'complete';
        observed = '';
        return snapshot('confirm-existing');
      }
      if (/›1\.Trynewmodel/i.test(visible)) {
        phase = 'await-existing';
        observed = '';
        return snapshot('select-existing');
      }
      return snapshot();
    },
    complete() {
      if (phase === 'watching' || phase === 'await-existing') {
        phase = 'complete';
        observed = '';
      }
      return snapshot();
    },
    status: () => ({ phase, active: phase === 'watching', startedAt, expiresAt: startedAt + windowMs }),
  };
}

/**
 * Claude can still show its first-run wizard to a headless launch even when
 * the persisted config says onboarding is complete. A human can press Enter
 * through that wizard; a headless managed pty cannot. Keep the recovery
 * deliberately narrow: only the explicit headless Claude launch mode gets
 * these two startup answers, and only while the child is in its bounded boot
 * window.
 */
export const HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS = 30_000;
// A fresh headless Claude kickoff must either reach the real composer or fail
// inside the detached launcher's 30s receipt window. Reserve the remaining
// time for native-transcript proof; never type into a quiet welcome/menu screen.
export const HEADLESS_CLAUDE_KICKOFF_READY_TIMEOUT_MS = 20_000;
const HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS = 32_768;
const HEADLESS_CLAUDE_THEME_PROMPT_RE =
  /(?:\b(?:choose|select|pick)\b[\s\S]{0,160}\btheme\b|\btheme\b[\s\S]{0,160}\b(?:dark|light|system)\b)/i;
const HEADLESS_CLAUDE_SECURITY_PROMPT_RE =
  /(?:\bsecurity\s+notes?\b[\s\S]{0,800}\bpress\s+enter\b|\bpress\s+enter\b[\s\S]{0,800}\bsecurity\s+notes?\b)/i;

/** The onboarding actuator is never enabled for an interactive or non-Claude
 * launch. Pure and exported so the environment gate cannot silently broaden. */
export function headlessClaudeOnboardingEnabled(env = process.env) {
  return (
    String(env?.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1' &&
    String(env?.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'claude'
  );
}

/** Read the bounded startup window from the launch environment. */
export function headlessClaudeOnboardingStartupMs(env = process.env) {
  return positiveNumber(
    env?.PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS,
    HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS,
  );
}

/**
 * Decide whether one startup output chunk warrants the next onboarding Enter.
 *
 * The pty may split a prompt anywhere (including inside an ANSI sequence), so
 * raw chunks accumulate before ANSI stripping and matching. The theme match
 * advances to the security phase and clears that buffer: output that happened
 * to contain both screens cannot cause the second Enter before the first one
 * has been consumed by Claude. The returned `submit` action is intentionally
 * just a decision; the host owns the child.write('\r') side effect.
 *
 * @param {{enabled?: boolean, startupMs?: number, now?: () => number}} [options]
 */
export function makeHeadlessClaudeOnboardingStateMachine({
  enabled = true,
  startupMs = HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const windowMs = positiveNumber(startupMs, HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS);
  const startedAt = clock();
  let phase = enabled ? 'theme' : 'disabled';
  let observed = '';

  const snapshot = (action = 'none', prompt = null) => ({
    action,
    prompt,
    phase,
    active: phase === 'theme' || phase === 'security',
    complete: phase === 'complete',
    expired: phase === 'expired',
  });

  const expire = (at = clock()) => {
    if (phase !== 'theme' && phase !== 'security') return snapshot();
    phase = 'expired';
    observed = '';
    return { ...snapshot('expired'), expiredAt: at };
  };

  const observe = (chunk, at = clock()) => {
    if (phase === 'disabled' || phase === 'complete' || phase === 'expired') return snapshot();
    if (at - startedAt >= windowMs) return expire(at);

    observed = `${observed}${String(chunk ?? '')}`;
    if (observed.length > HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS) {
      observed = observed.slice(-HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS);
    }
    const visible = stripAnsi(observed);

    if (phase === 'theme' && HEADLESS_CLAUDE_THEME_PROMPT_RE.test(visible)) {
      phase = 'security';
      observed = '';
      return snapshot('submit', 'theme');
    }
    if (phase === 'security' && HEADLESS_CLAUDE_SECURITY_PROMPT_RE.test(visible)) {
      phase = 'complete';
      observed = '';
      return snapshot('submit', 'security');
    }
    if (claudeStandaloneComposerPromptVisible(visible)) {
      // No onboarding wizard appeared (or its final Enter already reached the
      // editor). This positive composer marker ends the detector window instead
      // of reporting a false onboarding expiry 30s into an ordinary startup.
      phase = 'complete';
      observed = '';
      return snapshot('ready');
    }
    return snapshot();
  };

  return {
    observe,
    expire,
    isActive: () => phase === 'theme' || phase === 'security',
    isComplete: () => phase === 'complete',
    status: () => ({
      phase,
      active: phase === 'theme' || phase === 'security',
      complete: phase === 'complete',
      expired: phase === 'expired',
      startedAt,
      expiresAt: startedAt + windowMs,
      bufferedChars: observed.length,
    }),
  };
}

/**
 * Scripted Claude resumes can open an interactive recovery choice instead of
 * the composer when the saved transcript is too large for the current context:
 *
 *   Autocompact is thrashing
 *   1. Resume from summary (recommended)
 *   2. Resume full session as-is
 *   3. Don't ask again
 *
 * A quiet TUI is not a prompt in this state. Keep the recovery separate from
 * the ordinary startup/readiness heuristic so the kickoff cannot be pasted
 * into the menu, and accept the safe default exactly once. The raw output is
 * accumulated before ANSI stripping because pty chunks may split both an ANSI
 * sequence and the menu text itself. Pure and exported for tests.
 */
export const CLAUDE_RESUME_COMPACTION_STARTUP_MS = 30_000;
export const CLAUDE_RESUME_COMPACTION_RECOVERY_MS = 30_000;
const CLAUDE_RESUME_COMPACTION_BUFFER_CHARS = 32_768;
const CLAUDE_RESUME_COMPACTION_MENU_RE =
  /autocompact\s+is\s+thrashing/i;
const CLAUDE_RESUME_COMPACTION_SUMMARY_RE =
  /resume\s+from\s+summary\b/i;
const CLAUDE_RESUME_COMPACTION_FULL_RE =
  /resume\s+full\s+session\s+as[\s-]*is\b/i;
const CLAUDE_RESUME_COMPACTION_DONT_ASK_RE =
  /don['’]t\s+ask\s+again\b/i;

function claudeStandaloneComposerPromptVisible(visible) {
  // Claude's HPA cursor codes can supply the visual space after Try. stripAnsi
  // removes those codes, leaving Try"…"; keep the complete quoted-line guard.
  return String(visible ?? '')
    .split(/[\r\n]/)
    .map((line) => line.trim())
    .some((line) => /^(?:❯|>|╰─>)(?:\s*Try\s*["“][^"”]+["”])?\s*$/u.test(line));
}

function claudeResumeCompactionMenuVisible(visible) {
  const text = String(visible ?? '');
  return (
    CLAUDE_RESUME_COMPACTION_MENU_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_SUMMARY_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_FULL_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_DONT_ASK_RE.test(text)
  );
}

/** Session-env tunable detection window for the scripted Claude resume menu. */
export function claudeResumeCompactionStartupMs(env = process.env) {
  return positiveNumber(
    env.PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS,
    CLAUDE_RESUME_COMPACTION_STARTUP_MS,
  );
}

/** Session-env tunable bounded recovery window after the menu is selected. */
export function claudeResumeCompactionRecoveryMs(env = process.env) {
  return positiveNumber(
    env.PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS,
    CLAUDE_RESUME_COMPACTION_RECOVERY_MS,
  );
}

/**
 * @param {{enabled?: boolean, startupMs?: number, recoveryMs?: number, now?: () => number}} [options]
 */
export function makeClaudeResumeCompactionRecoveryStateMachine({
  enabled = true,
  startupMs = CLAUDE_RESUME_COMPACTION_STARTUP_MS,
  recoveryMs = CLAUDE_RESUME_COMPACTION_RECOVERY_MS,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const detectionWindowMs = positiveNumber(startupMs, CLAUDE_RESUME_COMPACTION_STARTUP_MS);
  const recoveryWindowMs = positiveNumber(recoveryMs, CLAUDE_RESUME_COMPACTION_RECOVERY_MS);
  // Host setup can precede the child's first PTY frame by an unbounded amount
  // under startup delay. Start the bounded menu-detection window with observed
  // child output, so a late first frame still gets inspected before expiry.
  let detectionStartedAt = null;
  let phase = enabled ? 'watching' : 'disabled';
  let recoveryStartedAt = 0;
  let observed = '';

  const snapshot = (action = 'none') => ({
    action,
    phase,
    recoveryStarted: recoveryStartedAt > 0,
    selectedSummary: recoveryStartedAt > 0,
    awaitingPrompt: phase === 'awaiting-prompt',
    ready:
      phase === 'disabled' ||
      phase === 'watching' ||
      phase === 'watch-expired' ||
      phase === 'ready',
    timedOut: phase === 'timed-out',
    active: phase === 'watching' || phase === 'awaiting-prompt',
  });

  const expireIfNeeded = (at = clock()) => {
    if (
      phase === 'watching' &&
      detectionStartedAt !== null &&
      at - detectionStartedAt >= detectionWindowMs
    ) {
      phase = 'watch-expired';
      observed = '';
      return snapshot('expired');
    }
    if (phase === 'awaiting-prompt' && at - recoveryStartedAt >= recoveryWindowMs) {
      phase = 'timed-out';
      observed = '';
      return snapshot('expired');
    }
    return snapshot();
  };

  const observe = (chunk, at = clock()) => {
    if (phase === 'watching' && detectionStartedAt === null) detectionStartedAt = at;
    const expiration = expireIfNeeded(at);
    if (expiration.action === 'expired') return expiration;
    if (phase === 'disabled' || phase === 'watch-expired' || phase === 'ready' || phase === 'timed-out') {
      return snapshot();
    }

    observed = `${observed}${String(chunk ?? '')}`;
    if (observed.length > CLAUDE_RESUME_COMPACTION_BUFFER_CHARS) {
      observed = observed.slice(-CLAUDE_RESUME_COMPACTION_BUFFER_CHARS);
    }
    const visible = stripAnsi(observed);

    if (phase === 'watching' && claudeResumeCompactionMenuVisible(visible)) {
      // Clear the menu paint before waiting for a post-selection repaint. This
      // prevents its selected-row `❯` from being mistaken for the composer.
      phase = 'awaiting-prompt';
      recoveryStartedAt = at;
      observed = '';
      return snapshot('select-summary');
    }
    if (phase === 'awaiting-prompt' && claudeStandaloneComposerPromptVisible(visible)) {
      phase = 'ready';
      observed = '';
      return snapshot('ready');
    }
    return snapshot();
  };

  const expire = (at = clock()) => {
    if (phase === 'watching') {
      phase = 'watch-expired';
      observed = '';
      return snapshot('expired');
    }
    if (phase === 'awaiting-prompt') {
      phase = 'timed-out';
      observed = '';
      return snapshot('expired');
    }
    return snapshot();
  };

  return {
    observe,
    expire,
    tick: expireIfNeeded,
    isReady: () => snapshot().ready,
    isAwaitingPrompt: () => phase === 'awaiting-prompt',
    isTimedOut: () => phase === 'timed-out',
    recoveryStarted: () => recoveryStartedAt > 0,
    status: () => ({
      ...snapshot(),
      // EI-25217214806027261: this read an unbound `startedAt` (ReferenceError on every
      // status() call); the machine's own clock is detectionStartedAt.
      startedAt: detectionStartedAt,
      detectionExpiresAt: detectionStartedAt === null ? null : detectionStartedAt + detectionWindowMs,
      recoveryExpiresAt: recoveryStartedAt ? recoveryStartedAt + recoveryWindowMs : null,
      bufferedChars: observed.length,
    }),
  };
}

/** WI-41386 — the SCROLLBACK GUARD on the child → terminal bridge.
 *
 *  `ESC[3J` (ED param 3, "erase saved lines") deletes the TERMINAL'S SCROLLBACK
 *  outright — not the visible screen, the owner's history. No agent TUI has a
 *  legitimate reason to issue it: a CLI that wants a clean canvas has `ESC[2J`
 *  (visible screen) and the alternate screen buffer, neither of which touches
 *  what has already scrolled away. So we drop it on the way to the real
 *  terminal, for every backend.
 *
 *  MEASURED (2026-08-24): omp emits `ESC[3J` at byte offset 20 of its boot
 *  stream — ~25,000 bytes BEFORE it switches to the alternate screen at offset
 *  25,242 — so it erases the PRIMARY buffer's history on every single boot. In
 *  a 40-row pane holding 60 marker lines, an omp boot destroyed 25 of them;
 *  with this guard, 0. That is a different failure from the claude/codex cursor
 *  overwrite (see respawnTerminalHandoffBytes) and no host-side cursor anchoring
 *  can prevent it, because the CHILD is issuing the erase.
 *
 *  Deliberately narrow: `2J`/`1J`/`0J` are visible-screen erases every TUI needs
 *  and are passed through untouched. Only param 3 (and its private `?3J` spelling)
 *  is dropped.
 *
 *  Chunk-boundary safe: a pty delivers arbitrary byte runs, so an escape can be
 *  split across two `onData` chunks. A tail that could still become one is held
 *  back and prepended to the next chunk; the hold is bounded so a stream that
 *  simply ends on a stray ESC cannot strand output.
 *
 *  Stateful per child — build a fresh one each time the bridge is (re)wired.
 *  Pure factory — exported for tests.
 */
export const SCROLLBACK_ERASE_RE = /\x1b\[\??3J/g;
/** Longest tail we will hold waiting for the rest of a possible `ESC[…3J`. */
const SCROLLBACK_GUARD_MAX_CARRY = 8;
export function makeScrollbackGuard() {
  let carry = '';
  return {
    /** @param {string} chunk @returns {string} bytes safe to write to the terminal */
    filter(chunk) {
      let s = carry + String(chunk ?? '');
      carry = '';
      // Hold back only a tail that is still a PREFIX of an erase sequence —
      // never arbitrary trailing bytes, which would reorder normal output.
      const m = s.match(/\x1b(?:\[\??[0-9;]*)?$/);
      if (m && m[0].length <= SCROLLBACK_GUARD_MAX_CARRY) {
        carry = m[0];
        s = s.slice(0, s.length - carry.length);
      }
      return s.replace(SCROLLBACK_ERASE_RE, '');
    },
    /** Flush whatever is held (child exit / teardown) so nothing is swallowed. */
    flush() {
      const held = carry;
      carry = '';
      return held.replace(SCROLLBACK_ERASE_RE, '');
    },
  };
}

/** A launch seed must not reach a TUI before its editor exists. Headless Claude
 * requires a standalone composer glyph; its welcome and onboarding screens can
 * emit output before an editor exists. Most other backends are ready for the
 * existing quiet-window check after their first output byte, but OMP emits
 * terminal capability probes before it paints any UI, and Codex
 * animates a multi-second character-by-character "Tip: ..." onboarding line
 * (plus, occasionally, an MCP-startup warning typed the same way) before its
 * composer ever paints — a mid-animation pause can look "quiet at a prompt"
 * to the ordinary quiescence gate even though the real editable prompt has not
 * installed yet (WI-4943: a live Claude→Codex port wrote its managed seed
 * during this animation, the submit CR landed as inert paste text, and native
 * persistence correctly failed). OMP's stable `omp vN` banner is the earliest
 * backend-owned proof that startup reached the dashboard; Codex's own stable
 * proof is its composer footer's live context-budget readout ("NN% context
 * left"), which is chrome the TUI only paints once the input line is
 * installed — verified against the shipped `codex` binary's embedded UI
 * strings (`@openai/codex-linux-x64`). The ordinary output-quiescence gate
 * still runs after either marker. Pure and exported so backend readiness
 * cannot regress into timing folklore.
 *
 * WI-10002745: Codex ≥0.156 moved the idle readout into a status footer —
 * `Ready · <model> <effort> · Context 100% left` — and paints the legacy
 * `NN% context left` form only once a turn is RUNNING. So before the first
 * turn the legacy pattern never matched: every fresh Codex kickoff fell to the
 * 15s startup fallback and was typed blind into a still-booting TUI, and the
 * leading bytes (the provenance marker) were lost whenever the write landed
 * mid-draw. The status word is part of the proof: `Starting` is the same
 * footer while MCP servers are still booting, so only a non-Starting status
 * counts as the composer being installed. */
const CODEX_STATUS_FOOTER_RE = /([A-Za-z]+)\s*·[^·\n]{0,120}·\s*Context\s+\d{1,3}%\s+left/g;
function codexStatusFooterState(visible) {
  const status = [...String(visible ?? '').matchAll(CODEX_STATUS_FOOTER_RE)]
    .at(-1)?.[1]?.toLowerCase() ?? null;
  if (status === null) return null;
  // ANSI cursor motion is stripped from scrollback, so a footer repainted over
  // existing composer text may be flattened into a token such as "anythingReady".
  if (status.endsWith('starting')) return 'starting';
  if (status.endsWith('ready')) return 'ready';
  return status;
}
function codexReadyStatusFooterObserved(output, dims) {
  // Codex v0.157 can leave the header at `model: loading` even after the
  // session is ready. The footer is the positive, post-model-choice signal;
  // its `Starting` form is painted while MCP startup is still in flight.
  return codexFooterStateFromOutput(output, dims) === 'ready';
}

/** WI-10005178: a minimal synchronous VT screen model, for reading TUI chrome as
 * the terminal SHOWS it. stripAnsi() flattens a byte stream, which is wrong for a
 * differential renderer: Codex (ratatui) repaints only the cells that changed and
 * positions each run with CUP. Measured 2026-10-02T02:03Z and 02:16Z on recycle
 * children (su-46569c12, su-3b465e67, codex-starting-stuck-snapshot rawTail): the
 * footer went from `Starting · GPT-6-Luna max · Context 100% left` to Ready as
 * `ESC[14;3H Re ESC[14;6H dy …`, skipping the unchanged `a`. The flattened
 * stream's last COMPLETE footer was still `Starting`, so a ready child was judged
 * stuck and dropped after ~3 minutes. Replaying the cursor motion onto a grid
 * gives back `Ready · …`.
 *
 * Covers the motion, erase, insert/delete and scroll subset a TUI uses, plus the
 * alternate screen. SGR, modes, OSC/DCS strings and terminal queries change no
 * cells and are skipped. A code point is one cell, except the common East Asian
 * wide and emoji ranges (two); combining marks are dropped. Returns one string
 * per row with trailing blanks trimmed. Pure and exported for tests. */
const TERMINAL_WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const TERMINAL_ZERO_WIDTH_RE = /[̀-ͯ​-‏⃐-⃿︀-️]/u;
const TERMINAL_CSI_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])/y;
export function renderTerminalScreen(output, { rows = 24, cols = 80 } = {}) {
  const R = Math.max(1, Math.min(500, Math.floor(Number(rows)) || 24));
  const C = Math.max(1, Math.min(1000, Math.floor(Number(cols)) || 80));
  const blankRow = () => new Array(C).fill(' ');
  const blankScreen = () => Array.from({ length: R }, blankRow);
  let screen = blankScreen();
  let row = 0;
  let col = 0;
  let top = 0;
  let bottom = R - 1;
  let wrapPending = false;
  let saved = { row: 0, col: 0 };
  let mainScreen = null;
  const clampRow = (r) => Math.min(R - 1, Math.max(0, r));
  const clampCol = (c) => Math.min(C - 1, Math.max(0, c));
  const scrollUp = (n, from = top, to = bottom) => {
    for (let k = 0; k < Math.min(n, to - from + 1); k += 1) {
      screen.splice(from, 1);
      screen.splice(to, 0, blankRow());
    }
  };
  const scrollDown = (n, from = top, to = bottom) => {
    for (let k = 0; k < Math.min(n, to - from + 1); k += 1) {
      screen.splice(to, 1);
      screen.splice(from, 0, blankRow());
    }
  };
  const lineFeed = () => {
    if (row === bottom) scrollUp(1);
    else row = clampRow(row + 1);
  };
  const eraseCells = (r, from, to) => {
    for (let c = Math.max(0, from); c <= Math.min(C - 1, to); c += 1) screen[r][c] = ' ';
  };
  const put = (ch, width) => {
    if (wrapPending) {
      col = 0;
      lineFeed();
      wrapPending = false;
    }
    if (width === 2 && col === C - 1) {
      screen[row][col] = ' ';
      col = 0;
      lineFeed();
    }
    screen[row][col] = ch;
    if (width === 2 && col + 1 < C) screen[row][col + 1] = '';
    const end = col + width - 1;
    if (end >= C - 1) {
      col = C - 1;
      wrapPending = true;
    } else {
      col = end + 1;
    }
  };
  const s = String(output ?? '');
  let i = 0;
  while (i < s.length) {
    const code = s.codePointAt(i);
    if (code === 0x1b) {
      const next = s[i + 1];
      if (next === undefined) break;
      if (next === '[') {
        TERMINAL_CSI_RE.lastIndex = i;
        const m = TERMINAL_CSI_RE.exec(s);
        if (!m) {
          i += 2;
          continue;
        }
        i = TERMINAL_CSI_RE.lastIndex;
        const [, params, intermediates, final] = m;
        if (intermediates) continue; // e.g. DECSCUSR `ESC[0 q`: no cell changes
        if (/^[<=>?]/.test(params)) {
          // Private modes touch no cells, except switching to/from the alternate screen.
          if (params[0] === '?' && (final === 'h' || final === 'l')
            && params.slice(1).split(';').some((p) => p === '1049' || p === '1047' || p === '47')) {
            if (final === 'h' && !mainScreen) {
              mainScreen = { screen, row, col, top, bottom };
              screen = blankScreen();
              top = 0;
              bottom = R - 1;
            } else if (final === 'l' && mainScreen) {
              ({ screen, row, col, top, bottom } = mainScreen);
              mainScreen = null;
            }
            wrapPending = false;
          }
          continue;
        }
        if (final === 'm') continue; // SGR
        const ps = params.split(';').map((p) => (/^\d+$/.test(p) ? Number(p) : null));
        const n = (k) => (ps[k] > 0 ? ps[k] : 1);
        const mode = ps[0] ?? 0;
        wrapPending = false;
        switch (final) {
          case 'H': case 'f': row = clampRow(n(0) - 1); col = clampCol(n(1) - 1); break;
          case 'A': row = clampRow(row - n(0)); break;
          case 'B': case 'e': row = clampRow(row + n(0)); break;
          case 'C': case 'a': col = clampCol(col + n(0)); break;
          case 'D': col = clampCol(col - n(0)); break;
          case 'E': row = clampRow(row + n(0)); col = 0; break;
          case 'F': row = clampRow(row - n(0)); col = 0; break;
          case 'G': case '`': col = clampCol(n(0) - 1); break;
          case 'd': row = clampRow(n(0) - 1); break;
          case 'J':
            if (mode === 0) {
              eraseCells(row, col, C - 1);
              for (let r = row + 1; r < R; r += 1) eraseCells(r, 0, C - 1);
            } else if (mode === 1) {
              eraseCells(row, 0, col);
              for (let r = 0; r < row; r += 1) eraseCells(r, 0, C - 1);
            } else {
              for (let r = 0; r < R; r += 1) eraseCells(r, 0, C - 1);
            }
            break;
          case 'K':
            if (mode === 0) eraseCells(row, col, C - 1);
            else if (mode === 1) eraseCells(row, 0, col);
            else eraseCells(row, 0, C - 1);
            break;
          case 'X': eraseCells(row, col, col + n(0) - 1); break;
          case '@': {
            const cells = screen[row];
            cells.splice(col, 0, ...new Array(Math.min(n(0), C - col)).fill(' '));
            cells.length = C;
            break;
          }
          case 'P': {
            const cells = screen[row];
            const k = Math.min(n(0), C - col);
            cells.splice(col, k);
            cells.push(...new Array(k).fill(' '));
            break;
          }
          case 'L': if (row >= top && row <= bottom) { scrollDown(n(0), row, bottom); col = 0; } break;
          case 'M': if (row >= top && row <= bottom) { scrollUp(n(0), row, bottom); col = 0; } break;
          case 'S': scrollUp(n(0)); break;
          case 'T': if (ps.length <= 1) scrollDown(n(0)); break; // the 5-param form is mouse tracking
          case 'r': {
            const t = Math.min(n(0), R) - 1;
            const b = ps[1] > 0 ? Math.min(ps[1], R) - 1 : R - 1;
            if (t < b) {
              top = t;
              bottom = b;
            } else {
              top = 0;
              bottom = R - 1;
            }
            row = 0;
            col = 0;
            break;
          }
          case 's': if (!params) saved = { row, col }; break;
          case 'u': if (!params) ({ row, col } = saved); break;
          default: break; // queries (`6n`, `c`) and anything else that paints nothing
        }
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC ends at BEL or ST; DCS, APC, PM and SOS end at ST.
        let j = i + 2;
        while (j < s.length) {
          if (next === ']' && s[j] === '\x07') { j += 1; break; }
          if (s[j] === '\x1b' && s[j + 1] === '\\') { j += 2; break; }
          j += 1;
        }
        i = j;
        continue;
      }
      if (next === '7') saved = { row, col };
      else if (next === '8') ({ row, col } = saved);
      else if (next === 'M') {
        if (row === top) scrollDown(1);
        else row = clampRow(row - 1);
      } else if (next === 'D') lineFeed();
      else if (next === 'E') { col = 0; lineFeed(); }
      else if (next === 'c') {
        screen = blankScreen();
        row = 0;
        col = 0;
        top = 0;
        bottom = R - 1;
        saved = { row: 0, col: 0 };
        mainScreen = null;
      }
      if ('78MDEc'.includes(next)) wrapPending = false;
      // `ESC ( B`, `ESC # 8` and other intermediate forms carry one more byte.
      i += /[ -/]/.test(next) ? 3 : 2;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if (code === 0x0d) {
        col = 0;
        wrapPending = false;
      } else if (code === 0x0a || code === 0x0b || code === 0x0c) {
        lineFeed();
        wrapPending = false;
      } else if (code === 0x08) {
        col = Math.max(0, col - 1);
        wrapPending = false;
      } else if (code === 0x09) {
        col = Math.min(C - 1, (Math.floor(col / 8) + 1) * 8);
      }
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(code);
    i += ch.length;
    // C1 controls and combining marks occupy no cell.
    if ((code >= 0x80 && code < 0xa0) || TERMINAL_ZERO_WIDTH_RE.test(ch)) continue;
    put(ch, TERMINAL_WIDE_RE.test(ch) ? 2 : 1);
  }
  return screen.map((cells) => cells.join('').replace(/ +$/, ''));
}

/** WI-10005178: the Codex footer state as the terminal shows it. The rendered
 * screen decides; the flattened stream is only the fallback for a screen that
 * holds no complete footer (the bounded startup buffer trimmed the full paint and
 * left only cell diffs), the one case the screen cannot decide. Pass the child's
 * PTY size: a CUP beyond the rendered grid is clamped onto the wrong cell.
 * @param {unknown} output
 * @param {{ rows?: number, cols?: number }} [dims]
 * @returns {string | null} */
export function codexFooterStateFromOutput(output, dims) {
  const raw = String(output ?? '');
  return codexStatusFooterState(renderTerminalScreen(raw, dims).join('\n'))
    ?? codexStatusFooterState(stripAnsi(raw));
}

/** WI-10005178: the screen text a `codex-startup-still-starting` verdict was read
 * from. Measured 2026-10-02T01:40-01:44Z (su-6a2603be, codex home session-32862):
 * the dropped child's own codex-tui.log shows session init, MCP resolution and the
 * model websocket warmup all complete within ~6s of spawn, yet the host judged its
 * footer `Starting` for 3m16s. Two readings fit that (WI-10004943 H1/H2): Codex
 * genuinely kept painting `Starting` (an MCP server still booting, e.g. the
 * OAuth-only `tsenta`), or a partial repaint wrote only the new status word so the
 * last COMPLETE footer the regex can match is a stale `Starting`. This evidence
 * separates them: `readyAfterLastFooter` true with state `starting` is the stale-read
 * signature; `mcpLines` names a server Codex was still waiting on. Bounded and
 * redacted, because host events reach a shared store. */
export function codexStartingFooterEvidence(output, { maxMatches = 4, tailChars = 600, maxLineChars = 160, dims } = {}) {
  if (typeof output !== 'string') return null;
  const visible = stripAnsi(output);
  // Resolved 2026-10-02 (H2): `state` is now the screen-rendered verdict the host
  // acts on; `streamState` keeps the flattened-stream reading it replaced.
  const footerRow = new RegExp(CODEX_STATUS_FOOTER_RE.source);
  const screenFooter = renderTerminalScreen(output, dims).findLast((r) => footerRow.test(r)) ?? null;
  const matches = [...visible.matchAll(CODEX_STATUS_FOOTER_RE)];
  const last = matches.at(-1) ?? null;
  const afterLast = last ? visible.slice(last.index + last[0].length) : visible;
  const line = (text) => redactSnapshotText(String(text).replace(/\s+/g, ' ').trim(), maxLineChars);
  // Control bytes made visible so a cursor-positioned partial repaint can be read.
  const visibleControls = (text) => Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x1b) return '⎋';
    if (code === 0x0a) return '\n';
    return code < 0x20 || code === 0x7f ? `^${String.fromCharCode(code ^ 0x40)}` : ch;
  }).join('');
  return {
    state: codexFooterStateFromOutput(output, dims),
    streamState: codexStatusFooterState(visible),
    screenFooter: screenFooter === null ? null : line(screenFooter),
    footerMatchCount: matches.length,
    lastMatches: matches.slice(-maxMatches).map((m) => ({
      status: m[1],
      fromEnd: visible.length - m.index,
      text: line(m[0]),
    })),
    readyAfterLastFooter: /ready/i.test(afterLast),
    startingAfterLastFooter: /starting/i.test(afterLast),
    mcpLines: visible.split(/\r\n|\r|\n/).filter((l) => /\bMCP\b/i.test(l)).slice(-3).map(line),
    visibleChars: visible.length,
    rawTail: redactSnapshotText(visibleControls(output.slice(-tailChars)), tailChars * 2),
  };
}
export function headlessClaudeKickoffReadiness({
  enabled = false,
  requireInitialOutput = false,
  promptReady = false,
  onboardingExpired = false,
} = {}) {
  if (!enabled || !requireInitialOutput) return 'ordinary-gate';
  if (promptReady) return 'composer-ready';
  // WI-10005472: the onboarding watcher saw neither a theme/security wizard nor
  // the composer for its whole startup window. That is the signature of a child
  // whose startup paint landed before this host's listener attached (the class
  // the startupMarkerMissing last resort documents): the TUI sits healthy at a
  // composer the byte stream never showed. Waiting longer cannot change that, so
  // defer to the ordinary busy gate, exactly as the next wake inject would.
  // Measured 2026-10-01/02: 24 of 24 headless-claude-composer-not-ready carry
  // drops had onboarding expired; 0 of 1775 delivered carries did.
  return onboardingExpired ? 'composer-unseen-ordinary-gate' : 'wait-for-composer';
}

/** @param {*} agent @param {*} output
 *  @param {{ rows?: number, cols?: number }} [dims] the child's PTY size (WI-10005178) */
export function startupOutputReady(agent, output, dims) {
  const visible = stripAnsi(output);
  const normalized = String(agent ?? '').toLowerCase();
  if (normalized === 'omp') return /\bomp\s+v\d/i.test(visible);
  if (normalized === 'codex') {
    const footerState = codexFooterStateFromOutput(output, dims);
    if (footerState !== null) return footerState === 'ready';
    return /\d{1,3}%\s*context left/i.test(visible);
  }
  if (normalized === 'claude') return freshChildPromptReady(normalized, output);
  return String(output ?? '').length > 0;
}

/** WI-10002745: the first thing a Codex TUI writes is a burst of terminal
 * capability queries (`ESC[?2004h ESC[>7u ESC[?1004h ESC[6n OSC10? OSC11?
 * ESC[?u ESC[c`). A headless PTY answers none of them, so Codex spends ~3.6s
 * reading stdin for the replies before it paints its first frame (its own log:
 * `tui startup initial frame scheduled duration_ms=3618`) — and any input that
 * arrives in that window is swallowed by the reply parser. The cursor-position
 * request is the earliest byte that is unambiguously the Codex TUI rather than
 * the psu launcher's own banner. Pure and exported for tests. */
export function codexTuiStartObserved(output) {
  return String(output ?? '').includes('\x1b[6n');
}

/** WI-10002745 (reopened): the probe above marks when the Codex TUI STARTS,
 * not when it is READY. Codex keeps reading stdin for the probe replies until
 * it schedules its first frame, and that wait is bimodal. Its own log line
 * `tui startup initial frame scheduled duration_ms=` measured min 33ms, p50
 * 698ms, p90 13.9s and max 14.1s over 41 launches on 2026-09-23. A fixed 15s
 * window measured from the probe therefore fired 0.3s and 0.6s BEFORE the
 * first frame on two grading auditors: each kickoff lost its leading
 * provenance marker, the native proof timed out, and the host tore down the
 * working session.
 *
 * FALSE PREMISE (retracted 2026-09-23 17:45Z): this used to treat the first
 * `OpenAI Codex` header or `›` composer glyph as readiness. Codex 0.156.1 paints
 * both ~0.25s after its probe while its header still reads `model: loading`,
 * BEFORE its session exists. On the slow launches, that pre-session frame came
 * 14s before Codex's own `initial frame scheduled` line, so the fallback clock
 * again started too early. Readiness is the header repainted with a real model
 * (`model: GPT-5.6-Sol high`), which Codex writes in full once the session is
 * configured (captured: scratch/su-bd109afe/wi2745-capture-*.jsonl).
 *
 * Codex v0.157 can keep that header at `model: loading` after model selection;
 * its `Ready · <model> · Context NN% left` footer is then the positive session
 * proof. `Starting` is not ready. `probeAlreadySeen` covers a probe that the caller's bounded startup buffer
 * has already trimmed away: the whole buffer then counts as post-probe.
 * Pure and exported for tests. */
const CODEX_SESSION_MODEL_RE = /model:\s+(?!loading\b)[^\s│]/;
export function codexSessionFrameObserved(output, { probeAlreadySeen = false, dims } = {}) {
  const raw = String(output ?? '');
  const probeAt = raw.lastIndexOf('\x1b[6n');
  if (probeAt < 0 && !probeAlreadySeen) return false;
  const afterProbe = probeAt < 0 ? raw : raw.slice(probeAt + '\x1b[6n'.length);
  return CODEX_SESSION_MODEL_RE.test(stripAnsi(afterProbe)) || codexReadyStatusFooterObserved(afterProbe, dims);
}

/** If the Codex first frame is never observed (a future Codex that stops
 * painting the header, or bytes that landed before the listener attached),
 * the host still delivers, but only after this multiple of the ordinary
 * fallback. It is measured from the startup probe when one was seen, otherwise
 * from the first output byte. A detector miss then makes delivery slower
 * instead of typing into a booting TUI. */
export const CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER = 4;

/** Has the startup-ready fallback window elapsed? For most backends it is
 * measured from the child's first output byte. For Codex it is measured from
 * the first frame Codex paints once its session exists (see
 * codexSessionFrameObserved). It is
 * not measured from the launcher banner: the PTY child is the psu launcher,
 * which bootstraps the role for ~20s under load before Codex execs. It is not
 * measured from Codex's startup probe either, because Codex can then read
 * stdin for up to ~14s more and swallow whatever is typed (WI-10002745).
 * Without a frame, the widened window runs from the probe when one was seen:
 * the launcher's own bootstrap time must not eat into Codex's swallow margin.
 * Pure and exported for tests. */
export function startupFallbackElapsed({
  agent,
  nowMs,
  firstOutputAt,
  backendTuiStartedAt = 0,
  backendFirstFrameAt = 0,
  fallbackMs,
}) {
  if (!(firstOutputAt > 0)) return false;
  if (String(agent ?? '').trim().toLowerCase() === 'codex') {
    if (backendFirstFrameAt > 0) return nowMs - backendFirstFrameAt >= fallbackMs;
    const widenedFrom = backendTuiStartedAt > 0 ? backendTuiStartedAt : firstOutputAt;
    return nowMs - widenedFrom >= fallbackMs * CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER;
  }
  return nowMs - firstOutputAt >= fallbackMs;
}

/** A fresh Claude child can repaint continuously (spinner/elapsed chrome), so
 * output quietness is not a reliable post-epoch settle signal. A standalone
 * composer glyph proves the editor is installed; menu rows include text and
 * do not match this predicate. */
export function freshChildPromptReady(agent, output) {
  const normalized = String(agent ?? '').trim().toLowerCase();
  return normalized === 'claude' && claudeStandaloneComposerPromptVisible(stripAnsi(output));
}

/** Terminate the entire process group created by forkpty, not only its leader.
 * OMP launches a descendant process; signalling only node-pty's immediate child
 * can let that target survive after the host exits. The direct child signal is
 * retained as a cross-platform fallback (negative group pids are POSIX-only). */
/**
 * node-pty's NUMERIC signal -> its name ('SIGHUP'), or null when there was no signal.
 *
 * WI-38054. node-pty reports a signal death as `{ exitCode: 0, signal: N }`; the number
 * alone is unreadable in a database row, and `0`/undefined must map to null rather than
 * to a spurious signal name — a session that exited normally must not acquire one.
 *
 * Resolved from `os.constants.signals` rather than a hardcoded table so it stays correct
 * across platforms (the numbers differ) instead of confidently naming the wrong signal.
 */
export function signalNameFromCode(signal) {
  if (typeof signal !== 'number' || !Number.isFinite(signal) || signal <= 0) return null;
  for (const [name, num] of Object.entries(osConstants.signals)) {
    if (num === signal) return name;
  }
  // An unrecognised number is still positive evidence of a KILL, so never discard it —
  // returning null here would silently restore the "looks like a clean exit" bug.
  return `SIG${signal}`;
}

/**
 * The teardown signal to RECORD: the one that actually arrived, falling back to SIGHUP
 * only when the handler was invoked without a name.
 *
 * WI-10001504. SIGINT/SIGTERM/SIGHUP all land in ONE handler, so recording a constant
 * discarded the single fact that identifies HOW a session died — and because `cleanup`
 * resolves `signal ?? teardownSignal`, a literal at its call site erased it a SECOND
 * time even once the variable was set correctly. The fallback is deliberately 'SIGHUP'
 * and never null: an unnamed teardown is still a kill, and null would restore exactly
 * the "looks like a clean voluntary exit" misreading `signalNameFromCode` above exists
 * to prevent.
 */
export function resolveTeardownSignal(receivedSignal) {
  return typeof receivedSignal === 'string' && receivedSignal ? receivedSignal : 'SIGHUP';
}

export function killPtyProcessTree(child, signal = 'SIGKILL', kill = process.kill) {
  const pid = Number(child?.pid);
  let killed = false;
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1) {
    try {
      kill(-pid, signal);
      killed = true;
    } catch {
      /* the group may already be gone; try the direct child below */
    }
  }
  try {
    child?.kill?.(signal);
    killed = true;
  } catch {
    /* already gone */
  }
  return killed;
}

/**
 * A forkpty process-group kill is not a lifetime boundary for a descendant that
 * called `setsid(2)`: it leaves the pgid but remains in the terminal's cgroup.
 * That exact shape left a 70 GiB diagnostic Hono host running for 12 hours after
 * its agent session ended (EI-20349478936631977).
 *
 * Reap only scopes that are structurally one-session containers. In particular,
 * never sweep a `.service` cgroup: operator/checkpoint services host unrelated
 * work and killing their other members would cross the session boundary. VTE
 * allocates one `vte-spawn-*.scope` per terminal; console-spawn's headless and
 * console scopes carry the same one-session invariant. Enrolled headless launches
 * use a task-manager `pc-*.scope`; that scope is accepted only when the caller has
 * explicitly proved the current host is headless.
 */
const DEDICATED_PSU_SCOPE_RE = /^(?:vte-spawn-[^/]+|papercup-(?:headless|console)-[^/]+|pc-[0-9a-z]{4,64}(?:--[A-Za-z0-9._-]+)?)\.scope$/;
const CGROUP_ROOT = '/sys/fs/cgroup';

function procParentPid(pid, readText) {
  let stat;
  try {
    stat = String(readText(`/proc/${pid}/stat`));
  } catch {
    return null;
  }
  // comm is parenthesised and may itself contain spaces or `)`, so split after
  // the LAST close-paren. The remaining fields begin with state, then ppid.
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) return null;
  const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : null;
}

function protectedAncestorChain(selfPid, readText) {
  const protectedPids = new Set();
  let pid = selfPid;
  for (let depth = 0; depth < 128; depth++) {
    if (!(Number.isSafeInteger(pid) && pid > 0) || protectedPids.has(pid)) {
      return { complete: false, protectedPids };
    }
    protectedPids.add(pid);
    if (pid === 1) return { complete: true, protectedPids };
    const parent = procParentPid(pid, readText);
    if (!parent) return { complete: false, protectedPids };
    pid = parent;
  }
  return { complete: false, protectedPids };
}

function dedicatedScopeDirForPid(pid, readText, { allowManagedScope = false } = {}) {
  let raw;
  try {
    raw = String(readText(`/proc/${pid}/cgroup`));
  } catch {
    return null;
  }
  const unified = raw.split('\n').find((line) => line.includes('::'));
  const rel = unified?.slice(unified.indexOf('::') + 2).trim();
  if (!rel || rel.includes('..')) return null;
  const parts = rel.split('/').filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.endsWith('.scope'));
  if (scopeIndex < 0) return null;
  const scopeLeaf = parts[scopeIndex];
  if (!DEDICATED_PSU_SCOPE_RE.test(scopeLeaf)) return null;
  // A `pc-*.scope` is normally an independently-managed task. Only the explicit
  // headless launch path may sweep it; without this gate, generic PTY cleanup
  // could kill a sibling task merely because it shares the task-manager naming
  // convention.
  if (scopeLeaf.startsWith('pc-') && !allowManagedScope) return null;
  return `${CGROUP_ROOT}/${parts.slice(0, scopeIndex + 1).join('/')}`;
}

function collectScopePids(scopeDir, readText, readDir) {
  const pids = new Set();
  const visit = (dir) => {
    let raw;
    try {
      raw = String(readText(`${dir}/cgroup.procs`));
    } catch {
      return false;
    }
    for (const token of raw.split(/\s+/)) {
      const pid = Number(token);
      if (Number.isSafeInteger(pid) && pid > 1) pids.add(pid);
    }
    try {
      for (const entry of readDir(dir)) {
        if (entry?.isDirectory?.()) visit(`${dir}/${entry.name}`);
      }
    } catch {
      // The root membership read is authoritative for the incident class. A
      // disappearing or unreadable child cgroup is best-effort and retried by
      // the next pass if it remains visible.
    }
    return true;
  };
  return visit(scopeDir) ? pids : null;
}

/**
 * Kill residual members of THIS host's exact dedicated session scope while
 * protecting the host and its full ancestor chain. The cgroup filesystem is the
 * authority even when systemd reports the transient unit `inactive/dead`: unlike
 * `systemctl stop`, membership remains readable until the last child exits.
 *
 * All IO is injectable so the inactive/dead-with-live-child regression is
 * reproducible without putting a real process in the test runner's cgroup.
 */
export function reapDetachedPtyScopeResidue({
  selfPid = process.pid,
  platform = process.platform,
  readText = (path) => readFileSync(path, 'utf8'),
  readDir = (path) => readdirSync(path, { withFileTypes: true }),
  kill = process.kill,
  maxPasses = 3,
  allowManagedScope = false,
} = {}) {
  const empty = (skippedReason, scopeDir = null, protectedPids = []) => ({
    scopeDir,
    protectedPids,
    killedPids: [],
    failedPids: [],
    skippedReason,
  });
  if (platform !== 'linux') return empty('non-linux');

  const scopeDir = dedicatedScopeDirForPid(selfPid, readText, { allowManagedScope });
  if (!scopeDir) return empty('not-in-dedicated-session-scope');

  const ancestors = protectedAncestorChain(selfPid, readText);
  const protectedPids = [...ancestors.protectedPids].sort((a, b) => a - b);
  // Fail toward preserving processes if we cannot identify every ancestor. The
  // alternative could kill the terminal/shim that is still serialising exit.
  if (!ancestors.complete) return empty('ancestor-chain-unreadable', scopeDir, protectedPids);

  const attempted = new Set();
  const killedPids = [];
  const failedPids = [];
  const passes = Math.max(1, Math.min(10, Number(maxPasses) || 1));
  for (let pass = 0; pass < passes; pass++) {
    const members = collectScopePids(scopeDir, readText, readDir);
    if (!members) return empty('scope-membership-unreadable', scopeDir, protectedPids);
    const targets = [...members]
      .filter((pid) => !ancestors.protectedPids.has(pid) && !attempted.has(pid))
      .sort((a, b) => a - b);
    if (targets.length === 0) break;
    for (const pid of targets) {
      attempted.add(pid);
      try {
        kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch {
        failedPids.push(pid);
      }
    }
  }
  return { scopeDir, protectedPids, killedPids, failedPids, skippedReason: null };
}

/** Only a genuine end of an agent-launched session owns the scope. */
export function shouldReapDetachedPtyScopeResidue({
  bridgeTty,
  headless = false,
  launchedBy,
  reexecRequested,
} = {}) {
  const ownedLaunch = Boolean(String(launchedBy ?? '').trim() && !reexecRequested);
  return Boolean(ownedLaunch && (bridgeTty || headless === true));
}

/** Status of the /mcp dialog row naming `name`: 'connected' | 'not-connected' |
 *  'unknown' | null (row doesn't name it). Negative markers are checked FIRST;
 *  note \bconnected\b does NOT match inside "disconnected" (no word boundary
 *  after "dis"), but explicit negatives keep this robust to copy drift. Pure —
 *  exported for tests. */
export function mcpServerRowStatus(line, name) {
  const l = String(line ?? '');
  if (!l.includes(name)) return null;
  if (/\b(disconnected|failed|error|needs authentication|connecting|pending|retrying)\b/i.test(l))
    return 'not-connected';
  if (/\bconnected\b/i.test(l)) return 'connected';
  return 'unknown';
}

/** Does the freshest paint read as "`name` is connected"? Two shapes exist:
 *  the LIST view puts name + status on ONE row (mcpServerRowStatus decides);
 *  the DETAIL view shows the name as a header and `Status: … connected` on its
 *  OWN line — so a bare status line is decisive there (the detail view shows
 *  only one server). Scans freshest-line-first; the first decisive row wins.
 *  Pure — exported for tests. */
export function mcpConnectedVerdict(visible, name) {
  const lines = String(visible ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const rowSt = mcpServerRowStatus(l, name);
    if (rowSt) return rowSt === 'connected';
    if (/\bstatus\b/i.test(l)) {
      if (/\b(disconnected|failed|error|connecting|pending|retrying|needs authentication)\b/i.test(l)) return false;
      if (/\bconnected\b/i.test(l)) return true;
    }
  }
  return false;
}

/** A scripted, fresh headless role must have its signed MCP server before its
 * first task turn. Claude does not reliably retry a failed startup catalog fetch. */
export function headlessRoleKickoffRequiresMcp({ agent, role, headless, hasKickoff, isResume }) {
  return agent === 'claude' && Boolean(role) && headless === true &&
    hasKickoff === true && isResume !== true;
}

/** Reuse the existing closed-loop /mcp walker, with one bounded second chance
 * for a server that was still connecting when the first dialog opened. */
export async function verifyHeadlessRoleMcp(connect, attempts = 2) {
  let last = { ok: false, step: 'not-attempted', detail: 'no MCP check ran' };
  for (let i = 0; i < attempts; i++) {
    last = await connect();
    if (last.ok) return { ...last, attempts: i + 1 };
  }
  return { ...last, attempts };
}

/** Is the ❯ selection cursor on the (freshest) dialog row matching `test`?
 *  Parses an ANSI-stripped visible chunk; the LAST matching line reflects the
 *  most recent repaint. Pure — exported for tests. */
export function mcpDialogRowSelected(visible, test) {
  const lines = String(visible ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const row = [...lines].reverse().find((l) => test(l));
  if (!row) return false;
  // the cursor glyph precedes the row text; require it BEFORE the matched content
  const m = row.search(/❯|›/u);
  return m >= 0 && m < row.length && test(row.slice(m));
}

/**
 * Drive the claude TUI's /mcp dialog to reconnect `serverName` — the P-003
 * closed-loop macro. All IO is injected (write = child stdin bytes; readTap /
 * resetTap = the rolling child-output tap) so the walker unit-tests against a
 * scripted fake TUI. Steps (each bounded, each verified off the screen):
 *   1. type `/mcp`, settle, CR (separate keystroke — paste-detector, WI-2930).
 *   2. wait for the dialog to paint (target server name visible).
 *      Already-connected ⇒ close + ok('already-connected') — the benign-misfire
 *      no-op the watchdog relies on.
 *   3. arrow-down until the ❯ cursor sits on the target row (re-parse after
 *      every keypress; bounded), then Enter.
 *   4. if a reconnect action row paints, cursor onto it the same way + Enter
 *      (some versions reconnect straight off step 3's Enter — then this is
 *      skipped by the connected-wait below).
 *   5. wait for the target row to read connected; Esc Esc out either way.
 * Returns { ok, step, detail } — the caller appendHostEvent()s it durably.
 */
export async function runMcpReconnectMacro({
  serverName,
  write,
  readTap,
  resetTap,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  crDelayMs = 150,
  settleMs = 300,
  paintBudgetMs = 8_000,
  reconnectBudgetMs = 20_000,
  maxArrows = 40,
}) {
  const ESC = '\x1b';
  const DOWN = '\x1b[B';
  const CR = '\r';
  const visible = () => stripAnsi(readTap());
  const closeOut = async () => {
    write(ESC);
    await sleep(150);
    write(ESC);
  };
  const waitFor = async (test, budgetMs) => {
    const until = Date.now() + budgetMs;
    for (;;) {
      const v = visible();
      if (test(v)) return v;
      if (Date.now() >= until) return null;
      await sleep(150);
    }
  };
  const targetRowStatus = (v) => {
    const lines = v.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const st = mcpServerRowStatus(lines[i], serverName);
      if (st) return st;
    }
    return null;
  };
  // Claude prints `Reconnected to <server>.` both for a direct `/mcp` reconnect
  // (2.1.280) and when the dialog's Reconnect action succeeds and the dialog
  // closes. The live TUI renders it as a local-command result behind a `⎿`
  // gutter, and Ink's diff renderer can emit inter-word gaps as cursor moves
  // that stripAnsi drops — measured 2026-09-27 as `⎿  Reconnectedtopapercusp.`
  // (WI-10003453). So compare with whitespace and the leading gutter removed,
  // but still require the WHOLE line: a partial reconnect message (for example,
  // ", but fetching tools failed") is not readiness.
  const expectedReconnectLine = `Reconnectedto${String(serverName).replace(/\s+/gu, '')}.`;
  const directReconnectSucceeded = (v) =>
    v.split('\n').some(
      (line) => line.replace(/\s+/gu, '').replace(/^[⎿│└├─]+/u, '') === expectedReconnectLine,
    );

  // (1) open the dialog
  resetTap();
  write('/mcp');
  await sleep(crDelayMs);
  // Typing the slash command paints autocomplete entries such as
  // `/papercusp:tool:*` before Enter. They contain the server name but are not
  // the /mcp result; judge only output produced after submitting the command.
  resetTap();
  write(CR);

  // (2) painted?
  const painted = await waitFor((v) => v.includes(serverName), paintBudgetMs);
  if (!painted) {
    await closeOut();
    return { ok: false, step: 'open-dialog', detail: `'${serverName}' never painted within ${paintBudgetMs}ms` };
  }
  if (directReconnectSucceeded(painted)) {
    return { ok: true, step: 'direct-reconnected', detail: 'Claude /mcp confirmed this server reconnected' };
  }
  if (targetRowStatus(painted) === 'connected') {
    await closeOut();
    return { ok: true, step: 'already-connected', detail: 'target row reads connected — nothing to heal' };
  }

  // (3) cursor onto the target row
  const onTarget = () => mcpDialogRowSelected(visible(), (l) => l.includes(serverName));
  let selected = onTarget();
  for (let i = 0; !selected && i < maxArrows; i++) {
    resetTap();
    write(DOWN);
    await sleep(settleMs);
    selected = onTarget();
  }
  if (!selected) {
    await closeOut();
    return { ok: false, step: 'select-server', detail: `cursor never reached '${serverName}' in ${maxArrows} downs` };
  }
  resetTap();
  write(CR);
  await sleep(settleMs);

  // (4) a reconnect action row (if this version paints one)
  if (/\breconnect\b/i.test(visible())) {
    const onReconnect = () => mcpDialogRowSelected(visible(), (l) => /\breconnect\b/i.test(l));
    let sel = onReconnect();
    for (let i = 0; !sel && i < maxArrows; i++) {
      resetTap();
      write(DOWN);
      await sleep(settleMs);
      sel = onReconnect();
    }
    if (sel) {
      resetTap();
      write(CR);
    }
    // not found selected ⇒ fall through — the connected-wait below still judges it
  }

  // (5) did it connect? (list-row OR detail-status shape — mcpConnectedVerdict —
  // OR the dialog closed itself and printed the success line.) mcpConnectedVerdict
  // alone can never accept that line: `\bconnected\b` has no word boundary inside
  // "Reconnected", so a real success used to time out here (WI-10003453).
  const done = await waitFor(
    (v) => directReconnectSucceeded(v) || mcpConnectedVerdict(v, serverName),
    reconnectBudgetMs,
  );
  if (done && directReconnectSucceeded(done)) {
    // The dialog is already closed; Esc Esc at the bare prompt would open the
    // message selector underneath the kickoff that is about to be typed.
    return { ok: true, step: 'done', detail: 'dialog reconnect printed the success line' };
  }
  await closeOut();
  return done
    ? { ok: true, step: 'done', detail: 'connected verdict observed' }
    : { ok: false, step: 'await-connected', detail: `no connected marker within ${reconnectBudgetMs}ms` };
}

// ── Same-source turn coalescing (compaction-continuity-hardening-2026-07-07 P-001a) ──
//
// Every control-socket connection runs its OWN async handler, and a gated 'turn'
// waits at the idle + agent-busy gates before writing. So N wakes arriving while
// the agent is busy all queue at the gates and ALL inject back-to-back the moment
// the prompt returns — measured live: the same loop wake delivered up to 9×, each
// a full template copy (~3KB), straight into the woken session's context. The
// upstream layers are NOT the leak (loop fires park at infinity while a turn is in
// flight; the await store's pump already coalesces per-subscriber deliveries) —
// only injects that stack up INSIDE this host between gate-wait and pty-write.
//
// The coalescer folds same-source turns while one is still waiting: the FIRST
// arrival becomes the waiter; later same-key arrivals just update it to the newest
// text and bump a fold counter, then return. When the waiter finally passes the
// gates it claims the newest text + fold count and delivers ONE turn annotated
// with how many duplicates folded in. Keyed by the turn text's first non-empty
// line: a loop wake's first line carries the loop marker + goal (stable across
// wakes of the same loop), while distinct sources (owner messages, other loops)
// differ — those still deliver independently.

/** Coalesce key for an injected turn: a loop's stable instance id when present,
 *  otherwise its first non-empty line, trimmed+capped. Loop short-form wakes
 *  lead with `Loop wake #<fireNumber>`, so text-only keys treat every fire as a
 *  different source and let a queued backlog spend one turn per fire. The
 *  envelope's routineId is the stable identity we actually want to coalesce.
 *
 *  WI-2141436 hole #4: `routineId` alone has no owner component. In the normal
 *  case this is safe — `makeTurnCoalescer()` is instantiated once per host
 *  PROCESS and one process serves exactly one ownerId's control socket, so its
 *  `pending` Map is already owner-scoped by construction. The residual gap is
 *  a socket-identity collision one layer down (the EI-153 comment's own
 *  "sanitizeKey collision at some OTHER layer") COMBINED with an unaddressed
 *  arrival (msg.ownerId omitted — the same latent hole as #1-#3): that pair
 *  can reach the coalescer without ever hitting the `msg.ownerId !== ownerId`
 *  mismatch guard, because the guard is a no-op when ownerId is absent. Taking
 *  `ownerId` here and folding it into the key is defense-in-depth for exactly
 *  that combination — it costs nothing in the common case (every call site
 *  passes the HOST's own ownerId, so same-host keys are unaffected) and
 *  guarantees two different owners' pending turns can never fold into one
 *  another even if their sockets ever did collide.
 *  Pure — exported for tests.
 *  @param {string} [data]
 *  @param {string} [routineId]
 *  @param {string} [ownerId] */
export function turnCoalesceKey(data, routineId, ownerId) {
  const ownerPrefix = String(ownerId ?? '').trim() ? `owner:${String(ownerId).trim()}|` : '';
  const loopId = String(routineId ?? '').trim();
  if (loopId) return `${ownerPrefix}loop-fire:${loopId}`;
  const first = String(data ?? '')
    .split('\n')
    .find((l) => l.trim().length > 0);
  return `${ownerPrefix}${(first ?? '').trim().slice(0, 300)}`;
}

/** Render the delivered turn text, annotating how many duplicates folded in.
 *  Pure — exported for tests. */
export function renderCoalescedTurn(data, folded) {
  if (!folded || folded < 1) return data;
  return (
    `${data}\n(${folded} duplicate queued wake${folded === 1 ? ' was' : 's were'} coalesced ` +
    'into this ONE delivery while your session was busy — treat this as a single wake, not ' +
    `${folded + 1} separate ones)`
  );
}

/** The per-host coalescer state machine. admit() returns true when the arrival was
 *  FOLDED into an already-waiting inject (the caller must NOT proceed); false when
 *  the caller became the waiter and must claim() at delivery — or on ANY early exit
 *  (defer/error), so folded wakes never black-hole behind a dead waiter. Delivery
 *  IDs folded into a waiter travel with it so the parent pipeline settles every
 *  accepted ID together (F03: a deferred parent must not leave a folded retry
 *  permanently deduped). */
export function makeTurnCoalescer() {
  const pending = new Map(); // key -> { data, folded, metadata?, deliveryIds? }
  const addDeliveryId = (entry, deliveryId) => {
    if (!deliveryId) return;
    entry.deliveryIds ??= [];
    if (!entry.deliveryIds.includes(deliveryId)) entry.deliveryIds.push(deliveryId);
  };
  return {
    admit(key, data, metadata, deliveryId) {
      const p = pending.get(key);
      if (p) {
        p.data = data; // newest wins — it carries the freshest checkpoint splice
        if (metadata !== undefined) p.metadata = metadata;
        addDeliveryId(p, deliveryId);
        p.folded += 1;
        return true;
      }
      const entry = metadata === undefined ? { data, folded: 0 } : { data, folded: 0, metadata };
      addDeliveryId(entry, deliveryId);
      pending.set(key, entry);
      return false;
    },
    /** Replace the text/metadata of an EXISTING waiter without counting another
     *  logical fire. A retry of the SAME durable delivery id is not a folded wake,
     *  but its executor-side delivery re-check may have rebuilt the envelope from a
     *  newer loop:checkpoint while the first attempt was still behind this host's
     *  busy gate (EI-21428742689578243). Returning false when the waiter already
     *  claimed its slot keeps this best-effort and never resurrects a delivered turn. */
    refresh(key, data, metadata) {
      const p = pending.get(key);
      if (!p) return false;
      // A newer DISTINCT fire may already have folded into this same routine
      // waiter after the original delivery was accepted. A late retry of the
      // older delivery still carries its older fireNumber: it may refresh its
      // own checkpoint snapshot, but it must not roll the logical fire backward.
      if (
        p.metadata?.routineId &&
        metadata?.routineId === p.metadata.routineId &&
        Number.isFinite(p.metadata.fireNumber) &&
        Number.isFinite(metadata.fireNumber) &&
        p.metadata.fireNumber > metadata.fireNumber
      ) {
        return false;
      }
      p.data = data;
      if (metadata !== undefined) p.metadata = metadata;
      return true;
    },
    claim(key) {
      const p = pending.get(key) ?? null;
      pending.delete(key);
      return p;
    },
    size() {
      return pending.size;
    },
  };
}

/** Default TTL a delivery id is remembered as "already accepted" (EI-19311270129974785).
 *  Sized comfortably above the client's own retry envelope — `markDeliveryFailed`'s
 *  backoff caps at 10min and the pump gives up after a bounded attempt count — so a
 *  legitimate late retry of an already-accepted delivery is always still deduped, while
 *  the map cannot grow unbounded on a long-lived host. Exported for tests. */
export const DELIVERY_DEDUP_TTL_MS = 30 * 60_000;

/**
 * The per-host delivery-id dedup memory (EI-19311270129974785): once a delivery has
 * been ACK'd 'accepted' (see the conn.on('end') handler's early-ack fast path), the
 * host is unstoppably committed to eventually running the gated pipeline for it —
 * but the CLIENT cannot always tell that happened. Its own ack-wait can time out, or
 * the host's ack write-back can fail (both explicitly documented as best-effort, see
 * the "the client's own timeout is the backstop" comment below) — either way looks to
 * the client exactly like a miss, and it retries with an IDENTICAL delivery id. Without
 * this memory, a retry arriving after the original waiter already cleared (delivered or
 * dropped) reads as a brand-new, unrelated request and gets a SECOND real turn written
 * into the pty — the turnCoalescer above only folds concurrent duplicates still parked
 * at the gate, and has no notion of "this exact delivery already ran to completion."
 * `isDuplicate` opportunistically sweeps expired entries on every call (bounded cost —
 * only iterates while there is something to evict); pure factory, exported for tests. */
export function makeDeliveryDedup({ ttlMs = DELIVERY_DEDUP_TTL_MS, now = Date.now } = {}) {
  const entries = new Map(); // deliveryId -> { state: 'pending'|'completed', at }
  const sweep = (t) => {
    for (const [k, entry] of entries) {
      if (t - entry.at > ttlMs) entries.delete(k);
    }
  };
  const getState = (id) => {
    if (!id) return null;
    const t = now();
    sweep(t);
    return entries.get(id)?.state ?? null;
  };
  return {
    /** Return the live state for `id`, or null when it is new/expired. */
    state(id) {
      return getState(id);
    },
    /** True when `id` is pending or completed within the TTL. `id` may be
     *  undefined/empty (a message with no delivery row) — always false then, so
     *  callers can pass it through unconditionally. */
    isDuplicate(id) {
      return getState(id) !== null;
    },
    /** Record the early ACK commitment while the detached gated pipeline runs. */
    markPending(id) {
      if (!id) return;
      const current = entries.get(id);
      if (current?.state === 'completed') return;
      entries.set(id, { state: 'pending', at: now() });
    },
    /** Record the point at which the gated pipeline committed its delivery. */
    markCompleted(id) {
      if (!id) return;
      entries.set(id, { state: 'completed', at: now() });
    },
    /** A terminal failed/deferred pipeline is eligible for a later retry. */
    clearPending(id) {
      if (!id) return;
      if (entries.get(id)?.state === 'pending') entries.delete(id);
    },
    /** Backward-compatible name for callers that already have a committed delivery. */
    markAccepted(id) {
      this.markCompleted(id);
    },
    size() {
      sweep(now());
      return entries.size;
    },
  };
}

/** Decide how the detached host pipeline settles one delivery ID.
 * A busy-gate deferral remains pending only when the re-arm controller still
 * owns that exact delivery; folded IDs that the re-arm does not own stay
 * retryable. */
export function deliveryDedupSettlement(deliveryOutcome, rearmOwnsDelivery = false) {
  if (
    deliveryOutcome?.ok === true &&
    (deliveryOutcome.reason === 'delivered' || deliveryOutcome.reason === 'quota-recovery-delivered')
  ) {
    return 'completed';
  }
  if (deliveryOutcome?.reason === 'deferred-busy-gate' && rearmOwnsDelivery) return 'pending';
  return 'clear';
}

/**
 * A minimal FIFO async mutex serializing the GATED-inject critical section within
 * a single host (EI-8822). Each control-socket connection runs its OWN async
 * handler, and a gated inject waits at the idle + agent-busy gates before it
 * writes. Without this, two gated injects freed at the SAME clean boundary — a
 * coord wake `turn` and a session:request-compaction `/compact`, both released the
 * instant the agent returns to its prompt — both pass the at-prompt gate and
 * interleave their bytes into the SAME pty input line. The second's text lands
 * CONCATENATED after the first ("<wake payload>…/compact <focus>"), so the CLI
 * reads it as one prose message, not a command, and the compaction silently never
 * runs (the agent keeps working at 90%+ context believing it compacted). The
 * coalescer above only folds SAME-source turns; it gives no mutual exclusion
 * between a wake and a compact. Holding this mutex across the whole
 * gate-wait-through-write sequence guarantees every gated inject is written as an
 * isolated, uninterrupted input line. Ungated raw/osc injects never acquire it (a
 * force-interrupt byte must land immediately, mid-turn; an osc recolor targets the
 * terminal display, not the agent's input line). `acquire()` resolves to a
 * `release` fn once the lock is free; the holder MUST call it (a `finally`). A
 * throwing/deferred critical section still releases via that finally, so one
 * inject's failure never wedges the queue.
 *
 * EI-22123519641932348: `await prev` alone has NO bound — every gate/verify
 * step downstream of acquire() is independently time-capped (confirmed by
 * reading each one: the idle/composer/busy gates, the submit verifier,
 * recycleChild's kill+respawn+carry sequence), but if a holder's critical
 * section fails to reach its `finally` release for a reason none of those
 * caps cover, every later gated inject queues behind it silently and
 * forever — this is the ONE unbounded wait in the whole gated-delivery
 * pipeline, and matches a live incident: ~6h of TOTAL SILENCE in a host's
 * event log (zero rows of any kind) spanning 4 stacked wake fires that all
 * reported `delivered` yet started no turn. `acquire()` now races `prev`
 * against a two-stage watchdog: past `warnMs` it fires `onStuck({phase:
 * 'warn', waitedMs})` (loud, side-effect-free — see the wiring at this
 * mutex's construction site for the durable host-event it becomes) while
 * still waiting for `prev`; past `forceReleaseMs` it fires `onStuck({phase:
 * 'force-release', waitedMs})` and lets this acquirer proceed AS IF the
 * wedged holder had released. `prev` itself is never resolved by the
 * watchdog — only THIS waiter stops awaiting it. If the original holder
 * eventually does call its own release(), that resolves a promise nothing
 * awaits any more (every later acquire() chains off THIS waiter's own tail,
 * never off `prev`) — a harmless no-op, never a second wedge. Both windows
 * default far above the slowest legitimate hold (a carry-respawn recycle,
 * ~11min worst case — see the INJECT_MUTEX_WARN_MS doc comment) so a
 * healthy, merely-slow delivery never trips either one. Pure factory
 * (`now`/`onStuck` injected, matching this file's other gate factories);
 * exported for tests. */
export function makeInjectMutex({
  now = Date.now,
  warnMs = INJECT_MUTEX_WARN_MS,
  forceReleaseMs = INJECT_MUTEX_FORCE_RELEASE_MS,
  onStuck = () => {},
} = {}) {
  let tail = Promise.resolve();
  return {
    /** Resolve to a release() fn once the lock is free (FIFO), or once the
     *  watchdog force-releases a wedged holder (see the doc block above).
     *  Caller MUST call the returned release(). */
    async acquire() {
      const prev = tail;
      /** The `resolve` of `tail`, captured synchronously by the executor below.
       *  Annotated, and initialised to the explicit `undefined` that a bare
       *  `let release;` already meant — so this is a ZERO runtime change. It
       *  exists because declaration emit cannot see that a Promise executor
       *  runs synchronously: without it `release` infers as `undefined`, this
       *  method is emitted as `acquire(): Promise<undefined>`, and every
       *  correct `const r = await m.acquire(); r();` caller is a type error
       *  against code that works fine at runtime (17 such errors in
       *  psu-pty-host.test.ts alone, which is what put apps/operator over its
       *  tsc baseline and held the green-checkpoint gate red).
       *  @type {(value?: any) => void} */
      let release = /** @type {any} */ (undefined);
      tail = new Promise((resolve) => {
        release = resolve;
      });
      const waitStartedAt = now();
      await new Promise((resolveAcquire) => {
        let settled = false;
        let warnTimer = null;
        let forceTimer = null;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (warnTimer) clearTimeout(warnTimer);
          if (forceTimer) clearTimeout(forceTimer);
          resolveAcquire();
        };
        prev.then(settle); // the ordinary, unstuck path
        const reportStuck = (phase) => {
          try {
            onStuck({ phase, waitedMs: now() - waitStartedAt });
          } catch {
            /* a diagnostic callback must never itself wedge the mutex */
          }
        };
        // Finite, positive windows only — a disabled/misconfigured watchdog
        // (0/NaN/Infinity) must never spend a real timer on it, and must
        // never change ordinary (unstuck) behavior.
        if (Number.isFinite(warnMs) && warnMs > 0) {
          warnTimer = setTimeout(() => {
            if (settled) return; // prev already resolved between tick and here
            reportStuck('warn');
          }, warnMs);
          warnTimer.unref?.();
        }
        if (Number.isFinite(forceReleaseMs) && forceReleaseMs > 0) {
          forceTimer = setTimeout(() => {
            if (settled) return;
            reportStuck('force-release');
            settle(); // proceed as though the wedged holder had released
          }, forceReleaseMs);
          forceTimer.unref?.();
        }
      });
      return release; // caller releases → frees the next FIFO waiter
    },
  };
}

// ── WI-5510: delivery-side STALE-FIRE GUARD ──────────────────────────────────
//
// Follow-up to EI-15799 (whose fix was cosmetic — renderColdWakeInjection just
// LABELS a cold-wake delivery with its fire number so a receiving agent can
// notice a lag; it explicitly did NOT drop a superseded delivery, and said so
// in its own doc comment). The root cause EI-15799 left open: the FIRE-time
// decision (loop-fire.ts, which computes `fireNumber = priorFires + 1` and
// stamps it on the wake payload) and the DELIVERY-time execution (the control-
// socket connection handler below, an EXTERNAL process from loop-fire.ts's
// point of view) are two separate stages with NO shared state between them.
// A fire can be decided/queued, gate-wait here (the idle + agent-busy gates can
// hold a delivery for minutes), and THEN a LATER fire for the SAME loop is
// decided, wins its own gate race, and delivers FIRST — so when the earlier
// delivery's wait finally clears, writing it flushes a stale, already-
// superseded wake mid-turn into the live session (this is exactly the failure
// EI-15799 was filed against, live-witnessed again during this very fix — see
// WI-5510's repro comment).
//
// makeStaleFireGuard is the shared state loop-fire.ts and the delivery path
// were missing: "the last fire number this host has committed to deliver, per
// loop instance". Keyed by `routineId` (the loop's stable `routines` row id,
// stamped into the wake payload by loop-fire.ts alongside `wakeCount`) rather
// than a bare fire number, so a loop that was `loop:end`ed and later re-armed
// (fire numbers restart at 1) is never mistaken for a stale delivery of the
// OLD loop's higher fire count — a fresh routineId always admits.
export function makeStaleFireGuard() {
  const lastByRoutine = new Map();
  return {
    /**
     * Decide + COMMIT in one call (mirrors makeTurnCoalescer's admit/claim
     * commit-at-delivery style): a message with no `routineId`/`fireNumber`
     * (not a loop-fire wake, or a pre-WI-5510 sender) always admits and never
     * touches the map — this guard is opt-in per-message, not a new
     * requirement on every control-socket write. When both are present,
     * admits (and records `fireNumber` as the new high-water mark) only when
     * `fireNumber` is STRICTLY NEWER than the last one committed for this
     * `routineId`; an equal-or-older fire number is a stale/duplicate
     * delivery and must be DROPPED (admit:false) without updating state.
     */
    admit(routineId, fireNumber) {
      if (routineId == null || fireNumber == null) return { admit: true, lastDelivered: null };
      const lastDelivered = lastByRoutine.get(routineId) ?? 0;
      if (fireNumber <= lastDelivered) return { admit: false, lastDelivered };
      lastByRoutine.set(routineId, fireNumber);
      return { admit: true, lastDelivered };
    },
    /** Live count of distinct loop instances tracked (diagnostics/tests). */
    size() {
      return lastByRoutine.size;
    },
  };
}

/** EI-18109211232286833: is a `carry-respawn` control message too stale to
 *  deliver? `receivedAtMs` is the moment this host first decoded the message
 *  (stamped once in `conn.on('end')`, reused unchanged across the one
 *  `makeCarryRearmController` retry), so this measures TOTAL elapsed wait —
 *  original busy-gate wait plus the re-arm's — not a per-attempt window.
 *  Pure + injectable clock (matches this file's style, e.g. makeStaleFireGuard
 *  above); exported for unit tests. A message with no `receivedAtMs` (a
 *  pre-fix sender, or any non-carry-respawn caller) is never considered stale
 *  — this guard is opt-in per-message, same convention as the stale-fire
 *  guard's opt-in `routineId`/`fireNumber`. */
export function isCarryRespawnStale(receivedAtMs, { maxAgeMs = CARRY_RESPAWN_MAX_AGE_MS, now = Date.now() } = {}) {
  if (receivedAtMs == null) return false;
  return now - receivedAtMs > maxAgeMs;
}

/** EI-18665672258948707: is a `carry-respawn` control message SUPERSEDED — has a
 *  LATER respawn already fired on THIS host since the message first arrived?
 *  Distinct from age-based staleness (isCarryRespawnStale above): the reported
 *  failure was a queued carry-respawn whose CLIENT-side injectIntoHost() write
 *  appeared to time out (a momentarily busy host lost the client's 2s
 *  socket-close race) even though the server had already durably received +
 *  queued the envelope. The calling agent, seeing `ok:false`, retried
 *  session:request-compaction — the second attempt built a FRESH carry document
 *  and delivered promptly, spawning a real successor that went on to do real
 *  work. The FIRST envelope, still gate-waiting (or pending its one
 *  carryRearm retry), was well within the 30-minute staleness cap and so was
 *  delivered anyway 28 minutes later — killing the live, already-progressed
 *  successor and replacing it with a stale snapshot from before that successor
 *  ever existed. A superseded carry-respawn can never be the right one to
 *  deliver, independent of its age, so this check is unconditional (no maxAgeMs
 *  knob) and orthogonal to isCarryRespawnStale — a caller applies BOTH. Pure;
 *  exported for unit tests. */
export function isCarryRespawnSuperseded(receivedAtMs, lastRespawnAtMs) {
  if (receivedAtMs == null || !lastRespawnAtMs) return false;
  return lastRespawnAtMs > receivedAtMs;
}

/** EI-18679681961154136 / EI-18681914950138372: should an incoming control
 *  message be DEFERRED because a carry-respawn is currently in flight for this
 *  host — either awaiting its FIRST delivery attempt's outcome, or a re-armed
 *  RETRY?
 *
 *  makeCarryRearmController's production re-poll loop RELEASES the inject
 *  mutex between busy-gate-defer attempts on purpose (so ordinary wakes are
 *  never wedged waiting on it) — but that same release lets a ready-to-fire
 *  `mode:'turn'` wake win the race for every idle window the rearm loop is
 *  polling for: it opens a fresh turn, the agent goes busy again, and the
 *  rearm's own next attempt misses the window it was waiting for. Repeated
 *  indefinitely (a busy, well-connected agent keeps receiving wakes), the
 *  queued carry-respawn is starved forever — observed + diagnosed end-to-end
 *  on 2026-07-26 (EI-18679681961154136). The original fix covered only the
 *  RETRY phase (`pending`, populated inside `schedule()`) — which starts only
 *  once the FIRST busy-gate wait has already timed out. During that entire
 *  first wait (up to the full busy-gate cap), a wake arriving sailed through
 *  this check unfiltered, queued on the inject mutex BEFORE the eventual
 *  retry did, and won every time (mutex is FIFO) — the same starvation, one
 *  layer earlier (EI-18681914950138372, also 2026-07-26). `pendingRespawnCount`
 *  now covers BOTH phases (see makeCarryRearmController's `inFlight` set +
 *  beginFirstAttempt/endFirstAttempt), closing the gap end-to-end. Only
 *  `mode:'turn'` is deferred here: reset/recycle/mcp-reconnect are explicit
 *  operator/owner actions, not routine wakes, and stay unaffected. The
 *  deferred wake loses nothing — it is already durable mail (coord/loop
 *  redeliver it) and is picked up on the next natural turn, exactly like an
 *  ordinary busy-gate refusal. Pure — exported for tests. */
export function shouldDeferWakeForPendingRespawn(mode, pendingRespawnCount) {
  return mode === 'turn' && pendingRespawnCount > 0;
}

/** The ordered write STEPS the host performs against the pty for a decoded
 *  message. raw → ONE immediate verbatim write (force-interrupt byte). turn →
 *  TWO writes: the line text, then the submit Enter (CR) as a SEPARATE keystroke
 *  `crDelayMs` later — because a single `text + CR` burst is swallowed by the
 *  Claude Code TUI's paste detector (the CR becomes a literal newline and the
 *  turn never submits). Pure — exported for tests. */
export function controlWrites(decoded, crDelayMs = TURN_SUBMIT_CR_DELAY_MS) {
  // raw (force-interrupt byte) and osc (recolor bytes) are both ONE immediate
  // verbatim write — no idle gate, no submit CR.
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return [{ data: decoded.data, delayMs: 0 }];
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: crDelayMs },
  ];
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The submit delay is backend-specific because each interactive TUI has its
 *  own paste/compose handling. Keep the wire protocol backend-neutral; the
 *  hosting psu process already knows its child agent via PAPERCUSP_AGENT.
 *  @param {EnvironmentMap} [env]
 */
export function turnSubmitCrDelayForAgent(agent, env = process.env) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') {
    return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS, CODEX_TURN_SUBMIT_CR_DELAY_MS);
  }
  return positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS, TURN_SUBMIT_CR_DELAY_MS);
}

function codexTurnResubmitCrDelay(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS, CODEX_TURN_RESUBMIT_CR_DELAY_MS);
}

function ompTurnResubmitCrDelay(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_OMP_RESUBMIT_CR_MS, CODEX_TURN_RESUBMIT_CR_DELAY_MS);
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const DEC_PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;
/** Enough trailing output to hold a DEC private-mode toggle split across two
 *  pty chunks (`ESC[?1004;2004h` is 14 chars). */
export const BRACKETED_PASTE_TAIL_CHARS = 32;

/** EI-24141825238362808: the child TUI's bracketed-paste mode (DECSET 2004)
 *  after it wrote `chunk`, given the mode before it and the tail of its earlier
 *  output, so a toggle split across two pty chunks is still seen. The last
 *  toggle wins; output with no toggle leaves the mode unchanged. Claude Code
 *  emits `ESC[?2004h` in its first ~100 output bytes, well before its composer
 *  prompt. Pure — exported for tests. */
export function bracketedPasteModeAfter(enabled, prevTail, chunk) {
  let mode = enabled === true;
  for (const m of `${prevTail ?? ''}${chunk ?? ''}`.matchAll(DEC_PRIVATE_MODE_RE)) {
    if (m[1].split(';').includes('2004')) mode = m[2] === 'h';
  }
  return mode;
}

/** Frame turn text as ONE bracketed paste. Embedded paste markers are removed
 *  so the payload cannot close the frame early and have its remainder read as
 *  typed keys. Pure — exported for tests. */
export function bracketedPasteFrame(text) {
  const body = String(text ?? '').replaceAll(BRACKETED_PASTE_START, '').replaceAll(BRACKETED_PASTE_END, '');
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}

/** Backend-aware write plan for an injected turn. Codex and OMP receive one
 *  redundant delayed submit CR because the first CR can be consumed as input,
 *  leaving the turn text visible but unsent. OMP used to receive LF instead of
 *  the terminal Enter byte; a real OMP 16.x session acknowledged the control
 *  write but persisted no user message and produced no transcript at all.
 *  A `reset` (RESET-CONTEXT) is a turn PREFIXED by the backend's context-clear
 *  command (see resetWritesForAgent).
 *
 *  EI-24141825238362808: when the Claude child has enabled bracketed paste
 *  (`opts.bracketedPaste`), its turn text is framed as one paste. Unframed text
 *  leaves the paste boundary to Claude's read-timing heuristic. When Claude is
 *  busy between pty reads, a long turn fragments and the trailing fragment plus
 *  the submit CR are read as typed keys. Measured on claude 2.1.280: the head
 *  of an 8 KB kickoff was lost, and a 2 KB kickoff's first CR was swallowed
 *  (the fleet-wide ~20 s resubmit lag). Framed, both submitted intact on the
 *  first CR.
 *  @param {EnvironmentMap} [env]
 *  @param {{ bracketedPaste?: boolean }} [opts]
 */
export function controlWritesForAgent(decoded, agent, env = process.env, opts = {}) {
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return controlWrites(decoded);
  if (decoded.mode === 'reset') return resetWritesForAgent(decoded, agent, env, opts);
  const normalized = String(agent || '').trim().toLowerCase();

  if (normalized === 'claude' && opts.bracketedPaste === true) {
    return controlWrites(
      { ...decoded, data: bracketedPasteFrame(decoded.data) },
      turnSubmitCrDelayForAgent(agent, env),
    );
  }

  if (normalized === 'omp') {
    const crDelayMs = turnSubmitCrDelayForAgent(agent, env);
    return [
      { data: decoded.data, delayMs: 0 },
      { data: '\r', delayMs: crDelayMs },
      { data: '\r', delayMs: ompTurnResubmitCrDelay(env) },
    ];
  }

  if (normalized !== 'codex') {
    return controlWrites(decoded, turnSubmitCrDelayForAgent(agent, env));
  }
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
    { data: '\r', delayMs: codexTurnResubmitCrDelay(env) },
  ];
}

/** WI-41386 — the RESPAWN TERMINAL HANDOFF: bytes the HOST writes to its own
 *  stdout (the real terminal) between a dying child and its successor.
 *
 *  WHY. Every recycle puts two CLI processes in one terminal back to back, and
 *  nothing re-anchored the cursor between them. Both primary-buffer backends
 *  draw wherever the cursor happens to be:
 *    - claude renders with the rewind idiom `\r ESC[<N>A` + rewrite, where N is
 *      the live frame height. Killed INSIDE that window — which a mid-turn
 *      SIGHUP usually is — the cursor is left up to a whole frame above the last
 *      drawn row. Its successor's first bytes carry NO newline, NO CUP and NO
 *      ED (measured on a captured stream), so the boot banner lands there and
 *      overwrites the predecessor's final frame: the owner loses the last
 *      screenful of history at every restart (measured ~40-50 lines on
 *      su-4b48f, 2026-08-24).
 *    - codex is the same class and asks the terminal where it is (`ESC[6n`),
 *      so it anchors to exactly the position we leave it at.
 *    - omp is the exception: it runs on the ALTERNATE screen (`?1049h`), so it
 *      never writes the primary scrollback at all and cannot lose it this way.
 *
 *  So the anchor below is written for every backend rather than branching on
 *  one: it is a no-op for a well-behaved child, and it is the only thing that
 *  helps a badly-behaved one. Two parts:
 *
 *  1. RESTORE — undo terminal modes a killed child never got to reset. A
 *     SIGKILLed omp never emits `?1049l`, stranding the terminal on the
 *     alternate screen where the successor then paints invisibly; a child
 *     killed mid-frame can leave the cursor hidden, SGR mid-colour, mouse
 *     reporting on (which makes the terminal spew on every mouse move), or a
 *     scroll region set. Each reset is idempotent, so this costs nothing when
 *     the predecessor exited cleanly.
 *  2. ANCHOR — park on the LAST screen row and emit CRLF. That forces a scroll
 *     rather than an overwrite: whatever the predecessor drew moves up into
 *     scrollback intact, and the successor is guaranteed a virgin line. This is
 *     the half that fixes the history loss, and it is deliberately expressed in
 *     terminal primitives rather than in anything the CLIs do, so it cannot rot
 *     against a backend version bump.
 *
 *  NEVER use `ESC c` (RIS) here — a full reset ERASES scrollback, which is the
 *  very thing this exists to preserve.
 *
 *  Pure — exported for tests.
 *  @param {{ rows?: number, separator?: boolean }} [opts]
 *  @returns {string} the bytes to write, or '' when disabled
 */
export function respawnTerminalHandoffBytes({ rows, separator = true } = {}) {
  const lastRow = Number.isFinite(rows) && rows >= 2 ? Math.floor(rows) : null;
  const restore =
    '\x1b[?1049l' + // leave the alternate screen if a dead child stranded us there
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse reporting off
    '\x1b[?2004l' + // bracketed paste off
    '\x1b[?7h' + // autowrap back on
    '\x1b[r' + // full-height scroll region
    '\x1b[0m' + // SGR reset — no inherited colour/bold
    '\x1b[?25h'; // cursor visible
  // Without a known height, a bare CRLF still guarantees a fresh line; the
  // absolute park is what additionally protects rows BELOW a mid-frame cursor.
  const anchor = (lastRow ? `\x1b[${lastRow};1H` : '') + '\r\n';
  const marker = separator ? '\x1b[2m── session restarted ──\x1b[0m\r\n' : '';
  return restore + anchor + marker;
}

/** The in-place context-clear command for a backend (su-cold-auto-mode P-004a).
 *  RESET-CONTEXT drops the grown transcript while keeping the process + MCP
 *  connections warm — the cheap per-wake cold path. Each interactive CLI exposes
 *  this as a slash command: Claude Code / OMP `/clear`; Codex starts a fresh
 *  conversation with `/new`. Pure — exported for tests. */
export function contextClearCommandForAgent(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') return '/new';
  return '/clear';
}

/** Backend-aware cold-reset delivery. Claude and OMP can clear their context in
 * place, but Codex's `/new` command only changes the visible TUI state; the
 * long-lived Codex process still retains the context that the cold boundary is
 * meant to discard. Route Codex reset envelopes through the existing hard
 * recycle path so a fresh child process is guaranteed.
 *
 * A Claude child spawned WITHOUT --system-prompt-file (a `psu --resume` from
 * before resumeArgsFor carried the persona, or one whose resume render failed)
 * takes the hard path too (EI-24628537598753105): `/clear` would open its fresh
 * conversation on claude's stock coding prompt, while a recycle re-renders the
 * persona and mintRecycleArgs adds the flag. `childArgs` is the LIVE child's
 * argv; omitted, the verdict is the backend default. Pure — exported for tests.
 * @param {string | null | undefined} agent
 * @param {readonly unknown[] | null} [childArgs]
 * @returns {'reset' | 'recycle'} */
export function coldResetModeForAgent(agent, childArgs = null) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') return 'recycle';
  if (normalized === 'claude' && Array.isArray(childArgs)) {
    const hasPersona = childArgs.some(
      (a) =>
        String(a) === '--system-prompt-file' ||
        String(a).startsWith('--system-prompt-file='),
    );
    if (!hasPersona) return 'recycle';
  }
  return 'reset';
}

/** The RESET-CONTEXT settle window (repaint budget after the clear submits).
 *  Session-env tunable, module default as fallback.
 *  @param {EnvironmentMap} [env]
 */
export function clearSettleMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS, CLEAR_SETTLE_MS);
}

/** The submit-verifier's OWN "is a turn genuinely running" quiet threshold
 *  (WI-2975) — deliberately independent of OUTPUT_QUIET_MS (the busy-gate's
 *  short "back at an idle prompt" threshold; see SUBMIT_VERIFY_QUIET_MS above
 *  for the false-positive this decoupling fixes). Session-env tunable, module
 *  default as fallback. Pure — exported for tests.
 *  @param {EnvironmentMap} [env]
 */
export function submitVerifyQuietMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS, SUBMIT_VERIFY_QUIET_MS);
}

/** Absolute path to the session-compacted emit CLI (a sibling script, built by the
 *  event-await-discoverability plan / P-103). The host resolves it relative to itself so
 *  the same path works from the staging AND release checkouts. */
export const SESSION_COMPACTED_EMIT_ENTRY = join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts');

/** EI-24961854655864836: authenticate the successor before submitting its work.
 * A failed first report may confirm through the launcher's existing durable retry.
 * The bounded wait never treats submission/transcript proof as identity authority.
 * @param {{nativeId?: string | null, readNativeId?: () => string | null,
 * report?: (id: string, options: {onConfirmed: (id?: string) => void}) => any,
 * isCurrent?: () => boolean, timeoutMs?: number, pollMs?: number,
 * alreadyConfirmed?: boolean}} options
 */
export async function waitForRespawnBinding({
  nativeId = null, readNativeId = () => null, report = () => false,
  isCurrent = () => true, timeoutMs = 2_000, pollMs = 50, alreadyConfirmed = false,
}) {
  const deadline = Date.now() + timeoutMs;
  let confirmed = alreadyConfirmed && Boolean(nativeId);
  let reporting = false;
  while (isCurrent()) {
    if (!nativeId) {
      try { nativeId = readNativeId(); } catch { /* next bounded startup check */ }
    }
    if (nativeId && !reporting && !confirmed) {
      reporting = true;
      const expectedId = nativeId;
      const onConfirmed = (id = expectedId) => {
        if (id === expectedId && isCurrent()) confirmed = true;
      };
      void Promise.resolve().then(() => isCurrent() ? report(expectedId, { onConfirmed }) : false)
        .then((ok) => { if (ok === true) onConfirmed(); }, () => {});
    }
    if (confirmed) return { ok: true, nativeId, reason: 'successor-reanchor-confirmed' };
    const left = deadline - Date.now();
    if (left <= 0) return {
      ok: false, nativeId,
      reason: nativeId ? 'successor-reanchor-unconfirmed' : 'successor-native-id-missing',
    };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
  return { ok: false, nativeId, reason: 'superseded' };
}

/**
 * Complete the existing carry lifecycle after native delivery and mapping are
 * proven. Codex assigns its id at startup: use the exact isolated rollout from
 * native proof, never "latest" (which can still be the critical predecessor).
 * @param {{ownerId: string, agent?: string, nativeId?: string | null,
 *   proof?: {persisted?: boolean, nativeRef?: string | null} | null,
 *   alreadyReported?: boolean,
 *   report?: (nativeId: string, options: {onConfirmed: () => void}) => any,
 *   isCurrent?: () => boolean,
 *   emit?: typeof fireSessionCompactedEvent, timeoutMs?: number}} options
 */
export async function announceVerifiedCarryRespawn({
  ownerId, agent, nativeId = null, proof = null, alreadyReported = false,
  report = () => false, emit = fireSessionCompactedEvent, timeoutMs = 2_000,
  isCurrent = () => true,
}) {
  if (!proof?.persisted) return { announced: false, nativeId, reason: 'native-turn-unverified' };
  if (!nativeId && agent === 'codex' && proof.nativeRef) {
    nativeId = /^rollout-.*-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i
      .exec(basename(proof.nativeRef))?.[1] ?? null;
  }
  if (!ownerId || !nativeId) return { announced: false, nativeId, reason: 'successor-native-id-missing' };
  let reported = alreadyReported;
  let announced = false;
  const announce = () => {
    if (announced || !isCurrent()) return;
    emit(ownerId, 'carry-respawn', { nativeId });
    announced = true;
  };
  const onConfirmed = () => {
    reported = true;
    try { announce(); } catch { /* fail-soft even after the foreground wait */ }
  };
  let timer;
  try {
    if (!reported) {
      const confirmed = await Promise.race([
        Promise.resolve().then(() => report(nativeId, { onConfirmed })),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]) === true;
      reported ||= confirmed;
    }
    if (!reported) return { announced: false, nativeId, reason: 'successor-reanchor-unconfirmed' };
    if (!isCurrent()) return { announced: false, nativeId, reason: 'successor-carry-superseded' };
    announce();
    return { announced: true, nativeId, reason: 'native-turn-and-reanchor-verified' };
  } catch {
    return { announced: false, nativeId, reason: 'successor-reanchor-or-emit-failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fire the server-side `session:compacted:<owner>` event (event-await-discoverability
 * P-103) after a server-requested compaction COMPLETES, so a peer can
 * `events:await { event: "session:compacted:<owner>" }` instead of polling.
 *
 * THE BRIDGE: this host is a deliberately-minimal standalone process — it has NO PG pool
 * and NO operator HTTP client (see the imports: node fs/net/pty only), so it CANNOT emit
 * the event in-process. Instead it spawns a short-lived DETACHED `tsx` CLI
 * (SESSION_COMPACTED_EMIT_ENTRY) that DOES reach org-PG — the connection resolves via
 * ~/.papercusp/embedded-pg.json (or the native :5432 fallback), independent of this host's
 * env, so the CLI needs no DATABASE_URL handed to it. Compaction is rare, so the tsx
 * cold-start cost is acceptable.
 *
 * `opts.nativeId` is the exact successor native session this completed cut
 * spawned. The detached CLI uses it to refuse a context-estimate refresh while
 * the owner mapping still points at the predecessor (EI-21567375926533125).
 *
 * FAIL-SOFT + fire-and-forget: if the entry does not exist yet (CLI not landed), or tsx /
 * PG fail, nothing touches the live session. Only the CALLER's real-completion path invokes
 * this (never the done.deferred drop). Pure side-effect; returns the spawned child or null.
 */
export function fireSessionCompactedEvent(ownerId, focus, opts = {}) {
  const entry = opts.entry ?? SESSION_COMPACTED_EMIT_ENTRY;
  const spawnFn = opts.spawnFn ?? spawn;
  const exists = opts.existsFn ?? existsSync;
  if (!ownerId) return null;
  // Don't spawn a doomed process before the CLI has landed — a missing entry is the
  // expected state until the event-await plan's P-103 CLI ships.
  if (!exists(entry)) return null;
  try {
    const child = spawnFn(
      'npx',
      ['tsx', entry, String(ownerId), String(focus ?? ''), String(opts.nativeId ?? '')],
      {
        cwd: join(HOST_SCRIPT_DIR, '..', '..', '..'), // checkout root — where npx finds tsx
        env: process.env,
        detached: true,
        stdio: 'ignore',
      },
    );
    // A spawn error (npx/tsx missing) must never surface into the session.
    child.on?.('error', () => {});
    child.unref?.();
    return child;
  } catch {
    return null; // best-effort — the awaiter falls back to its own timeout / next signal
  }
}

/** The ordered write STEPS for a RESET-CONTEXT (su-cold-auto-mode P-004a): submit
 *  the backend's context-clear command, wait `clearSettleMs` for the TUI to
 *  repaint a fresh prompt, then type + submit the carry-note as the opening turn
 *  of the fresh context (the SAME per-agent paste-safe turn plan, its first write
 *  delayed by the settle). An empty carry ⇒ a bare clear (no opening turn). Pure —
 *  exported for tests.
 *  @param {EnvironmentMap} [env]
 *  @param {{ bracketedPaste?: boolean }} [opts]
 */
export function resetWritesForAgent(decoded, agent, env = process.env, opts = {}) {
  const clearCmd = contextClearCommandForAgent(agent);
  const steps = [
    { data: clearCmd, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
  ];
  if (!decoded.data) return steps; // bare clear — no carry turn to open on
  // The carry turn reuses the normal per-agent turn plan; its FIRST write waits
  // for the clear to settle so the text lands on the fresh prompt, not mid-clear.
  const turnPlan = controlWritesForAgent({ mode: 'turn', data: decoded.data }, agent, env, opts);
  turnPlan[0] = { ...turnPlan[0], delayMs: clearSettleMs(env) };
  steps.push(...turnPlan);
  return steps;
}

/**
 * The OSC recolor bytes for a fleet-bound session, from the PAPERCUSP_FLEET_BG /
 * PAPERCUSP_FLEET_FG / PAPERCUSP_FLEET_CURSOR env vars bootstrap-su resolves from
 * the fleet's bound scheme — or null when the session has no fleet (leave the
 * terminal's profile default untouched). OSC 10 (fg) / 11 (bg) / 12 (cursor),
 * each BEL-terminated. This is the launch-time twin of operator-core
 * console-color-schemes.oscRecolorSequence (the runtime fleet:join path emits the
 * same bytes over the 'osc' control mode); inlined here so this plain-mjs host
 * needs no cross-package import — keep the OSC format in lockstep. Pure;
 * exported for tests + psu-launcher's no-pty fallback.
 * @param {EnvironmentMap} [env]
 */
export function fleetOscFromEnv(env = process.env) {
  const bg = env.PAPERCUSP_FLEET_BG;
  if (!bg) return null;
  const fg = env.PAPERCUSP_FLEET_FG;
  const cursor = env.PAPERCUSP_FLEET_CURSOR;
  let s = '';
  if (fg) s += `\x1b]10;${fg}\x07`;
  s += `\x1b]11;${bg}\x07`;
  if (cursor) s += `\x1b]12;${cursor}\x07`;
  return s;
}

/**
 * Connect to a live host's control socket and inject `text` as a submitted turn
 * (idle-gated). Used by tooling/tests; the OPERATOR's wake-executor implements
 * its own connect (it's TS in operator-core) to the SAME contract. Resolves true
 * on a clean write, false on connect error.
 *
 * WI-2141436 hole #1: this had NO ownerId param at all — an envelope-less write
 * with no addressed-recipient assertion, so the receiver's EI-153 misdelivery
 * guard (decodeOwnerIdentity / the `msg.ownerId !== ownerId` check) silently
 * no-ops for every call. Currently dead-code-shaped (no production caller), but
 * it is an exported path, so it gets the same identity binding as every other
 * writer: pass the TARGET session's ownerId and it rides in the envelope,
 * exactly like injectKickoffAfterResume's `{ mode:'turn', data, ownerId }`.
 * `ownerId` is optional only so an unaddressed legacy call still no-ops instead
 * of throwing — always pass it from a real caller.
 * @param {string} sock
 * @param {string} text
 * @param {string} [ownerId] the target session's coord ownerId (PAPERCUSP_SID) —
 *   checked by the receiving host against its own identity before it acts.
 */
export function injectTurn(sock, text, ownerId) {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'turn', data: text, ...(ownerId ? { ownerId } : {}) }));
      c.end();
    });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(true));
  });
}

/**
 * EI-24091823697677465: heal a DEAD loopback operator pin before an in-place respawn.
 * Direct :3170 pins also route proactively through the same-build staging proxy (:9171),
 * including explicit pins. The ordinary launcher already applies this rule, but an
 * in-place carry-respawn reuses this host's environment and bypasses that resolver.
 *
 * The in-place respawn below re-spawns the CLI with THIS host's env, so whatever
 * PAPERCUSP_OPERATOR_URL the session was launched with rides into every successor
 * unexamined. The launcher heals a dead pin only when one of ITS OWN requests fails
 * (fetchWithResilience); an in-place respawn makes no launcher request, so nothing
 * ever re-checks the pin. Measured 2026-09-23: a session launched from a staging
 * console carried http://localhost:3170 through every carry-respawn, and each staging
 * restart took its MCP tools and its owner-directive capture down with it.
 *
 * Only launcher-managed URLs may heal, using the existing provenance marker shared
 * with ptool. An explicit target stays authoritative even when its server is down:
 * a refusal does not authorize moving a current-build session to stable code.
 * A managed pin is replaced only when it refuses connections or its /api/mcp route
 * is confirmed missing. A slow/erroring service and a live MCP endpoint stay
 * authoritative. The replacement is the local MCP proxy, and it must answer both
 * /api/health and /api/mcp. Mutates `env` in place and returns `{ from, to }` when it
 * healed, otherwise null. Never throws.
 *
 * @param {EnvironmentMap} env
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function healDeadOperatorPin(env, { fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  try {
    const pinned = String(env.PAPERCUSP_OPERATOR_URL || '').trim().replace(/\/+$/, '');
    if (!pinned || env.PAPERCUSP_MCP_PROXY === '0') return null;
    let pinnedUrl;
    try {
      pinnedUrl = new URL(pinned);
    } catch {
      return null;
    }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(pinnedUrl.hostname)) return null;
    const stagingProxyPort =
      Number(env.PAPERCUSP_MCP_STAGING_PROXY_PORT) > 0
        ? Number(env.PAPERCUSP_MCP_STAGING_PROXY_PORT)
        : 9171;
    const isStagingProxy = pinnedUrl.port === String(stagingProxyPort);
    if (isStagingProxy) return null; // preserve the same-build, fail-closed staging route

    const isDirectStagingPin =
      ['127.0.0.1', 'localhost'].includes(pinnedUrl.hostname) &&
      pinnedUrl.port === '3170' &&
      ['', '/', '/api/mcp'].includes(pinnedUrl.pathname.replace(/\/+$/, '') || '/');
    if (
      isDirectStagingPin &&
      env.PAPERCUSP_MCP_STAGING_PROXY !== '0'
    ) {
      const stagingProxy = `http://127.0.0.1:${stagingProxyPort}`;
      // WI-10004511: probe the PROXY's own liveness, not `/api/health`. The proxy
      // forwards `/api/health` to :3170, so that probe fails during the staging
      // restart this reroute exists for. The launcher's resolveOperatorTarget probes
      // `/__mcp_proxy_health` too (defaultMcpProxyProbe), so both paths now agree.
      // `/api/health` is kept as a fallback for a proxy without the liveness route.
      const proxyAnswers = async (path) => {
        try {
          const h = await fetchImpl(`${stagingProxy}${path}`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          return Boolean(h?.ok);
        } catch {
          return false;
        }
      };
      try {
        if (
          (await proxyAnswers('/__mcp_proxy_health')) ||
          (await proxyAnswers('/api/health'))
        ) {
          env.PAPERCUSP_OPERATOR_URL = stagingProxy;
          // Keep the same-build staging route authoritative across later respawns;
          // the stable :9071 proxy may serve a different build.
          delete env.PAPERCUSP_OPERATOR_URL_PROVENANCE;
          return { from: pinned, to: stagingProxy, route: 'staging-proxy' };
        }
      } catch {
        /* preserve the direct staging pin if its same-build proxy is unavailable */
      }
    }

    if (env.PAPERCUSP_OPERATOR_URL_PROVENANCE !== 'psu-launcher') return null;
    const proxyPort =
      Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0 ? Number(env.PAPERCUSP_MCP_PROXY_PORT) : 9071;
    if (pinnedUrl.port === String(proxyPort)) return null;
    const proxy = `http://127.0.0.1:${proxyPort}`;

    let refused = false;
    let pinAnsweredHealth = false;
    try {
      const health = await fetchImpl(`${pinned}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      pinAnsweredHealth = true;
      try {
        await health?.body?.cancel?.();
      } catch {
        /* a small health response is already sufficient */
      }
    } catch (err) {
      // undici reports a refused connect as TypeError('fetch failed') whose cause
      // carries the socket errno. A timeout surfaces as AbortError/TimeoutError and
      // is NOT refusal: the operator may simply be busy.
      const code = err?.cause?.code ?? err?.code;
      refused = code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
    }
    let mcpRouteMissing = false;
    if (!refused && pinAnsweredHealth) {
      try {
        // A stale launcher URL can point at a healthy HTTP service that is not
        // the operator. GET is side-effect free: a real Streamable HTTP endpoint
        // may answer 405 (or open its event stream), while a missing route is 404.
        const route = await fetchImpl(`${pinned}/api/mcp`, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        mcpRouteMissing = route?.status === 404;
        try {
          await route?.body?.cancel?.();
        } catch {
          /* releasing a probe stream must not alter the route verdict */
        }
      } catch (err) {
        const code = err?.cause?.code ?? err?.code;
        refused = code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
      }
    }
    if (!refused && !mcpRouteMissing) return null;

    try {
      const h = await fetchImpl(`${proxy}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!h?.ok) return null;
      try {
        await h.body?.cancel?.();
      } catch {
        /* a small health response is already sufficient */
      }
      const mcp = await fetchImpl(`${proxy}/api/mcp`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const proxyMcpRouteExists = mcp?.status !== 404;
      try {
        await mcp?.body?.cancel?.();
      } catch {
        /* releasing a probe stream must not alter the route verdict */
      }
      if (!proxyMcpRouteExists) return null;
    } catch {
      return null;
    }
    env.PAPERCUSP_OPERATOR_URL = proxy;
    // The new value is a launcher decision, not the caller's pin, so later wakes may
    // rediscover (psu-launcher.mjs OPERATOR_URL_PROVENANCE_ENV; a literal because the
    // host cannot import the launcher without an import cycle).
    env.PAPERCUSP_OPERATOR_URL_PROVENANCE = 'psu-launcher';
    return mcpRouteMissing
      ? { from: pinned, to: proxy, route: 'mcp-route-missing' }
      : { from: pinned, to: proxy };
  } catch {
    return null;
  }
}

/**
 * D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326): the process the pty
 * actually runs for the agent child.
 *
 * With no {@link AGENT_IDENTITY_SPEC_ENV} in the child env (desktop, dev — every launch that is
 * not a hosted workspace host) this is exactly `command args env`, unchanged. On a hosted host
 * the operator sets that spec: psu stays the service-user supervisor and only the agent CLI
 * crosses to the customer workspace account — staged over a non-TTY hop, then run under a
 * remote TTY (`ssh -tt`) so the TUI, ^C and window resizes behave as they do locally. The spec
 * env var itself never crosses (the stage's env allowlist excludes it). A staging failure throws
 * a NAMED refusal; there is deliberately no fall back to running the agent as the service user.
 *
 * @param {{command: string, args: string[], env: Record<string,string|undefined>, cwd?: string}} target
 * @param {{stage?: typeof stageAgentIdentityTty}} [deps]
 * @returns {{command: string, args: string[], env: Record<string,string|undefined>}}
 */
export function resolveAgentPtyTarget({ command, args, env, cwd }, deps = {}) {
  // The host can retain serving-host hints across an in-place loop respawn.
  // They identify the host, not its agent child: ptool would prefer either
  // hint over the operator URL explicitly handed to that child. Keep the host
  // environment untouched and sanitize on EVERY child spawn, including recycle.
  const childEnv = { ...env };
  if (childEnv.PAPERCUSP_OPERATOR_URL) {
    delete childEnv.PAPERCUSP_OPERATOR_BASE;
    delete childEnv.PAPERCUSP_HONO_PORT;
  }
  const rawSpec = childEnv[AGENT_IDENTITY_SPEC_ENV];
  if (!rawSpec) return { command, args, env: childEnv };
  const stage = deps.stage ?? stageAgentIdentityTty;
  const exec = stage(rawSpec, { command, args, env: childEnv, cwd });
  return { command: exec.command, args: [...exec.args], env: exec.env };
}

/**
 * Host `command args` through a managed pty, bridging the user's TTY and
 * exposing the control socket. Returns a Promise that resolves with the child's
 * exit code (the caller maps that to its own exit). The pty + socket live in
 * THIS process (D-006).
 *
 * @param {object} o
 * @param {string} o.command            binary to launch (the *-su wrapper / raw CLI)
 * @param {string[]} [o.args]           its args
 * @param {string} [o.cwd]              launch dir
 * @param {EnvironmentMap} [o.env]      child env (must carry PAPERCUSP_SID = ownerId)
 * @param {string} o.ownerId            coord ownerId (PAPERCUSP_SID) — the discovery key
 * @param {number|string} [o.advSessionId]  adv_sessions row id, when known
 * @param {{stdin?: any, stdout?: any}} [o.io] { stdin, stdout } override (tests); default process.*
 * @param {(code:number, killedBySignal:string|null)=>void} [o.onExit]  exit handler;
 *   default process.exit. `killedBySignal` is the signal NAME when the child was killed
 *   (WI-38054) and null on a voluntary exit — it is the only thing distinguishing the
 *   two, because node-pty reports a signal death with exitCode 0.
 * @param {()=>any} [o.onSpawn] lifecycle callback invoked immediately after
 *   the initial pty.spawn succeeds; this is concrete resume-finalization evidence.
 * @param {boolean} [o.bridgeTty]       force the TTY bridge on/off; default = stdin.isTTY
 * @param {string | null} [o.kickoff]   first-turn text for a scripted launch
 * @param {string} [o.kickoffFile]      server-owned session-port seed (never a CLI arg)
 * @param {{renderedHash?: string}} [o.sessionPort] { renderedHash } for the managed seed
 * @param {(proof:any)=>Promise<void>} [o.onKickoffPersisted] lifecycle acknowledgement
 * @param {{nativeId?:string|null}|null} [o.adoptedCarryRespawn] host-code adoption of a carry;
 *   its kickoff must prove the late native id and re-anchor before it announces completion
 * @param {object} [o.signalSource]      process-like on/off signal source (tests)
 * @param {((file:string, args:string[], options:object, realSpawn:(file:string, args:string[], options:object)=>any)=>any)|null} [o.spawnPty]
 *   pty spawn override (tests: inject a resume failure); null = the real pty.spawn
 * @param {()=>object} [o.reapScopeResidue] exact-session-cgroup cleanup (tests)
 * @param {string} [o.normalizedLogPath] optional headless grep-safe log path; normally
 *   supplied through {@link HEADLESS_NORMALIZED_LOG_ENV} in `o.env`
 * @param {(args:string[], options:{agent?:string, personaFile?:string|null})=>any} [o.mintRecycleArgs] mint argv for an ordinary recycle
 * @param {(args:string[], options:{systemPromptAddendum:string, ownerId:string, agent?:string, personaFile?:string|null, codexHome?:string})=>any} [o.mintCarryRespawnArgs] mint argv for a carry respawn
 * @param {(args:string[], options:{agent?:string})=>({args:string[], nativeId:string}|null)} [o.mintParkResumeArgs]
 *   mint the argv that resumes a parked child (null = not resumable, never park)
 * @param {()=>Promise<any>} [o.ensureCodexHome] repair the per-session Codex home before a carry mint
 * @param {()=>Promise<any>} [o.refreshPersonaFile] refresh the rendered persona before respawn
 * @param {(...args:any[])=>any} [o.onRespawn] lifecycle callback after a respawn
 * @param {((pid:number)=>string|null)|null} [o.resolveRespawnNativeId] startup native identity of the exact PTY child
 * @param {typeof fireSessionCompactedEvent} [o.emitCompacted] verified carry completion bridge (tests)
 * @param {((...args:any[])=>any) | null} [o.onReexec] handoff callback for host re-exec
 * @param {()=>any} [o.hostCodeStalenessFn] injectable loaded-vs-disk probe
 * @param {(env: EnvironmentMap)=>Promise<{from:string,to:string}|null>} [o.healOperatorPin]
 *   injectable dead-operator-pin heal, run before each in-place respawn
 * @param {()=>number} [o.parentPidFn] injectable parent-pid probe
 * @param {number} [o.activityPersistMs] discovery activity refresh interval
 * @param {number} [o.nativePersistenceTimeoutMs] managed kickoff persistence deadline
 * @param {(...args:any[])=>any} [o.mcpReconnectMacro] injectable carry MCP reconnect macro
 */
export function hostThroughPty(o) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    ownerId,
    advSessionId = null,
    // WI-1980: injected by the launcher so the host stays launcher-agnostic
    // (launcher imports host → importing back would cycle). `mintRecycleArgs`
    // rewrites the argv for a RECYCLE respawn (fresh --session-id); `onRespawn`
    // re-anchors that fresh native id → coord ownerId. Defaults keep the
    // standalone host + existing tests behavior-identical (same args, no anchor).
    mintRecycleArgs = (a) => ({ args: a, nativeId: null }),
    mintCarryRespawnArgs = (a) => mintRecycleArgs(a),
    // psu-process-free-parking-2026-10-06 P-017: the argv that resumes a PARKED
    // child as the same conversation (launcher: mintParkResumeArgs). The default
    // returns null, i.e. "not resumable", so a host the launcher did not wire
    // never parks.
    mintParkResumeArgs = () => null,
    // The launcher owns the authenticated operator repair route. Invoke it at
    // the carry boundary so an archived Codex home cannot make every successor
    // attempt fail before minting its AGENTS.md prompt.
    ensureCodexHome = async () => null,
    // stale-prompt-render-in-live-sessions-2026-08-02 P-002: re-render this
    // session's base persona from CURRENT prompt sources before a respawn mints the
    // successor's argv. Injected by the launcher (which owns the operator call) for
    // the same reason as the mints — the host must stay launcher-agnostic. The
    // default returns no file, which reproduces the pre-fix behaviour exactly: the
    // successor inherits the predecessor's rendered prompt.
    refreshPersonaFile = async () => ({
      promptFile: null,
      reason: "not-wired",
    }),
    onRespawn = () => {},
    resolveRespawnNativeId = null,
    emitCompacted = fireSessionCompactedEvent,
    // WI-38292: hand the session to a FRESH launcher process instead of respawning
    // the CLI child inside this stale one. Injected like the mints, and for a
    // second reason beyond launcher-agnosticism: only the launcher knows whether
    // anything will re-run it (the psu shim's re-exec loop advertises itself in
    // env) and only the launcher owns the supervisor beat it must stop first.
    // null ⇒ adoption is unavailable and every respawn takes the in-process path,
    // which is the pre-WI-38292 behaviour exactly.
    onReexec = null,
    // WI-38292: injectable staleness probe, same role as parentPidFn above. The
    // real one compares this module's load-time hash against the file on disk, so
    // a test running the module it is testing can NEVER observe staleness without
    // rewriting the shared checkout mid-run — which git-sync would sweep into a
    // commit. Injecting it is what makes the adopting path testable at all.
    hostCodeStalenessFn = hostCodeStaleness,
    // EI-24091823697677465: injectable dead-pin probe, run before each in-place
    // respawn. Injected so tests can drive the respawn without real sockets.
    healOperatorPin = healDeadOperatorPin,
    // WI-3141: injectable parent-pid probe for the orphan watchdog, so a test can
    // drive a fake reparent-to-init without a real fork. Defaults to the live ppid.
    parentPidFn = () => process.ppid,
    // WI-3455: injectable activity/self-heal tick period so tests can exercise
    // the discovery re-assert without waiting the real 15s cadence.
    activityPersistMs = ACTIVITY_PERSIST_MS,
    // agent-launch-resume-primitives P-011/D-008: the first-turn text to inject
    // once the child settles at its prompt. Set by the launcher for a SCRIPTED
    // resume/fork (the fresh-launch path seeds its kickoff as a CLI positional
    // instead). null ⇒ the session opens idle, exactly as before.
    kickoff = null,
    kickoffFile = null,
    sessionPort = null,
    adoptedCarryRespawn = null,
    onKickoffPersisted = async () => {},
    onSpawn = () => {},
    nativePersistenceTimeoutMs = Number(
      env.PAPERCUSP_SESSION_PORT_PERSIST_TIMEOUT_MS,
    ) || 30_000,
    mcpReconnectMacro = runMcpReconnectMacro,
    signalSource = process,
    reapScopeResidue = reapDetachedPtyScopeResidue,
    // psu-process-free-parking-2026-10-06 P-019: injectable pty spawn so a test
    // can make ONE resume fail (fork EAGAIN/ENOMEM is the realistic cause on a
    // box parking agents to free memory) and prove the delivery is held, not
    // lost. Receives the real spawn as its 4th argument. null = pty.spawn.
    spawnPty = null,
  } = o;
  if (kickoff && kickoffFile) throw new Error('plain kickoff and managed kickoff file are mutually exclusive');
  const managedKickoff = kickoffFile
    ? (() => {
        const read = readManagedKickoffFile(kickoffFile, sessionPort?.renderedHash);
        return { ...read, text: tagSessionPortTurn(read.text, ownerId, env) };
      })()
    : null;
  const nativeCaptureAfterMs = Date.now();
  const respawnReportTimeoutMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS,
    RESPAWN_REPORT_TIMEOUT_MS,
  );
  const configuredCarryProofRetryMax = Number(env.PAPERCUSP_PSU_PTY_CARRY_PROOF_RETRIES);
  const carryProofRetryMax = Number.isFinite(configuredCarryProofRetryMax) && configuredCarryProofRetryMax >= 0
    ? Math.floor(configuredCarryProofRetryMax)
    : CARRY_PROOF_RETRY_MAX;
  const publishKickoffProof = (proof) => {
    const result = publishKickoffProofReceipt(proof, env);
    if (!result.published && result.reason !== 'kickoff-proof-request-missing') {
      appendHostEvent(ownerId, 'kickoff-proof-receipt-publication-failed', {
        persisted: proof.persisted === true,
        reason: result.reason,
        errorMessage: result.errorMessage ?? null,
        errorCode: result.errorCode ?? null,
      });
    }
    return result;
  };
  let managedKickoffDisposition = null;
  const acknowledgeManagedKickoff = (proof) => {
    if (!managedKickoff) return Promise.resolve();
    if (!managedKickoffDisposition) {
      // First terminal outcome wins. Child exit and persistence verification can
      // race; sharing one promise prevents delivered→failed double transitions.
      managedKickoffDisposition = Promise.resolve().then(() => {
        // The detached parent consumes this receipt; the session-port HTTP ack
        // alone cannot prove delivery to it. Publish before that potentially slow
        // ack, under the same first-terminal guard as the child-exit failure.
        publishKickoffProof({
          persisted: proof.persisted === true,
          nativeRef: proof.persisted === true ? proof.nativeRef ?? null : null,
          reason: proof.persisted === true ? null : proof.error ?? 'session-port-kickoff-not-persisted',
        });
        return onKickoffPersisted(proof);
      });
    }
    return managedKickoffDisposition;
  };
  // WI-38292: the exit code that hands this session to a fresh launcher, or null
  // when nothing would re-run us. Read from `env` (the launch environment the
  // shim exported into), never assumed — see reexecExitCodeFrom.
  const reexecCode = reexecExitCodeFrom(env);
  const stdin = o.io?.stdin ?? process.stdin;
  const stdout = o.io?.stdout ?? process.stdout;
  const onExit = o.onExit ?? ((code) => process.exit(code ?? 0));
  const bridgeTty = o.bridgeTty ?? !!(stdin.isTTY && typeof stdin.setRawMode === 'function');
  /** P-006: ROUTINE defer diagnostics go through here, never bare stderr — see
   *  shouldWriteHostDiagnostic. Returns whether the line was actually written,
   *  so a caller can tell "suppressed" from "failed" if it ever needs to. */
  const writeHostDiagnostic = (text) => {
    if (!shouldWriteHostDiagnostic({ bridgeTty, env })) return false;
    try {
      process.stderr.write(text);
      return true;
    } catch {
      /* never let a diagnostic write break the session */
      return false;
    }
  };
  const normalizedLogPath =
    String(o.normalizedLogPath ?? env[HEADLESS_NORMALIZED_LOG_ENV] ?? '').trim() || null;
  const normalizedLog = normalizedLogPath
    ? createHeadlessNormalizedLogWriter(normalizedLogPath)
    : null;

  // Startup failures need the same durable log as failures after the child exists.
  ensureDir();
  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    appendHostEvent(ownerId, 'pty-load-failed', hostErrorEvidence(e));
    process.stderr.write(
      `psu: failed to load @lydell/node-pty (${e.message}); falling back to a plain launch is the caller's job.\n`,
    );
    throw e;
  }

  pruneDead();
  const sock = socketPathFor(ownerId);
  const metaPath = metaPathFor(ownerId);
  // A stale socket from a crashed prior session of the SAME owner would block
  // bind; remove it (pruneDead already cleared dead ones, but be defensive).
  // managed-carry-lifecycle-enforcement P-003: fail CLOSED when the prior key
  // holder is still a live identity-verified psu host. The old warning+takeover
  // path unlinked the first host's socket, spawned a second child, and let both
  // hosts continue with independent retry/dedup state. A delayed teardown from
  // either could then strand or kill the apparent successor. Refuse before the
  // socket unlink and before pty.spawn; the original host stays injectable.
  const priorMeta = readDiscoveryMeta(ownerId);
  const hostAdmission = duplicateHostAdmission(ownerId, priorMeta);
  if (!hostAdmission.admitted) {
    appendHostEvent(ownerId, 'duplicate-host-startup-refused', { holderPid: hostAdmission.pid ?? null });
    throw new Error(
      `psu-pty-host: refusing duplicate startup for ${ownerId} — live psu host pid ` +
        `${hostAdmission.pid} already owns this logical session; its socket and child were left intact`,
    );
  }
  for (const p of [sock]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  const ptyName = env.TERM || process.env.TERM || 'xterm-256color';
  // WI-3278: the WSL console bridge can report a BOGUS terminal size (131072x1
  // seen live on the Windows VM) — a 1-row pty makes the claude TUI misbehave
  // (fullscreen-switch re-exec). Out-of-range dims fall back to the default.
  const sanePtyDim = (v, fallback, max) =>
    Number.isFinite(v) && v >= 2 && v <= max ? v : fallback;
  /** Spawn the child agent under a fresh pty in THIS host. Reused on RECYCLE
   *  (su-cold-auto-mode P-004b): same command/args/cwd/env means PAPERCUSP_SID,
   *  locks, hooks, and the control socket all survive — only the process is new.
   *  Reads the CURRENT terminal size each spawn. */
  // The argv the LIVE child was spawned with. `args` stays the original launch
  // argv (every respawn mints from it), so it cannot say whether the current
  // child carries a persona flag; coldResetModeForAgent needs exactly that.
  let liveChildArgs = args;
  // WI-10005178: the child's PTY size, so its cursor-positioned output can be
  // replayed onto the same grid (renderTerminalScreen). onResize keeps the child
  // at these dims too.
  const childScreenDims = () => ({
    cols: sanePtyDim(stdout.columns, 80, 1000),
    rows: sanePtyDim(stdout.rows, 24, 500),
  });
  const spawnChild = (spawnArgs = args) => {
    const target = resolveAgentPtyTarget({ command, args: spawnArgs, env, cwd });
    const ptyOptions = {
      name: ptyName,
      ...childScreenDims(),
      cwd,
      env: target.env,
    };
    const realSpawn = (file, argv, options) => pty.spawn(file, argv, options);
    const spawned = spawnPty
      ? spawnPty(target.command, target.args, ptyOptions, realSpawn)
      : realSpawn(target.command, target.args, ptyOptions);
    // Only a child that actually started owns the live argv: a failed spawn
    // must not rewrite what the next park/recycle mint reads.
    liveChildArgs = spawnArgs;
    return spawned;
  };
  let child;
  try {
    child = spawnChild();
  } catch (e) {
    appendHostEvent(ownerId, 'pty-spawn-failed', { command, ...hostErrorEvidence(e) });
    process.stderr.write(`psu: failed to spawn '${command}' under a pty: ${e.message}\n`);
    throw e;
  }
  if (adoptedCarryRespawn) {
    appendHostEvent(ownerId, 'host-code-adoption-child-started', {
      mode: 'carry-respawn',
      nativeId: adoptedCarryRespawn.nativeId ?? null,
      agent: env.PAPERCUSP_AGENT ?? null,
      kickoffPresent: typeof kickoff === 'string' && kickoff.length > 0,
      kickoffBytes: typeof kickoff === 'string' ? Buffer.byteLength(kickoff, 'utf8') : 0,
      argsCount: Array.isArray(liveChildArgs) ? liveChildArgs.length : null,
      kickoffFilePresent: Boolean(kickoffFile),
      childPid: Number.isInteger(child.pid) ? child.pid : null,
    });
  }
  let stopStartupTrace = startCodexStartupProcessTrace({
    agent: env.PAPERCUSP_AGENT, ownerId, pid: child.pid,
  });
  try {
    const acknowledgement = onSpawn();
    void Promise.resolve(acknowledgement).catch((error) => {
      appendHostEvent(ownerId, 'resume-finalization-report-failed', hostErrorEvidence(error));
      process.stderr.write(
        `psu: child spawned under pty, but its resume finalization report failed: ${error?.message ?? error}\n`,
      );
    });
  } catch (error) {
    appendHostEvent(ownerId, 'resume-finalization-callback-failed', hostErrorEvidence(error));
    process.stderr.write(
      `psu: child spawned under pty, but its resume finalization callback failed: ${error?.message ?? error}\n`,
    );
  }
  // RECYCLE state (su-cold-auto-mode P-004b). `recycling` guards the child-exit
  // handler so an intended kill+respawn does NOT tear the host down. The three
  // fns are (re)assigned below — declared here so the control-socket handler
  // (created before the teardown Promise) can close over them; they stay no-ops
  // until assigned, and a recycle cannot arrive before the socket is listening.
  let recycling = false;
  // WI-6638 SHUTDOWN state: set once a shutdown is accepted, so a duplicate/retried
  // request is an idempotent ok instead of a second kill. Unlike `recycling` this is
  // terminal — nothing clears it, because the host is on its way out.
  let shuttingDown = false;
  // WI-10004943 (d): set by cleanup() once the host has torn down, so a kickoff
  // HELD for a Codex frame (minutes) stops waiting instead of polling a dead host.
  let hostCleanedUp = false;
  // EI-18665672258948707: the moment (Date.now()) THIS host last successfully
  // spawned a fresh child via recycleChild — the supersession clock a queued
  // carry-respawn is checked against right before delivery (isCarryRespawnSuperseded).
  // 0 = never respawned yet, so nothing can be superseded.
  let lastRespawnAtMs = 0;
  let wireChildData = () => {};
  let wireChildExit = () => {};
  let recycleChild = async () => {};
  // WI-41044: submit verification is created per injected turn, but exhaustion
  // is terminal for this host. Keep the guard at host scope so a detached
  // verifier cannot let later injections create another unbounded CR window.
  let submitVerifyExhausted = false;
  let terminateSubmitVerifyExhaustion = () => false;

  // Output taps (mcp-transport-resilience P-003): live subscribers to the
  // child's raw output bytes — the mcp-reconnect macro reads the TUI screen
  // through one. Fed by wireChildData below (so a tap survives a RECYCLE's
  // re-wire); a tap's lifetime is its caller's (add → close), and a throwing
  // tap can never break the stdout bridge.
  const outputTaps = new Set();
  const makeOutputTap = (capBytes = 65_536) => {
    let buf = '';
    const fn = (d) => {
      buf += d;
      if (buf.length > capBytes) buf = buf.slice(-(capBytes >> 1));
    };
    outputTaps.add(fn);
    return {
      read: () => buf,
      reset: () => {
        buf = '';
      },
      close: () => outputTaps.delete(fn),
    };
  };

  // P-006: activity annotation rides the SAME discovery file — additive
  // fields only (the read-side contract in operator-core psu-pty-discovery.ts
  // tolerates their absence for files written by older hosts).
  const activity = makeActivityTracker();
  // Only actual owner input advances this epoch; terminal capability replies
  // cannot invalidate an untouched successor's first-prompt readiness.
  let ownerInputGeneration = 0;
  // WI-1386682 (1): quota-wall detector, fed the same raw bytes as `activity`
  // (wireChildData below). A stable object with its own reset() — unlike
  // childStartupOutput/childStartupReady this is not reassigned per recycle,
  // just reset in place at the same recycle site.
  // WI-2140984: scoped to THIS child's agent — the banner patterns are
  // per-product, and matching claude's copy against a codex pty read healthy
  // members as permanently walled.
  const quotaBlockDetector = makeQuotaBlockDetector({
    agent: env.PAPERCUSP_AGENT,
    // EI-22609012864215464 / EI-22800121604015331: both native resume and
    // fork repaint the source transcript's old quota errors. Do not block the
    // first new submission on that replay; subsequent errors still block wakes.
    deferUntilSubmit: env.PAPERCUSP_AGENT === 'codex' &&
      args.some((arg) => arg === 'resume' || arg === 'fork'),
    // WI-10003875: claude's banner set is bare phrases, so the model's own
    // prose can latch it on a static idle screen and defer every wake until a
    // human types. Corroborate against this owner's isolated transcript: a
    // rate_limit API-error row keeps the wall, the matched words appearing as
    // ordinary transcript content dismisses it, anything else fails closed.
    corroborate: ['', 'claude'].includes(String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase())
      ? makeClaudeQuotaCorroborator(env)
      : null,
    onDismiss: (dismissed) =>
      appendHostEvent(ownerId, 'quota-block-dismissed-transcript-echo', {
        agent: String(env.PAPERCUSP_AGENT ?? '') || null,
        matchedPattern: dismissed.pattern,
        matchedExcerpt: dismissed.excerpt,
        blockedSinceMs: dismissed.blockedSinceMs,
      }),
  });
  // The interactive Codex CLI remains under the owner's control. Classify its
  // transient capacity copy for the durable event stream without retrying or
  // substituting models behind the owner's back.
  const modelCapacityDetector =
    String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex'
      ? makeModelCapacityDetector()
      : null;
  const quotaBlockStarvationGuard = makeQuotaBlockStarvationGuard({
    thresholdMs: positiveNumber(
      env.PAPERCUSP_PSU_PTY_QUOTA_STARVATION_MS,
      QUOTA_BLOCK_STARVATION_THRESHOLD_MS,
    ),
    onStarvation: (signal) => {
      const extra = {
        ...signal,
        agent: String(env.PAPERCUSP_AGENT ?? '') || null,
      };
      appendHostEvent(ownerId, 'quota-block-starvation', extra);
      try {
        process.stderr.write(
          `psu-pty-host: QUOTA BLOCK STARVATION for ${ownerId} — ` +
            `${signal.ageMs}ms blocked with ${signal.attemptedGatedInjections} gated ` +
            `injection attempt(s) and zero successful deliveries; health signal recorded\n`,
        );
      } catch {
        /* diagnostics must never break delivery */
      }
    },
  });
  const observeQuotaBlockStarvation = (gatedInjection = null) => {
    const snapshot = quotaBlockDetector.snapshot();
    return quotaBlockStarvationGuard.observe({
      quotaBlocked: snapshot.quotaBlocked,
      observedBlockedSinceMs: snapshot.quotaBlockedSinceMs,
      gatedInjection,
    });
  };
  // Output-quiet alone is not a startup-ready signal: before a backend-owned
  // marker, terminal probes can read as "quiet at prompt" even though a slow
  // TUI has not installed its editor yet (live Codex/OMP ports WI-4943/WI-4947).
  // Reset on recycle.
  let childStartupOutput = '';
  let childStartupReady = false;
  let childPromptReady = false;
  // A first composer can appear before Codex's delayed model offer. Keep the
  // per-child choice watcher until a real turn is submitted, not merely until
  // the first ready frame is painted.
  let activeHeadlessCodexModelChoice = null;
  // WI-10005472: the current child's onboarding watcher, so the kickoff gate can
  // tell "composer not seen YET" from "composer never seen in the whole window".
  let activeHeadlessClaudeOnboarding = null;
  let childStartupFirstOutputAt = 0;
  // EI-24141825238362808: the child's own bracketed-paste mode, tracked over ALL
  // output (not only startup) so turn text is framed only while the TUI has it on.
  let childBracketedPaste = false;
  let childBracketedPasteTail = '';
  // WI-10002745: when the backend TUI itself started (Codex: its first
  // capability probe), as distinct from the psu launcher's banner above, and
  // when it painted its first frame after that probe. Only the frame proves
  // Codex has stopped swallowing stdin; the fallback is measured from it.
  let childBackendTuiStartedAt = 0;
  let childBackendFirstFrameAt = 0;
  const childStartupFallbackElapsed = () =>
    startupFallbackElapsed({
      agent: env.PAPERCUSP_AGENT,
      nowMs: Date.now(),
      firstOutputAt: childStartupFirstOutputAt,
      backendTuiStartedAt: childBackendTuiStartedAt,
      backendFirstFrameAt: childBackendFirstFrameAt,
      fallbackMs: startupMarkerFallbackMs,
    });
  let headlessClaudeOnboardingExpiryTimer = null;
  // A scripted resume/fork kickoff is the only path that can encounter Claude's
  // interactive "Autocompact is thrashing" recovery menu. Keep this detector
  // alive before wireChildData() attaches the first listener so the menu cannot
  // win a race against injectTurnAtPrompt(). Fresh launches seed their first
  // turn as a CLI positional argument and do not pass through this gate.
  const launchKickoff = managedKickoff?.text ?? kickoff;
  const claudeResumeCompactionEnabled =
    Boolean(launchKickoff) && String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'claude';
  const claudeResumeCompaction = makeClaudeResumeCompactionRecoveryStateMachine({
    enabled: claudeResumeCompactionEnabled,
    startupMs: claudeResumeCompactionStartupMs(env),
    recoveryMs: claudeResumeCompactionRecoveryMs(env),
  });
  let claudeResumeCompactionTimeoutReported = false;
  const reportClaudeResumeCompactionTimeout = () => {
    if (claudeResumeCompactionTimeoutReported) return;
    claudeResumeCompactionTimeoutReported = true;
    appendHostEvent(ownerId, 'claude-resume-compaction-timed-out', {
      recoveryMs: claudeResumeCompactionRecoveryMs(env),
    });
    try {
      process.stderr.write(
        `psu-pty-host: Claude resume compaction recovery timed out for ${ownerId}; ` +
          `the scripted kickoff will be dropped rather than written into an unresolved menu.\n`,
      );
    } catch {
      /* diagnostics are best-effort */
    }
  };
  const baseMeta = {
    ownerId,
    advSessionId: advSessionId != null ? String(advSessionId) : null,
    pid: process.pid,
    ptyPid: child.pid,
    terminalPid: terminalPidFromEnv(env.PAPERCUSP_TERMINAL_PID),
    sock,
    command,
    args,
    startedAt: Date.now(),
    // Interactive-vs-headless advertisement (deterministic-context-carry P-021;
    // ADDITIVE — absent on files written by older hosts). `bridgeTty:false` = a
    // headless/piped host (no human TTY bridged) — the only value that classifies
    // the session 'claude-headless'; absent/true fail-soft to 'claude-interactive'
    // (psu-pty-discovery.sessionClassForHost) — the SAFE direction, since the
    // interactive class additionally requires the no-recent-human-input guard
    // before any cold-by-default wake.
    bridgeTty,
    // Control-socket capabilities beyond the v1 base set (WI-1804). The operator reads
    // this (psu-pty-discovery.hostSupports) to decide whether to send mode:'compact'
    // (post-compaction auto-continuation) or fall back to a plain /compact turn on an
    // older host that has no `caps` field. Additive — grow this as new modes land.
    // 'mcp-reconnect' (P-003, 2026-07-13): the in-place /mcp dialog heal; an old
    // host without it makes the watchdog fall back to notify-only.
    // P-022: 'compact' is no longer advertised — a pre-cutover sender that
    // caps-gates on hostSupports(host, 'compact') now skips cleanly instead of
    // sending a message the handler will loudly drop.
    // 'shutdown' (WI-6638): wind down + exit, closing this session's terminal tab.
    // 'quota-recovery' (measured-agent-productivity P-004): the operator may
    // convert one durable, headless account:auto wake into the existing recycle
    // path and then verify pickup by delivery id. Older hosts lack the cap and
    // therefore retain the old defer-only behavior.
    caps: ['carry-respawn', 'mcp-reconnect', 'shutdown', 'quota-recovery'],
    // WI-6638: WHO launched this session — `injectLaunchedByArg` (agent-launch-core)
    // stamps `--launched-by=<caller ownerId>` onto every tool-driven psu launch, and
    // bootstrap-su re-exports it as PAPERCUSP_LAUNCHED_BY. An owner-typed `psu` never
    // carries one, which is what makes this a STRUCTURAL agent-vs-human discriminator
    // rather than a heuristic. Advertised so a would-be shutdown requester can see the
    // verdict BEFORE sending (the host re-checks it authoritatively either way).
    // ADDITIVE — absent on files written by older hosts; consumers must fail-soft to
    // "human-launched" (the refusing direction).
    launchedBy: String(env.PAPERCUSP_LAUNCHED_BY || '').trim() || null,
    // WI-38292: WHICH psu-pty-host BUILD this live host is running — the sha256 of
    // the module source as loaded, frozen at import. A carry-respawn replaces only
    // the CLI child, so a host that booted before a fix keeps executing the old code
    // indefinitely; without this field there is no way to ask a RUNNING session
    // whether it carries a given fix, and a correctly-shipped fix looks broken
    // instead of merely un-adopted. Advertised here because discovery is already the
    // host's public record, so every reader gets the answer without a new channel.
    // ADDITIVE — absent on files written by older hosts; consumers must fail-soft to
    // "unknown version", never to "up to date".
    hostCodeVersion: LOADED_HOST_CODE_VERSION,
  };
  const writeMeta = () => {
    try {
      // WI-3455: ATOMIC (tmp + rename). A plain in-place writeFileSync gives a
      // reader a window on a truncated/partial document — and the operator-side
      // janitor (pruneDeadDiscoveryFiles) DELETES a file it reads as corrupt,
      // i.e. a lost race here used to cost a LIVE host its discovery key.
      // rename(2) on the same fs is atomic, so readers only ever see a complete
      // json. The tmp name is pid-scoped so two hosts racing the same key never
      // corrupt each other's staging file.
      const tmp = `${metaPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...baseMeta, ...activity.snapshot(), ...quotaBlockDetector.snapshot() }));
      renameSync(tmp, metaPath);
    } catch {
      /* best-effort — discovery degrades to the base contract */
    }
  };
  writeMeta();
  // Fleet color at launch (fleet-color-schemes): if bootstrap-su bound this
  // session to a fleet (PAPERCUSP_FLEET_BG/FG/CURSOR from the fleet's scheme),
  // recolor THIS window now by writing the OSC straight to our stdout (= the
  // visible terminal), so the window opens in the fleet color instead of the
  // gnome profile default. No fleet ⇒ no write (profile default stands). The
  // runtime fleet:join path reuses the same bytes via the 'osc' control mode.
  const launchOsc = fleetOscFromEnv(env);
  if (launchOsc) {
    try {
      stdout.write(launchOsc);
    } catch {
      /* best-effort — a recolor must never break the session */
    }
  }
  let lastPersisted = 0;
  // WI-3455 SELF-HEAL: the discovery key (json + sock) can be deleted out from
  // under a LIVE host — a duplicate same-owner host's boot/exit, the operator
  // janitor pruning a file it mis-read mid-write, a manual rm. Instead of
  // guarding every possible deleter, each tick re-asserts the invariant "a live
  // host is discoverable": if the json no longer records THIS pid (missing /
  // corrupt / pointing at a DEAD or non-psu pid) rewrite it; if the sock path
  // vanished from disk (we'd still be listening on the unlinked inode —
  // unreachable) re-bind it. ONE exception prevents key flapping: when the json
  // points at a DIFFERENT pid that is a genuinely LIVE psu host, that newer
  // host owns the key — stand down (persist nothing) until it dies, then
  // reclaim. Returns whether WE currently own the key, which also gates the
  // ordinary activity persist below (pre-WI-3455 an old host's activity write
  // would silently trample a live successor's registration).
  let rebindControlSocket = () => {}; // assigned after the server exists below
  let lastHealNoticeAt = 0;
  const selfHealTick = () => {
    const m = readDiscoveryMeta(ownerId);
    if (m && m.pid && m.pid !== process.pid && pidAlive(m.pid) && pidLooksLikePsuHost(m.pid)) {
      return false; // a newer LIVE host owns the key — stand down, don't fight
    }
    const metaMine = !!(m && m.pid === process.pid);
    const sockOnDisk = existsSync(sock);
    if (metaMine && sockOnDisk) return true;
    writeMeta();
    if (!sockOnDisk) rebindControlSocket();
    const now = Date.now();
    if (now - lastHealNoticeAt > 60_000) {
      lastHealNoticeAt = now;
      appendHostEvent(ownerId, 'discovery-reasserted', {
        metadataRewritten: !metaMine,
        socketRebound: !sockOnDisk,
      });
      try {
        process.stderr.write(
          `psu-pty-host: discovery re-asserted for ${ownerId} ` +
            `(json ${metaMine ? 'ok' : 'rewritten'}, sock ${sockOnDisk ? 'ok' : 'rebound'}) — ` +
            `it was removed while this host was live\n`,
        );
      } catch {
        /* never let a diagnostic write break the host */
      }
    }
    return true;
  };
  // psu-process-free-parking-2026-10-06 P-017: the park policy rides this
  // existing tick (D-002: no new timer). Assigned once the park machinery below
  // exists; a no-op until then.
  let parkTick = () => {};
  const activityTimer = setInterval(() => {
    let ownKey = true;
    try {
      ownKey = selfHealTick();
    } catch {
      /* self-heal is best-effort — never break the activity persist */
    }
    const snap = activity.snapshot();
    if (ownKey && (snap.lastActivityAt ?? 0) > lastPersisted) {
      lastPersisted = snap.lastActivityAt ?? 0;
      writeMeta();
    }
    try {
      parkTick();
    } catch {
      /* a park decision must never break the activity persist */
    }
  }, activityPersistMs);
  if (typeof activityTimer.unref === 'function') activityTimer.unref();

  const idleGate = makeIdleGate();
  // A quiet terminal line can still contain unsubmitted owner text. Keep that
  // state separate from the mid-keystroke clock so a wake never appends its
  // provenance envelope to a staged human line.
  const ownerComposerGate = makeOwnerComposerGate({
    capMs: positiveNumber(env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS, DEFAULT_IDLE_WAIT_CAP_MS),
  });
  // Separate scanner over the SAME stdin stream (WI-38156). It must be fed every
  // chunk unconditionally — including while a machine turn queues owner input —
  // so its escape state machine stays in step with the real byte stream; a
  // classifier that misses chunks mis-reads the tail of a split reply as text.
  const ownerInputDetector = makeOwnerInputDetector();
  const freshChildOwnerInterruptionDetector = makeFreshChildOwnerInterruptionDetector();

  const wedgeDetector = makeComposerWedgeDetector({
    minDefers: positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_MIN_DEFERS, 3),
    minQuietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_QUIET_MS, 5 * 60_000),
  });
  const noteOwnerInputDefer = (pendingLength) => {
    const wedge = wedgeDetector.note({
      pendingLength,
      ownerQuietMs: ownerComposerGate.ownerQuietMs(),
      pendingAgeMs: ownerComposerGate.pendingAgeMs(),
    });
    if (!wedge) return;
    appendHostEvent(ownerId, 'owner-composer-wedge-suspected', wedge);
    try {
      process.stderr.write(
        `psu-pty-host: COMPOSER WEDGE SUSPECTED for ${ownerId} — ${wedge.consecutiveDefers} consecutive ` +
          `wake deferrals against an unchanged ${pendingLength}-char staged line, ` +
          `${
            wedge.ownerBytesEverSeen
              ? `idle ${Math.round(wedge.ownerQuietMs / 1000)}s`
              : 'and NO owner keystroke has ever been seen here'
          }. ` +
          `This agent is NOT receiving wakes. If nobody is typing in this window it is a phantom ` +
          `staged line (WI-38156) — press Ctrl-U here to clear it.\n`,
      );
    } catch {
      /* diagnostic only */
    }
  };
  // WI-38257: the ACTUATOR the wedge detector never had. Thresholds are
  // env-tunable because the right value is a property of the deployment, not of
  // the code: an attended desktop wants a longer grace than a headless fleet
  // member nobody is typing into.
  const wedgeBreakAgeMs = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_MS, 90_000);
  const wedgeBreakQuietMs = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_QUIET_MS, 90_000);
  // EI-20287339148365013: the clock-free backstop. Bounds the damage in the
  // unit that actually hurts — wakes thrown away — so it still fires on a host
  // where the timing measurements are absent or are being reset by a repeating
  // machine emitter, which is how ten hosts stayed wedged for up to 259 minutes.
  const wedgeBreakMaxDefers = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_MAX_DEFERS, 5);
  /**
   * Clear a staged line that has stopped tracking a person, so a gated write can
   * proceed instead of deferring forever. Returns true when it cleared one.
   *
   * Ctrl-U goes to the CHILD (the TUI owns the composer), and our own model is
   * then resynced explicitly: the gate observes the OWNER's stdin, so it would
   * never see a clear the host itself performed and would go on reporting the
   * line as pending forever — re-wedging on the state we just fixed.
   */
  const breakComposerWedgeIfConfirmed = () => {
    const pendingLength = ownerComposerGate.pendingLength();
    const pendingAgeMs = ownerComposerGate.pendingAgeMs();
    const ownerQuietMs = ownerComposerGate.ownerQuietMs();
    const consecutiveDefers = wedgeDetector.consecutiveDefers();
    if (
      !shouldBreakComposerWedge(
        { pending: ownerComposerGate.hasPending(), pendingAgeMs, ownerQuietMs, consecutiveDefers },
        {
          minAgeMs: wedgeBreakAgeMs,
          minQuietMs: wedgeBreakQuietMs,
          maxDefers: wedgeBreakMaxDefers,
        },
      )
    ) {
      return false;
    }
    // Which rule fired is the first question asked of a break in the field, and
    // reconstructing it later from thresholds and timings is exactly the archaeology
    // whose absence made the original episode undiagnosable. Record it.
    const brokenBy = consecutiveDefers >= wedgeBreakMaxDefers ? 'wake-loss' : 'idle-timing';
    try {
      // \u0015 = Ctrl-U (kill line). Written as an ESCAPE on purpose: a literal
      // control byte here is invisible in review and is exactly what a patch, an
      // editor or a copy-paste silently drops. If it ever degraded to an empty
      // write, markSubmitted() below would still clear our MODEL while the real
      // composer kept its text — so the next injected turn would append to owner
      // text, which is the precise corruption this gate exists to prevent,
      // reintroduced by the code meant to fix it.
      child?.write('\u0015');
    } catch {
      /* the child may have exited under us; the resync below still applies */
    }
    ownerComposerGate.markSubmitted();
    appendHostEvent(ownerId, 'owner-composer-wedge-cleared', {
      pendingLength,
      pendingAgeMs,
      ownerQuietMs: ownerQuietMs === Infinity ? null : ownerQuietMs,
      ownerBytesEverSeen: ownerQuietMs !== Infinity,
      brokenBy,
      consecutiveDefers,
    });
    try {
      process.stderr.write(
        `psu-pty-host: COMPOSER WEDGE CLEARED for ${ownerId} — discarded a ${pendingLength}-char staged ` +
          (brokenBy === 'wake-loss'
            ? `line after ${consecutiveDefers} consecutive wakes were thrown away against it. `
            : `line unchanged for ${Math.round(pendingAgeMs / 1000)}s with no owner keystroke for ` +
              `${ownerQuietMs === Infinity ? 'the whole session' : `${Math.round(ownerQuietMs / 1000)}s`}. `) +
          `It was blocking EVERY wake. If that text was yours, retype it — this agent was dead until now.\n`,
      );
    } catch {
      /* diagnostic only */
    }
    return true;
  };
  let machineTurnActive = false;
  // Latest owner-visible machine submit into THIS child. The ordinary Codex
  // native-boundary probe rejects any older task_complete record, preventing a
  // previous turn from certifying a new turn that has only just been submitted.
  let lastMachineTurnSubmittedAtMs = 0;
  // WI-10004943: when the first machine turn write into THIS child STARTED.
  // backend-session-frame-observed reports the gap to it, which separates a
  // Codex that became ready on its own (frame long after any write, or before
  // one) from a frame that the typed input itself provoked (frame within
  // moments of a write made while the footer still read `Starting`).
  let lastMachineTurnWriteStartedAtMs = 0;
  // WI-10004943: what the host could see at the instant a machine turn began
  // writing. Without it, a turn that lands after a 20-minute `Starting` footer
  // cannot tell "the write waited for readiness" from "the write caused it":
  // the deciding facts are computed here and were previously discarded.
  const turnWriteContext = (writeStartedAt) => {
    const context = {
      writeStartedAt: new Date(writeStartedAt).toISOString(),
      msSinceBackendFirstFrame: childBackendFirstFrameAt > 0
        ? writeStartedAt - childBackendFirstFrameAt
        : null,
    };
    if (String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex') {
      context.codexFooterAtWrite = codexFooterStateFromOutput(childStartupOutput, childScreenDims());
    }
    return context;
  };
  let queuedOwnerInput = [];
  // Mid-turn inject gate (coord-wake-mid-turn-2026-06-30): reads the SAME
  // lastOutputAt the activity tracker records on every `child.onData` below, so a
  // wake `turn` is held until the agent is back at its prompt (output quiescent)
  // — never written into a live, mid-turn TUI (which wedges it, needs ESC). The
  // windows are read from the SESSION env (per-call, like turnSubmitCrDelayForAgent)
  // with the module-level defaults as fallback, so a launch can tune them.
  const turnInjectBusyCapMs = positiveNumber(env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS, TURN_INJECT_BUSY_CAP_MS);
  const agentBusyGate = makeAgentBusyGate({
    lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
    quietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS, OUTPUT_QUIET_MS),
    capMs: turnInjectBusyCapMs,
  });
  // WI-1941: recycle carry-inject retry budget + backoff (per-session tunable,
  // like the busy cap above). The fresh cold child gets this long to reach its
  // prompt across retried waitAtPrompt() attempts before the carry is dropped.
  const recycleCarryInjectBudgetMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS,
    RECYCLE_CARRY_INJECT_BUDGET_MS,
  );
  const recycleCarryRetryBackoffMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS,
    RECYCLE_CARRY_RETRY_BACKOFF_MS,
  );
  const startupMarkerFallbackMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS,
    STARTUP_MARKER_FALLBACK_MS,
  );

  // Claude may pause at an interactive resume-choice menu after it has already
  // emitted ordinary startup bytes. This gate is deliberately separate from the
  // output-quiet busy gate: a quiet menu is not a composer prompt. It returns
  // immediately for non-Claude/non-scripted launches and for ordinary resumes
  // whose bounded detection window expires without the menu.
  const waitForClaudeResumeCompaction = async (deadline) => {
    if (!claudeResumeCompactionEnabled) return { ready: true };
    while (true) {
      const state = claudeResumeCompaction.tick();
      if (state.timedOut) {
        reportClaudeResumeCompactionTimeout();
        return { ready: false, reason: 'resume-compaction-timeout' };
      }
      if (!claudeResumeCompaction.isAwaitingPrompt()) return { ready: true };
      if (Date.now() >= deadline) {
        reportClaudeResumeCompactionTimeout();
        return { ready: false, reason: 'resume-compaction-timeout' };
      }
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  };

  // WI-2930: verify every injected submit actually started a turn — resubmit a
  // bare CR at each quiet observation in a bounded post-submit window (see
  // makeSubmitVerifier). writeCr reads the live `child` closure so it survives a
  // recycle; a fresh verifier per call keeps the human-input abort baseline fresh.
  const verifySubmitted = async (
    label,
    // WI-1378748: default by LABEL, not a blanket `true` — a wake inject
    // (turn/reset) must never be host-fatal. See submitExhaustionTerminatesHost.
    {
      terminateOnExhaustion = submitExhaustionTerminatesHost(label),
      text = '',
      submittedAtMs = Date.now(),
      // WI-10004943: turnWriteContext() captured when the write STARTED.
      writeContext = null,
    } = {},
  ) => {
    const marker = leadingTurnOriginMarker(text);
    const nativeProofAvailable = Boolean(marker) &&
      nativeTurnVerifierSupport(env.PAPERCUSP_AGENT, env).supported;
    const verifier = makeSubmitVerifier({
      lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
      lastInputAt: () => activity.snapshot().lastInputAt ?? 0,
      isQuotaBlocked: () => quotaBlockDetector.isBlocked(),
      isSubmitted: () => nativeProofAvailable && Boolean(findNativeTranscriptMarker({
        agent: env.PAPERCUSP_AGENT,
        env,
        marker,
        sinceMs: submittedAtMs,
      })),
      writeCr: () => child.write('\r'),
      // WI-2975: NOT OUTPUT_QUIET_MS (that's the busy-gate's short "back at an
      // idle prompt" threshold) — the verifier's own, deliberately-larger quiet
      // bar, so an ordinary post-submit thinking/latency gap is never mistaken
      // for a swallowed CR. See SUBMIT_VERIFY_QUIET_MS above.
      quietMs: submitVerifyQuietMs(env),
      pollMs: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS, SUBMIT_VERIFY_POLL_MS),
      polls: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS, SUBMIT_VERIFY_POLLS),
      maxResubmits: positiveNumber(
        env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR,
        SUBMIT_VERIFY_MAX_RESUBMITS,
      ),
      onResubmit: (n) => {
        // A retry is not a terminal failure. Its eventual result is persisted
        // as turn-delivered or submit-verify-unconfirmed; painting each retry
        // into an interactive agent's TUI made normal recovery look like a new
        // error and could interfere with the composer being verified.
        writeHostDiagnostic(
          `psu-pty-host: ${label} submit not confirmed for ${ownerId} — resubmit CR #${n} (WI-2930)\n`,
        );
      },
      // A managed session-port kickoff has a stronger, independent proof:
      // waitForNativeTranscriptMarker below. Its target can persist the marker
      // after the TUI goes quiet, so WI-41044's generic host teardown would race
      // the authoritative native-persistence acknowledgement. Startup submits
      // otherwise retain the host-fatal exhaustion behavior; WAKE injects never
      // do (WI-1378748).
      onExhausted: ({ polls, resubmits, outputObservedAfterResubmit }) => {
        const details = {
          label,
          polls,
          resubmits,
          maxResubmits: positiveNumber(
            env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR,
            SUBMIT_VERIFY_MAX_RESUBMITS,
          ),
          outputObservedAfterResubmit,
        };
        if (terminateOnExhaustion && !quotaBlockDetector.isBlocked()) {
          terminateSubmitVerifyExhaustion(details);
          return;
        }
        // WI-1378748: NOT fatal — but never silent either. Trading a loud kill
        // for a silent drop would just swap one invisible failure for another,
        // so the undelivered wake is recorded on the same event log the kill
        // used to write, and says plainly that the session was left running.
        appendHostEvent(ownerId, 'submit-verify-unconfirmed', {
          ...details,
          reason: 'max-resubmits-without-output',
          terminated: false,
        });
        try {
          process.stderr.write(
            `psu-pty-host: ${label} submit unconfirmed for ${ownerId} after ` +
              `${resubmits} resubmit CRs — wake not delivered, session left running (WI-1378748)\n`,
          );
        } catch {
          /* diagnostic only */
        }
      },
    });
    const result = await verifier.verify();
    if (result.aborted === 'quota-blocked') {
      appendHostEvent(ownerId, 'submit-verify-unconfirmed', {
        label,
        polls: result.polls,
        resubmits: result.resubmits,
        reason: 'quota-blocked',
        terminated: false,
      });
    } else if (!result.aborted && !result.exhausted) {
      // P-007 — THE SUCCESS ROW, and the reason it did not exist before.
      //
      // Every other appendHostEvent kind in this host (51 distinct spellings,
      // enumerated from source 2026-09-22) is a failure, drop, expiry, refusal,
      // retry or lifecycle marker. The failure side of wake delivery was
      // therefore fully instrumented while the DENOMINATOR was absent, so a
      // delivery success rate was not computable at all — and with no rate, no
      // fix to this path (P-003's verifier included) could be shown to work
      // rather than merely asserted. That is the gap this row closes.
      //
      // The predicate is the verifier's OWN settled verdict, not a
      // re-derivation of it: `aborted === null && exhausted === false` is
      // reachable only by falling out of the poll window with output still
      // flowing (`quietFor < quietMs` -> continue), or after a resubmit that
      // demonstrably woke the turn. notifyExhausted() early-returns while
      // `resubmits < maxResubmits`, so an ordinary quiet gap cannot set
      // `exhausted`.
      //
      // Counting anything looser would invert the metric. In particular a bare
      // `!result.aborted` folds the EXHAUSTED case — max resubmits with no
      // output, i.e. the wake provably not delivered — into the numerator, so
      // the reported delivery rate would climb as delivery actually failed.
      // `aborted === 'human-input'` is excluded for the opposite reason: the
      // owner typing mid-verify makes delivery genuinely undecidable here, and
      // an undecidable case must not be counted as a success.
      appendHostEvent(ownerId, 'turn-delivered', {
        label,
        polls: result.polls,
        resubmits: result.resubmits,
        // Count the initial submit as well as each verifier CR resubmit.
        // R-1(c)'s attempts > 1 detector is otherwise vacuous for turn delivery.
        attempts: 1 + result.resubmits,
        ...(result.confirmed ? { confirmed: result.confirmed } : {}),
        ...(writeContext ? { write: writeContext } : {}),
      });
    }
    return result;
  };

  /**
   * Deliver `text` as a TURN once the child is back at its prompt — GUARANTEED
   * or LOUDLY DROPPED, never silently. Retries `waitAtPrompt` across a
   * wall-clock budget (a cold/replaying child can stay busy past one agent-busy
   * cap and THEN settle), writes the per-agent paste-safe turn plan, and
   * verifies the submit actually started a turn (WI-2930). Bails if a recycle
   * supersedes the child mid-flight.
   *
   * Two callers: the RECYCLE carry-note (WI-1941) and the launch KICKOFF
   * (agent-launch-resume-primitives-2026-07-12 P-011/D-008) — a resumed or
   * forked session boots IDLE at its prompt with no first turn, and nothing
   * roster-gated can reach it (its presence rows were reaped when it died, so
   * coord:wake/coord:send answer `unknown_recipient`). The host owns the pty, so
   * it is the one place that can seed that turn without a discovery race — and
   * it works identically for a FORK, whose fresh coord identity no external
   * caller can know until it boots.
   */
  const injectTurnAtPrompt = async ({
    text,
    label,
    budgetMs = recycleCarryInjectBudgetMs,
    backoffMs = recycleCarryRetryBackoffMs,
    onDrop = () => {},
    requireInitialOutput = false,
    verifyKickoffMarkerEcho = false,
    terminateOnSubmitVerifyExhaustion = submitExhaustionTerminatesHost(label),
    submitVerificationRequired = terminateOnSubmitVerifyExhaustion,
    promptAlreadyVerified = false,
    freshChildOwnerInputGeneration = null,
    abortBeforeWrite = null,
    prepareBeforeWrite = null,
    // WI-10004943 (d): when set (ms, measured from this call), a kickoff whose
    // budget expires while the Codex footer still reads `Starting` is HELD for
    // the session frame up to this ceiling instead of being dropped.
    codexStartingHoldCeilingMs = null,
    // WI-10005106: when set (ms, measured from this call), give up EARLY on a
    // child whose Codex footer still reads `Starting` at this point, with the
    // ordinary `codex-startup-still-starting` drop. For a caller that can retry
    // on a fresh child epoch (the recycle carry-note), so a stuck child is
    // replaced in minutes instead of being waited on for the whole budget.
    codexStartingStuckMs = null,
  }) => {
    if (!text) return { delivered: false, reason: 'no-text', attempts: 0 };
    const injectChild = child; // bail if a newer recycle supersedes this one
    const injectStartedAt = Date.now();
    // Mutable only by the WI-10004943 Codex `Starting` hold below.
    let deadline = injectStartedAt + budgetMs;
    let attempts = 0;
    let dropReason = 'never-settled';
    const freshChildWasInterrupted = () =>
      freshChildOwnerInputGeneration !== null &&
      ownerInputGeneration !== freshChildOwnerInputGeneration;
    const codexMarkerKickoffRequiresFrame = () =>
      requireInitialOutput &&
      verifyKickoffMarkerEcho &&
      childBackendTuiStartedAt > 0 &&
      String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex';
    const startupReadinessProven = () =>
      codexMarkerKickoffRequiresFrame() ? childBackendFirstFrameAt > 0 : childStartupReady;
    const codexStartupExplicitlyStarting = () =>
      String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex' &&
      codexFooterStateFromOutput(childStartupOutput, childScreenDims()) === 'starting';
    const startupFallbackCanAuthorize = () =>
      !codexMarkerKickoffRequiresFrame() &&
      !codexStartupExplicitlyStarting() &&
      childStartupFallbackElapsed();
    // WI-10005106: the `Starting` stuck threshold (see codexStartingStuckMs).
    // Only a positive `Starting` footer on the SAME child counts; a child that
    // never painted a footer keeps the ordinary budget and drop reasons.
    const codexStartingStuckAt =
      Number(codexStartingStuckMs) > 0 ? injectStartedAt + Number(codexStartingStuckMs) : 0;
    let codexStartingStuckReported = false;
    const codexStartingStuck = () => {
      if (
        codexStartingStuckAt <= 0 ||
        !requireInitialOutput ||
        codexStartingHeldAt > 0 ||
        Date.now() < codexStartingStuckAt ||
        child !== injectChild ||
        freshChildWasInterrupted() ||
        !codexStartupExplicitlyStarting()
      ) {
        return false;
      }
      if (!codexStartingStuckReported) {
        codexStartingStuckReported = true;
        appendHostEvent(ownerId, 'codex-starting-stuck-early-drop', {
          label,
          elapsedMs: Math.max(0, Date.now() - injectStartedAt),
          stuckMs: Number(codexStartingStuckMs),
          budgetMs,
        });
      }
      return true;
    };
    let codexFrameWaitExtendedReported = false;
    const codexBackendFrameWaitExpired = () => {
      if (!codexMarkerKickoffRequiresFrame() || childBackendFirstFrameAt > 0) return false;
      const waitStartedAt = childBackendTuiStartedAt || childStartupFirstOutputAt;
      const budgetSpent = waitStartedAt > 0 &&
        Date.now() - waitStartedAt >= startupMarkerFallbackMs *
          (CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER + 1);
      // WI-10004919: this budget exists for a frame that is NEVER observed (a
      // Codex that stops painting it, or bytes that beat the listener). A footer
      // that positively reads `Starting` is the opposite case: the TUI is alive
      // and still booting its MCP servers. Measured: v0.159.3 sat in `Starting`
      // for 86.2s, the 75s budget dropped the kickoff 11s before the Ready frame,
      // and the resolver idled at its prompt until the run watchdog stranded it.
      // Keep waiting under the kickoff's own deadline; if it is still Starting
      // there, the drop reason is `codex-startup-still-starting`.
      if (budgetSpent && codexStartupExplicitlyStarting()) {
        if (!codexFrameWaitExtendedReported) {
          codexFrameWaitExtendedReported = true;
          appendHostEvent(ownerId, 'launch-kickoff-backend-frame-wait-extended', {
            reason: 'codex-footer-starting',
            elapsedMs: Math.max(0, Date.now() - waitStartedAt),
            remainingMs: Math.max(0, deadline - Date.now()),
          });
        }
        return false;
      }
      return budgetSpent;
    };
    // WI-10004943 (d): the ordinary budget expired, but the Codex footer still
    // positively reads `Starting`, so the TUI is alive and its composer is not
    // available yet. Dropping here discarded the session's first turn, and it
    // then idled at its prompt (production: `Starting` for 10-20 minutes, then
    // the frame). HOLD instead: extend the deadline once, to the caller's
    // ceiling. The hold is self-limiting: once the footer leaves `Starting`
    // without a frame, codexBackendFrameWaitExpired() ends the wait with the
    // ordinary `codex-backend-frame-not-observed` drop, and owner input ends it
    // through freshChildWasInterrupted().
    const holdCeilingAt =
      Number(codexStartingHoldCeilingMs) > 0
        ? injectStartedAt + Math.max(budgetMs, Number(codexStartingHoldCeilingMs))
        : 0;
    let codexStartingHeldAt = 0;
    const holdForCodexStartingFooter = () => {
      if (
        codexStartingHeldAt > 0 ||
        holdCeilingAt <= 0 ||
        !requireInitialOutput ||
        Date.now() >= holdCeilingAt ||
        child !== injectChild ||
        freshChildWasInterrupted() ||
        !codexStartupExplicitlyStarting()
      ) {
        return false;
      }
      codexStartingHeldAt = Date.now();
      deadline = holdCeilingAt;
      appendHostEvent(ownerId, 'kickoff-held-for-codex-frame', {
        label,
        budgetMs,
        holdCeilingMs: holdCeilingAt - injectStartedAt,
        elapsedMs: codexStartingHeldAt - injectStartedAt,
        remainingMs: Math.max(0, holdCeilingAt - codexStartingHeldAt),
      });
      return true;
    };
    try {
      // A scripted resume/port begins this task before wireChildData() is
      // reached later in host setup. Yield until the listener has observed at
      // least one real startup byte; the subsequent quiet gate then proves the
      // startup repaint has settled at a prompt. Never infer readiness from the
      // sentinel lastOutputAt=0 value.
      while (
        requireInitialOutput &&
        !startupReadinessProven() &&
        !freshChildWasInterrupted() &&
        !startupFallbackCanAuthorize() &&
        !codexBackendFrameWaitExpired() &&
        !codexStartingStuck() &&
        !(codexStartingHeldAt > 0 && hostCleanedUp) &&
        (Date.now() < deadline || holdForCodexStartingFooter())
      ) {
        const recoveryState = claudeResumeCompaction.tick();
        if (recoveryState.timedOut) {
          reportClaudeResumeCompactionTimeout();
          dropReason = 'resume-compaction-timeout';
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      if (codexStartingHeldAt > 0) {
        const frameObserved = startupReadinessProven();
        appendHostEvent(ownerId, 'kickoff-codex-frame-hold-ended', {
          label,
          outcome: frameObserved
            ? 'frame-observed'
            : hostCleanedUp
              ? 'host-ended'
              : freshChildWasInterrupted()
              ? 'owner-input'
              : codexStartupExplicitlyStarting()
                ? 'ceiling-still-starting'
                : 'footer-left-starting',
          heldMs: Math.max(0, Date.now() - codexStartingHeldAt),
        });
        // Released by the frame: give delivery a fresh ordinary budget, never
        // past the ceiling. Every other outcome drops below as before.
        if (frameObserved) deadline = Math.min(holdCeilingAt, Date.now() + budgetMs);
        else if (hostCleanedUp) return { delivered: false, reason: 'host-ended', attempts };
      }
      // The inner delivery loop below owns the common drop/diagnostic path. Do
      // not return or break from this outer try block when the recovery machine
      // has already timed out; its next gated check observes the same terminal
      // state and exits through that shared path.
      const startupFallbackReady = startupFallbackCanAuthorize();
      // EI-20270422678541544 — TERMINAL FALLBACK. A missing startup-ready marker
      // used to return from here with `attempts: 0`, having never once tried to
      // write. That is a GUARANTEED strand whenever marker detection has a false
      // negative, and this detection is inherently best-effort: it is a pattern
      // match over TUI boot output, and a child whose startup bytes landed before
      // wireChildData() attached its listener leaves BOTH childStartupReady and
      // childStartupFirstOutputAt unset while sitting perfectly healthy at its
      // prompt. Observed live 2026-08-12T17:45:31Z — `respawn-carry-dropped
      // reason=no-startup-ready-marker attempts=0 outputSeen=false`, after which
      // that session never took another machine turn until a human typed.
      //
      // So the marker's ABSENCE no longer decides delivery; it only decides how
      // many attempts we are willing to spend. Spend exactly ONE, bounded by the
      // busy gate's own cap: if the child really is at its prompt the turn lands
      // and the session recovers on its own; if it is genuinely dead the write is
      // a no-op inside the existing try/catch and we still drop — but with
      // attempts >= 1 and a reason recording that the fallback was exercised, so
      // the two cases stop being indistinguishable in the ledger.
      const startupMarkerMissing =
        requireInitialOutput && !startupReadinessProven() && !startupFallbackReady;
      if (startupMarkerMissing) dropReason = 'no-startup-ready-marker';
      let lastResortSpent = false;
      let composerUnseenFallbackRecorded = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (startupMarkerMissing) {
          // A bounded last resort is for a MISSED readiness marker. It must
          // not overrule Codex's explicit Starting footer, which says its
          // composer is still unavailable.
          if (codexStartupExplicitlyStarting()) {
            dropReason = 'codex-startup-still-starting';
            break;
          }
          if (lastResortSpent) {
            dropReason = 'no-startup-ready-marker-last-resort-failed';
            break;
          }
          lastResortSpent = true;
        }
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        if (freshChildWasInterrupted()) {
          dropReason = 'fresh-child-owner-input';
          break;
        }
        if (codexBackendFrameWaitExpired()) {
          const waitStartedAt = childBackendTuiStartedAt || childStartupFirstOutputAt;
          appendHostEvent(ownerId, 'launch-kickoff-backend-frame-timeout', {
            elapsedMs: waitStartedAt > 0 ? Math.max(0, Date.now() - waitStartedAt) : null,
            tuiStarted: childBackendTuiStartedAt > 0,
            budgetMs: startupMarkerFallbackMs *
              (CODEX_TUI_START_UNOBSERVED_FALLBACK_MULTIPLIER + 1),
          });
          dropReason = 'codex-backend-frame-not-observed';
          break;
        }
        attempts++;
        const recoveryBeforeBusy = await waitForClaudeResumeCompaction(deadline);
        if (!recoveryBeforeBusy.ready) {
          dropReason = recoveryBeforeBusy.reason;
          break;
        }
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        // WI-10001066: a fresh child has no submitted turn yet, but Codex and
        // Claude composers can repaint continuously. Positive backend startup
        // proof plus no intervening owner input establishes readiness without
        // requiring raw PTY silence. Reused children and heuristic fallbacks
        // still take the ordinary busy gate.
        const claudeKickoffReadiness = headlessClaudeKickoffReadiness({
          enabled: headlessClaudeOnboardingEnabled(env),
          requireInitialOutput,
          promptReady: childPromptReady,
          onboardingExpired: activeHeadlessClaudeOnboarding?.status().expired === true,
        });
        if (claudeKickoffReadiness === 'composer-unseen-ordinary-gate' && !composerUnseenFallbackRecorded) {
          composerUnseenFallbackRecorded = true;
          appendHostEvent(ownerId, 'headless-claude-composer-unseen-ordinary-gate', {
            label,
            attempts,
            startupOutputChars: childStartupOutput.length,
          });
        }
        const freshPromptReady = freshChildOwnerInputGeneration !== null &&
          (codexMarkerKickoffRequiresFrame()
            ? childBackendFirstFrameAt > 0
            : childPromptReady ||
              (String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex' && childStartupReady));
        // A re-armed wake has just passed the outer busy gate under the same
        // inject mutex. Repeating that gate here can burn a second, much longer
        // budget against an idle TUI repaint and drop the wake as never-settled.
        // The ordinary first-attempt and fresh-child paths still prove their
        // own boundary here.
        const atPrompt = promptAlreadyVerified
          ? { deferred: false, boundary: 'preverified' }
          : freshPromptReady
          ? { deferred: false }
          : claudeKickoffReadiness === 'composer-ready'
            ? { deferred: false }
            : claudeKickoffReadiness === 'wait-for-composer'
              ? { deferred: true, reason: 'headless-claude-composer-not-ready' }
              : await agentBusyGate.waitAtPrompt();
        if (claudeKickoffReadiness === 'wait-for-composer') {
          dropReason = 'headless-claude-composer-not-ready';
        }
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        if (!atPrompt.deferred) {
          // The menu can be painted while the ordinary quiet gate is settling.
          // Re-check immediately before the first byte so a stale quiet reading
          // can never authorize a kickoff into the recovery choices.
          const recoveryAfterBusy = await waitForClaudeResumeCompaction(deadline);
          if (!recoveryAfterBusy.ready) {
            dropReason = recoveryAfterBusy.reason;
            break;
          }
          if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
          if (promptAlreadyVerified && ownerComposerGate.hasPending()) {
            dropReason = 'owner-input';
            break;
          }
          if (freshChildWasInterrupted()) {
            dropReason = 'fresh-child-owner-input';
            break;
          }
          if (quotaBlockDetector.isBlocked()) {
            await verifySubmitted(label);
            dropReason = 'submit-verification-aborted-quota-blocked';
            break;
          }
          // A kickoff retry may have waited behind the original model turn for
          // minutes. Recheck at the actual write boundary, not when the retry
          // was queued: otherwise the completed first turn receives the same
          // kickoff again as a new user message (EI-24357651658566267).
          if (abortBeforeWrite?.()) {
            return { delivered: false, reason: 'first-turn-started', attempts };
          }
          if (prepareBeforeWrite) {
            const prepared = await prepareBeforeWrite({ deadline });
            if (!prepared.ok) {
              return { delivered: false, reason: prepared.reason ?? 'prewrite-rejected', attempts };
            }
            if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
            if (freshChildWasInterrupted()) return { delivered: false, reason: 'fresh-child-owner-input', attempts };
          }
          // The text is the first step; later steps are delayed submit CRs, so
          // readiness is captured now, not after them.
          const turnWriteStartedAt = Date.now();
          lastMachineTurnWriteStartedAtMs = turnWriteStartedAt;
          const kickoffWriteContext = turnWriteContext(turnWriteStartedAt);
          const turnWriteAuthorizedBy = codexMarkerKickoffRequiresFrame()
            ? 'backend-session-frame'
            : childPromptReady
              ? 'prompt-ready'
              : childStartupReady
                ? 'startup-ready-marker'
                : startupFallbackReady
                  ? 'startup-fallback'
                  : 'last-resort';
          const steps = controlWritesForAgent({ mode: 'turn', data: text }, env.PAPERCUSP_AGENT, env, {
            bracketedPaste: childBracketedPaste,
          });
          const kickoffMarker = verifyKickoffMarkerEcho ? leadingTurnOriginMarker(text) : null;
          if (kickoffMarker && text.length > kickoffMarker.length) {
            // Prove the short prefix while it is still visible. A long Codex
            // composer can render only the tail of an intact paste, making a
            // full-payload echo check wait forever before sending Enter.
            // Append the unchanged remainder only AFTER the exact marker echo;
            // native transcript proof below still verifies actual submission.
            const paste = (part) => childBracketedPaste ? bracketedPasteFrame(part) : part;
            steps.splice(0, 1,
              { data: paste(kickoffMarker), delayMs: 0 },
              { data: paste(text.slice(kickoffMarker.length)), delayMs: 0 },
            );
          }
          let markerEchoFailureReason = null;
          for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
            const step = steps[stepIndex];
            if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
            if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
            const chunks = ptyWriteChunks(step.data);
            const marker = stepIndex === 0 && verifyKickoffMarkerEcho
              ? leadingTurnOriginMarker(text)
              : null;
            const echoTap = marker ? makeOutputTap() : null;
            let echoProof = null;
            try {
              for (let i = 0; i < chunks.length; i++) {
                try {
                  quotaBlockDetector.observeInput(chunks[i]);
                  child.write(chunks[i]);
                  if (chunks[i].includes('\r')) activeHeadlessCodexModelChoice?.complete();
                } catch {
                  /* the child may have exited under us */
                }
                if (i + 1 < chunks.length) await new Promise((r) => setTimeout(r, 0));
              }
              if (marker && echoTap) {
                // A real Codex composer can take longer than two seconds to
                // render a complete paste. Keep the exact-marker safety check
                // until this kickoff's existing delivery deadline, and record
                // the two-second state without treating it as a failed turn.
                const echoBudgetMs = Math.max(1, deadline - Date.now());
                const echoTimeoutMs = Math.min(
                  echoBudgetMs,
                  positiveNumber(env.PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_TIMEOUT_MS, echoBudgetMs),
                );
                echoProof = await waitForPtyTextEcho({
                  read: echoTap.read,
                  text: marker,
                  timeoutMs: echoTimeoutMs,
                  pollMs: positiveNumber(
                    env.PAPERCUSP_PSU_PTY_KICKOFF_MARKER_ECHO_POLL_MS,
                    KICKOFF_MARKER_ECHO_POLL_MS,
                  ),
                  shouldCancel: () => child !== injectChild || freshChildWasInterrupted(),
                  onPending: (state) => appendHostEvent(ownerId, 'launch-kickoff-marker-echo-pending', {
                    ...state,
                    markerChars: marker.length,
                    budgetMs: echoTimeoutMs,
                  }),
                });
              }
            } finally {
              echoTap?.close();
            }
            if (echoProof?.cancelled) {
              markerEchoFailureReason = child !== injectChild ? 'superseded' : 'fresh-child-owner-input';
              break;
            }
            if (echoProof && !echoProof.echoed) {
              appendHostEvent(ownerId, 'launch-kickoff-marker-echo-unconfirmed', {
                elapsedMs: echoProof.elapsedMs,
                markerChars: marker.length,
                reason: echoProof.reason,
                observedChars: echoProof.observedChars,
                markerTailSeen: echoProof.markerTailSeen,
                visibleTail: echoProof.visibleTail ?? null,
                budgetMs: Math.max(0, deadline - turnWriteStartedAt),
              });
              markerEchoFailureReason = 'kickoff-marker-echo-unconfirmed';
              break;
            }
            if (echoProof?.echoed) {
              appendHostEvent(ownerId, 'launch-kickoff-marker-echo-confirmed', {
                elapsedMs: echoProof.elapsedMs,
                markerChars: marker.length,
                // WI-10005331: non-null when only a head-truncated marker echoed.
                markerHeadLost: echoProof.markerHeadLost ?? null,
                // WI-10005331: non-null when the marker echoed with only its
                // whitespace changed (a composer wrap at the marker's space).
                markerWhitespaceLost: echoProof.markerWhitespaceLost ?? null,
              });
            }
          }
          if (markerEchoFailureReason === 'superseded') {
            return { delivered: false, reason: 'superseded', attempts };
          }
          if (markerEchoFailureReason) {
            dropReason = markerEchoFailureReason;
            break;
          }
          lastMachineTurnSubmittedAtMs = Date.now();
          // The submit CR has reached this child. Do not answer a model menu
          // painted during the asynchronous proof wait as a startup choice.
          activeHeadlessCodexModelChoice?.complete();
          if (requireInitialOutput) {
            // WI-10002745: record which readiness gate authorized this first
            // write, timed from when the text bytes were written. A kickoff
            // typed into a still-booting TUI was only discoverable by
            // comparing the native transcript with the backend's own startup log.
            appendHostEvent(ownerId, 'startup-turn-written', {
              label,
              authorizedBy: turnWriteAuthorizedBy,
              msSinceFirstOutput: childStartupFirstOutputAt
                ? turnWriteStartedAt - childStartupFirstOutputAt
                : null,
              msSinceBackendFirstFrame: childBackendFirstFrameAt
                ? turnWriteStartedAt - childBackendFirstFrameAt
                : null,
              promptReady: childPromptReady,
              startupReady: childStartupReady,
              ...(kickoffWriteContext.codexFooterAtWrite !== undefined
                ? { codexFooterAtWrite: kickoffWriteContext.codexFooterAtWrite }
                : {}),
            });
          }
          if (child !== injectChild) {
            return { delivered: false, reason: 'superseded', attempts };
          }
          let submitVerification = await verifySubmitted(label, {
            terminateOnExhaustion: terminateOnSubmitVerifyExhaustion,
            text,
            submittedAtMs: turnWriteStartedAt,
            writeContext: kickoffWriteContext,
          });
          if (child !== injectChild) {
            return { delivered: false, reason: 'superseded', attempts };
          }
          // WI-10001508: a 'human-input' abort is TRANSIENT — every other
          // verifier verdict describes the CHILD (exhausted, quota-blocked) and
          // is terminal, but this one describes the OWNER touching the keyboard
          // during the verify window. Dropping on it discarded a MUST-DELIVER
          // carry outright, which is the opposite of what the busy-gate path
          // does for the identical situation: makeCarryRearmController re-polls
          // a production carry-respawn across successive windows precisely
          // because dropping "strands the session at its context ceiling".
          //
          // Measured 2026-09-15: `submit-verification-aborted-human-input` is
          // 0.6% of fleet drops but 100% of THIS (interactive) session's — the
          // owner types, the carry is dropped, the successor sits at an idle
          // prompt with orders it never received, and a human has to resume it
          // by hand. The owner's own keystroke is what destroys the delivery.
          //
          // So: wait for the keystrokes to settle, then RE-VERIFY. Deliberately
          // re-run the verifier rather than re-writing `text` — a re-write would
          // submit the carry TWICE, whereas the verifier only re-polls and (if
          // still quiet) sends a bare CR, submitting whatever is already staged.
          // Bounded by the same delivery deadline, so a session whose owner is
          // genuinely composing for the whole budget still drops exactly as
          // before, with the same reason.
          //
          // RESIDUAL (known, deliberate): if the owner has typed a partial line
          // into the composer and then gone quiet, the verifier's bare CR can
          // submit THEIR line. That is judged better than the current guaranteed
          // strand, but it is the reason this retries rather than force-submits.
          while (
            submitVerification.aborted === 'human-input' &&
            Date.now() < deadline &&
            child === injectChild
          ) {
            appendHostEvent(ownerId, 'submit-verify-human-input-retry', {
              label,
              polls: submitVerification.polls,
              resubmits: submitVerification.resubmits,
              msRemaining: Math.max(0, deadline - Date.now()),
            });
            await idleGate.waitIdle();
            if (child !== injectChild) {
              return { delivered: false, reason: 'superseded', attempts };
            }
            submitVerification = await verifySubmitted(label, {
              terminateOnExhaustion: terminateOnSubmitVerifyExhaustion,
              text,
              submittedAtMs: turnWriteStartedAt,
              writeContext: kickoffWriteContext,
            });
          }
          if (child !== injectChild) {
            return { delivered: false, reason: 'superseded', attempts };
          }
          // EI-21561923024113260 / WI-42318: verifier exhaustion and abort are
          // semantic negative/unknown outcomes. Ignoring either let a pty write
          // race cleanup or human input and still become delivered:true.
          // Callers with a stronger semantic proof (managed/native transcript)
          // deliberately disable generic fatal exhaustion and own the verdict
          // themselves. Only callers that opt into this verifier as authority
          // may turn its negative/unknown result into a delivery drop.
          const verificationFailure = submitVerificationRequired || submitVerification.aborted === 'quota-blocked'
            ? submitVerificationFailureReason(submitVerification)
            : null;
          if (verificationFailure) {
            dropReason = verificationFailure;
            break;
          }
          activeHeadlessCodexModelChoice?.complete();
          return { delivered: true, attempts };
        }
        // Deferred: the child is still mid-boot / mid-turn. Retry until the
        // budget is spent, then fall through to the loud drop.
        // The last-resort pass gets exactly one attempt regardless of the budget
        // (which the startup-marker wait has usually already spent), so re-enter
        // and let the top of the loop record the terminal reason.
        if (startupMarkerMissing) continue;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    } catch {
      /* an unexpected inject error still falls through to the drop trace */
    }
    if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
    if (dropReason === 'codex-startup-still-starting') {
      // WI-10004943 (b): capture what the stuck child was waiting on while it is
      // still alive. The respawn this drop leads to starts a fresh codex-tui.log
      // in the same CODEX_HOME, so this is the last chance to see its log.
      try {
        const snapshot = collectCodexStartingStuckSnapshot({
          rootPid: child?.pid,
          codexHome: env.CODEX_HOME,
          startupOutput: childStartupOutput,
          screenDims: childScreenDims(),
        });
        appendHostEvent(ownerId, 'codex-starting-stuck-snapshot', { label, ...snapshot });
      } catch {
        /* diagnostic only */
      }
    }
    try {
      onDrop();
    } catch {
      /* the drop trace must never break the session */
    }
    // WI-10004943: an early `Starting` drop is armed only for a caller that
    // replaces the child and retries (the carry's fresh epoch, the launch
    // kickoff's fresh child), so it is not terminal. It must not print the
    // DROPPED receipt: the acceptance grader treats `launch kickoff DROPPED`
    // with no first-turn progress as a dead judge, and would retire one whose
    // retry is about to land. A caller whose retry cannot run prints it.
    const earlyStuck = codexStartingStuckReported && dropReason === 'codex-startup-still-starting';
    appendHostEvent(ownerId, 'startup-turn-dropped', {
      label,
      reason: dropReason,
      attempts,
      budgetMs,
      ...(earlyStuck ? { earlyStuck: true } : {}),
    });
    if (!earlyStuck) writeStartupTurnDroppedLine({ label, dropReason, budgetMs, attempts });
    return { delivered: false, reason: dropReason, attempts, ...(earlyStuck ? { earlyStuck: true } : {}) };
  };

  // WI-10004926: the ONE writer of the parsed DROPPED receipt, pinned to the
  // acceptance-grader parser by apps/operator/lib/psu-pty-host-drop-line-contract.test.ts.
  // WI-10004943 adds a caller: a launch kickoff whose fresh-child retry cannot run.
  const writeStartupTurnDroppedLine = ({ label, dropReason, budgetMs, attempts }) => {
    try {
      process.stderr.write(formatStartupTurnDroppedLine({ label, ownerId, dropReason, budgetMs, attempts }));
    } catch {
      /* never let a diagnostic write break the host */
    }
  };

  // Scripted fresh launches and resumes share the managed first-turn seam;
  // prompts stay out of argv. Only a fresh Codex thread can use startup proof
  // instead of output silence. Resume/fork may already be running a turn.
  let launchKickoffSettled = !launchKickoff;
  let confirmedCarryChild = null;
  let confirmedCarryNativeId = null;
  const prepareCarryBinding = async (nativeId, deadline, alreadyConfirmed = false) => {
    const target = child;
    const result = await waitForRespawnBinding({
      nativeId,
      readNativeId: () => resolveRespawnNativeId?.(target.pid) ?? null,
      report: onRespawn,
      isCurrent: () => child === target && !hostCleanedUp && !shuttingDown,
      alreadyConfirmed: alreadyConfirmed || (confirmedCarryChild === target && confirmedCarryNativeId === nativeId),
      timeoutMs: Math.max(0, deadline - Date.now()),
    });
    appendHostEvent(ownerId, result.ok ? 'respawn-binding-confirmed' : 'respawn-binding-unconfirmed', {
      nativeId: result.nativeId, reason: result.reason,
    });
    if (result.ok) {
      confirmedCarryChild = target;
      confirmedCarryNativeId = result.nativeId;
    }
    return result;
  };
  if (launchKickoff) {
    const requireRoleMcp = headlessRoleKickoffRequiresMcp({
      agent: env.PAPERCUSP_AGENT,
      role: env.PAPERCUSP_ROLE,
      headless: env.PAPERCUSP_PSU_HEADLESS === '1',
      hasKickoff: true,
      isResume: args.some((arg) => arg === 'resume' || arg === 'fork'),
    });
    const verifyKickoffMarkerEcho =
      String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex' &&
      !args.some((arg) => arg === 'resume' || arg === 'fork') &&
      Boolean(leadingTurnOriginMarker(launchKickoff));
    void (async () => {
      const label = managedKickoff ? 'session-port seed' : 'launch kickoff';
      const isResumeLaunch = args.some((arg) => arg === 'resume' || arg === 'fork');
      const kickoffBudgetMs = headlessClaudeOnboardingEnabled(env)
        ? Math.min(recycleCarryInjectBudgetMs, HEADLESS_CLAUDE_KICKOFF_READY_TIMEOUT_MS)
        : recycleCarryInjectBudgetMs;
      // WI-10004943: a plain fresh Codex launch whose child is still at the
      // `Starting` footer after the stuck threshold gets a fresh child and the
      // same kickoff (the WI-10005106 carry remedy). The (d) hold alone rescued
      // 0 of 3 such launches; the last attempt still holds.
      const freshChildRetry = {
        agent: env.PAPERCUSP_AGENT,
        managedKickoff: Boolean(managedKickoff),
        isResume: isResumeLaunch,
        maxRetries: codexLaunchStartingRetryMax(env.PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES),
      };
      let freshChildRetries = 0;
      const injectLaunchKickoff = () => injectTurnAtPrompt({
        text: launchKickoff,
        label,
        budgetMs: kickoffBudgetMs,
        requireInitialOutput: true,
        verifyKickoffMarkerEcho,
        ...launchKickoffCodexStartingOptions({
          ...freshChildRetry,
          retryCount: freshChildRetries,
          stuckMs: positiveNumber(
            env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS,
            CODEX_CARRY_STARTING_STUCK_MS,
          ),
          // WI-10004943 (d): hold, don't drop, while the Codex footer reads Starting.
          holdCeilingMs: positiveNumber(
            env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS,
            CODEX_STARTING_KICKOFF_HOLD_CEILING_MS,
          ),
        }),
        prepareBeforeWrite: async ({ deadline }) => {
          if (adoptedCarryRespawn && (adoptedCarryRespawn.nativeId || resolveRespawnNativeId)) {
            const binding = await prepareCarryBinding(adoptedCarryRespawn.nativeId, deadline);
            if (!binding.ok) return binding;
            adoptedCarryRespawn.nativeId = binding.nativeId;
          }
          if (!requireRoleMcp) return { ok: true };
          const tap = makeOutputTap();
          try {
            const result = await verifyHeadlessRoleMcp(() => runMcpReconnectMacro({
              serverName: 'papercusp',
              write: (bytes) => child.write(bytes),
              readTap: tap.read,
              resetTap: tap.reset,
            }));
            appendHostEvent(ownerId, result.ok ? 'launch-role-mcp-ready' : 'launch-role-mcp-unavailable', {
              step: result.step,
              attempts: result.attempts,
              detail: result.detail,
            });
            return { ok: result.ok, reason: 'role-mcp-unavailable' };
          } finally {
            tap.close();
          }
        },
        // Read per attempt, so a replacement child is judged against the owner
        // input generation current at its own kickoff.
        freshChildOwnerInputGeneration: env.PAPERCUSP_AGENT === 'codex' && !isResumeLaunch
          ? ownerInputGeneration
          : null,
        // The managed kickoff's native transcript proof owns its failure
        // timeout and child kill. Do not let the generic submit verifier tear
        // down the host before that proof can observe a late marker.
        terminateOnSubmitVerifyExhaustion: !managedKickoff,
      });
      let r = await injectLaunchKickoff();
      while (
        !r.delivered &&
        shouldRetryLaunchKickoffOnFreshChild({ ...freshChildRetry, reason: r.reason, retryCount: freshChildRetries })
      ) {
        freshChildRetries += 1;
        appendHostEvent(ownerId, 'launch-kickoff-fresh-child-retry', {
          label,
          reason: r.reason,
          attempt: freshChildRetries,
          maxRetries: freshChildRetry.maxRetries,
        });
        let replaced;
        if (hostCleanedUp || shuttingDown) {
          replaced = { spawned: false, reason: 'host-shutting-down' };
        } else {
          try {
            replaced = await recycleChild('', { freshChildOnly: true });
          } catch (error) {
            replaced = { spawned: false, reason: `threw:${String(error?.message ?? error).slice(0, 120)}` };
          }
        }
        if (!replaced?.spawned) {
          appendHostEvent(ownerId, 'launch-kickoff-fresh-child-failed', {
            label,
            reason: replaced?.reason ?? 'no-recycle-result',
            attempt: freshChildRetries,
          });
          // The early drop skipped the parsed DROPPED receipt on the promise of
          // this retry. The retry cannot run, so the drop is terminal after all.
          if (r.earlyStuck) {
            writeStartupTurnDroppedLine({ label, dropReason: r.reason, budgetMs: kickoffBudgetMs, attempts: r.attempts });
          }
          break;
        }
        r = await injectLaunchKickoff();
      }
      // EI-24818010361425604: a same-host respawn replaced the child while this
      // kickoff was in flight, so the owner now lives in the successor. Wait on
      // the inject mutex (a gated respawn holds it through kill + spawn + carry
      // inject, so the carry turn lands first), then give the successor the
      // kickoff. A duplicate is possible when the carry tail already quoted the
      // kickoff; losing it, and having the parent kill the successor over a
      // terminal negative receipt, is the failure this replaces.
      let respawnRedeliveries = 0;
      while (
        !r.delivered &&
        shouldRedeliverLaunchKickoffAfterRespawn({
          reason: r.reason,
          managedKickoff: Boolean(managedKickoff),
          hostShuttingDown: hostCleanedUp || shuttingDown,
          redeliveries: respawnRedeliveries,
        })
      ) {
        respawnRedeliveries += 1;
        appendHostEvent(ownerId, 'launch-kickoff-respawn-redelivery', {
          label,
          attempt: respawnRedeliveries,
          maxRedeliveries: LAUNCH_KICKOFF_RESPAWN_REDELIVERY_MAX,
        });
        let releaseInject = null;
        try {
          releaseInject = await injectMutex.acquire();
        } catch {
          // Never block the redelivery on the mutex itself; the injector's own
          // prompt and busy gates still order it after the carry turn.
          releaseInject = null;
        }
        try {
          r = hostCleanedUp || shuttingDown
            ? { delivered: false, reason: 'host-shutting-down', attempts: 0 }
            : await injectLaunchKickoff();
        } finally {
          releaseInject?.();
        }
      }
      if (!managedKickoff) {
        if (!r.delivered) {
          // An opted-in detached caller must receive a terminal negative receipt
          // even when the PTY submission never started. Otherwise the parent
          // waits out its proof window and cannot distinguish "not submitted"
          // from a host that died before it could report.
          publishKickoffProof({
            persisted: false,
            nativeRef: null,
            reason: `kickoff-not-submitted:${r.reason ?? 'unknown'}`,
          });
          return;
        }
        let proof;
        try {
          proof = await verifyNativeTurnStartWithRetry({
            agent: env.PAPERCUSP_AGENT,
            env,
            text: launchKickoff,
            sinceMs: nativeCaptureAfterMs,
            timeoutMs: nativePersistenceTimeoutMs,
            writeCr: () => child.write('\r'),
            onRetry: () => {
              appendHostEvent(ownerId, 'launch-kickoff-turn-start-retry', {
                reason: 'native-turn-marker-timeout',
              });
            },
          });
        } catch (error) {
          proof = {
            persisted: false,
            nativeRef: null,
            retried: false,
            reason: 'native-turn-proof-error',
          };
          appendHostEvent(ownerId, 'launch-kickoff-turn-start-proof-error', {
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
        if (proof.markerTruncated) {
          // WI-10002745: delivered, but the provenance marker lost its head.
          // Kept visible so the byte-loss cause stays measurable.
          appendHostEvent(ownerId, 'launch-kickoff-marker-truncated', {
            lostChars: proof.markerTruncated.lostChars,
            nativeRef: proof.nativeRef ?? null,
          });
        }
        // Publish the native transcript verdict before any caller-facing
        // handling. The detached parent owns the placeholder and uses this
        // receipt as the only authority for whether its kickoff ran.
        publishKickoffProof({
          persisted: proof.persisted === true,
          nativeRef: proof.nativeRef ?? null,
          reason: proof.persisted ? null : proof.reason,
        });
        if (!proof.persisted) {
          const proofUnavailable =
            proof.reason === 'missing-leading-turn-origin' ||
            proof.reason === 'unsupported-backend';
          appendHostEvent(ownerId, 'launch-kickoff-turn-start-unverified', {
            reason: proof.reason,
            retried: proof.retried,
            proofUnavailable,
          });
          try {
            process.stderr.write(
              proofUnavailable
                ? `psu: kickoff submitted but UNVERIFIED — native execution proof is unavailable ` +
                  `(${proof.reason}); never claiming delivered.\n`
                : `psu: kickoff DROPPED — the exact provenance marker never entered the native transcript ` +
                  `(${proof.reason ?? 'native marker timeout'}).\n`,
            );
          } catch {
            /* diagnostics are best-effort */
          }
          // Plain hostThroughPty callers predate provenance tagging. Preserve
          // their submitted session without making a false delivery claim.
          // Production scripted fleet kickoffs are tagged; a missing marker
          // there is authoritative and the fresh, workless child is terminated.
          if (!proofUnavailable && !quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
          return;
        }
        if (adoptedCarryRespawn) {
          const adoptedCarryChild = child;
          const adoptedAnnouncement = await announceVerifiedCarryRespawn({
            ownerId,
            agent: env.PAPERCUSP_AGENT,
            nativeId: adoptedCarryRespawn.nativeId ?? null,
            proof,
            alreadyReported: confirmedCarryChild === adoptedCarryChild,
            report: onRespawn,
            emit: emitCompacted,
            timeoutMs: respawnReportTimeoutMs,
            isCurrent: () => child === adoptedCarryChild && !recycling && !shuttingDown && !hostCleanedUp,
          });
          const adoptedNativeId = adoptedAnnouncement.nativeId ?? adoptedCarryRespawn.nativeId ?? null;
          appendHostEvent(ownerId, 'respawn-carry-delivered', {
            mode: 'carry-respawn',
            nativeId: adoptedNativeId,
            outputSeen: childStartupOutput.length > 0,
            turnStartVerified: true,
            nativeRef: proof.nativeRef ?? null,
            adopted: true,
          });
          if (!adoptedAnnouncement.announced) {
            appendHostEvent(ownerId, 'respawn-compaction-unannounced', {
              nativeId: adoptedNativeId,
              reason: adoptedAnnouncement.reason,
              adopted: true,
            });
          }
        }
        // The marker proves submission, not execution. When an isolated native
        // transcript is available, only a task-start/assistant row after this
        // marker proves the turn ran; PTY output may have arrived before marker
        // proof returned and must not become a late sampling baseline.
        const readLastOutputAt = () => activity.snapshot().lastOutputAt ?? 0;
        const kickoffMarker = leadingTurnOriginMarker(launchKickoff);
        const kickoffMarkerAnchor = {
          fileIdentity: null, markerStartOffset: null, markerEndOffset: null, scannedEndOffset: null,
        };
        const nativeTurnActivity = kickoffMarker && proof.nativeRef &&
          nativeTurnVerifierSupport(env.PAPERCUSP_AGENT, env).supported
          ? () => nativeKickoffTurnActivityAfterMarker({
              agent: env.PAPERCUSP_AGENT,
              env,
              transcriptPath: proof.nativeRef,
              marker: kickoffMarker,
              markerLostChars: proof.markerTruncated?.lostChars ?? 0,
              anchor: kickoffMarkerAnchor,
            })
          : null;
        const configuredPollMs = Number(env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS);
        const kickoffTurnPollMs = configuredPollMs || KICKOFF_TURN_START_POLL_MS;
        const configuredPolls = Number(env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);
        const kickoffTurnPolls = Number.isFinite(configuredPolls) && configuredPolls >= 0
          ? configuredPolls
          : KICKOFF_TURN_START_POLLS;
        const observeTurnStart = () => observeKickoffModelTurnStart({
          lastOutputAt: readLastOutputAt,
          nativeTurnActivity,
          pollMs: kickoffTurnPollMs,
          polls: kickoffTurnPolls,
        });
        let turnStart = await observeTurnStart();
        let modelRetried = false;
        if (turnStart.observed && !turnStart.started) {
          appendHostEvent(ownerId, 'launch-kickoff-model-turn-absent', {
            budgetMs: turnStart.budgetMs,
            polls: turnStart.polls,
            reason: turnStart.reason,
            retrying: true,
          });
          // Re-send the kickoff TEXT, not a bare CR: the prompt already
          // submitted, so the composer is EMPTY and an Enter would be a no-op.
          // Routed through injectTurnAtPrompt so it inherits the busy/composer
          // gates — an UNGATED retype is the documented mid-turn wedge, and the
          // one case this detector can be wrong about (a genuinely slow turn) is
          // exactly the case those gates exist to defer. Never terminate on this
          // path: the child is still usable and the first turn already persisted.
          try {
            const retry = await injectTurnAtPrompt({
              text: launchKickoff,
              label: 'launch kickoff (model-turn retry)',
              requireInitialOutput: false,
              verifyKickoffMarkerEcho,
              terminateOnSubmitVerifyExhaustion: false,
              abortBeforeWrite: () => firstKickoffTurnStartedBeforeRetry(nativeTurnActivity),
            });
            modelRetried = retry.delivered === true;
            if (retry.reason === 'first-turn-started') {
              appendHostEvent(ownerId, 'launch-kickoff-model-turn-retry-skipped', {
                reason: 'first-turn-started-before-rewrite',
              });
            }
          } catch (error) {
            appendHostEvent(ownerId, 'launch-kickoff-model-turn-retry-error', {
              error: String(error?.message ?? error).slice(0, 200),
            });
          }
          turnStart = await observeTurnStart();
          appendHostEvent(ownerId, 'launch-kickoff-model-turn-retry-result', {
            started: turnStart.started,
            polls: turnStart.polls,
          });
        }
        try {
          process.stderr.write(
            turnStart.started
              ? `psu: kickoff delivered — verified the exact provenance marker in the native transcript` +
                `${modelRetried ? ' (model turn started only after one in-session retry)' : ''}.\n`
              : `psu: kickoff ACCEPTED BUT THE MODEL TURN NEVER STARTED — the provenance marker ` +
                `persisted, then ${Math.round(turnStart.budgetMs / 1000)}s passed with no output ` +
                `(retried once). The child is alive and idle; it is NOT working.\n`,
          );
        } catch {
          /* diagnostics are best-effort */
        }
        return;
      }
      if (!r.delivered) {
        try {
          await acknowledgeManagedKickoff({
            persisted: false,
            renderedHash: managedKickoff.renderedHash,
            error: `session-port seed was not submitted (${r.reason ?? 'unknown'})`,
          });
        } finally {
          if (!quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
        }
        return;
      }
      const proof = await waitForNativeTranscriptMarker({
        agent: env.PAPERCUSP_AGENT,
        env,
        marker: managedKickoff.marker,
        sinceMs: nativeCaptureAfterMs,
        timeoutMs: nativePersistenceTimeoutMs,
      });
      if (!proof.persisted) {
        try {
          await acknowledgeManagedKickoff({
            persisted: false,
            renderedHash: managedKickoff.renderedHash,
            error: `session-port seed was submitted but not found in the ${env.PAPERCUSP_AGENT} native transcript`,
          });
        } finally {
          if (!quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
        }
        return;
      }
      try {
        await acknowledgeManagedKickoff({
          persisted: true,
          renderedHash: managedKickoff.renderedHash,
          nativeRef: proof.nativeRef,
        });
        process.stderr.write(
          `psu: session port delivered — verified the exact seed checksum in the target native transcript.\n`,
        );
      } catch (error) {
        appendHostEvent(ownerId, 'session-port-delivery-ack-failed', hostErrorEvidence(error));
        process.stderr.write(`psu: session-port delivery acknowledgement failed: ${error?.message ?? error}\n`);
        if (!quotaBlockDetector.isBlocked()) {
          try { child.kill(); } catch { /* already exited */ }
        }
      }
    })().catch((error) => {
      appendHostEvent(ownerId, 'managed-kickoff-failed', hostErrorEvidence(error));
      if (!managedKickoff) {
        publishKickoffProof({
          persisted: false,
          nativeRef: null,
          reason: 'launch-kickoff-error',
        });
      }
      try { process.stderr.write(`psu: managed kickoff failed: ${error?.message ?? error}\n`); }
      catch { /* diagnostics are best-effort */ }
      try { child.kill(); } catch { /* already exited */ }
    }).finally(() => {
      // psu-process-free-parking P-017: a park must never cut off a first
      // prompt that is still waiting to be typed.
      launchKickoffSettled = true;
    });
  }

  // P-001a (compaction-continuity-hardening): fold duplicate same-source turn
  // injects that stack up at the gates while the agent is busy — see the
  // makeTurnCoalescer doc block for the measured 9× duplication this kills.
  const turnCoalescer = makeTurnCoalescer();
  // EI-19311270129974785: remember delivery ids while their detached gated
  // pipeline is pending and after it commits, so a retry cannot inject a second
  // real turn while an early ACK is still only acceptance.
  const deliveryDedup = makeDeliveryDedup();
  // EI-8822: serialize the gated-inject critical section so a wake `turn` and a
  // session:request-compaction `/compact` freed at the SAME clean boundary can't
  // both pass the at-prompt gate and interleave their bytes into one pty input
  // line (the "/compact swallowed as prose" race). See makeInjectMutex.
  //
  // EI-22123519641932348: onStuck is this mutex's ONLY observability seam — a
  // wedged holder previously left ZERO trace (the ~6h total-silence incident
  // this closes). Durably record every stuck/force-release tick on THIS
  // owner's event log (so a peer/watchdog reading it after the fact can see
  // the session went dark and why) and echo it to stderr, matching every
  // other loud-diagnostic write in this file.
  const injectMutex = makeInjectMutex({
    onStuck: ({ phase, waitedMs }) => {
      appendHostEvent(ownerId, phase === 'force-release' ? 'inject-mutex-force-released' : 'inject-mutex-stuck', {
        waitedMs,
      });
      try {
        process.stderr.write(
          phase === 'force-release'
            ? `psu-pty-host: inject-mutex FORCE-RELEASED for ${ownerId} after ${waitedMs}ms — ` +
                `a prior gated inject never reached its release; every gated inject since has been ` +
                `queued behind it (EI-22123519641932348). Proceeding the next waiter now.\n`
            : `psu-pty-host: inject-mutex looks STUCK for ${ownerId} (held ${waitedMs}ms with no ` +
                `release yet, EI-22123519641932348) — every gated inject since is queuing behind it\n`,
        );
      } catch {
        /* never let a diagnostic write break the host */
      }
    },
  });
  // WI-5510: per-loop-instance last-delivered fire number — the delivery-side
  // half of the stale-fire guard (see makeStaleFireGuard's doc block). One
  // guard per host process is correct: this host serves exactly ONE ownerId
  // for its whole lifetime (D-006), so it needs no owner-keyed map, only a
  // loop-instance-keyed (routineId) one.
  const staleFireGuard = makeStaleFireGuard();
  // EI-12754: one-shot deferred retry for busy-gate-refused carry-respawn
  // drills. The retry window defaults to 2× the live-inject cap (a busy turn
  // that outran the first 3-minute wait gets one more, longer chance to settle);
  // per-session tunable like the caps above. Deps are read through closures so
  // the retry always uses the CURRENT recycleChild (it is reassigned per child).
  const carryRearmCapMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_REARM_CAP_MS,
    turnInjectBusyCapMs * 2,
  );
  // EI-18109211232286833: per-session tunable like the caps above, so tests
  // can force a tiny budget instead of waiting out the 10-minute default.
  const carryRespawnMaxAgeMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS,
    CARRY_RESPAWN_MAX_AGE_MS,
  );
  /**
   * P-003/P-005: reasons the native turn verifier is unavailable that have
   * already been reported durably for this host process. The predicate below is
   * polled in a tight loop up to the busy cap, so the capability gap is recorded
   * once rather than tens of thousands of times.
   * @type {Set<string | null>}
   */
  const turnVerifierGapReported = new Set();

  /**
   * P-003/P-005: the SINGLE place a gated delivery's native-boundary predicate
   * is built.
   *
   * Both the first busy-gate attempt and its re-arm retry resolve their
   * boundary through here, so the two legs cannot drift apart. They previously
   * did: the first attempt had a `turn`-mode probe the retry leg lacked, so a
   * retry could re-defer on output-silence alone against an agent the first
   * attempt would have verified as idle.
   *
   * @param {{mode?: string, sourceTranscriptPath?: string | null, receivedAtMs?: number} | null} [msg]
   * @returns {{boundary: (() => boolean) | null,
   *   support: {supported: boolean, reason: 'no-classifier' | 'no-isolated-root' | null}}}
   */
  function verifiedBoundaryFor(msg) {
    const agent = env.PAPERCUSP_AGENT;
    const support = nativeTurnVerifierSupport(agent, env);
    if (!support.supported) {
      if (!turnVerifierGapReported.has(support.reason)) {
        turnVerifierGapReported.add(support.reason);
        appendHostEvent(ownerId, 'turn-verifier-unsupported', {
          agent: String(agent ?? ''),
          reason: support.reason,
        });
      }
      return { boundary: null, support };
    }
    // carry-respawn stays PINNED to its source transcript — never widened to
    // "newest", which would let another thread's completion certify this one.
    if (msg?.mode === 'carry-respawn') {
      return {
        boundary: () => nativeTurnCompletedInTranscript({
          agent,
          env,
          transcriptPath: msg?.sourceTranscriptPath,
          receivedAtMs: msg?.receivedAtMs,
        }),
        support,
      };
    }
    return {
      boundary: () => nativeLatestTurnCompleted({
        agent,
        env,
        completedAtOrAfterMs: Math.max(
          Number(activity.snapshot().lastInputAt ?? 0),
          lastMachineTurnSubmittedAtMs,
        ),
      }),
      support,
    };
  }

  const carryRearm = makeCarryRearmController({
    acquireInject: () => injectMutex.acquire(),
    waitIdle: bridgeTty ? () => idleGate.waitIdle() : null,
    hasPendingOwnerInput: () => ownerComposerGate.hasPending(),
    waitForOwnerInputClear: bridgeTty ? () => ownerComposerGate.waitClear() : null,
    waitAtPrompt: (cap, msg) => agentBusyGate.waitAtPrompt(cap, verifiedBoundaryFor(msg).boundary),
    recycle: (data, opts) => recycleChild(data, opts),
    // P-005 / D-004: dispatch a re-armed delivery by mode. Only the modes with
    // a verified single-call delivery primitive are registered; anything else
    // must fall through to the recycle default rather than be guessed at.
    performDelivery: async (message, { drillId, mode }) => {
      if (mode === 'turn') {
        // A deferred wake `turn` is re-INJECTED, never recycled — recycling
        // would kill the child and destroy the very turn being delivered.
        const text = String(message?.data ?? '');
        if (!text) return { delivered: false, reason: 'no-text' };
        return injectTurnAtPrompt({
          text,
          label: 'turn re-arm',
          promptAlreadyVerified: true,
          terminateOnSubmitVerifyExhaustion: false,
          submitVerificationRequired: true,
          prepareBeforeWrite: async () => {
            if (shouldDeferWakeForPendingRespawn(mode, carryRearm.pendingCount('carry-respawn'))) {
              appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', {
                reason: 'carry-respawn-pending', phase: 'pre-write', rearmed: true,
              });
              return { ok: false, reason: 'carry-respawn-pending' };
            }
            return { ok: true };
          },
        });
      }
      return recycleChild(message?.data, {
        systemPromptAddendum: message?.systemPromptAddendum ?? '',
        drillId,
        sessionClass: message?.sessionClass ?? '',
      });
    },
    emitEvent: (kind, extra) => {
      appendHostEvent(ownerId, kind, extra);
      appendSharedDrillLedgerEvent(ownerId, kind, extra);
    },
    onSettlement: (messages, outcome) => {
      for (const message of messages) {
        const deliveryId = message?.deliveryId;
        if (!deliveryId) continue;
        if (outcome?.delivered) deliveryDedup.markCompleted(deliveryId);
        else deliveryDedup.clearPending(deliveryId);
      }
    },
    capMs: carryRearmCapMs,
    // Age expiry is drill-only. A newer child supersedes production carries
    // too, and must retire their pending wake suppression without another cut.
    isStale: (msg) =>
      isCarryRespawnStale(msg.receivedAtMs, { maxAgeMs: carryRespawnMaxAgeMs }),
    isSuperseded: (msg) =>
      isCarryRespawnSuperseded(msg.receivedAtMs, lastRespawnAtMs),
  });

  // ── Process-free parking (psu-process-free-parking-2026-10-06 P-017) ───────
  // An idle Claude child is SIGKILLed to free its memory while this host, its
  // control socket, discovery file and terminal stay up (D-002). The first
  // owner keystroke, control-socket delivery or recycle brings it back on the
  // SAME conversation (mintParkResumeArgs). While parked, `child` is a stand-in
  // with no pid: nothing can signal a recycled pid, and killing the stand-in
  // ends the session through the ordinary child-exit path (so shutdown, a
  // host signal and an orphaned terminal all behave exactly as with a live
  // child).
  const parkIdleMs = parkIdleMsFromEnv(env);
  const parkResumeWaitMs = positiveNumber(env.PAPERCUSP_PSU_PARK_RESUME_WAIT_MS, 60_000);
  let parked = false;
  /** @type {Promise<boolean> | null} */
  let parkPromise = null;
  /** @type {Promise<{ unparked: boolean, reason: string }> | null} */
  let unparkPromise = null;
  let parkedAtMs = 0;
  let lastUnparkAtMs = 0;
  /** @type {{ args: string[], nativeId: string } | null} */
  let parkResume = null;
  let deliveriesInFlight = 0;
  let lastParkDeferReason = null;
  /** Owner keystrokes typed while parked, replayed once the resumed prompt is up. */
  const heldOwnerInput = [];
  let heldOwnerInputBytes = 0;
  const HELD_OWNER_INPUT_CAP_BYTES = 4096;
  // P-019: control deliveries that arrived while a resume FAILED. Running one
  // would write into the pid-less stand-in and silently lose a turn the host
  // already ACKed (WI-10005134), so each waits here for the next successful
  // resume. A retry timer (backing off from PAPERCUSP_PSU_PARK_UNPARK_RETRY_MS)
  // keeps trying while anything is held; the host ending releases them as
  // undeliverable so the sender's dedup slot clears.
  /** @type {Array<(outcome: { ok: boolean, reason: string }) => void>} */
  const heldDeliveryWaiters = [];
  const HELD_DELIVERY_CAP = 64;
  const parkUnparkRetryMs = positiveNumber(env.PAPERCUSP_PSU_PARK_UNPARK_RETRY_MS, 5_000);
  const PARK_UNPARK_RETRY_MAX_MS = 5 * 60_000;
  /** @type {NodeJS.Timeout | null} */
  let unparkRetryTimer = null;
  let unparkRetryAttempt = 0;
  const parkInProgress = () => parked || parkPromise !== null || unparkPromise !== null;
  const releaseHeldDeliveries = (outcome) => {
    for (const release of heldDeliveryWaiters.splice(0)) release(outcome);
  };
  const cancelUnparkRetry = () => {
    if (unparkRetryTimer) clearTimeout(unparkRetryTimer);
    unparkRetryTimer = null;
  };
  const makeParkedChild = () => {
    const listeners = [];
    let exitEvent = null;
    const fire = (fn) => setImmediate(() => {
      try {
        fn(exitEvent);
      } catch {
        /* a listener must never break another */
      }
    });
    return {
      pid: undefined,
      write() {},
      resize() {},
      onData() {
        return { dispose() {} };
      },
      onExit(fn) {
        if (exitEvent) fire(fn);
        else listeners.push(fn);
        return { dispose() {} };
      },
      // Asynchronous like node-pty's own exit event, so a teardown that records
      // its signal before killing (WI-38054) still wins the race.
      kill(signal = 'SIGHUP') {
        if (exitEvent) return;
        exitEvent = {
          exitCode: 0,
          signal: typeof signal === 'string' ? (osConstants.signals[signal] ?? 0) : Number(signal) || 0,
        };
        for (const fn of listeners.splice(0)) fire(fn);
      },
    };
  };
  const mintResumeForPark = () => {
    try {
      const configDir = env.CLAUDE_CONFIG_DIR || null;
      const newest = newestSessionTranscriptId(configDir, { ownerId });
      const base = mintParkResumeArgs(liveChildArgs, { agent: env.PAPERCUSP_AGENT });
      if (!base || !Array.isArray(base.args) || !base.nativeId) return null;
      if (newest && newest.id !== base.nativeId) {
        const switched = mintParkResumeArgs(liveChildArgs, {
          agent: env.PAPERCUSP_AGENT,
          nativeId: newest.id,
        });
        if (switched && Array.isArray(switched.args) && switched.nativeId) {
          return { ...switched, switchedFrom: base.nativeId };
        }
      }
      return base;
    } catch {
      return null;
    }
  };
  const clearParkedState = (trigger, extra = {}) => {
    const parkedForMs = parkedAtMs ? Date.now() - parkedAtMs : null;
    parked = false;
    parkedAtMs = 0;
    parkResume = null;
    lastUnparkAtMs = Date.now();
    baseMeta.parked = false;
    baseMeta.parkedAt = null;
    return { trigger, parkedForMs, ...extra };
  };
  const parkChild = async (verdict) => {
    const resume = mintResumeForPark();
    if (!resume) return false;
    const parkedChild = child;
    const childPid = Number.isInteger(parkedChild?.pid) ? parkedChild.pid : null;
    // `recycling` makes the child-exit handler ignore THIS kill: a park is not
    // the session ending, and the operator must never see it as one (D-002).
    recycling = true;
    try {
      stopStartupTrace('park');
      const dead = new Promise((res) => {
        try {
          parkedChild.onExit(() => res(true));
        } catch {
          res(true);
        }
      });
      killPtyProcessTree(parkedChild, 'SIGKILL');
      const exited = await Promise.race([
        dead,
        new Promise((res) => setTimeout(() => res(false), RECYCLE_FORCE_KILL_WAIT_MS * 5)),
      ]);
      if (normalizedLog) normalizedLog.flush();
      childStartupOutput = '';
      childStartupReady = false;
      childPromptReady = false;
      childStartupFirstOutputAt = 0;
      childBracketedPaste = false;
      childBracketedPasteTail = '';
      childBackendTuiStartedAt = 0;
      childBackendFirstFrameAt = 0;
      lastMachineTurnWriteStartedAtMs = 0;
      quotaBlockDetector.reset();
      ownerComposerGate.markSubmitted();
      child = makeParkedChild();
      wireChildExit();
      parked = true;
      parkedAtMs = Date.now();
      parkResume = resume;
      baseMeta.parked = true;
      baseMeta.parkedAt = parkedAtMs;
      // A dead pid is recycled within hours here; never advertise one.
      baseMeta.ptyPid = null;
      writeMeta();
      try {
        // The killed TUI left its terminal modes (mouse reporting, bracketed
        // paste) armed; reset them so a mouse move is not read as a keystroke.
        if (bridgeTty) {
          const handoff = respawnTerminalHandoffBytes({
            rows: sanePtyDim(stdout.rows, 0, 500) || undefined,
            separator: false,
          });
          if (handoff) stdout.write(handoff);
        }
        stdout.write(
          `\r\n[psu] Agent parked after ${Math.round((verdict.idleForMs ?? parkIdleMs) / 60_000)} min idle ` +
            `to free memory. Type, or send it a message, to resume the same conversation.\r\n`,
        );
      } catch {
        /* the notice is advisory */
      }
      appendHostEvent(ownerId, 'child-parked', {
        idleForMs: verdict.idleForMs ?? null,
        childPid,
        exited,
        nativeId: resume.nativeId,
        switchedFrom: resume.switchedFrom ?? null,
      });
      return true;
    } finally {
      recycling = false;
    }
  };
  parkTick = () => {
    if (parkInProgress() || hostCleanedUp || shuttingDown || recycling) return;
    const now = Date.now();
    const snap = activity.snapshot();
    const lastActivityAt = Math.max(
      snap.lastActivityAt ?? 0,
      lastRespawnAtMs,
      lastUnparkAtMs,
      baseMeta.startedAt ?? 0,
    );
    const busy =
      deliveriesInFlight > 0 ||
      machineTurnActive ||
      carryRearm.pendingCount() > 0 ||
      !launchKickoffSettled;
    const verdict = parkVerdict({
      idleMs: parkIdleMs,
      agent: env.PAPERCUSP_AGENT,
      now,
      lastActivityAt,
      childPromptReady,
      parked,
      busy,
      quotaBlocked: quotaBlockDetector.isBlocked(),
      composerPending: ownerComposerGate.hasPending(),
      // Only pay for the transcript-dir scan once the child is idle enough to
      // park; before that the verdict refuses on idleness anyway.
      resumable: now - lastActivityAt >= parkIdleMs ? mintResumeForPark() !== null : true,
      descendants: () => countProcessDescendants(child?.pid),
    });
    if (!verdict.park) {
      // Report WHY an idle child was not parked, once per reason change, so
      // "why is this idle agent still holding memory" is a read, not a guess.
      const idleFor = now - lastActivityAt;
      if (
        parkIdleMs > 0 &&
        idleFor >= parkIdleMs &&
        verdict.reason !== lastParkDeferReason &&
        !['disabled', 'agent-not-parkable', 'already-parked', 'not-idle-long-enough'].includes(verdict.reason)
      ) {
        appendHostEvent(ownerId, 'child-park-deferred', {
          reason: verdict.reason,
          idleForMs: idleFor,
          descendants: verdict.descendants ?? null,
        });
      }
      lastParkDeferReason = verdict.reason;
      return;
    }
    lastParkDeferReason = null;
    parkPromise = parkChild(verdict)
      .catch((error) => {
        appendHostEvent(ownerId, 'child-park-failed', hostErrorEvidence(error));
        return false;
      })
      .finally(() => {
        parkPromise = null;
      });
  };
  /** P-019: while a failed resume leaves owner input or deliveries held, try
   *  again on a backoff (base, 2x, 4x … capped at 5 min). Idempotent. */
  const scheduleUnparkRetry = () => {
    if (unparkRetryTimer || hostCleanedUp || shuttingDown || !parked) return;
    if (!heldDeliveryWaiters.length && !heldOwnerInput.length) return;
    const delayMs = Math.min(parkUnparkRetryMs * 2 ** unparkRetryAttempt, PARK_UNPARK_RETRY_MAX_MS);
    unparkRetryAttempt++;
    unparkRetryTimer = setTimeout(() => {
      unparkRetryTimer = null;
      void unparkChild('retry');
    }, delayMs);
    // The control socket keeps the host alive; the retry must not.
    unparkRetryTimer.unref?.();
  };
  /**
   * Bring a parked child back on the same conversation. Single-flight: every
   * trigger that arrives while a resume is in progress shares it. Resolves once
   * the resumed TUI shows its prompt (or the wait cap passes — the delivery
   * gates downstream still guard the write). On failure the child stays parked
   * and a retry is scheduled while anything is held (P-019).
   * @param {string} trigger
   */
  const unparkChild = (trigger) => {
    if (unparkPromise) return unparkPromise;
    if (!parked && !parkPromise) return Promise.resolve({ unparked: false, reason: 'not-parked' });
    /** @type {Promise<{ unparked: boolean, reason: string }>} */
    let attempt;
    // The single-flight slot is cleared by IDENTITY, after the assignment below.
    // A `finally` inside the async body is not enough: a resume that fails
    // synchronously (a spawn that throws before any await) runs that finally
    // BEFORE `unparkPromise = …` executes, leaving the failed promise in the
    // slot for good, so every later retry/keystroke/delivery silently re-reads
    // the stale failure (found by P-019's failing-first test).
    const releaseSlot = () => {
      if (unparkPromise === attempt) unparkPromise = null;
    };
    attempt = (async () => {
      const startedAt = Date.now();
      try {
        if (parkPromise) await parkPromise;
        if (!parked) return { unparked: false, reason: 'not-parked' };
        if (hostCleanedUp || shuttingDown) return { unparked: false, reason: 'host-ending' };
        const resume = parkResume;
        if (!resume) {
          appendHostEvent(ownerId, 'child-unpark-failed', { trigger, reason: 'no-resume-args' });
          scheduleUnparkRetry();
          return { unparked: false, reason: 'no-resume-args' };
        }
        let resumed;
        try {
          resumed = spawnChild(resume.args);
        } catch (error) {
          appendHostEvent(ownerId, 'child-unpark-failed', {
            trigger,
            reason: 'spawn-failed',
            attempt: unparkRetryAttempt,
            ...hostErrorEvidence(error),
          });
          scheduleUnparkRetry();
          return { unparked: false, reason: 'spawn-failed' };
        }
        cancelUnparkRetry();
        unparkRetryAttempt = 0;
        child = resumed;
        stopStartupTrace = startCodexStartupProcessTrace({
          agent: env.PAPERCUSP_AGENT, ownerId, pid: child.pid,
        });
        const details = clearParkedState(trigger, { nativeId: resume.nativeId });
        baseMeta.ptyPid = child.pid;
        writeMeta();
        wireChildData();
        wireChildExit();
        activity.touchOutput();
        const deadline = Date.now() + parkResumeWaitMs;
        while (!childPromptReady && child === resumed && !hostCleanedUp && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 100));
        }
        appendHostEvent(ownerId, 'child-unparked', {
          ...details,
          childPid: Number.isInteger(resumed.pid) ? resumed.pid : null,
          promptReady: childPromptReady,
          latencyMs: Date.now() - startedAt,
        });
        if (child === resumed && heldOwnerInput.length) {
          const replay = heldOwnerInput.splice(0);
          heldOwnerInputBytes = 0;
          for (const chunk of replay) forwardOwnerInput(chunk);
        }
        // Deliveries held by an earlier failed resume run now, in arrival order
        // (each re-enters the inject mutex). If the resumed child already died,
        // the host is ending and cleanup releases them as undeliverable.
        if (child === resumed) releaseHeldDeliveries({ ok: true, reason: 'resumed' });
        return { unparked: true, reason: 'resumed' };
      } catch (error) {
        // Anything unexpected past the spawn (writeMeta, wiring) must not leave
        // a rejected promise in callers that only branch on `unparked`.
        appendHostEvent(ownerId, 'child-unpark-failed', { trigger, reason: 'error', ...hostErrorEvidence(error) });
        scheduleUnparkRetry();
        return { unparked: false, reason: 'error' };
      }
    })();
    unparkPromise = attempt;
    attempt.then(releaseSlot, releaseSlot);
    return attempt;
  };
  /** Owner bytes typed while parked: keep the real keystrokes for replay, drop
   *  the terminal's own replies (they answered the dead TUI), and resume. */
  const holdOwnerInputWhileParked = (input, ownerTyped) => {
    if (!ownerTyped) return;
    const bytes = Buffer.byteLength(input, 'utf8');
    if (heldOwnerInputBytes + bytes <= HELD_OWNER_INPUT_CAP_BYTES) {
      heldOwnerInput.push(input);
      heldOwnerInputBytes += bytes;
    }
    if (!unparkPromise) {
      try {
        stdout.write('\r\n[psu] Resuming the agent…\r\n');
      } catch {
        /* advisory */
      }
    }
    void unparkChild('owner-input');
  };
  /** Every control-socket delivery resumes a parked child before its gates run
   *  (never refused: the host accepted it, WI-10005134), and counts as busy so
   *  the policy cannot park the child out from under it. A FAILED resume holds
   *  the delivery until a later resume succeeds (P-019): running it against the
   *  pid-less stand-in would drop it without a trace. */
  const deliverAfterUnpark = async (mode, run) => {
    deliveriesInFlight++;
    try {
      if (mode !== 'osc' && parkInProgress()) {
        const resume = await unparkChild(`control:${mode}`);
        if (!resume.unparked && parked) {
          if (resume.reason === 'host-ending' || hostCleanedUp || shuttingDown) {
            return { ok: false, reason: 'host-ending' };
          }
          if (heldDeliveryWaiters.length >= HELD_DELIVERY_CAP) {
            appendHostEvent(ownerId, 'parked-delivery-refused', {
              mode,
              reason: 'held-delivery-cap',
              held: heldDeliveryWaiters.length,
            });
            return { ok: false, reason: 'unpark-failed' };
          }
          /** @type {Promise<{ ok: boolean, reason: string }>} */
          const released = new Promise((res) => heldDeliveryWaiters.push(res));
          appendHostEvent(ownerId, 'parked-delivery-held', {
            mode,
            reason: resume.reason,
            held: heldDeliveryWaiters.length,
          });
          scheduleUnparkRetry();
          const outcome = await released;
          if (!outcome.ok) return outcome;
        }
      }
      return await run();
    } finally {
      deliveriesInFlight--;
    }
  };

  // Control socket: a connector writes one v1 envelope (or legacy raw bytes);
  // we inject it into the pty (a wake turn / a force-interrupt control byte).
  // P-013: a 'turn' (wake) is deferred until the user's input line is idle so a
  // mid-keystroke human line is never corrupted; a 'raw' (force interrupt) is
  // written IMMEDIATELY (the whole point of force is to land mid-thinking).
  // EI-18676244363359331 / WI-5872: allowHalfOpen:true is LOAD-BEARING for the
  // application-level ACK below. Node's net.Server default (allowHalfOpen:false)
  // auto-ends the WRITABLE side the instant the readable side sees the client's
  // FIN ('end') — i.e. the server socket starts closing back IMMEDIATELY, before
  // the async gate pipeline below (idleGate/agentBusyGate/stale-fire/superseded
  // checks, then the actual pty write) ever runs. That auto-close is exactly what
  // makes injectIntoHost()'s client-side `c.on('close', () => finish(true))`
  // resolve true on bare TCP close alone — the close race, not any real signal of
  // delivery. allowHalfOpen:true keeps `conn` writable after 'end' fires so the
  // handler below can write a real ACK/NACK once it actually knows the outcome,
  // then close the connection itself.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const chunks = [];
    let payloadBytes = 0;
    let payloadRejected = false;
    conn.on('data', (d) => {
      if (payloadRejected) return;
      payloadBytes += d.length;
      if (payloadBytes > MAX_CONTROL_PAYLOAD_BYTES) {
        payloadRejected = true;
        chunks.length = 0;
        appendHostEvent(ownerId, 'control-payload-rejected', {
          reason: 'payload-too-large',
          receivedBytes: payloadBytes,
          maxBytes: MAX_CONTROL_PAYLOAD_BYTES,
        });
        try {
          process.stderr.write(
            `psu-pty-host: control payload REJECTED for ${ownerId} ` +
              `(${payloadBytes} bytes > ${MAX_CONTROL_PAYLOAD_BYTES} byte cap)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        conn.destroy();
        return;
      }
      chunks.push(d);
    });
    conn.on('error', () => {});
    // EI-18676244363359331 / WI-5872: the whole existing gate/delivery pipeline
    // is now wrapped in an inner IIFE that RETURNS an { ok, reason } outcome at
    // every exit (instead of a bare `return;`) — the outer wrapper writes that
    // outcome back on `conn` as an application-level ACK/NACK before closing it,
    // so a caller no longer has to infer delivery from bare TCP close timing.
    // Every existing early-exit / drop / success path below is UNCHANGED in its
    // own behavior (same gates, same logging, same side effects) — each just
    // now also reports what happened, on the same connection, before it closes.
    conn.on('end', async () => {
      const outcome = await (async () => {
      if (payloadRejected) return { ok: false, reason: 'payload-rejected' };
      const payload = Buffer.concat(chunks);
      if (!payload.length) return { ok: false, reason: 'empty-payload' };
      const msg = decodeControl(payload);
      // EI-153: MISDELIVERY guard — the sender's addressed-recipient assertion
      // (decodeOwnerIdentity) is checked against THIS host's own registered
      // ownerId before anything else runs. This is leg-independent of *why* a
      // wrong envelope reached this socket (a swapped subscriberId, a stale/
      // reused host object, a sanitizeKey collision at some OTHER layer) — no
      // matter the cause, a host that finds itself holding a control message
      // addressed to a DIFFERENT agent must refuse to act on it rather than
      // silently running another agent's work/identity in its own session (the
      // su-b6c3f → su-ff997 incident). Absent `ownerId` (a pre-EI-153 sender, or
      // a legacy non-envelope payload) is a no-op — unchanged behavior.
      if (msg.ownerId != null && msg.ownerId !== ownerId) {
        const rejectExtra = { reason: 'ownerId-mismatch', mode: msg.mode, expected: ownerId, got: msg.ownerId };
        appendHostEvent(ownerId, 'control-payload-rejected', rejectExtra);
        try {
          process.stderr.write(
            `psu-pty-host: control payload REJECTED for ${ownerId} — addressed to ${msg.ownerId} ` +
              `(mode:${msg.mode}); refusing to run another agent's turn/identity in this session (EI-153)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        return { ok: false, reason: 'ownerId-mismatch' };
      }
      // WI-2141435: the guard above calls appendHostEvent ONLY on its reject path, so
      // its silence cannot distinguish "no violations" from "structurally blind to this
      // class" — an ownerId-less payload takes the documented no-op branch above and
      // leaves NO trace at all. Measured on WI-2140968: control-payload-rejected had
      // fired 128 times, EVERY one in an su-itest-misdeliver-* fixture and none in a
      // real session, across a period in which 9 real cross-owner deliveries provably
      // occurred. A firing count of zero was reporting blindness as cleanliness.
      //
      // DETECTOR ONLY — control flow is deliberately unchanged: an unaddressed payload
      // is still accepted exactly as before. Refusing it is a separate, later step
      // (WI-2141435 step 2), gated on this detector first showing a clean production
      // population — an older still-running sender that omits ownerId would otherwise
      // have every delivery refused fleet-wide, and host-code-stale is real and ongoing.
      if (msg.ownerId == null) {
        try {
          let v1 = false;
          try {
            v1 = JSON.parse(payload.toString('utf8'))?.v === 1;
          } catch {
            /* not JSON at all — a genuinely legacy raw payload */
          }
          appendHostEvent(ownerId, 'control-payload-unaddressed', {
            reason: 'no-ownerId',
            mode: msg.mode,
            bytes: payload.length,
            // true  ⇒ a v1 envelope that simply OMITTED ownerId (a pre-EI-153 sender)
            // false ⇒ decodeControl's legacy promotion of a NON-envelope payload
            envelope: v1,
          });
        } catch {
          /* a detector must never be able to affect delivery */
        }
      }
      // EI-19311270129974785: a RETRY of a delivery this host has already accepted
      // is short-circuited before any mode-specific state mutation. Pending means
      // the detached pipeline has not committed a write yet; completed means the
      // original delivery reached its commitment point. A terminal failed/deferred
      // pipeline clears pending below so a later retry remains eligible.
      // Absent/empty deliveryId (a one-shot raw/osc/compact/mcp-reconnect call, or a
      // pre-fix sender) makes this a no-op — unchanged behavior.
      const duplicateState = deliveryDedup.state(msg.deliveryId);
      if (duplicateState) {
        // EI-21428742689578243: `accepted` means the FIRST copy can wait behind
        // the host's busy/composer gates for minutes. During that wait the durable
        // pump retries the SAME delivery id, and executeWake rehydrates its text
        // from the latest loop:checkpoint. Pre-fix, the id-dedup returned here
        // before the turn coalescer could see those fresh bytes, so the eventually
        // delivered banner combined an enqueue-time checkpoint with a newer age.
        // Refresh only a still-pending LOOP waiter. It remains ONE logical delivery
        // (folded is unchanged), completed ids remain immutable, and a waiter that
        // already claimed its slot is deliberately not resurrected.
        const pendingLoopKey =
          duplicateState === 'pending' && msg.mode === 'turn' && msg.routineId
            ? turnCoalesceKey(msg.data, msg.routineId, ownerId)
            : null;
        const pendingLoopMetadata =
          msg.routineId && msg.fireNumber != null
            ? { routineId: msg.routineId, fireNumber: msg.fireNumber }
            : undefined;
        const refreshedPendingTurn =
          pendingLoopKey != null
            ? turnCoalescer.refresh(pendingLoopKey, msg.data, pendingLoopMetadata)
            : false;
        const refreshedPendingCarryRespawn =
          duplicateState === 'pending' && msg.mode === 'carry-respawn' && !msg.drillId
            ? carryRearm.refreshPendingMessage(msg)
            : false;
        const duplicateReason =
          duplicateState === 'pending' ? 'pending-delivery-id' : 'duplicate-delivery-id';
        appendHostEvent(ownerId, 'duplicate-delivery-id', {
          state: duplicateState,
          mode: msg.mode,
          refreshedPendingTurn,
          refreshedPendingCarryRespawn,
        });
        try {
          writeHostDiagnostic(
            `psu-pty-host: duplicate delivery id ${msg.deliveryId} for ${ownerId} short-circuited ` +
              `(${duplicateState}, mode:${msg.mode}${refreshedPendingTurn ? ', queued text refreshed' : ''})\n`,
          );
        } catch {
          /* diagnostic only */
        }
        return { ok: true, reason: duplicateReason };
      }
      // SHUTDOWN (WI-6638) — wind this session down and EXIT, closing its tab.
      //
      // Handled HERE, before the coalescer / carry-rearm / inject gates: those all
      // exist to schedule a FUTURE turn, and the whole premise of a shutdown is that
      // there will not be one. Deliberately NOT routed through the reaper's kill path
      // either — measured 2026-08-03, every psu session classifies
      // driveMode:'responsive' and is excluded from the live-idle cohort by the
      // queen-fleet-authority-boundary ruling (P-001/D-001) long before the window
      // guard is consulted. A system reaper may not kill these; only the session
      // itself may exit. This signals nothing but our OWN child.
      if (msg.mode === 'shutdown') {
        if (shuttingDown) return { ok: true, reason: 'already-shutting-down' };
        const refusal = shutdownRefusalReason({
          launchedBy: env.PAPERCUSP_LAUNCHED_BY,
          headless: bridgeTty === false,
          fleetSlug: env.PAPERCUSP_FLEET_SLUG,
          lastInputAt: activity.snapshot().lastInputAt ?? 0,
          agentQuietMs: agentBusyGate.quietForMs(),
          force: msg.force === true,
        });
        if (refusal) {
          appendHostEvent(ownerId, 'shutdown-refused', { reason: refusal, note: msg.data || '' });
          return { ok: false, reason: `shutdown-refused:${refusal}` };
        }
        shuttingDown = true;
        appendHostEvent(ownerId, 'shutdown-accepted', {
          note: msg.data || '',
          forced: msg.force === true,
        });
        try {
          process.stderr.write(
            `psu-pty-host: SHUTDOWN accepted for ${ownerId}${msg.data ? ` — ${msg.data}` : ''}; ` +
              `winding the session down and closing this terminal.\n`,
          );
        } catch {
          /* diagnostic only */
        }
        // DEFERRED so the ACK gets out first. The kill leads (via the child's own
        // exit) to cleanup → onExit → psu `process.exit`, which tears down this very
        // socket — killing synchronously here would race the ack write below
        // (conn.write at the end of this handler) and the requester would read a
        // successful shutdown as a `timeout`/`send-failed` miss.
        //
        // SIGHUP lets the TUI flush its transcript; the child's exit then runs the
        // normal cleanup path and psu exiting closes the `gnome-terminal --wait` tab.
        // The escalation timer is the backstop for a child that ignores SIGHUP.
        setTimeout(() => {
          try {
            killPtyProcessTree(child, 'SIGHUP');
          } catch {
            /* the escalation below still covers it */
          }
          const escalate = setTimeout(() => {
            try {
              killPtyProcessTree(child, 'SIGKILL');
            } catch {
              /* nothing further we can do */
            }
          }, SHUTDOWN_GRACE_MS);
          if (typeof escalate.unref === 'function') escalate.unref();
        }, SHUTDOWN_ACK_DELAY_MS);
        // NOT unref'd: this timer is the shutdown itself, and an unref'd one would
        // let an otherwise-idle host exit the event loop before it ever fires.
        return { ok: true, reason: 'shutdown-accepted' };
      }
      // EI-18679681961154136: a carry-respawn re-arm retry is PENDING for this
      // owner (an earlier busy-gate defer, now re-polling for the next idle
      // window — see makeCarryRearmController). An ordinary wake `turn` must
      // NOT be allowed to compete for that same idle window: the rearm loop
      // RELEASES the inject mutex between attempts (deliberately, so ordinary
      // wakes are never wedged waiting on it) — but that means a ready-to-fire
      // wake can win the race for every idle window the rearm loop is polling
      // for, opening a fresh turn that makes the agent busy again before the
      // rearm's own next attempt lands. Repeat that indefinitely (a busy,
      // well-connected agent keeps receiving wakes) and the carry-respawn is
      // starved forever — observed + diagnosed end-to-end on 2026-07-26. The
      // wake is already durable mail (coord/loop redeliver it), so it loses
      // nothing by skipping this live injection: defer it exactly like an
      // ordinary busy-gate refusal (queue-to-next-turn), and let the rearm
      // loop's next attempt have the idle window uncontested. Scoped to
      // `mode:'turn'` only — reset/recycle/mcp-reconnect stay unaffected;
      // they are already explicit operator/owner actions, not routine wakes.
      if (shouldDeferWakeForPendingRespawn(msg.mode, carryRearm.pendingCount('carry-respawn'))) {
        const dropExtra = { reason: 'carry-respawn-pending' };
        appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', dropExtra);
        // This is an internal delivery-ordering decision, not an agent-facing
        // failure. The durable host event above is the diagnostic surface; the
        // host's stderr is the owner's TUI, so writing the same state there
        // interrupts the agent with a message that looks like a stop signal.
        return { ok: false, reason: 'deferred-carry-respawn-pending' };
      }
      // EI-18109211232286833: stamp the receipt time ONCE, here, so both this
      // delivery attempt and its one makeCarryRearmController retry (which
      // reuses this same `msg` object — see carryRearm.schedule below) measure
      // TOTAL elapsed wait against isCarryRespawnStale, not a per-attempt one.
      if (msg.mode === 'carry-respawn' && msg.receivedAtMs == null) {
        msg.receivedAtMs = Date.now();
      }
      // EI-18681914950138372: mark this carry-respawn in-flight NOW, before it
      // ever enters its own busy-gate wait below — this is what closes the
      // starvation gap (see beginFirstAttempt's doc comment on
      // makeCarryRearmController). Cleared exactly once, whichever way this
      // attempt concludes, via the runGatedDelivery().finally() below.
      if (msg.mode === 'carry-respawn') {
        carryRearm.beginFirstAttempt(msg);
      }
      // P-001a: a same-source turn already waiting at the gates absorbs this one —
      // newest text wins, the waiter delivers ONE annotated turn. Only mode:'turn'
      // (never reset/recycle/compact — lifecycle verbs are not duplicates of work).
      const coalesceKey = msg.mode === 'turn' ? turnCoalesceKey(msg.data, msg.routineId, ownerId) : null;
      const coalesceMetadata =
        msg.routineId && msg.fireNumber != null
          ? { routineId: msg.routineId, fireNumber: msg.fireNumber }
          : undefined;
      const coalescedDeliveryIds = new Set(msg.deliveryId ? [msg.deliveryId] : []);
      const claimCoalesced = () => {
        const claimed = coalesceKey != null ? turnCoalescer.claim(coalesceKey) : null;
        for (const deliveryId of claimed?.deliveryIds ?? []) coalescedDeliveryIds.add(deliveryId);
        return claimed;
      };
      if (coalesceKey != null && turnCoalescer.admit(coalesceKey, msg.data, coalesceMetadata, msg.deliveryId)) {
        appendHostEvent(ownerId, 'queued-turn-folded', { mode: msg.mode, routineId: msg.routineId ?? null });
        try {
          writeHostDiagnostic(
            `psu-pty-host: duplicate queued turn FOLDED for ${ownerId} (same-source coalesce, P-001a)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        // EI-19311270129974785 / F03: this delivery id is accepted into the
        // pending waiter's one write, but it is NOT completed until that parent
        // pipeline commits. If the parent defers or errors, the parent outcome
        // clears this ID too so the durable pump can retry it.
        if (msg.deliveryId) deliveryDedup.markPending(msg.deliveryId);
        return { ok: true, reason: 'coalesced-into-pending-turn' };
      }
      // EI-18679050054551625 (WI-5872 follow-up #2): everything from here down —
      // mutex acquire, the human-idle + agent-busy GATES, the actual pty write,
      // submit verification, and recycle/carry-respawn — can legitimately take
      // anywhere from milliseconds (an idle agent) to the FULL busy-gate cap
      // (production PAPERCUSP_PSU_PTY_BUSY_CAP_MS, or a multi-second recycle) to
      // resolve. The very first version of the ACK protocol awaited all of this
      // before acking, which meant injectIntoHost()'s default 2000ms client
      // timeout fired on almost every gated delivery, incl. ones that landed
      // perfectly (deferred-then-delivered, capped-then-dropped-but-durable,
      // etc) — the original 9/10-red regression this work item tracks. A first
      // pass fixed the two SLOWEST tails (verifySubmitted, recycleChild) to run
      // in the background, which was necessary but not sufficient: the GATE
      // WAIT itself (waitAtPrompt, up to the full busy cap) still blocked the
      // ack, which a still-red subset of this same test file's assertions
      // depend on NOT happening (each expects `ok` to resolve promptly —
      // representing "accepted for processing" — checked BEFORE the busy
      // window elapses, with the actual write/drop verified separately via the
      // captured pty output on its own timeline).
      //
      // So: ack 'accepted' HERE, before any gate/mutex/write runs, for any
      // message that reached this point (payload validated, correctly
      // addressed, not a coalesce-duplicate) — mirroring the coalesce fast-path
      // just above, which already returns immediately. Run the entire
      // mutex+gate+delivery pipeline as a detached background continuation;
      // every outcome it reaches (deferred/dropped/delivered/error) is already
      // durably recorded via appendHostEvent()/process.stderr.write() calls
      // inside it, exactly as a caller under the OLD bare-close-is-`true`
      // protocol would have had to learn it — from the durable event log or
      // the pty's own output, never from this ACK.
      const runGatedDelivery = async () => {
      // EI-8822: hold the per-host inject mutex across the ENTIRE gated
      // critical section (gate wait → pty write → submit verify) so a wake
      // `turn` and a session:request-compaction `/compact` freed at the SAME
      // clean boundary run one-at-a-time and never interleave into one input
      // line. Ungated raw/osc bypass it — a force-interrupt byte must land
      // immediately (mid-turn), and osc writes the display, not the input line.
      const releaseInject = msg.gated ? await injectMutex.acquire() : null;
      let deferMutexRelease = false;
      const deferForOwnerInput = (reason) => {
        const pendingLength = ownerComposerGate.pendingLength();
        const extra = {
          mode: msg.mode,
          reason,
          pendingLength,
          // WI-38156 forensics. A phantom line is distinguishable from a real
          // one by these two numbers alone: a person either finishes a line or
          // abandons it, so a line staged for a long time whose length never
          // moves and which has received no owner byte since is not a person.
          pendingAgeMs: ownerComposerGate.pendingAgeMs(),
          ownerQuietMs: ownerComposerGate.ownerQuietMs(),
        };
        appendHostEvent(ownerId, 'turn-deferred-for-owner-input', extra);
        noteOwnerInputDefer(pendingLength);
        // P-006: durable trace is the appendHostEvent above; this terminal copy
        // is redundant and, on a bridged TTY, lands in the owner's own TUI.
        writeHostDiagnostic(
          `psu-pty-host: ${msg.mode} DEFERRED for ${ownerId} (${reason}) — ` +
            'owner has an unsubmitted input line; left in inbox for the next natural turn\n',
        );
        // P-001a: a deferred waiter must release its coalesce slot; a later wake
        // must be able to start a fresh delivery after the owner submits/cancels.
        claimCoalesced();
        return { ok: false, reason: 'deferred-owner-input' };
      };
      try {
        if (msg.gated) {
          // (1) Human keystroke gate (P-013): don't corrupt a line the user is
          // mid-typing. Only meaningful when there IS a bridged terminal a human
          // could be typing into.
          if (bridgeTty) {
            const idle = await idleGate.waitIdle();
            if (idle.deferred) return deferForOwnerInput(idle.reason || 'idle-cap');
            // Idle is not submission. If the owner paused with text still in
            // the composer, wait for Enter/Ctrl-C/Ctrl-U, bounded like idle.
            if (ownerComposerGate.hasPending()) {
              // WI-38257: a staged line that has stopped tracking a person must not be
              // able to defer wakes forever. Checked BEFORE the wait, because the wait
              // is what burns the cap — that is where the 112s of dead agent came from.
              if (!breakComposerWedgeIfConfirmed()) {
                const clear = await ownerComposerGate.waitClear();
                if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
              }
            }
          }
          // (2) Agent mid-turn gate (coord-wake-mid-turn-2026-06-30 /
          // clean-boundary-only-kill WI-1818, D-006): don't write a wake `turn`
          // into a TUI that is still generating (wedges it, needs ESC), and —
          // load-bearing for `reset`/`recycle` — never KILL the current child
          // while it is mid-turn (an uncommitted in-flight turn would be lost;
          // the carry-note is only as fresh as the LAST settled turn). This check
          // is a pure read of the activity tracker, unrelated to TTY bridging, so
          // it applies UNCONDITIONALLY for every gated verb (bridgeTty or not) —
          // gating it on bridgeTty left reset/recycle unguarded whenever the host
          // ran without a bridged terminal.
          // P-003: use the NATIVE turn-boundary proof for every registered
          // backend and every gated mode — not just codex, and not just
          // carry-respawn/turn.
          //
          // What this replaces: the two call sites below resolved to codex-only
          // probes, so a claude or omp session gated on output-silence ALONE. On
          // a repainting TUI that proxy is defeated by construction — the pty is
          // never quiet for OUTPUT_QUIET_MS even when the agent is parked at its
          // prompt — so the wake burned the full cap and deferred.
          //
          // Extending it to reset/recycle is deliberate, not incidental: those
          // verbs KILL the child, and "the native turn completed" is far better
          // evidence that no in-flight work will be lost than "the pty went
          // quiet for 1.5s".
          //
          // carry-respawn keeps its PINNED transcript rather than following the
          // newest one. That strictness is load-bearing (see the probe's
          // docstring: never accept another session's or an older turn's
          // completion), so an absent sourceTranscriptPath must fall back to the
          // output gate, NOT silently widen to the newest transcript.
          const { boundary: verifiedBoundary, support: verifierSupport } = verifiedBoundaryFor(msg);
          const atPrompt = await agentBusyGate.waitAtPrompt(undefined, verifiedBoundary);
          if (atPrompt.deferred) {
            // Agent stayed mid-turn past the cap. DROP the live inject/kill rather
            // than wedge the turn or lose in-flight work — the wake is already
            // durably in the recipient's inbox and is seen on its next natural
            // turn (queue-to-next-turn); a reset/recycle refused here simply never
            // fires this cycle (no partial kill, no data loss).
            // P-006: this is THE line the owner reported seeing (2026-09-22,
            // session 25a7969c). The defer it reports was correct; the durable
            // record is the busy-gate-expired event appended just below.
            writeHostDiagnostic(
              `psu-pty-host: ${msg.mode} DEFERRED/REFUSED for ${ownerId} ` +
                `(agent mid-turn > ${turnInjectBusyCapMs}ms cap); ` +
                `left in inbox for the next natural turn\n`,
            );
            // EI-19480099650947832: record WHY the delivery could not fire, not
            // just that it didn't. `busy-gate-expired` alone cannot distinguish a
            // genuinely-busy agent (longest quiet gap ≈ 0ms — something is
            // redrawing the pty continuously) from a near-miss (gap ≈ quietMs —
            // the threshold is simply too tight), and those have OPPOSITE fixes.
            //
            // WI-2141048: this row is emitted for EVERY deferred mode, and is
            // deliberately NOT nested inside the carry-respawn branch below. It
            // used to be, which meant a `turn`/`reset`/`recycle` killed by this
            // gate left a stderr line and nothing durable — so a member that
            // booted and never took a turn was undiagnosable after the fact. A
            // census of the full ~/.papercusp/psu-pty event-log population
            // (6,795 logs, 2026-09-02) found 11,544 carry-respawn rows and ZERO
            // turn-mode siblings of any spelling, confirming the whole non-respawn
            // half of this gate was invisible. `mode` carries what the old
            // kind-name encoded, so this is one row per defer, never two.
            appendHostEvent(ownerId, 'busy-gate-expired', {
              mode: msg.mode,
              capMs: turnInjectBusyCapMs,
              observedMaxQuietMs: Number.isFinite(atPrompt?.maxQuietForMs) ? atPrompt.maxQuietForMs : null,
              quietMs: Number.isFinite(atPrompt?.quietMs) ? atPrompt.quietMs : null,
              // P-003: whether a NATIVE boundary proof was even available for
              // this defer. Without it, a defer on a repainting claude TUI is
              // indistinguishable from one on a genuinely busy agent, which is
              // what made the codex-only wiring invisible for so long.
              verifier: verifierSupport.reason ?? 'supported',
            });
            // EI-12655 (fix b, leader-concurred rider: "expired must FAIL LOUD")
            // + EI-12754 (the re-arm leg deferred out of that diff) + WI-5368/
            // WI-5530: a carry-respawn refused here previously vanished with ZERO
            // durable trace, then (post-EI-12655) terminally dropped on the FIRST
            // refusal — and, worse, a PRODUCTION (non-drill) respawn was never
            // even scheduled (this branch gated on `msg.drillId`), so every
            // busy-gate-deferred session:request-compaction was silently lost.
            // Now BOTH drill and production respawns re-queue exactly ONE deferred
            // retry at the next settled turn via makeCarryRearmController (which
            // emits the durable rearm-queued row and, on a second refusal or an
            // error, the terminal drop) — so op:'report' / op:'verify' always see
            // a durable outcome, and a busy-but-recovering session no longer loses
            // its respawn to one long turn. A duplicate schedule (a retry already
            // pending for this key) drops terminally here. The diagnostic row
            // above is emitted unconditionally; this branch owns only the
            // carry-respawn LIFECYCLE verdict (rearm-queued / superseded / drop).
            if (msg.mode === 'carry-respawn') {
              const rearmVerdict = carryRearm.schedule(msg);
              // EI-19480099650947832: a PRODUCTION respawn arriving while an
              // earlier one is still re-polling now SUPERSEDES it (the fresher
              // carry document wins) instead of being terminally dropped. This
              // row is deliberately NON-terminal: nothing was lost, the pending
              // re-poll simply adopted this payload, so op:'report'/'verify'
              // must keep waiting for that loop's own delivered/dropped row.
              if (rearmVerdict === 'superseded') {
                const supExtra = {
                  mode: 'carry-respawn',
                  reason: 'superseded-pending-rearm',
                  capMs: turnInjectBusyCapMs,
                };
                appendHostEvent(ownerId, 'respawn-rearm-superseded', supExtra);
                appendSharedDrillLedgerEvent(ownerId, 'respawn-rearm-superseded', supExtra);
              }
              if (rearmVerdict === 'duplicate') {
                const isDrill = !!msg.drillId;
                const dropKind = isDrill ? 'carry-drill-carry-dropped' : 'respawn-carry-dropped';
                const dropExtra = isDrill
                  ? {
                      drillId: msg.drillId,
                      sessionClass: msg.sessionClass ?? '',
                      reason: 'busy-gate-expired',
                      capMs: turnInjectBusyCapMs,
                      rearmed: true,
                    }
                  : {
                      mode: 'carry-respawn',
                      reason: 'busy-gate-expired',
                      capMs: turnInjectBusyCapMs,
                      rearmed: true,
                    };
                appendHostEvent(ownerId, dropKind, dropExtra);
                appendSharedDrillLedgerEvent(ownerId, dropKind, dropExtra);
                return { ok: false, reason: 'carry-rearm-duplicate' };
              }
            }
            // P-005: a deferred wake `turn` is RE-ARMED, exactly as a
            // carry-respawn already was.
            //
            // It used to be abandoned here to a "next natural turn" that never
            // arrives for a session which parks after the turn that caused the
            // defer: the wake sits unread in the inbox and nothing re-invokes
            // the agent. Measured: 1,927 turn-mode wakes over 7 days.
            //
            // The re-arm verdict is reported on the DURABLE event below, not by
            // widening this function's return. Two reasons: the durable row is
            // the authoritative record a later census can actually read, and
            // `return { ok: false, reason: 'deferred-busy-gate' };` is the
            // literal `psu-pty-busy-gate-durable-evidence.test.ts` uses to
            // delimit this whole block. Adding a field there silently
            // un-anchors that guard (it caught exactly that on first attempt),
            // and a weakened guard is a worse trade than a slightly less
            // informative reply. The duplicate case gets its own reason,
            // mirroring the existing 'carry-rearm-duplicate'.
            if (msg.mode === 'turn') {
              const turnVerdict = carryRearm.schedule(msg);
              appendHostEvent(ownerId, 'wake-rearm-scheduled', {
                mode: msg.mode,
                verdict: turnVerdict,
                capMs: turnInjectBusyCapMs,
                verifier: verifierSupport.reason ?? 'supported',
              });
              if (turnVerdict === 'duplicate') {
                // An earlier re-arm for this mode already owns delivery; a
                // second one would double-inject the same wake.
                claimCoalesced();
                return { ok: false, reason: 'turn-rearm-duplicate' };
              }
            } else if (msg.mode !== 'carry-respawn') {
              // D-004: this mode has no registered re-arm. Record the residue so
              // it stays countable in the P-007 telemetry instead of being
              // rediscovered by a future census.
              appendHostEvent(ownerId, 'wake-rearm-unsupported', {
                mode: msg.mode,
                reason: 'no-registered-delivery',
                capMs: turnInjectBusyCapMs,
              });
            }
            // P-001a: clear the coalesce slot on defer — wakes folded into this
            // waiter are dropped WITH it (same queue-to-next-turn semantics), and
            // later arrivals must start a fresh cycle, never fold into a dead one.
            claimCoalesced();
            return { ok: false, reason: 'deferred-busy-gate' };
          }
          // WI-1386682 (2): don't spend a wake `turn`/`reset` inject into a
          // session sitting on Claude's own usage-limit wall. The pty is
          // quiet for the SAME reason a settled prompt is quiet — no output —
          // so the busy-gate above (agent-busy vs at-prompt) cannot tell them
          // apart and just cleared this message to proceed. Writing text+CR
          // into a walled screen is pure waste: the CR queues into the
          // composer (or is dropped outright) and verifySubmitted's later
          // resubmit CRs (WI-2930) are equally futile, all spent against an
          // agent that cannot answer until the wall lifts. Deferring here
          // uses the SAME queue-to-next-turn contract as the busy-gate defer
          // just above — nothing is lost, the message stays durably in the
          // recipient's inbox for a real turn once quota resets, a
          // recycle/respawn replaces the child, or the owner intervenes.
          // Scoped to turn/reset only: recycle/carry-respawn intentionally
          // still proceed even while walled — a walled session still
          // deserves the fresh child the owner asked for, and never letting
          // ANY submit path (including those) be host-fatal while
          // quota-blocked is prevented by the live submit-verifier gate — and
          // mcp-reconnect/raw/osc never reach this branch (already returned
          // above, or ungated).
          if ((msg.mode === 'turn' || msg.mode === 'reset') && quotaBlockDetector.isBlocked()) {
            const extra = { mode: msg.mode, reason: 'quota-blocked' };
            appendHostEvent(ownerId, 'turn-deferred-quota-blocked', extra);
            // WI-10003875: this deferral IS the gated-injection attempt the
            // starvation guard counts. The guard was built and unit-tested but
            // never fed, so an 18h prose-latched wedge (32 deferrals) emitted
            // zero quota-block-starvation signals.
            observeQuotaBlockStarvation({ attempted: true });
            // P-006: durable trace is the turn-deferred-quota-blocked event above.
            writeHostDiagnostic(
              `psu-pty-host: ${msg.mode} DEFERRED for ${ownerId} (quota-blocked; ` +
                `usage-limit banner on screen) — left in inbox for the next natural turn\n`,
            );
            claimCoalesced();
            return { ok: false, reason: 'deferred-quota-blocked' };
          }
          // The agent gate above yields to the event loop. Re-check immediately
          // before the write in case the owner began composing during that wait.
          if (ownerComposerGate.hasPending()) {
            // WI-38257: a staged line that has stopped tracking a person must not be
            // able to defer wakes forever. Checked BEFORE the wait, because the wait
            // is what burns the cap — that is where the 112s of dead agent came from.
            if (!breakComposerWedgeIfConfirmed()) {
              const clear = await ownerComposerGate.waitClear();
              if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
            }
          }
        }
        // WI-5510: STALE-FIRE GUARD. Once a message has passed every gate above
        // and is ABOUT to be delivered, check + commit it against the last fire
        // number this host has delivered for its loop instance (routineId).
        // Placed here — after the busy-gate wait, before any write/recycle —
        // because this is the true "about to deliver" moment: a message that was
        // still gate-waiting while a LATER fire for the same loop already cleared
        // its own wait and delivered is exactly the stale-mid-turn-flush race
        // this guard exists to close (see makeStaleFireGuard's doc block). Only
        // messages carrying BOTH `routineId` + `fireNumber` (a loop-fire wake
        // from a WI-5510-aware sender) are guarded; an ordinary coord wake or
        // owner-typed injection (neither field set) always admits, unaffected.
        if (msg.fireNumber != null && msg.routineId) {
          const verdict = staleFireGuard.admit(msg.routineId, msg.fireNumber);
          if (!verdict.admit) {
            const dropExtra = {
              routineId: msg.routineId,
              fireNumber: msg.fireNumber,
              lastDelivered: verdict.lastDelivered,
              mode: msg.mode,
            };
            appendHostEvent(ownerId, 'stale-fire-dropped', dropExtra);
            try {
              process.stderr.write(
                `psu-pty-host: STALE fire #${msg.fireNumber} DROPPED for ${ownerId} ` +
                  `(routine ${msg.routineId} already delivered fire #${verdict.lastDelivered}; ` +
                  `mode:${msg.mode}) — superseded by a later fire, never written\n`,
              );
            } catch {
              /* diagnostic only */
            }
            // Same coalesce-slot hygiene as the busy-gate defer path just above —
            // a dropped waiter must release any same-source turn folded into it,
            // never black-hole it; a later arrival starts a fresh cycle.
            claimCoalesced();
            return { ok: false, reason: 'stale-fire-dropped' };
          }
        }
        // EI-18109211232286833: CARRY-RESPAWN STALENESS GUARD. Placed here —
        // after every gate wait, immediately before the delivery it would
        // otherwise perform — because this is the true "about to deliver"
        // moment (same placement rationale as the stale-fire guard just
        // above): a carry-respawn is a snapshot of the world taken when it was
        // built, and one held this long by the busy-gate (+ its one
        // carryRearm re-arm) is no longer trustworthy even though it carries
        // no routineId/fireNumber for the stale-fire guard to catch.
        // EI-18665672258948707: SUPERSEDED GUARD, same placement — a later
        // respawn may have already fired on this host (e.g. the client-side
        // injectIntoHost() write for THIS message appeared to time out, the
        // calling agent retried, and the retry's carry-respawn already delivered
        // and spawned a real successor) while this message sat gate-waiting.
        // Unconditional on age: a superseded carry-respawn is never the right one
        // to deliver, however fresh. Checked separately from staleness so the
        // event log records the true reason.
        const superseded =
          msg.mode === 'carry-respawn' && isCarryRespawnSuperseded(msg.receivedAtMs, lastRespawnAtMs);
        // Age expiry is a bounded DRILL safeguard only. A production
        // carry-respawn is the successor's only context continuation and must
        // remain deliverable even when the first busy-gate wait consumes the
        // configured age window. Production carries are still rejected by the
        // unconditional epoch-supersession check above, so an older snapshot
        // cannot replace a newer successor.
        const stale =
          !superseded &&
          msg.mode === 'carry-respawn' &&
          Boolean(msg.drillId) &&
          isCarryRespawnStale(msg.receivedAtMs, { maxAgeMs: carryRespawnMaxAgeMs });
        if (superseded || stale) {
          const ageMs = msg.receivedAtMs != null ? Date.now() - msg.receivedAtMs : null;
          const dropExtra = superseded
            ? { mode: 'carry-respawn', reason: 'superseded', ageMs, lastRespawnAtMs }
            : { mode: 'carry-respawn', reason: 'carry-stale', ageMs, maxAgeMs: carryRespawnMaxAgeMs };
          appendHostEvent(ownerId, 'respawn-carry-dropped', dropExtra);
          appendSharedDrillLedgerEvent(ownerId, 'respawn-carry-dropped', dropExtra);
          try {
            process.stderr.write(
              superseded
                ? `psu-pty-host: SUPERSEDED carry-respawn DROPPED for ${ownerId} ` +
                    `(a later respawn already fired at ${lastRespawnAtMs}, this message arrived ` +
                    `${msg.receivedAtMs}) — never delivered, would have discarded a live successor\n`
                : `psu-pty-host: STALE carry-respawn DROPPED for ${ownerId} ` +
                    `(age ${ageMs}ms > ${carryRespawnMaxAgeMs}ms cap) — never delivered\n`,
            );
          } catch {
            /* diagnostic only */
          }
          claimCoalesced();
          return { ok: false, reason: superseded ? 'superseded' : 'carry-stale' };
        }
        // RECYCLE (su-cold-auto-mode P-004b): a hard cold reset — kill + respawn
        // the child in THIS host, then open the fresh process on the carry-note.
        // Codex RESET-CONTEXT is backend-aware: `/new` does not discard the
        // long-lived process context, so Codex reset envelopes take this same
        // hard path. The gate above already guaranteed a settled turn
        // (D-006 clean-boundary). Other reset/turn/raw/osc messages fall through
        // to the write plan below.
        const hardReset =
          msg.mode === 'recycle' ||
          msg.mode === 'carry-respawn' ||
          (msg.mode === 'reset' &&
            coldResetModeForAgent(env.PAPERCUSP_AGENT, liveChildArgs) === 'recycle');
        if (hardReset) {
          // measured-agent-productivity P-004: a quota recovery is a durable
          // operation, not a fire-and-forget lifecycle request. The outer socket
          // already ACKed `accepted`, so waiting here does not hold the caller;
          // it only keeps this delivery id PENDING until the existing recycle
          // path has proved the successor's native turn start. A later retry then
          // sees completed dedup state, while wake-executor independently waits
          // for the same owner's first productive tool invocation.
          if (msg.mode === "recycle" && msg.quotaRecovery) {
            appendHostEvent(ownerId, "quota-recovery-started", {
              operationId: msg.quotaRecovery.operationId,
              recoveryOwnerId: msg.quotaRecovery.ownerId,
              startedAtMs: msg.quotaRecovery.startedAtMs,
              accountRoutingMode: "auto",
            });
            const recovery = await recycleChild(msg.data, {
              quotaRecovery: msg.quotaRecovery,
            });
            return recovery?.delivered
              ? { ok: true, reason: "quota-recovery-delivered" }
              : {
                  ok: false,
                  reason: `quota-recovery-${recovery?.reason ?? "failed"}`,
                };
          }
          // The socket ACK already went out before runGatedDelivery() started,
          // so waiting here no longer risks the caller's short ACK timeout.
          // Keep the delivery id pending until recycleChild() proves the fresh
          // epoch's carry turn, then let the settlement below mark it completed
          // (or clear it for a durable retry). Returning "delivered" before this
          // promise settles permanently deduped failed carries and made a
          // transient argv/spawn/native-proof failure look successful.
          const recycleResult = await recycleChild(msg.data, {
            systemPromptAddendum:
              msg.mode === "carry-respawn" ? msg.systemPromptAddendum : "",
            drillId: msg.mode === "carry-respawn" ? msg.drillId : "",
            sessionClass: msg.mode === "carry-respawn" ? msg.sessionClass : "",
          });
          if (recycleResult?.delivered) return { ok: true, reason: "delivered" };
          return {
            ok: false,
            reason: recycleResult?.reason ?? "recycle-failed",
          };
        }
        // COMPACT — RETIRED (P-022, 2026-07-18): native compaction is removed
        // fleet-wide; carry-respawn above is the only context cut, and every
        // psu Claude child runs with DISABLE_COMPACT (the command doesn't even
        // exist to type). A mode:'compact' arriving here means a STALE
        // pre-P-022 sender is still running old code (the EI-16190 class: a
        // long-lived host process, e.g. bg-host, never restarted after the
        // cutover). Drop it LOUDLY — an absorbed stale message hid a broken
        // fleet enforcer for ~13h; a screaming one gets its sender restarted.
        if (msg.mode === 'compact') {
          appendHostEvent(ownerId, 'retired-mode-dropped', {
            mode: 'compact',
            hint: 'stale pre-P-022 sender still running (EI-16190) — find and restart it',
          });
          try {
            process.stderr.write(
              `psu-pty-host: mode:compact DROPPED for ${ownerId} — retired by P-022 (carry-respawn is the only ` +
                `context cut); a stale pre-cutover sender is still running (EI-16190): find and restart that process\n`,
            );
          } catch {
            /* diagnostic only */
          }
          return { ok: false, reason: 'retired-mode-dropped' };
        }
        // MCP-RECONNECT (mcp-transport-resilience P-003, 2026-07-13): drive the
        // claude TUI's /mcp dialog to re-attach a dead HTTP-MCP server IN PLACE.
        // The gates above already guaranteed a settled turn + quiet input line.
        // Claude-only: the dialog walker is pinned to the claude TUI; other
        // backends drop durably with an event-log row. Truth
        // of the heal is judged operator-side (presence beat, P-005) — the host
        // event is advisory.
        if (msg.mode === 'mcp-reconnect') {
          const agent = String(env.PAPERCUSP_AGENT || 'claude');
          if (agent !== 'claude') {
            appendHostEvent(ownerId, 'mcp-reconnect-dropped', {
              reason: 'unsupported-backend',
              backend: agent,
            });
            return { ok: false, reason: 'mcp-reconnect-unsupported-backend' };
          }
          const serverName = String(msg.data ?? '').trim() || 'papercusp-su';
          const tap = makeOutputTap();
          appendHostEvent(ownerId, 'mcp-reconnect-started', { serverName });
          try {
            const result = await runMcpReconnectMacro({
              serverName,
              write: (b) => child.write(b),
              readTap: tap.read,
              resetTap: tap.reset,
              crDelayMs: turnSubmitCrDelayForAgent(agent, env),
            });
            appendHostEvent(ownerId, result.ok ? 'mcp-reconnect-completed' : 'mcp-reconnect-failed', {
              serverName,
              step: result.step,
              detail: result.detail,
            });
            // P-006 (completing the class): this is a FOURTH routine host
            // diagnostic that writes straight into the owner's TUI — it fires on
            // every mcp-reconnect, success included. The original P-006 pass
            // routed the three busy-gate defer sites and missed this one, which
            // would have left the reported symptom half-fixed and re-armed for
            // the next reader. writeHostDiagnostic is itself fail-soft, so the
            // local try/catch it replaces is redundant.
            writeHostDiagnostic(
              `psu-pty-host: mcp-reconnect ${result.ok ? 'OK' : 'FAILED'} for ${ownerId} ` +
                `(${serverName}: ${result.step} — ${result.detail})\n`,
            );
            return { ok: result.ok, reason: result.ok ? 'delivered' : 'mcp-reconnect-failed', detail: result.detail };
          } finally {
            tap.close();
          }
        }
        // mode:'osc' targets the terminal DISPLAY — the host's stdout IS the
        // visible window — so a fleet:join recolors the LIVE window. Every other
        // mode targets the agent's stdin (a wake turn / a force-interrupt byte).
        const sink = msg.mode === 'osc' ? stdout : child;
        // Hold owner keystrokes that arrive during the deliberate text→CR
        // submit gap. Without this small delivery lease, a human can start a
        // new line after the envelope is written but before its CR, recreating
        // the same interleaving this composer gate prevents at the front door.
        const machineTurn = bridgeTty && (msg.mode === 'turn' || msg.mode === 'reset');
        if (machineTurn && ownerComposerGate.hasPending()) {
          // WI-38257: a staged line that has stopped tracking a person must not be
          // able to defer wakes forever. Check before spending the wait budget.
          if (!breakComposerWedgeIfConfirmed()) {
            const clear = await ownerComposerGate.waitClear();
            if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
          }
        }
        // EI-23247679868236430: admission happened before any mutex/gate wait.
        // A carry can become pending during those waits; recheck at the final
        // boundary before writing bytes or latching the owner-input lease.
        if (shouldDeferWakeForPendingRespawn(msg.mode, carryRearm.pendingCount('carry-respawn'))) {
          claimCoalesced();
          appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', {
            reason: 'carry-respawn-pending', phase: 'pre-write',
          });
          return { ok: false, reason: 'deferred-carry-respawn-pending' };
        }
        if (machineTurn) {
          machineTurnActive = true;
          queuedOwnerInput = [];
        }
        // P-001a: claim the coalesce slot at delivery — later same-key arrivals
        // start a fresh cycle (they'll gate on the turn this write starts). The
        // claimed newest text replaces this waiter's own, annotated with the count.
        let deliver = msg;
        if (coalesceKey != null) {
          const claimed = claimCoalesced();
          if (claimed) {
            // The folded text is the newest loop fire, so carry its fire identity
            // forward too. Keeping the first envelope here would make the stale-
            // fire guard commit an older number for newer text.
            deliver = {
              ...msg,
              ...(claimed.metadata ?? {}),
              data: renderCoalescedTurn(claimed.data, claimed.folded),
            };
          }
        }
        // Deliver as ordered steps: a turn writes its text, THEN the submit CR as
        // a separate keystroke after a settle (controlWrites). A one-shot text+CR
        // burst is swallowed by the TUI's paste detector — the turn never submits
        // and the human has to press Enter.
        let machineTurnSubmitted = false;
        const turnWriteStartedAt = Date.now();
        // WI-10004943: snapshot BEFORE the first byte, so a frame the write
        // provokes cannot be mistaken for readiness that preceded it.
        const injectWriteContext = msg.mode === 'turn' || msg.mode === 'reset'
          ? turnWriteContext(turnWriteStartedAt)
          : null;
        if (injectWriteContext) lastMachineTurnWriteStartedAtMs = turnWriteStartedAt;
        try {
          for (const step of controlWritesForAgent(deliver, env.PAPERCUSP_AGENT, env, {
            bracketedPaste: childBracketedPaste,
          })) {
            if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
            if (msg.mode !== 'osc') quotaBlockDetector.observeInput(step.data);
            sink.write(step.data);
            if ((msg.mode === 'turn' || msg.mode === 'reset') && step.data.includes('\r')) {
              activeHeadlessCodexModelChoice?.complete();
            }
          }
          if (msg.mode === 'turn' || msg.mode === 'reset') {
            lastMachineTurnSubmittedAtMs = Date.now();
            activeHeadlessCodexModelChoice?.complete();
          }
          machineTurnSubmitted = machineTurn;
        } finally {
          if (machineTurn) {
            machineTurnActive = false;
            const ownerInput = queuedOwnerInput;
            queuedOwnerInput = [];
            if (machineTurnSubmitted) ownerComposerGate.markSubmitted();
            for (const input of ownerInput) {
              ownerComposerGate.observe(input);
              try {
                quotaBlockDetector.observeInput(input);
                child.write(input);
              } catch {
                /* child exit is handled by the normal host cleanup path */
              }
            }
          }
        }
        // WI-2930: a turn/reset submit targets the agent's stdin and must be
        // verified like the compact writes above (raw = control bytes and osc =
        // display bytes have no submit to verify).
        if (msg.mode === 'turn' || msg.mode === 'reset') {
          // EI-18679050054551625 / WI-5872 follow-up: verifySubmitted()'s poll
          // loop sleeps a FULL pollMs (default 5000ms, env
          // PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS) before its very first
          // check, and can run up to `polls` iterations resubmitting a CR —
          // it is a best-effort confirm-and-resubmit safety net, not a
          // precondition for a truthful "delivered" ack (the actual write
          // above already landed). Awaiting it here before acking meant the
          // ACK protocol's round-trip always exceeded injectIntoHost()'s
          // default 2000ms client timeout for every turn/reset delivery —
          // observed as 9/10 psu-pty-host-turn.integration.test.ts cases red,
          // each timing out at ~2000-2200ms despite the write having actually
          // succeeded (confirmed via trace instrumentation: the handler
          // reaches verifySubmitted and never returns before the client
          // gives up). Ack "delivered" now; let verify+resubmit run as a
          // background continuation, same pattern as the recycle/carry-
          // respawn fix above — the inject mutex stays held
          // (deferMutexRelease) until it finishes, preserving the "gate wait
          // -> pty write -> submit verify" one-at-a-time invariant.
          deferMutexRelease = true;
          const releaseAfterVerify = releaseInject;
          void verifySubmitted(`${msg.mode} inject`, {
            text: deliver.data,
            submittedAtMs: turnWriteStartedAt,
            writeContext: injectWriteContext,
          })
            .catch(() => {})
            .finally(() => {
              if (releaseAfterVerify) releaseAfterVerify();
            });
        }
        return { ok: true, reason: 'delivered' };
      } catch (err) {
        // P-001a: an error path must clear the coalesce slot too (claim is
        // idempotent — a no-op when the delivery already claimed it above).
        claimCoalesced();
        // EI-10412: a lifecycle verb (compact/reset/recycle) dying here used to
        // vanish without a trace — for compact that silently killed the whole
        // auto-continuation. The swallow stays (child may have exited mid-inject;
        // the host must survive), but the outcome is now durably recorded.
        if (msg.mode === 'reset' || msg.mode === 'recycle') {
          appendHostEvent(ownerId, `${msg.mode}-inject-error`, {
            error: String((err && err.message) || err).slice(0, 300),
          });
        }
        // EI-18676244363359331 / WI-5872: this used to be a silent swallow for
        // every OTHER mode (turn/raw/osc/mcp-reconnect) too — the sender had no
        // way to learn a mid-delivery throw ever happened. Now folded into the
        // ACK below as a real outcome instead of a bare successful-looking close.
        return { ok: false, reason: 'error', error: String((err && err.message) || err).slice(0, 300) };
      } finally {
        // EI-8822: always free the inject mutex — on success, an early return
        // (defer/recycle/compact), OR a throw — so one inject never wedges the
        // queue behind an unreleased lock. EI-18679050054551625: skip it here
        // when deferMutexRelease is set — the turn/reset verify-in-background
        // or recycle/carry-respawn-in-background continuation above owns
        // releasing it once that continuation actually finishes, so the mutex
        // still covers the full "gate wait -> write/recycle -> verify" span.
        if (!deferMutexRelease && releaseInject) releaseInject();
      }
      };
      // EI-19311270129974785 / F03: the early ACK is only an acceptance
      // commitment; keep every ID in this coalesced waiter pending until the
      // detached pipeline reaches its write/recycle commitment, or clear the
      // complete set when the attempt is terminally refused.
      if (msg.deliveryId) deliveryDedup.markPending(msg.deliveryId);
      // Fire the gated pipeline and forget it (from the ACK's point of view) —
      // its own try/catch/finally above already handles every expected outcome
      // and durably records it; this outer .catch exists only so a genuinely
      // unexpected throw can never surface as an unhandled promise rejection.
      void deliverAfterUnpark(msg.mode, runGatedDelivery)
        .then((deliveryOutcome) => {
          if (!coalescedDeliveryIds.size) return;
          for (const deliveryId of coalescedDeliveryIds) {
            const rearmOwnsDelivery =
              deliveryId === msg.deliveryId &&
              deliveryOutcome?.reason === 'deferred-busy-gate' &&
              carryRearm.isPendingMessage(msg);
            const settlement = deliveryDedupSettlement(deliveryOutcome, rearmOwnsDelivery);
            if (settlement === 'completed') {
              deliveryDedup.markCompleted(deliveryId);
            } else if (settlement === 'pending') {
              // carryRearm owns the original ID outside this promise. Keep it
              // pending so a client retry cannot race the turn or carry re-arm.
              deliveryDedup.markPending(deliveryId);
            } else {
              deliveryDedup.clearPending(deliveryId);
            }
          }
        })
        .catch((err) => {
          for (const deliveryId of coalescedDeliveryIds) deliveryDedup.clearPending(deliveryId);
          appendHostEvent(ownerId, 'gated-delivery-pipeline-error', {
            mode: msg.mode,
            ...hostErrorEvidence(err),
          });
          try {
            process.stderr.write(
              `psu-pty-host: gated delivery pipeline threw for ${ownerId}: ` +
                `${String((err && err.message) || err).slice(0, 300)}\n`,
            );
          } catch {
            /* diagnostic only */
          }
        })
        .finally(() => {
          // EI-18681914950138372: this attempt has concluded one way or another
          // (delivered / dropped / errored / handed off to carryRearm.schedule's
          // own `pending` tracking) — clear the in-flight marker exactly once.
          // Safe even on hand-off: schedule() adds to `pending` synchronously
          // before this can fire, so pendingCount() never dips to 0 mid-transfer.
          if (msg.mode === 'carry-respawn') {
            carryRearm.endFirstAttempt(msg);
          }
        });
      // The host has accepted the request for processing, but has not yet
      // claimed that a turn started. The sender must keep the delivery durable
      // and retryable until the pipeline settlement above marks it completed.
      return { ok: true, reason: 'accepted' };
      })().catch((err) => ({
        ok: false,
        reason: 'unhandled-error',
        error: String((err && err.message) || err).slice(0, 300),
      }));
      // Write the ACK/NACK back on the STILL-OPEN connection (allowHalfOpen:true
      // above kept the writable side alive past the client's FIN) before we
      // close our end. Best-effort: a write/end failure here must never throw
      // out of this event handler and must never re-run any delivery — the real
      // work above already happened (or didn't) regardless of whether the ACK
      // itself makes it back.
      try {
        conn.write(`${JSON.stringify({ v: 1, ...outcome })}\n`);
      } catch {
        /* best-effort — the client's own timeout is the backstop */
      }
      try {
        conn.end();
      } catch {
        /* already closing */
      }
    });
  });
  server.on('error', (e) => {
    appendHostEvent(ownerId, 'control-socket-error', hostErrorEvidence(e));
    process.stderr.write(`psu: control socket error: ${e.message}\n`);
  });
  // Tight umask around bind so the node is never even briefly world-accessible,
  // then pin 0600 (owner-only). Shared by the initial bind and the WI-3455
  // self-heal re-bind (the sock path was unlinked while we were live).
  const listenControlSocket = () => {
    const prevUmask = process.umask(0o077);
    server.listen(sock, () => {
      try {
        chmodSync(sock, 0o600);
      } catch {
        /* best-effort */
      }
      try {
        process.umask(prevUmask);
      } catch {
        /* ignore */
      }
    });
  };
  listenControlSocket();
  // WI-3455: re-bind after the sock path was deleted out from under us. A unix
  // socket keeps LISTENING on the unlinked inode (unreachable — connectors get
  // ENOENT), so heal by closing the listener and re-listening on the same path.
  // net.Server supports listen-after-close; the connection handler is reused.
  rebindControlSocket = () => {
    try {
      server.close(() => {
        try {
          if (existsSync(sock)) unlinkSync(sock); // a dead successor's stray node would block bind
        } catch {
          /* ignore */
        }
        try {
          listenControlSocket();
        } catch (e) {
          appendHostEvent(ownerId, 'control-socket-rebind-failed', hostErrorEvidence(e));
          process.stderr.write(`psu: control socket re-bind failed: ${e.message}\n`);
        }
      });
    } catch {
      /* close() throws only when already closed — nothing to heal then */
    }
  };

  // pty -> stdout (output bytes = the mid-turn signal, P-006). Re-attachable: a
  // RECYCLE (P-004b) spawns a fresh child and re-wires this bridge to it (node-pty
  // listeners are per-process). onStdin/onResize below read the live `child`
  // closure, so they need no re-wiring.
  wireChildData = () => {
    // WI-41386: one guard per child — it carries partial-escape state, so a
    // respawn must not inherit the dead child's tail.
    const scrollbackGuard = makeScrollbackGuard();
    modelCapacityDetector?.reset();
    if (headlessClaudeOnboardingExpiryTimer) {
      clearTimeout(headlessClaudeOnboardingExpiryTimer);
      headlessClaudeOnboardingExpiryTimer = null;
    }
    const headlessClaudeOnboarding = makeHeadlessClaudeOnboardingStateMachine({
      enabled: headlessClaudeOnboardingEnabled(env),
      startupMs: headlessClaudeOnboardingStartupMs(env),
    });
    activeHeadlessClaudeOnboarding = headlessClaudeOnboarding;
    const headlessCodexModelChoice = makeHeadlessCodexModelChoiceStateMachine({
      enabled: headlessCodexModelChoiceEnabled(env),
    });
    activeHeadlessCodexModelChoice = headlessCodexModelChoice;
    let codexModelChoiceConfirmTimer = null;
    const confirmExistingModel = (selection) => {
      if (codexModelChoiceConfirmTimer) clearTimeout(codexModelChoiceConfirmTimer);
      codexModelChoiceConfirmTimer = null;
      try {
        child.write('\r');
        appendHostEvent(ownerId, 'headless-codex-model-choice-kept-existing', { selection });
      } catch {
        /* child-exit teardown owns a vanished pty */
      }
    };
    if (headlessClaudeOnboarding.isActive()) {
      headlessClaudeOnboardingExpiryTimer = setTimeout(() => {
        const result = headlessClaudeOnboarding.expire();
        headlessClaudeOnboardingExpiryTimer = null;
        if (result.action === 'expired') {
          appendHostEvent(ownerId, 'headless-claude-onboarding-expired', {
            phase: result.phase,
            startupMs: headlessClaudeOnboardingStartupMs(env),
          });
        }
      }, headlessClaudeOnboardingStartupMs(env));
      if (typeof headlessClaudeOnboardingExpiryTimer.unref === 'function') {
        headlessClaudeOnboardingExpiryTimer.unref();
      }
    }
    child.onData((d) => {
      const raw = typeof d === 'string' ? d : String(d);
      const codexModelChoice = headlessCodexModelChoice.observe(raw);
      if (codexModelChoice.action === 'select-existing') {
        try {
          // Wait for Codex to repaint the selected second row. Sending Arrow
          // and Enter in one PTY write can submit the still-selected first row.
          const offeredChild = child;
          child.write('\x1b[B');
          appendHostEvent(ownerId, 'headless-codex-model-choice-select-existing', {});
          codexModelChoiceConfirmTimer = setTimeout(() => {
            if (child !== offeredChild ||
                headlessCodexModelChoice.status().phase !== 'await-existing') return;
            // A lost redraw must not strand a headless launch indefinitely.
            headlessCodexModelChoice.complete();
            confirmExistingModel('fallback-after-arrow');
          }, 2_000);
          codexModelChoiceConfirmTimer.unref?.();
        } catch (error) {
          appendHostEvent(ownerId, 'headless-codex-model-choice-select-failed', {
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
      } else if (codexModelChoice.action === 'confirm-existing') {
        confirmExistingModel('repaint-confirmed');
      }
      if (!childStartupFirstOutputAt) childStartupFirstOutputAt = Date.now();
      childBracketedPaste = bracketedPasteModeAfter(childBracketedPaste, childBracketedPasteTail, raw);
      childBracketedPasteTail = `${childBracketedPasteTail}${raw}`.slice(-BRACKETED_PASTE_TAIL_CHARS);
      childStartupOutput += raw;
      if (childStartupOutput.length > 65_536) childStartupOutput = childStartupOutput.slice(-32_768);
      if (
        !childBackendTuiStartedAt &&
        String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex' &&
        codexTuiStartObserved(childStartupOutput)
      ) {
        // Checked on the accumulated buffer so a probe split across two pty
        // chunks is still seen (WI-10002745).
        childBackendTuiStartedAt = Date.now();
        appendHostEvent(ownerId, 'backend-tui-start-observed', {
          agent: 'codex',
          msAfterFirstOutput: childBackendTuiStartedAt - childStartupFirstOutputAt,
        });
      }
      // Not an else-branch: when Codex's probe wait is short, the probe and the
      // first frame can arrive in the same chunk.
      if (
        childBackendTuiStartedAt &&
        !childBackendFirstFrameAt &&
        codexSessionFrameObserved(childStartupOutput, { probeAlreadySeen: true, dims: childScreenDims() })
      ) {
        childBackendFirstFrameAt = Date.now();
        appendHostEvent(ownerId, 'backend-session-frame-observed', {
          agent: 'codex',
          msAfterTuiStart: childBackendFirstFrameAt - childBackendTuiStartedAt,
          // WI-10004943: null = no machine turn was ever written before the
          // frame. A small value means the frame may have been PROVOKED by
          // that write rather than signalling readiness on its own.
          msSinceMachineTurnWriteStarted: lastMachineTurnWriteStartedAtMs > 0
            ? childBackendFirstFrameAt - lastMachineTurnWriteStartedAtMs
            : null,
        });
      }
      const onboarding = headlessClaudeOnboarding.observe(raw);
      if (onboarding.complete && headlessClaudeOnboardingExpiryTimer) {
        clearTimeout(headlessClaudeOnboardingExpiryTimer);
        headlessClaudeOnboardingExpiryTimer = null;
      }
      if (onboarding.action === 'submit') {
        try {
          // One raw CR per detected prompt. Do not use controlWritesForAgent:
          // there is no text paste to settle and a delayed write can leave the
          // wizard parked again.
          child.write('\r');
          appendHostEvent(ownerId, 'headless-claude-onboarding-advanced', {
            prompt: onboarding.prompt,
            phase: onboarding.phase,
          });
        } catch {
          /* the child-exit path owns teardown if it disappeared mid-answer */
        }
      } else if (onboarding.action === 'expired') {
        appendHostEvent(ownerId, 'headless-claude-onboarding-expired', {
          phase: onboarding.phase,
          startupMs: headlessClaudeOnboardingStartupMs(env),
        });
      }
      const resumeCompaction = claudeResumeCompaction.observe(raw);
      if (resumeCompaction.action === 'select-summary') {
        try {
          // Claude's first menu item is the safe summary recovery. Send exactly
          // one raw CR; this is a recovery choice, not a user turn, so it must
          // not go through controlWritesForAgent() or submit verification.
          child.write('\r');
          appendHostEvent(ownerId, 'claude-resume-compaction-summary-selected', {
            startupMs: claudeResumeCompactionStartupMs(env),
            recoveryMs: claudeResumeCompactionRecoveryMs(env),
          });
        } catch {
          /* the child-exit path owns teardown; recovery will expire loudly */
        }
      } else if (resumeCompaction.action === 'ready') {
        appendHostEvent(ownerId, 'claude-resume-compaction-ready', {});
      } else if (resumeCompaction.timedOut) {
        reportClaudeResumeCompactionTimeout();
      }
      if (!childStartupReady) {
        // A normal headless Claude boot remains byte-ready. Only a positively
        // identified theme screen turns readiness off until its Security screen
        // receives the second CR; otherwise every healthy launch would wait for
        // the full expiry window even when no wizard is present.
        childStartupReady = startupOutputReady(env.PAPERCUSP_AGENT, childStartupOutput, childScreenDims());
      }
      // Codex can paint a composer before the model offer. Submission, above,
      // disarms the watcher; a ready frame alone does not.
      if (!childPromptReady) {
        childPromptReady = freshChildPromptReady(env.PAPERCUSP_AGENT, childStartupOutput);
      }
      if (onboarding.action === 'submit' && onboarding.prompt === 'theme') {
        childStartupReady = false;
        childPromptReady = false;
      }
      // A Claude recovery menu is not a composer prompt. Keep readiness blocked
      // until the recovery machine has seen a later standalone composer prompt.
      if (resumeCompaction.awaitingPrompt || resumeCompaction.timedOut) {
        childStartupReady = false;
        childPromptReady = false;
      } else if (resumeCompaction.action === 'ready') {
        childStartupReady = true;
        childPromptReady = true;
      }
      // WI-1386682 (1): feed the quota-wall detector the same raw bytes.
      const quotaTransition = quotaBlockDetector.observe(raw);
      if (quotaTransition) {
        // Publish the edge immediately. A static quota screen may never emit
        // another chunk to trigger the ordinary activity refresh.
        writeMeta();
        // WI-2140984: a bare detected/cleared row cannot distinguish a real
        // wall from a pattern hitting ordinary chrome, which is exactly how a
        // false positive cost a fleet leader an escalation. Carry the agent and
        // the matched text on the DETECTED edge (the cleared edge has none by
        // definition, and the per-deferral rows stay lean).
        const hit = quotaTransition === 'detected' ? quotaBlockDetector.lastMatch() : null;
        appendHostEvent(
          ownerId,
          quotaTransition === 'detected' ? 'quota-block-detected' : 'quota-block-cleared',
          hit
            ? {
                agent: String(env.PAPERCUSP_AGENT ?? '') || null,
                matchedPattern: hit.pattern,
                matchedExcerpt: hit.excerpt,
              }
            : {},
        );
      }
      const modelCapacity = modelCapacityDetector?.observe(stripAnsi(raw) ?? '') ?? null;
      if (modelCapacity) {
        appendHostEvent(ownerId, 'model-capacity-detected', {
          agent: 'codex',
          errorClass: modelCapacity.errorClass,
          retryable: modelCapacity.retryable,
          retryAfterMs: modelCapacity.retryAfterMs,
          matchedPattern: modelCapacity.matchedPattern,
          matchedExcerpt: modelCapacity.matchedExcerpt,
        });
      }
      activity.touchOutput();
      // Headless launchers keep the original raw PTY bytes on stdout for the
      // existing liveness/activity consumers, but also persist a bounded,
      // ANSI-free, CR-split companion so grep cannot expand one TUI frame into
      // an unbounded physical line.
      if (normalizedLog) normalizedLog.push(raw);
      // Everything else — readiness above, the output taps below — keeps seeing
      // the RAW stream; only what reaches the owner's terminal is guarded.
      stdout.write(scrollbackGuard.filter(raw));
      // P-003: feed any live output taps (mcp-reconnect macro screen reads).
      if (outputTaps.size > 0) {
        for (const t of outputTaps) {
          try {
            t(raw);
          } catch {
            /* a tap must never break the stdout bridge */
          }
        }
      }
    });
  };
  wireChildData();

  // stdin (raw) -> pty, tracking activity for the idle gate
  if (bridgeTty) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
  if (typeof stdin.resume === 'function') stdin.resume();
  const onStdin = (d) => {
    const input = d.toString('utf8');
    // WI-38156: a bridged terminal answers the TUI's capability queries on the
    // SAME stdin that carries owner keystrokes, so "bytes arrived on stdin" is
    // NOT "a human is here". Classify first — an emulator's own reply must not
    // forge any of the three owner signals below, and `lastInputAt` in
    // particular is permanent: one reply makes shutdownRefusalReason answer
    // 'human-attended' for the life of the session, so every agent-launched
    // bridged host becomes un-shutdownable by tooling.
    // Conservative by construction: only unambiguous terminal-authored string
    // sequences are filtered, so arrow/function/keypad keys still count.
    // A fresh Codex boot elicits automatic CSI/SS3 replies from the bridged
    // terminal. They remain possible-owner activity for the presence/idle
    // accounting below, but cannot cancel deterministic first-prompt delivery:
    // only definite line-affecting input advances this interruption epoch.
    if (freshChildOwnerInterruptionDetector.sawOwnerInput(input)) {
      ownerInputGeneration++;
    }
    const ownerTyped = ownerInputDetector.sawOwnerInput(input);
    if (ownerTyped) {
      idleGate.touch();
      activity.touchInput();
      // owner-presence-human-turn-signal-2026-07-11 P-003: a real human keystroke into
      // a bridged terminal → stamp owner presence (throttled, fire-and-forget). Gated on
      // bridgeTty so only a genuine interactive TTY (never a headless piped session)
      // reports. Socket-injected agent wakes bypass stdin, so they never reach here.
      if (bridgeTty) reportOwnerHumanTurn();
    }
    // psu-process-free-parking P-017: no child to type into while parked —
    // hold the keystrokes, resume, and replay them at the resumed prompt.
    if (parkInProgress()) {
      holdOwnerInputWhileParked(input, ownerTyped);
      return;
    }
    forwardOwnerInput(input);
  };
  /** Owner bytes → the child (or the post-submit queue while a machine turn
   *  owns the line). Shared by the live bridge and the parked-input replay. */
  function forwardOwnerInput(input) {
    if (bridgeTty) {
      if (machineTurnActive) {
        // The machine turn owns the current text→CR gap. Replay these bytes only
        // after its submit so owner input starts on the next terminal line.
        queuedOwnerInput.push(input);
        return;
      }
      ownerComposerGate.observe(input);
    }
    try {
      quotaBlockDetector.observeInput(input);
      child.write(input);
    } catch {
      /* ignore */
    }
  }
  stdin.on('data', onStdin);

  // terminal resize (SIGWINCH) -> pty resize
  const onResize = () => {
    const c = sanePtyDim(stdout.columns, 0, 1000);
    const r = sanePtyDim(stdout.rows, 0, 500);
    if (c && r) {
      try {
        child.resize(c, r);
      } catch {
        /* ignore */
      }
    }
  };
  if (typeof stdout.on === 'function') stdout.on('resize', onResize);

  return new Promise((resolve) => {
    let cleaned = false;
    let orphanTimer = null; // WI-3141 orphan watchdog; assigned below, cleared in cleanup
    let killChild = () => {};
    /**
     * WI-38054: the signal WE sent, recorded the moment we decide to tear the child
     * down. node-pty's own `signal` is preferred when it arrives, but the teardown
     * paths can complete without ever seeing an exit event (the child may already be
     * gone), and those are precisely the paths where "the session did not choose to
     * end" must still be recorded. Without this, a teardown reports a bare `0` and the
     * row asserts a clean voluntary exit.
     */
    let teardownSignal = null;
    /** WI-38292: set by the adopting path just before it runs `cleanup`, so the
     *  ordinary teardown does the whole release and only the FINAL step differs.
     *  `{ code, go }` — never a bare boolean: the successor's marching orders are
     *  already on disk by the time this is set, and `go` is what actually leaves. */
    let reexecRequested = null;
    const cleanup = (code, signal = null) => {
      if (cleaned) return;
      cleaned = true;
      hostCleanedUp = true;
      stopStartupTrace('host-cleanup');
      // P-019: nothing held for a resume can run now; release it as
      // undeliverable so each sender's dedup slot clears instead of hanging.
      cancelUnparkRetry();
      releaseHeldDeliveries({ ok: false, reason: 'host-ending' });
      const endedSignal = signal ?? teardownSignal;
      // A PTY leader can exit before its descendants. Reap the group while its
      // forkpty pgid is still unambiguous, then remove our signal listeners.
      killPtyProcessTree(child, 'SIGKILL');
      // A descendant can call setsid() and escape that pgid while remaining in
      // the session scope. On a GENUINE end of an agent-launched session, reap
      // the rest of that exact scope too. Reexec/recycle is continuation, and
      // an unmarked non-headless/shared scope is never ours to sweep.
      if (
        shouldReapDetachedPtyScopeResidue({
          bridgeTty,
          headless: String(env.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1',
          launchedBy: env.PAPERCUSP_LAUNCHED_BY,
          reexecRequested,
        })
      ) {
        try {
          const residue = reapScopeResidue({
            allowManagedScope: String(env.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1',
          });
          if (residue?.failedPids?.length) {
            appendHostEvent(ownerId, 'session-scope-cleanup-partial', {
              killed: residue.killedPids?.length ?? 0,
              failed: residue.failedPids.length,
            });
          }
          if (residue?.killedPids?.length || residue?.failedPids?.length) {
            process.stderr.write(
              `psu-pty-host: session scope cleanup for ${ownerId} killed ` +
                `${residue.killedPids?.length ?? 0} detached descendant(s)` +
                `${residue.failedPids?.length ? `; ${residue.failedPids.length} kill(s) failed` : ''}\n`,
            );
          }
        } catch (error) {
          // Group cleanup already ran and the host must still finish its durable
          // session-end record. Surface the residue failure without stranding exit.
          appendHostEvent(ownerId, 'session-scope-cleanup-failed', hostErrorEvidence(error));
          try {
            process.stderr.write(
              `psu-pty-host: session scope cleanup failed for ${ownerId}: ${error?.message ?? error}\n`,
            );
          } catch {
            /* terminal may already be closing */
          }
        }
      }
      try {
        signalSource.off?.('SIGINT', killChild);
        signalSource.off?.('SIGTERM', killChild);
        signalSource.off?.('SIGHUP', killChild);
      } catch {
        /* best-effort listener hygiene */
      }
      if (bridgeTty) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        // WI-42458: returning stdin to cooked mode does NOT reset terminal-emulator
        // DEC modes. A child killed before its own teardown can leave SGR mouse
        // reporting armed, so the shell that inherits this terminal receives
        // ESC[<35;col;rowM on every mouse move. Final exit is a terminal handoff
        // just like recycle: restore the existing mode set and anchor below a
        // possibly half-drawn frame, but omit the restart marker because no
        // successor agent is being spawned. Keep this inside bridgeTty so a
        // headless session never writes terminal controls into its log stream.
        try {
          const handoff = respawnTerminalHandoffBytes({
            rows: sanePtyDim(stdout.rows, 0, 500) || undefined,
            separator: false,
          });
          if (handoff) stdout.write(handoff);
        } catch {
          /* a closing terminal is best-effort — cleanup must still finish */
        }
      }
      try {
        stdin.off?.('data', onStdin);
        stdin.pause?.();
      } catch {
        /* ignore */
      }
      try {
        stdout.off?.('resize', onResize);
      } catch {
        /* ignore */
      }
      try {
        clearInterval(activityTimer);
      } catch {
        /* ignore */
      }
      // The normalized companion is a separate diagnostic file descriptor.
      // Flush the final visible frame and close it on every terminal exit so
      // the last line is durable and a successor/test can reopen the path
      // without inheriting an open writer from this host.
      try {
        normalizedLog?.close();
      } catch {
        /* diagnostic side-channel cleanup must never block session teardown */
      }
      try {
        if (headlessClaudeOnboardingExpiryTimer) clearTimeout(headlessClaudeOnboardingExpiryTimer);
        headlessClaudeOnboardingExpiryTimer = null;
      } catch {
        /* ignore */
      }
      try {
        if (orphanTimer) clearInterval(orphanTimer);
      } catch {
        /* ignore */
      }
      // WI-3455: only remove the discovery key when it is still OURS. A
      // successor host that took over this ownerId re-registered the json with
      // ITS pid and re-bound the sock — unlinking them here would strand that
      // LIVE session (exactly the 2026-07-08 su-a8f52 stranding: a duplicate
      // host's exit deleted the original's key → no_live_pty_host on a live,
      // psu-hosted session). A missing/corrupt json means no registered
      // successor, so the sock is ours to remove; a json recording a DEAD other
      // pid is left for pruneDead/the janitor (their liveness test already
      // reads it as prunable). NOTE: server.close() must ALSO be skipped when
      // the key is owned by another host — libuv unlinks the server's bound
      // PATH on graceful close, even when that path now points at the
      // successor's re-bound socket node. unref() instead: the server stops
      // holding the event loop open (so an embedding process — a test — can
      // exit) and process exit reaps the fd WITHOUT unlinking the path.
      const registered = readDiscoveryMeta(ownerId);
      const ownedByOther = !!(registered && registered.pid && registered.pid !== process.pid);
      if (ownedByOther) {
        try {
          server.unref();
        } catch {
          /* ignore */
        }
      } else {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        for (const p of [sock, metaPath]) {
          try {
            if (existsSync(p)) unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
      const finishExit = () => {
        // WI-38292: an ADOPTING exit is not the session ending — it is the same
        // session continuing in a fresh process that loaded current host code. It
        // must therefore leave by a different door: `onExit` records an ended
        // session (adv_sessions, killedBySignal), which would report this live
        // session as dead and hand the successor a grave to climb out of.
        // Everything ABOVE this point still ran: the child is reaped, the tty is
        // un-bridged and the discovery key + socket are released, in that order,
        // BEFORE the successor asserts them (host:2739 — a second host on a live
        // discovery key strands the first).
        if (reexecRequested) {
          resolve(reexecRequested.code);
          reexecRequested.go();
          return;
        }
        // `resolve` keeps its numeric contract for embedding callers; the signal rides
        // the onExit channel, which is the one that reaches the adv_sessions record.
        resolve(code ?? 0);
        onExit(code ?? 0, endedSignal);
      };
      if (managedKickoff && !managedKickoffDisposition) {
        void acknowledgeManagedKickoff({
          persisted: false,
          renderedHash: managedKickoff.renderedHash,
          error: `target child exited (${code ?? 0}) before native session-port persistence was verified`,
        }).catch((error) => {
          appendHostEvent(ownerId, 'session-port-failure-ack-failed', hostErrorEvidence(error));
          try { process.stderr.write(`psu: session-port failure acknowledgement failed: ${error?.message ?? error}\n`); }
          catch { /* diagnostics are best-effort */ }
        }).finally(finishExit);
      } else if (managedKickoffDisposition) {
        void managedKickoffDisposition.catch(() => undefined).finally(finishExit);
      } else {
        finishExit();
      }
    };
    // WI-41044: a verifier window that reaches its CR cap without observing any
    // output after a resubmit is a stranded submit, not a recoverable quiet
    // interval. End the whole managed host so the discovery key, socket, and
    // child subtree are released and the launcher records a nonzero outcome.
    terminateSubmitVerifyExhaustion = (details = {}) => {
      if (cleaned || submitVerifyExhausted) return false;
      submitVerifyExhausted = true;
      const extra = {
        label: details.label ?? 'submit',
        polls: details.polls ?? null,
        resubmits: details.resubmits ?? null,
        maxResubmits: details.maxResubmits ?? null,
        outputObservedAfterResubmit: Boolean(details.outputObservedAfterResubmit),
        reason: 'max-resubmits-without-output',
      };
      appendHostEvent(ownerId, 'submit-verify-exhausted', extra);
      try {
        process.stderr.write(
          `psu-pty-host: ${extra.label} submit verification exhausted for ${ownerId} ` +
            `after ${extra.resubmits ?? '?'} resubmit CRs — terminating host (WI-41044)\n`,
        );
      } catch {
        /* diagnostic only */
      }
      cleanup(1, 'SIGTERM');
      return true;
    };

    // Child-exit wiring, re-attachable for RECYCLE (P-004b). Double-guarded so a
    // recycle's intended kill never tears the host down: (1) `recycling` skips the
    // exit that IS the recycle kill; (2) the per-child capture skips a superseded
    // (already-recycled-away) child whose exit event arrives late. Only the CURRENT
    // child's genuine exit runs cleanup.
    wireChildExit = () => {
      const thisChild = child;
      thisChild.onExit(({ exitCode, signal }) => {
        if (recycling) return; // an intended recycle kill — respawn re-wires; host lives on
        if (child !== thisChild) return; // a superseded child that died late — ignore
        // WI-38054: `signal` MUST be read here. node-pty reports a signal death as
        // { exitCode: 0, signal: N } — MEASURED in this tree: SIGHUP -> {"exitCode":0,"signal":1}.
        // Destructuring only exitCode (as this did) throws away the sole evidence that
        // the session was killed, and the surviving 0 then travels all the way to
        // adv_sessions as a clean voluntary exit. Two of the owner's agents were reaped
        // by a sidecar restart and recorded as `ended_by='self', exit_code=0` this way.
        cleanup(exitCode, signalNameFromCode(signal));
      });
    };
    wireChildExit();

    // RECYCLE (su-cold-auto-mode P-004b): the periodic HARD cold reset in the
    // HYBRID cadence (D-002) — kill the child + fresh-spawn it in THIS same host
    // (same socket / SID / locks / hooks / env survive, D-003), then open the fresh
    // process on the carry-note. Only ever reached at a settled turn (the handler's
    // clean-boundary gate ran first, D-006). Serialized by `recycling`; fail-soft
    // (a spawn failure leaves the host running, carry stays in the inbox).
    recycleChild = async (
      carryText,
      {
        systemPromptAddendum = '',
        drillId = '',
        sessionClass = '',
        quotaRecovery = null,
        carryProofRetryCount = 0,
        // WI-10004943: spawn a fresh child on the launch argv and return without
        // a first prompt; the launch closure re-delivers its own kickoff.
        freshChildOnly = false,
      } = {},
    ) => {
      const settleQuotaRecovery = (delivered, reason, extra = {}) => {
        if (quotaRecovery) {
          appendHostEvent(
            ownerId,
            delivered ? 'quota-recovery-ready' : 'quota-recovery-dropped',
            {
              operationId: quotaRecovery.operationId,
              recoveryOwnerId: quotaRecovery.ownerId,
              startedAtMs: quotaRecovery.startedAtMs,
              reason,
              ...extra,
            },
          );
        }
        return { delivered, reason };
      };
      if (recycling) return settleQuotaRecovery(false, 'recycle-already-running');
      recycling = true;
      // WI-5075 observability: the drill-only rows below made a WATCHDOG-initiated
      // carry-respawn (no drillId) completely invisible in the per-owner event log
      // — the P-018 successor-kill loop left ZERO durable trace outside journalctl.
      // Non-drill respawns now always leave generic respawned/failed/carry rows.
      const respawnMode = systemPromptAddendum
        ? 'carry-respawn'
        : freshChildOnly
          ? 'launch-fresh-child'
          : 'recycle';
      // WI-38292: a respawn replaces the CLI child but NOT this host process, so a
      // host fix committed after this process booted stays inert here — the live
      // reproduction was a continuation fix (d351ee3084) that a running host simply
      // could not execute, which looked exactly like the fix not working. Nothing in
      // the process could report that, so the failure was invisible for its whole
      // lifetime. Record it at the respawn boundary, where a stale host is about to
      // decide the session's continuation and the mismatch actually changes outcomes.
      // Detection only: adoption is a separate, riskier change (a launcher re-exec),
      // and a silent-but-detectable staleness is strictly better than an undetected one.
      // WI-10001514: record WHY a stale host will not adopt, not merely THAT it is
      // stale. The adoption gate below is
      // `!quotaRecovery && shouldAdoptHostCode({ onReexec, reexecCode, bridgeTty })`,
      // and when any condition fails the code falls through to the in-process
      // respawn recording nothing — which makes two very different outcomes
      // indistinguishable after the fact. `bridgeTty` true is a CORRECT refusal (a
      // re-exec would tear down a live human TUI); a missing onReexec/reexecCode is
      // a HEADLESS host that could safely have adopted but had no launcher shim,
      // i.e. a real gap wearing the same shape. Measured 2026-09-15: 7,021 of 9,087
      // stale detections never adopted and not one is attributable to either cause,
      // so "did adoption regress?" is unanswerable from the corpus. These are the
      // gate's OWN inputs read where it already evaluates them — still detection
      // only, no behaviour and no restart-timing change.
      try {
        const hostCode = hostCodeStalenessFn();
        if (hostCode.stale) {
          const allowInteractive = interactiveAdoptionOptIn();
          const adoptable = shouldAdoptHostCode({
            onReexec,
            reexecCode,
            bridgeTty,
            allowInteractive,
          });
          appendHostEvent(ownerId, 'host-code-stale', {
            mode: respawnMode,
            loaded: hostCode.loaded,
            onDisk: hostCode.onDisk,
            launcher: hostCode.launcher ?? null,
            // Store the closed enum only. The direct target URL may carry credentials.
            operatorPin: operatorPinEvidence(env),
            // ADDITIVE — absent on rows written by older hosts, so a reader must
            // treat `undefined` as "not recorded", never as false.
            adoptable,
            willAdopt: adoptable && !quotaRecovery && !freshChildOnly,
            notAdoptingReason: adoptable
              ? quotaRecovery
                ? 'quota-recovery'
                : freshChildOnly
                  ? 'launch-fresh-child'
                  : null
              : bridgeTty
                ? 'interactive-tty'
                : !onReexec
                  ? 'no-reexec-callback'
                  : 'no-reexec-code',
            bridgeTty,
            hasReexecCallback: Boolean(onReexec),
            reexecCode: reexecCode ?? null,
          });
        }
      } catch {
        /* diagnostic only — never block a respawn on the staleness probe */
      }
      // Assemble + persist the NEXT child's argv before killing the current one.
      // If carry-file creation fails, the settled current session remains alive
      // and its native/force-compaction backstops remain available.
      //
      // P-002 (stale-prompt-render-in-live-sessions-2026-08-02): re-render the base
      // persona FIRST, so the fresh path can be swapped into the argv below. Without
      // it, mintRecycleArgs copies `--system-prompt-file <predecessor's render>`
      // through verbatim and this session runs its FIRST launch's prompt forever —
      // 27 of 53 live sessions were up to 14 days stale when measured.
      //
      // Ordering: this runs BEFORE the kill, so a slow operator delays the respawn
      // rather than leaving the session dead while we wait. FAIL-SOFT: any failure
      // yields null and the successor keeps the inherited render — a stale prompt is
      // strictly better than a lost session — but it is RECORDED, never silent, so
      // a persistently-failing refresh is diagnosable instead of looking like the
      // bug this fixes.
      let personaFile = null;
      let personaRefreshReason = null;
      // Only claude has a `--system-prompt-file` to swap (codex carries its
      // instructions in CODEX_HOME/AGENTS.md, omp in its own launch-context env), so
      // skip the round-trip for a backend that could not use the answer. Skipped only
      // on an EXPLICIT non-claude value — an unset PAPERCUSP_AGENT still attempts the
      // refresh, because silently not refreshing is the failure mode being fixed.
      const agentHint = String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase();
      if (agentHint && agentHint !== 'claude') {
        personaRefreshReason = `unsupported-agent:${agentHint}`;
      } else {
        try {
          const refreshed = await refreshPersonaFile();
          personaFile = refreshed?.promptFile ?? null;
          personaRefreshReason = personaFile ? null : (refreshed?.reason ?? 'no-file');
        } catch (e) {
          personaFile = null;
          personaRefreshReason = `threw: ${e?.message ?? String(e)}`;
        }
      }
      // Record a refresh that did not happen, so a persistently-failing one is visible
      // rather than looking exactly like the staleness bug. The two EXPECTED skips
      // (a host with no refresh wired, a backend that has no prompt file to swap) are
      // not events — per-respawn noise for a known condition just buries real ones.
      if (
        !personaFile &&
        personaRefreshReason &&
        personaRefreshReason !== 'not-wired' &&
        !personaRefreshReason.startsWith('unsupported-agent')
      ) {
        appendHostEvent(ownerId, 'persona-refresh-skipped', {
          mode: respawnMode,
          reason: personaRefreshReason,
        });
      }
      // agent-economy-flywheel P-016 (decision D-012): the ONE refresh failure that is
      // not fail-soft. The operator refused to activate a priced Cupboard identity it
      // could neither fund nor drop from the stack. Booting the successor on the
      // inherited render would activate that identity again, so the respawn is
      // abandoned before anything is killed and the current session stays alive.
      if (personaRefreshReason === IDENTITY_ACTIVATION_REFUSED_REASON) {
        appendHostEvent(ownerId, 'respawn-failed', {
          mode: respawnMode,
          reason: IDENTITY_ACTIVATION_REFUSED_REASON,
        });
        try {
          if (!recycleChild.identityActivationRefusedWarned) {
            recycleChild.identityActivationRefusedWarned = true;
            process.stderr.write(
              `psu-pty-host: carry-respawn refused for ${ownerId}: a priced Cupboard identity on this ` +
                `session has no funds behind it. Fund it or detach it, then respawn ` +
                `(further refusals logged to the event log only)\n`,
            );
          }
        } catch {
          /* diagnostic only */
        }
        recycling = false;
        return settleQuotaRecovery(false, IDENTITY_ACTIVATION_REFUSED_REASON);
      }
      let recycleArgs;
      let nativeId;
      let respawnReported = false;
      let launchContextPath = null;
      let freshChildOwnerInputGeneration = null;
      try {
        if (
          systemPromptAddendum &&
          String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'codex'
        ) {
          try {
            await ensureCodexHome();
          } catch {
            /* mintCarryRespawnArgs remains the final fail-soft fallback */
          }
        }
        const minted = systemPromptAddendum
          ? mintCarryRespawnArgs(args, {
              systemPromptAddendum,
              ownerId,
              agent: env.PAPERCUSP_AGENT,
              personaFile,
              codexHome: env.CODEX_HOME,
            })
          : mintRecycleArgs(args, { agent: env.PAPERCUSP_AGENT, personaFile });
        recycleArgs = minted.args;
        nativeId = minted.nativeId;
        launchContextPath = minted.launchContextPath ?? null;
        // Codex's carry mint adds a visible, non-user-authored lineage marker.
        // Feed that rendered text to the native transcript (AGENTS.md alone is
        // system context and does not solve the owner's missing-history view),
        // but AFTER the original turn-origin line and body: replacing the first
        // prompt wholesale lost the marker, so every Codex carry failed its
        // native turn-start proof and was recorded as dropped (WI-10002752).
        if (minted.carryText) carryText = composeCarryTurnText(carryText, minted.carryText);
      } catch (e) {
        if (drillId) {
          const failExtra = {
            drillId,
            sessionClass,
            reason: 'argv-build-failed',
            detail: e?.message ?? String(e),
          };
          appendHostEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
        } else {
          appendHostEvent(ownerId, 'respawn-failed', {
            mode: respawnMode,
            reason: 'argv-build-failed',
            detail: e?.message ?? String(e),
          });
        }
        try {
          // Once per boot: the watchdog re-sends every ~2min sweep, and a
          // deterministic build failure repeated verbatim into the session's
          // terminal is pure spam (owner-reported 2026-07-18, the resume-launch
          // mint gap). The event-log row above still records every attempt.
          if (!recycleChild.argvBuildFailWarned) {
            recycleChild.argvBuildFailWarned = true;
            process.stderr.write(
              `psu-pty-host: carry-respawn argv build failed for ${ownerId}: ${e.message} ` +
                `(further identical failures logged to the event log only)\n`,
            );
          }
        } catch {
          /* diagnostic only */
        }
        recycling = false;
        return settleQuotaRecovery(false, 'argv-build-failed');
      }
      // WI-38292 ADOPTION. A respawn is the ONLY safe moment to swap host code:
      // the session is being cut anyway, the successor's argv is already minted
      // and its carry is already on disk, so nothing in flight is lost. Take it
      // only when ALL of these hold — each is a way the swap could strand the
      // session rather than continue it:
      //   * the loaded host code really is behind the file on disk (increment 1);
      //   * something will actually RE-RUN us (`onReexec` is wired AND the shim
      //     advertised its loop) — without that, exiting just kills the session;
      //   * the successor's orders reached disk, so it boots into THIS session's
      //     carry instead of a bare prompt.
      // Any of them missing ⇒ fall through to the in-process respawn, which is
      // the pre-WI-38292 behaviour: a stale host, but a live one.
      // Interactive sessions must never hand the terminal back to the shim.
      // The shim's re-exec closes/reopens the launcher and can race the
      // successor handoff, which presents as a fresh bootstrap/wizard and an
      // apparent interruption to the owner.  Adoption is safe for headless
      // hosts (there is no human TTY to tear down); keep interactive hosts on
      // the in-process respawn path so the PTY, socket, and terminal remain
      // continuous even when git-sync updates this module on disk.
      // A quota recovery carries an in-flight delivery-id handshake in this
      // host's memory. Keep that one recycle in-process; adopting the host here
      // would throw away the pending/completed dedup state before the operator
      // can confirm pickup. Ordinary respawns still adopt current code exactly
      // as before.
      // Kept on ONE line deliberately: psu-pty-host.test.ts locates this block by the
      // literal `if (!quotaRecovery && shouldAdoptHostCode` to assert the adoption body
      // never fires the session-compacted event. Reformatting it silently turns that
      // guard's indexOf into -1, which reads as the guard passing rather than failing.
      const allowInteractive = interactiveAdoptionOptIn();
      // A launch fresh child (WI-10004943) stays in-process too: the launch closure
      // that asked for it still owes the kickoff and its proof receipt, and a
      // re-exec would end that closure before either is published.
      if (!quotaRecovery && shouldAdoptHostCode({ onReexec, reexecCode, bridgeTty, allowInteractive }) && !freshChildOnly) {
        let hostCode = { stale: false };
        try {
          hostCode = hostCodeStalenessFn();
        } catch {
          /* a probe failure must never cost a respawn — stay on the old path */
        }
        if (hostCode.stale) {
          // The shim re-runs the launcher with its ORIGINAL environment, not
          // the local child environment assembled after bootstrap. Preserve
          // only the identity/configuration keys needed to reconstruct this
          // exact session; do not serialize the full environment (which may
          // contain unrelated credentials).
          const handoffEnv = {};
          for (const key of HOST_HANDOFF_ENV_KEYS) {
            const value = env[key];
            if (typeof value === 'string' && value.length > 0) handoffEnv[key] = value;
          }
          // Missing/empty provenance is an explicit pin, not permission to inherit
          // a managed marker from the shim's original environment.
          if (handoffEnv.PAPERCUSP_OPERATOR_URL) {
            handoffEnv.PAPERCUSP_OPERATOR_URL_PROVENANCE = env.PAPERCUSP_OPERATOR_URL_PROVENANCE ?? '';
          }
          if (advSessionId != null && !handoffEnv.PAPERCUSP_ADV_SESSION_ID) {
            handoffEnv.PAPERCUSP_ADV_SESSION_ID = String(advSessionId);
          }
          const handoffPath = writeHostHandoff(ownerId, {
            mode: respawnMode,
            command,
            args: recycleArgs,
            // EI-23076695727837648: the first turn is NOT in recycleArgs. The
            // in-process path injects carryText after spawn (injectTurnAtPrompt),
            // and this predecessor exits before it would. Without this field the
            // successor boots on the carry document and then sits idle until an
            // unrelated loop fire or wake (measured 3-48 min, 11 of 11 adoptions
            // on one goal holder). The launcher successor seeds it as its kickoff.
            firstTurnText: typeof carryText === 'string' && carryText.length > 0 ? carryText : null,
            cwd,
            nativeId: nativeId ?? null,
            advSessionId: advSessionId ?? env.PAPERCUSP_ADV_SESSION_ID ?? null,
            codexHome: env.CODEX_HOME ?? null,
            launchContextPath,
            // The successor builds its env from the shim's, not from ours, so the
            // deltas this respawn would have applied to the child have to travel
            // with the orders. P-018/P-022: a carry successor must not keep
            // Claude's native compactors, which would race the deterministic one.
            childEnv: {
              ...handoffEnv,
              ...(systemPromptAddendum
                ? { DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1' }
                : {}),
            },
            loaded: hostCode.loaded,
            onDisk: hostCode.onDisk,
            launcher: hostCode.launcher ?? null,
            drillId: drillId || null,
            sessionClass: sessionClass || null,
          });
          if (handoffPath) {
            appendHostEvent(ownerId, 'host-code-adopting', {
              mode: respawnMode,
              loaded: hostCode.loaded,
              onDisk: hostCode.onDisk,
              launcher: hostCode.launcher ?? null,
              handoffPath,
              nativeId: nativeId ?? null,
              firstTurnPresent: typeof carryText === 'string' && carryText.length > 0,
              firstTurnBytes: typeof carryText === 'string' ? Buffer.byteLength(carryText, 'utf8') : 0,
              handoffArgumentCount: Array.isArray(recycleArgs) ? recycleArgs.length : null,
            });
            // The launcher successor owns the adoption report and the
            // session-compacted event. Do not announce from this predecessor:
            // the successor must first re-anchor its native id and clear the
            // predecessor's context gauge, or a woken member can immediately
            // re-pull into the stale critical bucket (EI-21567375926533125).
            // `cleanup` IS the release sequence — reap the child, un-bridge the
            // tty, drop the timers, then release the discovery key and socket.
            // Reused rather than re-implemented so the adopting path cannot drift
            // away from the ordering the ordinary exit already gets right.
            reexecRequested = {
              code: reexecCode,
              go: () => onReexec({ code: reexecCode, handoffPath, mode: respawnMode }),
            };
            cleanup(0);
            return;
          }
          // Orders did not reach disk. Respawning in place loses nothing (the
          // carry is still in the inbox) whereas exiting would drop it.
          appendHostEvent(ownerId, 'host-code-adopt-failed', {
            mode: respawnMode,
            reason: 'handoff-write-failed',
          });
        }
      }
      const priorDisableAutoCompact = env.DISABLE_AUTO_COMPACT;
      const priorDisableCompact = env.DISABLE_COMPACT;
      try {
        stopStartupTrace('recycle');
        const dead = new Promise((res) => {
          try {
            child.onExit(() => res());
          } catch {
            res();
          }
        });
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        const exitedGracefully = await Promise.race([
          dead.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), RECYCLE_KILL_TIMEOUT_MS)),
        ]);
        if (!exitedGracefully) {
          // child.kill() sends the backend's graceful signal, but a CLI (or a
          // continuation helper it launched) can ignore it. Spawning after the
          // old cap without a hard tree kill creates two writers under the same
          // owner/SID — the cold-respawn duplicate-continuation failure. The
          // process group is this host's pty scope, so SIGKILL is the smallest
          // durable predecessor fence and also catches ordinary descendants.
          killPtyProcessTree(child, 'SIGKILL');
          await Promise.race([
            dead,
            new Promise((resolve) => setTimeout(resolve, RECYCLE_FORCE_KILL_WAIT_MS)),
          ]);
        }
        // Finish any visible text and discard a dangling escape sequence before
        // the successor child starts writing to the same companion artifact.
        if (normalizedLog) normalizedLog.flush();
        // WI-1980: a RECYCLE is a HARD cold reset — mint a FRESH --session-id so
        // we don't re-declare the prior child's already-on-disk id (which claude
        // rejects → boot-retry storm). env (PAPERCUSP_SID) is untouched, so coord
        // identity / locks / socket all survive; only the native claude id rotates.
        childStartupOutput = '';
        childStartupReady = false;
        childPromptReady = false;
        childStartupFirstOutputAt = 0;
        childBracketedPaste = false;
        childBracketedPasteTail = '';
        childBackendTuiStartedAt = 0;
        childBackendFirstFrameAt = 0;
        lastMachineTurnWriteStartedAtMs = 0;
        // WI-1386682 (1): a fresh child has no screen history and cannot
        // inherit the old child's wall.
        quotaBlockDetector.reset();
        // Composer state belongs to the child that was just killed. Carrying a
        // staged-line bit across this hard process boundary can make every wake
        // to the healthy successor defer forever, even though that successor's
        // editor is empty. This does not discard live owner input: the old child
        // (and therefore its composer) is already gone at this point.
        ownerComposerGate.markSubmitted();
        // P-018: disable Claude Code's native AUTO compactor only on the fresh
        // child whose deterministic carry consumer is now installed. The old
        // child kept its native safety net right up to this successful cut.
        // P-022 adds DISABLE_COMPACT: a successor of a pre-cutover session
        // would otherwise inherit an env where /compact still exists.
        if (systemPromptAddendum) {
          env.DISABLE_AUTO_COMPACT = '1';
          env.DISABLE_COMPACT = '1';
        }
        // WI-41386: the predecessor is dead but the TERMINAL still carries its
        // state — a cursor parked mid-frame, and whatever modes a killed child
        // never reset. Hand the terminal over cleanly BEFORE the successor gets
        // to write a byte, or its boot render lands on top of the predecessor's
        // final frame and the owner loses the last screenful of scrollback at
        // every restart. Backend-agnostic on purpose (see
        // respawnTerminalHandoffBytes): a no-op for a clean exit, the only
        // rescue for a dirty one. Best-effort — a handoff write must never be
        // what breaks a respawn.
        try {
          const handoff = respawnTerminalHandoffBytes({
            rows: sanePtyDim(stdout.rows, 0, 500) || undefined,
            separator: env.PAPERCUSP_PSU_PTY_RESPAWN_SEPARATOR !== '0',
          });
          if (handoff) stdout.write(handoff);
        } catch {
          /* the terminal bridge is advisory — never let it break the respawn */
        }
        freshChildOwnerInputGeneration = systemPromptAddendum
          ? ownerInputGeneration
          : null;
        // The successor inherits `env`; heal dead managed targets here while
        // preserving explicit target provenance. Best-effort: a probe
        // failure must never cost the respawn.
        try {
          const healed = await healOperatorPin(env);
          if (healed) {
            appendHostEvent(
              ownerId,
              healed.route === 'staging-proxy' ? 'operator-pin-routed' : 'operator-pin-healed',
              {
                from: operatorPinEvidence({ PAPERCUSP_OPERATOR_URL: healed.from }),
                to: operatorPinEvidence({ PAPERCUSP_OPERATOR_URL: healed.to }),
                ...(healed.route === 'staging-proxy' ? { route: 'staging-proxy' } : {}),
                mode: respawnMode,
              },
            );
          }
        } catch {
          /* keep the old pin — the respawn itself matters more */
        }
        child = spawnChild(recycleArgs);
        stopStartupTrace = startCodexStartupProcessTrace({
          agent: env.PAPERCUSP_AGENT, ownerId, pid: child.pid,
        });
        // P-017: a recycle that reaches a PARKED host had no live child to kill
        // (the stand-in exited at once); the fresh child ends the park.
        if (parked) {
          heldOwnerInput.length = 0;
          heldOwnerInputBytes = 0;
          cancelUnparkRetry();
          unparkRetryAttempt = 0;
          appendHostEvent(ownerId, 'child-unparked', {
            ...clearParkedState('recycle', { nativeId: nativeId ?? null }),
            childPid: Number.isInteger(child.pid) ? child.pid : null,
          });
          // P-019: deliveries held by a failed resume ride the fresh child.
          releaseHeldDeliveries({ ok: true, reason: 'recycled' });
        }
        // Re-anchor the fresh native id → coord ownerId so a LATER untracked
        // resume still recovers this identity (else the 2026-07-02 orphaning bug
        // recurs). The launcher callback also repairs the authoritative
        // adv_sessions mapping. Await that report before publishing successor
        // metadata/wiring/carry, but cap the wait so a wedged operator cannot
        // strand the live child forever.
        if (nativeId) {
          let reportTimer;
          let reportTimedOut = false;
          try {
            const report = Promise.resolve().then(() => onRespawn(nativeId)).then((confirmed) => {
              if (!reportTimedOut) respawnReported = confirmed === true;
            });
            await Promise.race([
              report,
              new Promise((resolve) => {
                reportTimer = setTimeout(() => {
                  reportTimedOut = true;
                  resolve();
                }, respawnReportTimeoutMs);
              }),
            ]);
          } catch (error) {
            appendHostEvent(ownerId, 'respawn-report-failed', {
              mode: respawnMode,
              nativeId,
              detail: String(error?.message ?? error).slice(0, 200),
            });
          } finally {
            if (reportTimer) clearTimeout(reportTimer);
          }
          if (reportTimedOut) {
            appendHostEvent(ownerId, 'respawn-report-timeout', {
              mode: respawnMode,
              nativeId,
              timeoutMs: respawnReportTimeoutMs,
            });
          }
        }
        baseMeta.ptyPid = child.pid;
        writeMeta();
        wireChildData();
        wireChildExit();
        // WI-1818: mark THIS instant as fresh output activity so the carry-inject
        // retry loop below evaluates the FRESH child's own settledness, not stale
        // quiet-time inherited from the OLD (just-killed) child. Without this, a
        // pre-kill busy gate that had ALREADY been satisfied (the old child was
        // quiet for quietMs before the kill) leaves `lastOutputAt` stale by
        // (at least) quietMs the instant this fresh child boots — so the very
        // FIRST waitAtPrompt() call below could read that staleness as "already
        // at prompt" and inject the carry before the fresh child has emitted a
        // single byte, even one that will stay busy from its first tick.
        activity.touchOutput();
        // EI-18665672258948707: this respawn just genuinely happened — stamp the
        // supersession clock NOW (before the event-log/emit calls below, which
        // are not load-bearing for correctness) so any OTHER carry-respawn still
        // gate-waiting or pending a carryRearm retry, whose receivedAtMs predates
        // this instant, is recognized as superseded the next time it is checked.
        lastRespawnAtMs = Date.now();
      } catch (e) {
        if (systemPromptAddendum) {
          if (priorDisableAutoCompact === undefined) delete env.DISABLE_AUTO_COMPACT;
          else env.DISABLE_AUTO_COMPACT = priorDisableAutoCompact;
          if (priorDisableCompact === undefined) delete env.DISABLE_COMPACT;
          else env.DISABLE_COMPACT = priorDisableCompact;
        }
        try {
          process.stderr.write(`psu-pty-host: recycle spawn failed for ${ownerId}: ${e.message}\n`);
        } catch {
          /* never let a diagnostic write break the host */
        }
        if (drillId) {
          const failExtra = {
            drillId,
            sessionClass,
            reason: 'spawn-failed',
            detail: e?.message ?? String(e),
          };
          appendHostEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
        } else {
          appendHostEvent(ownerId, 'respawn-failed', {
            mode: respawnMode,
            reason: 'spawn-failed',
            detail: e?.message ?? String(e),
          });
        }
        recycling = false;
        return settleQuotaRecovery(false, 'spawn-failed');
      }
      // EI-20287339148365013: a respawn REPLACES the agent, so any line staged
      // against the predecessor is stale BY DEFINITION — nobody is mid-sentence
      // to a process that no longer exists. Clearing it here makes the routine
      // event that already happens (a carry-respawn) double as the recovery the
      // wedge class never had.
      //
      // Measured 2026-08-12: su-f0c6fa5e carry-respawned at 22:56:00Z and its
      // successor deferred its very first wake 3 minutes later against the same
      // 11-char phantom the PREVIOUS agent had been stuck behind — the host
      // process, and therefore the composer model, outlive the agent. The owner
      // read that as "the bug isn't fixed"; it was the fix being unable to reach
      // a staged line nothing ever resets. This is also the ONLY lever that
      // helps without a relaunch: the pty-host is long-lived, so a code fix
      // reaches an existing host only at moments the host itself re-enters.
      const stagedAcrossRespawn = ownerComposerGate.hasPending()
        ? ownerComposerGate.pendingLength()
        : 0;
      if (stagedAcrossRespawn > 0) {
        // Ctrl-U to the CHILD first, then resync our own model — the same
        // ordering breakComposerWedgeIfConfirmed uses and for the same reason:
        // clearing only our model would leave the real composer holding text
        // that the next injected turn would then append to.
        try {
          child?.write('\u0015');
        } catch {
          /* the child is being replaced anyway */
        }
        ownerComposerGate.markSubmitted();
        appendHostEvent(ownerId, 'owner-composer-cleared-on-respawn', {
          pendingLength: stagedAcrossRespawn,
          respawnMode,
        });
      }
      if (drillId) {
        const respawnedExtra = {
          drillId,
          sessionClass,
          nativeId: nativeId ?? null,
          launchContextPath,
        };
        appendHostEvent(ownerId, 'carry-drill-respawned', respawnedExtra);
        appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawned', respawnedExtra);
      } else {
        appendHostEvent(ownerId, 'respawned', {
          mode: respawnMode,
          nativeId: nativeId ?? null,
          launchContextPath,
          // false = the successor boots with NO first prompt (P-010 answered case)
          // and waits for its loop/coord wake — expected, but worth seeing.
          firstPrompt: Boolean(carryText),
          capMs: recycleCarryInjectBudgetMs,
          // P-002: did this successor get a FRESH base persona, or inherit the
          // predecessor's render? The whole point of the fix, so it is observable
          // per respawn rather than inferable only from a prompt diff.
          personaRefreshed: Boolean(personaFile),
        });
      }
      // Spawn is not a completed carry. Codex has no minted native id yet
      // and can stay at Starting without accepting its carry. Announcing here
      // refreshed the predecessor's estimate and woke peers before delivery.
      recycling = false;
      // WI-10004943: a launch fresh child has no carry. Report the spawn; the
      // launch closure delivers its kickoff and publishes the proof receipt.
      if (freshChildOnly) return { delivered: false, reason: 'fresh-child-spawned', spawned: true };
      if (!carryText) {
        if (drillId) {
          const dropExtra = {
            drillId,
            sessionClass,
            reason: 'no-first-prompt',
          };
          appendHostEvent(ownerId, 'carry-drill-carry-dropped', dropExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-carry-dropped', dropExtra);
        }
        return settleQuotaRecovery(false, 'no-first-prompt');
      }
      // Open the fresh process on the carry-note once it has booted to its prompt
      // (boot output quiesces → the agent-busy gate clears), via the shared
      // guaranteed-or-loudly-dropped delivery (WI-1941 — the old single-shot
      // waitAtPrompt dropped the iteration SILENTLY the instant it deferred,
      // leaving the session booted-but-idle with no trace until its next
      // scheduled wake). The carry also stays in the inbox as the last-resort
      // next-turn resume, so a drop is observable, not lossy.
      const recordCarryDrop = () => {
        baseMeta.lastCarryDropAt = Date.now();
        baseMeta.carryDropCount = (baseMeta.carryDropCount || 0) + 1;
        // A generic submit-verifier exhaustion may already have cleaned up the
        // host. Preserve the in-memory counter and durable event, but never
        // recreate a stale discovery file after cleanup removed it.
        if (!cleaned) writeMeta();
      };
      let carryResult = await injectTurnAtPrompt({
        text: carryText,
        label: drillId ? `carry-drill ${drillId} first prompt` : 'recycle carry-note',
        // A fresh child can be output-quiet before its input handler exists.
        // Apply the same backend-aware boot proof as a scripted resume/port.
        requireInitialOutput: true,
        freshChildOwnerInputGeneration,
        // WI-10005106: a child stuck at the Codex `Starting` footer is replaced
        // early while a fresh-epoch retry remains; the LAST attempt holds for the
        // frame instead (the WI-10004943 (d) launch-kickoff behaviour), because
        // dropping it there leaves the session idle without its carry.
        ...(!drillId && carryProofRetryCount < carryProofRetryMax
          ? {
              codexStartingStuckMs: positiveNumber(
                env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS,
                CODEX_CARRY_STARTING_STUCK_MS,
              ),
            }
          : !drillId
            ? {
                codexStartingHoldCeilingMs: positiveNumber(
                  env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS,
                  CODEX_STARTING_KICKOFF_HOLD_CEILING_MS,
                ),
              }
            : {}),
        // Decide whether a failed fresh epoch is retryable before recording a
        // terminal carry drop; a retry must not increment the drop counter.
        onDrop: () => {},
        // A recycled Claude su session can arrive while the native Papercusp
        // MCP endpoint is still reconnecting. Keep the carry out of the composer
        // until the closed-loop reconnect check proves papercusp-su ready.
        prepareBeforeWrite: async ({ deadline }) => {
          if (respawnMode === 'carry-respawn' && (nativeId || resolveRespawnNativeId)) {
            const binding = await prepareCarryBinding(nativeId, deadline, respawnReported);
            if (!binding.ok) return binding;
            nativeId = binding.nativeId;
            respawnReported = true;
          }
          if (!(respawnMode === 'carry-respawn' &&
          String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'claude' &&
          sessionClass === 'claude-su')) return { ok: true };
          const tap = makeOutputTap();
          try {
            const result = await verifyHeadlessRoleMcp(() => mcpReconnectMacro({
              serverName: 'papercusp-su',
              write: (bytes) => child.write(bytes),
              readTap: tap.read,
              resetTap: tap.reset,
            }));
            appendHostEvent(
              ownerId,
              result.ok ? 'respawn-carry-mcp-ready' : 'respawn-carry-mcp-unavailable',
              {
                mode: respawnMode,
                nativeId: nativeId ?? null,
                serverName: 'papercusp-su',
                step: result.step,
                attempts: result.attempts,
                detail: result.detail,
              },
            );
            return { ok: result.ok, reason: 'carry-mcp-unavailable' };
          } finally {
            tap.close();
          }
        },
      });
      const retryOnFreshEpoch = (reason, proofReason = null) => {
        if (!shouldRetryCarryOnFreshEpoch({
          drillId,
          reason,
          proofReason,
          retryCount: carryProofRetryCount,
          maxRetries: carryProofRetryMax,
        })) return null;
        appendHostEvent(ownerId, 'respawn-carry-fresh-epoch-retry', {
          mode: respawnMode,
          nativeId: nativeId ?? null,
          reason,
          detail: proofReason,
          attempt: carryProofRetryCount + 1,
          maxRetries: carryProofRetryMax,
        });
        return recycleChild(carryText, {
          systemPromptAddendum,
          drillId,
          sessionClass,
          quotaRecovery,
          carryProofRetryCount: carryProofRetryCount + 1,
        });
      };
      if (!carryResult.delivered) {
        const retry = retryOnFreshEpoch(carryResult.reason);
        if (retry) return retry;
      }
      let turnStartProof = null;
      // EI-21561923024113260: PTY output proves only that the successor painted
      // something. The incident had outputSeen:true and no user turn for 182s.
      // Production carry prompts carry a unique leading turn-origin marker and
      // a fresh native id, so require that exact pair in the fresh backend
      // transcript before emitting respawn-carry-delivered. Drills retain their
      // existing PTY-level contract because their synthetic payloads do not
      // necessarily carry turn provenance.
      if (!drillId && carryResult.delivered) {
        const proofWindowMs = Math.max(250, Math.floor(nativePersistenceTimeoutMs / 2));
        turnStartProof = await verifyNativeTurnStartWithRetry({
          agent: env.PAPERCUSP_AGENT,
          env,
          text: carryText,
          nativeId,
          requireNativeId: carryTurnProofRequiresNativeId(env.PAPERCUSP_AGENT),
          sinceMs: lastRespawnAtMs,
          timeoutMs: proofWindowMs,
          writeCr: () => child.write('\r'),
          onRetry: ({ proofKind }) => {
            appendHostEvent(ownerId, 'respawn-carry-turn-start-retry', {
              mode: respawnMode,
              nativeId,
              reason: proofKind === 'exact-prompt' ? 'native-turn-prompt-timeout' : 'native-turn-marker-timeout',
            });
          },
        });
        if (turnStartProof.markerTruncated) {
          appendHostEvent(ownerId, 'respawn-carry-marker-truncated', {
            mode: respawnMode,
            nativeId: nativeId ?? null,
            lostChars: turnStartProof.markerTruncated.lostChars,
          });
        }
        if (!turnStartProof.persisted) {
          appendHostEvent(ownerId, 'turn-start-unverified', {
            mode: respawnMode,
            nativeId: nativeId ?? null,
            detail: turnStartProof.reason ?? 'native-turn-marker-timeout',
          });
          // A fresh epoch clears the exact state that made the native marker
          // invisible (stale transcript tail, a repainting composer, or a
          // child that accepted the CR but never entered its backend turn).
          // Retry only the timeout class: missing provenance/native-id is a
          // deterministic contract failure and cannot be repaired by respawn.
          const retry = retryOnFreshEpoch('turn-start-unverified', turnStartProof.reason);
          if (retry) {
            // `recycling` is already false once the successor is spawned, so
            // this recursive call performs a real hard cut and mints a new
            // native id before resubmitting the same carry text. Returning its
            // result prevents the failed epoch from emitting a false terminal
            // drop or incrementing carryDropCount.
            return retry;
          }
          carryResult = { ...carryResult, delivered: false, reason: 'turn-start-unverified' };
          try {
            process.stderr.write(
              `psu-pty-host: carry turn start UNVERIFIED for ${ownerId} ` +
                `(native ${nativeId ?? 'unknown'}; ${turnStartProof.reason ?? 'marker timeout'}) — ` +
                `recording a drop, never respawn-carry-delivered\n`,
            );
          } catch {
            /* diagnostic only */
          }
        }
      }
      if (respawnMode === 'carry-respawn' && !drillId && carryResult.delivered) {
        const carryChild = child;
        const announcement = await announceVerifiedCarryRespawn({
          ownerId, agent: env.PAPERCUSP_AGENT, nativeId, proof: turnStartProof,
          alreadyReported: respawnReported, report: onRespawn, emit: emitCompacted,
          timeoutMs: respawnReportTimeoutMs,
          isCurrent: () => child === carryChild && !recycling && !shuttingDown && !cleaned,
        });
        if (announcement.nativeId) nativeId = announcement.nativeId;
        if (!announcement.announced) {
          appendHostEvent(ownerId, 'respawn-compaction-unannounced', {
            nativeId: nativeId ?? null, reason: announcement.reason,
          });
        }
      }
      if (!carryResult.delivered) recordCarryDrop();
      if (drillId) {
        // EI-12655 (drill-1 instrumentation, leader-concurred): a never-settled
        // drop was previously indistinguishable from a never-booted child.
        // budgetMs (the wall-clock the retry loop had) + outputSeen (did the
        // fresh child ever emit a startup byte) make the next occurrence
        // self-diagnosing: outputSeen:false ⇒ the child never became ready;
        // outputSeen:true + never-settled ⇒ continuous TUI output kept the
        // busy gate from ever seeing quietMs of silence.
        const terminalKind = carryResult.delivered
          ? 'carry-drill-carry-delivered'
          : 'carry-drill-carry-dropped';
        const terminalExtra = {
          drillId,
          sessionClass,
          nativeId: nativeId ?? null,
          reason: carryResult.delivered ? undefined : carryResult.reason,
          attempts: carryResult.attempts,
          budgetMs: recycleCarryInjectBudgetMs,
          outputSeen: childStartupOutput.length > 0,
        };
        appendHostEvent(ownerId, terminalKind, terminalExtra);
        appendSharedDrillLedgerEvent(ownerId, terminalKind, terminalExtra);
      } else {
        // EI-21859839880291755: this is the ONLY place a production
        // (non-drill) carry-respawn's terminal outcome is known — both the
        // genuine-success case (delivered:true) and a drop discovered only
        // here (e.g. reason:'turn-start-unverified', which can fire AFTER
        // the retry loop's own pre-recycle staleness/supersede check already
        // passed). Every OTHER production drop path (the pre-recycle
        // staleness/supersede check, and the retry loop's own carry-stale
        // check) mirrors its appendHostEvent call with
        // appendSharedDrillLedgerEvent so the box-wide shared ledger stays
        // aggregatable — this terminal one previously did not, so the shared
        // ledger (~/.papercusp/psu-pty/carry-drills.events.jsonl) was
        // STRUCTURALLY BLIND to every production delivery success and to
        // this drop reason: it could show hundreds of 'carry-stale'/
        // 'superseded' drops and ZERO 'respawn-carry-delivered' rows even on
        // a box where most respawns actually succeeded, because success was
        // logged only to each owner's PRIVATE per-owner log
        // (eventLogPathForOwner), never to the shared one. Measured
        // 2026-08-30: 36,162 respawn-carry-delivered rows exist across
        // per-owner logs while the shared ledger showed 0 in its 48h window
        // — an investigation reading only the shared ledger concluded
        // "fleet-wide carry-respawn starvation" from what was actually just
        // this asymmetric-logging gap. Mirroring the call here (matching the
        // drill branch just above, which has always logged both) closes it.
        const terminalExtra = {
          mode: respawnMode,
          nativeId: nativeId ?? null,
          reason: carryResult.delivered ? undefined : carryResult.reason,
          attempts: carryResult.attempts,
          outputSeen: childStartupOutput.length > 0,
          turnStartVerified: turnStartProof ? Boolean(turnStartProof.persisted) : undefined,
          nativeRef: turnStartProof?.nativeRef ?? undefined,
        };
        const terminalKind = carryResult.delivered ? 'respawn-carry-delivered' : 'respawn-carry-dropped';
        appendHostEvent(ownerId, terminalKind, terminalExtra);
        appendSharedDrillLedgerEvent(ownerId, terminalKind, terminalExtra);
      }
      return settleQuotaRecovery(
        Boolean(carryResult.delivered),
        carryResult.delivered ? 'turn-start-verified' : (carryResult.reason ?? 'carry-dropped'),
        {
          nativeId: nativeId ?? null,
          nativeRef: turnStartProof?.nativeRef ?? null,
          attempts: carryResult.attempts,
        },
      );
    };

    // Raw-mode keyboard Ctrl-C remains a byte forwarded to the target. A real
    // process SIGINT (outer terminal/executor interrupt) is teardown, just like
    // SIGHUP/SIGTERM: kill the whole forkpty group so no backend descendant can
    // survive and serialize the managed-port failure receipt immediately.
    killChild = (receivedSignal) => {
      // WI-38054: record the teardown BEFORE sending it. This host is being torn down
      // (its own SIGINT/SIGTERM/SIGHUP), so whatever happens next, the session did not
      // choose to end — without this, a teardown that reaches cleanup through the
      // child-exit path can report a bare 0 indistinguishable from a clean exit.
      // WI-10001504: record the signal that ACTUALLY arrived, never a constant.
      // SIGINT/SIGTERM/SIGHUP all land in this one handler, so the previous hardcoded
      // 'SIGHUP' discarded the single most diagnostic fact about a session death. The
      // erasure was DOUBLE: cleanup() resolves `signal ?? teardownSignal`, so the
      // literal passed at its call site below overrode this variable a second time even
      // once it was set correctly. Measured 2026-09-15: two deaths (su-9ab60223
      // @19:55:03.322Z, su-66826cba @20:07:13.129Z) arrived as SIGTERM and BOTH were
      // recorded as SIGHUP — which is precisely why the sender hunt had no durable
      // signal to start from and burned hours across several agents.
      const actualSignal = typeof receivedSignal === 'string' ? receivedSignal : null;
      teardownSignal = resolveTeardownSignal(receivedSignal);
      appendHostEvent(ownerId, 'host-teardown', {
        via: 'signal',
        signal: actualSignal,
      });
      // External fleet:kill can SIGKILL this host before node-pty delivers the
      // child's exit event. Run cleanup now so detached VTE-scope descendants are
      // reaped even when the child is slow to report its exit. cleanup() performs
      // the forceful process-tree kill as its first step, preserving the existing
      // SIGHUP -> SIGKILL ordering without waiting on child.onExit.
      // The signal we SEND the child stays SIGHUP — it is what lets a claude TUI flush
      // its transcript before the SIGKILL escalation. Only what we RECORD changes here.
      killPtyProcessTree(child, 'SIGHUP');
      cleanup(0, teardownSignal);
    };
    signalSource.on?.('SIGINT', killChild);
    signalSource.on?.('SIGTERM', killChild);
    signalSource.on?.('SIGHUP', killChild);

    // ── Orphan / vanished-terminal teardown (WI-3141) ──────────────────────────
    // A managed-pty host must NOT outlive the interactive terminal it bridges.
    // SIGHUP (above) is the nominal "terminal closed" signal, but a WSL/console-
    // session teardown can reparent psu to init WITHOUT delivering it — leaving a
    // host that keeps its child alive and keeps forwarding the child's output to a
    // /dev/pts fd the OS has since recycled to the owner's NEXT terminal (the
    // 2026-07-05 "random characters appear without typing" report). So the moment
    // the human is gone, kill the child and exit — hard, not the soft SIGTERM
    // killChild uses, since an orphan may be forwarding a wedged/looping child.
    // Only engaged for a real interactive TTY bridge (bridgeTty): a non-tty
    // (piped/programmatic) host has no terminal to spam and treats stdin EOF as
    // ordinary end-of-input, so these guards would be wrong there.
    if (bridgeTty) {
      const teardownOrphan = (why) => {
        if (cleaned) return;
        // `why` is the ONLY value separating the five orphan triggers from each other
        // AND from a real received signal — every one of them ends as SIGHUP/exit-0 in
        // adv_sessions. Until this row existed it was written solely to the terminal
        // that just vanished, so a session death could be observed but never explained
        // (measured 2026-09-15: two deaths, neither near a context limit, cause
        // unrecoverable from any durable surface). appendHostEvent is fail-soft by
        // contract, so this can never cost a teardown; it must precede the stderr write
        // below, which is aimed at the very terminal whose loss we are recording.
        appendHostEvent(ownerId, 'orphan-teardown', { why });
        try {
          process.stderr.write(
            `psu-pty-host: session orphaned (${why}) for ${ownerId} — killing child + exiting\n`,
          );
        } catch {
          /* the terminal we'd warn on may be the very one that vanished */
        }
        try {
          teardownSignal = 'SIGHUP'; // WI-38054 — an orphan teardown is a kill, not an exit
          killPtyProcessTree(child, 'SIGHUP');
          killPtyProcessTree(child, 'SIGKILL');
        } catch {
          /* already gone */
        }
        cleanup(0, 'SIGHUP');
      };

      // (1) The bridged TTY going EOF / closed / errored = the terminal vanished.
      stdin.once?.('end', () => teardownOrphan('stdin-eof'));
      stdin.once?.('close', () => teardownOrphan('stdin-close'));
      stdin.on?.('error', () => teardownOrphan('stdin-error'));
      // A write error on our stdout (EIO/EPIPE) = the terminal is gone. Wiring a
      // listener also keeps a stray write error from throwing uncaught.
      if (typeof stdout.on === 'function') stdout.on('error', () => teardownOrphan('stdout-error'));

      // (2) Parent-death watchdog — catches the case the pts stays ALIVE (a fresh
      // shell took over the same /dev/pts number, so stdin never hits EOF) but the
      // shell that LAUNCHED psu has died: the exact 2026-07-05 orphan (ppid→init).
      // Only a TRANSITION to init counts; a host already under init at launch (a
      // service/nohup start) is left alone.
      let initialParentPid = 1;
      try {
        initialParentPid = parentPidFn();
      } catch {
        /* if we can't read ppid, skip the watchdog (the EOF guards still apply) */
      }
      if (initialParentPid && initialParentPid !== 1) {
        orphanTimer = setInterval(() => {
          let ppid = initialParentPid;
          try {
            ppid = parentPidFn();
          } catch {
            return; // transient read failure — try again next tick
          }
          if (ppid === 1) teardownOrphan('parent-exited');
        }, ORPHAN_POLL_MS);
        if (typeof orphanTimer.unref === 'function') orphanTimer.unref();
      }
    }
  });
}
