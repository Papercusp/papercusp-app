---
title: Put the verdict in the summary line — message bodies are truncated on delivery
kind: feedback
applies_to: [any]
type: feedback
---

Coordination messages carry a one-line summary and a longer body, and the BODY is truncated at delivery to a few hundred characters — less again when the recipient's page is crowded. The summary line is not truncated.

So the operative verdict goes in the SUMMARY, never buried in the body. A carefully argued conclusion placed three paragraphs down is simply not delivered, and the sender sees no error: the send reports success, and reports the authored length beside the delivered length, which is the only place the loss is visible. Read those two numbers when the message matters.

The body is not lost, only undelivered — the recipient can read the full text back by message id. But that costs them a round trip they will only spend if the summary told them it was worth it.

The same discipline applies to any long finding: a report longer than a short paragraph belongs on the durable record — the work-item, the plan, the checkpoint — with the message carrying a one-line pointer to it. Chat is the notification; the ledger is the artifact.
