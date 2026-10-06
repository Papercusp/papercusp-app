/**
 * Reader-set labels for Personal Vault content — the PURE core.
 * Plan personal-data-reader-set-labels-2026-10-01 P-002 (WI-10004864), D-001..D-003.
 *
 * The rule being enforced: while restricted personal content is in an agent's
 * context, that agent may send only to people already permitted to read ALL of
 * that content. This is the decentralized-label-model "reader set" check
 * (Myers & Liskov 1997; the same shape as DeepMind's CaMeL send_email policy).
 *
 *   level      — resolved from OWNER-authored rules; default `unrestricted` (D-001).
 *   readerSet  — derived from REAL HEADERS ONLY (participants[] built from
 *                From/To/Cc by the adapter, and metadata.from). Never from body
 *                text: an address an attacker typed into a body must never become
 *                a permitted reader. That is the same signature the D-020
 *                addressee rails refuse (capability-verbs/addressing.ts).
 *   allowed    — the owner's own addresses ∪ (⋂ reader sets of every ACTIVE
 *                disclosure to this agent). Reading more restricted content can
 *                only SHRINK the set; nothing an agent reads can widen it.
 *
 * No I/O here; the ledger lives in disclosure-ledger.ts.
 */
import { normalizeParticipant } from './store';

export type PrivacyLevel = 'unrestricted' | 'participants' | 'sender-only';
export type RestrictedLevel = Exclude<PrivacyLevel, 'unrestricted'>;
export type PrivacyRuleMatch = 'source' | 'sender' | 'sender-domain';

export interface PrivacyRule {
  matchKind: PrivacyRuleMatch;
  matchValue: string;
  level: PrivacyLevel;
}

export interface LabelableDocument {
  id: string;
  source: string;
  participants: readonly string[];
  metadata?: Record<string, unknown> | null;
}

export interface DocumentLabel {
  level: RestrictedLevel;
  readerSet: string[];
}

export interface ActiveDisclosure {
  id: string;
  documentId: string;
  level: RestrictedLevel;
  readerSet: readonly string[];
}

export type AllowedRecipients =
  | { restricted: false }
  | { restricted: true; allowed: string[]; constraining: ActiveDisclosure[] };

export type RecipientCheck =
  | { ok: true }
  | { ok: false; violating: string[]; allowed: string[]; constraining: ActiveDisclosure[] };

const LEVEL_RANK: Record<PrivacyLevel, number> = { unrestricted: 0, participants: 1, 'sender-only': 2 };
/** Most specific match wins, so an owner can carve a per-sender exception out of a source-wide rule. */
const MATCH_SPECIFICITY: PrivacyRuleMatch[] = ['sender', 'sender-domain', 'source'];

function safeNormalize(value: string): string | null {
  const normalized = normalizeParticipant(String(value ?? ''));
  if (!normalized || /[\r\n\s,;]/.test(normalized)) return null;
  return normalized;
}

function firstHeaderAddress(value: unknown): string | null {
  if (typeof value === 'string') return safeNormalize(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstHeaderAddress(entry);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const email = (value as { email?: unknown; address?: unknown }).email
      ?? (value as { address?: unknown }).address;
    return typeof email === 'string' ? safeNormalize(email) : null;
  }
  return null;
}

/**
 * The document's sender from its header metadata (`from` / `sender` /
 * `organizer` / `author`). Returns null when no header carries one — callers
 * must then fail closed rather than guess.
 */
export function documentSender(doc: LabelableDocument): string | null {
  const meta = doc.metadata ?? {};
  for (const key of ['from', 'sender', 'organizer', 'author']) {
    const found = firstHeaderAddress((meta as Record<string, unknown>)[key]);
    if (found) return found;
  }
  return null;
}

export function senderDomain(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 ? address.slice(at + 1) : null;
}

/** Resolve a document's privacy level. Unmatched ⇒ `unrestricted` (D-001). */
export function resolvePrivacyLevel(doc: LabelableDocument, rules: readonly PrivacyRule[]): PrivacyLevel {
  const sender = documentSender(doc);
  const subject: Record<PrivacyRuleMatch, string | null> = {
    sender,
    'sender-domain': senderDomain(sender),
    source: doc.source.trim().toLowerCase(),
  };
  for (const kind of MATCH_SPECIFICITY) {
    const value = subject[kind];
    if (!value) continue;
    // Rules are unique per (kind, value) in Postgres; if a caller passes
    // duplicates anyway, the STRICTEST of them wins.
    let best: PrivacyLevel | null = null;
    for (const rule of rules) {
      if (rule.matchKind !== kind) continue;
      if (rule.matchValue.trim().toLowerCase() !== value) continue;
      if (best === null || LEVEL_RANK[rule.level] > LEVEL_RANK[best]) best = rule.level;
    }
    if (best !== null) return best;
  }
  return 'unrestricted';
}

/**
 * The stored form of a rule's match value, or null when the value cannot name
 * what its kind matches. Stored values compare equal to what
 * `resolvePrivacyLevel` derives from a document, so a rule cannot silently
 * never match.
 */
