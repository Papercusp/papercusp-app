/**
 * remember-coerce.ts — WI-1982: be liberal about memory:remember's `kind`.
 *
 * memory:remember failed ~21% of calls (34/161 in 24h). ~12 of those were a valid
 * fact (content present) REJECTED purely because `kind` was missing or outside the
 * unified enum {user,feedback,project,reference} — the agent used a legacy kind
 * (identity/preference/correction) or a free-form label (fact/note/technical/…), and
 * the write (durable knowledge) was LOST. Coerce `kind` to the closest valid bucket
 * instead of rejecting; a fact is far better mis-bucketed than dropped, and recall is
 * semantic (not kind-filtered), so the blast radius of a defaulted kind is tiny.
 *
 * (The OTHER ~20 failures are a client double-encoding the whole args as a JSON
 * string under an `args` key — `content` then reads undefined. That is a
 * cross-tool DISPATCH-layer bug, filed separately; this coercion deliberately does
 * NOT fabricate a missing `content`.)
 */

type ValidKind = 'user' | 'feedback' | 'project' | 'reference';
const VALID_KINDS = new Set<ValidKind>(['user', 'feedback', 'project', 'reference']);

/** Legacy + common free-form labels → the unified taxonomy. Unmapped ⇒ 'reference'
 *  (the catch-all for hard-won technical facts, which is what agents mostly write). */
const KIND_ALIASES: Record<string, ValidKind> = {
  // user = who they are
  identity: 'user',
  who: 'user',
  profile: 'user',
  person: 'user',
  // feedback = how to work (corrections + confirmed approaches)
  preference: 'feedback',
  correction: 'feedback',
  howto: 'feedback',
  'how-to': 'feedback',
  approach: 'feedback',
  convention: 'feedback',
  lesson: 'feedback',
  // project = ongoing work context
  work: 'project',
  context: 'project',
  task: 'project',
  progress: 'project',
  status: 'project',
  // reference = pointers + hard-won technical facts
  fact: 'reference',
  note: 'reference',
  notes: 'reference',
  technical: 'reference',
  tech: 'reference',
  insight: 'reference',
  pointer: 'reference',
  ref: 'reference',
  doc: 'reference',
  docs: 'reference',
  gotcha: 'reference',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Map any kind input to a valid enum member (default 'reference'). Exported for tests. */
export function normalizeMemoryKind(kind: unknown): ValidKind {
  if (typeof kind === 'string') {
    const k = kind.trim().toLowerCase();
    if (VALID_KINDS.has(k as ValidKind)) return k as ValidKind;
    if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  }
  return 'reference';
}

export function coerceMemoryKind(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  // A valid, exactly-cased kind is left untouched (identity — no needless clone).
  if (typeof raw.kind === 'string' && VALID_KINDS.has(raw.kind as ValidKind)) return raw;
  return { ...raw, kind: normalizeMemoryKind(raw.kind) };
}
