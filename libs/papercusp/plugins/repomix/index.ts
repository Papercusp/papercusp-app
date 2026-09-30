/**
 * @papercupai/repomix — pack a project into a single LLM-friendly document.
 *
 * Function-as-truth plugin: this file declares one function (`pack`); the
 * manifest's `tools[].expose` declaration projects it onto both transports
 * (HTTP at /api/plugins/repomix/pack, MCP as `repomix.pack`). The framework
 * wires both automatically — no per-transport code here.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import type { Plugin, ToolHandler } from '@papercusp/plugin-sdk';

interface PackInput {
  include?: string[];
  ignore?: string[];
  format?: 'xml' | 'markdown' | 'plain';
  compress?: boolean;
}

interface PackConfig {
  defaultIgnore?: string[];
  inlineThresholdChars?: number;
}

const DEFAULT_IGNORE = [
  'node_modules/**',
  'dist/**',
  '.papercusp/**',
  '.next/**',
  '*.lock',
  '*.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

const DEFAULT_INLINE_THRESHOLD = 50_000;

/**
 * Read this plugin's per-harness config. Repomix doesn't currently
 * persist a config UI; we read defaults from the harness's plugin
 * config file if present, else fall back to manifest defaults.
 */
async function readConfig(stateDir: string): Promise<PackConfig> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_repomix', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as PackConfig;
  } catch {
    return {};
  }
}

/**
 * `pack` — call repomix CLI with the per-harness project dir as cwd.
 *
 * Output policy (hybrid, per design D3):
 *   - <50k chars (configurable): return inline as text content
 *   - >=50k chars: write to <stateDir>/scratch/repomix-<sha>-<ts>.<ext>,
 *     return JSON `{ path, sizeBytes, charCount }` as text content. Agent
 *     calls `read` against the path when it needs the bytes.
 */
const pack: ToolHandler<PackInput> = async (input, ctx) => {
  if (!ctx.spawn) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'repomix.pack: ctx.spawn not available; capability "compute:exec:repomix" must be granted by the host.' }],
    };
  }
  if (!ctx.projectDir) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'repomix.pack: ctx.projectDir is unset; harness path resolution failed at the transport layer.' }],
    };
  }

  ctx.progress(0, 'starting repomix');

  const cfg = ctx.stateDir ? await readConfig(ctx.stateDir) : {};
  const inlineThreshold = cfg.inlineThresholdChars ?? DEFAULT_INLINE_THRESHOLD;
  const baseIgnore = cfg.defaultIgnore ?? DEFAULT_IGNORE;

  const format = input.format ?? 'xml';
  const ignore = [...baseIgnore, ...(input.ignore ?? [])];
  const include = input.include ?? [];

  const args: string[] = ['repomix', '--stdout', '--style', format];
  if (input.compress) args.push('--compress');
  if (include.length > 0) args.push('--include', include.join(','));
  if (ignore.length > 0) args.push('--ignore', ignore.join(','));

  ctx.progress(10, `invoking repomix (format=${format}, compress=${input.compress ?? false})`);
  ctx.log(`repomix args: ${args.join(' ')}`);

  // Use `npx` so the user doesn't need a global repomix install.
  const result = await ctx.spawn('npx', args, {
    cwd: ctx.projectDir,
    timeoutMs: 110_000, // tool's manifest timeoutSec is 120; subprocess gets 110s.
    maxBufferBytes: 64 * 1024 * 1024, // 64 MB cap on raw output
  });

  if (result.killed || result.code !== 0) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `repomix.pack: subprocess failed (code=${result.code}, killed=${result.killed}). stderr:\n${result.stderr.slice(0, 4000)}`,
      }],
    };
  }

  ctx.progress(80, `repomix produced ${result.stdout.length} chars`);

  const charCount = result.stdout.length;

  if (charCount < inlineThreshold) {
    ctx.progress(100, 'returning inline');
    return {
      content: [{ type: 'text', text: result.stdout }],
    };
  }

  // Large output: write to disk, return reference.
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(result.stdout).digest('hex').slice(0, 12);
  const ts = Date.now();
  const ext = format === 'xml' ? 'xml' : format === 'markdown' ? 'md' : 'txt';
  const scratchDir = join(ctx.stateDir ?? ctx.projectDir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const filename = `repomix-${sha}-${ts}.${ext}`;
  const fullPath = join(scratchDir, filename);
  await writeFile(fullPath, result.stdout, 'utf8');

  ctx.progress(100, `wrote ${fullPath}`);

  const sizeBytes = Buffer.byteLength(result.stdout, 'utf8');
  const summary = {
    path: fullPath,
    sizeBytes,
    charCount,
    sample: result.stdout.slice(0, 500),
    note: `Output exceeded inline threshold (${inlineThreshold} chars). Use ctx.read or fs reads to fetch the full content.`,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    outputRef: fullPath,
    outputSize: sizeBytes,
  };
};

export const tools: Record<string, ToolHandler> = {
  pack: pack as ToolHandler,
};

const plugin: Plugin = {
  name: '@papercupai/repomix',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Pack a project (or a subset of it) into a single LLM-friendly document.',
  capabilities: [
    'tools:repomix:pack',
    'compute:exec:repomix',
    'compute:exec:npx',
  ],
  tools,
};

export default plugin;
