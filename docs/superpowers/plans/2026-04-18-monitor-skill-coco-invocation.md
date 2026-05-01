# Monitor Skill Coco Invocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `skills/monitor` 从“可被本地 devkit 安装的源码 seed”升级为“可在 Coco 中手动 `/monitor` 调用、并稳定执行 create/attach monitor session 的真实 skill”，且在 `link` 与 `publish-local` 两种安装形态下行为一致。

**Architecture:** 保持 `skills/monitor` 作为唯一真源，但把 Coco 可见入口收敛为 `SKILL.md`，并在 skill 目录内增加一套无需仓库构建、可直接被 `node` 执行的便携 runtime（`.mjs`）。第一阶段只解决 `/monitor` 的 session create/attach 与最小状态持久化；`apps/monitor-board` 继续作为独立 viewer，不在本计划内自动拉起。

**Tech Stack:** Coco skill `SKILL.md` frontmatter、Node.js ESM (`.mjs`)、TypeScript/Vitest（通过 `apps/bata-workflow` 测试 skill runtime）、Rush/pnpm workspace、现有 `skill-devkit` link/publish-local 生命周期。

---

## File Structure

### New skill entry/runtime files

- Create: `skills/monitor/SKILL.md` — Coco 可见入口，声明 `/monitor` 的稳定 create-or-attach 语义，并调用安装目录内的 runtime 脚本
- Create: `skills/monitor/runtime/context.mjs` — 解析 `--cwd`、环境变量、旧安装路径提示与 runtime state 路径
- Create: `skills/monitor/runtime/monitor-session.mjs` — 纯 JS session 规则层，负责 `create|attach` 决策与返回协议
- Create: `skills/monitor/runtime/session-store.mjs` — monitor runtime state 的原子化读写与最小持久化
- Create: `skills/monitor/runtime/invoke-monitor.mjs` — 供 `SKILL.md` 与测试调用的可执行入口，输出结构化 JSON

### Existing skill files to modify

- Modify: `skills/monitor/skill-manifest.json` — 把 `entry` 改为 `SKILL.md`，把 `cocoInstallName` 固定为 `monitor`，并把 `runtime/**` 纳入 `files`
- Modify: `skills/monitor/src/skill/monitor-command.ts` — 保持纯规则层，同时把返回字段补齐为 runtime 需要的稳定协议（至少补 `rootSessionId`/`requesterActorId` 语义）
- Modify: `skills/monitor/src/skill/index.ts` — 继续只导出纯逻辑层，不让 `SKILL.md` 直接依赖 TS barrel

### Tests to create/modify

- Create: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts` — 直接导入/调用 `skills/monitor/runtime/*.mjs`，覆盖 create/attach、状态持久化、旧安装提示
- Modify: `apps/bata-workflow/tests/skill-command.test.ts` — 把安装名断言从 `%40luobata%2Fmonitor` 切到 `monitor`，并增加 link/publish-local 安装后可运行 runtime 的端到端用例

---

### Task 1: Make monitor a Coco-visible skill package

**Files:**
- Create: `skills/monitor/SKILL.md`
- Modify: `skills/monitor/skill-manifest.json`
- Modify: `apps/bata-workflow/tests/skill-command.test.ts`

- [ ] **Step 1: Write the failing install-shape test**

Update `apps/bata-workflow/tests/skill-command.test.ts` so the lifecycle test stops expecting the scoped install name and instead expects the final public install name `monitor` plus Coco-visible entry assets:

```ts
const installPath = resolve(tempHome, '.coco', 'skills', 'monitor')
const statePath = resolve(skillStateRoot, 'monitor.json')
const packOutputDirectory = resolve(skillPacksRoot, 'monitor', '0.1.0')

expect(validateResult.stdout).toContain('Validated skill: monitor@0.1.0')
expect(existsSync(resolve(installPath, 'SKILL.md'))).toBe(true)
expect(existsSync(resolve(installPath, 'runtime', 'invoke-monitor.mjs'))).toBe(true)
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: FAIL because `skill-manifest.json` still uses `@luobata/monitor`, `src/index.ts`, and the installed skill does not contain `SKILL.md` / `runtime/invoke-monitor.mjs`.

- [ ] **Step 3: Convert the monitor seed into a Coco-visible package**

Replace `skills/monitor/skill-manifest.json` with:

```json
{
  "name": "monitor",
  "displayName": "Monitor",
  "entry": "SKILL.md",
  "cocoInstallName": "monitor",
  "version": "0.1.0",
  "files": [
    "skill-manifest.json",
    "SKILL.md",
    "runtime/**/*.mjs",
    "src/**/*.ts"
  ],
  "dev": {
    "link": true,
    "publishLocal": true
  },
  "metadata": {
    "description": "Create or attach a monitor session from Coco using a portable local runtime",
    "tags": ["monitor", "coco", "local-dev", "session"]
  }
}
```

Create `skills/monitor/SKILL.md` with stable frontmatter and runtime instructions:

```md
---
name: monitor
description: Create or attach a monitor session for the current Coco work session. Use this when the user explicitly invokes /monitor.
tags:
  - monitor
  - session
  - debug
