/**
 * Prompt Studio routes — edit the `renderSuPlaybook` SOURCES with a live preview
 * of the assembled per-client psu prompt
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-011).
 *
 *   GET  /api/prompt-studio/sources                 → the editable source list + the resolved dir
 *   GET  /api/prompt-studio/source?id=<id>          → one source's current content
 *   PUT  /api/prompt-studio/source { id, content }  → overwrite one source (WHITELISTED ids only)
 *   GET  /api/prompt-studio/preview?agent=&profile= → renderSuPlaybook(...) assembled text
 *
 * What it edits (the SOURCES, never the generated `~/.papercusp/*-collaborator*.md`,
 * which regenerate): the base playbooks `papercusp-su-{engineer,power}.tools.md`, the
 * per-client tooling overlays `papercusp-su.{omp,claude,codex}.md`, and the P-001
 * project-guide source (the repo `CLAUDE.md`). Preview composes them exactly as a psu
 * launch does (`renderSuPlaybook` → spliceToolingOverlay + the generated sections + the
 * project-guide splice), so an editor sees the real assembled prompt before saving.
 *
 * SECURITY — two boundaries: (1) the id→filename WHITELIST prevents path traversal (no
 * user-controlled path segments); (2) AUTHORIZATION is the declared `auth: 'loopback'`
 * tier on EVERY route (auth-tier Wave 1) — these routes read/rewrite the SOURCES of every
 * agent's system prompt, so they are loopback-only, enforced at the dispatch chokepoint
 * (route-stack authStep), exactly like the sibling /adv + /harness mutate routes. The
 * whitelist alone is NOT the authz boundary — do not drop the tier. Writes land in the
 * operator app root's `prompts/` dir — on
 * a STAGING-tree host that means git-sync → green-checkpoint → deploy carries them (the
 * P-011 gate: edits ride the staging→deploy pipeline; the live :3070 render reads the
 * released copy). Editing from the release checkout would be clobbered on the next deploy
 * — by design, prompt-source edits are a staging-tree action.
 */
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { renderSuPlaybook } from '../../desktop-install/papercusp-files';
import { defineTool } from '@papercusp/agent-mcp';
import { gateApiRoute } from '../../require-flag';
import { FLAGS } from '@papercusp/flags';

/** Whitelisted editable sources that live in the operator `prompts/` dir. */
const PROMPT_SOURCES: Record<string, { file: string; label: string; kind: 'playbook' | 'overlay' }> = {
  'engineer-playbook': { file: 'papercusp-su-engineer.tools.md', label: 'Engineer playbook (base)', kind: 'playbook' },
  'power-playbook': { file: 'papercusp-su-power.tools.md', label: 'Power playbook (base)', kind: 'playbook' },
  'overlay-omp': { file: 'papercusp-su.omp.md', label: 'OMP tooling overlay', kind: 'overlay' },
  'overlay-claude': { file: 'papercusp-su.claude.md', label: 'Claude tooling overlay', kind: 'overlay' },
  'overlay-codex': { file: 'papercusp-su.codex.md', label: 'Codex tooling overlay', kind: 'overlay' },
};
/** The project-guide source (P-001) is the repo `CLAUDE.md` at the repo root, not the prompts dir. */
const PROJECT_GUIDE_ID = 'project-guide';

/** Resolve the operator `prompts/` dir (where the base playbooks live). Mirrors
 *  `playbookCandidates`' sidecar fallbacks (cwd-rooted), so it resolves whether the host
 *  runs from the repo root or `apps/operator`. null when not found. */
function resolvePromptsDir(): string | null {
  const cwd = process.cwd();
  for (const c of [join(cwd, 'apps', 'operator', 'prompts'), join(cwd, 'prompts')]) {
    if (existsSync(join(c, 'papercusp-su-engineer.tools.md'))) return c;
  }
  return null;
}

/** The repo `CLAUDE.md` (project guide) — three up from the prompts dir
 *  (`<repo>/apps/operator/prompts` → `<repo>`). */
function projectGuidePath(promptsDir: string): string {
  return join(resolve(promptsDir, '..', '..', '..'), 'CLAUDE.md');
}

/** Resolve a whitelisted source id → absolute path (+ label/kind), or null for an
 *  unknown id. The ONLY way an id maps to a path — no traversal. */
function resolveSourcePath(
  id: string,
  promptsDir: string,
): { path: string; label: string; kind: string } | null {
  if (id === PROJECT_GUIDE_ID) {
    return { path: projectGuidePath(promptsDir), label: 'Project guide (repo CLAUDE.md)', kind: 'project-guide' };
  }
  const s = PROMPT_SOURCES[id];
  if (!s) return null;
  return { path: join(promptsDir, s.file), label: s.label, kind: s.kind };
}

