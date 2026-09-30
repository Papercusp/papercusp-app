/**
 * The interactive su's COMPOSED SOURCE — `identities-v1-2026-08-30` P-003 switching
 * the render that P-002 classified (rulings D-007 as amended, D-009, D-018 §4).
 *
 * `blueprints/base/prompts/su.md` is one file in which kernel, identity and instance
 * text interleave; P-002 tiled it (`SU_TILES`) and derived one verbatim document per
 * part. This module builds the SU_DEFAULT_STACK from those tiles and renders it with
 * the seal (`composeStack`): client seam → domain (papercusp-engineer) → [fleet
 * posture, when bound] → practices (su-collaborator stance, su.practice) → instance
 * → the precedence statement → kernel (agent-base-preamble.md, then su.md's kernel
 * tiles). The output is the SOURCE `renderSuPlaybook` splices its generated sections
 * into: every `<!-- PAPERCUSP-SU:… -->` seam survives in its tile (the client seam
 * renders AS the `client` layer, so step 1 still splices the per-client overlay
 * there; AUTO-MODE / RESULT-DOOR / COORD-LEGEND / WIRE-SCHEMAS sit inside kernel
 * tiles and render under the seal).
 *
 * D-018 §4 DEDUPE. The preamble is the kernel's base text on EVERY tier; a kernel tile
 * that duplicates one of its sections carries `dedupeWithPreamble` naming the heading,
 * and this composer keeps the text ONCE — in the preamble — by DROPPING the tile. The
 * drop is guarded: a tile whose named heading is NOT actually in the preamble is KEPT
 * (and reported in `keptDedupeTiles`), so an edit to the preamble can never silently
 * lose kernel text.
 *
 * LOSSLESS by construction otherwise: every tile of su.md that is not a dropped
 * dedupe tile renders exactly once — `su-stack.test.ts` proves it over the real tree.
 *
 * P-021 — MODES AS FACETS. The ACTIVE registry modes bind one mode-axis identity per axis
 * (`mode-identities.ts`: `su.mode-auto` on `autonomy`, `su.mode-ideate` on `ideation`,
 * `su.mode-drain` on `objective`, `su.mode-audit` on `audit`), rendered in the `modes`
 * layer ONLY while the mode is on — `suSessionBinding({ modes })` at launch, the ⟦stack⟧
 * channel mid-session. Their documents are authored (no su.md tiles) and resolve through
 * the chain only. Mode STATE, the implication table and AUTHORITY stay kernel (D-008).
 *
 * P-020 — IDENTITY DOCUMENTS RESOLVE THROUGH THE PROMPT CHAIN. The four identity-homed
 * part documents (papercusp-engineer's domain leaf, su-collaborator's stance, and the
 * two fleet postures `su.fleet-member` / `su.fleet-leader`) are read from
 * `blueprints/<identity>/prompts/…` under `identityRoots` (most specific tier first,
 * built-in harness last — the walk `resolveReplacementSystemPromptStack` does for the
 * domain overlay), NOT re-concatenated from su.md's tiles; the tiles are the DERIVATION
 * those files are regenerated from (`gen:su-decomposition`) and stay byte-equal by test,
 * which is what keeps the render above lossless. So an installed override of an identity
 * wins over the built-in copy, and a bound identity installed in no tier refuses the
 * render instead of rendering stale text. Kernel, practice and instance still render
 * from their tiles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessPath, harnessRoot } from '@papercusp/harness/paths';
import { composeStack, type ComposeStackOptions, type ComposedStack, type StackDocument } from './render-stack.js';
import {
  applyStackMutation,
  attachLayer,
  normalizeStackBinding,
  type AppliedStackMutation,
  type ApplyStackMutationInput,
  type BoundLayer,
  type StackBinding,
  type StackMutationOp,
} from './stack-mutation.js';
import type { SlotId } from './slots.js';
import {
  AUDIENCE_IDENTITY_DOCUMENTS,
  suModeDocument,
  suModeLayers,
  type ModeCatalogSnapshot,
} from './mode-identities.js';
import {
  SU_PART_DOCUMENTS,
  SU_PREAMBLE_REL,
  locateSuTiles,
  readSuSource,
  suPartDocumentHome,
  tilesOfDocument,
  type FleetPostureRole,
  type LocatedSuTile,
  type SuPartDocument,
  type SuTile,
} from './su-decomposition.js';

export interface SuStackComposeOptions extends ComposeStackOptions {
  /** The harness install dir (default: the built-in harness via `harnessPath`). */
  harnessDir?: string;
  /** su.md text override (tests); default: read from the harness. */
  suText?: string;
  /** Preamble text override (tests); default: read from the harness. */
  preambleText?: string;
  /**
   * Tile-list override (tests); default: the live `SU_TILES`. Pair it with `suText` when the
   * subject is a FROZEN su.md — a pinned fixture cannot grow a section when the live su.md
   * does, so validating a frozen subject with the live invariant reds the moment a tile is
   * added (it was, 2026-09-21: '## Owner directives — durable capture and resolution'). Scope
   * the tiles to the frozen text instead of re-pinning it. Live-su.md tiling soundness is NOT
   * weakened by this: that invariant is asserted against the real harness file by
   * `su-identities.test.ts`, which passes no override.
   */
  tiles?: readonly SuTile[];
  /**
   * Bind a fleet posture (attached at fleet:launch-on-plan / fleet:join / fleet:take-leadership);
   * default none. Sugar for `binding: suPostureBinding(posture)` — disagreeing with an
   * explicit `binding` on the `fleet-posture` slot is an error, not a silent precedence.
   */
  posture?: FleetPostureRole | null;
  /**
   * P-012: the layers bound on the LIVE session beyond the static su stack — the fleet
   * posture, mode-axis documents (P-021), further practices. Applied over
   * `SU_STATIC_LAYERS` with attach semantics, so an exclusive layer here REPLACES the
   * static one (a different `domain` document swaps the profession).
   */
  binding?: StackBinding | null;
  /**
   * Resolve a bound layer that is NOT one of su.md's part documents (a Cupboard
   * identity, a P-021 mode document). Called only for ids `suBoundLayerDocument`
   * cannot serve; returning null refuses the binding loudly.
   */
  resolveLayer?: (layer: BoundLayer, located: readonly LocatedSuTile[]) => StackDocument | null;
  /**
   * P-020: the roots an IDENTITY-HOMED part document (`blueprints/<identity>/prompts/…` —
   * the domain leaf, the stance, the two fleet postures) is resolved from, most-specific
   * FIRST — the prompt chain's tiers (a hive's local / installed blueprints, then the
   * built-in harness), the same walk `resolveReplacementSystemPromptStack` does for the
   * domain overlay. Default `[harnessDir]` (the built-in tier alone). The first root that
   * holds the document wins; a bound identity whose document exists in NO root REFUSES
   * the render rather than falling back to su.md's tiles — the tiles are the DERIVATION
   * of these files (`gen:su-decomposition`), not a second source.
   */
  identityRoots?: readonly string[];
}

