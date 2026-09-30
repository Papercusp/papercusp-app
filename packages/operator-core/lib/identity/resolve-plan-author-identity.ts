/**
 * resolve-plan-author-identity — map a plan author reference to a renderable,
 * github-verified-when-possible identity (handle + avatar), for the plan
 * ownership/attribution badges (shared-hive-collaboration-2026-06-14 P-001, B1,
 * D-001).
 *
 * Three input kinds, one always-renders output:
 *   - `email`    — a plan's frontmatter `owner` (harness_plans.owner).
 *   - `authorId` — a plan_revisions.author_id (the editor's ownerId; pair with
 *                  authorKind from classifyAuthor: 'human' | 'agent').
 *   - `pubkey`   — a harness_plan_parts.author device pubkey (per-item author).
 *
 * Enrichment sources (read-only):
 *   - hive_members — the ONLY source of github_username + avatar_url +
 *     device_pubkey↔github bindings (per-Hive; we index workspace-wide and dedupe
 *     by github_user_id, preferring a row that carries an avatar).
 *   - harness_shared.users — local accounts: id → username/display_name (no
 *     email/github/avatar), for resolving a human authorId that is a user uuid.
 *
 * DESIGN: the mapping is a PURE function over a prebuilt index, so the
 * fallback/branch logic is unit-tested without PG; the thin async wrapper builds
 * the index in at most two batched queries (no N+1 — perf doc A-class). It is
 * BEST-EFFORT: it never throws and always returns a sensible handle, so a missing
 * binding degrades to "localpart + initials", never a blank badge.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeviceAttestationEntry } from '../harness/contributor-row-types';

export type PlanAuthorInputKind = 'email' | 'authorId' | 'pubkey';

export interface PlanAuthorInput {
  kind: PlanAuthorInputKind;
  /** The raw reference: an email, an ownerId, or a device pubkey. */
  value: string;
  /** Only meaningful for kind:'authorId' — from classifyAuthor(). Default 'agent'. */
  authorKind?: 'human' | 'agent';
}

export interface ResolvedAuthor {
  /** Stable id for dedupe / per-user color-keying: the github_user_id (as string)
   *  when verified, else the raw input value. */
  id: string;
  /** A short, human-facing handle — NEVER a raw email. */
  handle: string;
  /** GitHub avatar when the reference binds to a verified member; else null
   *  (the UI renders an initials chip).
   *
   *  OPTIONAL, not merely nullable: the plans.list / plans.byHive wire payload
   *  OMITS this key when it resolves to null (EI-19455103442009801 — it was null
   *  on 1,475/1,475 live occurrences, 25,075 B of pure dead weight). The omission
   *  happens at the attachment point in sync-resolver/plan-attribution.ts, not in
   *  the UI projection, because that projection runs BEFORE the enrichment that
   *  attaches these objects.
   *
   *  ⚠ Read it with TRUTHINESS (`avatarUrl ? … : …`, `??`, `?.`). `=== null`,
   *  `'avatarUrl' in x`, `hasOwnProperty` and destructuring-with-a-default all
   *  break on an omitted key. Every current consumer already uses truthiness. */
  avatarUrl?: string | null;
  kind: 'human' | 'agent';
  /** True when handle/avatar come from a github-verified hive member. */
  verified: boolean;
}

/** One resolved github identity, deduped across hives. */
interface MemberIdentity {
  githubUserId: number;
  githubUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The prebuilt index the pure mapper resolves against. */
export interface IdentityIndex {
  /** lowercased github_username → identity. */
  byUsername: Map<string, MemberIdentity>;
  /** device_pubkey → identity (from each member's device_attestations). */
  byDevicePubkey: Map<string, MemberIdentity>;
  /** harness_shared.users.id (uuid) → { username, displayName }. */
  byUserId: Map<string, { username: string; displayName: string | null }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v.trim());
}

