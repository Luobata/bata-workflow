# Bata-Workflow Watch TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 `bata-workflow` 增加一个只读实时监控型终端 TUI，通过 `watch` 命令观察 team 模式运行状态。

**Architecture:** 复用现有 `.bata-workflow/state/runs/*` 中的 `report.json` / `task-store.json` 作为数据源，新增一层 TUI 状态聚合与终端渲染模块，不改变现有 `runGoal`、queue 或 runtime 执行语义。CLI 入口新增 `watch` 分支，默认读取最近一次运行，支持显式指定 `runDirectory` 或 `reportPath`。

**Tech Stack:** TypeScript、Node.js 内置 `readline`、现有 `RunReport` / `RuntimeSnapshot` 类型、JSON 状态文件。

---

## File Structure

- Modify: `src/cli/index.ts`
  - 新增 `watch` 命令解析与入口分支
- Modify: `src/domain/types.ts`
  - 如有必要，补充 TUI 视图层需要的轻量类型（仅当现有类型不够时）
- Create: `src/tui/watch-state.ts`
  - 读取运行状态、装配顶部概览 / workers / hot tasks / events 视图模型
- Create: `src/tui/render.ts`
  - 负责终端整屏渲染、布局与颜色语义
- Create: `src/tui/watch.ts`
  - 刷新循环、按键监听、终端清屏与退出恢复
- Test: `tests/watch-state.test.ts`
  - 验证视图模型聚合逻辑
- Test: `tests/watch-command.test.ts`
  - 验证 CLI `watch` 入口、参数选择与错误提示

## Task 1: 搭建 `watch` 命令入口

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/watch-command.test.ts`

- [x] **Step 1: 写 `watch` 命令的失败测试**

```ts
import { describe, expect, it } from 'vitest'

