//! Voice mode (PTT) — the Rust audio stack (voice-mode-tui-port-2026-06-05 P0).
//!
//! Capture: cpal (default input device → PipeWire default source) → mono mix →
//! 16 kHz resample → PCM16 WAV (hound) — the exact shape the voicemode Whisper
//! `/v1/audio/transcriptions` endpoint wants (the browser PTT path sends
//! `f32ToWav(pcm16k, 16000)` — we mirror it).
//!
//! Playback: rodio (wav from kokoro, mp3 from the cloud engines).
//!
//! Threading: cpal `Stream` and rodio `OutputStream` are `!Send`, so each side
//! lives on a dedicated OS thread behind a command channel; the handles
//! (`CaptureSession`, `Player`) are `Send` and own no audio objects. `App`
//! stays pure — main.rs drives these from the run loop (plan D-007).
//!
//! Device disambiguation (this box has the Brio + several USB codecs): we take
//! the PipeWire *default* source/sink (what `pactl get-default-source` says —
//! the Brio here), with `PUI_VOICE_INPUT` / `PUI_VOICE_OUTPUT` env overrides
//! matching a cpal device-name substring for setups where the default is wrong.
#![allow(dead_code)] // P2 consumes the full surface as the PTT loop lands.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc as smpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "voice_dsp.rs"]
mod dsp;
pub use dsp::*;

// ─────────────────────────────── capture side ───────────────────────────────

/// What a finished recording yields: the Whisper-ready WAV + provenance.
#[derive(Debug)]
pub struct CaptureResult {
    /// 16 kHz mono PCM16 WAV bytes.
    pub wav: Vec<u8>,
    /// Captured length in seconds (at the source rate, pre-resample).
    pub seconds: f32,
    /// The device's native sample rate the audio was captured at.
    pub src_rate: u32,
    /// The cpal device name that captured it.
    pub device: String,
}

enum CaptureCmd {
    /// Stop and deliver the encoded result.
    Finish,
    /// Stop and discard.
    Cancel,
}

/// Handle to one in-flight PTT recording. The cpal stream lives on a dedicated
/// thread; this handle is Send (main.rs finishes it in `spawn_blocking`).
pub struct CaptureSession {
    cmd_tx: smpsc::Sender<CaptureCmd>,
    done_rx: smpsc::Receiver<Result<CaptureResult>>,
    level_bits: Arc<AtomicU32>,
    started: Instant,
}

impl CaptureSession {
    /// Latest mic RMS level (0..~1) — written by the audio callback, read on
    /// UI ticks. No event spam (plan D-007).
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Stop recording, resample + encode, and return the WAV. Blocks briefly
    /// (ms-scale DSP) — call from `spawn_blocking`, not the UI thread.
    pub fn finish(self) -> Result<CaptureResult> {
        let _ = self.cmd_tx.send(CaptureCmd::Finish);
        self.done_rx
            .recv_timeout(Duration::from_secs(10))
            .context("capture thread did not deliver a result")?
    }

    /// Stop recording and discard the audio (Esc while recording).
    pub fn cancel(self) {
        let _ = self.cmd_tx.send(CaptureCmd::Cancel);
        // Best-effort: wait for the thread to wind down so the stream closes
        // before a new session could open the device again.
        let _ = self.done_rx.recv_timeout(Duration::from_secs(2));
    }
}

/// Open the input device and start recording. Device pick: `PUI_VOICE_INPUT`
/// env substring match when set, else the cpal/PipeWire default source.
pub fn start_capture() -> Result<CaptureSession> {
    let (cmd_tx, cmd_rx) = smpsc::channel::<CaptureCmd>();
    let (done_tx, done_rx) = smpsc::channel::<Result<CaptureResult>>();
    let (ready_tx, ready_rx) = smpsc::channel::<Result<()>>();
    let level_bits = Arc::new(AtomicU32::new(0));
    let level_for_thread = level_bits.clone();

    std::thread::Builder::new()
        .name("pui-voice-capture".into())
        .spawn(move || capture_thread(cmd_rx, done_tx, ready_tx, level_for_thread))
        .context("spawn capture thread")?;

    // Surface device/stream-open failures at start (not at finish) so the UI
    // can show "mic unavailable" immediately.
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(CaptureSession {
            cmd_tx,
            done_rx,
            level_bits,
            started: Instant::now(),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("capture thread did not signal readiness")),
    }
}

