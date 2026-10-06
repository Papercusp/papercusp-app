/**
 * Detect whether the user has signed in to the supported coding-agent
 * providers. Used by the Setup Wizard's `logins` step status.
 *
 * Cheap file-existence probes for agent CLIs. GitHub is stricter: the dogfood
 * hive clone depends on a valid `gh` token AND `gh auth setup-git`, so a stale
 * hosts.yml must not count as signed in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Run `security` without blocking the event loop. Wrapped at CALL time (not a module-level
 *  `promisify(execFile)`), so a test that mocks node:child_process without `execFile` still
 *  imports this module; the missing function then surfaces inside the callers' try/catch. */
function runSecurity(
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      args,
      { encoding: 'utf8', timeout: opts.timeout ?? 5000, ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

/** Parse `security dump-keychain` output (metadata only) into service + account pairs. Each item
 *  block prints its `"acct"<blob>="…"` attribute before its `"svce"<blob>="…"`, so pair the
 *  last-seen account with the next service line. Pure; shared by the sync and async listers. */
export function parseDumpKeychainItems(stdout: string): { service: string; account: string | null }[] {
  const items: { service: string; account: string | null }[] = [];
  let account: string | null = null;
  for (const line of stdout.split('\n')) {
    const a = /"acct"<blob>="([^"]*)"/.exec(line);
    if (a) {
      account = a[1];
      continue;
    }
    const s = /"svce"<blob>="([^"]*)"/.exec(line);
    if (s) {
      items.push({ service: s[1], account });
      account = null;
    }
  }
  return items;
}

function anyExists(paths: readonly string[]): boolean {
  return paths.some((p) => existsSync(p));
}

/**
 * On macOS, Claude Code stores its OAuth credential in the login KEYCHAIN — NOT in
 * ~/.claude/.credentials.json. A pure file probe therefore reports a genuinely
 * signed-in Mac user as "logged out", which is what drove the packaged-app agent to
 * spelunk the Keychain and agonize over a perfectly normal desktop state (P-004,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05).
 *
 * We probe the Keychain for the EXISTENCE of Claude Code's generic-password item
 * (`-s <service>` WITHOUT `-w`, so we read metadata only — no secret fetch, hence no
 * Keychain-unlock GUI prompt). The probe fails SAFE: any error — a wrong service label,
 * a locked keychain, or the `security` binary being absent off-macOS — returns false and
 * falls through to the existing file check, so this NEVER regresses current behavior.
 *
 * ⚠ Mac-VM verify: the `-s` service labels below are Claude Code's current ones; if a
 * future Claude Code release renames the item, add the new label here.
 */
/** Exported as the ONE source of the service labels — the inference-gateway's `keychain:`
 *  credential resolver (credential-store.ts) reads the same item for its secret payload. */
export const CLAUDE_KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'] as const;

export function claudeKeychainSignedIn(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return false;
  for (const service of CLAUDE_KEYCHAIN_SERVICES) {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', service], { timeout: 5000 });
      if (r.status === 0) return true; // the item exists → signed in
    } catch {
      /* security absent / errored → fall through to the next label / file probe */
    }
  }
  return false;
}

// ── macOS Keychain OAuth bundle read + write-back (REQ B: Mac cred reuse across consoles) ──────
// Claude Code on macOS stores its OAuth in the login KEYCHAIN as a generic-password whose secret
// is the SAME JSON as ~/.claude/.credentials.json ({ claudeAiOauth: { accessToken, refreshToken,
// expiresAt, … } }). The per-session CLAUDE_CONFIG_DIR fork model (interactive-claude-config.ts)
// and claude-credential-sync are FILE-based, so on a Mac (no `.credentials.json` on disk) a psu
// session inherits NO login and forces /login — the every-console-relogin bug the owner reported.
// The reconcile bridge (claude-credential-sync.ts, darwin branch) READS this item to materialize
// the file family, and WRITES it back so a session-fork refresh keeps the owner's direct `claude`
// (which reads the Keychain) fresh — one logical credential across Keychain + file + forks.