export interface SuStackDocuments {
  docs: StackDocument[];
  located: LocatedSuTile[];
  /** Kernel tiles dropped because the preamble carries the section (D-018 §4). */
  droppedTiles: LocatedSuTile[];
  /** Dedupe-marked tiles KEPT because the preamble does NOT carry the named heading. */
  keptDedupeTiles: LocatedSuTile[];
  /** The effective binding the documents were built from (static layers + the runtime binding). */
  binding: StackBinding;
}

/**
 * The layers the interactive su ALWAYS carries (SU_DEFAULT_STACK's `binding: 'static'`
 * rows that are slot documents). A runtime binding is applied OVER these with attach
 * semantics. The client seam, the instance tile and the kernel are not layers of the
 * binding — the seam is a splice point, the other two are reserved layers.
 */
export const SU_STATIC_LAYERS: readonly BoundLayer[] = [
  { slot: 'domain', id: 'papercusp-engineer' },
  { slot: 'collaboration-stance', id: 'su-collaborator' },
  { slot: 'practice', id: 'su.practice' },
];

/** The fleet-posture layer for a role — what fleet:join / take-leadership attach. */
export function suPostureLayer(role: FleetPostureRole): BoundLayer {
  return { slot: 'fleet-posture', id: role === 'leader' ? 'su.fleet-leader' : 'su.fleet-member' };
}

export function suPostureBinding(role: FleetPostureRole | null | undefined): StackBinding {
  return normalizeStackBinding(role ? [suPostureLayer(role)] : []);
}

/**
 * The binding a live session's EXISTING facts imply — presence's `fleet_role` today,
 * the mode axes once P-021 supplies documents for them. This is the whole "no new
 * table" of P-012: the binding is derived, and the control anchor projects it.
 */
