/**
 * Committed per-role model defaults — the in-tree role→model default map
 * (EI-7 / release-gate-ready-branch-2026-06-04 D-011).
 *
 * The problem this closes: per-role model selection (`resolveModel` in
 * invoke.ts, `applyRoleModel` in operator-core's harness-invoke-once.ts) read
 * ONLY env (`AGENT_MODELS`) + per-harness config.json. So a role whose
 * judgment must NOT silently downgrade — chiefly `release-manager`, whose blast
 * radius is the entire running fleet — fell back to the agent CLI's generic
 * default on any host without the env var set (the `opus:xhigh` pin lived only
 * in a `.env.local` + a doc-comment). EI-7.
 *
 * These are DEFAULTS, not overrides: `AGENT_MODELS` / config.json STILL win
 * (an operator can still pin a different model). The committed default is the
 * floor that applies when nothing else is set, so the choice can't degrade to
 * the CLI default by omission.
 *
 * A spec is a model id or `<modelId>:<effort>` (effort ∈
 * low|medium|high|xhigh|max) — the same shape `AGENT_MODELS` values take, so it
 * flows through the existing parsers unchanged (`applyRoleModel` splits the
 * `:effort`; `resolveModel` passes the spec to `normalizeModelForBackend`).
 */

/**
 * Committed role→model-spec defaults — the per-role MODEL-TIER POLICY
 * (token-usage-reduction-audit-2026-06-09 P-012), enforced via the launch
 * spec rather than convention:
 *
 *   - haiku  — high-volume, low-judgment loop roles: the fleet's call-count
 *              tier; opus here is pure waste. (cup/scanner/judge moved OFF
 *              this tier onto the autonomous-loop GPT-5.6 luna floor below,
 *              autonomous-loop-prod-audit-2026-07-02 P-020 — no role
 *              currently occupies haiku.)
 *   - sonnet — the pipeline's execution tier (worker / validator /
 *              documenter): high-frequency roles whose work is bounded by a
 *              spec + acceptance assertions, not open-ended judgment.
 *   - opus   — ONLY on explicit escalation: an `AGENT_MODELS`/config override
 *              per role, or a committed pin for a low-frequency,
 *              fleet-blast-radius judgment call (release-manager).
 *
 * These are DEFAULTS, not overrides — `AGENT_MODELS`/config.json still win,
 * so escalating one harness's worker to opus is a per-role config entry.
 */
