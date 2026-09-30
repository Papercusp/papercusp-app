/**
 * generation-watermark.ts — named GENERATION watermarks for evidence windows
 * (rubric-system-hardening-2026-07-14 P-002, EI-12148).
 *
 * The motivating defect: the scout bg-host is a LONG-LIVED process, so "the fix is
 * deployed on disk" and "the fix is what's running" diverge until the host restarts —
 * and the release instrument (blender:success-metrics) judged a fixed system FAIL for
 * up to 48h on errors the PRE-fix generation emitted (9.0% reported while the true
 * post-restart rate was 0/8, 2026-07-14). The host's ActiveEnterTimestamp IS the
 * generation boundary: everything at/after it was produced by the code currently
 * running. This module resolves that boundary as a named watermark
 * ({@link BG_HOST_RESTART_WATERMARK}) so instruments can judge "the running
 * generation" instead of a fixed look-back that straddles a restart.
 *
 * Split like every scout instrument: a PURE parser ({@link parseSystemdTimestamp},
 * unit-tested) + a thin IO edge ({@link readBgHostActiveEnterMs}, one systemctl exec).
 * Resolution DEGRADES to null (host not running / no systemd / non-Linux) — the caller
 * decides whether that is a loud error (an explicitly requested watermark, the
 * blender:success-metrics arg) or a provenance-tagged fallback (a rubric-declared
 * window, resolveCriterionWindow's 'watermark-unresolved').
 */
import { execFile } from 'node:child_process';

import { getBuildInfo } from '../build-info';

/** The named watermark: the running scout bg-host generation's start instant. */
export const BG_HOST_RESTART_WATERMARK = 'bg-host-restart';

/** The systemd user unit hosting the scout loop (the long-lived generation). */
export const BG_HOST_UNIT = 'papercup-bg-host.service';

/** Watermark refs this module can resolve (the vocabulary the tool arg documents). */
export const KNOWN_WATERMARK_REFS: readonly string[] = [BG_HOST_RESTART_WATERMARK];

/**
 * PURE: parse a systemd `show -p <TimestampProp> --value` string → epoch-ms.
 * Read with TZ=UTC the value is `Tue 2026-07-14 18:08:24 UTC`; an inactive/never-started
 * unit yields `` or `n/a`. Returns null on anything unparseable — never throws.
 */
export function parseSystemdTimestamp(value: string | null | undefined): number | null {
  const v = (value ?? '').trim();
  if (!v || v === 'n/a') return null;
  // Canonical: [Dow ]YYYY-MM-DD HH:MM:SS ZONE. Parse the date+time explicitly and trust
  // the zone token only when it is UTC (we exec with TZ=UTC, so this is the normal path);
  // otherwise fall back to Date.parse of the raw string (V8 handles US zone abbrevs).
  const m = v.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s+(\S+))?/);
  if (m) {
    const [, date, time, zone] = m;
    if (!zone || zone === 'UTC' || zone === 'GMT' || zone === 'Z') {
      const ms = Date.parse(`${date}T${time}Z`);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * IO edge: the running bg-host generation's start instant (epoch-ms), or null when it
 * cannot be determined (unit not running, no systemd user session, non-Linux, timeout).
 * One short-lived `systemctl --user show` exec with TZ=UTC so the timestamp parses
 * deterministically regardless of the host's local zone.
 */
export function readBgHostActiveEnterMs(unit: string = BG_HOST_UNIT): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ActiveEnterTimestamp', '--value'],
      { env: { ...process.env, TZ: 'UTC' }, timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseSystemdTimestamp(stdout));
      },
    );
  });
}

