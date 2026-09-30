/**
 * PR-reviewer settings routes — Phase 8 P-049.
 *
 *   GET  /api/harness/:slug/pr-reviewer-settings
 *        → PrReviewerSettingsResponse:
 *          { settings, trustList[], audit[], viewer, editable }
 *
 *   POST /api/harness/:slug/pr-reviewer-settings
 *        body: PrReviewerSettingsPatch (subset of toggles + merge_method)
 *        → { ok: true, settings } | { error }
 *
 *   POST /api/harness/:slug/pr-reviewer-settings/trust/remove
 *        body: { trusted_github_user_id: number }
 *        → { ok: true } | { error }
 *
 * Data sources (all LOCAL, never synced — v5 §7.5):
 *   - settings:  harness_shared.pr_reviewer_settings  (per harness, per viewer github id)
 *   - trustList: harness_shared.trusted_authors       (per harness, trusted-by viewer)
 *   - audit:     harness_shared.auto_review_audit      (recent auto-review/merge actions)
 *
 * Identity / gating: settings + trust are keyed by the VIEWER's GitHub
 * user id, resolved server-side from the local `gh` token
 * (`resolveLocalGithubIdentity`) — single-user loopback desktop means the
 * local identity IS the viewer (same model as the P-072 privacy filter +
 * the P-069 claim-status route). Writes REQUIRE a resolved viewer id;
 * anonymous (no gh auth) → 401, so the UI renders read-only. The settings
 * UI never passes an id from the client — the server is the trust boundary.
 *
 * Auth: 'public' — loopback gate is the trust boundary (same as sibling
 * harness routes); the per-viewer scoping above is the write gate.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-049.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';
import {
  defaultPrReviewerSettings,
  applyPrReviewerSettingsPatch,
  type PrReviewerSettingsRow,
  type PrReviewerSettingsPatch,
} from '../../../pr-host/pr-reviewer-settings-types';
import { PR_MERGE_METHODS, type PrMergeMethod } from '../../../pr-host/types';
import {
  resolveClaimStatus,
  type ClaimStatusRow,
} from '../../../harness/claim-status-resolver';
import type { BindingClaimStatus } from '../../../harness/binding-types';

// ─── Wire shapes ──────────────────────────────────────────────────

/** A trust-list entry as returned to the client. */
export interface TrustListEntry {
  trusted_github_user_id: number;
  trusted_login: string | null;
  trusted_at: string;
}

/** An audit-log row as returned to the client. */
export interface AuditEntry {
  id: number;
  pr_number: number;
  pr_url: string | null;
  author_github_id: number | null;
  action: string;
  detail: string | null;
  ts: string;
}

/** The four UI-relevant toggles (mirrors the PG row minus identity). */
export interface SettingsToggles {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: PrMergeMethod;
}

