"use strict";
/**
 * @papercupai/code2prompt — diff-aware reviewer prompts.
 *
 * Two functions (`diff` and `pack`) wrap the code2prompt Rust CLI.
 * Both projected onto HTTP + MCP transports. `diff` is the headline
 * tool for the reviewer role; `pack` is the non-diff variant.
 *
 * Requires `code2prompt` binary on PATH. Install:
 *   cargo install code2prompt
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

const DEFAULT_INLINE_THRESHOLD = 50_000;
const DEFAULT_BINARY = 'code2prompt';
const DEFAULT_BASE = 'main';

const TEMPLATE_HEADERS = {
  'code-review': '# Code Review\n\nReview the following diff for correctness, clarity, and maintainability. Flag bugs, security issues, performance regressions, and style issues. Cite file:line references.\n\n',
  'security-audit': '# Security Audit\n\nAudit the following code for security vulnerabilities. Focus on: input validation, authentication/authorization, secrets handling, injection risks, and unsafe deserialization.\n\n',
  'refactor-prep': '# Refactor Preparation\n\nAnalyze the following code and produce a refactor plan: identify duplication, suggest extractions, propose architectural improvements. Include impact analysis.\n\n',
};

async function readConfig(stateDir) {
  if (!stateDir) return {};
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(stateDir, 'plugins', '@papercupai_code2prompt', 'config.json');
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function templateHeader(name) {
  if (!name || name === 'none') return '';
  return TEMPLATE_HEADERS[name] ?? '';
}

async function writeIfLarge(content, ctx, format, tag) {
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
  const ext = format === 'xml' ? 'xml' : 'md';
  const scratchDir = join(ctx.stateDir ?? ctx.projectDir, 'scratch');
  await mkdir(scratchDir, { recursive: true });
  const filename = `code2prompt-${tag}-${sha}-${ts}.${ext}`;
  const fullPath = join(scratchDir, filename);
  await writeFile(fullPath, content, 'utf8');
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const summary = {
    path: fullPath,
    sizeBytes,
    charCount: content.length,
    sample: content.slice(0, 500),
    note: `Output exceeded inline threshold (${inlineThreshold} chars). Use ctx.read or fs reads to fetch the full content.`,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    outputRef: fullPath,
    outputSize: sizeBytes,
  };
}

async function spawnCode2Prompt(input, ctx, opts) {
  if (!ctx.spawn) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'code2prompt: ctx.spawn not available; capability "compute:exec:code2prompt" must be granted.' }],
    };
  }
  if (!ctx.projectDir) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'code2prompt: ctx.projectDir is unset; harness path resolution failed at the transport layer.' }],
    };
  }

  const cfg = ctx.stateDir ? await readConfig(ctx.stateDir) : {};
  const binary = cfg.binary ?? DEFAULT_BINARY;
  const format = input.format === 'xml' ? 'xml' : 'markdown';
  const ignore = input.ignore ?? [];
  const include = input.include ?? [];

  // Build code2prompt args. Project dir is positional. We pass --output -
  // to write to stdout instead of a file (the Rust CLI writes by default).
  const args = ['.', '--output', '-'];

  if (format === 'xml') args.push('--output-format', 'xml');

  if (include.length > 0) args.push('--include', include.join(','));
  if (ignore.length > 0) args.push('--exclude', ignore.join(','));

  if (opts.diffBase) {
    args.push('--git-diff-branch', opts.diffBase);
  }

  if (opts.tokens) {
    args.push('--tokens');
  }

  ctx.progress(0, `invoking ${binary}${opts.diffBase ? ` (diff vs ${opts.diffBase})` : ''}`);
  ctx.log(`code2prompt args: ${args.join(' ')}`);

  const result = await ctx.spawn(binary, args, {
    cwd: ctx.projectDir,
    timeoutMs: 50_000,
    maxBufferBytes: 32 * 1024 * 1024,
  });

  if (result.killed || result.code !== 0) {
    const stderr = result.stderr.slice(0, 4000);
    if (stderr.includes('command not found') || stderr.includes('No such file')) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `code2prompt: binary not found on PATH. Install: cargo install code2prompt`,
        }],
      };
    }
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `code2prompt: subprocess failed (code=${result.code}, killed=${result.killed}). stderr:\n${stderr}`,
      }],
    };
  }

  ctx.progress(80, `code2prompt produced ${result.stdout.length} chars`);
  const header = templateHeader(opts.template);
  const full = header + result.stdout;
  ctx.progress(100, 'done');
  return await writeIfLarge(full, ctx, format, opts.tag);
}

const diff = async (input, ctx) => {
  const cfg = ctx.stateDir ? await readConfig(ctx.stateDir) : {};
  const base = input.base ?? cfg.defaultBase ?? DEFAULT_BASE;
  return spawnCode2Prompt(input, ctx, {
    diffBase: base,
    template: input.template ?? 'code-review',
    tokens: false,
    tag: 'diff',
  });
};

const pack = async (input, ctx) => {
  return spawnCode2Prompt(input, ctx, {
    diffBase: undefined,
    template: input.template ?? 'none',
    tokens: input.tokens === true,
    tag: 'pack',
  });
};

const tools = { diff, pack };

const plugin = {
  name: '@papercupai/code2prompt',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Diff-aware reviewer prompts via the code2prompt CLI.',
  capabilities: [
    'tools:code2prompt:diff',
    'tools:code2prompt:pack',
    'compute:exec:code2prompt',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = tools;
