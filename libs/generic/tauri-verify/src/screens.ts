/** Semantic Papercusp screens backed by routes and selectors that exist in the live Tauri SPA. */
import type { RouteInfo, Screen } from './types.js';

function defineScreen(screen: Screen): Screen {
  return screen;
}

export const SCREENS = {
  ONBOARDING: defineScreen({
    id: 'onboarding',
    name: 'Onboarding Console',
    href: '/onboarding',
    route: { pathname: '/onboarding' },
    requiredElements: ['.pc-onboarding-shell', '.pc-onboarding-console'],
  }),
  SETUP: defineScreen({
    id: 'setup',
    name: 'Setup Wizard',
    href: '/setup',
    route: { pathname: '/setup' },
    requiredElements: ['.pc-setup-shell'],
  }),
  WORKING: defineScreen({
    id: 'working',
    // Screen NAME follows the UI label (renamed Working → Work, owner ask
    // 2026-07-26); the screen id stays 'working' — callers key off it.
    name: 'Work',
    href: '/adv?tab=harnesses',
    route: { pathname: '/adv', query: { tab: 'harnesses' } },
    requiredElements: ['.pc-advshell', '.pc-advshell__tab--harnesses[data-state="active"]'],
  }),
  LEARNING: defineScreen({
    id: 'learning',
    name: 'Learning',
    href: '/adv?tab=learning',
    route: { pathname: '/adv', query: { tab: 'learning' } },
    requiredElements: ['.pc-advshell', '.pc-advshell__tab--learning[data-state="active"]'],
  }),
  ADVANCED: defineScreen({
    id: 'advanced',
    name: 'Advanced Surface',
    href: '/adv',
    route: { pathname: '/adv' },
    requiredElements: ['.pc-advshell'],
  }),
  SETTINGS: defineScreen({
    id: 'settings',
    name: 'Settings',
    href: '/settings/profile',
    route: { pathname: /^\/settings(?:\/|$)/ },
    requiredElements: ['.pc-settings-shell'],
  }),
  ADMIN: defineScreen({
    id: 'admin',
    name: 'Admin',
    href: '/admin/run',
    route: { pathname: /^\/admin(?:\/|$)/ },
    requiredElements: ['.pc-adminshell'],
  }),
  QUICK_PANEL: defineScreen({
    id: 'quick-panel',
    name: 'Quick Panel',
    href: '/quick-panel',
    route: { pathname: '/quick-panel' },
    requiredElements: ['.pc-qp', '.pc-qp__tabs'],
  }),
  FLEET_STATUS: defineScreen({
    id: 'fleet-status',
    name: 'Fleet Status',
    href: '/fleet-status',
    route: { pathname: '/fleet-status' },
    requiredElements: ['.pc-fleet-status'],
  }),
  WEATHER: defineScreen({
    id: 'weather',
    name: 'Weather',
    href: '/weather',
    route: { pathname: '/weather' },
    requiredElements: ['.pc-weather-widget'],
  }),
} as const;

function testPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') return value === pattern;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function screenMatchesRoute(screen: Screen, route: RouteInfo): boolean {
  if (!testPattern(route.pathname, screen.route.pathname)) return false;
  const query = new URLSearchParams(route.search);
  for (const [key, expected] of Object.entries(screen.route.query ?? {})) {
    if (!testPattern(query.get(key) ?? '', expected)) return false;
  }
  return true;
}

export function findScreen(id: string): Screen | undefined {
  return Object.values(SCREENS).find((screen) => screen.id === id);
}

/** Specific query-bound screens are declared before their generic parent, so they win. */
export function findScreenByRoute(route: RouteInfo | string): Screen | undefined {
  const info: RouteInfo =
    typeof route === 'string'
      ? (() => {
          const url = new URL(route, 'http://tauri.local');
          return { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash };
        })()
      : route;
  return Object.values(SCREENS).find((screen) => screenMatchesRoute(screen, info));
}

export function getAllScreens(): Screen[] {
  return Object.values(SCREENS);
}
