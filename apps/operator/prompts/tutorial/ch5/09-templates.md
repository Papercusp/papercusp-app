---
id: ch5-09-templates
chapter: 5
order: 9
title: Templates — building whole apps on Papercusp
docSlugs: spec/spawnable-templates
---

## Brief

**Templates** are how you build whole new apps on Papercusp: each one bundles
ready-made code components, an agent-readable build guide, and an acceptance
check suite. You compose an app from several of them — a desktop shell, a data
layer, a UI kit, an agent plane — and an agent does the assembly, verified by
the templates' own checks. Browse the **"Papercusp Official:"** set in the
Cupboard's Templates section.

## Details

A template is not a rigid scaffold. It has three parts: **components**
(version-pinned packages — the deterministic code), a **GUIDE** (the
composition prompt an agent follows, with hard MUST rules, SHOULD defaults,
and FREE choices left to judgment), and **checks** (an acceptance suite every
composition must pass). Correctness comes from verification, not from a rigid
generator: the agent composes freely, then the union of every used template's
checks has to run green. One app typically composes several templates — an
app-scope template (like `desktop-app` or `agentic-desktop-app`) pulls in
aspect templates (`tauri-desktop-shell`, `papercusp-data-layer`,
`papercusp-ui`, `papercusp-data-sync`, `papercusp-search`,
`release-pipeline`, …) via pinned requirements.

The official set was extracted from real apps built on Papercusp (the
quartermaster and oddsmith pattern: a deterministic app joined to a judgment
Pot by one work-item seam), and a scheduled "template gym" continuously
rebuilds the reference composition so templates can't silently rot as the
platform moves.

Honest labeling: today the flow is **ask an agent** — "build me an app from
the desktop-app template" — and it installs the template and follows the
GUIDE. The polished one-click "New app from template" entry point is still
under construction, so treat that part as in development, not ready yet.
