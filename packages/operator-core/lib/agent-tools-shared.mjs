/**
 * Shared tool implementations for the Oracle + Delegate MCP servers.
 *
 * Both servers expose the same cross-harness read/dispatch surface
 * (listHarnesses, getHarnessStatus, listChats, dispatchToAgent). The
 * differences are bolt-ons:
 *   - Oracle adds navigate + resumeChat (UI-command channel via
 *     ORACLE_SESSION_ID).
 *   - Delegate adds listAgents + followUpInChat (no UI channel).
 *
 * This module owns the shared definitions + handlers so a fix to e.g.
 * the chat sort order lands in both servers automatically.
 */
import { operatorApiBase } from './operator-api-base.mjs';

const DEFAULT_BASE = operatorApiBase();

export function text(t) { return { content: [{ type: 'text', text: t }] }; }
export function errText(t) { return { content: [{ type: 'text', text: t }], isError: true }; }

export const SHARED_TOOLS = [
  {
    name: 'listHarnesses',
    description:
      'List harnesses (projects) on this machine: slug, path, hasState, hasSpec. Use to look up a slug ' +
      'before a tool that needs one, or to answer "what harnesses do I have".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getHarnessStatus',
    description:
      'Get a feature/status snapshot for a harness: counts by status, last 5 features, summary excerpt. ' +
      'Use to answer "where are we on X" without dispatching to an agent.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'listChats',
    description:
      'List recent chats in a harness (id, role, title, message_count, updated_at), optionally filtered by role.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        role: { type: 'string', description: 'Optional role filter (architect, orchestrator, …).' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'listAgents',
    description:
      'Enumerate role-scoped agents that have recent chat activity, optionally scoped to a single harness. ' +
      'Returns: [{slug, role, chat_count, last_active}]. Use to answer "which agents are working on X" or ' +
      'to pick the most-active matching role before dispatchToAgent.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Optional — restrict to a single harness.' } },
    },
  },
  {
    name: 'dispatchToAgent',
    description:
      'Start a new chat with a role-scoped agent in a harness, and send the first message. The harness ' +
      'spawns the role-scoped Claude on demand even if its pty is idle. Common roles: orchestrator, scoper, ' +
      'worker, validator, reviewer, documenter, architect, debugger, project_manager.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        role: { type: 'string' },
        message: { type: 'string' },
        featureId: { type: 'string', description: 'Optional feature/issue id (F-001, BRIEF-BRF-12).' },
      },
      required: ['slug', 'role', 'message'],
    },
  },
];

/**
 * Run one of the SHARED_TOOLS by name. Returns the MCP content payload
 * directly — caller dispatches based on tool name; this fn handles only
 * the four shared ones and throws for unknowns.
 */
