#!/usr/bin/env node
// release-content-identity.js — the canonical, reviewable content identity for
// ONE release stage on ONE platform.
//
// This object is the release journal's INPUT: release-task-journal.mts hashes it
// (releaseStageInputHash) and a receipt is only reusable while the hash still
// matches. Source SHA + the complete gitlink tuple are added by the journal
// itself; this object binds every REMAINING input that can change produced or
// trusted bytes. No secret material enters it — signing is represented only by
// the public updater-key digest.
//
// It lived as a 60-line heredoc inside release-local.sh with `platform` written
// as the literal 'linux-x86_64', which is why only the Linux leg could ever be
// journalled: there was no way to ask for another platform's identity, and no
// way to test the builder at all. Extracting it makes the platform a parameter
// and the builder directly exercisable (release-content-identity.selftest.sh).
//
//   node bin/lib/release-content-identity.js <workspace> <desktop> <platform>
//
// prints the identity JSON on stdout, or fails closed on stderr with exit 1.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// Every platform whose bytes this repo produces. A stage identity must name one
// of these: an unknown or empty platform is a caller bug that would otherwise
// mint a receipt keyed to nothing, which then collides with every other leg's.
// A platform is the RECEIPT NAMESPACE: two entries here can never share a stage
// identity, so this list exists to stop a typo silently minting a private one.
// 'darwin-universal' is a genuine third darwin entry rather than a synonym for
// either single-arch key: release-local.sh builds MAC_BUILD_TARGET=
// universal-apple-darwin exclusively, emits "<Product>_<version>_
// universal-apple-darwin.dmg", and a universal artifact's receipt must NOT be
// interchangeable with a thin aarch64/x86_64 one that ships different bytes.
const KNOWN_PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'windows-x86_64',
  'darwin-universal',
  'darwin-aarch64',
  'darwin-x86_64',
  'android',
];

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

const fileSha = (file, label) => {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`release reuse identity is missing ${label}: ${file}`);
  }
  return sha(fs.readFileSync(file));
};

