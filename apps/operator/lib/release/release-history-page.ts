/**
 * The beta release-history page — static HTML, generated at cut time from the
 * release registry, served from the R2 SECRET PATH alongside the artifacts.
 * (WI-4446. Registry: release-registry.ts. Table: migration 589.)
 *
 * [owner 2026-07-12, on who it is for]
 *   "only the people we share the link with, which will be our beta testers. we
 *    will also want to collect stats on visits to make sure it isnt leaked."
 *
 * That answer decides the whole design:
 *
 * 1. UNLISTED, NOT PUBLIC. It lives under the same secret path segment as the
 *    installers — one secret, one blast radius, and the download links on it are
 *    already under that path. No index, no nav, no robots. Every link on the page
 *    is RELATIVE, so the secret is never written into the HTML.
 *
 * 2. THE ANALYTICS ARE A LEAK DETECTOR, not a vanity counter. The owner's reason
 *    is "to make sure it isnt leaked", so a hit count is useless on its own — a
 *    leak looks like traffic, and traffic is what a beta page is supposed to have.
 *    What names a leak is the REFERRER: a visit arriving from a page we never
 *    shared the link with is the signal. So the beacon captures document.referrer.
 *
 * 3. ⛔ THE BEACON NEVER SENDS THE REAL URL. The obvious thing — PostHog's usual
 *    `$current_url` read from `location.href` — would write the secret path into an
 *    analytics store, where it lands in dashboards, exports and support tools. The
 *    URL IS the secret; shipping a leak detector that leaks the secret is not a
 *    detail, it is the bug.
 *
 *    [owner 2026-07-27] then asked for "the same sort of PostHog tracking we are
 *    using for papercusp.com". The site's beacon (public-site src/page.html) is
 *    ported here WHOLESALE — same host, same project key, same persistent
 *    distinct_id, same session id, same UTM first/last touch, same hand-derived
 *    browser/OS/device — with EXACTLY ONE thing changed: the URL family is
 *    REDACTED rather than read from `location`. `$current_url`/`$pathname`/`path`
 *    are built from a page identity baked in AT GENERATION TIME (`/index.html`,
 *    `/plans/<slug>.html`) under a literal `<redacted>` base segment. PostHog
 *    still gets per-page breakdowns, sessions and paths; it never gets the secret.
 *    `$host` is sent as-is — the hostname is public, only the PATH is the secret
 *    (D-002). If you are tempted to "fix" this by using `location.href`, don't:
 *    a test fails, and the reason is this paragraph.
 *
 * 4. THE CONTENT RENDERS WITH JAVASCRIPT DISABLED. Markdown is rendered to HTML
 *    HERE, at generation time — not by a client-side editor. A beta tester's job
 *    on this page is to read what changed and download an installer; if that
 *    depended on fetching a script (blocked, offline, proxied, CSP'd), the page
 *    would be BLANK exactly when someone needs it. The beacon is the only script,
 *    and it is best-effort: if it never runs, the page is still whole.
 *
 *    ONE deliberate exception, the Instructions [owner 2026-09-28 #868: "the
 *    instructions should come seperate from the release cut"]. They live on their
 *    own page, instructions.html, published by its own command — so a release cut
 *    or a site publish can never roll them back, and changing them needs no cut.
 *    The index embeds that page with a tiny same-origin loader; without
 *    JavaScript the section is a plain link to the same page. See
 *    renderInstructions() and renderInstructionsHtml().
 *
 *    (This is the one place I did not take the owner's suggested route verbatim —
 *    "we can use our same vditor to display the plan". Vditor is a browser editor
 *    that pulls a Lute WASM bundle at runtime; on a static page that makes the
 *    release notes a network-dependent render. Same markdown, same source of
 *    truth, rendered one layer earlier. Disclosed rather than silently swapped.)
 */

import { marked } from 'marked';
import type { ReleaseArtifact, ReleaseRow, ShippedItem, ShippedPlan } from './release-registry';
import { groupItemsByPlan } from './release-registry';
import {
  HOLDING_PAGE_MARKER,
  PUBLISHED_CONTACT_EMAIL,
  identityLiterals,
  scrubIdentity,
  type IdentityLiteral,
} from './release-content-scrub';
import { ROBOT_BG_DATA_URI } from './release-bg';
import { DISCORD_URL, INSTRUCTIONS_HEADING, INSTRUCTIONS_MD } from './release-instructions';
import { DEMO_VIDEO_LABEL, DEMO_VIDEO_POSTER_DATA_URI, DEMO_VIDEO_SRC } from './release-video';
import { releaseHistoryStem } from './release-project-history';
import { partialScopeApprovalDirectiveId } from './release-partial-scope';

/** A release row with the display data for its FROZEN id lists looked up. */
export interface HydratedRelease {
  row: ReleaseRow;
  items: ShippedItem[];
  plans: ShippedPlan[];
  internalCount: number;
}

export interface Analytics {
  host: string;
  projectKey: string;
}

