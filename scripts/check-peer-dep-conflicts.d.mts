// Type declarations for check-peer-dep-conflicts.mjs — a plain ESM script with no build
// step, consumed both as a CLI (`npm run lint:peer-dep-conflicts`) and, for its pure
// core, imported from a Vitest test
// (packages/operator-core/lib/__tests__/check-peer-dep-conflicts.test.ts).

/** A peer declaration the installed tree cannot satisfy. */
export interface PeerConflict {
  /** `name` from the declaring workspace's package.json, else its directory. */
  workspace: string;
  /** Workspace directory, relative to the scanned root. */
  dir: string;
  /** The peer dependency name. */
  dep: string;
  /** The declared peer range, verbatim. */
  range: string;
  /** The concrete version installed under the scanned root's node_modules. */
  installed: string;
}

/**
 * A declaration that could NOT be judged — an unimplemented range/version form, or an
 * unreadable installed manifest. Reported as exit 2 (NOT CHECKED), never as clean.
 */
export interface PeerUnsupported {
  workspace: string;
  dir: string;
  dep: string;
  range: string;
  installed?: string;
  reason: string;
}

/**
 * A peer declaration recorded differently in package.json and package-lock.json.
 * `npm install` re-resolves from the manifest; `npm ci` installs from the lock — so any
 * divergence means the two install paths can produce different trees.
 */
export interface PeerLockDrift {
  workspace: string;
  dir: string;
  dep: string;
  /** Range in the workspace's package.json, or null when absent there. */
  manifest: string | null;
  /** Range recorded in package-lock.json, or null when absent there. */
  lock: string | null;
}

export interface PeerScanResult {
  conflicts: PeerConflict[];
  unsupported: PeerUnsupported[];
  /** null when package-lock.json is missing/unreadable — reported as NOT CHECKED. */
  drift: PeerLockDrift[] | null;
  /** Declarations actually judged (external, installed, and parseable). */
  checked: number;
  /** External peers with nothing installed to judge against — skipped, not flagged. */
  unprovided: number;
  /** Every peer declaration seen, including local-scope ones that are not judged. */
  declarations: number;
  /** Workspace package dirs resolved from the root `workspaces` globs. */
  workspaces: number;
}

/** Thrown instead of guessing at a range or version form the checker does not implement. */
export declare class UnsupportedRange extends Error {
  constructor(token: string);
  readonly name: 'UnsupportedRange';
  readonly token: string;
}

/** Parse `major.minor.patch`; null for prereleases, tags, and partial versions. */
export declare function parseVersion(v: string): [number, number, number] | null;

/**
 * Parse a range into alternatives (the `||` union), each an expanded comparator list.
 * @throws {UnsupportedRange} for `~`, `x` wildcards, hyphen ranges, and dist-tags.
 */
export declare function parseRange(range: string): Array<Array<{ op: string; v: number[] }>>;

/**
 * Does `version` satisfy `range`?
 * @throws {UnsupportedRange} when either side uses a form the checker will not judge.
 */
export declare function satisfies(version: string, range: string): boolean;

/** Scan a tree (defaults to the repo root, or `PEER_DEP_CONFLICTS_ROOT`). */
export declare function scan(root?: string): PeerScanResult;

/**
 * Compare each workspace's declared peers against the copy package-lock.json records.
 * Returns null when the lock is missing/unreadable (caller reports NOT CHECKED).
 */
export declare function scanLockDrift(root?: string): PeerLockDrift[] | null;

/** True only when Node invoked this checker as its direct CLI entrypoint. */
export declare function isDirectCliInvocation(entryPath?: string): boolean;

/** Shrink-only grandfather list, EMPTY by construction — see the script header. */
export declare const BASELINE: string[];

export declare const EXIT_OK: 0;
export declare const EXIT_CONFLICTS: 1;
export declare const EXIT_NOT_CHECKED: 2;
