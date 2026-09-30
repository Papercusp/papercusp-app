/**
 * Splice the per-client tooling overlay into a base SU playbook at the
 * CLIENT-TOOLING-OVERLAY marker.
 *
 * The base playbook (papercusp-su-<profile>.tools.md) is NOT complete on its
 * own — it carries a `<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->` marker
 * where the client-specific task/workflow tooling section belongs. Shipping
 * the base RAW leaks the literal marker comment with no tooling section (the
 * 2026-05-30 marker-split regression). Every TS path that ships a playbook
 * MUST splice first:
 *   - desktop-install/papercusp-files.ts  → ~/.papercusp/engineer-collaborator.md
 *   - endpoint-route/routes/misc/agent-bundle.ts → the power-user OMP bundle
 * (The bash installer, install-standalone-mcp.sh `render_playbook`, implements
 * the same contract for the shell path.)
 */
export const CLIENT_TOOLING_OVERLAY_MARKER =
  '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';

/**
 * Marker for the generated "## Wire schemas" legend (token-efficient-agent-io
 * P-003) — the prompt-declared column schemas for the pre-prompt registry tools.
 * Spliced by `renderSuPlaybook` from `renderWireSchemasSection()`. Same splice
 * contract as the tooling overlay: an absent marker means the section is simply
 * appended; an empty section removes the marker (never shipped literally).
 */
export const WIRE_SCHEMAS_MARKER = '<!-- PAPERCUSP-SU:WIRE-SCHEMAS -->';

/**
 * Marker for the generated coord-injection legend (token-efficient-coord-injection
 * P-007) — the positional `[coord+N]` grammar + glyph key + the relocated footer,
 * declared ONCE per session. Spliced by `renderSuPlaybook` from
 * `renderCoordLegend()`. Same splice contract as the others.
 */
export const COORD_LEGEND_MARKER = '<!-- PAPERCUSP-SU:COORD-LEGEND -->';

/**
 * Marker for the generated "Where to work" workspace map
 * (staging-branch-pipeline-2026-06-06) — the canonical working tree + its
 * branch, and the do-not-touch pipeline-artifact siblings (release/checkpoint
 * checkouts). Rendered by `renderWorkspaceMapSection()` from the SAME env
 * seams as `release-config.ts`/`dev-deploy-state.ts`, so when branches or
 * paths change (it happened 2026-06-06: main→staging) the prompt follows the
 * config instead of drifting hand-written prose. Same splice contract.
 */
export const WORKSPACE_MAP_MARKER = '<!-- PAPERCUSP-SU:WORKSPACE-MAP -->';

/**
 * Marker for the generated "How your change reaches `main`" promotion model
 * (per-hive-git-and-release-gate-2026-06-29 P-012) — the staging→main contract (work lands
 * on the integration branch; `main` is green-only; a red suite freezes it; tests gate
 * promotion; watch /admin/git). Rendered by `renderPromotionModelSection()` from the SAME
 * release-gate env seams as the workspace map, so it follows the config instead of drifting.
 * A non-coding hive (no gate) renders an EMPTY section → the marker is removed (never a
 * contract for a gate that doesn't run). Same splice contract.
 */
export const PROMOTION_MODEL_MARKER = '<!-- PAPERCUSP-SU:PROMOTION-MODEL -->';

/**
 * Marker for the spliced PROJECT GUIDE (psu-isolation P-001) — the repo's
 * `CLAUDE.md` (the single editable source; `AGENTS.md` is a symlink to it).
 * Spliced by `renderSuPlaybook` from `renderProjectGuideSection(guideText)`.
 *
 * This is the D-002 mechanism: psu sessions get the 600+-line project guide
 * (the full nuqs / storage / testing / sync conventions the playbook only
 * headlines) WITHOUT the client auto-loading it — auto-load also drags in the
 * launching user's personal/global config (the leakage P-002/P-003/P-004 fix).
 * engineer profile → papercup's own `CLAUDE.md`; power profile → the managed
 * repo's guide (resolved from the launch cwd). Same splice contract as the
 * other generated sections: an absent marker leaves the section out; an empty
 * guide removes the marker (never shipped literally).
 */
export const PROJECT_GUIDE_MARKER = '<!-- PAPERCUSP-SU:PROJECT-GUIDE -->';

