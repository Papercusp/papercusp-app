/**
 * promotion-model — the generated "How your change reaches `main`" section of the SU
 * playbooks (per-hive-git-and-release-gate-2026-06-29 P-012, D-005).
 *
 * Sibling of workspace-map.ts: the staging→main PROMOTION CONTRACT (work lands on the
 * integration branch; `main` is green-only; a red suite freezes it; never push `main` by
 * hand; tests gate promotion; watch /admin/git) is CONFIG, not prose — branches + the green
 * command come from the live release-gate, so a hand-written contract would drift and could
 * describe a gate the routines don't run. This renders it from the same env seams as
 * `release-config.ts` / `hive-release-env.ts`, so every freshly-rendered prompt follows the
 * config. A NON-CODING hive (no gate) renders NOTHING (D-005) — the section never describes
 * a gate that isn't there.
 */

export interface PromotionModelConfig {
  /** Whether this hive runs the staging→main green gate. false ⇒ render nothing. */
  enabled: boolean;
  integrationBranch: string;
  releaseRef: string;
  /** The command the green-checkpoint runs to decide "green" (the SAME command agents
   *  write tests for — the gate consumes the existing test runner, D-004). */
  greenCmd: string;
}

/**
 * Resolve the promotion-model config from the env (the per-hive overlay
 * hive-release-env.ts sets, or the operator-home defaults). `enabled` defaults true: the
 * operator-home (papercusp) IS a coding hive that runs the gate. A future per-hive render
 * for a non-coding hive passes `enabled:false` to omit the section.
 */
export function resolvePromotionModelConfig(): PromotionModelConfig {
  return {
    enabled: true,
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
    greenCmd: process.env.PAPERCUSP_GREEN_CMD ?? 'npm run test:affected',
  };
}

/**
 * Render the promotion-model markdown. Pure over the (injectable) config so it's
 * unit-testable without env games. Returns '' for a disabled gate (non-coding hive) so the
 * splice removes the marker (never ships a contract for a gate that doesn't run).
 */
export function renderPromotionModelSection(
  cfg: PromotionModelConfig = resolvePromotionModelConfig(),
): string {
  if (!cfg.enabled) return '';
  const { integrationBranch, releaseRef, greenCmd } = cfg;
  return [
    `**How your change reaches \`${releaseRef}\` — the promotion model** *(generated from the live release-gate config — authoritative)*:`,
    ``,
    `- Your work lands on **\`${integrationBranch}\`** (git-sync sweeps the tree there on a schedule). **\`${releaseRef}\` is GREEN-ONLY**: the green-checkpoint runs the suite (\`${greenCmd}\`) in an isolated checkout and fast-forwards \`${releaseRef}\` to a \`${integrationBranch}\` commit ONLY when it passes.`,
    `- A **red suite HOLDS \`${releaseRef}\`** — fix forward on \`${integrationBranch}\`; never \`git push\` / \`branch -f\` \`${releaseRef}\` by hand (a pre-push hook blocks it).`,
    `- **Tests ship WITH the feature, in this hive's framework** — \`${greenCmd}\` is exactly what gates promotion. A skipped or flaky test that lets red through freezes \`${releaseRef}\` (and the deploy) for the WHOLE hive, not just you.`,
    `- Watch the gate at **\`/admin/git\`** (pipeline dashboard) and the 🟩/🟥 green-checkpoint coord broadcasts. If \`${releaseRef}\` lacks your change, the suite is red or the checkpoint hasn't run yet — check there before assuming it deployed.`,
    `- **If you NEED your change green on \`${releaseRef}\` to keep working, getting the gate GREEN is YOUR job — end-to-end, and yours to DRIVE (don't just wait for the hourly checkpoint).** A red suite freezes \`${releaseRef}\` for the whole hive, so if the checkpoint is RED you OWN getting it green **even when the failing tests are someone ELSE'S unrelated work** — diagnose + fix forward on \`${integrationBranch}\` (coordinate the owner if they're live on it), don't sit blocked. Then promote + deploy: it is EXPECTED and fine that a green \`${releaseRef}\` fast-forwards a commit carrying others' work alongside yours — that's the shared green pin by design. Get it green, get it to \`${releaseRef}\`, deploy.`,
  ].join('\n');
}