/** Local part of an email, lowercased — the handle we show instead of the raw email. */
export function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return (at > 0 ? email.slice(0, at) : email).trim();
}

/** Short, scannable label for an agent ownerId (e.g. `su-88991abc…` → `su-88991abc`).
 *  Mirrors RevisionsPanel.formatAuthor's agent branch (first two dash chunks). */
export function agentLabel(ownerId: string): string {
  const id = ownerId.trim();
  const parts = id.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : id.slice(0, 16);
}

/** Short device-pubkey label for an unresolved per-item author. */
export function shortPubkey(pubkey: string): string {
  const k = pubkey.trim();
  return k.length > 10 ? `${k.slice(0, 8)}…` : k;
}

/** Build the pure index from raw rows (exported for unit tests). Dedupes members
 *  by github_user_id, preferring a row that carries an avatar_url. */
export function buildIdentityIndex(
  members: Array<{
    githubUserId: number;
    githubUsername: string;
    displayName: string | null;
    avatarUrl: string | null;
    deviceAttestations: DeviceAttestationEntry[];
  }>,
  users: Array<{ id: string; username: string; displayName: string | null }> = [],
): IdentityIndex {
  const byGithubUserId = new Map<number, MemberIdentity>();
  for (const m of members) {
    const existing = byGithubUserId.get(m.githubUserId);
    // Prefer the first row with an avatar; otherwise keep the first seen.
    if (!existing || (!existing.avatarUrl && m.avatarUrl)) {
      byGithubUserId.set(m.githubUserId, {
        githubUserId: m.githubUserId,
        githubUsername: m.githubUsername,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
      });
    }
  }
  const byUsername = new Map<string, MemberIdentity>();
  const byDevicePubkey = new Map<string, MemberIdentity>();
  for (const ident of byGithubUserId.values()) {
    if (ident.githubUsername) byUsername.set(ident.githubUsername.toLowerCase(), ident);
  }
  // device_pubkey → identity: re-walk members (attestations live on the per-hive
  // row, but every device for a github user points at the same person).
  for (const m of members) {
    const ident = byGithubUserId.get(m.githubUserId);
    if (!ident) continue;
    for (const a of m.deviceAttestations ?? []) {
      if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
        if (!byDevicePubkey.has(a.device_pubkey)) byDevicePubkey.set(a.device_pubkey, ident);
      }
    }
  }
  const byUserId = new Map<string, { username: string; displayName: string | null }>();
  for (const u of users) byUserId.set(u.id, { username: u.username, displayName: u.displayName });
  return { byUsername, byDevicePubkey, byUserId };
}

function fromMember(m: MemberIdentity, kind: 'human' | 'agent'): ResolvedAuthor {
  return {
    id: String(m.githubUserId),
    handle: m.githubUsername || m.displayName || String(m.githubUserId),
    avatarUrl: m.avatarUrl,
    kind,
    verified: true,
  };
}

/** PURE: map one author reference to a renderable identity against a prebuilt index.
 *  Never throws; always returns a usable handle. */
export function mapAuthorToIdentity(input: PlanAuthorInput, index: IdentityIndex): ResolvedAuthor {
  const value = (input.value ?? '').trim();
  if (!value) return { id: 'unknown', handle: 'unknown', avatarUrl: null, kind: 'agent', verified: false };

  if (input.kind === 'email') {
    const local = emailLocalPart(value);
    // Opportunistic enrich: a github_username equal to the email local part.
    const hit = index.byUsername.get(local.toLowerCase());
    if (hit) return fromMember(hit, 'human');
    return { id: value, handle: local, avatarUrl: null, kind: 'human', verified: false };
  }

  if (input.kind === 'pubkey') {
    const hit = index.byDevicePubkey.get(value);
    if (hit) return fromMember(hit, 'human');
    // An unbound device pubkey reads as a machine/agent device.
    return { id: value, handle: shortPubkey(value), avatarUrl: null, kind: 'agent', verified: false };
  }

  // kind === 'authorId'
  const authorKind = input.authorKind ?? 'agent';
  if (authorKind === 'agent') {
    return { id: value, handle: agentLabel(value), avatarUrl: null, kind: 'agent', verified: false };
  }
  // human authorId: a user uuid, an email, or an opaque id.
  if (isUuid(value)) {
    const u = index.byUserId.get(value);
    if (u) return { id: value, handle: u.username || u.displayName || value, avatarUrl: null, kind: 'human', verified: false };
    return { id: value, handle: value.slice(0, 8), avatarUrl: null, kind: 'human', verified: false };
  }
  if (value.includes('@')) {
    return mapAuthorToIdentity({ kind: 'email', value }, index);
  }
  return { id: value, handle: value.slice(0, 24), avatarUrl: null, kind: 'human', verified: false };
}

