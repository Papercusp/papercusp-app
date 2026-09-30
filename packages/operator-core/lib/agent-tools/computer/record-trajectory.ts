/**
 * computer:record — open/close/export an ACTION-SAMPLED recording of the caller's
 * sandbox desktop (agent-virtual-desktops-2026-08-23 P-009; D-013).
 *
 * The recorder itself lives in `trajectory-recorder.ts`; this is the agent-facing
 * surface. Two properties are worth knowing before reaching for it:
 *
 *   - RECORDING IS INVISIBLE IN YOUR CONTEXT. Frames go to disk, never into a tool
 *     result (D-013 §2), so a recording costs you nothing per step in tokens — it
 *     costs one extra screen capture per action whose observation was a tree, and
 *     nothing at all for one that already produced an image.
 *   - THE EXPORT IS FOR A HUMAN. It renders the trajectory to webm/GIF and parks a
 *     one-line pointer on the work-item bound at `start`. The bytes never enter
 *     Postgres or the transcript.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveBoundDisplay, type ComputerCtx } from './computer';
import { resolveLocalDesktopByDisplay } from '../../desktop/desktop-session-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { commentWorkItem } from '../../work-items';
import {
  DEFAULT_RECORDING_BOUNDS,
  listRecordings,
  readRecording,
  recordingStatus,
  recordingsRoot,
  startRecording,
  stopRecording,
} from './trajectory-recorder';
import {
  createFfmpegExec,
  exportPointerLine,
  exportRecording,
  type ExportFormat,
} from './trajectory-export';
import { basename, join } from 'node:path';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const recordArgs = z
  .object({
    op: z
      .enum(['start', 'stop', 'status', 'export'])
      .describe('start a recording, stop it, report the open one, or render one to video.'),
    workItem: z
      .string()
      .optional()
      .describe('Work-item this recording belongs to (e.g. "WI-1234"). Bound at `start`; `export` parks its pointer comment there.'),
    note: z.string().max(500).optional().describe('Short human note stored in the manifest ("reproducing the save-dialog hang").'),
    format: z.enum(['webm', 'gif']).optional().describe('export format (default webm; gif for pasting into a thread).'),
    recording: z
      .string()
      .optional()
      .describe('export a SPECIFIC recording id (default: this display\'s open recording, else the most recent).'),
    maxFrames: z.number().int().min(1).max(2000).optional().describe(`frame files kept on disk (default ${DEFAULT_RECORDING_BOUNDS.maxFrames}); the oldest are evicted past it.`),
    maxDurationSec: z
      .number()
      .int()
      .min(30)
      .max(24 * 3600)
      .optional()
      .describe(`wall-clock ceiling; crossing it auto-stops the recording (default ${DEFAULT_RECORDING_BOUNDS.maxDurationSec}s).`),
  })
  .strict();

export type RecordArgs = z.infer<typeof recordArgs>;

/** Resolve which recording directory `export` should render. */
function resolveExportDir(display: string, id?: string): string {
  if (id) {
    const dir = join(recordingsRoot(), basename(id));
    return dir;
  }
  const open = recordingStatus(display);
  if (open) return open.dir;
  const recent = listRecordings()[0];
  if (!recent) {
    throw new Error(
      `computer:record — no recording to export for display ${display}. Run computer:record { op: 'start' }, drive the desktop, then export.`,
    );
  }
  return recent;
}

/** The tool ctx slice this handler reads: the display resolver's + the comment author's. */
export type RecordTrajectoryCtx = ComputerCtx & ResolveIdentityCtx;

