/**
 * The guest-tool versions a cloud image is tagged/described with, shared by every provider's
 * release path (WI-10006386 for AWS, WI-10006408 for GCP).
 *
 * `derived` is the request's set, derived by the release-request composer from the bake's own
 * syft SBOM (installed-rpm rows only). `override` is the operator's `--guest-tool-versions-file`.
 * An override may restate the derived versions but never contradict them, and may not name a tool
 * the SBOM does not record: either would publish the image with a version no evidence supports.
 * With no derived set (a request composed before derivation existed) the override is used as is;
 * the adapter still refuses when a required tool is unpinned.
 */
export function resolveSbomGuestToolVersions(
  derived: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!derived) return override;
  if (!override) return derived;
  const conflicts = Object.entries(override)
    .filter(([name, version]) => derived[name] !== version.trim())
    .map(([name, version]) =>
      derived[name] === undefined
        ? `${name} (override ${version}; the SBOM records no version)`
        : `${name} (override ${version}; SBOM ${derived[name]})`,
    );
  if (conflicts.length > 0) {
    throw new Error(`--guest-tool-versions-file disagrees with the bake SBOM: ${conflicts.join('; ')}`);
  }
  return derived;
}
