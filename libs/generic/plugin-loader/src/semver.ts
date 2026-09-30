/**
 * Minimal semver-range matcher for plugin runtime-version validation.
 *
 * Supports the subset of npm's semver syntax that real plugin manifests
 * actually use:
 *
 *   "1.2.3"        exact match
 *   "^1.2.3"       compatible-with-1.x: >=1.2.3 <2.0.0  (or, for 0.x:
 *                  >=0.2.3 <0.3.0 — npm's "caret with leading zero"
 *                  semantics, locking on the first non-zero segment)
 *   "~1.2.3"       approximately-1.2: >=1.2.3 <1.3.0
 *   ">=1.2.3"      open-ended lower bound
 *   "*"            anything
 *
 * Pre-release tags + build metadata are not supported — plugins are
 * expected to ship as `X.Y.Z` releases, no pre-release qualifiers.
 *
 * Pure: no I/O, no dependencies. A consuming host uses this to decide
 * whether a plugin's declared range covers the host's runtime version.
 */

interface Triple { major: number; minor: number; patch: number }

/**
 * Parse a semver string into a `{major, minor, patch}` triple. Accepts:
 *
 *   "1.2.3"   exact
 *   "1.2"     shorthand for "1.2.0"
 *   "1"       shorthand for "1.0.0"
 *
 * Range strings like "^1.2" reuse this and inherit the same shorthands;
 * matches `npm` / `cargo` semver semantics for partial versions.
 */
function parse(version: string): Triple | null {
  const trimmed = version.trim();
  let m = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  m = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: 0 };
  m = /^(\d+)$/.exec(trimmed);
  if (m) return { major: Number(m[1]), minor: 0, patch: 0 };
  return null;
}

function cmp(a: Triple, b: Triple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function inRange(v: Triple, lo: Triple, hi: Triple): boolean {
  // Half-open interval: [lo, hi)
  return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
}

/**
 * Check whether `version` (e.g. '0.1.0') satisfies `range` (e.g. '^0.1.0').
 *
 * Returns false if either input fails to parse, so a malformed manifest
 * range fails loud at load time rather than silently allowing the plugin.
 */
export function satisfies(version: string, range: string): boolean {
  if (!range || typeof range !== 'string') return false;
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'x') return true;
  const v = parse(version);
  if (!v) return false;

  // ^X.Y.Z — compatible-within-major (or, for 0.x, within-minor; for
  // 0.0.z, exact patch).
  if (trimmed.startsWith('^')) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    let hi: Triple;
    if (base.major > 0) {
      hi = { major: base.major + 1, minor: 0, patch: 0 };
    } else if (base.minor > 0) {
      hi = { major: 0, minor: base.minor + 1, patch: 0 };
    } else {
      hi = { major: 0, minor: 0, patch: base.patch + 1 };
    }
    return inRange(v, base, hi);
  }

  // ~X.Y.Z — approximately-Y: locks the minor.
  if (trimmed.startsWith('~')) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    const hi = { major: base.major, minor: base.minor + 1, patch: 0 };
    return inRange(v, base, hi);
  }

  // >=X.Y.Z — open lower bound.
  if (trimmed.startsWith('>=')) {
    const base = parse(trimmed.slice(2).trim());
    if (!base) return false;
    return cmp(v, base) >= 0;
  }

  // Bare X.Y.Z — exact match.
  const exact = parse(trimmed);
  if (!exact) return false;
  return cmp(v, exact) === 0;
}
