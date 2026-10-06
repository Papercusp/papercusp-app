/**
 * install-datatype-io — the IO seam that installs a Cupboard `datatype` listing AND
 * seeds its `datatype_registry` row (P-027 / D-010).
 *
 * WHY THE ROW-WRITE LIVES HERE, NOT IN THE CORE
 * ---------------------------------------------
 * `install-datatype-core` materializes a verified package directory and stops there,
 * on purpose: if the Cupboard install layer wrote definitions itself it would BECOME
 * a second resolver, which is the exact duplication P-027 exists to remove. D-010
 * keeps `datatype_registry` as the ONE resolution layer, so distribution (the package
 * on disk) and resolution (the row) are two steps, and this seam is the only place
 * they meet.
 *
 * That split has a consequence worth stating plainly: a package installed WITHOUT a
 * seeded row is inert — `work_items:create { kind }` resolves through the registry,
 * not through the installed directory. So a failed seed is reported as a failed
 * INSTALL, never as a success with a warning.
 *
 * IDENTITY is enforced ONE level down, not here: `readDatatypeDir` refuses a package whose
 * manifest id is not already its canonical slug, so by the time a package reaches this seam
 * its id is canonical by construction. This file deliberately does NOT re-check it — a
 * second copy of that rule would be a second place for it to drift, and the parse-time
 * refusal is the stronger one anyway (it rejects the package, not just the row write).
 * The same parse gate also carries P-001 (a payloadSchema must compile) and P-010 (a
 * self-improving tier must ship its selfImprovement block), so every definition-shaped
 * refusal surfaces here as one 422 "failed to parse its datatype.json".
 */
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';
import { installDatatypeFromCupboardCore, InstallDatatypeError } from './install-datatype-core';
import {
  installedDatatypeRef,
  resolveInstalledDatatype,
  type InstalledDatatype,
} from './datatype-store';
import { legacyNatureForTier, type UpsertDatatypeInput } from '../datatype-registry-store';
import { parseDatatypeDisplay, type DatatypeDisplaySpec } from '../datatype-display';

export interface InstallDatatypeInput {
  listingId?: string;
  githubUrl?: string;
  listingRef?: string;
  update?: boolean;
  /** The workspace whose registry row is seeded — the resolution half (D-010). */
  workspaceId: string;
  createdBy?: string;
}

export interface InstallDatatypeDeps {
  /** Seed/refresh the `datatype_registry` row from the installed package. Injected so
   *  the seam is testable without Postgres, and so the registry stays the one writer. */
  seedRegistry: (input: UpsertDatatypeInput) => Promise<{ id: string }>;
}

export interface InstalledDatatypeResult extends InstalledDatatype {
  ok: true;
  ref: string;
  installedTo: string;
  operation: 'install' | 'update' | 'no-op';
  /** The `datatype_registry` id this install made resolvable. */
  registryId: string;
}

export type InstallDatatypeResult =
  | { ok: true; result: InstalledDatatypeResult }
  | { ok: false; status: number; error: string; detail?: string };

/** The default seeder: the registry store, reached through the org pool. Imported
 *  lazily so a test (or an export-only caller) never opens a pool it will not use. */
async function defaultSeedRegistry(input: UpsertDatatypeInput): Promise<{ id: string }> {
  const [{ getOrgPg }, { upsertDatatype }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../datatype-registry-store'),
  ]);
  const row = await upsertDatatype(getOrgPg().sql, input);
  return { id: row.id };
}

/** Project an installed package into the registry write. Kept separate from the
 *  install so the mapping is readable on its own — it is the D-010 boundary. */
