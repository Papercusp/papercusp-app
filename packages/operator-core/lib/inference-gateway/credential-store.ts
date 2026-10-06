/**
 * Credential resolution + automated refresh for the hive inference gateway
 * (hive-inference-gateway-2026-06-09 P-003).
 *
 * The gateway is the SOLE egress to api.anthropic.com for a machine's bees, so it holds the
 * bound account's OAuth and injects it. A bound account is named by an account-pool
 * `credentialRef` (the same shape the frame-installer / `accounts:register` use):
 *
 *   - `token:<path>`  — a long-lived `claude setup-token` (`sk-ant-oat…`). No expiry, no
 *                       refresh; used as the bearer verbatim. The proven owner-add channel.
 *   - `file:<path>` / absolute / `~` — a `.credentials.json` bundle (a `claudeAiOauth` block:
 *                       accessToken + refreshToken + expiresAt). Access tokens are short-lived
 *                       (~hours), so the gateway REFRESHES them transparently via the claude
 *                       OAuth provider (`grant_type=refresh_token`, same client_id that minted
 *                       them) and rewrites the bundle in place — the piece the pool lacked.
 *
 * Refresh reuses `oauth/token.ts getOAuthToken` (near-expiry refresh + concurrent-refresh
 * dedup), backed by a bundle-shaped `TokenStorage`. A small in-memory token cache keeps the
 * hot proxy path off disk between refreshes.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOAuthToken, type TokenStorage } from '../oauth/token';
import { getProvider, registerProvider, makeClaudeProvider } from '../oauth/providers';
import {
  listClaudeKeychainCredentialItemsAsync,
  readKeychainSecretAsync,
  writeClaudeKeychainOAuthBundleAsync,
} from '../agent-auth-detect';

/** The OAuth beta flag a subscription (non-API-key) request must carry. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** The Anthropic beta that enables the 1M context window for marked models. */
export const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';
/** Refresh this far before the access token's expiry (mirrors getOAuthToken's window). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** The on-disk `~/.claude/.credentials.json` bundle shape. */
export interface ClaudeCredentialBundle {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    /** Epoch ms. */
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

let claudeProviderRegistered = false;
/** Idempotently register the default (refresh-capable) claude provider in the OAuth registry. */
export function ensureClaudeProvider(): void {
  if (claudeProviderRegistered) return;
  if (!getProvider('claude')) registerProvider(makeClaudeProvider());
  claudeProviderRegistered = true;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p;
}

/** Parse a credentialRef into its channel + path (mirrors `resolveCredential`). A Claude account is
 *  either a consumer Claude subscription — `token:` (a `claude setup-token`), `file:` (a refreshable
 *  `.credentials.json` bundle), or `keychain:` (the macOS login-Keychain item Claude Code stores the
 *  SAME bundle JSON in — darwin has no `.credentials.json` on disk; P-006,
 *  cross-platform-hardening-and-agent-ergonomics-2026-07-05) — or an Anthropic Console API key,
 *  `apikey:<source>` (anthropic-credits-gateway-2026-09-30 P-005, D-002). An API-key account spends
 *  the Console organization's API credits and authenticates with `x-api-key` instead of the
 *  subscription OAuth Bearer; `path` carries the raw source spec, parsed by `parseApiKeySource`. */
export function parseCredentialRef(ref: string): { kind: 'token' | 'file' | 'env' | 'keychain' | 'apikey'; path: string } {
  if (ref.startsWith('token:')) return { kind: 'token', path: expandHome(ref.slice(6)) };
  if (ref.startsWith('file:')) return { kind: 'file', path: expandHome(ref.slice(5)) };
  if (ref.startsWith('env:')) return { kind: 'env', path: ref.slice(4).trim() };
  if (ref.startsWith('keychain:')) return { kind: 'keychain', path: ref.slice(9).trim() };
  if (ref.startsWith('apikey:')) {
    const spec = ref.slice(7).trim();
    parseApiKeySource(spec); // validate eagerly so a malformed ref fails at parse, not at first request
    return { kind: 'apikey', path: spec };
  }
  if (ref.startsWith('/') || ref.startsWith('~')) return { kind: 'file', path: expandHome(ref) };
  throw new Error(
    `inference-gateway: unsupported credentialRef '${ref}' (expected token:/file:/keychain:/path for a Claude subscription, or apikey:env:NAME | apikey:file:PATH | apikey:credentials for a Console API key)`,
  );
}

/** How an upstream Claude request authenticates. `oauth` = `Authorization: Bearer` plus the
 *  subscription `oauth-2025-04-20` beta (a subscription account; also the shape of a plain bearer
 *  account). `api-key` = `x-api-key` with NO Authorization header and NO oauth beta (an Anthropic
 *  Console API key, billed to the organization's API credits). */
export type ClaudeAuthMode = 'oauth' | 'api-key';

/** Where an `apikey:` account's key lives. `credentials` is the operator credentials store's
 *  `anthropic_api_key` (written by `setup:save_key`), so a key saved once is usable without copying
 *  it into a file or the gateway's environment. */
export type ApiKeySource = { kind: 'env'; name: string } | { kind: 'file'; path: string } | { kind: 'credentials' };

/** Parse the part of an `apikey:` credentialRef after the scheme. Throws on an unknown source. */
export function parseApiKeySource(spec: string): ApiKeySource {
  const s = spec.trim();
  if (s === 'credentials') return { kind: 'credentials' };
  if (s.startsWith('env:')) {
    const name = s.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`inference-gateway: apikey:env: needs an environment variable name, got '${name}'`);
    }
    return { kind: 'env', name };
  }
  if (s.startsWith('file:')) {
    const path = expandHome(s.slice(5).trim());
    if (!path) throw new Error('inference-gateway: apikey:file: needs a path');
    return { kind: 'file', path };
  }
  throw new Error(
    `inference-gateway: unsupported apikey source '${spec}' (expected apikey:env:NAME | apikey:file:PATH | apikey:credentials)`,
  );
}