/**
 * Marker for the generated operating-modes section (operating-modes-policy.ts) — the owner's
 * AUTO ("act, don't ask") switch + its relationship to the engine loop, PLUS the IDEATE
 * ("invent net-new, don't just patch") switch and the AUTO×IDEATE composition table. Authored
 * ONCE in `renderModesPolicy()` and spliced into the engineer + power su playbooks by
 * `renderSuPlaybook` / `writeSplicedPlaybook`, so the two surfaces can't desync (the AUTO half
 * used to be a hand-maintained copy in papercusp-su-engineer.tools.md only — power had none).
 * The marker keeps its `AUTO-MODE` name: the string is a contract shared by both base
 * playbooks, the `libs/papercusp` blueprint persona, and build artifacts, so renaming it would
 * need a lock-step cross-repo edit with a silent section-drop on any mismatch. Same splice
 * contract: an absent marker leaves the section out (a future profile can opt out); an empty
 * section removes the marker.
 */
export const AUTO_MODE_MARKER = '<!-- PAPERCUSP-SU:AUTO-MODE -->';

/**
 * Marker for the agent self-management compaction protocol
 * (agent-managed-compaction-2026-07-01) — the soft-limit / 90%–125% /
 * set_compaction_limit / session:request_compaction contract the AGENT follows to
 * manage its own context. Canonical source is the projected file
 * apps/operator/prompts/papercusp-compaction.protocol.md; spliced by
 * renderSuPlaybook / writeSplicedPlaybook. Same contract: absent marker leaves the
 * section out; an empty file removes the marker (never shipped literally).
 */
export const COMPACTION_MARKER = '<!-- PAPERCUSP-SU:COMPACTION -->';

/**
 * Marker for the generated per-result DOOR section (agent-context-firewall P-015) —
 * the effective `resultEach` cap and the `projection` knob, taught ONCE in standing
 * context instead of in ~550 tool descriptions (which the P-011 prompt-weight budget
 * would red on). Rendered by `renderResultDoorSection()` from `computeTurnDoors`, the
 * SAME function `applyResultDoor` enforces with, so the number in the prompt cannot
 * drift from the number in the door. Same splice contract as the others: an absent
 * marker leaves the section out; an empty section removes the marker.
 */
export const RESULT_DOOR_MARKER = '<!-- PAPERCUSP-SU:RESULT-DOOR -->';

/**
 * Marker for the SHARED BASE NOTES bundle (`injectSharedBaseNotes` in papercusp-files.ts):
 * the deploy-pipeline, wait-loop, peer-wake, COUPLING and state-plane clauses that are
 * authored once in code and projected into every prompt base so they cannot desync.
 *
 * ⚠ WHY THIS MARKER EXISTS — a silent total-drop that ran for 12+ days (2026-08-09).
 * The bundle used to anchor on {@link PROJECT_GUIDE_MARKER}, which doubled as its "is this a
 * real su playbook?" test. That test was sound only while the LEGACY base
 * (`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md`) was live — it carries that
 * marker. When `SU_BLUEPRINT_PERSONA` made the BLUEPRINT base
 * (`libs/papercusp/packages/harness/blueprints/base/prompts/su.md`) the live one, the anchor
 * vanished with it: the blueprint base carries AUTO-MODE / WIRE-SCHEMAS / COORD-LEGEND /
 * RESULT-DOOR but has never carried PROJECT-GUIDE. `injectSharedBaseNotes` therefore hit its
 * `return text` no-op branch and dropped ALL FIVE notes, silently, on every interactive
 * render. Measured: the coupling clause reached 6 of 5211 rendered launch contexts, and the
 * 6 were a ten-second burst on the day it shipped.
 *
 * Two properties this fixes, deliberately kept separate:
 *   · POSITION — where the bundle goes is now stated IN the base, not inferred from an
 *     unrelated section's marker that may or may not be there.
 *   · ELIGIBILITY — "should this base get the notes at all?" is answered by the base
 *     carrying this marker, so a minimal/test base still gets nothing (the no-append
 *     contract every other section here honours) without that answer riding on a marker
 *     whose real job is something else.
 *
 * The general trap, since it will recur: an anchor borrowed from another feature is a
 * dependency you did not declare, and it breaks silently — the splice contract's
 * "absent marker ⇒ leave the section out" is correct for an OPTIONAL section and
 * catastrophic for a MANDATORY one. PROJECT_GUIDE_MARKER remains a fallback anchor so
 * the legacy bases keep their existing placement with no edit.
 */
