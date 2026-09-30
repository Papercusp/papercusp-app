#!/usr/bin/env node
// Verify a Tauri updater (minisign) signature over an artifact using the
// embedded Ed25519 public key — WITHOUT an external `minisign`/`rsign2` binary.
// Node's crypto provides Blake2b-512 + Ed25519, the EXACT scheme Tauri's updater
// uses (minisign PREHASHED: Ed25519 over Blake2b-512(file)). Keeping this in
// Node means the local release box needs no extra system dependency to run the
// P-010 signature check (desktop-build-hardening-tri-platform-2026-07-11).
//
// WHY (D-004): the updater's REAL trust decision is this signature verifying
// against the pubkey baked into the app — NOT the sha256 in build-provenance.json.
// A correct-bytes-but-wrong/stale-signature artifact (LABELED!=PACKED at the
// SIGNATURE level) passes every sha256 check and still fails at install. This
// verifier is the executable form of "the signature the updater will actually
// trust does verify, right now, against the embedded key."
//
// Formats (minisign / tauri):
//   pubkey (tauri.conf.json plugins.updater.pubkey) = base64 of the 2-line
//     minisign pubkey FILE; its LAST line = base64([algo(2)|keyId(8)|pub(32)]).
//   .sig file on disk = base64 of the whole minisign sig FILE; that decoded
//     file's 2nd line = base64([algo(2)|keyId(8)|sig(64)]); 4th line = the
//     global signature (over sig||trustedComment) — verified too when present.
//   algo 'ED' = prehashed (Blake2b-512 of the file); 'Ed' = legacy (raw file).
//
// Usage: verify-tauri-signature.mjs <pubkey|path> <artifact> <sigfile> [--json]
//   <pubkey>   the tauri.conf.json updater pubkey (base64 of the 2-line file),
//              a path to a pubkey file, or the bare "RWR..." key line.
// Exit 0 = signature valid; 1 = invalid / key-id mismatch; 2 = usage/parse error.
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const pos = args.filter((a) => a !== '--json');
const [pubArg, artifact, sigPath] = pos;

function finish(code, obj) {
  if (wantJson) process.stdout.write(JSON.stringify(obj) + '\n');
  else {
    const tag = obj.valid ? 'VALID' : 'INVALID';
    const detail = obj.reason || obj.error || '';
    process.stderr.write(`signature ${tag}${detail ? ': ' + detail : ''}\n`);
  }
  process.exit(code);
}

if (!pubArg || !artifact || !sigPath) {
  finish(2, { valid: false, error: 'usage: verify-tauri-signature.mjs <pubkey|path> <artifact> <sigfile> [--json]' });
}
if (!existsSync(artifact)) finish(2, { valid: false, error: `artifact not found: ${artifact}` });
if (!existsSync(sigPath)) finish(2, { valid: false, error: `sig file not found: ${sigPath}` });

// ── Resolve the pubkey's key line ─────────────────────────────────────────
function decodeMaybeText(s) {
  const t = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(t)) return null;
  try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return null; }
}
function keyLineFrom(arg) {
  let text = arg;
  if (existsSync(arg)) text = readFileSync(arg, 'utf8');
  const decoded = decodeMaybeText(text.trim());
  // tauri.conf pubkey is base64 of the 2-line file → decoded text names the key.
  if (decoded && /minisign public key/i.test(decoded)) text = decoded;
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // The key material is the LAST non-empty line (comment line comes first).
  return lines[lines.length - 1] || '';
}

let keyBytes, sigBytes, sigFileText;
try {
  keyBytes = Buffer.from(keyLineFrom(pubArg), 'base64');
  // The .sig file on disk is base64 of the whole minisign sig file.
  sigFileText = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64').toString('utf8');
  const sigLines = sigFileText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  sigBytes = Buffer.from(sigLines[1] || '', 'base64');
} catch (e) {
  finish(2, { valid: false, error: `parse error: ${e.message}` });
}
if (keyBytes.length !== 42) finish(2, { valid: false, error: `pubkey block is ${keyBytes.length} bytes, expected 42` });
if (sigBytes.length !== 74) finish(2, { valid: false, error: `sig block is ${sigBytes.length} bytes, expected 74` });

const pubKeyId = keyBytes.subarray(2, 10);
const pub = keyBytes.subarray(10, 42);
const sigAlgo = sigBytes.subarray(0, 2).toString('latin1');
const sigKeyId = sigBytes.subarray(2, 10);
const sig = sigBytes.subarray(10, 74);
const keyIdHex = pubKeyId.toString('hex');

if (!pubKeyId.equals(sigKeyId)) {
  finish(1, { valid: false, reason: `key id mismatch — sig key ${sigKeyId.toString('hex')} != pubkey ${keyIdHex} (signature not from this key)`, keyId: keyIdHex });
}

function blake2b512File(p) {
  return new Promise((res, rej) => {
    const h = createHash('blake2b512');
    const s = createReadStream(p);
    s.on('error', rej);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest()));
  });
}

async function main() {
  let message;
  if (sigAlgo === 'ED') message = await blake2b512File(artifact); // prehashed (tauri default)
  else if (sigAlgo === 'Ed') message = readFileSync(artifact); // legacy raw-file
  else finish(2, { valid: false, error: `unknown signature algorithm '${sigAlgo}'` });

  // Rebuild an SPKI DER wrapper around the raw 32-byte Ed25519 public key.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
  let ok;
  try {
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    ok = edVerify(null, message, keyObj, sig);
  } catch (e) {
    finish(1, { valid: false, reason: `verify error: ${e.message}`, algo: sigAlgo, keyId: keyIdHex });
  }
  if (ok) finish(0, { valid: true, algo: sigAlgo, keyId: keyIdHex });
  finish(1, { valid: false, reason: 'ed25519 signature does not verify against the pubkey', algo: sigAlgo, keyId: keyIdHex });
}
main();
