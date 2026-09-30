#!/usr/bin/env npx tsx
/**
 * release-site-delta — publish only what CHANGED on the releases site.
 * (WI-10003694; absorbs the upload half filed as WI-10003625.)
 *
 * [owner 2026-09-28 #819/#820] "cant we improve our system so that we can skip the full
 *  build if we are changing the instructions only?" / "or other surface change?"
 *
 * THE COST THIS REMOVES. The site is ~29k files / ~2 GB: one page per shipped plan and per
 * shipped work item. Before this module EVERY publish, whatever had changed:
 *   • re-ran the identity gate over every byte (measured 2026-09-28: 5+ min, CPU-bound), and
 *   • re-uploaded every page, because a regenerate rewrote every file's mtime and
 *     `aws s3 sync` uploads on a newer mtime (measured 2026-09-28: 28,199 pages at ~15 files/s,
 *     ~31 min, for pages byte-identical to what was already live).
 * So a one-paragraph edit to the Instructions cost the same as a full release.
 *
 * THE MECHANISM. A publish MANIFEST — relative path → sha256 of the bytes the host now serves —
 * written only AFTER a publish verified its public read path. The next publish hashes the local
 * site (seconds), uploads only paths whose hash differs, deletes only mirrored pages that
 * disappeared, and gates only what it uploads. The generator side (`writeIfChanged`) keeps
 * unchanged pages byte-for-byte and mtime-for-mtime, so even the full-publish path's
 * `aws s3 sync` skips them.
 *
 * ⛔ THE INVARIANT THIS MUST NOT WEAKEN: every byte that reaches the host has been through the
 * identity gate. A path that is not uploaded now was gated when it WAS uploaded — unless the
 * identity RULES changed since, which is why the manifest carries a gate fingerprint (the
 * resolved identity literals plus the source of the scrub and of the gate). When it differs,
 * the gate re-scans the whole site even though only the delta is uploaded.
 *
 * Whenever the previous state is unknowable — no manifest, a different bucket/prefix, an
 * unreadable or foreign-schema manifest, or an explicit FULL=1 — it falls back to the full
 * publish, which is exactly the pre-existing behaviour. Incremental is an optimisation that
 * must be provably safe; full is the default whenever it is not.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { describeOwnerIdentityLoad, loadOwnerIdentityEnv } from './owner-identity-env';
import { identityLiterals, type IdentityLiteral } from './release-content-scrub';

/** Top-level files the publisher uploads. */
export const SITE_FILES = ['index.html', 'history.json'] as const;
/** Directories the publisher uploads, recursively. */
export const SITE_DIRS = ['plans', 'work-items', 'changes', 'assets'] as const;
/**
 * Directories whose remote copy MIRRORS the local one — the full publish syncs them with
 * `--delete`, so a page that disappeared locally is removed remotely. The incremental path
 * keeps exactly that contract; `changes/` and `assets/` never deleted remotely and still don't.
 */
export const MIRRORED_DIRS = ['plans', 'work-items'] as const;

export const MANIFEST_SCHEMA = 'release-site-publish-manifest-v1';
export const PLAN_SCHEMA = 'release-site-publish-plan-v1';

export interface PublishManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** sha256 of bucket + secret prefix. Never the raw prefix: it is the unguessable URL segment. */
  target: string;
  /** What the identity gate's rules were when these files were gated. */
  gateFingerprint: string;
  publishedAt: string;
  /** posix relative path → sha256 hex of the published bytes. */
  files: Record<string, string>;
}

export interface PublishPlan {
  schema: typeof PLAN_SCHEMA;
  /**
   * full        — upload + gate everything (the pre-existing behaviour).
   * incremental — upload + gate only what differs from the last verified publish.
   * only        — a caller-judged FORCE: upload + gate exactly the named files, nothing else.
   */
  mode: 'full' | 'incremental' | 'only';
  reason: string;
  /** Paths to upload (every path in full mode). */
  upload: string[];
  /** Remote keys to delete (incremental mode only; full mode deletes via `sync --delete`). */
  remove: string[];
  /** Paths the identity gate must scan before anything is uploaded. */
  gate: string[];
  unchangedCount: number;
  /**
   * The manifest to record once this publish has been verified — null when this publish cannot
   * establish the state of the WHOLE site (an `only` publish with no usable prior manifest).
   */
  next: PublishManifest | null;
}

// ── Generator side ───────────────────────────────────────────────────────────

export type WriteOutcome = 'written' | 'unchanged';

