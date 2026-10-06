/**
 * Organization membership removals, carried from the portal to each connected machine
 * (WI-10004257; external-app-access-to-workspaces-2026-09-29 follow-up to P-328, D-030 #5).
 *
 * The creator-removed connected-app alert asks whether a key's creator still belongs to the
 * organization. Membership lives on the portal (`papercusp_auth.organization_memberships`). A
 * hosted or relay-linked machine's database holds no current membership rows, so on a machine
 * the alert could never fire.
 *
 * So the portal reports, on each machine's connector socket, every address in that machine's
 * organization whose membership is no longer active:
 *
 *   portal   loadMembershipReportFrame(organizationId)  -> { type: 'membership.report', ... }
 *            sent by HostedWorkspaceSessionBroker after `bound`, and again when it changes
 *   machine  HostedWorkspaceHostSessionAdapter.accept   -> drops a frame for another organization
 *            applyMembershipReport(frame)              -> replaces that organization's rows in
 *                                                         harness_shared.connected_app_removed_creators
 *   sweep    loadSweepKeys                             -> creator_removed reads that table too
 *
 * Each report is the complete set for the organization, so a member who is re-activated drops
 * out of the next report and their row is removed. The stored fact is display-only: it feeds one
 * alert and is never an authorization input, which is why it is not written into the
 * papercusp_auth tables hosted authorization reads.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** The connector frame type. Sent outside any relay channel. */
export const MEMBERSHIP_REPORT_FRAME_TYPE = 'membership.report';

/**
 * Most addresses one report carries. Far above any real organization's removed members, and far
 * below the 1 MiB connector message cap. A larger set is not sent at all rather than truncated:
 * a truncated set would read as "everyone else is active" and clear rows that are still true.
 */
export const MEMBERSHIP_REPORT_MAX_EMAILS = 10_000;

export interface MembershipReport {
  type: typeof MEMBERSHIP_REPORT_FRAME_TYPE;
  organizationId: string;
  /** lower-cased, de-duplicated, sorted. */
  removedEmails: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedEmails(values: readonly unknown[]): string[] | null {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    if (!email || email.length > 320 || !email.includes('@')) return null;
    out.add(email);
  }
  return [...out].sort();
}

/** Shared by both entry points: `normalizedEmails` validates each value at runtime. */
function frameFromValues(organizationId: string, values: readonly unknown[]): MembershipReport | null {
  if (!organizationId || values.length > MEMBERSHIP_REPORT_MAX_EMAILS) return null;
  const removedEmails = normalizedEmails(values);
  if (!removedEmails) return null;
  return { type: MEMBERSHIP_REPORT_FRAME_TYPE, organizationId, removedEmails };
}

/** Pure: build the frame for an organization and its removed members' addresses. */
export function membershipReportFrame(organizationId: string, emails: readonly string[]): MembershipReport | null {
  return frameFromValues(organizationId, emails);
}

/**
 * Pure: parse a portal-authored frame; null when it is not a well-formed report. The portal is a
 * separately deployed peer, so a malformed frame is refused whole, never applied in part.
 */
export function parseMembershipReport(value: unknown): MembershipReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== MEMBERSHIP_REPORT_FRAME_TYPE) return null;
  if (typeof frame.organizationId !== 'string' || !frame.organizationId || frame.organizationId.length > 128) return null;
  if (!Array.isArray(frame.removedEmails)) return null;
  return frameFromValues(frame.organizationId, frame.removedEmails);
}

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

/**
 * Portal side: the report for one organization, read from the portal's own membership tables.
 * Null for an organization id that cannot be one (not a uuid) or a set over the cap.
 *
 * `removed` means the address holds a membership in THIS organization and it is not active
 * (suspended or revoked). One membership per (organization, user), so there is no second row
 * that could still be active.
 */
export async function loadMembershipReportFrame(
  organizationId: string,
  run: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
): Promise<MembershipReport | null> {
  if (!UUID_RE.test(organizationId)) return null;
  const rows = await run((sql) => sql<{ email: string }[]>`
    SELECT DISTINCT lower(u.primary_email) AS email
      FROM papercusp_auth.organization_memberships m
      JOIN papercusp_auth.hosted_users u ON u.id = m.user_id
     WHERE m.organization_id = ${organizationId}::uuid
       AND m.status <> 'active'
       AND u.primary_email IS NOT NULL AND u.primary_email <> ''
     ORDER BY 1
     LIMIT ${MEMBERSHIP_REPORT_MAX_EMAILS + 1}
  `);
  if (rows.length > MEMBERSHIP_REPORT_MAX_EMAILS) {
    console.warn(`[connected-apps] organization ${organizationId} has more than ${MEMBERSHIP_REPORT_MAX_EMAILS} removed members; membership report not sent`);
    return null;
  }
  return membershipReportFrame(organizationId, rows.map((r) => r.email));
}

export interface AppliedMembershipReport {
  organizationId: string;
  stored: number;
  added: number;
  cleared: number;
}

/**
 * Machine side: replace the organization's stored removals with this report, in one statement.
 * Returns null (and writes nothing) for a malformed frame.
 */
export async function applyMembershipReport(
  value: unknown,
  sql: SqlClient = getOrgPg().sql,
): Promise<AppliedMembershipReport | null> {
  const report = parseMembershipReport(value);
  if (!report) return null;
  // JSON, not a native array parameter: the array serializer is not registered until the pool's
  // first connection has fetched array types (WI-10004177).
  const rows = await sql<Array<{ added: number | string; cleared: number | string }>>`
    WITH incoming AS (
      SELECT DISTINCT e AS email FROM jsonb_array_elements_text(${JSON.stringify(report.removedEmails)}::jsonb) AS e
    ), gone AS (
      DELETE FROM harness_shared.connected_app_removed_creators r
       WHERE r.organization_id = ${report.organizationId}
         AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.email = r.email)
      RETURNING 1
    ), added AS (
      INSERT INTO harness_shared.connected_app_removed_creators (organization_id, email)
      SELECT ${report.organizationId}, i.email FROM incoming i
      ON CONFLICT (organization_id, email) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM added) AS added, (SELECT count(*) FROM gone) AS cleared
  `;
  return {
    organizationId: report.organizationId,
    stored: report.removedEmails.length,
    added: Number(rows[0]?.added ?? 0),
    cleared: Number(rows[0]?.cleared ?? 0),
  };
}

/**
 * The runtime's default sink for a report frame. Best-effort and never throws: a failed write
 * must not cost the machine its connector. The next report (or reconnect) re-sends the full set.
 */
export async function onMembershipReported(value: unknown): Promise<AppliedMembershipReport | null> {
  try {
    return await applyMembershipReport(value);
  } catch (err) {
    console.warn('[connected-apps] applying a membership report failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
