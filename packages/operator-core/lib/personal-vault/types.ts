export type PersonalPrincipalType = 'plan-template' | 'binding' | 'agent-role';

export interface PersonalPrincipal {
  type: PersonalPrincipalType;
  id: string;
}

export interface PersonalDocumentInput {
  source: string;
  sourceId?: string | null;
  providerAccountId?: string | null;
  /** Canonical datatype registry id; the routing key stored as documents.datatype_id (D-010). */
  datatypeId?: string | null;
  kind: string;
  externalId?: string | null;
  occurredAt?: string | Date | null;
  participants?: string[];
  participantIds?: string[];
  title?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface PersonalSearchInput {
  query: string;
  scopes?: string[];
  sourceIds?: string[];
  providerAccountIds?: string[];
  participants?: string[];
  timeRange?: { from?: string; to?: string };
  limit?: number;
  snippetChars?: number;
  queryEmbedding?: number[] | null;
}

export interface PersonalSearchResult {
  id: string;
  source: string;
  scopeKey: string;
  sourceId: string | null;
  providerAccountId: string | null;
  kind: string;
  externalId: string | null;
  occurredAt: string | null;
  participants: string[];
  participantIds: string[];
  title: string;
  snippet: string;
  metadata: Record<string, unknown>;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
}

export interface PersonalToolContext {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  role?: string | null;
  featureId?: string | null;
  planRunSessionId?: string | null;
  principal?: { kind?: string; slug?: string; workspaceId?: string } | null;
}
