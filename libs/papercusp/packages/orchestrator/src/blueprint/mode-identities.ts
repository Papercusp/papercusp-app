/**
 * MODES AS FACETS — the mode-axis and audience IDENTITY documents (`identities-v1-2026-08-30`
 * P-021; D-008 as amended 2026-09-03, D-022 §1/§6, D-023 §3).
 *
 * A mode is three things fused together (D-008): STATE, DEFINITION, AUTHORITY. Only the
 * DEFINITION moves here — the long-form operating clause that `operating-modes-policy.ts`
 * used to splice into EVERY su render (33,951 B, no is-this-mode-active gate). Each mode's
 * definition is now an abstract identity blueprint filling ONE EXCLUSIVE AXIS SLOT
 * (`autonomy` / `ideation` / `objective` / `audit` — additive ACROSS axes, exclusive WITHIN
 * one), rendered in the `modes` layer only while the mode is ON:
 *
 *   - at launch, `suSessionBinding({ modes })` binds one layer per active mode into the
 *     FIRST render (role-launch-spec ← bootstrap-su's `--auto` / `--mode=drain` / fleet
 *     registration);
 *   - mid-session, `mode:set` writes `agent_modes` → the control anchor's `stack` projects
 *     these layers (`stack-binding-channel.ts`) → the ⟦stack⟧ inject-now payload attaches
 *     the document on the next turn; `enabled:false` detaches and VOIDS it (P-012 / D-022).
 *
 * WHAT STAYS KERNEL and is NOT in any of these documents: the mode STATE
 * (`harness_shared.agent_modes`), implication ENFORCEMENT (`modes/store.ts` —
 * DRAIN ⇒ AUTO is applied by the registry write, using trusted build metadata;
 * an installed document cannot change those declarations), and the AUTHORITY semantics
 * (what AUTO suspends, what AUDIT permits — computed by `instruction-lint.ts` from the
 * registry, enforced at the dispatch chokepoint by `audit-mode-guard.ts`). A mode-axis
 * document supplies only the domain flavour of how the mode reads; `identity-lint.ts`
 * BLOCKS an authority-bearing field on a mode axis (`authority-on-mode-axis`) and any
 * forged control literal (`⟦stack⟧`, `⟦INSTRUCTION-PRECEDENCE⟧`, …) — the D-005 negative.
 *
 * GOAL, GRADE and TEST now have authored mode-axis documents beside the original
 * four. `cold-auto` binds the AUTO document — same axis and grant — while its
 * carry rider remains a runtime-state contract until the reader migration.
 *
 * THE SECOND AXIS (D-008 "unify"): the file-based persona modes
 * (`<role>.persona.{engineer,novice}-mode.md`, `loadRoleModePersona`) are identities on the
 * exclusive `audience` slot — `AUDIENCE_IDENTITY_DOCUMENTS` — resolved through the same
 * chain. RECORDED DEFAULT (P-021): v1 is the four files on the same mechanism.
 *
 * These documents are AUTHORED (an identity's own prompt), not derived from su.md — unlike
 * `SU_PART_DOCUMENTS` they have no tiles, so `su-stack.ts` resolves them through the chain
 * ONLY (a missing document refuses; there is nothing to fall back to).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODE_AXES, type ModeAxis, type SlotId } from './slots.js';
import { layerSourceDocument, type BlueprintLayer } from './loader.js';
import { BlueprintContributionSchema } from './schema.js';
import type { BlueprintValidation } from './validate.js';
import { stableStringify } from './merge.js';
import { BUILTIN_MODE_COMPONENTS } from './mode-catalog.generated.js';
import type { BoundLayer } from './stack-mutation.js';

/** Generated view of mode metadata authored by a validated identity component.
 * Trusted declarations feed the host's existing code-backed enforcement. */
