/**
 * Launch-context composer for the `psu` / `*-su` launch path.
 *
 * When `psu` (or the /adv "Launch SU" modal) bootstraps a session, the
 * user has just picked a harness scope and (optionally) a plan to work
 * on. The static playbook the wrappers inject is profile-wide and
 * scope-agnostic — it can't say "you are on harness X" or "your bound
 * plan's Now is Y". This module composes a SHORT, launch-specific
 * addendum from those picks; `bootstrap-su` writes it to a per-launch
 * file and hands the path to the wrapper via `PAPERCUSP_LAUNCH_CONTEXT_FILE`,
 * which each client appends to its system prompt
 * (`--append-system-prompt[-file]`).
 *
 * Design (su-prompt-audit-fixes P-021/P-022, D-008): the addendum
 * *supplements* the playbook (it does not restate it — see D-001
 * pointers-not-duplication). It only has something launch-specific to
 * say when a harness OR a plan was picked; an ad-hoc workspace-level
 * launch returns '' (the playbook's no-harness section already covers
 * that case) and `bootstrap-su` then sets no env var.
 *
 * `composeLaunchContext` is pure so it is unit-tested without the route;
 * the fs write + env wiring live in `bootstrap-su.ts`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LaunchContextInput {
  /** Harness the session is scoped to, or null for a workspace-level launch. */
  harnessSlug: string | null;
  /** Plan the session is bound to, or null for an ad-hoc session. */
  planSlug: string | null;
  /** Plan title from frontmatter, if known. */
  planTitle?: string | null;
  /** The plan's `## Now` block, if the plan was readable at launch. */
  planNow?: { state: string; next: string } | null;
  /** Controls which repo-specific shortcuts belong in the launch brief. */
  profile?: 'engineer' | 'power' | 'generic';
  /** WI-10004449: the session's fleet role. A `leader` gets a lead-the-fleet first
   *  move instead of the member "claim its next actionable item" line. */
  fleetRole?: string | null;
}

/**
 * Compose the launch-context addendum (markdown). Returns '' when there
 * is nothing launch-specific to say (no harness AND no plan).
 */
export function composeLaunchContext(input: LaunchContextInput): string {
  const { harnessSlug, planSlug, planTitle, planNow } = input;
  if (!harnessSlug && !planSlug) return '';

  const lines: string[] = [
    '# Operating brief — this launch',
    '',
    '> Generated from the selected scope and plan. This compact index points into',
    '> the full playbook; it does not replace its safety rules.',
    '',
  ];

  if (harnessSlug) {
    // improve-fleet-launch-autokickoff P-004: this used to claim harness-scoped tools
    // "serve this harness automatically — you don't pass its slug", but the SU model
    // (role-launch-spec) is per-call: `docs:*`/`features:*`/`issues:*`/`plans:*` answer
    // `harness_required` until a harness is named on the call. The old over-promise made
    // agents omit `harness` and eat a wasted round-trip. State the per-call model truthfully.
    lines.push('<!-- papercusp-rule:harness-scope=explicit-per-call -->');
    if (harnessSlug === 'papercusp') {
      // Papercusp's agent-insights/framework docs live on the engineering surface,
      // not in the papercusp harness' project-docs tree. Keep the concrete harness
      // scope for project plans/issues/features while naming the deliberate docs
      // surface escape so a launch brief cannot send agents to an empty corpus.
      lines.push(
        `- **Scope:** harness \`${harnessSlug}\`; pass \`harness: '${harnessSlug}'\` to ` +
          '`features:*`, `issues:*`, and `plans:*`.',
        "- **Papercusp engineering docs:** for `docs:*` reads of `agent-insights/*` and framework docs, pass `harness: 'all'` in an unscoped operator session; workspace-scoped sessions use `harness: 'engineering'` instead.",
      );
    } else {
      lines.push(
        `- **Scope:** harness \`${harnessSlug}\`; pass \`harness: '${harnessSlug}'\` to ` +
          '`docs:*`, `features:*`, `issues:*`, and `plans:*`.',
      );
    }
    lines.push('- **Other harnesses:** read through `cross_harness:docs_*` / `cross_harness:plans_*`.');
  } else {
    lines.push(
      '<!-- papercusp-rule:harness-scope=explicit-per-call -->',
      '- **Scope:** workspace level; pass a concrete harness to harness-scoped tools.',
      '- **Other harnesses:** read through `cross_harness:docs_*` / `cross_harness:plans_*`.',
    );
  }

  if (planSlug) {
    lines.push(`- **Plan:** bound to \`${planSlug}\`${planTitle ? ` — ${planTitle}` : ''}.`);
    if (planNow && (planNow.state || planNow.next)) {
      if (planNow.state) lines.push(`  - **Now:** ${planNow.state}`);
      if (planNow.next) lines.push(`  - **Next:** ${planNow.next}`);
    } else {
      lines.push(`  - Read \`plans:get { slug: '${planSlug}' }\` for its current \`## Now\`.`);
    }
    // improve-fleet-launch-autokickoff (EI-5503) stopgap: a scripted/fleet plan
    // launch now seeds a kickoff first-turn, but belt-and-suspenders — if any launch
    // path leaves a plan-bound agent idle with no kickoff (a backend without a
    // positional-prompt seam, a server kickoff-derive miss, a future launcher), it
    // must START ON ITS OWN rather than park waiting to be told.
    lines.push(
      input.fleetRole === 'leader'
        ? `- **First move:** you LEAD this plan's fleet — read \`${planSlug}\`, check that the fleet ` +
            "claim spec selects its items and that members are claiming them; do not claim the plan's " +
            'items yourself (WI-10004449).'
        : `- **First move:** read \`${planSlug}\`, claim its next actionable item, and begin; a ` +
            'plan-bound launch is already a work assignment.',
    );
  }

  if ((input.profile ?? 'engineer') === 'engineer') {
    lines.push(
      '<!-- papercusp-rule:test-router=test-file -->',
      '- **Exact tests:** Vitest files use `npm run test:file -- <test paths>`, which routes each file to its owning Vitest config; registered non-Vitest files (for example `papercusp-desktop` Node tests) use their package\'s documented runner because `test:file` is Vitest-only.',
      '<!-- papercusp-rule:app-runtime=tauri -->',
      '- **UI verification:** drive the Tauri shell; server-side staging changes run on `:3170`.',
      '<!-- papercusp-rule:git-ownership=background-sync -->',
      '- **Git:** leave verified edits in `staging`; the background sync owns commit and push.',
    );
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Directory the per-launch context files live in. A bootstrap artifact a
 * CLI reads as `--append-system-prompt-file` BEFORE any PG/tool
 * connection exists — squarely an acceptable file use (not app state).
 * Overridable via `PAPERCUSP_LAUNCH_CONTEXT_DIR` (used by tests + for
 * relocating the runtime dir); defaults under `~/.papercusp`.
 */
export function launchContextDir(): string {
  return process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR || join(homedir(), '.papercusp', 'launch-context');
}

/** Absolute path of the context file for a given launch key (session id or nonce). */
export function launchContextPathFor(key: string | number): string {
  return join(launchContextDir(), `session-${key}.md`);
}
