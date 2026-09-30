/**
 * enablePlatformMode — the opt-in "Papercusp inside Papercusp" enable flow
 * (per-hive-learning-loops-2026-06-14 P-071; D-006/D-007/D-008).
 *
 * When a user opts INTO platform mode, three things must happen — in order, each
 * best-effort + individually reported so a partial enable is visible, never silent:
 *
 *   1. FLIP the `PLATFORM_IMPROVEMENT_LOOPS` knob ON for THIS install (P-070's
 *      flag). The knob defaults ON in dev/self-host but OFF on a public release
 *      (PAPERCUSP_PLATFORM_MODE=off); opting in flips the PG-backed override so the
 *      Class-C layer-3 loops can materialize. This is the master switch — it must
 *      flip FIRST so step 3's materialization sees platform mode ON.
 *   2. STAND UP Papercusp's own repo as a self-managed SHARED Pot (kind:'hive',
 *      D-008) via the EXISTING `pot:create_from_repo` machinery — FETCH-ON-ENABLE
 *      from the public repo (D-007a: clone on toggle, do NOT bundle source). Because
 *      pot:create_from_repo → createPotHarness already runs the per-pot
 *      learning-loop provisioning (P-020 step 6c), the self-pot inherits its OWN
 *      gym + scout loop for free — this function does NOT re-provision it.
 *   3. ARM the layer-3 platform-improvement loops: materialize the Class-C
 *      workspace-singleton frontier/measurement loops (`materializeLearningSingletons`)
 *      — now that the flag is ON they actually get written instead of skipped. The
 *      improvement-watchdog/triage/implement set rides the same gate (seeded INACTIVE
 *      by default; the watchdog is the safe capture-only cadence the owner arms).
 *
 * Idempotent + re-runnable: an existing self-pot returns a JOIN OFFER from the
 * lookup (zero side effects), which we treat as "already standing" rather than an
 * error. The flag flip + singleton materialization are both upserts.
 *
 * SAFETY (P-073 / D-007): standing up the self-pot does NOT change the confinement
 * envelope. The platform loop on this install still respects the TCB / never-auto /
 * protected-path guards (classifyImprovement) and the autonomy ceilings — its blast
 * radius is THIS install; everything upstream is PR-/moderation-gated (P-072). This
 * function arms loops; it never relaxes a guard.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverride } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { createPotFromRepo, type CreatePotFromRepoResult } from '../agent-tools/pot/_create_from_repo';
import { materializeLearningSingletons } from '../blueprint/seed-learning-singletons';
import { loadHarnessRegistry } from '../harness-registry';

/**
 * The canonical public Papercusp repo (D-007a fetch-on-enable). This is the SAME
 * URL the cloud frame-bootstrap clones; standing it up as a kind:'hive' shared Pot
 * is exactly the "Papercusp inside Papercusp" relationship this dev workspace has.
 */
export const PAPERCUSP_CANONICAL_REPO_URL = 'https://github.com/Papercusp/papercup.git';

/** Default base slug for the self-pot — member `papercusp-platform`, home `papercusp-platform-pot`. */
export const PLATFORM_SELF_POT_SLUG = 'papercusp-platform';

