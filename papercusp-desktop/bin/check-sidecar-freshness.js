#!/usr/bin/env node
// EI-19446480107603858 — announce a prebuilt sidecar's provenance, and refuse the build
// when the caller asserted a commit the sidecar does not carry.
// Rationale, and why this does NOT fail on "gitHead != HEAD", in ./lib/sidecar-freshness.js.
//
// Wired into the two cross-build legs that CONSUME a sidecar they did not build
// (build-mac-cross.sh, build-windows-cross.sh), immediately beside their existing
// existence/arch payload asserts — so the freshness signal arrives at the same moment,
// and from the same guard block, as "is it there at all" and "is it the right arch".
//
//   node bin/check-sidecar-freshness.js --sidecar <dir> [--repo-root <dir>] [--label <name>]
//
// Exit 0 = proceed (the banner is on stdout), 4 = refused for staleness (family
// convention: matches check-spa-freshness.js and the build-and-archive-deb.sh guard, so
// a wrapper can treat "refused for staleness" as one condition whichever guard caught it).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  inspectSidecarFreshness,
  blocksBuild,
  describe,
  inspectSidecarSourceCoherence,
  sourceCoherenceBlocksBuild,
  describeSourceCoherence,
} = require('./lib/sidecar-freshness.js');

const desktopDir = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sidecarDir = path.resolve(arg('--sidecar', path.join(desktopDir, 'src-tauri/sidecar')));
const repoRoot = path.resolve(
  arg('--repo-root', process.env.PAPERCUSP_REPO_DIR || path.resolve(desktopDir, '..')),
);
const label = arg('--label', 'sidecar-freshness');

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sha256FileOrNull(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function readStampOrNull(file) {
  const text = readOrNull(file);
  if (text == null) return null;
  try {
    const stamp = JSON.parse(text);
    return stamp && typeof stamp === 'object' ? stamp : null;
  } catch {
    return null;
  }
}

function gitOrNull(args) {
  try {
    const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() || null : null;
  } catch {
    return null;
  }
}

function sha256MigrationEntries(dir, { recursive = false } = {}) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && recursive) {
        visit(file);
      } else if (entry.isFile() && entry.name.endsWith('.sql')) {
        const relative = path.relative(dir, file).split(path.sep).join('/');
        if (!recursive || /(^|\/)libs\/db\/sql\/[^/]+\.sql$/.test(relative)) {
          files.push({ name: entry.name, sha256: sha256FileOrNull(file) });
        }
      }
    }
  };

  try {
    visit(dir);
    return files;
  } catch {
    return null;
  }
}