/**
 * The RUNNING generation, as a stampable identity (EI-12147, P-003/P-007; reworked
 * WI-5397 to stop LYING about what it measures).
 *
 * The founding defect (WI-5397): the old `sha` field named itself as "the code the
 * scout host is running" but was really {@link getBuildInfo}'s sha — the QUERYING
 * process's own build (PAPERCUSP_BUILD_SHA at deploy, else a rev-parse of ITS OWN
 * tree). The scout bg-host is a SEPARATE, long-lived process that runs `npx tsx
 * bin/hono-host.ts` directly against the shared STAGING WORKING TREE (no bundling, no
 * file-watch — see CLAUDE.md § two-port model) — a tree continuously edited unstaged
 * by the whole fleet. So a deploy landing on the QUERYING process (typically :3070,
 * restarted every deploy) flipped `sha` to the new code with ZERO relation to whether
 * bg-host itself had ever restarted to load it — the exact false "the fix is live"
 * signal WI-5397 was filed over. Verified live 2026-07-18: `sha` moved between two
 * queries 28 minutes apart with `hostStartedAt` unchanged (same bg-host process, no
 * restart) — proof the field named the wrong process's identity.
 *
 * The new shape reports what is ACTUALLY measured and makes staleness explicit
 * instead of papering over it:
 *  - `deployedSha` — the QUERYING process's own build sha (was `sha`; renamed for
 *    honesty — this is NOT necessarily what the scout loop is executing).
 *  - `hostStartedAt` — the bg-host's ActiveEnterTimestamp (ISO), via systemd. The one
 *    field with strong ground truth: when the long-lived scout process last (re)started.
 *  - `bootHeadSha` — the shared staging tree's HEAD sha AS OF `hostStartedAt`,
 *    reconstructed via {@link resolveStagingHeadAsOf} (a retroactive `git log
 *    --before` query — no boot-time write needed, since this is answerable purely
 *    from git history + the systemd timestamp). Null when unresolvable.
 *  - `scoutCodeHash` — the scout ideation code's CONTENT identity, as stamped by
 *    bg-host itself on its own tick ledger rows (see ./scout-code-identity.ts +
 *    ./tick-ledger.ts's readNewestScoutCodeHash) — the PRECISE signal, since a git
 *    sha alone cannot distinguish "the tree moved on" from "the code that matters
 *    changed" on a continuously-edited working tree. Null until bg-host has recorded
 *    at least one tick since restart (or when `hostStartedAt` itself is unresolvable —
 *    no generation boundary to attribute a stamp to).
 *  - `staleHost` — true unless we have POSITIVE evidence the running scout loop is
 *    executing `deployedSha`'s code (bootHeadSha resolved AND equals deployedSha).
 *    Fails toward "not proven fresh", never toward a false all-clear — an unresolved
 *    bootHeadSha reports staleHost:true, not false.
 *
 * Every leg is best-effort — a stamp must never fail the capture it rides on.
 */
export interface RunningGeneration {
  deployedSha: string | null;
  hostStartedAt: string | null;
  bootHeadSha: string | null;
  scoutCodeHash: string | null;
  staleHost: boolean;
}

/** The staging tree root git history is read against — see capability/base-dir.ts's
 *  IDENTICAL resolution order (this module deliberately mirrors it rather than
 *  importing across the agent-tools/scout layer boundary). Empty/whitespace treated
 *  as unset. */
function resolveStagingRoot(): string {
  const env = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  return env || process.cwd();
}

/**
 * IO edge: reconstruct the staging tree's HEAD sha AS OF a given instant via `git log
 * -1 --before=<iso>` — a PURELY RETROACTIVE git-history query, so no boot-time write
 * is needed to answer "what commit was HEAD when bg-host started" even though bg-host
 * itself never persists anything at boot. Null on any failure (no git, not a repo,
 * unparseable output, timeout) — never throws.
 */
export function resolveStagingHeadAsOf(atIso: string, opts: { cwd?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', '-1', `--before=${atIso}`, '--format=%H'],
      { cwd: opts.cwd ?? resolveStagingRoot(), timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const sha = stdout.trim();
        resolve(/^[0-9a-f]{7,40}$/i.test(sha) ? sha : null);
      },
    );
  });
}

