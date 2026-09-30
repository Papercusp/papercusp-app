# Mobile operator app — feature + design feedback
URL: /internal/docs/design/mobile-operator-feedback

Captured live against http://localhost:1420/operator (paired to localhost:3070). Two sections — features for the feature agent, design for the design agent — independently actionable.

:::caution\[Surface superseded — the web mobile app was replaced by a native rebuild]
This memo critiques the old Tauri-WebView mobile app (`apps/operator-mobile`,
loaded at `localhost:1420`) and cites paths like
`apps/operator-mobile/src/screens/Operator.tsx` and
`apps/operator/lib/mobile-operator-actions.ts`. **Neither exists anymore** —
the `apps/operator-mobile` app and the `mobile-operator-actions.ts` helper are
gone. Mobile was revived as a **native** app (`papercup-rust-mobile`, Android +
iOS, a separate repo; see the plan `mobile-apps-revival-redesign-2026-06-05`)
with a redesigned IA: five **Inbox-first** tabs — **Inbox / Operator / Plans /
Fleet / Settings** — replacing the old Operator/Harness/Running/Inbox/Settings
set. The standalone suggestion-card feed is retired; cards now render inline as
actionable chat bubbles in the Operator thread, and the old "Running" tab was
folded into "Fleet". Treat the feature/design observations below as historical
design intent against a surface that no longer ships in this form.
:::

Captured live by loading the mobile app at `localhost:1420`, pairing
against `localhost:3070`, and walking all five tabs (Operator,
Harness, Running, Inbox, Settings). Screenshots in `/tmp/mob-*.png`.

This doc has **two sections**, written for two different agents.
Each section is self-contained — hand them off independently.

***

# Part 1 — Feature feedback (for the feature agent)

The mobile app's information architecture is good — five tabs map to
the five things a user wants on the go. But the *operator-specific*
features are thin compared to desktop. Below is what's missing or
half-shipped, in roughly priority order.

## 1.1 Inform/navigate cards collapse "read it" and "skip it" into one button

**Correction from round 1: I previously claimed this was a real-money
safety bug — that was wrong.** Reading
`apps/operator-mobile/src/screens/Operator.tsx:82-110`:

* **Directive** cards already render two buttons: *Dispatch* + *Dismiss*.
* **Inform / navigate** cards render a single *Acknowledge* button,
  which calls `dismissCard()` (not `dispatchCard()`).
* The `dispatchCard()` helper at
  `apps/operator/lib/mobile-operator-actions.ts:89` short-circuits to
  `"advisory; nothing to dispatch"` for non-directive cards anyway.

So "Acknowledge on an inform card" is just dismiss with a softer
label. No money is at risk.

**The actual (smaller) issue** is that "Acknowledge" overloads two
distinct intents on inform/navigate cards:

* *"I read it, hide it from me"* → equivalent to dismiss.
* *"I followed the navigate link"* → no specific affordance.

On desktop, navigate cards have an "Open ↗" action that follows the
link AND dismisses. Mobile has only Acknowledge, which dismisses
without a dedicated way to follow.

**Fix:**

* For `navigate` cards, render *Open ↗* (which navigates + dismisses)
  alongside *Dismiss*.
* For `inform` cards, *Acknowledge* is fine as-is; consider renaming
  to *Got it* — clearer that it's "dismiss after reading."
* Directive cards (Dispatch + Dismiss) are already correct; no
  change needed.

This is medium-priority — clarity, not safety.

## 1.2 No tier / risk indicator

Cards on desktop carry `tier: low | medium | high`, color-coded.
Mobile shows just `#N · inform` and `pending` — no tier. A user has
no way to tell "this is high-risk, careful" from "low-risk, sure" on
their phone.

**Fix:** show tier as a colored dot or chip next to `#N`:
`● #1 · inform` (red dot for high, amber for medium, green for low).
Pair with §1.1 — mobile should ASK before dispatching anything tier
≥ medium.

## 1.3 No Pause toggle

The single most natural mobile gesture for the operator is *"pause
from your pocket"* — and there's no UI for it. Settings has *Standing
approvals* and *Unpair*, but no Pause.

**Fix:** add a *Pause / Resume* toggle as a sticky bar at the top of
the Operator tab (or as a header-right button). Tapping pauses the
operator workspace-wide; same FS flag the desktop reads.

## 1.4 Voice button is silent

Bottom-right floating `◉` voice button has no state — same glyph for
idle, listening, connecting, error. On desktop, voice cycles through
mute / connecting / listening / speaking states. Mobile has none of
that visual feedback.

