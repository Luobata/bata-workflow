# Monitor Board Coco Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make monitor-board isolate every Coco live session into its own monitor session, ensure a newly opened board starts with a fresh empty shell for only the current session, and show a disconnected state when that Coco session closes.

**Architecture:** Replace workspace-hash fallback as the live-session identity source with the current `COCO_SESSION_ID`, propagate that identity through monitor session state, bata-workflow runtime metadata, gateway snapshot selection, and board URL filtering, then add a terminal disconnected snapshot path instead of silent fallback or cross-session reuse. Test the behavior with isolated state roots and isolated Coco session fixtures that simulate two concurrent sessions plus a session-close transition.

**Tech Stack:** Node.js ESM runtime, React + Zustand + Vite monitor-board, Vitest, Coco session cache JSON/JSONL fixtures.

---

### Task 1: Lock live monitor identity to Coco session IDs

**Files:**
- Modify: `skills/monitor/runtime/context.mjs`
- Modify: `skills/monitor/runtime/invoke-monitor.mjs`
- Modify: `skills/monitor/runtime/monitor-session.mjs`
- Modify: `apps/bata-workflow/src/runtime/team-runtime.ts`
- Modify: `apps/bata-workflow/src/runtime/run-session.ts`
- Test: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('uses the current COCO_SESSION_ID as the live monitor root session id', async () => {
  process.env.COCO_SESSION_ID = 'coco-live-A';
  const context = resolveMonitorContext({ cwd: '/tmp/workspace-a' });
  expect(context.rootSessionId).toBe('coco-live-A');
  expect(context.stateFilePath).toContain('coco-live-A.json');
});

it('does not infer another workspace-matching Coco session when the current live session id is different', async () => {
  // fixture: workspace has coco-live-A and coco-live-B in cache
  // when opening monitor for coco-live-B, persisted state must bind to coco-live-B only
  expect(result.cocoSessionId).toBe('coco-live-B');
  expect(result.monitorSessionId).toBe('monitor:coco-live-B');
});
```

- [ ] **Step 2: Run the targeted test file and verify it fails**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" exec vitest run tests/monitor-skill-runtime.test.ts`

Expected: FAIL because monitor live identity still allows workspace-hash / latest-workspace-session fallback.

- [ ] **Step 3: Implement the minimal identity changes**

```js
// context.mjs
const liveCocoSessionId = process.env.COCO_SESSION_ID?.trim() || null;
const rootSessionId = options.rootSessionId ?? liveCocoSessionId ?? deriveWorkspaceHashSessionId(cwd);

// invoke-monitor.mjs
const explicitCocoSessionId = process.env.COCO_SESSION_ID?.trim() || null;
const cocoSessionId = explicitCocoSessionId ?? existingSession?.cocoSessionId ?? null;

// when explicit live coco session exists, do not rebind by scanning same-workspace latest session
const inferredCocoSessionId = explicitCocoSessionId ? null : await inferLatestCocoSessionId(context);

// team-runtime.ts
const rootSessionId = process.env.COCO_SESSION_ID?.trim() || `workspace-${hash}`;
monitorSessionId: `monitor:${rootSessionId}`;

// run-session.ts
// cleanup path uses explicit rootSessionId passed from run metadata so it releases only that session
```

- [ ] **Step 4: Re-run the targeted test file and verify it passes**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" exec vitest run tests/monitor-skill-runtime.test.ts`

Expected: PASS.


### Task 2: Guarantee fresh board bootstrap for only the target session

**Files:**
- Modify: `apps/monitor-board/src/monitor/gateway/bata-workflow-live.ts`
- Modify: `apps/monitor-board/src/monitor/gateway/server.ts`
- Modify: `apps/monitor-board/src/App.tsx`
- Test: `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
- Test: `apps/monitor-board/src/monitor/gateway/server.test.ts`
- Test: `apps/monitor-board/src/test/board.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('returns a shell snapshot for the current monitor session before that session has any live events', async () => {
  expect(snapshot.monitorSessionId).toBe('monitor:coco-live-A');
  expect(snapshot.timelineCount).toBe(1);
  expect(snapshot.state.timeline[0].summary).toContain('awaiting runtime data');
});

it('does not leak another monitor session snapshot to a board targeted at session A', async () => {
  gateway.replaceSnapshots([snapshotA, snapshotB]);
  render(<App targetMonitorSessionId="monitor:coco-live-A" ... />);
  expect(screen.queryByText(/session B summary/i)).toBeNull();
});
```

- [ ] **Step 2: Run the monitor-board test files and verify they fail**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/monitor/gateway/server.test.ts src/test/board.test.tsx`

Expected: FAIL because current snapshot selection and board bootstrap can still expose non-target snapshots or stale previous content.

- [ ] **Step 3: Implement the minimal filtering and shell-bootstrap changes**

