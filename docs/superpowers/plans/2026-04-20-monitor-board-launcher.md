# Monitor Board Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Coco 中的 `/monitor` 在维持现有 create-or-attach monitor session 语义的同时，自动启动或复用 `monitor-board` 本地服务，并返回可点击的本地 URL。

**Architecture:** 保留现有 `skills/monitor/runtime` 的 session 逻辑不变，在其上新增一个独立的 `board-launcher.mjs` 薄层负责 repo root 发现、端口探测、子进程启动和 board URL 构造。`invoke-monitor.mjs` 只负责串联 monitor session 与 board launcher 两段结果，`monitor-board` 页面仅补充 querystring 读取能力，不引入完整 gateway 改造。

**Tech Stack:** Node.js ESM runtime (`.mjs`)、Vitest、Vite dev server、React 19、TypeScript、Rush/pnpm workspace。

---

## File Structure

### New Files

- Create: `skills/monitor/runtime/board-launcher.mjs` — 负责 board 服务复用/启动、状态文件读写、端口探测和 URL 构造。
- Create: `apps/bata-workflow/tests/monitor-board-launcher.test.ts` — launcher 层单测，覆盖 started/reused/failed 三种返回。

### Existing Files to Modify

- Modify: `skills/monitor/runtime/context.mjs` — 增加 `boardRepoRoot`、`boardRuntimeStatePath`、默认 board host/port 解析。
- Modify: `skills/monitor/runtime/invoke-monitor.mjs` — 在 session 结果外拼接 `board` 字段，并支持注入 fake launcher 便于测试。
- Modify: `skills/monitor/SKILL.md` — 更新 `/monitor` 行为说明，明确返回 board URL、不自动开浏览器。
- Modify: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts` — 增加 launcher 集成测试与 board failed 兜底测试。
- Modify: `apps/bata-workflow/tests/skill-command.test.ts` — 扩展 linked / published-local 安装态测试，校验 board URL 和 reused 语义。
- Modify: `apps/monitor-board/src/App.tsx` — 从 `window.location.search` 读取 `monitorSessionId`，在 fallback / 初始 snapshot 展示中使用。
- Modify: `apps/monitor-board/src/test/board.test.tsx` — 增加 querystring 初始化测试。

### Notes Locked In

- launcher 第一版统一用 `127.0.0.1:5173`，通过 CLI 参数覆盖 `apps/monitor-board/vite.config.ts:15-17` 的默认 4173，而不是修改现有 Vite 配置。
- board 运行态状态文件固定为：`<repoRoot>/.bata-workflow/state/monitor-board/runtime.json`。
- 如果无法从当前 `cwd` 向上找到 `apps/monitor-board/package.json`，launcher 返回 `failed`，但 monitor session 结果继续成功返回。

---

### Task 1: Write failing launcher and runtime contract tests

**Files:**
- Create: `apps/bata-workflow/tests/monitor-board-launcher.test.ts`
- Modify: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`

- [ ] **Step 1: Write the failing launcher test file**

Create `apps/bata-workflow/tests/monitor-board-launcher.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureMonitorBoardRunning } from '../../../skills/monitor/runtime/board-launcher.mjs'

const tempRoots: string[] = []

const createTempRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'monitor-board-launcher-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('monitor board launcher', () => {
  it('starts monitor-board when no state exists and the port is offline', async () => {
    const repoRoot = createTempRoot()
    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })

    const spawn = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))
    const result = await ensureMonitorBoardRunning(
      {
        repoRoot,
        monitorSessionId: 'monitor:workspace-1',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        isPortReachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        spawnProcess: spawn,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-1',
      port: 5173,
      pid: 43210,
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(readFileSync(resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json'), 'utf8'))
    expect(persisted).toMatchObject({ port: 5173, pid: 43210 })
  })

  it('reuses an already running board when the recorded port is reachable', async () => {
    const repoRoot = createTempRoot()
    mkdirSync(resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })

    const statePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    require('node:fs').writeFileSync(
      statePath,
      JSON.stringify({ pid: 123, port: 5173, url: 'http://127.0.0.1:5173', startedAt: '2026-04-20T00:00:00.000Z', repoRoot }),
    )

    const result = await ensureMonitorBoardRunning(
      { repoRoot, monitorSessionId: 'monitor:workspace-1', preferredPort: 5173, host: '127.0.0.1' },
      {
        isPortReachable: vi.fn().mockResolvedValue(true),
        spawnProcess: vi.fn(),
        waitForPort: vi.fn(),
      },
    )

    expect(result).toMatchObject({
      status: 'reused',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-1',
      port: 5173,
      pid: 123,
    })
  })
})
```