/**
 * Write `content` to `file` only when the bytes differ from what is already there.
 *
 * An unchanged page keeps its bytes AND its mtime, which is what lets `aws s3 sync` (the
 * full-publish path) skip it, and what keeps a regenerate from churning 29k files for a
 * one-page change.
 */
export function writeIfChanged(file: string, content: string | Uint8Array): WriteOutcome {
  const next = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  let existingSize: number | null = null;
  try {
    const st = fs.statSync(file);
    if (st.isFile()) existingSize = st.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existingSize === next.length && fs.readFileSync(file).equals(next)) return 'unchanged';
  fs.writeFileSync(file, next);
  return 'written';
}

/** Counts what a regenerate actually changed on disk, so its log line can say so. */
export class SiteWriteTally {
  written = 0;
  unchanged = 0;

  write(file: string, content: string | Uint8Array): WriteOutcome {
    const outcome = writeIfChanged(file, content);
    if (outcome === 'written') this.written++;
    else this.unchanged++;
    return outcome;
  }
}

// ── Publisher side ───────────────────────────────────────────────────────────

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function walkFiles(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(toPosix(path.relative(root, full)));
  }
}

/** Every file the publisher uploads, as sorted posix paths relative to the site root. */
export function listSiteFiles(siteDir: string): string[] {
  const out: string[] = [];
  for (const file of SITE_FILES) {
    if (fs.existsSync(path.join(siteDir, file))) out.push(file);
  }
  for (const dir of SITE_DIRS) {
    const full = path.join(siteDir, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walkFiles(siteDir, full, out);
  }
  return out.sort();
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Relative path → sha256 of its bytes, for every published file. */
export function hashSite(siteDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of listSiteFiles(siteDir)) {
    hashes[rel] = sha256Bytes(fs.readFileSync(path.join(siteDir, rel)));
  }
  return hashes;
}

/**
 * Identity of the publish destination. A manifest recorded for one bucket/prefix says nothing
 * about another, so a changed target forces a full publish.
 */
export function publishTarget(bucket: string, keyPrefix: string): string {
  return sha256Bytes(`${bucket}\n${keyPrefix}`);
}

/**
 * The gate's rules, fingerprinted: the identity literals it searches for plus the source of the
 * code that decides what a leak is. Pages published under a different fingerprint were gated
 * under different rules, so they must be re-gated.
 */
export function gateFingerprint(
  literals: readonly IdentityLiteral[],
  ruleSources: readonly string[],
): string {
  const sortedLiterals = [...literals]
    .map((literal) => `${literal.kind}\u0000${literal.value}`)
    .sort();
  const hash = createHash('sha256');
  hash.update(JSON.stringify(sortedLiterals));
  for (const source of ruleSources) {
    hash.update('\u0000');
    hash.update(source);
  }
  return hash.digest('hex');
}

/** The files whose content defines what the gate treats as a leak. */
export function defaultGateRuleSources(): string[] {
  return ['./release-content-scrub.ts', './gate-release-site.ts'].map((rel) =>
    fs.readFileSync(new URL(rel, import.meta.url), 'utf8'),
  );
}

export interface ManifestRead {
  manifest: PublishManifest | null;
  /** Why no usable manifest was returned (absent / unreadable / foreign schema). */
  problem: string | null;
}

export function readManifest(file: string): ManifestRead {
  if (!fs.existsSync(file)) {
    return { manifest: null, problem: 'no publish manifest yet, so what is live is unknown' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      manifest: null,
      problem: `publish manifest is unreadable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const candidate = parsed as Partial<PublishManifest> | null;
  if (
    !candidate ||
    candidate.schema !== MANIFEST_SCHEMA ||
    typeof candidate.target !== 'string' ||
    typeof candidate.gateFingerprint !== 'string' ||
    !candidate.files ||
    typeof candidate.files !== 'object'
  ) {
    return { manifest: null, problem: `publish manifest is not a ${MANIFEST_SCHEMA} document` };
  }
  return { manifest: candidate as PublishManifest, problem: null };
}

export interface PlanPublishInput {
  current: Record<string, string>;
  previous: PublishManifest | null;
  /** Why `previous` is null, when it is. */
  previousProblem?: string | null;
  target: string;
  gateFingerprint: string;
  full?: boolean;
  now?: Date;
}

function isMirrored(rel: string): boolean {
  return MIRRORED_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

export interface PlanOnlyInput {
  /** Hashes of exactly the named files. */
  only: Record<string, string>;
  previous: PublishManifest | null;
  target: string;
  gateFingerprint: string;
  reason: string;
  now?: Date;
}

/**
 * `ONLY=<file,…>` — the publish-side force (owner #821). The caller judged that nothing else
 * changed, so it uploads and gates exactly those files and skips hashing the other ~29k.
 *
 * The manifest can still advance, but only when the rest of it is trustworthy: same target and
 * same gate rules. Otherwise nothing is recorded, and the next ordinary publish falls back to
 * full — a force never manufactures a claim about files it did not look at.
 */
export function planOnlyPublish(input: PlanOnlyInput): PublishPlan {
  const upload = Object.keys(input.only).sort();
  const previous = input.previous;
  const canAdvance =
    previous !== null &&
    previous.target === input.target &&
    previous.gateFingerprint === input.gateFingerprint;
  return {
    schema: PLAN_SCHEMA,
    mode: 'only',
    reason: `forced ONLY publish — ${input.reason}`,
    upload,
    remove: [],
    gate: upload,
    unchangedCount: 0,
    next: canAdvance
      ? {
          ...previous,
          publishedAt: (input.now ?? new Date()).toISOString(),
          files: { ...previous.files, ...input.only },
        }
      : null,
  };
}

/**
 * Decide what this publish uploads, deletes and gates. Pure: the whole safety argument lives
 * here, so it is the part the tests pin.
 */
export function planPublish(input: PlanPublishInput): PublishPlan {
  const all = Object.keys(input.current).sort();
  const next: PublishManifest = {
    schema: MANIFEST_SCHEMA,
    target: input.target,
    gateFingerprint: input.gateFingerprint,
    publishedAt: (input.now ?? new Date()).toISOString(),
    files: { ...input.current },
  };
  const previous = input.previous;
  const fullReason = input.full
    ? 'full publish requested (FULL=1)'
    : !previous
      ? (input.previousProblem ?? 'no publish manifest yet, so what is live is unknown')
      : previous.target !== input.target
        ? 'the publish target (bucket or secret prefix) differs from the last recorded publish'
        : null;
  if (fullReason || !previous) {
    return {
      schema: PLAN_SCHEMA,
      mode: 'full',
      reason: fullReason ?? 'no previous publish',
      upload: all,
      remove: [],
      gate: all,
      unchangedCount: 0,
      next,
    };
  }

  const upload = all.filter((rel) => previous.files[rel] !== input.current[rel]);
  const remove = Object.keys(previous.files)
    .filter((rel) => !(rel in input.current) && isMirrored(rel))
    .sort();
  const rulesChanged = previous.gateFingerprint !== input.gateFingerprint;
  return {
    schema: PLAN_SCHEMA,
    mode: 'incremental',
    reason: rulesChanged
      ? 'only changed files are uploaded, but the identity rules changed since the last publish, so the gate re-scans every file'
      : 'only changed files are gated and uploaded; the rest were gated under the same rules when they were published',
    upload,
    remove,
    gate: rulesChanged ? all : upload,
    unchangedCount: all.length - upload.length,
    next,
  };
}

/**
 * Hard-link (or copy, across devices) each path into `stageDir`, preserving relative paths, so
 * the uploader can push exactly the delta with the same per-directory headers it always used.
 */
export function stageFiles(siteDir: string, stageDir: string, rels: readonly string[]): number {
  for (const rel of rels) {
    const src = path.join(siteDir, rel);
    const dest = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
  }
  return rels.length;
}

export function writeManifestAtomic(file: string, manifest: PublishManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── CLI (called by papercusp-desktop/bin/publish-release-history.sh) ─────────

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function writeList(file: string, rels: readonly string[]): void {
  fs.writeFileSync(file, rels.length ? `${rels.join('\n')}\n` : '');
}

/**
 * `plan <siteDir> --manifest <file> --bucket <name> --out <plan.json> --gate-list <file>
 *       --remove-list <file> [--stage <dir>] [--full]`
 *   The secret key prefix is read from PAPERCUSP_PUBLISH_KEY_PREFIX, never argv (argv is
 *   visible in the process table).
 * `commit --plan <plan.json> --manifest <file>` — record what a VERIFIED publish put live.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  literals?: readonly IdentityLiteral[],
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'plan') {
    const siteDir = rest[0];
    const manifestFile = flag(rest, '--manifest');
    const bucket = flag(rest, '--bucket');
    const out = flag(rest, '--out');
    const gateList = flag(rest, '--gate-list');
    const removeList = flag(rest, '--remove-list');
    const stage = flag(rest, '--stage');
    const keyPrefix = env.PAPERCUSP_PUBLISH_KEY_PREFIX ?? '';
    if (!siteDir || siteDir.startsWith('--') || !manifestFile || !bucket || !out || !gateList || !removeList) {
      console.error(
        'usage: release-site-delta plan <siteDir> --manifest <file> --bucket <name> --out <plan.json> ' +
          '--gate-list <file> --remove-list <file> [--stage <dir>] [--full]',
      );
      return 2;
    }
    if (!keyPrefix) {
      console.error('release-site-delta: PAPERCUSP_PUBLISH_KEY_PREFIX is unset — cannot identify the publish target.');
      return 2;
    }
    const resolvedLiterals = literals ?? identityLiterals();
    const started = Date.now();
    const { manifest, problem } = readManifest(manifestFile);
    const target = publishTarget(bucket, keyPrefix);
    const fingerprint = gateFingerprint(resolvedLiterals, defaultGateRuleSources());
    const onlyRaw = flag(rest, '--only');
    let plan: PublishPlan;
    let hashed: number;
    if (onlyRaw !== null) {
      const reason = (flag(rest, '--reason') ?? '').trim();
      if (reason.length < 8) {
        console.error(
          'release-site-delta: --only is a FORCE (it skips the rest of the site) — say why with --reason "<why only these files changed>".',
        );
        return 2;
      }
      const siteRoot = path.resolve(siteDir);
      const only: Record<string, string> = {};
      for (const rel of onlyRaw.split(',').map((part) => part.trim()).filter(Boolean)) {
        const full = path.resolve(siteRoot, rel);
        const inSite = full.startsWith(`${siteRoot}${path.sep}`);
        const posix = toPosix(path.relative(siteRoot, full));
        const published =
          (SITE_FILES as readonly string[]).includes(posix) ||
          SITE_DIRS.some((dir) => posix.startsWith(`${dir}/`));
        if (!inSite || !published || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          console.error(`release-site-delta: --only ${rel} is not a published file in ${siteDir}.`);
          return 2;
        }
        only[posix] = sha256Bytes(fs.readFileSync(full));
      }
      if (Object.keys(only).length === 0) {
        console.error('release-site-delta: --only named no files.');
        return 2;
      }
      plan = planOnlyPublish({ only, previous: manifest, target, gateFingerprint: fingerprint, reason });
      hashed = Object.keys(only).length;
    } else {
      const current = hashSite(siteDir);
      plan = planPublish({
        current,
        previous: manifest,
        previousProblem: problem,
        target,
        gateFingerprint: fingerprint,
        full: rest.includes('--full'),
      });
      hashed = Object.keys(current).length;
    }
    fs.writeFileSync(out, JSON.stringify(plan));
    writeList(gateList, plan.gate);
    writeList(removeList, plan.remove);
    if (stage && plan.mode !== 'full') stageFiles(siteDir, stage, plan.upload);
    console.log(
      `[delta] mode=${plan.mode} upload=${plan.upload.length} remove=${plan.remove.length} ` +
        `unchanged=${plan.unchangedCount} gate=${plan.gate.length} hashed=${hashed} ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s — ${plan.reason}`,
    );
    return 0;
  }
  if (command === 'commit') {
    const planFile = flag(rest, '--plan');
    const manifestFile = flag(rest, '--manifest');
    if (!planFile || !manifestFile) {
      console.error('usage: release-site-delta commit --plan <plan.json> --manifest <file>');
      return 2;
    }
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as PublishPlan;
    if (plan.schema !== PLAN_SCHEMA) {
      console.error(`release-site-delta: ${planFile} is not a ${PLAN_SCHEMA} document.`);
      return 2;
    }
    if (plan.next === null) {
      console.log(
        '[delta] published state NOT recorded — this ONLY publish cannot vouch for the rest of the site, ' +
          'so the next ordinary publish runs full once and records it.',
      );
      return 0;
    }
    if (plan.next.schema !== MANIFEST_SCHEMA) {
      console.error(`release-site-delta: ${planFile} carries no ${MANIFEST_SCHEMA} manifest.`);
      return 2;
    }
    writeManifestAtomic(manifestFile, { ...plan.next, publishedAt: new Date().toISOString() });
    console.log(
      `[delta] recorded the published state (${Object.keys(plan.next.files).length} file(s)) — ` +
        'the next publish uploads only what changes after this.',
    );
    return 0;
  }
  console.error('usage: release-site-delta <plan|commit> …');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  // Same process-boundary identity load as gate-release-site: the fingerprint must be computed
  // over the SAME literals the gate will search for.
  console.error(describeOwnerIdentityLoad(loadOwnerIdentityEnv()));
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(2);
    },
  );
}