/** The macOS Keychain OAuth secret payload — same JSON shape as `~/.claude/.credentials.json`. */
export interface ClaudeKeychainOAuthBundle {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Injectable `security` shim (there is no Keychain off macOS): read a service's secret (`-w`),
 *  or write it back (`-U`). Return the raw secret string / write success. Defaults to the real
 *  `security` CLI; the reconcile tests inject a fake so no real Keychain is touched. */
export interface KeychainAccess {
  read(service: string): string | null;
  write(service: string, account: string, secret: string): boolean;
  /** Enumerate generic-password items (service + account) — METADATA only (`dump-keychain`
   *  without `-d`), so no secret is read and no unlock/ACL prompt is raised. Optional so
   *  existing test fakes keep compiling; callers treat absent/erroring as an empty list. */
  list?(): { service: string; account: string | null }[];
}

const defaultKeychainAccess: KeychainAccess = {
  read(service) {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout;
    } catch {
      /* security absent / ACL-blocked (errSecInteractionNotAllowed, exit 36 in a non-GUI SSH
         session) / errored → treated as not-found */
    }
    return null;
  },
  list() {
    try {
      const r = spawnSync('security', ['dump-keychain'], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (r.status !== 0 || typeof r.stdout !== 'string') return [];
      return parseDumpKeychainItems(r.stdout);
    } catch {
      return [];
    }
  },
  write(service, account, secret) {
    try {
      // `-U` updates the item in place if it exists (same service+account), else creates it.
      const r = spawnSync(
        'security',
        ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret],
        { encoding: 'utf8', timeout: 5000 },
      );
      return r.status === 0;
    } catch {
      return false;
    }
  },
};

/**
 * Non-blocking `security` shim for callers on an event loop (WI-10005231). The credential
 * reconcile runs on the operator main thread at boot, on every watch kick and every 5 min; a
 * `spawnSync('security', …)` there blocks the whole host for the length of the Keychain call. A
 * sync {@link KeychainAccess} fake is assignable here, because `await` accepts plain values.
 */
export interface KeychainAccessAsync {
  read(service: string): Promise<string | null> | string | null;
  write(service: string, account: string, secret: string): Promise<boolean> | boolean;
  /** Non-blocking {@link KeychainAccess.list} (WI-10005306): `dump-keychain` metadata only.
   *  Optional so existing fakes keep compiling; absent/erroring → an empty list. */
  list?(): Promise<{ service: string; account: string | null }[]> | { service: string; account: string | null }[];
}

const defaultKeychainAccessAsync: KeychainAccessAsync = {
  async read(service) {
    try {
      const stdout = await runSecurity(['find-generic-password', '-s', service, '-w']);
      if (stdout.trim()) return stdout;
    } catch {
      /* security absent / ACL-blocked / non-zero exit / timeout → treated as not-found */
    }
    return null;
  },
  async list() {
    try {
      return parseDumpKeychainItems(
        await runSecurity(['dump-keychain'], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }),
      );
    } catch {
      return [];
    }
  },
  async write(service, account, secret) {
    try {
      // `-U` updates the item in place if it exists (same service+account), else creates it.
      await runSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret]);
      return true;
    } catch {
      return false;
    }
  },
};

let keychainAccess: KeychainAccess = defaultKeychainAccess;
let keychainAccessAsync: KeychainAccessAsync = defaultKeychainAccessAsync;
/** Test seam — inject a fake Keychain (or null to restore the real `security` CLI). It backs both
 *  the sync and the async helpers. */
export function _setClaudeKeychainAccessForTests(access: KeychainAccess | null): void {
  keychainAccess = access ?? defaultKeychainAccess;
  keychainAccessAsync = access ?? defaultKeychainAccessAsync;
}
/** Test seam for the async helpers only — e.g. a fake whose reads settle on a later tick. */
export function _setClaudeKeychainAsyncAccessForTests(access: KeychainAccessAsync | null): void {
  keychainAccessAsync = access ?? defaultKeychainAccessAsync;
}

