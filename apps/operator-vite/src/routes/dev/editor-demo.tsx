import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../lib/require-flag';
import EditorDemoPage from '@/app/editor-demo/page';

/**
 * /dev/editor-demo — multi-editor markdown demo. Translated from
 * `apps/operator/app/editor-demo/page.tsx`. Page uses `next/dynamic` for
 * 11 editor panes with `loading:` fallbacks — alias shim maps to
 * `React.lazy` + Suspense (loading callback becomes the Suspense fallback).
 *
 * Demoted under /dev + gated behind FLAGS.TESTING (design-simplification P-013):
 * a lab surface — a closed (notFound) gate in default production, open when the
 * testing flag is on.
 */
export const Route = createFileRoute('/dev/editor-demo')({
  beforeLoad: () => requireFlag(FLAGS.TESTING),
  component: EditorDemoPage,
});
