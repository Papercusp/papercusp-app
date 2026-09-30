// EI-18662389554660036 — a filesystem-local mutex for shared-tree-wide mutations
// that plain repo tooling (no MCP/Papercusp credentials, just `node`) needs to
// serialize across concurrent agent processes on the same host.
//
// This is the SAME proven algorithm as `withTestcontainerStartLock`
// (libs/test-config/src/testcontainer-start-lock.ts): an atomic `mkdir` as the
// lock primitive (POSIX mkdir either creates the dir or fails EEXIST — no
// separate compare-and-swap needed), an owner.json recording {pid, host,
// startedAt} for diagnostics, and a two-layer reclaim so a crashed holder can
// never wedge every future caller forever:
//   1. age-based staleness (`staleMs`) — a purely time-based fallback;
//   2. positive dead-owner confirmation (same host + ESRCH on `kill(pid, 0)`) —
//      reclaims immediately instead of waiting out the FULL stale window,
//      closing the gap EI-7818 found in the pure age-based check alone.
// Deliberately duplicated here rather than importing from `@papercusp/test-config`:
// that package is TS or vitest-testcontainer-shaped, but the caller (a bare
// `node scripts/npm-install-safe.mjs`, run from `preinstall`/CI/any agent's raw
// shell, no build step) must stay plain-JS-executable with zero devDependency on
// the test toolchain. If a THIRD consumer shows up, promote both to one shared
// `libs/generic/fs-mutex` package instead of a third copy.
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 250;

/**
 * Host-wide reader/writer boundary for package-manager cache access.
 *
 * Safe installs hold a READER lease: installs in independent checkouts can keep
 * running concurrently. The retention janitor takes the WRITER lease before a
 * native npm/bun/pnpm cache prune, which drains every safe install first and
 * prevents a cache clear from racing extraction in staging, release, or a
 * checkpoint checkout. Keep the key here, beside the primitive both callers
 * already share, so the two sides cannot silently drift onto different locks.
 */
export const PACKAGE_CACHE_MUTEX_NAME = "package-manager-cache";

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Resolve one host-stable mutex root.
 *
 * `os.tmpdir()` is intentionally NOT used here. It follows each process's
 * TMPDIR, and Papercusp agents legitimately run with both TMPDIR unset and
 * TMPDIR=/tmp/pcv. That split one logical npm-install mutex across
 * /tmp/pcv/fs-mutex-locks and /tmp/pcv/pcv/fs-mutex-locks, allowing two root
 * reifiers to hollow shared packages concurrently (WI-40965 / D-031).
 *
 * Keep the existing Linux/macOS default path so already-running default-env
 * callers retain lock continuity. Windows has no guaranteed /tmp, so use the
 * account home there. PAPERCUSP_FS_MUTEX_LOCK_DIR remains the explicit test /
 * operator override on every platform.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, homeDir?: string }} [options]
 */
export function resolveFsMutexLockRoot(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const stableDefault =
    platform === "win32"
      ? join(homeDir, ".papercusp", "fs-mutex-locks")
      : "/tmp/pcv/fs-mutex-locks";
  return resolve(env.PAPERCUSP_FS_MUTEX_LOCK_DIR ?? stableDefault);
}

function lockRoot() {
  return resolveFsMutexLockRoot();
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readerRoot(lockRootDir, name) {
  return join(lockRootDir, `${safeName(name)}.readers`);
}

async function readOwner(lockDir) {
  try {
    return await readFile(join(lockDir, "owner.json"), "utf8");
  } catch {
    return "(owner unknown)";
  }
}

/**
 * True only when we can POSITIVELY confirm the lock's recorded owner process is
 * dead: same host (a cross-host pid means nothing) AND `process.kill(pid, 0)`
 * reports ESRCH (no such process). Any other outcome (different host,
 * unparseable owner.json, EPERM/alive, or any other error) returns false — this
 * must never produce a false "dead" that reclaims a live holder's lock.
 */
async function isOwnerProcessConfirmedDead(lockDir) {
  let raw;
  try {
    raw = await readFile(join(lockDir, "owner.json"), "utf8");
  } catch {
    return false;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof owner.pid !== "number" || typeof owner.host !== "string")
    return false;
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // no throw ⇒ signal delivered ⇒ process exists (or we lack permission ⇒ assume alive)
  } catch (error) {
    return error && error.code === "ESRCH";
  }
}

async function lockAgeMs(lockDir) {
  return stat(lockDir)
    .then((s) => Date.now() - s.mtimeMs)
    .catch(() => 0);
}

