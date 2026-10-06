/**
 * JSON-input helpers shared by the workspace-host image release CLIs (GCP image family and AWS AMI).
 *
 * Both CLIs read an operator-authored request file and an optional guest-tool versions file; the
 * error messages name the path but never echo file contents, which can carry connection metadata.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse `--guest-tool-versions-file`: a flat object of tool name -> non-empty version string. */
export function parseGuestToolVersions(
  raw: unknown,
): Readonly<Record<string, string>> {
  if (!isRecord(raw))
    throw new Error("guest tool versions file must contain a JSON object");
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw)) {
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(
        `guest tool version for ${name} must be a non-empty string`,
      );
    }
    versions[name] = version.trim();
  }
  return versions;
}

export async function readJsonInput(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<unknown> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    throw new Error(`cannot read JSON input '${path}'`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`JSON input '${path}' is not valid JSON`);
  }
}
