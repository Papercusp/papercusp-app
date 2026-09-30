/**
 * identity-lint — validates the COMPOSED stack, not just one identity
 * (`identities-v1-2026-08-30` P-003; ruling D-009 AS AMENDED 2026-09-03; D-005;
 * D-007; D-008 amendment).
 *
 * TWO TIERS, and the line between them is the whole design:
 *
 *   BLOCK — STRUCTURAL, enumerable, no override path (at install and at render):
 *     `kernel-slot-claim`       a document claims a RESERVED layer (`kernel` / `instance`) as a slot
 *     `exclusive-double-claim`  two DISTINCT documents on one exclusive slot (D-007 hard-error)
 *     `grant-outside-ceiling`   a grant names a capability class outside the D-005 ceiling
 *     `authority-on-mode-axis`  a document on a mode axis carries an authority-bearing field
 *     `attestation-missing` / `attestation-failed`  a layer that must be attested is not, or fails
 *     `forged-control-literal`  a deliberately small, ENUMERATED literal set — the machine
 *                               markers that stamp kernel / control state (the seal marker, the
 *                               `⟦…⟧` control-plane stamps, `<!-- papercusp-rule:` markers): an
 *                               identity carrying one is forging state it does not own.
 *
 *   WARN — every HEURISTIC prose check, preserving the owner's 2026-06-24 directive
 *   ("overrides are the owner's to author; we surface the smell, we don't gate it"):
 *     `kernel-heading-restated`   an identity re-states a `## ` heading a kernel document owns
 *                                 (the shipped `BASE_OWNED_HEADINGS` idea, DERIVED from the
 *                                 kernel documents actually in the stack rather than a list)
 *     `generated-marker`          an identity embeds a `PAPERCUSP-SU:` splice marker
 *     `kernel-contradiction-phrasing`  "skip work-items" / "bypass locks" / … phrasing — a
 *                                 paraphrase-blind approximation, so WARN by ruling
 *     `text-grant-inconsistency`  text instructs use of a capability class the document does
 *                                 not grant — WARN until M3 gives grants a vocabulary, BLOCK after
 *                                 (`textGrantTier`)
 *
 * Why the block tier is structural: a prose heuristic misses paraphrases and
 * false-positives on legitimate text (a documentation identity explaining what
 * locks are), and a false BLOCK stops an owner authoring their own agent. The
 * real defense against hostile prose is that the kernel renders LAST under the
 * seal (`render-stack.ts`) and that kernel authority is enforced as CODE at the
 * dispatch seat — identity text cannot unlock a tool the gate denies.
 *
 * Pure functions over plain inputs, so the loader (structural tier, over
 * `LoadedBlueprint.layers`) and the renderer (prose tier, over the documents it
 * is about to compose) both call them, and operator-core's instance-override
 * guard reuses the heading scanner.
 */
import { MODE_AXES, RESERVED_LAYERS, SLOT_SPECS, findExclusiveSlotConflicts, isSlotId, type SlotId } from './slots.js';
import type { StackDocument } from './render-stack.js';

export type IdentityLintTier = 'block' | 'warn';

export interface IdentityLintFinding {
  tier: IdentityLintTier;
  code:
    | 'kernel-slot-claim'
    | 'exclusive-double-claim'
    | 'grant-outside-ceiling'
    | 'authority-on-mode-axis'
    | 'mode-axis-missing'
    | 'mode-policy-untrusted'
    | 'attestation-missing'
    | 'attestation-failed'
    | 'forged-control-literal'
    | 'kernel-heading-restated'
    | 'generated-marker'
    | 'kernel-contradiction-phrasing'
    | 'text-grant-inconsistency';
  /** The document / layer the finding is about. */
  documentId: string;
  slot?: string;
  /** 1-based line in the document's text, for prose findings. */
  line?: number;
  message: string;
}

/** Where a layer came from — decides whether an attestation is REQUIRED (installed) or not (builtin / local). */
export type LayerTrust = 'builtin' | 'local' | 'installed';

