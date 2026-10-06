/**
 * computer:observe + computer:click_element — the accessibility observation path
 * (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * WHY SEPARATE TOOLS AND NOT NEW `capability:computer` ACTIONS. `capability:computer`
 * mirrors the canonical Anthropic `computer_20250124` action vocabulary VERBATIM, and
 * that is load-bearing rather than stylistic: the model was post-trained on that exact
 * action set, so its grounding priors fire on it. Adding `observe` / `click_element`
 * to that enum would make the tool a near-miss of the vocabulary the model knows,
 * which is worse than either a faithful copy or an honestly separate tool. The plan
 * says the tree sits "BESIDE the screenshot path", and this is what beside means.
 *
 * The two are complements, not competitors, and the guidance says so plainly: the tree
 * is cheap and semantic but sees ONLY what the toolkit exports, so a canvas app, a
 * video, or a plain X11 client like `xterm` is invisible to it. The screenshot is the
 * fallback that always works and the tree is the one to reach for first.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  actionCommand,
  elementClickPoint,
  estimateImageTokens,
  estimateTextTokens,
  findByRef,
  parseA11yActionOutput,
  NoAccessibilityBusError,
  type A11yActionResult,
} from './accessibility-tree';
import {
  resolveA11yBus,
  snapshotA11yTree,
  type A11ySnapshot,
  type SnapshotOptions,
} from './a11y-snapshot';
import { captureScreenshotPng, computerExec, desktopArg, resolveBoundDisplay, type ComputerCtx } from './computer';
import { planAction, xdotoolCommand, type DesktopTarget } from './desktop-driver';
import { recordAction, renderLedgerLine } from './action-ledger';
import { isRecording, noteRecordedAction } from './trajectory-recorder';

/**
 * Record an activation on the P-008 action ledger — and, when a P-009 recording is
 * open, park its frame (D-013 §4).
 *
 * P-008 shipped the ledger on `capability:computer` only, so every AT-SPI
 * activation was invisible to it: the ledger claimed to answer "what has this
 * desktop been asked to do" while omitting exactly the path P-007 teaches agents to
 * PREFER — the cheapest path was also the unrecorded one. A tree-driven trajectory
 * would then record frames with no actions to explain them. The line is emitted
 * like `capability:computer` emits it, so seq numbers stay dense in the transcript.
 */
async function recordActivation(
  target: DesktopTarget,
  input: { action: string; coordinate?: readonly [number, number]; ok: boolean; note?: string },
  signal?: AbortSignal,
): Promise<string> {
  const entry = recordAction(target.display, { ...input, observed: 'none' });
  if (isRecording(target.display)) {
    await noteRecordedAction(target.display, entry, {
      capture: () => captureScreenshotPng(target, signal),
    });
  }
  return renderLedgerLine(entry);
}

/** Resolve the a11y bus a display advertises, or throw the loud refusal. */
async function resolveBus(display: string, signal?: AbortSignal): Promise<string> {
  const addr = await resolveA11yBus(display, computerExec, signal);
  if (!addr) throw new NoAccessibilityBusError(display);
  return addr;
}

/**
 * One snapshot, or the loud refusal these two tools have always thrown.
 *
 * P-008 moved the walk itself into `a11y-snapshot.ts` so `capability:computer` can
 * share it. That module returns REASONS instead of throwing, because its other
 * caller has to be able to fall back to pixels deliberately; these two tools have
 * no fallback and are meant to fail loudly, so the reasons are re-raised here.
 * `no-apps` is NOT an error — an empty bus is a real, reportable state — so it is
 * handed back for the caller to narrate.
 */
async function snapshotOrThrow(
  tool: string,
  target: DesktopTarget,
  opts: SnapshotOptions = {},
): Promise<A11ySnapshot> {
  const snap = await snapshotA11yTree(target, computerExec, opts);
  if (!snap.ok) {
    if (snap.reason === 'no-bus') throw new NoAccessibilityBusError(target.display);
    if (snap.reason === 'walker-failed') throw new Error(`${tool} — ${snap.detail}`);
  }
  return snap;
}