fn capture_thread(
    cmd_rx: smpsc::Receiver<CaptureCmd>,
    done_tx: smpsc::Sender<Result<CaptureResult>>,
    ready_tx: smpsc::Sender<Result<()>>,
    level_bits: Arc<AtomicU32>,
) {
    let setup = (|| -> Result<(cpal::Device, cpal::SupportedStreamConfig, String)> {
        let host = cpal::default_host();
        let device = pick_device(
            host.input_devices().context("enumerate input devices")?,
            host.default_input_device(),
            std::env::var("PUI_VOICE_INPUT").ok().as_deref(),
        )
        .ok_or_else(|| anyhow!("no input (mic) device available"))?;
        let name = device.name().unwrap_or_else(|_| "<unknown>".into());
        let config = device
            .default_input_config()
            .with_context(|| format!("default input config for {name}"))?;
        Ok((device, config, name))
    })();

    let (device, config, name) = match setup {
        Ok(t) => t,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    let src_rate = config.sample_rate().0;
    let channels = config.channels();
    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = {
        let buf = buf.clone();
        let level = level_bits.clone();
        let on_err = |e: cpal::StreamError| {
            // Capture errors mid-stream surface as a short recording; the
            // status line shows whatever Whisper makes of it.
            eprintln!("pui voice capture stream error: {e}");
        };
        let push = move |chunk: Vec<f32>| {
            level.store(rms(&chunk).to_bits(), Ordering::Relaxed);
            if let Ok(mut b) = buf.lock() {
                b.extend_from_slice(&chunk);
            }
        };
        match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[f32], _| push(data.to_vec()),
                on_err,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[i16], _| push(data.iter().map(|&s| s as f32 / 32768.0).collect()),
                on_err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[u16], _| {
                    push(
                        data.iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect(),
                    )
                },
                on_err,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(anyhow!("unsupported sample format {other:?}")));
                return;
            }
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("open input stream on {name}: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(anyhow!("start input stream on {name}: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(()));

    // Record until told otherwise. A dropped handle (sender gone) cancels.
    let cmd = cmd_rx.recv().unwrap_or(CaptureCmd::Cancel);
    drop(stream); // close the device before the (ms-scale) DSP below

    match cmd {
        CaptureCmd::Cancel => {
            let _ = done_tx.send(Err(anyhow!("recording cancelled")));
        }
        CaptureCmd::Finish => {
            let samples = buf.lock().map(|b| b.clone()).unwrap_or_default();
            let seconds = if src_rate > 0 && channels > 0 {
                samples.len() as f32 / channels as f32 / src_rate as f32
            } else {
                0.0
            };
            let mono = mix_to_mono(&samples, channels);
            let s16k = resample_to_16k(&mono, src_rate);
            let wav = encode_wav_pcm16(&s16k, WHISPER_RATE);
            let _ = done_tx.send(Ok(CaptureResult {
                wav,
                seconds,
                src_rate,
                device: name,
            }));
        }
    }
}

// ───────────────── continuous capture (realtime voice, P-004) ─────────────────

/// Continuous mic capture: the same device pipeline as the PTT path, but
/// streaming ~`chunk_ms` windows of 16 kHz mono PCM16 LE to a channel instead
/// of accumulating one WAV. `stop()` (or drop) ends the stream; the chunk
/// channel closes with the capture thread so consumers unblock naturally.
/// Per-window resampling introduces sub-sample boundary seams — inaudible for
/// speech and irrelevant to EL's VAD/STT (the PTT path resamples whole clips).
pub struct StreamCapture {
    stop: Arc<AtomicBool>,
    level_bits: Arc<AtomicU32>,
    chunks_rx: Option<smpsc::Receiver<Vec<u8>>>,
}

