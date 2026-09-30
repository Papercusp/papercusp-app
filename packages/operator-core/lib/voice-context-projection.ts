import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type {
  VoiceCapabilityEnvelope,
  VoicePrincipal,
  VoiceReadCapability,
} from '@papercusp/chat-protocol';
import { buildPersonalQueryEmbedder } from './personal-vault/embedding';
import {
  isPersonalVaultEnabled,
  personalScope,
  searchPersonalDocuments,
} from './personal-vault/store';
import type { PersonalSearchResult } from './personal-vault/types';
import { withMemoryTimeout } from './memory/op-deadline';

export const VOICE_CONTEXT_PROJECTION_VERSION = 1 as const;
export const VOICE_CONTEXT_LIMIT = 12;
export const VOICE_CONTEXT_SNIPPET_CHARS = 480;
export const VOICE_CONTEXT_EMBED_TIMEOUT_MS = 750;

const VOICE_QUERY_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'before', 'could', 'from', 'have', 'into',
  'just', 'know', 'please', 'status', 'tell', 'that', 'their', 'there', 'these',
  'the', 'they', 'this', 'those', 'what', 'when', 'where', 'which', 'with', 'would',
  'your',
]);

const DAY_MS = 24 * 60 * 60 * 1_000;

export const VOICE_CONTEXT_CAPABILITIES = [
  'personal-memory',
  'contacts',
  'calendar',
  'email',
  'caller-history',
  'call-policy',
] as const satisfies readonly VoiceReadCapability[];

export type VoiceContextCapability = (typeof VOICE_CONTEXT_CAPABILITIES)[number];
export type VoiceContextDataCapability = Exclude<VoiceContextCapability, 'call-policy'>;

/**
 * A turn projection is deliberately recency-bounded. Contacts are current
 * state rather than events, so an undated contact remains usable; every other
 * dated source has a finite window and is re-checked on every turn.
 */
export const VOICE_CONTEXT_MAX_AGE_MS: Readonly<Record<VoiceContextCapability, number | null>> = {
  'personal-memory': 365 * DAY_MS,
  contacts: null,
  calendar: 180 * DAY_MS,
  email: 180 * DAY_MS,
  'caller-history': 180 * DAY_MS,
  'call-policy': null,
};

export interface VoiceContextItemProvenance {
  system: 'personal-vault' | 'caller-history';
  source: string;
  id: string | null;
  externalId: string | null;
  providerAccountId: string | null;
  scope: string | null;
  retrievedAt: string;
}

/** A server-source candidate. Client input is never accepted in this shape. */
export interface VoiceContextCandidate {
  capability: VoiceContextDataCapability;
  title: string;
  text: string;
  occurredAt: string | null;
  /** Source-owned expiry wins over the generic recency window. */
  freshUntil?: string | null;
  /** Explicit source invalidation; useful when a source knows more than age. */
  stale?: boolean;
  provenance: Omit<VoiceContextItemProvenance, 'retrievedAt'>;
}

export interface VoiceContextItem extends Omit<VoiceContextCandidate, 'freshUntil' | 'stale'> {
  provenance: VoiceContextItemProvenance;
}

export type VoiceContextSliceStatus = 'ready' | 'empty' | 'degraded' | 'denied';
export type VoiceContextSliceReason =
  | 'not-capable'
  | 'principal-not-owner'
  | 'no-subject'
  | 'no-fresh-results'
  | 'vault-disabled'
  | 'source-unavailable';

export interface VoiceContextSlice {
  capability: VoiceContextCapability;
  status: VoiceContextSliceStatus;
  checkedAt: string;
  maxAgeMs: number | null;
  droppedStale: number;
  droppedInvalid: number;
  items: VoiceContextItem[];
  reason?: VoiceContextSliceReason;
  /** Present only on the server-derived call-policy slice. */
  policy?: VoiceCapabilityEnvelope;
}

export interface VoiceContextProjection {
  version: typeof VOICE_CONTEXT_PROJECTION_VERSION;
  resolvedAt: string;
  status: 'ready' | 'empty' | 'degraded';
  principal: Pick<VoicePrincipal, 'kind' | 'subjectId' | 'authoritySource'>;
  sources: VoiceContextSlice[];
}