**Fix:** replace `◉` with a state-aware glyph and color:

* Idle: outline `🎙` gray
* Listening: filled `🎙` red, gentle pulse
* Connecting: filled `🎙` amber, spinner
* Speaking: filled speaker `🔊` cyan
* Error: red exclamation, tap to see error toast

## 1.5 Running tab has no controls

`/running` shows *"OPERATOR · SCANNING · 8M · $0.0000"* — clearly a
status dump. No way to **cancel** a running operator scan. No way to
**inspect** what it's actually scanning. The 8-minute scan time + 0
cost is suspicious — looks like the scan is wedged.

**Fix:**

* Add a *Cancel scan* button on running operator entries.
* Make the row tappable → drawer with current substep / progress.
* Show recent completed scans (tap → see resulting cards).

## 1.6 Inbox doesn't link back to source

Inbox shows entries like *"Dispatched: 8 harnesses have
accept-with-notes plan reviews"* — but tapping doesn't take you to
the originating card. The notification is a dead-end.

**Fix:** every notification that came from a card stores the
`cardId`; tapping should jump to `/operator?card=<id>` (highlighted +
scrolled into view). For dispatched-card notifications, jump to the
running harness if available.

## 1.7 Bottom nav has no unread badge

When new operator cards arrive, the *Operator* tab doesn't show a
badge. Same for new notifications on *Inbox*. Push notifications are
the only signal a user gets about new state — and once the
notification is gone, you can't tell at-a-glance there's stuff to
review.

**Fix:** badge on Operator tab when `pending > 0` (count or dot).
Badge on Inbox tab when `unread > 0`. Match the OS-native badge
pattern — small red circle, tab icon.

## 1.8 No Scan history tab on mobile

Desktop just shipped a Scan history tab (this session) so users can
review what previous scans suggested. Mobile has no equivalent. A
power user wants to be able to ask their phone *"what did the
operator suggest 2 hours ago?"* and currently can't.

**Fix:** new tab or a `History →` link from `/operator` header → list
of past scans (summary + cards emitted), same shape as desktop.

## 1.9 No Delegates surface

Desktop has a Delegates section showing background tasks the operator
handed off. Mobile doesn't expose this at all. If the user has 3
in-flight delegates from voice asks, they can't see them on the phone.

**Fix:** add Delegates tab, or fold into Running tab as a sub-row.
Same data, smaller cards.

## 1.10 Auto-fire countdown not visible

Desktop shows *"Auto-fire pending — 23s"* with cancel affordance.
Mobile shows the same auto-dispatch card as static `pending` with the
same Acknowledge button. A user can't even tell which cards will
auto-fire vs. which need their tap.

**Fix:** for `auto_dispatch && pending` cards, show a countdown chip
(`Auto-firing in 17s`) and replace the action button with *Cancel
auto-fire*.

## 1.11 No per-card recipient on mobile

Desktop cards show *"→ sheets"* (target harness). Mobile cards only
show recipient for `navigate` cards. Directive cards don't say which
harness will receive the directive.

**Fix:** show target harness as a chip on every directive card —
*"will send to `sheets`"* — so the user sees the consequence before
tapping.

## 1.12 Voice STT/TTS shows "Web Speech (local)" with no controls

Settings shows *"STT/TTS: Web Speech (local)"* but you can't change
it from there. The desktop has a full /settings/voice page with
engine selection, voice ID, model, etc. Mobile has just a *Voice
settings ›* link that drops the user out — and the inline label is
read-only.

**Fix:** make the *Web Speech (local)* string a tappable chooser, or
remove the inline preview and let the link page do the work
(consistent with how *Standing approvals* is shipped).

## 1.13 Misleading Settings labels

Settings shows *"Desktop: localhost:1420"* — but `1420` is the
*mobile* dev port. The actual desktop pair target is `localhost:3070`.
Looks like the label is reading the wrong field.

**Fix:** label this as *"Paired with: localhost:3070"* (the desktop
host the JWT was minted for, not the mobile origin).

## 1.14 No first-run / orientation

After pairing, the user is dropped into `/operator` with 5 cards and
no orientation. Same complaint as desktop §1.10 in the prior memo —
new users have no idea what tiers, dispatches, or harnesses are.

**Fix:** 3-step coachmark on first visit:

1. *"These are suggestion cards from your operator. Tap a card to
   see detail; use Dispatch / Open / Dismiss."*
2. *"Tap the voice button to talk. Say 'pause' or 'scan' to
   control the operator hands-free."*
3. *"Bottom tabs let you check harness status, what's running, and
   recent notifications."*

