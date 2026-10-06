/**
 * The MEASURED digest a GCP image release attests as `buildManifest.baseImage.sha256`.
 *
 * ## Why this exists (WI-10005746)
 *
 * The bootc release path binds `baseImage.sha256` to the image it actually built from: the OCI
 * digest of the pinned base, read off the image itself (WI-10005711). The GCP Packer path did not.
 * `gcp-image-release-request-cli` copied `baseImage.sha256` verbatim from its input file, every
 * later layer validated only its FORMAT, and the adapter handed it to Packer, which recorded it in
 * the image provenance. So the provenance attested a value no code had ever compared to the base
 * image, and the adapter's `sourceImage` override could build from one image while attesting
 * another's digest.
 *
 * ## What is measured
 *
 * A GCE image is an API resource, not an OCI artifact: it has no content digest to read. What it
 * does have is an immutable identity. `id` is a server-assigned uint64 that is never reused, so an
 * image deleted and recreated under the same name gets a new one, and `creationTimestamp` is fixed
 * at creation. The digest is SHA-256 over a canonical JSON of the scheme, the immutable reference
 * and those two fields. Mutable fields (`status`, `deprecated`, `labels`, `description`) are
 * deliberately excluded: a public base image is deprecated over time, and that must not change
 * the digest of the image a past release was built from.
 *
 * Both the request CLI (which emits the digest) and the adapter (which re-measures the image it
 * actually passes to Packer, immediately before the billable build) call `measureGcpBaseImage`,
 * so the two can only agree if they read the same resource.
 */
import { createHash } from 'node:crypto';

import { parseGcpImmutableImageId } from './gcp-image-family';
import type { GcpImageFamilyComputeApi, GcpImageFamilyComputeImage } from './gcp-image-family-adapter';

export const GCP_BASE_IMAGE_IDENTITY_SCHEME = 'gce-image-identity-v1';

export interface GcpBaseImageIdentity {
  scheme: typeof GCP_BASE_IMAGE_IDENTITY_SCHEME;
  /** `projects/{project}/global/images/{name}` — the immutable reference that was looked up. */
  reference: string;
  /** The server-assigned resource id, as a decimal string (the API returns it as a string). */
  id: string;
  creationTimestamp: string;
}

export interface GcpBaseImageMeasurement {
  sha256: string;
  identity: GcpBaseImageIdentity;
}

/** Only the getter is needed; either spelling the adapter accepts is honoured. */
export type GcpBaseImageReader = Pick<GcpImageFamilyComputeApi, 'getImage' | 'getImageByName'>;

/**
 * Build the identity of `image`, which must be the resource `reference` names.
 *
 * Throws when the API response lacks an immutable field rather than hashing a partial identity:
 * a digest over `{ reference }` alone would be equal for every image ever created under that name.
 */
export function gcpBaseImageIdentity(
  reference: string,
  image: GcpImageFamilyComputeImage,
): GcpBaseImageIdentity {
  const coordinates = parseGcpImmutableImageId(reference, 'baseImage.reference');
  if (image.name !== coordinates.imageName) {
    throw new Error(
      `GCP base image lookup for ${reference} returned image '${image.name}'; refusing to measure a different resource`,
    );
  }
  const id = image.id === undefined || image.id === null ? '' : String(image.id).trim();
  if (!/^[0-9]+$/.test(id)) {
    throw new Error(`GCP base image ${reference} has no numeric resource id; cannot measure its identity`);
  }
  const creationTimestamp = (image.creationTimestamp ?? '').trim();
  if (!creationTimestamp || !Number.isFinite(Date.parse(creationTimestamp))) {
    throw new Error(`GCP base image ${reference} has no creationTimestamp; cannot measure its identity`);
  }
  return {
    scheme: GCP_BASE_IMAGE_IDENTITY_SCHEME,
    reference: `projects/${coordinates.projectId}/global/images/${coordinates.imageName}`,
    id,
    creationTimestamp,
  };
}

/** SHA-256 over the identity's canonical JSON (fixed key order, no whitespace). */
export function gcpBaseImageIdentityDigest(identity: GcpBaseImageIdentity): string {
  const canonical = JSON.stringify({
    scheme: identity.scheme,
    reference: identity.reference,
    id: identity.id,
    creationTimestamp: identity.creationTimestamp,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Look `reference` up through the Compute API and return its measured digest. */
export async function measureGcpBaseImage(
  compute: GcpBaseImageReader,
  reference: string,
): Promise<GcpBaseImageMeasurement> {
  const coordinates = parseGcpImmutableImageId(reference, 'baseImage.reference');
  const getter = compute.getImage ?? compute.getImageByName;
  if (!getter) throw new Error('GCP Compute adapter does not implement getImage');
  const image = await getter.call(compute, coordinates.projectId, coordinates.imageName);
  if (!image) {
    throw new Error(`GCP base image ${reference} was not found; refusing to attest a digest for it`);
  }
  const identity = gcpBaseImageIdentity(reference, image);
  return { sha256: gcpBaseImageIdentityDigest(identity), identity };
}
