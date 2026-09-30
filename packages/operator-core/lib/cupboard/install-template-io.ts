/**
 * install-template-io — the REAL (git + network + resolver) wiring for installing
 * a Cupboard app-template into the local template store.
 *
 * Extracted (cupboard-agent-tool-coverage-2026-07-14 P-007, D-001 reuse-first)
 * from the inline body of `endpoint-route/routes/cupboard-install-template.ts`
 * so BOTH the loopback HTTP route AND the agent-callable `cupboard:install-template`
 * tool run the exact same logic — no fork. The template sibling of
 * install-plugin-io / install-blueprint-io.
 *
 * A `kind=template` listing is GitHub-repo-backed: installing it = git-clone the
 * mirror repo, locate `<clone>/<listing_ref>/`, validate it as a self-describing
 * template dir (template.yaml), and drop it into the WRITABLE user template layer
 * (`<papercuspRoot>/templates/<ref>/`) so it shadows the bundled floor. After
 * install, `templates:new-app` materializes it via the same local resolution as a
 * bundled template — an installed ref becomes a LOCAL template, resolvable
 * independently of FLAGS.TEMPLATES_MARKETPLACE (which only gates the automatic
 * remote MERGE in templates:list/new-app, not an explicit install-by-url).
 *
 * The pure, DI-testable core stays in install-template-core.ts; this file wires
 * the real deps (clone / user dir / tmp dir) + the listing resolution and returns
 * a structured result. Never throws for an expected failure; the caller maps
 * status+error.
 */
import { tmpdir } from 'node:os';
import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
  type InstallTemplateCoreResult,
} from './install-template-core';
import { gitCloneShallow } from './install-io';
import { userTemplatesDir } from './template-store';
import { resolveTemplateListing } from './templates';

export interface InstallTemplateFromCupboardInput {
  /** Resolve the mirror repo URL + listing_ref from the Cupboard listing. */
  listingId?: string;
  /** OR install a mirror repo directly (listingRef = the template subdir). */
  githubUrl?: string;
  listingRef?: string;
}

export type InstallTemplateFromCupboardResult =
  | { ok: true; result: InstallTemplateCoreResult }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The ONE orchestrated path that installs an app-template from the Cupboard by
 * listing id OR direct github url. Mirrors the loopback route body exactly.
 */
export async function installTemplateFromCupboard(
  input: InstallTemplateFromCupboardInput,
): Promise<InstallTemplateFromCupboardResult> {
  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : '';

  if (!githubUrl && input.listingId) {
    const resolved = await resolveTemplateListing(String(input.listingId));
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    if (!listingRef) listingRef = resolved.ref;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) {
    return { ok: false, status: 400, error: 'listingRef required (the template subdir)' };
  }

  try {
    const result = await installTemplateFromCupboardCore(
      { githubUrl, listingRef },
      { cloneRepo: gitCloneShallow, userTemplatesDir, tmpDir: tmpdir },
    );
    return { ok: true, result };
  } catch (e) {
    if (e instanceof InstallTemplateError) {
      return { ok: false, status: e.status, error: e.message };
    }
    return { ok: false, status: 500, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}
