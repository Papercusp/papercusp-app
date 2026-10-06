'use client';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { usePathname, useSearchParams } from '@/lib/router-compat/navigation';
import { animate, stagger } from 'motion';
import { useReducedMotion } from 'motion/react';
import { reconcileVisualEffectsMode, useFancyEffectsEnabled } from '@/lib/visual-effects';
import { reconcileActiveTheme } from '@/lib/theme';
import { reconcileShortcutOverrides } from '@papercusp/operator-core/lib/shortcut-registry';
import { GITHUB_REPO_URL } from '@papercusp/operator-core/lib/canonical-github-identity';
import { BrainMark, ResMark } from './ChromeNavMarks';
import { AriaLiveRegions } from './voice/AriaLiveRegions';
import { VoiceLeaderBootstrap } from './voice/VoiceLeaderBootstrap';
import { HostCheckBanner } from './HostCheckBanner';
import { DesktopSupervisorBanner } from './DesktopSupervisorBanner';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import ThemeSelector from './ThemeSelector';
import BrandSwitcher from './BrandSwitcher';
import UserPicker from './UserPicker';
import AutoLoginWelcomeToast from './AutoLoginWelcomeToast';
import UpdateChip from './UpdateChip';
import { NotificationCenter } from './NotificationCenter';
import { RecentActionsCenter } from './RecentActionsCenter';
import { AnimatedPapercuspCup } from './AnimatedPapercuspCup';
import RouteLink from './RouteLink';
import { PuiLauncherButton } from './PuiLauncherButton';
import { PLAN_DASHBOARD_PARAM } from './plans/PlanDashboardHost';
// ConsoleLauncherButton is intentionally NOT imported: the global "+" terminal
// launcher was removed from the navbar on 2026-07-26 (owner ask — see the note
// in pc-header-center). The component itself is kept for restoration.
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { useLexicon } from '@/lib/useLexicon';
import { isChromeShellNavActive } from './chrome-shell-nav';
import { isChromelessPath, isPortalEmbedLocation } from '@papercusp/operator-core/lib/chromeless-routes';
// OracleDock + TutorialButton remain RETIRED (design-simplification-2026-07-09
// P-003; see _retired/legacy-web-chats/RESTORE.md). OperatorChatSidebar was
// retired with them but is REVIVED as the app's PRIMARY chat surface
// (operator-chat-sidebar-revival-2026-07-13, owner decision — the zellij pui
// dock is now the TESTING-gated dev path instead). The chat must appear on
// first paint, not pop in seconds later: import it eagerly so it ships in the
// main bundle and mounts immediately — a lazy() chunk fetch (or, in the Tauri
// dev shell, an on-demand compile of that chunk) is exactly what caused the
// visible delay before. The docks below stay lazy/idle-deferred.
import { OperatorChatSidebar } from './OperatorChatSidebar';
import type { OpChatFace } from './op-chat-faces';

// Heavy dock components — they run polling, subscriptions, and large
// useEffects on mount. Not needed for first paint of any page; defer to
// idle so the page becomes interactive faster.
const VoiceAppBridge = lazy(() => import('./voice/VoiceAppBridge').then(m => ({ default: m.VoiceAppBridge })));
const OperatorDelegationListener = lazy(() => import('./OperatorDelegationListener'));
const RegistryShortcuts = lazy(() => import('../../lib/commands/shims/shortcut-shim').then(m => ({ default: m.RegistryShortcuts })));
const OperatorVoiceAnnouncer = lazy(() => import('./voice/OperatorVoiceAnnouncer').then(m => ({ default: m.OperatorVoiceAnnouncer })));
// Eager import: ChatwootWidget is tiny (one useEffect + script tag) and was
// repeatedly failing as a chunked lazy import in dev (turbopack chunk-hash
// staleness across rebuilds). The bundle cost is negligible.
import { ChatwootWidget } from './ChatwootWidget';

