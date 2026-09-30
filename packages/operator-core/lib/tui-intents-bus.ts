/**
 * tui_intents observer (agent-tool-delta-protocol-2026-06-22, Lane D / P-010) — the
 * TUI analogue of {@link onUiIntent}. `tui:dispatch` INSERTs a pending
 * `harness_shared.tui_intents` row and fires `NOTIFY tui_intents <client_id>`; this
 * bus wakes the /api/tui/intents/stream route, replacing its old 250ms poll. A thin
 * instance of the shared {@link createNotifyBus}.
 */
import { createNotifyBus } from "./pg-notify-bus";

const bus = createNotifyBus("tui_intents", "tui-intents-bus");

/** Register a wake handler invoked with the notified client_id. Returns unsubscribe. */
export const onTuiIntent = (handler: (clientId: string) => void): (() => void) => bus.subscribe(handler);
export const _stopForTests = (): Promise<void> => bus._stopForTests();
