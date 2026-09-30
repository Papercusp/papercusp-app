---
id: ch6-02-gpu-allocation
chapter: 6
order: 2
title: GPU allocation — lending compute across the Pot
docSlugs:
---

## Brief

**Still being built — do not expect this to work today.** The idea: machines
in a Pot advertise their GPUs, and workloads that need one (local model
inference, embeddings, media work) get placed on whichever peer has capacity
— your laptop borrowing the tower's GPU without you configuring anything.

## Details

This section is a design preview, not a feature tour — **GPU allocation is
one of the youngest pieces of the p2p roadmap and is explicitly not
functional yet.**

The intended model mirrors how the inference gateway already treats API
accounts (chapter 5): a pool with a governor. Each peer advertises what
hardware it has and how busy it is; a placement layer matches GPU-hungry
jobs to peers with headroom, streams the work over the encrypted p2p
channel, and returns results as if they'd run locally. Priorities and quotas
keep one machine's batch job from starving another's interactive session.

Why it's worth building: local models are increasingly good enough for real
agent work (drafting, classification, embeddings), and most Pots have
exactly one machine with a serious GPU. Pooling it turns "the one box that
can run models" into "the Pot can run models."

Until this ships, the practical answer for model workloads remains the
inference gateway and hosted accounts. When GPU pooling lands it will be
announced like any other feature — flag-gated, documented, and visible in
the GUI.
