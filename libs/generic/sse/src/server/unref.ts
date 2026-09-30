/**
 * Release the event loop's hold on a timer where the runtime supports it.
 *
 * This package compiles against DOM lib typings (timers are `number`) but
 * runs on Node too (timers are `Timeout` with `.unref()`), so the handle is
 * probed structurally rather than typed as either.
 */
export function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}
