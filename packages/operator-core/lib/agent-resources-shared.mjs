/**
 * Shared resource implementations for the Oracle + Delegate MCP servers.
 *
 * Symmetric to agent-tools-shared.mjs. Exposes browsable URIs that
 * mirror what the existing tools fetch — agents that prefer a
 * resources/list discovery model can read the same data without
 * tools/call invocations.
 *
 * URIs:
 *   - papercusp://workspace/harnesses             (concrete)
 *   - papercusp://harness/{slug}/status           (templated)
 *   - papercusp://harness/{slug}/chats            (templated)
 *   - papercusp://workspace/agents                (concrete)
 */
import { operatorApiBase } from './operator-api-base.mjs';

const DEFAULT_BASE = operatorApiBase();

const JSON_MIME = 'application/json';

function jsonResource(uri, payload) {
  return { uri, mimeType: JSON_MIME, text: JSON.stringify(payload, null, 2) };
}

function jsonError(uri, message) {
  return jsonResource(uri, { error: message });
}

/** Concrete resources visible without expansion. */
export const STATIC_RESOURCES = [
  {
    uri: 'papercusp://workspace/harnesses',
    name: 'workspace/harnesses',
    mimeType: JSON_MIME,
    description: 'Harnesses (projects) on this machine: slug, path, hasState, hasSpec.',
  },
  {
    uri: 'papercusp://workspace/agents',
    name: 'workspace/agents',
    mimeType: JSON_MIME,
    description:
      'Active role-scoped agents in the workspace: [{slug, role, chat_count, last_active}].',
  },
];

/** Templates expanded by listing harnesses. */
export const TEMPLATED_RESOURCES = [
  {
    template: 'papercusp://harness/{slug}/status',
    name: (slug) => `harness/${slug}/status`,
    mimeType: JSON_MIME,
    description: (slug) =>
      `Feature/status snapshot for harness "${slug}": counts, recent features, summary excerpt.`,
  },
  {
    template: 'papercusp://harness/{slug}/chats',
    name: (slug) => `harness/${slug}/chats`,
    mimeType: JSON_MIME,
    description: (slug) =>
      `Recent agent chats for harness "${slug}": id, role, title, message_count, updated_at.`,
  },
];

/** Compile a `{var}` template into a regex with named groups. */
function matcherFor(template) {
  const escaped = template.replace(/[.+*?^$()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^' + escaped.replace(/\\\{([a-zA-Z_][a-zA-Z0-9_]*)\\\}/g, '(?<$1>[^/]+)') + '$',
  );
}

/**
 * Enumerate all concrete URIs visible to a resources/list call.
 * Templated entries expand by listing harnesses; one URI per harness.
 */
export async function listSharedResources({ base = DEFAULT_BASE } = {}) {
  const out = STATIC_RESOURCES.map((r) => ({ ...r }));
  try {
    const r = await fetch(`${base}/api/harness/projects`);
    if (r.ok) {
      const d = await r.json();
      const slugs = (d?.projects ?? []).map((p) => p.slug);
      for (const tmpl of TEMPLATED_RESOURCES) {
        for (const slug of slugs) {
          out.push({
            uri: tmpl.template.replace('{slug}', slug),
            name: tmpl.name(slug),
            mimeType: tmpl.mimeType,
            description: tmpl.description(slug),
          });
        }
      }
    }
  } catch {
    // Templated entries omitted silently if the operator is unreachable.
    // The static resources are still returned so the agent sees something.
  }
  return out;
}

/**
 * Read one resource by URI. Returns an MCP `resources/read` payload
 * shape: `{ contents: [{ uri, mimeType, text }] }`.
 */
export async function runSharedResource(uri, { base = DEFAULT_BASE } = {}) {
  // Static: workspace/harnesses
  if (uri === 'papercusp://workspace/harnesses') {
    const r = await fetch(`${base}/api/harness/projects`);
    if (!r.ok) return jsonError(uri, `projects fetch failed: HTTP ${r.status}`);
    const d = await r.json();
    return jsonResource(uri, {
      harnesses: (d?.projects ?? []).map((p) => ({
        slug: p.slug,
        path: p.path,
        hasState: !!p.hasState,
        hasSpec: !!p.hasSpec,
      })),
    });
  }

  // Static: workspace/agents
  if (uri === 'papercusp://workspace/agents') {
    const projR = await fetch(`${base}/api/harness/projects`);
    if (!projR.ok) return jsonError(uri, `projects fetch failed: HTTP ${projR.status}`);
    const projData = await projR.json();
    const out = [];
    for (const p of projData?.projects ?? []) {
      const cr = await fetch(
        `${base}/api/harness/${encodeURIComponent(p.slug)}/agent-chats`,
      ).catch(() => null);
      if (!cr || !cr.ok) continue;
      const cd = await cr.json().catch(() => null);
      const chats = Array.isArray(cd?.chats) ? cd.chats : [];
      const byRole = new Map();
      for (const c of chats) {
        const role = c.role ?? 'unknown';
        const e = byRole.get(role) ?? {
          slug: p.slug,
          role,
          chat_count: 0,
          last_active: null,
        };
        e.chat_count += 1;
        if (!e.last_active || String(c.updated_at) > e.last_active) {
          e.last_active = c.updated_at;
        }
        byRole.set(role, e);
      }
      out.push(...byRole.values());
    }
    out.sort((a, b) =>
      String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')),
    );
    return jsonResource(uri, { agents: out.slice(0, 80) });
  }

  // Templated: harness/{slug}/status
  {
    const m = matcherFor('papercusp://harness/{slug}/status').exec(uri);
    if (m?.groups?.slug) {
      const slug = m.groups.slug;
      const [statusR, summaryR] = await Promise.all([
        fetch(`${base}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`),
        fetch(`${base}/api/harness/${encodeURIComponent(slug)}/summary`),
      ]);
      if (!statusR.ok) return jsonError(uri, `status fetch failed: HTTP ${statusR.status}`);
      const status = await statusR.json();
      const summary = summaryR.ok ? await summaryR.json().catch(() => null) : null;
      const features = Array.isArray(status?.features) ? status.features : [];
      const counts = features.reduce((acc, f) => {
        const s = f?.status ?? 'unknown';
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      return jsonResource(uri, {
        slug,
        path: status?.project?.path,
        feature_counts: counts,
        feature_total: features.length,
        recent_features: features
          .slice(-5)
          .map((f) => ({ id: f.id, status: f.status, title: f.title })),
        summary_excerpt:
          typeof summary?.summary === 'string' ? summary.summary.slice(0, 1200) : null,
      });
    }
  }

  // Templated: harness/{slug}/chats
  {
    const m = matcherFor('papercusp://harness/{slug}/chats').exec(uri);
    if (m?.groups?.slug) {
      const slug = m.groups.slug;
      const r = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`);
      if (!r.ok) return jsonError(uri, `chats fetch failed: HTTP ${r.status}`);
      const d = await r.json();
      const chats = (Array.isArray(d?.chats) ? d.chats : [])
        .map((c) => ({
          id: c.id,
          role: c.role,
          title: c.title,
          feature_id: c.feature_id ?? null,
          message_count: Array.isArray(c.transcript) ? c.transcript.length : 0,
          updated_at: c.updated_at,
        }))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return jsonResource(uri, { slug, chats });
    }
  }

  return jsonError(uri, `unknown resource URI: ${uri}`);
}
