---
name: monitor
description: Create or attach a monitor session for the current Coco work session. Use this when the user explicitly invokes /monitor.
tags:
  - monitor
  - session
  - debug
---

# Monitor

This phase is reserved for creating or attaching a monitor session for the current Coco work session. It does not auto-open monitor-board, and it does not create nested monitor sessions.

## Commands

Run the runtime once with:

```bash
node "$HOME/.coco/skills/monitor/runtime/invoke-monitor.mjs" --cwd "$PWD" --output json
```

## Expected Behavior

- First `/monitor` call in the current workspace/session => `kind=create`
- Repeated `/monitor` calls => `kind=attach`
- Child callers never create nested monitors

## Operating Rules

1. Run the command exactly once per invocation.
2. Parse the JSON response and report `kind`, `monitorSessionId`, and `message`.
3. If the runtime reuses an existing session, explain that the result is an attach to the reused session.
4. Do not auto-open monitor-board or any viewer UI.
5. Do not create nested monitor sessions.
