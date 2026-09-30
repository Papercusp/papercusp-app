/**
 * install-event-io — the IO seam that installs a Cupboard `event` listing AND seeds its
 * `event_key_registry` row (P-029 / D-010).
 *
 * WHY THE ROW-WRITE LIVES HERE, NOT IN THE CORE
 * ---------------------------------------------
 * `install-event-core` materializes a verified package directory and stops there, on
 * purpose: if the Cupboard install layer registered keys itself it would BECOME a second
 * resolver, and `events:catalog` would have two disagreeing sources of truth — the exact
 * drift P-029's registry half exists to end. D-010 keeps `event_key_registry` as the ONE
 * resolution layer, so distribution (the package on disk) and resolution (the row) are two
 * steps, and this seam is the only place they meet.
 *
 * That split has a consequence worth stating plainly: a package installed WITHOUT a seeded
 * row is inert — a rule's `on` and an agent's `events:await` resolve through the registry,
 * not through the installed directory, so an unseeded vocabulary is a listener parked on a
 * key that resolves nowhere. That is precisely the silent-inertness failure P-029 names. So
 * a failed seed is reported as a failed INSTALL, never as a success with a warning.
 *
 * THE CURATED/DERIVED BOUNDARY (D-058) IS ENFORCED ONE LEVEL DOWN, NOT HERE
 * ------------------------------------------------------------------------
 * A package carries only the CURATED half of a registry row. `emitter` / `emitterExists` /
 * `emitSiteCount` / `derivedFrom` / `derivedAt` are measurements of the PUBLISHER's tree and
 * are REFUSED at parse time by `readEventDir` — refused, never silently dropped — so by the
 * time a package reaches this seam it cannot express the derived half at all. This file
 * deliberately does NOT re-check that: a second copy of the rule would be a second place for
 * it to drift, and the parse-time refusal is the stronger one anyway (it rejects the package,
 * not just the row write). The derived half is written only by `recordEventKeyDerivation`,
 * against the INSTALLING pot's own tree, behind the derived-dated CHECK constraint.
 *
 * `RegisterEventKeyInput` mirrors that boundary in the type system: it has no field for a
 * derived measurement, so the projection below is total by construction.
 */
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';
import { installEventFromCupboardCore, InstallEventError } from './install-event-core';
import { installedEventRef, resolveInstalledEvent, type InstalledEvent } from './event-store';
import type { RegisterEventKeyInput } from '../event-key-registry-store';

export interface InstallEventInput {
  listingId?: string;
  githubUrl?: string;
  listingRef?: string;
  update?: boolean;
  /** The workspace whose registry row is seeded — the resolution half (D-010). */
  workspaceId: string;
  createdBy?: string;
}

export interface InstallEventDeps {
  /** Seed/refresh the `event_key_registry` row from the installed package. Injected so the
   *  seam is testable without Postgres, and so the registry stays the one writer. */
  seedRegistry: (input: RegisterEventKeyInput) => Promise<{ eventKey: string }>;
}

export interface InstalledEventResult extends InstalledEvent {
  ok: true;
  ref: string;
  installedTo: string;
  operation: 'install' | 'update' | 'no-op';
  /** The registry key this install made resolvable. NOT a surrogate id: `event_key_registry`
   *  is keyed NATURALLY on (workspaceId, eventKey) — `EventKeyRow` has no `id` column at all,
   *  unlike `datatype_registry`. So the honest thing to hand back is the key an
   *  `events:await` can now resolve, which is also the only identity the row has. */
  registeredKey: string;
}

export type InstallEventResult =
  | { ok: true; result: InstalledEventResult }
  | { ok: false; status: number; error: string; detail?: string };

/** The default seeder: the registry store, reached through the harness pool. Imported lazily
 *  so a test (or an export-only caller) never opens a pool it will not use. */
async function defaultSeedRegistry(input: RegisterEventKeyInput): Promise<{ eventKey: string }> {
  const [{ getOrgPg }, { registerEventKey }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../event-key-registry-store'),
  ]);
  const row = await registerEventKey(getOrgPg().sql, input);
  return { eventKey: row.eventKey };
}

