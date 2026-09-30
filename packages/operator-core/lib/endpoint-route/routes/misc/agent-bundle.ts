/**
 * GET /api/agent-bundle — the bundle the @papercusp/omp plugin fetches
 * on connect (persona, tools.md, skills, hooks, mcp_url, workspace, user).
 *
 * Ported from app/api/agent-bundle/route.ts. `auth: 'public'` — the
 * route authenticates by its own power-user access-token check
 * (verifyAccessToken on the Authorization header), not a principal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { verifyAccessToken } from '../../../power-user-token';
import { getActivePowerUserSession } from '../../../power-user-sessions';
import { workspaceById } from '../../../workspace-registry';
import { spliceToolingOverlay } from '../../../desktop-install/splice-tooling-overlay';
import { defineTool } from '@papercusp/agent-mcp';
import { accountProviderForInteractiveBackend, backendFeatureGuard } from '../../../backend-feature-capabilities';
import { ompGatewayModelsConfig, ompProviderForAccountProvider } from '../../../inference-gateway/omp-models-config';

interface BundleFile {
  name: string;
  source: string;
}

function resolvePromptsDir(): string | null {
  const cwd = process.cwd();
  for (const c of [
    resolvePath(cwd, 'prompts'),
    resolvePath(cwd, 'apps', 'operator', 'prompts'),
    resolvePath(cwd, '..', '..', 'prompts'),
    resolvePath(cwd, '..', '..', '..', 'prompts'),
  ]) {
    if (existsSync(join(c, 'papercusp-su-engineer.tools.md'))) return c;
  }
  return null;
}

function resolveScriptsDir(): string | null {
  const cwd = process.cwd();
  for (const c of [
    resolvePath(cwd, 'scripts'),
    resolvePath(cwd, 'apps', 'operator', 'scripts'),
    resolvePath(cwd, '..', '..', 'scripts'),
    resolvePath(cwd, '..', '..', '..', 'scripts'),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function readDirFiles(dir: string | null, exts: string[]): BundleFile[] {
  if (!dir || !existsSync(dir)) return [];
  const out: BundleFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!exts.some((e) => name.endsWith(e))) continue;
    if (name.toLowerCase() === 'readme.md') continue;
    try {
      out.push({ name, source: readFileSync(join(dir, name), 'utf8') });
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

function bearerFrom(req: Request): string | null {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

async function lookupUser(
  userId: string,
): Promise<{ id: string; username: string; displayName: string }> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: string; username: string; display_name: string }>>`
      SELECT id, username, display_name FROM harness_shared.users WHERE id = ${userId} LIMIT 1
    `;
    if (rows.length > 0) {
      return { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name };
    }
  } catch {
    /* fall through */
  }
  return { id: userId, username: userId, displayName: userId };
}

export interface OmpGatewayModelsBundle {
  /** Path under the OMP agent HOME to write (`.omp/agent/models.yml`). */
  relPath: string;
  /** The models.yml bytes. */
  content: string;
  /** `papercusp-gateway/<model>` — the client sets this as the session model. */
  modelSelector: string;
}

/**
 * Resolve the per-session OMP gateway model config for the power-user connect
 * flow (omp-account-pinning-gateway-2026-06-29 P-005 / D-006/D-007). Returns the
 * models.yml the @papercusp/omp client temp-installs into ~/.omp/agent so the
 * session routes through the inference gateway pinned to a pool account.
 *
 * MATRIX-GATED: returns null while omp gateway-routing is unsupported (dormant
 * until the P-007 capability-matrix flip), and fail-soft on any error so the
 * bundle stays byte-identical to today when the gateway is off / no pool.
 */