async function reclaimAbandonedLock(lockDir, staleMs) {
  // Confirm a dead owner before falling back to the existing age-based safety
  // valve. The positive pid check is what lets a crashed reader release its
  // marker promptly; the age fallback also handles a process dying between
  // mkdir and owner.json, where there is no pid to inspect.
  if (
    (await isOwnerProcessConfirmedDead(lockDir)) ||
    (await lockAgeMs(lockDir)) > staleMs
  ) {
    await rm(lockDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

// EI-21915677034576963 — a FIFO fairness queue for `withFsMutex`'s WRITE-mode
// acquisition. Without this, a waiter is just one more `mkdir()` racer on a fixed
// poll cycle, so a caller that re-acquires the SAME lock repeatedly across many
// short-lived sub-invocations (e.g. one shard of a broad affected-tests run after
// another, each its own `runBudgetedTasks` -> `withFsMutex` call) gets a fresh,
// immediate shot at the mkdir() every time it releases, with no fairness against a
// caller that has already been waiting — a bounded/narrow verification run can be
// starved for hours behind a "continuous sequence" of such re-acquisitions even
// though it registered first. Each caller now registers a ticket BEFORE racing for
// the lock, and only the OLDEST live ticket is allowed to attempt the mkdir on any
// given poll — a brand-new sub-invocation always registers a brand-new, strictly
// YOUNGER ticket, so it can never leapfrog someone who was already waiting.

function queueRoot(lockRootDir, name) {
  return join(lockRootDir, `${safeName(name)}.queue`);
}

/**
 * A FIFO-orderable, globally-unique ticket id: a zero-padded epoch-ms prefix (so
 * lexicographic directory-listing order matches chronological registration order)
 * plus pid+uuid to break same-millisecond ties and guarantee uniqueness across
 * concurrent callers on the same host.
 */
function ticketId(startedAtMs) {
  return `${String(startedAtMs).padStart(16, "0")}-${process.pid}-${randomUUID()}`;
}

// EI-21917992245424964: the owner record answered "IS the holder alive?" and nothing about
// "is the holder WORTH waiting for?". A blocked peer therefore saw {pid, host, startedAt,
// name} and had to choose between waiting indefinitely and interrupting possibly-critical
// work — so the safe default was always to wait. Measured 2026-08-30: a peer read "it is
// progressing, so I will not interrupt it" off a holder that had just entered a ~26-minute
// leg whose output nobody wanted; resolution needed an out-of-band coord message and the
// holder happening to be awake to answer it.
//
// `intent` is that missing half: a small, caller-supplied, self-describing record carried
// INSIDE the owner record, so the answer travels with the lock and is readable by anyone
// who is blocked, with no round-trip and no liveness on the holder's part.
//
// Bounded on purpose. This value is written into a file that every waiter reads and that a
// timeout embeds into an error message, so an unbounded caller value would be a way to make
// the lock's own diagnostics unreadable — or to break the JSON a waiter parses. Scalars
// only, key- and length-capped, and anything unrepresentable is DROPPED rather than
// coerced: a missing field reads as "not declared", which is honest, whereas a coerced
// "[object Object]" reads as data.
const INTENT_MAX_KEYS = 12;
const INTENT_MAX_STRING_CHARS = 200;

function sanitizeIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent))
    return null;
  const out = {};
  let kept = 0;
  for (const [key, value] of Object.entries(intent)) {
    if (kept >= INTENT_MAX_KEYS) break;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      out[key] =
        value.length > INTENT_MAX_STRING_CHARS
          ? `${value.slice(0, INTENT_MAX_STRING_CHARS)}…`
          : value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    kept += 1;
  }
  return kept > 0 ? out : null;
}

/**
 * Reclaim one abandoned WAIT TICKET. Deliberately NOT the same policy as
 * `reclaimAbandonedLock`: a ticket legitimately gets old while its owner is
 * genuinely still waiting — that is exactly the multi-hour starvation this queue
 * exists to prevent — so age alone must NEVER reclaim a ticket whose owner.json
 * parses and names a still-alive process; only a POSITIVELY confirmed-dead owner
 * does. Age is still the fallback ONLY for the narrow "mkdir landed, owner.json
 * never did" crash window: a ticket with no readable owner can never be confirmed
 * dead by pid, and left unreclaimed would otherwise wedge the whole queue behind a
 * phantom waiter forever.
 */
