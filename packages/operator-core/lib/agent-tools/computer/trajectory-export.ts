/**
 * trajectory-export — turn an action-sampled recording into something a HUMAN can
 * watch (P-009, D-013 §7). webm for review, GIF for pasting into a work-item.
 *
 * THE TIMING IS THE WHOLE PROBLEM. An action-sampled recording (see
 * `trajectory-recorder.ts`) has irregularly-spaced frames: two clicks 300ms apart,
 * then four minutes while the model thinks. Encode it at a fixed frame rate and a
 * 40-step task collapses into 1.6 unwatchable seconds; encode it at its literal
 * timestamps and you get four minutes of a still frame. So each frame holds for its
 * REAL gap, CLAMPED to [MIN_FRAME_SEC, MAX_FRAME_SEC] — the pauses stay visible as
 * pauses without the export becoming a screensaver.
 *
 * The command builders are pure and unit-tested without ffmpeg; only
 * `exportRecording` shells out, through an injected exec so the tool layer owns
 * the process (no import cycle back into `computer.ts`).
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording, type LoadedRecording, type RecordedFrame } from './trajectory-recorder';
import { scrubExecEnv } from '../capability/exec-sandbox';
import { activeWorkspaceId } from '../../workspace-registry';
import { runGovernedOperation } from '../../resource-governor/execution';

export type ExportFormat = 'webm' | 'gif';

/** A frame never holds for less than this — otherwise fast steps are invisible. */
export const MIN_FRAME_SEC = 0.2;
/** …nor longer than this, however long the model actually thought (D-013 §7). */
export const MAX_FRAME_SEC = 3;
/** Hold for the LAST frame, which has no successor to measure a gap against. */
export const LAST_FRAME_SEC = 1.5;
/** GIFs are pasted into threads; downscale (never upscale) to keep them sane. */
export const GIF_MAX_WIDTH = 800;

export const CONCAT_BASENAME = 'trajectory.concat';
export const PALETTE_BASENAME = 'palette.png';

export function clampFrameSeconds(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return MIN_FRAME_SEC;
  return Math.min(MAX_FRAME_SEC, Math.max(MIN_FRAME_SEC, sec));
}

/**
 * The ffmpeg concat-demuxer script for a frame list.
 *
 * ⚠ THE LAST ENTRY IS REPEATED ON PURPOSE, and the trade is MEASURED. The concat
 * demuxer applies a `duration` to the file PRECEDING the next `file` directive, so
 * without a repeat the final frame gets the container's default frame duration
 * instead of its own — it flashes by, which is the most common way an image-sequence
 * export ends a beat early.
 *
 * Measured on ffmpeg 6.1.1, 6 frames x 0.500s (model: 3.000s):
 *   with the repeat : webm 3.04s / 7 decoded frames · gif 3.04s / 7 frames
 *   without         : webm 2.56s / 6 decoded frames · gif 2.56s / 6 frames
 *
 * So the repeat buys the last frame its full hold (2.56 → 3.04 ≈ the modelled 3.00)
 * at the cost of ONE extra decoded frame that is a byte-identical duplicate of the
 * last, plus ~0.04s of default-duration overshoot. A viewer cannot see the duplicate;
 * a viewer very much notices the final state vanishing. Hence: keep the repeat, and
 * expect `decoded frames === recorded frames + 1` when probing an export.
 */
export function buildConcatScript(frames: readonly RecordedFrame[]): string {
  if (frames.length === 0) throw new Error('computer:record — cannot build a concat script for zero frames.');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => {
    const next = frames[i + 1];
    const seconds = next ? clampFrameSeconds((next.atMs - frame.atMs) / 1000) : clampFrameSeconds(LAST_FRAME_SEC);
    lines.push(`file '${frame.file}'`);
    lines.push(`duration ${seconds.toFixed(3)}`);
  });
  const last = frames[frames.length - 1];
  if (last) lines.push(`file '${last.file}'`);
  return `${lines.join('\n')}\n`;
}

/** Total seconds the export will play for, from the same clamped durations. */
export function exportDurationSeconds(frames: readonly RecordedFrame[]): number {
  return frames.reduce((total, frame, i) => {
    const next = frames[i + 1];
    return total + (next ? clampFrameSeconds((next.atMs - frame.atMs) / 1000) : clampFrameSeconds(LAST_FRAME_SEC));
  }, 0);
}

export interface FfmpegCommand {
  bin: string;
  args: string[];
}

const CONCAT_INPUT = ['-f', 'concat', '-safe', '0', '-i', CONCAT_BASENAME];

/**
 * webm (VP9). `-vf scale=trunc(iw/2)*2:...` because yuv420p demands even
 * dimensions and an X capture is whatever the display is — an odd height fails the
 * encode outright, which would present as "export is broken" for one geometry only.
 */
export function webmCommand(outBasename: string): FfmpegCommand {
  return {
    bin: 'ffmpeg',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...CONCAT_INPUT,
      '-fps_mode',
      'vfr',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '0',
      '-crf',
      '34',
      '-row-mt',
      '1',
      '-an',
      outBasename,
    ],
  };
}

/**
 * GIF is TWO passes on purpose. The one-liner everyone copies
 * (`split[a][b];[a]palettegen[p];[b][p]paletteuse`) makes ffmpeg buffer the entire
 * second branch in RAM while the first drains — at 240 frames of 1024x768 that is
 * ~750MB of an operator process's heap for a diagnostic. Two passes stream.
 */
