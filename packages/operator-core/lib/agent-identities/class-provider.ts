/** Resolve a portable class@major against the pot's attested exact-version choices. */
import type postgres from 'postgres';
import {
  getCapabilityClass,
  getPotCapabilityProviderBinding,
  type CapabilityClassVerb,
  type PotCapabilityProviderBindingRow,
  type ProviderExecutionContract,
} from '../capability-class-registry-store';

export type IdentityClassProviderResolution = {
  ok: true;
  requestedClassRef: string;
  classRef: string;
  verb: string;
  contract: CapabilityClassVerb & { outputSchema: Record<string, unknown> };
  provider: PotCapabilityProviderBindingRow & ProviderExecutionContract;
} | {
  ok: false;
  requestedClassRef: string;
  code: 'invalid-class-major' | 'class-unknown' | 'class-unbound' | 'provider-unavailable' |
    'operation-unavailable' | 'recipe-unavailable' | 'verb-unknown' | 'output-schema-missing';
};

/** A major request excludes prereleases. The newest stable version explicitly
 * selected by THIS pot wins (numeric semver order, not creation/text order).
 * Do not fall back to an older binding when that selected provider is retired
 * or async: the host records an omission instead of silently changing providers.
 * The returned exact contract and provider pin share one repeatable-read snapshot.
 */
export async function resolveIdentityClassProvider(
  sql: postgres.Sql,
  input: { workspaceId: string; potSlug: string; classRef: string; verb: string },
): Promise<IdentityClassProviderResolution> {
  const unavailable = (code: Extract<IdentityClassProviderResolution, { ok: false }>['code']) =>
    ({ ok: false as const, requestedClassRef: input.classRef, code });
  const parsed = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)@(0|[1-9][0-9]*)$/.exec(input.classRef);
  if (!parsed || input.classRef.length > 220) return unavailable('invalid-class-major');
  const [, classId, major] = parsed;
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const versions = await tx<{ version: string; bound: boolean }[]>`
      SELECT c.version, (p.pot_slug IS NOT NULL) AS bound
        FROM harness_shared.capability_class_registry c
        LEFT JOIN harness_shared.pot_capability_class_bindings p
          ON p.workspace_id = c.workspace_id AND p.class_id = c.id
         AND p.class_version = c.version AND p.pot_slug = ${input.potSlug}
       WHERE c.workspace_id = ${input.workspaceId} AND c.id = ${classId!}
         AND c.status = 'active' AND c.version LIKE ${major + '.%'}
         AND c.version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
       ORDER BY (p.pot_slug IS NOT NULL) DESC,
                split_part(c.version, '.', 2)::numeric DESC,
                split_part(c.version, '.', 3)::numeric DESC
       LIMIT 1`;
    const selected = versions[0];
    if (!selected) return unavailable('class-unknown');
    if (!selected.bound) return unavailable('class-unbound');
    const capabilityClass = await getCapabilityClass(tx, input.workspaceId, classId!, selected.version);
    if (!capabilityClass) return unavailable('class-unknown');
    const provider = await getPotCapabilityProviderBinding(tx, {
      workspaceId: input.workspaceId, potSlug: input.potSlug, classId: classId!,
      classVersion: selected.version, providerKinds: ['tool', 'recipe', 'operation'],
    });
    if (!provider) return unavailable('provider-unavailable');
    // Operation bindings never execute inline. Their producers need P-018's
    // wearer authority contract; synchronous identities read their state cells.
    if (provider.providerKind === 'operation' || provider.latencyClass !== 'sync') {
      return unavailable('operation-unavailable');
    }
    // Storage kind alone cannot masquerade as inspected recipe conformance: a
    // recipe row is admitted only with host-inspected evidence for THIS verb,
    // which recipe-provider-runtime.ts re-inspects against its pin (P-013, D-019).
    if (provider.providerKind === 'recipe' &&
        !(provider.recipeInspections && Object.hasOwn(provider.recipeInspections, input.verb))) {
      return unavailable('recipe-unavailable');
    }
    const contract = Object.hasOwn(capabilityClass.interfaceVerbs, input.verb)
      ? capabilityClass.interfaceVerbs[input.verb] : undefined;
    if (!contract) return unavailable('verb-unknown');
    if (!contract.outputSchema) return unavailable('output-schema-missing');
    return {
      ok: true, requestedClassRef: input.classRef, classRef: capabilityClass.ref,
      verb: input.verb, contract: { ...contract, outputSchema: contract.outputSchema }, provider,
    };
  });
}
