import {
  VOICE_PROTOCOL_VERSION,
  parseVoiceCapabilityEnvelope,
  parseVoicePrincipal,
  parseVoiceTurnRequest,
  type VoiceCapabilityEnvelope,
  type VoicePrincipal,
  type VoiceTurnRequest,
} from '@papercusp/chat-protocol';
import {
  createVoiceContextSources,
  resolveVoiceContextProjection,
  type VoiceContextProjection,
  type VoiceContextSources,
} from './voice-context-projection';

/** Transport fields that remain untrusted until the canonical request parses. */
export type VoiceTurnRoutingInput = Omit<
  VoiceTurnRequest,
  'version' | 'conversation' | 'principal' | 'capabilities'
> & {
  workspaceId: string;
  /** Identity resolved by the server auth/call-ledger boundary, never by the request body. */
  resolvedPrincipal: VoicePrincipal;
  /** Stable transport call/room id. Required whenever a call conversation is used. */
  callSessionId?: string;
};

export interface VoiceExecutorRequest {
  workspaceId: string;
  policy: 'owner' | 'restricted-call';
  turn: VoiceTurnRequest;
  /**
   * Server-only context passed to the executor. It is intentionally outside
   * VoiceTurnRequest so a transport/client cannot assert or widen it.
   */
  context: VoiceContextProjection;
}

export interface VoiceTurnRouterDependencies {
  getOrCreateActiveOperatorConversation(workspaceId: string): Promise<{ id: string }>;
  getOrCreateCallConversation(input: {
    workspaceId: string;
    callSessionId: string;
    transport: VoiceTurnRequest['transport'];
    principal: VoicePrincipal;
  }): Promise<{ id: string }>;
  /** Existing Papercup tool policy projected into canonical tool names for an owner turn. */
  resolveOwnerTools?(principal: VoicePrincipal): readonly string[] | Promise<readonly string[]>;
  /** Optional server-owned source seam; every route still resolves context. */
  voiceContextSources?: VoiceContextSources;
}

export type VoiceTurnRoutingErrorCode =
  | 'invalid_principal'
  | 'missing_call_session'
  | 'invalid_conversation'
  | 'invalid_capability_policy'
  | 'invalid_turn';

export class VoiceTurnRoutingError extends Error {
  constructor(readonly code: VoiceTurnRoutingErrorCode, message: string) {
    super(message);
    this.name = 'VoiceTurnRoutingError';
  }
}

const OWNER_READ: VoiceCapabilityEnvelope['read'] = [
  'conversation-history',
  'personal-memory',
  'contacts',
  'calendar',
  'email',
  'caller-history',
  'call-policy',
];
const OWNER_WRITE: VoiceCapabilityEnvelope['write'] = [
  'conversation-turn',
  'call-outcome',
  'draft',
];

const RESTRICTED_POLICY: Readonly<Record<Exclude<VoicePrincipal['kind'], 'owner'>, VoiceCapabilityEnvelope>> = {
  guest: {
    read: ['call-policy'],
    write: ['conversation-turn', 'call-outcome'],
    tools: [],
  },
  caller: {
    read: ['caller-history', 'call-policy'],
    write: ['conversation-turn', 'call-outcome'],
    tools: [],
  },
  unknown: {
    read: ['call-policy'],
    write: ['conversation-turn', 'call-outcome'],
    tools: [],
  },
};

function requiredText(value: string | undefined, code: VoiceTurnRoutingErrorCode, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new VoiceTurnRoutingError(code, `${field} is required`);
  return normalized;
}

function validateResolvedPrincipal(value: VoicePrincipal): VoicePrincipal {
  const principal = parseVoicePrincipal(value);
  if (!principal) {
    throw new VoiceTurnRoutingError('invalid_principal', 'server-resolved voice principal is invalid');
  }
  const valid =
    (principal.kind === 'owner' && principal.authoritySource === 'owner-session') ||
    (principal.kind === 'guest' && principal.authoritySource === 'invite' && principal.authenticated && principal.subjectId !== null) ||
    (principal.kind === 'caller' && principal.authoritySource === 'call-ledger' && principal.subjectId !== null) ||
    (principal.kind === 'unknown' && principal.authoritySource === 'unknown');
  if (!valid) {
    throw new VoiceTurnRoutingError(
      'invalid_principal',
      `voice principal ${principal.kind} has an incompatible authority source`,
    );
  }
  return principal;
}

