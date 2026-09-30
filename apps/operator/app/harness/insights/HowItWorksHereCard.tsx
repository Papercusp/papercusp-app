'use client';

/**
 * HowItWorksHereCard — Phase 8 P-073e.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 Insights tab — onboarding-flavored card.
 *
 * Templated prose explaining the harness's specific workflow:
 *
 *   1. queue → claim (orchestrator) | manual pick
 *   2. PR open → auto-review (if enabled) → auto-merge (if enabled)
 *   3. shipped
 *
 * Customizations rendered from the harness config:
 *   - pr_reviewer_role_enabled / auto_review / auto_merge / merge_method
 *   - has_orchestrator (claims pick automatically vs manual)
 *   - branch_policy ('feature-branch' | 'main-fast-forward' | ...)
 *
 * Optional `customWelcome` paragraph — provisional owner / claimant
 * can override the templated intro (planned v2 of this card per Q-3).
 *
 * Pure UI. The card composes a stable list of steps + bullets so the
 * caller's template choices flow through.
 */

import type { CSSProperties, ReactNode } from 'react';
import type {
  BranchPolicy,
  HowItWorksHereConfig,
  HowItWorksHereCardProps,
} from '@papercusp/operator-core/lib/harness-insights/card-types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Bound the rendered README so a giant one can't blow up the card's DOM. */
const README_MAX_CHARS = 12_000;

const CARD: CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-1)',
  borderRadius: 8,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 14,
};

const TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg)',
};

const PROSE: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--fg-dim)',
};

const STEPS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 4,
};

const STEP: CSSProperties = {
  display: 'flex',
  gap: 10,
  fontSize: 13,
};

const STEP_NUM: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 999,
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 600,
  flexShrink: 0,
};

const STEP_BODY: CSSProperties = {
  color: 'var(--fg)',
  lineHeight: 1.5,
};

const STEP_SUB: CSSProperties = {
  marginTop: 2,
  fontSize: 12,
  color: 'var(--fg-dim)',
};

const README_SECTION: CSSProperties = {
  marginTop: 4,
  borderTop: '1px solid var(--border)',
  paddingTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const README_BODY: CSSProperties = {
  maxHeight: 360,
  overflowY: 'auto',
  fontSize: 12.5,
  lineHeight: 1.55,
  color: 'var(--fg-dim)',
  wordBreak: 'break-word',
};

export type { BranchPolicy, HowItWorksHereConfig, HowItWorksHereCardProps };

function describeClaim(cfg: HowItWorksHereConfig): string {
  if (cfg.has_orchestrator) {
    return 'A new feature gets queued, then the orchestrator picks it for the first available contributor.';
  }
  return 'A new feature gets queued. Contributors pick from the queue manually.';
}

function describePR(cfg: HowItWorksHereConfig): {
  body: string;
  sub: string | null;
} {
  if (!cfg.pr_reviewer_role_enabled) {
    return {
      body: 'When the work is ready, the contributor opens a PR. Reviewers approve and merge by hand.',
      sub: null,
    };
  }
  let body =
    'When the work is ready, the contributor opens a PR. PR-reviewer role is enabled.';
  const subBits: string[] = [];
  if (cfg.auto_review) subBits.push('Auto-approve fires for trusted authors.');
  if (cfg.auto_merge) {
    subBits.push(
      `Auto-merge fires after auto-approval (using ${cfg.merge_method}).`,
    );
  }
  if (!cfg.auto_review && !cfg.auto_merge) {
    subBits.push('Auto-actions are off for now; manual approvals only.');
  }
  return { body, sub: subBits.join(' ') };
}

function describeShipped(cfg: HowItWorksHereConfig): string {
  switch (cfg.branch_policy) {
    case 'feature-branch':
      return 'On merge the feature branch is squashed onto main; the feature row flips to shipped.';
    case 'main-fast-forward':
      return 'On merge the change fast-forwards onto main; the feature row flips to shipped.';
    case 'release-branch':
      return 'On merge the change lands on the active release branch; main updates at the next release.';
  }
}

export function HowItWorksHereCard(
  props: HowItWorksHereCardProps,
): ReactNode {
  const { harnessName, config, customWelcome, readme } = props;

  const intro =
    customWelcome ??
    `Here's how work flows in ${harnessName}. Three steps, customized to this harness's config.`;

  const prDesc = describePR(config);

  const readmeMd =
    readme && readme.trim().length > 0
      ? readme.length > README_MAX_CHARS
        ? `${readme.slice(0, README_MAX_CHARS)}\n\n…`
        : readme
      : null;

  return (
    <div style={CARD} data-testid="insights-how-it-works-card">
      <div style={TITLE}>How it works here</div>
      <div style={PROSE} data-testid="how-it-works-intro">
        {intro}
      </div>

      <div style={STEPS}>
        <div style={STEP} data-testid="how-it-works-step-1">
          <div style={STEP_NUM}>1</div>
          <div style={STEP_BODY}>{describeClaim(config)}</div>
        </div>

        <div style={STEP} data-testid="how-it-works-step-2">
          <div style={STEP_NUM}>2</div>
          <div style={STEP_BODY}>
            {prDesc.body}
            {prDesc.sub ? (
              <div style={STEP_SUB} data-testid="how-it-works-step-2-sub">
                {prDesc.sub}
              </div>
            ) : null}
          </div>
        </div>

        <div style={STEP} data-testid="how-it-works-step-3">
          <div style={STEP_NUM}>3</div>
          <div style={STEP_BODY}>{describeShipped(config)}</div>
        </div>
      </div>

      {readmeMd ? (
        <div style={README_SECTION} data-testid="how-it-works-readme">
          <div style={TITLE}>Project README</div>
          <div style={README_BODY} className="pc-readme-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a({ children, href }) {
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {readmeMd}
            </ReactMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}
