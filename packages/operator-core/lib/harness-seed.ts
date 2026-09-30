/**
 * Shared hermetic-seed primitive for throwaway harnesses.
 *
 * Seeds a throwaway harness pointing at a (clone) path: register it (which scaffolds
 * its schema), pre-seed workspace files, apply prompt overrides, then file the
 * feature. Used by BOTH the harness gym (full-pipeline optimizer, lib/gym/) and the
 * single-role PipelineTarget (lib/llm-testing/pipeline.ts) — coordinated with the
 * harness-test-coverage owner so neither double-builds the seed step. The SPAWN,
 * CAPTURE, and TEARDOWN are intentionally NOT here — they differ per caller (gym runs
 * the whole DBOS pipeline + git-diffs; the single-role target invoke-once's one role +
 * diffs filesWritten). All effects are injected, and the feature-filing path is
 * injectable so the external gym controller can file over HTTP while a co-located
 * caller can use in-process functions.
 */
import { AGENT_ROLES, FROZEN_OVERLAY_ROLES } from '@papercusp/agent-mcp';

const KNOWN_ROLES: ReadonlySet<string> = new Set(AGENT_ROLES);
// The external judge is frozen (D-003) and is never a throwaway-harness override
// target — guarded EXPLICITLY now that `judge` is a member of AGENT_ROLES
// (blueprint-role-bundling EI-621), so the freeze no longer relies on absence.
const FROZEN_ROLES: ReadonlySet<string> = new Set(FROZEN_OVERLAY_ROLES);

export interface SeedFeature {
  id: string;
  title: string;
  spec: string;
  acceptance?: string[];
  status?: string;
}

export interface SeedHarnessInput {
  slug: string;
  /** The throwaway clone (or repo) path the harness points at. */
  repoOrClonePath: string;
  workspaceId: string;
  feature: SeedFeature;
  /** Files to pre-seed in the harness workspace (e.g. an impl the validator checks). */
  files?: Array<{ path: string; content: string }>;
  /** Per-role prompt overrides (the variant overlay, or a single-role test override). */
  promptOverrides?: Record<string, string>;
}

export interface SeedHarnessDeps {
  registerHarness(i: { slug: string; path: string; workspaceId: string }): Promise<void>;
  fileFeature(i: { slug: string; workspaceId: string; feature: SeedFeature }): Promise<void>;
  writeFile(i: { basePath: string; relPath: string; content: string }): Promise<void>;
  setOverride(i: { workspaceId: string; slug: string; role: string; promptMd: string }): Promise<void>;
}

export async function seedThrowawayHarness(
  input: SeedHarnessInput,
  deps: SeedHarnessDeps,
): Promise<{ harnessSlug: string }> {
  const overrides = input.promptOverrides ?? {};
  for (const role of Object.keys(overrides)) {
    if (FROZEN_ROLES.has(role)) {
      throw new Error(`seedThrowawayHarness: cannot override the frozen role "${role}" (the external judge is frozen)`);
    }
    if (!KNOWN_ROLES.has(role)) {
      throw new Error(`seedThrowawayHarness: unknown override role "${role}" (not in AGENT_ROLES)`);
    }
  }

  await deps.registerHarness({ slug: input.slug, path: input.repoOrClonePath, workspaceId: input.workspaceId });

  for (const f of input.files ?? []) {
    await deps.writeFile({ basePath: input.repoOrClonePath, relPath: f.path, content: f.content });
  }
  for (const role of Object.keys(overrides).sort()) {
    await deps.setOverride({ workspaceId: input.workspaceId, slug: input.slug, role, promptMd: overrides[role] });
  }

  await deps.fileFeature({ slug: input.slug, workspaceId: input.workspaceId, feature: input.feature });
  return { harnessSlug: input.slug };
}
