/**
 * Logging — mirrors bash `log()` which prints `[ISO_TIMESTAMP] message`
 * to stdout AND tees to `<stateDir>/logs/run.log`.
 *
 * Both bash and TS orchestrators write to the same log file so the harness
 * UI's log tail keeps working when toggling between implementations.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Logger {
  log(message: string): void;
  /** Write event marker to <stateDir>/events/<eventName>.log (append). */
  notifyEvent(eventName: string, body?: string): void;
}

export function createLogger(stateDir: string): Logger {
  const logDir = join(stateDir, 'logs');
  const eventsDir = join(stateDir, 'events');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const runLog = join(logDir, 'run.log');

  const log = (message: string): void => {
    const ts = new Date().toISOString();
    // Bash uses `date -Iseconds` which formats with timezone, e.g.
    // 2026-04-26T22:53:11-04:00. Node's toISOString is always UTC with Z.
    // The harness UI parses both — we keep UTC for portability.
    const line = `[${ts}] ${message}\n`;
    process.stdout.write(line);
    appendFileSync(runLog, line);
  };

  const notifyEvent = (eventName: string, body = ''): void => {
    if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
    const eventFile = join(eventsDir, `${eventName}.log`);
    const ts = new Date().toISOString();
    appendFileSync(eventFile, `[${ts}] ${body}\n`);
    log(`EVENT ${eventName}${body ? `: ${body}` : ''}`);
  };

  return { log, notifyEvent };
}