function parseKeychainOAuthSecret(raw: string): ClaudeKeychainOAuthBundle | null {
  try {
    const parsed = JSON.parse(raw.trim()) as ClaudeKeychainOAuthBundle;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Read + parse Claude Code's macOS login-Keychain OAuth bundle. Returns null on ANY miss — off
 * macOS, `security` absent, ACL-blocked, item absent, or non-JSON secret. NEVER throws: the
 * credential reconcile calls this inline in session launch and must not fail a launch.
 *
 * ⚠ Reads the SECRET (`-w`), unlike `claudeKeychainSignedIn`'s metadata-only probe — so the FIRST
 * read on a Mac may raise a one-time "allow access" GUI prompt (click "Always Allow"). A non-GUI
 * SSH session cannot answer it and gets null (fail-soft); the packaged app runs in the GUI session
 * where the prompt is answerable, and one grant covers every later read by that process.
 */
export function readClaudeKeychainOAuthBundle(
  platform: NodeJS.Platform = process.platform,
): { bundle: ClaudeKeychainOAuthBundle; service: string } | null {
  if (platform !== 'darwin') return null;
  for (const service of CLAUDE_KEYCHAIN_SERVICES) {
    const raw = keychainAccess.read(service);
    if (!raw) continue;
    const bundle = parseKeychainOAuthSecret(raw);
    if (bundle) return { bundle, service };
  }
  return null;
}

/** Non-blocking {@link readClaudeKeychainOAuthBundle} for event-loop callers (the credential
 *  reconcile). Same contract: null on any miss, never throws. */
export async function readClaudeKeychainOAuthBundleAsync(
  platform: NodeJS.Platform = process.platform,
): Promise<{ bundle: ClaudeKeychainOAuthBundle; service: string } | null> {
  if (platform !== 'darwin') return null;
  for (const service of CLAUDE_KEYCHAIN_SERVICES) {
    let raw: string | null = null;
    try {
      raw = await keychainAccessAsync.read(service);
    } catch {
      /* a throwing shim is a miss, never a failed launch */
    }
    if (typeof raw !== 'string' || !raw) continue;
    const bundle = parseKeychainOAuthSecret(raw);
    if (bundle) return { bundle, service };
  }
  return null;
}

/**
 * Every Claude Code credential Keychain item on this Mac: the base `Claude Code-credentials`
 * item PLUS the per-`CLAUDE_CONFIG_DIR` siblings (`Claude Code-credentials-<sha256(configDir)
 * first-8-hex>`) — Claude Code keeps ONE rotating OAuth bundle PER config dir, refreshed by
 * whichever CLI session runs in it, so on a fleet box the base item is typically a STALE
 * snapshot while a hashed sibling holds the live token family member (the 2026-07-06
 * fleet-member-login root cause). Metadata only — enumerating raises no unlock/ACL prompt.
 * Empty off macOS (`security` absent → the shim returns []) or on any `security` error — no
 * platform gate here, so tests can fake the shim without faking process.platform.
 */
export function listClaudeKeychainCredentialItems(): { service: string; account: string | null }[] {
  return filterClaudeKeychainItems(keychainAccess.list?.() ?? []);
}

function filterClaudeKeychainItems(
  all: readonly { service: string; account: string | null }[],
): { service: string; account: string | null }[] {
  const base = CLAUDE_KEYCHAIN_SERVICES[0];
  return all.filter(
    (m) =>
      m.service === base ||
      m.service.startsWith(`${base}-`) ||
      m.service === CLAUDE_KEYCHAIN_SERVICES[1],
  );
}

/** Non-blocking {@link listClaudeKeychainCredentialItems} for event-loop callers — the inference
 *  gateway's freshest-scan (WI-10005306). Same contract: empty on any miss, never throws. */
export async function listClaudeKeychainCredentialItemsAsync(): Promise<
  { service: string; account: string | null }[]
> {
  try {
    const all = await keychainAccessAsync.list?.();
    return filterClaudeKeychainItems(Array.isArray(all) ? all : []);
  } catch {
    return [];
  }
}

/** Non-blocking read of one Keychain item's raw secret (`-w`), or null on ANY miss — `security`
 *  absent, ACL-blocked, item absent, timeout. Never throws. No platform gate (like the lister), so
 *  tests can fake the shim without faking process.platform; off macOS `security` is absent. */
export async function readKeychainSecretAsync(service: string): Promise<string | null> {
  try {
    const raw = await keychainAccessAsync.read(service);
    return typeof raw === 'string' && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort write-back of a (refreshed) OAuth bundle into Claude Code's Keychain item so the
 * owner's direct `claude` stays on the newest token family member. Returns true on a confirmed
 * write. NEVER throws. Fails soft (returns false) when off macOS, `security` is absent, or the
 * item's ACL blocks a non-creating writer — in which case the owner's direct `claude` simply
 * re-logs-in once when its access token next expires (a graceful degradation, not a break).
 *
 * `account` is the Keychain item's account (Claude Code uses the login user, `$USER`).
 */
export function writeClaudeKeychainOAuthBundle(
  service: string,
  account: string,
  bundleJson: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false;
  return keychainAccess.write(service, account, bundleJson);
}

/** Non-blocking {@link writeClaudeKeychainOAuthBundle} for event-loop callers. Never throws. */
export async function writeClaudeKeychainOAuthBundleAsync(
  service: string,
  account: string,
  bundleJson: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'darwin') return false;
  try {
    return (await keychainAccessAsync.write(service, account, bundleJson)) === true;
  } catch {
    return false;
  }
}

export function claudeSignedIn(): boolean {
  if (claudeKeychainSignedIn()) return true;
  const home = homedir();
  return anyExists([
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude', 'credentials.json'),
    join(home, '.config', 'claude', 'credentials.json'),
  ]);
}

export function ompSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.omp', 'agent', 'auth.json'),
    join(home, '.pi_back', 'agent', 'auth.json'),
  ]);
}

