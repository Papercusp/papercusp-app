/**
 * Canonical-manifest sha256 (§15.4 publishing, §15.5 snapshots).
 *
 * Substrate and Worker both run this on the same manifest input, then the
 * Worker checks the result against the JWT's `sha256` claim. Without
 * deterministic canonicalization, NFC vs NFD path encoding (macOS) and
 * key-order differences across JSON serializers silently break JWT
 * signature validation.
 *
 * The manifest is a JSON value; we apply NFC normalization to all `path`
 * fields, sort `files[]` by path UTF-16 order, then JCS-canonicalize.
 */

import { canonicalizeBytes } from './jcs';
import { toHex } from './hex';
import type { CanonicalManifest, ManifestFile } from './types';

export function normalizeManifest(input: CanonicalManifest): CanonicalManifest {
  const files: ManifestFile[] = input.files
    .map((f) => ({
      path: f.path.normalize('NFC'),
      sha256: f.sha256,
      bytes: f.bytes,
    }))
    .sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });
  return { files, deployment_slug: input.deployment_slug };
}

export async function manifestSha256Hex(
  manifest: CanonicalManifest,
): Promise<string> {
  const normalized = normalizeManifest(manifest);
  const bytes = canonicalizeBytes(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

export async function fileSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}