export interface PageOptions {
  generatedAt: Date;
  /** Omit/null to generate a page with no beacon at all (local preview, tests). */
  analytics?: Analytics | null;
  /**
   * This box's identity, redacted out of every page. DEFAULTS to resolving the
   * real machine — a caller cannot accidentally publish un-scrubbed pages by
   * forgetting to pass it (WI-4389's lesson: the loader belongs in the producer).
   * Tests pass explicit literals; pass `[]` to deliberately disable.
   */
  redact?: IdentityLiteral[];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown → HTML, at GENERATION time. Content is ours (agent changelog, our own
 *  plan bodies from our own Postgres), never third-party input. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/**
 * Drop a plan's YAML frontmatter before it is rendered.
 *
 * It is METADATA, and on a public page it is both noise and a leak. Noise: the
 * title is already the <h1>, and `status: draft` / `created:` / `slug:` mean
 * nothing to a beta tester. Leak: `owner:` is a human's EMAIL ADDRESS — and it is
 * how two of the owner's personal gmail addresses reached a page bound for beta
 * testers (neither was this box's git identity, so no enumerated literal matched;
 * the scrub's shape-based email pattern is the backstop, this is the fix).
 *
 * Markdown does not treat frontmatter as metadata — `marked` sees the closing
 * `---` as a setext underline and renders the whole block as a HEADING, so it
 * arrives not merely present but as the loudest text on the page.
 */
export function stripFrontmatter(md: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/**
 * A plan's body almost always opens with `# <the plan title>` — and the page already
 * renders that title as its own `<h1>`. Left alone, every plan page states its title
 * twice, in two different sizes, which reads as a rendering bug.
 *
 * Only an EXACT title match is removed. A first heading that says something else is
 * real content and stays: silently eating the opening line of a plan body because it
 * merely looked title-ish would be a worse bug than the duplication it fixes.
 */
export function stripDuplicateTitle(md: string, title: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const m = /^[ \t]*#[ \t]+(.+?)[ \t]*(\r?\n|$)/.exec(md);
  if (!m || norm(m[1]) !== norm(title)) return md;
  return md.slice(m[0].length).replace(/^\s*\r?\n/, '');
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `plans/<slug>.html`, relative — never absolute (the base path is the secret). */
export function planPagePath(slug: string): string {
  return `plans/${slug.replace(/[^a-zA-Z0-9._-]/g, '-')}.html`;
}

/** `work-items/<id>.html`, relative — never absolute (the base path is secret). */
export function workItemPagePath(id: string): string {
  return `work-items/${id.replace(/[^a-zA-Z0-9._-]/g, '-')}.html`;
}

/**
 * The beacon. A single fetch to PostHog's anonymous capture endpoint — no
 * posthog-js, no CDN, no cookie. The `phc_*` key is a public anonymous-capture
 * credential (it cannot read events back), which is what makes it safe to bake
 * into a static page.
 *
 * `keepalive` so the POST survives the user clicking a download link immediately.
 * Every failure is swallowed: analytics must never be able to break the page.
 */
function beaconScript(
  a: Analytics,
  page: string,
  version: string | null,
  pagePath: string,
): string {
  // `surface` is the PRODUCER CONTRACT, and it is the reason this object exists
  // rather than just {page, version}. Two independent web surfaces — papercusp.com
  // and this releases page — publish into the SAME PostHog project, so every
  // consumer query must be able to say which one it means.
  //
  // ⛔ Do NOT use `page` for that. It is 'index' | 'plan' | 'work-item' — a page
  // WITHIN this surface, not the surface itself. It only ever separated the two
  // producers because the site happens not to send a `page` prop, which is a
  // coincidence of two independent designs rather than an agreement: the day the
  // site adds one, any consumer filtering on `page` silently changes meaning.
  // EI-18859175264310052 is the detector gap behind exactly that (its instance,
  // the site's Sessions/Bounce/Engaged tiles counting beta-tester traffic, was
  // fixed in WI-6556 by leaning on that very coincidence).
  //
  // Stamped on EVERY event, so a consumer scoped by TIME ALONE — no event filter,
  // which is the case that got contaminated and the easiest to forget — still has
  // an explicit axis to scope on. Additive and safe: it never removes a prop an
  // existing query reads.
  const props = JSON.stringify({ surface: 'releases', page, version });
  return `<script>
(function () {
  // ── anonymous analytics, ported from papercusp.com (public-site src/page.html)
  // [owner 2026-07-27: "the same sort of posthog tracking we are using for
  // papercusp.com"]. Same host, same project key, same shape — so releases-page
  // traffic lands in the same project and the same admin queries work on it.
  //
  // ⛔ THE ONE DIFFERENCE, AND IT IS LOAD-BEARING: the site reads the URL family
  // from location.*; this page CANNOT. Its path is the unlisted secret we share
  // with beta testers, so PAGE_PATH below is baked in at GENERATION time and the
  // base segment is a literal <redacted>. Never rebuild these from the browser's
  // own url/path accessors — a test fails, and the module header says why. (Nor
  // may you NAME those accessors in a comment down here: this text is emitted
  // into the published page, and the test greps the finished HTML, not the
  // source. That is deliberate — a warning is worth nothing if the thing it
  // warns about can hide inside it.)
  var PAGE_PATH = ${JSON.stringify(pagePath)};
  try {
    var HOST = ${JSON.stringify(a.host)},
        KEY = ${JSON.stringify(a.projectKey)},
        SID_KEY = 'pc_sid', SID_EXP_KEY = 'pc_sid_exp', SID_IDLE_MS = 30 * 60 * 1000,
        FT_KEY = 'pc_first_touch', LT_KEY = 'pc_last_touch', aid;

    // distinct_id: localStorage so repeat visits count as ONE visitor; falls back
    // to sessionStorage when storage access throws (privacy mode / cookie
    // blockers), so a blocked visitor's reloads stay one unique rather than
    // inflating the count with a fresh id per pageload.
    try { aid = localStorage.getItem('pc_aid'); } catch (e) {}
    if (!aid) { try { aid = sessionStorage.getItem('pc_aid'); } catch (e) {} }
    if (!aid) {
      aid = 'a-' + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));
      try { localStorage.setItem('pc_aid', aid); }
      catch (e) { try { sessionStorage.setItem('pc_aid', aid); } catch (e2) {} }
    }

    // PostHog's sessions table types $session_id as a UUID and DROPS non-UUID
    // values, which silently kills session duration / bounce / paths. Keep this a
    // bare RFC4122 UUID — never add a prefix.
    function uuid() {
      if (window.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16); });
    }
    function sessionId() {
      try {
        var now = Date.now(), exp = parseInt(sessionStorage.getItem(SID_EXP_KEY) || '0', 10),
            sid = sessionStorage.getItem(SID_KEY);
        if (!sid || !exp || now > exp) { sid = uuid(); sessionStorage.setItem(SID_KEY, sid); }
        sessionStorage.setItem(SID_EXP_KEY, String(now + SID_IDLE_MS));
        return sid;
      } catch (e) { return ''; }
    }

    // UTM / ref capture — first touch persisted forever, last touch overwritten
    // whenever a new utm_*/ref appears, both attached to every event. Reading the
    // QUERY STRING is safe: the secret lives in the PATH (D-002), never the query.
    function currentTouch() {
      try {
        var sp = new URLSearchParams(location.search), out = {}, has = false;
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
          var v = sp.get(k); if (v) { out[k] = v; has = true; } });
        var ref = sp.get('ref'); if (ref) { out.ref = ref; has = true; }
        if (!has) return null;
        out.landing_path = PAGE_PATH; out.ts = Date.now();
        return out;
      } catch (e) { return null; }
    }
    function touches() {
      var cur = currentTouch(), first = null, last = null;
      try { var f = localStorage.getItem(FT_KEY); if (f) first = JSON.parse(f); } catch (e) {}
      try { var l = localStorage.getItem(LT_KEY); if (l) last = JSON.parse(l); } catch (e) {}
      if (!first) {
        first = cur || { landing_path: PAGE_PATH, ts: Date.now(), organic: true };
        try { localStorage.setItem(FT_KEY, JSON.stringify(first)); } catch (e) {}
      }
      if (cur) { last = cur; try { localStorage.setItem(LT_KEY, JSON.stringify(last)); } catch (e) {} }
      else if (!last) { last = first; }
      return { first: first, last: last };
    }

    // No posthog-js here (same as the site), so the reserved $browser/$os/
    // $device_type props are derived by hand — enough for admin-panel bucketing.
    function detectUA() {
      var ua = navigator.userAgent || '', browser = 'Other', os = 'Other', device = 'Desktop';
      if (/Edg\\//.test(ua)) browser = 'Edge';
      else if (/OPR\\//.test(ua)) browser = 'Opera';
      else if (/Chrome\\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
      else if (/Firefox\\//.test(ua)) browser = 'Firefox';
      else if (/Safari\\//.test(ua) && /Version\\//.test(ua)) browser = 'Safari';
      if (/Windows/.test(ua)) os = 'Windows';
      else if (/Mac OS X/.test(ua)) os = 'Mac OS X';
      else if (/Android/.test(ua)) os = 'Android';
      else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
      else if (/Linux/.test(ua)) os = 'Linux';
      if (/iPad|Tablet/.test(ua)) device = 'Tablet';
      else if (/Mobi|Android/.test(ua)) device = 'Mobile';
      return { browser: browser, os: os, device: device };
    }

    var TOUCH_PROP_MAP = { utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign',
      ref: 'referrer', landing_path: 'landing', ts: 'ts' };

    function capture(event, extra, opts) {
      try {
        var ua = detectUA(), ref = document.referrer || '', refDomain = '$direct';
        if (ref) {
          try {
            var rh = new URL(ref).hostname;
            // A same-origin referrer IS a secret url (index -> plan page). The
            // page's <meta name="referrer" content="no-referrer"> should already
            // blank it; this is the belt to that braces, so the secret cannot
            // reach PostHog even if the meta is ever dropped.
            if (rh === location.hostname) { ref = '$internal'; refDomain = '$internal'; }
            else { refDomain = rh || '$direct'; }
          } catch (e) { ref = '$direct'; refDomain = '$direct'; }
        }
        var t = touches(), base = {
          // REDACTED url family — see the note at the top of this script.
          '$current_url': location.origin + '/<redacted>' + PAGE_PATH,
          '$pathname': PAGE_PATH,
          '$host': location.host,
          '$referrer': ref || '$direct', '$referring_domain': refDomain,
          '$browser': ua.browser, '$os': ua.os, '$device_type': ua.device,
          '$screen_height': screen.height, '$screen_width': screen.width,
          // legacy lowercase names, kept because the site's admin queries use them
          path: PAGE_PATH, referrer: ref || '(direct)',
          screen: screen.width + 'x' + screen.height, lang: navigator.language
        };
        var sid = sessionId(); if (sid) { base['$session_id'] = sid; }
        Object.keys(t.first || {}).forEach(function (k) { base['ft_' + (TOUCH_PROP_MAP[k] || k)] = t.first[k]; });
        Object.keys(t.last || {}).forEach(function (k) { base['lt_' + (TOUCH_PROP_MAP[k] || k)] = t.last[k]; });
        var p = Object.assign(base, ${props}, extra || {});
        var payload = JSON.stringify({ api_key: KEY, event: event,
          properties: Object.assign({ distinct_id: aid }, p), timestamp: new Date().toISOString() });
        // sendBeacon for events fired on the way out — more reliably delivered
        // during unload than a fetch, even with keepalive.
        if (opts && opts.beacon && navigator.sendBeacon) {
          navigator.sendBeacon(HOST + '/e/', new Blob([payload], { type: 'application/json' }));
        } else {
          fetch(HOST + '/e/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            keepalive: true, body: payload }).catch(function () {});
        }
      } catch (e) {}
    }

    capture('release_history_viewed');

    // One delegated listener covers every link on the page, so a link added later
    // is instrumented for free. NOTE: we read getAttribute('href') — the RAW,
    // relative value — never a.href, which the browser resolves into the full
    // secret url. Download and plan hrefs are relative by design, so what we send
    // is an artifact filename or a plan slug, never a path to this page.
    document.addEventListener('click', function (e) {
      try {
        var t = e.target;
        var a2 = t.closest && t.closest('a[href]');
        if (!a2) return;
        var href = a2.getAttribute('href') || '';
        var text = ((a2.textContent || '') + '').trim().slice(0, 80);
        if (/^https?:\\/\\//i.test(href)) {
          var domain = ''; try { domain = new URL(href).hostname; } catch (e2) {}
          if (/discord\\.(gg|com)/i.test(href)) capture('discord_clicked', { href: href });
          else capture('outbound_link_clicked', { href: href, domain: domain, link_text: text });
        } else if (/^mailto:/i.test(href)) {
          // The contact link. NO href and NO link_text on purpose: both contain
          // the owner's address, and an event property travels to PostHog, where
          // nothing scrubs it — the page's identity gate only ever sees the HTML.
          // Without this branch the address would ALSO be misfiled as a download.
          capture('contact_clicked');
        } else if (/^(?:\\.\\.\\/)*plans\\//.test(href)) {
          capture('plan_page_opened', { plan: href.replace(/^(?:\\.\\.\\/)*plans\\//, '').replace(/\\.html$/, '') });
        } else if (/^(?:\\.\\.\\/)*work-items\\//.test(href)) {
          capture('work_item_page_opened', { work_item: href.replace(/^(?:\\.\\.\\/)*work-items\\//, '').replace(/\\.html$/, '') });
        } else if (/^(?:\\.\\.\\/)*index\\.html(?:#.*)?$/.test(href)) {
          capture('release_history_returned');
        } else if (href && href.indexOf('#') !== 0) {
          // a relative, non-anchor link on this page is a release artifact
          capture('download_clicked', { artifact: href, link_text: text });
        }
      } catch (e) {}
    }, true);

    // Demo-video engagement: did the reader actually press play, and did they
    // finish it. One-shot each, so a scrub back and forth is not counted twice.
    try {
      var vid = document.getElementById('demoVid');
      if (vid) {
        var played = false;
        vid.addEventListener('play', function () {
          if (played) return; played = true; capture('demo_video_played');
        });
        vid.addEventListener('ended', function () { capture('demo_video_completed', {}, { beacon: true }); });
      }
    } catch (e) {}
  } catch (e) {}
})();
</script>`;
}

/**
 * The papercusp.com theme, lifted from the live site so a beta tester who clicks
 * through from the product lands somewhere that looks like the same company.
 *
 * DARK, matching the site. papercusp.com now ships a single dark theme by default
 * (html[data-theme="dark"], --bg:#07101d) sitting over a static "robot" flow-field —
 * the same backdrop the marketing site wears, minus the video/animation
 * (ROBOT_BG_DATA_URI, inlined below so the page stays self-contained). This file used
 * to be light-only, back when the site genuinely had no dark variant; it does now, so
 * we mirror it. Matching a single-theme site means adopting its single theme — if the
 * site's palette moves, move these tokens with it rather than inventing a second look.
 */
const STYLES = `
:root {
  --bg: #07101d; --bg-2: #0b1626; --bg-3: #0e1d31;
  --surface: rgba(18, 38, 63, .45); --surface-2: rgba(12, 26, 44, .7);
  --border: rgba(96, 168, 214, .18); --border-strong: rgba(96, 168, 214, .34);
  --fg: #e7f7ff; --fg-dim: #c3dcec; --muted: #8ea9c0;
  --accent: #38bdf8; --accent-2: #5eead4; --accent-deep: #0ea5e9;
  --glow: rgba(56, 189, 248, .22); --grid: rgba(120, 180, 220, .05);
  --shadow: 0 24px 60px -30px rgba(0, 0, 0, .7);
  --radius: 8px;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  position: relative;
  margin: 0; padding: 3.5rem 1.25rem 6rem; min-height: 100vh;
  color: var(--fg); font: 16px/1.65 var(--sans);
  background: var(--bg);
}
/* The static robot backdrop, pinned as its OWN fixed layer rather than a
   background-attachment:fixed on <body>. Deliberate: these pages are long (a plan page
   runs thousands of words) and background-attachment:fixed seams at the fold on tall
   pages, whereas a fixed element composites once and never seams. z-index:-1 drops it
   behind the grid (body::before, z-0) and the content (main, z-1). It is decorative and
   aria-hidden; if the data URI ever fails to paint, the solid --bg underneath is the
   same colour, so the page is unharmed. */
.bgfx {
  position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
  background:
    radial-gradient(1100px 620px at 82% -10%, var(--glow), transparent 60%),
    radial-gradient(900px 520px at 6% 2%, rgba(94, 234, 212, .10), transparent 62%),
    url("${ROBOT_BG_DATA_URI}") center top / cover no-repeat,
    var(--bg);
}
/* the faint engineering grid papercusp.com sits on, faded out down the page */
body::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 44px 44px;
  /* fade in PIXELS, not %: a % fade would stretch the grid halfway down a
     3,000-word plan page instead of keeping it a masthead texture. */
  -webkit-mask-image: linear-gradient(180deg, #000 0, rgba(0, 0, 0, .55) 340px, transparent 760px);
  mask-image: linear-gradient(180deg, #000 0, rgba(0, 0, 0, .55) 340px, transparent 760px);
}
main { position: relative; z-index: 1; max-width: 56rem; margin: 0 auto; }
h1 {
  font-size: clamp(2.1rem, 5vw, 3.25rem); line-height: 1.08; margin: 0 0 .5rem;
  letter-spacing: -.03em; font-weight: 650;
  background: linear-gradient(135deg, var(--fg) 0%, var(--accent-deep) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
/* a plan TITLE is a sentence, not a wordmark — "Papercusp releases" carries a 52px
   hero; "Desktop auto-update fully operational (manifest fixes → proxy → 2-cut E2E
   on win/mac/linux VMs)" at that size is three lines of shouting. */
h1.plan-title { font-size: clamp(1.7rem, 3.2vw, 2.15rem); line-height: 1.2; }
h1.item-title { font-size: clamp(1.55rem, 3vw, 2rem); line-height: 1.22; }
h2 { font-size: 1.45rem; margin: 0; letter-spacing: -.02em; font-weight: 640; }
a { color: var(--accent-deep); text-decoration-color: rgba(2, 132, 199, .35); text-underline-offset: 2px; }
a:hover { color: var(--accent); }
.sub { color: var(--muted); font-size: .95rem; margin: 0 0 3rem; max-width: 42rem; }
/* The homepage demo video, at the top of the page (owner ask 2026-07-27).
   Black backing so the letterbox bars around a non-16:9 cut read as part of the
   frame rather than as a rendering gap, and max-height so a short-but-wide
   browser window does not push the download tables off the fold entirely. */
.demo {
  position: relative; z-index: 1;
  margin: 0 0 1.75rem; border: 1px solid var(--border); border-radius: 16px;
  overflow: hidden; background: #000; box-shadow: var(--shadow);
}
.demo video { display: block; width: 100%; height: auto; max-height: 74vh; background: #000; }
.rel {
  border: 1px solid var(--border); border-radius: 16px;
  padding: 1.6rem 1.75rem; margin: 0 0 1.75rem;
  background: var(--surface); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
}
.rel-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .4rem; }
.tag {
  font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
  padding: .18rem .5rem; border-radius: 999px;
  border: 1px solid var(--border-strong); color: var(--muted); background: var(--surface-2);
}
.tag.current { border-color: transparent; color: #fff; background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%); }
.meta { color: var(--muted); font-size: .85rem; margin-bottom: 1.25rem; }
.meta code, .platform-section code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border); padding: .1rem .4rem; border-radius: 5px; font-size: .85em; }
.platform-section code { display: inline-block; margin: .18rem 0; user-select: all; }
.changelog { margin: 1.35rem 0 0; color: var(--fg-dim); }
.changelog :first-child { margin-top: 0; }
.changelog h1, .changelog h2, .changelog h3 {
  font-size: 1.05rem; margin: 1.35rem 0 .45rem; color: var(--fg);
  letter-spacing: -.01em; font-weight: 640;
  background: none; -webkit-background-clip: border-box; background-clip: border-box;
}
h3.dl-group { font-size: .95rem; margin: 1.4rem 0 .5rem; color: var(--fg-dim); font-weight: 640; letter-spacing: -.01em; }
table.dl { width: 100%; border-collapse: collapse; margin: 0; font-size: .9rem; }
table.dl th {
  text-align: left; color: var(--muted); font-weight: 600; font-size: .72rem;
  text-transform: uppercase; letter-spacing: .06em;
  padding: .4rem .75rem .4rem 0; border-bottom: 1px solid var(--border-strong);
}
table.dl td { padding: .6rem .75rem .6rem 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.dl tr:last-child td { border-bottom: 0; }
table.dl td a { font-weight: 550; }
table.dl td.sha { color: var(--muted); font-family: var(--mono); font-size: .7rem; word-break: break-all; }
/* Per-platform download sections (owner ask 2026-07-19): each platform is its own
   section; within it the app and Server are labelled sub-tables of the same shape. */
.platform-section { margin: 1.5rem 0 0; }
h3.platform-h { font-size: 1.02rem; margin: 0 0 .35rem; color: var(--fg); font-weight: 680; letter-spacing: -.01em; border-bottom: 1px solid var(--border-strong); padding-bottom: .3rem; }
h4.component-h { font-size: .74rem; margin: .85rem 0 .25rem; color: var(--fg-dim); font-weight: 640; text-transform: uppercase; letter-spacing: .04em; }
p.n { color: var(--muted); font-size: .8rem; margin: .5rem 0 0; line-height: 1.45; }
p.warn { color: #e6a23c; font-size: .82rem; margin: .55rem 0 0; font-weight: 520; line-height: 1.45; }
details {
  margin-top: 1.35rem; border-top: 1px solid var(--border); padding-top: 1rem;
}
summary { cursor: pointer; font-weight: 600; font-size: .92rem; color: var(--accent-deep); }
summary:hover { color: var(--accent); }
summary::marker { color: var(--accent); }
ul.items { list-style: none; padding: 0; margin: .6rem 0 0; }
ul.items li { padding: .35rem 0; font-size: .89rem; color: var(--fg-dim); border-bottom: 1px solid var(--grid); }
ul.items li:last-child { border-bottom: 0; }
.wid { font-family: var(--mono); font-size: .76rem; color: var(--accent-2); margin-right: .55rem; }
.item-row, .plan-heading { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; }
.item-row > details { flex: 1 1 auto; min-width: 0; }
.detail-link { flex: 0 0 auto; font-size: .76rem; font-weight: 600; white-space: nowrap; }
/* Per-item click-to-expand (WI-5525). Scope OVER the top-level details/summary
   rules above so a nested item expander keeps the compact item look, not the big
   section-header look. */
ul.items li details { margin-top: 0; border-top: 0; padding-top: 0; }
ul.items li summary { font-weight: inherit; font-size: inherit; color: inherit; list-style: none; cursor: pointer; }
ul.items li summary:hover { color: var(--fg); }
ul.items li summary::-webkit-details-marker { display: none; }
ul.items li summary::marker { content: ""; }
ul.items li summary::before { content: "▸"; color: var(--muted); display: inline-block; width: 1em; margin-right: .1rem; transition: transform .12s ease; }
ul.items li details[open] summary::before { transform: rotate(90deg); }
ul.items li .item-body { margin: .45rem 0 .35rem 1.1em; padding: .55rem .75rem; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .82rem; line-height: 1.5; color: var(--muted); background: rgba(255,255,255,.02); border-left: 2px solid var(--border); border-radius: 4px; max-height: 24rem; overflow: auto; }
.plan-group { margin: 1.25rem 0 0; }
.plan-group > h4 { margin: 0 0 .1rem; font-size: .95rem; font-weight: 640; letter-spacing: -.01em; }
.plan-heading > h4 { margin: 0; font-size: .95rem; font-weight: 640; letter-spacing: -.01em; }
.plan-group > .n { color: var(--muted); font-size: .78rem; margin: 0 0 .35rem; }
.detail-card { border: 1px solid var(--border); border-radius: 12px; padding: 1.15rem 1.25rem; margin: 1.25rem 0; background: var(--surface); }
.detail-card h2 { font-size: 1.05rem; margin-bottom: .75rem; }
.detail-grid { display: grid; grid-template-columns: minmax(8rem, .38fr) minmax(0, 1fr); gap: .45rem 1rem; margin: 0; font-size: .88rem; }
.detail-grid dt { color: var(--muted); font-weight: 600; }
.detail-grid dd { margin: 0; color: var(--fg-dim); overflow-wrap: anywhere; }
.detail-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg-dim); margin: 0; }
.evidence-list { margin: 0; padding-left: 1.15rem; color: var(--fg-dim); }
.evidence-list li { margin: .45rem 0; overflow-wrap: anywhere; }
.evidence-list code { white-space: pre-wrap; }
@media (max-width: 620px) {
  .item-row, .plan-heading { align-items: flex-start; flex-direction: column; gap: .3rem; }
  .detail-grid { grid-template-columns: 1fr; gap: .1rem; }
  .detail-grid dd { margin-bottom: .55rem; }
}
.empty { color: var(--muted); font-style: italic; }
.back { display: inline-block; margin-bottom: 1.75rem; font-size: .88rem; font-weight: 550; }
.prose { margin-top: 1.5rem; color: var(--fg-dim); }
.prose h1, .prose h2, .prose h3, .prose h4 {
  color: var(--fg); letter-spacing: -.02em;
  background: none; -webkit-background-clip: border-box; background-clip: border-box;
}
.prose h1 { font-size: 1.6rem; }
.prose h2 { font-size: 1.3rem; margin-top: 2rem; }
/* The Instructions section nests three levels deep (section h2 → topic h3 →
   sub-topic h4), so h3/h4 need explicit sizes: the UA defaults render h4 SMALLER
   than the body text it introduces, which reads as a caption, not a heading. */
.prose h3 { font-size: 1.1rem; margin: 2.1rem 0 .5rem; font-weight: 660; }
.prose h4 { font-size: .95rem; margin: 1.5rem 0 .4rem; font-weight: 640; color: var(--fg-dim); }
.prose li { margin: .3rem 0; }
.prose li > ul { margin: .35rem 0; }
/* A heading's inline <code> keeps the mono face but drops the pill padding —
   at heading weight the box reads as a gap in the middle of the words
   ("SU Agents (  psu  command)"). */
.prose h2 code, .prose h3 code, .prose h4 code { font-size: .86em; padding: .02rem .22rem; }
/* The Instructions warning is a CALLOUT, not a footnote. The bare p.warn above
   is sized for a one-line note under a download table (.82rem); reused inside
   the prose it rendered the single most important sentence on the page —
   "the GUI is not the part that is ready" — SMALLER than the body text around
   it, which is the opposite of what it is for. Scoped to .prose so the
   platform notes under the download tables keep their existing quiet size. */
.prose p.warn {
  font-size: 1rem; line-height: 1.55; font-weight: 500;
  margin: 1.2rem 0; padding: .85rem 1.1rem;
  border: 1px solid rgba(230, 162, 60, .32);
  border-left: 3px solid #e6a23c;
  border-radius: var(--radius);
  background: rgba(230, 162, 60, .07);
}
.prose p.warn code { border-color: rgba(230, 162, 60, .3); }
.prose kbd {
  font-family: var(--mono); font-size: .78em; padding: .08rem .35rem;
  border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px;
  background: var(--surface-2); color: var(--fg-dim); white-space: nowrap;
}
.prose pre {
  background: var(--surface-2); border: 1px solid var(--border);
  padding: .9rem 1.1rem; border-radius: var(--radius); overflow-x: auto;
  font-family: var(--mono); font-size: .84rem;
}
.prose code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border); padding: .1rem .35rem; border-radius: 5px; font-size: .86em; }
.prose pre code { background: none; border: 0; padding: 0; }
.prose blockquote { margin: 1rem 0; padding: .1rem 0 .1rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
.prose table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: .88rem; }
.prose td, .prose th { border: 1px solid var(--border); padding: .45rem .7rem; }
.prose th { background: var(--surface-2); }
.prose img { max-width: 100%; border-radius: var(--radius); }
footer { color: var(--muted); font-size: .78rem; margin-top: 3.5rem; text-align: center; }
`;

/**
 * The single point where a page becomes bytes — and therefore the ONE place the
 * identity scrub belongs.
 *
 * Scrubbing at each call site (item titles here, plan bodies there, changelog
 * over there) means the next person who adds a field to the page silently adds a
 * leak. The content is written by agents on the owner's own box: a work-item title
 * quoting a shell command carries his home path, a plan's decision log carries his
 * name. So we scrub the FINISHED HTML, once, on the way out. Nothing renders
 * except through here.
 */
function shell(
  title: string,
  body: string,
  beacon: string,
  redact: IdentityLiteral[],
  opts: { headExtra?: string; allowEmails?: readonly string[] } = {},
): string {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07101d">
<!-- Unlisted beta page. Not indexed, not linked from anywhere public. -->
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
${opts.headExtra ? `${opts.headExtra}\n` : ''}<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="bgfx" aria-hidden="true"></div>
<main>
${body}
</main>
${beacon}
</body>
</html>
`;
  // allowEmails defaults to EMPTY — every existing caller keeps the old,
  // scrub-everything behaviour. Only the holding page opts in.
  return scrubIdentity(html, redact, { allowEmails: opts.allowEmails });
}

/** High-level platform sections for a release's downloads, in display order
 *  (owner ask 2026-07-19: a separate section per platform). `Mobile` folds the
 *  phone builds together; `platforms` lists the ReleaseArtifact platform strings
 *  that belong to each section. */
const PLATFORM_SECTIONS: ReadonlyArray<{ label: string; platforms: string[]; desktop: boolean }> = [
  { label: 'Linux', platforms: ['linux-x86_64'], desktop: true },
  { label: 'macOS', platforms: ['darwin-universal'], desktop: true },
  { label: 'Windows', platforms: ['windows-x86_64'], desktop: true },
  { label: 'Mobile', platforms: ['android-universal', 'ios-arm64'], desktop: false },
];

/** One download table (Download / Size / SHA-256) for a set of artifacts. Used
 *  IDENTICALLY for the app (GUI) and the Server within a platform section — the
 *  Server is a first-class table, never a prose link (owner ask 2026-07-19). The
 *  platform is the section header and the component is a sub-header, so neither is
 *  a table column here. */
function renderDownloadTable(list: ReleaseArtifact[]): string {
  if (list.length === 0) return '';
  const rows = list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (a) => `      <tr>
        <td><a href="${escapeHtml(encodeArtifactPath(a.url))}">${escapeHtml(a.name)}</a></td>
        <td>${escapeHtml(formatBytes(a.size))}</td>
        <td class="sha">${escapeHtml(a.sha256 || '—')}</td>
      </tr>`,
    )
    .join('\n');
  return `<table class="dl">
  <thead><tr><th>Download</th><th>Size</th><th>SHA-256</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** Encode registry artifact paths for an HTML href without encoding separators. */
function encodeArtifactPath(url: string): string {
  return url
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** The GUI↔Server requirement note for ONE desktop platform section. Every
 *  desktop GUI requires the separately installed Server. If a section has a GUI
 *  but NO Server, warn loudly rather than let a tester install a build that
 *  cannot start. */
function platformRequirementNote(
  label: string,
  hasGui: boolean,
  hasServer: boolean,
): string {
  if (!hasGui) return '';
  return hasServer
    ? `\n<p class="n"><strong>Install both.</strong> On ${escapeHtml(label)} the app needs <strong>Papercusp Server</strong> running alongside it — install the app <em>and</em> the Server below.</p>`
    : `\n<p class="warn">⚠ On ${escapeHtml(label)} the app also needs <strong>Papercusp Server</strong> to run — it isn't in this release yet, so this build can't start on its own.</p>`;
}

/** macOS first-launch note (EI-20109680727314274). Our mac builds are AD-HOC SIGNED,
 *  so Gatekeeper HARD-BLOCKS first launch ("damaged" / "unidentified developer") and
 *  there is no way through it from the Finder — the user must run `xattr` once. This
 *  has to live on the PAGE, not in one release's changelog: it applies to every mac
 *  build we ship until a real Apple Developer certificate lands (owner wall WI-5138).
 *
 *  It is deliberately NOT covered by any automated test we have: our own mac E2E
 *  harness (papercusp-desktop/bin/mac-vm-fresh-install-e2e.sh) unquarantines the
 *  bundles itself before launching them, so it is structurally incapable of hitting
 *  the wall a human hits. That asymmetry is exactly why this went unnoticed. */
function macFirstLaunchNote(hasGui: boolean, hasServer: boolean): string {
  const apps: string[] = [];
  if (hasGui) apps.push('Papercusp GUI.app');
  if (hasServer) apps.push('Papercusp Server.app');
  if (apps.length === 0) return '';
  const cmds = apps
    .map((a) => `<code>xattr -dr com.apple.quarantine "/Applications/${escapeHtml(a)}"</code>`)
    .join('<br>');
  return (
    `\n<p class="warn">⚠ <strong>macOS: one command before first launch.</strong> These builds are ad-hoc signed, so macOS will refuse to open them ` +
    `(&ldquo;damaged&rdquo; or &ldquo;unidentified developer&rdquo;). Drag ${apps.length > 1 ? 'them' : 'it'} to Applications, then run this once in Terminal:</p>` +
    `\n<p class="n">${cmds}</p>` +
    `\n<p class="n">Then open the app normally. This is not a virus warning &mdash; it means we do not yet have an Apple Developer certificate.</p>`
  );
}

/** One platform's section: a heading, then the app downloads and (when present)
 *  the Server downloads, each as its own labelled table of the SAME shape. */
function renderPlatformSection(
  label: string,
  desktop: boolean,
  list: ReleaseArtifact[],
  noteHtml?: string,
): string {
  const app = list.filter((a) => a.product === 'gui' || a.product === 'mobile');
  const server = list.filter((a) => a.product === 'server');
  // Only label the App/Server sub-sections when BOTH are present — a platform with
  // just one component doesn't need the distinction.
  const labelComponents = app.length > 0 && server.length > 0;
  const parts: string[] = [`<h3 class="platform-h">${escapeHtml(label)}</h3>`];
  if (noteHtml) parts.push(noteHtml);
  if (app.length > 0) {
    if (labelComponents) parts.push(`<h4 class="component-h">App</h4>`);
    parts.push(renderDownloadTable(app));
  }
  if (server.length > 0) {
    if (labelComponents) parts.push(`<h4 class="component-h">Papercusp Server</h4>`);
    parts.push(renderDownloadTable(server));
  }
  if (desktop) parts.push(platformRequirementNote(label, app.length > 0, server.length > 0));
  // Gatekeeper blocks EVERY mac build we ship (ad-hoc signed) — the note belongs on
  // the page, not in a single release's changelog. See macFirstLaunchNote.
  if (desktop && label === 'macOS') {
    parts.push(macFirstLaunchNote(app.length > 0, server.length > 0));
  }
  return `<section class="platform-section">\n${parts.filter(Boolean).join('\n')}\n</section>`;
}

/**
 * A release's downloads, as a separate high-level SECTION per platform (owner ask
 * 2026-07-19), each grouping that platform's app + Server into their own tables of
 * the same shape. This structure carries the cross-platform GUI↔Server
 * requirement inline: Linux, macOS, and Windows GUIs have no built-in backend;
 * each needs the separate Papercusp Server, so install BOTH.
 * Mobile is its own section. An unrecognized platform is never dropped — it falls
 * into an "Other" section so the page's account of the release stays complete.
 */
function renderArtifacts(
  artifacts: ReleaseArtifact[],
  platformNotes: ReadonlyMap<string, string> = new Map(),
): string {
  const real = artifacts.filter((a) => !a.name.endsWith('.sig'));
  if (real.length === 0) {
    return `<p class="empty">No downloadable artifacts recorded for this release.</p>`;
  }

  const known = new Set(PLATFORM_SECTIONS.flatMap((s) => s.platforms));
  const sections: string[] = [];
  for (const sec of PLATFORM_SECTIONS) {
    const list = real.filter((a) => sec.platforms.includes(a.platform));
    const note = sec.platforms.map((p) => platformNotes.get(p)).find(Boolean);
    if (list.length > 0) sections.push(renderPlatformSection(sec.label, sec.desktop, list, note));
  }
  const other = real.filter((a) => !known.has(a.platform));
  if (other.length > 0) sections.push(renderPlatformSection('Other', true, other));

  return sections.join('\n');
}

/**
 * One card on the index: a full release plus any PLATFORM-ONLY hotfixes cut on
 * top of it (WI-10003687, owner #800: "put the windows build along with the mac
 * and linux 0.0.22 build … id rather they all look like the same release even
 * though windows is 0.0.23").
 *
 * This is a VIEW-only grouping. The registry keeps one row per version and
 * `history.json` (the in-app Update Center feed) still lists every release on its
 * own, so a Windows 0.0.22 install is still offered 0.0.23 while Linux and macOS
 * see no update. Recording the hotfix files under the older row instead would
 * hide the update from exactly the users it is for.
 */
export interface ReleaseCard {
  /** The full release that owns the card, its heading and its changelog. */
  base: HydratedRelease;
  /** Platform-only releases folded into it, OLDEST first. */
  hotfixes: HydratedRelease[];
  /** Index (newest-first) of the newest release in the card. */
  newestIndex: number;
}

function downloadPlatforms(rel: HydratedRelease): Set<string> {
  return new Set(rel.row.artifacts.filter((a) => !a.name.endsWith('.sig')).map((a) => a.platform));
}

/**
 * True when `rel` is a RECORDED platform-only hotfix of `base`: the registry row
 * carries the owner-approved partial-desktop-scope note record-release writes,
 * and it ships a strict, non-empty subset of `base`'s platforms.
 *
 * Platform arithmetic alone is NOT the signal. The registry holds full releases
 * that shipped fewer platforms than the one before them — every desktop-only
 * release after 0.0.14 (the last cut with Android/iOS), and 0.0.10 (Linux only,
 * after 0.0.9). A subset test on its own folded that whole history into one
 * 0.0.14 card.
 */
function isPlatformHotfix(rel: HydratedRelease, base: HydratedRelease): boolean {
  if (partialScopeApprovalDirectiveId(rel.row.notes) === null) return false;
  const mine = downloadPlatforms(rel);
  const theirs = downloadPlatforms(base);
  if (mine.size === 0 || mine.size >= theirs.size) return false;
  for (const p of mine) if (!theirs.has(p)) return false;
  return true;
}

/**
 * Group releases (newest first, as the registry returns them) into index cards.
 * A release folds into the most recent older card of the SAME channel when it is
 * a recorded platform-only hotfix of that card (see isPlatformHotfix); anything
 * else starts its own card. Cards come back newest-first, positioned by their
 * newest member.
 */
export function groupReleaseCards(releases: HydratedRelease[]): ReleaseCard[] {
  const cards: ReleaseCard[] = [];
  const openByChannel = new Map<string, ReleaseCard>();
  for (let i = releases.length - 1; i >= 0; i -= 1) {
    const rel = releases[i]!;
    const open = openByChannel.get(rel.row.channel);
    if (open && isPlatformHotfix(rel, open.base)) {
      open.hotfixes.push(rel);
      open.newestIndex = i;
      continue;
    }
    const card: ReleaseCard = { base: rel, hotfixes: [], newestIndex: i };
    cards.push(card);
    openByChannel.set(rel.row.channel, card);
  }
  return cards.sort((a, b) => a.newestIndex - b.newestIndex);
}

/** The card's downloads: the base's artifacts, with each hotfix's
 *  (platform, product) builds replacing the base's for that pair. */
function cardArtifacts(card: ReleaseCard): ReleaseArtifact[] {
  let merged = card.base.row.artifacts.slice();
  for (const hotfix of card.hotfixes) {
    const replaced = new Set(hotfix.row.artifacts.map((a) => `${a.platform}\u0000${a.product}`));
    merged = merged
      .filter((a) => !replaced.has(`${a.platform}\u0000${a.product}`))
      .concat(hotfix.row.artifacts);
  }
  return merged;
}

function platformLabel(platform: string): string {
  return PLATFORM_SECTIONS.find((s) => s.platforms.includes(platform))?.label ?? platform;
}

/** Per-platform notes naming the hotfix version a section now carries. */
function hotfixPlatformNotes(card: ReleaseCard): Map<string, string> {
  const notes = new Map<string, string>();
  for (const hotfix of card.hotfixes) {
    const { row } = hotfix;
    const when = formatDate(row.publishedAt ?? row.cutAt);
    const html =
      `<p class="n hotfix-note">Updated to <strong>${escapeHtml(row.version)}</strong> on ${escapeHtml(when)} ` +
      `&mdash; a fix for this platform only, on top of ${escapeHtml(card.base.row.version)}. ` +
      `<a href="changes/${releaseHistoryStem(row.version, row.channel)}.html">What changed →</a></p>`;
    for (const p of downloadPlatforms(hotfix)) notes.set(p, html);
  }
  return notes;
}

function renderHotfixChangelogs(card: ReleaseCard): string {
  return card.hotfixes
    .slice()
    .reverse()
    .filter((h) => h.row.changelogMd?.trim())
    .map((h) => {
      const platforms = [...downloadPlatforms(h)].map(platformLabel).join(', ');
      return `<div class="changelog hotfix-changelog"><h3>${escapeHtml(platforms)} ${escapeHtml(h.row.version)}</h3>${renderMarkdown(h.row.changelogMd ?? '')}</div>`;
    })
    .join('\n');
}

function renderItemList(items: ShippedItem[]): string {
  return `<ul class="items">
${items
  .map((i) => {
    const head = `<span class="wid">${escapeHtml(i.id)}</span>${escapeHtml(i.title)}`;
    const link = `<a class="detail-link" href="${escapeHtml(workItemPagePath(i.id))}">View full work item →</a>`;
    const body = (i.summary ?? '').trim();
    // No body → a plain row (unchanged look). With a body → a click-to-expand
    // <details> (WI-5525): summary is the id+title row (same look), the panel is
    // the full item text. Body is ESCAPED + white-space:pre-wrap — faithful and
    // XSS-safe (no markdown eval); identity is scrubbed with the whole page in
    // shell(). Pure HTML, no JS — works on the static R2 page.
    if (!body) return `      <li><div class="item-row"><span>${head}</span>${link}</div></li>`;
    return `      <li><div class="item-row"><details><summary>${head}</summary><div class="item-body">${escapeHtml(body)}</div></details>${link}</div></li>`;
  })
  .join('\n')}
    </ul>`;
}

const MAX_INDEX_WORK_ITEM_PREVIEW = 50;

/** Keep the shared beta landing page usable on mobile and fail generation if a
 * future content change makes the index grow beyond this explicit budget. */
export const MAX_RELEASE_HISTORY_INDEX_BYTES = 5 * 1024 * 1024;

export function assertReleaseHistoryIndexSizeBudget(html: string): void {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_RELEASE_HISTORY_INDEX_BYTES) {
    throw new Error(
      `Release-history index exceeds its ${MAX_RELEASE_HISTORY_INDEX_BYTES}-byte generation budget ` +
        `(${bytes} bytes). Keep the landing page concise and link full content from detail pages.`,
    );
  }
}

function itemsInSnapshotOrder(rel: HydratedRelease) {
  const byId = new Map(rel.items.map((item) => [item.id, item] as const));
  const ordered = rel.row.workItemIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  return ordered.length === rel.items.length ? ordered : rel.items;
}

function renderWork(rel: HydratedRelease, maxItems?: number): string {
  if (rel.items.length === 0 && rel.internalCount === 0) return '';

  const snapshotItems = itemsInSnapshotOrder(rel);
  const items = maxItems === undefined
    ? snapshotItems
    : snapshotItems.slice(Math.max(0, snapshotItems.length - maxItems));
  const omittedItems = snapshotItems.length - items.length;
  const allGroups = groupItemsByPlan(snapshotItems, rel.plans);
  const groups = groupItemsByPlan(items, rel.plans);
  const planCount = allGroups.filter((g) => g.plan !== null).length;

  const body = groups
    .map((g) => {
      // No plan STATUS on the public page: `draft` / `ready` / `shipped` is our
      // internal workflow state, it says nothing to a tester, and on a page listing
      // what SHIPPED, "plan draft" reads as a contradiction rather than as metadata.
      const heading = g.plan
        ? `<div class="plan-heading"><h4><a href="${escapeHtml(planPagePath(g.plan.slug))}">${escapeHtml(g.plan.title)}</a></h4><a class="detail-link" href="${escapeHtml(planPagePath(g.plan.slug))}">View full plan →</a></div>
      <p class="n">${g.items.length} item${g.items.length === 1 ? '' : 's'}</p>`
        : `<h4>Not part of a plan</h4>
      <p class="n">${g.items.length} item${g.items.length === 1 ? '' : 's'}</p>`;
      return `    <div class="plan-group">
      ${heading}
      ${renderItemList(g.items)}
    </div>`;
    })
    .join('\n');

  // The internal count is stated, never listed: EI-* items are the agents fixing
  // their own tooling. Hiding them silently would make "the full list" a lie;
  // listing 700 of them would bury the 1,000 that matter.
  const internal =
    rel.internalCount > 0
      ? `\n    <p class="n">Plus ${rel.internalCount} internal engineering-tooling fixes (not listed — they change how the agents work, not the product).</p>`
      : '';
  const previewNote = omittedItems > 0
    ? items.length > 0
      ? `<p class="n">Showing the ${items.length} most recent of ${snapshotItems.length} user-facing work items. <a href="changes/${releaseHistoryStem(rel.row.version, rel.row.channel)}.html">Explore the complete release details →</a></p>`
      : `<p class="n">All ${snapshotItems.length} work items are on the <a href="changes/${releaseHistoryStem(rel.row.version, rel.row.channel)}.html">complete release details page</a>.</p>`
    : '';

  return `  <details>
    <summary>${snapshotItems.length} work item${snapshotItems.length === 1 ? '' : 's'} across ${planCount} plan${planCount === 1 ? '' : 's'}</summary>
${previewNote}${body}${internal}
  </details>`;
}

/**
 * The homepage demo video, at the top of the releases page [owner 2026-07-27].
 *
 * Same element the homepage renders — same cut, same `controls autoplay muted
 * playsinline`, same aria-label — so a tester who saw it on papercusp.com and a
 * tester who lands here straight from the link see the same thing.
 *
 * `muted` is what makes `autoplay` actually work (browsers block unmuted
 * autoplay), and it is the courteous default on a page someone opened to fetch
 * an installer. `preload="metadata"` fetches a few KB rather than the whole
 * 32 MB up front, so arriving on the page does not cost a tester a download
 * they did not ask for; the poster is inlined, so there is something to look at
 * either way. Index page only — a plan page is a wall of text, not a landing.
 */
function renderVideo(): string {
  // The poster is our own generated base64 (safe attribute alphabet); the src
  // and label go through escapeHtml on principle — they are lifted from the
  // site's HTML by a script, and "it is ours" is how injection bugs start.
  return `<section class="demo">
  <video id="demoVid" controls autoplay muted playsinline preload="metadata"
    poster="${DEMO_VIDEO_POSTER_DATA_URI}"
    src="${escapeHtml(DEMO_VIDEO_SRC)}"
    aria-label="${escapeHtml(DEMO_VIDEO_LABEL)}"></video>
</section>`;
}

/**
 * Every link in the Instructions section opens in a new tab.
 *
 * Not a nicety: the page IS the release. A tester who clicks the Discord link
 * mid-setup and navigates away has lost the download tables and the rest of the
 * instructions, and the only way back is the secret URL — which they got in a
 * message they now have to go find. `noopener noreferrer` comes along because
 * `target="_blank"` without it hands the opened page a live `window.opener`
 * handle on this one.
 *
 * Applied to the RENDERED html rather than written into the markdown so the
 * content stays plain markdown that anyone can edit without remembering to
 * repeat the attributes (and so a link added later can't quietly miss them).
 * Scoped to `http(s)` — the release links elsewhere on the page are relative on
 * purpose (the base path is the secret) and must keep navigating in place.
 */
function openLinksInNewTab(html: string): string {
  return html.replace(/<a href="(https?:\/\/)/g, '<a target="_blank" rel="noopener noreferrer" href="$1');
}

/** The Instructions page, relative to the index — never absolute (the base path is the secret). */
export const INSTRUCTIONS_PAGE_PATH = 'instructions.html';
/** The element on instructions.html whose content the index embeds. */
export const INSTRUCTIONS_BODY_ID = 'instructions-body';
/** Marks the index's one non-beacon script, so readers (and tests) can tell the two apart. */
export const INSTRUCTIONS_LOADER_ATTR = 'data-instructions-loader';

/**
 * Fills the index's Instructions section from instructions.html at view time.
 * Same origin, relative path, no third party: it can only ever read a page we
 * published next to this one. Every failure leaves the no-JS link in place.
 */
const INSTRUCTIONS_LOADER_JS = `(function () {
  var box = document.getElementById(${JSON.stringify(INSTRUCTIONS_BODY_ID)});
  if (!box || !window.fetch || !window.DOMParser) return;
  fetch(${JSON.stringify(INSTRUCTIONS_PAGE_PATH)}, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (text) {
      if (!text) return;
      var src = new DOMParser().parseFromString(text, 'text/html').getElementById(${JSON.stringify(INSTRUCTIONS_BODY_ID)});
      if (src && src.innerHTML.trim()) box.innerHTML = src.innerHTML;
    })
    .catch(function () {});
})();`;

/**
 * The owner's "Instructions" section on the index — the beta-tester onboarding
 * notes, ABOVE the downloads [owner 2026-07-27].
 *
 * The order is the whole point: setup steps only help if they are read BEFORE
 * the installer is downloaded.
 *
 * ⚠ The index does NOT carry the instructions text [owner 2026-09-28 #868: "the
 * instructions should come seperate from the release cut"]. The index is
 * generated at release time, from whatever checkout cut the release — and the
 * 0.0.24 publish, generated from a checkout pinned before that day's edits,
 * silently rolled the live instructions back (EI-24562046738478155). So the
 * text lives only on instructions.html (renderInstructionsHtml), published by
 * bin/publish-release-instructions.sh, and this section loads it. Nothing a
 * release does can change it, and changing it needs no release.
 *
 * Without JavaScript the section is a link to that page, so the steps are still
 * one click away with scripts blocked.
 */
function renderInstructions(): string {
  return `<section class="rel instructions">
  <div class="rel-head">
    <h2>${escapeHtml(INSTRUCTIONS_HEADING)}</h2>
  </div>
  <div class="prose" id="${INSTRUCTIONS_BODY_ID}"><p><a href="${INSTRUCTIONS_PAGE_PATH}">Read the setup instructions</a></p></div>
  <script ${INSTRUCTIONS_LOADER_ATTR}>${INSTRUCTIONS_LOADER_JS}</script>
</section>`;
}

/**
 * instructions.html — the ONE place the instructions text is rendered.
 *
 * A complete page on its own (it is the no-JS fallback target), and the source
 * the index's loader reads `#instructions-body` from. Rendered from markdown at
 * generation time, like every other page here. No beacon: the index a tester
 * opened already recorded the visit, and this page is fetched by that index.
 *
 * Content lives in release-instructions.ts; release-instructions-cli.ts renders
 * this page and bin/publish-release-instructions.sh publishes it.
 */
export function renderInstructionsHtml(opts: Pick<PageOptions, 'generatedAt' | 'redact'>): string {
  const body = `<p><a href="index.html">← Releases and downloads</a></p>
<h1>Papercusp — ${escapeHtml(INSTRUCTIONS_HEADING)}</h1>
<section class="rel instructions">
  <div class="prose" id="${INSTRUCTIONS_BODY_ID}">${openLinksInNewTab(renderMarkdown(INSTRUCTIONS_MD))}</div>
</section>
<footer>Updated ${formatDate(opts.generatedAt)} · unlisted beta page</footer>`;
  return shell(`Papercusp — ${INSTRUCTIONS_HEADING}`, body, '', opts.redact ?? identityLiterals());
}

/**
 * Order: downloads BEFORE the changelog. A beta tester came here to get the
 * installer; making them scroll past the release notes to reach it is backwards.
 * It also keeps the prose honest — 0.0.8's changelog says "download the installer
 * above", which was a lie when the table rendered underneath it.
 */
function renderRelease(
  rel: HydratedRelease,
  isCurrent: boolean,
  maxWorkItems?: number,
  card?: ReleaseCard,
): string {
  const { row } = rel;
  const hasHotfixes = card !== undefined && card.hotfixes.length > 0;
  const artifacts = hasHotfixes ? cardArtifacts(card) : row.artifacts;
  const platformNotes = hasHotfixes ? hotfixPlatformNotes(card) : new Map<string, string>();
  const meta: string[] = [`Cut ${formatDate(row.cutAt)}`];
  if (row.publishedAt) meta.push(`published ${formatDate(row.publishedAt)}`);
  if (row.gitSha) meta.push(`<code>${escapeHtml(row.gitSha.slice(0, 12))}</code>`);

  const changelog = row.changelogMd?.trim()
    ? `<div class="changelog">${renderMarkdown(row.changelogMd)}</div>`
    : `<p class="empty">No changelog was written for this release.</p>`;

  // The newest release the card carries — a folded hotfix's version, not the
  // heading's. publish-release-history.sh binds the page to the release being
  // shipped through this attribute (WI-10003687).
  const newestVersion = hasHotfixes ? card.hotfixes[card.hotfixes.length - 1]!.row.version : row.version;

  return `<section class="rel" data-newest-release="${escapeHtml(newestVersion)}">
  <div class="rel-head">
    <h2>${escapeHtml(row.version)}</h2>
    <span class="tag">${escapeHtml(row.channel)}</span>
    ${isCurrent ? '<span class="tag current">latest</span>' : ''}
  </div>
  <p class="meta">${meta.join(' · ')}</p>
  ${renderArtifacts(artifacts, platformNotes)}
  ${changelog}
  ${hasHotfixes ? renderHotfixChangelogs(card) : ''}
  <p><a class="detail-link" href="changes/${releaseHistoryStem(row.version, row.channel)}.html">Explore plans, completed work and verification →</a></p>
${renderWork(rel, maxWorkItems)}
</section>`;
}

/** Release-scoped shared History, with existing static details as a fallback. */
export function renderProjectHistoryPage(rel: HydratedRelease, opts: PageOptions): string {
  const stem = releaseHistoryStem(rel.row.version, rel.row.channel);
  const fallback = renderWork(rel).replaceAll('href="plans/', 'href="../plans/')
    .replaceAll('href="work-items/', 'href="../work-items/');
  return shell(`Papercusp ${rel.row.version} — Changes`, `
<p><a href="../index.html">← All releases and downloads</a></p>
<h1>Changes in ${escapeHtml(rel.row.version)}</h1>
<p>Plans, completed work and their verification evidence for this ${escapeHtml(rel.row.channel)} release. Plan documents show their current ledger state; completed work is limited to this release.</p>
<section class="build-history-page" id="release-project-history" data-document="${stem}.json"></section>
<div id="release-history-fallback">${fallback || '<p>No product-facing work items were recorded for this release.</p>'}</div>
<script type="module" src="../assets/project-history.js"></script>`, '', opts.redact ?? identityLiterals(), {
    headExtra: '<link rel="stylesheet" href="../assets/project-history.css">',
  });
}

/**
 * THE HOLDING PAGE — what the beta link serves while the real page is held back
 * [owner 2026-07-28: "TEMPORARILLY change out releases page to just say 'NEXT
 * UPDATE COMING SOON' … leave the discord link too and leave teh video"].
 *
 * Deliberately NOT a variant of renderIndexHtml. The holding page's whole
 * purpose is that it shows NOTHING about releases, so building it by hiding
 * parts of the real page would mean every future edit to the real page has to
 * remember this mode exists — and the day someone forgets, a held page starts
 * leaking download tables. A separate function cannot regress that way.
 *
 * What it keeps, and why:
 *   - the video: it is the pitch, and it is the one thing on the page that is
 *     not release-specific;
 *   - Discord + a mailto: with the downloads gone, a tester who arrives needs a
 *     way to reach a human, or the page is a dead end;
 *   - the beacon: visits and contact clicks must still record while held, or the
 *     admin panel's Releases tab goes dark exactly when we most want to know
 *     whether testers are still showing up.
 *
 * What it drops: downloads, changelog, instructions, plan links. The installers
 * themselves stay published and reachable by direct link — this hides the page,
 * it does not unship a release.
 */
export function renderHoldingHtml(opts: PageOptions): string {
  const body = `<section class="rel holding">
  <h1>NEXT UPDATE COMING SOON</h1>
  <p class="sub">The beta downloads are paused while the next build is prepared. This page will be restored when it ships.</p>
  ${renderVideo()}
  <p class="sub">Questions, or want to stay in the loop?
    <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(DISCORD_URL)}">Join the Discord</a>
    &middot;
    <a href="mailto:${escapeHtml(PUBLISHED_CONTACT_EMAIL)}">Email us</a>
  </p>
</section>`;

  const footer = `<footer>Generated ${formatDate(opts.generatedAt)} &middot; unlisted beta page</footer>`;
  // The beacon stays on, so `release_history_viewed` keeps flowing to the admin
  // panel while the page is held. Version is null: no release is on offer here.
  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'index', null, '/index.html')
    : '';
  return shell('Papercusp — next update coming soon', `${body}\n${footer}`, beacon, opts.redact ?? identityLiterals(), {
    // The marker the publish gate keys its email allowance off — see
    // gate-release-site.ts allowedEmailsFor(). Without it the gate refuses this
    // page, which is exactly the behaviour we want for every OTHER page.
    headExtra: HOLDING_PAGE_MARKER,
    allowEmails: [PUBLISHED_CONTACT_EMAIL],
  });
}

/** The whole history — every release, newest first. */
export function renderIndexHtml(releases: HydratedRelease[], opts: PageOptions): string {
  // The Instructions section renders on EVERY index, including an empty one.
  // It is the page's standing "how to get started", not a property of a release
  // — gating it on the registry having rows would mean the one page where a
  // reader has the least context is the page that explains the least.
  let inlineWorkItemsRemaining = MAX_INDEX_WORK_ITEM_PREVIEW;
  // A platform-only hotfix (e.g. Windows 0.0.23 on top of 0.0.22) shares the
  // card of the release it patches — see groupReleaseCards.
  const releaseSections = groupReleaseCards(releases).map((card) => {
    const release = card.base;
    const previewLimit = Math.min(inlineWorkItemsRemaining, release.items.length);
    inlineWorkItemsRemaining -= previewLimit;
    return renderRelease(release, card.newestIndex === 0, previewLimit, card);
  });
  const body =
    releases.length === 0
      ? `<h1>Papercusp releases</h1>
<p class="sub">No releases have been recorded yet.</p>
${renderVideo()}
${renderInstructions()}`
      : `<h1>Papercusp releases</h1>
<p class="sub">Beta builds for testers. This page is unlisted — please don't share the link.</p>
${renderVideo()}
${renderInstructions()}
${releaseSections.join('\n')}`;

  const footer = `<footer>Generated ${formatDate(opts.generatedAt)} · unlisted beta page</footer>`;
  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'index', releases[0]?.row.version ?? null, '/index.html')
    : '';
  return shell('Papercusp releases', `${body}\n${footer}`, beacon, opts.redact ?? identityLiterals());
}

/**
 * `history.json` — the same release history, for the APP to read.
 *
 * ⚠ This exists because the obvious implementation of the in-app Update Center is
 * wrong. The registry lives in `harness_shared.releases` in OUR Postgres; a beta
 * tester's installed app has its own, empty database. A route that reads the
 * registry directly therefore works perfectly on the machine that cut the release
 * and shows an empty history to every actual user — the "works on my box" bug, in
 * a place nobody would look for it, because the code has no branch that can fail.
 *
 * So the history travels the SAME rail as the updater's manifest: a static file on
 * the release host, published next to `latest.json`, fetched over HTTPS. One
 * source of truth (the registry), two published projections (this and the page).
 *
 * It goes through the identity scrub for the same reason the page does — these are
 * bytes leaving this box for a human outside it, and the changelog is agent-written
 * prose from our own database, which is precisely the content we learned not to
 * trust.
 */
export function renderHistoryJson(releases: HydratedRelease[], opts: PageOptions): string {
  const json = {
    generated_at: opts.generatedAt.toISOString(),
    releases: releases.map((r) => ({
      tag: `desktop-v${r.row.version}${r.row.channel === 'stable' ? '' : `-${r.row.channel}`}`,
      version: r.row.version,
      channel: r.row.channel,
      notes: r.row.changelogMd ?? '',
      pub_date: (r.row.publishedAt ?? r.row.cutAt).toISOString(),
      prerelease: r.row.channel !== 'stable',
      artifacts: r.row.artifacts
        .filter((a) => !a.name.endsWith('.sig'))
        .map((a) => ({
          product: a.product,
          platform: a.platform,
          name: a.name,
          // RELATIVE, like everywhere else — the base path is the secret, and the
          // app already knows it (it is baked in as the update base URL).
          url: a.url,
          size: a.size,
          sha256: a.sha256,
        })),
    })),
  };
  return scrubIdentity(JSON.stringify(json, null, 2), opts.redact ?? identityLiterals());
}

/** One plan, rendered — the owner's "display the plan" surface. */
export function renderPlanPageHtml(
  plan: ShippedPlan,
  opts: PageOptions & { version: string },
): string {
  const md = stripDuplicateTitle(stripFrontmatter(plan.content).trim(), plan.title).trim();
  const content = md
    ? `<div class="prose">${renderMarkdown(md)}</div>`
    : `<p class="empty">This plan has no written content.</p>`;

  const body = `<a class="back" href="../index.html">← All releases</a>
<h1 class="plan-title">${escapeHtml(plan.title)}</h1>
<p class="sub">${plan.itemCount} work item${plan.itemCount === 1 ? '' : 's'} shipped in ${escapeHtml(opts.version)}</p>
${content}`;

  // The plan page's identity is its own relative path — which carries the plan
  // slug but NOT the secret base, so PostHog can break plan pages out from each
  // other without ever learning where the site lives.
  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'plan', opts.version, `/${planPagePath(plan.slug)}`)
    : '';
  return shell(
    `${plan.title} — Papercusp`,
    body,
    beacon,
    opts.redact ?? identityLiterals(),
  );
}

function formatItemTimestamp(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC');
}

function renderCompletionEvidence(item: ShippedItem): string {
  const evidence = item.terminalCompletionEvidence;
  const rows: string[] = [];
  const addText = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      rows.push(`<li><strong>${escapeHtml(label)}:</strong> <span class="detail-text">${escapeHtml(value.trim())}</span></li>`);
    }
  };

