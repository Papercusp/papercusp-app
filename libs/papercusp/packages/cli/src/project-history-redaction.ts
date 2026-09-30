import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** A resolved build identity and the stable key used for its replacement. */
export type ProjectHistoryIdentityEntry = readonly [key: string, literal: string];

/**
 * The Project History CLI is bundled into an installed sidecar, so it cannot import the
 * repository's release-only scrubber at runtime. Keep this small mirror beside the CLI and
 * apply it to generated text only; the source ledgers remain unchanged.
 */

const PLACEHOLDER_NAMES = new Set([
  'jane', 'john', 'jdoe', 'jane-doe', 'johndoe', 'alice', 'bob', 'carol', 'dave',
  'someone', 'somebody', 'name', 'owner', 'user', 'example', 'test', 'testuser',
  'placeholder', 'redacted', 'anon', 'anonymous', 'foo', 'bar',
]);

const GENERIC_USERS = new Set([
  'linuxbrew', 'dev', 'runner', 'user', 'ubuntu', 'root', 'node', 'builder', 'vscode',
  'codespace', 'shared', 'Shared', 'ci', 'agent', 'pcusp', 'papercusp', 'papercup',
  'tester', 'User', 'x', 'papercusp-workspace', 'packer', 'test', 'testuser', 'owner',
  'host', 'whoever', 'all', 'paper', 'submission', 'jdoe', 'alice', 'bob', 'buildbot',
  'otheruser', 'someuser', 'builduser', 'buildhost', 'macuser', 'maclogin', 'ownerhandle',
  'path',
]);

const GENERIC_ACCOUNTS = new Set([
  'root', 'runner', 'build', 'ubuntu', 'node', 'vscode', 'codespace', 'ci', 'agent',
  'linuxbrew', 'dev', 'user', 'shared', 'Shared', 'pcusp', 'papercusp', 'papercup',
]);

const IDENTITY_REDACTIONS: Record<string, string> = {
  'build-user-name': 'builduser',
  'build-hostname': 'buildhost',
  'build-git-email': 'owner@example.invalid',
  'build-git-name': 'owner',
};

const IDENTITY_REDACTION_FALLBACK = 'redacted';
const REDACTED_HOME_USER = 'builduser';

const OWNER_FAST_REJECT =
  /\[owner:|owner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\s*\(/i;
const BRACKET_TAG = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;
const PAREN_TAG =
  /(\bowner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\b\s*\(\s*)([A-Za-z][A-Za-z'.-]*)(?:\s*,\s*|\s+(?=\d)|(?=\)))/gi;

const BOX_IDENTITY_FAST_REJECT = /[/-](home|Users)[/-]/;
const HOME_PATH = /\/(home|Users)\/([A-Za-z0-9._-]+)(?=[/'"`\s\\)\]:,;]|$)/g;
const MUNGED_HOME = /(^|["'`/\s])-(home|Users)-([A-Za-z0-9._]+)(?=-)/g;

const isSessionId = (value: string): boolean => /^su-/i.test(value);
const isDateLike = (value: string): boolean => /^\d/.test(value);
const isPlaceholder = (value: string): boolean => PLACEHOLDER_NAMES.has(value.toLowerCase());
const looksLikePersonName = (value: string): boolean =>
  value.length >= 2 && /^[A-Z][A-Za-z'.-]*$/.test(value);
const isRedactedUser = (value: string): boolean =>
  /^[.<{$%]/.test(value) || value === '$USER' || value === 'USER' || value.length <= 2;
const isFileInHome = (value: string): boolean => /\.[A-Za-z0-9]{1,5}$/.test(value);
const stripTrailingDots = (value: string): string => value.replace(/\.+$/, '');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const needsWordBoundary = (value: string): boolean => value.length < 6 && /^[A-Za-z0-9]+$/.test(value);
const literalPattern = (value: string): RegExp => needsWordBoundary(value)
  ? new RegExp(`\\b${escapeRegExp(value)}\\b`)
  : new RegExp(escapeRegExp(value));

function readGitConfig(cwd: string, key: string): string {
  return execFileSync('git', ['-C', cwd, 'config', '--get', key], {
    encoding: 'utf8',
    timeout: 5_000,
  }).toString();
}

/**
 * Resolve the identities that can be present in ledger prose on this machine.
 * Resolution is best-effort: a clean/CI environment may have no personal identity.
 */
export function resolveProjectHistoryIdentityEntries(
  cwd = process.cwd(),
  readConfig: (cwd: string, key: string) => string = readGitConfig,
): ProjectHistoryIdentityEntry[] {
  const entries: ProjectHistoryIdentityEntry[] = [];
  try {
    const account = os.userInfo().username;
    if (account && !GENERIC_ACCOUNTS.has(account)) entries.push(['build-user-name', account]);
  } catch {
    // Best effort; missing OS identity is safe.
  }
  try {
    const hostname = os.hostname();
    if (hostname && !/^((runner|ci-)|localhost)/i.test(hostname)) {
      entries.push(['build-hostname', hostname]);
    }
  } catch {
    // Best effort; missing host identity is safe.
  }
  for (const key of ['user.email', 'user.name'] as const) {
    try {
      const value = readConfig(cwd, key).trim();
      if (value) entries.push([key === 'user.email' ? 'build-git-email' : 'build-git-name', value]);
    } catch {
      // Unconfigured Git identity is safe.
    }
  }
  return entries;
}

let cachedDefaultEntries: ProjectHistoryIdentityEntry[] | undefined;

/**
 * Redact all identity classes that can enter generated Project History prose:
 * named owner tags, home-directory path shapes, and this machine's resolved identity literals.
 * The replacements are intentionally the same neutral vocabulary used by release scrubbing.
 */
export function redactProjectHistoryText(
  text: string,
  entries?: readonly ProjectHistoryIdentityEntry[],
): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  const identities = entries ?? (cachedDefaultEntries ??= resolveProjectHistoryIdentityEntries());
  let output = text;

  if (OWNER_FAST_REJECT.test(output)) {
    output = output.replace(BRACKET_TAG, (match, name: string) =>
      isPlaceholder(name) || isSessionId(name) || isDateLike(name) ? match : '[owner',
    );
    output = output.replace(PAREN_TAG, (match, head: string, name: string) =>
      isPlaceholder(name) || isSessionId(name) || isDateLike(name) || !looksLikePersonName(name)
        ? match
        : head,
    );
  }

  for (const [key, literal] of identities) {
    if (!literal) continue;
    output = output.replace(
      new RegExp(literalPattern(literal).source, 'g'),
      IDENTITY_REDACTIONS[key] ?? IDENTITY_REDACTION_FALLBACK,
    );
  }

  if (BOX_IDENTITY_FAST_REJECT.test(output)) {
    output = output.replace(HOME_PATH, (match, root: string, rawUser: string) => {
      const user = stripTrailingDots(rawUser);
      if (GENERIC_USERS.has(user) || isRedactedUser(user) || isFileInHome(user)) return match;
      return `/${root}/${REDACTED_HOME_USER}${rawUser.slice(user.length)}`;
    });
    output = output.replace(MUNGED_HOME, (match, prefix: string, root: string, user: string) =>
      GENERIC_USERS.has(user) || isRedactedUser(user)
        ? match
        : `${prefix}-${root}-${REDACTED_HOME_USER}`,
    );
  }

  return output;
}
