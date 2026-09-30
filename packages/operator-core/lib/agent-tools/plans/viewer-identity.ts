/**
 * viewer-identity — resolve the current viewer's plan-OWNER identity (their
 * email) for the plans list "my / others' / all" saved views
 * (shared-hive-collaboration-2026-06-14 P-002).
 *
 * A plan's `owner` frontmatter is an email (plans/new.ts: `z.string().email()`).
 * The local `git config user.email` IS that identity on a user's machine — it is
 * exactly what a human stamps as a plan's owner — so "my plans" = plans whose
 * `owner` equals the viewer's git email. This generalizes per-machine in a shared
 * hive (each peer's git email is their own) without any github-API round-trip.
 *
 * Resolved ONCE per process (it ~never changes mid-run) and fail-soft: if git
 * isn't configured (e.g. a deployed frame), it returns null and the UI degrades
 * — the "mine / others" views hide and the raw owner dropdown still works.
 *
 * NOTE (P-001 / Brief A coupling): once verified github identity lands on plan
 * rows (shared-hive-trust-admission verified_author), this can additionally key
 * "mine" on the github id for robustness across a user's multiple emails. Today
 * it keys on the git email, which matches the live plan-owner corpus.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);

let cached: Promise<string | null> | undefined;

async function resolveGitEmail(): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['config', 'user.email'], { timeout: 3000 });
    const email = stdout.trim().toLowerCase();
    return email.length > 0 ? email : null;
  } catch {
    // git absent / unconfigured (deployed frame) → no viewer identity; the UI
    // degrades gracefully (mine/others hidden, raw owner filter unaffected).
    return null;
  }
}

/**
 * The current viewer's plan-owner email (lowercased), or null when it can't be
 * resolved. Cached per process. `git config user.email` reads local-then-global
 * config, so it is the user's identity on their own machine.
 */
export async function getViewerOwnerEmail(): Promise<string | null> {
  cached ??= resolveGitEmail();
  return cached;
}

/** Test seam: drop the cache so the next call re-resolves. */
export function __resetViewerIdentityForTests(): void {
  cached = undefined;
}