const observeArgs = z.object({
  include_hidden: z.boolean().optional().describe('Include elements the toolkit reports as not on screen (e.g. unopened menus). Default false.'),
  include_bounds: z.boolean().optional().describe('Include each element\'s on-screen box. Default false — you click by #ref, not by coordinate.'),
  max_nodes: z.number().int().positive().max(2000).optional().describe('Cap the elements returned (default 200).'),
  desktop: desktopArg,
});

export async function runObserve(args: z.infer<typeof observeArgs>, ctx: ComputerCtx = {}) {
  const target = await resolveBoundDisplay(ctx, { desktop: args.desktop });
  const snap = await snapshotOrThrow('computer:observe', target, {
    includeHidden: args.include_hidden ?? false,
    includeBounds: args.include_bounds ?? false,
    ...(args.max_nodes ? { maxNodes: args.max_nodes } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (!snap.ok) {
    // The only reason that reaches here is `no-apps` — a successful walk of an
    // empty bus, which must not read as "the desktop is empty".
    return {
      content: [
        {
          type: 'text' as const,
          text: `${snap.detail} Take a capability:computer screenshot to see what is actually on screen.`,
        },
      ],
    };
  }

  // The comparison the plan asks to measure, computed on the SAME screen, so it is a
  // ratio rather than an absolute claim (see estimate* for why that matters).
  const treeTokens = estimateTextTokens(snap.tree);
  const fit = target.capture ?? { width: target.width, height: target.height };
  const shotTokens = estimateImageTokens(
    Math.min(fit.width, target.width),
    Math.min(fit.height, target.height),
  );

  const header =
    `${snap.apps} application(s) on the accessibility bus · ${snap.stats.keptNodes} of ${snap.stats.rawNodes} elements shown` +
    `${snap.stats.truncated ? ' (truncated)' : ''} · ~${treeTokens} tokens vs ~${shotTokens} for a screenshot of this desktop` +
    `${!snap.boundsTrustworthy ? '\n⚠ This toolkit reports unusable screen coordinates; click by #ref (computer:click_element), not by pixel.' : ''}`;

  return {
    content: [{ type: 'text' as const, text: `${header}\n\n${snap.tree}` }],
  };
}

const clickArgs = z.object({
  ref: z.string().describe('The #ref of the element, exactly as computer:observe printed it (e.g. "0/0/2/1").'),
  action: z.string().optional().describe('Which of the element\'s actions to fire (default: its first). computer:observe does not list these; omit unless a previous error named one.'),
  desktop: desktopArg,
});

export async function runClickElement(args: z.infer<typeof clickArgs>, ctx: ComputerCtx = {}) {
  const target = await resolveBoundDisplay(ctx, { desktop: args.desktop });
  const bus = await resolveBus(target.display, ctx.signal);
  const cmd = actionCommand(target.display, bus, args.ref, args.action);
  const r = await computerExec(cmd.bin, cmd.args, { env: cmd.env, signal: ctx.signal });
  const parsed = parseA11yActionOutput(r.stdout.toString());

  if (parsed?.ok) {
    const line = await recordActivation(
      target,
      { action: `click_element #${args.ref.replace(/^#/, '')}`, ok: true },
      ctx.signal,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: `${line}\nActivated ${parsed.role ?? 'element'}${parsed.name ? ` "${parsed.name}"` : ''} (#${args.ref.replace(/^#/, '')}) via "${parsed.performed}". Call computer:observe again to see the result.`,
        },
      ],
    };
  }

  // No activating action: fall back to a pixel click, but ONLY where the tree's own
  // coordinates are believable. On GTK4/X11 every element reports (0,0) with its real
  // size, so a centre computed there sends every click to the same wrong place — and
  // the screenshot still looks right, which is what makes that failure so expensive.
  const snap = await snapshotOrThrow('computer:click_element', target, {
    includeHidden: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const roots = snap.ok ? snap.roots : [];
  const node = findByRef(roots, args.ref);
  if (!node) {
    throw new Error(
      `computer:click_element — no element #${args.ref.replace(/^#/, '')} on this desktop. ` +
        'Refs are positions in the tree and go stale when the UI changes: call computer:observe again and use a fresh one.',
    );
  }
  if (!snap.ok || !snap.boundsTrustworthy) {
    throw new Error(
      `computer:click_element — #${args.ref.replace(/^#/, '')} (${node.role}${node.name ? ` "${node.name}"` : ''}) ` +
        `exposes no activating action${parsed?.actions?.length ? ` (it has: ${parsed.actions.join(', ')} — pass one as \`action\`)` : ''}, ` +
        'and this toolkit reports unusable screen coordinates, so a pixel click cannot be aimed either. ' +
        'Use capability:computer with a screenshot to locate and click it.',
    );
  }
  const [x, y] = elementClickPoint(node, target);
  const plan = planAction({ action: 'left_click', coordinate: [x, y] }, { ...target, capture: undefined });
  if (plan.kind !== 'xdotool') throw new Error('computer:click_element — unexpected plan');
  const clickCmd = xdotoolCommand(plan, target);
  const click = await computerExec(clickCmd.bin, clickCmd.args, { env: clickCmd.env, signal: ctx.signal });
  const clickLedger = {
    action: `click_element #${args.ref.replace(/^#/, '')}`,
    coordinate: [x, y] as const,
    note: 'pixel-fallback',
  };
  if (click.status !== 0) {
    const line = await recordActivation(target, { ...clickLedger, ok: false }, ctx.signal);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `${line}\ncomputer:click_element — pixel-click fallback failed (exit ${click.status}): ${click.stderr.slice(0, 200)}` }],
    };
  }
  const line = await recordActivation(target, { ...clickLedger, ok: true }, ctx.signal);
  return {
    content: [
      {
        type: 'text' as const,
        text: `${line}\nClicked ${node.role}${node.name ? ` "${node.name}"` : ''} at (${x}, ${y}) — it exposed no activating action, so this was a pixel click at its centre. Call computer:observe to see the result.`,
      },
    ],
  };
}

export const observeTool = defineTool({
  name: 'computer:observe',
  description:
    'Read the sandbox desktop\'s ACCESSIBILITY TREE — every on-screen element with its role, name, text and state, as compact text. Far cheaper than a screenshot and carries semantics a screenshot cannot (which node is focused, what an entry actually contains). Each interactive element gets a #ref you pass to computer:click_element.',
  guidance: {
    when: 'FIRST, before screenshotting, whenever you need to know what is on a GUI and act on it. It is a fraction of a screenshot\'s tokens per step, and a computer-use loop pays that cost on every step.',
    notWhen:
      'It only sees what the toolkit exports. A canvas/game/video, a PDF or image viewer\'s content, or a plain X11 app (xterm) reports little or nothing — if it returns no applications or a tree that clearly does not match the task, take a capability:computer screenshot. Also use the screenshot when you need to judge LAYOUT or appearance rather than structure.',
    chaining: 'computer:observe → pick an element → computer:click_element { ref } → computer:observe to confirm. Drop to capability:computer for typing, keys, scrolling and anything the tree cannot see.',
    seeAlso: [
      'capability:computer (screenshot + type/key/scroll; the fallback that always works)',
      'computer:click_element (activate an element this tool listed)',
      'computer:provision_desktop (stand up the sandbox desktop first)',
    ],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 45,
  args: observeArgs,
  handler: (args, ctx) => runObserve(args, ctx as ComputerCtx),
});

export const clickElementTool = defineTool({
  name: 'computer:click_element',
  description:
    'Activate an element by the #ref computer:observe gave it — semantically, over the accessibility bus, rather than by clicking pixels. Works on elements that are scrolled out of view or overlapped, and is immune to screenshot scaling.',
  guidance: {
    when: 'To press a button, activate an entry, or toggle a control that computer:observe listed with a #ref.',
    notWhen:
      'Anything the tree cannot see (canvas, video, a plain X11 app) → capability:computer left_click at a coordinate you read off a screenshot. Typing, keys and scrolling are capability:computer too — this tool only activates.',
    chaining: 'computer:observe → computer:click_element { ref } → computer:observe to confirm the result.',
    seeAlso: ['computer:observe (get the refs)', 'capability:computer (type / key / scroll / screenshot)'],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 45,
  args: clickArgs,
  handler: (args, ctx) => runClickElement(args, ctx as ComputerCtx),
});

export default observeTool;
