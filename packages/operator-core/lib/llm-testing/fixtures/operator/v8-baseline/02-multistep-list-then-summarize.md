# Scenario: 02-multistep-list-then-summarize

**Request body:**
```json
{
  "trigger": "user_message",
  "messages": [
    {
      "role": "user",
      "content": "List the open issues in the sheets harness, then summarize them by severity."
    }
  ],
  "modality": "text",
  "mayAskActive": false
}
```

**Raw SSE stream:**
```
event: heartbeat
data: {"tsMs":1778741191994}

event: heartbeat
data: {"tsMs":1778741207456}

event: heartbeat
data: {"tsMs":1778741222715}

event: heartbeat
data: {"tsMs":1778741238868}

id: 1
event: delta
data: {"text":"<say"}

id: 2
event: delta
data: {"text":">Checking sheets for open issues.</say>"}

event: done
data: {"costUsd":0}

```

**Events observed:**
      4 event: heartbeat
      2 event: delta
      1 event: done

**Tool calls:**

**Brain deltas (joined):**
```
<say>Checking sheets for open issues.</say>
```

**Parsed tags (from joined deltas):**
- <say>: 1
- <continue/>: 0
- <sleep>: 0
- <set_mode>: 0

**End-of-turn classification:**
→ TERMINAL (in active mode, runtime should auto-fire user_says_ready)