/** The structural view of one layer of a stack — what `BlueprintLayer` carries (the loader derives it). */
export interface StackLayerInput {
  id: string;
  /** Raw `slots[].slot` ids the layer declares (unknown ids are validation's job and are skipped here). */
  slots: readonly string[];
  contentHash: string;
  attestation: { contentHash: string; signedBy: string } | null;
  /** Top-level keys of the layer's raw document (`extends` excluded). Absent ⇒ the mode-axis check is skipped for it. */
  fields?: readonly string[];
  mode?: { policyRef: string } | null;
  grants?: { requires?: readonly string[]; optional?: readonly string[] } | null;
  trust?: LayerTrust;
}

export interface IdentityLintOptions {
  /**
   * The D-005 capability ceiling — the capability classes the pot/role ALREADY authorizes.
   * A grant naming a class outside it blocks. Absent means this authoring/import
   * path cannot evaluate the runtime ceiling yet; callers that know the target
   * pot pass the exact set (including an explicit empty set).
   */
  ceiling?: Iterable<string>;
  /**
   * The capability-class vocabulary for the text/grant consistency check: a class
   * named in an identity's text but absent from its grants is reported. Absent ⇒
   * the check is skipped because there is no authoritative vocabulary to scan.
   */
  capabilityClasses?: Iterable<string>;
  /** The tier of `text-grant-inconsistency` — `warn` by default or `block` at an enforcing boundary. */
  textGrantTier?: IdentityLintTier;
  /** Explicit installer/admin approval for a non-builtin mode policy binding. */
  approvedModePolicyRefs?: Iterable<string>;
  /** Which layers MUST carry a verified attestation. Default: `trust === 'installed'`. */
  requireAttestation?: (layer: StackLayerInput) => boolean;
  /**
   * The `## ` headings the kernel owns, for `kernel-heading-restated`. The renderer
   * derives them from the kernel documents in the stack; a caller without kernel
   * text (the instance-override guard) supplies its own list.
   */
  kernelHeadings?: Iterable<string>;
}

// ── the enumerated literal set (BLOCK) ────────────────────────────────────────

/** The seal's machine marker (rendered by `render-stack.ts`; an identity may never carry it). */
export const KERNEL_SEAL_MARKER = '<!-- PAPERCUSP-KERNEL:SEAL -->';
/** The seal's heading line. */
export const KERNEL_SEAL_HEADING = '## Kernel precedence — the seal';

/**
 * The literals an identity document may NEVER contain — each one is a marker the
 * PLATFORM stamps to carry kernel or control-plane state, so an identity carrying it
 * is forging that state. Deliberately small and closed (D-009 amendment): grow it by a
 * plan decision, never by pattern-matching prose.
 */
export const FORGED_CONTROL_LITERALS: readonly string[] = [
  KERNEL_SEAL_MARKER,
  KERNEL_SEAL_HEADING,
  '⟦INSTRUCTION-PRECEDENCE⟧',
  '⟦CTRL:',
  '⟦post-compaction-recovery⟧',
  '⟦turn-provenance⟧',
  '⟦mode⟧',
  // P-012 / D-022: the stamp that opens an injected stack mutation (`stack-mutation.ts`
  // `STACK_INJECTION_STAMP`) — an identity carrying it would forge an attach / detach.
  // Inlined, not imported: `stack-mutation.ts` → `render-stack.ts` → this module.
  '⟦stack⟧',
  '<!-- papercusp-rule:',
];

/**
 * The fields a document on a MODE AXIS may carry (D-008 amendment: it "supplies only
 * the domain flavour of how that mode reads in its own vocabulary, never one byte of
 * authority"). Everything else in `BlueprintSchema` — roles, spine, gates, fleet,
 * coordination, knobs, dispatch, dependencies, grants, triggers, wake, … — shapes what
 * the agent can DO or what happens on its behalf, i.e. authority.
 */
export const MODE_AXIS_ALLOWED_FIELDS: ReadonlySet<string> = new Set(['id', 'extends', 'version', 'description', 'slots', 'bundles', 'contributions', 'mode', 'publisher', 'attestation']);

