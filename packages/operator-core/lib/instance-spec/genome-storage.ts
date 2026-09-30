/**
 * Genome storage — where a harness's genome lives on disk + in the registry, so
 * `capture` reads it back and `boot` writes it forward round-trippably.
 *
 *   - **prompt overlays** → `<harness>/.papercusp/genome/<path>` files (git-canonical,
 *     diffable — apiary P-011's "directory of prompt files");
 *   - **config knobs**    → the registry ProjectEntry's `configOverrides.genome`
 *     (workspace PG, so they federate to a cloud frame like the rest of the
 *     instance config — cloud-deployment-layer D-007).
 *
 * The genome is content-addressed (`hashGenome`); this module is only the
 * read/write seam, kept pure-ish (FS + a passed-in entry, no PG of its own).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { GenomeConfig, GenomePrompts, Genome } from './genome';
import { GENOME_CONFIG_AXES, normalizeGenome } from './genome';

/** The harness-relative dir holding genome prompt overlays. */
export const GENOME_DIR = '.papercusp/genome';
/** The `configOverrides` key under which the genome's config knobs are stored. */
export const GENOME_CONFIG_KEY = 'genome';

/** Recursively list files under `dir`, returning paths relative to `dir` (posix-style). */
function listFilesRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Read the genome prompt overlays under a harness's `.papercusp/genome/`. */
export function readGenomePrompts(harnessPath: string): GenomePrompts {
  const dir = join(harnessPath, GENOME_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return {};
  const prompts: GenomePrompts = {};
  for (const rel of listFilesRel(dir)) {
    prompts[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return prompts;
}

/** Extract the genome config knobs from a ProjectEntry's `configOverrides`. */
export function readGenomeConfig(configOverrides: Record<string, unknown> | undefined): GenomeConfig {
  const raw = configOverrides?.[GENOME_CONFIG_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const config: GenomeConfig = {};
  for (const axis of GENOME_CONFIG_AXES) {
    const v = src[axis];
    if (v && typeof v === 'object' && Object.keys(v).length > 0) config[axis] = v as Record<string, unknown>;
  }
  return config;
}

/** Assemble a harness's full genome from disk (prompts) + registry (config). */
export function readGenome(harnessPath: string, configOverrides: Record<string, unknown> | undefined): Genome {
  return normalizeGenome({
    prompts: readGenomePrompts(harnessPath),
    config: readGenomeConfig(configOverrides),
  });
}

/**
 * Write a genome's prompt overlays to `<harness>/.papercusp/genome/`, replacing any
 * existing overlays (the dir is the genome's authoritative prompt surface). A guard
 * rejects path-escaping keys.
 */
export function writeGenomePrompts(harnessPath: string, prompts: GenomePrompts): void {
  const dir = join(harnessPath, GENOME_DIR);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const entries = Object.entries(prompts);
  if (entries.length === 0) return;
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of entries) {
    const target = join(dir, rel);
    const norm = relative(dir, target);
    if (norm.startsWith('..') || norm.includes(`..${sep}`)) {
      throw new Error(`genome prompt path escapes the genome dir: ${rel}`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/**
 * Fold a genome's config knobs into a `configOverrides` object under the `genome`
 * key (pure — returns a new object). An empty genome config clears the key.
 */
export function applyGenomeConfig(
  configOverrides: Record<string, unknown> | undefined,
  config: GenomeConfig,
): Record<string, unknown> {
  const next = { ...(configOverrides ?? {}) };
  const present: GenomeConfig = {};
  for (const axis of GENOME_CONFIG_AXES) {
    const v = config[axis];
    if (v && Object.keys(v).length > 0) present[axis] = v;
  }
  if (Object.keys(present).length === 0) delete next[GENOME_CONFIG_KEY];
  else next[GENOME_CONFIG_KEY] = present;
  return next;
}
