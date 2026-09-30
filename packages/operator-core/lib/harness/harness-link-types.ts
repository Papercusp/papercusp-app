/**
 * harness-link-types — parse + format for the
 * `papercusp://harness?topic=...&github=...&repo_id=...` URL scheme
 * used by Phase 5a P-029 (wizard generator) + Phase 1b P-009 (Entry
 * 4 parser) per papercusp-dogfood-v5 lines 337 + 1205.
 *
 * Types-only and PURE. No I/O, no clipboard access, no host calls.
 * Both the wizard's "copy this link" path and Entry 4's "paste a
 * link" path import these to keep the wire format aligned.
 *
 * Eleventh module in the dogfood-arc types-only spine.
 *
 * URL format (v5 line 337 verbatim):
 *   papercusp://harness?topic=<hex>&github=<owner>/<repo>&repo_id=<github_repository_id>
 *
 *   topic    — Hyperswarm topic bytes, hex-encoded (32 bytes → 64 hex chars)
 *   github   — `<owner>/<repo>` slug; matches the `gh` CLI form
 *   repo_id  — GitHub's stable numeric repository_id (NOT login,
 *              since owner/repo rename freely; the id is immutable)
 */

/**
 * Wire-version. Bump if the URL shape changes; parsers reject
 * unknown versions so an out-of-date client can surface a clear
 * "you need to update" error rather than fail mysteriously.
 *
 * v1 has no `?v=1` query param (omission == v1 for backward compat);
 * a future v2 would add `?v=2` and parsers would dispatch.
 */
export const HARNESS_LINK_VERSION = 1 as const;
export type HarnessLinkVersion = typeof HARNESS_LINK_VERSION;

/**
 * Scheme + host. Single source of truth used by both format + parse
 * paths.
 */
export const HARNESS_LINK_SCHEME = 'papercusp:' as const;
export const HARNESS_LINK_HOST = 'harness' as const;
export const HARNESS_LINK_PREFIX = HARNESS_LINK_SCHEME + '//' + HARNESS_LINK_HOST;

/**
 * The parsed payload. Mirrors the URL params 1:1 with normalized
 * types (numeric repo_id, lowercased hex topic).
 */
export interface HarnessLinkPayload {
  /** Hyperswarm topic as 64-char lowercase hex string (32 bytes). */
  topic: string;
  /** GitHub owner/repo slug — case preserved as-shared. */
  github_owner: string;
  github_repo: string;
  /** GitHub numeric repository_id; immutable across rename. */
  github_repository_id: number;
}

/**
 * Discriminated parse result. `ok:false` carries a structured reason
 * for the UI to render diagnostic copy ("link is malformed" vs
 * "link is for a different host" vs "link is for an unknown version").
 */
export type HarnessLinkParseResult =
  | { ok: true; payload: HarnessLinkPayload }
  | { ok: false; error: HarnessLinkParseError };

export type HarnessLinkParseError =
  | { kind: 'not_a_url' }
  | { kind: 'wrong_scheme'; got: string }
  | { kind: 'wrong_host'; got: string }
  | { kind: 'missing_topic' }
  | { kind: 'invalid_topic'; got: string }
  | { kind: 'missing_github' }
  | { kind: 'invalid_github_slug'; got: string }
  | { kind: 'missing_repo_id' }
  | { kind: 'invalid_repo_id'; got: string }
  | { kind: 'unsupported_version'; got: string };

/**
 * Hyperswarm topic length: 32 bytes → 64 hex chars. Strict.
 */
export const TOPIC_HEX_LENGTH = 64;
const HEX_LOWER_RE = /^[0-9a-f]+$/;
export function isValidTopicHex(topic: string): boolean {
  if (typeof topic !== 'string') return false;
  if (topic.length !== TOPIC_HEX_LENGTH) return false;
  return HEX_LOWER_RE.test(topic);
}

/**
 * GitHub `owner/repo` slug shape: owner is alphanumeric+dashes
 * (login rules); repo is alphanumeric + `_` + `.` + `-`. Both have
 * length caps GitHub enforces; we re-enforce here so a bad slug
 * fails parse rather than fails at clone-time with a confusing
 * upstream error.
 */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