export interface EnablePlatformModeInput {
  workspaceId?: string;
  sql?: Sql;
  /**
   * Override the canonical repo URL (tests / a fork-from). Default: the public
   * Papercusp repo. The self-pot is created with `visibility:'private'` so the
   * enable flow performs ZERO external publish writes — the install dogfoods
   * Papercusp locally; contribution is the separate, gated P-072 path.
   */
  repoUrl?: string;
  /** Override the self-pot base slug. Default `papercusp-platform`. */
  slug?: string;
  /**
   * Shallow-clone the (large) Papercusp repo. Default true — fetch-on-enable
   * wants the small download; the platform loop reads HEAD, not deep history.
   */
  shallow?: boolean;
  /**
   * Run the canonical repo's test command at create. Default FALSE — the same
   * hardening default pot:create_from_repo uses for a pasted URL (D-001): never
   * auto-execute repo code on enable. The owner verifies later if they wish.
   */
  runTests?: boolean;
  // ── injectable seams (real defaults below) — every external effect is a seam so
  //    the whole flow is unit-testable with no real flag store / clone / PG ──
  /** Flip the platform-improvement flag override. Default: setFlagOverride. */
  setFlag?: (
    key: typeof FLAGS.PLATFORM_IMPROVEMENT_LOOPS,
    enabled: boolean,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Stand up the self-pot. Default: createPotFromRepo. */
  createSelfPot?: (
    opts: Parameters<typeof createPotFromRepo>[0],
  ) => Promise<CreatePotFromRepoResult>;
  /** Arm the Class-C singletons. Default: materializeLearningSingletons. */
  armSingletons?: typeof materializeLearningSingletons;
  /**
   * WI-1293: check whether the dedicated `<slug>-pot` self-pot is ALREADY a
   * locally-registered `kind:'hive'` project. Default: a `loadHarnessRegistry`
   * read. Injectable seam for tests.
   */
  checkSelfPotRegistered?: (potSlug: string, workspaceId: string) => Promise<boolean>;
}

export interface EnablePlatformModeResult {
  ok: boolean;
  /** The platform-improvement flag was flipped ON (or already on). */
  flagEnabled: { ok: boolean; reason?: string };
  /** The self-pot stand-up outcome. */
  selfPot:
    | { ok: true; status: 'created'; potSlug: string; memberSlug: string }
    | { ok: true; status: 'already_standing'; detail: string }
    | { ok: false; status: 'failed'; error: string; message?: string };
  /** The layer-3 loop arming outcome (counts only — the full per-loop trail is large). */
  armedLoops:
    | { ok: true; materialized: number; skipped: number; names: string[] }
    | { ok: false; error: string };
  /** A one-line human summary of the enable. */
  summary: string;
}

/** Default `checkSelfPotRegistered` seam: is `<slug>-pot` already a locally
 *  registered `kind:'hive'` project in this workspace? (WI-1293) */
async function defaultSelfPotAlreadyRegistered(potSlug: string, workspaceId: string): Promise<boolean> {
  const reg = await loadHarnessRegistry(workspaceId);
  return reg.projects.some((p) => p.slug === potSlug && p.harness_kind === 'hive');
}

/**
 * Enable platform mode. ORDER MATTERS: flag first (so the singleton materialization
 * sees it ON), then the self-pot, then the loop arming. Each step is best-effort and
 * never throws — a partial enable is reported, not hidden, so the owner can re-run.
 */
export async function enablePlatformMode(
  input: EnablePlatformModeInput = {},
): Promise<EnablePlatformModeResult> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const sql = input.sql ?? getOrgPg().sql;
  const repoUrl = input.repoUrl ?? PAPERCUSP_CANONICAL_REPO_URL;
  const slug = input.slug ?? PLATFORM_SELF_POT_SLUG;
  const potSlug = `${slug}-pot`;
  const setFlag = input.setFlag ?? setFlagOverride;
  const createSelfPot = input.createSelfPot ?? createPotFromRepo;
  const armSingletons = input.armSingletons ?? materializeLearningSingletons;
  const checkSelfPotRegistered = input.checkSelfPotRegistered ?? defaultSelfPotAlreadyRegistered;

