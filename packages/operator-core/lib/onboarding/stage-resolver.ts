/**
 * Pure onboarding stage-resolver — maps a detection snapshot to the concierge
 * stage (plan agent-first-onboarding-2026-07-03, P-001).
 *
 * NO IO in this module. The onboarding concierge (onboard-launcher.mjs, P-002)
 * polls the detection endpoints (`/api/desktop/setup-status` + credentials),
 * builds an {@link OnboardingSnapshot}, and asks this module "what stage am I
 * in?". Keeping the resolver pure makes every transition unit-testable and the
 * whole flow resumable for free: quit at any point, relaunch, re-detect, land
 * in the same stage — no onboarding state machine persisted anywhere.
 *
 * Stage order (first-run):
 *   pick → install → login → embeddings → handoff → (setup:complete) → done
 *
 * The embeddings key (mem0 memory) is a REQUIRED step (owner 2026-07-06): a
 * machine is only `done` when it BOTH graduated (setup_wizard_state.finished_at)
 * AND has an OpenAI embeddings key. A user may still SKIP the key to finish the
 * rest of setup (the concierge honors `embeddingsSkipped` this session), but the
 * machine then reads as INCOMPLETE — the concierge/`papercusp setup` re-offer it
 * and psu nags on every launch — until a key is added.
 */

export type OnboardingFramework = 'claude' | 'codex' | 'omp';

/** Display labels for the concierge picker. */
export const FRAMEWORK_LABELS: Record<OnboardingFramework, string> = {
  claude: 'Claude Code',
  codex: 'Codex (OpenAI)',
  omp: 'oh-my-pi (omp)',
};

/** Auto-skip preference order (pre-detection): first ready framework wins. */
export const FRAMEWORK_PREFERENCE: readonly OnboardingFramework[] = [
  'claude',
  'codex',
  'omp',
];

export interface OnboardingSnapshot {
  claudeInstalled: boolean;
  codexInstalled: boolean;
  ompInstalled: boolean;
  claudeSignedIn: boolean;
  codexSignedIn: boolean;
  /** omp path auth = provider auth.json present (agent-auth-detect.ompSignedIn). */
  ompSignedIn: boolean;
  /** OpenAI embeddings key present in the credentials store (openai_api_key). */
  embeddingsKeyPresent: boolean;
  /** `setup_wizard_state.finished_at` set — onboarding already graduated. */
  setupFinished: boolean;
}

export type OnboardingStage =
  /** Onboarding already graduated — the concierge should not run (tutorial-only mode still may). */
  | { stage: 'done' }
  /** No usable backend chosen/ready — show the framework picker. */
  | { stage: 'pick'; frameworks: OnboardingFramework[]; detected: OnboardingFramework[] }
  /** Chosen framework not (fully) installed — run its guided install. */
  | { stage: 'install'; framework: OnboardingFramework }
  /** Installed but not signed in — run its login flow. */
  | { stage: 'login'; framework: OnboardingFramework }
  /** Signed in; offer the (skippable) OpenAI embeddings key step. */
  | { stage: 'embeddings'; framework: OnboardingFramework }
  /** Everything ready — exec the agent with the tutor launch-context. */
  | { stage: 'handoff'; framework: OnboardingFramework };

/**
 * Onboarding frameworks are the standalone CLI agents (Claude Code / Codex /
 * oh-my-pi) on every OS. All three are installable cross-platform now (omp via
 * a direct GitHub-release download — see buildFrameworkInstallSpec), so the set
 * no longer varies by OS. The `os` param is retained for signature stability
 * (callers thread `process.platform`).
 */
export function allowedFrameworks(os: string): OnboardingFramework[] {
  void os;
  return [...FRAMEWORK_PREFERENCE];
}

/** A framework is INSTALLED when its full path exists. */
export function frameworkInstalled(f: OnboardingFramework, s: OnboardingSnapshot): boolean {
  switch (f) {
    case 'claude':
      return s.claudeInstalled;
    case 'codex':
      return s.codexInstalled;
    case 'omp':
      return s.ompInstalled;
  }
}

