/**
 * The "Instructions" section of the beta release-history page — the owner's
 * words to beta testers, kept as SOURCE so the page can be regenerated from it.
 *
 * [owner 2026-07-27] asked for a section headed "Instructions" on the releases
 * page, placed ABOVE the download tables. [owner 2026-09-28, #807/#808/#811/
 * #812/#813] had it rewritten because it was long out of date: "Make it clear &
 * brief. The GUI IS READY". Then [owner 2026-09-28, #839]: "make launch PSU from
 * the terminal the main way ... add prefer the gui? ... direct to the HUD tab".
 * So: install both apps, set up once in the GUI (psu has no backend/embeddings
 * picker), then `psu` in a terminal is the main way, with the GUI's HUD tab as
 * the named alternative. It keeps the self-improvement and inference-gateway sections
 * (updated), and drops the old "GUI not ready / use psu" callout, the auto-loop
 * essay, and the "Not ready" list. [owner 2026-09-28, #823] then renamed the
 * self-improvement heading to "Don't like something about Papercusp?" and
 * brought the modes section back, rewritten brief and matched to the live mode
 * registry (AUTO, COLD AUTO, IDEATE, DRAIN, GRADE, TEST, AUDIT, GOAL).
 *
 * ── Why this lives in its own module ────────────────────────────────────────
 * It is CONTENT, not layout. release-history-page.ts renders the release
 * registry; this is prose a human rewrites between releases. Keeping it here
 * means editing it is a one-file diff with no risk of disturbing the renderer,
 * and the renderer stays a pure function of (registry, content).
 *
 * It stays a TypeScript constant rather than a `.md` file on disk because the
 * renderer is a pure, dependency-free function used by tests and by the CLI —
 * a filesystem read at generation time would make "what does the page say"
 * depend on cwd, on packaging, and on which checkout generated it.
 *
 * ── Editing it ──────────────────────────────────────────────────────────────
 * It is GitHub-flavoured markdown, rendered to HTML at GENERATION time. Raw HTML
 * is passed through. After editing, publish it — ONE command, from the tree you
 * edited, no release cut and no site regenerate:
 *
 *   papercusp-desktop/bin/publish-release-instructions.sh
 *
 * ── Why it is published separately [owner 2026-09-28, #868] ────────────────
 * "the instructions should come seperate from the release cut". The release
 * page used to embed this text, so every release re-rendered it from whichever
 * checkout cut that release. The 0.0.24 publish ran from a checkout pinned
 * before that day's edits and rolled the live instructions back
 * (EI-24562046738478155). Now the text is rendered ONLY into instructions.html
 * (renderInstructionsHtml), which the release index loads at view time.
 * record-release-cli never writes that file and publish-release-history.sh
 * never uploads it, so no release can change what testers read here.
 *
 * ⚠ Do NOT edit generated HTML by hand — the next publish overwrites it.
 *
 * ⚠ Every link here is rendered with `target="_blank"`, and the page ships
 * `<meta name="referrer" content="no-referrer">`, so clicking out never hands
 * the secret release path to Discord or anyone else. Keep it that way.
 *
 * ⛔ "Papercup" (the assistant in the quickpanel) and "Papercusp" (the product)
 * differ by one letter ON PURPOSE [owner 2026-07-27]. Never "fix" one into the
 * other in a copy-edit.
 */

/** The section heading, as the owner asked for it. */
export const INSTRUCTIONS_HEADING = 'Instructions';

/**
 * The beta Discord invite — ONE definition, because two pages now show it.
 *
 * The holding page (renderHoldingHtml) keeps this link when everything else on
 * the page is stripped, so a copy pasted into both places would eventually
 * diverge and the held page would send testers to a dead invite at exactly the
 * moment it is their only way to reach a human.
 */
export const DISCORD_URL = 'https://discord.gg/HjRQ8g4Nju';

/** The instructions text, approved by the owner [2026-09-28, #813]. */
export const INSTRUCTIONS_MD = `
<p>Questions? I'm on <a href="${DISCORD_URL}">Discord</a>.</p>

1. **Install both apps** for your platform from the downloads below: **Papercusp Server** and **Papercusp GUI**. On macOS, run the one Terminal command shown in the macOS section before first launch.
2. **Open Papercusp GUI once** and follow the setup. You'll pick:
   - an **agent backend**: Claude, Codex, or OMP (Oh My Pie)
   - an **embeddings provider** for agent memory: OpenAI (under $20/month with active use) or free local models (EmbeddingGemma + Harrier)
3. **Open a terminal and run \`psu\`.** This is the main way to work with Papercusp.
4. **Ask an agent to build something for you.** When it offers to launch a fleet, say yes.

Prefer the GUI? Open the **HUD** tab in Papercusp GUI to work with the same agents.

### Agent modes

Tell an agent to go into a mode, and what to focus on while it's there: *"Go into AUTO mode and finish the onboarding plan."* Modes combine, so AUTO + IDEATE works. Tell it to leave the mode when you want it back.

- **AUTO**: works on its own and stops asking you questions; it tells you what it decided instead. It keeps going through long jobs, starting a fresh session by itself when its context fills up.
- **COLD AUTO**: like AUTO, but every turn starts a fresh session from its saved notes. Cheaper for very long unattended runs, but less tested than AUTO.
- **IDEATE**: comes up with new features and improvements and writes them up as proposals. With AUTO on, it builds the best ones.
- **DRAIN**: works through a queue until it's empty: *"Drain the bug backlog with a fleet of 10 agents."* Turns on AUTO.
- **GRADE**: scores something against a rubric (a saved testing procedure), reusing an existing one or writing a new one. Every grading is saved as a scorecard, so you can track quality over time. Then it fixes what it found and grades again. Turns on AUTO.
- **TEST**: tests someone else's work independently. It reports the problems it finds instead of quietly fixing them, and leaves real tests behind.
- **AUDIT**: steps back and reviews a whole project end to end, then gives you an evidence-backed verdict on what works and what doesn't.
- **GOAL**: give it a goal and it runs the whole effort: it sets up the projects, plans, and agent fleets, hands out the building, and cuts what isn't working. Turns on AUTO and IDEATE.

You can also ask an agent to raise or lower how much context it holds before it starts fresh.

### Don't like something about Papercusp?

Ask an agent to change it. Papercusp has its own source code, so it can build your change and switch you to it live. The version switcher at the top picks which build you're running. If something breaks, click **Release** to go back to the installed version (or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>–<kbd>5</kbd>).

- **Dev**: your working copy, including uncommitted edits.
- **Staging**: everyone's merged work, committed automatically in the background.
- **Prod**: what passed the test suite.
- **Local**: live-reloading UI, for frontend work.
- **Release**: the build that shipped in the installer. Always works.

### Use several AI accounts (inference gateway)

In the GUI's Inference settings, sign in to more than one Claude Max or Codex account. When you start agents or a fleet, choose **auto**: Papercusp picks the account with the most headroom and switches when one hits its rate limit. You can also pin agents to one account. Mark one account as the default for anything that doesn't choose.
`.trim();