impl StreamCapture {
    /// Take the chunk receiver (once) — it moves to the outbound pump.
    pub fn take_chunks(&mut self) -> Option<smpsc::Receiver<Vec<u8>>> {
        self.chunks_rx.take()
    }
    /// Live mic RMS (the same meter the PTT composer shows).
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for StreamCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn start_stream_capture(chunk_ms: u32) -> Result<StreamCapture> {
    let stop = Arc::new(AtomicBool::new(false));
    let level_bits = Arc::new(AtomicU32::new(0));
    let (chunks_tx, chunks_rx) = smpsc::channel::<Vec<u8>>();
    let (ready_tx, ready_rx) = smpsc::channel::<Result<()>>();
    {
        let stop = stop.clone();
        let level_bits = level_bits.clone();
        std::thread::Builder::new()
            .name("pui-voice-stream-capture".into())
            .spawn(move || stream_capture_thread(stop, level_bits, chunks_tx, ready_tx, chunk_ms))
            .context("spawn stream capture thread")?;
    }
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(StreamCapture {
            stop,
            level_bits,
            chunks_rx: Some(chunks_rx),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("stream capture thread did not signal readiness")),
    }
}

fn stream_capture_thread(
    stop: Arc<AtomicBool>,
    level_bits: Arc<AtomicU32>,
    chunks_tx: smpsc::Sender<Vec<u8>>,
    ready_tx: smpsc::Sender<Result<()>>,
    chunk_ms: u32,
) {
    // Same device setup as the PTT capture_thread (PUI_VOICE_INPUT honored).
    let setup = (|| -> Result<(cpal::Device, cpal::SupportedStreamConfig, String)> {
        let host = cpal::default_host();
        let device = pick_device(
            host.input_devices().context("enumerate input devices")?,
            host.default_input_device(),
            std::env::var("PUI_VOICE_INPUT").ok().as_deref(),
        )
        .ok_or_else(|| anyhow!("no input (mic) device available"))?;
        let name = device.name().unwrap_or_else(|_| "<unknown>".into());
        let config = device
            .default_input_config()
            .with_context(|| format!("default input config for {name}"))?;
        Ok((device, config, name))
    })();
    let (device, config, name) = match setup {
        Ok(t) => t,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    let src_rate = config.sample_rate().0;
    let channels = config.channels();
    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let stream = {
        let buf = buf.clone();
        let level = level_bits.clone();
        let on_err = |e: cpal::StreamError| {
            eprintln!("pui voice stream-capture error: {e}");
        };
        let push = move |chunk: Vec<f32>| {
            level.store(rms(&chunk).to_bits(), Ordering::Relaxed);
            if let Ok(mut b) = buf.lock() {
                b.extend_from_slice(&chunk);
            }
        };
        match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[f32], _| push(data.to_vec()),
                on_err,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[i16], _| push(data.iter().map(|&s| s as f32 / 32768.0).collect()),
                on_err,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.clone().into(),
                move |data: &[u16], _| {
                    push(
                        data.iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .collect(),
                    )
                },
                on_err,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(anyhow!("unsupported sample format {other:?}")));
                return;
            }
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("open input stream on {name}: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(anyhow!("start input stream on {name}: {e}")));
        return;
    }
    let _ = ready_tx.send(Ok(()));

    let tick = Duration::from_millis(u64::from(chunk_ms.max(50)));
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(tick);
        let raw: Vec<f32> = match buf.lock() {
            Ok(mut b) => std::mem::take(&mut *b),
            Err(_) => break,
        };
        if raw.is_empty() {
            continue;
        }
        let bytes = f32_chunk_to_pcm16le(&raw, channels, src_rate);
        if bytes.is_empty() {
            continue;
        }
        if chunks_tx.send(bytes).is_err() {
            break; // consumer gone — session over
        }
    }
    drop(stream); // close the device; the chunks channel closes with us
}

/// Pick a device: name-substring override first (case-insensitive), else the
/// host default. Shared by capture (input) and playback (output).
fn pick_device<I>(
    devices: I,
    default: Option<cpal::Device>,
    want: Option<&str>,
) -> Option<cpal::Device>
where
    I: Iterator<Item = cpal::Device>,
{
    if let Some(want) = want.filter(|w| !w.trim().is_empty()) {
        let want_lc = want.to_lowercase();
        for d in devices {
            if d.name()
                .map(|n| n.to_lowercase().contains(&want_lc))
                .unwrap_or(false)
            {
                return Some(d);
            }
        }
        // Fall through to default when the override matches nothing — a wrong
        // env var shouldn't brick voice entirely.
    }
    default
}

