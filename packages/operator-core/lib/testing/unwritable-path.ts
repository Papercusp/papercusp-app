/**
 * unwritable-path.ts — the ONE safe "guaranteed-unwritable path" test fixture.
 *
 * Fail-soft code is exactly the code that needs such a fixture ("never throws on an
 * unwritable path" is the assertion protecting every swallowed-error path we write),
 * so this idiom sits precisely where careful people walk. The obvious choice —
 * somewhere under `/proc/` — is a TRAP that hangs the process FOREVER.
 *
 * ## The trap, measured on this box 2026-08-02
 *
 *   node -e "fs.mkdirSync('/proc/definitely/not/writable',{recursive:true})"  -> HANGS
 *   node -e "fs.mkdirSync('/dev/null/nope',{recursive:true})"                 -> ENOTDIR, 0ms
 *   node -e "fs.mkdirSync('/sys/definitely/not/writable',{recursive:true})"   -> EACCES, 0ms
 *
 * MECHANISM (strace, 3s sample): 44,995 `mkdirat` syscalls, alternating 22,488
 * EEXIST and 22,489 ENOENT — a 1:1 ping-pong. procfs answers `mkdir` on a
 * non-existent path with **ENOENT** rather than EACCES/EPERM. Node's recursive
 * mkdir reads ENOENT as "the parent is missing", walks up to create `/proc`, gets
 * EEXIST ("parent already exists — retry the child"), and loops forever. Only
 * ENOENT triggers that retry, which is why `/sys` (EACCES) and a path under a
 * plain file (ENOTDIR) both fail instantly instead.
 *
 * ## Why this is banned by a lint rather than left to judgement
 *
 * The hang is **implementation-dependent and invisible at the call site**:
 * coreutils `mkdir -p` on the same path fails in 5ms, so a `/proc/...` fixture
 * consumed by a shell script is harmless while the identical string consumed by
 * Node's `mkdirSync({recursive:true})` wedges the run. A test author cannot see
 * which implementation will eventually receive the path. So the idiom is banned
 * outright — `scripts/check-no-proc-path-fixture.mjs` — instead of asking every
 * author to trace the consumer.
 *
 * ## Why the symptom is so expensive
 *
 * The hang happens during vitest COLLECTION, so the run emits zero output — no
 * banner, no filename, no test count. It is indistinguishable from a heavy job
 * queued behind the pc-heavy slot clamp, and it poisons sibling files sharing the
 * vitest process (they look wedged too). It has bitten twice: it wedged every gate
 * for hours on 2026-07-11, and on 2026-08-02 it cost a peer two misdiagnoses, two
 * kills and a pointless re-route before a differential localized it.
 *
 * DISCRIMINATOR worth remembering: when ONE test file hangs while its siblings pass
 * under the identical command, that is a PER-FILE signal and can never be
 * load/contention — contention does not select one file.
 *
 * @see EI-19369372064589484
 */

/**
 * A path component that EXISTS but is not a directory, so anything trying to
 * create or write a path beneath it fails immediately with ENOTDIR.
 *
 * `/dev/null` is a character device on both Linux and macOS, so this is portable
 * across every platform the repo tests on.
 */
export const UNWRITABLE_PATH_ROOT = '/dev/null';

/**
 * A ready-made guaranteed-unwritable *directory* path. Creating it, or writing any
 * file beneath it, throws ENOTDIR synchronously and instantly.
 *
 * ```ts
 * import { UNWRITABLE_PATH_FIXTURE } from '@papercusp/operator-core/lib/testing/unwritable-path';
 * expect(() => writeLedger(UNWRITABLE_PATH_FIXTURE)).not.toThrow(); // fail-soft
 * ```
 */
export const UNWRITABLE_PATH_FIXTURE = `${UNWRITABLE_PATH_ROOT}/definitely-not-writable`;

/**
 * Build a distinct guaranteed-unwritable path, for suites that need more than one
 * (or want the fixture to name the thing under test in a failure message).
 *
 * ```ts
 * unwritablePath('reds.jsonl')          // '/dev/null/definitely-not-writable/reds.jsonl'
 * unwritablePath('slots', 'heavy')      // '/dev/null/definitely-not-writable/slots/heavy'
 * ```
 *
 * Every returned path fails with ENOTDIR on first use — it never hangs, never
 * partially succeeds, and never depends on the current user's permissions (which
 * is the other reason not to reach for a root-owned directory here: a suite run as
 * root would silently start SUCCEEDING and the assertion would go vacuous).
 */
export function unwritablePath(...segments: string[]): string {
  const clean = segments.filter((s) => s !== '' && s !== '.').map((s) => s.replace(/^\/+|\/+$/g, ''));
  return [UNWRITABLE_PATH_FIXTURE, ...clean].join('/');
}
