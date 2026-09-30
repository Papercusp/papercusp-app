/**
 * owner-identity-env — fill the owner-identity variables from the box's
 * owner-provisioned config file, for the release CLIs that need them.
 *
 * WHY THIS EXISTS
 * ---------------
 * `identityLiterals()` resolves the owner's NAME from `PAPERCUSP_RELEASE_OWNER_NAME`,
 * and that one literal decides whether two *different* things work:
 *
 *   - the SCRUB (record-release-cli --regenerate) — without it the scrub redacts
 *     NOTHING, silently, while still producing a complete-looking site; and
 *   - the GATE (gate-release-site) — without it the gate refuses to certify (exit 2),
 *     because a CLEAN verdict it cannot back up is worse than no gate at all.
 *
 * On this box `git config user.name` belongs to the git-sync automation rather than to a
 * person, so git can NEVER supply the literal and it must come from elsewhere. It was
 * being supplied by hand — every operator and every runbook had to remember
 * `set -a; . ~/.papercusp/release-identity.env; set +a` before either command, and
 * forgetting it produced two failures that look nothing like a missing variable: a
 * confusing exit-2 refusal from the gate, or (worse) a silently unredacted site.
 * Measured 2026-09-22: the file existed on this box and was referenced by NO code at
 * all — it was pure operator folklore.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not weaken the "read at run time, never stored" rule in release-content-scrub.
 * That rule is about SOURCE FILES: writing the owner's real name into a file committed
 * to git would itself be the leak. This file lives outside the repo, in the owner's own
 * `~/.papercusp/` config directory, exactly like the `release-host.env` and `r2.env`
 * that publish-release-history.sh already sources for the same reason.
 *
 * DELIBERATELY NOT CALLED FROM `identityLiterals()`
 * ------------------------------------------------
 * It is called from the CLI ENTRY POINTS, never from the resolver. Burying a file read
 * inside `identityLiterals()` would make `record-release-generator-fails-closed.test.ts`
 * — whose whole job is to prove the ABSENT-variable path fails closed — pass on a box
 * where this file happens to exist and fail in CI where it does not. A guard whose
 * verdict depends on the developer's home directory is not a guard.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

/** Override the config path (tests, a container, a non-standard install). */
export const IDENTITY_ENV_PATH_ENV = 'PAPERCUSP_RELEASE_IDENTITY_ENV';

/**
 * The ONLY keys this loader will set.
 *
 * An allowlist, not a blanket import: this file is owner-provisioned config, and a
 * `. file` that adopts whatever it happens to contain is how an unrelated stray line
 * silently changes the behaviour of a publish. Adding a key here is a deliberate act.
 */
export const OWNER_IDENTITY_KEYS = [
  'PAPERCUSP_RELEASE_OWNER_NAME',
  'PAPERCUSP_RELEASE_OWNER_EMAIL',
] as const;

export type OwnerIdentityKey = (typeof OWNER_IDENTITY_KEYS)[number];

export type LoadOwnerIdentityResult = {
  /** The path consulted, always reported so a caller can name it in an error. */
  path: string;
  /** Did that path exist and parse? */
  loaded: boolean;
  /** Why not, when `loaded` is false — for a log line, never for control flow. */
  reason?: 'no-file' | 'unreadable';
  /** Detail behind `unreadable`. */
  error?: string;
  /** Keys this call actually set in the environment. */
  filled: OwnerIdentityKey[];
  /** Keys left untouched because the environment already carried a value. */
  alreadySet: OwnerIdentityKey[];
};

export function defaultIdentityEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const explicit = (env[IDENTITY_ENV_PATH_ENV] ?? '').trim();
  return explicit || path.join(home, '.papercusp', 'release-identity.env');
}

/**
 * Fill any unset owner-identity variable from the config file.
 *
 * An EXPLICIT environment value always wins — this only ever fills a gap, so a caller
 * that exports the variable for one run (CI, a container, a different owner) keeps the
 * behaviour it asked for. A missing file is NOT an error: the variable may legitimately
 * be supplied by the environment, and the gate's own fail-closed branch is what turns a
 * genuinely-unresolvable name into a refusal. Reporting the miss here and refusing there
 * keeps "I could not read config" and "I cannot certify" as separate, visible facts.
 */
export function loadOwnerIdentityEnv(
  opts: {
    env?: NodeJS.ProcessEnv;
    filePath?: string;
    readFile?: (p: string) => string;
  } = {},
): LoadOwnerIdentityResult {
  const env = opts.env ?? process.env;
  const filePath = opts.filePath ?? defaultIdentityEnvPath(env);
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));

  const filled: OwnerIdentityKey[] = [];
  const alreadySet: OwnerIdentityKey[] = [];
  for (const key of OWNER_IDENTITY_KEYS) {
    if ((env[key] ?? '').trim() !== '') alreadySet.push(key);
  }
  if (alreadySet.length === OWNER_IDENTITY_KEYS.length) {
    // Nothing to fill. Do not touch the disk at all — an operator who exported both
    // should not get a "config unreadable" warning about a file nobody needed.
    return { path: filePath, loaded: true, filled, alreadySet };
  }

  let contents: string;
  try {
    contents = readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      path: filePath,
      loaded: false,
      reason: code === 'ENOENT' ? 'no-file' : 'unreadable',
      error: code === 'ENOENT' ? undefined : String((err as Error)?.message ?? err),
      filled,
      alreadySet,
    };
  }

  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(contents) as Record<string, string>;
  } catch (err) {
    return {
      path: filePath,
      loaded: false,
      reason: 'unreadable',
      error: String((err as Error)?.message ?? err),
      filled,
      alreadySet,
    };
  }

  for (const key of OWNER_IDENTITY_KEYS) {
    if (alreadySet.includes(key)) continue;
    const value = (parsed[key] ?? '').trim();
    if (value === '') continue;
    env[key] = value;
    filled.push(key);
  }

  return { path: filePath, loaded: true, filled, alreadySet };
}

/**
 * One line naming what was resolved and from where — WITHOUT printing the values.
 *
 * The values are the owner's real name and email. This whole subsystem exists to keep
 * those off a page we hand to strangers, so a loader that helpfully echoes them into a
 * build log that gets pasted into a work item would be the same leak by another route.
 * Report the KEYS and the PATH; never the values.
 */
export function describeOwnerIdentityLoad(r: LoadOwnerIdentityResult): string {
  if (r.filled.length > 0) {
    return `[identity] resolved ${r.filled.join(', ')} from ${r.path}`;
  }
  if (r.alreadySet.length > 0 && r.loaded) {
    return `[identity] using ${r.alreadySet.join(', ')} already set in the environment`;
  }
  if (r.reason === 'no-file') {
    return `[identity] no ${r.path} — relying on the environment alone`;
  }
  return `[identity] could not read ${r.path}: ${r.error ?? 'unknown error'}`;
}