export function gifPaletteCommand(): FfmpegCommand {
  return {
    bin: 'ffmpeg',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...CONCAT_INPUT,
      '-vf',
      `scale='min(${GIF_MAX_WIDTH},iw)':-2:flags=lanczos,palettegen=stats_mode=diff`,
      PALETTE_BASENAME,
    ],
  };
}

export function gifCommand(outBasename: string): FfmpegCommand {
  return {
    bin: 'ffmpeg',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...CONCAT_INPUT,
      '-i',
      PALETTE_BASENAME,
      '-lavfi',
      `scale='min(${GIF_MAX_WIDTH},iw)':-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      '-loop',
      '0',
      outBasename,
    ],
  };
}

/** The ffmpeg invocations for a format, in order. */
export function exportCommands(format: ExportFormat, outBasename: string): FfmpegCommand[] {
  return format === 'webm' ? [webmCommand(outBasename)] : [gifPaletteCommand(), gifCommand(outBasename)];
}

export type ExportExec = (
  bin: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<{ status: number; stderr: string }>;

/**
 * Encoding a few hundred frames of VP9 is minutes-scale work, so this deliberately
 * does NOT reuse `computerExec`: that seam SIGKILLs at 15s (right for a click, fatal
 * for an encode) and takes no `cwd`, which the concat demuxer needs to resolve frame
 * basenames. The env is scrubbed the same way, for the same reason — ffmpeg has no
 * business seeing the operator's database credentials.
 */
export const EXPORT_TIMEOUT_MS = 180_000;

export function createFfmpegExec(timeoutMs = EXPORT_TIMEOUT_MS): ExportExec {
  return (bin, args, opts) =>
    runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'computer-trajectory-export',
        owner: 'computer:record',
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `computer:record:${bin}`,
        metadata: { binary: bin, timeoutMs },
      },
      async () =>
        new Promise((resolveExec, reject) => {
          const child = spawn(bin, args, {
            cwd: opts.cwd,
            env: scrubExecEnv(process.env),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          const err: Buffer[] = [];
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
          child.stderr?.on('data', (d: Buffer) => err.push(d));
          child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on('close', (status) => {
            clearTimeout(timer);
            const stderr = Buffer.concat(err).toString();
            resolveExec({
              status: status ?? 1,
              stderr: timedOut ? `${stderr}\n(killed after ${timeoutMs}ms)` : stderr,
            });
          });
        }),
    );
}

export interface ExportResult {
  format: ExportFormat;
  /** Absolute path of the exported file. */
  path: string;
  frames: number;
  /** Frames the bounds evicted — the export is missing them, and says so. */
  droppedFrames: number;
  playbackSec: number;
  bytes: number;
  recording: LoadedRecording['manifest'];
}

export interface ExportOpts {
  format?: ExportFormat;
  exec: ExportExec;
  signal?: AbortSignal;
  /** Injected for tests; defaults to node:fs statSync. */
  sizeOf?: (path: string) => number;
}

/**
 * Render a recording directory to webm/GIF. Refuses an EMPTY recording rather than
 * producing a zero-frame file: "the export worked and is blank" is the reading that
 * costs an hour, and a recording with no frames is a real condition (a recording
 * opened but never driven).
 */
export async function exportRecording(dir: string, opts: ExportOpts): Promise<ExportResult> {
  const format: ExportFormat = opts.format ?? 'webm';
  const loaded = readRecording(dir);
  if (loaded.frames.length === 0) {
    throw new Error(
      `computer:record — recording ${loaded.manifest.id} has no frames on disk` +
        `${loaded.droppedFrames > 0 ? ` (${loaded.droppedFrames} were recorded and evicted by its bounds)` : ' (no actions were driven while it was open)'}` +
        '. Nothing to export.',
    );
  }

  writeFileSync(join(dir, CONCAT_BASENAME), buildConcatScript(loaded.frames), 'utf8');
  const outBasename = `trajectory.${format}`;
  for (const cmd of exportCommands(format, outBasename)) {
    const r = await opts.exec(cmd.bin, cmd.args, { cwd: dir, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (r.status !== 0) {
      throw new Error(
        `computer:record — ffmpeg failed (exit ${r.status}) exporting ${format}: ${r.stderr.slice(0, 400)}`,
      );
    }
  }

  const path = join(dir, outBasename);
  if (!existsSync(path)) {
    throw new Error(`computer:record — ffmpeg reported success but wrote no ${outBasename} in ${dir}.`);
  }
  const sizeOf = opts.sizeOf ?? ((p: string) => statSync(p).size);

  return {
    format,
    path,
    frames: loaded.frames.length,
    droppedFrames: loaded.droppedFrames,
    playbackSec: Number(exportDurationSeconds(loaded.frames).toFixed(2)),
    bytes: sizeOf(path),
    recording: loaded.manifest,
  };
}

/** The one-line pointer parked on the driving work-item (D-013 §8). */
export function exportPointerLine(result: ExportResult): string {
  const wall = result.recording.endedAtMs
    ? Math.round((result.recording.endedAtMs - result.recording.startedAtMs) / 1000)
    : Math.round((Date.now() - result.recording.startedAtMs) / 1000);
  return (
    `🎞 Desktop trajectory recording ${result.recording.id} (display ${result.recording.display}) — ` +
    `${result.frames} action frame(s)${result.droppedFrames > 0 ? `, ${result.droppedFrames} evicted by the recording bounds` : ''}, ` +
    `${wall}s of wall clock rendered to ${result.playbackSec}s of ${result.format} ` +
    `(${(result.bytes / 1024).toFixed(0)} KB).\nFile: ${result.path}\n` +
    'Frames are on disk only — media never enters Postgres or the tool result (D-003/D-013).'
  );
}
