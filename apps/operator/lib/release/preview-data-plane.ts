/**
 * preview-data-plane — the missing half of the pre-gate preview (WI-3732 follow-up).
 *
 * `next.config.mjs`'s PAPERCUSP_PREVIEW_DATA_ORIGIN proxy let a staging-tree UI
 * ride the LIVE backend's data. That covers every change EXCEPT the one that adds
 * a NEW named query: the live backend has no resolver for it, so the preview gets
 * `unknown queryName` and the new panel renders empty — exactly the case that
 * blocked previewing /rubrics (`rubrics.list`) on 2026-07-10.
 *
 * This process closes that gap. It is a SHIM IN FRONT OF the live backend:
 *
 *     preview UI (:3171) ──▶ data plane (:3172) ──▶ live release backend (:3070)
 *                                   │
 *                                   └─▶ STAGING resolveNamedQueryV2 (this tree)
 *
 *   - `/api/zero-harness/rest-query`: resolved HERE, against the staging tree's
 *     query registry — so a brand-new resolver works the moment it is written,
 *     reading the same live Postgres the release process reads. (The companion
 *     `/rest-query-batch` was removed with the client batcher in
 *     drop-sync-batcher-2026-07-25; every sync read is now one request.)
 *   - Everything else (`/sse`, other `/api/*`, auth, mutations): proxied verbatim
 *     upstream, streaming preserved. This process defines no writes of its own;
 *     named queries are reads by construction.
 *   - A name the staging registry doesn't know is NOT an error here — it is
 *     delegated upstream, so this shim can never be *less* capable than the plain
 *     proxy it replaces.
 *
 * It reads the live store but is not part of the release: nothing here runs in
 * production, and the release process is untouched (no restart, no lock, no
 * migration). It is a preview affordance, and it exits non-zero rather than
 * guessing if its upstream is unset.
 *
 * Usage (both processes, staging tree):
 *   PAPERCUSP_PREVIEW_UPSTREAM=http://localhost:3070 \
 *     tsx apps/operator/lib/release/preview-data-plane.ts          # :3172
 *   PAPERCUSP_PREVIEW_DATA_ORIGIN=http://localhost:3172 \
 *     next dev -p 3171                                             # apps/operator
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '@papercusp/operator-core/lib/sync-resolver';

const PORT = Number(process.env.PAPERCUSP_PREVIEW_DATA_PLANE_PORT ?? 3172);
const UPSTREAM = (process.env.PAPERCUSP_PREVIEW_UPSTREAM ?? '').replace(/\/+$/, '');

if (!UPSTREAM) {
  console.error(
    '[preview-data-plane] PAPERCUSP_PREVIEW_UPSTREAM is required (e.g. http://localhost:3070) — ' +
      'this shim delegates every non-named-query request there.',
  );
  process.exit(2);
}

const REST_QUERY = '/api/zero-harness/rest-query';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // The preview UI is a different origin (:3171) than this plane (:3172).
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve one named query against the STAGING registry; `null` ⇒ delegate upstream. */
async function resolveLocal(name: string, args: unknown): Promise<{ rows: unknown[] } | null> {
  const rows = await resolveNamedQueryV2(name, args);
  if (rows === NAME_NOT_FOUND) return null;
  return { rows: rows as unknown[] };
}

/** Stream a request upstream verbatim (headers, body, status, streaming body back). */
async function proxyUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = `${UPSTREAM}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || k === 'connection') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
    redirect: 'manual',
  });

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    // content-length can disagree once we re-stream; let node recompute.
    if (key !== 'content-length' && key !== 'content-encoding') outHeaders[key] = value;
  });
  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }
  // Preserve streaming (SSE): forward chunks as they arrive, never buffer.
  const reader = upstream.body.getReader();
  req.on('close', () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === REST_QUERY) {
    const name = url.searchParams.get('name');
    if (!name) return sendJson(res, 400, { error: 'missing name' });
    let args: unknown;
    try {
      args = JSON.parse(url.searchParams.get('args') ?? '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid args (not JSON)' });
    }
    const local = await resolveLocal(name, args);
    if (local) {
      console.log(`[preview-data-plane] staging resolver served ${name} (${local.rows.length} rows)`);
      return sendJson(res, 200, local);
    }
    // Unknown to THIS tree — the live backend may still know it (e.g. the preview
    // tree is behind on some other resolver). Never fail where the proxy would work.
    return proxyUpstream(req, res);
  }

  return proxyUpstream(req, res);
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('[preview-data-plane] request failed', err);
    if (!res.headersSent) sendJson(res, 502, { error: 'preview data plane failure' });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(
    `[preview-data-plane] :${PORT} → staging named queries served locally, everything else proxied to ${UPSTREAM}`,
  );
});