---

# Monitor

## Overview

Use this skill only when the user explicitly invokes `/monitor`.

The goal of this first-phase skill is to create or attach a monitor session for the current work session. It does not auto-open monitor-board and it does not create nested monitor sessions.

## Commands

Run the installed runtime directly from the local Coco skills directory:

```bash
node "$HOME/.coco/skills/monitor/runtime/invoke-monitor.mjs" --cwd "$PWD" --output json
```

## Operating Rules

1. Run the command above exactly once when `/monitor` is invoked.
2. Parse the JSON output.
3. Report `kind`, `monitorSessionId`, and `message` back to the user.
4. If `kind` is `attach`, explain that an existing monitor session was reused.
5. Do not auto-open viewer UI in this phase.
```

Update the lifecycle assertions in `apps/bata-workflow/tests/skill-command.test.ts` to match the new install name and packaged files.

- [ ] **Step 4: Re-run the focused test and confirm it passes**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: PASS with the lifecycle test now showing `Install Path: .../.coco/skills/monitor` and both `SKILL.md` and `runtime/invoke-monitor.mjs` present after install.

- [ ] **Step 5: Commit the packaging/entry changes**

```bash
git add \
  skills/monitor/skill-manifest.json \
  skills/monitor/SKILL.md \
  apps/bata-workflow/tests/skill-command.test.ts
git commit -m "feat: expose monitor as a coco-visible skill"
```

---

### Task 2: Add a portable monitor runtime with stable create/attach semantics

**Files:**
- Create: `skills/monitor/runtime/context.mjs`
- Create: `skills/monitor/runtime/monitor-session.mjs`
- Create: `skills/monitor/runtime/session-store.mjs`
- Create: `skills/monitor/runtime/invoke-monitor.mjs`
- Create: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`
- Modify: `skills/monitor/src/skill/monitor-command.ts`

- [ ] **Step 1: Write the failing runtime tests**

Create `apps/bata-workflow/tests/monitor-skill-runtime.test.ts` with these two core tests:

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { invokeMonitor } from '../../../skills/monitor/runtime/invoke-monitor.mjs'

