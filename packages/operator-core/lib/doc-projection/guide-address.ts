/**
 * guide-address.ts — the ADDRESSING grammar of a Project-guide doc part
 * (identities-v1-2026-08-30 P-022).
 *
 * A `harness_doc_parts` row carries two projection axes:
 *
 *   client_scope  WHICH FILE  — `{claude}` / `{codex}` / `{all}`   (migration 781)
 *   stack_scope   WHO         — `blueprint:<id>` / `slot:<slot>` / `role:<role>`  (1104)
 *
 * `stack_scope` is a list of TOKENS, OR-matched against the wearer's expanded stack —
 * the same `&&` semantics `client_scope` already has. An EMPTY list means UNADDRESSED:
 * the part reaches every reader and lives in the default CLAUDE.md / AGENTS.md. A
 * non-empty list keeps the part OUT of the default file and delivers it only to a
 * launch whose stack matches (see `addressed-project-guide.ts`).
 *
 * The projector script (`scripts/project-doc-parts.mjs`) treats tokens as OPAQUE
 * strings — it only needs "is this part addressed?" and "does this token set intersect
 * that one?" — so the vocabulary lives HERE, once, in TypeScript: the write seat
 * (`validateDocPart` ← set-doc-part) refuses a token this module cannot parse, and the
 * launch seat (`guideAddressesForWearer`) is the only place a wearer is turned into
 * tokens. Migration 1104's `stack_scope_shape` CHECK mirrors `parseGuideAddress` for
 * raw-SQL writes, the same way `validateDocPart` mirrors 781's CHECKs.
 */

/**
 * `package` (portable-identity-packages P-009 / D-022) addresses ONE exact installed
 * pack-doc resource by its 64-hex `packageResourceKey`. It is workspace-unique, so a
 * package token matches across guide harnesses; the other kinds stay per harness.
 */
export const GUIDE_ADDRESS_KINDS = ['blueprint', 'slot', 'role', 'package'] as const;
export type GuideAddressKind = (typeof GUIDE_ADDRESS_KINDS)[number];

export interface GuideAddress {
  kind: GuideAddressKind;
  value: string;
}

/** `<kind>:<value>` — kind from the closed set, value non-blank with no whitespace or ':'. */
export function parseGuideAddress(token: string): GuideAddress | null {
  const m = /^(blueprint|slot|role|package):([^\s:]+)$/.exec(token);
  if (!m) return null;
  if (m[1] === 'package' && !/^[a-f0-9]{64}$/.test(m[2])) return null;
  return { kind: m[1] as GuideAddressKind, value: m[2] };
}

/** True for a `package:<resourceKey>` token (matched across guide harnesses). */
export function isPackageGuideAddress(token: string): boolean {
  return parseGuideAddress(token)?.kind === 'package';
}

export function formatGuideAddress(addr: GuideAddress): string {
  return `${addr.kind}:${addr.value}`;
}

export interface GuideAddressVocabulary {
  /** Registered slot ids (`SLOT_IDS` from `@papercusp/orchestrator/blueprint`). */
  knownSlots?: readonly string[];
  /** Whether a blueprint / identity id resolves in the tiers the caller can see. */
  blueprintExists?: (id: string) => boolean;
}

/**
 * Every reason a `stack_scope` value is not a valid addressing declaration. Pure; the
 * vocabulary checks run only when the caller supplies the vocabulary (a projector run
 * with no harness on disk still refuses a malformed token, and still accepts a
 * well-formed one it cannot look up).
 */
export function guideAddressProblems(
  stackScope: readonly string[],
  vocab: GuideAddressVocabulary = {},
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const token of stackScope) {
    if (seen.has(token)) {
      problems.push(`duplicate address ${JSON.stringify(token)}`);
      continue;
    }
    seen.add(token);
    const addr = parseGuideAddress(token);
    if (!addr) {
      problems.push(
        `${JSON.stringify(token)} is not an address — expected <kind>:<value> with kind in ` +
          `${GUIDE_ADDRESS_KINDS.join(' | ')} and a value with no whitespace or ':'`,
      );
      continue;
    }
    if (addr.kind === 'slot' && vocab.knownSlots && !vocab.knownSlots.includes(addr.value)) {
      problems.push(
        `slot:${addr.value} names no registered slot (known: ${vocab.knownSlots.join(', ')})`,
      );
    }
    if (addr.kind === 'blueprint' && vocab.blueprintExists && !vocab.blueprintExists(addr.value)) {
      problems.push(
        `blueprint:${addr.value} resolves to no blueprint in the tiers this write can see — ` +
          `a part addressed to an identity nobody can wear is a silent no-op forever`,
      );
    }
  }
  return problems;
}

/** One bound layer of a wearer's stack — `{ slot, id }`, the shape `StackBinding` carries. */
export interface GuideWearerLayer {
  slot: string;
  id: string;
}

/** The facts a launch knows about who is about to read the guide. */
export interface GuideWearer {
  /** The prompt role (`su`, `operator`, `worker`, …). Omit when the launch has none. */
  role?: string | null;
  /** The bound stack: static layers + the session binding (fleet posture, mode axes, …). */
  layers: readonly GuideWearerLayer[];
  /**
   * P-009 / D-022: the exact pack-doc resource keys this wearer's installation holds
   * (never another owner's). Omit ⇒ no package tokens.
   */
  packageResources?: readonly string[];
}

/**
 * Expand a wearer into the tokens an addressed part can match — the ONLY wearer →
 * token mapping in the system. Deterministic and deduplicated so a launch record can
 * quote it and a test can pin it.
 */
export function guideAddressesForWearer(wearer: GuideWearer): string[] {
  const out = new Set<string>();
  const role = (wearer.role ?? '').trim();
  if (role) out.add(formatGuideAddress({ kind: 'role', value: role }));
  for (const layer of wearer.layers) {
    const slot = (layer.slot ?? '').trim();
    const id = (layer.id ?? '').trim();
    if (slot) out.add(formatGuideAddress({ kind: 'slot', value: slot }));
    if (id) out.add(formatGuideAddress({ kind: 'blueprint', value: id }));
  }
  for (const key of wearer.packageResources ?? []) {
    const token = formatGuideAddress({ kind: 'package', value: key.trim() });
    if (parseGuideAddress(token)) out.add(token);
  }
  return [...out].sort();
}

/** `stack_scope && tokens` — the intersection test, identical to what the SQL read does. */
export function guideAddressMatches(
  stackScope: readonly string[],
  wearerTokens: readonly string[],
): boolean {
  if (stackScope.length === 0) return true; // unaddressed reaches everyone
  return stackScope.some((t) => wearerTokens.includes(t));
}
