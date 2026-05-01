# Bata-Workflow 下一阶段细粒度任务清单

> 目标：让新会话拿到这份清单后，可以直接进入 `watch` 的下一阶段演进：`detailMode` 切换、产物/验证证据可视化、结构化执行结果展示，而不用重新梳理前面的 watch/TUI 演进。

## A. 启动阶段

### A1. 读取现状

- 先读 `docs/NEXT_SESSION_ENTRY.md`
- 再读 `docs/NEXT_TASK_CHECKLIST.md`
- 再读 `docs/HANDOFF_STATUS_2026-04-12.md`
- 再按顺序读：
  - `src/tui/watch-state.ts`
  - `src/tui/render.ts`
  - `src/tui/watch.ts`
  - `src/cli/index.ts`
  - `src/runtime/state-store.ts`
  - `src/planner/planner.ts`

### A2. 确认工作区状态

- 查看 `git status`
- 确认当前是否已经带有上一轮未提交实现
- 不要重复实现已经存在的：
  - `/bata-workflow-debug` 文档驱动入口
  - `watch` 终端 TUI 的总览 / workers / hotTasks / recentEvents
  - `selectedTask` 排障详情
  - `↑/↓/j/k/q/r/p` 交互
  - `Task Details` 中的 `Overview + Collaboration` 合并视图
  - `detailMode = combined|overview|collaboration` 扩展位

---

## B. 当前已完成基线（新会话不要重做）

### B1. 持久化执行面

- 已有 `src/runtime/task-queue.ts`
- 已有 `src/runtime/task-store.ts`
- 已实现：
  - `createTaskQueue(runDirectory, ...)`
  - `loadTaskQueue(runDirectory, ...)`
  - `claimNextTask(workerId)`
  - `transitionTask(taskId, status, patch)`
  - `releaseTask(taskId)`
  - `appendTaskEvent(taskId, event)`
  - `appendGeneratedTask(...)`
  - `addDependency(taskId, dependencyId)`

### B2. worker pool / resume

- 已接入 `maxConcurrency`
- worker 数已与 task 数解耦
- `resume` 已基于 queue 恢复，而不是重新从 `report` 重建执行图

### B3. failure / loop

- 已支持：
  - `retryDelayMs`
  - `fallbackRole`
  - `fallbackModel`
  - `retryOn`
  - `terminalOn`
  - `fixVerifyLoop`
- `testing` 失败时已能生成显式 remediation task（如 `T4_FIX_1`）
- `report.runtime` 已有：
  - `dynamicTaskStats`
  - `loopSummaries`

---

## C. 下一阶段主目标：把 watch 的详情面板做成可切换视图

### C1. detailMode 切换（方案 B）

当前现状：

- `watch.ts` 已有 `detailMode = 'combined' | 'overview' | 'collaboration'` 状态占位
- `render.ts` 已把详情结构拆成 `Overview` 与 `Collaboration` 两个内部区块
- 当前还未实现 detailMode 真实切换，仍固定展示 combined

下一步目标：

- 支持详情面板在以下模式间切换：
  - `combined`
  - `overview`
  - `collaboration`
- 增加最小切换快捷键，不破坏现有任务选择交互

建议修改：

- `src/tui/watch.ts`
- `src/tui/render.ts`
- `tests/watch-command.test.ts`
- `tests/watch-state.test.ts`

### C2. 详情面板继续补执行证据

当前已做：

- 基础排障字段
- mailbox / upstream / handoff / collab status

下一步建议：

- 在详情面板继续补：
  - `artifacts`
  - `verification`
  - `blockers`
- 让 tester/reviewer 结果不只依赖 summary
- 为后续 dashboard/Web 视图保留统一结构

---

## D. 下一阶段主目标：把结构化执行结果做成 watch 可消费数据

### D1. 扩展任务执行结果 schema

当前现状：

- `watch` 主要展示 summary 与协作线索
- 执行结果还没有稳定的 `artifacts / verification / blockers` 展示面

建议新增：

- `TaskExecutionResult.artifacts`
- `TaskExecutionResult.verification`
- `TaskExecutionResult.blockers`

建议修改：

- `src/domain/types.ts`
- `src/runtime/coco-adapter.ts`
- `src/verification/index.ts`
- `src/tui/watch-state.ts`

### D2. watch 中接入执行证据区块

目标：

- `watch` 详情面板可直接消费结构化执行结果
- 运行中与恢复后查看到的数据结构一致
- 后续 Web dashboard 可复用同一套聚合模型

---

## E. watch 的中长期方向

### E1. mailbox drill-down / 详情页

建议新增：

- mailbox 明细视图
- 选中消息后显示完整内容
- future: detail tab 或弹出式详情页

### E2. Web dashboard

目标：

- 重用 `watch-state` 聚合模型
- 提供更高可读性的任务泳道 / 事件流 / 协作面板

---

## F. 测试细化 TODO

### F1. 必补测试

- detailMode 切换测试
- artifact/verification/blockers 聚合测试
- mailbox 明细与长文本截断测试
- watch 恢复后详情视图一致性测试

### F2. 命令级验证

- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test -- watch-command watch-state`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" build`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev /bata-workflow-debug --adapter=dry-run -dir <docs>`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev watch --reportPath <report.json>`

---

## G. 建议分阶段提交点

### Commit 1

- detailMode 切换
- 补 watch 交互与渲染测试

### Commit 2

- 结构化执行结果 `artifacts / verification / blockers`
- watch 详情面板接入执行证据

### Commit 3

- mailbox drill-down / detail tabs
- 或 Web dashboard 起步

---

## H. 当前优先顺序（最推荐）

1. loop 独立 role/model 解析
2. `report.summary` 顶层聚合
3. resume 后 summary 对齐
4. `skills.yaml` 外部化
5. `team-compositions.yaml` 外部化

---

## I. 完成判定

下一阶段完成后，至少要满足：

- remediation task 不再依赖 fallback 路由语义才能解析角色/模型
- `run` 与 `resume` 都输出稳定一致的顶层 summary
- loop 统计可直接被 CLI / dashboard 消费
- 新增测试全部通过