/**
 * A value-type-only view of an in-memory credential object for diagnostics.
 *
 * This deliberately has no field-name allowlist: names such as `refresh` are
 * not evidence that a value is safe to print. String values are represented by
 * their type and length only; finite numbers are the sole values retained
 * because credential expiry metadata is numeric. Arrays are summarized by
 * length, and nested objects are shaped recursively. Accessors and cycles are
 * represented without invoking or traversing them.
 */
export type SafeCredentialMetadata =
  | { type: 'string'; length: number }
  | { type: 'number'; value?: number }
  | { type: 'boolean' }
  | { type: 'undefined' }
  | { type: 'bigint' }
  | { type: 'symbol' }
  | { type: 'function' }
  | { type: 'null' }
  | { type: 'array'; length: number; truncated?: boolean }
  | { type: 'object'; fields: SafeCredentialShape; truncated?: boolean }
  | { type: 'accessor' }
  | { type: 'circular' };

export interface SafeCredentialShape {
  [field: string]: SafeCredentialMetadata;
}

const MAX_SAFE_CREDENTIAL_SHAPE_DEPTH = 8;

function safeCredentialValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): SafeCredentialMetadata {
  if (value === null) return { type: 'null' };
  switch (typeof value) {
    case 'string':
      return { type: 'string', length: value.length };
    case 'number':
      return Number.isFinite(value) ? { type: 'number', value } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'undefined':
      return { type: 'undefined' };
    case 'bigint':
      return { type: 'bigint' };
    case 'symbol':
      return { type: 'symbol' };
    case 'function':
      return { type: 'function' };
    case 'object':
      if (Array.isArray(value)) {
        try {
          return {
            type: 'array',
            length: value.length,
            ...(depth >= MAX_SAFE_CREDENTIAL_SHAPE_DEPTH ? { truncated: true } : {}),
          };
        } catch {
          return { type: 'array', length: 0, truncated: true };
        }
      }
      if (seen.has(value)) return { type: 'circular' };
      if (depth >= MAX_SAFE_CREDENTIAL_SHAPE_DEPTH) {
        return { type: 'object', fields: {}, truncated: true };
      }
      seen.add(value);
      const fields = safeCredentialObject(value, seen, depth + 1);
      seen.delete(value);
      return { type: 'object', fields };
    default:
      return { type: 'undefined' };
  }
}

