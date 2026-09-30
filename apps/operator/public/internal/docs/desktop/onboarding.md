# Onboarding — the agent-chat first run
URL: /internal/docs/desktop/onboarding

What a fresh install experiences — the concierge → agent-tutor conversation — plus how to re-run the tutorial and where the classic GUI wizard lives now.

Papercusp's first-run experience is a **guided walkthrough in a terminal, not a
wizard**. On a fresh install the desktop opens a full-window terminal — the
**Onboarding Console** — running a scripted concierge that installs your agent
framework, signs you in, and then hands the same terminal to a **scripted
tutorial you can ask questions in**. The deterministic parts (installing,
signing in, walking the tutorial) are just scripts; your agent is there for the
moments that aren't deterministic — your questions. The first experience *is*
the daily experience: describing what you want, in a terminal.

## What a new user sees

1. **The concierge** (works before any LLM exists) prints the welcome banner
   and asks one question: *which agent framework?* — Claude Code
   (recommended), Codex, or oh-my-pi + Meridian. If one is already installed
   and signed in it skips straight to the handoff.

2. **Guided install + sign-in** stream in the same terminal. Detection polls
   every few seconds, so installing manually in another terminal works too.

3. An optional **OpenAI embeddings key** step (recommended — it makes search
   and agent memory dramatically better; skippable).

4. **The tutorial**: the concierge hands the same window to a **scripted
   walkthrough**. It presents the tutorial one brief at a time, always ending
   with:

   `[1] Continue · [2] More details · [m] Menu · [f] Finish · or just type your question`

   The walkthrough itself is deterministic — the same content, in the same order,
   every time. Type `1`/`2`/`m`/`f` to navigate. The moment you type a real
   **question**, it hands that one turn to your agent, answers it, and drops you
   back into the tour. (The agent is used for your questions — not for reading you
   the script.)

5. **Graduation**: onboarding is marked finished; thereafter the app boots
   normally. Quitting anywhere is safe — progress is checkpointed after every
   section, so relaunching resumes exactly where you left off.

## Re-running the tutorial

Any time, two ways:

* The **Papercusp Tutorial** desktop icon (installed beside the server + GUI
  icons).
* `papercusp tutorial` in a terminal — tutorial-only mode: skips the setup
  stages detection reports complete, offers a section menu, and resumes where
  you left off.

## Where the GUI wizard went

The classic step-by-step Setup Wizard is **demoted, not removed** — it is the
standing fallback:

* **Settings → Advanced → Setup Wizard (classic)** (`/settings/setup-wizard`).
* Direct URL escape hatch: `/setup?force=1` (the Onboarding Console links to
  it — "Prefer clicking through a GUI?").
* **Automatic in a browser**: the chat-first console needs the desktop's pty;
  a plain browser gets a card pointing at the classic wizard instead.

## The cutover switch

First-run routing is gated by the `papercusp-onboarding-agent-first` flag
(default **ON**). Flipping it OFF restores the old behavior byte-for-byte —
fresh installs land on `/setup` — with the agent-chat console still reachable
at `/onboarding`. See `/admin/features` to flip.

## For engineers

Architecture, endpoint map, test coverage, and traps live in the runbook:
[agent-insights/agent-first-onboarding-architecture](/internal/docs/agent-insights/agent-first-onboarding-architecture).