/**
 * Renders the operator's global chrome (header, Oracle dock, hidden
 * Chatwoot SDK bridge, host-check banner) ONLY for routes that aren't
 * designed to be embedded in iframes.
 *
 * Why this exists: operator routes like `/pi` and `/project-docs` are
 * mounted inside iframes by harness plugin tabs (pi-coding, starlight).
 * The chrome belongs in the parent harness page, not inside the iframe.
 * Previously the chrome rendered for every route and was hidden via a
 * useEffect-applied body class — that caused a flash of header/dock
 * before the JS ran, and for `/project-docs` the body class was never
 * applied so the chrome leaked permanently.
 *
 * `usePathname()` returns the pathname during SSR for client components,
 * so this skip is server-rendered: the chrome never appears in the HTML
 * for iframe routes, eliminating the flash entirely.
 *
 * Keep route presentation in the shared operator-core predicate so focused
 * portal routes cannot render global chrome by accident.
 */
// GSAP intro-easing equivalent (power3.out ≈ quart-out).
const INTRO_EASE: [number, number, number, number] = [0.165, 0.84, 0.44, 1];

const HEADER_QUOTE = 'Nothing Is So Painful To The Human Mind As A Great And Sudden Change';
const HEADER_QUOTE_DELAY_MS = 950;
const HEADER_QUOTE_CHARACTER_MS = 24;
/** Compact against the header's REAL content box, not window.innerWidth. The
 * docked chat/steering/dev rails can leave less than this at a 1440px desktop,
 * while Tauri's native minWidth=800 makes the old viewport-only 760px branch
 * unreachable at the shell minimum. */
const COMPACT_HEADER_MAX_WIDTH = 760;