export function suSessionBinding(
  session: { fleetRole?: string | null; modes?: readonly string[] | null },
  modeCatalog?: ModeCatalogSnapshot,
): StackBinding {
  const layers: BoundLayer[] = [];
  const role = (session.fleetRole ?? '').trim().toLowerCase();
  if (role === 'leader' || role === 'member') layers.push(suPostureLayer(role));
  // P-021: the ACTIVE registry modes (`agent_modes`, implication closure already applied by
  // the registry write) bind one mode-axis identity per axis — `su.mode-auto` on
  // `autonomy`, … — additive ACROSS axes, exclusive WITHIN one (D-008 amendment). Modes
  // without an authored definition bind nothing; GOAL/GRADE/TEST now have axes.
  layers.push(...suModeLayers(session.modes, modeCatalog));
  return normalizeStackBinding(layers);
}

/** Static layers + the runtime binding (attach semantics — exclusive layers replace). */
export function suEffectiveBinding(runtime: StackBinding | null | undefined, posture?: FleetPostureRole | null): StackBinding {
  let binding = normalizeStackBinding([...SU_STATIC_LAYERS]);
  const runtimeLayers = runtime ? normalizeStackBinding(runtime).layers : [];
  if (posture) {
    const wanted = suPostureLayer(posture);
    const bound = runtimeLayers.find((l) => l.slot === 'fleet-posture');
    if (bound && bound.id !== wanted.id) throw new Error(`su-stack: posture "${posture}" disagrees with the binding's fleet-posture layer "${bound.id}"`);
    if (!bound) runtimeLayers.push(wanted);
  }
  for (const layer of runtimeLayers) binding = attachLayer(binding, layer).after;
  return binding;
}

export interface ComposedSuStack extends ComposedStack {
  droppedTiles: LocatedSuTile[];
  keptDedupeTiles: LocatedSuTile[];
}

/** The preamble's `# ` headings (its sections are H1). */
function preambleHeadings(preamble: string): Set<string> {
  const out = new Set<string>();
  for (const l of preamble.split('\n')) {
    const m = /^#\s+(.+?)\s*$/.exec(l);
    if (m) out.add(m[1]!);
  }
  return out;
}

function readPreamble(opts: SuStackComposeOptions): string {
  if (opts.preambleText != null) return opts.preambleText;
  const p = opts.harnessDir ? join(opts.harnessDir, SU_PREAMBLE_REL) : harnessPath(...SU_PREAMBLE_REL.split('/'));
  return readFileSync(p, 'utf8');
}

function partDoc(id: SuPartDocument['id']): SuPartDocument {
  const d = SU_PART_DOCUMENTS.find((x) => x.id === id);
  if (!d) throw new Error(`su-stack: unknown part document ${id}`);
  return d;
}

function textOf(located: readonly LocatedSuTile[], doc: SuPartDocument, drop: ReadonlySet<LocatedSuTile> = new Set()): string {
  return tilesOfDocument(located, doc)
    .filter((t) => !drop.has(t))
    .map((t) => t.text)
    .join('');
}

/**
 * The SU_DEFAULT_STACK as `StackDocument`s, derived from su.md's tiles + the
 * preamble. Order is immaterial (`composeStack` orders); ids are the part-document
 * ids so a render's `order` reads like the decomposition table.
 */