export interface ModeCatalogEntry {
  id: string;
  policyRef: string;
  slot: ModeAxis;
  title: string;
  oneLiner: string;
  /** Optional only for older installed definitions; the build requires these. */
  implies?: readonly string[];
  requiresSubject?: boolean;
  launchable?: boolean;
  aliases?: readonly {
    id: string; title: string; oneLiner: string; definitionHeading: string;
    implies: readonly string[]; requiresSubject: boolean; launchable: boolean;
  }[];
  definition: {
    contributionId: string;
    inputKind: 'prompt-file' | 'addressed-document';
    ref: string;
    source: 'fixed' | 'provider';
    refresh: 'source-change' | 'launch' | 'turn' | 'on-demand';
    producerRef?: string;
  };
  sourceId: string;
  sourceHash: string;
  definitionHash: string;
  revision: string;
}

export interface ModeCatalogSnapshot {
  revision: string;
  entries: readonly ModeCatalogEntry[];
}

export function modeCatalogFromValidatedSources(
  sources: readonly { layers: readonly BlueprintLayer[]; validation: BlueprintValidation }[],
  options: {
    supportedPolicyRefs: Iterable<string>;
    approvedModePolicyRefs?: Iterable<string>;
    /** Installer-owned exact source hashes, obtained from moderated release
     * receipts. A publisher's own attestation cannot authorize a host policy. */
    approvedInstalledSourceHashes?: ReadonlyMap<string, string>;
    /** Trusted build-generated entries when source YAML is not shipped. Installed
     * sources still require moderation and an exact replacement of this baseline. */
    builtinEntries?: readonly ModeCatalogEntry[];
  },
): ModeCatalogSnapshot {
  const supported = new Set(options.supportedPolicyRefs);
  const approved = new Set(options.approvedModePolicyRefs ?? []);
  const byId = new Map<string, ModeCatalogEntry>();
  for (const entry of options.builtinEntries ?? []) {
    if (!supported.has(entry.policyRef)) throw new Error(`mode "${entry.id}" references unsupported host policy "${entry.policyRef}"`);
    byId.set(entry.id, entry);
  }
  for (const source of sources) {
    if (!source.validation.ok) throw new Error('mode catalog refuses an invalid blueprint source');
    for (const layer of source.layers) {
      const mode = layer.mode;
      if (!mode) continue;
      const slot = layer.slots.filter((value): value is ModeAxis => (MODE_AXES as readonly string[]).includes(value));
      if (slot.length !== 1) throw new Error(`mode "${mode.id}" must fill exactly one mode axis`);
      if (!supported.has(mode.policyRef)) throw new Error(`mode "${mode.id}" references unsupported host policy "${mode.policyRef}"`);
      if (layer.trust !== 'builtin' && !approved.has(mode.policyRef)) {
        throw new Error(`mode "${mode.id}" has no installer/admin approval for host policy "${mode.policyRef}"`);
      }
      if (layer.trust === 'installed' && options.approvedInstalledSourceHashes?.get(layer.id) !== layer.contentHash) {
        throw new Error(`installed mode "${mode.id}" needs a moderated receipt for this exact source revision`);
      }
      const prior = byId.get(mode.id);
      if (layer.trust !== 'builtin') {
        for (const field of ['implies', 'requiresSubject', 'launchable', 'aliases'] as const) {
          if (mode[field] !== undefined && (!prior || stableStringify(mode[field]) !==
              stableStringify(prior[field] ?? (field === 'implies' || field === 'aliases' ? [] : false)))) {
            throw new Error(`mode "${mode.id}" cannot change protected activation metadata "${field}"`);
          }
        }
        if (prior && prior.slot !== slot[0]) {
          throw new Error(`mode "${mode.id}" cannot change protected activation metadata "slot"`);
        }
      }
      const contributions = source.layers.flatMap((candidate) => {
        const raw = layerSourceDocument(candidate);
        return Array.isArray(raw?.contributions) ? raw.contributions.map((value) => BlueprintContributionSchema.parse(value)) : [];
      });
      const definition = contributions.find((value) => value.id === mode.definitionContributionId);
      if (!definition || definition.purpose !== 'prompt' ||
          (definition.inputKind !== 'prompt-file' && definition.inputKind !== 'addressed-document')) {
        throw new Error(`mode "${mode.id}" has no prompt contribution "${mode.definitionContributionId}"`);
      }
      const promptPath = layer.sourcePath ? join(dirname(layer.sourcePath), 'prompts', `${slot[0]}.md`) : null;
      if (promptPath && existsSync(layer.sourcePath!) && !existsSync(promptPath)) {
        throw new Error(`mode "${mode.id}" has no selected prompt file at ${promptPath}`);
      }
      const definitionHash = createHash('sha256')
        .update(promptPath && existsSync(promptPath) ? readFileSync(promptPath) : definition.ref)
        .digest('hex');
      const content = {
        id: mode.id, policyRef: mode.policyRef, slot: slot[0]!, title: mode.title,
        oneLiner: mode.oneLiner,
        implies: mode.implies ?? prior?.implies ?? [],
        requiresSubject: mode.requiresSubject ?? prior?.requiresSubject ?? false,
        launchable: mode.launchable ?? prior?.launchable ?? false,
        aliases: mode.aliases ?? prior?.aliases ?? [],
        definition: {
          contributionId: definition.id, inputKind: definition.inputKind, ref: definition.ref,
          source: definition.source, refresh: definition.refresh,
          ...(definition.producerRef ? { producerRef: definition.producerRef } : {}),
        },
        sourceId: layer.id, sourceHash: layer.contentHash, definitionHash,
      };
      const entry: ModeCatalogEntry = {
        ...content,
        revision: createHash('sha256').update(stableStringify(content)).digest('hex'),
      };
      if (prior && prior.revision === entry.revision) continue;
      if (prior && (mode.replacesRevision !== prior.revision || prior.policyRef !== mode.policyRef)) {
        throw new Error(`mode "${mode.id}" has conflicting definitions from "${prior.sourceId}" and "${layer.id}" without an exact replacement revision`);
      }
      byId.set(mode.id, entry);
    }
  }
  const entries = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const activationEntries = entries.flatMap((entry) => [entry, ...(entry.aliases ?? [])]);
  const activationById = new Map(activationEntries.map((entry) => [entry.id, entry]));
  if (activationById.size !== activationEntries.length) throw new Error('duplicate mode or carry alias id');
  for (const entry of activationEntries) {
    if (entry.launchable && entry.requiresSubject) {
      throw new Error(`mode "${entry.id}" requires a subject and cannot use the subject-less launch surface`);
    }
    const visited = new Set<string>();
    const visit = (id: string, ancestors: readonly string[]): void => {
      if (ancestors.includes(id)) throw new Error(`mode implication cycle: ${[...ancestors, id].join(' -> ')}`);
      const target = activationById.get(id);
      if (!target) throw new Error(`mode "${entry.id}" implies unknown mode "${id}"`);
      if (ancestors.length > 0 && target.requiresSubject) {
        throw new Error(`mode "${entry.id}" implies subject-requiring mode "${id}"`);
      }
      if (visited.has(id)) return;
      visited.add(id);
      for (const implied of target.implies ?? []) visit(implied, [...ancestors, id]);
    };
    visit(entry.id, []);
  }
  return { revision: createHash('sha256').update(stableStringify(entries)).digest('hex'), entries };
}