export function normalizeRuleValue(kind: PrivacyRuleMatch, value: string): string | null {
  if (kind === 'sender') {
    const normalized = safeNormalize(value);
    return normalized && senderDomain(normalized) ? normalized : null;
  }
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (kind === 'sender-domain') {
    const domain = trimmed.replace(/^@/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
  }
  return /^[a-z0-9][a-z0-9_.:-]*$/.test(trimmed) ? trimmed : null;
}

export type RuleChange =
  | { op: 'set'; matchKind: PrivacyRuleMatch; matchValue: string; level: PrivacyLevel }
  | { op: 'delete'; matchKind: PrivacyRuleMatch; matchValue: string };

export type RuleChangeEffect = 'tighten' | 'loosen' | 'noop';

function strictestRule(rules: readonly PrivacyRule[], kind: PrivacyRuleMatch, value: string | null): PrivacyLevel | null {
  if (!value) return null;
  let best: PrivacyLevel | null = null;
  for (const rule of rules) {
    if (rule.matchKind !== kind || rule.matchValue.trim().toLowerCase() !== value) continue;
    if (best === null || LEVEL_RANK[rule.level] > LEVEL_RANK[best]) best = rule.level;
  }
  return best;
}

/**
 * The level the documents a (kind, value) rule governs resolve to under
 * `rules`, given the level their SOURCE would give them. Mirrors the
 * specificity order of `resolvePrivacyLevel`: a sender rule falls back to its
 * domain's rule, and both fall back to whatever their source resolves to.
 */
function governedLevel(
  rules: readonly PrivacyRule[],
  kind: PrivacyRuleMatch,
  value: string,
  sourceLevel: PrivacyLevel,
): PrivacyLevel {
  const own = strictestRule(rules, kind, value);
  if (own) return own;
  if (kind === 'source') return 'unrestricted';
  if (kind === 'sender') {
    const domain = strictestRule(rules, 'sender-domain', senderDomain(value));
    if (domain) return domain;
  }
  return sourceLevel;
}

/**
 * Whether a rule change can LOWER the level some document resolves to. Judged
 * by effect, not by row: a new per-sender rule below its source's level is a
 * carve-out, and deleting a rule drops its documents to the next match — both
 * loosen even though neither edits an existing row downward (D-005).
 *
 * The documents a sender or domain rule governs can come from any source, so
 * every source level (and `unrestricted`, for a source with no rule) is a
 * possible starting point; the change loosens if it lowers any of them.
 * `value` must already be normalized (`normalizeRuleValue`).
 */
export function classifyRuleChange(rules: readonly PrivacyRule[], change: RuleChange): RuleChangeEffect {
  const value = change.matchValue;
  const others = rules.filter((rule) => !(rule.matchKind === change.matchKind && rule.matchValue.trim().toLowerCase() === value));
  const after = change.op === 'set' ? [...others, { matchKind: change.matchKind, matchValue: value, level: change.level }] : others;
  const sourceLevels = new Set<PrivacyLevel>(['unrestricted']);
  for (const rule of rules) if (rule.matchKind === 'source') sourceLevels.add(rule.level);

  let tightens = false;
  for (const sourceLevel of sourceLevels) {
    const before = LEVEL_RANK[governedLevel(rules, change.matchKind, value, sourceLevel)];
    const next = LEVEL_RANK[governedLevel(after, change.matchKind, value, sourceLevel)];
    if (next < before) return 'loosen';
    if (next > before) tightens = true;
  }
  return tightens ? 'tighten' : 'noop';
}

/**
 * The permitted readers of one document at a given level, from headers only.
 * `sender-only` with no resolvable sender yields an EMPTY set (owner-only):
 * an unknown sender must narrow, never widen.
 */
export function readerSetFor(doc: LabelableDocument, level: RestrictedLevel): string[] {
  if (level === 'sender-only') {
    const sender = documentSender(doc);
    return sender ? [sender] : [];
  }
  const readers = new Set<string>();
  const sender = documentSender(doc);
  if (sender) readers.add(sender);
  for (const participant of doc.participants) {
    const normalized = safeNormalize(participant);
    if (normalized) readers.add(normalized);
  }
  return [...readers].sort();
}

/** Label a document, or return null when it is unrestricted (no disclosure needed). */
export function labelDocument(doc: LabelableDocument, rules: readonly PrivacyRule[]): DocumentLabel | null {
  const level = resolvePrivacyLevel(doc, rules);
  if (level === 'unrestricted') return null;
  return { level, readerSet: readerSetFor(doc, level) };
}

/** Owner addresses ∪ ⋂ reader sets of the active disclosures. */
export function allowedRecipients(
  disclosures: readonly ActiveDisclosure[],
  ownerAddresses: readonly string[],
): AllowedRecipients {
  if (disclosures.length === 0) return { restricted: false };
  const readerSets: Set<string>[] = disclosures.map((disclosure) => new Set(
    disclosure.readerSet.map((r) => safeNormalize(r)).filter((r): r is string => !!r),
  ));
  const [first, ...rest] = readerSets;
  const allowed = new Set<string>([...first].filter((r) => rest.every((set) => set.has(r))));
  for (const owner of ownerAddresses) {
    const normalized = safeNormalize(owner);
    if (normalized) allowed.add(normalized);
  }
  return { restricted: true, allowed: [...allowed].sort(), constraining: [...disclosures] };
}

/**
 * Every recipient must be in the allowed set. An address that does not
 * normalize to a single mailbox is itself a violation (fail closed).
 */
export function checkRecipients(recipients: readonly string[], allowed: AllowedRecipients): RecipientCheck {
  if (!allowed.restricted) return { ok: true };
  const permitted = new Set(allowed.allowed);
  const violating: string[] = [];
  for (const recipient of recipients) {
    const normalized = safeNormalize(recipient);
    if (!normalized || !permitted.has(normalized)) violating.push(normalized ?? String(recipient));
  }
  if (violating.length === 0) return { ok: true };
  return { ok: false, violating, allowed: allowed.allowed, constraining: allowed.constraining };
}
