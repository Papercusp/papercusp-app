/**
 * gen-openapi-spec.ts — project the live `defineTool` registry into an OpenAPI 3.1
 * document (.papercusp/openapi.json).
 *
 * docs-and-memory-as-projections-2026-06-05 P-004/D-002: the HTTP surface is
 * DERIVABLE from code, so we project a spec instead of hand-writing one. Each
 * HTTP-exposed tool becomes a path+method operation; its `inputSchema` (already
 * JSON Schema on `ProjectedTool` — OpenAPI 3.1 schemas ARE JSON Schema, so no
 * zod→OpenAPI dependency is needed) becomes the requestBody for body methods or
 * query parameters for GET/DELETE. Capability/role gates ride as x- extensions.
 *
 *   Run:  npm run gen:openapi           (write .papercusp/openapi.json)
 *         npm run gen:openapi -- --check (fail if the written artifact is stale)
 *
 * ON-DEMAND, NOT committed or CI-gated — `.papercusp/openapi.json` is GITIGNORED
 * (.gitignore:101), and --check treats a MISSING file as stale, so this can never
 * be a blocking gate: a fresh checkout has no artifact to compare against. The
 * `gen:openapi:check` npm alias was retired 2026-08-12 (WI-38239) for exactly that
 * reason — it was a guard-shaped declaration over a file that is not in the repo.
 * The check form above still works; it appends the flag to the writer alias.
 * ⚠ gen-tool-catalog.ts is NOT the same case, despite this header once claiming the
 * same stance: its artifact IS tracked, so its drift invariant is real.
 * The renderer (Scalar / starlight-openapi) is the P-005 Starlight-site decision,
 * which remains owner-gated; this generator just makes the spec a one-command
 * artifact when that lands.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@papercusp/operator-core/lib/agent-tools/index.ts';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, '.papercusp', 'openapi.json');

type Json = Record<string, unknown>;

function methodsOf(http: { methods?: readonly string[]; method?: string }): string[] {
  if (http.methods && http.methods.length > 0) return [...http.methods];
  if (http.method) return [http.method];
  return ['POST']; // the framework default
}

/** `/harness/:slug/features/:id` → `/harness/{slug}/features/{id}` + the param names. */
function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

/** Top-level properties of an object schema → query parameter objects (GET/DELETE). */
function queryParamsFrom(schema: Json | undefined): Json[] {
  const props = (schema?.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, propSchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    ...(typeof propSchema.description === 'string'
      ? { description: propSchema.description }
      : {}),
    schema: propSchema,
  }));
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const paths: Record<string, Json> = {};
let opCount = 0;

for (const t of listAllProjectedTools()) {
  const http = t.expose?.http;
  if (!http) continue;
  const { path, params } = toOpenApiPath(http.path);
  const schema = (t.inputSchema ?? undefined) as Json | undefined;
  const mcpName = t.expose?.mcp?.name ?? null;

  for (const method of methodsOf(http)) {
    const m = method.toLowerCase();
    const operation: Json = {
      ...(mcpName ? { operationId: mcpName.replace(/[^A-Za-z0-9_.-]/g, '_') } : {}),
      summary: t.description.split('\n')[0]?.slice(0, 200) ?? '',
      tags: [mcpName ? mcpName.split(':')[0] : path.split('/')[2] ?? 'api'],
      parameters: [
        ...params.map((name) => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
        ...(!BODY_METHODS.has(method) ? queryParamsFrom(schema) : []),
      ],
      ...(BODY_METHODS.has(method) && schema
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Success' },
        '4XX': { description: 'Validation / auth / gate failure' },
      },
      ...(t.capabilities.length > 0 ? { 'x-capabilities': [...t.capabilities] } : {}),
      ...(t.agentRoles && t.agentRoles.length > 0 ? { 'x-agent-roles': [...t.agentRoles] } : {}),
      ...(t.public ? { 'x-public': true } : {}),
      ...(mcpName ? { 'x-mcp-name': mcpName } : {}),
    };
    (paths[path] ??= {})[m] = operation;
    opCount++;
  }
}

// Stable key order so the artifact diffs cleanly.
const sortedPaths: Record<string, Json> = {};
for (const k of Object.keys(paths).sort()) sortedPaths[k] = paths[k];

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Papercusp operator API',
    description:
      'GENERATED from the defineTool registry by scripts/gen-openapi-spec.ts — do not hand-edit. Every operation is a projected tool; schemas are the live zod-derived JSON Schemas. Run `npm run gen:openapi` to refresh.',
    version: '0.0.1',
  },
  servers: [{ url: 'http://127.0.0.1:3070/api' }],
  paths: sortedPaths,
};

const jsonOut = JSON.stringify(spec, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing → stale */
  }
  if (current !== jsonOut) {
    process.stderr.write('✗ .papercusp/openapi.json is stale. Run: npm run gen:openapi\n');
    process.exit(1);
  }
  process.stdout.write(`✓ .papercusp/openapi.json is up to date (${opCount} operations)\n`);
} else {
  writeFileSync(OUT, jsonOut);
  process.stdout.write(
    `✓ wrote ${opCount} operations across ${Object.keys(sortedPaths).length} paths to .papercusp/openapi.json\n`,
  );
}
// Same keep-alive caveat as gen-tool-catalog: the registry import opens pools/timers.
process.exit(0);
