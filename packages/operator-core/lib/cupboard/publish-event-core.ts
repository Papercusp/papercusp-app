/** Publish a locally-registered event key as a Cupboard `event` listing.
 *
 * This is the DISTRIBUTION half of identities-v1-2026-08-30 P-029 (D-010/D-011).
 * It closes a gap that has been live since the Cupboard's first release:
 * `requires_events` already lets a listing depend on an event family — and an
 * unresolvable dependency is a hard install failure — but only first-party
 * families could ever resolve, because nothing could PUBLISH one. `event` is in
 * REVIEW_POLICY_KINDS, so this publishes PENDING; an event vocabulary is
 * moderated like every other kind rather than auto-approved into the namespace.
 *
 * The definition still resolves from `event_key_registry` (D-010): this reads
 * the registry row and exports it as a package. It never becomes the source of
 * truth, and it never registers anything — seeding a row is the install seam's
 * job, not the publisher's.
 */
import { publishListingToCupboard } from './publish-listing';
import { fetchGithubRepoMeta, parseGithubRemote } from './resolve-repo-coords';
import {
  forbiddenManifestFields,
  writeEventPackageDir,
  type EventExportSource,
  type WrittenEventPackage,
} from './event-store';

export interface PublishEventInput {
  /** The `event_key_registry` key to publish, in canonical form. */
  eventKey: string;
  github_url: string;
  listing_ref?: string;
  project_ref?: string;
  version?: string;
  title?: string;
  description?: string;
  exportOnly?: boolean;
}

export interface PublishEventDeps {
  /** Resolution stays with the registry (D-010) — injected, never re-implemented here. */
  listEventKeys: () => Promise<EventExportSource[]>;
  writePackage: typeof writeEventPackageDir;
  fetchRepo: typeof fetchGithubRepoMeta;
  publish: typeof publishListingToCupboard;
}

export type PublishEventResult =
  | { ok: true; exportedOnly: boolean; export: WrittenEventPackage; listing?: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

export async function publishEventToCupboard(
  input: PublishEventInput,
  deps: PublishEventDeps,
): Promise<PublishEventResult> {
  const eventKey = String(input.eventKey ?? '').trim();
  const event = (await deps.listEventKeys()).find((candidate) => candidate.eventKey === eventKey);
  if (!event) return { ok: false, status: 404, error: `event key "${eventKey}" not registered in this workspace` };

  // D-058: refuse a row still carrying the DERIVED half (emitter/emitSiteCount/…)
  // or install-site lifecycle (contributor/status/…). `EventExportSource` excludes
  // both by TYPE, but a type is erased at runtime and `writeEventPackageDir` builds
  // its manifest by explicit field pick — so an over-full row would be dropped
  // SILENTLY, which is the worse failure: the publisher keeps believing their
  // attestation shipped, and the installing pot would have received a measurement
  // of the PUBLISHER's tree presented as one of its own. Same list the parser
  // enforces on the way back in, imported rather than restated so the two halves
  // of one rule cannot drift apart.
  const forbidden = forbiddenManifestFields(event as unknown as Record<string, unknown>);
  if (forbidden.length > 0) {
    return {
      ok: false,
      status: 422,
      error:
        `event "${eventKey}" carries non-distributable fields: ${forbidden.join(', ')}. ` +
        'The derived half is a measurement of THIS tree and the lifecycle fields belong to the ' +
        'install site; both are re-derived after install. Export the curated fields only.',
    };
  }

  const githubUrl = String(input.github_url ?? '').trim();
  const repo = parseGithubRemote(githubUrl);
  if (!repo) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };

  let written: WrittenEventPackage;
  try {
    written = deps.writePackage(event, {
      ref: input.listing_ref ?? eventKey,
      version: input.version,
      description: input.description,
      source: githubUrl,
    });
  } catch (error) {
    return { ok: false, status: 422, error: error instanceof Error ? error.message : String(error) };
  }
  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: written };

  const meta = await deps.fetchRepo(repo.owner, repo.repo);
  if (!meta) return { ok: false, status: 422, error: `could not resolve GitHub repo ${repo.owner}/${repo.repo}` };
  const result = await deps.publish({
    listing_kind: 'event',
    // `written.ref`, NOT the requested ref: an event key is colon-delimited
    // (`work-item:done:*`) and `writeEventPackageDir` sanitizes it to a safe
    // directory name. Publishing under the raw key would file the listing under
    // an identity that no longer matches the package dir it points at — a
    // divergence the datatype path never sees, because datatype ids are already
    // kebab slugs and its sanitizer is a no-op on them.
    listing_ref: written.ref,
    ...(input.project_ref ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: repo.owner,
    github_name: repo.repo,
    github_url: meta.html_url || githubUrl,
    title: input.title?.trim() || written.manifest.title,
    description: input.description?.trim() || written.manifest.description,
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, exportedOnly: false, export: written, listing: result.data };
}
