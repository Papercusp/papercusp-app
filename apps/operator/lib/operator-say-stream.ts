/**
 * Incrementally exposes user-visible text from the operator's `<say>` envelope.
 *
 * The converse stream also carries control tags (`<sleep>`, `<continue/>`, …),
 * so rendering raw SSE deltas would leak protocol text into the chat. This
 * projector stays silent until it has seen a complete `<say>` opener, emits
 * only its body, and withholds any suffix that could be a split `</say>` tag.
 * The completed turn still goes through parseOperatorTurn; this is only the
 * low-latency visual projection while that canonical parse is in flight.
 */

// One implementation for the desktop and portal host boundaries.
export { SayStreamProjector as OperatorSayStreamProjector } from '@papercusp/chat-protocol';
