/**
 * (WI-39599) Fixture: a packaged sidecar, in the two shapes under comparison.
 *
 * Both shapes carry the pre-fix serve.ts fault handler — the one that reports by
 * writing to stderr. GUARD=1 additionally installs the real stdio peer guard.
 * The ONLY difference between the two children is that install, so a CPU delta
 * between them after their shared parent is SIGKILLed is attributable to it and
 * to nothing else.
 *
 * Driven by lib/process-supervision/stdio-peer-guard.integration.test.ts.
 */
import { createServer } from 'node:net';
import { installStdioPeerGuard } from '../lib/process-supervision/stdio-peer-guard';

if (process.env.GUARD === '1') installStdioPeerGuard();

// The shape that amplifies: diagnose the fault by writing to the stream that is
// about to be (or already is) broken.
process.on('uncaughtException', (err) => {
  console.error(
    '[fixture] non-fatal uncaughtException in a detached boot/background task (continuing boot):',
    (err as Error)?.message,
  );
});

// A listening handle, as a real sidecar has — it keeps the process alive and
// keeps the event loop registered with libuv.
const server = createServer(() => {});
server.listen(0, '127.0.0.1');

// Ordinary periodic output, which is what first discovers the broken pipe.
// A self-rescheduling setTimeout rather than setInterval: recurring timers in
// this repo belong to the scheduler layer (lint:no-raw-setinterval), and a
// fixture has no business declaring one.
const beat = (): void => {
  console.log('[fixture] heartbeat');
  setTimeout(beat, 250).unref?.();
};
setTimeout(beat, 250);

// Keep the process alive for the whole measurement window even if the server
// handle is ever closed under us.
setTimeout(() => process.exit(0), 600_000);
