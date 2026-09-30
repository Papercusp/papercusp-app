/**
 * visibleHarnessesForViewer — the §18 privacy-filter SEAM for the user
 * profile (P-072b).
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-072b/c/d real-data follow-up).
 *
 * ─── SHARED VIEWER-IDENTITY GAP (flagged, not silently dropped) ─────────
 * The live `/adv` shell has NO viewer-identity resolution yet — the same
 * gap that blocks P-038's write path and the P-048/P-072 viewer-specific
 * surfaces. Until that infra lands, callers pass `viewerGithubUserId =
 * null` (an anonymous viewer) and this seam returns ONLY the
 * shared-public (and missing-binding) harnesses — never leaking
 * shared-private rows. When the real viewer identity arrives, pass it
 * here and the membership-unlock path (below) drops in unchanged.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Visibility rule (per Q-2 / §18 invariants):
 *   - A `shared-public` harness is always visible.
 *   - A harness with NO binding row is visible (default-visible — better
 *     to surface a real contributor's harness than silently drop it when
 *     the binding cache is sparse / ensure hasn't run).
 *   - A `shared-private` harness is visible only when the viewer:
 *       (a) IS the profile subject (you always see your own), OR
 *       (b) is a member of that harness (contributor row exists).
 *
 * PURE: no PG access. The caller fetches the binding rows + the viewer's
 * harness membership and feeds them in; this function just applies the
 * rule. That keeps it unit-testable and keeps the real-viewer-identity
 * wiring a one-line change at the call site, not a rewrite here.
 */

export interface HarnessVisibilityInfo {
  harness_slug: string;
  /** `shared-public` | `shared-private`; undefined when no binding row. */
  privacy?: string;
}

export interface VisibleHarnessesOpts {
  /** The profile subject's github_user_id. */
  subjectGithubUserId: number;
  /**
   * The viewer's github_user_id, or null for an anonymous viewer (the
   * current default — see the shared viewer-identity gap above).
   */
  viewerGithubUserId: number | null;
  /** Per-harness privacy info (from shared_repo_binding_cache). */
  harnesses: ReadonlyArray<HarnessVisibilityInfo>;
  /**
   * Harness slugs the viewer is a member of (contributor rows for the
   * viewer). Only consulted to unlock shared-private rows. Empty for an
   * anonymous viewer.
   */
  viewerMembership: ReadonlySet<string>;
}

/** PURE: filter a list of harness slugs to those the viewer may see. */
export function visibleHarnessesForViewer(
  opts: VisibleHarnessesOpts,
): HarnessVisibilityInfo[] {
  const { subjectGithubUserId, viewerGithubUserId, viewerMembership } = opts;
  const viewerIsSubject =
    viewerGithubUserId != null && viewerGithubUserId === subjectGithubUserId;
  return opts.harnesses.filter((h) => {
    const privacy = h.privacy;
    // Missing binding row → default-visible.
    if (privacy == null) return true;
    if (privacy === 'shared-public') return true;
    // shared-private from here on.
    if (viewerIsSubject) return true;
    return viewerMembership.has(h.harness_slug);
  });
}
