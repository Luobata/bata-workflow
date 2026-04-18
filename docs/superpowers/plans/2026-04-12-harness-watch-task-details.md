# Harness Watch Task Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 `watch` 终端 TUI 增加可选择的任务详情面板，支持在监控运行时快速排障。

**Architecture:** 保持现有只读 watch 架构不变，继续复用 `RunReport` 落盘状态。新增一层“选中任务”视图状态，渲染时把 `Workers / Hot Tasks / Task Details / Recent Events` 组合成三栏加底部事件布局。交互只增加任务选择，不引入运行控制。

**Tech Stack:** TypeScript、Node.js `readline`、现有 `watch-state`/`render`/`watch` 模块、Vitest。

---

## File Structure

- Modify: `src/tui/watch-state.ts`
  - 扩展视图模型，增加 `selectedTask` 详情聚合与选择保持辅助函数
- Modify: `src/tui/render.ts`
  - 把双栏渲染升级为三栏主视图，渲染选中态与详情面板
- Modify: `src/tui/watch.ts`
  - 增加 `selectedTaskId` 本地 UI 状态，支持 `↑/↓/j/k` 选择任务
- Test: `tests/watch-state.test.ts`
  - 验证详情聚合、选中保持、无选中兜底
- Test: `tests/watch-command.test.ts`
  - 验证新增按键解析与选择状态演化

### Task 1: 扩展详情视图模型

**Files:**
- Modify: `src/tui/watch-state.ts`
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写失败测试，覆盖详情字段聚合**

```ts
it('为选中的 hot task 聚合排障优先详情', () => {
  const viewModel = loadWatchViewModel({ stateRoot, reportPath, selectedTaskId: 'T1' })
  expect(viewModel.selectedTask).toMatchObject({
    taskId: 'T1',
    status: 'failed',
    attempts: 2,
    maxAttempts: 3,
    lastError: 'network timeout',
    summary: 'failed after retry',
    dependsOn: []
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，提示 `selectedTask` 尚未实现

- [x] **Step 3: 实现 `selectedTask` 视图模型与选择保持逻辑**

```ts
export type WatchSelectedTaskViewModel = {
  taskId: string
  title: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  attempts: number
  maxAttempts: number
  lastError: string | null
  summary: string | null
  dependsOn: string[]
  generatedFromTaskId: string | null
}
```

- [x] **Step 4: 测试通过后补无选中兜底用例**

Run: `npm test -- watch-state`
Expected: PASS，并覆盖：
- `selectedTaskId` 命中时返回对应详情
- 未命中时回退到第一条 hot task
- 没有 hot task 时返回 `null`

### Task 2: 升级渲染器为三栏视图

**Files:**
- Modify: `src/tui/render.ts`
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写失败测试，要求渲染出 `Task Details` 面板和选中标记**

```ts
it('渲染任务详情面板与选中态', () => {
  const output = renderWatchScreen(viewModel)
  expect(output).toContain('Task Details')
  expect(output).toContain('> T1')
  expect(output).toContain('Last Error: network timeout')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，当前渲染还没有详情面板

- [x] **Step 3: 实现三栏渲染**

```ts
Workers | Hot Tasks | Task Details
...
Recent Events
```

- [x] **Step 4: 测试通过并检查长文本截断**

Run: `npm test -- watch-state`
Expected: PASS，且详情字段过长时不会破坏基本布局

### Task 3: 增加任务选择交互

**Files:**
- Modify: `src/tui/watch.ts`
- Test: `tests/watch-command.test.ts`

- [x] **Step 1: 写失败测试，覆盖 `↑/↓/j/k` 键位解析**

```ts
it('支持上下移动 hot task 选择', () => {
  expect(resolveWatchKeyAction('', { name: 'up' })).toBe('select-prev')
  expect(resolveWatchKeyAction('', { name: 'down' })).toBe('select-next')
  expect(resolveWatchKeyAction('k')).toBe('select-prev')
  expect(resolveWatchKeyAction('j')).toBe('select-next')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-command`
Expected: FAIL，当前只支持 `q/r/p`

- [x] **Step 3: 实现选择状态维护**

```ts
let selectedTaskId: string | null = null
// refresh 后：若 selectedTaskId 仍在 hotTasks 中则保留，否则回落到第一条
```

- [x] **Step 4: 测试通过并人工确认选择刷新不丢失**

Run: `npm test -- watch-command`
Expected: PASS

### Task 4: 回归验证与异常场景检查

**Files:**
- Modify: `tests/watch-state.test.ts`
- Modify: `tests/watch-command.test.ts`

- [x] **Step 1: 补回归测试**

```ts
it('无 hot tasks 时详情面板显示占位文本', () => {
  expect(rendered).toContain('No active task selected')
})
```

- [x] **Step 2: 运行局部测试**

Run: `npm test -- watch-command watch-state`
Expected: PASS

- [x] **Step 3: 运行相关回归测试与构建**

Run: `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [x] **Step 4: 做一次真实链路冒烟**

Run:
- `pnpm dev /harness-debug --adapter=dry-run -dir <docs>`
- `pnpm dev watch --reportPath <report.json>`

Expected:
- `Hot Tasks` 有选中标记
- `Task Details` 展示 `Attempts / Last Error / Depends On / Summary`
- `q/r/p` 仍正常工作

## Self-Review Checklist

- [x] 没有引入新的运行状态源，详情仍只来自 `RunReport`
- [x] 选择状态只保存在当前 TUI 会话中
- [x] `selectedTaskId` 刷新后保持逻辑清晰且可测试
- [x] 无 hot task 时界面不报错
- [x] 三栏布局在测试输出中可读
- [x] `q/r/p` 不回归，新增 `↑/↓/j/k` 行为可测

## Verification Commands

- `npm test -- watch-command watch-state`
- `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
- `npm run build`
- `pnpm dev watch --reportPath <report.json>`

