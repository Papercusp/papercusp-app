/**
 * Project-root config files editable from the harness UI:
 *
 *   GET/PUT /api/harness/:slug/mcp                       — .mcp.json
 *   GET/PUT /api/harness/:slug/claude-settings           — .claude/settings.json
 *   GET     /api/harness/:slug/claude-settings/effective — defaults ⊕ file (D-013)
 *   GET/PUT /api/harness/:slug/env                       — .env (secrets — gated by header)
 *
 * mcp.json + claude-settings.json are PG-canonical (Phase 0d) via
 * text-artifacts with a custom disk mirror at the project root. .env is
 * FS-only (never mirrored to PG) and PUT requires an explicit
 * `X-Confirm-Secrets: yes` header.
 *
 * The `/effective` view (pui-completion-and-polish-2026-06-05 D-013) renders
 * the harness's *effective* Claude Code settings — `CLAUDE_SETTINGS_DEFAULTS`
 * overlaid by whatever the file provides — so an empty/missing
 * `.claude/settings.json` shows the real default structure instead of a blank,
 * and editors (the PUI Config tab's `:set`/`:unset`) have a structure to edit.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 15).
 */
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import type { ProjectEntry } from '../../../harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const mcpPath = (p: ProjectEntry) => join(p.path, '.mcp.json');
const claudeSettingsPath = (p: ProjectEntry) => join(p.path, '.claude', 'settings.json');
const envPath = (p: ProjectEntry) => join(p.path, '.env');

/**
 * Build a GET+PUT pair for a PG-canonical (text-artifacts) JSON config
 * file with a custom disk mirror at the project root. Empty content on
 * PUT deletes the file + clears the PG row.
 */
function jsonConfigRoutes(opts: {
  routePath: string;
  artifactKey: string;
  diskPath: (p: ProjectEntry) => string;
}) {
  const get = defineTool({
    method: 'GET',
    path: opts.routePath,
    // These files can contain credentials and execution policy. Keep reads
    // on the same local-only perimeter as the corresponding writes.
    auth: 'loopback',
    async handler(req, ctx) {
      const slug = ctx.params.slug as string;
      const project = await resolvePhasedProject(slug, phaseFromReq(req));
      if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
      const { loadTextArtifact } = await import('../../../text-artifacts');
      const fromPg = await loadTextArtifact(slug, opts.artifactKey);
      return Response.json({ content: fromPg ?? safeRead(opts.diskPath(project)) ?? '' });
    },
  });
  const put = defineTool({
    method: 'PUT',
    path: opts.routePath,
    // Mutating config write → loopback per the Wave-1 rule (auth-tier
    // rollout; the generator's regex scan missed this factory's non-literal
    // path — the posture test's registry gate is what caught it).
    auth: 'loopback',
    async handler(req, ctx) {
      const slug = ctx.params.slug as string;
      const project = await resolvePhasedProject(slug, phaseFromReq(req));
      if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
      const body = await req.json().catch(() => ({} as any));
      if (typeof body.content !== 'string') {
        return Response.json({ error: 'content required' }, { status: 400 });
      }
      if (body.content.trim()) {
        try { JSON.parse(body.content); }
        catch (e: any) { return Response.json({ error: `invalid JSON: ${e.message}` }, { status: 400 }); }
      }
      const path = opts.diskPath(project);
      const { saveTextArtifact } = await import('../../../text-artifacts');
      if (!body.content.trim()) {
        try { await unlink(path); } catch {}
        await saveTextArtifact(slug, opts.artifactKey, '', { customDiskPath: path });
        return Response.json({ ok: true, deleted: true });
      }
      await saveTextArtifact(slug, opts.artifactKey, body.content, { customDiskPath: path });
      return Response.json({ ok: true });
    },
  });
  return [get, put];
}

const [getMcp, putMcp] = jsonConfigRoutes({
  routePath: '/harness/:slug/mcp',
  artifactKey: 'mcp.json',
  diskPath: mcpPath,
});

