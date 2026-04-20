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

## Immediate Execution Procedure

When `/monitor` is invoked, do this immediately:

1. Use the Bash tool exactly once to run the runtime command below.
2. Do not create a todo list before the Bash call.
3. Do not ask follow-up questions before the Bash call.
4. After the Bash call returns, parse the JSON and report the result.

## Runtime Command

Run this exact command once:

```bash
node "$HOME/.coco/skills/monitor/runtime/invoke-monitor.mjs" --cwd "$PWD" --output json
```

## Expected Behavior

- First `/monitor` call in the current workspace/session => `kind=create`
- Repeated `/monitor` calls => `kind=attach`
- Child callers never create nested monitors

## Runtime Output Contract

The runtime returns JSON with:

- `kind`: `create` or `attach`
- `monitorSessionId`: current monitor session identifier
- `message`: human-readable summary of the create/attach result
- `board.url`: a monitor-board URL for the current `monitorSessionId` when the board is available

The `board` object follows this contract:

- `board.status=started`: the runtime started monitor-board for this invocation
- `board.status=reused`: the runtime reused an existing monitor-board and returned a session-specific URL
- `board.status=failed`: monitor-board could not be started or reused; `board.url` is `null` and `board.message` explains why

## Operating Rules

1. Run the runtime command exactly once per invocation, before any extra reasoning steps.
2. Parse the JSON response and report `kind`, `monitorSessionId`, `message`, and `board` status/URL details.
3. If the runtime reuses an existing session, explain that the result is an attach to the reused session.
4. If `board.url` is present, tell the user to open that URL manually.
5. If the Bash call fails, report the failure output directly instead of hanging or waiting.
6. Do not auto-open monitor-board, a browser, or any viewer UI.
7. Do not create nested monitor sessions.
