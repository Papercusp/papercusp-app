/**
 * Pure cron next-fire computation for the routines engine. Kept separate from
 * `lib/dbos/routines-workflow.ts` so it's unit-testable without that module's
 * DBOS registration side-effects.
 *
 * Format: standard 5- or 6-field crontab (DBOS itself speaks crontab natively,
 * and `routines.trigger_config.cron` stores the same). If we ever need
 * calendar-grade recurrence (nth-weekday, until-dates) we'd add an `rrule` branch
 * here — the engine only depends on this `(cron, from) -> Date | null` contract
 * (git-sync-auto-commit D-006).
 */
// cron-parser is CJS; its `parseExpression` named export isn't statically visible
// to ESM named-import LINKING (cjs-module-lexer) under tsx now that operator-core
// is `"type": "module"`, so `import { parseExpression }` fails to link. A default
// import resolves module.exports (which carries parseExpression) at runtime — and,
// unlike a renamed `createRequire`, stays statically inlinable by the desktop
// sidecar's esbuild bundle.
import cronParser from 'cron-parser';

/** Next fire at-or-after `from` for a cron expression, or null if unparseable.
 *
 * Guards empty/blank input explicitly: `cron-parser` parses `''` as all-wildcards
 * ("every minute") rather than erroring, which would silently fire a misconfigured
 * routine every minute — so a blank expression is treated as invalid (null). */
export function computeNextFireAt(cronExpr: string, from: Date): Date | null {
  if (!cronExpr || !cronExpr.trim()) return null;
  try {
    return cronParser.parseExpression(cronExpr, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}