const listSources = defineTool({
  method: 'GET',
  path: '/prompt-studio/sources',
  auth: 'loopback',
  async handler(req) {
    // Don't ship the prompt-source backend ahead of the flag (security review): the
    // whole surface is dark (404) until PROMPT_STUDIO is on. Closed-gate default.
    const off = await gateApiRoute(req, FLAGS.PROMPT_STUDIO);
    if (off) return off;
    const dir = resolvePromptsDir();
    if (!dir) return Response.json({ error: 'prompts dir not found' }, { status: 404 });
    const sources = [
      ...Object.entries(PROMPT_SOURCES).map(([id, s]) => ({ id, label: s.label, kind: s.kind })),
      { id: PROJECT_GUIDE_ID, label: 'Project guide (repo CLAUDE.md)', kind: 'project-guide' as const },
    ];
    return Response.json({ dir, sources });
  },
});

const readSource = defineTool({
  method: 'GET',
  path: '/prompt-studio/source',
  auth: 'loopback',
  async handler(req) {
    // Don't ship the prompt-source backend ahead of the flag (security review): the
    // whole surface is dark (404) until PROMPT_STUDIO is on. Closed-gate default.
    const off = await gateApiRoute(req, FLAGS.PROMPT_STUDIO);
    if (off) return off;
    const dir = resolvePromptsDir();
    if (!dir) return Response.json({ error: 'prompts dir not found' }, { status: 404 });
    const id = new URL(req.url).searchParams.get('id') ?? '';
    const src = resolveSourcePath(id, dir);
    if (!src) return Response.json({ error: 'unknown source id' }, { status: 404 });
    try {
      const content = await readFile(src.path, 'utf8');
      return Response.json({ id, label: src.label, kind: src.kind, path: src.path, content });
    } catch (e) {
      return Response.json({ error: `read failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const writeSource = defineTool({
  method: 'PUT',
  path: '/prompt-studio/source',
  auth: 'loopback',
  async handler(req) {
    // AUTHZ: rewriting prompt SOURCES = controlling every agent's system prompt.
    // auth:'public' is the codebase norm; the loopback bind + this guard are the perimeter.
    // Don't ship the prompt-source backend ahead of the flag (security review): the
    // whole surface is dark (404) until PROMPT_STUDIO is on. Closed-gate default.
    const off = await gateApiRoute(req, FLAGS.PROMPT_STUDIO);
    if (off) return off;
    const dir = resolvePromptsDir();
    if (!dir) return Response.json({ error: 'prompts dir not found' }, { status: 404 });
    const body = (await req.json()) as { id?: string; content?: string };
    const src = body.id ? resolveSourcePath(body.id, dir) : null;
    if (!src) return Response.json({ error: 'unknown source id' }, { status: 404 });
    if (typeof body.content !== 'string') {
      return Response.json({ error: 'content must be a string' }, { status: 400 });
    }
    // Size cap (security review — dangerous-sink hardening): a prompt source is a
    // few-KB markdown file; reject anything pathological before it hits writeFile.
    const MAX_BYTES = 512 * 1024; // generous — base playbooks ~50KB, the project guide ~44KB
    if (Buffer.byteLength(body.content, 'utf8') > MAX_BYTES) {
      return Response.json({ error: `content exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }
    try {
      await writeFile(src.path, body.content, 'utf8');
      // Reminder surfaced to the client: edits ride the staging→deploy pipeline (git-sync).
      return Response.json({ ok: true, id: body.id, path: src.path, note: 'saved to the staging tree; git-sync → green-checkpoint → deploy carries it to the live render' });
    } catch (e) {
      return Response.json({ error: `write failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

const previewPrompt = defineTool({
  method: 'GET',
  path: '/prompt-studio/preview',
  auth: 'loopback',
  async handler(req) {
    // Don't ship the prompt-source backend ahead of the flag (security review): the
    // whole surface is dark (404) until PROMPT_STUDIO is on. Closed-gate default.
    const off = await gateApiRoute(req, FLAGS.PROMPT_STUDIO);
    if (off) return off;
    const url = new URL(req.url);
    const agent = url.searchParams.get('agent') ?? 'claude';
    const profile = url.searchParams.get('profile') ?? 'engineer';
    try {
      const rendered = await renderSuPlaybook({ agent, profile });
      return Response.json({
        agent,
        profile,
        text: rendered.text,
        baseSource: rendered.baseSource,
        overlaySource: rendered.overlaySource,
        projectGuideSource: rendered.projectGuideSource,
        chars: rendered.text.length,
      });
    } catch (e) {
      return Response.json({ error: `preview failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

export default [listSources, readSource, writeSource, previewPrompt];

// Exported for unit tests (the whitelist is the security boundary).
export const __test = { PROMPT_SOURCES, PROJECT_GUIDE_ID, resolveSourcePath, projectGuidePath };
