/**
 * loadHarnessPeople — Insights PeopleCard data source.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073c real-data follow-up).
 *
 * Reads harness_shared.contributors for one harness and shapes the rows
 * for the PeopleCard's avatar stack. Pure logic — injectable runQuery.
 *
 * Returns rows in joined-at-desc order; the card itself truncates to
 * maxAvatars on render.
 */

import type { PeopleCardPerson } from './card-types';

export interface LoadHarnessPeopleOpts {
  workspace_id: string;
  harness_slug: string;
  limit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface RawRow {
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: unknown;
}

function pickBindingStatus(raw: unknown): PeopleCardPerson['binding_status'] {
  if (!Array.isArray(raw) || raw.length === 0) return 'unverified';
  let anyVerified = false;
  let anyPending = false;
  for (const a of raw) {
    if (a && typeof a === 'object') {
      const verified = (a as { verified?: boolean }).verified;
      if (verified === true) anyVerified = true;
      if (verified === false) anyPending = true;
    }
  }
  if (anyVerified) return 'verified';
  if (anyPending) return 'pending';
  return 'unverified';
}

export async function loadHarnessPeople(
  opts: LoadHarnessPeopleOpts,
): Promise<PeopleCardPerson[]> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const limit = opts.limit ?? 50;

  let rows: RawRow[] = [];
  try {
    rows = await runQuery<RawRow>(
      `SELECT github_user_id, github_username, display_name, avatar_url,
              device_attestations
         FROM harness_shared.contributors
        WHERE workspace_id = $1
          AND harness_slug = $2
        ORDER BY joined_at DESC
        LIMIT $3`,
      [workspace_id, harness_slug, limit],
    );
  } catch {
    return [];
  }

  return rows.map((r) => ({
    github_user_id:
      typeof r.github_user_id === 'string'
        ? Number.parseInt(r.github_user_id, 10) || 0
        : r.github_user_id,
    login: r.github_username,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    binding_status: pickBindingStatus(r.device_attestations),
  }));
}