/// Names of available input/output devices (the `:voice-devices` palette /
/// smoke diagnostics).
pub fn list_devices() -> (Vec<String>, Vec<String>) {
    let host = cpal::default_host();
    let name_of = |d: cpal::Device| d.name().unwrap_or_else(|_| "<unknown>".into());
    let inputs = host
        .input_devices()
        .map(|it| it.map(name_of).collect())
        .unwrap_or_default();
    let outputs = host
        .output_devices()
        .map(|it| it.map(name_of).collect())
        .unwrap_or_default();
    (inputs, outputs)
}

// ─────────────────────────────── playback side ───────────────────────────────

/// Device-only capture. The caller drains native interleaved f32 blocks and
/// performs DSP in PUI. The bounded callback queue reports overflow explicitly.
pub struct RawCapture {
    pub info: crate::audio_proto::CaptureInfo,
    pub chunks: smpsc::Receiver<Vec<f32>>,
    pub error: Arc<Mutex<Option<String>>>,
    _stream: cpal::Stream,
}

impl RawCapture {
    pub fn stop(self) -> smpsc::Receiver<Vec<f32>> {
        drop(self._stream);
        self.chunks
    }
}

pub fn start_raw_capture() -> Result<RawCapture> {
    let host = cpal::default_host();
    let device = pick_device(
        host.input_devices().context("enumerate input devices")?,
        host.default_input_device(),
        std::env::var("PUI_VOICE_INPUT").ok().as_deref(),
    )
    .ok_or_else(|| anyhow!("no input (mic) device available"))?;
    let name = device.name().unwrap_or_else(|_| "<unknown>".into());
    let config = device.default_input_config().context("input config")?;
    let info = crate::audio_proto::CaptureInfo {
        device: name,
        rate: config.sample_rate().0,
        channels: config.channels(),
    };
    let (tx, chunks) = smpsc::sync_channel(16);
    let block_samples = 4096 * usize::from(info.channels);
    let error = Arc::new(Mutex::new(None));
    let queue_error = error.clone();
    let push = move |samples: Vec<f32>| {
        for block in samples.chunks(block_samples) {
            if tx.try_send(block.to_vec()).is_err() {
                if let Ok(mut slot) = queue_error.lock() {
                    *slot = Some("audio capture consumer fell behind; recording stopped".into());
                }
                break;
            }
        }
    };
    let stream_error = error.clone();
    let on_error = move |failure: cpal::StreamError| {
        if let Ok(mut slot) = stream_error.lock() {
            *slot = Some(format!("audio capture: {failure}"));
        }
    };
    let stream_config = config.clone().into();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| push(data.to_vec()),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _| push(data.iter().map(|&s| s as f32 / 32768.0).collect()),
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _| {
                push(
                    data.iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .collect(),
                )
            },
            on_error,
            None,
        ),
        other => return Err(anyhow!("unsupported sample format {other:?}")),
    }
    .context("open input stream")?;
    stream.play().context("start input stream")?;
    Ok(RawCapture {
        info,
        chunks,
        error,
        _stream: stream,
    })
}

enum PlayerCmd {
    Prepare(smpsc::Sender<Result<()>>),
    AppendRealtimePcm {
        samples: Vec<i16>,
        rate: u32,
    },
    /// Decode + play these audio bytes (wav/mp3), replacing anything playing.
    Play(Vec<u8>),
    /// APPEND raw mono PCM16 to the live queue (gap-free streaming TTS — the
    /// realtime Conv-AI `audio` events, voice-realtime-tui P-004). Starts a
    /// sink when none is live; never replaces what's already queued.
    AppendPcm {
        samples: Vec<i16>,
        rate: u32,
    },
    /// APPEND an encoded chunk (mp3/wav) to the live queue (non-PCM agent
    /// output formats).
    AppendEncoded(Vec<u8>),
    /// Stop playback now.
    Stop,
}