export function suStackDocuments(opts: SuStackComposeOptions = {}): SuStackDocuments {
  const suText = opts.suText ?? readSuSource(opts.harnessDir);
  const preamble = readPreamble(opts);
  const located = locateSuTiles(suText, opts.tiles);
  const headings = preambleHeadings(preamble);
  const droppedTiles: LocatedSuTile[] = [];
  const keptDedupeTiles: LocatedSuTile[] = [];
  for (const t of located) {
    if (!t.dedupeWithPreamble) continue;
    if (t.part !== 'kernel') throw new Error(`su-stack: only a kernel tile may dedupe with the preamble (${JSON.stringify(t.anchor)} is ${t.part})`);
    if (headings.has(t.dedupeWithPreamble)) droppedTiles.push(t);
    else keptDedupeTiles.push(t);
  }
  const drop = new Set(droppedTiles);

  const kernelDoc = partDoc('su.kernel');
  const docs: StackDocument[] = [
    { id: 'agent-base-preamble', layer: 'kernel', text: preamble, sourcePath: SU_PREAMBLE_REL },
    { id: kernelDoc.id, layer: 'kernel', text: textOf(located, kernelDoc, drop), sourcePath: kernelDoc.path },
  ];
  // The client seam tile renders AS the client layer — the per-client overlay is spliced there.
  const seam = located.filter((t) => t.part === 'client');
  if (seam.length) docs.push({ id: 'client-seam', layer: 'client', slot: 'client', text: seam.map((t) => t.text).join(''), sourcePath: null });
  // The slot layers: the static su layers with the runtime binding applied over them (P-012).
  const binding = suEffectiveBinding(opts.binding, opts.posture);
  const identityRoots = suIdentityRoots(opts);
  for (const layer of binding.layers) {
    // An explicitly selected identity may reuse any built-in id, including a
    // static SU part. The trusted caller has already validated its source;
    // use that exact document before the built-in prompt-chain fallback.
    const doc = opts.resolveLayer?.(layer, located) ??
      suBoundLayerDocument(located, layer, { identityRoots }) ?? null;
    if (!doc) throw new Error(`su-stack: bound layer "${layer.slot}:${layer.id}" is neither an su.md part document nor resolvable by the caller`);
    docs.push(doc);
  }
  const instance = partDoc('su.instance');
  docs.push({ id: instance.id, layer: 'instance', text: textOf(located, instance), sourcePath: instance.path });
  return { docs, located, droppedTiles, keptDedupeTiles, binding };
}

/** The identity-document roots a compose call resolves against (`identityRoots`, else the harness dir, else the built-in harness). */
export function suIdentityRoots(opts: Pick<SuStackComposeOptions, 'identityRoots' | 'harnessDir'>): string[] {
  if (opts.identityRoots && opts.identityRoots.length) return [...opts.identityRoots];
  return [opts.harnessDir ?? harnessRoot()];
}

export interface SuIdentityDocumentHit {
  /** The root the document was found under (the most specific tier that carries it). */
  root: string;
  /** Absolute path of the resolved document. */
  path: string;
  text: string;
}

/**
 * P-020: resolve an identity-homed part document THROUGH THE PROMPT CHAIN — the first
 * root (most specific first) that holds `<root>/<part.path>` wins. Null when no root
 * holds it; the caller decides whether that refuses.
 */
export function resolveSuIdentityDocument(part: Pick<SuPartDocument, 'path'>, roots: readonly string[]): SuIdentityDocumentHit | null {
  for (const root of roots) {
    const p = join(root, part.path);
    if (existsSync(p)) return { root, path: p, text: readFileSync(p, 'utf8') };
  }
  return null;
}

/**
 * The `StackDocument` for a bound layer that is one of su.md's part documents — the part
 * document whose id matches AND whose part IS the bound slot (a `su.fleet-leader` bound
 * on `practice` is refused, not rendered in the wrong place). Null for any other id.
 *
 * WHERE THE TEXT COMES FROM (P-020): an IDENTITY-homed document (the domain leaf, the
 * stance, the two fleet postures — `suPartDocumentHome === 'identity'`) is resolved
 * through the prompt chain (`resolve.identityRoots`, most specific first); the tiles of
 * su.md are its DERIVATION (byte-equal by `su-decomposition.test.ts`), not the source,
 * so a missing identity document REFUSES rather than silently rendering the tiles. A
 * base-homed document (`su.practice`) renders from its tiles. With no `resolve` given
 * (a caller that only has the located tiles) every document renders from its tiles.
 */
export function suBoundLayerDocument(
  located: readonly LocatedSuTile[],
  layer: BoundLayer,
  resolve?: { identityRoots: readonly string[] },
): StackDocument | null {
  // P-021: a MODE-AXIS or AUDIENCE identity is AUTHORED, not derived from su.md — it has
  // no tiles, so it resolves through the chain ONLY; a missing document refuses (nothing
  // to fall back to). With no `resolve` the built-in harness is the one root.
  const mode = suModeDocument(layer.id);
  const audience =
    AUDIENCE_IDENTITY_DOCUMENTS.find((document) => document.id === layer.id) ?? null;
  const authored = mode ?? audience;
  if (authored) {
    if (authored.slot !== layer.slot) return null;
    const roots = resolve?.identityRoots ?? [harnessRoot()];
    const hit = resolveSuIdentityDocument(authored, roots);
    if (!hit) {
      throw new Error(
        `su-stack: ${mode ? 'mode' : 'audience'} identity document for "${layer.slot}:${layer.id}" (${authored.path}) exists in none of the identity roots [${roots.join(', ')}] — the identity is not installed in any tier`,
      );
    }
    return {
      id: authored.id,
      layer: slotLayer(authored.slot),
      slot: authored.slot,
      text: hit.text,
      sourcePath: hit.path,
    } satisfies StackDocument;
  }
  const part = SU_PART_DOCUMENTS.find((d) => d.id === layer.id);
  if (!part || part.part !== layer.slot) return null;
  const slot: SlotId = layer.slot;
  if (resolve && suPartDocumentHome(part) === 'identity') {
    const hit = resolveSuIdentityDocument(part, resolve.identityRoots);
    if (!hit) {
      throw new Error(
        `su-stack: identity document for "${layer.slot}:${layer.id}" (${part.path}) exists in none of the identity roots [${resolve.identityRoots.join(', ')}] — the identity is not installed in any tier (regenerate the built-in copy with \`npm run gen:su-decomposition\`)`,
      );
    }
    return { id: part.id, layer: slotLayer(slot), slot, text: hit.text, sourcePath: hit.path } satisfies StackDocument;
  }
  const spec = { id: part.id, layer: slotLayer(slot), slot, text: textOf(located, part), sourcePath: part.path } satisfies StackDocument;
  return spec;
}

