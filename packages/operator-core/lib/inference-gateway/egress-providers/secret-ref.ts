/**
 * Generic secret REFERENCE resolver for EgressProvider backends (B-PROV) — mirrors the
 * `credentialRef` convention (`accounts:register`, `inference-gateway/credential-store.ts`'s
 * `parseCredentialRef`): callers pass a REFERENCE (`env:NAME` | `file:<path>` | an absolute/`~` path),
 * never the literal secret, so provider config is safe to log/persist/federate. Resolution happens
 * only at the point of use (e.g. building a REST auth header), never eagerly.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

/**
 * Resolve a secret reference to its value. `env:NAME` reads `process.env[NAME]`; `file:<path>` |
 * an absolute path | a `~`-path reads the (trimmed) file contents. Throws a descriptive error if the
 * reference is malformed or unresolvable — callers should let this surface, not swallow it (a silent
 * empty-string credential produces a confusing downstream 401, not a clear "you forgot to set it").
 */
export async function resolveSecretRef(ref: string): Promise<string> {
  const trimmedRef = ref.trim();
  if (trimmedRef.startsWith('env:')) {
    const name = trimmedRef.slice(4).trim();
    if (!name) throw new Error(`egress: malformed secret ref '${ref}' (expected env:NAME)`);
    const value = process.env[name];
    if (!value) throw new Error(`egress: env var '${name}' is not set (referenced by 'env:${name}')`);
    return value;
  }
  const path = trimmedRef.startsWith('file:')
    ? expandHome(trimmedRef.slice(5))
    : trimmedRef.startsWith('/') || trimmedRef.startsWith('~')
      ? expandHome(trimmedRef)
      : null;
  if (!path) {
    throw new Error(`egress: unsupported secret ref '${ref}' (expected env:NAME | file:<path> | an absolute/~ path)`);
  }
  const raw = await fs.readFile(path, 'utf8');
  const value = raw.trim();
  if (!value) throw new Error(`egress: secret file '${path}' is empty`);
  return value;
}
