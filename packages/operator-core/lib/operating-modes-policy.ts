/**
 * operating-modes-policy.ts — the KERNEL half of the operating modes, spliced into every
 * su render at `AUTO_MODE_MARKER` (`<!-- PAPERCUSP-SU:AUTO-MODE -->`).
 *
 * identities-v1-2026-08-30 P-021 (D-008 as amended 2026-09-03). A mode is three things fused
 * together — STATE, DEFINITION, AUTHORITY — and only two of them belong in the kernel:
 *
 *   - STATE: whether AUTO / IDEATE / DRAIN / AUDIT is on for THIS session right now lives in
 *     `harness_shared.agent_modes` (`mode:set` writes it; the ⟦CTRL⟧ anchor projects it);
 *     this section teaches how a flip is REGISTERED and what the registry's implication
 *     table does on the write (DRAIN ⇒ AUTO, GOAL ⇒ AUTO + IDEATE — DERIVED from
 *     `modes/registry.ts`, never restated).
 *   - AUTHORITY: what a mode suspends or permits is COMPUTED from the registry by
 *     `instruction-lint.ts` (the `⟦INSTRUCTION-PRECEDENCE⟧` verdict) and ENFORCED at the
 *     dispatch chokepoint (`audit-mode-guard.ts`); no prose — a definition's least of all —
 *     can widen it.
 *   - DEFINITION: the long-form operating clause of each mode is an IDENTITY on its own
 *     exclusive axis slot — `su.mode-auto` (autonomy), `su.mode-ideate` (ideation),
 *     `su.mode-drain` (objective), `su.mode-audit` (audit); `mode-identities.ts` in the
 *     orchestrator — rendered in the `modes` layer of the composed su stack ONLY while the
 *     mode is on: bound into the first render by `suSessionBinding({ modes })`, attached
 *     live by the ⟦stack⟧ channel on the turn after `mode:set` (detached — VOID — on exit).
 *
 * Until P-021 this module rendered all four definitions (28,428 B of prose, 33,951 B of
 * module) into EVERY su render with no is-this-mode-active condition; the `fleet` tier's
 * compact AUTO variant was the only branch. Both tiers now render this same kernel stub —
 * the fleet member's autonomy document is bound because the launch registers `auto`, not
 * because the tier says so. The marker keeps its historical name: it is a contract shared
 * by both base playbooks, the blueprint persona and build artifacts.
 *
 * `AUDIENCE` is the fifth axis (engineer-mode / novice-mode for the chat roles) and is
 * bound per conversation by `loadRoleModePersona`, not by `mode:set`; it is named here only
 * so the vocabulary is complete.
 */
import { SU_MODE_DOCUMENTS } from '@papercusp/orchestrator/blueprint';
import { MODES, modeIndexMarkdown, resolveImpliedModes } from './modes/registry';

/** The registry's implication table, as prose — one line per mode that implies others. */
export function renderModeImplicationTable(): string {
  const rows = MODES.filter((m) => (m.implies ?? []).length > 0).map((m) => {
    const closure = resolveImpliedModes(m.id);
    return `\`${m.id}\` ⇒ ${closure.map((x) => `\`${x}\``).join(' + ')}`;
  });
  return rows.length ? rows.join(' · ') : '(none)';
}

/** The axis ← mode map, derived from the orchestrator's mode identities. */
export function renderModeAxisMap(): string {
  return SU_MODE_DOCUMENTS.map((d) => `\`${d.slot}\` ← ${d.modes.map((m) => `\`${m}\``).join(' / ')} (\`${d.id}\`)`).join(' · ');
}

/**
 * The kernel modes section. The `tier` argument is kept for the call sites (P-017 threaded
 * it through every su render); both tiers render the same stub since P-021 — the tier no
 * longer decides which definitions ride along, the registry state does.
 */
export function renderModesPolicy(_tier: 'full' | 'fleet' = 'full'): string {
  const withDocs = new Set(SU_MODE_DOCUMENTS.flatMap((d) => [...d.modes]));
  const contractOnly = MODES.map((m) => m.id).filter((id) => !withDocs.has(id));
  return `## Operating modes — state in the registry, definitions as identity layers

A MODE is three things (D-008): its STATE, its DEFINITION, and its AUTHORITY. Only the
state and the authority are kernel; the definition arrives as an identity layer while the
mode is ON.

- **Register the flip THE MOMENT the owner says it.** "AUTO mode" / "run autonomously" /
  "just keep going" ⇒ \`mode:set { mode:'auto', reason, ownerDirected:true }\`; "ideate mode" /
  "think bigger" ⇒ \`ideate\`; "drain the queue" / "clear the backlog" ⇒ \`drain\`; "audit this
  program" ⇒ \`audit\` (scope in \`instructions\`). \`{ enabled:false }\` exits; \`mode:get\` reads
  anyone's. A mode honoured from directive text alone is INVISIBLE state — peers and the
  leader read the REGISTRY, and a compaction or cold successor silently drops it. On a psu
  Claude/Codex session the UserPromptSubmit provenance hook registers an OWNER-typed flip for
  you and stamps a \`⟦mode⟧\` line into your context; register yourself only when that line is
  absent or reports a failure (a duplicate \`mode:set\` is a harmless upsert).
- **Same-axis modes exclude each other; cross-axis modes stack.** \`auto\` ↔ \`cold-auto\` is one
  dial; \`auto + ideate\` is the canonical pair. The IMPLICATION TABLE is kernel and is applied
  by the registry write itself — you never remember a follow-up call: ${renderModeImplicationTable()}.
- **Authority is COMPUTED from the registry, never from prose.** The \`⟦INSTRUCTION-PRECEDENCE⟧\`
  verdict every bootstrap carries (execution-authorization · mission · ideation) is derived
  from your registered modes by instruction-lint and ENFORCED at the dispatch chokepoint
  (AUDIT's read-only-toward-subject rail included). No section of your context — a mode's
  own definition least of all — grants one byte more than the registry does.
- **Each ACTIVE mode's DEFINITION is an identity layer on its axis slot** — ${renderModeAxisMap()} —
  bound into your launch render when the mode is set at launch, and attached live by a
  \`⟦stack⟧\` payload on the turn after \`mode:set\` (detached and VOIDED when the mode exits).
  Nothing of a definition is in your context while its mode is off. Modes without a
  definition document (${contractOnly.map((id) => `\`${id}\``).join(', ')}) deliver their registry
  contract through \`mode:set\` / \`coord:orient\` alone. The \`audience\` axis (engineer-mode /
  novice-mode) is bound per conversation for the chat roles, not by \`mode:set\`.

${modeIndexMarkdown()}`;
}
