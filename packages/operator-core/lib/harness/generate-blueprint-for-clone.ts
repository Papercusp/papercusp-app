/**
 * generate-blueprint-for-clone — the standalone-from-URL blueprint step
 * (hive-from-github-url-2026-06-11 P-010 / D-007).
 *
 * A repo registered via the projects-route githubUrl path (standalone mode —
 * no hive, no publish) still deserves a working blueprint. This wraps the
 * generate-from-repo detection spine (detectFromRepo → detectionToOverride →
 * resolveAndValidate) and writes the git-canonical `.papercusp/blueprint.yaml`
 * — exactly the file harness:create would have written. Best-effort by
 * contract: the ROUTE registers the harness regardless; a generation failure
 * is reported, never thrown.
 *
 * `runTests` defaults FALSE here (unlike the tool): this runs inline in an
 * HTTP create path where a 2-minute test-verify run is hostile UX. The picker
 * can re-verify later via harness:generate-from-repo.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

export type GenerateBlueprintForCloneResult =
  | { generated: true; blueprintFile: string }
  | { generated: false; reason: 'already_has_blueprint' }
  | { generated: false; error: string };

export async function generateBlueprintForClone(
  slug: string,
  repoPath: string,
  opts: { runTests?: boolean; testTimeoutMs?: number } = {},
): Promise<GenerateBlueprintForCloneResult> {
  try {
    const { detectFromRepo, detectionToOverride } = await import('../blueprint/detect-from-repo');
    const { resolveAndValidate } = await import('../agent-tools/blueprint/_resolve');
    const det = detectFromRepo(repoPath, {
      runTests: opts.runTests === true,
      ...(opts.testTimeoutMs ? { testTimeoutMs: opts.testTimeoutMs } : {}),
    });
    if (det.skip) return { generated: false, reason: 'already_has_blueprint' };
    const override = detectionToOverride(slug, det);
    const validation = resolveAndValidate(override);
    if (validation.parseError || !validation.ok) {
      return {
        generated: false,
        error: validation.parseError ?? 'generated blueprint failed validation',
      };
    }
    const bpDir = join(repoPath, '.papercusp');
    if (!existsSync(bpDir)) mkdirSync(bpDir, { recursive: true });
    const blueprintFile = join(bpDir, 'blueprint.yaml');
    writeFileSync(blueprintFile, stringifyYaml(override, { lineWidth: 100 }), 'utf8');
    return { generated: true, blueprintFile };
  } catch (e) {
    return { generated: false, error: e instanceof Error ? e.message : String(e) };
  }
}
