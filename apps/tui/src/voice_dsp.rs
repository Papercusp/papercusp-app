//! Shared pure audio transforms; no device library dependencies.
#![allow(dead_code)]

/// Whisper's native sample rate — the capture pipeline's output rate.
pub const WHISPER_RATE: u32 = 16_000;

// ─────────────────────────── pure DSP (unit-tested) ───────────────────────────

/// Interleaved multi-channel f32 → mono by averaging each frame's channels.
pub fn mix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return samples.to_vec();
    }
    samples
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Resample mono f32 to 16 kHz. Integer downsample ratios use boxcar-average
/// decimation (the averaging doubles as a crude anti-alias low-pass — plenty
/// for PTT speech into Whisper); everything else uses linear interpolation.
pub fn resample_to_16k(mono: &[f32], src_rate: u32) -> Vec<f32> {
    if mono.is_empty() || src_rate == 0 {
        return Vec::new();
    }
    if src_rate == WHISPER_RATE {
        return mono.to_vec();
    }
    if src_rate > WHISPER_RATE && src_rate.is_multiple_of(WHISPER_RATE) {
        let ratio = (src_rate / WHISPER_RATE) as usize;
        return mono
            .chunks(ratio)
            .map(|c| c.iter().sum::<f32>() / c.len() as f32)
            .collect();
    }
    let ratio = src_rate as f64 / WHISPER_RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let i0 = pos.floor() as usize;
            let frac = (pos - i0 as f64) as f32;
            let a = mono[i0.min(mono.len() - 1)];
            let b = mono[(i0 + 1).min(mono.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// Encode mono f32 (−1..1) as a PCM16 WAV byte buffer at `rate`.
pub fn encode_wav_pcm16(samples: &[f32], rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        // In-memory writer can't fail on IO; unwraps are spec-correctness only.
        let mut w = hound::WavWriter::new(&mut cur, spec).expect("wav writer");
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            w.write_sample(v).expect("wav sample");
        }
        w.finalize().expect("wav finalize");
    }
    cur.into_inner()
}

/// Synthesize a sine tone (test/smoke helper).
pub fn sine(freq: f32, secs: f32, rate: u32, amp: f32) -> Vec<f32> {
    let n = (secs * rate as f32) as usize;
    (0..n)
        .map(|i| (i as f32 / rate as f32 * freq * std::f32::consts::TAU).sin() * amp)
        .collect()
}

/// Root-mean-square level of a chunk (the mic meter's unit).
pub fn rms(chunk: &[f32]) -> f32 {
    if chunk.is_empty() {
        return 0.0;
    }
    (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt()
}

/// Convert a drained interleaved f32 window into 16 kHz mono PCM16 LE bytes —
/// the exact `pcm_16000` chunk shape EL's `user_audio_chunk` wants
/// (voice-realtime-tui-2026-06-05 D-006). Pure — unit-tested.
pub fn f32_chunk_to_pcm16le(raw: &[f32], channels: u16, src_rate: u32) -> Vec<u8> {
    let mono = mix_to_mono(raw, channels);
    let s16k = resample_to_16k(&mono, src_rate);
    let mut out = Vec::with_capacity(s16k.len() * 2);
    for s in s16k {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}