async function reclaimAbandonedTicket(ticketDir, staleMs) {
  let raw;
  try {
    raw = await readFile(join(ticketDir, "owner.json"), "utf8");
  } catch {
    if ((await lockAgeMs(ticketDir)) > staleMs)
      await rm(ticketDir, { recursive: true, force: true });
    return;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    if ((await lockAgeMs(ticketDir)) > staleMs)
      await rm(ticketDir, { recursive: true, force: true });
    return;
  }
  if (
    typeof owner.pid !== "number" ||
    typeof owner.host !== "string" ||
    owner.host !== hostname()
  )
    return;
  try {
    process.kill(owner.pid, 0);
    return; // no throw ⇒ signal delivered ⇒ owner is alive (or unconfirmable ⇒ assume alive)
  } catch (error) {
    if (error && error.code === "ESRCH")
      await rm(ticketDir, { recursive: true, force: true });
  }
}

/**
 * The ticket that has been waiting LONGEST for `name`'s write lock, after
 * reclaiming any abandoned tickets — or null when the queue directory cannot be
 * read. Fail-open: no ordering information ⇒ the caller falls back to racing for
 * the lock directly, so a broken/unreadable queue can never deadlock acquisition.
 */
async function oldestTicketDir(ticketsDir, staleMs) {
  let entries;
  try {
    entries = await readdir(ticketsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const ticketDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ticketsDir, entry.name));
  for (const ticketDir of ticketDirs)
    await reclaimAbandonedTicket(ticketDir, staleMs);
  let remaining;
  try {
    remaining = (await readdir(ticketsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  return remaining.length ? join(ticketsDir, remaining[0]) : null;
}

async function writerLockIsHeld(lockDir, staleMs) {
  try {
    await stat(lockDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return !(await reclaimAbandonedLock(lockDir, staleMs));
}

async function listReaderLocks(readersDir) {
  try {
    const entries = await readdir(readersDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(readersDir, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForReaders(
  readersDir,
  {
    timeoutMs,
    staleMs,
    retryMs,
    startedAt,
    onWaiting,
    waitingNoticeIntervalMs = 0,
  },
) {
  let announcedWaiting = false;
  // WI-1490656: same re-announce cadence as the write-lock wait. Fixing only the write path
  // would leave the identical silent-wait hole here — a writer blocked behind long-lived
  // READERS goes just as quiet, and looks just as much like a wedge.
  let lastWaitingNoticeMs = 0;
  for (;;) {
    const readers = await listReaderLocks(readersDir);
    for (const reader of readers) await reclaimAbandonedLock(reader, staleMs);
    const activeReaders = await listReaderLocks(readersDir);
    if (activeReaders.length === 0) return;

    const elapsed = Date.now() - startedAt;
    const dueForNotice =
      !announcedWaiting ||
      (waitingNoticeIntervalMs > 0 &&
        elapsed - lastWaitingNoticeMs >= waitingNoticeIntervalMs);
    if (dueForNotice && onWaiting) {
      announcedWaiting = true;
      lastWaitingNoticeMs = elapsed;
      onWaiting({
        owner: await readOwner(activeReaders[0]),
        elapsedMs: elapsed,
      });
    }
    if (elapsed > timeoutMs) {
      const currentOwner = await readOwner(activeReaders[0]);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for fs-mutex readers (${readersDir}); holder: ${currentOwner}`,
      );
    }
    await sleep(retryMs);
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process, filesystem-local mutex
 * named `name`. Blocks (retrying every `retryMs`) until acquired, a stale/dead
 * holder is reclaimed, or `timeoutMs` elapses (throws). Always releases in a
 * `finally`, even if `fn` throws.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ mode?: 'read' | 'reader' | 'write', timeoutMs?: number, staleMs?: number, retryMs?: number, onWaiting?: (info: { owner: string, elapsedMs: number }) => void, waitingNoticeIntervalMs?: number, onAcquired?: (info: { waitedMs: number }) => void, intent?: Record<string, string | number | boolean> }} [opts]
 * @returns {Promise<T>}
 */
export async function withFsMutex(name, fn, opts = {}) {
  if (opts.mode === "read" || opts.mode === "reader")
    return withFsMutexRead(name, fn, opts);
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX === "1") {
    return fn();
  }

  const root = lockRoot();
  const lockDir = join(root, `${safeName(name)}.lock`);
  const readersDir = readerRoot(root, name);
  const timeoutMs =
    opts.timeoutMs ??
    intEnv("PAPERCUSP_FS_MUTEX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const staleMs =
    opts.staleMs ?? intEnv("PAPERCUSP_FS_MUTEX_STALE_MS", DEFAULT_STALE_MS);
  const retryMs =
    opts.retryMs ?? intEnv("PAPERCUSP_FS_MUTEX_RETRY_MS", DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  // Nested under its own key rather than merged: a caller can then never shadow `pid` /
  // `host` / `startedAt`, which are the fields the reclaim path and every waiter trust.
  const intent = sanitizeIntent(opts.intent);
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
    ...(intent ? { intent } : {}),
  };

  await mkdir(root, { recursive: true });

  // EI-21915677034576963: register a FIFO ticket BEFORE racing for the write lock, so a
  // caller that has been waiting longest is never overtaken by a newer one that simply
  // happens to poll at a luckier moment — including the SAME long-running caller
  // re-entering across its own successive sub-invocations (e.g. one shard after
  // another): each is a brand-new `withFsMutex` call, so it always registers a
  // brand-new, strictly YOUNGER ticket than anyone already waiting. Best-effort: if the
  // ticket bookkeeping itself fails for any reason, fall back to the pre-existing racing
  // behaviour for THIS caller rather than ever deadlocking on a broken queue.
  const ticketsDir = queueRoot(root, name);
  const myTicketDir = join(ticketsDir, `${ticketId(startedAt)}.ticket`);
  let ticketRegistered = false;
  try {
    await mkdir(ticketsDir, { recursive: true });
    await mkdir(myTicketDir);
    await writeFile(
      join(myTicketDir, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
    );
    ticketRegistered = true;
  } catch {
    ticketRegistered = false;
  }

  let announcedWaiting = false;
  let lastWaitingNoticeMs = 0;
  // WI-1490656 — EI-21921867787033533 wired a FIRST-wait notice, but it fires exactly
  // ONCE, at t≈0. A caller that then queues for hours produces no further output, so any
  // observer who attaches later (or reads a rotated capture) sees a process parked in
  // ep_poll with zero children and a frozen log — byte-for-byte indistinguishable from a
  // genuine wedge, and repeatedly misdiagnosed as one. Callers that pass
  // `waitingNoticeIntervalMs` get the notice RE-ANNOUNCED on that cadence, so the WAITING
  // state keeps emitting attributable forward-progress bytes for as long as it lasts.
  const waitingNoticeIntervalMs =
    Number(opts.waitingNoticeIntervalMs) > 0
      ? Number(opts.waitingNoticeIntervalMs)
      : 0;
  const announceWaiting = async (elapsedMs) => {
    if (!opts.onWaiting) return;
    const due =
      !announcedWaiting ||
      (waitingNoticeIntervalMs > 0 &&
        elapsedMs - lastWaitingNoticeMs >= waitingNoticeIntervalMs);
    if (!due) return;
    announcedWaiting = true;
    lastWaitingNoticeMs = elapsedMs;
    opts.onWaiting({ owner: await readOwner(lockDir), elapsedMs });
  };
  try {
    for (;;) {
      if (ticketRegistered) {
        const oldest = await oldestTicketDir(ticketsDir, staleMs);
        if (oldest != null && oldest !== myTicketDir) {
          // Someone else registered first — don't even attempt the mkdir race this
          // cycle; let them go before us.
          const elapsed = Date.now() - startedAt;
          await announceWaiting(elapsed);
          if (elapsed > timeoutMs) {
            const currentOwner = await readOwner(lockDir);
            throw new Error(
              `Timed out after ${timeoutMs}ms waiting for fs-mutex "${name}" (${lockDir}); holder: ${currentOwner}`,
            );
          }
          await sleep(retryMs);
          continue;
        }
      }
      try {
        await mkdir(lockDir);
        // WI-1490656: `startedAt` is when this caller began TRYING, so it includes its own
        // queue wait and cannot answer "how long has the lock been HELD" — the one question a
        // triager staring at a stalled pipeline actually asks. Reading it as a hold duration
        // produced a wrong, confidently-reported measurement during this very investigation.
        // The mkdir above IS the grant, so stamp the grant instant here and make it
        // answerable instead of inviting the same misreading again.
        await writeFile(
          join(lockDir, "owner.json"),
          `${JSON.stringify({ ...owner, acquiredAt: new Date().toISOString() }, null, 2)}\n`,
        );
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;

        const elapsed = Date.now() - startedAt;
        await announceWaiting(elapsed);
        const lockAgeMs = await stat(lockDir)
          .then((s) => Date.now() - s.mtimeMs)
          .catch(() => 0);
        if (lockAgeMs > staleMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (await isOwnerProcessConfirmedDead(lockDir)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (elapsed > timeoutMs) {
          const currentOwner = await readOwner(lockDir);
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for fs-mutex "${name}" (${lockDir}); holder: ${currentOwner}`,
          );
        }
        await sleep(retryMs);
      }
    }
  } finally {
    if (ticketRegistered) {
      try {
        await rm(myTicketDir, { recursive: true, force: true });
      } catch {
        // best-effort — a missing/already-cleaned ticket is not an error
      }
    }
  }

  try {
    await waitForReaders(readersDir, {
      timeoutMs,
      staleMs,
      retryMs,
      startedAt,
      onWaiting: opts.onWaiting,
      waitingNoticeIntervalMs,
    });
    // WI-1490656: report how long admission actually QUEUED. A caller that re-acquires
    // the same lock across many short sub-invocations (one affected-tests shard after
    // another) otherwise has no way to bound its TOTAL queue time — each call's
    // `timeoutMs` restarts from zero, so an N-shard run's real worst case is N × timeoutMs.
    // Fires inside the try so a throwing callback still releases the lock.
    if (opts.onAcquired) opts.onAcquired({ waitedMs: Date.now() - startedAt });
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` while holding a shared reader marker for `name`. Readers do not
 * acquire the writer's exclusive mkdir lock, so independent dependency reads
 * can proceed together. A reader marker is installed before checking the
 * writer lock; a writer that wins the race therefore waits for that marker,
 * while a reader that observes an existing writer backs out and retries.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ mode?: 'read' | 'reader', timeoutMs?: number, staleMs?: number, retryMs?: number, onWaiting?: (info: { owner: string, elapsedMs: number }) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withFsMutexRead(name, fn, opts = {}) {
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX === "1") return fn();

  const root = lockRoot();
  const writerDir = join(root, `${safeName(name)}.lock`);
  const readersDir = readerRoot(root, name);
  const timeoutMs =
    opts.timeoutMs ??
    intEnv("PAPERCUSP_FS_MUTEX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const staleMs =
    opts.staleMs ?? intEnv("PAPERCUSP_FS_MUTEX_STALE_MS", DEFAULT_STALE_MS);
  const retryMs =
    opts.retryMs ?? intEnv("PAPERCUSP_FS_MUTEX_RETRY_MS", DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  const readerDir = join(
    readersDir,
    `${process.pid}-${Date.now()}-${randomUUID()}.lock`,
  );
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
    mode: "read",
  };

  await mkdir(root, { recursive: true });
  await mkdir(readersDir, { recursive: true });

  let announcedWaiting = false;
  for (;;) {
    let markerCreated = false;
    let ready = false;
    try {
      await mkdir(readerDir);
      markerCreated = true;
      await writeFile(
        join(readerDir, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
      );
      ready = !(await writerLockIsHeld(writerDir, staleMs));
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (markerCreated)
          await rm(readerDir, { recursive: true, force: true });
        throw error;
      }
    }

    if (ready) break;
    if (markerCreated) await rm(readerDir, { recursive: true, force: true });

    const elapsed = Date.now() - startedAt;
    if (!announcedWaiting && opts.onWaiting) {
      announcedWaiting = true;
      opts.onWaiting({ owner: await readOwner(writerDir), elapsedMs: elapsed });
    }
    if (elapsed > timeoutMs) {
      const currentOwner = await readOwner(writerDir);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for fs-mutex writer ("${name}"); holder: ${currentOwner}`,
      );
    }
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    await rm(readerDir, { recursive: true, force: true });
  }
}

/**
 * EI-19304880034803985 — a NON-blocking, synchronous peek at whether `name`'s
 * mutex is currently held, for a caller that wants to WARN a caller ("an
 * install may be about to make you hang") rather than wait/acquire it.
 *
 * Deliberately does not reclaim a stale/dead-owner lock (that mutates shared
 * state — a caller merely peeking must never race the real holder's own
 * cleanup) and deliberately does not throw on any read/parse failure — an
 * inconclusive peek reports `held:false` (never block a caller on a
 * diagnostic that fails open by design, mirroring `withFsMutex`'s own
 * fail-open error handling).
 *
 * @param {string} name
 * @returns {{ held: boolean, owner?: { pid?: number, host?: string, startedAt?: string, name?: string, intent?: Record<string, string | number | boolean> }, lockDir: string }}
 */
export function peekFsMutexSync(name) {
  const lockDir = join(lockRoot(), `${safeName(name)}.lock`);
  try {
    const raw = readFileSync(join(lockDir, "owner.json"), "utf8");
    return { held: true, owner: JSON.parse(raw), lockDir };
  } catch {
    return { held: false, lockDir };
  }
}
