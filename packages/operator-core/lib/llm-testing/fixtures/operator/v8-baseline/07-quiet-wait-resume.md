# Scenario: 07-quiet-wait-resume

**Request body:**
```json
{
  "trigger": "quiet_wait_resume",
  "messages": [
    {
      "role": "user",
      "content": "ok"
    },
    {
      "role": "assistant",
      "content": "<say>Got it — proceeding.</say>"
    }
  ],
  "modality": "text",
  "mayAskActive": false
}
```

**Raw SSE stream:**
```
event: heartbeat
data: {"tsMs":1778741244692}

event: heartbeat
data: {"tsMs":1778741260047}

event: heartbeat
data: {"tsMs":1778741275453}

event: heartbeat
data: {"tsMs":1778741291268}

id: 1
event: delta
data: {"text":"<say"}

id: 2
event: delta
data: {"text":">Welcome back. Want to pick up where we left off, or check what"}

id: 3
event: delta
data: {"text":"'s flagged in the workspace?</say>"}

event: done
data: {"costUsd":0}

```

**Events observed:**
      4 event: heartbeat
      3 event: delta
      1 event: done

**Tool calls:**

**Brain deltas (joined):**
```
<say>Welcome back. Want to pick up where we left off, or check what's flagged 
in the workspace?</say>
```

**Parsed tags (from joined deltas):**
- <say>: 1
- <continue/>: 0
- <sleep>: 0
- <set_mode>: 0

**End-of-turn classification:**
→ AWAITING_REPLY (say ends with ?)
