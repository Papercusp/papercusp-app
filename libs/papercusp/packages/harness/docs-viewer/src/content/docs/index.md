---
title: Harness Docs
description: Auto-generated documentation from the autonomous harness.
---

This viewer renders feature documentation written by the harness's **documenter** role. Each time a feature's validator marks it `passed`, the documenter produces or updates a Starlight page describing what was built, how to use it, and which `VAL-*` claims it satisfies.

## How it works

1. **Worker** implements a feature and commits.
2. **Validator** runs the validation contract. If all claims pass, the feature status flips to `passed`.
3. **Documenter** runs, reads the diff and the contract, and writes to `<project>/docs/features/F-xxx.md`.
4. This viewer picks it up via a symlink into `src/content/docs/projects/<slug>/`.

## Projects

See the sidebar for per-project docs. Symlinks are wired up by `bin/docs-viewer.sh` at startup, so only projects that have a `docs/` directory will appear.

## This is a separate process

The docs viewer runs on its own port (default `4325`) and has no runtime dependency on the harness control UI, the Restart web app, or any specific project's dev server. Start it, stop it, run it on another machine — it only needs filesystem access to the project dirs.