export interface PrReviewerSettingsResponse {
  settings: SettingsToggles;
  trustList: TrustListEntry[];
  audit: AuditEntry[];
  /** Resolved viewer identity (null when no gh auth). */
  viewer: { github_user_id: number; github_login: string } | null;
  /** Whether this viewer may write (true iff a viewer id resolved). */
  editable: boolean;
  /**
   * PR-3 §3: is the viewer the CLAIMED OWNER of this harness (the
   * authority that may flip per-hive auto-mode)? Drives the GUI's owner
   * messaging. See `isClaimedOwner`.
   */
  claimOwner?: boolean;
  /**
   * PR-3 §3: may the viewer flip the AUTO-MODE toggles (`auto_review` /
   * `auto_merge`)? = `editable && claimOwner`. The GUI renders the auto
   * toggle read-only when false; the POST handler enforces the same gate
   * (the teeth). The personal reviewer-role + merge_method stay gated on
   * `editable` only.
   */
  autoModeEditable?: boolean;
  /**
   * Hive-pr-rollup P-007 (D-002): when the viewer has NO settings row for this
   * harness but DOES have the reviewer role on its hive HOME, the role bit is
   * inherited read-time and this carries the home slug (provenance for the
   * settings UI). null/absent = no inheritance applied. Only
   * `pr_reviewer_role_enabled` inherits — auto_review/auto_merge stay
   * explicit per harness. An explicit row (any value) always wins.
   */
  inheritedFrom?: string | null;
  /**
   * P-008 (D-003): true when the role was conferred by hive OWNERSHIP (this
   * install created the hive — a local harness_shared.pots row exists for
   * the group's home). Pairs with inheritedFrom (the home slug; null when
   * the viewed harness IS the owned home).
   */
  grantedByOwnership?: boolean;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

/** Project a full settings row down to the UI-relevant toggles. */
export function toToggles(row: PrReviewerSettingsRow): SettingsToggles {
  return {
    pr_reviewer_role_enabled: row.pr_reviewer_role_enabled,
    auto_review: row.auto_review,
    auto_merge: row.auto_merge,
    merge_method: row.merge_method,
  };
}

/**
 * Validate + normalise a raw settings-patch body into a typed
 * `PrReviewerSettingsPatch`. Only the four known fields are accepted;
 * unknown fields are dropped, bad types rejected. Returns `{ ok:false }`
 * when the body is empty (nothing to update) or a field is malformed.
 */
export function parseSettingsPatch(
  body: unknown,
): { ok: true; patch: PrReviewerSettingsPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;
  const patch: PrReviewerSettingsPatch = {};

  for (const key of ['pr_reviewer_role_enabled', 'auto_review', 'auto_merge'] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
      patch[key] = b[key] as boolean;
    }
  }
  if (b.merge_method !== undefined) {
    if (
      typeof b.merge_method !== 'string' ||
      !(PR_MERGE_METHODS as readonly string[]).includes(b.merge_method)
    ) {
      return { ok: false, error: `merge_method must be one of ${PR_MERGE_METHODS.join(', ')}` };
    }
    patch.merge_method = b.merge_method as PrMergeMethod;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no recognised fields to update' };
  }
  return { ok: true, patch };
}

/** Validate the trust-remove body → the numeric id to remove. */
export function parseTrustRemoveBody(
  body: unknown,
): { ok: true; trustedId: number } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const raw = (body as { trusted_github_user_id?: unknown }).trusted_github_user_id;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'trusted_github_user_id must be a positive integer' };
  }
  return { ok: true, trustedId: n };
}

// ─── PR-3: owner-gated auto-mode ──────────────────────────────────

/**
 * Does this patch flip an AUTO-MODE lever (`auto_review` / `auto_merge`)?
 * Those are the per-hive "auto-apply agent recommendations" decision —
 * gated on CLAIMED-OWNER authority (PLAN-pr-system-completion-dogfood
 * PR-3 §3). The personal reviewer-role + merge_method are NOT auto-mode
 * and stay gh-auth-gated. Pure — unit-tested.
 */
export function patchTouchesAutoMode(patch: PrReviewerSettingsPatch): boolean {
  return patch.auto_review !== undefined || patch.auto_merge !== undefined;
}

/**
 * Whether the viewer may edit AUTO-MODE for `slug`, given the GitHub
 * sign-in state + the claimed-owner authority. Pure — unit-tested.
 * `editable` is the gh-auth gate (a resolved viewer); `claimOwner` is the
 * claimed-owner gate. Both must hold to flip the auto toggles.
 */
export function autoModeEditableFrom(opts: { editable: boolean; claimOwner: boolean }): boolean {
  return opts.editable && opts.claimOwner;
}

type SrbcOwnerRow = {
  github_repository_id: number | string;
  claim_status: BindingClaimStatus;
  provisional_owner_github_user_id: number | string;
  provisional_owner_github_login: string | null;
  claimed_by_github_user_ids: Array<number | string> | string | null;
  superseded_by_harness_topic: string | null;
};