export interface VoiceContextResolutionInput {
  workspaceId: string;
  principal: VoicePrincipal;
  capabilities: VoiceCapabilityEnvelope;
  query: string;
  callSessionId?: string;
}

export type VoiceContextSourceResult =
  | { available: true; candidates: readonly VoiceContextCandidate[] }
  | { available: false; reason: 'vault-disabled' | 'source-unavailable' };

export interface VoiceContextSources {
  resolveOwnerVault(input: {
    workspaceId: string;
    userId: string;
    query: string;
    capabilities: VoiceCapabilityEnvelope;
  }): Promise<VoiceContextSourceResult>;
  resolveCallerHistory(input: {
    workspaceId: string;
    subjectId: string;
    callSessionId?: string;
    query: string;
  }): Promise<VoiceContextSourceResult>;
  now?(): Date;
}

export interface CreateVoiceContextSourcesOptions {
  sql?: Sql;
  embedQuery?: (query: string) => Promise<number[] | null>;
  resolveCallerHistory?: VoiceContextSources['resolveCallerHistory'];
  now?: () => Date;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function personalResultCapability(result: Pick<PersonalSearchResult, 'source'>): VoiceContextDataCapability {
  switch (result.source.trim().toLowerCase()) {
    case 'gmail':
      return 'email';
    case 'calendar':
      return 'calendar';
    case 'contacts':
      return 'contacts';
    default:
      return 'personal-memory';
  }
}

export function personalResultToVoiceContextCandidate(result: PersonalSearchResult): VoiceContextCandidate {
  return {
    capability: personalResultCapability(result),
    title: result.title,
    text: result.snippet,
    occurredAt: result.occurredAt,
    freshUntil: metadataText(result.metadata, 'freshUntil') ?? metadataText(result.metadata, 'expiresAt'),
    stale: result.metadata.stale === true,
    provenance: {
      system: 'personal-vault',
      source: result.source,
      id: result.id,
      externalId: result.externalId,
      providerAccountId: result.providerAccountId,
      scope: result.scopeKey,
    },
  };
}

function ownerVaultScopes(capabilities: VoiceCapabilityEnvelope): string[] {
  const reads = new Set(capabilities.read);
  // personal-memory is the explicit permission for non-calendar/contact/mail
  // vault sources (social archives, imported notes, and future source kinds).
  // An empty scope list means the store may search all sources; results are
  // still mapped and filtered against the capability set below.
  if (reads.has('personal-memory')) return [];
  const scopes: string[] = [];
  if (reads.has('email')) scopes.push(personalScope('gmail'));
  if (reads.has('calendar')) scopes.push(personalScope('calendar'));
  if (reads.has('contacts')) scopes.push(personalScope('contacts'));
  return scopes;
}

/**
 * `searchPersonalDocuments` intentionally uses websearch semantics, whose
 * unquoted words are conjunctive. When the embedding leg is unavailable, a
 * natural spoken question can therefore miss a row because one filler word is
 * absent. This bounded fallback keeps only content-like tokens and explicitly
 * ORs them. It is used only after the primary hybrid query returns no rows.
 */
export function voiceContextLexicalFallbackQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((token) => !VOICE_QUERY_STOP_WORDS.has(token)) ?? [];
  const unique = [...new Set(tokens)].slice(0, 8);
  return unique.length >= 2 ? unique.join(' OR ') : null;
}

/**
 * Production Personal Vault source. Voice authorization is already fixed by
 * the server-resolved principal + capability envelope, so this deliberately
 * does not reuse the agent-plan grant model from personal-vault/authorization.
 * It does reuse the vault kill switch, bounded hybrid search, and provenance.
 */
