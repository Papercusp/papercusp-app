/**
 * The one identity install consent (portable-identity-packages P-014, D-034).
 *
 * A Cupboard blueprint install may place content that only its own wearers see
 * without asking. Anything beyond that — a grant, a provider binding written
 * into the pot, a hook rule, an event subscription, an operation it fires,
 * plugin code, or content that lands in a workspace-visible store — needs the
 * administrator's consent to THIS artifact and THIS subject set.
 *
 * The subjects are computed here, once, from the release closure. The author
 * preview (identity-preview.ts) calls the same function, so what the preview
 * shows is what install asks (R-7 consent-preview). The consent is never read
 * from the publisher's manifest; the manifest's `permissions` are only checked
 * against this computation so a listing cannot advertise less than it carries.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResolvedAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { wornRulePins } from '../agent-identities/sync-hook-rules';
import type { CapabilityGrantResolutionVerdict } from './capability-grant-resolver';

/** Everything beyond package-private content, each list sorted and unique. */
export interface IdentityConsentSubjects {
  readonly contentOnly: boolean;
  readonly grants: readonly string[];
  /** `classRef → package@version` for each binding the install resolves in the pot. */
  readonly providerBindings: readonly string[];
  /** `class@major verb` for each context contribution that reads through the
   * pot's provider for that class, whichever provider the pot has bound. */
  readonly contextReads: readonly string[];
  readonly rules: readonly string[];
  readonly events: readonly string[];
  readonly operations: readonly string[];
  readonly pluginCode: readonly string[];
  /** Recipe and rubric packages: they land in workspace-visible stores. */
  readonly sharedContent: readonly string[];
}

export interface IdentityInstallConsentSubject {
  readonly artifactContentHash: string;
  readonly subjectsHash: string;
}

export type IdentityInstallConsent = IdentityInstallConsentSubject;

/** The tool/route shape: the consentSubject echoed back verbatim. */
export const identityInstallConsentSchema = z.object({
  artifactContentHash: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/i),
  subjectsHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

// An event package claims a workspace-wide vocabulary key at install (D-042).
const SHARED_CONTENT_KINDS = new Set(['recipe', 'rubric', 'event']);

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Every pot binding the identity will run through: the existing ones it reuses
 * and the ones install writes. Both are consent subjects. */
export function resolvedProviderBindings(
  resolution: Pick<CapabilityGrantResolutionVerdict, 'requirements' | 'selected'> | null | undefined,
): Array<{ classRef: string; providerPackage: string; providerVersion: string }> {
  if (!resolution) return [];
  return [
    ...resolution.requirements.flatMap((item) => item.binding ? [item.binding] : []),
    ...resolution.selected,
  ];
}

export function identityConsentSubjects(input: {
  readonly grants: { readonly requires?: readonly string[]; readonly optional?: readonly string[] } | undefined;
  readonly providerBindings: readonly { readonly classRef: string; readonly providerPackage: string; readonly providerVersion: string }[];
  readonly contributions: readonly { readonly inputKind?: string; readonly ref?: string; readonly verb?: string }[] | undefined;
  readonly inputs: ResolvedAgentSpecification['inputs'];
}): IdentityConsentSubjects {
  const packages = input.inputs.flatMap((entry) => entry.kind === 'package' ? [entry] : []);
  const { rules } = wornRulePins({ inputs: input.inputs });
  const subjects = {
    grants: sorted([...(input.grants?.requires ?? []), ...(input.grants?.optional ?? [])]),
    providerBindings: sorted(input.providerBindings.map((binding) =>
      `${binding.classRef} → ${binding.providerPackage}@${binding.providerVersion}`)),
    contextReads: sorted((input.contributions ?? []).flatMap((entry) =>
      entry.inputKind === 'capability-provider' && entry.ref && entry.verb ? [`${entry.ref} ${entry.verb}`] : [])),
    rules: sorted(rules.flatMap(({ rule }) => rule.delivery !== 'sync' ? []
      : [`${rule.id} (${rule.guard ? 'guard' : 'context'} at ${rule.sink})`])),
    events: sorted(rules.flatMap(({ rule }) => rule.delivery !== 'async' ? [] : [`${rule.id} on ${rule.on}`])),
    operations: sorted(rules.flatMap(({ rule }) => rule.delivery !== 'async' ? [] : [rule.fire])),
    pluginCode: sorted(packages.flatMap((entry) => entry.packageKind === 'plugin' ? [entry.ref] : [])),
    sharedContent: sorted(packages.flatMap((entry) =>
      SHARED_CONTENT_KINDS.has(entry.packageKind) ? [`${entry.packageKind}:${entry.ref}`] : [])),
  };
  return { contentOnly: Object.values(subjects).every((list) => list.length === 0), ...subjects };
}

export function identityInstallConsentSubject(
  artifactContentHash: string, subjects: IdentityConsentSubjects,
): IdentityInstallConsentSubject {
  const { contentOnly: _contentOnly, ...lists } = subjects;
  return {
    artifactContentHash: artifactContentHash.toLowerCase(),
    subjectsHash: createHash('sha256').update(canonicalJson(lists)).digest('hex'),
  };
}

/** Null when the install may proceed. */
export function identityInstallConsentRefusal(
  consent: IdentityInstallConsent | null | undefined,
  subject: IdentityInstallConsentSubject,
): { code: 'required' | 'mismatch'; detail: string } | null {
  if (!consent) {
    return { code: 'required', detail: 'this release carries grants, bindings, hooks, operations, plugin code or shared content that need administrator consent for this exact artifact' };
  }
  if (consent.artifactContentHash.toLowerCase() !== subject.artifactContentHash ||
      consent.subjectsHash.toLowerCase() !== subject.subjectsHash) {
    return { code: 'mismatch', detail: 'the consent was given for a different artifact or subject set; review the returned subjects and consent again' };
  }
  return null;
}

/**
 * The destination-independent subject lines a signed release manifest lists as
 * `permissions`. Provider bindings depend on the destination pot, so they are
 * the one subject a publisher cannot declare.
 */
export function identityPermissionLines(subjects: IdentityConsentSubjects): string[] {
  return [
    ...subjects.grants.map((value) => `grant:${value}`),
    ...subjects.contextReads.map((value) => `context:${value}`),
    ...subjects.rules.map((value) => `rule:${value}`),
    ...subjects.events.map((value) => `event:${value}`),
    ...subjects.operations.map((value) => `operation:${value}`),
    ...subjects.pluginCode.map((value) => `plugin:${value}`),
    ...subjects.sharedContent.map((value) => `shared:${value}`),
  ].sort();
}