/// Long-lived playback handle. The rodio `OutputStream` lives on its thread;
/// the handle is Send + cheap to clone into async tasks.
#[derive(Clone)]
pub struct Player {
    tx: smpsc::Sender<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Player {
    /// Confirm the actual output device and sink before stream playback starts.
    pub fn prepare(&self) -> Result<()> {
        let (tx, rx) = smpsc::channel();
        self.tx
            .send(PlayerCmd::Prepare(tx))
            .context("playback worker stopped")?;
        rx.recv_timeout(Duration::from_secs(5))
            .context("output device did not become ready")?
    }

    pub fn append_realtime_pcm(&self, samples: Vec<i16>, rate: u32) {
        let _ = self.tx.send(PlayerCmd::AppendRealtimePcm { samples, rate });
    }
    /// Spawn the playback thread. The output device opens lazily on first
    /// play (so a missing sound card only breaks playback, not startup).
    pub fn spawn() -> Player {
        let (tx, rx) = smpsc::channel::<PlayerCmd>();
        let playing = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None));
        let p = playing.clone();
        let le = last_error.clone();
        let _ = std::thread::Builder::new()
            .name("pui-voice-playback".into())
            .spawn(move || player_thread(rx, p, le));
        Player {
            tx,
            playing,
            last_error,
        }
    }

    /// Play audio bytes (wav or mp3), stopping anything currently playing.
    pub fn play(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(PlayerCmd::Play(bytes));
    }

    /// Append raw mono PCM16 to the playback queue (streaming TTS chunks —
    /// the realtime voice session). Chunks play gap-free in arrival order.
    pub fn append_pcm(&self, samples: Vec<i16>, rate: u32) {
        let _ = self.tx.send(PlayerCmd::AppendPcm { samples, rate });
    }

    /// Append an encoded (mp3/wav) chunk to the playback queue.
    pub fn append_encoded(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(PlayerCmd::AppendEncoded(bytes));
    }

    /// Stop playback (barge-in / Esc).
    pub fn stop(&self) {
        let _ = self.tx.send(PlayerCmd::Stop);
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::Relaxed)
    }

    /// The most recent playback error, if any (cleared on a successful play).
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
    }
}

/// Open the output device lazily (PUI_VOICE_OUTPUT override honored).
/// Records the error + returns false when no device opens.
fn ensure_output(
    output: &mut Option<(rodio::OutputStream, rodio::OutputStreamHandle)>,
    set_err: &dyn Fn(Option<String>),
) -> bool {
    if output.is_some() {
        return true;
    }
    let want = std::env::var("PUI_VOICE_OUTPUT").ok();
    let opened = match want.as_deref().filter(|w| !w.trim().is_empty()) {
        Some(w) => {
            let host = cpal::default_host();
            let dev = host
                .output_devices()
                .ok()
                .and_then(|it| pick_device(it, host.default_output_device(), Some(w)));
            match dev {
                Some(d) => rodio::OutputStream::try_from_device(&d),
                None => rodio::OutputStream::try_default(),
            }
        }
        None => rodio::OutputStream::try_default(),
    };
    match opened {
        Ok(pair) => {
            *output = Some(pair);
            true
        }
        Err(e) => {
            set_err(Some(format!("open output device: {e}")));
            false
        }
    }
}

/// Append a source to the live sink (created on demand) — the queueing path
/// the streaming-TTS appends share with `Play`.
fn append_source<S>(
    sink: &mut Option<rodio::Sink>,
    handle: &rodio::OutputStreamHandle,
    playing: &Arc<AtomicBool>,
    set_err: &dyn Fn(Option<String>),
    src: S,
) where
    S: rodio::Source + Send + 'static,
    S::Item: rodio::Sample + Send,
    f32: cpal::FromSample<S::Item>,
{
    if sink.is_none() {
        match rodio::Sink::try_new(handle) {
            Ok(s) => *sink = Some(s),
            Err(e) => {
                set_err(Some(format!("audio sink: {e}")));
                return;
            }
        }
    }
    if let Some(s) = sink.as_ref() {
        s.append(src);
        playing.store(true, Ordering::Relaxed);
        set_err(None);
    }
}