function AnimatedHeaderQuote({ animateQuote }: { animateQuote: boolean }) {
  const [text, setText] = useState(() => (animateQuote ? '' : HEADER_QUOTE));
  const [settled, setSettled] = useState(() => !animateQuote);

  useEffect(() => {
    if (!animateQuote) {
      setText(HEADER_QUOTE);
      setSettled(true);
      return;
    }

    let characterIndex = 0;
    let timer: number | undefined;
    setText('');
    setSettled(false);

    const typeNextCharacter = () => {
      characterIndex += 1;
      setText(HEADER_QUOTE.slice(0, characterIndex));

      if (characterIndex < HEADER_QUOTE.length) {
        timer = window.setTimeout(typeNextCharacter, HEADER_QUOTE_CHARACTER_MS);
      } else {
        setSettled(true);
      }
    };

    timer = window.setTimeout(typeNextCharacter, HEADER_QUOTE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [animateQuote]);

  return (
    <span
      className={`pc-header-quote pc-header-quote--hud${settled ? ' is-settled' : ''}${animateQuote ? '' : ' is-static'}`}
      aria-hidden="true"
    >
      <span className="pc-header-quote-text">{text}</span>
      <span className="pc-header-quote-caret" />
    </span>
  );
}

/**
 * @param chatFaces EXTRA faces for the Papercup chat sidebar's header row —
 *   the Fleet + Peers panes (WI-5162), which live under operator-vite/src and
 *   cannot be imported up-layer from this tree. The Vite SPA root composes them
 *   and passes them through here to OperatorChatSidebar; see op-chat-faces.ts.
 */
export default function ChromeShell({ chatFaces }: { chatFaces?: readonly OpChatFace[] } = {}) {
  const headerRef = useRef<HTMLElement | null>(null);
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const reducedMotion = useReducedMotion() ?? false;
  const visualEffectsEnabled = useFancyEffectsEnabled();
  const fancyEffectsEnabled = visualEffectsEnabled && !reducedMotion;
  const chromeless = isChromelessPath(pathname);
  const portalEmbed = isPortalEmbedLocation(pathname, searchParams.toString());
  // When the user is already on the ordinary /adv surface, the Ops CTA is a
  // no-op. A plan dashboard is a query-param takeover that deliberately keeps
  // /adv mounted underneath, so Ops must remain a link there: navigating to
  // bare /adv closes the takeover instead of stranding the user behind it.
  const onAdv = isChromeShellNavActive(pathname, '/adv');
  const opsIsCurrent = onAdv && !searchParams.has(PLAN_DASHBOARD_PARAM);
  const onRes = isChromeShellNavActive(pathname, '/res');
  const testingFlag = useFlag(FLAGS.TESTING);
  const resFlag = useFlag(FLAGS.RES_ALLOCATION);
  const operatorChatSidebarFlag = useFlag(FLAGS.OPERATOR_CHAT_SIDEBAR);
  const t = useLexicon();
  const mainNavJumpGateProps = { 'data-route-transition-intent': 'jump-gate' as const };
  const navLinkProps = (href: string) => {
    const active = isChromeShellNavActive(pathname, href);
    return active
      ? { ...mainNavJumpGateProps, className: 'pc-header-nav-link active', 'aria-current': 'page' as const }
      : { ...mainNavJumpGateProps, className: 'pc-header-nav-link' };
  };

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (chromeless || !header) return;

    const syncCompactState = (width: number) => {
      // jsdom and a detached first measurement can report zero. Wait for the
      // observer's first real box rather than falsely compacting on no data.
      if (width <= 0) return;
      header.classList.toggle(
        'pc-header--compact',
        width <= COMPACT_HEADER_MAX_WIDTH,
      );
    };
    syncCompactState(header.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      return () => header.classList.remove('pc-header--compact');
    }
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const ownEntry = entries.find((entry) => entry.target === header);
      const width = ownEntry?.contentRect.width ?? header.getBoundingClientRect().width;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      // Compact mode changes the observed header's height. Mutate after
      // observer delivery so that change cannot trigger a resize-loop error.
      resizeFrame = requestAnimationFrame(() => { resizeFrame = null; syncCompactState(width); });
    });
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      header.classList.remove('pc-header--compact');
    };
  }, [chromeless]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || !fancyEffectsEnabled) return;

    // Entrance intro via motion's WAAPI-backed animate (gsap removed per the
    // perf-docs animation table). The hud lines animate OPACITY only. That used
    // to be forced on us — their `transform` was owned by infinite CSS sweep
    // keyframes that beat inline styles, so the old gsap scaleX leg never
    // visibly rendered. Those sweeps were removed in WI-6530 (an always-on
    // animation holds the 60fps repaint loop open and cost ~40% of a CPU core),
    // so the constraint is gone — but keep this a one-shot entrance either way:
    // anything that runs forever here re-arms exactly the cost WI-6530 removed.
    const items = header.querySelectorAll<HTMLElement>(
      '.pc-header-left > *, .pc-header-center > *, .pc-header-right > *',
    );
    const hudLines = header.querySelectorAll<HTMLElement>('.pc-header-hud-line');
    const controls = [
      items.length
        ? animate(
            items,
            { opacity: [0, 1], y: [-14, 0] },
            { duration: 0.42, ease: INTRO_EASE, delay: stagger(0.035) },
          )
        : null,
      hudLines.length
        ? animate(
            hudLines,
            { opacity: [0.18, 1] },
            { duration: 0.64, ease: INTRO_EASE, delay: stagger(0.08, { startDelay: 0.06 }) },
          )
        : null,
    ];

    // Idle/ambient header HUD line sweeps are driven by CSS @keyframes.
    // Keeping the intro one-shot (no rAF loops) takes ~282 DOM-attribute
    // mutations per 5s off the main thread on every page ChromeShell renders.

    return () => {
      for (const c of controls) c?.stop();
    };
  }, [pathname, fancyEffectsEnabled]);

  // Reconcile browser-presentation prefs from PG once on mount. The host
  // pre-paints theme + visual-effects from PG (bin/host-spa.ts); this adopts
  // any drift — changed in another window, or this device's localStorage cache
  // lost/stale — now that these prefs are PG-backed, not localStorage-only.
  // Placed before the chromeless early-return so hook order stays stable.
  useEffect(() => {
    if (portalEmbed) return;
    void reconcileActiveTheme();
    void reconcileVisualEffectsMode();
    void reconcileShortcutOverrides();
  }, [portalEmbed]);

  if (chromeless) return null;
  // A portal-embedded /adv is a CONTENT-ONLY document (owner ask 2026-09-01):
  // the cloud portal hosts the Papercup chat as its own outer sidebar (framed
  // from /portal-panes/chat), so mounting it here again would put two chats
  // side by side. Only the a11y live regions the tab bodies announce into.
  if (portalEmbed) return <AriaLiveRegions />;

  return (
    <>
      <header ref={headerRef} className="pc-header pc-header--maximal-hud">
        <span className="pc-header-hud-line pc-header-hud-line--primary" aria-hidden="true" />
        <span className="pc-header-hud-line pc-header-hud-line--secondary" aria-hidden="true" />
        {/*
          Three-region grid: left = brand + quote, centre = primary CTAs
          (Adv, Ops, Deck, auto-scan), right = nav. CSS Grid
          in `1fr auto 1fr` keeps the centre cluster geometrically centred
          in the viewport regardless of how wide the brand/quote on the left
          and the nav on the right grow.
        */}
        <div className="pc-header-left">
          <RouteLink href="/" className="brand pc-header-brand-wrap" aria-label="papercusp" {...mainNavJumpGateProps}>
            <AnimatedPapercuspCup />
          </RouteLink>
          <AnimatedHeaderQuote animateQuote={fancyEffectsEnabled} />
        </div>
        <div className="pc-header-center">
          {opsIsCurrent ? (
            <span
              className="pc-header-cta pc-header-cta--mission is-current"
              aria-label="Ops (current page)"
              aria-current="page"
            >
              <span className="pc-header-cta-orb" aria-hidden="true">
                <BrainMark className="pc-header-cta-logo pc-header-cta-logo--adv" />
              </span>
              <span className="pc-header-cta-label">OPS</span>
            </span>
          ) : (
            <RouteLink href="/adv" className="pc-header-cta pc-header-cta--mission" aria-label="Ops" {...mainNavJumpGateProps}>
              <span className="pc-header-cta-orb" aria-hidden="true">
                <BrainMark className="pc-header-cta-logo pc-header-cta-logo--adv" />
              </span>
              <span className="pc-header-cta-label">OPS</span>
            </RouteLink>
          )}
          {/* RES — the workspace-scoped Resources section: hand account pools +
              local GPUs to the fleets in the hive tree. Sits next to OPS.
              A TESTING-only surface (owner ask 2026-07-07): gated behind
              FLAGS.TESTING (default off) IN ADDITION to FLAGS.RES_ALLOCATION
              (which also gates the /res route), so the button hides in normal
              use and only appears when the testing flag is on. */}
          {testingFlag && resFlag ? (
            onRes ? (
              <span
                className="pc-header-cta pc-header-cta--mission is-current"
                aria-label="Resources (current page)"
                aria-current="page"
              >
                <span className="pc-header-cta-orb" aria-hidden="true">
                  <ResMark className="pc-header-cta-logo" />
                </span>
                <span className="pc-header-cta-label">RES</span>
              </span>
            ) : (
              <RouteLink href="/res" className="pc-header-cta pc-header-cta--mission" aria-label="Resources" {...mainNavJumpGateProps}>
                <span className="pc-header-cta-orb" aria-hidden="true">
                  <ResMark className="pc-header-cta-logo" />
                </span>
                <span className="pc-header-cta-label">RES</span>
              </RouteLink>
            )
          ) : null}
          {/* Terminal-launch CTA: opens the pui workbench (apps/tui) in an OS
              terminal via a server-side spawn. Sits next to OPS. (Brief 26)
              A TESTING-only surface (owner ask 2026-07-07): gated behind
              FLAGS.TESTING (default off), so it only appears when the testing
              flag is on. */}
          {testingFlag ? <PuiLauncherButton /> : null}
          {/* REMOVED 2026-07-26 (owner ask, hud-session-launcher-and-board-tabs
              P-001): the global "+" terminal launcher (ConsoleLauncherButton)
              no longer renders here — "now that we have this hud page remove the
              new terminal button next to the OPS button". The HUD page's own
              session launcher supersedes it.

              The COMPONENT is deliberately kept (not deleted): it was added at
              owner request under WI-3093 ("I don't see the psu button in the
              Windows app") and still carries the psu affordance behind the
              owner-authority PSU_END_USER flag, plus the
              window.__papercupLaunchTerminal devtools trigger. Re-render it here
              to restore. NOTE the sibling PuiLauncherButton above also opens a
              terminal, but is FLAGS.TESTING-gated and therefore normally
              invisible, so this "+" is the button that actually sat next to
              OPS. */}
          {/* The Start/Pause-Hive control (start-hive-wake P-006) lives in the
              AdvShell harness bar (AdvNowRunning), not here. */}
        </div>
        <nav className="pc-header-right" aria-label="Primary navigation">
          {/* Visible text is "Workspaces", NOT "Cloud" (owner directive #79,
              2026-09-22: "I still don't see a way to create a workspace").
              The route, the link and its ChromeShell.test.tsx assertion all
              already existed — the only thing missing was the WORD the owner
              was scanning the navbar for, which lived solely in the
              aria-label. A nav label has to carry the noun the user is
              hunting; "Cloud" names the implementation, "Workspaces" names
              the thing. aria-label stays "Cloud Workspaces" so the accessible
              name is unchanged and the existing test still pins it. */}
          <RouteLink href="/cloud-workspaces" aria-label="Cloud Workspaces" {...navLinkProps('/cloud-workspaces')}>Workspaces</RouteLink>
          {testingFlag ? (
            <RouteLink href="/installed/plugins" {...navLinkProps('/installed/plugins')}>Plugins</RouteLink>
          ) : null}
          {/* Rubrics moved OFF the top navbar into the /adv "Learning" tab (owner
              ask 2026-07-10): the navbar link pointed at /rubrics, a route the
              live Vite operator never registered, so it errored. Rubrics &
              scorecards now live in Learning → Verify → Rubrics (AdvShell). */}
          <RouteLink href="/support" {...navLinkProps('/support')}>Support</RouteLink>
          <RouteLink href="/settings/operator" {...navLinkProps('/settings/operator')}>Settings</RouteLink>
          {/* Admin link intentionally NOT rendered — reachable only by URL /admin */}
          {(() => {
            const p = navLinkProps('/dev');
            return <RouteLink href="/dev" {...p} className={`${p.className} is-dev`}>DEV</RouteLink>;
          })()}
          <RouteLink href="/cupboard" {...navLinkProps('/cupboard')}>{t('cupboard')}</RouteLink>
          <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className="pc-header-nav-link">GitHub</a>
          <UpdateChip />
          <NotificationCenter />
          <RecentActionsCenter />
          <ThemeSelector />
          {/* Lexicon/brand switcher (Papercup ⇄ The Swarm) is a TESTING-only
              surface — public release ships the Pot lexicon with no toggle, to
              avoid brand confusion between users. restore-pot-lexicon P-004. */}
          {testingFlag ? <BrandSwitcher /> : null}
          <WorkspaceSwitcher />
          <UserPicker />
        </nav>
      </header>
      <HostCheckBanner />
      <DesktopSupervisorBanner />
      <VoiceLeaderBootstrap />
      <AriaLiveRegions />
      <AutoLoginWelcomeToast />
      {/* Operator chat sidebar — fixed left, full-height, on every
          non-chromeless page (operator-chat-sidebar-revival-2026-07-13).
          The sidebar shifts the rest of the app right via body.has-op-chat
          padding-left, set INSIDE the component at mount and removed on
          unmount — there is deliberately no pre-paint reservation (D-017:
          flags are unknowable pre-paint), so a one-frame shift on first
          paint is the accepted cost. Iframe-target routes (CHROMELESS
          prefixes) skip ChromeShell entirely so the sidebar is absent
          there too — desired, those routes are embedded inside other
          pages that already host the sidebar. */}
      {operatorChatSidebarFlag && <OperatorChatSidebar faces={chatFaces} />}
      {!pathname.startsWith('/settings') && <DeferredDocks />}
    </>
  );
}