/** Reads the operator credentials store's `anthropic_api_key` — injectable for tests (the default
 *  touches Postgres, lazily, so importing this module never does). */
export type ApiKeyCredentialsReader = () => Promise<string | undefined>;
const defaultApiKeyCredentialsReader: ApiKeyCredentialsReader = async () => {
  const { readCredentials } = await import('../credentials');
  return (await readCredentials()).anthropic_api_key;
};
let apiKeyCredentialsReader: ApiKeyCredentialsReader = defaultApiKeyCredentialsReader;
export function _setApiKeyCredentialsReaderForTests(fn: ApiKeyCredentialsReader | null): void {
  apiKeyCredentialsReader = fn ?? defaultApiKeyCredentialsReader;
}

/** Resolve an API key from its source. Refuses a subscription OAuth token (`sk-ant-oat…`) — sent as
 *  `x-api-key` it would 401 on every request; that credential belongs under `token:`. */
async function readApiKey(source: ApiKeySource): Promise<string> {
  let raw: string | undefined;
  let where: string;
  if (source.kind === 'env') {
    raw = process.env[source.name];
    where = `environment variable ${source.name}`;
  } else if (source.kind === 'file') {
    raw = await fs.readFile(source.path, 'utf8');
    where = source.path;
  } else {
    raw = await apiKeyCredentialsReader();
    where = 'the operator credentials store (anthropic_api_key — set it with setup:save_key)';
  }
  const key = normalizeBearerToken(raw ?? '');
  if (!key) throw new Error(`inference-gateway: no Anthropic API key in ${where}`);
  if (key.startsWith('sk-ant-oat')) {
    throw new Error(
      `inference-gateway: ${where} holds a subscription OAuth token, not a Console API key — register it as token:<path> instead of apikey:`,
    );
  }
  return key;
}

/**
 * A `TokenStorage` backed by a `.credentials.json` bundle file. Maps the helper's
 * `(field, field_refresh, field_expires_at)` config keys onto `claudeAiOauth.*` and persists
 * a refresh by rewriting the bundle atomically (0600), preserving the other bundle fields.
 */