export function registryInputFromPackage(
  datatype: InstalledDatatype,
  workspaceId: string,
  createdBy?: string,
): UpsertDatatypeInput {
  // A package's `display` is parsed as an opaque object by readDatatypeDir; the registry's
  // contract is the narrower DatatypeDisplaySpec. Parse it HERE, at the D-010 boundary, and
  // THROW on a malformed one: `seed()` turns that into a failed install, which is the honest
  // outcome — a package whose display cannot produce a valid row is not resolvable.
  let display: DatatypeDisplaySpec | undefined;
  if (datatype.display) {
    const parsed = parseDatatypeDisplay(datatype.display);
    if (!parsed.ok) {
      throw new Error(`datatype "${datatype.id}" has an invalid display spec: ${parsed.issues.join('; ')}`);
    }
    display = parsed.value;
  }
  // P-008 / D-013 §5: a package that declares its nature keeps it; one that predates natures
  // gets the legacy tier rule (the same rule migration 1318 backfills existing rows with).
  const natureSpec = datatype.nature
    ? { nature: datatype.nature, audience: datatype.audience }
    : legacyNatureForTier(datatype.tier);
  return {
    id: datatype.id,
    workspaceId,
    title: datatype.title,
    description: datatype.description,
    tier: datatype.tier,
    nature: natureSpec.nature,
    audience: natureSpec.audience,
    ...(datatype.workItemKind ? { workItemKind: datatype.workItemKind } : {}),
    ...(datatype.payloadSchema ? { payloadSchema: datatype.payloadSchema } : {}),
    ...(display ? { display } : {}),
    ...(datatype.authoritativeWriter ? { authoritativeWriter: datatype.authoritativeWriter } : {}),
    ...(datatype.selfImprovement ? { selfImprovement: datatype.selfImprovement } : {}),
    tags: datatype.tags,
    ...(createdBy ? { createdBy } : {}),
  };
}

export async function installDatatypeFromCupboard(
  input: InstallDatatypeInput,
  deps: InstallDatatypeDeps = { seedRegistry: defaultSeedRegistry },
): Promise<InstallDatatypeResult> {
  const workspaceId = String(input.workspaceId ?? '').trim();
  if (!workspaceId) return { ok: false, status: 400, error: 'workspaceId required' };

  let githubUrl = input.githubUrl?.trim() ?? '';
  let listingRef = input.listingRef?.trim() ?? '';
  let releaseVersion: string | undefined;
  // The Worker's publish-time content pin (P-002): only a listing carries one, so a
  // direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;
  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'datatype');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef ||= resolved.ref;
    releaseVersion = resolved.releaseVersion;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) return { ok: false, status: 400, error: 'listingRef required' };

  const targetRef = installedDatatypeRef(githubUrl, listingRef);
  const existing = resolveInstalledDatatype(targetRef);
  // A no-op still re-seeds: the package being present says nothing about the row,
  // and a package installed before its seed failed must be recoverable by re-running.
  if (existing && releaseVersion && existing.version === releaseVersion && input.update !== true) {
    const seeded = await seed(existing, workspaceId, input.createdBy, deps);
    if (!seeded.ok) return seeded;
    return {
      ok: true,
      result: { ...existing, ok: true, ref: targetRef, installedTo: existing.dir, operation: 'no-op', registryId: seeded.id },
    };
  }
  if (existing && input.update !== true) {
    return {
      ok: false,
      status: 409,
      error: `datatype "${existing.id}" is already installed; pass update:true to replace it`,
    };
  }

  let installed: InstalledDatatype & { ref: string; installedTo: string };
  try {
    installed = await installDatatypeFromCupboardCore(
      { githubUrl, listingRef, targetRef, replaceExisting: existing !== null && input.update === true, pin },
      cupboardGitDeps(),
    );
  } catch (error) {
    if (error instanceof InstallDatatypeError) return { ok: false, status: error.status, error: error.message };
    return { ok: false, status: 500, error: 'install failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const seeded = await seed(installed, workspaceId, input.createdBy, deps);
  if (!seeded.ok) return seeded;
  return {
    ok: true,
    result: {
      ...installed,
      ok: true,
      ref: installed.ref,
      installedTo: installed.installedTo,
      operation: existing ? 'update' : 'install',
      registryId: seeded.id,
    },
  };
}

async function seed(
  datatype: InstalledDatatype,
  workspaceId: string,
  createdBy: string | undefined,
  deps: InstallDatatypeDeps,
): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string; detail?: string }> {
  try {
    const row = await deps.seedRegistry(registryInputFromPackage(datatype, workspaceId, createdBy));
    return { ok: true, id: row.id };
  } catch (error) {
    // The package is on disk but unresolvable, so this is an install failure.
    return {
      ok: false,
      status: 500,
      error: 'datatype installed but its registry row could not be seeded — it is not resolvable yet; re-run to retry',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
