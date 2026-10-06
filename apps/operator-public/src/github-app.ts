/**
 * GitHub App plumbing for the Cupboard Worker — cupboard-release-pipeline-
 * content-trust-2026-09-16 P-006 (D-009: built and tested against an injected
 * GitHub; the real "Papercusp Cupboard" App registration is P-005, owner-gated,
 * and gates only LIVE enablement).
 *
 * Three jobs, all on WebCrypto + the injected `fetch` so they run unchanged in a
 * Cloudflare Worker and under Node/Vitest:
 *   1. verify a webhook delivery's `X-Hub-Signature-256` (HMAC-SHA256, constant
 *      time) — a delivery we cannot authenticate is never acted on;
 *   2. mint the App's short-lived RS256 JWT and exchange it for an INSTALLATION
 *      token (the credential that reads the pushed commit and posts the check);
 *   3. post a Check Run on the pushed commit carrying the verdict.
 *
 * This module only talks to GitHub and verifies signatures. It decides nothing
 * about listings — the route owns that — and it never logs or returns a secret.
 */

const GITHUB_API = 'https://api.github.com';

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Length-independent-of-content comparison: every byte is visited whether or
 *  not an earlier one differed, so timing does not reveal the first mismatch. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * `X-Hub-Signature-256` is `sha256=<hex HMAC of the RAW body>`. The raw bytes
 * are what GitHub signed — verify BEFORE parsing JSON, never a re-serialisation.
 * A missing, malformed, or non-`sha256=` header is simply `false`.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!secret || signatureHeader == null) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = hexToBytes(signatureHeader.slice(prefix.length));
  if (provided === null) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
  return constantTimeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// App JWT (RS256)
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }. */
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);

/**
 * GitHub hands out App private keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`), but
 * WebCrypto imports only PKCS#8. Wrap the PKCS#1 DER in the PKCS#8 envelope
 * `SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING { pkcs1 } }`.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octet = concat(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concat(Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM_IDENTIFIER, octet);
  return concat(Uint8Array.of(0x30), derLength(body.length), body);
}

/** PEM → DER bytes plus whether the label was the PKCS#1 `RSA PRIVATE KEY`. */
function parsePem(pem: string): { der: Uint8Array; pkcs1: boolean } | null {
  // Secrets pasted through `wrangler secret put` often carry literal `\n`.
  const normalised = pem.replace(/\\n/g, '\n');
  const match = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(normalised);
  if (!match) return null;
  try {
    const binary = atob(match[2]!.replace(/\s/g, ''));
    return { der: Uint8Array.from(binary, (char) => char.charCodeAt(0)), pkcs1: match[1] === 'RSA PRIVATE KEY' };
  } catch {
    return null;
  }
}

export class GithubAppKeyError extends Error {
  constructor() {
    super('GITHUB_APP_PRIVATE_KEY is not a PEM RSA private key');
    this.name = 'GithubAppKeyError';
  }
}

/** The App JWT GitHub requires: `iss` = App id, backdated 60s for clock skew,
 *  valid for at most 10 minutes (we use 9). */
export async function mintAppJwt(appId: string, privateKeyPem: string, nowSec: number): Promise<string> {
  const parsed = parsePem(privateKeyPem);
  if (parsed === null) throw new GithubAppKeyError();
  const pkcs8 = parsed.pkcs1 ? pkcs1ToPkcs8(parsed.der) : parsed.der;
  let key: CryptoKey;
  try {
    // `new Uint8Array(x)` re-homes the bytes on a plain ArrayBuffer — WebCrypto's
    // BufferSource rejects the `ArrayBufferLike` (possibly-shared) typing.
    key = await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new GithubAppKeyError();
  }
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

// ---------------------------------------------------------------------------
// GitHub REST: installation token + Check Run
// ---------------------------------------------------------------------------

const baseHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'papercusp-cupboard',
  'Content-Type': 'application/json',
});

export type InstallationTokenResult = { ok: true; token: string } | { ok: false; status: number };

/** Exchange the App JWT for a short-lived token scoped to ONE installation. */
export async function mintInstallationToken(input: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  nowSec: number;
  fetchImpl?: typeof fetch;
}): Promise<InstallationTokenResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const jwt = await mintAppJwt(input.appId, input.privateKeyPem, input.nowSec);
  const res = await fetchImpl(`${GITHUB_API}/app/installations/${encodeURIComponent(String(input.installationId))}/access_tokens`, {
    method: 'POST',
    headers: baseHeaders(jwt),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || body.token.length === 0) return { ok: false, status: res.status };
  return { ok: true, token: body.token };
}

export interface CheckRunInput {
  token: string;
  owner: string;
  name: string;
  headSha: string;
  /** Distinguishes the several listings one repo can hold (`<kind>/<ref>`). */
  checkName: string;
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
  fetchImpl?: typeof fetch;
}

/** Post a completed Check Run on the pushed commit. Best-effort by contract:
 *  the caller records `ok:false` and carries on — a failed annotation must never
 *  undo the drift flag the same delivery just set. */
export async function postCheckRun(input: CheckRunInput): Promise<{ ok: boolean; status: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/check-runs`,
    {
      method: 'POST',
      headers: baseHeaders(input.token),
      body: JSON.stringify({
        name: input.checkName,
        head_sha: input.headSha,
        status: 'completed',
        conclusion: input.conclusion,
        output: { title: input.title, summary: input.summary },
      }),
    },
  );
  return { ok: res.ok, status: res.status };
}