/** Postgres BIGINT[] arrives as number[], string[], or a `{1,2}` literal. */
function parseClaimantIds(raw: SrbcOwnerRow['claimed_by_github_user_ids']): number[] {
  if (raw == null) return [];
  let arr: unknown[];
  if (Array.isArray(raw)) arr = raw;
  else {
    const s = String(raw).trim();
    if (!s || s === '{}' || s === '[]') return [];
    if (s.startsWith('{') && s.endsWith('}')) arr = s.slice(1, -1).split(',');
    else {
      try {
        const v = JSON.parse(s);
        arr = Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    }
  }
  return arr
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Is `viewerId` the CLAIMED OWNER of `slug` — the authority that may flip
 * auto-mode? Rules (PR-3 §3 "an unclaimed/non-owner viewer sees it
 * read-only"):
 *   - NO binding row (a purely-local, never-shared harness) → the local
 *     operator IS the implicit owner → true for any resolved viewer.
 *   - binding row present → true ONLY when the binding is CLAIMED and the
 *     viewer is a claimant. Unclaimed / stale / superseded / not-the-
 *     claimant → false (read-only until claimed by this viewer).
 * Best-effort: a missing table / PG error → false (fail closed).
 */
async function isClaimedOwner(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  slug: string,
  viewerId: number | null,
): Promise<boolean> {
  if (viewerId == null) return false;
  try {
    const rows = (await sql`
      SELECT github_repository_id, claim_status,
             provisional_owner_github_user_id, provisional_owner_github_login,
             claimed_by_github_user_ids, superseded_by_harness_topic
        FROM harness_shared.shared_repo_binding_cache
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
       LIMIT 1
    `) as unknown as SrbcOwnerRow[];
    const row = rows[0];
    // No shared binding → local harness; the resolved operator is the owner.
    if (!row) return true;

    const claimRow: ClaimStatusRow = {
      github_repository_id: Number(row.github_repository_id),
      claim_status: row.claim_status,
      provisional_owner_github_user_id: Number(row.provisional_owner_github_user_id),
      provisional_owner_github_login: row.provisional_owner_github_login ?? '',
      claimed_by_github_user_ids: parseClaimantIds(row.claimed_by_github_user_ids),
      claimant_logins: {},
      superseded_by_harness_topic: row.superseded_by_harness_topic,
    };
    const resolved = resolveClaimStatus(claimRow, viewerId);
    return resolved.status === 'claimed' && resolved.isClaimant;
  } catch {
    // Missing table / PG error → fail closed (no auto-mode edit).
    return false;
  }
}

// ─── DB row → wire mappers ────────────────────────────────────────

interface SettingsDbRow {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: string;
  updated_at: string | Date;
}

function dbRowToSettings(
  row: SettingsDbRow | undefined,
  slug: string,
  githubUserId: number,
  now: number,
): PrReviewerSettingsRow {
  if (!row) return defaultPrReviewerSettings({ harness_slug: slug, github_user_id: githubUserId, now });
  return {
    harness_slug: slug,
    github_user_id: githubUserId,
    pr_reviewer_role_enabled: !!row.pr_reviewer_role_enabled,
    auto_review: !!row.auto_review,
    auto_merge: !!row.auto_merge,
    merge_method: (PR_MERGE_METHODS as readonly string[]).includes(row.merge_method)
      ? (row.merge_method as PrMergeMethod)
      : 'squash',
    updated_at: new Date(row.updated_at).getTime(),
  };
}

/**
 * Resolve the hive-group ROOT containing `slug` — the slug itself when it IS
 * the root (P-008 needs that case: ownership applies on the home too). Uses
 * the cached lite payload's precomputed grouping (formal `hive_slug` + legacy
 * fallback). Null on lookup failure. Exported for tests.
 */
export async function hiveGroupRootOf(slug: string): Promise<string | null> {
  try {
    const { buildProjectsLitePayload } = await import('../../../harness/projects-lite');
    const { hives } = await buildProjectsLitePayload();
    const group = hives.find((g) => g.members.some((m) => m.slug === slug));
    return group?.root.slug ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the hive HOME for `slug` when slug is a MEMBER of a multi-harness
 * hive (P-007). Returns null for a standalone harness, the home itself, or on
 * any failure (inheritance silently off). Exported for tests.
 */
export async function hiveHomeOf(slug: string): Promise<string | null> {
  const root = await hiveGroupRootOf(slug);
  return root && root !== slug ? root : null;
}

/**
 * Does this install OWN the hive whose home is `homeSlug`? A
 * `harness_shared.pots` row exists ONLY for locally-created hives (the
 * keypair'd creator) — a JOINED remote hive gets a registry `remote_hive`
 * view, no row, no keypair. Best-effort false on error.
 */
async function isOwnedHiveHome(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  homeSlug: string,
): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 FROM harness_shared.pots
       WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${homeSlug}
       LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The role-grant precedence (P-008 / D-003), pure + exported for tests:
 *   explicit per-harness row (ANY value — the kill switch)
 *   > hive OWNERSHIP (claiming the hive confers the role on home + members)
 *   > home-row inheritance (D-002)
 *   > default off.
 * auto_review/auto_merge never inherit or auto-grant on any path.
 */
export function resolveRoleSource(opts: {
  hasExplicitRow: boolean;
  ownsHome: boolean;
  homeRoleEnabled: boolean;
}): 'explicit' | 'ownership' | 'inherited' | 'none' {
  if (opts.hasExplicitRow) return 'explicit';
  if (opts.ownsHome) return 'ownership';
  if (opts.homeRoleEnabled) return 'inherited';
  return 'none';
}

// ─── Shared identity resolution ───────────────────────────────────

async function viewer(): Promise<{ id: number; login: string } | null> {
  try {
    const r = await resolveLocalGithubIdentity();
    return r.kind === 'ok' ? { id: r.githubUserId, login: r.githubLogin } : null;
  } catch {
    return null;
  }
}

// ─── Shared response builder (route GET handler + prReviewerSettings.byHarness
//     named query, all-active-surfaces-data-sync-migration-2026-07-11 P-011) ──

/**
 * Build the full `PrReviewerSettingsResponse` for `slug` — the viewer-scoped
 * settings, trust list, and audit log. Shared by the GET route handler and
 * the `prReviewerSettings.byHarness` sync-resolver entry so the two paths
 * never drift. Identity resolution is server-local (`resolveLocalGithubIdentity`)
 * and takes no client input, so it is equally safe to call from either caller.
 */
export async function buildPrReviewerSettingsResponse(slug: string): Promise<PrReviewerSettingsResponse> {
  const workspaceId = activeWorkspaceId();
  const v = await viewer();
  const now = Date.now();

  try {
    const { sql } = getOrgPg();

    // Settings are per-viewer; with no viewer id, return the safe defaults
    // (all-off) read-only.
    const githubUserId = v?.id ?? 0;
    let settingsRow: PrReviewerSettingsRow = defaultPrReviewerSettings({
      harness_slug: slug,
      github_user_id: githubUserId,
      now,
    });
    let inheritedFrom: string | null = null;
    let grantedByOwnership = false;
    if (v) {
      const rows = (await sql`
        SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at
          FROM harness_shared.pr_reviewer_settings
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${slug}
           AND github_user_id = ${v.id}
         LIMIT 1
      `) as unknown as SettingsDbRow[];
      settingsRow = dbRowToSettings(rows[0], slug, v.id, now);
      // No explicit row → the layered grant (P-007 D-002 + P-008 D-003):
      // OWNERSHIP of the hive confers the role on the home and every member
      // (claiming the hive IS the reviewer mandate); else fall back to the
      // viewer's hive-HOME row (read-time inheritance). An explicit row —
      // any value — beats both (the kill switch). auto_review/auto_merge
      // never inherit or auto-grant on any path.
      if (!rows[0]) {
        const root = await hiveGroupRootOf(slug);
        const ownsHome = root ? await isOwnedHiveHome(sql, workspaceId, root) : false;
        const home = root && root !== slug ? root : null;
        let homeRoleEnabled = false;
        if (!ownsHome && home) {
          const homeRows = (await sql`
            SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at
              FROM harness_shared.pr_reviewer_settings
             WHERE workspace_id = ${workspaceId}
               AND harness_slug = ${home}
               AND github_user_id = ${v.id}
             LIMIT 1
          `) as unknown as SettingsDbRow[];
          homeRoleEnabled = !!homeRows[0]?.pr_reviewer_role_enabled;
        }
        const source = resolveRoleSource({ hasExplicitRow: false, ownsHome, homeRoleEnabled });
        if (source === 'ownership') {
          settingsRow = { ...settingsRow, pr_reviewer_role_enabled: true };
          grantedByOwnership = true;
          inheritedFrom = home; // null when slug IS the owned home
        } else if (source === 'inherited') {
          settingsRow = { ...settingsRow, pr_reviewer_role_enabled: true };
          inheritedFrom = home;
        }
      }
    }

    // Trust list — the entries THIS viewer trusts on this harness. Join
    // contributors for display logins (best-effort). With no viewer, empty.
    const trustList: TrustListEntry[] = [];
    if (v) {
      const trustRows = (await sql`
        SELECT t.trusted_github_user_id, t.trusted_at, c.github_username
          FROM harness_shared.trusted_authors t
          LEFT JOIN harness_shared.contributors c
            ON c.workspace_id = t.workspace_id
           AND c.github_user_id = t.trusted_github_user_id
         WHERE t.workspace_id = ${workspaceId}
           AND t.harness_slug = ${slug}
           AND t.trusted_by_github_user_id = ${v.id}
         ORDER BY t.trusted_at DESC
      `) as unknown as Array<{
        trusted_github_user_id: number | string;
        trusted_at: string | Date;
        github_username: string | null;
      }>;
      for (const r of trustRows) {
        trustList.push({
          trusted_github_user_id: Number(r.trusted_github_user_id),
          trusted_login: r.github_username ?? null,
          trusted_at: new Date(r.trusted_at).toISOString(),
        });
      }
    }

    // Recent audit — auto-review + auto-merge actions for this harness.
    // Not viewer-scoped: the audit log is per-machine and shows what
    // auto-actions THIS install took. Cap at 50 most-recent.
    const auditRows = (await sql`
      SELECT id, pr_number, pr_url, author_github_id, action, detail, ts
        FROM harness_shared.auto_review_audit
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
       ORDER BY ts DESC
       LIMIT 50
    `) as unknown as Array<{
      id: number | string;
      pr_number: number;
      pr_url: string | null;
      author_github_id: number | string | null;
      action: string;
      detail: string | null;
      ts: string | Date;
    }>;
    const audit: AuditEntry[] = auditRows.map((r) => ({
      id: Number(r.id),
      pr_number: Number(r.pr_number),
      pr_url: r.pr_url,
      author_github_id: r.author_github_id == null ? null : Number(r.author_github_id),
      action: r.action,
      detail: r.detail,
      ts: new Date(r.ts).toISOString(),
    }));

    // PR-3 §3: claimed-owner authority — the gate for editing auto-mode.
    const claimOwner = await isClaimedOwner(sql, workspaceId, slug, v?.id ?? null);
    return {
      settings: toToggles(settingsRow),
      trustList,
      audit,
      viewer: v ? { github_user_id: v.id, github_login: v.login } : null,
      editable: !!v,
      claimOwner,
      autoModeEditable: autoModeEditableFrom({ editable: !!v, claimOwner }),
      inheritedFrom,
      grantedByOwnership,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Missing schema / PG unreachable → safe-default read-only shape, not 500.
    if (/does not exist|relation .* does not exist/i.test(msg)) {
      return {
        settings: toToggles(
          defaultPrReviewerSettings({ harness_slug: slug, github_user_id: v?.id ?? 0, now }),
        ),
        trustList: [],
        audit: [],
        viewer: v ? { github_user_id: v.id, github_login: v.login } : null,
        editable: !!v,
        claimOwner: false,
        autoModeEditable: false,
      };
    }
    throw e;
  }
}

// ─── GET /harness/:slug/pr-reviewer-settings ──────────────────────

const getSettings = defineTool({
  method: 'GET',
  path: '/harness/:slug/pr-reviewer-settings',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const resp = await buildPrReviewerSettingsResponse(slug);
    return Response.json(resp);
  },
});

// ─── POST /harness/:slug/pr-reviewer-settings ─────────────────────

const postSettings = defineTool({
  method: 'POST',
  path: '/harness/:slug/pr-reviewer-settings',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const v = await viewer();
    if (!v) {
      return Response.json(
        { error: 'gh auth required to change PR-reviewer settings' },
        { status: 401 },
      );
    }
    const parsed = parseSettingsPatch(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const { sql } = getOrgPg();
    const now = Date.now();

    // PR-3 §3 (teeth): flipping AUTO-MODE (auto_review / auto_merge) requires
    // CLAIMED-OWNER authority. A non-owner's auto-mode change is refused (403)
    // — the GUI also renders the toggle read-only, but the server is the trust
    // boundary. The personal reviewer-role + merge_method are NOT gated here.
    if (patchTouchesAutoMode(parsed.patch)) {
      const claimOwner = await isClaimedOwner(sql, workspaceId, slug, v.id);
      if (!claimOwner) {
        return Response.json(
          {
            error:
              'Only the claimed owner of this harness can change auto-mode. Claim the harness to configure auto-apply.',
            code: 'NOT_CLAIMED_OWNER',
          },
          { status: 403 },
        );
      }
    }

    const existingRows = (await sql`
      SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at
        FROM harness_shared.pr_reviewer_settings
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
         AND github_user_id = ${v.id}
       LIMIT 1
    `) as unknown as SettingsDbRow[];
    const existing = dbRowToSettings(existingRows[0], slug, v.id, now);
    const merged = applyPrReviewerSettingsPatch(existing, parsed.patch, now);

    await sql`
      INSERT INTO harness_shared.pr_reviewer_settings
        (workspace_id, harness_slug, github_user_id,
         pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at)
      VALUES
        (${workspaceId}, ${slug}, ${v.id},
         ${merged.pr_reviewer_role_enabled}, ${merged.auto_review}, ${merged.auto_merge},
         ${merged.merge_method}, now())
      ON CONFLICT (workspace_id, harness_slug, github_user_id) DO UPDATE SET
        pr_reviewer_role_enabled = EXCLUDED.pr_reviewer_role_enabled,
        auto_review              = EXCLUDED.auto_review,
        auto_merge               = EXCLUDED.auto_merge,
        merge_method             = EXCLUDED.merge_method,
        updated_at               = now()
    `;

    // PR-1 (P-042): keep the `system:pr-poll` routine in lockstep with the reviewer
    // role. Enabling the role seeds + activates the per-harness poll daemon (notice
    // PR → review-trigger → auto-flow); disabling it deactivates the routine (the row
    // stays, so re-enabling restores cadence + last-seen). Best-effort — a routine
    // sync failure must never fail the settings write.
    try {
      if (merged.pr_reviewer_role_enabled) {
        const { seedPrPollRoutineForHarness } = await import('../../../pr-host/pr-poll-routine');
        await seedPrPollRoutineForHarness({ workspaceId, installSlug: slug, active: true }, { sql });
      } else {
        const { setPrPollRoutineActive } = await import('../../../pr-host/pr-poll-routine');
        await setPrPollRoutineActive(sql, slug, false);
      }
    } catch (e) {
      console.warn(
        `[pr-reviewer-settings] pr-poll routine sync failed for ${slug}: ${e instanceof Error ? e.message : e}`,
      );
    }

    return Response.json({ ok: true, settings: toToggles(merged) });
  },
});

// ─── POST /harness/:slug/pr-reviewer-settings/trust/remove ────────

const postTrustRemove = defineTool({
  method: 'POST',
  path: '/harness/:slug/pr-reviewer-settings/trust/remove',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const v = await viewer();
    if (!v) {
      return Response.json({ error: 'gh auth required to edit the trust list' }, { status: 401 });
    }
    const parsed = parseTrustRemoveBody(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const { sql } = getOrgPg();
    // Only the viewer's own trust entries are removable (trusted_by gate).
    await sql`
      DELETE FROM harness_shared.trusted_authors
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
         AND trusted_by_github_user_id = ${v.id}
         AND trusted_github_user_id = ${parsed.trustedId}
    `;
    return Response.json({ ok: true });
  },
});

export default [getSettings, postSettings, postTrustRemove];