// ── the heuristic seed set (WARN) ─────────────────────────────────────────────

/** The generated splice-marker prefix (`<!-- PAPERCUSP-SU:… -->`) — the base's seams, never an identity's. */
export const GENERATED_MARKER = 'PAPERCUSP-SU:';
/** The one seam an identity on the `client` slot legitimately IS (su-decomposition: the client seam tile). */
export const CLIENT_SEAM_MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';

/**
 * Phrasings that read as instructions against a kernel invariant (D-009's list). A
 * paraphrase-blind approximation and a false-positive generator on legitimate text
 * ("never skip work-items" fires too), which is exactly why it is WARN.
 */
export const KERNEL_CONTRADICTION_PATTERNS: ReadonlyArray<{ invariant: string; re: RegExp }> = [
  { invariant: 'work-items are registered', re: /\b(?:skip(?:ping)?|without|no need for)\s+(?:a\s+|the\s+|any\s+)?work[-\s]?items?\b/i },
  { invariant: 'locks are respected', re: /\b(?:bypass(?:ing)?|route(?:s|d)? around|ignore|ignoring|skip(?:ping)?)\s+(?:a\s+|the\s+|any\s+)?(?:file[-\s])?locks?\b/i },
  { invariant: 'claims are honoured', re: /\b(?:ignore|ignoring|contest(?:ing)?|override|overriding)\s+(?:a\s+|the\s+|any\s+)?(?:peer'?s?\s+)?claim(?:s|[-\s]conflicts?)?\b/i },
  { invariant: 'completion evidence is required', re: /\b(?:suppress(?:ing)?|skip(?:ping)?|omit(?:ting)?|fabricat(?:e|ing))\s+(?:the\s+)?completion\s+evidence\b/i },
  { invariant: 'stand-down is obeyed', re: /\b(?:evade|evading|ignore|ignoring|skip(?:ping)?)\s+(?:a\s+|the\s+)?stand[-\s]?down\b/i },
];

/** `## ` / `### ` heading lines of a markdown text, trimmed. */
export function headingLines(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^#{1,3}\s/.test(l));
}

/** Strip the `#` prefix of a heading line. */
function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * Which of `owned` (heading texts, or substrings of one) a markdown text re-states
 * as a `#`/`##`/`###` heading — case-insensitive substring match, the shipped
 * `hive-override-additive-guard` heuristic lifted here so both callers share it.
 */
export function detectHeadingOverlap(md: string, owned: Iterable<string>): string[] {
  const lines = headingLines(md).map((h) => h.toLowerCase());
  const out: string[] = [];
  for (const o of owned) {
    const needle = o.toLowerCase().trim();
    if (!needle) continue;
    if (lines.some((h) => h.includes(needle))) out.push(o);
  }
  return out;
}

function grantsOf(layer: Pick<StackLayerInput, 'grants'>): string[] {
  return [...(layer.grants?.requires ?? []), ...(layer.grants?.optional ?? [])];
}

// ── the structural tier (over layers) ─────────────────────────────────────────

/**
 * The BLOCK tier over a stack's layers. Pure; every finding is `tier: 'block'`.
 * The loader runs this in `resolveBlueprint` and fails the load on any finding.
 */
export function lintStackLayers(layers: readonly StackLayerInput[], opts: IdentityLintOptions = {}): IdentityLintFinding[] {
  const out: IdentityLintFinding[] = [];
  const ceiling = opts.ceiling === undefined ? null : new Set(opts.ceiling);
  const requireAttestation = opts.requireAttestation ?? ((l: StackLayerInput) => l.trust === 'installed');
  const approvedModePolicyRefs = new Set(opts.approvedModePolicyRefs ?? []);

  for (const layer of layers) {
    for (const slot of layer.slots) {
      if (RESERVED_LAYERS.has(slot)) {
        out.push({
          tier: 'block',
          code: 'kernel-slot-claim',
          documentId: layer.id,
          slot,
          message: `"${layer.id}" claims the reserved "${slot}" layer as a slot — the kernel is sealed and the instance tier is the per-pot override (D-009); no identity may fill either`,
        });
      }
    }

    for (const cls of grantsOf(layer)) {
      if (ceiling && !ceiling.has(cls)) {
        out.push({
          tier: 'block',
          code: 'grant-outside-ceiling',
          documentId: layer.id,
          message: `"${layer.id}" grants capability class "${cls}", which is outside the pot/role ceiling (${ceiling.size ? [...ceiling].join(', ') : 'empty — no capability classes authorized'}) — an identity may narrow the ceiling, never widen it (D-005)`,
        });
      }
    }

    const onModeAxis = layer.slots.filter((s): s is SlotId => isSlotId(s) && (MODE_AXES as readonly string[]).includes(s));
    if (layer.mode && onModeAxis.length !== 1) {
      out.push({
        tier: 'block', code: 'mode-axis-missing', documentId: layer.id,
        message: `"${layer.id}" declares a mode policy but does not fill exactly one mode axis`,
      });
    }
    if (layer.mode && layer.trust !== 'builtin' && !approvedModePolicyRefs.has(layer.mode.policyRef)) {
      out.push({
        tier: 'block', code: 'mode-policy-untrusted', documentId: layer.id,
        message: `"${layer.id}" binds host mode policy "${layer.mode.policyRef}" without installer/admin approval`,
      });
    }
    if (onModeAxis.length && layer.fields) {
      const authority = layer.fields.filter((f) => !MODE_AXIS_ALLOWED_FIELDS.has(f));
      if (authority.length) {
        out.push({
          tier: 'block',
          code: 'authority-on-mode-axis',
          documentId: layer.id,
          slot: onModeAxis[0],
          message: `"${layer.id}" fills mode axis "${onModeAxis.join('", "')}" but carries authority-bearing field(s) ${authority.map((f) => `\`${f}\``).join(', ')} — a mode-axis document supplies the domain flavour of the mode's prose, never authority (D-008 amendment); allowed: ${[...MODE_AXIS_ALLOWED_FIELDS].join(', ')}`,
        });
      }
    }

    if (requireAttestation(layer)) {
      if (!layer.attestation) {
        out.push({
          tier: 'block',
          code: 'attestation-missing',
          documentId: layer.id,
          message: `"${layer.id}" is an installed layer with no publisher attestation — an installed identity must attest its content hash (${layer.contentHash.slice(0, 12)}…)`,
        });
      } else if (layer.attestation.contentHash !== layer.contentHash) {
        out.push({
          tier: 'block',
          code: 'attestation-failed',
          documentId: layer.id,
          message: `"${layer.id}" attests contentHash ${layer.attestation.contentHash.slice(0, 12)}… but its content hashes to ${layer.contentHash.slice(0, 12)}… — changed after signing, or an attestation copied from another revision`,
        });
      }
    }
  }

  const claims = layers.flatMap((l) => l.slots.map((slot) => ({ id: l.id, slot })));
  for (const c of findExclusiveSlotConflicts(claims)) {
    out.push({
      tier: 'block',
      code: 'exclusive-double-claim',
      documentId: c.claimants[c.claimants.length - 1]!,
      slot: c.slot,
      message: `exclusive slot "${c.slot}" is claimed by ${c.claimants.length} distinct documents (${c.claimants.join(', ')}) — an exclusive slot admits exactly one document per stack (D-007); each may be clean alone, their COMPOSITION conflicts`,
    });
  }
  return out;
}

