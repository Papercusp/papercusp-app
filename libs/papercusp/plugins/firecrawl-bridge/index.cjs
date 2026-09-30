"use strict";
/**
 * @papercupai/firecrawl-bridge — managed Firecrawl access for heavy
 * research workloads: PDFs, JS-rendered pages, schema-driven extraction,
 * site mapping.
 *
 * Three functions wrapping the Firecrawl API:
 *   - scrape  → POST /v1/scrape
 *   - extract → POST /v1/extract
 *   - map     → POST /v1/map
 *
 * Requires FIRECRAWL_API_KEY (read via ctx.secret). See README for
 * pricing and self-host options.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

const DEFAULT_API_BASE = 'https://api.firecrawl.dev';
const DEFAULT_INLINE_THRESHOLD = 50_000;

async function readConfig(stateDir) {
  if (!stateDir) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_firecrawl-bridge', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getApiKey(ctx) {
  if (!ctx.secret) return null;
  try {
    return await ctx.secret('FIRECRAWL_API_KEY');
  } catch {
    return null;
  }
}

async function callFirecrawl(ctx, endpoint, payload) {
  const cfg = ctx.stateDir ? await readConfig(ctx.stateDir) : {};
  const apiBase = cfg.apiBase ?? DEFAULT_API_BASE;
  const apiKey = await getApiKey(ctx);
  if (!apiKey) {
    return {
      ok: false,
      error: 'FIRECRAWL_API_KEY not configured. Set it in the operator env or via /settings/api-keys.',
    };
  }
  const res = await fetch(`${apiBase}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: ctx.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Firecrawl API ${res.status} ${res.statusText}: ${text.slice(0, 1000)}`,
    };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

async function shapeOutput(content, ctx, tag) {
  const cfg = ctx.stateDir ? await readConfig(ctx.stateDir) : {};
  const inlineThreshold = cfg.inlineThresholdChars ?? DEFAULT_INLINE_THRESHOLD;
  if (content.length < inlineThreshold) {
    return { content: [{ type: 'text', text: content }] };
  }
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const ts = Date.now();
  const scratchDir = join(ctx.stateDir ?? ctx.projectDir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const fullPath = join(scratchDir, `firecrawl-${tag}-${sha}-${ts}.json`);
  await writeFile(fullPath, content, 'utf8');
  const summary = {
    path: fullPath,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    charCount: content.length,
    sample: content.slice(0, 500),
    note: `Output exceeded inline threshold (${inlineThreshold} chars).`,
  };
  return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
}

async function scrape(input, ctx) {
  if (!input || typeof input.url !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'scrape: input.url is required' }] };
  }
  ctx.progress(0, `firecrawl scrape ${input.url}`);
  const r = await callFirecrawl(ctx, '/v1/scrape', {
    url: input.url,
    formats: input.formats ?? ['markdown'],
    onlyMainContent: input.onlyMainContent !== false,
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  const data = (r.data && r.data.data) ?? r.data;
  return shapeOutput(JSON.stringify(data, null, 2), ctx, 'scrape');
}

async function extract(input, ctx) {
  if (!input || !Array.isArray(input.urls) || input.urls.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'extract: input.urls must be a non-empty array' }] };
  }
  if (!input.schema || typeof input.schema !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'extract: input.schema must be a JSON Schema object' }] };
  }
  ctx.progress(0, `firecrawl extract ${input.urls.length} URL(s)`);
  const r = await callFirecrawl(ctx, '/v1/extract', {
    urls: input.urls,
    schema: input.schema,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  return shapeOutput(JSON.stringify(r.data, null, 2), ctx, 'extract');
}

async function map(input, ctx) {
  if (!input || typeof input.url !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'map: input.url is required' }] };
  }
  ctx.progress(0, `firecrawl map ${input.url}`);
  const r = await callFirecrawl(ctx, '/v1/map', {
    url: input.url,
    limit: typeof input.limit === 'number' ? input.limit : 100,
  });
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: r.error }] };
  }
  ctx.progress(100, 'done');
  return shapeOutput(JSON.stringify(r.data, null, 2), ctx, 'map');
}

const tools = { scrape, extract, map };

const plugin = {
  name: '@papercupai/firecrawl-bridge',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Managed Firecrawl access — scrape, extract, map.',
  capabilities: [
    'tools:firecrawl:scrape',
    'tools:firecrawl:extract',
    'tools:firecrawl:crawl',
    'tools:firecrawl:map',
    'http:fetch:api.firecrawl.dev',
    'secrets:read:FIRECRAWL_API_KEY',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = tools;