function safeCredentialObject(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): SafeCredentialShape {
  const shape: SafeCredentialShape = {};
  let fields: string[];
  try {
    fields = Object.keys(value);
  } catch {
    return shape;
  }
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      shape[field] = { type: 'accessor' };
      continue;
    }
    // Reading an accessor could execute arbitrary code or expose a secret.
    if (!descriptor || !('value' in descriptor)) {
      shape[field] = { type: 'accessor' };
      continue;
    }
    shape[field] = safeCredentialValue(descriptor.value, seen, depth);
  }
  return shape;
}

export function safeCredentialShape(value: unknown): SafeCredentialShape {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const seen = new WeakSet<object>();
  seen.add(value);
  const shape = safeCredentialObject(value, seen, 0);
  seen.delete(value);
  return shape;
}

/**
 * OMP (pi) auth DETAIL — beyond mere file existence. A present `auth.json` with
 * an EXPIRED OAuth access token reads as "signed in" to `ompSignedIn()` but pi
 * may fail real Anthropic calls with "No API key found" (observed: a stale token
 * silently degrades an interactive psu→omp session to local ollama). So a
 * diagnostics surface needs the expiry, not just presence, to prompt a re-login.
 *
 * `accessExpired` is a HINT, not a hard "signed out": pi MAY refresh an expired
 * access token from `token.refresh`. Surface it as "re-login if Anthropic calls
 * fail", and keep `ompSignedIn()` a cheap presence probe (unchanged semantics).
 */
export interface OmpAuthStatus {
  /** `auth.json` exists. */
  present: boolean;
  /** First configured provider key (e.g. `anthropic`), or null. */
  provider: string | null;
  /** The provider's auth type (e.g. `oauth`), or null. */
  authType: string | null;
  /** OAuth access-token expiry (epoch ms), or null when not an expiring token. */
  expiresAt: number | null;
  /** `expiresAt` is in the past — pi may still refresh from `hasRefresh`. */
  accessExpired: boolean;
  /** A refresh token is present (pi can attempt a silent refresh). */
  hasRefresh: boolean;
}

export function ompAuthStatus(home: string = homedir(), now: number = Date.now()): OmpAuthStatus {
  const empty: OmpAuthStatus = {
    present: false, provider: null, authType: null, expiresAt: null, accessExpired: false, hasRefresh: false,
  };
  const path = [
    join(home, '.omp', 'agent', 'auth.json'),
    join(home, '.pi_back', 'agent', 'auth.json'),
  ].find((p) => existsSync(p));
  if (!path) return empty;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const provider = Object.keys(data)[0] ?? null;
    const entry = (provider ? data[provider] : null) as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return { ...empty, present: true };
    const authType = typeof entry.type === 'string' ? entry.type : null;
    const tok = (entry.token && typeof entry.token === 'object' ? entry.token : null) as Record<string, unknown> | null;
    const tokenShape = tok ? safeCredentialShape(tok) : {};
    const expiresAt =
      tokenShape.expires?.type === 'number' && 'value' in tokenShape.expires
        ? tokenShape.expires.value ?? null
        : null;
    const hasRefresh = tokenShape.refresh?.type === 'string' && tokenShape.refresh.length > 0;
    return {
      present: true,
      provider,
      authType,
      expiresAt,
      accessExpired: expiresAt != null && expiresAt < now,
      hasRefresh,
    };
  } catch {
    return { ...empty, present: true };
  }
}

export function codexSignedIn(): boolean {
  const home = homedir();
  return anyExists([
    join(home, '.codex', 'auth.json'),
  ]);
}

