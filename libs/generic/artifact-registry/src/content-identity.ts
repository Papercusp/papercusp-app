/**
 * Generic content-identity scanning for bytes that are about to become public.
 *
 * This module is deliberately runtime-neutral: it uses no Node or platform APIs,
 * so the same fail-closed detector can run in a Cloudflare Worker and in the
 * operator's publish path. Structured config scrubbers may pass harvested values;
 * free text and scripts are never rewritten, only refused by the caller.
 */

export type ContentIdentityLeakKind =
  | 'identity-value'
  | 'home-path'
  | 'agent-session-id'
  | 'email'
  | 'os-user'
  | 'secret';

export interface ContentIdentityLeakHit {
  kind: ContentIdentityLeakKind;
  /** A bounded excerpt suitable for a refusal response. */
  value: string;
  occurrences: number;
}

export interface ContentIdentityScanOptions {
  knownIdentityValues?: readonly string[];
  osUser?: string | null;
}

const HOME_PATH_RE = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+/g;
const AGENT_SESSION_ID_RE =
  /\bsu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SELF_IDENTIFYING_SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;
const KEY_DIRECTED_SECRET_RE = new RegExp(
  [
    String.raw`(?:(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential)s?|(?:[A-Za-z_][A-Za-z0-9_-]*_)?(?:access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|database[_-]?url))["'\s]*[:=]\s*["']?[^\s"',;&)}\]]{8,}`,
    String.raw`(?:authorization|proxy-authorization)["'\s]*[:=]\s*["']?(?:bearer|basic|token)\s+[^\s"',;&)}\]]{8,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  ].join('|'),
  'gi',
);
const GENERIC_OS_USERS = new Set(['root', 'user', 'users', 'node', 'admin', 'ubuntu', 'runner', 'docker', 'build', 'app', 'test']);
const MIN_HARVESTED_LENGTH = 3;
const IDENTITY_KEYS = new Set([
  'account', 'accountid', 'accounthandle', 'accountname',
  'owner', 'ownerid', 'ownerlabel', 'ownerhandle',
  'user', 'userid', 'username', 'handle', 'login',
  'email', 'emailaddress', 'createdby', 'updatedby', 'authoredby',
  'assignee', 'sessionid', 'suid', 'agentid',
  'workspace', 'workspaceid', 'installslug', 'potslug', 'harnessslug', 'homedir',
]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Shared structured-field predicate used by both scrubbers and Worker verification. */
export const isIdentityFieldName = (key: string): boolean => IDENTITY_KEYS.has(normalizeKey(key));

/**
 * Harvest identity-bearing scalar values from parsed JSON-shaped package data.
 * The Worker feeds these literals back into scanIdentityLeaks so an account
 * handle is caught even when it has no email, home-directory, or session-identifier shape.
 */
export function collectIdentityValues(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (isIdentityFieldName(key) && (typeof entry === 'string' || typeof entry === 'number')) {
        const literal = String(entry);
        if (
          literal.length >= MIN_HARVESTED_LENGTH &&
          !literal.startsWith('<scrubbed:') &&
          !GENERIC_OS_USERS.has(literal.toLowerCase())
        ) {
          found.add(literal);
        }
      }
      visit(entry);
    }
  };
  visit(value);
  return [...found];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

const excerpt = (value: string): string => (value.length <= 80 ? value : `${value.slice(0, 77)}…`);

/** Find identity or secret material in serialized package bytes. */
export function scanIdentityLeaks(
  text: string,
  opts: ContentIdentityScanOptions = {},
): ContentIdentityLeakHit[] {
  const hits: ContentIdentityLeakHit[] = [];
  const seen = new Set<string>();
  const add = (kind: ContentIdentityLeakKind, value: string, occurrences: number): void => {
    if (occurrences <= 0) return;
    const key = JSON.stringify([kind, value]);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, value: excerpt(value), occurrences });
  };

  for (const value of opts.knownIdentityValues ?? []) {
    if (typeof value === 'string' && value.length >= MIN_HARVESTED_LENGTH) {
      add('identity-value', value, countOccurrences(text, value));
    }
  }

  for (const [re, kind] of [
    [HOME_PATH_RE, 'home-path'],
    [AGENT_SESSION_ID_RE, 'agent-session-id'],
    [EMAIL_RE, 'email'],
  ] as const) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) add(kind, match[0], countOccurrences(text, match[0]));
  }

  const osUser = opts.osUser;
  if (osUser && osUser.length >= 4 && !GENERIC_OS_USERS.has(osUser.toLowerCase())) {
    add('os-user', osUser, countOccurrences(text, osUser));
  }

  SELF_IDENTIFYING_SECRET_RE.lastIndex = 0;
  for (const match of text.matchAll(SELF_IDENTIFYING_SECRET_RE)) {
    add('secret', match[0], countOccurrences(text, match[0]));
  }
  KEY_DIRECTED_SECRET_RE.lastIndex = 0;
  for (const match of text.matchAll(KEY_DIRECTED_SECRET_RE)) {
    add('secret', '[secret-shaped value detected by sensitive-text]', 1);
  }
  return hits;
}
