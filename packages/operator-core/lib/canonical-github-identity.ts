/**
 * canonical-github-identity — the ONE place that names Papercusp's public
 * GitHub org + canonical repo, plus the maintainer's personal login.
 *
 * WHY THIS FILE EXISTS (WI-4978): the canonical repositories live under the
 * `Papercusp` GitHub **Organization** (created 2026-05-28); `papercupai` is a
 * GitHub **User** account (created 2026-04-25, the maintainer's personal
 * admin login) with active admin membership *in* that org. The two are
 * related but distinct identities — a GitHub user cannot itself be an "org",
 * so any check/doc/link that treats `papercupai` as if it owned the product
 * repos is describing something that does not exist and will 404 (owner
 * confusion after the 2026-07-15 public-library rollout: at least one
 * owner-facing "Open a GitHub issue" link pointed at
 * `github.com/papercupai/papercusp`, a repo that has never existed — the
 * canonical remote is `github.com/Papercusp/papercup`).
 *
 * Canonical rule of thumb: when the CANONICAL REPO/ORG is meant, it's
 * `Papercusp`; when a PERSONAL admin-login/profile is specifically meant,
 * it's `papercupai`. Every owner-facing GitHub link (issue tracker, "open an
 * issue", top-nav "GitHub" link, …) should resolve through the constants
 * below rather than a hand-typed literal, so this can't drift again — see
 * `github-identity-drift.test.ts`, which fails the build if a new hardcoded
 * `github.com/papercupai/<repo>` link is introduced anywhere in the tree.
 *
 * Kept free of Node/server imports (mirrors the `agent-config-constants.ts`
 * pattern) so client bundles (operator-vite, the Next app) can import it
 * without dragging in server-only code.
 */

/** The GitHub Organization that owns the canonical Papercusp repositories. */
export const GITHUB_ORG = 'Papercusp';

/** The canonical monorepo's name under `GITHUB_ORG` (matches `git remote get-url origin`). */
export const GITHUB_REPO = 'papercup';

/** `<org>/<repo>` slug for the canonical monorepo. */
export const GITHUB_REPO_SLUG = `${GITHUB_ORG}/${GITHUB_REPO}`;

/** The canonical monorepo's GitHub URL. */
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`;

/** The canonical monorepo's issue tracker. */
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

/** "Open a new issue" deep link against the canonical monorepo. */
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_ISSUES_URL}/new`;

/**
 * The maintainer's personal GitHub User login — a person, NOT an org. Use
 * ONLY when a personal/admin-login identity is specifically meant (e.g. an
 * explanatory note); never as the owner segment of a product repo URL.
 */
export const GITHUB_MAINTAINER_LOGIN = 'papercupai';

/** The maintainer's personal GitHub profile URL. */
export const GITHUB_MAINTAINER_PROFILE_URL = `https://github.com/${GITHUB_MAINTAINER_LOGIN}`;