async function resolveOmpGatewayModels(
  workspaceId: string,
  ownerId: string,
): Promise<OmpGatewayModelsBundle | null> {
  try {
    if (!backendFeatureGuard('omp', 'gateway-routing').supported) return null;
    const provider = accountProviderForInteractiveBackend('omp');
    if (!provider) return null;
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) return null;
    const { loadAccountPool } = await import('../../../deployment/account-pool-store');
    const { accountsForProvider } = await import('../../../deployment/account-pool');
    const pool = await loadAccountPool(workspaceId);
    const accounts = accountsForProvider(pool, provider);
    if (accounts.length === 0) return null;
    const { gatewayPort } = await import('../../../inference-gateway/spawn-env');
    const cfg = ompGatewayModelsConfig({
      provider: ompProviderForAccountProvider(provider),
      accountId: accounts[0].id,
      ownerId,
      port: gatewayPort(),
    });
    if (!cfg) return null;
    return { relPath: cfg.relPath, content: cfg.content, modelSelector: cfg.modelSelector };
  } catch {
    return null;
  }
}

export default defineTool({
  method: 'GET',
  path: '/agent-bundle',
  auth: 'public',
  async handler(req) {
    const claims = await verifyAccessToken(bearerFrom(req));
    if (!claims) {
      return Response.json({ error: 'invalid or expired access token' }, { status: 401 });
    }
    const session = await getActivePowerUserSession(claims.authSessionId);
    if (!session) {
      return Response.json({ error: 'session revoked or unknown' }, { status: 401 });
    }
    const promptsDir = resolvePromptsDir();
    if (!promptsDir) {
      return Response.json(
        { error: 'agent-bundle: prompts directory not found at runtime' },
        { status: 500 },
      );
    }
    // Power-user sessions are OMP, so splice the OMP client-tooling overlay
    // into the base at the CLIENT-TOOLING-OVERLAY marker (mirrors
    // render_playbook in install-standalone-mcp.sh + writeSplicedPlaybook in
    // desktop-install/papercusp-files.ts). Without this the bundle ships a
    // literal marker comment with NO task/workflow tooling section — the
    // 2026-05-30 marker-split regression, which was fixed on the
    // desktop/installer paths but not this bundle path.
    const baseToolsmd = readFileSync(join(promptsDir, 'papercusp-su-power.tools.md'), 'utf8');
    const ompOverlayPath = join(promptsDir, 'papercusp-su.omp.md');
    const ompOverlay = existsSync(ompOverlayPath)
      ? readFileSync(ompOverlayPath, 'utf8').replace(/\n+$/, '')
      : '';
    const toolsmd = spliceToolingOverlay(baseToolsmd, ompOverlay);
    const personaPath = join(promptsDir, 'papercusp-su.persona.md');
    const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '';
    const skills = readDirFiles(join(promptsDir, 'power-user-skills'), ['.md']);
    const scriptsDir = resolveScriptsDir();
    // The `hooks` field carries OMP extension modules (`pi.on(...)`
    // factories) — currently `coord-hook.ts`, the coordination
    // turn-start / session-start / tool-call extension. The
    // @papercusp/omp client must place each `hooks[].source` into the
    // session's `~/.omp/agent/extensions/` dir so OMP's extension
    // runner auto-discovers it. (OMP's legacy "hook" subsystem is
    // deprecated; the field name is kept for client compatibility.)
    const hooks = readDirFiles(
      scriptsDir ? join(scriptsDir, 'hooks', 'omp') : null,
      ['.ts', '.js', '.mjs'],
    );
    const origin = new URL(req.url).origin;
    const ws = workspaceById(claims.workspaceId);
    const user = await lookupUser(claims.userId);
    const omp_gateway_models = await resolveOmpGatewayModels(claims.workspaceId, claims.authSessionId);
    return Response.json({
      persona,
      toolsmd,
      skills,
      hooks,
      mcp_url: `${origin}/api/mcp?power_user=1&profile=power`,
      workspace: { id: claims.workspaceId, name: ws?.name ?? claims.workspaceId },
      user,
      // Per-session OMP gateway routing config (P-005 / D-006). null = no gateway
      // routing (matrix-dormant, gateway off, or no pool account).
      omp_gateway_models,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    });
  },
});
