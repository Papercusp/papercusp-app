# Agent brief — Holepunch video for shared harnesses (2026-06-05)

**Self-contained.** Standalone from the desktop-workbench / universal-voice discussion the owner is having separately. You **extend** the existing holepunch voice transport — do **not** fork it. Coordinate with the **`holepunch-voice-channels-2026-06-05`** plan owner (su-7c44bb97 et al.); `apps/tui/src/voice_stream.rs` and the `p2p-voice` framing are hot.

## Goal
Add **peer-to-peer video** to the **desktop app** for **shared harnesses**, surfaced inside a voice/video tab — mirroring how **Keet** does A/V over Holepunch. The audio half already exists and is cross-NAT-proven; you add the video track + the participant-grid GUI. Audio is mixed server-side; **video is fanned out per-peer and rendered as N tiles client-side** (you don't mix video).

## What already exists (build on this — don't rebuild)
- **Proven P2P transport:** `libs/holepunch-spike/voice/` — UDX datagram + Hyperswarm, cross-NAT verified home↔Ashburn (~0.31 ms loopback, 38.8 ms WAN, 0 % loss; see `RESULTS.md`). WebRTC was benchmarked (`05-webrtc-compare.mjs`) and **not** chosen for audio because UDX won — but for *video* WebCodecs-over-UDX is the path (D-002).
- **Production voice-node:** `libs/generic/p2p-voice/` — `voice-node.ts`, `mixer.ts`, `framing.ts`. One channel per node (Discord/Keet model), in-band presence, PCM16↔Opus over an injected `codec` seam.
- **Operator-side wiring:** `packages/operator-core/lib/voice-node/` — `manager.ts`, `local-audio-socket.ts` (framing `[4B len BE][1B type][payload]`, types `0x01 CTRL / 0x02 MIC / 0x03 MIX`, discovery file `~/.papercusp/voice-ipc.json`), `agent-peer.ts`, `codec.ts`, `desktop-voice-ws.ts`.
- **TUI client:** `apps/tui/src/voice_stream.rs`. **Channel model:** topic = the shared-harness/fleet id; presence is in-band.

## Decisions
- **D-001 — Transport: a second media stream on the SAME swarm topic.** Reuse the per-channel Hyperswarm/UDX connection; add a **video frame type** to both the swarm framing (`p2p-voice/framing.ts`) and the local socket (`0x04 VIDEO` alongside `0x02 MIC`). Frames are keyframe + delta chunks tagged with sender id; **fan out per-peer, no server mix**.
- **D-002 — Codec: WebCodecs in the Tauri webview.** The desktop is a webview — use `VideoEncoder`/`VideoDecoder` (VP8 or H.264, hardware-accelerated where available) over `getUserMedia` camera frames. Closest analog to Keet's WebRTC-media-over-holepunch without a native codec dep. Keep the encoder behind a seam (like the audio `codec` seam) so a native encoder can swap in later.
- **D-003 — Scope: shared harnesses only.** The video channel is keyed to a shared-harness/fleet topic; a solo local harness shows no channel. Reuse the existing in-band peer roster for presence.
- **D-004 — GUI (the voice/video tab):** Discord/Keet-style — a **participant grid** (camera tile, or avatar + talking-ring when camera off), **self-view PiP**, **active-speaker highlight** border, per-tile mute/deafen, a bottom control bar (**mic / camera / screen-share / leave**), and graceful empty/permission states. Build it as a **self-contained component**; the desktop-workbench plan owns the *pane it mounts into* — agree the component contract, don't block on the mount.
- **D-005 — Degrade gracefully + bound cost.** No camera / denied permission → audio-only with avatars. Adapt resolution/framerate to peer count + link health (start 360p@15, scale down on loss — mirror the audio AIMD instinct). Hard-cap visible tiles. Document the bandwidth/CPU budget.
- **D-006 — Screen-share (stretch):** same pipeline with `getDisplayMedia` as the source; one shared screen track per channel.

## Build order
1. Extend `p2p-voice/framing.ts` + `voice-node/local-audio-socket.ts` with the `0x04 VIDEO` frame type (+ unit tests for the codec/framing).
2. Camera-capture + WebCodecs encode/decode module, seam-isolated, unit-tested on synthetic frames.
3. Wire the video track through the voice-node swarm per channel (per-peer fan-out, no mix).
4. The participant-grid GUI component (desktop), behind a feature flag (`libs/flags`), mounted in the voice/video pane.
5. E2E: two desktop instances join the same shared-harness channel → see each other's camera, active-speaker tracking, mute, leave; cross-NAT if feasible.

## Verify
Two app instances on the same shared harness establish a P2P video channel with **no server relay**: each sees the other's camera tile, the active-speaker highlight tracks who's talking, camera/mic toggles work, leave tears down cleanly, and audio-only degrade works with the camera off. Tests ship with each layer; respect the shared-tree rules (stay on main, git-sync owns commit/push, file-lock hook, coord-claim the hot `apps/tui` + `p2p-voice` files first).