export type SuModeDocId = (typeof BUILTIN_MODE_COMPONENTS)[number]['sourceId'];

export interface SuModeDocument {
  /** The identity blueprint id (`blueprints/<id>/blueprint.yaml`). */
  id: SuModeDocId;
  /** The exclusive mode axis the identity fills — its `slots:` declaration. */
  slot: Exclude<ModeAxis, 'audience'>;
  /** The `modes/registry.ts` mode ids whose activation binds this document. */
  modes: readonly string[];
  /** Harness-relative path of the document: `blueprints/<id>/prompts/<slot>.md`. */
  path: string;
  role: string;
}

/**
 * The mode-axis identities — one per axis that has a definition today. Path is DERIVED
 * from id + slot (`prompts/<slot>.md`, the convention every non-domain identity document
 * follows), never restated.
 */
function modeDoc(id: SuModeDocId, slot: SuModeDocument['slot'], modes: readonly string[], role: string): SuModeDocument {
  return { id, slot, modes, path: `blueprints/${id}/prompts/${slot}.md`, role };
}

export const SU_MODE_DOCUMENTS: readonly SuModeDocument[] = [...BUILTIN_MODE_COMPONENTS]
  .sort((a, b) => MODE_AXES.indexOf(a.slot) - MODE_AXES.indexOf(b.slot))
  .map((entry) => modeDoc(
    entry.sourceId,
    entry.slot,
    [entry.id, ...((entry as ModeCatalogEntry).aliases ?? []).map((alias) => alias.id)],
    entry.title,
  ));