export function bundleTokenStorage(path: string): TokenStorage {
  const FIELD = 'access';
  return {
    async read() {
      const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
      const o = bundle.claudeAiOauth ?? ({} as ClaudeCredentialBundle['claudeAiOauth']);
      return {
        [FIELD]: o.accessToken,
        [`${FIELD}_refresh`]: o.refreshToken,
        [`${FIELD}_expires_at`]: o.expiresAt ?? null,
      };
    },
    async update(_plugin, _harness, patch) {
      const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
      const o = bundle.claudeAiOauth ?? ({} as ClaudeCredentialBundle['claudeAiOauth']);
      if (typeof patch[FIELD] === 'string') o.accessToken = patch[FIELD] as string;
      if (typeof patch[`${FIELD}_refresh`] === 'string') o.refreshToken = patch[`${FIELD}_refresh`] as string;
      if (`${FIELD}_expires_at` in patch) {
        const v = patch[`${FIELD}_expires_at`];
        o.expiresAt = typeof v === 'number' ? v : undefined;
      }
      bundle.claudeAiOauth = o;
      const tmp = `${path}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(bundle, null, 2), { mode: 0o600 });
      await fs.rename(tmp, path);
    },
  };
}

export interface CredentialResolver {
  /** A fresh bearer token (refreshing a near-expiry bundle transparently). */
  current(): Promise<string>;
  /** Force the next `current()` to re-read/refresh (call after an upstream 401). */
  invalidate(): void;
  /** The credential channel: `token` (a setup-token, never refreshes), `file` (a bundle the
   *  gateway refreshes near expiry), or `keychain` (the macOS local-credential FRESHEST-SCAN —
   *  serves the newest live bundle across the base Keychain item, every per-config-dir sibling
   *  and the disk bundle, self-refreshing only when all of them are hard-expired; see the
   *  channel comment above), or `apikey` (an Anthropic Console API key — never refreshes). */
  readonly kind: 'token' | 'file' | 'keychain' | 'apikey';
  /** How the upstream request authenticates with what `current()` returns: `oauth` (Bearer + the
   *  oauth beta) for every subscription channel, `api-key` (x-api-key) for `apikey:`. */
  readonly authMode: ClaudeAuthMode;
}

// ── macOS local-credential channel (`keychain:`) — the FRESHEST-SCAN resolver ──────────────────
// Claude Code on macOS stores the SAME `.credentials.json` bundle JSON as login-Keychain
// generic-passwords — but NOT as one item: the base 'Claude Code-credentials' item belongs to the
// default `~/.claude` config, and every CLAUDE_CONFIG_DIR session owns a hashed sibling
// ('Claude Code-credentials-<sha256(configDir) first-8-hex>') that it refreshes AS IT RUNS.
// Anthropic OAuth refresh tokens are single-use and ROTATE on every refresh, so any one snapshot
// (the base item, or a ~/.claude/.credentials.json file) is dead the first time a rotation happens
// elsewhere in the family. Serving one fixed item is exactly how the gateway spent weeks 401ing
// every fleet member while a live CLI kept a fresh bundle two Keychain items away (the recurring
// "fleet member not logged in", root-caused 2026-07-06). The channel therefore SCANS every local
// source — the named base item, every enumerated Claude Code Keychain sibling, and the disk
// bundle — and serves the freshest live token; only when EVERYTHING is hard-expired does it
// refresh the freshest refreshable bundle itself, persisting the rotated result back (Keychain
// write-back, disk fallback). Reading a SECRET (`-w`) may raise a one-time "allow access" GUI
// prompt on some Macs (click "Always Allow"); enumeration is metadata-only and never prompts.

// Every Keychain call below is NON-BLOCKING (WI-10005306). The gateway serves every fleet
// member's inference from one event loop, and the freshest-scan shells out to `security` once
// per enumerated item (dozens on a fleet Mac) plus a `dump-keychain` of up to 15s. Run with
// spawnSync, each call froze every in-flight request for its duration. The injectable seams
// accept a sync OR async function, so a plain sync test fake stays assignable (`await` takes
// plain values); the defaults are agent-auth-detect's execFile-based helpers.

/** Read the Keychain item's secret payload, or null when absent/unreadable. Injectable for tests
 *  (there is no `security` off macOS). */
export type KeychainSecretReader = (service: string) => Promise<string | null> | string | null;

const defaultKeychainReader: KeychainSecretReader = (service) => readKeychainSecretAsync(service);
let keychainReader: KeychainSecretReader = defaultKeychainReader;
export function _setKeychainReaderForTests(fn: KeychainSecretReader | null): void {
  keychainReader = fn ?? defaultKeychainReader;
}

/** One reader call that never throws: a throwing/rejecting seam is a miss, like a null. */
async function readKeychainSecret(service: string): Promise<string | null> {
  try {
    const raw = await keychainReader(service);
    return typeof raw === 'string' && raw ? raw : null;
  } catch {
    return null;
  }
}

/** Read + parse Claude Code's Keychain bundle. Throws with actionable guidance on any miss. */
export async function readClaudeKeychainBundle(service: string): Promise<ClaudeCredentialBundle> {
  const raw = await readKeychainSecret(service);
  if (!raw) {
    throw new Error(
      `inference-gateway: no readable Keychain item for service '${service}' — is Claude Code ` +
        'signed in on this Mac? (security find-generic-password -s returned nothing; a Keychain ' +
        'ACL prompt may need a one-time "Always Allow")',
    );
  }
  try {
    return JSON.parse(raw.trim()) as ClaudeCredentialBundle;
  } catch {
    throw new Error(`inference-gateway: Keychain item '${service}' is not a credentials-bundle JSON`);
  }
}

/** Enumerate Claude Code Keychain items (service + account, metadata only) — injectable for
 *  tests (there is no Keychain off macOS). Defaults to agent-auth-detect's `dump-keychain` shim. */
export type KeychainItemLister = () =>
  | Promise<{ service: string; account: string | null }[]>
  | { service: string; account: string | null }[];
const defaultKeychainItemLister: KeychainItemLister = () => listClaudeKeychainCredentialItemsAsync();
let keychainLister: KeychainItemLister = defaultKeychainItemLister;
export function _setKeychainListerForTests(fn: KeychainItemLister | null): void {
  keychainLister = fn ?? defaultKeychainItemLister;
}

/** Write a rotated bundle back into a Keychain item — injectable for tests. Defaults to
 *  agent-auth-detect's `add-generic-password -U` shim (false off macOS / on ACL refusal). */
export type KeychainBundleWriter = (
  service: string,
  account: string,
  secret: string,
) => Promise<boolean> | boolean;
const defaultKeychainBundleWriter: KeychainBundleWriter = (service, account, secret) =>
  writeClaudeKeychainOAuthBundleAsync(service, account, secret);
let keychainWriter: KeychainBundleWriter = defaultKeychainBundleWriter;
export function _setKeychainWriterForTests(fn: KeychainBundleWriter | null): void {
  keychainWriter = fn ?? defaultKeychainBundleWriter;
}

/** One readable local Claude credential bundle found by the freshest-scan. */
export interface LocalCredentialCandidate {
  /** Log identity + write-back routing: `keychain:<service>` or `file:<path>`. */
  ref: string;
  kind: 'keychain' | 'file';
  service?: string;
  account?: string | null;
  path?: string;
  bundle: ClaudeCredentialBundle;
}

/** The global disk bundle — a scan candidate, and the persist fallback when a Keychain
 *  write-back is refused. Honors $HOME (like every other path in this module) so tests
 *  can redirect it off the real box credential. */
export function localCredentialsFilePath(): string {
  return join(process.env.HOME ?? homedir(), '.claude', '.credentials.json');
}

/**
 * Every readable local Claude credential bundle: the named base Keychain item, every enumerated
 * Claude Code Keychain sibling (per-CLAUDE_CONFIG_DIR items — see the channel comment above), and
 * the `~/.claude/.credentials.json` disk bundle. Unreadable / non-bundle / token-less sources are
 * skipped silently — the scan's job is to find SOMETHING live, not to validate every snapshot.
 */
export async function scanLocalCredentialCandidates(baseService: string): Promise<LocalCredentialCandidate[]> {
  const out: LocalCredentialCandidate[] = [];
  const metas = new Map<string, string | null>([[baseService, null]]);
  let listed: { service: string; account: string | null }[] = [];
  try {
    const l = await keychainLister();
    if (Array.isArray(l)) listed = l;
  } catch {
    /* enumeration failed → scan the base item + disk bundle only */
  }
  for (const m of listed) {
    if (!metas.has(m.service) || m.account) metas.set(m.service, m.account);
  }
  for (const [service, account] of metas) {
    const raw = await readKeychainSecret(service);
    if (!raw) continue;
    try {
      const bundle = JSON.parse(raw.trim()) as ClaudeCredentialBundle;
      if (bundle?.claudeAiOauth?.accessToken) {
        out.push({ ref: `keychain:${service}`, kind: 'keychain', service, account, bundle });
      }
    } catch {
      /* not a credential bundle — skip */
    }
  }
  const filePath = localCredentialsFilePath();
  try {
    const bundle = JSON.parse(await fs.readFile(filePath, 'utf8')) as ClaudeCredentialBundle;
    if (bundle?.claudeAiOauth?.accessToken) {
      out.push({ ref: `file:${filePath}`, kind: 'file', path: filePath, bundle });
    }
  } catch {
    /* absent / unreadable — fine */
  }
  return out;
}

/**
 * Pick what the freshest-scan serves. `live` = the candidate with the LATEST known-future expiry
 * (a known-future expiry beats no-expiry — fleet boxes accumulate stale no-expiry junk bundles),
 * else any unknown-expiry one. `refreshables` = the all-expired refresh order: every candidate
 * carrying a refreshToken, freshest first — rotation invalidates older refresh tokens, so the
 * newest bundle holds the family's most-likely-valid one. Pure; exported for tests.
 */
export function selectLocalCredential(
  candidates: LocalCredentialCandidate[],
  now: number,
): { live?: LocalCredentialCandidate; refreshables: LocalCredentialCandidate[] } {
  const expOf = (c: LocalCredentialCandidate) => c.bundle.claudeAiOauth?.expiresAt ?? 0;
  const future = candidates.filter((c) => expOf(c) > now).sort((a, b) => expOf(b) - expOf(a));
  const unknown = candidates.filter((c) => !expOf(c));
  const refreshables = candidates
    .filter((c) => c.bundle.claudeAiOauth?.refreshToken)
    .sort((a, b) => expOf(b) - expOf(a));
  return { live: future[0] ?? unknown[0], refreshables };
}

/**
 * Persist a rotated bundle. The refresh CONSUMED the old refresh token (single-use), so losing the
 * rotated result strands every holder of the old one — persist tries the source Keychain item
 * first (same service+account), then the global disk bundle (atomic, 0600). A total persist
 * failure still leaves the fresh token serving from memory — better a live gateway plus one lost
 * rotation than a dead gateway — but it warns loudly, because the NEXT all-expired refresh on that
 * source will fail.
 */
async function persistLocalCandidate(c: LocalCredentialCandidate): Promise<void> {
  if (c.kind === 'keychain') {
    const account = c.account ?? process.env.USER ?? '';
    let wrote = false;
    try {
      wrote = account !== '' && (await keychainWriter(c.service!, account, JSON.stringify(c.bundle))) === true;
    } catch {
      /* a throwing writer is a refused write-back → disk fallback below */
    }
    if (wrote) return;
  }
  const filePath = c.kind === 'file' ? c.path! : localCredentialsFilePath();
  try {
    await fs.mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(c.bundle, null, 2), { mode: 0o600 });
    await fs.rename(tmp, filePath);
  } catch (e) {
    console.warn(
      `[inference-gateway:warn] rotated credential bundle could not be persisted anywhere (${c.ref} → ${filePath}): ` +
        `${scrubSecrets((e as Error).message)} — serving it from memory; the next all-expired refresh on this source will fail`,
    );
  }
}

/** OAuth-refresh one scanned candidate via the claude provider and persist the rotated bundle
 *  back to its source. Returns the fresh token + its expiry for the resolver cache. */
async function refreshLocalCandidate(
  c: LocalCredentialCandidate,
  dedupKey: string,
): Promise<{ token: string; expiresAt: number }> {
  ensureClaudeProvider();
  const FIELD = 'access';
  let persistedExpiresAt = c.bundle.claudeAiOauth?.expiresAt ?? 0;
  const storage: TokenStorage = {
    async read() {
      const o = c.bundle.claudeAiOauth;
      return { [FIELD]: o?.accessToken, [`${FIELD}_refresh`]: o?.refreshToken, [`${FIELD}_expires_at`]: o?.expiresAt ?? null };
    },
    async update(_plugin, _harness, patch) {
      const o = c.bundle.claudeAiOauth ?? ({} as NonNullable<ClaudeCredentialBundle['claudeAiOauth']>);
      if (typeof patch[FIELD] === 'string') o.accessToken = patch[FIELD] as string;
      if (typeof patch[`${FIELD}_refresh`] === 'string') o.refreshToken = patch[`${FIELD}_refresh`] as string;
      if (`${FIELD}_expires_at` in patch) {
        const v = patch[`${FIELD}_expires_at`];
        o.expiresAt = typeof v === 'number' ? v : undefined;
      }
      c.bundle.claudeAiOauth = o;
      persistedExpiresAt = o.expiresAt ?? 0;
      await persistLocalCandidate(c);
    },
  };
  const token = await getOAuthToken(
    { plugin: 'inference-gateway', harness: `${dedupKey}:${c.ref}`, storage, resolveProvider: () => ({ provider: 'claude' }) },
    FIELD,
  );
  if (!token) throw new Error('refresh yielded no access token');
  return { token: normalizeBearerToken(token), expiresAt: persistedExpiresAt };
}

/** Bound the freshest-scan frequency: a near-expiry token re-scans at most this often (the scan
 *  shells out to `security` dozens of times — never per-request), and an UNAUTHENTICATED verdict
 *  is re-derived at most this often (keeps a signed-out box from hammering the OAuth endpoint
 *  with a consumed refresh token on every member request). */
const LOCAL_SCAN_MIN_INTERVAL_MS = 15_000;

/** Cap the all-expired refresh attempts per scan (distinct refresh tokens, freshest first) —
 *  a fleet box carries dozens of stale snapshots and each attempt is a network call. */
const LOCAL_REFRESH_MAX_ATTEMPTS = 5;

/**
 * Collapse a raw credential string to the single header-safe token it is meant to be. A bearer is
 * one RFC 7230 field token — but a hand-pasted credential wrapped by a terminal carries an
 * EMBEDDED newline that `trim()` cannot see. Left in, it is injected verbatim into the
 * `Authorization` header and every request on that account dies with
 * `Headers.append: … is an invalid header value` (502 for the caller) — the 2026-07-03 incident:
 * three pool accounts had never served a single request because their token files were pasted
 * with a mid-token line wrap. Stripping ALL whitespace reconstructs the intended token (the
 * token alphabet has no whitespace), so normalize every read through this.
 */
export function normalizeBearerToken(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * Redact credential material from a string bound for a client-facing error body or a log line.
 * The 2026-07-03 `Headers.append: "Bearer sk-ant-oat01-…" is an invalid header value` 502 echoed a
 * LIVE account token verbatim into every caller's terminal + journald — an upstream/runtime error
 * message is never guaranteed secret-free, so every gateway error surface must pass through this.
 * Keeps a short identifying prefix so operators can still tell WHICH credential is involved.
 */
export function scrubSecrets(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, (m) => `${m.slice(0, 12)}…[redacted]`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]');
}

function pickBearerString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return normalizeBearerToken(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of ['value', 'apiKey', 'api_key', 'key']) {
    const candidate = rec[key];
    if (typeof candidate === 'string' && candidate.trim()) return normalizeBearerToken(candidate);
  }
  return undefined;
}

function extractBearerFromFile(raw: string, path: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`inference-gateway: empty bearer token at ${path}`);
  if (!trimmed.startsWith('{')) return normalizeBearerToken(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
    const apiKey = pickBearerString(parsed.OPENAI_API_KEY);
    if (apiKey) return apiKey;
    if (parsed.auth_mode === 'chatgpt') {
      throw new Error(
        `inference-gateway: Codex/OpenAI gateway credential at ${path} is a ChatGPT auth.json; ` +
          'register an OpenAI API bearer via token:<path> or env:NAME instead',
      );
    }
    const token = parsed?.tokens?.access_token;
    if (typeof token === 'string' && token.trim()) return normalizeBearerToken(token);
  } catch (e) {
    if (e instanceof Error && e.message.includes('ChatGPT auth.json')) throw e;
    throw new Error(`inference-gateway: bearer credential JSON at ${path} failed to parse`);
  }
  throw new Error(`inference-gateway: bearer credential JSON at ${path} has no tokens.access_token`);
}

export async function credentialRefSupportsOpenAiBearer(credentialRef: string): Promise<boolean> {
  try {
    await makeBearerCredentialResolver(credentialRef).current();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a resolver for one account's credentialRef. `token:` returns the staged setup-token
 * verbatim (cached; no expiry). `file:` returns the bundle's access token, refreshing via the
 * claude provider when within REFRESH_SKEW_MS of expiry; an in-memory {token, expiresAt} cache
 * keeps the per-request path off disk between refreshes. `keychain:` runs the local-credential
 * FRESHEST-SCAN (see the channel comment above): newest live bundle across the base item, every
 * per-config-dir Keychain sibling and the disk bundle; self-refresh (+ persist-back) only when
 * every source is hard-expired. `harnessKey` scopes the concurrent-refresh dedup so distinct
 * accounts never share a refresh.
 */
export function makeCredentialResolver(credentialRef: string, harnessKey?: string): CredentialResolver {
  const { kind, path } = parseCredentialRef(credentialRef);
  if (kind === 'env') {
    throw new Error(`inference-gateway: unsupported Claude credentialRef '${credentialRef}' (env: is only valid for bearer accounts; a Console API key in the environment is apikey:env:NAME)`);
  }
  if (kind === 'apikey') return makeApiKeyResolver(parseApiKeySource(path));
  ensureClaudeProvider();
  const dedupKey = harnessKey ?? path;

  let cachedToken: string | undefined;
  let cachedExpiresAt = 0; // epoch ms; 0 = unknown/no-expiry
  let lastScanAt = 0; // last freshest-scan (keychain kind) — bounds the near-expiry re-scan rate
  // Negative cache (keychain kind): a signed-out box re-derives its UNAUTHENTICATED verdict at
  // most every LOCAL_SCAN_MIN_INTERVAL_MS instead of paying a full scan + refresh attempts on
  // every member request.
  let lastScanFailure: { at: number; err: Error } | undefined;

  return {
    kind,
    authMode: 'oauth',
    invalidate() {
      cachedToken = undefined;
      cachedExpiresAt = 0;
      lastScanAt = 0; // a 401 means the served token is bad NOW — the next current() must re-scan
      lastScanFailure = undefined; // the reload/refresh ticks invalidate() first — let them retry immediately
    },
    async current() {
      if (kind === 'token') {
        if (cachedToken) return cachedToken;
        cachedToken = normalizeBearerToken(await fs.readFile(path, 'utf8'));
        if (!cachedToken) throw new Error(`inference-gateway: empty setup-token at ${path}`);
        return cachedToken;
      }
      if (kind === 'keychain') {
        // FRESHEST-SCAN. Serve the cache until near expiry; then re-scan every local source —
        // whichever live CLI refreshed most recently wins. Within the skew window the scan
        // repeats (rate-bounded — it shells out to `security` per item) until a fresher bundle
        // appears; once EVERYTHING is hard-expired, refresh the freshest refreshable bundle
        // ourselves and persist the rotated result back. An upstream 401 invalidate()s the
        // cache, so recovery from a newly-signed-in CLI needs no gateway restart.
        const now = Date.now();
        const cachedStillValid = cachedExpiresAt === 0 || cachedExpiresAt > now;
        if (
          cachedToken &&
          cachedStillValid &&
          (cachedExpiresAt === 0 || cachedExpiresAt - now > REFRESH_SKEW_MS || now - lastScanAt < LOCAL_SCAN_MIN_INTERVAL_MS)
        ) {
          return cachedToken;
        }
        if (lastScanFailure && now - lastScanFailure.at < LOCAL_SCAN_MIN_INTERVAL_MS) {
          throw lastScanFailure.err;
        }
        lastScanAt = now;
        const candidates = await scanLocalCredentialCandidates(path);
        const { live, refreshables } = selectLocalCredential(candidates, now);
        if (live) {
          const o = live.bundle.claudeAiOauth!;
          cachedToken = normalizeBearerToken(o.accessToken ?? '');
          cachedExpiresAt = o.expiresAt ?? 0;
          lastScanFailure = undefined;
          return cachedToken;
        }
        const failures: string[] = [];
        const attemptedRefreshTokens = new Set<string>(); // stale snapshots share bundles — refresh each family branch once
        for (const c of refreshables) {
          const rt = c.bundle.claudeAiOauth!.refreshToken!;
          if (attemptedRefreshTokens.has(rt)) continue;
          if (attemptedRefreshTokens.size >= LOCAL_REFRESH_MAX_ATTEMPTS) break;
          attemptedRefreshTokens.add(rt);
          try {
            const r = await refreshLocalCandidate(c, dedupKey);
            cachedToken = r.token;
            cachedExpiresAt = r.expiresAt;
            lastScanFailure = undefined;
            return r.token;
          } catch (e) {
            failures.push(`${c.ref}: ${(e as Error).message}`);
          }
        }
        const err = new Error(
          `inference-gateway: UNAUTHENTICATED — no live Claude credential on this machine. Scanned ` +
            `${candidates.length} bundle(s) (Keychain '${path}' + per-config-dir siblings + ` +
            `${localCredentialsFilePath()}): ${candidates.length ? 'all hard-expired' : 'none readable'}` +
            (failures.length
              ? `; refresh attempts failed: ${scrubSecrets(failures.join(' | '))}`
              : candidates.length
                ? '; none carries a refreshToken'
                : '') +
            `. Sign in with \`claude\` on this machine (any session) — the gateway picks it up on its next request, no restart needed.`,
        );
        lastScanFailure = { at: now, err };
        throw err;
      }
      // file: bundle — serve the cache until near expiry, else refresh-on-read via getOAuthToken.
      const now = Date.now();
      if (cachedToken && (cachedExpiresAt === 0 || cachedExpiresAt - now > REFRESH_SKEW_MS)) {
        return cachedToken;
      }
      const token = await getOAuthToken(
        {
          plugin: 'inference-gateway',
          harness: dedupKey,
          storage: bundleTokenStorage(path),
          resolveProvider: () => ({ provider: 'claude' }),
        },
        'access',
      );
      if (!token) throw new Error(`inference-gateway: no access token in bundle ${path}`);
      const normalized = normalizeBearerToken(token);
      // Re-read the (possibly refreshed) expiry to set the cache window.
      try {
        const bundle = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
        cachedExpiresAt = bundle.claudeAiOauth?.expiresAt ?? 0;
      } catch {
        cachedExpiresAt = 0;
      }
      cachedToken = normalized;
      return normalized;
    },
  };
}

