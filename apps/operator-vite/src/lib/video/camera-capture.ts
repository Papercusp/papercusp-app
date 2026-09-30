/**
 * Camera/screen capture → WebCodecs encoder loop — plan
 * holepunch-video-shared-harnesses-2026-06-05 (P-006/P-009).
 *
 * Browser-only (getUserMedia/getDisplayMedia + frame extraction): the live
 * camera→encoded-frame path is the P-010 hardware verify. Prefers the WHATWG
 * MediaStreamTrackProcessor (Chromium); falls back to a canvas draw loop where
 * it's absent (e.g. some WebKitGTK builds). Either way, encoded frames are
 * delivered to `onFrame` for the desktop video client to send.
 */
import {
  createCameraEncoder,
  type CameraEncoder,
  type EncodedVideoFrame,
  type VideoEncodeConfig,
  type VideoFrameLike,
} from './video-codec';

export interface CameraCapture {
  stop(): void;
  encoder: CameraEncoder;
  stream: MediaStream;
}

interface MediaGlobals {
  MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
    readable: ReadableStream<VideoFrameLike>;
  };
  VideoFrame?: new (source: CanvasImageSource, init: { timestamp: number }) => VideoFrameLike;
}

export async function startCameraCapture(opts: {
  config?: VideoEncodeConfig;
  source?: 'camera' | 'screen';
  onFrame: (f: EncodedVideoFrame) => void;
  onError?: (err: unknown) => void;
}): Promise<CameraCapture> {
  const md = navigator.mediaDevices;
  const width = opts.config?.width ?? 640;
  const height = opts.config?.height ?? 360;
  const framerate = opts.config?.framerate ?? 15;
  const constraints: MediaStreamConstraints = { video: { width, height, frameRate: framerate }, audio: false };
  const stream =
    opts.source === 'screen' ? await md.getDisplayMedia(constraints) : await md.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  const encoder = createCameraEncoder({ config: opts.config, onFrame: opts.onFrame, onError: opts.onError });
  const g = globalThis as unknown as MediaGlobals;
  let stopped = false;

  if (typeof g.MediaStreamTrackProcessor === 'function') {
    const proc = new g.MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    void (async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        if (frame) encoder.encode(frame); // encoder.encode closes the frame
      }
    })().catch((e) => opts.onError?.(e));
    return {
      stream,
      encoder,
      stop() {
        stopped = true;
        try {
          void reader.cancel();
        } catch {
          /* gone */
        }
        encoder.close();
        track.stop();
      },
    };
  }

  // Canvas draw-loop fallback.
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const VideoFrameCtor = g.VideoFrame;
  const timer = setInterval(() => {
    if (stopped || !ctx || !VideoFrameCtor) return;
    try {
      ctx.drawImage(video, 0, 0, width, height);
      encoder.encode(new VideoFrameCtor(canvas, { timestamp: performance.now() * 1000 }));
    } catch (e) {
      opts.onError?.(e);
    }
  }, 1000 / framerate);
  return {
    stream,
    encoder,
    stop() {
      stopped = true;
      clearInterval(timer);
      encoder.close();
      track.stop();
      video.srcObject = null;
    },
  };
}