export function frameworkSignedIn(f: OnboardingFramework, s: OnboardingSnapshot): boolean {
  switch (f) {
    case 'claude':
      return s.claudeSignedIn;
    case 'codex':
      return s.codexSignedIn;
    case 'omp':
      return s.ompSignedIn;
  }
}

export interface ResolveOpts {
  /** The user's picked framework (null/undefined before the picker has run). */
  chosen?: OnboardingFramework | null;
  /** The user explicitly declined the pre-detection auto-skip ("no, let me pick"). */
  forcePick?: boolean;
  /** The user skipped the optional embeddings-key step this session. */
  embeddingsSkipped?: boolean;
  /** `process.platform` of the host (default: 'linux'). */
  os?: string;
  /**
   * Tutorial re-entry (`papercusp tutorial` / the Papercusp Tutorial icon,
   * P-014): a FINISHED machine proceeds to handoff (mode=tutorial) instead of
   * `done`, and the embeddings nag never re-fires. An UNfinished machine
   * still walks pick→install→login first — the tutorial needs a working
   * agent backend either way.
   */
  tutorial?: boolean;
}

/**
 * Resolve the concierge stage from a detection snapshot.
 *
 * Pre-detection (no `chosen` yet): if some framework is already installed AND
 * signed in, resolution jumps straight past pick/install/login for it — the
 * concierge surfaces that as "Found Claude Code installed and signed in — use
 * it?" and passes `forcePick: true` if the user declines.
 */
/**
 * Are all REQUIRED setup steps satisfied? A backend installed + signed in, and
 * the embeddings key present. Pure — the single source of truth for "setup is
 * complete" across the concierge, the `papercusp setup` checklist, and the psu
 * launch nudge. (`setupFinished` is graduation — the app boots normally — which
 * is a WEAKER bar than this: a user can graduate having skipped the key.)
 */
export function requiredSetupComplete(s: OnboardingSnapshot): boolean {
  const anyReady =
    (s.claudeInstalled && s.claudeSignedIn) ||
    (s.codexInstalled && s.codexSignedIn) ||
    (s.ompInstalled && s.ompSignedIn);
  return Boolean(anyReady && s.embeddingsKeyPresent);
}

export function resolveStage(s: OnboardingSnapshot, opts: ResolveOpts = {}): OnboardingStage {
  const os = opts.os ?? 'linux';
  const frameworks = allowedFrameworks(os);
  // `done` requires BOTH graduation AND the required embeddings key — a machine
  // that graduated with the key skipped falls through here and re-resolves to the
  // `embeddings` stage, so the concierge re-offers it and psu keeps nagging until
  // a key is present. Tutorial re-entry (opts.tutorial) never gates on the key.
  if (s.setupFinished && s.embeddingsKeyPresent && !opts.tutorial) return { stage: 'done' };

  const chosen = opts.chosen && frameworks.includes(opts.chosen) ? opts.chosen : null;
  if (!chosen) {
    if (!opts.forcePick) {
      const ready = frameworks.find(
        (f) => frameworkInstalled(f, s) && frameworkSignedIn(f, s),
      );
      if (ready) return afterAuth(ready, s, opts);
    }
    return {
      stage: 'pick',
      frameworks,
      detected: frameworks.filter((f) => frameworkInstalled(f, s)),
    };
  }

  if (!frameworkInstalled(chosen, s)) return { stage: 'install', framework: chosen };
  if (!frameworkSignedIn(chosen, s)) return { stage: 'login', framework: chosen };
  return afterAuth(chosen, s, opts);
}

function afterAuth(
  f: OnboardingFramework,
  s: OnboardingSnapshot,
  opts: ResolveOpts,
): OnboardingStage {
  if (!s.embeddingsKeyPresent && !opts.embeddingsSkipped && !opts.tutorial) {
    return { stage: 'embeddings', framework: f };
  }
  return { stage: 'handoff', framework: f };
}
