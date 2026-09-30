/**
 * Directory of the calling module, across the runtimes this package actually
 * runs under. `import.meta.dirname` exists in real ESM (Node ≥20.11, vitest)
 * — but the operator Hono host runs these files through tsx's CJS transform
 * (apps/operator has no `"type": "module"`), where `dirname` is undefined and
 * a bare `resolve(import.meta.dirname, …)` throws `paths[0] must be of type
 * string`. There `import.meta.url` IS shimmed, so derive from that. Returns
 * null only when neither is available; callers must treat the result as one
 * candidate among several, not a certainty.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleDir(meta: ImportMeta): string | null {
  if (meta.dirname) return meta.dirname;
  if (meta.url) {
    try {
      return dirname(fileURLToPath(meta.url));
    } catch {
      return null;
    }
  }
  return null;
}
