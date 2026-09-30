/**
 * A minimal, hand-driven `EventSource` stand-in for tests of the staleness
 * ladder. TEST-ONLY — never imported by app code.
 *
 * WHY IT IS A FAKE AND NOT A MOCK OF THE TRANSPORT: there is no `EventSource`
 * in the Node/jsdom test env, and the network is not where any of these bugs
 * lived. Faking at THIS seam — the browser primitive — keeps everything that
 * decides the outcome real: the real `createResilientEventSource` wrapper, its
 * real zombie watchdog at its real default timeout, and the real `signal()`
 * wiring that feeds both that watchdog and the pane's own silence timer. Mock
 * the wrapper instead and you delete the very interaction under test.
 *
 * Shared by `stream-freshness.ladder.test.ts` (does the transport reach the
 * 'stale' rung at all?) and `AgentThinkingStream.staleness.test.tsx` (does the
 * hook RE-RENDER when it does?) so both drive one identical fake.
 */

interface FakeListenerEntry { type: string; fn: (ev: unknown) => void; }

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners: FakeListenerEntry[] = [];
  closed = false;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) { this.listeners.push({ type, fn }); }
  removeEventListener() { /* not exercised */ }
  close() { this.closed = true; this.readyState = 2; }

  fire(type: string, data: unknown = '') {
    for (const e of this.listeners) if (e.type === type) e.fn({ data, type });
  }
  fireOpen() { this.readyState = 1; this.fire('open'); }
}

/** The most recently constructed instance — a reconnect makes a NEW one, so
 *  driving `instances[0]` after a backoff silently drives a dead socket. */
export const latestEventSource = () =>
  FakeEventSource.instances[FakeEventSource.instances.length - 1];
