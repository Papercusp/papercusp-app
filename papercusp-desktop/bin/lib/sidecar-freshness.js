// EI-19446480107603858 — is the prebuilt sidecar a build that carries the change
// this cut is supposed to ship?
//
// WHY THIS EXISTS
// `build-mac-cross.sh` (and `build-windows-cross.sh`) consume a sidecar that some
// EARLIER, separate command produced. Both gated it on EXISTENCE and ARCH only:
//
//     [[ -d "$DARWIN_SIDECAR/apps" && -f "$DARWIN_SIDECAR/bin/node" ]] || fail "... not found"
//     file "$DARWIN_SIDECAR/bin/node" | grep -q 'Mach-O'              || fail "... NOT darwin"
//
// Both guards are loud when the sidecar is MISSING and completely silent when it is
// STALE — and stale is the COMMON case, precisely because rebuilding it is a separate
// manual step nobody remembers. The guard is verbose in the rare case and mute in the
// frequent one.
//
// THE HALF-FRESH ARTIFACT — why staleness here is so deceptive
// The same build refreshes the OTHER half of the bundle every single run:
// cross-install-darwin-tree.sh rsyncs the live monorepo into the shipped source tree.
// So one half is rebuilt from current source and the other half is a cache, and nothing
// announces which is which. On 2026-08-03 (WI-3307) that shipped a bundle whose
// decisive acceptance criterion PASSED on the fresh half while the cached sidecar
// carried a 9-hour-old operator: /var/tmp/darwin-sidecar-abifix/serve.mjs was baked at
// 02:53Z and contained ZERO occurrences of the fix's symbols, yet DID contain
// env-operator-launcher.ts's other strings — so the launcher was bundled, just the old
// one. A partly-fresh artifact is far more deceptive than a wholly-stale one, because
// the evidence of freshness is real.
//
// Generalised: when an artifact is assembled from inputs with DIFFERENT refresh
// policies, "I rebuilt it" is not a claim about any particular input.
//
// WHY THIS DOES NOT FAIL ON "sidecar gitHead != HEAD"
// That was the fix originally proposed on the issue, and it is wrong here for the
// reason ./spa-freshness.js already established for its own input set: this is ONE
// shared checkout edited concurrently by the whole fleet, so HEAD moves every few
// minutes and a "source newer than artifact" rule would fire on essentially every
// build for every agent — a false-positive machine, which is a guard people learn to
// bypass. A guard that cries wolf is worse than no guard, because it trains the
// bypass.
//
// So this module contributes two things, and blocks only on explicit assertions:
//
//   1. THE BANNER (always, never blocks). The sidecar's recorded gitHead, buildSha and
//      age, printed at the top of every consuming build. Silence was the actual defect;
//      "built 9h ago from ebb8505" would have stopped the WI-3307 build in its tracks
//      before ~73 minutes of cargo zigbuild. Information has no false-positive rate.
//
//   2. THE ASSERTIONS (blocks, zero false positives). A caller can require a commit
//      (PAPERCUSP_REQUIRE_SIDECAR_CONTAINS), the exact serve.mjs bytes expected for a
//      release cut (PAPERCUSP_EXPECTED_SERVE_SHA), a sidecar build stamp at or
//      after the cut start (PAPERCUSP_SIDECAR_MIN_EPOCH_SEC), and proof that the
//      assembled sidecar passed its release identity audit
//      (PAPERCUSP_REQUIRE_SIDECAR_RELEASE_AUDIT). Each can only fire when its caller
//      explicitly asserted something, so none is a HEAD-vs-sidecar clock comparison
//      that cries wolf on the shared checkout.
//
// An absent provenance file is NOT treated as a pass: it is reported as undecidable,
// in the same spirit as spa-freshness.js's 'no-dist' — declining to guess rather than
// reporting a clean pass it has not earned.
//
// PURE — takes the provenance document's TEXT plus already-resolved git facts, so every
// verdict is unit-testable without a 4.7GB sidecar or a git repo on disk.