/**
 * Whether a backend's login can still authenticate a NEW spawn, judged without a model
 * call (WI-10004897).
 *
 * A hosted workspace host receives copies of the claude/codex logins whose refresh tokens
 * are deliberately blanked (D-311: no rotating refresh secret crosses to a host; see
 * WORKSPACE_HOST_*_NEUTRALIZED_REFRESH_TOKEN in the deployment driver). Such a copy works
 * until its access token expires and then fails every call with a 401. The papercup chat's
 * failover used to move a capped turn onto exactly such a dead copy, so the turn failed
 * twice and reported only the second (useless) error.
 *
 * The verdict is UNUSABLE only on positive evidence: no credential at all, an unparseable
 * file, or an access token past its recorded expiry with no refresh token and no API key.
 * Anything that cannot be judged from local state (a gateway route, an env key, the macOS
 * keychain, a token with no recorded expiry) is reported usable, which keeps the previous
 * behavior (try it) rather than inventing a refusal.
 *
 * Only booleans and expiry numbers are derived; no credential value is returned or logged.
 */
export type AgentCredentialBasis =
  | 'gateway'
  | 'env-key'
  | 'keychain'
  | 'api-key'
  | 'refreshable'
  | 'live-access'
  | 'no-expiry';
export type AgentCredentialUnusableReason = 'absent' | 'expired-no-refresh' | 'unreadable';
export type AgentCredentialVerdict =
  | { usable: true; basis: AgentCredentialBasis }
  | { usable: false; reason: AgentCredentialUnusableReason };

export interface AgentCredentialProbeInput {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: number;
  platform?: NodeJS.Platform;
}

/** Tokens this close to expiry are treated as expired (mirrors chat-stream's TOKEN_EXPIRY_SKEW_MS). */
const CREDENTIAL_EXPIRY_SKEW_MS = 60_000;

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