interface HiveMemberIndexRow {
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: DeviceAttestationEntry[] | string | null;
}

function parseAttestations(v: DeviceAttestationEntry[] | string | null): DeviceAttestationEntry[] {
  if (v == null) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as DeviceAttestationEntry[]) : [];
    } catch {
      return [];
    }
  }
  return v;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const dedupeKey = (i: PlanAuthorInput): string => `${i.kind}:${i.value}`;

/**
 * Build the workspace identity index from PG (hive_members workspace-wide + the
 * users needed for any human-uuid authorIds in `inputs`), then resolve every
 * input. Returns a Map keyed `${kind}:${value}` → ResolvedAuthor. Best-effort:
 * on any PG error it resolves everything against an empty index (pure fallbacks).
 */
export async function resolvePlanAuthorIdentities(
  workspaceId: string,
  inputs: PlanAuthorInput[],
  opts?: { sql?: Sql },
): Promise<Map<string, ResolvedAuthor>> {
  const out = new Map<string, ResolvedAuthor>();
  const distinct = new Map<string, PlanAuthorInput>();
  for (const i of inputs) {
    if (i && (i.value ?? '').trim()) distinct.set(dedupeKey(i), i);
  }
  if (distinct.size === 0) return out;

  let index: IdentityIndex;
  try {
    const sql = pg(opts?.sql);
    const memberRows = (await sql.unsafe(
      `SELECT github_user_id, github_username, display_name, avatar_url, device_attestations
         FROM harness_shared.pot_members WHERE workspace_id = $1`,
      [workspaceId],
    )) as unknown as HiveMemberIndexRow[];
    const members = memberRows.map((r) => ({
      githubUserId: Number(r.github_user_id),
      githubUsername: r.github_username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      deviceAttestations: parseAttestations(r.device_attestations),
    }));

    // Only the human-uuid authorIds need a users lookup.
    const userIds = [...distinct.values()]
      .filter((i) => i.kind === 'authorId' && (i.authorKind ?? 'agent') === 'human' && isUuid(i.value))
      .map((i) => i.value.trim());
    let users: Array<{ id: string; username: string; displayName: string | null }> = [];
    if (userIds.length > 0) {
      const userRows = (await sql.unsafe(
        `SELECT id, username, display_name FROM harness_shared.users WHERE id = ANY($1::uuid[])`,
        [userIds],
      )) as unknown as Array<{ id: string; username: string; display_name: string | null }>;
      users = userRows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }));
    }
    index = buildIdentityIndex(members, users);
  } catch {
    // Fall back to pure resolution (handles + initials, no avatars).
    index = { byUsername: new Map(), byDevicePubkey: new Map(), byUserId: new Map() };
  }

  for (const [key, input] of distinct) out.set(key, mapAuthorToIdentity(input, index));
  return out;
}

/** Convenience: the dedupe key for looking a result up in the resolved Map. */
export function planAuthorKey(kind: PlanAuthorInputKind, value: string): string {
  return `${kind}:${value}`;
}