export const SHARED_BASE_NOTES_MARKER = '<!-- PAPERCUSP-SU:SHARED-BASE-NOTES -->';

/**
 * Marker in papercusp-compaction.base.md where the per-client compaction overlay
 * (papercusp-compaction.<client>.md) splices — the SUMMARIZER-instruction analog of
 * CLIENT_TOOLING_OVERLAY_MARKER. Consumed by renderCompactionStrategy (the Claude
 * floor: base+claude -> ~/.papercusp/compaction-strategy.md). agent-managed-compaction.
 */
export const COMPACTION_CLIENT_OVERLAY_MARKER = '<!-- PAPERCUSP-COMPACTION:CLIENT-OVERLAY -->';

/**
 * Every concrete splice token, keyed by the stable marker id carried in the
 * comment. Runtime splicers keep their named exports above; tests and the
 * repository-wide presence guard derive from this map so a rename cannot leave
 * a second hand-maintained registry behind (identities-v1 P-024).
 */
export const SPLICE_MARKERS = {
  'PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY': CLIENT_TOOLING_OVERLAY_MARKER,
  'PAPERCUSP-SU:WIRE-SCHEMAS': WIRE_SCHEMAS_MARKER,
  'PAPERCUSP-SU:COORD-LEGEND': COORD_LEGEND_MARKER,
  'PAPERCUSP-SU:WORKSPACE-MAP': WORKSPACE_MAP_MARKER,
  'PAPERCUSP-SU:PROMOTION-MODEL': PROMOTION_MODEL_MARKER,
  'PAPERCUSP-SU:PROJECT-GUIDE': PROJECT_GUIDE_MARKER,
  'PAPERCUSP-SU:AUTO-MODE': AUTO_MODE_MARKER,
  'PAPERCUSP-SU:COMPACTION': COMPACTION_MARKER,
  'PAPERCUSP-SU:RESULT-DOOR': RESULT_DOOR_MARKER,
  'PAPERCUSP-SU:SHARED-BASE-NOTES': SHARED_BASE_NOTES_MARKER,
  'PAPERCUSP-COMPACTION:CLIENT-OVERLAY': COMPACTION_CLIENT_OVERLAY_MARKER,
} as const;

export type SpliceMarkerId = keyof typeof SPLICE_MARKERS;

/** The complete marker contract of a source/base SU playbook. */
export const SU_PLAYBOOK_MARKER_IDS = [
  'PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY',
  'PAPERCUSP-SU:WIRE-SCHEMAS',
  'PAPERCUSP-SU:COORD-LEGEND',
  'PAPERCUSP-SU:WORKSPACE-MAP',
  'PAPERCUSP-SU:PROMOTION-MODEL',
  'PAPERCUSP-SU:PROJECT-GUIDE',
  'PAPERCUSP-SU:AUTO-MODE',
  'PAPERCUSP-SU:COMPACTION',
  'PAPERCUSP-SU:RESULT-DOOR',
  'PAPERCUSP-SU:SHARED-BASE-NOTES',
] as const satisfies readonly SpliceMarkerId[];

const SU_KERNEL_MARKER_IDS = [
  'PAPERCUSP-SU:WIRE-SCHEMAS',
  'PAPERCUSP-SU:COORD-LEGEND',
  'PAPERCUSP-SU:WORKSPACE-MAP',
  'PAPERCUSP-SU:PROMOTION-MODEL',
  'PAPERCUSP-SU:AUTO-MODE',
  'PAPERCUSP-SU:RESULT-DOOR',
  'PAPERCUSP-SU:SHARED-BASE-NOTES',
] as const satisfies readonly SpliceMarkerId[];

export interface RequiredSpliceMarkerArtifact {
  /** Repository-relative path. */
  path: string;
  markerIds: readonly SpliceMarkerId[];
  /** Ignored build outputs are checked when present but are absent in clean CI trees. */
  required: boolean;
}

/**
 * Per-artifact presence contract. Every listed marker must occur EXACTLY ONCE.
 * The ignored host/sidecar copies are optional-to-exist but never optional-to-be
 * correct when a build materializes them. Tracked sources, derived part docs,
 * the pinned baseline fixture, and the desktop staging projection fail closed.
 */