function sourceArchiveMigrations(archive) {
  if (!fs.existsSync(archive)) return { present: false, entries: null, error: null };
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'papercusp-source-coherence-'));
  try {
    const result = spawnSync(
      'tar',
      [
        '--use-compress-program=zstd',
        '-xf', archive,
        '-C', extracted,
        '--no-same-owner',
        '--no-same-permissions',
        '--wildcards',
        './libs/papercusp/libs/db/sql/*.sql',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0) {
      return {
        present: true,
        entries: null,
        error: String(result.stderr || `tar exited ${result.status}`).trim(),
      };
    }
    return {
      present: true,
      entries: sha256MigrationEntries(
        path.join(extracted, 'libs/papercusp/libs/db/sql'),
      ),
      error: null,
    };
  } catch (error) {
    return { present: true, entries: null, error: String(error?.message || error) };
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

function provenanceMigrations(head) {
  if (!head) return null;
  try {
    const rootTree = spawnSync(
      'git',
      ['-C', repoRoot, 'ls-tree', head, '--', 'libs/papercusp'],
      { encoding: 'utf8' },
    );
    if (rootTree.status !== 0) return null;
    const gitlink = String(rootTree.stdout).match(
      /^160000 commit ([0-9a-f]{40})\tlibs\/papercusp$/m,
    )?.[1];
    if (!gitlink) return null;

    const papercuspRepo = path.join(repoRoot, 'libs/papercusp');
    const listing = spawnSync(
      'git',
      ['-C', papercuspRepo, 'ls-tree', '-r', '--name-only', gitlink, '--', 'libs/db/sql'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    if (listing.status !== 0) return null;
    return String(listing.stdout)
      .split('\n')
      .filter((file) => /^libs\/db\/sql\/[^/]+\.sql$/.test(file))
      .map((file) => path.basename(file));
  } catch {
    return null;
  }
}

/**
 * Does `head` (the sidecar's recorded commit) contain `needle`?
 * true / false / null when either object is unknown to this checkout — the three
 * outcomes are deliberately distinct: `null` refuses rather than passing, because an
 * assertion that could not be checked has not been satisfied.
 */
function containsCommit(needle, head) {
  if (!needle || !head) return null;
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', needle, head], {
      encoding: 'utf8',
    });
    if (r.status === 0) return true; // ancestor (a commit is its own ancestor)
    if (r.status === 1) return false; // resolved, and NOT contained
    return null; // 128 / spawn failure: unknown object, cannot judge
  } catch {
    return null;
  }
}

const provenanceText = readOrNull(path.join(sidecarDir, 'build-provenance.json'));
const requireContains = (process.env.PAPERCUSP_REQUIRE_SIDECAR_CONTAINS || '').trim() || null;
const expectedServeSha = (process.env.PAPERCUSP_EXPECTED_SERVE_SHA || '').trim() || null;
const minEpochRaw = (process.env.PAPERCUSP_SIDECAR_MIN_EPOCH_SEC || '').trim();
const minEpochSec = minEpochRaw || null;
const serveSha = sha256FileOrNull(path.join(sidecarDir, 'serve.mjs'));
const stamp = readStampOrNull(path.join(sidecarDir, '.sidecar-build-stamp'));
const stampEpochSec = stamp && Object.prototype.hasOwnProperty.call(stamp, 'epochSec')
  ? stamp.epochSec
  : null;
const requireReleaseAudit = process.env.PAPERCUSP_REQUIRE_SIDECAR_RELEASE_AUDIT === '1';
const releaseAuditPassed = stamp?.releaseIdentityAudit?.passed === true;
const requireSourceCoherence = process.env.PAPERCUSP_REQUIRE_SOURCE_COHERENCE === '1';

// Resolve the sidecar's own gitHead first so ancestry can be asked against it.
let recordedHead = null;
let provenanceDoc = null;
try {
  provenanceDoc = provenanceText ? JSON.parse(provenanceText) : null;
  if (provenanceDoc && typeof provenanceDoc.gitHead === 'string') {
    recordedHead = provenanceDoc.gitHead;
  }
} catch {
  /* inspect() reports the unreadable verdict; nothing to resolve here */
}

const result = inspectSidecarFreshness({
  sidecarPresent: fs.existsSync(sidecarDir),
  provenanceText,
  headSha: gitOrNull(['rev-parse', 'HEAD']),
  requireContains,
  containsVerdict: requireContains ? containsCommit(requireContains, recordedHead) : null,
  expectedServeSha,
  serveSha,
  minEpochSec,
  stampEpochSec,
  requireReleaseAudit,
  releaseAuditPassed,
});

const message = describe(result);

const freshnessOverridden =
  blocksBuild(result.verdict)
  && result.verdict !== 'release-audit-unattested'
  && process.env.PAPERCUSP_ALLOW_STALE_SIDECAR === '1';

if (freshnessOverridden) {
  console.warn(`[${label}] OVERRIDDEN by PAPERCUSP_ALLOW_STALE_SIDECAR=1:\n${message}`);
}

if (blocksBuild(result.verdict) && !freshnessOverridden) {
  console.error(`[${label}] ${message}`);
  process.exit(4);
}

console.log(`[${label}] ${message}`);

if (requireSourceCoherence) {
  const provenanceCanAttest = /^[0-9a-f]{40}$/i.test(recordedHead || '')
    && provenanceDoc?.gitDirty === false;
  const archive = provenanceCanAttest
    ? sourceArchiveMigrations(path.join(sidecarDir, 'source.tar.zst'))
    : { present: false, entries: null, error: null };
  const coherence = inspectSidecarSourceCoherence({
    required: true,
    provenanceHead: recordedHead,
    provenanceDirty: provenanceDoc?.gitDirty,
    sourceArchivePresent: archive.present,
    sourceEntries: archive.entries,
    shippedEntries: sha256MigrationEntries(path.join(sidecarDir, 'db-sql')),
    provenanceEntries: provenanceCanAttest ? provenanceMigrations(recordedHead) : null,
  });
  const coherenceMessage = describeSourceCoherence(coherence);
  if (sourceCoherenceBlocksBuild(coherence.verdict)) {
    const archiveError = archive.error
      ? `\n  archive read failed: ${archive.error.slice(0, 500)}`
      : '';
    console.error(`[${label}] ${coherenceMessage}${archiveError}`);
    process.exit(4);
  }
  console.log(`[${label}] ${coherenceMessage}`);
}
