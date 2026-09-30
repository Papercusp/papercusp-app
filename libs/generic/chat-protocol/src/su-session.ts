import type { OpenCardSnapshot } from "./index.js";

/**
 * Stable, dependency-free wire contract between an SU-session host and clients
 * such as PUI. Runtime adapters may use provider SDKs internally, but none of
 * those types cross this boundary.
 */
export const SU_SESSION_SCHEMA = "papercusp.su-session/v1" as const;
export const SU_SESSION_PROTOCOL_VERSION = 1 as const;

export const SU_SESSION_BACKENDS = ["claude", "codex", "omp"] as const;
export type SuSessionBackend = (typeof SU_SESSION_BACKENDS)[number];

export const SU_SESSION_LIFECYCLE_STATES = [
  "starting",
  "ready",
  "running",
  "waiting-for-owner",
  "interrupted",
  "compacting",
  "resuming",
  "ended",
  "failed",
] as const;
export type SuSessionLifecycleState =
  (typeof SU_SESSION_LIFECYCLE_STATES)[number];

export const SU_SESSION_COMMAND_TYPES = [
  "owner_turn",
  "interrupt",
  "resume",
  "fork",
  "focus",
  "end",
] as const;
export type SuSessionCommandType = (typeof SU_SESSION_COMMAND_TYPES)[number];

export const SU_SESSION_EVENT_TYPES = [
  "session",
  "lifecycle",
  "command_result",
  "transcript",
  "tool",
  "card",
  "backend",
  "error",
] as const;
export type SuSessionEventType = (typeof SU_SESSION_EVENT_TYPES)[number];

/**
 * Capability keys every backend must declare. Because `SuSessionCapabilities`
 * types `features` as a TOTAL record over this union, adding a key here is a
 * compile error in every adapter until it declares the key truthfully — which
 * is the mechanism that keeps the published table honest rather than optimistic.
 *
 * Semantics, so an engine attests to the same question the PUI asks:
 * - `tool-events`       tool calls/results surface as structured events.
 * - `interactive-cards` typed owner-input cards reach the PUI.
 * - `reasoning-stream`  assistant reasoning is streamed on the `reasoning` channel.
 * - `usage`             token/cost metadata reaches the client.
 * - `compaction`        the session survives a context compaction / carry.
 * - `approvals`         a tool-permission request is put to the OWNER and their
 *                       decision governs the call — not silently auto-approved.
 * - `context`           the client can read context consumption/headroom for the
 *                       session (what a PUI context gauge would render).
 * - `modes`             the session's operating modes are reported to the client
 *                       and can be changed through this contract.
 */
export const SU_SESSION_FEATURES = [
  "tool-events",
  "interactive-cards",
  "reasoning-stream",
  "usage",
  "compaction",
  "approvals",
  "context",
  "modes",
] as const;
export type SuSessionFeature = (typeof SU_SESSION_FEATURES)[number];

/** JSON-only value carried by tool and error events. */
export type SuSessionJsonValue =
  | null
  | boolean
  | number
  | string
  | SuSessionJsonValue[]
  | { [key: string]: SuSessionJsonValue };

/**
 * Durable identity survives PUI restarts and runtime-process replacement.
 * `agentChatId` binds the contract to the existing agent-chats transport;
 * `advSessionId` plus the backend-native id govern reconciliation/resume.
 */
export interface SuSessionIdentity<
  B extends SuSessionBackend = SuSessionBackend,
> {
  agentChatId: string;
  advSessionId: number;
  backend: B;
  nativeSessionId: string;
  ownerId: string;
  workspaceId: string;
  harnessSlug: string | null;
}

/**
 * Backend-specific metadata that clients may render or use for diagnostics.
 * These shapes deliberately mirror already-shipped native-session handles.
 */
export interface SuSessionBackendExtensionMap {
  claude: {
    configDir: string | null;
    configDirSource: string | null;
  };
  codex: {
    codexHome: string | null;
  };
  omp: {
    agentHome: string | null;
  };
}

export type SuSessionBackendExtension<
  B extends SuSessionBackend = SuSessionBackend,
> = B extends SuSessionBackend
  ? { backend: B } & SuSessionBackendExtensionMap[B]
  : never;

/**
 * `host` means Papercusp supplies the behavior around the native runtime (for
 * example pane focus). There is intentionally no "simulated" value: unsupported
 * backend behavior must remain visible instead of being silently imitated.
 */
export type SuSessionCapabilitySupport =
  | { state: "supported"; implementation: "native" | "host" }
  | { state: "conditional"; implementation: "native" | "host"; reason: string }
  | { state: "unsupported"; reason: string };

export interface SuSessionCapabilities {
  commands: Readonly<Record<SuSessionCommandType, SuSessionCapabilitySupport>>;
  features: Readonly<Record<SuSessionFeature, SuSessionCapabilitySupport>>;
}

export type SuSessionDescriptor<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend
    ? {
        identity: SuSessionIdentity<B>;
        lifecycle: SuSessionLifecycleState;
        /** Increments when a replacement runtime attaches to the same identity. */
        runtimeGeneration: number;
        role: "su";
        model: string | null;
        /** The account that actually served the latest completed native turn. */
        accountServed: string | null;
        accountRoute: string | null;
        carry: "warm" | "cold";
        modes: readonly string[];
        capabilities: SuSessionCapabilities;
        backendExtension: SuSessionBackendExtension<B>;
      }
    : never;

