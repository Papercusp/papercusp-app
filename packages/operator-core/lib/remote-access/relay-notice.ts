/**
 * The Papercusp relay notice (external-app-access D-009) — the one source of its words. The
 * machine shows it before the user may start linking (relay-opt-in.ts), and the portal shows it on
 * the approval page for a relay link (endpoint-route/routes/hosted-cli). A leaf module so the
 * portal route does not load the machine-side connector to read two constants.
 *
 * Change the words → bump the version, and everyone agrees again (R-20).
 */
export const PORTAL_RELAY_NOTICE_VERSION = 1;
export const PORTAL_RELAY_NOTICE =
  "When the Papercusp relay is on, calls from outside apps pass through Papercusp's servers on their way to this computer. " +
  'Papercusp can read those calls and their results while they pass through, and does not store them. ' +
  "If you don't want that, use your own tunnel instead.";