describe('monitor skill runtime', () => {
  it('creates a monitor session on first invocation and persists state', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'monitor-skill-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'monitor-skill-cwd-'))

    const result = await invokeMonitor({ cwd, homeDir, requesterActorId: 'lead-1', isRootActor: true })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: expect.stringMatching(/^monitor:/),
      requesterActorId: 'lead-1',
      isRootActor: true,
    })

    const state = JSON.parse(readFileSync(resolve(cwd, '.bata-workflow', 'state', 'monitor-sessions', 'default.json'), 'utf8'))
    expect(state.monitorSessionId).toBe(result.monitorSessionId)
  })

  it('attaches to the existing monitor session on repeat invocation', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'monitor-skill-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'monitor-skill-cwd-'))

    const first = await invokeMonitor({ cwd, homeDir, requesterActorId: 'lead-1', isRootActor: true })
    const second = await invokeMonitor({ cwd, homeDir, requesterActorId: 'lead-1', isRootActor: true })

    expect(first.kind).toBe('create')
    expect(second).toMatchObject({
      kind: 'attach',
      monitorSessionId: first.monitorSessionId,
      requesterActorId: 'lead-1',
      isRootActor: true,
    })
  })
})
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
```

Expected: FAIL because `skills/monitor/runtime/invoke-monitor.mjs` does not exist and the runtime API is undefined.

- [ ] **Step 3: Implement the runtime context, session rules, state store, and entrypoint**

Create `skills/monitor/runtime/monitor-session.mjs`:

```js
export function deriveMonitorSessionId(rootSessionId) {
  return `monitor:${rootSessionId}`
}

export function resolveMonitorInvocation(input) {
  const monitorSessionId = input.existingMonitorSessionId ?? deriveMonitorSessionId(input.rootSessionId)

  if (input.existingMonitorSessionId) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId: input.rootSessionId,
      requesterActorId: input.requesterActorId,
      isRootActor: input.isRootActor,
      message: `Attached actor ${input.requesterActorId} to existing monitor ${monitorSessionId}`,
    }
  }

  if (!input.isRootActor) {
    return {
      kind: 'attach',
      monitorSessionId,
      rootSessionId: input.rootSessionId,
      requesterActorId: input.requesterActorId,
      isRootActor: false,
      message: `Child actor ${input.requesterActorId} cannot create a nested monitor; attach to ${monitorSessionId}`,
    }
  }

  return {
    kind: 'create',
    monitorSessionId,
    rootSessionId: input.rootSessionId,
    requesterActorId: input.requesterActorId,
    isRootActor: true,
    message: `Created monitor ${monitorSessionId} for root actor ${input.requesterActorId}`,
  }
}
```

Create `skills/monitor/runtime/context.mjs`:

```js
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

function hashWorkspace(cwd) {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

export function resolveMonitorContext(options) {
  const cwd = resolve(options.cwd)
  const homeDir = resolve(options.homeDir)
  const stateRoot = resolve(cwd, '.bata-workflow', 'state', 'monitor-sessions')
  mkdirSync(stateRoot, { recursive: true })

  const rootSessionId = options.rootSessionId ?? process.env.COCO_SESSION_ID ?? `workspace:${hashWorkspace(cwd)}`
  const requesterActorId = options.requesterActorId ?? process.env.COCO_ACTOR_ID ?? 'lead'
  const isRootActor = options.isRootActor ?? requesterActorId === 'lead'
  const legacyInstallPath = resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor')

  return {
    cwd,
    homeDir,
    rootSessionId,
    requesterActorId,
    isRootActor,
    statePath: resolve(stateRoot, 'default.json'),
    legacyInstallDetected: existsSync(legacyInstallPath),
  }
}
```

Create `skills/monitor/runtime/session-store.mjs`:

```js
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readMonitorSessionState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return null
  }
}

export function writeMonitorSessionState(statePath, value) {
  mkdirSync(dirname(statePath), { recursive: true })
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, JSON.stringify(value, null, 2))
  renameSync(tmpPath, statePath)
}
```

Create `skills/monitor/runtime/invoke-monitor.mjs`:

```js
import { resolveMonitorContext } from './context.mjs'
import { resolveMonitorInvocation } from './monitor-session.mjs'
import { readMonitorSessionState, writeMonitorSessionState } from './session-store.mjs'