/**
 * An Anthropic Console API-key account (`apikey:`, anthropic-credits-gateway-2026-09-30 P-005). The
 * key is read once and cached — keys do not expire, so there is nothing to refresh — and an upstream
 * 401 `invalidate()`s the cache so a rotated key (a new env value, file, or `setup:save_key`) is
 * picked up on the next request without a gateway restart.
 */
function makeApiKeyResolver(source: ApiKeySource): CredentialResolver {
  let cachedKey: string | undefined;
  return {
    kind: 'apikey',
    authMode: 'api-key',
    invalidate() {
      cachedKey = undefined;
    },
    async current() {
      if (cachedKey) return cachedKey;
      cachedKey = await readApiKey(source);
      return cachedKey;
    },
  };
}

export function makeBearerCredentialResolver(credentialRef: string): CredentialResolver {
  const { kind, path } = parseCredentialRef(credentialRef);
  if (kind === 'keychain' || kind === 'apikey') {
    throw new Error(
      `inference-gateway: unsupported bearer credentialRef '${credentialRef}' (${kind === 'keychain' ? 'keychain: is Claude-subscription-only' : 'apikey: is Claude-only'}; use token:/file:/env: for bearer accounts)`,
    );
  }
  let cachedToken: string | undefined;
  return {
    kind: kind === 'env' ? 'token' : kind,
    authMode: 'oauth',
    invalidate() {
      cachedToken = undefined;
    },
    async current() {
      if (cachedToken) return cachedToken;
      if (kind === 'env') {
        const value = normalizeBearerToken(process.env[path] ?? '');
        if (!value) throw new Error(`inference-gateway: env credential ${path} is empty or unset`);
        cachedToken = value;
        return cachedToken;
      }
      cachedToken = extractBearerFromFile(await fs.readFile(path, 'utf8'), path);
      return cachedToken;
    },
  };
}