/** Project an installed package into the registry write. Kept separate from the install so
 *  the mapping is readable on its own — it is the D-010 boundary.
 *
 *  `contributor` is stamped from the package's own source rather than taken from the
 *  manifest: a publisher naming its own provenance is exactly the hand-authored claim the
 *  derived-truth ladder forbids, and `readEventDir` already refuses a manifest that carries
 *  one. What is recorded here is what the INSTALL observed — which listing this key arrived
 *  from — so the row's provenance is a fact about this pot, not a publisher's assertion. */
export function registryInputFromPackage(
  event: InstalledEvent,
  workspaceId: string,
  createdBy?: string,
): RegisterEventKeyInput {
  return {
    workspaceId,
    eventKey: event.eventKey,
    title: event.title,
    description: event.description,
    keyPattern: event.keyPattern,
    contributor: `cupboard:${event.packageRef}`,
    tags: event.tags,
    ...(createdBy ? { createdBy } : {}),
  };
}

export async function installEventFromCupboard(
  input: InstallEventInput,
  deps: InstallEventDeps = { seedRegistry: defaultSeedRegistry },
): Promise<InstallEventResult> {
  const workspaceId = String(input.workspaceId ?? '').trim();
  if (!workspaceId) return { ok: false, status: 400, error: 'workspaceId required' };

  let githubUrl = input.githubUrl?.trim() ?? '';
  let listingRef = input.listingRef?.trim() ?? '';
  let releaseVersion: string | undefined;
  // The Worker's publish-time content pin (P-002): only a listing carries one, so a direct
  // githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;
  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'event');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef ||= resolved.ref;
    releaseVersion = resolved.releaseVersion;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) return { ok: false, status: 400, error: 'listingRef required' };

  const targetRef = installedEventRef(githubUrl, listingRef);
  const existing = resolveInstalledEvent(targetRef);
  // A no-op still re-seeds: the package being present says nothing about the row, and a
  // package installed before its seed failed must be recoverable by re-running. This is the
  // repair path for the inert-install case the header describes.
  if (existing && releaseVersion && existing.version === releaseVersion && input.update !== true) {
    const seeded = await seed(existing, workspaceId, input.createdBy, deps);
    if (!seeded.ok) return seeded;
    return {
      ok: true,
      result: { ...existing, ok: true, ref: targetRef, installedTo: existing.dir, operation: 'no-op', registeredKey: seeded.eventKey },
    };
  }
  if (existing && input.update !== true) {
    return {
      ok: false,
      status: 409,
      error: `event "${existing.eventKey}" is already installed; pass update:true to replace it`,
    };
  }

  let installed: Awaited<ReturnType<typeof installEventFromCupboardCore>>;
  try {
    installed = await installEventFromCupboardCore(
      { githubUrl, listingRef, targetRef, replaceExisting: existing !== null && input.update === true, pin },
      cupboardGitDeps(),
    );
  } catch (error) {
    if (error instanceof InstallEventError) return { ok: false, status: error.status, error: error.message };
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
      registeredKey: seeded.eventKey,
    },
  };
}

async function seed(
  event: InstalledEvent,
  workspaceId: string,
  createdBy: string | undefined,
  deps: InstallEventDeps,
): Promise<{ ok: true; eventKey: string } | { ok: false; status: number; error: string; detail?: string }> {
  try {
    const row = await deps.seedRegistry(registryInputFromPackage(event, workspaceId, createdBy));
    return { ok: true, eventKey: row.eventKey };
  } catch (error) {
    // The package is on disk but its keys resolve nowhere, so this is an install failure —
    // never a success with a warning. An `events:await` on this vocabulary would be silently
    // inert, which is the failure mode P-029 exists to close.
    return {
      ok: false,
      status: 500,
      error: 'event installed but its registry row could not be seeded — its keys are not resolvable yet; re-run to retry',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
