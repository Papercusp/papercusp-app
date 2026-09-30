/**
 * @papercupai/fetch-plus — clean URL→markdown via Jina AI Reader.
 *
 * Typed source. Runtime artifact lives in index.cjs (loader uses
 * createRequire); edit both in lockstep until we add a build step.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import type { Plugin, ToolHandler } from '@papercusp/plugin-sdk';

interface FetchCleanInput {
  url: string;
  format?: 'markdown' | 'text';
}

interface FetchPlusConfig {
  maxResponseChars?: number;
  userAgent?: string;
}

const DEFAULT_MAX_RESPONSE_CHARS = 200_000;
const DEFAULT_USER_AGENT = 'Papercusp/fetch-plus';
const JINA_BASE = 'https://r.jina.ai/';

async function readConfig(stateDir: string | undefined): Promise<FetchPlusConfig> {
  if (!stateDir) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_fetch-plus', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as FetchPlusConfig;
  } catch {
    return {};
  }
}

const fetchClean: ToolHandler<FetchCleanInput> = async (input, ctx) => {
  if (!input || typeof input.url !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'fetch_clean: input.url is required (string)' }],
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: `fetch_clean: invalid URL "${input.url}"` }],
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isError: true,
      content: [{ type: 'text', text: `fetch_clean: only http(s) URLs supported, got "${parsed.protocol}"` }],
    };
  }

  ctx.progress(0, `fetching ${parsed.hostname}`);

  const cfg = await readConfig(ctx.stateDir);
  const maxChars = cfg.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  const userAgent = cfg.userAgent ?? DEFAULT_USER_AGENT;
  const format = input.format === 'text' ? 'text' : 'markdown';

  const jinaUrl = `${JINA_BASE}${input.url}`;

  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: format === 'text' ? 'text/plain' : 'text/markdown',
  };
  if (format === 'text') {
    headers['x-return-format'] = 'text';
  }

  if (ctx.secret) {
    try {
      const apiKey = await ctx.secret('JINA_API_KEY');
      if (apiKey) {
        headers['authorization'] = `Bearer ${apiKey}`;
      }
    } catch { /* secret not granted */ }
  }

  ctx.progress(20, 'request sent to Jina Reader');

  let response: Response;
  try {
    response = await fetch(jinaUrl, { method: 'GET', headers, signal: ctx.signal });
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `fetch_clean: network error: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  if (!response.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `fetch_clean: Jina Reader returned ${response.status} ${response.statusText}` }],
    };
  }

  ctx.progress(60, 'reading response');

  let body = await response.text();
  ctx.progress(90, `received ${body.length} chars`);

  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }
  const note = truncated ? `\n\n[fetch-plus: truncated to ${maxChars} chars; original was longer]` : '';

  ctx.progress(100, 'done');
  return { content: [{ type: 'text', text: body + note }] };
};

export const tools: Record<string, ToolHandler> = {
  fetch_clean: fetchClean as ToolHandler,
};

const plugin: Plugin = {
  name: '@papercupai/fetch-plus',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Clean URL→markdown for agents via Jina AI Reader.',
  capabilities: [
    'tools:web:fetch_clean',
    'http:fetch:r.jina.ai',
    'secrets:read:JINA_API_KEY',
  ],
  tools,
};

export default plugin;