- [ ] **Step 2: Run launcher test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-board-launcher.test.ts
```

Expected: FAIL because `skills/monitor/runtime/board-launcher.mjs` does not exist.

- [ ] **Step 3: Add the failing runtime-level board result tests**

Append these cases to `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`:

```ts
  it('returns board status started with a board URL when the launcher starts the board', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning: async () => ({
        status: 'started',
        url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Adefault',
        port: 5173,
        pid: 43210,
        message: 'monitor-board started',
      }),
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      board: {
        status: 'started',
        url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Adefault',
      },
    })
  })

  it('keeps the monitor session result when board startup fails', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning: async () => ({
        status: 'failed',
        url: null,
        port: 5173,
        pid: null,
        message: 'monitor-board failed to start on 127.0.0.1:5173',
      }),
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      board: {
        status: 'failed',
        url: null,
      },
    })
  })
```

- [ ] **Step 4: Run runtime test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
```

Expected: FAIL because `invokeMonitor()` does not yet accept `ensureBoardRunning` and does not return `board`.

- [ ] **Step 5: Commit the red tests**

```bash
git add \
  apps/bata-workflow/tests/monitor-board-launcher.test.ts \
  apps/bata-workflow/tests/monitor-skill-runtime.test.ts
git commit -m "test: define monitor board launcher contract"
```

---

### Task 2: Implement board launcher and integrate it into monitor runtime

**Files:**
- Create: `skills/monitor/runtime/board-launcher.mjs`
- Modify: `skills/monitor/runtime/context.mjs`
- Modify: `skills/monitor/runtime/invoke-monitor.mjs`

- [ ] **Step 1: Add repo-root discovery and board runtime paths to context**

Update `skills/monitor/runtime/context.mjs` with these helpers and fields:

```js
import { dirname, resolve } from 'node:path'

function findBoardRepoRoot(startCwd) {
  let current = startCwd

  while (true) {
    if (existsSync(resolve(current, 'apps', 'monitor-board', 'package.json'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      return null
    }

    current = parent
  }
}
```

Then extend the returned context:

```js
  const boardRepoRoot = options.repoRoot ? resolve(options.repoRoot) : findBoardRepoRoot(cwd)
  const boardHost = options.boardHost ?? '127.0.0.1'
  const boardPort = Number(options.boardPort ?? 5173)
  const boardRuntimeStatePath = boardRepoRoot
    ? resolve(boardRepoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    : null

  return {
    cwd,
    homeDir,
    stateRoot,
    stateFilePath,
    rootSessionId,
    requesterActorId,
    isRootActor,
    legacyInstallPath,
    hasLegacyInstall: existsSync(legacyInstallPath),
    boardRepoRoot,
    boardHost,
    boardPort,
    boardRuntimeStatePath,
  }
```

- [ ] **Step 2: Implement the launcher file**

Create `skills/monitor/runtime/board-launcher.mjs`:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import net from 'node:net'

function encodeMonitorSessionId(monitorSessionId) {
  return encodeURIComponent(monitorSessionId)
}

function buildBoardUrl(host, port, monitorSessionId) {
  return `http://${host}:${port}/?monitorSessionId=${encodeMonitorSessionId(monitorSessionId)}`
}

function readBoardRuntimeState(statePath) {
  if (!statePath || !existsSync(statePath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}

function writeBoardRuntimeState(statePath, value) {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function defaultIsPortReachable(host, port) {
  return await new Promise((resolveResult) => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolveResult(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolveResult(false)
    })
    socket.setTimeout(500, () => {
      socket.destroy()
      resolveResult(false)
    })
  })
}

async function defaultWaitForPort(host, port, timeoutMs, isPortReachable) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortReachable(host, port)) {
      return true
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  return false
}