export function createVoiceContextSources(
  options: CreateVoiceContextSourcesOptions = {},
): VoiceContextSources {
  return {
    now: options.now,
    async resolveOwnerVault(input) {
      const sql = options.sql ?? getOrgPg().sql;
      if (!(await isPersonalVaultEnabled(sql, input.workspaceId, input.userId))) {
        return { available: false, reason: 'vault-disabled' };
      }
      let queryEmbedding: number[] | null = null;
      try {
        if (options.embedQuery) {
          queryEmbedding = await options.embedQuery(input.query);
        } else {
          const embed = await buildPersonalQueryEmbedder();
          queryEmbedding = await withMemoryTimeout(
            embed(input.query),
            'voice-context-query',
            VOICE_CONTEXT_EMBED_TIMEOUT_MS,
          );
        }
      } catch {
        // Lexical search remains available and policy is unchanged.
      }
      const primaryQuery = input.query.trim().slice(0, 500);
      const searchInput = {
        query: primaryQuery,
        scopes: ownerVaultScopes(input.capabilities),
        limit: VOICE_CONTEXT_LIMIT,
        snippetChars: VOICE_CONTEXT_SNIPPET_CHARS,
        queryEmbedding,
      };
      let results = await searchPersonalDocuments(sql, input.workspaceId, input.userId, searchInput);
      const fallbackQuery = voiceContextLexicalFallbackQuery(primaryQuery);
      if (!results.length && fallbackQuery) {
        results = await searchPersonalDocuments(sql, input.workspaceId, input.userId, {
          ...searchInput,
          query: fallbackQuery,
        });
      }
      return { available: true, candidates: results.map(personalResultToVoiceContextCandidate) };
    },
    resolveCallerHistory: options.resolveCallerHistory ?? (async () => ({
      available: false,
      reason: 'source-unavailable',
    })),
  };
}

function safeNow(source: VoiceContextSources): Date {
  try {
    const value = source.now?.() ?? new Date();
    return Number.isFinite(value.getTime()) ? value : new Date();
  } catch {
    return new Date();
  }
}

function baseSlice(
  capability: VoiceContextCapability,
  checkedAt: string,
  status: VoiceContextSliceStatus,
  reason?: VoiceContextSliceReason,
): VoiceContextSlice {
  return {
    capability,
    status,
    checkedAt,
    maxAgeMs: VOICE_CONTEXT_MAX_AGE_MS[capability],
    droppedStale: 0,
    droppedInvalid: 0,
    items: [],
    ...(reason ? { reason } : {}),
  };
}

function candidateFresh(candidate: VoiceContextCandidate, nowMs: number, maxAgeMs: number | null): boolean {
  if (candidate.stale) return false;
  if (candidate.freshUntil !== undefined && candidate.freshUntil !== null) {
    const until = Date.parse(candidate.freshUntil);
    if (!Number.isFinite(until) || until <= nowMs) return false;
  }
  if (candidate.occurredAt !== null) {
    const occurred = Date.parse(candidate.occurredAt);
    if (!Number.isFinite(occurred)) return false;
    if (maxAgeMs !== null && occurred < nowMs - maxAgeMs) return false;
  }
  return true;
}

function resolvedSlice(
  capability: VoiceContextDataCapability,
  candidates: readonly VoiceContextCandidate[],
  checkedAt: string,
  nowMs: number,
): VoiceContextSlice {
  const slice = baseSlice(capability, checkedAt, 'empty');
  for (const candidate of candidates) {
    if (candidate.capability !== capability) continue;
    if (!candidateFresh(candidate, nowMs, slice.maxAgeMs)) {
      slice.droppedStale += 1;
      continue;
    }
    const title = text(candidate.title, 200);
    const itemText = text(candidate.text, VOICE_CONTEXT_SNIPPET_CHARS);
    if (!title && !itemText) {
      slice.droppedInvalid += 1;
      continue;
    }
    slice.items.push({
      capability,
      title: title || '(untitled)',
      text: itemText,
      occurredAt: candidate.occurredAt,
      provenance: { ...candidate.provenance, retrievedAt: checkedAt },
    });
  }
  if (slice.items.length) {
    slice.status = 'ready';
  } else if (slice.droppedStale || slice.droppedInvalid) {
    slice.reason = 'no-fresh-results';
  }
  return slice;
}

function unavailableSlices(
  capabilities: readonly VoiceContextDataCapability[],
  checkedAt: string,
  result: Extract<VoiceContextSourceResult, { available: false }>,
): VoiceContextSlice[] {
  const degraded = result.reason === 'source-unavailable';
  return capabilities.map((capability) =>
    baseSlice(capability, checkedAt, degraded ? 'degraded' : 'empty', result.reason));
}

/**
 * Build the server-only context object that accompanies every executor turn.
 * It never reads a client context field, never invokes the owner vault for a
 * non-owner, and converts each source failure into an explicit empty/degraded
 * slice rather than failing the voice turn.
 */
