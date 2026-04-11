# Harness 下一阶段细粒度任务清单

> 目标：让新会话拿到这份清单后，可以直接进入“fix/verify loop 独立路由 + report summary 聚合 + 配置继续外部化”阶段，而不用重新梳理前面的 queue/runtime 演进。

## A. 启动阶段

### A1. 读取现状

- 先读 `docs/NEXT_SESSION_ENTRY.md`
- 再读 `docs/NEXT_TASK_CHECKLIST.md`
- 再读 `docs/HANDOFF_STATUS_2026-04-11.md`
- 再按顺序读：
  - `src/domain/types.ts`
  - `src/runtime/task-queue.ts`
  - `src/runtime/task-store.ts`
  - `src/runtime/team-runtime.ts`
  - `src/runtime/failure-policy.ts`
  - `src/runtime/recovery.ts`
  - `src/runtime/state-store.ts`
  - `src/dispatcher/dispatcher.ts`
  - `src/cli/index.ts`

### A2. 确认工作区状态

- 查看 `git status`
- 确认当前是否已经带有上一轮未提交实现
- 不要重复实现已经存在的：
  - `task queue / task store` 原子落盘
  - `worker pool + maxConcurrency`
  - `queue-based resume`
  - `failure fallback`
  - 显式 `fix/verify loop`
  - `runtime.dynamicTaskStats / runtime.loopSummaries`

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

## C. 下一阶段主目标：把 loop 做成真正独立能力

### C1. loop 的独立 role/model 解析

当前问题：

- `fixVerifyLoop.remediationRole` 已进入 schema
- 但 runtime 仍主要依赖已解析的 `fallback` 目标

下一步目标：

- loop 使用独立的 remediation role/model 解析路径
- 不再把 remediation 的角色/模型选择绑定到 fallback 语义
- 支持：
  - `remediationRole`
  - `remediationModel`
  - `remediationTaskType`
  - `remediationSkills`

建议修改：

- `src/runtime/team-runtime.ts`
- `src/dispatcher/dispatcher.ts`
- `src/runtime/failure-policy.ts`
- `src/role-model-config/resolver.ts`

### C2. loop 轮次与策略类型继续扩展

当前已做：

- `maxRounds`
- remediation task 模板

下一步建议：

- 支持多种 loop 策略类型：
  - `fix-then-retry-source`
  - `spawn-separate-verify-task`
  - `fix-only`
- 区分 remediation task 和 verify task 的统计
- 为 loop 增加更明确的 terminal reason

---

## D. 下一阶段主目标：补 report 顶层 summary

### D1. 新增 report.summary 聚合

当前现状：

- loop 统计已经在 `runtime.dynamicTaskStats` / `runtime.loopSummaries`
- 但没有适合 CLI / dashboard 直接消费的顶层 summary

建议新增：

- `report.summary.generatedTaskCount`
- `report.summary.loopCount`
- `report.summary.loopedSourceTaskIds`
- `report.summary.failedTaskCount`
- `report.summary.completedTaskCount`
- `report.summary.retryTaskCount`

建议修改：

- `src/domain/types.ts`
- `src/orchestrator/run-goal.ts`
- `src/runtime/recovery.ts`
- `src/runtime/task-queue.ts`

### D2. 保证 resume 后 summary 一致

目标：

- `run` 与 `resume` 输出的 summary 结构一致
- 动态任务在恢复后重新聚合时不丢失
- CLI 输出能直接用于后续 dashboard / trace

---

## E. 配置外部化后续项

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

- 让不同目标直接选 composition
- 例如：`feature-dev`、`bugfix`、`review-only`、`research-only`

---

## F. 测试细化 TODO

### F1. 必补测试

- remediation role/model 独立解析测试
- loop `maxRounds` 上限测试
- report summary 聚合测试
- resume 后 summary 一致性测试
- 单独 verify task 策略测试（如果本轮实现）

### F2. 命令级验证

- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" test`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" build`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate --adapter=dry-run --maxConcurrency=2 "实现登录功能并补测试"`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume --adapter=dry-run`

---

## G. 建议分阶段提交点

### Commit 1

- loop 独立 remediation role/model 解析
- 补相关 schema / resolver / runtime 测试

### Commit 2

- `report.summary` 顶层聚合
- run / resume 统一 summary 输出

### Commit 3

- `skills.yaml` / `team-compositions.yaml`
- CLI 选择 composition

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
