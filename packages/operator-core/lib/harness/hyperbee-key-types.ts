/**
 * hyperbee-key-types — single source of truth for the Hyperbee key
 * shapes used by Phase 5a P-030 (Hyperbee schema setup) + P-031
 * (write-side + read-side projection) per papercusp-dogfood-v5
 * lines 433-441.
 *
 * Types-only and PURE. No Hyperbee driver, no Hypercore, no PG.
 * The runtime (`apps/operator/lib/harness/hyperbee-projection.ts`,
 * when P-031 lands) uses these to compose keys at write-time + to
 * parse keys returned from prefix scans at read-time.
 *
 * Twelfth module in the dogfood-arc types-only spine. Mirrors the
 * v5 table at line 433-441 verbatim.
 *
 * Why single-source: any drift between writer + reader silently
 * breaks the projection. Composer + parser sharing one regex /
 * delimiter set prevents that.
 *
 * Key shapes (per v5 §7.1 table at line 433-441):
 *
 *   features/by-id/<feature_id>
 *   features/by-status/<status>/<feature_id>
 *   queue/<github_user_id>/<feature_id>
 *   contributors/<github_user_id>
 *   usage/<github_user_id>/<event_id>            (append-only)
 *   presence/<github_user_id>/<machine_label>
 *   claims/<feature_id>/<seq>                    (append-only)
 *   issues/<issue_id>
 *
 * NB: the `prs/<feature_id>` shape was retired (EI-479) — `harness_feature_prs`
 * never federated (no producer; the projection never fired), so PR state is now
 * a PG-local table (sync:'none'), GitHub-derived + re-polled per machine.
 */

/**
 * The canonical Hyperbee table tags. Append-only tables (usage,
 * claims) are flagged separately via APPEND_ONLY_TAGS so the
 * projection can refuse `put`-overwrites on them.
 */
export const HYPERBEE_TABLE_TAGS = [
  'features-by-id',
  'features-by-status',
  'plans-by-slug',
  'queue',
  'working-set',
  'contributors',
  'usage',
  'presence',
  'claims',
  'issues',
] as const;
export type HyperbeeTableTag = (typeof HYPERBEE_TABLE_TAGS)[number];

/**
 * Tags that are append-only (P-030 spec). Composer + parser still
 * round-trip, but writer code uses this set to assert against
 * accidental key reuse for usage/claims rows.
 */
export const APPEND_ONLY_TAGS: ReadonlySet<HyperbeeTableTag> = new Set([
  'usage',
  'claims',
] as const);

/**
 * Map tag → top-level prefix. The "features-by-id" + "features-by-
 * status" tags share the same `features/` top-level — they're
 * distinguished by the next segment.
 */
export const HYPERBEE_TAG_TO_PREFIX: Record<HyperbeeTableTag, string> = {
  'features-by-id': 'features/by-id/',
  'features-by-status': 'features/by-status/',
  'plans-by-slug': 'plans/by-slug/',
  queue: 'queue/',
  'working-set': 'working-set/',
  contributors: 'contributors/',
  usage: 'usage/',
  presence: 'presence/',
  claims: 'claims/',
  issues: 'issues/',
};

/**
 * Reverse map: prefix → tag. Useful when reading an unknown key
 * and dispatching by table.
 *
 * Note both `features/by-id/` and `features/by-status/` map to the
 * matching tag; bare `features/` doesn't map to anything (that
 * would be a malformed key — the by-X discriminator is required).
 */
export const HYPERBEE_PREFIX_TO_TAG: Record<string, HyperbeeTableTag> = {
  'features/by-id/': 'features-by-id',
  'features/by-status/': 'features-by-status',
  'plans/by-slug/': 'plans-by-slug',
  'queue/': 'queue',
  'working-set/': 'working-set',
  'contributors/': 'contributors',
  'usage/': 'usage',
  'presence/': 'presence',
  'claims/': 'claims',
  'issues/': 'issues',
};

// ---------- composers ----------

