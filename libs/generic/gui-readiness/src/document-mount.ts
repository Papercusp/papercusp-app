/**
 * Classify "is the right screen mounted?" from a sequence of webview document
 * observations — level-triggered, like everything else in this library.
 *
 * WHY THIS IS NOT JUST `waitUntilReady`. A readiness barrier answers one
 * question: ready yet, y/n. A UI mount wait has to answer three, because two
 * distinct states are NOT "not ready yet" — they are TERMINAL, and waiting on
 * them is pure waste:
 *
 *   1. mounted            — the target screen is up.
 *   2. still coming up    — keep waiting; this is the only legitimate wait.
 *   3. wrong screen       — the app settled somewhere that will never become the
 *                           target on its own (a first-run/login/setup landing).
 *   4. document destroyed — the app rendered, and then the webview died under us.
 *
 * Collapsing 3 or 4 into 2 is not a cosmetic mistake. It converts a decisive,
 * instantly-diagnosable failure into a timeout, and a timeout carries none of
 * the evidence that made it decisive. Worse, states 3 and 4 both tend to
 * SATISFY whatever the caller was about to measure — a first-run screen does
 * little, so it is fast and quiet; a dead document does nothing at all, so it is
 * faster and quieter still. A suite that cannot name them will happily publish
 * their numbers as if they described the real app.
 *
 * WHY `documentDestroyed` NEEDED ITS OWN NAME (observed 2026-07-28). A packaged
 * desktop app mounted its UI, held it for ~10s, and was then replaced by a blank
 * document at the SAME url which persisted until the suite's budget expired.
 * With no name for that state the wait read it as "still booting" and waited out
 * its entire timeout on a webview that was already gone — every run, in four
 * specs at once. The signature is precise and cannot be confused with a slow
 * boot, which is what makes it worth detecting rather than guessing at:
 *
 *   - we must ALREADY have seen a document render (so: not "hasn't started"),
 *   - the document IDENTITY must have changed (so: not "the app re-rendered"),
 *   - and the replacement must have no root container AT ALL (so: not a route
 *     change — every route of a single-page app renders into the same root).
 *
 * `docToken` is what makes the middle condition decidable. It is a value the
 * caller mints into the document on first read and which dies with the document,
 * so a CHANGE in it is definitive evidence of replacement. Inferring the same
 * thing from "resource timing went back to zero" is not equivalent: that cannot
 * distinguish a replaced document from a webview that never records resource
 * timing in the first place — which some custom-protocol embeddings genuinely
 * do not.
 */

/** One level-triggered look at the document. */
export interface DocumentObservation {
  /** Route path, for the wrong-screen predicate. */
  pathname: string;
  /**
   * Identity of THIS document: minted on first read, dies with the document.
   * A change means the document was REPLACED, definitively.
   */
  docToken: string;
  /**
   * Child count of the app's root container; **`-1` when the container is
   * absent entirely**. The distinction is load-bearing — "present but empty"
   * is a normal pre-render frame, while "absent" cannot happen in a document
   * the app itself rendered.
   */
  rootChildren: number;
  /** Does the marker proving THIS IS THE TARGET SCREEN resolve right now? */
  targetPresent: boolean;
}

export interface MountClassifierConfig {
  /**
   * Is this path a screen that will never become the target on its own?
   * Domain-supplied on purpose: only the caller knows its own routes.
   */
  isTerminalWrongScreen: (pathname: string) => boolean;
  /**
   * How long a wrong-screen landing must persist before it is called terminal.
   * Exists solely so a redirect observed mid-flight cannot trip the abort.
   */
  wrongScreenDwellMs: number;
  /** How long a destroyed document must persist before the webview is called dead. */
  documentDeathDwellMs: number;
}

/** Carried between observations. Treat as opaque; never construct by hand. */
export interface MountProgress {
  /** Identity of the first document observed to have rendered anything. */
  renderedDocToken: string | null;
  wrongScreenSince: number | null;
  documentDeathSince: number | null;
}

export const INITIAL_MOUNT_PROGRESS: Readonly<MountProgress> = Object.freeze({
  renderedDocToken: null,
  wrongScreenSince: null,
  documentDeathSince: null,
});

export type MountVerdict = 'mounted' | 'waiting' | 'wrongScreen' | 'documentDestroyed';

/**
 * Decide what one observation means, given everything seen so far.
 *
 * Pure: no clock, no I/O. `now` is a parameter so every dwell branch is
 * reachable from a test — a settle budget whose clock it cannot control is a
 * branch nothing ever exercises.
 */
export function classifyMountObservation(
  state: Readonly<MountProgress>,
  observation: DocumentObservation,
  now: number,
  config: MountClassifierConfig,
): { state: MountProgress; verdict: MountVerdict } {
  const next: MountProgress = { ...state };

  // Remember the first document that rendered anything. This is what later lets
  // us distinguish "died" from "never started" — without it, an empty document
  // at the start of a boot and an empty document after a crash are identical.
  if (observation.rootChildren > 0 && next.renderedDocToken === null) {
    next.renderedDocToken = observation.docToken;
  }

  // Success outranks every failure reading: a target that is present right now
  // is mounted regardless of what any earlier observation looked like.
  if (observation.targetPresent && observation.rootChildren > 0) {
    return { state: next, verdict: 'mounted' };
  }

  const replaced =
    next.renderedDocToken !== null && observation.docToken !== next.renderedDocToken;
  if (replaced && observation.rootChildren === -1) {
    next.documentDeathSince ??= now;
    if (now - next.documentDeathSince >= config.documentDeathDwellMs) {
      return { state: next, verdict: 'documentDestroyed' };
    }
  } else {
    next.documentDeathSince = null;
  }

  if (config.isTerminalWrongScreen(observation.pathname)) {
    next.wrongScreenSince ??= now;
    if (now - next.wrongScreenSince >= config.wrongScreenDwellMs) {
      return { state: next, verdict: 'wrongScreen' };
    }
  } else {
    next.wrongScreenSince = null;
  }

  return { state: next, verdict: 'waiting' };
}