export async function invokeMonitor(options = {}) {
  const context = resolveMonitorContext(options)
  const existing = readMonitorSessionState(context.statePath)
  const result = resolveMonitorInvocation({
    rootSessionId: context.rootSessionId,
    requesterActorId: context.requesterActorId,
    isRootActor: context.isRootActor,
    existingMonitorSessionId: existing?.monitorSessionId ?? null,
  })

  writeMonitorSessionState(context.statePath, {
    rootSessionId: result.rootSessionId,
    monitorSessionId: result.monitorSessionId,
    ownerActorId: existing?.ownerActorId ?? result.requesterActorId,
    lastAttachedActorId: result.requesterActorId,
    status: result.kind === 'create' ? 'created' : 'attached',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  return context.legacyInstallDetected
    ? { ...result, message: `${result.message} (legacy install @luobata/monitor detected; relink to monitor when convenient)` }
    : result
}
```

At the bottom of `invoke-monitor.mjs`, add direct CLI execution support:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const cwd = process.argv.includes('--cwd') ? process.argv[process.argv.indexOf('--cwd') + 1] : process.cwd()
  const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : 'json'
  const result = await invokeMonitor({ cwd, homeDir: process.env.HOME ?? process.env.USERPROFILE ?? '.' })
  process.stdout.write(output === 'json' ? `${JSON.stringify(result)}\n` : `${result.message}\n`)
}
```

Finally, update `skills/monitor/src/skill/monitor-command.ts` to expose the same fields in the pure TypeScript helper:

```ts
export interface OpenMonitorSessionResult {
  kind: 'create' | 'attach'
  monitorSessionId: string
  rootSessionId: string
  requesterActorId: string
  isRootActor: boolean
  message: string
}
```

- [ ] **Step 4: Run the runtime test again and confirm it passes**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
```

Expected: PASS with one test asserting `kind=create` and the second asserting `kind=attach` against the same persisted `monitorSessionId`.

- [ ] **Step 5: Commit the runtime implementation**

```bash
git add \
  skills/monitor/runtime/context.mjs \
  skills/monitor/runtime/monitor-session.mjs \
  skills/monitor/runtime/session-store.mjs \
  skills/monitor/runtime/invoke-monitor.mjs \
  skills/monitor/src/skill/monitor-command.ts \
  apps/bata-workflow/tests/monitor-skill-runtime.test.ts
git commit -m "feat: add portable monitor skill runtime"
```

---

### Task 3: Verify `/monitor` behavior is identical in linked and published-local installs

**Files:**
- Modify: `apps/bata-workflow/tests/skill-command.test.ts`
- Modify: `skills/monitor/SKILL.md`

- [ ] **Step 1: Add the failing end-to-end invocation test**

Extend `apps/bata-workflow/tests/skill-command.test.ts` with a new case that installs `monitor`, then executes the installed runtime exactly the way `SKILL.md` documents it:

```ts
const firstLinkedInvoke = spawnSync('node', [resolve(installPath, 'runtime', 'invoke-monitor.mjs'), '--cwd', repoRoot, '--output', 'json'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
  },
})

const secondLinkedInvoke = spawnSync('node', [resolve(installPath, 'runtime', 'invoke-monitor.mjs'), '--cwd', repoRoot, '--output', 'json'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
  },
})

expect(JSON.parse(firstLinkedInvoke.stdout)).toMatchObject({ kind: 'create' })
expect(JSON.parse(secondLinkedInvoke.stdout)).toMatchObject({ kind: 'attach' })
```

Repeat the same check after `publish-local` using the copied install directory, and assert the second install still reports `attach` against the same `monitorSessionId`.

- [ ] **Step 2: Run the end-to-end skill test and verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: FAIL because the installed skill currently lacks a runnable runtime entrypoint or because the linked/published installs do not yet behave identically.

- [ ] **Step 3: Make `SKILL.md` and the install packaging match the runtime contract**

Tighten the `SKILL.md` command section so it exactly matches the tested invocation path and explicitly states the session semantics:

```md
## Commands