/** features/by-id/<feature_id> */
export function keyFeatureById(featureId: string): string {
  assertNonEmpty('feature_id', featureId);
  return 'features/by-id/' + featureId;
}

/** features/by-status/<status>/<feature_id> */
export function keyFeatureByStatus(status: string, featureId: string): string {
  assertNonEmpty('status', status);
  assertNonEmpty('feature_id', featureId);
  return 'features/by-status/' + status + '/' + featureId;
}

/** queue/<github_user_id>/<feature_id> */
export function keyQueueEntry(githubUserId: number, featureId: string): string {
  assertPositiveInteger('github_user_id', githubUserId);
  assertNonEmpty('feature_id', featureId);
  return 'queue/' + githubUserId + '/' + featureId;
}

/** contributors/<github_user_id> */
export function keyContributor(githubUserId: number): string {
  assertPositiveInteger('github_user_id', githubUserId);
  return 'contributors/' + githubUserId;
}

/** usage/<github_user_id>/<event_id>  (append-only) */
export function keyUsageEvent(githubUserId: number, eventId: string): string {
  assertPositiveInteger('github_user_id', githubUserId);
  assertNonEmpty('event_id', eventId);
  return 'usage/' + githubUserId + '/' + eventId;
}

/** presence/<github_user_id>/<machine_label> */
export function keyPresence(githubUserId: number, machineLabel: string): string {
  assertPositiveInteger('github_user_id', githubUserId);
  assertNonEmpty('machine_label', machineLabel);
  // machine_label may contain dashes + alphanumeric; reject `/` to
  // avoid path-escape.
  if (machineLabel.includes('/')) {
    throw new TypeError('machine_label must not contain "/"');
  }
  return 'presence/' + githubUserId + '/' + machineLabel;
}

/** claims/<feature_id>/<seq>  (append-only) */
export function keyClaim(featureId: string, seq: number): string {
  assertNonEmpty('feature_id', featureId);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TypeError('seq must be a non-negative integer');
  }
  return 'claims/' + featureId + '/' + seq;
}

/** issues/<issue_id> */
export function keyIssue(issueId: string): string {
  assertNonEmpty('issue_id', issueId);
  return 'issues/' + issueId;
}

// ---------- parsers ----------

/**
 * Discriminated parse result. Returns the tag + table-specific
 * fields. Callers switch on `tag` to handle each table.
 */
export type ParsedHyperbeeKey =
  | { tag: 'features-by-id'; feature_id: string }
  | { tag: 'features-by-status'; status: string; feature_id: string }
  | { tag: 'queue'; github_user_id: number; feature_id: string }
  | { tag: 'contributors'; github_user_id: number }
  | { tag: 'usage'; github_user_id: number; event_id: string }
  | { tag: 'presence'; github_user_id: number; machine_label: string }
  | { tag: 'claims'; feature_id: string; seq: number }
  | { tag: 'issues'; issue_id: string };

/**
 * Parse a Hyperbee key. Returns null for any malformed input.
 */
