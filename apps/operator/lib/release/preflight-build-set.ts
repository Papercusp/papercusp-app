/**
 * preflight-build-set.ts — release-readiness-preflight-gate-2026-07-19 P-002.
 *
 * A PRE-FLIGHT architecture-invariant assert that runs in SECONDS, before the
 * multi-hour builds: the effective build ROLE SET for a real release cut must
 * cover every required desktop PRODUCT (gui AND server).
 *
 * WHY (the 0.0.12 failure this catches): on mac/win the GUI does NOT self-host —
 * it attaches to a separately-installed Papercusp Server bundle
 * (launch_bundle(com.papercusp.server); linux is being made to match, see
 * linux-desktop-split-server-like-mac-win-2026-07-19). A cut whose role set drops
 * `server` therefore ships a GUI with no Server to attach to. That is exactly what
 * a gui-only role set did to the *published* mac/linux Server product (D-004 of
 * this plan restored the default to BOTH roles after gui-only silently dropped
 * it). This gate ENFORCES that default so a real cut can never be configured
 * gui-only silently — it fails loudly, in seconds, instead of after a ~45-min
 * build + install + boot.
 *
 * The matrix of required products is the same single source of truth the record
 * path uses for its post-build completeness alert (release-completeness.ts /
 * WI-5515) — reused here, pre-build, against the intended role set.
 *
 * A DELIBERATE partial cut (fast-iteration gui-only) is still possible: set
 * PAPERCUSP_ALLOW_INCOMPLETE_ROLES=1 to turn the failure into a loud, conscious
 * warning (mirrors the WI-5515 "confirm the omission is intentional" pattern).
 *
 * NOTE (windows Server): whether the *Windows* Server is a PUBLISHED product is a
 * separate, currently-contested question (WI-5028/WI-5085: the Windows Server
 * output is spanned-Inno and record-release skips it). This gate deliberately does
 * NOT adjudicate that — it asserts the release-level role SET, not per-platform
 * publish policy. The build scripts decide per platform what to package from the
 * built roles.
 */
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { REQUIRED_DESKTOP_PRODUCTS, type RequiredDesktopProduct } from './release-completeness';

/** The role set a real (non-fast-iteration) release cut defaults to. */
export const RELEASE_DEFAULT_ROLES = 'gui server';

export interface BuildSetCheck {
  ok: boolean;
  /** Required products the role set does NOT cover. */
  missing: RequiredDesktopProduct[];
  /** The normalized roles that were checked. */
  roles: string[];
  /** True when `missing` is non-empty but the caller opted into a partial cut. */
  allowedIncomplete: boolean;
  /** Human-readable summary — the pass line, the failure block, or the override warning. */
  message: string;
}

/**
 * Parse a `PAPERCUSP_BUILD_ROLES`-style string ("gui server") into a normalized,
 * de-duplicated, lower-cased role list. Whitespace- or comma-separated; empty /
 * nullish → []. Unknown entries are preserved (the build scripts warn+skip them).
 */
export function parseBuildRoles(env: string | undefined | null): string[] {
  if (!env) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of env.split(/[\s,]+/)) {
    const r = raw.trim().toLowerCase();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * Assert a build role set covers every required desktop product. PURE.
 * `allowIncomplete` (fast-iteration opt-in) turns a miss into a passing warning.
 */
export function checkReleaseBuildSet(
  roles: string[],
  opts: { allowIncomplete?: boolean } = {},
): BuildSetCheck {
  const have = new Set(roles);
  const missing = REQUIRED_DESKTOP_PRODUCTS.filter((p) => !have.has(p));
  const rolesLabel = roles.length ? roles.join(' ') : '(empty)';

  if (missing.length === 0) {
    return {
      ok: true,
      missing: [],
      roles,
      allowedIncomplete: false,
      message: `build role set OK — covers all required products (${REQUIRED_DESKTOP_PRODUCTS.join(', ')}); roles = [${rolesLabel}]`,
    };
  }

  const missingLabel = missing.join(', ');
  if (opts.allowIncomplete) {
    return {
      ok: true,
      missing,
      roles,
      allowedIncomplete: true,
      message:
        `⚠ INCOMPLETE build role set (roles = [${rolesLabel}]) — missing required product(s): ${missingLabel}. ` +
        `PAPERCUSP_ALLOW_INCOMPLETE_ROLES is set, so this is a CONSCIOUS partial cut. ` +
        `A '${missingLabel}'-less cut ships a GUI with no Server to attach to on mac/win — publish only if intentional.`,
    };
  }

  return {
    ok: false,
    missing,
    roles,
    allowedIncomplete: false,
    message:
      `build role set is INCOMPLETE for a release: roles = [${rolesLabel}], missing required product(s): ${missingLabel}.\n` +
      `On mac/win the GUI attaches to a separately-installed Papercusp Server — a cut without '${missingLabel}' ships a dead GUI. ` +
      `Set PAPERCUSP_BUILD_ROLES="${RELEASE_DEFAULT_ROLES}" (the default), or PAPERCUSP_ALLOW_INCOMPLETE_ROLES=1 for a deliberate fast-iteration cut.`,
  };
}

/** CLI: read PAPERCUSP_BUILD_ROLES + PAPERCUSP_ALLOW_INCOMPLETE_ROLES, exit 0/1. */
export function runPreflightBuildSetCli(env: NodeJS.ProcessEnv = process.env): number {
  const roles = parseBuildRoles(env.PAPERCUSP_BUILD_ROLES ?? RELEASE_DEFAULT_ROLES);
  const allowIncomplete = env.PAPERCUSP_ALLOW_INCOMPLETE_ROLES === '1';
  const res = checkReleaseBuildSet(roles, { allowIncomplete });
  if (!res.ok) {
    console.error(`[preflight:build-set] ${res.message}`);
    return 1;
  }
  console.log(`[preflight:build-set] ${res.message}`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(runPreflightBuildSetCli());
}