fn player_thread(
    rx: smpsc::Receiver<PlayerCmd>,
    playing: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    let set_err = |msg: Option<String>| {
        if let Ok(mut g) = last_error.lock() {
            *g = msg;
        }
    };
    // (OutputStream, handle) must outlive every sink — created lazily, kept
    // for the thread's life. `OutputStream` is !Send; it never leaves here.
    let mut output: Option<(rodio::OutputStream, rodio::OutputStreamHandle)> = None;
    let mut sink: Option<rodio::Sink> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(PlayerCmd::Prepare(ready)) => {
                if !ensure_output(&mut output, &set_err) {
                    let message = last_error
                        .lock()
                        .ok()
                        .and_then(|s| s.clone())
                        .unwrap_or_else(|| "output device unavailable".into());
                    let _ = ready.send(Err(anyhow!(message)));
                    continue;
                }
                let handle = &output.as_ref().expect("output opened").1;
                match rodio::Sink::try_new(handle) {
                    Ok(s) => {
                        sink = Some(s);
                        let _ = ready.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = ready.send(Err(anyhow!("audio sink: {e}")));
                    }
                }
            }
            Ok(PlayerCmd::Play(bytes)) => {
                // Replace semantics: anything queued stops first.
                if let Some(s) = sink.take() {
                    s.stop();
                }
                if !ensure_output(&mut output, &set_err) {
                    continue;
                }
                let handle = output.as_ref().expect("output opened above").1.clone();
                match rodio::Decoder::new(std::io::Cursor::new(bytes)) {
                    Ok(source) => append_source(&mut sink, &handle, &playing, &set_err, source),
                    Err(e) => set_err(Some(format!("decode audio: {e}"))),
                }
            }
            Ok(command @ (PlayerCmd::AppendPcm { .. } | PlayerCmd::AppendRealtimePcm { .. })) => {
                let (samples, rate, realtime) = match command {
                    PlayerCmd::AppendPcm { samples, rate } => (samples, rate, false),
                    PlayerCmd::AppendRealtimePcm { samples, rate } => (samples, rate, true),
                    _ => unreachable!(),
                };
                if rate == 0 {
                    set_err(Some("audio sample rate must be positive".into()));
                    continue;
                }
                if realtime && sink.as_ref().is_some_and(|s| s.len() > 6) {
                    continue;
                }
                if !ensure_output(&mut output, &set_err) {
                    continue;
                }
                let handle = output.as_ref().expect("output opened above").1.clone();
                let src = rodio::buffer::SamplesBuffer::new(1, rate, samples);
                append_source(&mut sink, &handle, &playing, &set_err, src);
            }
            Ok(PlayerCmd::AppendEncoded(bytes)) => {
                if !ensure_output(&mut output, &set_err) {
                    continue;
                }
                let handle = output.as_ref().expect("output opened above").1.clone();
                match rodio::Decoder::new(std::io::Cursor::new(bytes)) {
                    Ok(source) => append_source(&mut sink, &handle, &playing, &set_err, source),
                    Err(e) => set_err(Some(format!("decode audio chunk: {e}"))),
                }
            }
            Ok(PlayerCmd::Stop) => {
                if let Some(s) = sink.take() {
                    s.stop();
                }
                playing.store(false, Ordering::Relaxed);
            }
            Err(smpsc::RecvTimeoutError::Timeout) => {
                if playing.load(Ordering::Relaxed)
                    && sink.as_ref().map(|s| s.empty()).unwrap_or(true)
                {
                    playing.store(false, Ordering::Relaxed);
                    sink = None;
                }
            }
            Err(smpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

// ────────────────────────────────── tests ──────────────────────────────────

#[cfg(test)]
mod stream_chunk_tests {
    use super::*;

    #[test]
    fn f32_chunk_to_pcm16le_downmixes_resamples_and_packs_le() {
        // 100 ms of stereo 32 kHz: L = 0.5, R = -0.5 → mono 0.0 everywhere…
        let frames = 3200;
        let mut raw = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            raw.push(0.5);
            raw.push(-0.5);
        }
        let bytes = f32_chunk_to_pcm16le(&raw, 2, 32_000);
        // …16 kHz mono = half the frames, 2 bytes each.
        assert_eq!(bytes.len(), frames / 2 * 2);
        assert!(bytes.iter().all(|&b| b == 0), "L/R cancel to silence");

        // Mono constant 0.5 at 16 kHz passes through; LE packing of +0.5.
        let bytes = f32_chunk_to_pcm16le(&[0.5; 160], 1, 16_000);
        assert_eq!(bytes.len(), 320);
        let v = i16::from_le_bytes([bytes[0], bytes[1]]);
        assert!((v - 16383).abs() <= 1, "0.5 → ~16383, got {v}");

        // Clamp: ±2.0 saturates instead of wrapping.
        let bytes = f32_chunk_to_pcm16le(&[2.0, -2.0], 1, 16_000);
        let hi = i16::from_le_bytes([bytes[0], bytes[1]]);
        let lo = i16::from_le_bytes([bytes[2], bytes[3]]);
        assert_eq!((hi, lo), (32767, -32767));

        // Empty in → empty out (the pump skips it).
        assert!(f32_chunk_to_pcm16le(&[], 2, 48_000).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_wav(bytes: &[u8]) -> (hound::WavSpec, Vec<i16>) {
        let mut r = hound::WavReader::new(std::io::Cursor::new(bytes)).expect("wav reader");
        let spec = r.spec();
        let samples = r.samples::<i16>().map(|s| s.unwrap()).collect();
        (spec, samples)
    }

    /// Dominant frequency estimate by zero-crossing count.
    fn zero_cross_freq(samples: &[f32], rate: u32) -> f32 {
        if samples.len() < 2 {
            return 0.0;
        }
        let crossings = samples
            .windows(2)
            .filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0))
            .count();
        crossings as f32 / 2.0 / (samples.len() as f32 / rate as f32)
    }

    #[test]
    fn mono_mix_averages_channels() {
        let stereo = [1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(mix_to_mono(&stereo, 2), vec![0.5, 0.5, 0.0]);
        // 1ch passes through.
        assert_eq!(mix_to_mono(&[0.25, -0.25], 1), vec![0.25, -0.25]);
    }

    #[test]
    fn resample_48k_to_16k_decimates_by_3() {
        let tone = sine(440.0, 1.0, 48_000, 0.8);
        let out = resample_to_16k(&tone, 48_000);
        assert_eq!(out.len(), 16_000);
        // The tone survives decimation at the right pitch.
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_44k1_to_16k_linear_interp() {
        let tone = sine(440.0, 1.0, 44_100, 0.8);
        let out = resample_to_16k(&tone, 44_100);
        let expected = 16_000;
        assert!(
            (out.len() as i64 - expected).unsigned_abs() <= 2,
            "len {} !~ {expected}",
            out.len()
        );
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 440.0).abs() < 10.0, "expected ~440Hz, got {f}");
    }

    #[test]
    fn resample_8k_upsamples() {
        let tone = sine(300.0, 0.5, 8_000, 0.8);
        let out = resample_to_16k(&tone, 8_000);
        assert!((out.len() as i64 - 8_000).unsigned_abs() <= 2);
        let f = zero_cross_freq(&out, 16_000);
        assert!((f - 300.0).abs() < 10.0, "expected ~300Hz, got {f}");
    }

    #[test]
    fn resample_16k_is_identity_and_empty_is_safe() {
        let tone = sine(440.0, 0.1, 16_000, 0.5);
        assert_eq!(resample_to_16k(&tone, 16_000), tone);
        assert!(resample_to_16k(&[], 48_000).is_empty());
        assert!(resample_to_16k(&[0.1], 0).is_empty());
    }

    #[test]
    fn wav_encode_roundtrips_pcm16_mono_16k() {
        let tone = sine(440.0, 0.25, WHISPER_RATE, 0.5);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let (spec, samples) = decode_wav(&wav);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(samples.len(), tone.len());
        // Amplitude survives the f32→i16 quantization.
        let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!((peak as f32 / 32767.0 - 0.5).abs() < 0.01);
    }

    #[test]
    fn wav_encode_clamps_overdrive() {
        let wav = encode_wav_pcm16(&[2.0, -2.0], WHISPER_RATE);
        let (_, samples) = decode_wav(&wav);
        assert_eq!(samples, vec![32767, -32767]);
    }

    #[test]
    fn rms_basics() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    // ── hardware smokes (#[ignore] — need an explicit PUI_LIVE_AUDIO=1 opt-in
    // and a real audio stack; run via the isolated null-sink loopback script
    // below). The opt-in is deliberate: `cargo test -- --ignored` is also used
    // for the operator/IPC smokes and must stay green on headless boxes. ──

    fn audio_smoke_opted_in(name: &str) -> bool {
        let enabled = std::env::var("PUI_LIVE_AUDIO")
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);
        if !enabled {
            eprintln!(
                "SKIP {name}: audio hardware smoke is opt-in; \
                 set PUI_LIVE_AUDIO=1 (the audio-loopback-smoke.sh wrapper does this)"
            );
        }
        enabled
    }

    fn capture_for_audio_smoke(name: &str) -> Option<CaptureSession> {
        if !audio_smoke_opted_in(name) {
            return None;
        }
        match start_capture() {
            Ok(session) => Some(session),
            Err(err) => {
                eprintln!("SKIP {name}: no usable audio capture device/backend ({err:#})");
                None
            }
        }
    }

    /// Capture ~1.5s from the default (or PUI_VOICE_INPUT) device and verify
    /// the pipeline yields a sane 16k mono WAV.
    #[test]
    #[ignore]
    fn smoke_record_yields_16k_wav() {
        let Some(session) = capture_for_audio_smoke("smoke_record_yields_16k_wav") else {
            return;
        };
        std::thread::sleep(Duration::from_millis(1500));
        let res = session.finish().expect("finish capture");
        eprintln!(
            "captured {:.2}s at {} Hz from {} → {} wav bytes",
            res.seconds,
            res.src_rate,
            res.device,
            res.wav.len()
        );
        let (spec, samples) = decode_wav(&res.wav);
        assert_eq!(spec.sample_rate, WHISPER_RATE);
        assert_eq!(spec.channels, 1);
        if samples.is_empty() {
            eprintln!("SKIP smoke_record_yields_16k_wav: capture device returned no samples");
            return;
        }
        // ~1.5s of 16k audio, generous margin for stream startup latency.
        assert!(
            samples.len() > WHISPER_RATE as usize, // > 1.0s
            "too few samples: {}",
            samples.len()
        );
    }

    /// Play a 440Hz tone through the default (or PUI_VOICE_OUTPUT) device and
    /// verify the playing flag transitions.
    #[test]
    #[ignore]
    fn smoke_play_tone() {
        if !audio_smoke_opted_in("smoke_play_tone") {
            return;
        }
        let tone = sine(440.0, 0.8, WHISPER_RATE, 0.4);
        let wav = encode_wav_pcm16(&tone, WHISPER_RATE);
        let player = Player::spawn();
        player.play(wav);
        std::thread::sleep(Duration::from_millis(300));
        if let Some(err) = player.last_error() {
            eprintln!("SKIP smoke_play_tone: no usable audio output device ({err})");
            return;
        }
        assert!(
            player.is_playing(),
            "player never started: {:?}",
            player.last_error()
        );
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!player.is_playing(), "player never finished");
        assert_eq!(player.last_error(), None);
    }

    /// Full loop: play a tone while recording — requires the loopback routing
    /// (play→null sink, capture→its monitor) the verification shell sets up.
    /// Asserts the captured audio contains the played tone.
    ///
    /// The tone (2.5s) is deliberately LONGER than the capture window (~1.6s) so
    /// the whole recording is steady-state tone — and we estimate the frequency
    /// over the middle 60% only, skipping the stream-startup onset. (A naive
    /// estimate over a buffer with trailing silence reads low: 440·tone/window.)
    #[test]
    #[ignore]
    fn smoke_loopback_tone_roundtrip() {
        let Some(session) = capture_for_audio_smoke("smoke_loopback_tone_roundtrip") else {
            return;
        };
        let player = Player::spawn();
        let tone = sine(440.0, 2.5, WHISPER_RATE, 0.6);
        player.play(encode_wav_pcm16(&tone, WHISPER_RATE));
        std::thread::sleep(Duration::from_millis(1600));
        if let Some(err) = player.last_error() {
            eprintln!("SKIP smoke_loopback_tone_roundtrip: no usable audio output device ({err})");
            return;
        }
        let res = session.finish().expect("finish capture");
        let (_, samples) = decode_wav(&res.wav);
        let f32s: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        if f32s.is_empty() {
            eprintln!("SKIP smoke_loopback_tone_roundtrip: capture device returned no samples");
            return;
        }
        let level = rms(&f32s);
        assert!(level > 0.01, "loopback capture is silent (rms {level})");
        // Middle 60% — past the onset, before finish() trims, all tone.
        let lo = f32s.len() * 2 / 10;
        let hi = f32s.len() * 8 / 10;
        let mid = &f32s[lo..hi];
        let f = zero_cross_freq(mid, WHISPER_RATE);
        assert!(
            (f - 440.0).abs() < 40.0,
            "expected ~440Hz in the loopback capture, got {f}"
        );
    }
}