/** Split a comma-separated `anthropic-beta` value into trimmed, de-duplicated flags (order kept). */
function betaFlags(incoming: string | null | undefined): Set<string> {
  return new Set(
    (incoming ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Build the `anthropic-beta` header to send upstream on an OAuth (subscription) request: the
 * client's existing beta flags PLUS the required `oauth-2025-04-20`, de-duplicated.
 */
export function withOAuthBeta(incoming: string | null | undefined, context1m = false): string {
  const flags = betaFlags(incoming);
  flags.add(CLAUDE_OAUTH_BETA);
  if (context1m) flags.add(CLAUDE_CONTEXT_1M_BETA);
  return [...flags].join(',');
}

/**
 * The client's `anthropic-beta` flags plus the 1M-context beta when requested — WITHOUT the
 * subscription OAuth flag. This is the auth-neutral request-level value; the per-attempt layer
 * (`claudeAttemptHeaders`) adds or removes the OAuth flag for the account the attempt lands on.
 * Returns undefined when no flag remains.
 */
export function withClientBetas(incoming: string | null | undefined, context1m = false): string | undefined {
  const flags = betaFlags(incoming);
  flags.delete(CLAUDE_OAUTH_BETA);
  if (context1m) flags.add(CLAUDE_CONTEXT_1M_BETA);
  return flags.size ? [...flags].join(',') : undefined;
}

/** The auth mode a Claude `credentialRef` selects, decided from the ref alone (no secret read). */
export function claudeAuthModeForRef(credentialRef: string): ClaudeAuthMode {
  return parseCredentialRef(credentialRef).kind === 'apikey' ? 'api-key' : 'oauth';
}

/**
 * Upstream headers for ONE Claude attempt (anthropic-credits-gateway-2026-09-30 P-006).
 *
 * Auth is decided per ATTEMPT, not per request: a request that hits a usage cap on a subscription
 * account can rotate to a Console API-key account and must present THAT account's credential shape.
 *  - `oauth` (subscription): `authorization: Bearer <token>` and the `oauth-2025-04-20` beta.
 *  - `api-key` (Console credits): `x-api-key: <key>`, NO `authorization`, and the OAuth beta
 *    REMOVED — a Console key carrying the subscription-only beta is rejected — while every other
 *    client beta (context-1m, …) is kept.
 * Any `authorization` / `x-api-key` already in `base` is dropped first, so a caller can never
 * smuggle its own credential upstream (the gateway also strips them at intake; this is the
 * attempt-level backstop). Header names are matched case-insensitively.
 */
export function claudeAttemptHeaders(
  base: Record<string, string>,
  authMode: ClaudeAuthMode,
  token: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  let beta: string | undefined;
  for (const [k, v] of Object.entries(base)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-api-key') continue;
    if (lk === 'anthropic-beta') {
      beta = beta ? `${beta},${v}` : v;
      continue;
    }
    out[k] = v;
  }
  const flags = betaFlags(beta);
  if (authMode === 'api-key') {
    flags.delete(CLAUDE_OAUTH_BETA);
    out['x-api-key'] = token;
  } else {
    flags.add(CLAUDE_OAUTH_BETA);
    out.authorization = `Bearer ${token}`;
  }
  if (flags.size) out['anthropic-beta'] = [...flags].join(',');
  return out;
}