export async function runSharedTool(name, args, { base = DEFAULT_BASE } = {}) {
  if (name === 'listHarnesses') {
    const r = await fetch(`${base}/api/harness/projects`);
    if (!r.ok) return errText(`listHarnesses failed: HTTP ${r.status}`);
    const d = await r.json();
    const summary = (d?.projects ?? []).map((p) => ({
      slug: p.slug,
      path: p.path,
      hasState: !!p.hasState,
      hasSpec: !!p.hasSpec,
    }));
    return text(JSON.stringify(summary, null, 2));
  }

  if (name === 'listAgents') {
    const slugFilter = args?.slug ? String(args.slug).trim() : null;
    const projR = await fetch(`${base}/api/harness/projects`);
    if (!projR.ok) return errText(`listAgents: projects fetch failed: HTTP ${projR.status}`);
    const projData = await projR.json();
    const slugs = (projData?.projects ?? [])
      .map((p) => p.slug)
      .filter((s) => !slugFilter || s === slugFilter);
    const out = [];
    for (const slug of slugs) {
      const cr = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`).catch(() => null);
      if (!cr || !cr.ok) continue;
      const cd = await cr.json().catch(() => null);
      const chats = Array.isArray(cd?.chats) ? cd.chats : [];
      const byRole = new Map();
      for (const c of chats) {
        const role = c.role ?? 'unknown';
        const existing = byRole.get(role) ?? { slug, role, chat_count: 0, last_active: null };
        existing.chat_count += 1;
        if (!existing.last_active || String(c.updated_at) > existing.last_active) {
          existing.last_active = c.updated_at;
        }
        byRole.set(role, existing);
      }
      out.push(...byRole.values());
    }
    out.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
    return text(JSON.stringify(out.slice(0, 40), null, 2));
  }

  if (name === 'getHarnessStatus') {
    const slug = String(args?.slug ?? '').trim();
    if (!slug) return errText('slug required');
    const [statusR, summaryR] = await Promise.all([
      fetch(`${base}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`),
      fetch(`${base}/api/harness/${encodeURIComponent(slug)}/summary`),
    ]);
    if (!statusR.ok) return errText(`status fetch failed: HTTP ${statusR.status}`);
    const status = await statusR.json();
    const summary = summaryR.ok ? await summaryR.json().catch(() => null) : null;
    const features = Array.isArray(status?.features) ? status.features : [];
    const counts = features.reduce((acc, f) => {
      const s = f?.status ?? 'unknown';
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    return text(JSON.stringify({
      slug,
      path: status?.project?.path,
      feature_counts: counts,
      feature_total: features.length,
      recent_features: features.slice(-5).map((f) => ({ id: f.id, status: f.status, title: f.title })),
      summary_excerpt: typeof summary?.summary === 'string' ? summary.summary.slice(0, 1200) : null,
    }, null, 2));
  }

  if (name === 'listChats') {
    const slug = String(args?.slug ?? '').trim();
    if (!slug) return errText('slug required');
    const r = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`);
    if (!r.ok) return errText(`listChats failed: HTTP ${r.status}`);
    const d = await r.json();
    const wantRole = args?.role ? String(args.role).trim() : null;
    const chats = (Array.isArray(d?.chats) ? d.chats : [])
      .filter((c) => !wantRole || c.role === wantRole)
      .map((c) => ({
        id: c.id,
        role: c.role,
        title: c.title,
        feature_id: c.feature_id ?? null,
        message_count: Array.isArray(c.transcript) ? c.transcript.length : 0,
        updated_at: c.updated_at,
      }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 20);
    return text(JSON.stringify(chats, null, 2));
  }

  if (name === 'dispatchToAgent') {
    const slug = String(args?.slug ?? '').trim();
    const role = String(args?.role ?? '').trim();
    const message = String(args?.message ?? '').trim();
    const featureId = args?.featureId ? String(args.featureId).trim() : undefined;
    if (!slug || !role || !message) return errText('slug, role, and message are required');
    const createR = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, feature_id: featureId, title: featureId ? `${role} · ${featureId}` : role }),
    });
    if (!createR.ok) {
      const t = await createR.text().catch(() => '');
      return errText(`failed to create chat: HTTP ${createR.status} ${t}`);
    }
    const chat = await createR.json();
    fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chat.id)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
    }).catch(() => {});
    return text(JSON.stringify({
      ok: true,
      slug,
      chatId: chat.id,
      role,
      title: chat.title,
      featureId: chat.feature_id ?? null,
    }, null, 2));
  }

  throw new Error(`runSharedTool: unknown tool ${name}`);
}

/**
 * Variant for callers (Oracle) that need the raw chat object so they
 * can push a UI command after dispatch. Returns {chat, payload}.
 */
export async function runDispatchToAgent(args, { base = DEFAULT_BASE } = {}) {
  const slug = String(args?.slug ?? '').trim();
  const role = String(args?.role ?? '').trim();
  const message = String(args?.message ?? '').trim();
  const featureId = args?.featureId ? String(args.featureId).trim() : undefined;
  if (!slug || !role || !message) return { error: errText('slug, role, and message are required') };
  const createR = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, feature_id: featureId, title: featureId ? `${role} · ${featureId}` : role }),
  });
  if (!createR.ok) {
    const t = await createR.text().catch(() => '');
    return { error: errText(`failed to create chat: HTTP ${createR.status} ${t}`) };
  }
  const chat = await createR.json();
  fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chat.id)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message }),
  }).catch(() => {});
  return { chat, slug, role, featureId };
}
