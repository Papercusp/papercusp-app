/**
 * GET /api/scratch/<workspace>/<toolName>/<runId>/<basename>
 *
 * Serves a tool's outputRef scratch file. Path-traversal rejected at
 * three layers (parseScratchUri regex, safeScratchFilesystemPath
 * containment, active-workspace check).
 *
 * Ported from app/api/scratch/[...path]/route.ts. The Next `[...path]`
 * catch-all → Hono `:path{.+}`. `auth: 'public'` — the handler's own
 * workspace check is the gate.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  parseScratchUri,
  safeScratchFilesystemPath,
  ScratchUriError,
  SCRATCH_SCHEME,
} from '../../../scratch-uri';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import {
  authorizeScratchReference,
  parseScratchReference,
  ScratchReferenceError,
} from '../../../scratch-reference';

function json400(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'bad_request', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function guessContentType(basename: string): string {
  const ext = basename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'txt':
    case 'log':
    case 'md':
    case 'html': return 'text/plain';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'application/octet-stream';
    case 'pdf': return 'application/pdf';
    case 'zip': return 'application/zip';
    case 'gz': return 'application/gzip';
    default: return 'application/octet-stream';
  }
}

function safeManifestContentType(mediaType: string): string {
  const normalized = mediaType.toLowerCase().split(';', 1)[0].trim();
  if (normalized === 'text/html' || normalized === 'image/svg+xml') return 'application/octet-stream';
  return /^(?:text\/[a-z0-9.+-]+|application\/(?:json|pdf|zip|gzip)|image\/(?:png|jpeg|gif|webp))$/u.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

export default defineTool({
  method: 'GET',
  path: '/scratch/:path{.+}',
  auth: 'public',
  sampleRate: 0,
  async handler(_req, ctx) {
    // Use the captured `:path{.+}` segment rather than parsing req.url:
    // host-neutral (works under Hono base-path, raw mount, or tests).
    const rest = ctx.params.path ?? '';
    const uri = `${SCRATCH_SCHEME}/${rest}`;

    let parts;
    try {
      parts = parseScratchUri(uri);
    } catch (err) {
      return json400(err instanceof ScratchUriError ? err.message : 'invalid scratch URI');
    }

    const ws = activeWorkspaceId();
    if (parts.workspaceId !== ws) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'forbidden_cross_workspace',
            message: `scratch URI references workspace "${parts.workspaceId}"; operator's active workspace is "${ws}"`,
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }

    let fsPath: string;
    try {
      fsPath = safeScratchFilesystemPath(uri);
    } catch (err) {
      return json400(err instanceof ScratchUriError ? err.message : 'invalid scratch path');
    }
    if (!existsSync(fsPath)) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'scratch file does not exist' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const st = statSync(fsPath);
    if (!st.isFile()) {
      return new Response(
        JSON.stringify({ error: { code: 'not_a_file', message: 'scratch path is not a regular file' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    let payload = readFileSync(fsPath);
    let contentType = guessContentType(parts.basename);
    try {
      const reference = parseScratchReference(payload);
      if (reference) {
        authorizeScratchReference(reference.manifest, {
          workspaceId: ws,
          ownerId: ctx.principal?.slug ?? null,
        });
        payload = Buffer.from(reference.payload);
        contentType = safeManifestContentType(reference.manifest.mediaType);
      }
    } catch (err) {
      if (err instanceof ScratchReferenceError) {
        const status = err.code === 'expired_reference' ? 410 : err.code === 'invalid_reference' || err.code === 'integrity_mismatch' ? 422 : 403;
        return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw err;
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(payload.length),
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${parts.basename}"`,
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