function slotLayer(slot: SlotId): StackDocument['layer'] {
  switch (slot) {
    case 'client':
      return 'client';
    case 'domain':
      return 'domain';
    case 'fleet-posture':
      return 'fleet-posture';
    case 'autonomy':
    case 'ideation':
    case 'objective':
    case 'grade':
    case 'test':
    case 'goal':
    case 'audit':
    case 'audience':
      return 'modes';
    case 'collaboration-stance':
    case 'practice':
      return 'practices';
  }
}

/** Compose the interactive su's source text under the seal. Throws on a block finding (D-009). */
export function composeSuStackSource(opts: SuStackComposeOptions = {}): ComposedSuStack {
  const { docs, droppedTiles, keptDedupeTiles } = suStackDocuments(opts);
  const composed = composeStack(docs, opts);
  return { ...composed, droppedTiles, keptDedupeTiles };
}

export interface SuStackMutationOptions extends Omit<SuStackComposeOptions, 'posture'> {
  /** The session's CURRENT runtime binding (not the effective one — the static layers are implied). */
  binding?: StackBinding | null;
  op: StackMutationOp;
  layer: { slot: SlotId; id?: string | null };
  /** Optional desired specification/state revision for acknowledged delivery. */
  activation?: ApplyStackMutationInput['activation'];
}

export interface ComposedSuStackMutation extends AppliedStackMutation {
  /**
   * The RUNTIME binding after the mutation — the effective binding minus the static su
   * layers — i.e. what the control anchor should now carry as `stack`.
   */
  runtimeBinding: StackBinding;
}

function isStaticSuLayer(layer: BoundLayer): boolean {
  return SU_STATIC_LAYERS.some((s) => s.slot === layer.slot && s.id === layer.id);
}

/**
 * Apply a stack mutation to the interactive su's stack: mutate the EFFECTIVE binding
 * (static layers + the runtime binding — so an exclusive attach truthfully reports
 * which document it `replaced`), compose the next full render under the seal (a BLOCK
 * refuses the whole mutation), then render the inject-now payload. A static su layer
 * cannot be DETACHED at runtime — it is `binding: 'static'` in SU_DEFAULT_STACK for
 * that reason — and the attempt is refused loudly; it CAN be replaced by an exclusive
 * attach, and detaching that replacement restores the static layer.
 */
export function composeSuStackMutation(opts: SuStackMutationOptions): ComposedSuStackMutation {
  const { op, layer, binding, ...compose } = opts;
  const effective = suEffectiveBinding(binding);
  if (op === 'detach') {
    const id = String(layer.id ?? '').trim() || null;
    const holder = effective.layers.find((l) => l.slot === layer.slot && (id == null || l.id === id));
    if (holder && isStaticSuLayer(holder)) {
      throw new Error(`su-stack: "${holder.slot}:${holder.id}" is a static layer of the su stack and cannot be detached at runtime (replace it with an exclusive attach instead)`);
    }
  }
  const applied = applyStackMutation({
    binding: effective,
    op,
    layer,
    activation: opts.activation,
    documents: (next) => suStackDocuments({ ...compose, binding: next }).docs,
    compose,
  });
  const runtimeBinding = normalizeStackBinding(applied.binding.layers.filter((l) => !isStaticSuLayer(l)));
  return { ...applied, runtimeBinding };
}
