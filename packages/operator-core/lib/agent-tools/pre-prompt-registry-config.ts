/**
 * The curated pre-prompt registry list (plan `token-efficient-agent-io-2026-06-06`,
 * P-002 / D-008). This is the HOST configuration of the domain-free registry in
 * `@papercusp/result-encoding` — the one governed place that decides which tools
 * get prompt-declared column schemas (and thus the Tier-3 read / positional write
 * paths). Imported as a side-effect at startup (see agent-tools/index.ts).
 *
 * Telemetry basis (D-008 — derived, not hand-guessed). From
 * `harness_shared.tool_invocations` over the trailing 21 days (~268k calls), the
 * hot tools by call count are:
 *
 *   coord:inbox 80.8k · activity:recent 50k · activity:report 28.7k ·
 *   plans:list 26k · locks:acquire/release/queue ~13-15k each ·
 *   plans:attention 9.6k · plans:get/items ~2.2k · plans:set-status 1.5k ·
 *   coord:declare-intent 1k · coord:send 0.9k · coord:presence 0.38k ·
 *   harness:list 0.32k
 *
 * The breakeven gate (a tool earns its prompt space when called > ~1×/session)
 * is comfortably cleared by every tool above. BUT Tier-3 read only activates when
 * a tool's `data` is a flat scalar array (columns derivable) AND positional write
 * only when the args fit the bounded shape (scalars/enums/ids + ≤1 trailing
 * free-text, no arrays). Most hot reads don't qualify *yet*:
 *
 *   - coord:inbox / coord:presence / locks:queue — `data` is a nested object
 *     ({summary, entries[]} / {active, stale} / {active_locks, waiting}), not a
 *     flat array. (coord injection has its own push-side plan,
 *     `token-efficient-coord-injection`.)
 *   - plans:list / plans:items — array rows carry a nested field (itemCounts /
 *     the ResolvedItem object), so not CSV-flat.
 *   - activity:recent — flat-ish but carries a `detail: unknown` column; the
 *     runtime flatness check downgrades to TOON whenever detail is an object.
 *   - locks:acquire / coord:send / coord:declare-intent — write args carry
 *     ARRAYS (paths/to/current_files) → not positional-shaped.
 *   - plans:set-status — has a non-last free-text column (`note` before
 *     `rationale`) → correctly rejected by the positional projection.
 *
 * So v1 activates the clean, correct cases and lists them here; the larger-win
 * tools activate as their output `data` is flattened / restructured (tracked by
 * the sibling read plans). Note the read side is already compact (the
 * tool-result-formats plan defaults every tool to TOON); Tier-3 CSV is an
 * incremental read win, while the positional WRITE path is the larger one
 * (output tokens cost ~4-5× input).
 */

import { configurePrePromptRegistry, type ColumnOverride, type PrePromptEntry } from '@papercusp/result-encoding';
import { WORK_ITEM_ID_PATTERN } from '../work-items';

/**
 * EI-7927 (D-007 residual): the misalignment guard's per-column checks (id
 * pattern / enum membership) only fire when the tool's OWN Zod schema carries
 * them — but the positional `id` on `work_items:claim` is a loose string
 * accepting several id-family prefixes, so the schema alone can't express
 * the constraint. `columnOverrides` supplies it out of band.
 * This is used by the one remaining positional work-item write
 * (`claim`). `work_items:set_state` is intentionally keyed-only: its terminal
 * branch requires completionRef + assumptions, which cannot be represented by
 * the bounded `{row}` CSV projection.
 */
const WORK_ITEM_ID_OVERRIDE: ColumnOverride = { pattern: WORK_ITEM_ID_PATTERN };

export const PRE_PROMPT_REGISTRY: PrePromptEntry[] = [
  // ── Read (self-describing TOON) ───────────────────────────────────────────
  // audit:list — summary mode returns exactly {id,ts,actor,action,subject}
  // (declared, flat); `detail:'full'` adds a nested field. Shape-eligible for
  // Tier-3 headerless CSV, but deliberately served as TOON.
  //
  // EI-136 (measured, 2026-06-08; re-verified 2026-08-03): with the headerless
  // form, sonnet-4-6 COLUMN-SHIFT-MISREADS this result ~1/3 of runs (2 pass / 1
  // fail over 3, groundedness variance 1.89) — naming a decoy actor from an
  // adjacent row. The mechanism is distance: the reader must map 5 bare
  // positions to a column order held THOUSANDS of tokens away in the prompt's
  // "## Wire schemas" legend. TOON carries `fields[5]: …` + `rows[N]{…}:`
  // adjacent to the data, so the mapping is local and no legend lookup happens.
  //
  // Why this is the cheap fix rather than a format-design project: TOON already
  // ships fleet-wide as the default compact encoding (every non-registry list
  // tool uses it), so this is a re-route at an existing, already-benchmarked
  // renderer — not a new format. The self-description tax is ~68 chars (~20
  // tokens) ONCE PER RESULT regardless of row count (~1% on a 50-row read,
  // which is what Tier-3 targets), against a ~1/3 misattribution rate on the
  // single read tool in this registry.
  //
  // `read:'toon'` (not `'off'`) keeps the tool governed by this registry and
  // states the encoding explicitly; `tryTier3Read` returns null for it and the
  // generic compact path picks TOON (serialize-result.ts:209). It also
  // suppresses the now-redundant read-column legend — declaring positional
  // columns for a self-describing payload is dead prompt weight AND actively
  // misleading (it instructs a position→column mapping the wire no longer
  // needs). See renderWireSchemasSection, which emits read columns only for the
  // positional formats.
  //
  // Reverting to 'csv' re-arms the measured misread — do not flip it back
  // without a gym A/B (S08-compact-read) showing the read accuracy is fine.
  { name: 'audit:list', read: 'toon', note: 'flat audit rows; ~hot on investigation; TOON not CSV per EI-136 read-accuracy' },

  // ── Write (positional-CSV args) — only fixed-shape writes ────────────────
  // `work_items:set_state` is deliberately absent. Its real schema has
  // conditional terminal evidence (`completionRef` + `assumptions`) and bulk
  // array/object fields, so advertising a `{row}` member teaches a call shape
  // that cannot close terminal work-items. The keyed schema remains the sole
  // advertised contract and preserves the full lifecycle union.
  {
    name: 'work_items:claim',
    read: 'off',
    write: 'positional',
    note: 'positional live 2026-07-06 — S07 gate passed (cols id,assignee?,harness?,force?,reason?); takeover fields retained for audited force claims; columnOverrides hardened EI-7927; keyed bulk fallback preserved by WI-3260',
    writeColumnNames: ['id', 'assignee', 'harness', 'force', 'reason'],
    writeRequiredColumnNames: ['id'],
    writeKeyedFallback: true,
    columnOverrides: { id: WORK_ITEM_ID_OVERRIDE },
  },
];

configurePrePromptRegistry(PRE_PROMPT_REGISTRY);
