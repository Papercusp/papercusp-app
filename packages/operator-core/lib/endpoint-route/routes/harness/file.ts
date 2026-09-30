/**
 * GET /api/harness/:slug/file?path=<rel> — read manifest-allowlisted config file.
 * PUT /api/harness/:slug/file — write same.
 *
 * Path constrained to harness manifest configFiles allowlist. A config-file
 * entry may additionally declare an absolute `root` when a deliberately
 * shared configuration directory lives outside the harness checkout:
 *
 *   { "path": "settings.json", "root": "/srv/shared-config" }
 *
 * `root` is an explicit grant, not a caller-selected path. Without it the
 * canonical harness checkout is the only permitted root.
 *
 * Ported from app/api/harness/[slug]/file/route.ts. `auth: 'loopback'` keeps
 * local configuration contents off network-exposed operator binds.
 */
import { constants, promises as fs, existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { papercuspPath } from '../../../papercusp-root';
import { loadHarnessRegistry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

interface ConfigFile {
  path: string;
  /**
   * Explicit absolute root grant for shared configuration. The route never
   * accepts this value from the request.
   */
  root?: unknown;
  language?: string;
  label?: string;
}

interface AuthorizedFile {
  /** Canonical root selected by the manifest grant. */
  root: string;
  /** Components relative to `root`, after lexical validation. */
  parts: string[];
}

type FileErrorCode =
  | 'invalid_path'
  | 'path_escape'
  | 'root_unavailable'
  | 'parent_not_found'
  | 'not_found'
  | 'not_a_file'
  | 'file_identity_unavailable';

class FileRouteError extends Error {
  constructor(readonly code: FileErrorCode) {
    super(code);
    this.name = 'FileRouteError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configFiles(value: unknown): ConfigFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.length === 0) return [];
    return [{ path: entry.path, root: entry.root, language: entry.language as string | undefined, label: entry.label as string | undefined }];
  });
}

async function loadConfigFiles(projectPath: string): Promise<ConfigFile[]> {
  const projectManifest = join(projectPath, '.papercusp', 'papercusp.json');
  let manifest: { configFiles?: unknown } | null = null;
  if (existsSync(projectManifest)) {
    try { manifest = JSON.parse(await fs.readFile(projectManifest, 'utf8')); } catch { /* ignore */ }
  }
  if (!manifest || !Array.isArray(manifest.configFiles)) {
    const harnessesDir = papercuspPath('harnesses');
    const dirs = await fs.readdir(harnessesDir, { withFileTypes: true }).catch(() => []);
    const dirManifests = await Promise.all(dirs.map(async (d) => {
      if (!d.isDirectory()) return null;
      try {
        const m = JSON.parse(await fs.readFile(join(harnessesDir, d.name, 'papercusp.json'), 'utf8'));
        return m && Array.isArray(m.configFiles) ? m : null;
      } catch { return null; }
    }));
    const found = dirManifests.find((m) => m != null);
    if (found) manifest = found;
  }
  const cfg = configFiles(manifest?.configFiles);
  if (cfg.length > 0) return cfg;
  return [
    // SPEC.md + validation-contract.md dropped — deprecated (D-004/D-005).
    'AGENTS.md', '.papercusp/config.json',
    '.mcp.json', '.claude/settings.json',
    '.papercusp/supervisor-notes.md', '.papercusp/knowledge.md',
    '.env',
  ].map((path) => ({ path }));
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeParts(path: string): string[] | null {
  if (!path || path.includes('\0') || isAbsolute(path)) return null;
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..')) return null;
  const clean = parts.filter((part) => part !== '' && part !== '.');
  return clean.length > 0 ? clean : null;
}

function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function mapOpenError(error: unknown, missing: FileErrorCode): FileRouteError | unknown {
  const code = errnoCode(error);
  if (code === 'ENOENT') return new FileRouteError(missing);
  if (code === 'ELOOP') return new FileRouteError('path_escape');
  return error;
}

async function canonicalRoot(path: string): Promise<string> {
  try {
    const root = await fs.realpath(resolve(path));
    if (!inside(root, root)) throw new FileRouteError('root_unavailable');
    return root;
  } catch (error) {
    if (error instanceof FileRouteError) throw error;
    throw new FileRouteError('root_unavailable');
  }
}

async function validateDescriptor(handle: FileHandle, root: string): Promise<void> {
  // Linux lets us validate the object actually opened, not the path that was
  // checked before open. This closes both final-link and parent-link swaps.
  // The fd remains authoritative while the caller reads or writes it.
  if (process.platform !== 'linux') return;
  const opened = await fs.realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);
  if (!opened) throw new FileRouteError('file_identity_unavailable');
  if (!inside(root, opened)) throw new FileRouteError('path_escape');
}

async function closeHandles(handles: FileHandle[]): Promise<void> {
  for (const handle of handles.reverse()) {
    await handle.close().catch(() => {});
  }
}

/**
 * Execute an operation against an opened target. On Linux every parent
 * component is traversed from an already-open directory descriptor through
 * `/proc/self/fd`, and the target descriptor is canonicalized before any
 * bytes are touched. Final symlinks are intentionally followed so valid
 * in-root links keep working; the opened descriptor, rather than the mutable
 * pathname, is what is authorized.
 */
async function withOpenedTarget<T>(
  file: AuthorizedFile,
  flags: number,
  action: (handle: FileHandle) => Promise<T>,
  createParents: boolean,
): Promise<T> {
  const root = await canonicalRoot(file.root);

  if (process.platform !== 'linux') {
    const candidate = resolve(root, ...file.parts);
    if (!inside(root, candidate)) throw new FileRouteError('path_escape');
    if (createParents) await fs.mkdir(resolve(root, ...file.parts.slice(0, -1)), { recursive: true });
    const parent = await fs.realpath(resolve(candidate, '..')).catch(() => {
      throw new FileRouteError('parent_not_found');
    });
    if (!inside(root, parent)) throw new FileRouteError('path_escape');
    const handle = await fs.open(candidate, flags, 0o600).catch((error) => mapOpenError(error, 'not_found') as never);
    try {
      const resolved = await fs.realpath(candidate).catch(() => null);
      if (!resolved || !inside(root, resolved)) throw new FileRouteError('path_escape');
      return await action(handle);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  const handles: FileHandle[] = [];
  try {
    const rootHandle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY).catch((error) => {
      throw mapOpenError(error, 'root_unavailable');
    });
    handles.push(rootHandle);
    let parent = rootHandle;

    for (const part of file.parts.slice(0, -1)) {
      const childPath = `/proc/self/fd/${parent.fd}/${part}`;
      let child: FileHandle;
      try {
        child = await fs.open(childPath, constants.O_RDONLY | constants.O_DIRECTORY);
      } catch (error) {
        if (!createParents || errnoCode(error) !== 'ENOENT') {
          throw mapOpenError(error, 'parent_not_found');
        }
        try {
          await fs.mkdir(childPath);
        } catch (mkdirError) {
          if (errnoCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        child = await fs.open(childPath, constants.O_RDONLY | constants.O_DIRECTORY).catch((openError) => {
          throw mapOpenError(openError, 'parent_not_found');
        });
      }
      handles.push(child);
      await validateDescriptor(child, root);
      parent = child;
    }

    const targetPath = `/proc/self/fd/${parent.fd}/${file.parts[file.parts.length - 1]}`;
    const target = await fs.open(targetPath, flags, 0o600).catch((error) => {
      throw mapOpenError(error, 'not_found');
    });
    handles.push(target);
    await validateDescriptor(target, root);
    return await action(target);
  } finally {
    await closeHandles(handles);
  }
}

async function authorize(
  slug: string,
  rel: string,
): Promise<{ ok: true; file: AuthorizedFile } | { ok: false; error: string; status: number }> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) return { ok: false, error: 'invalid slug', status: 400 };
  const project = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug);
  if (!project) return { ok: false, error: 'unknown project', status: 404 };
  const entries = await loadConfigFiles(project.path);
  const entry = entries.find((candidate) => candidate.path === rel);
  if (!entry) return { ok: false, error: `path "${rel}" not in manifest configFiles`, status: 403 };

  const parts = safeParts(rel);
  if (!parts) return { ok: false, error: 'path resolves outside project tree', status: 400 };

  let root = project.path;
  if (entry.root !== undefined) {
    if (typeof entry.root !== 'string' || !entry.root || !isAbsolute(entry.root) || entry.root.includes('\0')) {
      return { ok: false, error: 'invalid external root grant', status: 400 };
    }
    root = entry.root;
  }
  try {
    const canonical = await canonicalRoot(root);
    if (!inside(canonical, resolve(canonical, ...parts))) {
      return { ok: false, error: 'path resolves outside granted root', status: 403 };
    }
    return { ok: true, file: { root: canonical, parts } };
  } catch (error) {
    if (error instanceof FileRouteError && error.code === 'root_unavailable') {
      return { ok: false, error: 'granted root is unavailable', status: 400 };
    }
    throw error;
  }
}

function fileErrorResponse(error: unknown, rel: string, operation: 'read' | 'write'): Response {
  if (error instanceof FileRouteError) {
    if (error.code === 'not_found' && operation === 'read') {
      return Response.json({ path: rel, content: null, exists: false });
    }
    const status =
      error.code === 'path_escape' ? 403 :
      error.code === 'not_found' ? 404 :
      error.code === 'not_a_file' ? 400 :
      error.code === 'parent_not_found' ? 400 :
      error.code === 'invalid_path' ? 400 :
      500;
    return Response.json({ error: error.message }, { status });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/file',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const rel = url.searchParams.get('path') ?? '';
    if (!rel) return Response.json({ error: 'path query param required' }, { status: 400 });
    const auth = await authorize(slug, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    try {
      const content = await withOpenedTarget(
        auth.file,
        constants.O_RDONLY,
        async (handle) => {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new FileRouteError('not_a_file');
          return await handle.readFile('utf8');
        },
        false,
      );
      return Response.json({ path: rel, content, exists: true });
    } catch (error) {
      return fileErrorResponse(error, rel, 'read');
    }
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/harness/:slug/file',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    let body: { path?: string; content?: unknown };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const rel = String(body.path ?? '').trim();
    if (!rel) return Response.json({ error: 'path required' }, { status: 400 });
    const auth = await authorize(slug, rel);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return Response.json({ error: 'content (string) required' }, { status: 400 });
    try {
      const bytes = Buffer.byteLength(content, 'utf8');
      await withOpenedTarget(
        auth.file,
        constants.O_WRONLY | constants.O_CREAT,
        async (handle) => {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new FileRouteError('not_a_file');
          await handle.truncate(0);
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        },
        true,
      );
      return Response.json({ ok: true, path: rel, bytes });
    } catch (error) {
      return fileErrorResponse(error, rel, 'write');
    }
  },
});

export default [get, put];