function readJsonObject(path: string): Record<string, unknown> | 'absent' | 'unreadable' {
  if (!existsSync(path)) return 'absent';
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function accessVerdict(input: {
  hasAccess: boolean;
  hasRefresh: boolean;
  expiresAtMs: number | null;
  now: number;
}): AgentCredentialVerdict {
  if (!input.hasAccess) return { usable: false, reason: 'absent' };
  if (input.hasRefresh) return { usable: true, basis: 'refreshable' };
  if (input.expiresAtMs === null) return { usable: true, basis: 'no-expiry' };
  return input.expiresAtMs > input.now + CREDENTIAL_EXPIRY_SKEW_MS
    ? { usable: true, basis: 'live-access' }
    : { usable: false, reason: 'expired-no-refresh' };
}

/** The `claude` CLI login the papercup brain spawn uses (`~/.claude/.credentials.json`, symlinked per spawn). */
export function claudeCredentialVerdict(input: AgentCredentialProbeInput = {}): AgentCredentialVerdict {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  // A loopback ANTHROPIC_BASE_URL is the inference gateway, which re-auths to its own pool.
  if (isLoopbackUrl(env.ANTHROPIC_BASE_URL)) return { usable: true, basis: 'gateway' };
  if (nonEmptyString(env.ANTHROPIC_API_KEY) || nonEmptyString(env.ANTHROPIC_AUTH_TOKEN)) {
    return { usable: true, basis: 'env-key' };
  }
  if (claudeKeychainSignedIn(input.platform ?? process.platform)) return { usable: true, basis: 'keychain' };
  const file = readJsonObject(join(input.home ?? homedir(), '.claude', '.credentials.json'));
  if (file === 'absent') return { usable: false, reason: 'absent' };
  if (file === 'unreadable') return { usable: false, reason: 'unreadable' };
  const oauth = (file.claudeAiOauth && typeof file.claudeAiOauth === 'object' ? file.claudeAiOauth : {}) as Record<
    string,
    unknown
  >;
  return accessVerdict({
    hasAccess: nonEmptyString(oauth.accessToken),
    hasRefresh: nonEmptyString(oauth.refreshToken),
    expiresAtMs: typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    now,
  });
}

/** The `exp` claim (seconds) of a JWT, as epoch ms; null when the token is not a decodable JWT. */
function jwtExpiryMs(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = claims && typeof claims === 'object' ? (claims as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The `codex` CLI login the papercup brain spawn uses (`~/.codex/auth.json`, symlinked into CODEX_HOME). */
export function codexCredentialVerdict(input: AgentCredentialProbeInput = {}): AgentCredentialVerdict {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  // Mirrors chat-stream's codex spawn: either flag routes codex through the gateway's provider block.
  if (env.PAPERCUSP_CODEX_GATEWAY === '1' || nonEmptyString(env.PAPERCUSP_ACCOUNT_ID)) {
    return { usable: true, basis: 'gateway' };
  }
  if (nonEmptyString(env.CODEX_API_KEY) || nonEmptyString(env.OPENAI_API_KEY)) return { usable: true, basis: 'env-key' };
  const file = readJsonObject(join(input.home ?? homedir(), '.codex', 'auth.json'));
  if (file === 'absent') return { usable: false, reason: 'absent' };
  if (file === 'unreadable') return { usable: false, reason: 'unreadable' };
  if (nonEmptyString(file.OPENAI_API_KEY)) return { usable: true, basis: 'api-key' };
  const tokens = (file.tokens && typeof file.tokens === 'object' ? file.tokens : {}) as Record<string, unknown>;
  return accessVerdict({
    hasAccess: nonEmptyString(tokens.access_token),
    hasRefresh: nonEmptyString(tokens.refresh_token),
    expiresAtMs: jwtExpiryMs(tokens.access_token),
    now,
  });
}

/**
 * The verdict for a backend whose login lives in a local credential file; null when not judged here.
 *
 * ⚠ It judges the CALLING process's own home (or `input.home`). A caller whose agent CLI
 * spawns as a DIFFERENT identity (the D-421 hosted customer-identity spawn transform) is
 * asking about a home this process cannot read, and must not use this verdict for it.
 */
export function agentBackendCredentialVerdict(
  backend: string,
  input: AgentCredentialProbeInput = {},
): AgentCredentialVerdict | null {
  if (backend === 'claude-code') return claudeCredentialVerdict(input);
  if (backend === 'codex') return codexCredentialVerdict(input);
  return null;
}

/**
 * GitHub CLI auth status for the dogfood clone path. A hosts.yml alone is not
 * enough: revoked tokens remain on disk, and without `gh auth setup-git` git
 * cannot authenticate private HTTPS submodules with GIT_TERMINAL_PROMPT=0.
 */
export function githubSignedIn(): boolean {
  const home = homedir();
  if (!anyExists([
    join(home, '.config', 'gh', 'hosts.yml'),
    // Windows: gh stores config under %AppData%\GitHub CLI\hosts.yml.
    `${process.env.APPDATA ?? ''}/GitHub CLI/hosts.yml`,
  ])) return false;

  const gh = resolveGhBinary();
  if (!gh) return true; // legacy fallback for hosts where gh is not probeable.
  const auth = spawnSync(gh, ['auth', 'status', '--hostname', 'github.com'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (auth.status !== 0) return false;

  const helper = spawnSync('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return helper.status === 0 && /gh\s+auth\s+git-credential/.test(helper.stdout);
}

export function anyAgentSignedIn(): boolean {
  return claudeSignedIn() || codexSignedIn() || ompSignedIn();
}

function resolveGhBinary(): string | null {
  const candidates = [
    process.argv[1] ? join(dirname(process.argv[1]), 'bin', 'gh') : '',
    join(dirname(process.execPath), 'gh'),
    join(process.cwd(), 'bin', 'gh'),
    join(process.cwd(), '..', 'bin', 'gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ];
  for (const p of candidates) if (p && existsSync(p)) return p;
  const which = spawnSync('which', ['gh'], { encoding: 'utf8', timeout: 3000 });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}