export const ROLE_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  // The deploy gate's judgment half (D-011). Claude Opus 4.8 @ xhigh effort:
  // a deploy's blast radius is the whole running fleet, so this low-frequency,
  // high-stakes call is worth maximum reasoning. Committed so it can't silently
  // downgrade on a host without AGENT_MODELS["release-manager"] set.
  'release-manager': 'opus:xhigh',
  // The launch-fixer family — opus:xhigh for the two fleet-blast-radius members, the
  // committed floor matching git-pipeline-stats' resolverModel() (git-sync-content-guard
  // D-008 follow-up). Each fires rarely (only on a conflict / red gate) and unblocks a
  // path the whole fleet depends on, so the same "low-frequency, fleet-blast-radius
  // judgment call" rubric that pins release-manager applies:
  //   - merge-resolver redoes a conflicted merge on `main` — a wrong resolution corrupts
  //     the shared history. resolverModel() already declares opus:xhigh as its floor for
  //     stats, but the LAUNCH path (applyRoleModel→roleModelDefault) had no entry, so on a
  //     host without AGENT_MODELS["merge-resolver"] it silently downgraded (the EI-7 class
  //     of bug release-manager fixed). Pinned here reconciles the two sources of truth.
  //   - release-fixer is the release-manager's execution twin: it reproduces a red-gate
  //     failure and classifies regression-vs-flake — subtle judgment where a wrong call
  //     either ships a regression or churns on a flake, on the path that gates ALL deploys.
  'merge-resolver': 'opus:xhigh',
  'release-fixer': 'opus:xhigh',
  // The content-guard's syntax repairer — the execution tier (sonnet), not opus: its work
  // is bounded syntax repair against a deterministic success check (the content detector
  // re-passes), it fires more often than the gate fixers (any quarantined .mdx/.ts), and a
  // wrong fix is self-correcting (re-quarantined, low blast radius). Not haiku: a file-
  // editing role needs reliable tool-calling (EI-286: haiku drifts into bash).
  //
  // ⚠ OVERRIDDEN 2026-09-02 — owner directive (interactive): "change them to
  // opus 5 xhigh agents" + "edit the workspace defaults as well". The sonnet
  // rationale above is the ORIGINAL reasoning and is kept for context; it is NO
  // LONGER the policy. The owner was shown explicitly that this pin was deliberate
  // and documented, and chose to override it anyway. Do not "restore" it as a
  // drift fix — revert only on a new owner decision.
  'content-fixer': 'opus:xhigh',
  // The DOC-STEWARD (docs-corpus-audit WS2 / P-008) — the auto doc-freshness fixer, the
  // launch-fixer family's fourth member alongside merge-resolver / release-fixer / content-fixer.
  // sonnet, not opus: like content-fixer its work is bounded (re-verify prose against the anchored
  // code, harness_docs:verify to clear the flag) and self-correcting, but a doc-editing role needs
  // reliable tool-calling + the BIG window — it reads several whole source files per run to check a
  // batch of up to 8 drifted docs. EI-8164: registered LATE (role-config.ts), it was the one
  // fixer role with NO committed default, so `applyRoleModel`/`roleModelDefault` returned the base
  // command UNCHANGED → it launched on the bare CLI default, which runs a 200k auto-compact window
  // in CC (no `[1m]` marker gets injected when no spec is resolved). Its multi-file reads then
  // thrashed autocompact → "Prompt is too long" (context_overflow) — 6+ failed spawns/day. Pinning
  // `sonnet` here routes it through normalizeModelSpec → `sonnet[1m]` (the 967k window) at launch,
  // the same fix every sibling fixer already had. Cheap, high-frequency, spec-bounded ⇒ sonnet tier.
  //
  // ⚠ OVERRIDDEN 2026-09-02 — owner directive (interactive), same call as
  // content-fixer above. NOTE what carries over from the EI-8164 story: the reason
  // that bug existed was a MISSING `[1m]` window, and `opus` is in DEFAULT_1M_FAMILY_RE
  // exactly like `sonnet`, so normalizeModelSpec still yields `opus[1m]:xhigh` and the
  // big window this role needs for multi-file reads is preserved. The change is the
  // TIER, not the window — EI-8164 does not regress.
  'doc-steward': 'opus:xhigh',
  // P-012 execution tier — spec-bounded, high-frequency pipeline roles.
  worker: 'sonnet',
  validator: 'sonnet',
  documenter: 'sonnet',
  // P-012 volume tier (haiku) ORIGINALLY also pinned cup/scanner/judge here —
  // superseded by the P-020 autonomous-loop migration below (those three ARE
  // autonomous-loop/gym roles the brief names explicitly; moved rather than
  // duplicated, since an object literal's later key silently wins and a
  // stray duplicate would be a footgun for the next reader). No other role
  // currently occupies this volume tier.
  // The pot's JUDGMENT/control-loop layer (owner-watched autonomous run):
  // Mug/Kettle/Cup/Blender wakes are the free-running Mug->Cup->Kettle->Blender
  // autonomous loop (local-hive-orchestration / pot-rename D-007), plus the gym
  // learning-loop's judge/scanner. Sonnet-5 trimmed-mode ([1m] window) at `high`
  // reasoning effort is the committed floor.
  //
  // HISTORY: autonomous-loop-prod-audit-2026-07-02 P-020 (WI-4640) migrated this
  // whole set to `gpt-5.6-luna:high` on the native Codex backend. That migration
  // was REVERTED here per owner decision WI-4623 (owner, interactive 2026-07-16;
  // relayed by fleet leader su-d838f112, coord mroerbb3): autonomous-loop roles
  // go to sonnet-5:high TRIMMED via the gateway, NOT gpt-5.6-luna. The luna floor
  // also broke production at runtime — a role whose spawn keeps the `claude`
  // binary (the gateway / account-steering path) was handed a codex-only
  // `gpt-5.6-luna` id and hard-downed (kettle@papercusp, 2026-07-16;
  // independently root-caused + sonnet-pin-verified by su-33019ac2). A trimmed
  // sonnet spec is the inverse of the trap the luna migration relied on: where
  // the `gpt-5.6-` prefix made `inferBackendFromModelSpec` (harness-invoke-once.ts)
  // / `isCodexShapedModelSpec` (orchestrator env.ts) swap the subprocess to
  // `codex`, `sonnet[1m]:high` resolves through normalizeModelSpec to the 967k
  // trimmed window and now infers the claude-code backend, so the spawn binary
  // stays correct.
  //
  // ⚠ CORRECTION (2026-08-08, WI-36197): that last clause USED TO BE FALSE, and
  // the false comment is very likely why nobody re-checked the path. Until this
  // date `inferBackendFromModelSpec` returned a backend ONLY for Codex-shaped
  // specs and `undefined` for everything else — it never inferred claude. The
  // spawn binary therefore came from `AGENT_CMD ?? CLAUDE ?? 'omp -p'`, so it
  // "stayed correct" only in processes that happen to export AGENT_CMD.
  // papercup-bg-host.service does (mug/kettle boot fine); the OPERATOR process
  // does not — so every `cup:spawn` served there launched
  // `omp -p --model sonnet[1m]:high`, which omp has no bare alias for, and died
  // in ~1.5s with exit 1 before its first turn. Six consecutive spawns reported
  // `ok` while the pot made zero progress. The claude-code branch now exists in
  // inferBackendFromModelSpec (harness-invoke-once.ts), making the sentence
  // above true; do not "simplify" it back out — the spec must drive the binary
  // at EVERY spawner, not only ones with the env var set.
  //
  // ⚠ The spec is the BARE `sonnet[1m]:high`, NOT `sonnet-5[1m]:high` — even
  // though the owner's decision names "sonnet-5". `sonnet-5` is a VERSIONED
  // shorthand that validateCloudModelSpec / psu-launcher REJECT as unrunnable
  // (WI-1979 / EI-12657): only the bare alias `sonnet` is resolvable, and it
  // resolves to the LATEST sonnet generation (= sonnet-5 today; live-verified a
  // `--model sonnet` transcript reports "claude-sonnet-5"). Writing `sonnet-5`
  // here reaches the CLI/gateway as an unrunnable id and kills every autonomous
  // spawn before its first turn — do NOT "fix" the bare alias to the versioned one.
  //
  // Every key that resolves to the same canonical role via the pot-rename
  // map (POT_RENAME_ROLE_MAP in agent-tools/coordination/roles.ts:
  // bee->cup, queen->mug, sentinel->papercup, overwatch->kettle, scout->blender)
  // is kept in lockstep here — nothing canonicalizes the role string before
  // this map is looked up, so a stale legacy-name entry would silently keep
  // running a different spec for any caller still passing the old name.
  // `papercup` and `blender` are entries that were previously absent (those
  // roles fell through to the bare CLI default with no committed floor at
  // all, the exact EI-7 gap this file exists to close).
  // ⚠ 2026-09-02 — owner directive (interactive): "change them to opus 5 xhigh
  // agents" + "edit the workspace defaults as well". mug / kettle / scanner are the
  // three members of this autonomous-loop group that ALSO carry an
  // operator_agent_config roleBackends entry, so they moved to opus:xhigh with the
  // rest of that 8-role set. Every other role in this block stays on the sonnet
  // tier — they were not in the scope the owner named. The [1m] window is NOT lost:
  // `opus` matches DEFAULT_1M_FAMILY_RE, so normalizeModelSpec yields
  // `opus[1m]:xhigh`. What changed is the TIER, not the window.
  queen: 'sonnet[1m]:high',
  bee: 'sonnet[1m]:high',
  mug: 'opus:xhigh',
  cup: 'sonnet[1m]:high',
  kettle: 'opus:xhigh',
  overwatch: 'sonnet[1m]:high',
  sentinel: 'sonnet[1m]:high',
  papercup: 'sonnet[1m]:high',
  blender: 'sonnet[1m]:high',
  // `operator` was a member of THIS SAME judgment/control-loop group pre-migration
  // (`operator: 'sonnet[1m]:high'`) but is DELIBERATELY absent as of P-020
  // (autonomous-loop-prod-audit-2026-07-02): it's the interactive brain surface,
  // not an autonomous-loop role, and the orchestrator's OWN suite pins the
  // no-committed-default behavior explicitly (invoke.test.ts: "operator has no
  // committed default in ROLE_MODEL_DEFAULTS (interactive surface, not
  // autonomous-loop)" — `resolveModel({}, 'operator')` must be `''`). Do not
  // re-add it without updating that guard test in lockstep — a prior pass on
  // this file re-added it and broke that invariant.
  // The gym loop's judgment role (task-generator/variant-runner/proposer stay
  // unpinned — no committed default existed for them before P-020 either;
  // out of THIS item's narrow scope, left for a follow-up). `scanner` is
  // blender's negative-space-scan execution role (AGENT_ROLES: "the
  // negative-space/scout scanner") — moves with blender.
  judge: 'sonnet[1m]:high',
  // Moved to opus:xhigh with mug/kettle — see the 2026-09-02 owner-directive note above.
  scanner: 'opus:xhigh',
};

/**
 * The committed default model spec for a role, or `undefined` when the role has
 * none (→ caller keeps the CLI default). `AGENT_MODELS`/config OVERRIDE this; it
 * is consulted only after they yield nothing.
 */
export function roleModelDefault(role: string): string | undefined {
  return ROLE_MODEL_DEFAULTS[role];
}