export async function resolveVoiceContextProjection(
  input: VoiceContextResolutionInput,
  sources: VoiceContextSources,
): Promise<VoiceContextProjection> {
  const now = safeNow(sources);
  const resolvedAt = now.toISOString();
  const allowed = new Set(input.capabilities.read);
  const slices = new Map<VoiceContextCapability, VoiceContextSlice>();

  for (const capability of VOICE_CONTEXT_CAPABILITIES) {
    slices.set(
      capability,
      allowed.has(capability)
        ? baseSlice(capability, resolvedAt, 'empty')
        : baseSlice(capability, resolvedAt, 'denied', 'not-capable'),
    );
  }

  if (allowed.has('call-policy')) {
    slices.set('call-policy', {
      ...baseSlice('call-policy', resolvedAt, 'ready'),
      policy: {
        read: [...input.capabilities.read],
        write: [...input.capabilities.write],
        tools: [...input.capabilities.tools],
      },
    });
  }

  const ownerCapabilities = (['personal-memory', 'contacts', 'calendar', 'email'] as const)
    .filter((capability) => allowed.has(capability));
  if (ownerCapabilities.length) {
    if (input.principal.kind !== 'owner' || !input.principal.subjectId) {
      for (const capability of ownerCapabilities) {
        slices.set(capability, baseSlice(capability, resolvedAt, 'denied', 'principal-not-owner'));
      }
    } else {
      try {
        const result = await sources.resolveOwnerVault({
          workspaceId: input.workspaceId,
          userId: input.principal.subjectId,
          query: input.query,
          capabilities: input.capabilities,
        });
        if (result.available) {
          for (const capability of ownerCapabilities) {
            slices.set(capability, resolvedSlice(capability, result.candidates, resolvedAt, now.getTime()));
          }
        } else {
          for (const slice of unavailableSlices(ownerCapabilities, resolvedAt, result)) {
            slices.set(slice.capability, slice);
          }
        }
      } catch {
        for (const slice of unavailableSlices(
          ownerCapabilities,
          resolvedAt,
          { available: false, reason: 'source-unavailable' },
        )) {
          slices.set(slice.capability, slice);
        }
      }
    }
  }

  if (allowed.has('caller-history')) {
    if (!input.principal.subjectId) {
      slices.set('caller-history', baseSlice('caller-history', resolvedAt, 'empty', 'no-subject'));
    } else {
      try {
        const result = await sources.resolveCallerHistory({
          workspaceId: input.workspaceId,
          subjectId: input.principal.subjectId,
          callSessionId: input.callSessionId,
          query: input.query,
        });
        if (result.available) {
          // The caller-history adapter is a distinct server-owned trust seam.
          // Reject a mislabeled Personal Vault row even if it claims the right
          // capability; that turns an adapter bug into empty context, not leak.
          const permitted = result.candidates.filter((candidate) =>
            candidate.capability === 'caller-history'
            && candidate.provenance.system === 'caller-history');
          const projected = resolvedSlice('caller-history', permitted, resolvedAt, now.getTime());
          projected.droppedInvalid += result.candidates.length - permitted.length;
          if (!projected.items.length && projected.droppedInvalid && !projected.reason) {
            projected.reason = 'no-fresh-results';
          }
          slices.set('caller-history', projected);
        } else {
          slices.set('caller-history', unavailableSlices(['caller-history'], resolvedAt, result)[0]!);
        }
      } catch {
        slices.set(
          'caller-history',
          baseSlice('caller-history', resolvedAt, 'degraded', 'source-unavailable'),
        );
      }
    }
  }

  const ordered = VOICE_CONTEXT_CAPABILITIES.map((capability) => slices.get(capability)!);
  const hasDegraded = ordered.some((slice) => slice.status === 'degraded');
  const hasData = ordered.some((slice) => slice.capability !== 'call-policy' && slice.items.length > 0);
  return {
    version: VOICE_CONTEXT_PROJECTION_VERSION,
    resolvedAt,
    status: hasDegraded ? 'degraded' : hasData ? 'ready' : 'empty',
    principal: {
      kind: input.principal.kind,
      subjectId: input.principal.subjectId,
      authoritySource: input.principal.authoritySource,
    },
    sources: ordered,
  };
}