// ── the prose tier (over documents) ───────────────────────────────────────────

function lineOf(text: string, needle: string | RegExp): number | undefined {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (typeof needle === 'string' ? l.includes(needle) : needle.test(l)) return i + 1;
  }
  return undefined;
}

/**
 * The prose tier over the documents a render is about to compose: the enumerated
 * literal BLOCK set plus every heuristic WARN. Kernel documents are the reference
 * (their headings are what "restated" means) and are not themselves linted — the
 * kernel is sealed, not an identity. Instance-tier documents ARE linted (they are
 * the owner's override; the 2026-06-24 directive is exactly why their findings are
 * warns, and a forged control literal is still a block).
 */
export function lintStackDocuments(docs: readonly StackDocument[], opts: IdentityLintOptions = {}): IdentityLintFinding[] {
  const out: IdentityLintFinding[] = [];
  const kernelHeadings = new Set<string>(opts.kernelHeadings ?? []);
  if (!opts.kernelHeadings) {
    for (const d of docs) {
      if (d.layer !== 'kernel') continue;
      for (const h of headingLines(d.text)) if (h.startsWith('## ')) kernelHeadings.add(headingText(h));
    }
  }
  const classes = [...(opts.capabilityClasses ?? [])].map((ref) => {
    const at = ref.lastIndexOf('@');
    return { ref, textName: at > 0 ? ref.slice(0, at) : ref };
  });
  const textGrantTier = opts.textGrantTier ?? 'warn';

  for (const d of docs) {
    if (d.layer === 'kernel') continue;
    const text = d.text;

    for (const lit of FORGED_CONTROL_LITERALS) {
      if (text.includes(lit)) {
        out.push({
          tier: 'block',
          code: 'forged-control-literal',
          documentId: d.id,
          slot: d.slot,
          line: lineOf(text, lit),
          message: `"${d.id}" contains the platform control literal ${JSON.stringify(lit)} — that marker stamps kernel / control-plane state and no identity may carry it`,
        });
      }
    }

    const restated = detectHeadingOverlap(text, kernelHeadings).filter((h) => {
      // Only a FULL heading match counts against a derived kernel heading (a substring
      // seed like the guard's 'AUTO mode' is the caller's own list, matched as a substring).
      return opts.kernelHeadings ? true : headingLines(text).some((l) => headingText(l).toLowerCase() === h.toLowerCase());
    });
    for (const h of restated) {
      out.push({
        tier: 'warn',
        code: 'kernel-heading-restated',
        documentId: d.id,
        slot: d.slot,
        line: lineOf(text, new RegExp(`^#{1,3}\\s.*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')),
        message: `"${d.id}" re-states the kernel-owned heading "${h}" — identities ADD to the kernel, they do not restate it (the kernel renders last under the seal regardless)`,
      });
    }

    const markerLine = text.split('\n').findIndex((l) => l.includes(GENERATED_MARKER) && !(d.slot === 'client' && l.trim() === CLIENT_SEAM_MARKER));
    if (markerLine >= 0) {
      out.push({
        tier: 'warn',
        code: 'generated-marker',
        documentId: d.id,
        slot: d.slot,
        line: markerLine + 1,
        message: `"${d.id}" embeds a generated splice marker (${GENERATED_MARKER}…) — those are the base's seams; an identity that carries one duplicates generated content`,
      });
    }

    for (const p of KERNEL_CONTRADICTION_PATTERNS) {
      const m = text.match(p.re);
      if (m) {
        out.push({
          tier: 'warn',
          code: 'kernel-contradiction-phrasing',
          documentId: d.id,
          slot: d.slot,
          line: lineOf(text, p.re),
          message: `"${d.id}" reads as instructing against the kernel invariant "${p.invariant}" (${JSON.stringify(m[0])}) — heuristic; the kernel renders last under the seal and the invariant is enforced in code, so this is a smell to review, not a gate`,
        });
      }
    }

    if (classes.length) {
      const granted = new Set([...(d.grants?.requires ?? []), ...(d.grants?.optional ?? [])]);
      for (const cls of classes) {
        if (granted.has(cls.ref)) continue;
        const re = new RegExp(`(^|[^\\w-])${cls.textName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'i');
        if (re.test(text)) {
          out.push({
            tier: textGrantTier,
            code: 'text-grant-inconsistency',
            documentId: d.id,
            slot: d.slot,
            line: lineOf(text, re),
            message: `"${d.id}" instructs use of capability class "${cls.ref}" but does not grant it — text and grants must agree (an identity's toolset is its grants ∩ the ceiling, never its prose)`,
          });
        }
      }
    }
  }
  return out;
}
