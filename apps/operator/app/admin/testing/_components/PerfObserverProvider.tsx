'use client';

import { useEffect } from 'react';
import { startRecorder } from '../_lib/vitals-recorder';

/**
 * Mounts the global perf recorder once per browser session.
 * Imported by the root layout — registers PerformanceObservers for
 * interaction/longtask/layout-shift, console.error monkey-patch, and
 * window error/unhandledrejection listeners.
 *
 * Idempotent — repeated mounts are no-ops.
 */
export default function PerfObserverProvider() {
  useEffect(() => {
    startRecorder();
  }, []);
  return null;
}
