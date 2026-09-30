/**
 * One-off audit helper — assemble the OpenAPI document exactly as the
 * GET /api/openapi.json route does, and write it to disk for linting.
 * Not committed; mirrors routes/openapi-json.ts.
 */
import { writeFileSync } from 'node:fs';
import { assembleOpenApiDocument, listAllProjectedTools } from '@papercusp/agent-mcp';
import { allRouteFragments } from '@papercusp/operator-core/lib/endpoint-route/openapi.ts';
import '@papercusp/operator-core/lib/agent-tools/index.ts';

const doc = assembleOpenApiDocument(listAllProjectedTools(), {
  title: 'Papercusp API',
  description: 'Audit regeneration of the full Papercusp API surface.',
  extraFragments: allRouteFragments(),
});
writeFileSync('/tmp/openapi-audit.json', JSON.stringify(doc, null, 2));
const paths = Object.keys((doc as { paths?: Record<string, unknown> }).paths ?? {});
console.log(`assembled OK — ${paths.length} paths, openapi ${(doc as { openapi?: string }).openapi}`);
