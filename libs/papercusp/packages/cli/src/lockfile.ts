/**
 * `papercusp.lock` — per-harness lockfile.
 *
 * Lives at ~/.papercusp/harnesses/<slug>/papercusp.lock.
 * Records every plugin pinned into the harness: user-installed plus transitive
 * `requires`. `recommends` are NOT in the lockfile until the user accepts them
 * (spec §14.9.7 — transitivity rule).
 *
 * The lockfile is the single source of truth for `papercusp run` to know which
 * plugins to load + verify retraction state against the registry on startup
 * (spec §14.9.6 — three retraction states map to three load behaviors).
 */
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { papercuspRoot } from './papercusp-root.ts';
const PAPERCUSP_ROOT = papercuspRoot();
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');

export interface LockEntry {
  /** Pinned semver (exact version that was installed). */
  version: string;
  /** Tarball SHA — lets future installs verify the bytes. */
  integrity: string;
  /** Marketplace `kind` discriminator at lock time. */
  kind: 'plugin' | 'template';
  /** Hash of the consent-record subset that was approved (P4 wires this). */
  grantedCapsHash: string | null;
  /** "user" if the user installed it directly, otherwise the slug of the plugin
   *  that pulled it in via `requires`. */
  requiredBy: string;
  /** ISO-8601 timestamp when the entry was first added. */
  addedAt: string;
}

export interface Lockfile {
  lockfileVersion: 1;
  harness: string;
  entries: Record<string, LockEntry>;
}

export function lockPath(harnessSlug: string): string {
  return join(HARNESSES_DIR, harnessSlug, 'papercusp.lock');
}

export async function readLock(harnessSlug: string): Promise<Lockfile> {
  const path = lockPath(harnessSlug);
  if (!existsSync(path)) {
    return { lockfileVersion: 1, harness: harnessSlug, entries: {} };
  }
  const raw = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Lockfile;
  if (parsed.lockfileVersion !== 1) {
    throw new Error(`unsupported lockfileVersion ${parsed.lockfileVersion} at ${path}`);
  }
  if (parsed.harness !== harnessSlug) {
    // Don't fail — just rewrite. Harness may have been renamed.
    parsed.harness = harnessSlug;
  }
  if (!parsed.entries) parsed.entries = {};
  return parsed;
}

export async function writeLock(lock: Lockfile): Promise<void> {
  const path = lockPath(lock.harness);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(lock, null, 2), 'utf8');
}

export async function addToLock(
  harnessSlug: string,
  slug: string,
  entry: LockEntry,
): Promise<void> {
  const lock = await readLock(harnessSlug);
  lock.entries[slug] = entry;
  await writeLock(lock);
}

export async function removeFromLock(harnessSlug: string, slug: string): Promise<void> {
  const lock = await readLock(harnessSlug);
  if (!lock.entries[slug]) return;
  delete lock.entries[slug];
  // Cascade: anything that lists this slug as `requiredBy` is now an orphan;
  // the caller decides whether to remove or not. We don't auto-cascade because
  // a transitive dep might still be wanted by the user directly later.
  await writeLock(lock);
}

/** Validate that everything in the lockfile is actually installed locally. */
export async function validateLockAgainstInstalled(
  harnessSlug: string,
): Promise<{ ok: boolean; missing: string[] }> {
  const lock = await readLock(harnessSlug);
  const globalDir = join(PAPERCUSP_ROOT, 'global-plugins');
  const missing: string[] = [];
  for (const [slug, entry] of Object.entries(lock.entries)) {
    const manifestPath = join(globalDir, slug, 'papercusp.json');
    if (!existsSync(manifestPath)) {
      missing.push(`${slug}@${entry.version}`);
      continue;
    }
    try {
      const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: string };
      if (m.version !== entry.version) {
        missing.push(`${slug}@${entry.version} (have ${m.version})`);
      }
    } catch {
      missing.push(`${slug}@${entry.version} (manifest unreadable)`);
    }
  }
  return { ok: missing.length === 0, missing };
}

// ─── Retraction-aware load (spec §14.9.6) ──────────────────────────────────

export type RetractionState = 'active' | 'deprecated' | 'withdrawn' | 'quarantined';

export interface RetractionStatus {
  slug: string;
  state: RetractionState;
  reason: string | null;
}

export interface RetractionCheckResult {
  status: 'ok' | 'warn' | 'block';
  notes: string[];        // human-readable lines for stderr
  blocked: string[];      // slugs that hard-fail
  warned: string[];       // slugs that produced warnings only
}

/**
 * For each lockfile entry, ask the registry for the package's retraction state.
 * Maps three registry states to three behaviors per spec §14.9.6:
 *   - deprecated  → log warn, proceed
 *   - withdrawn   → fail unless `allowWithdrawn === true`
 *   - quarantined → hard fail; refuse to start
 * Network failure is treated as a soft warn so an offline run isn't blocked.
 */
export async function checkRetractionStates(
  harnessSlug: string,
  registryUrl: string,
  opts: { allowWithdrawn?: boolean } = {},
): Promise<RetractionCheckResult> {
  const lock = await readLock(harnessSlug);
  const slugs = Object.keys(lock.entries);
  const result: RetractionCheckResult = { status: 'ok', notes: [], blocked: [], warned: [] };
  if (slugs.length === 0) return result;

  let statuses: RetractionStatus[] = [];
  try {
    const r = await fetch(
      `${registryUrl}/v1/installed-status?slugs=${encodeURIComponent(slugs.join(','))}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!r.ok) {
      result.notes.push(
        `retraction check skipped: registry returned HTTP ${r.status} (run will proceed)`,
      );
      return result;
    }
    const body = (await r.json()) as {
      packages: Array<{ slug: string; retracted: RetractionState; reason: string | null }>;
    };
    statuses = body.packages.map((p) => ({
      slug: p.slug,
      state: p.retracted ?? 'active',
      reason: p.reason ?? null,
    }));
  } catch (e: any) {
    result.notes.push(
      `retraction check skipped: registry unreachable (${e?.message ?? 'unknown'}); run will proceed`,
    );
    return result;
  }

  for (const s of statuses) {
    if (s.state === 'active') continue;
    const reason = s.reason ? ` — ${s.reason}` : '';
    if (s.state === 'deprecated') {
      result.notes.push(`[deprecated] ${s.slug}${reason}`);
      result.warned.push(s.slug);
      if (result.status === 'ok') result.status = 'warn';
    } else if (s.state === 'withdrawn') {
      if (opts.allowWithdrawn) {
        result.notes.push(`[withdrawn] ${s.slug}${reason} — overridden by --allow-withdrawn`);
        result.warned.push(s.slug);
        if (result.status === 'ok') result.status = 'warn';
      } else {
        result.notes.push(
          `[withdrawn] ${s.slug}${reason} — re-pin via \`papercusp upgrade-pin ${s.slug}\` ` +
            `or pass --allow-withdrawn`,
        );
        result.blocked.push(s.slug);
        result.status = 'block';
      }
    } else if (s.state === 'quarantined') {
      result.notes.push(
        `[QUARANTINED] ${s.slug}${reason} — refuse to start. ` +
          `Upgrade/replace this plugin before re-running.`,
      );
      result.blocked.push(s.slug);
      result.status = 'block';
    }
  }
  return result;
}