export const REQUIRED_SPLICE_MARKERS_BY_ARTIFACT: readonly RequiredSpliceMarkerArtifact[] = [
  { path: 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: true },
  { path: 'apps/operator/prompts/papercusp-su-engineer.tools.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: true },
  { path: 'apps/operator/prompts/papercusp-su-power.tools.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: true },
  { path: 'packages/operator-core/lib/desktop-install/__fixtures__/su-render-baseline/su.base.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: true },
  { path: 'papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: true },
  { path: 'libs/papercusp/packages/harness/blueprints/base/prompts/su.kernel.md', markerIds: SU_KERNEL_MARKER_IDS, required: true },
  { path: 'libs/papercusp/packages/harness/blueprints/base/prompts/su.practice.md', markerIds: ['PAPERCUSP-SU:COMPACTION'], required: true },
  { path: 'libs/papercusp/packages/harness/blueprints/base/prompts/su.instance.md', markerIds: ['PAPERCUSP-SU:PROJECT-GUIDE'], required: true },
  { path: 'apps/operator/prompts/papercusp-compaction.base.md', markerIds: ['PAPERCUSP-COMPACTION:CLIENT-OVERLAY'], required: true },
  { path: 'apps/operator/dist-host/blueprints/base/prompts/su.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: false },
  { path: 'apps/operator/dist-host/blueprints/base/prompts/su.kernel.md', markerIds: SU_KERNEL_MARKER_IDS, required: false },
  { path: 'apps/operator/dist-host/blueprints/base/prompts/su.practice.md', markerIds: ['PAPERCUSP-SU:COMPACTION'], required: false },
  { path: 'apps/operator/dist-host/blueprints/base/prompts/su.instance.md', markerIds: ['PAPERCUSP-SU:PROJECT-GUIDE'], required: false },
  { path: 'apps/operator/dist-sidecar/blueprints/base/prompts/su.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: false },
  { path: 'papercusp-desktop/src-tauri/sidecar/harness/blueprints/base/prompts/su.md', markerIds: SU_PLAYBOOK_MARKER_IDS, required: false },
  { path: 'papercusp-desktop/src-tauri/sidecar/harness/blueprints/base/prompts/su.kernel.md', markerIds: SU_KERNEL_MARKER_IDS, required: false },
  { path: 'papercusp-desktop/src-tauri/sidecar/harness/blueprints/base/prompts/su.practice.md', markerIds: ['PAPERCUSP-SU:COMPACTION'], required: false },
  { path: 'papercusp-desktop/src-tauri/sidecar/harness/blueprints/base/prompts/su.instance.md', markerIds: ['PAPERCUSP-SU:PROJECT-GUIDE'], required: false },
];

/**
 * Splice generated `content` into `base` at `marker`. Replaces ALL marker
 * occurrences; with an absent marker the content is appended (when non-empty);
 * an empty content with a present marker just removes it. Generalizes the
 * tooling-overlay splice so multiple generated sections share one contract.
 */
export function spliceAtMarker(base: string, marker: string, content: string): string {
  if (base.includes(marker)) {
    return base.split(marker).join(content);
  }
  if (content) {
    return base.replace(/\n+$/, '') + '\n\n' + content + '\n';
  }
  return base;
}

/**
 * Splice a GENERATED section ONLY where its marker is present — never append.
 * Unlike `spliceToolingOverlay` (whose append-on-absent is a legacy fallback), a
 * generated section (wire-schemas, coord-legend) belongs strictly at its marker:
 * a base playbook that doesn't carry the marker (a minimal/test base, a future
 * profile that opts out) must NOT get the section dumped at its end. Absent
 * marker → returned unchanged.
 */
export function spliceGeneratedSection(base: string, marker: string, content: string): string {
  return base.includes(marker) ? base.split(marker).join(content) : base;
}

/**
 * @param base    base playbook (may contain the marker).
 * @param overlay client tooling overlay; pass '' if none (the marker is then
 *                removed, never shipped literally).
 * @returns base with the overlay spliced in at the marker. For a pre-marker
 *   base, the overlay is appended; with no overlay, the base is returned
 *   verbatim. Mirrors `render_playbook` in install-standalone-mcp.sh.
 */
export function spliceToolingOverlay(base: string, overlay: string): string {
  if (base.includes(CLIENT_TOOLING_OVERLAY_MARKER)) {
    return base.split(CLIENT_TOOLING_OVERLAY_MARKER).join(overlay); // replace ALL
  }
  if (overlay) {
    return base.replace(/\n+$/, '') + '\n\n' + overlay + '\n';
  }
  return base;
}