const command = (name, args = ['--version']) => {
  try {
    return cp.execFileSync(name, args, { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`release reuse identity cannot resolve ${name} ${args.join(' ')}`);
  }
};

function dependencyMarkerFields(workspace) {
  const markerPath = path.join(workspace, 'node_modules', '.papercusp-dependency-generation');
  const marker = fs.readFileSync(markerPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const markerField = (key) => {
    const matches = marker.filter((line) => line.startsWith(`${key}=`));
    if (matches.length !== 1) throw new Error(`release dependency marker requires exactly one ${key}`);
    return matches[0].slice(key.length + 1);
  };
  const identity = markerField('identity');
  const source = markerField('source');
  if (!/^v1-[0-9a-f]{64}$/.test(identity) || !/^[0-9a-f]{64}$/.test(source) || identity !== `v1-${source}`) {
    throw new Error('release dependency generation marker has an incoherent immutable identity');
  }
  return { identity, source };
}

function buildContentIdentity({ workspace, desktop, platform, env = process.env }) {
  if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
    throw new Error(
      `release content identity requires a known platform (one of ${KNOWN_PLATFORMS.join(', ')}), got ${
        platform ? `'${platform}'` : '(empty)'
      }`,
    );
  }

  const dependency = dependencyMarkerFields(workspace);

  const policyFiles = {
    distributionContract: path.join(desktop, 'src-tauri', 'distribution-contract.json'),
    tauriBase: path.join(desktop, 'src-tauri', 'tauri.conf.json'),
    cupboardBundle: path.join(workspace, 'content-bundles', 'workspace-host', 'bundle.yaml'),
    modelBoundary: path.join(desktop, 'bin', 'lib', 'transformers-models.sh'),
    identityScanner: path.join(desktop, 'bin', 'audit-release-bundle.py'),
    provenanceVerifier: path.join(desktop, 'bin', 'verify-provenance.sh'),
    freshnessVerifier: path.join(desktop, 'bin', 'check-sidecar-freshness.js'),
    // P-003 clause 4 (D-008). The compressed PACKAGE stages carry compression
    // policy in TWO forms and each needs a different mechanism. The presets are
    // HARDCODED in these producers — `zstd --long=27` (stage-source-tree.sh) and
    // `xz -9` (repack-deb-xz.sh) — so nothing but a fingerprint of the producer
    // itself can notice them changing; that is exactly what this policy-file set
    // already does for the provenance/identity gates above. The env-TUNABLE half
    // (levels, threads, memlimit) cannot be caught this way, because tuning a knob
    // leaves these bytes identical — it is keyed separately under `compression`.
    sourcePackager: path.join(desktop, 'bin', 'stage-source-tree.sh'),
    debCompressor: path.join(desktop, 'bin', 'repack-deb-xz.sh'),
    // This builder DEFINES what a stage identity means, so a change to it must
    // invalidate receipts minted under the old definition. Without the
    // self-fingerprint, editing the policy set below (adding a gate, dropping
    // one) leaves every existing receipt reusable under rules that no longer
    // exist — the invalidation hole P-002 names.
    identityBuilder: __filename,
  };
  const channelConfig = String(env.PAPERCUSP_REUSE_CHANNEL_CONFIG || '').match(
    /tauri\.[a-z0-9.-]+\.conf\.json/i,
  )?.[0];
  if (channelConfig) policyFiles.channel = path.join(desktop, 'src-tauri', channelConfig);
  const policies = Object.fromEntries(
    Object.entries(policyFiles).map(([key, file]) => [key, fileSha(file, key)]),
  );

  return {
    // v3 adds the caller-supplied platform and the identityBuilder
    // self-fingerprint. Both change the hash of an otherwise-identical stage,
    // so the version bump is what makes that invalidation deliberate and
    // legible rather than an unexplained cache miss.
    // v4 adds `compression` (P-003 clause 4, D-008). Editing this file already
    // busts every prior receipt via the identityBuilder self-fingerprint, so the
    // bump buys legibility rather than invalidation: it makes the one-time miss
    // read as a deliberate policy widening instead of an unexplained cache miss.
    // v5 drops `installedLock` (node_modules/.package-lock.json). That file is
    // npm's install bookkeeping, and dependency_generation_prune_ephemeral
    // deletes it at the generation boundary, so a release tree materialized from
    // a generation never has one: requiring it failed every journalled managed
    // cut at leg start (nightly 2026-09-24). The installed tree is already bound,
    // completely, by `generation` — its identity is the source manifest hash.
    schemaVersion: 5,
    platform,
    dependencies: {
      generation: dependency.identity,
      source: dependency.source,
      packageLock: fileSha(path.join(workspace, 'package-lock.json'), 'workspace package lock'),
      cargoLock: fileSha(path.join(desktop, 'src-tauri', 'Cargo.lock'), 'Cargo lock'),
    },
    toolchain: {
      rustc: command('rustc'),
      cargo: command('cargo'),
      node: command('node'),
      npm: command('npm'),
      tauriCli: env.PAPERCUSP_REUSE_TAURI_CLI,
    },
    profile: {
      channel: env.PAPERCUSP_REUSE_CHANNEL,
      roles: String(env.PAPERCUSP_REUSE_BUILD_ROLES || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .sort(),
      rustflags: env.PAPERCUSP_REUSE_RUSTFLAGS || '',
      channelConfig: env.PAPERCUSP_REUSE_CHANNEL_CONFIG || '',
      releaseHostSha256: sha(env.PAPERCUSP_REUSE_RELEASE_HOST || ''),
    },
    // P-003 clause 4 (D-008) — the env-TUNABLE half of compression policy.
    // R-3 requires package/compression outputs to be keyed by "content and policy
    // identity", and the Design section names the xz preset specifically. Tuning
    // any knob below changes the produced BYTES while leaving every other field
    // here identical, so without this block a package compressed under one policy
    // satisfies a request for another.
    //
    // These defaults MIRROR the producers and are pinned to them by
    // release-local-linux-reuse.test.js — a default that drifts from its producer
    // would record a policy that never ran, which is worse than recording none.
    //
    // Keying on these cannot make reuse host-specific: repack-deb-xz.sh:18-24
    // deliberately fixes threads/memlimit ("make its default resource cost
    // independent of host size") instead of scaling to host cores, so they are
    // policy an operator tunes, never facts about the machine.
    compression: {
      sourceZstdLevel: Number(env.PAPERCUSP_REUSE_SOURCE_ZSTD_LEVEL || 6),
      debXzThreads: Number(env.PAPERCUSP_REUSE_DEB_XZ_THREADS || 4),
      debXzMemoryLimit: env.PAPERCUSP_REUSE_DEB_XZ_MEMLIMIT || '4GiB',
    },
    policy: {
      files: policies,
      allowIncompleteRoles: env.PAPERCUSP_REUSE_ALLOW_INCOMPLETE,
      skipProvenanceParity: env.PAPERCUSP_REUSE_SKIP_PROVENANCE,
      skipMigrationLint: env.PAPERCUSP_REUSE_SKIP_MIGRATION_LINT,
      skipMigrationBootsmoke: env.PAPERCUSP_REUSE_SKIP_MIGRATION_BOOTSMOKE,
      skipBuildset: env.PAPERCUSP_REUSE_SKIP_BUILDSET,
      allowUnverifiedSubmodule: env.PAPERCUSP_REUSE_ALLOW_UNVERIFIED_SUBMODULE,
    },
    signing: { updaterPublicKeySha256: sha(env.PAPERCUSP_REUSE_SIGNER_PUBKEY || '') },
    audit: {
      releaseIdentityAudit: true,
      requiredArtifactVerification: ['cardinality', 'provenance', 'health-sha', 'updater-signature'],
      reuseMaxAgeSec: Number(env.PAPERCUSP_RELEASE_REUSE_MAX_AGE_SEC || 0),
    },
  };
}

module.exports = { buildContentIdentity, dependencyMarkerFields, KNOWN_PLATFORMS };

if (require.main === module) {
  const [workspace, desktop, platform] = process.argv.slice(2);
  if (!workspace || !desktop) {
    console.error('usage: release-content-identity.js <workspace> <desktop> <platform>');
    process.exit(1);
  }
  try {
    process.stdout.write(JSON.stringify(buildContentIdentity({ workspace, desktop, platform })));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