// Mounts the heavy dock components AFTER the page has had a chance to
// paint and become interactive. Uses requestIdleCallback (or a 200ms
// fallback) so first-meaningful-paint isn't blocked by their useEffect
// chains, polling, and event-listener registration.
function DeferredDocks() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number);
    let idleId: number | undefined;
    // Race requestIdleCallback against a 1500ms backstop. Without the
    // backstop, a busy page (HMR storms in dev, large-app cold paint)
    // can starve idle entirely — the dock never mounts. The backstop
    // also covers Safari/older browsers where requestIdleCallback is
    // missing. The first to fire wins; the loser is canceled.
    const backstop = setTimeout(() => {
      setReady(true);
      if (idleId !== undefined) {
        const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
        cancel?.(idleId);
      }
    }, 1500);
    if (idle) {
      idleId = idle(() => {
        setReady(true);
        clearTimeout(backstop);
      }, { timeout: 1500 });
    }
    return () => {
      clearTimeout(backstop);
      if (idleId !== undefined) {
        const cancel = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
        cancel?.(idleId);
      }
    };
  }, []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <ChatwootWidget />
      <VoiceAppBridge />
      <OperatorDelegationListener />
      <OperatorVoiceAnnouncer />
      <RegistryShortcuts />
    </Suspense>
  );
}
