/**
 * MOVED to `@papercusp/operator-ui/papercup-chat/chat-ref-popup-params`
 * (WI-10001509): the portal writes `wpop`/`wppop` too, and it reaches this
 * chat only through that package. This module is the operator's historical
 * import surface and re-exports the one implementation — two copies of the
 * grammar would drift, and a writer disagreeing with the reader about it is an
 * invisible dead click (the WI-6601 failure mode).
 */
export {
  CHAT_WORK_ITEM_POPUP_PARAM,
  CHAT_PLAN_POPUP_PARAM,
  encodeScopedRef,
  decodeScopedRef,
  workRefPopupTarget,
  canOpenWorkRef,
  type ChatWorkRef,
  type ChatRefPopupTarget,
} from '@papercusp/operator-ui/papercup-chat/chat-ref-popup-params';
