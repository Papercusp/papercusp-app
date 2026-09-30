/**
 * identity-scrub — the IDENTITY gate on the Cupboard publish path.
 *
 * A published package is pushed to a PUBLIC mirror repo BY DESIGN: the documented
 * flow is export → push → publish. Every byte an export writes is therefore a byte
 * that goes public, and the publisher's identity must not ride along in it.
 *
 * This module exists because the live-state stripper never covered identity
 * (EI-23420285862298325). `cupboard:publish-goal` reported a sanitized `stripped`
 * summary while the exported goal.json retained the owner's personal account handle
 * at 10+ sites under `launchSettings.roles.*.account` — a report that read as
 * complete sanitization while the package was not sanitized at all. That is the
 * worst shape a sanitizer can have: it converts "nobody checked" into "somebody
 * checked and it was fine".
 *
 * TWO MECHANISMS, deliberately different, because the right answer depends on WHAT
 * the identity is sitting in:
 *
 *   1. SCRUB structured CONFIG — `scrubIdentityFields`. A value under an
 *      identity-bearing KEY (`account`, `ownerId`, `email`, …) is configuration,
 *      and a package is supposed to ship DEFAULTS. Replacing it with a typed
 *      placeholder IS the package semantic, so it is scrubbed and REPORTED.
 *
 *   2. REFUSE prose and scripts — `scanIdentityLeaks` + `assertIdentityClean`.
 *      Identity inside a duty body or a recipe script is not configuration, it is
 *      load-bearing text. Rewriting it would publish something that reads — or
 *      RUNS — differently from what its title claims. recipe-export.ts already
 *      makes exactly this call for workspace-scoped refs, for the same reason:
 *      laundering is worse than refusing.
 *
 * THE SCAN IS NOT A REPORT. `assertIdentityClean` THROWS, and callers run it on the
 * exact serialized bytes immediately before `writeFileSync`. A check whose failure
 * cannot stop the next step is decoration — the incident that produced this module
 * was contained only after a hand-rolled scan faithfully PRINTED the leak and the
 * push ran anyway in the same `set -e` block, because `grep | wc -l` prints "1" and
 * exits 0. Gate on control flow, never on a printed count.
 *
 * SECRETS are a neighbouring concern with its own module: `../sensitive-text`
 * (credentials, bearer tokens, key-directed assignments). This gate COMPOSES that
 * detector rather than re-implementing it, so a package carrying a credential is
 * refused by the same chokepoint that refuses one carrying a handle.
 *
 * KNOWN LIMIT, stated rather than papered over: mechanism 2 catches a stray copy of
 * an identity value only when that value was ALSO harvested by mechanism 1 (or
 * matches one of the host-shaped patterns below). A handle that appears ONLY as a
 * schema `default`, under no identity-bearing key anywhere in the package, is not
 * detectable by shape and will pass. Widen IDENTITY_KEYS when such a field appears.
 */
import { userInfo } from 'node:os';
import {
  isIdentityFieldName,
  scanIdentityLeaks as scanGenericIdentityLeaks,
  type ContentIdentityLeakHit,
} from '@papercusp/artifact-registry';

/** One structured field the scrubber replaced. */
export interface IdentityScrubHit {
  /** Dotted path to the scrubbed value, e.g. `launchSettings.roles.leader.account`. */
  path: string;
  /** The identity-bearing key that selected it. */
  key: string;
}

export interface IdentityScrubResult<T> {
  /** A deep COPY with identity fields replaced; the input is never mutated. */
  value: T;
  scrubbed: IdentityScrubHit[];
  /**
   * The ORIGINAL values removed. Fed to `scanIdentityLeaks` so that a copy of the
   * same handle surviving somewhere else in the package — a duty body, a script, a
   * schema default — is caught even though nothing about its SHAPE marks it as an
   * identity.
   */
  identityValues: string[];
}

export type IdentityLeakHit = ContentIdentityLeakHit;

/**
 * Keys whose VALUE identifies a person, an agent, or this installation.
 *
 * Named explicitly rather than derived by omission, so a new identity-bearing field
 * forces a decision here instead of leaking by default (the rationale recipe-export
 * gives for its own STRIPPED_FIELDS list).
 *
 * Compared case- and separator-insensitively, so `account_id`, `accountId` and
 * `Account-ID` all match one entry.
 */
const placeholderFor = (key: string): string => `<scrubbed:${key}>`;

const isPlaceholder = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('<scrubbed:');