export async function runRecordTrajectory(args: RecordArgs, ctx: RecordTrajectoryCtx = {}) {
  const target = await resolveBoundDisplay(ctx); // throws loudly if no lease / refuses :0

  if (args.op === 'status') {
    const open = recordingStatus(target.display);
    return text({
      ok: true,
      display: target.display,
      recording: open,
      recent: listRecordings().slice(0, 5).map((d) => basename(d)),
    });
  }

  if (args.op === 'start') {
    // Best-effort: bind the P-003 registry row when there is one, so a recording is
    // traceable to the DesktopSession it came from. A desktop with no row still
    // records — the row is inventory, never a precondition (D-004).
    let sessionId: string | null = null;
    try {
      sessionId =
        (await resolveLocalDesktopByDisplay({ workspaceId: activeWorkspaceId(), display: target.display }))?.id ?? null;
    } catch {
      /* inventory only */
    }
    const started = startRecording({
      display: target.display,
      workItem: args.workItem ?? null,
      sessionId,
      note: args.note ?? null,
      bounds: {
        ...(args.maxFrames !== undefined ? { maxFrames: args.maxFrames } : {}),
        ...(args.maxDurationSec !== undefined ? { maxDurationSec: args.maxDurationSec } : {}),
      },
    });
    return text({
      ok: true,
      started: true,
      id: started.id,
      display: started.display,
      dir: started.dir,
      workItem: started.workItem,
      bounds: started.bounds,
      note: 'Frames are captured per ACTION, out of band — nothing is added to your tool results. Export when done.',
    });
  }

  if (args.op === 'stop') {
    const stopped = stopRecording(target.display);
    if (!stopped) return text({ ok: true, stopped: false, reason: `no open recording on display ${target.display}` });
    const loaded = readRecording(stopped.dir);
    return text({
      ok: true,
      stopped: true,
      id: stopped.id,
      frames: loaded.frames.length,
      droppedFrames: loaded.droppedFrames,
      wallSec: Math.round(((stopped.endedAtMs ?? Date.now()) - stopped.startedAtMs) / 1000),
      endReason: stopped.endReason,
      ...(stopped.lastError ? { lastError: stopped.lastError } : {}),
      next: `computer:record { op: 'export', format: 'webm' }`,
    });
  }

  // export
  const dir = resolveExportDir(target.display, args.recording);
  const format: ExportFormat = args.format ?? 'webm';
  const result = await exportRecording(dir, {
    format,
    exec: createFfmpegExec(),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  // D-013 §8 — the work-item gets a POINTER, never the bytes. `workItem` on the call
  // overrides the one bound at start (an export re-parked deliberately), and neither
  // being present is a normal outcome, not an error.
  const parkOn = args.workItem ?? result.recording.workItem;
  let parked: { workItem: string; posted: boolean; reason?: string } | null = null;
  if (parkOn) {
    let authorId: string | undefined;
    try {
      authorId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* an unattributed comment beats no comment */
    }
    try {
      const post = await commentWorkItem(parkOn, exportPointerLine(result), authorId);
      parked = { workItem: parkOn, posted: Boolean(post), ...(post ? {} : { reason: 'work-item not found' }) };
    } catch (e) {
      parked = { workItem: parkOn, posted: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  return text({
    ok: true,
    exported: true,
    format: result.format,
    path: result.path,
    frames: result.frames,
    droppedFrames: result.droppedFrames,
    playbackSec: result.playbackSec,
    bytes: result.bytes,
    recording: result.recording.id,
    parked,
  });
}

export default defineTool({
  name: 'computer:record',
  profile: 'engineer',
  description:
    'Record what you do on the sandbox desktop as a trajectory — one frame per action, captured out of band — and export it to webm/GIF for a human to watch. Frames never enter your tool results, so recording costs no tokens per step.',
  guidance: {
    when: 'Before a GUI sequence someone will need to REVIEW: reproducing a bug you will hand off, evidence for a work-item, or a flow you want a human to check. start → drive the desktop normally → stop → export.',
    notWhen:
      'To SEE the screen yourself — that is capability:computer (screenshot) or computer:observe; a recording is written to disk and is not returned to you. Not for a single click worth no video.',
    chaining:
      "computer:record { op:'start', workItem:'WI-1234' } → capability:computer / computer:click_element as usual → computer:record { op:'stop' } → computer:record { op:'export', format:'webm' }.",
    returns:
      'JSON. `start` gives the recording id + directory + bounds. `stop` gives the frame count, evicted-frame count and wall-clock. `export` gives the file path, playback seconds and whether the pointer comment was parked on the work-item. Frames are sampled per ACTION, so an idle desktop records nothing and each frame has an action that explains it; playback holds each frame for its real gap, clamped to 0.2–3s.',
    seeAlso: [
      'capability:computer (drive the desktop — every action lands in the recording)',
      'computer:observe (read the tree; cheaper than a screenshot)',
      'computer:list_desktops (which desktops are leased)',
    ],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  // Shells out to ffmpeg for an encode that can run minutes — the same reason
  // capability:computer opts out (EI-18803497769946984): holding the ambient
  // workspace transaction across that wait trips idle_in_transaction_session_timeout.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 200,
  args: recordArgs,
  result: z
    .object({
      ok: z.unknown().optional(),
      recording: z.unknown().optional(),
      directory: z.unknown().optional(),
      bounds: z.unknown().optional(),
      frames: z.unknown().optional(),
      droppedFrames: z.unknown().optional(),
      wallClockMs: z.unknown().optional(),
      exported: z.unknown().optional(),
      format: z.unknown().optional(),
      path: z.unknown().optional(),
      playbackSec: z.unknown().optional(),
      bytes: z.unknown().optional(),
      parked: z.unknown().optional(),
    })
    .passthrough(),
  handler: (args, ctx) => runRecordTrajectory(args, ctx as RecordTrajectoryCtx),
});