***

# Part 2 — Design feedback (for the design agent)

Tone: this is a phone app for a power-user agent operator on the go.
Stakes are real (cards fire money-spending workers). Visual design
should reinforce *"think before tapping"*, not encourage rapid
flicking-through. Several current choices push the wrong direction.

## 2.1 Visual hierarchy is inverted on cards

On every operator card:

* The cyan `#1 · INFORM` eyebrow shouts (12px uppercase, cyan-400 on
  near-black — high contrast).
* The `pending` pill whispers (10px uppercase, neutral-500 on
  neutral-900 — barely visible).
* The body text speaks at normal volume (14px neutral-300).
* The single `Acknowledge` button is the visually heaviest element
  (full-width, bordered, takes up \~30% of card real estate).

**Result:** the eye lands on `#1 · INFORM` first (which is a
debug-style index + type label), then jumps to the button (which is
the *commit* action), barely registering the body in the middle.
Reading order is upside down.

**Fix:**

* Demote the `#N · type` label to small gray (or drop entirely; no
  user needs the ordinal).
* Promote the lifecycle state (`pending` / `in flight` / etc.) to be
  the most prominent meta — color-coded chip on the right of the card
  head.
* Make the body the visual anchor — slightly larger (15-16px) and
  higher-contrast (neutral-100 or white).
* De-emphasize Acknowledge until the user has read the body — neutral
  outline button, not a heavy filled one.

## 2.2 Cards have no title — body is the title

The body text is doing two jobs: it's the lede AND the explanation.
Compare:

```
#1 · INFORM   pending
Non-accept plan verdict surfaces as inform per operator prompt rules.
[Acknowledge]
```

vs. an extracted title:

```
●low   pending  →  
Plan verdict surfaced as inform
Non-accept verdict — see inform rules in operator prompt.
[Acknowledge]
```

The desktop card has `card.title` separate from `card.body`. Mobile
appears to be using only the body — losing the structural advantage.

**Fix:** render `card.title` as the heading (16-18px, semibold);
`card.body` as the explanation below in normal weight.

## 2.3 Color is doing nothing

Every card is the same color. Tier (the single most consequential
attribute) has no visual representation. The cyan accent on `#1` and
on links is the only color signal — used for two different things.

**Fix:** make tier color-led:

* Low: subtle green left rail (4px) + green dot in head
* Medium: amber left rail + amber dot
* High: red left rail + red dot

This is the strongest mobile-native signal you can deliver. A user
flicking through their phone should see red/amber/green and know
*before reading* whether they need to focus.

## 2.4 Typography mixes 3 sizes per card

`10px` (pending) / `12px` (eyebrow) / `14px` (body) — three different
sizes inside the same card head + body, plus a 4th for the button
(`14px`). Eye has to context-switch four times per card.

**Fix:** collapse to two sizes per card — `12px` (meta + state +
buttons) and `15px` (title + body). Use weight (semibold vs. normal)
and color (white vs. neutral-400) for hierarchy instead of size.

## 2.5 Bottom nav glyphs are inscrutable

Current bottom nav:

| Glyph | Label    |
| ----- | -------- |
| `●`   | Operator |
| `⌘`   | Harness  |
| `▶`   | Running  |
| `◆`   | Inbox    |
| `⚙`   | Settings |

`⌘` is the **command key** in user mental models (Mac users will
expect it to invoke a command palette, not navigate). `●` for
"Operator" reads as "currently active" rather than as an icon for the
operator. `◆` is just a diamond.

**Fix:** use proper Lucide / Phosphor / Material icons:

* Operator: brain / scan-search / radar
* Harness: layers / kanban
* Running: play-circle / activity
* Inbox: bell / inbox
* Settings: settings (gear)

Geometric symbols feel placeholder; real icons feel finished.

## 2.6 Voice button is a debug widget

The floating voice button is a small `◉` circle bottom-right. No
label. No state. No animation. No ring. No safe-area inset (could be
under iOS home indicator).

**Fix:**

* Replace `◉` with a recognizable mic icon.
* Add a status ring (or pulsing border) when listening.
* Inset from bottom by `env(safe-area-inset-bottom) + 80px` so it's
  above the bottom nav on notch phones.
* Optional: a "tap to talk / hold to push-to-talk" affordance —
  desktop voice runs always-on; on mobile, push-to-talk often makes
  more sense (battery + accidental wake).

## 2.7 The PAIRING / CONNECTION / VOICE / ABOUT sections are unstyled lists

