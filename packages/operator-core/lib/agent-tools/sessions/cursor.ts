import { createHash } from 'node:crypto';

export type SessionCursorTool = 'sessions:list' | 'sessions:search' | 'sessions:timeline';

const CURSOR_VERSION = 2;
const MAX_CURSOR_OFFSET = 500;

export interface SessionCursorBounds {
  since?: string;
  until?: string;
}

export interface SessionCursorAuthority {
  workspaceId: string;
  selfOwnerId?: string;
  selfSessionId?: string;
}

interface SessionCursorPayload {
  v: number;
  tool: SessionCursorTool;
  offset: number;
  fingerprint: string;
  bounds?: SessionCursorBounds;
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  );
};

/** Bind a cursor to the query/filter and resolved authority while allowing the page size to change. */
export function sessionCursorFingerprint(value: unknown, authority?: SessionCursorAuthority): string {
  const fingerprintValue = authority
    ? {
        query: value,
        authority: {
          workspace_id: authority.workspaceId,
          self_owner_id: authority.selfOwnerId,
          self_session_id: authority.selfSessionId,
        },
      }
    : value;
  return createHash('sha256').update(JSON.stringify(stableValue(fingerprintValue))).digest('hex').slice(0, 24);
}

/**
 * Build the stable query portion of a cursor fingerprint for paginated session
 * reads. The page size and cursor are transport details; timeline bounds are
 * carried in the cursor itself so a caller may omit them on replay.
 */
export function sessionCursorQueryFingerprint(
  value: Record<string, unknown>,
  authority?: SessionCursorAuthority,
): string {
  const { cursor: _cursor, limit: _limit, since: _since, until: _until, ...query } = value;
  return sessionCursorFingerprint(query, authority);
}

/**
 * Explicit bounds on a cursor replay must agree with the bounds that were
 * frozen into the cursor. Omitted bounds are intentional: the replay should
 * use the cursor's carried snapshot.
 */
export function sessionCursorBoundsMatch(
  requested: SessionCursorBounds,
  carried: SessionCursorBounds,
): boolean {
  return (requested.since === undefined || requested.since === carried.since)
    && (requested.until === undefined || requested.until === carried.until);
}

export function encodeSessionCursor(
  tool: SessionCursorTool,
  offset: number,
  fingerprint: string,
  bounds?: SessionCursorBounds,
): string {
  const payload: SessionCursorPayload = {
    v: CURSOR_VERSION,
    tool,
    offset,
    fingerprint,
    ...(bounds && Object.keys(bounds).length > 0 ? { bounds } : {}),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSessionCursor(
  cursor: string | undefined,
  tool: SessionCursorTool,
  fingerprint: string,
): { ok: true; offset: number; bounds: SessionCursorBounds } | { ok: false; error: 'invalid_cursor'; message: string } {
  if (!cursor) return { ok: true, offset: 0, bounds: {} };
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SessionCursorPayload>;
    const bounds = payload.bounds ?? {};
    const boundsValid =
      bounds &&
      typeof bounds === 'object' &&
      !Array.isArray(bounds) &&
      Object.keys(bounds).every((key) => key === 'since' || key === 'until') &&
      [bounds.since, bounds.until].every((value) => value === undefined || (
        typeof value === 'string' && Number.isFinite(Date.parse(value))
      ));
    if (
      payload.v !== CURSOR_VERSION ||
      payload.tool !== tool ||
      payload.fingerprint !== fingerprint ||
      !boundsValid ||
      !Number.isInteger(payload.offset) ||
      (payload.offset ?? -1) < 0 ||
      (payload.offset ?? 0) > MAX_CURSOR_OFFSET
    ) {
      return {
        ok: false,
        error: 'invalid_cursor',
        message: 'Cursor is stale, belongs to another sessions tool/query, or exceeds the bounded pagination window.',
      };
    }
    return { ok: true, offset: payload.offset as number, bounds };
  } catch {
    return { ok: false, error: 'invalid_cursor', message: 'Cursor is malformed.' };
  }
}