  addText('Completion record', item.terminalCompletionRef);
  if (evidence?.summary !== item.terminalCompletionRef) addText('Outcome', evidence?.summary);
  addText('Verified how', evidence?.verifiedHow);
  addText('Tests run', evidence?.testsRun);
  addText('Test result', evidence?.testResult);
  const filesChanged = Array.isArray(evidence?.filesChanged)
    ? evidence.filesChanged.filter((file): file is string => typeof file === 'string')
    : [];
  if (filesChanged.length) {
    rows.push(`<li><strong>Files changed:</strong> ${filesChanged.map((file) => `<code>${escapeHtml(file)}</code>`).join(', ')}</li>`);
  }
  if (evidence?.addedTests !== undefined) {
    rows.push(`<li><strong>Tests added or changed:</strong> ${evidence.addedTests ? 'Yes' : 'No'}</li>`);
  }
  if (evidence?.coverage) {
    const coverage = [
      ['Population', evidence.coverage.population],
      ['Checked', evidence.coverage.checked],
      ['Not checked', evidence.coverage.notChecked],
      ['Not applicable', evidence.coverage.notApplicable],
      ['Residue', evidence.coverage.residue],
    ] as const;
    for (const [label, values] of coverage) {
      const safeValues = Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string')
        : [];
      if (safeValues.length) rows.push(`<li><strong>${label}:</strong> ${safeValues.map(escapeHtml).join(', ')}</li>`);
    }
  }
  if (evidence?.treeStamp?.headSha) {
    rows.push(`<li><strong>Verified tree:</strong> <code>${escapeHtml(evidence.treeStamp.headSha)}</code></li>`);
  }
  if (item.completionAuthority) {
    rows.push(`<li><strong>Evidence status:</strong> ${escapeHtml(item.completionAuthority)}</li>`);
  }

