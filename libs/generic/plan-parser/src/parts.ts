/**
 * parts — decompose a plan markdown into stably-keyed, BYTE-FAITHFUL parts, and
 * recompose them, so a plan can federate PER-PART instead of as one whole-document
 * blob (shared-hive-hardening-2026-06-13 P-018 / D-009).
 *
 * # Why
 *
 * Today a plan federates as the whole `harness_plans.content` markdown, LWW-merged
 * keyed by `plan_slug`. On a multi-machine shared hive that CLOBBERS: two peers
 * editing DIFFERENT items each produce a divergent whole-document, and the
 * last-writer-wins merge silently drops one peer's entire edit (plans have no git
 * backstop — the .md is gitignored + rendered-on-demand). Federating per part —
 * each item, decision, section as its own LWW key — lets concurrent edits to
 * DIFFERENT parts MERGE; only same-part edits race.
 *
 * # The byte-faithful invariant (load-bearing)
 *
 * `joinPartsIntoPlan(splitPlanIntoParts(content)) === content` for ALL inputs.
 * The split partitions the source into contiguous LINE ranges and each part holds
 * its raw lines, so recomposition is exact — no re-rendering, so prose sections
 * (Background, Verification, …) keep byte fidelity (unlike the structured
 * `renderer.ts`, which is deliberately NOT byte-faithful). This matters so a
 * peer's own split→join is identity (capturing a plan never spuriously rewrites
 * its content) and so reassembly on a remote peer is deterministic.
 *
 * # Keys
 *
 * Stable within a plan, derived from stable identity (heading text / P-NNN / D-NNN):
 *   - `frontmatter`            — the leading `--- … ---` YAML block
 *   - `preamble`              — the `# H1` + anything before the first `## `
 *   - `section:<heading-slug>`— a `## ` section (its heading + prose, minus items/decisions)
 *   - `item:<P-NNN>`          — one `- **P-NNN** …` item (+ its continuation lines)
 *   - `decision:<D-NNN>`      — one `### D-NNN …` decision block
 * Collisions (e.g. two identical `## ` headings) get a `#<n>` suffix so keys stay unique.
 *
 * Pure + dependency-free (generic-first). The FEDERATION wiring (capture emits
 * per-part ops; the projection LWW-merges + recomposes) builds on this and lives
 * in operator-core — see the P-018 wire-up notes.
 */

export type PlanPartKind = 'frontmatter' | 'preamble' | 'section' | 'item' | 'decision';

export interface PlanPart {
  /** Stable, unique-within-plan federation key (see module doc). */
  key: string;
  kind: PlanPartKind;
  /** Raw markdown of this part (its exact source lines joined by '\n'). */
  text: string;
  /** 0-based document order — drives deterministic reassembly + new-part placement. */
  order: number;
}

