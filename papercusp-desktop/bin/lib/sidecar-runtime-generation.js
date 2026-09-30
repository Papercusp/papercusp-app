#!/usr/bin/env node
'use strict';
// WI-10003673 — the Windows Server's hot-runtime generation, computed ONCE at
// package time instead of on every boot.
//
// The launcher keys its distro-local sidecar snapshot by a content generation
// of {app}\sidecar (src-tauri/src/sidecar_runtime_identity.rs). Computing it
// at runtime walks and SHA-256s the installed tree — ~17k files / ~5 GB — and
// that walk ran BEFORE the snapshot's marker probe, so every Server boot spent
// ~9 minutes hashing before the operator could start (measured on the VM,
// 2026-09-28, 0.0.22). The installed tree is immutable between installs, so
// the key can be computed here, where the bytes are packed, and shipped as
// {app}\sidecar\.sidecar-runtime-generation.
//
// What the key must guarantee is only that it CHANGES whenever the installed
// hot payload changes; it is a cache key, not an integrity check. So it is
// computed over what Inno will install, not over what the walk would see:
//   * the installed layout — sidecar\* plus the env-sidecars overlay that
//     papercusp.iss maps to {app}\sidecar\env-sidecars (later layer wins, as a
//     later [Files] entry overwrites an earlier one);
//   * symlinks followed, as Wine presents them to ISCC (the installed tree
//     holds the target's bytes, not a link);
//   * the installer script's bytes, since it decides what is installed;
//   * a domain tag distinct from the walk's, so a packed key can never be
//     mistaken for (or collide with) a runtime-walked one.
// The record is bound to the exact bytes of .sidecar-build-stamp; the launcher
// ignores a record whose binding does not match the installed stamp and falls
// back to the walk, so a stale record can only cost time, never correctness.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GENERATION_FILE = '.sidecar-runtime-generation';
const RECORD_SCHEMA = 'papercusp-sidecar-runtime-generation/v1';
const STAMP_FILE = '.sidecar-build-stamp';
const DOMAIN = 'papercusp-hot-runtime-packed-v1';
// The walk's root exclusions: cold one-time inputs the WSL staging never
// copies, the marker it writes, and this record itself.
const ROOT_EXCLUSIONS = new Set([
  'source.tar.zst',
  'db-seed.dump',
  'db-seed.tar.gz',
  '.papercusp-runtime-complete',
  GENERATION_FILE,
]);

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function frame(hash, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  hash.update(u64(buffer.length));
  hash.update(buffer);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Byte-wise UTF-8 order, identical to Rust's `String` sort in the walk. */
function compareNames(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function statFollowing(file, rel) {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`dangling symlink in the packed sidecar: ${rel} (${file})`);
    }
    throw error;
  }
}

function hashFile(hash, file, rel, size, buffer, totals) {
  const fd = fs.openSync(file, 'r');
  let read = 0;
  const magic = [];
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      for (let i = 0; i < n && magic.length < 4; i += 1) magic.push(buffer[i]);
      hash.update(buffer.subarray(0, n));
      read += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (read !== size) throw new Error(`packed sidecar file changed while hashing: ${rel}`);
  const shebang = magic.length >= 2 && magic[0] === 0x23 && magic[1] === 0x21;
  const elf = magic.length === 4 && magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
  hash.update(Buffer.from([shebang || elf ? 1 : 0]));
  totals.files += 1;
  totals.bytes += size;
}

/**
 * Walk one directory of the installed layout. `layers` are real directories
 * that all install to this same path, lowest precedence first; `mounts` maps a
 * root-level name to an extra top layer (papercusp.iss's env-sidecars entry).
 */
function walk(hash, layers, relative, mounts, buffer, totals) {
  const names = new Set();
  for (const dir of layers) for (const name of fs.readdirSync(dir)) names.add(name);
  if (relative === '') for (const name of mounts.keys()) names.add(name);
  for (const name of [...names].sort(compareNames)) {
    if (relative === '' && ROOT_EXCLUSIONS.has(name)) continue;
    const rel = relative === '' ? name : `${relative}/${name}`;
    const sources = layers.map((dir) => path.join(dir, name));
    if (relative === '' && mounts.has(name)) sources.push(mounts.get(name));
    const entries = [];
    for (const file of sources) {
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
      entries.push({ file, stat: statFollowing(file, rel) });
    }
    const top = entries[entries.length - 1];
    frame(hash, rel);
    if (top.stat.isDirectory()) {
      if (entries.some((entry) => !entry.stat.isDirectory())) {
        throw new Error(`packed sidecar layout conflict at ${rel}: a file and a directory install to the same path`);
      }
      frame(hash, 'directory');
      walk(hash, entries.map((entry) => entry.file), rel, mounts, buffer, totals);
    } else if (top.stat.isFile()) {
      if (entries.some((entry) => entry.stat.isDirectory())) {
        throw new Error(`packed sidecar layout conflict at ${rel}: a file and a directory install to the same path`);
      }
      frame(hash, 'file');
      hash.update(u64(top.stat.size));
      hashFile(hash, top.file, rel, top.stat.size, buffer, totals);
    } else {
      throw new Error(`unsupported packed sidecar entry: ${rel}`);
    }
  }
}