  return rows.length > 0
    ? `<ul class="evidence-list">${rows.join('')}</ul>`
    : `<p class="empty">No completion or verification evidence was recorded.</p>`;
}

/** One complete public work-item page. Raw payloads/checkpoints never enter this projection. */
export function renderWorkItemPageHtml(
  item: ShippedItem,
  opts: PageOptions & { version: string; channel: string; plan?: ShippedPlan | null },
): string {
  const plan = opts.plan ?? null;
  const planValue = plan
    ? `<a href="../${escapeHtml(planPagePath(plan.slug))}">${escapeHtml(plan.title)}</a>`
    : item.planSlug
      ? escapeHtml(item.planSlug)
      : 'Not part of a plan';
  const description = item.summary?.trim()
    ? `<p class="detail-text">${escapeHtml(item.summary.trim())}</p>`
    : `<p class="empty">No description was recorded.</p>`;

  const body = `<a class="back" href="../index.html">← All releases</a>
<p class="sub"><span class="wid">${escapeHtml(item.id)}</span></p>
<h1 class="item-title">${escapeHtml(item.title)}</h1>
<section class="detail-card">
  <h2>Work item</h2>
  <dl class="detail-grid">
    <dt>Type</dt><dd>${escapeHtml(item.kind ?? 'work item')}</dd>
    <dt>State</dt><dd>${escapeHtml(item.state ?? 'unknown')}</dd>
    <dt>Release</dt><dd><a href="../index.html">${escapeHtml(opts.version)} (${escapeHtml(opts.channel)})</a></dd>
    <dt>Plan</dt><dd>${planValue}</dd>
    <dt>Created</dt><dd>${escapeHtml(formatItemTimestamp(item.createdAt))}</dd>
    <dt>Updated</dt><dd>${escapeHtml(formatItemTimestamp(item.updatedAt))}</dd>
    <dt>Completed</dt><dd>${escapeHtml(formatItemTimestamp(item.closedAt))}</dd>
  </dl>
</section>
<section class="detail-card"><h2>Description</h2>${description}</section>
<section class="detail-card"><h2>Completion and verification</h2>${renderCompletionEvidence(item)}</section>`;

  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'work-item', opts.version, `/${workItemPagePath(item.id)}`)
    : '';
  return shell(`${item.id}: ${item.title} — Papercusp`, body, beacon, opts.redact ?? identityLiterals());
}