const FENCE = /^\s*(?:```|~~~)/;
const H2 = /^##\s+(.+?)\s*$/; // a top-level plan section heading (## …), not ### / #
const ITEM = /^[-*]\s+\*\*\s*(P-\d{3,})\s*\*\*/; // - **P-NNN** …
const DECISION = /^###\s+(D-\d{3,})\b/; // ### D-NNN …

function slug(heading: string): string {
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

interface Boundary {
  line: number;
  key: string;
  kind: PlanPartKind;
}

/**
 * Decompose a plan markdown into an ordered list of byte-faithful parts. The
 * parts cover 100% of the source as contiguous line ranges, so
 * {@link joinPartsIntoPlan} reconstructs the input exactly.
 */
export function splitPlanIntoParts(content: string): PlanPart[] {
  const lines = content.split('\n');
  if (lines.length === 1 && lines[0] === '') return []; // empty doc

  let scanStart = 0;
  let frontmatterEnd = -1; // exclusive end line of the frontmatter block
  if (lines[0]?.trimEnd() === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j]?.trimEnd() === '---') {
        frontmatterEnd = j + 1;
        break;
      }
    }
    if (frontmatterEnd !== -1) scanStart = frontmatterEnd;
  }

  // Collect part boundaries in the body, fence-aware (never split inside ``` … ```).
  const boundaries: Boundary[] = [];
  const used = new Map<string, number>();
  const uniq = (base: string): string => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  };
  let inFence = false;
  for (let i = scanStart; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h2 = H2.exec(line);
    if (h2) {
      boundaries.push({ line: i, key: uniq(`section:${slug(h2[1])}`), kind: 'section' });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      boundaries.push({ line: i, key: uniq(`item:${item[1]}`), kind: 'item' });
      continue;
    }
    const dec = DECISION.exec(line);
    if (dec) {
      boundaries.push({ line: i, key: uniq(`decision:${dec[1]}`), kind: 'decision' });
      continue;
    }
  }

  const parts: PlanPart[] = [];
  let order = 0;
  const pushRange = (key: string, kind: PlanPartKind, start: number, end: number) => {
    if (end <= start) return;
    parts.push({ key, kind, text: lines.slice(start, end).join('\n'), order: order++ });
  };

  // Frontmatter.
  if (frontmatterEnd !== -1) pushRange('frontmatter', 'frontmatter', 0, frontmatterEnd);

  // Preamble = from scanStart up to the first boundary (the H1 + any lead prose).
  const firstBoundary = boundaries.length > 0 ? boundaries[0].line : lines.length;
  pushRange('preamble', 'preamble', scanStart, firstBoundary);

  // Each boundary owns [its line, the next boundary's line).
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b].line;
    const end = b + 1 < boundaries.length ? boundaries[b + 1].line : lines.length;
    pushRange(boundaries[b].key, boundaries[b].kind, start, end);
  }

  return parts;
}

/**
 * Recompose parts into the plan markdown. Parts are emitted in `order`; because
 * {@link splitPlanIntoParts} produced contiguous line ranges, joining their raw
 * text with '\n' reconstructs the original byte-for-byte.
 */
export function joinPartsIntoPlan(parts: readonly PlanPart[]): string {
  return [...parts]
    .sort((a, b) => a.order - b.order)
    .map((p) => p.text)
    .join('\n');
}

export interface PlanPartsDiff {
  /** Parts that are new or whose text changed (capture emits an op per entry). */
  upserted: PlanPart[];
  /** Keys present before but gone now (capture emits a tombstone per entry). */
  removedKeys: string[];
}

/** What changed between two splits of the same plan — the capture-side delta. */
export function diffPlanParts(prev: readonly PlanPart[], next: readonly PlanPart[]): PlanPartsDiff {
  const prevByKey = new Map(prev.map((p) => [p.key, p]));
  const nextByKey = new Map(next.map((p) => [p.key, p]));
  const upserted: PlanPart[] = [];
  for (const p of next) {
    const before = prevByKey.get(p.key);
    if (!before || before.text !== p.text || before.order !== p.order) upserted.push(p);
  }
  const removedKeys: string[] = [];
  for (const p of prev) if (!nextByKey.has(p.key)) removedKeys.push(p.key);
  return { upserted, removedKeys };
}

/** A part as it travels the peer-log: the part + its LWW stamp. */
export interface FederatedPart extends PlanPart {
  /** LWW ordering field (epoch ms / HLC) — higher wins on the same key. */
  fedTs: number;
  /** Tie-break when fedTs is equal (e.g. the author device pubkey). */
  author?: string;
  /** A removal op — drops the key (still LWW-guarded by fedTs). */
  tombstone?: true;
}

function lwwWins(incoming: FederatedPart, existing: FederatedPart): boolean {
  if (incoming.fedTs !== existing.fedTs) return incoming.fedTs > existing.fedTs;
  // Equal ts → deterministic author tie-break (same on every peer).
  return (incoming.author ?? '') > (existing.author ?? '');
}

/**
 * LWW-merge one incoming federated part into a local part set, keyed by `part.key`.
 * THIS is the merge-not-clobber primitive: an op for `item:P-002` never touches
 * `item:P-001`, so concurrent edits to different parts both survive. Returns a new
 * map; never mutates the input.
 */
export function mergeFederatedPart(
  local: ReadonlyMap<string, FederatedPart>,
  incoming: FederatedPart,
): Map<string, FederatedPart> {
  const out = new Map(local);
  const existing = out.get(incoming.key);
  if (existing && !lwwWins(incoming, existing)) return out; // strictly-older / lost tie → drop
  if (incoming.tombstone) out.delete(incoming.key);
  else out.set(incoming.key, incoming);
  return out;
}

/** Recompose the live (non-tombstone) parts of a merged set into plan markdown. */
export function joinFederatedParts(parts: ReadonlyMap<string, FederatedPart>): string {
  return joinPartsIntoPlan([...parts.values()].filter((p) => !p.tombstone));
}
