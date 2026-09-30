/**
 * universalDomains — testing domains that genuinely apply to ANY project,
 * not just Papercusp. Phase 1 of testing-shell-cross-project-2026-06-01
 * (decision D-007): the set was narrowed to the truly portable domains, and
 * each section names a logical `role` (no hardcoded glob) so a consumer
 * fills the globs for its own repo via {@link applyRoleGlobs}.
 *
 * Renamed from `generalizedRegistry`. `routes` is the one glob/role domain
 * rendered by <DomainTestPanel> via a dataSource. The other universal domains
 * — load (k6), live-web, chaos-web, ai-explore, chaos-desktop — are
 * CUSTOM-PANEL domains: the lib ships their panels and they're wired by
 * {@link buildUniversalTesting} as customTabs, NOT registered via
 * defineTestDomain (un-defers testing-shell-cross-project D-002/D-007;
 * supersedes D-008 — see universal-testing-domains-generic-2026-06-03).
 *
 * PURE DATA — does NOT call defineTestDomain / import React, so this file stays
 * side-effect-free and server-importable via `@papercusp/testing-shell/registry`.
 */

import { type TestDomain, type TestTier } from '../registry';
import { type TabPlatform } from '../platform';

export const universalDomains: TestDomain[] = [
  {
    id: 'routes',
    label: 'Routes',
    description: 'Endpoint test surface — the project’s HTTP/RPC route tests.',
    tier: 'universal',
    sections: [
      {
        id: 'endpoint-tests',
        label: 'Endpoint tests',
        // No baked glob — `role` is the project-resolvable handle. Each
        // consumer supplies its endpoint-test paths via applyRoleGlobs
        // (the operator maps 'endpoints' →
        // apps/operator/lib/endpoint-route/__tests__/**).
        role: 'endpoints',
      },
    ],
  },
];

/**
 * Tab metadata for the universal CUSTOM-PANEL domains — the ones the lib ships
 * a panel for. Pure data (no React) so this stays server-importable; the actual
 * panels + wiring live in `buildUniversalTesting` (registry/universal-tabs.tsx).
 * Each consumer opts a domain in by supplying its config block; presence ⇒ tab.
 */
export interface UniversalPanelDomain {
  id: string;
  label: string;
  description: string;
  tier: TestTier;
  /** Platform variant; omit = agnostic (shown on every platform). */
  platform?: TabPlatform;
}

export const UNIVERSAL_PANEL_DOMAINS: Record<string, UniversalPanelDomain> = {
  load: { id: 'load', label: 'Load (k6)', description: 'smoke / load / stress / spike / soak', tier: 'universal' },
  'live-web': { id: 'live-web', label: 'Live', description: 'in-page console / error / CLS / long-task observer', tier: 'universal' },
  'chaos-web': { id: 'chaos-web', label: 'Chaos (web)', description: 'headless random-clicker over the app', tier: 'universal', platform: 'web' },
  'ai-explore': { id: 'ai-explore', label: 'AI Explore', description: 'Stagehand LLM walk over the app', tier: 'universal', platform: 'web' },
  'chaos-desktop': { id: 'chaos-desktop', label: 'Chaos (desktop)', description: 'in-app perf-recorder clicker (Tauri)', tier: 'universal', platform: 'desktop' },
  llm: { id: 'llm', label: 'LLM', description: 'scenario-driven LLM evaluation (sim-user → SUT → judge)', tier: 'universal' },
};
