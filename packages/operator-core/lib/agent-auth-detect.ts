/**
 * Detect whether the user has signed in to the supported coding-agent
 * providers. Used by the Setup Wizard's `logins` step status.
 *
 * Cheap file-existence probes for agent CLIs. GitHub is stricter: the dogfood
 * hive clone depends on a valid `gh` token AND `gh auth setup-git`, so a stale
 * hosts.yml must not count as signed in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
      // Each item block prints its `"acct"<blob>="…"` attribute before its `"svce"<blob>="…"`,
      // so pair the last-seen account with the next service line.
      const items: { service: string; account: string | null }[] = [];
      let account: string | null = null;
      for (const line of r.stdout.split('\n')) {
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

let keychainAccess: KeychainAccess = defaultKeychainAccess;
/** Test seam — inject a fake Keychain (or null to restore the real `security` CLI). */
export function _setClaudeKeychainAccessForTests(access: KeychainAccess | null): void {
  keychainAccess = access ?? defaultKeychainAccess;
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
    try {
      const parsed = JSON.parse(raw.trim()) as ClaudeKeychainOAuthBundle;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { bundle: parsed, service };
    } catch {
      /* not JSON — try the next service label */
    }
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
  const base = CLAUDE_KEYCHAIN_SERVICES[0];
  const all = keychainAccess.list?.() ?? [];
  return all.filter(
    (m) =>
      m.service === base ||
      m.service.startsWith(`${base}-`) ||
      m.service === CLAUDE_KEYCHAIN_SERVICES[1],
  );
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
