export const SESSION_PORT_SCHEMA = 'papercusp.session-port/v1' as const;
export const SESSION_PORT_PROTOCOL_VERSION = 2 as const;
export const SESSION_PORT_TRANSFORM_VERSION = 4 as const;
export const SESSION_PORT_TOKEN_ESTIMATOR = 'utf8-byte-upper-bound-v1' as const;

export type SessionBackend = 'claude' | 'codex' | 'omp';
export type PortableRole = 'user' | 'assistant' | 'system' | 'tool';

export interface PortableTextBlock {
  type: 'text';
  text: string;
}

export interface PortableToolNarrativeBlock {
  /** Inert historical narrative. This is deliberately not an executable tool
   * object and carries no source-provider call id. */
  type: 'tool_narrative';
  event: 'call' | 'result';
  /** Adapter-local relationship id shared by one historical call and its
   * result. Source-provider call ids never cross the port boundary. */
  relationId: string | null;
  name: string;
  content: string;
  isError?: boolean;
}

export interface PortableTextAttachmentBlock {
  type: 'text_attachment';
  name: string | null;
  mediaType: string | null;
  text: string;
  originalBytes: number;
  truncated: boolean;
}

export interface PortableOmissionBlock {
  type: 'omission';
  reason:
    | 'binary-attachment'
    | 'unsupported-content'
    | 'provider-thinking'
    | 'provider-signature'
    | 'redacted';
  sourceType: string;
}

export type PortableBlock =
  | PortableTextBlock
  | PortableTextAttachmentBlock
  | PortableToolNarrativeBlock
  | PortableOmissionBlock;

export interface PortableTurn {
  id: string;
  parentId: string | null;
  role: PortableRole;
  timestamp: string | null;
  blocks: PortableBlock[];
  compactSummary?: boolean;
}

export interface PortableSessionPort {
  schema: typeof SESSION_PORT_SCHEMA;
  protocolVersion: typeof SESSION_PORT_PROTOCOL_VERSION;
  source: {
    backend: SessionBackend;
    workspaceId: string;
    advSessionId: number;
    nativeSessionId: string;
    cwd: string;
    harnessSlug: string | null;
    planSlug: string | null;
    capturedAt: string;
    snapshot: {
      kind: 'live-jsonl' | 'archive-manifest';
      highWaterBytes: number;
      completeBytes: number;
      sha256: string;
      archiveRelpath: string | null;
    };
    activeLeafId: string | null;
    compactSummaryIds: string[];
  };
  target: {
    backend: SessionBackend;
    provider: string;
    model: string | null;
    account: string;
    contextWindow: number;
    availableInputTokens: number;
    contextSize: 'full' | 'trimmed' | 'steward' | null;
    /** Digest of the resolved launch-context bytes. The path itself is not an
     * identity: changing the file behind a stable path must create a new logical
     * request, while moving byte-identical context must not. */
    launchContextHash: string;
    /** Explicit distinct answer identity. Omitted for source continuation. */
    ownerId?: string;
  };
  fidelity: 'full' | 'summary-tail';
  versions: {
    adapter: number;
    transform: number;
    renderer: number;
    summaryPrompt: number | null;
  };
  hashes: {
    source: string;
    normalized: string;
    rendered: string;
  };
  budget: {
    estimator: typeof SESSION_PORT_TOKEN_ESTIMATOR;
    availableInputTokens: number;
    finalPayloadEstimatedTokens: number;
    summarizerOutputBudgetTokens: number | null;
  };
  portedFrom: {
    backend: SessionBackend;
    advSessionId: number;
    nativeSessionId: string;
  };
  turns: PortableTurn[];
  stats: {
    sourceRecords: number;
    activePathRecords: number;
    malformedRecords: number;
    sidechainRecords: number;
    compactedAncestors: number;
    toolCalls: number;
    toolResults: number;
    unlinkedToolResults: number;
    truncatedToolNarratives: number;
    omittedAttachments: number;
    textAttachments: number;
    truncatedAttachments: number;
    omittedThinkingBlocks: number;
    omittedSignatureBlocks: number;
    unsupportedBlocks: number;
    syntheticRecords: number;
    redactions: number;
    controlBytesRemoved: number;
    delimiterEscapes: number;
  };
  summary: null | {
    provider: string;
    model: string;
    costUsd: number;
    chunks: number;
    promptVersion: number;
    outputBudgetTokens: number;
    maxOutputTokensPerChunk: number;
  };
  warnings: string[];
}

/** Durable, content-free projection of a portable contract. The full contract
 * (especially `turns`) exists only while rendering the short-lived 0600 seed
 * artifact and must never be copied into session_ports.metadata. */
export interface SessionPortContractSummary {
  protocolVersion: typeof SESSION_PORT_PROTOCOL_VERSION;
  source: Pick<
    PortableSessionPort['source'],
    'backend' | 'workspaceId' | 'advSessionId' | 'nativeSessionId' | 'cwd' | 'harnessSlug' | 'planSlug' | 'snapshot'
  >;
  target: PortableSessionPort['target'];
  fidelity: PortableSessionPort['fidelity'];
  versions: PortableSessionPort['versions'];
  hashes: PortableSessionPort['hashes'];
  budget: PortableSessionPort['budget'];
  stats: PortableSessionPort['stats'];
  summary: PortableSessionPort['summary'];
  warnings: string[];
}

export interface ClaudeAdaptResult {
  turns: PortableTurn[];
  stats: PortableSessionPort['stats'];
  warnings: string[];
  activeLeafId: string | null;
}
