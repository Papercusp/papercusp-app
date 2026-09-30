/**
 * ui_intents observer (agent-tool-delta-protocol-2026-06-22, Lane D / P-010).
 *
 * `ui:dispatch` INSERTs a pending `harness_shared.ui_intents` row and fires
 * `NOTIFY ui_intents <client_id>`; this bus wakes the /api/ui/intents/stream route
 * (which drains by its own client_id cursor), replacing the route's old 250ms poll.
 * A thin instance of the shared {@link createNotifyBus}.
 */
import { createNotifyBus } from "./pg-notify-bus";

const bus = createNotifyBus("ui_intents", "ui-intents-bus");

/** Register a wake handler invoked with the notified client_id. Returns unsubscribe. */
export const onUiIntent = (handler: (clientId: string) => void): (() => void) => bus.subscribe(handler);
export const _stopForTests = (): Promise<void> => bus._stopForTests();