export interface SuSessionCommandBase<
  B extends SuSessionBackend,
  T extends SuSessionCommandType,
> {
  schema: typeof SU_SESSION_SCHEMA;
  protocolVersion: typeof SU_SESSION_PROTOCOL_VERSION;
  type: T;
  commandId: string;
  issuedAt: string;
  target: SuSessionIdentity<B>;
}

export type SuSessionCommandFor<B extends SuSessionBackend> =
  | (SuSessionCommandBase<B, "owner_turn"> & {
      turnId: string;
      content: string;
    })
  | (SuSessionCommandBase<B, "interrupt"> & {
      reason?: string;
    })
  | (SuSessionCommandBase<B, "resume"> & {
      cause: "owner" | "pui-restart" | "runtime-replacement" | "compaction";
    })
  | (SuSessionCommandBase<B, "fork"> & {
      /** Omit to fork from the latest acknowledged sequence. */
      fromSequence?: number;
    })
  | SuSessionCommandBase<B, "focus">
  | (SuSessionCommandBase<B, "end"> & {
      reason?: string;
    });

export type SuSessionCommand<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend ? SuSessionCommandFor<B> : never;

export interface SuSessionEventBase<
  B extends SuSessionBackend,
  T extends SuSessionEventType,
> {
  schema: typeof SU_SESSION_SCHEMA;
  protocolVersion: typeof SU_SESSION_PROTOCOL_VERSION;
  type: T;
  eventId: string;
  /** Strictly increasing within one durable session, including reconnects. */
  sequence: number;
  at: string;
  session: SuSessionIdentity<B>;
}

export interface SuSessionRefusal {
  code: string;
  message: string;
  retryable: boolean;
}

export type SuSessionCommandResultEvent<B extends SuSessionBackend> =
  SuSessionEventBase<B, "command_result"> &
    (
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "accepted";
        }
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "completed";
        }
      | {
          commandId: string;
          commandType: SuSessionCommandType;
          status: "refused";
          refusal: SuSessionRefusal;
        }
    );

export type SuSessionTranscriptEvent<B extends SuSessionBackend> =
  SuSessionEventBase<B, "transcript"> &
    (
      | {
          phase: "started";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
        }
      | {
          phase: "delta";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
          content: string;
        }
      | {
          phase: "completed";
          turnId: string;
          role: "owner" | "assistant" | "system";
          channel: "text" | "reasoning";
          content?: string;
        }
    );

export type SuSessionToolEvent<B extends SuSessionBackend> = SuSessionEventBase<
  B,
  "tool"
> &
  (
    | {
        phase: "started";
        turnId: string;
        callId: string;
        name: string;
        input?: SuSessionJsonValue;
      }
    | {
        phase: "completed";
        turnId: string;
        callId: string;
        name: string;
        output?: SuSessionJsonValue;
        isError: boolean;
      }
  );

export type SuSessionCardEvent<B extends SuSessionBackend> = SuSessionEventBase<
  B,
  "card"
> &
  (
    | {
        phase: "opened";
        turnId: string;
        card: OpenCardSnapshot;
      }
    | {
        phase: "closed";
        turnId: string;
        correlationId: string;
        resolution:
          | "submitted"
          | "declined"
          | "cancelled"
          | "expired"
          | "interrupted";
      }
  );

export type SuSessionEventFor<B extends SuSessionBackend> =
  | (SuSessionEventBase<B, "session"> & {
      descriptor: SuSessionDescriptor<B>;
    })
  | (SuSessionEventBase<B, "lifecycle"> & {
      previousState: SuSessionLifecycleState | null;
      state: SuSessionLifecycleState;
      runtimeGeneration: number;
      reason?: string;
    })
  | SuSessionCommandResultEvent<B>
  | SuSessionTranscriptEvent<B>
  | SuSessionToolEvent<B>
  | SuSessionCardEvent<B>
  | (SuSessionEventBase<B, "backend"> & {
      extension: SuSessionBackendExtension<B>;
    })
  | (SuSessionEventBase<B, "error"> & {
      scope: "session" | "command" | "turn" | "transport";
      code: string;
      message: string;
      recoverable: boolean;
      commandId?: string;
      details?: SuSessionJsonValue;
    });

export type SuSessionEvent<B extends SuSessionBackend = SuSessionBackend> =
  B extends SuSessionBackend ? SuSessionEventFor<B> : never;

export function isSuSessionBackend(value: string): value is SuSessionBackend {
  return (SU_SESSION_BACKENDS as readonly string[]).includes(value);
}

export function isSuSessionLifecycleState(
  value: string,
): value is SuSessionLifecycleState {
  return (SU_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isSuSessionCommandType(
  value: string,
): value is SuSessionCommandType {
  return (SU_SESSION_COMMAND_TYPES as readonly string[]).includes(value);
}

export function isSuSessionEventType(
  value: string,
): value is SuSessionEventType {
  return (SU_SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Use in switch defaults so a new union member strands every incomplete handler. */
export function assertNeverSuSession(value: never): never {
  throw new Error(
    `Unhandled SU-session contract member: ${JSON.stringify(value)}`,
  );
}
