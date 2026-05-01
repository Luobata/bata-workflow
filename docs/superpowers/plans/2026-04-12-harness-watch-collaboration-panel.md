# Bata-Workflow Watch Collaboration Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 `watch` 的 `Task Details` 面板补充协作链路信息，优先展示 mailbox、上游任务摘要与 handoff 线索，同时保留后续切到方案 B（详情 Tab 切换）的扩展空间。

**Architecture:** 继续沿用现有只读 watch 架构，不新增运行状态源。由 `watch-state` 在当前 `selectedTask` 之上聚合一层 `collaboration` 数据块，`render` 先以内联区块追加到 `Task Details`，但数据结构拆成独立子对象，方便未来在右栏切成 `Overview / Collaboration` 两种详情视图。

**Tech Stack:** TypeScript、现有 `RunReport`/`MailboxMessage`/`TaskExecutionResult` 类型、Node 终端字符串渲染、Vitest。

---

## File Structure

- Modify: `src/tui/watch-state.ts`
  - 扩展 `WatchSelectedTaskViewModel`，新增可复用的 `collaboration` 子结构
- Modify: `src/tui/render.ts`
  - 在 `Task Details` 里追加 `Collaboration` 区块，并保留未来 tab 化的渲染边界
- Modify: `src/tui/watch.ts`
  - 仅在必要时新增未来可扩展的详情视图状态占位；本轮不实现 tab 切换
- Test: `tests/watch-state.test.ts`
  - 覆盖 mailbox/upstream/handoff 聚合逻辑
- Test: `tests/watch-command.test.ts`
  - 覆盖 watch 对未来详情视图状态的兼容性（若本轮引入轻量占位）

### Task 1: 在 `watch-state` 聚合协作链路视图模型

**Files:**
- Modify: `src/tui/watch-state.ts`
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写失败测试，覆盖 mailbox、upstream、handoff 聚合**

```ts
it('为 selectedTask 聚合协作链路信息', () => {
  const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })
  expect(viewModel.selectedTask?.collaboration).toMatchObject({
    upstream: [
      { taskId: 'T1', status: 'completed', summary: 'analysis done' }
    ],
    mailbox: [
      { direction: 'inbound', taskId: 'T2', workerId: 'W2' }
    ],
    handoffSummary: 'Received upstream summary from T1'
  })
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，提示 `collaboration` 字段尚未实现

- [x] **Step 3: 扩展 `WatchSelectedTaskViewModel`**

```ts
export type WatchTaskCollaborationViewModel = {
  mailbox: Array<{
    messageId: string
    workerId: string
    taskId: string
    direction: 'inbound' | 'outbound'
    content: string
    createdAt: string
  }>
  upstream: Array<{
    taskId: string
    role: string
    taskType: Task['taskType']
    status: RuntimeTaskState['status']
    summary: string | null
  }>
  handoffSummary: string | null
  collaborationStatus: {
    hasInboundMailbox: boolean
    hasOutboundMailbox: boolean
    hasUpstreamSummaries: boolean
  }
}
```

- [x] **Step 4: 实现聚合逻辑，要求结构可支持未来详情 Tab**

```ts
selectedTask: {
  ...existingFields,
  collaboration: {
    mailbox,
    upstream,
    handoffSummary,
    collaborationStatus
  }
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `npm test -- watch-state`
Expected: PASS，且覆盖：
- 最近 3 条与 selectedTask 相关的 mailbox 消息
- 上游依赖任务的状态与 summary
- handoffSummary 的提取/回退逻辑

### Task 2: 在 `Task Details` 中追加 `Collaboration` 区块

**Files:**
- Modify: `src/tui/render.ts`
- Test: `tests/watch-state.test.ts`

- [x] **Step 1: 写失败测试，要求渲染 Collaboration 区块**

```ts
it('在任务详情中渲染协作链路区块', () => {
  const rendered = renderWatchScreen(viewModel)
  expect(rendered).toContain('Collaboration')
  expect(rendered).toContain('Mailbox:')
  expect(rendered).toContain('Upstream:')
  expect(rendered).toContain('Handoff:')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-state`
Expected: FAIL，当前详情面板尚未渲染协作链路

- [x] **Step 3: 以内联区块方式追加渲染，但保留未来 tab 化边界**

```ts
function renderTaskOverview(task: WatchSelectedTaskViewModel): string[] { ... }
function renderTaskCollaboration(task: WatchSelectedTaskViewModel): string[] { ... }

function renderTaskDetails(view: WatchViewModel): string[] {
  return [
    ...renderTaskOverview(task),
    '',
    ...renderTaskCollaboration(task)
  ]
}
```

- [x] **Step 4: 做基础截断与空值占位**

Run: `npm test -- watch-state`
Expected: PASS，且无 mailbox / upstream 时显示占位文本，例如 `No mailbox activity`

### Task 3: 为未来方案 B 预留详情视图状态边界

**Files:**
- Modify: `src/tui/watch.ts`
- Test: `tests/watch-command.test.ts`

- [x] **Step 1: 写失败测试，要求详情视图状态可扩展但默认仍是 overview+collaboration 合并显示**

```ts
it('watch ui state 保留详情视图模式扩展位', () => {
  expect(createInitialWatchUiState().detailMode).toBe('combined')
})
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- watch-command`
Expected: FAIL，当前无 `detailMode` 概念

- [x] **Step 3: 仅增加轻量状态占位，不实现 tab 切换**

```ts
export type WatchDetailMode = 'combined' | 'overview' | 'collaboration'

export type WatchUiState = {
  paused: boolean
  selectedTaskId?: string
  hotTaskIds: string[]
  detailMode: 'combined'
}
```

- [x] **Step 4: 确认现有交互不回归**

Run: `npm test -- watch-command`
Expected: PASS，`q/r/p/↑/↓/j/k` 均不受影响

### Task 4: 回归测试与端到端验证

**Files:**
- Modify: `tests/watch-state.test.ts`
- Modify: `tests/watch-command.test.ts`

- [x] **Step 1: 补协作场景测试数据**

```ts
runtime.mailbox = [
  {
    messageId: 'M1',
    workerId: 'W1',
    taskId: 'T2',
    direction: 'inbound',
    content: 'Received analysis summary from T1',
    createdAt: '2026-04-12T10:05:00.000Z'
  }
]
```

- [x] **Step 2: 运行局部测试**

Run: `npm test -- watch-command watch-state`
Expected: PASS

- [x] **Step 3: 运行相关回归测试与构建**

Run: `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [x] **Step 4: 做真实链路冒烟**

Run:
- `pnpm dev /bata-workflow-debug --adapter=dry-run -dir <docs>`
- `pnpm dev watch --reportPath <report.json>`

Expected:
- `Task Details` 中出现 `Collaboration`
- 可看到 `Mailbox / Upstream / Handoff` 区块
- 现有 `↑/↓/j/k/q/r/p` 行为不回归

## Self-Review Checklist

- [x] 协作链路数据全部来自现有 `RunReport.runtime.mailbox`、`results`、`plan.tasks`、`taskStates`
- [x] `WatchSelectedTaskViewModel` 新增的是独立 `collaboration` 子结构，而不是把字段平铺到顶层
- [x] 当前渲染是方案 A（内联追加区块），但结构支持未来方案 B 切 Tab
- [x] 没有引入新的运行控制行为
- [x] 没有破坏现有 `Task Details` 基础排障字段
- [x] 测试覆盖 mailbox、upstream、handoff、空值兜底与交互不回归

## Verification Commands

- `npm test -- watch-command watch-state`
- `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
- `npm run build`
- `pnpm dev watch --reportPath <report.json>`