describe('watch command', () => {
  it('支持 watch 命令并读取最近一次运行', () => {
    expect(true).toBe(false)
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-command`
Expected: FAIL，提示 `watch command` 用例失败或命令尚未实现

- [x] **Step 3: 在 CLI 中增加 `watch` 命令分支**

```ts
if (command === 'watch') {
  const { runWatchTui } = await import('../tui/watch.js')
  await runWatchTui({
    stateRoot,
    runDirectory: flags.get('runDirectory'),
    reportPath: flags.get('reportPath')
  })
  return
}
```

- [x] **Step 4: 运行测试确认入口通过**

Run: `npm test -- watch-command`
Expected: PASS，命令能被识别并进入 `watch` 分支

- [x] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/watch-command.test.ts
git commit -m "feat: add watch command entry"
```

## Task 2: 实现运行状态读取与视图模型聚合

**Files:**
- Create: `src/tui/watch-state.ts`
- Modify: `src/runtime/state-store.ts`（仅在需要导出更多读取能力时）
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写聚合逻辑失败测试**

```ts
import { describe, expect, it } from 'vitest'

describe('watch state', () => {
  it('把 RunReport 转成总览、workers、hot tasks 与 recent events', () => {
    expect(true).toBe(false)
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，提示视图模型尚未实现

- [x] **Step 3: 实现 `watch-state.ts` 的核心函数**

```ts
export interface WatchViewModel {
  summary: {
    runId: string
    goal: string
    status: 'RUNNING' | 'FAILED' | 'COMPLETED' | 'RECOVERABLE'
    batchProgress: string
    completed: number
    failed: number
    retry: number
    generated: number
  }
  workers: Array<{ workerId: string; role: string; taskId: string; status: string; model: string }>
  hotTasks: Array<{ taskId: string; taskType: string; role: string; title: string; status: string }>
  recentEvents: Array<{ time: string; type: string; taskId: string; detail: string }>
}
```

- [x] **Step 4: 为以下规则补齐实现并确认测试通过**

Run: `npm test -- watch-state`
Expected: PASS，且覆盖以下行为：
- `failed` / `in_progress` / `ready` / 最近完成任务的排序
- `generatedTaskCount` 能进入 summary
- `workers` 中空 role/task 用 `-` 占位
- `recentEvents` 只保留最近 N 条

- [x] **Step 5: Commit**

```bash
git add src/tui/watch-state.ts tests/watch-state.test.ts src/runtime/state-store.ts
git commit -m "feat: add watch state aggregation"
```

## Task 3: 实现终端渲染器

**Files:**
- Create: `src/tui/render.ts`
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写渲染快照失败测试**

```ts
it('渲染 watch TUI 的总览、workers、tasks 与 events 四个区域', () => {
  const output = renderWatchScreen(viewModel)
  expect(output).toContain('Workers')
  expect(output).toContain('Hot Tasks')
  expect(output).toContain('Recent Events')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，提示 `renderWatchScreen` 未实现或输出不匹配

- [x] **Step 3: 实现字符串渲染器**

```ts
export function renderWatchScreen(view: WatchViewModel): string {
  return [
    renderSummary(view.summary),
    '',
    renderColumns(view.workers, view.hotTasks),
    '',
    renderEvents(view.recentEvents),
    '',
    '[q] quit  [r] refresh  [p] pause'
  ].join('\n')
}
```

- [x] **Step 4: 运行测试确认渲染输出稳定**

Run: `npm test -- watch-state`
Expected: PASS，渲染输出包含四个区块与快捷键提示

- [x] **Step 5: Commit**

```bash
git add src/tui/render.ts tests/watch-state.test.ts
git commit -m "feat: render watch tui screen"
```

## Task 4: 实现 watch 循环与最小交互

**Files:**
- Create: `src/tui/watch.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/watch-command.test.ts`

- [x] **Step 1: 写 watch 主循环失败测试**

```ts
it('watch 模式支持 q 退出、r 刷新、p 暂停刷新', () => {
  expect(true).toBe(false)
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-command`
Expected: FAIL，提示 watch 交互尚未实现

- [x] **Step 3: 实现最小交互循环**

```ts
export async function runWatchTui(params: { stateRoot: string; runDirectory?: string; reportPath?: string }) {
  let paused = false
  const render = () => { /* load -> aggregate -> clear -> draw */ }
  const timer = setInterval(() => {
    if (!paused) render()
  }, 1000)
  // q: clearInterval + restore terminal
  // r: render once
  // p: paused = !paused
}
```

- [x] **Step 4: 验证命令可用与退出恢复正常**

Run: `npm test -- watch-command`
Expected: PASS，且人工执行 `pnpm dev watch` 后能正常退出并恢复终端输入状态

- [x] **Step 5: Commit**

```bash
git add src/tui/watch.ts src/cli/index.ts tests/watch-command.test.ts
git commit -m "feat: add interactive watch tui"
```

## Task 5: 补齐异常路径与端到端验证

**Files:**
- Modify: `src/tui/watch.ts`
- Modify: `tests/watch-command.test.ts`
- Modify: `tests/watch-state.test.ts`

- [x] **Step 1: 增加异常路径测试**

```ts
it('没有 latest run 时输出明确提示', () => {
  expect(message).toContain('未找到可观察的运行')
})

it('reportPath 或 runDirectory 非法时输出明确错误', () => {
  expect(message).toContain('未找到')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-command watch-state`
Expected: FAIL，提示异常路径尚未处理

- [x] **Step 3: 实现异常提示与兜底逻辑**

```ts
if (!latestRun && !params.runDirectory && !params.reportPath) {
  throw new Error('未找到可观察的运行，请先执行 run，或通过 --runDirectory/--reportPath 指定目标')
}
```

- [x] **Step 4: 运行完整验证**

Run: `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
Expected: PASS

Run: `npm run build`
Expected: PASS

人工验证：
- 先执行一次 `pnpm dev /bata-workflow-debug --adapter=dry-run -dir <docs>`
- 再执行 `pnpm dev watch`
- 期望看到总览 / Workers / Hot Tasks / Recent Events，并可通过 `q` 退出

- [x] **Step 5: Commit**

```bash
git add src/tui/watch.ts tests/watch-command.test.ts tests/watch-state.test.ts
git commit -m "test: cover watch tui error states"
```

## Self-Review Checklist

- [x] `watch` 命令没有修改现有 `run/plan/resume` 语义
- [x] 数据只来自现有状态文件，没有引入第二套 runtime 状态源
- [x] 第一版只读，不含控制操作
- [x] `q/r/p` 行为有测试或人工验证
- [x] 输出的 Workers / Hot Tasks / Recent Events 字段都能映射回现有 `RunReport.runtime`
- [x] 没有 latest run 的报错清晰可懂

## Verification Commands

- `npm test -- watch-command watch-state`
- `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
- `npm run build`
- `pnpm dev /bata-workflow-debug --adapter=dry-run -dir <docs>`
- `pnpm dev watch`