/** Strings and finite numbers carry identity; objects and arrays are containers to
 *  recurse into, and replacing a whole subtree would destroy package shape. */
const isScrubbableValue = (value: unknown): value is string | number => {
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' && Number.isFinite(value);
};

const MIN_HARVESTED_LENGTH = 3;

/**
 * Replace every identity-bearing CONFIG value with a typed placeholder, returning a
 * deep copy plus the evidence of what was removed.
 *
 * Only values sitting directly under an identity-bearing key are touched. Prose is
 * never rewritten — a duty body or a script is text whose meaning the publisher owns,
 * and silently editing it is the failure this module refuses to commit. Prose leaks
 * are caught by `scanIdentityLeaks` and REFUSED instead.
 */
export function scrubIdentityFields<T>(input: T): IdentityScrubResult<T> {
  const scrubbed: IdentityScrubHit[] = [];
  const identityValues = new Set<string>();

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((entry, i) => walk(entry, `${path}[${i}]`));
    if (node === null || typeof node !== 'object') return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;

      if (isIdentityFieldName(key)) {
        // Already scrubbed (a re-export of an exported package) — clean, not a hit.
        if (isPlaceholder(value)) {
          out[key] = value;
          continue;
        }
        if (isScrubbableValue(value)) {
          const literal = String(value);
          if (literal.length >= MIN_HARVESTED_LENGTH) identityValues.add(literal);
          scrubbed.push({ path: childPath, key });
          out[key] = placeholderFor(key);
          continue;
        }
      }

      out[key] = walk(value, childPath);
    }
    return out;
  };

  return {
    value: walk(input, '') as T,
    scrubbed,
    identityValues: [...identityValues],
  };
}

export interface ScanIdentityOptions {
  /**
   * Values harvested by `scrubIdentityFields`. A surviving copy of one of these is
   * the highest-confidence leak there is: the package itself told us the value
   * identifies its publisher.
   */
  knownIdentityValues?: readonly string[];
  /**
   * The host account name. Injected so the scan is deterministic under test;
   * production resolves it from the OS.
   */
  osUser?: string | null;
}

/**
 * Find publisher identity surviving in serialized package bytes.
 *
 * Returns hits rather than throwing, so a caller can report as well as refuse.
 * The refusing caller is `assertIdentityClean`.
 */
export function scanIdentityLeaks(text: string, opts: ScanIdentityOptions = {}): IdentityLeakHit[] {
  return scanGenericIdentityLeaks(text, {
    ...opts,
    osUser: opts.osUser === undefined ? currentOsUser() : opts.osUser,
  });
}

function currentOsUser(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

/**
 * Thrown by `assertIdentityClean`. Carries the hits so a tool surface can name
 * exactly what to fix rather than making the publisher re-run a hand scan.
 */
export class IdentityLeakError extends Error {
  /** Brand: `instanceof` is unreliable across duplicated module records, and this
   *  file is reached through several import specifiers. */
  readonly isIdentityLeakError = true as const;
  readonly hits: IdentityLeakHit[];
  readonly where: string;

  constructor(where: string, hits: IdentityLeakHit[]) {
    const detail = hits
      .map((h) => `${h.kind} ${JSON.stringify(h.value)}x${h.occurrences}`)
      .join('; ');
    super(
      `${where} still carries publisher identity and was NOT written (${detail}). ` +
        `A published package is pushed to a PUBLIC repo, so this is refused rather than ` +
        `rewritten: editing prose or a script to remove the value would publish something ` +
        `that reads or runs differently from what its title claims. Remove the identity at ` +
        `the source (generalize the text, parameterize the value) and re-export.`,
    );
    this.name = 'IdentityLeakError';
    this.hits = hits;
    this.where = where;
  }
}

export const isIdentityLeakError = (e: unknown): e is IdentityLeakError =>
  typeof e === 'object' &&
  e !== null &&
  (e as { isIdentityLeakError?: unknown }).isIdentityLeakError === true;

/**
 * THE GATE. Throw unless `text` is free of publisher identity.
 *
 * Call this on the exact bytes about to be written, not on an earlier
 * representation of them — the whole point is that the check and the write cannot
 * disagree.
 */
export function assertIdentityClean(
  text: string,
  where: string,
  opts: ScanIdentityOptions = {},
): void {
  const hits = scanIdentityLeaks(text, opts);
  if (hits.length > 0) throw new IdentityLeakError(where, hits);
}