function restrictedCapabilities(kind: Exclude<VoicePrincipal['kind'], 'owner'>): VoiceCapabilityEnvelope {
  const policy = RESTRICTED_POLICY[kind];
  return { read: [...policy.read], write: [...policy.write], tools: [] };
}

/**
 * Build the shared server-side router. The transport supplies turn content and
 * a server-resolved principal; conversation identity and capability authority
 * are always constructed here. Extra request-body fields are intentionally ignored.
 */
export function createVoiceTurnRouter(deps: VoiceTurnRouterDependencies) {
  return async function routeVoiceTurn(input: VoiceTurnRoutingInput): Promise<VoiceExecutorRequest> {
    const workspaceId = requiredText(input.workspaceId, 'invalid_turn', 'workspaceId');
    const principal = validateResolvedPrincipal(input.resolvedPrincipal);
    const isOwner = principal.kind === 'owner';

    let operatorConversation: { id: string } | null = null;
    if (isOwner) {
      operatorConversation = await deps.getOrCreateActiveOperatorConversation(workspaceId);
      requiredText(operatorConversation?.id, 'invalid_conversation', 'operator conversation id');
    }

    let conversation: VoiceTurnRequest['conversation'];
    if (isOwner && input.transport !== 'phone-livekit') {
      conversation = {
        kind: 'operator',
        id: operatorConversation!.id,
        parentOperatorConversationId: null,
      };
    } else {
      const callSessionId = requiredText(
        input.callSessionId,
        'missing_call_session',
        'callSessionId',
      );
      const callConversation = await deps.getOrCreateCallConversation({
        workspaceId,
        callSessionId,
        transport: input.transport,
        principal,
      });
      const callConversationId = requiredText(
        callConversation?.id,
        'invalid_conversation',
        'call conversation id',
      );
      conversation = {
        kind: 'phone-call',
        id: callConversationId,
        parentOperatorConversationId: isOwner ? operatorConversation!.id : null,
      };
    }

    let capabilities: VoiceCapabilityEnvelope;
    if (principal.kind === 'owner') {
      const tools = deps.resolveOwnerTools ? [...await deps.resolveOwnerTools(principal)] : [];
      const parsed = parseVoiceCapabilityEnvelope({
        read: OWNER_READ,
        write: OWNER_WRITE,
        tools,
      });
      if (!parsed) {
        throw new VoiceTurnRoutingError(
          'invalid_capability_policy',
          'resolved owner voice capability policy is invalid',
        );
      }
      capabilities = parsed;
    } else {
      capabilities = restrictedCapabilities(principal.kind);
    }

    const turn = parseVoiceTurnRequest({
      version: VOICE_PROTOCOL_VERSION,
      turnId: input.turnId,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      transport: input.transport,
      latencyClass: input.latencyClass,
      transcript: input.transcript,
      conversation,
      principal,
      capabilities,
    });
    if (!turn) {
      throw new VoiceTurnRoutingError('invalid_turn', 'voice turn failed canonical validation');
    }
    // Context is resolved only after the server has fixed the principal and
    // capability envelope. A source failure is represented by the projector's
    // degraded/empty slices and must never drop an otherwise valid turn.
    const context = await resolveVoiceContextProjection(
      {
        workspaceId,
        principal,
        capabilities,
        query: turn.transcript,
        callSessionId: input.callSessionId,
      },
      deps.voiceContextSources ?? createVoiceContextSources(),
    );
    return { workspaceId, policy: isOwner ? 'owner' : 'restricted-call', turn, context };
  };
}
