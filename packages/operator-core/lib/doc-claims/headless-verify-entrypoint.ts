/**
 * headless-verify-entrypoint.ts — EI-19341315235545734.
 *
 * THE CLAIM THIS PINS: CLAUDE.md's "▶ Running / testing this app" section must hand an
 * AGENT `scripts/verify-tauri-headless.sh` — the isolated Xvfb + own-port + own-sidecar
 * + scoped-teardown rig — and must present `cd papercusp-desktop && npm run dev` only as
 * the ATTENDED/human form.
 *
 * WHY THIS NEEDS A GUARD RATHER THAN A CAREFUL AUTHOR. That section is the first thing
 * every agent in the fleet reads, and for months it named `npm run dev` as "the ONLY
 * supported way to run or test the app". On this box an agent shell inherits
 * `DISPLAY=:1` — the owner's real desktop — so the doc's most emphatic instruction was
 * the one command agent-e2e.mdx §0 forbids outright ("focus-stealing is unacceptable").
 * WI-2648 is the recorded incident where synthetic input from a verification run leaked
 * into the owner's real email draft; WI-7101 is the one where a second `tauri dev`
 * killed the owner's live desktop outright.
 *
 * The isolated rig existed the whole time. EI-9005 created it precisely because agents
 * SKIP the owner-required UI-verification gate when hand-deriving an isolated instance
 * looks expensive — and then the file every agent is guaranteed to read went on routing
 * them to the focus-stealing command, with the script's name buried ~250 lines into a
 * 2350-line doc. Two independent work-items hit that gap in one week (EI-9005, WI-3658).
 *
 * So the failure mode is not "someone writes something false". It is that the correct
 * entrypoint drifts back out of the one file that is guaranteed to be read, silently,
 * while every individual sentence stays true. That is a claim about code (a script path
 * and its invocation forms) living in prose — rung 2 of the derived-truth ladder: PIN it.
 *
 * SCOPE — this judges the DOC TEXT's routing only. It says nothing about whether the rig
 * actually isolates what it claims to isolate (the script's own header documents what is
 * NOT isolated: the database, the workspace, the WebView profile), nor about whether any
 * particular verification run was sound. Those are separate claims with separate probes.
 */

/** A fenced command block found inside the judged section. */
export interface FencedBlock {
  /** 1-based line number of the opening fence, in the judged document. */
  readonly startLineNo: number;
  /** The block's contents, fences excluded. */
  readonly body: string;
  readonly namesHeadlessScript: boolean;
  readonly namesAttendedLaunch: boolean;
}

/** A prose site prescribing the window-opening launch. */
export interface AttendedLaunchSite {
  readonly line: string;
  readonly lineNo: number;
  /** True when this site (or the two lines under it) marks the form attended/human. */
  readonly markedAttended: boolean;
}

export interface HeadlessEntrypointVerdict {
  readonly ok: boolean;
  readonly sectionFound: boolean;
  /** 1-based line number of the section heading, or null when absent. */
  readonly sectionStartLineNo: number | null;
  readonly fencedBlocks: readonly FencedBlock[];
  /** The FIRST fenced block in the section — what a skimming agent copies. */
  readonly primaryBlock: FencedBlock | null;
  /**
   * Invocation forms the doc prescribes for the script, as the literal argv tokens that
   * follow it (`--`, `--boot-only`, …). The executable probe checks these against the
   * script's own `--help`, so a doc that prescribes a retired flag reds here.
   */
  readonly prescribedInvocations: readonly string[];
  readonly attendedLaunchSites: readonly AttendedLaunchSite[];
  readonly violations: readonly string[];
}

/** The section whose routing is judged. Matched on its stable words, not its full title. */
const SECTION_HEADING = /^#{2,3}\s.*Running\s*\/\s*testing this app/i;

/** Any `##`-level heading — where the judged section ends. */
const NEXT_SECTION = /^##\s/;

/** The isolated rig. A path claim: the executable probe checks it resolves. */
export const HEADLESS_SCRIPT = 'scripts/verify-tauri-headless.sh';

/** The window-opening launch, matched on the exact form the doc prescribes. */
const ATTENDED_LAUNCH = /cd\s+papercusp-desktop\s+&&\s+npm\s+run\s+dev/;

/** What makes an attended-launch site legible as attended rather than as the default. */
const ATTENDED_MARKER = /\b(attended|human)\b/i;

/** Lines below an attended-launch site that may carry its marker. */
const ATTENDED_MARKER_WINDOW = 2;

/** Argv tokens the doc may prescribe after the script path. */
const INVOCATION_TOKEN = /(^|\s)(--[a-z0-9-]*)/g;

const MIN_JUDGEABLE_CHARS = 200;

/** Extract the judged section's lines, with the document line number of each. */
function sliceSection(lines: readonly string[]): { start: number; lines: string[] } | null {
  const start = lines.findIndex((l) => SECTION_HEADING.test(l));
  if (start < 0) return null;

  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((l) => NEXT_SECTION.test(l));
  const body = endOffset < 0 ? rest : rest.slice(0, endOffset);
  return { start: start + 1, lines: body };
}

