/**
 * GET /binding/:github_repository_id — public lookup of canonical binding.
 *
 * Extends Phase 1b's per-engineer binding service for cross-engineer
 * discovery. A user pasting a GitHub URL into Entry 2 of the
 * CreateHarnessPicker calls this to find out whether a Cupboard
 * listing already binds to that repo, before creating a new one
 * (the "join existing" alert from addendum 1).
 *
 * Public (no auth). Cached at the edge for 60s by default.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { getHarnessByGithubRepoId, getHarnessesByGithubRepoIds } from '../db.ts';

/** Batch lookup cap (comb-hive-native-sharing P-011) — a search page is ≤20. */
const MAX_BATCH_REPO_IDS = 50;

export function bindingRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/binding/:github_repository_id', async (c) => {
    const idStr = c.req.param('github_repository_id');
    const repoId = parseInt(idStr, 10);
    if (!Number.isFinite(repoId) || repoId <= 0) {
      return c.json({ error: 'invalid_repository_id' }, 400);
    }
    const row = await getHarnessByGithubRepoId(c.env.DB, repoId);
    if (!row || row.unlisted_at) return c.json({ exists: false });
    return c.json({
      exists: true,
      harness: {
        id: row.id,
        github_repository_id: row.github_repository_id,
        github_url: row.github_url,
        title: row.title,
        description: row.description,
        topic_hex: row.topic_hex,
        claim_status: row.claim_status,
        claimant_github_login: row.claimant_github_login,
        publisher_github_login: row.publisher_github_login,
        // Repo→Hive binding (migration 007): the owning Hive's identity, so a
        // pasted member-repo URL resolves to its hive (P-005 lookup resolver).
        hive_pubkey: row.hive_pubkey ?? null,
        hive_title: row.hive_title ?? null,
      },
    });
  });

  /**
   * GET /bindings?repo_ids=1,2,… — BATCH repo→Hive lookup
   * (comb-hive-native-sharing P-011). Resolves a page of GitHub search results
   * (≤50 ids) against the index in one query, so the picker's search panel can
   * badge "Hive exists / claimed" per result (P-010). Public, no auth — same
   * posture as the single-repo /binding lookup; edge-cacheable.
   *
   * Returns one entry per repo that has an active harness listing:
   *   { repo_id, hive_pubkey, hive_title, claim_status, listing_id }[]
   * Repos with no listing are simply absent (the caller treats absent = none).
   */
  app.get('/bindings', async (c) => {
    const raw = c.req.query('repo_ids') ?? '';
    const ids = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    const uniq = [...new Set(ids)].slice(0, MAX_BATCH_REPO_IDS);
    if (uniq.length === 0) return c.json({ bindings: [] });

    const rows = await getHarnessesByGithubRepoIds(c.env.DB, uniq);
    // One binding per repo id (the active harness row); dedup defensively in
    // case the 1:1-per-repo invariant ever yields more than one active row.
    const seen = new Set<number>();
    const bindings: Array<{
      repo_id: number;
      hive_pubkey: string | null;
      hive_title: string | null;
      claim_status: string;
      listing_id: string;
    }> = [];
    for (const row of rows) {
      if (seen.has(row.github_repository_id)) continue;
      seen.add(row.github_repository_id);
      bindings.push({
        repo_id: row.github_repository_id,
        hive_pubkey: row.hive_pubkey ?? null,
        hive_title: row.hive_title ?? null,
        claim_status: row.claim_status,
        listing_id: row.id,
      });
    }
    return c.json({ bindings });
  });

  return app;
}
