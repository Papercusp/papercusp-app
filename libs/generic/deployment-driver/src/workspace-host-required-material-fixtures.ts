/**
 * Fixture-side DERIVATION of the required release materials.
 *
 * `WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS` is the single release-gate contract, and its own
 * documentation asks producers and fixtures to consume the exported paths rather than maintain
 * parallel lists. Every build-manifest fixture nonetheless hand-rolled the array, so adding
 * `bin/papercusp-deliver-material` to the contract turned seven suites red at once, each failing
 * with a provenance error naming a path the test never mentioned.
 *
 * Deriving here closes that class: a sixth required material reaches every fixture on its own, and
 * a fixture that still restates the list is visibly the odd one out.
 */
import { createHash } from "node:crypto";

import {
  WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS,
  type WorkspaceHostBuildMaterial,
} from "./workspace-host-build-manifest";

/** Per-material fixture overrides, keyed by the contract's own material path. */
export type WorkspaceHostRequiredMaterialFixtureOverrides = Readonly<
  Record<string, Partial<Omit<WorkspaceHostBuildMaterial, "path">>>
>;

/**
 * Deterministic stand-in digest. Stable per path so a manifest built twice serializes to identical
 * bytes — several suites assert exactly that — while staying obviously synthetic.
 */
function fixtureDigest(path: string): string {
  return createHash("sha256").update(`workspace-host-required-material:${path}`).digest("hex");
}

/**
 * Every material the release-provenance rule requires, ready to spread into a build-manifest
 * fixture's `materials` alongside whatever else that fixture is actually testing:
 *
 * ```ts
 * materials: [
 *   { path: 'dist/papercusp-server.tgz', sha256: RELEASE_DIGEST, sizeBytes: BUNDLE_BYTES },
 *   ...workspaceHostRequiredReleaseMaterialFixtures(),
 * ]
 * ```
 *
 * `executable` is taken from the contract, never from the caller's memory of it, because the rule
 * rejects a required-executable material that is present but unmarked. Sizes default non-zero for
 * the same reason: an empty required material is its own provenance failure. Pass `overrides` when
 * a test needs a specific digest or size — including a deliberately invalid one, which is how the
 * negative cases keep working.
 */
export function workspaceHostRequiredReleaseMaterialFixtures(
  overrides: WorkspaceHostRequiredMaterialFixtureOverrides = {},
): WorkspaceHostBuildMaterial[] {
  return WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS.map((required) => {
    const override = overrides[required.path] ?? {};
    const executable = override.executable ?? required.executable;
    return {
      path: required.path,
      sha256: override.sha256 ?? fixtureDigest(required.path),
      sizeBytes: override.sizeBytes ?? 1_024,
      ...(executable === true ? { executable: true } : {}),
    };
  });
}