```ts
// bata-workflow-live.ts
// only build snapshots for active session ids from the current state root, never from unrelated workspace cache matches

// server.ts
// broadcast all snapshots, but support explicit removal/tombstone snapshots instead of silent deletion

// App.tsx
const initialSnapshot = targetMonitorSessionId
  ? createLiveShellSnapshot(targetMonitorSessionId)
  : createDemoSnapshot();

if (snapshot.monitorSessionId !== targetMonitorSessionId) {
  return;
}

// keep page state bound to the target session only; never hydrate from a different session payload
```

- [ ] **Step 4: Re-run the monitor-board test files and verify they pass**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/monitor/gateway/server.test.ts src/test/board.test.tsx`

Expected: PASS.


### Task 3: Add disconnected lifecycle for closed Coco sessions

**Files:**
- Modify: `apps/monitor-board/src/monitor/protocol/schema.ts`
- Modify: `skills/monitor/src/protocol/schema.ts`
- Modify: `apps/monitor-board/src/monitor/gateway/bata-workflow-live.ts`
- Modify: `apps/monitor-board/src/components/TopBar.tsx`
- Modify: `apps/monitor-board/src/App.tsx`
- Test: `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
- Test: `apps/monitor-board/src/test/board.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('marks the session disconnected when the bound Coco session stops updating', async () => {
  expect(snapshot.state.actors[0].status).toBe('disconnected');
  expect(snapshot.state.timeline.at(-1)?.summary).toContain('disconnected');
});

it('renders disconnected health while preserving the last frame of the current session', () => {
  render(<App initialSnapshot={disconnectedSnapshot} targetMonitorSessionId="monitor:coco-live-A" />);
  expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  expect(screen.getByText(/实时验证标记/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted monitor-board tests and verify they fail**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/test/board.test.tsx`

Expected: FAIL because protocol and UI do not yet encode a disconnected state.

- [ ] **Step 3: Implement the minimal disconnected snapshot flow**

```ts
// protocol/schema.ts
export const StatusSchema = z.enum(['idle', 'active', 'blocked', 'done', 'failed', 'canceled', 'disconnected']);

// bata-workflow-live.ts
// derive liveness from bound session.json updated_at / events.jsonl timestamps
// if session is stale or removed, emit a disconnected snapshot using the same monitorSessionId

// App.tsx + TopBar.tsx
// map disconnected snapshots to HEALTH=DISCONNECTED, STAGE=DISCONNECTED
// keep existing summary/timeline text from the current session instead of clearing the board
```

- [ ] **Step 4: Re-run the targeted monitor-board tests and verify they pass**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/test/board.test.tsx`

Expected: PASS.


### Task 4: Freeze the new end-to-end testing mode

**Files:**
- Modify: `apps/monitor-board/src/monitor/gateway/bata-workflow-live.test.ts`
- Modify: `apps/bata-workflow/tests/monitor-board-launcher.test.ts`
- Modify: `bata-workflow/AGENTS.md`

- [ ] **Step 1: Write the failing integration-style tests for isolated multi-session behavior**

```ts
it('shows a fresh shell for session A, ignores session B updates, then renders only session A updates', async () => {
  // fixture with two coco sessions under same workspace
  expect(initialA.timelineCount).toBe(1);
  expect(initialA.state.timeline[0].summary).toContain('awaiting runtime data');

  // after advancing session B only
  expect(snapshotForBoardA.monitorSessionId).toBe('monitor:coco-live-A');
  expect(snapshotForBoardA.state.timeline.some((evt) => evt.sessionId === 'coco-live-B')).toBe(false);

  // after advancing session A
  expect(snapshotForBoardA.state.timeline.some((evt) => evt.sessionId === 'coco-live-A')).toBe(true);
});

it('transitions the current board session to disconnected when the bound coco session closes', async () => {
  expect(disconnected.monitorSessionId).toBe('monitor:coco-live-A');
  expect(disconnected.state.actors[0].status).toBe('disconnected');
});
```

- [ ] **Step 2: Run the relevant test files and verify they fail**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/monitor/gateway/server.test.ts src/test/board.test.tsx && pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" exec vitest run tests/monitor-board-launcher.test.ts tests/monitor-skill-runtime.test.ts`

Expected: FAIL before the final behavior is fully implemented.

- [ ] **Step 3: Update the repo guidance so future tests use this isolated-session pattern**

```md
For live monitor validation, use isolated `HARNESS_STATE_ROOT` and isolated `COCO_SESSIONS_ROOT` fixtures.
Always verify:
1. board opens with a fresh shell for the target session only
2. other session data never appears
3. current session updates stream in live
4. session close becomes disconnected
```

- [ ] **Step 4: Run the full verification set and verify everything passes**

Run: `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" exec vitest run tests/monitor-board-launcher.test.ts tests/monitor-skill-runtime.test.ts && pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" exec vitest run src/monitor/gateway/bata-workflow-live.test.ts src/monitor/gateway/server.test.ts src/test/board.test.tsx && pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" build`

Expected: all tests PASS and build succeeds.