/**
 * @param {{ sidecarDir: string, mounts?: Record<string,string>, installerScript?: string }} options
 * @returns {{ generation: string, files: number, bytes: number }}
 */
function computePackedGeneration({ sidecarDir, mounts = {}, installerScript } = {}) {
  if (!sidecarDir || !fs.statSync(sidecarDir).isDirectory()) {
    throw new Error(`sidecar directory not found: ${sidecarDir}`);
  }
  const mountMap = new Map();
  for (const [name, dir] of Object.entries(mounts)) {
    if (!name || name.includes('/') || name.includes('\\') || ROOT_EXCLUSIONS.has(name)) {
      throw new Error(`invalid overlay mount name: ${name}`);
    }
    if (!fs.statSync(dir).isDirectory()) throw new Error(`overlay ${name} is not a directory: ${dir}`);
    mountMap.set(name, dir);
  }
  const hash = crypto.createHash('sha256');
  frame(hash, DOMAIN);
  const totals = { files: 0, bytes: 0 };
  walk(hash, [sidecarDir], '', mountMap, Buffer.alloc(1024 * 1024), totals);
  frame(hash, 'installer-script');
  frame(hash, installerScript ? sha256Hex(fs.readFileSync(installerScript)) : 'none');
  return { generation: hash.digest('hex'), ...totals };
}

/** The exact bytes the launcher parses (sidecar_runtime_identity.rs). */
function formatGenerationRecord({ generation, stampBytes }) {
  if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error(`generation must be 64 lowercase hex: ${generation}`);
  return `${JSON.stringify({ schema: RECORD_SCHEMA, generation, stampSha256: sha256Hex(stampBytes) })}\n`;
}

/**
 * Compute and atomically write the record. The stamp is read before and after
 * the walk: a sidecar republished mid-hash would otherwise bind a key for one
 * tree to the stamp of another.
 */
function writeGenerationRecord({ sidecarDir, mounts, installerScript, out }) {
  const stampPath = path.join(sidecarDir, STAMP_FILE);
  const stampBytes = fs.readFileSync(stampPath);
  const started = Date.now();
  const result = computePackedGeneration({ sidecarDir, mounts, installerScript });
  if (!stampBytes.equals(fs.readFileSync(stampPath))) {
    throw new Error(`${stampPath} changed while the sidecar was hashed; refusing to bind the generation`);
  }
  const temporary = `${out}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, formatGenerationRecord({ generation: result.generation, stampBytes }));
  fs.renameSync(temporary, out);
  return { ...result, out, stampSha256: sha256Hex(stampBytes), elapsedMs: Date.now() - started };
}

function parseArgs(argv) {
  const options = { mounts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--sidecar') options.sidecarDir = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--installer-script') options.installerScript = value();
    else if (arg === '--mount') {
      const spec = value();
      const at = spec.indexOf('=');
      if (at <= 0) throw new Error(`--mount expects name=dir, got ${spec}`);
      options.mounts[spec.slice(0, at)] = spec.slice(at + 1);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.sidecarDir || !options.out) {
    throw new Error('usage: sidecar-runtime-generation.js --sidecar <dir> --out <file> [--mount name=dir]... [--installer-script <file>]');
  }
  return options;
}

if (require.main === module) {
  try {
    const result = writeGenerationRecord(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `sidecar runtime generation ${result.generation} (${result.files} files, ${result.bytes} bytes, ${result.elapsedMs} ms) -> ${result.out}\n`,
    );
  } catch (error) {
    process.stderr.write(`sidecar-runtime-generation: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  GENERATION_FILE,
  RECORD_SCHEMA,
  computePackedGeneration,
  formatGenerationRecord,
  writeGenerationRecord,
  parseArgs,
};