const [getClaudeSettings, putClaudeSettings] = jsonConfigRoutes({
  routePath: '/harness/:slug/claude-settings',
  artifactKey: 'claude-settings.json',
  diskPath: claudeSettingsPath,
});

/**
 * Claude Code per-project settings defaults (D-013). `.claude/settings.json`
 * in a harness checkout configures the Claude Code CLI for every agent
 * spawned there (permissions, hooks, env, model, MCP gating). Keys mirror
 * Claude Code's documented settings surface; values are Claude Code's own
 * defaults — `model: null` means "no override; the CLI resolves its default".
 * Kept deliberately curated: only keys a harness plausibly tunes.
 */
export const CLAUDE_SETTINGS_DEFAULTS: Record<string, unknown> = {
  model: null,
  permissions: {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: 'default',
  },
  env: {},
  hooks: {},
  includeCoAuthoredBy: true,
  cleanupPeriodDays: 30,
  enableAllProjectMcpServers: false,
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `overlay` onto `base`: plain objects merge per-key, everything
 * else (scalars, arrays, null) is replaced by the overlay value. Overlay keys
 * unknown to the defaults pass through untouched.
 */
export function mergeSettings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v)
      ? mergeSettings(out[k] as Record<string, unknown>, v)
      : v;
  }
  return out;
}

/**
 * Compute the effective settings view from raw file content (PG-canonical or
 * disk). Empty/missing content → pure defaults. Invalid JSON (or a non-object
 * root) → defaults plus a `parseError` the UI surfaces; the broken file
 * content still round-trips via the plain GET so the user can fix it.
 */
export function effectiveClaudeSettings(content: string | null | undefined): {
  parsed: Record<string, unknown> | null;
  parseError?: string;
  effective: Record<string, unknown>;
  fileKeys: string[];
} {
  const raw = (content ?? '').trim();
  if (!raw) return { parsed: null, effective: { ...CLAUDE_SETTINGS_DEFAULTS }, fileKeys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return {
      parsed: null,
      parseError: `invalid JSON: ${e.message}`,
      effective: { ...CLAUDE_SETTINGS_DEFAULTS },
      fileKeys: [],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      parsed: null,
      parseError: 'settings root must be a JSON object',
      effective: { ...CLAUDE_SETTINGS_DEFAULTS },
      fileKeys: [],
    };
  }
  return {
    parsed,
    effective: mergeSettings(CLAUDE_SETTINGS_DEFAULTS, parsed),
    fileKeys: Object.keys(parsed),
  };
}

const getClaudeSettingsEffective = defineTool({
  method: 'GET',
  path: '/harness/:slug/claude-settings/effective',
  // Effective settings include the file's environment and permission policy.
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(slug, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const { loadTextArtifact } = await import('../../../text-artifacts');
    const fromPg = await loadTextArtifact(slug, 'claude-settings.json');
    const content = fromPg ?? safeRead(claudeSettingsPath(project)) ?? '';
    const view = effectiveClaudeSettings(content);
    return Response.json({
      ok: true,
      content,
      defaults: CLAUDE_SETTINGS_DEFAULTS,
      effective: view.effective,
      fileKeys: view.fileKeys,
      ...(view.parseError ? { parseError: view.parseError } : {}),
    });
  },
});

const getEnv = defineTool({
  method: 'GET',
  path: '/harness/:slug/env',
  // `.env` is secret-bearing and must never be a network-readable surface.
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    return Response.json({ content: safeRead(envPath(project)) ?? '' });
  },
});

const putEnv = defineTool({
  method: 'PUT',
  path: '/harness/:slug/env',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    // Secrets pass through the wire — require an explicit confirmation header.
    if (req.headers.get('x-confirm-secrets') !== 'yes') {
      return Response.json({ error: 'missing X-Confirm-Secrets: yes header' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'content required' }, { status: 400 });
    }
    await writeFile(envPath(project), body.content, 'utf8');
    return Response.json({ ok: true });
  },
});

export default [getMcp, putMcp, getClaudeSettings, putClaudeSettings, getClaudeSettingsEffective, getEnv, putEnv];
