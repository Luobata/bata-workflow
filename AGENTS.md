# AGENTS

## Scope

These rules apply when changing the monitor stack under this repo, especially:

- `apps/monitor-board/**`
- `skills/monitor/**`
- `apps/bata-workflow/tests/monitor-*.test.ts`

## Live data modes

Before changing monitor behavior, distinguish these three modes clearly:

1. `seed=...` in the URL means explicit demo data.
2. `monitorSessionId=...` means a live attach target.
3. A live attach target may still render a **session shell** when no matching fresh bata-workflow run exists yet.

Do not call the session shell “mock data”. It is a live fallback built from monitor session state.

## Source of truth for live monitor-board data

`monitor-board` does not read the current Coco conversation directly.
It rebuilds live snapshots from persisted runtime state and, when attached to a Coco session, Coco session cache files:

- `monitor-board/runtime.json`
- `monitor-sessions/<root>.json`
- `runs/*/queue.json`
- `runs/*/task-store.json`
- `~/Library/Caches/coco/sessions/<cocoSessionId>/session.json`
- `~/Library/Caches/coco/sessions/<cocoSessionId>/events.jsonl`
- `~/Library/Caches/coco/sessions/<cocoSessionId>/traces.jsonl`

Selection order matters:

1. If `monitor-sessions/<root>.json` contains a `cocoSessionId`, prefer the matching Coco snapshot.
2. Otherwise use the newest matching bata-workflow run newer than the current monitor attach time.
3. If neither source is fresh/usable, fall back to the session shell.

Do not “fake” live data by mutating runtime files. Fix the source selection instead.

## Required testing / debugging approach

When validating monitor changes, **do not use the repo's default `.bata-workflow/state` as your first-choice test target**.
Prefer an isolated state root so local debugging does not pollute persistent monitor data.

Preferred approach:

1. Create an isolated temp state root.
2. Run monitor skill / board / bata-workflow runtime with the same `BATA_WORKFLOW_STATE_ROOT`.
3. Verify behavior there.
4. Remove the temp directory after validation.

Preferred environment variable:

```bash
BATA_WORKFLOW_STATE_ROOT=/absolute/path/to/temp-state
```

`MONITOR_STATE_ROOT` is only a compatibility fallback. Prefer `BATA_WORKFLOW_STATE_ROOT` for new work.

If you need to validate Coco bridge behavior without touching your real Coco cache, also point the board/runtime at an isolated exported Coco sessions directory:

```bash
COCO_SESSIONS_ROOT=/absolute/path/to/temp-coco-sessions
```

For manual browser debugging, keep both variables aligned with the same isolated run so websocket payloads and board state come from the same sandbox.

For live monitor regression tests, treat this isolated multi-session fixture flow as the default pattern:

1. Bind the target monitor session to one explicit `COCO_SESSION_ID` fixture.
2. Open the board for that target session and verify it starts from a fresh shell (`awaiting runtime data`).
3. Advance a sibling Coco session in the same workspace and verify none of its data appears on the target board.
4. Advance the bound Coco session and verify only its live events appear.
5. Remove or stale the bound Coco session and verify the board transitions to `disconnected` without cross-session fallback.

## Verification order

For monitor changes, prefer this order:

1. Focused unit tests
   - `apps/monitor-board/src/test/board.test.tsx`
   - `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
   - `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`
   - `apps/bata-workflow/tests/monitor-board-launcher.test.ts`
   - Add/keep Coco bridge cases in `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
2. `pnpm build` for `apps/monitor-board`
3. Browser reload against an isolated state root
4. WebSocket probe only after the above checks are green

## Monitor board lifecycle invariants (must keep)

For every change touching monitor runtime/board lifecycle, preserve these invariants:

1. **No dangling board after last session closes**
   - When the final tracked `rootSessionId` is gone, monitor-board must stop itself quickly.
   - Do not rely on next `/monitor` invocation to perform lazy cleanup.
2. **No timeout-driven eviction for active sessions**
   - Do not auto-release active monitor leases due short timeout windows.
   - Prefer explicit session close/cleanup signals over idle time heuristics.
3. **Fail fast, never hang silently**
   - Any monitor startup/sync failure must surface a user-visible message or stderr warning.
   - Avoid unbounded waits around board startup, snapshot sync, or Coco session inference.
4. **Prefer recoverability over hard failure**
   - If live data is temporarily unavailable, keep shell mode explicit (`awaiting runtime data` / `disconnected`) and continue retry paths.

## /monitor anti-freeze checklist

Before shipping monitor changes, verify all of the following:

1. `/monitor` returns within bounded time even when board startup path is broken.
2. Frontend gateway/socket disconnect does not freeze forever; it retries and surfaces connection issue text.
3. Snapshot sync failures log warnings and do not wedge future sync loops.
4. Last session cleanup actually terminates board process (no orphan listener on board port).
5. Detached process cleanup escalates when SIGTERM is ignored (TERM -> KILL fallback where supported).

## Suggested test focus for AI agents

When editing monitor stack, prioritize these tests first:

1. `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`
   - monitor invoke/create/attach/failure paths
2. `apps/bata-workflow/tests/run-session.test.ts`
   - last-session cleanup and board stop behavior
3. `apps/bata-workflow/tests/monitor-board-launcher.test.ts`
   - reuse/startup-failure/identity mismatch cleanup
4. `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
   - shell/disconnected/live transition and lease release policy
5. `apps/monitor-board/src/test/board.test.tsx`
   - websocket update/disconnect/retry behavior in UI

## Debug checklist for “looks like mock data”

If the board still looks fake, check in this order:

1. Is the URL using `seed`? If yes, it is demo mode by design.
2. Does `monitor-sessions/<root>.json` contain the expected `cocoSessionId` and `workspaceRoot`?
3. Does the board process see the same `COCO_SESSIONS_ROOT` / Coco cache directory that contains that session?
4. If a `cocoSessionId` is attached, does `session.json`, `events.jsonl`, and `traces.jsonl` exist for it?
5. If no Coco snapshot is available, is the page showing a shell fallback because no fresh matching run exists?
6. Does `monitor-sessions/<root>.json` have a newer `updatedAt` than the latest matching run?
7. Does the matching run have both `queue.json` and `task-store.json`?
8. Are you accidentally validating against a polluted shared `.bata-workflow/state` instead of an isolated one?

## Guardrails

- Do not hand-edit persistent `runs/*` data just to make the UI look populated.
- Do not hand-edit Coco cache files just to force a monitor screenshot; use isolated fixtures/state roots for reproducible tests.
- Do not treat browser visuals alone as proof of live correctness; always verify the state root and websocket payload.
- When the board is in shell fallback mode, keep the UI explicit that it is waiting for runtime data rather than implying fake progress.