export function parseHyperbeeKey(key: string): ParsedHyperbeeKey | null {
  if (typeof key !== 'string' || key.length === 0) return null;

  // features/by-id/<feature_id>
  if (key.startsWith('features/by-id/')) {
    const rest = key.slice('features/by-id/'.length);
    if (!rest || rest.includes('/')) return null;
    return { tag: 'features-by-id', feature_id: rest };
  }

  // features/by-status/<status>/<feature_id>
  if (key.startsWith('features/by-status/')) {
    const rest = key.slice('features/by-status/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const status = rest.slice(0, slash);
    const feature_id = rest.slice(slash + 1);
    if (feature_id.includes('/')) return null;
    return { tag: 'features-by-status', status, feature_id };
  }

  // queue/<github_user_id>/<feature_id>
  if (key.startsWith('queue/')) {
    const rest = key.slice('queue/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const userIdStr = rest.slice(0, slash);
    const feature_id = rest.slice(slash + 1);
    const github_user_id = Number(userIdStr);
    if (!Number.isInteger(github_user_id) || github_user_id <= 0) return null;
    if (feature_id.includes('/')) return null;
    return { tag: 'queue', github_user_id, feature_id };
  }

  // contributors/<github_user_id>
  if (key.startsWith('contributors/')) {
    const rest = key.slice('contributors/'.length);
    if (!rest || rest.includes('/')) return null;
    const github_user_id = Number(rest);
    if (!Number.isInteger(github_user_id) || github_user_id <= 0) return null;
    return { tag: 'contributors', github_user_id };
  }

  // usage/<github_user_id>/<event_id>
  if (key.startsWith('usage/')) {
    const rest = key.slice('usage/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const userIdStr = rest.slice(0, slash);
    const event_id = rest.slice(slash + 1);
    const github_user_id = Number(userIdStr);
    if (!Number.isInteger(github_user_id) || github_user_id <= 0) return null;
    if (event_id.includes('/')) return null;
    return { tag: 'usage', github_user_id, event_id };
  }

  // presence/<github_user_id>/<machine_label>
  if (key.startsWith('presence/')) {
    const rest = key.slice('presence/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const userIdStr = rest.slice(0, slash);
    const machine_label = rest.slice(slash + 1);
    const github_user_id = Number(userIdStr);
    if (!Number.isInteger(github_user_id) || github_user_id <= 0) return null;
    if (machine_label.includes('/')) return null;
    return { tag: 'presence', github_user_id, machine_label };
  }

  // claims/<feature_id>/<seq>
  if (key.startsWith('claims/')) {
    const rest = key.slice('claims/'.length);
    const slash = rest.lastIndexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const feature_id = rest.slice(0, slash);
    const seqStr = rest.slice(slash + 1);
    const seq = Number(seqStr);
    if (!Number.isInteger(seq) || seq < 0) return null;
    if (!feature_id) return null;
    return { tag: 'claims', feature_id, seq };
  }

  // issues/<issue_id>
  if (key.startsWith('issues/')) {
    const rest = key.slice('issues/'.length);
    if (!rest || rest.includes('/')) return null;
    return { tag: 'issues', issue_id: rest };
  }

  return null;
}

/**
 * Identify the table tag from a key without parsing the full
 * payload. Useful for routing to per-table handlers.
 */
export function tagOfKey(key: string): HyperbeeTableTag | null {
  const parsed = parseHyperbeeKey(key);
  return parsed === null ? null : parsed.tag;
}

/**
 * Build the prefix for a Hyperbee `createReadStream({gt, lt})`
 * scoped scan. Returns the start prefix; callers add the end-marker
 * for an exclusive upper bound:
 *
 *   const start = scanPrefix('contributors');           // 'contributors/'
 *   const end = scanPrefix('contributors') + '\xff';    // exclusive cap
 *   db.createReadStream({ gte: start, lt: end });
 */
export function scanPrefix(tag: HyperbeeTableTag): string {
  return HYPERBEE_TAG_TO_PREFIX[tag];
}

/**
 * Scoped prefix for "everything for one user." E.g. queue for
 * github_user_id=12345 lives at `queue/12345/`; usage at
 * `usage/12345/`; presence at `presence/12345/`. Throws if the
 * tag doesn't have github_user_id as its first segment.
 */
export function scanPrefixForUser(
  tag: 'queue' | 'usage' | 'presence',
  githubUserId: number,
): string {
  assertPositiveInteger('github_user_id', githubUserId);
  return HYPERBEE_TAG_TO_PREFIX[tag] + githubUserId + '/';
}

/**
 * Scoped prefix for all status-indexed features under one status.
 * Used to read "all features with status=todo" without scanning
 * every features row.
 */
export function scanPrefixForStatus(status: string): string {
  assertNonEmpty('status', status);
  return 'features/by-status/' + status + '/';
}

// ---------- internal assertions ----------

function assertNonEmpty(name: string, v: unknown): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(name + ' must be a non-empty string');
  }
}

function assertPositiveInteger(name: string, v: unknown): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new TypeError(name + ' must be a positive integer');
  }
}