export function isSuModeDocId(x: unknown): x is SuModeDocId {
  return typeof x === 'string' && SU_MODE_DOCUMENTS.some((d) => d.id === x);
}

export function suModeDocument(id: string): SuModeDocument | null {
  return SU_MODE_DOCUMENTS.find((d) => d.id === id) ?? null;
}

/**
 * The layer a registry mode id binds — null for an unknown id or a supported mode
 * without a definition. A typo must
 * never bind a layer; the registry test is what catches it).
 */
export function suModeLayer(modeId: string, catalog?: ModeCatalogSnapshot): BoundLayer | null {
  const key = String(modeId ?? '').trim().toLowerCase();
  if (catalog) {
    const entry = catalog.entries.find((candidate) => candidate.id === (key === 'cold-auto' ? 'auto' : key));
    return entry ? { slot: entry.slot, id: entry.sourceId } : null;
  }
  const doc = SU_MODE_DOCUMENTS.find((d) => d.modes.includes(key));
  return doc ? { slot: doc.slot, id: doc.id } : null;
}

/**
 * The mode-axis layers a set of ACTIVE registry modes binds — one per axis, in
 * `MODE_AXES` order, deduped (auto + cold-auto can never both be active — same registry
 * axis — but a caller passing both still gets ONE autonomy layer). The implication
 * closure is NOT applied here: `setMode` already wrote the implied rows, so `modes`
 * as read from `agent_modes` carries `drain` AND `auto`.
 */
export function suModeLayers(modes: readonly string[] | null | undefined, catalog?: ModeCatalogSnapshot): BoundLayer[] {
  const bySlot = new Map<SlotId, BoundLayer>();
  for (const m of modes ?? []) {
    const layer = suModeLayer(m, catalog);
    if (layer && !bySlot.has(layer.slot)) bySlot.set(layer.slot, layer);
  }
  return MODE_AXES.filter((axis) => bySlot.has(axis)).map((axis) => bySlot.get(axis)!);
}

// ── the audience axis ─────────────────────────────────────────────────────────

export type AudienceRole = 'operator' | 'papercup';
export type AudienceMode = 'engineer' | 'novice';

export interface AudienceIdentityDocument {
  /** `<role>.audience-<mode>` — the identity blueprint id. */
  id: string;
  role: AudienceRole;
  mode: AudienceMode;
  slot: 'audience';
  /** Harness-relative path: `blueprints/<id>/prompts/audience.md`. */
  path: string;
}

export const AUDIENCE_ROLES: readonly AudienceRole[] = ['operator', 'papercup'];
export const AUDIENCE_MODES: readonly AudienceMode[] = ['engineer', 'novice'];

export function audienceIdentityId(role: AudienceRole, mode: AudienceMode): string {
  return `${role}.audience-${mode}`;
}

/** The four audience identities (D-008 unify; RECORDED DEFAULT v1 = four files, same mechanism). */
export const AUDIENCE_IDENTITY_DOCUMENTS: readonly AudienceIdentityDocument[] = AUDIENCE_ROLES.flatMap((role) =>
  AUDIENCE_MODES.map((mode) => {
    const id = audienceIdentityId(role, mode);
    return { id, role, mode, slot: 'audience' as const, path: `blueprints/${id}/prompts/audience.md` };
  }),
);

/** The audience identity document for a chat role + audience mode, or null for an unknown pair. */
export function audienceIdentityDocument(role: string, mode: string): AudienceIdentityDocument | null {
  return AUDIENCE_IDENTITY_DOCUMENTS.find((d) => d.role === role && d.mode === mode) ?? null;
}