Settings is a flat plain text list with vertical labels and values.
No visual grouping beyond uppercase section headers. Compare to iOS
Settings (grouped table cells with rounded corners, dividers between
items, chevron-right on tappable rows).

**Fix:** standard mobile grouped-list pattern:

* Card-shaped section wrapper (rounded, border)
* Each row: label left, value or `›` right
* Dividers between rows
* Tappable rows have chevron + tinted background on press

## 2.8 Card list could use breathing room

Cards are stacked tight. On desktop, the operator panel has lots of
chrome around cards (sidebars, etc.); on mobile, cards are most of the
screen — they need more space between them, not less.

**Fix:** `gap-3` → `gap-4`. Inner card padding `p-4` → `p-5`.
Header has the count (`5 pending`) — this could be a sticky header
on scroll, with cards beneath using full vertical space.

## 2.9 Running tab feels like a `console.log`

```
Now running
OPERATOR
SCANNING
8M
Scan the workspace and surface up to 5 next-action suggestions.
$0.0000
HARNESSES (0)
No harnesses currently running.
```

This is debug output presented as UI. Layout makes it look like a
shell prompt.

**Fix:** make this a proper status card:

```
┌─ Operator ─────────────── ⏹ Cancel ┐
│  Scanning workspace · 8m elapsed   │
│  Pending: 0 spend                  │
│  ━━━━━━━━━━━━━━━━━━━━━━━ 8/?      │
└────────────────────────────────────┘

  Running harnesses
  None running
```

Each running thing is a card with an icon, status, elapsed time,
metrics, and a cancel control.

## 2.10 No haptics, no transitions, no native feel

Pure web app feel — taps are flat, navigation between tabs has no
slide animation, no haptic feedback on Acknowledge. On a Tauri /
WebView mobile app there's no excuse not to use native primitives.

**Fix:**

* Tab transitions: slide-and-fade (use Motion / Framer Motion).
* Card actions: light haptic on tap (Tauri has a haptics API; web
  has `navigator.vibrate` as fallback).
* Acknowledge → confirmation animation (checkmark + slide-out).

## 2.11 Empty states are blunt

Harness tab and Running tab show *"No harnesses currently running."*
in the middle of the screen. No illustration, no guidance, no
"learn more" link.

**Fix:** make empty states:

* Light SVG illustration (don't have to be fancy — simple line art).
* Heading: *"Nothing running yet"*.
* One-line subtitle: *"When the operator dispatches a harness, it'll
  appear here."*
* Optional CTA: *"Run a scan now"* (button) or *"See past scans"*
  (link to /history).

## 2.12 Dark theme is fine but flat

Pure dark with neutral-900 cards on neutral-950 background. Borders
are `border-neutral-800` — visible but flat. No depth.

**Fix:** very subtle elevation gradient on cards (1-2% lighter at
top edge → original at bottom). Or a faint inner glow on the
*currently-tappable* card. Adds dimension without changing the
palette.

***

# Cross-cutting: shared work between feature + design

A few fixes need both agents:

* **Tier color-coding (§1.2 + §2.3):** feature agent surfaces tier
  in the data; design agent renders it as red/amber/green left rail
  and chip.
* **Action confirm flow (§1.1 + §2.10):** feature agent wires up the
  three actions (Dispatch / Open / Dismiss); design agent lays out
  the slide-up confirmation panel.
* **Voice state (§1.4 + §2.6):** feature agent emits the state
  events from the voice client; design agent renders them.

***

# Top-priority list

If the agents can ship one thing each in the next iteration:

**Feature agent:**

> §1.3 Pause toggle. Most-natural mobile feature, trivially small
> wire-up. Most days a user wants this from their phone before
> they want anything else.

**Design agent:**

> §2.3 Tier color-coding on cards. Without it the user has no way to
> tell "this needs my attention" from "this is fine to skip" when
> flicking through their phone.

If they can ship two each:

**Feature agent:** §1.4 Voice button state visibility. Today the same
glyph shows for idle / connecting / listening / error.

**Design agent:** §2.5 Replace bottom-nav glyphs with real icons.
The current set looks like a wireframe.

***

# How I gathered this

* Loaded `http://localhost:1420/operator` in Edge.
* Quick-paired against `localhost:3070`.
* Walked all 5 tabs (Operator, Harness, Running, Inbox, Settings).
* Captured screenshots at `/tmp/mob-{operator,harness,running,
  notifications,settings}.png`.
* Inspected card markup via DOM eval (cyan eyebrow, neutral pill,
  button class structure observed directly).
* Cross-referenced against the desktop OperatorPanel feature surface
  to identify gaps.
