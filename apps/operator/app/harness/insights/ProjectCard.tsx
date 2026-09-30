'use client';

/**
 * ProjectCard — Phase 8 P-073a.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 Insights tab — project card.
 *
 * Tier-A static card: name, description, owner (with claimed/unclaimed
 * badge per addendum 1), license, languages (top 3), GitHub link,
 * optional Discord link (§11).
 *
 * Pure UI; the caller supplies the rendered values (the substrate
 * aggregations + harness config feed these).
 */

import type { CSSProperties, ReactNode } from 'react';
import { ClaimStatusBadge } from '../../_components/ClaimStatusBadge';
import type {
  ProjectCardLanguage,
  ProjectCardProps,
} from '@papercusp/operator-core/lib/harness-insights/card-types';

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

const TITLE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const TITLE: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--fg)',
};

const DESCRIPTION: CSSProperties = {
  color: 'var(--fg-dim)',
  fontSize: 13,
  lineHeight: 1.5,
};

const META_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr',
  rowGap: 6,
  columnGap: 12,
  fontSize: 13,
};

const META_LABEL: CSSProperties = {
  color: 'var(--fg-dim)',
};

const META_VALUE: CSSProperties = {
  color: 'var(--fg)',
};

const LANG_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 12,
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  marginRight: 4,
};

const LANG_DOT: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 4,
  flexShrink: 0,
};

const TOPICS_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const TOPIC_PILL: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 12,
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
};

const LINK_ROW: CSSProperties = {
  display: 'flex',
  gap: 12,
  fontSize: 13,
};

const LINK: CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'none',
};

const STATS_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 14,
  fontSize: 12,
  color: 'var(--fg-dim)',
};

/** Coarse "x ago" for the repo's last-push timestamp. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: Array<[number, string]> = [
    [86400 * 365, 'y'],
    [86400 * 30, 'mo'],
    [86400 * 7, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [s, label] of units) {
    if (secs >= s) return `${Math.floor(secs / s)}${label} ago`;
  }
  return 'just now';
}

export type { ProjectCardLanguage, ProjectCardProps };

export function ProjectCard(props: ProjectCardProps): ReactNode {
  const {
    name,
    description,
    ownerDisplayName,
    claimStatus,
    claimantLogin,
    license,
    languages,
    githubUrl,
    discordUrl,
    stars,
    forks,
    openIssues,
    lastActivityIso,
    latestRelease,
  } = props;

  const topLanguages = (languages ?? []).slice(0, 3);
  const topics = (props.topics ?? []).slice(0, 8);
  const hasStats =
    typeof stars === 'number' ||
    typeof forks === 'number' ||
    typeof openIssues === 'number' ||
    !!lastActivityIso ||
    !!latestRelease;

  return (
    <div style={CARD} data-testid="insights-project-card">
      <div style={TITLE_ROW}>
        <div style={TITLE}>{name}</div>
        <ClaimStatusBadge
          status={claimStatus}
          claimantLogin={claimantLogin}
        />
      </div>

      <div style={DESCRIPTION}>{description}</div>

      <div style={META_GRID}>
        <div style={META_LABEL}>Owner</div>
        <div style={META_VALUE}>@{ownerDisplayName}</div>

        {license ? (
          <>
            <div style={META_LABEL}>License</div>
            <div style={META_VALUE}>{license}</div>
          </>
        ) : null}

        {topLanguages.length > 0 ? (
          <>
            <div style={META_LABEL}>Languages</div>
            <div style={META_VALUE} data-testid="project-card-languages">
              {topLanguages.map((l) => (
                <span key={l.name} style={LANG_PILL}>
                  <span style={{ ...LANG_DOT, background: l.color }} />
                  {l.name}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {topics.length > 0 ? (
        <div style={TOPICS_ROW} data-testid="project-card-topics">
          {topics.map((t) => (
            <span key={t} style={TOPIC_PILL}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {hasStats ? (
        <div style={STATS_ROW} data-testid="project-card-stats">
          {typeof stars === 'number' ? (
            <span title="GitHub stars">★ {stars.toLocaleString()}</span>
          ) : null}
          {typeof forks === 'number' ? (
            <span title="Forks">⑂ {forks.toLocaleString()}</span>
          ) : null}
          {typeof openIssues === 'number' ? (
            <span title="Open issues">{openIssues.toLocaleString()} open issues</span>
          ) : null}
          {lastActivityIso ? (
            <span title={lastActivityIso}>Updated {relativeTime(lastActivityIso)}</span>
          ) : null}
          {latestRelease ? (
            <span
              title={
                latestRelease.publishedAtIso
                  ? `Released ${latestRelease.publishedAtIso}`
                  : 'Latest release'
              }
              data-testid="project-card-release"
            >
              🏷 {latestRelease.tag}
              {latestRelease.publishedAtIso
                ? ` · ${relativeTime(latestRelease.publishedAtIso)}`
                : ''}
            </span>
          ) : null}
        </div>
      ) : null}

      <div style={LINK_ROW}>
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          style={LINK}
          data-testid="project-card-github-link"
        >
          GitHub →
        </a>
        {discordUrl ? (
          <a
            href={discordUrl}
            target="_blank"
            rel="noreferrer"
            style={LINK}
            data-testid="project-card-discord-link"
          >
            Discord →
          </a>
        ) : null}
      </div>
    </div>
  );
}