'use strict';

/**
 * Parse a build-provenance.json document (bin/emit-build-provenance.sh's output).
 * Returns null when the text is absent or not valid JSON — never throws.
 */
function parseProvenance(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/** Human-readable age, e.g. "9h 12m". Null in, null out. */
function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function explicitAssertionVerdict({
  expectedServeSha,
  serveSha,
  minEpochRequested,
  minEpochSec,
  stampEpochSec,
  requireReleaseAudit,
  releaseAuditPassed,
}) {
  if (expectedServeSha) {
    if (!/^[0-9a-f]{64}$/.test(expectedServeSha) || !/^[0-9a-f]{64}$/.test(serveSha || '')) {
      return 'serve-unverifiable';
    }
    if (serveSha !== expectedServeSha) return 'serve-skew';
  }

  if (minEpochRequested) {
    if (!Number.isFinite(minEpochSec) || minEpochSec < 0 || !Number.isFinite(stampEpochSec) || stampEpochSec < 0) {
      return 'stamp-unverifiable';
    }
    if (stampEpochSec < minEpochSec) return 'stamp-stale';
  }

  if (requireReleaseAudit && releaseAuditPassed !== true) {
    return 'release-audit-unattested';
  }

  return null;
}

/**
 * Judge a prebuilt sidecar's freshness.
 *
 * @param {object}  args
 * @param {boolean} args.sidecarPresent  does the sidecar dir itself exist?
 * @param {?string} args.provenanceText  contents of <sidecar>/build-provenance.json, or null
 * @param {?string} args.headSha         the consuming repo's current HEAD (banner only)
 * @param {?string} args.requireContains the commit the caller asserts the sidecar must carry
 * @param {?boolean} args.containsVerdict true = provenance contains it, false = it does not,
 *                                        null = could not be resolved (unknown object).
 *                                        Resolved by the CALLER (git), so this stays pure.
 * @param {?string} args.expectedServeSha the exact serve.mjs hash asserted by a release cut
 * @param {?string} args.serveSha the hash of the sidecar's actual serve.mjs bytes
 * @param {?number} args.minEpochSec the release cut start epoch asserted by the caller
 * @param {?number} args.stampEpochSec the sidecar build stamp's epoch
 * @param {boolean} args.requireReleaseAudit whether the caller requires proof that the
 *                                          final assembled identity scan passed
 * @param {boolean} args.releaseAuditPassed whether the sidecar stamp carries that proof
 * @param {number}  args.nowMs           clock injection for deterministic tests
 *
 * Verdicts:
 *   'match'                 nothing asserted (or the assertion holds) — safe to build.
 *   'skew'                  an assertion was made and the sidecar does NOT carry it. BLOCKS.
 *   'contains-unverifiable' an assertion was made and could not be checked at all. BLOCKS —
 *                           an unverifiable assertion is not a pass.
 *   'serve-skew'            the packed serve.mjs hash differs from the cut's expected bytes.
 *   'serve-unverifiable'    the expected serve.mjs hash could not be checked.
 *   'stamp-stale'           the sidecar build stamp predates the asserted cut start.
 *   'stamp-unverifiable'    the asserted sidecar build stamp could not be checked.
 *   'release-audit-unattested' the caller required the final assembled identity audit,
 *                              but the sidecar carries no successful attestation.
 *   'no-sidecar'            no sidecar at all; the build fails on its own, more clearly.
 *   'no-provenance'         sidecar predates provenance emission; cannot judge, does not block.
 *   'unreadable'            provenance present but unparseable / missing gitHead.
 */
function inspectSidecarFreshness({
  sidecarPresent,
  provenanceText = null,
  headSha = null,
  requireContains = null,
  containsVerdict = null,
  expectedServeSha = null,
  serveSha = null,
  minEpochSec = null,
  stampEpochSec = null,
  requireReleaseAudit = false,
  releaseAuditPassed = false,
  nowMs = Date.now(),
} = {}) {
  const require_ = typeof requireContains === 'string' && requireContains.trim() !== ''
    ? requireContains.trim()
    : null;
  const expectedServe_ = typeof expectedServeSha === 'string' && expectedServeSha.trim() !== ''
    ? expectedServeSha.trim().toLowerCase()
    : null;
  const serveSha_ = typeof serveSha === 'string' && serveSha.trim() !== ''
    ? serveSha.trim().toLowerCase()
    : null;
  const minEpochRequested = minEpochSec !== null && minEpochSec !== undefined;
  const minEpoch_ = minEpochRequested ? Number(minEpochSec) : null;
  const stampEpoch_ = stampEpochSec === null || stampEpochSec === undefined
    ? null
    : Number(stampEpochSec);
  const requireReleaseAudit_ = requireReleaseAudit === true;
  const releaseAuditPassed_ = releaseAuditPassed === true;

  const base = {
    gitHead: null,
    buildSha: null,
    builtAtUtc: null,
    ageMs: null,
    headSha: headSha ?? null,
    requireContains: require_,
    containsVerdict: require_ ? containsVerdict : null,
    expectedServeSha: expectedServe_,
    serveSha: serveSha_,
    minEpochSec: minEpoch_,
    stampEpochSec: stampEpoch_,
    requireReleaseAudit: requireReleaseAudit_,
    releaseAuditPassed: releaseAuditPassed_,
  };

  if (!sidecarPresent) return { ...base, verdict: 'no-sidecar' };

  const prov = parseProvenance(provenanceText);
  if (prov == null) {
    // Explicit release-cut assertions are independent of the optional legacy
    // provenance record. They must still fail closed when that record is absent
    // or corrupt; otherwise an old sidecar can evade the cut's real assertions by
    // deleting the metadata that would have made it visible.
    const assertionVerdict = explicitAssertionVerdict({
      expectedServeSha: expectedServe_,
      serveSha: serveSha_,
      minEpochRequested,
      minEpochSec: minEpoch_,
      stampEpochSec: stampEpoch_,
      requireReleaseAudit: requireReleaseAudit_,
      releaseAuditPassed: releaseAuditPassed_,
    });
    if (assertionVerdict) return { ...base, verdict: assertionVerdict };
    // Distinguish "no file at all" from "a file we could not read" — they call for
    // different operator actions (rebuild vs investigate a corrupt emit).
    const hadText = typeof provenanceText === 'string' && provenanceText.trim() !== '';
    return { ...base, verdict: hadText ? 'unreadable' : 'no-provenance' };
  }

  const gitHead = typeof prov.gitHead === 'string' && prov.gitHead !== '' ? prov.gitHead : null;
  const builtAtUtc = typeof prov.builtAtUtc === 'string' && prov.builtAtUtc !== ''
    ? prov.builtAtUtc
    : null;
  const parsedAt = builtAtUtc ? Date.parse(builtAtUtc) : NaN;
  const facts = {
    ...base,
    gitHead,
    buildSha: typeof prov.buildSha === 'string' && prov.buildSha !== '' ? prov.buildSha : null,
    builtAtUtc,
    ageMs: Number.isFinite(parsedAt) ? Math.max(0, nowMs - parsedAt) : null,
  };

  // These assertions are independent of git provenance. In particular, an
  // explicit release cut must fail closed even if an older sidecar predates
  // build-provenance.json entirely.
  const assertionVerdict = explicitAssertionVerdict({
    expectedServeSha: expectedServe_,
    serveSha: serveSha_,
    minEpochRequested,
    minEpochSec: minEpoch_,
    stampEpochSec: stampEpoch_,
    requireReleaseAudit: requireReleaseAudit_,
    releaseAuditPassed: releaseAuditPassed_,
  });
  if (assertionVerdict) return { ...facts, verdict: assertionVerdict };

  // A provenance doc with no gitHead cannot answer the commit assertion.
  if (!gitHead) return { ...facts, verdict: 'unreadable' };

  if (require_) {
    if (containsVerdict === false) return { ...facts, verdict: 'skew' };
    if (containsVerdict !== true) return { ...facts, verdict: 'contains-unverifiable' };
  }

  return { ...facts, verdict: 'match' };
}

/**
 * Whether a verdict must stop the build. Only an explicit assertion that fails or
 * cannot be verified does. Never mere staleness without a release-cut assertion.
 */
function blocksBuild(verdict) {
  return [
    'skew',
    'contains-unverifiable',
    'serve-skew',
    'serve-unverifiable',
    'stamp-stale',
    'stamp-unverifiable',
    'release-audit-unattested',
  ].includes(verdict);
}

/** The sidecar's identity line — printed on EVERY verdict, including the passing ones. */
function provenanceLine(result) {
  if (!result.gitHead && !result.builtAtUtc && !result.serveSha && !Number.isFinite(result.stampEpochSec)) {
    return 'provenance: none recorded';
  }
  const age = formatAge(result.ageMs);
  const parts = [
    `built ${result.builtAtUtc ?? 'at an unrecorded time'}${age ? ` (${age} ago)` : ''}`,
    `gitHead ${result.gitHead ?? 'unknown'}`,
  ];
  if (result.buildSha) parts.push(`buildSha ${result.buildSha}`);
  if (result.serveSha) parts.push(`serve.mjs sha ${result.serveSha}`);
  if (Number.isFinite(result.stampEpochSec)) parts.push(`stamp epoch ${result.stampEpochSec}`);
  if (result.releaseAuditPassed) parts.push('release identity audit attested');
  if (result.headSha && result.gitHead && result.headSha !== result.gitHead) {
    parts.push(`repo HEAD is now ${result.headSha}`);
  }
  return parts.join('  ·  ');
}

/** The operator-facing explanation. Kept here so the CLI and its test share one text. */
function describe(result) {
  const line = provenanceLine(result);
  switch (result.verdict) {
    case 'skew':
      return (
        'FATAL: STALE SIDECAR — the prebuilt sidecar does NOT carry the commit this build was\n' +
        `  told to ship (PAPERCUSP_REQUIRE_SIDECAR_CONTAINS=${result.requireContains}).\n` +
        `  sidecar ${line}\n\n` +
        '  The consuming build does not rebuild the sidecar; it packages whatever is already\n' +
        '  staged. Your source fix is NOT in that artifact, and every check that reads the\n' +
        '  shipped SOURCE TREE (which IS refreshed every build) will still pass — that is the\n' +
        '  half-fresh trap this guard exists for.\n\n' +
        '  Fix:  rebuild the sidecar, then re-run this build:\n' +
        '        TARGET_OS=<os> TARGET_ARCH=<arch> PAPERCUSP_SIDECAR_OUT=<dir> \\\n' +
        '          papercusp-desktop/bin/build-desktop-sidecar.sh\n\n' +
        '  THEN VERIFY THE ARTIFACT, not the source: grep the rebuilt serve.mjs for a literal\n' +
        '  only your change introduces. That check costs seconds and, on 2026-08-03, saved a\n' +
        '  ~73-minute cross-build that would have reproduced the identical bug.\n\n' +
        '  Override (you know the staged sidecar is what you want): PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'contains-unverifiable':
      return (
        `FATAL: could not verify that the sidecar carries ${result.requireContains}.\n` +
        `  sidecar ${line}\n\n` +
        '  Either the asserted commit or the sidecar\'s recorded gitHead is unknown to this\n' +
        '  checkout (an unfetched commit, a submodule sha, or a typo). An assertion that\n' +
        '  cannot be checked is not a pass, so this refuses rather than reporting a clean\n' +
        '  result it has not earned.\n\n' +
        '  Override: PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'serve-skew':
      return (
        'FATAL: STALE SIDECAR — serve.mjs does not match the bytes this release cut built.\n' +
        `  expected sha256 ${result.expectedServeSha}\n` +
        `  actual   sha256 ${result.serveSha ?? 'unavailable'}\n` +
        `  sidecar ${line}\n\n` +
        '  The cross-build leg would package a different sidecar than the one released\n' +
        '  by release-local.sh. Rebuild the sidecar and re-run the cut.\n\n' +
        '  Override (deliberate stale bytes only): PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'serve-unverifiable':
      return (
        'FATAL: could not verify the sidecar bytes required by this release cut.\n' +
        `  expected sha256 ${result.expectedServeSha ?? 'invalid'}\n` +
        `  actual   sha256 ${result.serveSha ?? 'unavailable'}\n` +
        `  sidecar ${line}\n\n` +
        '  The cut assertion is fail-closed: rebuild the sidecar and verify serve.mjs\n' +
        '  before packaging it. Override only for deliberate stale bytes:\n' +
        '  PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'stamp-stale':
      return (
        'FATAL: STALE SIDECAR — its build stamp predates this release cut.\n' +
        `  sidecar stamp epoch ${result.stampEpochSec}\n` +
        `  required cut epoch ${result.minEpochSec}\n` +
        `  sidecar ${line}\n\n` +
        '  The cross-build leg would package a sidecar built before release-local.sh\n' +
        '  started this cut. Rebuild the sidecar and re-run the cut.\n\n' +
        '  Override (deliberate stale bytes only): PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'stamp-unverifiable':
      return (
        'FATAL: could not verify that the sidecar was built during this release cut.\n' +
        `  required cut epoch ${Number.isFinite(result.minEpochSec) ? result.minEpochSec : 'invalid'}\n` +
        `  sidecar ${line}\n\n` +
        '  The cut assertion is fail-closed: rebuild the sidecar to regenerate\n' +
        '  .sidecar-build-stamp, then re-run the cut. Override only for deliberate\n' +
        '  stale bytes: PAPERCUSP_ALLOW_STALE_SIDECAR=1'
      );
    case 'release-audit-unattested':
      return (
        'FATAL: UNAUDITED SIDECAR — this cross-build requires proof that the final\n' +
        '  assembled sidecar passed the release identity scan, but its\n' +
        '  .sidecar-build-stamp carries no successful releaseIdentityAudit attestation.\n' +
        `  sidecar ${line}\n\n` +
        '  A normal/dev sidecar is not a release input: rebuild it with\n' +
        '  PAPERCUSP_RELEASE_AUDIT=1 and the release owner identity environment set,\n' +
        '  then re-run this cross-build. PAPERCUSP_ALLOW_STALE_SIDECAR does not\n' +
        '  bypass a missing privacy attestation.\n\n' +
        '  Canonical identity source (EI-22084619262074810): source\n' +
        '  ~/.papercusp/release-identity.env (set -a) at runtime before the sidecar\n' +
        '  build — never write identity values into any tracked or untracked file.'
      );
    case 'no-sidecar':
      return (
        'WARNING: no prebuilt sidecar found. Run papercusp-desktop/bin/build-desktop-sidecar.sh.\n' +
        '  (Not blocking: the build\'s own payload assert fails on this, and more clearly than a\n' +
        '  freshness check can.)'
      );
    case 'no-provenance':
      return (
        'NOTE: this sidecar carries no build-provenance.json, so its age and origin cannot be\n' +
        '  judged — it predates provenance emission (or was assembled by hand). Building with it\n' +
        '  as-is. This check declines to guess rather than reporting a clean pass it has not\n' +
        '  earned; rebuild the sidecar to get a provenanced one.'
      );
    case 'unreadable':
      return (
        'NOTE: the sidecar\'s build-provenance.json is unparseable or records no gitHead, so\n' +
        '  freshness cannot be judged. Not blocking, but a corrupt provenance emit is worth\n' +
        '  investigating — rebuild the sidecar to regenerate it.'
      );
    default:
      if (result.requireContains) return `sidecar OK — carries ${result.requireContains}.  ${line}`;
      if (result.expectedServeSha) return `sidecar OK — serve.mjs matches the release cut.  ${line}`;
      if (result.minEpochSec !== null) return `sidecar OK — build stamp satisfies the release cut.  ${line}`;
      if (result.requireReleaseAudit) return `sidecar OK — release identity audit attested.  ${line}`;
      return `sidecar ${line}`;
  }
}

// EI-21649958701175888 — a Server sidecar is assembled from three independently
// refreshed views of the database migrations:
//
//   * source.tar.zst's runnable source tree,
//   * sidecar/db-sql, which the bundled operator actually executes, and
//   * build-provenance.json's clean Git commit.
//
// A preserved source overlay can survive a later sidecar rebuild. Provenance and
// db-sql then look fresh while the installed dev/local source silently lags. Keep
// the verdict pure: the CLI resolves tar/Git/filesystem facts, while this function
// decides whether those facts earn a release assertion.
function migrationManifest(entries, { requireHashes = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const rows = new Map();
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    const sha256 = typeof entry === 'object' && entry !== null ? entry.sha256 : null;
    if (typeof name !== 'string' || !/^[^/]+\.sql$/.test(name) || rows.has(name)) return null;
    if (requireHashes && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) {
      return null;
    }
    rows.set(name, sha256 ?? null);
  }

  const names = [...rows.keys()].sort();
  const highest = names.reduce((best, name) => {
    if (best == null) return name;
    const number = Number.parseInt(name.match(/^(\d+)/)?.[1] ?? '', 10);
    const bestNumber = Number.parseInt(best.match(/^(\d+)/)?.[1] ?? '', 10);
    if (Number.isFinite(number) && Number.isFinite(bestNumber)) {
      return number > bestNumber || (number === bestNumber && name > best) ? name : best;
    }
    if (Number.isFinite(number)) return name;
    if (Number.isFinite(bestNumber)) return best;
    return name > best ? name : best;
  }, null);
  return {
    count: names.length,
    highest,
    names,
    hashes: rows,
  };
}

function sameNames(a, b) {
  return a.names.length === b.names.length && a.names.every((name, i) => name === b.names[i]);
}

function manifestSummary(manifest) {
  return manifest
    ? { count: manifest.count, highest: manifest.highest }
    : { count: null, highest: null };
}

function inspectSidecarSourceCoherence({
  required = false,
  provenanceHead = null,
  provenanceDirty = null,
  sourceArchivePresent = false,
  sourceEntries = null,
  shippedEntries = null,
  provenanceEntries = null,
} = {}) {
  const base = {
    provenanceHead,
    provenanceDirty,
    source: { count: null, highest: null },
    shipped: { count: null, highest: null },
    provenance: { count: null, highest: null },
    hashMismatches: [],
  };

  if (!required) return { ...base, verdict: 'not-required' };
  if (typeof provenanceHead !== 'string' || !/^[0-9a-f]{40}$/i.test(provenanceHead)) {
    return { ...base, verdict: 'provenance-unverifiable' };
  }
  if (provenanceDirty !== false) return { ...base, verdict: 'provenance-dirty' };
  if (!sourceArchivePresent) return { ...base, verdict: 'source-missing' };

  const source = migrationManifest(sourceEntries, { requireHashes: true });
  const shipped = migrationManifest(shippedEntries, { requireHashes: true });
  // Provenance names the clean, pre-release Git tree. Both shipped copies are
  // deliberately identity-scrubbed after that boundary, so their bytes are not
  // expected to equal raw Git. The clean provenance bit + complete name set tie
  // the release to Git; exact hashes tie the two transformed/shipped copies to
  // each other.
  const provenance = migrationManifest(provenanceEntries);
  const facts = {
    ...base,
    source: manifestSummary(source),
    shipped: manifestSummary(shipped),
    provenance: manifestSummary(provenance),
  };

  if (!source) return { ...facts, verdict: 'source-unverifiable' };
  if (!shipped) return { ...facts, verdict: 'runtime-unverifiable' };
  if (!provenance) return { ...facts, verdict: 'provenance-migrations-unverifiable' };
  if (!sameNames(source, shipped) || !sameNames(source, provenance)) {
    return { ...facts, verdict: 'migration-set-skew' };
  }

  const hashMismatches = source.names.filter(
    (name) => source.hashes.get(name) !== shipped.hashes.get(name),
  );
  if (hashMismatches.length > 0) {
    return {
      ...facts,
      verdict: 'source-runtime-byte-skew',
      hashMismatches: hashMismatches.slice(0, 8),
    };
  }

  return { ...facts, verdict: 'coherent' };
}

function sourceCoherenceBlocksBuild(verdict) {
  return verdict !== 'not-required' && verdict !== 'coherent';
}

function describeSourceCoherence(result) {
  const summary =
    `  source.tar.zst: ${result.source.count ?? 'unavailable'} migration(s), highest ${result.source.highest ?? 'unavailable'}\n` +
    `  shipped db-sql: ${result.shipped.count ?? 'unavailable'} migration(s), highest ${result.shipped.highest ?? 'unavailable'}\n` +
    `  provenance Git: ${result.provenance.count ?? 'unavailable'} migration(s), highest ${result.provenance.highest ?? 'unavailable'}`;
  const fix =
    '\n\n  Rebuild and stage the sidecar/source overlay from one clean commit, then retry.\n' +
    '  PAPERCUSP_ALLOW_STALE_SIDECAR does not bypass source coherence.';

  switch (result.verdict) {
    case 'coherent':
      return (
        `sidecar source coherence OK — ${result.source.count} migration(s) agree by name; ` +
        `source/runtime SQL bytes match; provenance ${result.provenanceHead}.`
      );
    case 'source-missing':
      return 'FATAL: INCOHERENT SIDECAR SOURCE — source.tar.zst is missing.' + fix;
    case 'provenance-unverifiable':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — build provenance has no full source gitHead, ' +
        'so the preserved source cannot be tied to a commit.' + fix
      );
    case 'provenance-dirty':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — build provenance records a dirty source state.\n' +
        '  A commit cannot attest uncommitted bytes, so three-way coherence is unprovable.' + fix
      );
    case 'source-unverifiable':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — source.tar.zst could not yield one unambiguous ' +
        'libs/db/sql migration set.\n' + summary + fix
      );
    case 'runtime-unverifiable':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — shipped sidecar/db-sql could not yield one ' +
        'unambiguous migration set.\n' + summary + fix
      );
    case 'provenance-migrations-unverifiable':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — the provenance commit\'s papercusp gitlink ' +
        'could not yield a migration set.\n' + summary + fix
      );
    case 'migration-set-skew':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — source.tar.zst, shipped db-sql, and provenance ' +
        'name different migration sets.\n' + summary + fix
      );
    case 'source-runtime-byte-skew':
      return (
        'FATAL: INCOHERENT SIDECAR SOURCE — source.tar.zst and shipped db-sql carry ' +
        'different SQL bytes for: ' + result.hashMismatches.join(', ') + '.\n' + summary + fix
      );
    default:
      return 'sidecar source coherence was not required';
  }
}

module.exports = {
  parseProvenance,
  formatAge,
  inspectSidecarFreshness,
  blocksBuild,
  provenanceLine,
  describe,
  inspectSidecarSourceCoherence,
  sourceCoherenceBlocksBuild,
  describeSourceCoherence,
};