export function parseGithubSlug(
  slug: string,
): { owner: string; repo: string } | null {
  if (typeof slug !== 'string') return null;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return null;
  // Multiple slashes are invalid (paths beyond the second segment
  // are not legal owner/repo slugs).
  if (slug.indexOf('/', idx + 1) !== -1) return null;
  const owner = slug.slice(0, idx);
  const repo = slug.slice(idx + 1);
  if (!GITHUB_OWNER_RE.test(owner)) return null;
  if (!GITHUB_REPO_RE.test(repo)) return null;
  // Repo cannot be `.` or `..` (filesystem-safety + GitHub rules).
  if (repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/**
 * Build a `papercusp://harness?...` link from a payload. Inverse of
 * `parseHarnessLink`. Uses URL constructor for proper escaping.
 */
export function formatHarnessLink(payload: HarnessLinkPayload): string {
  if (!isValidTopicHex(payload.topic)) {
    throw new TypeError('topic must be 64-char lowercase hex');
  }
  if (
    !payload.github_owner ||
    !payload.github_repo ||
    !GITHUB_OWNER_RE.test(payload.github_owner) ||
    !GITHUB_REPO_RE.test(payload.github_repo) ||
    payload.github_repo === '.' ||
    payload.github_repo === '..'
  ) {
    throw new TypeError('github_owner/repo must match GitHub slug rules');
  }
  if (
    !Number.isInteger(payload.github_repository_id) ||
    payload.github_repository_id <= 0
  ) {
    throw new TypeError('github_repository_id must be a positive integer');
  }
  const githubSlug = payload.github_owner + '/' + payload.github_repo;
  const params = new URLSearchParams({
    topic: payload.topic,
    github: githubSlug,
    repo_id: String(payload.github_repository_id),
  });
  return HARNESS_LINK_PREFIX + '?' + params.toString();
}

/**
 * Parse a `papercusp://harness?...` link. Returns a discriminated
 * result so callers handle malformed input explicitly.
 */
export function parseHarnessLink(input: string): HarnessLinkParseResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: { kind: 'not_a_url' } };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: { kind: 'not_a_url' } };
  }
  if (url.protocol !== HARNESS_LINK_SCHEME) {
    return { ok: false, error: { kind: 'wrong_scheme', got: url.protocol } };
  }
  // URL parses `papercusp://harness?...` such that host="harness".
  if (url.host !== HARNESS_LINK_HOST) {
    return { ok: false, error: { kind: 'wrong_host', got: url.host } };
  }
  // Version dispatch — v1 has no `v` param.
  const v = url.searchParams.get('v');
  if (v !== null && v !== String(HARNESS_LINK_VERSION)) {
    return { ok: false, error: { kind: 'unsupported_version', got: v } };
  }

  const topic = url.searchParams.get('topic');
  if (topic === null) {
    return { ok: false, error: { kind: 'missing_topic' } };
  }
  if (!isValidTopicHex(topic)) {
    return { ok: false, error: { kind: 'invalid_topic', got: topic } };
  }

  const githubSlug = url.searchParams.get('github');
  if (githubSlug === null) {
    return { ok: false, error: { kind: 'missing_github' } };
  }
  const parsedSlug = parseGithubSlug(githubSlug);
  if (parsedSlug === null) {
    return { ok: false, error: { kind: 'invalid_github_slug', got: githubSlug } };
  }

  const repoIdStr = url.searchParams.get('repo_id');
  if (repoIdStr === null) {
    return { ok: false, error: { kind: 'missing_repo_id' } };
  }
  const repoId = Number(repoIdStr);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return { ok: false, error: { kind: 'invalid_repo_id', got: repoIdStr } };
  }

  return {
    ok: true,
    payload: {
      topic,
      github_owner: parsedSlug.owner,
      github_repo: parsedSlug.repo,
      github_repository_id: repoId,
    },
  };
}

/**
 * Convenience: surface a one-line human-readable error from a parse
 * error. UI consumers can override per error.kind for richer copy.
 */
export function formatParseError(error: HarnessLinkParseError): string {
  switch (error.kind) {
    case 'not_a_url':
      return "That doesn't look like a harness link.";
    case 'wrong_scheme':
      return 'Not a Papercusp link (scheme: ' + error.got + ').';
    case 'wrong_host':
      return 'Not a harness link (host: ' + error.got + ').';
    case 'missing_topic':
      return 'Link is missing the Hyperswarm topic.';
    case 'invalid_topic':
      return 'Link has a malformed topic (expected 64-char hex).';
    case 'missing_github':
      return 'Link is missing the GitHub owner/repo.';
    case 'invalid_github_slug':
      return "Link's GitHub slug isn't a valid owner/repo (got: " + error.got + ').';
    case 'missing_repo_id':
      return 'Link is missing the GitHub repository id.';
    case 'invalid_repo_id':
      return 'Link has a malformed repository id (got: ' + error.got + ').';
    case 'unsupported_version':
      return 'Link uses a newer format (v' + error.got + ') — update Papercusp to open it.';
  }
}
