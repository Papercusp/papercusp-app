/**
 * load-packs — fs resolution for Knowledge Packs (learning-packs-2026-06-11 P-001).
 *
 * Two roots, mirroring the blueprint distribution tiers
 * (installed-blueprints.ts):
 *
 *   builtin    libs/papercusp/packages/harness/knowledge-packs/<id>/  (ships with the app)
 *   installed  ~/.papercusp/knowledge-packs/<id>/                     (Comb-installed, P-017)
 *
 * Builtin wins on an id clash — a community pack can never shadow a
 * first-party one. Missing roots are simply empty (fresh installs have no
 * installed dir; test fixtures override both via opts.roots).
 *
 * All file reads are batched with Promise.all — never a serial fs loop
 * (performance anti-pattern A1).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from '../harness-paths';
import { papercuspRoot } from '../papercusp-root';
import { workspacesRoot } from '../workspace-registry';
import {
  parseLearningFile,
  parseManifest,
  parsePackDocFile,
  validatePack,
  type LearningItem,
  type PackDocItem,
  type KnowledgePack,
  type KnowledgePackSource,
  type KnowledgePackSummary,
} from './pack-format';

export function builtinKnowledgePacksRoot(): string {
  // knowledge-packs P-003: the builtin dir was renamed harness/learnings →
  // harness/knowledge-packs alongside the module. It ships INSIDE the app
  // bundle, so there is no on-disk legacy copy to fall back to — a stale name
  // here is a hard "no builtin packs", not a soft miss.
  return harnessPath('knowledge-packs');
}

export function installedKnowledgePacksRoot(): string {
  return join(papercuspRoot(), 'knowledge-packs');
}

/**
 * The workspace-INDEPENDENT shared root (knowledge-pack-loop-integrity-2026-07-19
 * P-005 / plan D-005): GLOBAL packs — today the `fleet-lessons` pack the
 * candidate loop materializes adoptions into — live here, NOT under a
 * per-workspace `papercuspRoot()`. Candidates are fleet-global (migration 377,
 * data-scoping P-002), so materializing into whichever workspace happened to
 * be ACTIVE fragmented the pack across workspace roots with independent
 * versions (EI-18106997081327607). Resolves under `workspacesRoot()` so every
 * workspace sees ONE copy.
 */
export function sharedKnowledgePacksRoot(): string {
  return join(workspacesRoot(), 'shared', 'knowledge-packs');
}

/**
 * The pre-rename installed root. Unlike the builtin dir this one lives in the
 * USER's home (`~/.papercusp/`), so an existing install genuinely has packs
 * sitting under the old name — they are migrated on boot (migrateInstalledRoot).
 */
export function legacyInstalledKnowledgePacksRoot(): string {
  return join(papercuspRoot(), 'learning-packs');
}

/**
 * Boot-time move of the installed-packs root (knowledge-packs P-003).
 *
 * D-001 is a HARD rename with no read-time aliases, so the old directory must
 * actually MOVE rather than be dual-read forever. Idempotent and fail-soft:
 * a missing legacy dir is the normal (fresh-install) case, and if BOTH exist
 * the new root wins and the legacy dir is left alone for the owner to inspect
 * rather than silently merged (a merge could shadow an installed pack with a
 * stale same-id copy).
 */
export async function migrateInstalledRoot(): Promise<
  { moved: false; reason: 'no-legacy' | 'already-migrated' } | { moved: true; from: string; to: string }
> {
  const legacy = legacyInstalledKnowledgePacksRoot();
  const next = installedKnowledgePacksRoot();
  const exists = async (d: string) => !!(await fs.stat(d).catch(() => null));

  if (!(await exists(legacy))) return { moved: false, reason: 'no-legacy' };
  if (await exists(next)) return { moved: false, reason: 'already-migrated' };

  await fs.rename(legacy, next);
  return { moved: true, from: legacy, to: next };
}

/**
 * Boot-time move of a fleet-lessons pack materialized under a PER-WORKSPACE
 * installed root into the shared root (P-005). Same posture as
 * migrateInstalledRoot: idempotent, fail-soft, and when BOTH exist the shared
 * copy wins and the per-workspace dir is left for the owner to inspect rather
 * than silently merged (resolution order already shadows it).
 */
export async function migrateFleetLessonsToSharedRoot(io: {
  /** Test overrides; default = the real per-workspace installed / shared roots. */
  fromRoot?: string;
  toRoot?: string;
} = {}): Promise<
  { moved: false; reason: 'no-legacy' | 'already-migrated' } | { moved: true; from: string; to: string }
> {
  const from = join(io.fromRoot ?? installedKnowledgePacksRoot(), 'fleet-lessons');
  const to = join(io.toRoot ?? sharedKnowledgePacksRoot(), 'fleet-lessons');
  const exists = async (d: string) => !!(await fs.stat(d).catch(() => null));

  if (!(await exists(from))) return { moved: false, reason: 'no-legacy' };
  if (await exists(to)) return { moved: false, reason: 'already-migrated' };

  await fs.mkdir(join(to, '..'), { recursive: true });
  await fs.rename(from, to);
  return { moved: true, from, to };
}

export interface PackRoots {
  /** Resolution order; earlier roots win on id clash. Default builtin → shared → installed. */
  roots?: Array<{ dir: string; source: KnowledgePackSource }>;
}