/**
 * IO edge: the RUNNING scout generation's ledger-stamped code identity — the newest
 * `detail.scoutCodeHash` bg-host stamped on a scout tick AT/AFTER the generation
 * boundary (`sinceMs` = hostStartedAt). The tick ledger IS the cross-process channel
 * (WI-5397, {@link ./tick-ledger}'s readNewestScoutCodeHash): the querying process
 * must never report its OWN module hash here — bg-host is a separate process, so a
 * local `currentScoutCodeHash()` read names the wrong process's code (null in a
 * bundled build, or worse, the querying tree's hash presented as the scout's). Null
 * when the boundary is unresolvable, when no tick has stamped a hash since it, or on
 * any read failure/timeout — best-effort, never throws.
 */
export async function readScoutGenerationCodeHash(
  sinceMs: number | null,
  deps: { readNewestScoutCodeHash?: (opts: { sinceMs: number }) => Promise<string | null> } = {},
): Promise<string | null> {
  if (sinceMs == null) return null;
  const read = (async () => {
    const readFn = deps.readNewestScoutCodeHash ?? (await import('./tick-ledger')).readNewestScoutCodeHash;
    return readFn({ sinceMs });
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), 5_000);
    t.unref?.();
  });
  return Promise.race([read, timeout]);
}

/** Read the running generation's identity. Never throws; each leg degrades to null
 *  (staleHost still resolves to a real boolean — see {@link RunningGeneration}). */
export async function readRunningGeneration(): Promise<RunningGeneration> {
  const ms = await readBgHostActiveEnterMs().catch(() => null);
  const hostStartedAt = ms != null ? new Date(ms).toISOString() : null;
  let deployedSha: string | null = null;
  try {
    deployedSha = getBuildInfo().sha;
  } catch {
    deployedSha = null;
  }
  const bootHeadSha = hostStartedAt ? await resolveStagingHeadAsOf(hostStartedAt).catch(() => null) : null;
  const scoutCodeHash = await readScoutGenerationCodeHash(ms);
  // staleHost fails toward "not proven fresh": false ONLY when both shas resolved AND
  // match (a full sha vs a shortened one is still a match via prefix comparison —
  // getBuildInfo() commonly yields a short `--short HEAD`, while resolveStagingHeadAsOf
  // always returns the full 40-char sha).
  const staleHost = !(deployedSha != null && bootHeadSha != null && shaMatches(deployedSha, bootHeadSha));
  return { deployedSha, hostStartedAt, bootHeadSha, scoutCodeHash, staleHost };
}

/** Two shas "match" when equal, or one is a prefix of the other (a short sha vs the
 *  full 40-char form). Case-insensitive. */
function shaMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export type WatermarkResolution = { ok: true; ms: number } | { ok: false; error: string };

/**
 * Resolve a named watermark ref → epoch-ms, with a TEACHING error for the two distinct
 * failure shapes: an UNKNOWN ref (caller typo / not in the vocabulary) vs a known ref
 * that is currently UNRESOLVABLE (the generation boundary genuinely can't be read —
 * judging "post-watermark" would be judging an unknown window, so the caller must not
 * silently substitute one).
 */
export async function resolveWatermarkRef(ref: string): Promise<WatermarkResolution> {
  if (ref !== BG_HOST_RESTART_WATERMARK) {
    return {
      ok: false,
      error: `unknown watermarkRef '${ref}' — known refs: ${KNOWN_WATERMARK_REFS.join(', ')}`,
    };
  }
  const ms = await readBgHostActiveEnterMs();
  if (ms === null) {
    return {
      ok: false,
      error:
        `watermark '${ref}' did not resolve: ${BG_HOST_UNIT} is not running under systemd --user ` +
        '(or its ActiveEnterTimestamp is unreadable). Pass an explicit sinceMs, or omit both for the default window.',
    };
  }
  return { ok: true, ms };
}

// ───────────────────────────────────────────────────────────────────────────
// Generation FRESHNESS (WI-5277) — has the generation this evidence graded ENDED?
// ───────────────────────────────────────────────────────────────────────────

