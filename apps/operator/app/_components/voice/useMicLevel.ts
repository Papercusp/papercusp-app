/**
 * useMicLevel — drives a CSS custom property on a target element with
 * the live mic level (0..1). Writes directly to the DOM via a ref
 * instead of React state so the 60fps RMS updates don't re-render the
 * component (or any of its parents — VoiceButton sits in the chrome
 * header, so a state-based version churned the whole shell).
 *
 * Engine-independent: opens its own getUserMedia stream + AnalyserNode
 * solely for visualization, so all 3 STT engines (Voicemode, WebSpeech,
 * Deepgram) light up the same way without sharing the capture stream.
 */

import { useEffect, useRef } from 'react';

/**
 * Threshold (post-eased value 0..1) at which we consider the mic to be
 * "receiving audio." Below this is silence/noise floor; above is voice.
 * Hysteresis (separate on/off thresholds) avoids flicker on borderline
 * input.
 */
const RECEIVING_ON = 0.08;
const RECEIVING_OFF = 0.04;

export function useMicLevel(
  active: boolean,
  onReceivingChange?: (receiving: boolean) => void,
  // Reports the getUserMedia outcome so callers can explain a silent
  // capture failure. Called with the error on rejection, and with `null`
  // on a successful acquire so a prior error doesn't linger.
  onCaptureError?: (err: unknown | null) => void,
): {
  ref: React.RefObject<HTMLElement>;
} {
  const ref = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.style.setProperty('--mic-level', '0');
    if (!active) return;
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Mic acquired — clear any prior capture error so a stale failure
        // from an earlier attempt doesn't mislabel this session.
        onCaptureError?.(null);
        streamRef.current = stream;
        const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        // WebKitGTK (the Tauri desktop webview) and Chrome's autoplay
        // policy both start an AudioContext in the 'suspended' state. A
        // suspended context never advances its clock, so the AnalyserNode
        // is fed nothing and every RMS read is flat — the mic level stays
        // 0 and `audioReceiving` never flips, which surfaces to the user as
        // "No audio detected" on a perfectly live mic. resume() transitions
        // it to 'running' and is permitted here without a fresh user
        // gesture (verified on this WebKitGTK build).
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch { /* best effort — leave flat */ }
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          try { await ctx.close(); } catch { /* ignore */ }
          return;
        }
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);

        // Throttle to ~20Hz instead of 60Hz. The ring is a vibe indicator
        // — you can't perceive faster than ~30Hz changes anyway, and the
        // user already has another analyser (stt-voicemode VAD) running
        // on the actual capture stream. 60Hz here on a quiet idle page
        // wastes main-thread budget that React reconciliation needs.
        const FRAME_MS = 50;
        let lastTick = 0;
        let lastWritten = -1;
        let receivingState = false;

        const tick = (t: number) => {
          if (t - lastTick >= FRAME_MS) {
            lastTick = t;
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);
            const eased = Math.min(1, Math.max(0, (rms - 0.02) * 6));
            // Skip the DOM write when the value barely moved (saves the
            // CSSStyleDeclaration write + GPU recomposite).
            if (Math.abs(eased - lastWritten) >= 0.01) {
              lastWritten = eased;
              if (ref.current) ref.current.style.setProperty('--mic-level', eased.toFixed(2));
            }
            // Hysteresis threshold for "is the mic picking up voice?"
            if (!receivingState && eased >= RECEIVING_ON) {
              receivingState = true;
              onReceivingChange?.(true);
            } else if (receivingState && eased <= RECEIVING_OFF) {
              receivingState = false;
              onReceivingChange?.(false);
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        // permission denied / device busy / no device. Report it so the
        // PTT "no audio" path can name the actual cause; the visualization
        // itself still fails open (no ring animation).
        if (!cancelled) onCaptureError?.(err);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try { ctxRef.current?.close(); } catch { /* ignore */ }
      ctxRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (ref.current) ref.current.style.setProperty('--mic-level', '0');
      onReceivingChange?.(false);
    };
  }, [active, onReceivingChange, onCaptureError]);

  return { ref };
}
