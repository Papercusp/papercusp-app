"use strict";
/**
 * @papercupai/repomix — runtime artifact, hand-written CommonJS.
 * Mirrors index.ts. Edit both in lockstep until we add a build step.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

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

async function readConfig(stateDir) {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_repomix', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function pack(input, ctx) {
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

  const args = ['repomix', '--stdout', '--style', format];
  if (input.compress) args.push('--compress');
  if (include.length > 0) args.push('--include', include.join(','));
  if (ignore.length > 0) args.push('--ignore', ignore.join(','));

  ctx.progress(10, `invoking repomix (format=${format}, compress=${input.compress ?? false})`);
  ctx.log(`repomix args: ${args.join(' ')}`);

  const result = await ctx.spawn('npx', args, {
    cwd: ctx.projectDir,
    timeoutMs: 110_000,
    maxBufferBytes: 64 * 1024 * 1024,
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
}

const tools = { pack };

const plugin = {
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

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = tools;
// touch Sun May 10 05:55:43 AM EDT 2026
