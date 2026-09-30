/**
 * install-rubric-io — the REAL (git + network + resolver + seed) wiring for
 * installing a Cupboard rubric into the local rubric store
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004).
 *
 * The rubric sibling of install-template-io / install-plugin-io / install-blueprint-io:
 * the pure, DI-testable core stays in install-rubric-core.ts; this file wires the
 * real deps and returns a structured result. Never throws for an expected failure.
 *
 * ONE STRUCTURAL DIFFERENCE FROM EVERY OTHER INSTALLER, and it is the whole reason
 * this file is not a copy of install-template-io: for a template, landing the dir IS
 * the install — `templates:new-app` reads the store directly afterwards. A rubric is
 * not readable that way. A rubric IS a plan row (template='rubric' in
 * harness_shared.harness_plans) with ratify/trend/scorecard machinery keyed off the
 * DB, so a dir sitting in the user layer is INERT until it is seeded into the
 * workspace. Installing therefore has two steps, and reporting success after only
 * the first would be reporting a rubric that does not exist to `rubrics:list`,
 * `rubrics:get`, or any scorecard.
 *
 * The second step reuses the EXISTING seed (reseedRubricsAfterInstall → the same
 * pass as the boot seed), so no-clobber, the wedge reclaim and the content-drift
 * upgrade gate all apply unchanged — an install can never overwrite a rubric this
 * workspace has locally ratified.
 */
import {
  installRubricFromCupboardCore,
  InstallRubricError,
  type InstallRubricCoreResult,
} from './install-rubric-core';
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';

export interface InstallRubricFromCupboardInput {
  /** Resolve the mirror repo URL + listing_ref from the Cupboard listing. */
  listingId?: string;
  /** OR install a mirror repo directly (listingRef = the rubric subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Skip the post-install seed. Only for callers that will seed themselves (and
   *  for tests); the default two-step behaviour is what makes a rubric LIVE. */
  skipSeed?: boolean;
}

export interface InstallRubricOutcome extends InstallRubricCoreResult {
  /** Whether the installed dir was seeded into the workspace rubric store. False ⇒
   *  the dir is on disk but the rubric is not yet a live row (see `seedError`). */
  seeded: boolean;
  /** Why the seed did not run/complete, when `seeded` is false. */
  seedError?: string;
}

export type InstallRubricFromCupboardResult =
  | { ok: true; result: InstallRubricOutcome }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The ONE orchestrated path that installs a rubric from the Cupboard by listing id
 * OR direct github url, then makes it live.
 */
export async function installRubricFromCupboard(
  input: InstallRubricFromCupboardInput,
): Promise<InstallRubricFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';

  // The Worker's publish-time content pin (P-002): present ⇒ the install fetches
  // exactly that commit and refuses content-address-mismatch. Only a listing carries
  // one; a direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'rubric');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) {
    return { ok: false, status: 400, error: 'listingRef required (the rubric subdir)' };
  }

  let result: InstallRubricCoreResult;
  try {
    result = await installRubricFromCupboardCore(
      { githubUrl, listingRef, pin },
      cupboardGitDeps(),
    );
  } catch (e) {
    if (e instanceof InstallRubricError) {
      return { ok: false, status: e.status, error: e.message };
    }
    return {
      ok: false,
      status: 500,
      error: 'install failed',
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }

  if (input.skipSeed) return { ok: true, result: { ...result, seeded: false } };

  // The dir is on disk. A seed failure does NOT fail the install — the content is
  // correctly placed and a later rubrics read retries the pass (the seed re-arms
  // 'pending' on failure) — but it MUST be reported, because until it succeeds the
  // rubric is invisible to rubrics:list/get and to every scorecard.
  try {
    const { reseedRubricsAfterInstall } = await import('../rubrics');
    await reseedRubricsAfterInstall();
    return { ok: true, result: { ...result, seeded: true } };
  } catch (e) {
    return {
      ok: true,
      result: {
        ...result,
        seeded: false,
        seedError: e instanceof Error ? e.message.slice(0, 300) : String(e),
      },
    };
  }
}