/**
 * Judge a doc body (CLAUDE.md, AGENTS.md, or the projected corpus).
 *
 * REFUSES a body too short to contain the section rather than reporting it clean — a
 * failed or moved read must never be indistinguishable from a passing gate.
 */
export function judgeHeadlessVerifyEntrypoint(docText: string): HeadlessEntrypointVerdict {
  if (!docText || docText.length < MIN_JUDGEABLE_CHARS) {
    throw new Error(
      `Refusing to judge a ${docText?.length ?? 0}-char doc body: too short to contain ` +
        'the run/test section. A failed read must not read as a clean verdict.',
    );
  }

  const lines = docText.split('\n');
  const section = sliceSection(lines);
  const violations: string[] = [];

  if (!section) {
    return {
      ok: false,
      sectionFound: false,
      sectionStartLineNo: null,
      fencedBlocks: [],
      primaryBlock: null,
      prescribedInvocations: [],
      attendedLaunchSites: [],
      violations: [
        'SECTION MISSING: no "▶ Running / testing this app" heading. The guard measured ' +
          'nothing; it does not mean the routing is correct.',
      ],
    };
  }

  // The section heading itself is line `section.start`; its body starts one line later.
  const bodyStartLineNo = section.start + 1;
  const sectionText = section.lines.join('\n');

  const fencedBlocks: FencedBlock[] = [];
  const prescribedInvocations = new Set<string>();
  const attendedLaunchSites: AttendedLaunchSite[] = [];

  let openFenceAt: number | null = null;
  let openBody: string[] = [];

  section.lines.forEach((line, i) => {
    const lineNo = bodyStartLineNo + i;

    if (/^\s*```/.test(line)) {
      if (openFenceAt === null) {
        openFenceAt = lineNo;
        openBody = [];
      } else {
        const body = openBody.join('\n');
        fencedBlocks.push({
          startLineNo: openFenceAt,
          body,
          namesHeadlessScript: body.includes(HEADLESS_SCRIPT),
          namesAttendedLaunch: ATTENDED_LAUNCH.test(body),
        });
        openFenceAt = null;
        openBody = [];
      }
      return;
    }
    if (openFenceAt !== null) openBody.push(line);

    if (line.includes(HEADLESS_SCRIPT)) {
      const after = line.slice(line.indexOf(HEADLESS_SCRIPT) + HEADLESS_SCRIPT.length);
      for (const m of after.matchAll(INVOCATION_TOKEN)) {
        // A bare `--` separates the script from its assertion argv; longer tokens are flags.
        prescribedInvocations.add(m[2] === '--' ? '--' : m[2]);
      }
      if (/\s--\s/.test(after)) prescribedInvocations.add('--');
    }

    if (ATTENDED_LAUNCH.test(line)) {
      const window = section.lines.slice(i, i + 1 + ATTENDED_MARKER_WINDOW).join('\n');
      attendedLaunchSites.push({
        line: line.trim(),
        lineNo,
        markedAttended: ATTENDED_MARKER.test(window),
      });
    }
  });

  const primaryBlock = fencedBlocks[0] ?? null;

  if (!sectionText.includes(HEADLESS_SCRIPT)) {
    violations.push(
      `NO HEADLESS ENTRYPOINT: the run/test section never names \`${HEADLESS_SCRIPT}\`. ` +
        'An agent reading only this section is routed at the owner\'s live desktop ' +
        '(EI-9005, WI-2648).',
    );
  }

  if (!primaryBlock) {
    violations.push(
      'NO COMMAND BLOCK: the run/test section prescribes no fenced command at all, so ' +
        'the guard cannot tell which command an agent copies first.',
    );
  } else if (!primaryBlock.namesHeadlessScript) {
    violations.push(
      `PRIMARY COMMAND IS NOT THE ISOLATED VERIFIER: the first fenced block (line ` +
        `${primaryBlock.startLineNo}) does not name \`${HEADLESS_SCRIPT}\`` +
        (primaryBlock.namesAttendedLaunch
          ? ' and instead prescribes the window-opening `npm run dev` launch'
          : '') +
        '. The first block is what a skimming agent copies.',
    );
  }

  for (const site of attendedLaunchSites) {
    if (site.markedAttended) continue;
    violations.push(
      `UNMARKED ATTENDED LAUNCH (line ${site.lineNo}): \`${site.line}\` prescribes the ` +
        'window-opening launch without marking it attended/human. On this box that ' +
        "opens a window on the owner's live desktop (DISPLAY=:1).",
    );
  }

  return {
    ok: violations.length === 0,
    sectionFound: true,
    sectionStartLineNo: section.start,
    fencedBlocks,
    primaryBlock,
    prescribedInvocations: [...prescribedInvocations].sort(),
    attendedLaunchSites,
    violations,
  };
}
