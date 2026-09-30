/**
 * POST /workspace-hosts/:hostId/agent-credentials — store one agent credential generation.
 *
 * THE CALLER THE PRODUCER DID NOT HAVE (WI-10001686). Every consumer of agent credential material
 * was built and enforced; nothing produced it, so `claude` and `codex` could never be ready on any
 * host and initialization always died at its last step. `storeWorkspaceHostAgentCredentialMaterial`
 * closed the derive-encode-validate-store half. This route is what makes that half reachable.
 *
 * NO SECRET CROSSES THIS BOUNDARY. The body carries a SOURCE SELECTOR, never bytes: an endpoint
 * body is logged and a tool argument is persisted (`tool_invocations.args_json`), so a verb that
 * accepted a credential would durably record it. `resolveWorkspaceHostAgentCredentialSources`
 * reads the bytes inside the operator, from a closed set of sources, and hands them straight to
 * the producer. Nothing in the response echoes content — the receipt is a key, a generation, a
 * byte count and a per-slot source label, all public metadata.
 *
 * WHY THE hostId IS CHECKED AGAINST THE REF. An agent reference's first segment IS the host id
 * (`segments: ['hostId', 'agentSet']`). A request whose path and reference disagree would store
 * admissible material under a key for a DIFFERENT host — and because storage succeeds, the error
 * would only surface as that other host failing to bind, or as this one silently never finding
 * material. Both are expensive to diagnose from the far end, so they are refused here.
 *
 * DRY RUN IS NOT A COURTESY. `dryRun: true` resolves the sources, runs the encoder AND the host's
 * own admission gate, derives the key, and writes nothing. That exercises every failure this route
 * can produce except the store write itself, which is exactly what a caller wants before pointing
 * a real credential at a real host — and it is how the claude-projection notice reaches someone
 * before the credential is forwarded rather than after.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { parseWorkspaceHostCredentialReference } from '@papercusp/deployment-driver';

import { writeIntegrationCredentials } from '../../../integration-credentials';
import {
  WorkspaceHostAgentCredentialMaterialError,
  buildWorkspaceHostAgentCredentialMaterial,
  storeWorkspaceHostAgentCredentialMaterial,
  workspaceHostAgentCredentialMaterialKey,
} from '../../../workspace-host/agent-credential-material-producer';
import {
  WorkspaceHostAgentCredentialSourceError,
  resolveWorkspaceHostAgentCredentialSources,
  type WorkspaceHostAgentCredentialSourceSelector,
} from '../../../workspace-host/agent-credential-source-selector';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface WorkspaceHostAgentCredentialsRouteDependencies {
  resolveSources: typeof resolveWorkspaceHostAgentCredentialSources;
  storeMaterial: typeof storeWorkspaceHostAgentCredentialMaterial;
  buildMaterial: typeof buildWorkspaceHostAgentCredentialMaterial;
  deriveKey: typeof workspaceHostAgentCredentialMaterialKey;
  writeKey: (name: string, value: string) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostAgentCredentialsRouteDependencies = {
  resolveSources: resolveWorkspaceHostAgentCredentialSources,
  storeMaterial: storeWorkspaceHostAgentCredentialMaterial,
  buildMaterial: buildWorkspaceHostAgentCredentialMaterial,
  deriveKey: workspaceHostAgentCredentialMaterialKey,
  // `writeIntegrationCredentials` takes a partial map; the producer's writer seam is (name, value).
  writeKey: async (name, value) => {
    await writeIntegrationCredentials({ [name]: value });
  },
};

export function createWorkspaceHostAgentCredentialsRoute(
  dependencies: WorkspaceHostAgentCredentialsRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/agent-credentials',
    auth: 'loopback',
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!SAFE_ID.test(hostId)) {
        return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
      }

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await req.json();
        if (!isRecord(parsed)) throw new Error('body must be a JSON object');
        body = parsed;
      } catch (error) {
        return Response.json(
          { ok: false, error: `invalid JSON body: ${error instanceof Error ? error.message : 'unknown'}` },
          { status: 400 },
        );
      }

      const credentialRef = typeof body.credentialRef === 'string' ? body.credentialRef.trim() : '';
      if (credentialRef.length === 0) {
        return Response.json(
          { ok: false, error: "missing required string field 'credentialRef'" },
          { status: 400 },
        );
      }

      const generation = body.generation;
      if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
        return Response.json(
          { ok: false, error: "'generation' must be a positive integer" },
          { status: 400 },
        );
      }

      if (!isRecord(body.sources)) {
        return Response.json(
          {
            ok: false,
            error:
              "missing required object field 'sources' — one source per agent slot " +
              '(claude, codex, omp). A source names a KIND, never bytes and never a path: ' +
              "{ kind: 'operator-home-file' } | { kind: 'integration-key', name } | { kind: 'absent' }.",
          },
          { status: 400 },
        );
      }

      // Parse the reference for the AGENT channel specifically: a cloud or git reference passed
      // here would otherwise be keyed into the agent namespace and never read by anything.
      let refHostId: string;
      try {
        const parsedRef = parseWorkspaceHostCredentialReference(credentialRef, 'agent');
        refHostId = parsedRef.fields.hostId ?? '';
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: `credentialRef is not a valid agent reference: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          },
          { status: 400 },
        );
      }

      if (refHostId !== hostId) {
        return Response.json(
          {
            ok: false,
            error:
              `credentialRef names host '${refHostId}' but the request path names '${hostId}'. ` +
              'Storing under a mismatched reference would write admissible material to a key this ' +
              'host never reads, which surfaces only as a far-side bind failure.',
          },
          { status: 400 },
        );
      }

      const dryRun = body.dryRun === true;

      try {
        const sources = await dependencies.resolveSources(
          body.sources as unknown as WorkspaceHostAgentCredentialSourceSelector,
        );

        if (dryRun) {
          // Derive AND encode: the encode step is what runs the admission gate, so a dry run that
          // skipped it would report success for material the real call would refuse.
          const key = dependencies.deriveKey(credentialRef, generation);
          const material = dependencies.buildMaterial(sources.files);
          return Response.json({
            ok: true,
            dryRun: true,
            stored: false,
            key,
            generation,
            materialBytes: Buffer.byteLength(material, 'utf8'),
            resolved: sources.resolved,
            notices: sources.notices,
          });
        }

        const result = await dependencies.storeMaterial(
          { credentialRef, generation, files: sources.files },
          dependencies.writeKey,
        );

        return Response.json({
          ok: true,
          dryRun: false,
          stored: true,
          key: result.key,
          generation: result.generation,
          materialBytes: result.materialBytes,
          resolved: sources.resolved,
          notices: sources.notices,
        });
      } catch (error) {
        if (
          error instanceof WorkspaceHostAgentCredentialSourceError ||
          error instanceof WorkspaceHostAgentCredentialMaterialError
        ) {
          // Both error classes are authored to name the offending slot/field without echoing a
          // byte of what they read, which is why they can be returned to the caller verbatim.
          return Response.json(
            { ok: false, error: error.message, errorKind: error.name },
            { status: 400 },
          );
        }
        return Response.json(
          {
            ok: false,
            error: `agent credential storage failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          },
          { status: 500 },
        );
      }
    },
  });
}

export default createWorkspaceHostAgentCredentialsRoute();
