//! Runtime-optional audio process. Keeping every cpal/rodio reference in this
//! binary lets `pui` start on machines without ALSA; only voice needs it.

#[path = "../audio_proto.rs"]
mod audio_proto;
#[path = "../voice.rs"]
mod voice_backend;

use anyhow::{anyhow, Context, Result};
use audio_proto::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    let result = match command.as_str() {
        "capture" => capture(),
        "play" => play(),
        "devices" => devices(),
        _ => Err(anyhow!("usage: pui-audio <capture|play|devices>")),
    };
    if let Err(error) = result {
        let message = format!("{error:#}");
        let _ = write_frame(std::io::stdout().lock(), ERROR, message.as_bytes());
        eprintln!("pui-audio: {message}");
        std::process::exit(1);
    }
}

fn stdin_eof_flag() -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    let signal = done.clone();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
        signal.store(true, Ordering::Relaxed);
    });
    done
}

fn capture() -> Result<()> {
    let capture = voice_backend::start_raw_capture()?;
    let stop = stdin_eof_flag();
    let mut stdout = std::io::stdout().lock();
    write_frame(&mut stdout, READY, &serde_json::to_vec(&capture.info)?)?;
    while !stop.load(Ordering::Relaxed) {
        if let Some(error) = capture.error.lock().ok().and_then(|slot| slot.clone()) {
            return Err(anyhow!(error));
        }
        match capture.chunks.recv_timeout(Duration::from_millis(20)) {
            Ok(samples) => {
                let bytes: Vec<u8> = samples.into_iter().flat_map(f32::to_le_bytes).collect();
                write_frame(&mut stdout, RAW, &bytes)?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(anyhow!("capture device stopped"))
            }
        }
    }
    // Close the device before draining the final callback blocks.
    let chunks = capture.stop();
    for samples in chunks.try_iter() {
        let bytes: Vec<u8> = samples.into_iter().flat_map(f32::to_le_bytes).collect();
        write_frame(&mut stdout, RAW, &bytes)?;
    }
    Ok(())
}

fn play() -> Result<()> {
    let player = voice_backend::Player::spawn();
    player.prepare()?;
    let (tx, rx) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            match read_frame(&mut stdin) {
                Ok(Some(frame)) => {
                    if tx.send(frame).is_err() {
                        return;
                    }
                }
                _ => return,
            }
        }
    });
    let mut stdout = std::io::stdout().lock();
    write_frame(&mut stdout, READY, b"{}")?;
    let mut last_state = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => match frame.kind {
                PLAY_REPLACE => player.play(frame.payload),
                PLAY_APPEND_ENCODED => player.append_encoded(frame.payload),
                PLAY_APPEND_PCM | PLAY_REALTIME_PCM => {
                    if frame.payload.len() < 4 || !frame.payload.len().is_multiple_of(2) {
                        return Err(anyhow!("APPEND_PCM frame lacks its sample rate"));
                    }
                    let rate = u32::from_le_bytes(frame.payload[..4].try_into().unwrap());
                    if rate == 0 {
                        return Err(anyhow!("audio sample rate must be positive"));
                    }
                    let samples = frame.payload[4..]
                        .chunks_exact(2)
                        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                        .collect();
                    if frame.kind == PLAY_REALTIME_PCM {
                        player.append_realtime_pcm(samples, rate);
                    } else {
                        player.append_pcm(samples, rate);
                    }
                }
                PLAY_STOP => player.stop(),
                other => return Err(anyhow!("unknown playback frame type {other}")),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
        let state = PlaybackState {
            playing: player.is_playing(),
            error: player.last_error(),
        };
        if last_state.as_ref() != Some(&state) {
            write_frame(&mut stdout, STATE, &serde_json::to_vec(&state)?)?;
            last_state = Some(state);
        }
    }
}

fn devices() -> Result<()> {
    let (inputs, outputs) = voice_backend::list_devices();
    let payload = serde_json::to_vec(&serde_json::json!({
        "inputs": inputs,
        "outputs": outputs,
    }))?;
    write_frame(std::io::stdout().lock(), DEVICES, &payload).context("write device list")
}
