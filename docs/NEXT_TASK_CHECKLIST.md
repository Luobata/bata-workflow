# Harness 下一阶段细粒度任务清单

> 目标：让新会话拿到这份清单后，可以直接进入“持久化 task queue + worker pool + maxConcurrency”阶段，而不用重新梳理现状。

## A. 先做的事情（启动阶段）

### A1. 读取现状

- 先读 `docs/NEXT_SESSION_ENTRY.md`
- 再读 `docs/HANDOFF_STATUS_2026-04-11.md`
- 再按顺序读：
  - `src/domain/types.ts`
  - `src/runtime/team-runtime.ts`
  - `src/runtime/recovery.ts`
  - `src/runtime/state-store.ts`
  - `src/cli/index.ts`

### A2. 确认工作区状态

- 查看 `git status`
- 确认当前是否已包含新的交接文档改动
- 决定是否要在下一轮实现前先单独提交文档

---

## B. 下一阶段主目标：持久化 task queue + worker pool

### B1. 建立持久化 task queue 抽象

目标：不再只依赖 `report.json` 快照恢复，而是把 task 作为可持续更新的状态对象。

建议新增模块：

- `src/runtime/task-queue.ts`
- `src/runtime/task-store.ts`

需要实现的接口：

- `createTaskQueue(runDirectory, assignments)`
- `loadTaskQueue(runDirectory)`
- `listTasks()`
- `claimNextTask(workerId)`
- `transitionTask(taskId, status, patch)`
- `releaseTask(taskId)`
- `appendTaskEvent(taskId, event)`

建议落盘结构：

```text
.harness/state/runs/<run-id>/
  task-store.json
  queue.json
  tasks/
    T1.json
    T2.json
    T3.json
```

### B2. 从“task 对 worker 一一绑定”改成“worker 池”

当前问题：

- `team-runtime.ts` 中 worker 基本按 task 创建
- 这不是真正的 worker pool

下一步需要：

- 引入 `maxConcurrency`
- worker 数与 task 数解耦
- worker 从 queue claim 下一个 ready task
- 同一个 worker 可连续执行多个任务

建议新增类型：

- `WorkerPoolConfig`
- `QueueClaimResult`
- `WorkerLease`

### B3. 加入 maxConcurrency 调度

目标：

- CLI 增加 `--maxConcurrency`
- 默认值建议 `2`
- dry-run 和 coco-cli 两种 adapter 都走统一 worker pool 执行面

需要改的地方：

- `src/cli/index.ts`
- `src/runtime/team-runtime.ts`
- `src/domain/types.ts`

---

## C. 恢复逻辑增强

### C1. resume 改成基于 queue 恢复

当前现状：

- `resume` 依赖 `report.json` 和 `task-store.json`
- 恢复粒度仍偏“快照型”

下一步目标：

- 直接读取 queue 状态
- 找出 `ready` / `in_progress` / `failed but retryable` 任务
- 按 queue 恢复，而不是重新推一次 assignment 集合

### C2. 保留更多历史信息

建议补充：

- `attemptHistory`
- `workerHistory`
- `failureTimestamps`
- `lastClaimedAt`
- `releasedAt`

---

## D. 失败策略增强

### D1. 扩展 failure policy schema

当前只有：

- `maxAttempts`

建议下一步扩展：

- `retryDelayMs`
- `fallbackRole`
- `fallbackModel`
- `retryOn`
- `terminalOn`

建议修改：

- `configs/failure-policies.yaml`
- `src/runtime/failure-policy.ts`

### D2. 明确失败后的路由策略

建议实现：

- coding 失败可切换到 reviewer/coder 二次尝试
- review 失败不重试实现，只输出风险
- testing 失败可进入 verify/fix loop 雏形

---

## E. skill 与角色的进一步配置化

### E1. skill registry 外部化

当前现状：

- `src/team/skill-registry.ts` 仍是 TS 常量

下一步建议：

- 新增 `configs/skills.yaml`
- 新增 `src/team/skill-loader.ts`
- 支持 role -> skills 的完全配置化

### E2. role composition 配置化

建议新增：

- `configs/team-compositions.yaml`

目标：

- 让不同目标可直接选 composition
- 例如：`feature-dev`, `bugfix`, `review-only`, `research-only`

---

## F. 测试细化 TODO

### F1. 必补测试

- task queue claim/release 测试
- worker pool 并发测试
- maxConcurrency 限流测试
- queue-based resume 测试
- failure fallback 测试

### F2. 命令级验证

- `pnpm orchestrate --adapter=dry-run --maxConcurrency=2 ...`
- `pnpm orchestrate --adapter=coco-cli --maxConcurrency=2 ...`
- `pnpm resume --adapter=dry-run`

---

## G. 建议分阶段提交点

### Commit 1

- task queue 基础结构
- queue 持久化
- 基本 claim/release

### Commit 2

- worker pool
- maxConcurrency
- runtime 改造

### Commit 3

- resume 基于 queue
- failure policy 扩展
- 测试补齐

---

## H. 当前优先顺序（最推荐）

1. `task-store / queue` 原子持久化
2. `worker pool + maxConcurrency`
3. `resume` 改为 queue 驱动
4. `failure policy` 扩展
5. `skill registry` 外部化

---

## I. 完成判定

下一阶段完成后，至少要满足：

- worker 数不再等于 task 数
- 存在真实 queue claim/release 流程
- `resume` 不再依赖 report 快照重建执行图
- `maxConcurrency` 可通过 CLI 配置并生效
- 新增测试全部通过
