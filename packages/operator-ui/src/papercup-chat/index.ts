/**
 * `@papercusp/operator-ui/papercup-chat` — the one Papercup chat, as a
 * component (`PapercupChat`) over a host-free transport hook (`usePapercupChat`).
 * Plan papercup-chat-one-component-one-contract-2026-09-06, D-003 / D-005 / D-008.
 *
 * A host does four things:
 *   1. write a `PapercupChatAdapter` (sendTurn / answerCard / loadHistory)
 *   2. `const chat = usePapercupChat({ adapter, conversationId })`
 *   3. inject `PAPERCUP_CHAT_CSS` once (and theme via `--pc-chat-*` variables)
 *   4. `<PapercupChat chat={chat} hostTrust="owner" | "public" … />`
 */
export {
  PapercupChat,
  ChatMarkdown,
  askTranscriptPlaceholder,
  askCapabilityNoticeText,
  lookedAtTools,
  papercupChatUrlTransform,
  withHardBreaks,
  CHAT_LINK_PROTOCOLS,
  type PapercupChatProps,
  type PapercupChatHostTrust,
  type ChatMarkdownProps,
  type AskTranscriptPlaceholder,
} from './PapercupChat';
export {
  usePapercupChat,
  reduceAskFrame,
  parsePapercupFrame,
  askTurnRefusalState,
  askErrorMessage,
  askCompletedTurn,
  askRetryTarget,
  askChoiceArgsFromToolCall,
  ChatTurnRefusedError,
  ASK_CAPABILITY_CONTRACT,
  ASK_CHOICE_TOOL,
  EMPTY_TURN,
  CHAT_TURN_FAILED,
  CHAT_TRANSPORT_FAILED,
  CHAT_TURN_ABORTED,
  type PapercupChatAdapter,
  type PapercupChatController,
  type PapercupChatFrame,
  type PapercupChatErrorFrame,
  type UsePapercupChatOptions,
  type SendTurnOptions,
  type PersistedCardAnswer,
  type SurfaceError,
  type AskTurnState,
  type AskProvenance,
  type AskFailureContext,
  type AskRetryTarget,
  type AskCapabilityContract,
  type AskChoiceToolInput,
} from './use-papercup-chat';
export { PAPERCUP_CHAT_CSS } from './papercup-chat.styles';
export { MessageTimestamp, formatMessageStamp, formatAge, useChatClock, CHAT_CLOCK_TICK_MS, type MessageStamp, type MessageTimestampProps } from './message-timestamp';
export { HydratedWorkRefPill, type HydratedWorkRefPillProps } from './HydratedWorkRefPill';
export { WorkRefPill, type WorkRefPillProps, type WorkRefState } from './WorkRefPill';
export { remarkWorkRefs, type WorkRefPillNode } from './remark-work-refs';
export { parseWorkRefs, type WorkRefKind, type WorkRefMatch } from './parse-work-refs';
export {
  CHAT_WORK_ITEM_POPUP_PARAM,
  CHAT_PLAN_POPUP_PARAM,
  encodeScopedRef,
  decodeScopedRef,
  workRefPopupTarget,
  type ChatWorkRef,
  type ChatRefPopupTarget,
} from './chat-ref-popup-params';
