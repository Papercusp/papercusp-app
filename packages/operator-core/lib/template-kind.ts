/**
 * Resolve a harness instance's `templateKind` (§15.8 of project-sharing /
 * §16 publishing — `requiresTemplateKinds` enforcement).
 *
 * Source order:
 *   1. ~/.papercusp/harnesses/<slug>/papercusp.json `templateKind` field
 *   2. Same manifest's `topology: "multi"` ⇒ "org"
 *   3. ~/.papercusp/registry.json projects[].harness_kind
 *   4. Default "coding" (back-compat for harnesses without any kind hint)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { papercuspRoot } from './papercusp-root';
export type TemplateKind = 'coding' | 'org' | 'department' | string;

export async function resolveTemplateKind(harnessSlug: string): Promise<TemplateKind> {
  const root = papercuspRoot();
  try {
    const m = JSON.parse(
      await fs.readFile(join(root, 'harnesses', harnessSlug, 'papercusp.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (typeof m.templateKind === 'string') return m.templateKind;
    if (m.topology === 'multi') return 'org';
  } catch { /* manifest missing — try registry next */ }
  try {
    const reg = JSON.parse(await fs.readFile(join(root, 'registry.json'), 'utf8')) as {
      projects?: Array<{ slug: string; harness_kind?: string }>;
    };
    const project = reg.projects?.find((p) => p.slug === harnessSlug);
    if (project?.harness_kind) return project.harness_kind;
  } catch { /* fall through */ }
  return 'coding';
}

export function pluginAllowsKind(
  requiresTemplateKinds: unknown,
  harnessKind: TemplateKind,
): boolean {
  if (!Array.isArray(requiresTemplateKinds) || requiresTemplateKinds.length === 0) {
    return true;
  }
  return requiresTemplateKinds.includes(harnessKind);
}

export async function readPluginRequiresTemplateKinds(
  pluginDir: string,
): Promise<string[] | null> {
  try {
    const m = JSON.parse(
      await fs.readFile(join(pluginDir, 'papercusp.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (Array.isArray(m.requiresTemplateKinds)) {
      return m.requiresTemplateKinds.filter((s): s is string => typeof s === 'string');
    }
    return null;
  } catch {
    return null;
  }
}
