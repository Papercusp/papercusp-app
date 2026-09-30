/** Pure version-bump transforms. No I/O — apply over file *text*. */
import type { VersionFile } from './types.js';

/** Set a (possibly dotted) field on a parsed JSON object, in place. */
function setDeep(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Rewrite a JSON file's version field. Mirrors release-local.sh:
 * 2-space indent + trailing newline (key order preserved by JSON round-trip).
 */
export function bumpJson(text: string, version: string, field = 'version'): string {
  const obj = JSON.parse(text) as Record<string, unknown>;
  setDeep(obj, field, version);
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Rewrite the FIRST `version = "…"` line in a Cargo.toml. Mirrors
 * release-local.sh's `re.sub(r'(?m)^version = "[^"]+"', …, count=1)` —
 * the package version is the first such line; deps further down are untouched.
 */
export function bumpCargoToml(text: string, version: string): string {
  let replaced = false;
  return text.replace(/^version = "[^"]+"/m, (m) => {
    if (replaced) return m;
    replaced = true;
    return `version = "${version}"`;
  });
}

/** Apply the right transform for a VersionFile over its current text. */
export function applyVersionBump(
  file: VersionFile,
  text: string,
  version: string,
): string {
  switch (file.kind) {
    case 'json':
      return bumpJson(text, version, file.field ?? 'version');
    case 'cargo-toml':
      return bumpCargoToml(text, version);
  }
}
