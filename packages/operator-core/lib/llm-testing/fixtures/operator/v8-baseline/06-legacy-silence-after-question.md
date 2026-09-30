# Scenario: 06-legacy-silence-after-question

**Request body:**
```json
{
  "trigger": "silence_after_question",
  "messages": [
    {
      "role": "user",
      "content": "Can you summarize?"
    },
    {
      "role": "assistant",
      "content": "<say>Sure — what specifically would you like me to summarize, the sheets harness or all workspaces?</say>"
    }
  ],
  "modality": "text",
  "mayAskActive": false
}
```

**Raw SSE stream:**
```
event: heartbeat
data: {"tsMs":1778741224964}

id: 1
event: error
data: {"message":"invalid_args: [\n  {\n    \"code\": \"invalid_union\",\n    \"errors\": [\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"user_message\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"user_message\\\"\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"quiet_wait_resume\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"quiet_wait_resume\\\"\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"open_canvas\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"open_canvas\\\"\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"user_says_ready\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"user_says_ready\\\"\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"user_welcomed\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"user_welcomed\\\"\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"continue\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"continue\\\"\"\n        }\n      ]\n    ],\n    \"path\": [\n      \"trigger\"\n    ],\n    \"message\": \"Invalid input\"\n  }\n]"}

```

**Events observed:**
      1 event: heartbeat
      1 event: error

**Tool calls:**

**Brain deltas (joined):**
```

```

**Parsed tags (from joined deltas):**
- <say>: 0
- <continue/>: 0
- <sleep>: 0
- <set_mode>: 0

**End-of-turn classification:**
→ TERMINAL (in active mode, runtime should auto-fire user_says_ready)
