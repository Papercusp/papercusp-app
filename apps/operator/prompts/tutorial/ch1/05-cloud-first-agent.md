---
id: ch1-05-cloud-first-agent
chapter: 1
order: 5
title: Cloud — get your first agent running
docSlugs: cloud/first-agent-lesson-runbook
---

## Brief

In the hosted app's Cloud view, open Help and choose **Get your first agent running**.
The six-step guide explains the real controls while you connect Google Cloud,
review configuration and cost, prepare a healthy workspace, launch an agent,
send a small read-only task and inspect its answer. You perform each action;
neither the guide nor its advisory AI help performs cloud work for you.

## Details

This is the hosted Cloud lesson, version 1 (`first-cloud-agent`); the desktop
installation tutorial is a separate flow. Sign in and select an authorized
workspace. Have a Google Cloud project, the permissions/APIs needed by the
connection form, an injected credential reference and the requested runtime
service account. Keep secrets in that form, never in lesson Help.

The guide uses these headings and controls:

1. **Connect Google Cloud** — complete the form and choose **Connect and validate**.
2. **Review configuration and cost** — review the current region, machine, disk
   and estimate, then choose **I've reviewed the configuration and cost**.
   Provider billing is authoritative; retained disks and agent model usage can
   cost money. An existing healthy workspace can be selected instead.
3. **Wait for a healthy workspace** — explicitly provision or select your
   workspace, inspect readiness and connect its browser session.
4. **Launch your first agent** — choose **+ New session** and review its model/account.
5. **Submit a small read-only task** — choose **Send sample task**. It asks the
   agent to list its tools without running them or changing anything.
6. **Inspect the result** — read that request's successful answer and choose
   **I've inspected this answer**. Other sessions or unrelated answers do not count.

**Show me** navigates to and focuses the current control. **Check again** reads
state or retries a progress save; it never provisions or resends a task.
**Pause**, **Resume guide**, **Skip lesson**, **Close guide** and Help/replay affect
the guide. Replay explanations do not reset cloud resources or create success.
Reload restores scoped guide disposition/inspection, then rechecks current
product state; saved progress is not evidence that a resource or task succeeded.

The guide speaks instructions and permitted help answers through the existing
voice selection. **Mute guide**, **Stop speech** and **Replay speech** control
playback. AI/TTS outage or blocked autoplay leaves the text and Cloud controls
usable; no microphone is needed. Help questions go to the configured AI service,
so keep secrets out. Explicit tutorial analytics use only fixed lesson/action/
step/status metadata through existing consent; the tutorial does not enable
session recording.

When blocked, inspect the indicated connection validation, workspace operation,
session launch receipt or correlated task transcript. Fix the product condition,
then use its explicit retry/repair control. Never manipulate saved progress or
mark a step complete manually. See the maintained
**Cloud first-agent lesson and troubleshooting runbook** for recovery details.