```bash
node "$HOME/.coco/skills/monitor/runtime/invoke-monitor.mjs" --cwd "$PWD" --output json
```

## Expected Behavior

- First `/monitor` call in the current workspace/session => `kind=create`
- Repeated `/monitor` calls => `kind=attach`
- Child callers never create nested monitors
```

If the end-to-end test reveals missing packaged files, update `skill-manifest.json` `files` until both `link` and `publish-local` contain the exact same runtime assets.

- [ ] **Step 4: Run the focused end-to-end test, then full bata-workflow verification**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" build
```

Expected:

- `tests/skill-command.test.ts` PASS, including the create→attach checks for both linked and published-local installs
- Full `apps/bata-workflow` test suite PASS
- `build` exits 0

- [ ] **Step 5: Commit the invocation parity verification**

```bash
git add \
  skills/monitor/SKILL.md \
  apps/bata-workflow/tests/skill-command.test.ts
git commit -m "test: verify monitor skill invocation across install modes"
```

---

### Task 4: Add legacy install warning and final compatibility guardrails

**Files:**
- Modify: `skills/monitor/runtime/context.mjs`
- Modify: `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`

- [ ] **Step 1: Add the failing legacy-install warning test**

Extend `apps/bata-workflow/tests/monitor-skill-runtime.test.ts` with:

```ts
it('adds a migration hint when the legacy scoped install path exists', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'monitor-skill-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'monitor-skill-cwd-'))
  mkdirSync(resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor'), { recursive: true })

  const result = await invokeMonitor({ cwd, homeDir, requesterActorId: 'lead-1', isRootActor: true })

  expect(result.message).toContain('legacy install @luobata/monitor detected')
})
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
```

Expected: FAIL because `context.mjs` does not yet detect the old `%40luobata%2Fmonitor` install directory or append the migration hint.

- [ ] **Step 3: Implement the migration warning in the context/runtime result**

Update `skills/monitor/runtime/context.mjs` so it checks:

```js
const legacyInstallPath = resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor')
legacyInstallDetected: existsSync(legacyInstallPath)
```

Update `invoke-monitor.mjs` to append the warning:

```js
return context.legacyInstallDetected
  ? {
      ...result,
      message: `${result.message} (legacy install @luobata/monitor detected; relink to monitor when convenient)`,
    }
  : result
```

- [ ] **Step 4: Run final focused verification**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/monitor-skill-runtime.test.ts
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/skill-command.test.ts
```

Expected: PASS, with the legacy-warning test confirming that old scoped installs are detected without breaking normal create/attach behavior.

- [ ] **Step 5: Commit the compatibility guardrail**

```bash
git add \
  skills/monitor/runtime/context.mjs \
  skills/monitor/runtime/invoke-monitor.mjs \
  apps/bata-workflow/tests/monitor-skill-runtime.test.ts
git commit -m "feat: warn on legacy monitor skill installs"
```

---

## Self-Review Checklist

- Spec coverage:
  - `/monitor` 手动 create/attach 语义：Task 2 + Task 3
  - `link` / `publish-local` 持续可调试与可发布：Task 1 + Task 3
  - 稳定入口 `SKILL.md`：Task 1
  - 独立 viewer、第一阶段不自动拉起 UI：Task 1 `SKILL.md` + Task 3 behavior assertions
  - 旧 `@luobata/monitor` 安装兼容提示：Task 4
- Placeholder scan: 本计划中没有 `TBD` / `TODO` / “后面补细节” 之类占位语句。
- Type consistency: `kind`, `monitorSessionId`, `rootSessionId`, `requesterActorId`, `isRootActor`, `message` 在 Task 2–4 中保持同一命名。

---

Plan complete and saved to `docs/superpowers/plans/2026-04-18-monitor-skill-coco-invocation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