function defaultSpawnProcess(repoRoot, host, port) {
  const child = spawn('pnpm', ['--dir', resolve(repoRoot, 'apps', 'monitor-board'), 'dev', '--', '--host', host, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

export async function ensureMonitorBoardRunning(options, deps = {}) {
  const host = options.host ?? '127.0.0.1'
  const port = options.preferredPort ?? 5173

  if (!options.repoRoot || !options.runtimeStatePath) {
    return {
      status: 'failed',
      url: null,
      port,
      pid: null,
      message: 'monitor-board repo root could not be resolved from the current workspace',
    }
  }

  const isPortReachable = deps.isPortReachable ?? defaultIsPortReachable
  const waitForPort = deps.waitForPort ?? ((probeHost, probePort) => defaultWaitForPort(probeHost, probePort, 5000, isPortReachable))
  const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess

  const existingState = readBoardRuntimeState(options.runtimeStatePath)
  if (existingState?.port && await isPortReachable(host, existingState.port)) {
    return {
      status: 'reused',
      url: buildBoardUrl(host, existingState.port, options.monitorSessionId),
      port: existingState.port,
      pid: existingState.pid ?? null,
      message: 'monitor-board is already running',
    }
  }

  const child = spawnProcess(options.repoRoot, host, port)
  const ready = await waitForPort(host, port)
  if (!ready) {
    return {
      status: 'failed',
      url: null,
      port,
      pid: child.pid ?? null,
      message: `monitor-board failed to start on ${host}:${port}`,
    }
  }

  writeBoardRuntimeState(options.runtimeStatePath, {
    pid: child.pid ?? null,
    port,
    url: `http://${host}:${port}`,
    startedAt: new Date().toISOString(),
    repoRoot: options.repoRoot,
  })

  return {
    status: 'started',
    url: buildBoardUrl(host, port, options.monitorSessionId),
    port,
    pid: child.pid ?? null,
    message: 'monitor-board started',
  }
}
```

- [ ] **Step 3: Integrate launcher output into `invokeMonitor()`**

Update `skills/monitor/runtime/invoke-monitor.mjs`:

```js
import { ensureMonitorBoardRunning } from './board-launcher.mjs'
```

Extend `invokeMonitor` like this:

```js
export async function invokeMonitor(options = {}) {
  const context = resolveMonitorContext(options)
  const existingSession = await readMonitorSessionState(context.stateFilePath)
  const result = openMonitorSession({
    rootSessionId: context.rootSessionId,
    requesterActorId: context.requesterActorId,
    isRootActor: context.isRootActor,
    existingMonitorSessionId: existingSession?.monitorSessionId ?? null,
  })

  const now = new Date().toISOString()
  await writeMonitorSessionState(context.stateFilePath, {
    rootSessionId: result.rootSessionId,
    monitorSessionId: result.monitorSessionId,
    ownerActorId: resolveOwnerActorId({ context, existingSession, result }),
    lastAttachedActorId: result.requesterActorId,
    status: 'active',
    createdAt: existingSession?.createdAt ?? now,
    updatedAt: now,
  })

  const ensureBoard = options.ensureBoardRunning ?? ensureMonitorBoardRunning
  const board = await ensureBoard({
    repoRoot: context.boardRepoRoot,
    runtimeStatePath: context.boardRuntimeStatePath,
    monitorSessionId: result.monitorSessionId,
    preferredPort: context.boardPort,
    host: context.boardHost,
  })

  return {
    kind: result.kind,
    monitorSessionId: result.monitorSessionId,
    rootSessionId: result.rootSessionId,
    requesterActorId: result.requesterActorId,
    isRootActor: result.isRootActor,
    message: appendLegacyInstallWarning(result.message, context),
    board,
  }
}
```

- [ ] **Step 4: Run focused tests to verify they pass**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-board-launcher.test.ts
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
```

Expected: PASS, with launcher returning `started/reused` and runtime returning `board` in both success and failed-board cases.

- [ ] **Step 5: Commit the runtime integration**

```bash
git add \
  skills/monitor/runtime/context.mjs \
  skills/monitor/runtime/board-launcher.mjs \
  skills/monitor/runtime/invoke-monitor.mjs \
  apps/bata-workflow/tests/monitor-board-launcher.test.ts \
  apps/bata-workflow/tests/monitor-skill-runtime.test.ts
git commit -m "feat: add monitor board launcher runtime"
```

---

### Task 3: Surface board URLs in the skill contract and installation tests

**Files:**
- Modify: `skills/monitor/SKILL.md`
- Modify: `apps/bata-workflow/tests/skill-command.test.ts`

- [ ] **Step 1: Extend the install-mode test with failing board URL assertions**

Update `apps/bata-workflow/tests/skill-command.test.ts`:

```ts
      expect(JSON.parse(linkedRuntimeResult.stdout)).toMatchObject({
        kind: 'create',
        requesterActorId: 'lead',
        isRootActor: true,
        board: {
          status: expect.stringMatching(/^(started|reused|failed)$/),
        },
      })
```

And extend the parity test:

```ts
      const linkedFirstJson = JSON.parse(linkedFirst.stdout) as {
        kind: string
        monitorSessionId: string
        board: { status: string; url: string | null }
      }

      expect(linkedFirstJson.board.url).toContain('http://127.0.0.1:5173/?monitorSessionId=')
      expect(linkedSecondJson.board.status).toBe('reused')
```

- [ ] **Step 2: Run the focused install-mode test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: FAIL because `SKILL.md` and/or install-mode assertions do not yet describe the board URL contract.

- [ ] **Step 3: Update the skill docs to describe the new board contract**

Replace the behavior section in `skills/monitor/SKILL.md` with:

```md
## Commands

Run the runtime once with:

```bash
node "$HOME/.coco/skills/monitor/runtime/invoke-monitor.mjs" --cwd "$PWD" --output json
```

## Expected Behavior

- First `/monitor` call in the current workspace/session => `kind=create`
- Repeated `/monitor` calls => `kind=attach`
- Child callers never create nested monitors
- `board.status=started` means the local monitor-board service was launched for this call
- `board.status=reused` means the local monitor-board service was already running and reused
- `board.url` is the browser URL to open manually; `/monitor` does not auto-open a browser window

## Operating Rules

1. Run the command exactly once per invocation.
2. Parse the JSON response and report `kind`, `monitorSessionId`, `message`, and `board.url`.
3. If `board.status` is `failed`, tell the user the monitor session still exists but the board did not start.
4. Do not auto-open the browser in this phase.
```
```

- [ ] **Step 4: Make the integration tests pass**

Keep `runInstalledMonitor(...)` unchanged, but update assertions so linked and published-local modes both validate:

```ts
      expect(linkedFirstJson).toMatchObject({
        kind: 'create',
        board: {
          status: expect.stringMatching(/^(started|reused)$/),
          url: expect.stringContaining('http://127.0.0.1:5173/?monitorSessionId='),
        },
      })

      expect(publishedFirstJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedFirstJson.monitorSessionId,
        board: {
          status: expect.stringMatching(/^(reused|started)$/),
          url: expect.stringContaining('http://127.0.0.1:5173/?monitorSessionId='),
        },
      })
```

- [ ] **Step 5: Re-run the focused test and commit**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: PASS.

Then commit:

```bash
git add skills/monitor/SKILL.md apps/bata-workflow/tests/skill-command.test.ts
git commit -m "test: verify monitor board URL across install modes"
```

---

### Task 4: Make the board UI consume `monitorSessionId` from the URL and run full verification

**Files:**
- Modify: `apps/monitor-board/src/App.tsx`
- Modify: `apps/monitor-board/src/test/board.test.tsx`

- [ ] **Step 1: Write the failing board UI querystring test**

Append to `apps/monitor-board/src/test/board.test.tsx`:

```ts
  it('uses the monitorSessionId query parameter when rendering the fallback board shell', () => {
    window.history.replaceState({}, '', '/?monitorSessionId=monitor%3Afrom-query')

    render(<App connectSocket={() => { throw new Error('offline'); }} />)

    expect(screen.getByText('monitor:from-query')).toBeInTheDocument()
    expect(screen.queryByText('Task 8 Board')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the board UI test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" test src/test/board.test.tsx
```

Expected: FAIL because `App` does not yet read `window.location.search`.

- [ ] **Step 3: Implement the minimal querystring-aware fallback in `App.tsx`**

Add this helper near the top of `apps/monitor-board/src/App.tsx`:

```ts
const readMonitorSessionIdFromLocation = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = new URLSearchParams(window.location.search).get('monitorSessionId');
  return value && value.trim() ? value.trim() : null;
};
```

Then derive the fallback snapshot:

```ts
const cloneDemoSnapshotForMonitor = (monitorSessionId: string): SessionSnapshot => ({
  ...demoSnapshot,
  monitorSessionId,
});
```

And in `App`, when no `initialSnapshot` is passed:

```ts
  const fallbackMonitorSessionId = readMonitorSessionIdFromLocation();
  const seededSnapshot = initialSnapshot ?? (fallbackMonitorSessionId ? cloneDemoSnapshotForMonitor(fallbackMonitorSessionId) : demoSnapshot);
```

Use `seededSnapshot` everywhere the component currently uses the default demo snapshot.

- [ ] **Step 4: Run monitor-board tests and build**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" test src/test/board.test.tsx
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" build
```

Expected: PASS.

- [ ] **Step 5: Run full verification and commit**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" build
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" test
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/monitor-board" build
```

Expected:

- `apps/bata-workflow` tests PASS
- `apps/bata-workflow` build PASS
- `apps/monitor-board` tests PASS
- `apps/monitor-board` build PASS

Then commit:

```bash
git add \
  apps/monitor-board/src/App.tsx \
  apps/monitor-board/src/test/board.test.tsx
git commit -m "feat: surface monitor board URL from /monitor"
```

---

## Self-Review

- Spec coverage:
  - `/monitor` 自动启动或复用 board：Task 2
  - 返回 URL 不自动开浏览器：Task 2 + Task 3
  - install parity：Task 3
  - 页面读取 `monitorSessionId`：Task 4
  - board 启动失败不破坏主流程：Task 1 + Task 2
- Placeholder scan:
  - 无 `TODO/TBD` 占位
  - 每个测试步骤都给了实际代码和命令
- Type consistency:
  - `board.status` 统一为 `started | reused | failed`
  - `board.url` 一律 `string | null`
  - `monitorSessionId` 在 runtime、skill 文档、board URL、页面 querystring 中保持同名

---

Plan complete and saved to `docs/superpowers/plans/2026-04-20-monitor-board-launcher.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