  // 1 — FLIP the master switch ON for this install (PG-backed override; works
  //     without PostHog). MUST precede the materialization so step 3 sees it ON.
  let flagEnabled: { ok: boolean; reason?: string };
  try {
    const r = await setFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, true);
    flagEnabled = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (e) {
    flagEnabled = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  // 2 — STAND UP the Papercusp self-pot (fetch-on-enable, D-007a). The install
  //     dogfoods locally against a DEDICATED, isolated clone (D-007a: never the
  //     live dev tree). The self-pot inherits its per-pot gym+scout loop from
  //     createPotHarness (P-020 step 6c) — we do NOT re-provision it here.
  //
  //     WI-1293: `createPotFromRepo`'s paste-URL lookup matches an existing
  //     Pot/harness by REPO IDENTITY (owner/repo, not the requested slug) — so
  //     on a box whose OWN dev harness already tracks this same canonical repo
  //     (this dev checkout itself is exactly such a harness), the lookup finds
  //     THAT unrelated binding first and short-circuits with
  //     `existing.kind:'legacy_shared_harness'` BEFORE the dedicated
  //     `<slug>-pot` self-pot is ever created. `contribute`'s
  //     `defaultResolveSelfPotMember` then can't find it (it requires an exact
  //     local `hive_slug === '<slug>-pot'` registration) and fails with
  //     `self_hive_not_found`. Guard on the ACTUAL local registration instead —
  //     unambiguous and slug-scoped — rather than trusting the generic
  //     repo-identity lookup: only when `<slug>-pot` is genuinely already a
  //     registered `kind:'hive'` project do we skip creation; otherwise force
  //     PAST any same-repo-different-slug match so the dedicated self-pot
  //     actually gets stood up.
  let selfPot: EnablePlatformModeResult['selfPot'];
  try {
    const alreadyRegistered = await checkSelfPotRegistered(potSlug, workspaceId);
    if (alreadyRegistered) {
      selfPot = { ok: true, status: 'already_standing', detail: 'platform_self_hive' };
    } else {
      const res = await createSelfPot({
        githubUrl: repoUrl,
        slug,
        shallow: input.shallow ?? true,
        runTests: input.runTests ?? false,
        workspaceId,
        force: true,
      });
      if (res.ok && 'created' in res) {
        selfPot = {
          ok: true,
          status: 'created',
          potSlug: res.created.potSlug,
          memberSlug: res.created.memberSlug,
        };
      } else if (res.ok && 'existing' in res) {
        // Defensive fallback only — the real `createPotFromRepo` seam never
        // returns `existing` once `force:true` is set (it always proceeds to
        // create, flagging `duplicateOf` instead); kept in case an injected
        // test double for `createSelfPot` ignores `force`.
        selfPot = {
          ok: true,
          status: 'already_standing',
          detail: res.existing.kind,
        };
      } else {
        selfPot = {
          ok: false,
          status: 'failed',
          error: (res as { error: string }).error,
          ...((res as { message?: string }).message ? { message: (res as { message?: string }).message } : {}),
        };
      }
    }
  } catch (e) {
    selfPot = { ok: false, status: 'failed', error: 'exception', message: e instanceof Error ? e.message : String(e) };
  }

  // 3 — ARM the layer-3 Class-C singletons. Now that the flag is ON (step 1), the
  //     materialization writes the @singleton rows instead of skipping them (the
  //     P-070 gate). Frontier loops seed DARK (owner arms each); the always-on
  //     loops seed active per their blueprint. Best-effort: a failure is reported.
  let armedLoops: EnablePlatformModeResult['armedLoops'];
  try {
    // If the flag flip failed we still attempt with an explicit ON resolver so a
    // missing PostHog backend (override-store-not-configured) does not block the
    // local enable — the user opted in; honor it for the materialization.
    const results = await armSingletons(sql, workspaceId, {
      execute: true,
      retireLegacy: false,
      flag: async () => true,
    });
    const acted = results.filter((r) => r.declaresSingleton && !r.skipped);
    const skipped = results.filter((r) => r.skipped).length;
    armedLoops = {
      ok: true,
      materialized: acted.length,
      skipped,
      names: acted.flatMap((r) => r.plannedNames),
    };
  } catch (e) {
    armedLoops = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const ok = flagEnabled.ok && selfPot.ok && armedLoops.ok;
  const summary = ok
    ? `Platform mode ENABLED: flag on, self-pot ${selfPot.ok && 'status' in selfPot ? selfPot.status : '?'}, ` +
      `${armedLoops.ok ? armedLoops.materialized : 0} layer-3 loop(s) armed (dark — arm via the gym/routines UI).`
    : `Platform mode PARTIALLY enabled — re-run: ` +
      `flag=${flagEnabled.ok ? 'on' : `FAILED(${flagEnabled.reason})`}, ` +
      `self-pot=${selfPot.ok ? 'ok' : `FAILED(${(selfPot as { error: string }).error})`}, ` +
      `loops=${armedLoops.ok ? 'armed' : `FAILED(${armedLoops.error})`}.`;

  return { ok, flagEnabled, selfPot, armedLoops, summary };
}