function defaultRoots(): Array<{ dir: string; source: KnowledgePackSource }> {
  // builtin → shared → installed (earlier wins on id clash): a first-party
  // pack can never be shadowed, and the ONE shared fleet-lessons copy wins
  // over any stale per-workspace copy left behind pre-migration (P-005).
  return [
    { dir: builtinKnowledgePacksRoot(), source: 'builtin' },
    { dir: sharedKnowledgePacksRoot(), source: 'installed' },
    { dir: installedKnowledgePacksRoot(), source: 'installed' },
  ];
}

export interface LoadedKnowledgePack {
  pack: KnowledgePack;
  source: KnowledgePackSource;
  /** Per-item parse problems for a pack that still loaded (none ⇒ clean). */
  warnings: string[];
  /** Exact resolved directory for the composition compiler's complete-content pin. */
  directory?: string;
}

/**
 * Read one pack directory. Returns null when the dir has no readable
 * manifest; a manifest with malformed learnings still loads (the bad items
 * are dropped into `warnings`) so one typo'd file never hides a whole pack —
 * EXCEPT when validation fails outright (no items / dup ids), which returns
 * null with the reason in `errors`.
 */
async function readPackDir(
  dir: string,
  source: KnowledgePackSource,
): Promise<{ loaded?: LoadedKnowledgePack; errors: string[] }> {
  const errors: string[] = [];

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(join(dir, 'manifest.yaml'), 'utf8');
  } catch {
    return { errors: [`${dir}: no readable manifest.yaml`] };
  }
  const { manifest, error: manifestError } = parseManifest(manifestRaw);
  if (!manifest) return { errors: [`${dir}: ${manifestError}`] };

  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { errors: [`${dir}: unreadable pack directory`] };
  }

  const warnings: string[] = [];
  const reads = await Promise.all(
    entries.map(async (file) => {
      try {
        const raw = await fs.readFile(join(dir, file), 'utf8');
        return { file, raw };
      } catch {
        warnings.push(`${manifest.id}/${file}: unreadable`);
        return null;
      }
    }),
  );

  const items: LearningItem[] = [];
  for (const read of reads) {
    if (!read) continue;
    const stem = read.file.replace(/\.md$/, '');
    const { item, error } = parseLearningFile(read.raw, stem);
    if (item) items.push(item);
    else if (error) warnings.push(`${manifest.id}: ${error}`);
  }

  // P-009 / D-022: optional `docs/` — procedure sections an identity package
  // installs as addressed doc parts. An absent dir is the normal case.
  const docsDir = join(dir, 'docs');
  const docFiles = (await fs.readdir(docsDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.md'))
    .sort();
  const docReads = await Promise.all(
    docFiles.map(async (file) => {
      try {
        return { file, raw: await fs.readFile(join(docsDir, file), 'utf8') };
      } catch {
        warnings.push(`${manifest.id}/docs/${file}: unreadable`);
        return null;
      }
    }),
  );
  const docs: PackDocItem[] = [];
  for (const read of docReads) {
    if (!read) continue;
    const { doc, error } = parsePackDocFile(read.raw, read.file.replace(/\.md$/, ''));
    if (doc) docs.push(doc);
    else if (error) warnings.push(`${manifest.id}: ${error}`);
  }

  // `docs` is omitted when empty so a doc-less pack pins byte-identically.
  const pack: KnowledgePack = { manifest, items, ...(docs.length > 0 ? { docs } : {}) };
  const packErrors = validatePack(pack);
  if (packErrors.length > 0) {
    return { errors: packErrors.map((e) => `${manifest.id}: ${e}`) };
  }
  return { loaded: { pack, source, warnings, directory: dir }, errors };
}

/** Enumerate every resolvable pack across the roots (earlier root wins on id). */
export async function listKnowledgePacks(opts: PackRoots = {}): Promise<KnowledgePackSummary[]> {
  const roots = opts.roots ?? defaultRoots();
  const byId = new Map<string, KnowledgePackSummary>();

  for (const { dir, source } of roots) {
    let subdirs: string[] = [];
    try {
      subdirs = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue; // root absent — fine (fresh install)
    }
    const loadedAll = await Promise.all(
      subdirs.map((name) => readPackDir(join(dir, name), source)),
    );
    for (const { loaded } of loadedAll) {
      if (!loaded) continue;
      const m = loaded.pack.manifest;
      if (byId.has(m.id)) continue; // earlier root wins
      byId.set(m.id, {
        id: m.id,
        title: m.title,
        description: m.description,
        version: m.version,
        ...(m.author ? { author: m.author } : {}),
        itemCount: loaded.pack.items.length,
        source,
      });
    }
  }
  return [...byId.values()];
}

/** Resolve one pack by id across the roots (earlier root wins). */
export async function loadKnowledgePack(
  packId: string,
  opts: PackRoots = {},
): Promise<LoadedKnowledgePack | null> {
  const roots = opts.roots ?? defaultRoots();
  for (const { dir, source } of roots) {
    const { loaded } = await readPackDir(join(dir, packId), source);
    if (loaded && loaded.pack.manifest.id === packId) return loaded;
  }
  return null;
}

/**
 * Read + validate one pack DIRECTORY directly (no root resolution) — the
 * fetch-from-Comb path (P-017) validates a cloned repo's pack dir before
 * copying it under the installed root. Returns null + errors when invalid.
 */
export async function loadKnowledgePackFromDir(
  dir: string,
): Promise<{ loaded?: LoadedKnowledgePack; errors: string[] }> {
  return readPackDir(dir, 'installed');
}
