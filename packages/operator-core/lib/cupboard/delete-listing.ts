/**
 * delete-listing — the ONE `DELETE /listings/:id` primitive (gh-token authed,
 * publisher-or-claimant), shared by the hive member-repo unlist
 * (unlist-hive-rows.ts) AND the agent-callable `cupboard:unpublish` tool
 * (cupboard-agent-tool-coverage-2026-07-14 P-009, D-001 reuse-first).
 *
 * Delisting is universal across kinds: any listing (plugin/pack/blueprint/
 * template/app/knowledge-pack/harness) is withdrawn by its listing id. A whole
 * HIVE (many member-repo harness rows at once) is withdrawn via
 * discovery:set_pot { visibility: 'private' }, which fans out over these.
 */
import { getGhAuthToken } from '../identity/gh-token';
import { resolveCupboardBaseUrl } from './base-url';

export interface DeleteCupboardListingResult {
  ok: boolean;
  /** The worker reported the listing was already unlisted (idempotent re-delist). */
  alreadyUnlisted?: boolean;
  status?: number;
  error?: string;
}

/** DELETE one Cupboard listing by id. Never throws — returns a structured result. */
export async function deleteCupboardListing(
  listingId: number | string,
): Promise<DeleteCupboardListingResult> {
  const tokenRes = await getGhAuthToken();
  if (tokenRes.kind !== 'ok') return { ok: false, status: 401, error: 'gh_auth_required' };
  try {
    const res = await fetch(
      `${resolveCupboardBaseUrl()}/listings/${encodeURIComponent(String(listingId))}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenRes.token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return { ok: false, status: res.status, error: `cupboard_http_${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { already_unlisted?: boolean };
    return { ok: true, status: res.status, ...(body.already_unlisted ? { alreadyUnlisted: true } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
