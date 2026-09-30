'use client';

/**
 * MOVED to `@papercusp/operator-ui/papercup-chat/message-timestamp`
 * (papercup-chat-one-component-one-contract-2026-09-06 P-007; parity row
 * `op-timestamps`). The clock, the pure `formatMessageStamp` and the stamp
 * component live there now — ONE clock for every mounted stamp, whichever
 * surface mounts it. This module is the operator's historical import surface:
 * it re-exports the implementation and pins the operator's legacy class names
 * (`oracle-msg-time`, styled in globals.css) onto the shared stamp for the
 * operator host's existing CSS vocabulary.
 */
import {
  MessageTimestamp as SharedMessageTimestamp,
  type MessageTimestampProps,
} from '@papercusp/operator-ui/papercup-chat/message-timestamp';

export {
  CHAT_CLOCK_TICK_MS,
  formatMessageStamp,
  useChatClock,
  type MessageStamp,
} from '@papercusp/operator-ui/papercup-chat/message-timestamp';

export function MessageTimestamp({ ts }: Pick<MessageTimestampProps, 'ts'>) {
  return <SharedMessageTimestamp ts={ts} className="oracle-msg-time" />;
}