/**
 * The verdict of comparing evidence's STAMPED generation boundary against the boundary
 * running RIGHT NOW.
 *
 * ⚠ This is NOT {@link RunningGeneration.staleHost}, and confusing the two is what let
 * WI-5277 survive a year of near-misses. `staleHost` is computed AT STAMP TIME and then
 * frozen into the row forever: it answers *"was the scout provably executing
 * `deployedSha`'s code at the moment this was graded"*. `GenerationFreshness` answers a
 * question **no stored field can ever answer** — *"has that generation ended since?"* —
 * because it requires reading the live boundary at READ time. A row can carry
 * `staleHost: false` (proven fresh when graded) and still be `stale` here; that is
 * exactly the 2026-07-17 incident this exists for, where a 4.5h soak and a 6/6 scorecard
 * were voided by a bg-host restart three minutes after they were emitted.
 *
 * Fails toward NOT-PROVEN-FRESH in every ambiguous case, mirroring `staleHost`'s own
 * convention: `fresh` is reported ONLY on a positive match of two resolved boundaries.
 */
export type GenerationFreshness =
  | { status: 'fresh'; gradedHostStartedAt: string; liveHostStartedAt: string }
  | { status: 'stale'; gradedHostStartedAt: string; liveHostStartedAt: string; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * PURE: compare a stamped generation boundary against the live one.
 *
 * `gradedHostStartedAt` is the ISO boundary carried on the evidence (a scorecard's
 * `gradedGeneration.hostStartedAt`); `liveHostStartedAtMs` is the boundary running now
 * (from {@link readBgHostActiveEnterMs}, whose epoch-ms is the SAME source the stamp was
 * derived from, so an unchanged generation compares exactly equal).
 *
 * Kept pure + IO-free so the decision is testable without systemd and so a caller can
 * resolve the live boundary ONCE and judge many rows against it.
 */
export function compareGenerationFreshness(
  gradedHostStartedAt: string | null | undefined,
  liveHostStartedAtMs: number | null,
): GenerationFreshness {
  if (typeof gradedHostStartedAt !== 'string' || !gradedHostStartedAt.trim()) {
    return {
      status: 'unknown',
      reason:
        'this evidence carries no generation boundary (a pre-stamp row, or hostStartedAt was ' +
        'unresolvable when it was graded) — freshness cannot be judged, so it must not be read as fresh',
    };
  }
  const gradedMs = Date.parse(gradedHostStartedAt);
  if (!Number.isFinite(gradedMs)) {
    return {
      status: 'unknown',
      reason: `the stamped generation boundary '${gradedHostStartedAt}' is not a parseable timestamp`,
    };
  }
  if (liveHostStartedAtMs == null) {
    return {
      status: 'unknown',
      reason:
        `the LIVE ${BG_HOST_UNIT} generation boundary is unreadable, so this evidence's generation ` +
        'can be neither confirmed nor refuted',
    };
  }
  const liveHostStartedAt = new Date(liveHostStartedAtMs).toISOString();
  if (liveHostStartedAtMs === gradedMs) {
    return { status: 'fresh', gradedHostStartedAt, liveHostStartedAt };
  }
  if (liveHostStartedAtMs > gradedMs) {
    return {
      status: 'stale',
      gradedHostStartedAt,
      liveHostStartedAt,
      reason:
        `${BG_HOST_UNIT} restarted at ${liveHostStartedAt}, ending the generation that began ` +
        `${gradedHostStartedAt} — the generation this evidence measured no longer exists`,
    };
  }
  // live < graded: the stamp claims a boundary NEWER than the running one. Impossible for
  // a single healthy host — clock skew, a restored row, or a stamp made against a
  // different machine. "Not proven fresh" is the only safe reading; never report fresh.
  return {
    status: 'unknown',
    reason:
      `the stamped generation boundary ${gradedHostStartedAt} is NEWER than the live one ` +
      `(${liveHostStartedAt}) — clock skew or a stamp from a different host; freshness cannot be established`,
  };
}
