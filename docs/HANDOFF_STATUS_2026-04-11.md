# Bata-Workflow 交接记录（2026-04-11）

## 1. 当前结论

- 当前仓库路径：`/Users/bytedance/luobata/bata-skill/bata-workflow`
- 当前代码状态：**已完成多轮实现，已从“快照式 runtime”推进到“持久化 queue / worker pool / queue-based resume / fix-verify loop”阶段**
- 已存在仓库提交：
  - `4e0aadd` `feat: bootstrap harness multi-role orchestration runtime`
  - `5194634` `docs: add continuation handoff entrypoints`
- 当前工作区：包含本轮代码改动与文档更新，继续前先看 `git status`
- 当前最重要目标：**继续把 fix/verify loop 做成独立可配置能力，并补 report 顶层 summary 聚合**

---

## 2. 本轮后已经完成的能力

### 2.1 工程基础

已完成：

- `TypeScript + Node.js + pnpm + vitest` 工程
- 可用脚本：
  - `pnpm plan`
  - `pnpm orchestrate`
  - `pnpm resume`
  - `pnpm test`
  - `pnpm build`

关键文件：

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`

### 2.2 领域模型与基础编排

已完成：

- `Goal / Task / Plan / DispatchAssignment / RunReport / RuntimeSnapshot / RuntimeTaskState`
- 规则化任务拆解
- 任务依赖建模
- 拓扑批次调度
- 运行时动态任务字段：`generatedFromTaskId`
- loop 统计字段：`dynamicTaskStats`、`loopSummaries`

关键文件：

- `src/domain/types.ts`
- `src/planner/planner.ts`
- `src/dispatcher/dispatcher.ts`
- `src/runtime/scheduler.ts`

### 2.3 角色、模型、prompt

已完成：

- 角色配置化：`configs/roles.yaml`
- 模型路由配置化：`configs/role-models.yaml`
- 模型优先级：`taskType > skill > role > team > global`
- 角色 prompt 配置化：`configs/role-prompts.yaml`
- `coco` prompt 已拼接 opening / 角色职责 / 要求 / skills / 输出约束

关键文件：

- `src/team/role-registry.ts`
- `src/role-model-config/schema.ts`
- `src/role-model-config/loader.ts`
- `src/role-model-config/resolver.ts`
- `src/team/prompt-loader.ts`
- `src/team/prompt-templates.ts`

### 2.4 coco-cli 接入

已完成：

- 本地 `coco` CLI 已可用
- 使用 `coco -p` 非交互模式接入
- 支持：
  - `--adapter=coco-cli`
  - `--timeoutMs=...`
  - `--allowedTools=...`
  - `--yolo=true`
- dry-run 与 coco-cli 共用统一 runtime 执行面

关键文件：

- `src/runtime/coco-adapter.ts`
- `src/cli/index.ts`

### 2.5 持久化 task queue / worker pool / queue-based resume

已完成：

- 持久化 `task queue` 抽象
- 持久化 `task store` 抽象
- `queue.json` / `task-store.json` / `tasks/<taskId>.json` 原子写入
- worker pool 已接入，worker 数与 task 数解耦
- `maxConcurrency` 已接入 CLI，默认值 `2`
- `resume` 已升级为 **queue 驱动恢复**
- `attemptHistory` / `workerHistory` / `failureTimestamps` / `lastClaimedAt` / `releasedAt` / `nextAttemptAt` 已进入任务状态

当前落盘结构：

```text
.bata-workflow/state/
  latest-run.json
  plans/
    latest-plan.json
  runs/
    <run-id>/
      plan.json
      report.json
      queue.json
      task-store.json
      tasks/
        T1.json
        T2.json
        ...
```

关键文件：

- `src/runtime/task-queue.ts`
- `src/runtime/task-store.ts`
- `src/runtime/team-runtime.ts`
- `src/runtime/recovery.ts`
- `src/runtime/state-store.ts`
- `src/cli/index.ts`

### 2.6 failure policy 与 fallback 路由

已完成：

- failure policy 已支持：
  - `maxAttempts`
  - `retryDelayMs`
  - `fallbackRole`
  - `fallbackModel`
  - `retryOn`
  - `terminalOn`
- 分发阶段已预解析 fallback 目标
- runtime 已支持失败后 reroute / delay / terminal 判定

关键文件：

- `configs/failure-policies.yaml`
- `src/runtime/failure-policy.ts`
- `src/dispatcher/dispatcher.ts`
- `src/runtime/team-runtime.ts`

### 2.7 显式 fix/verify loop

已完成：

- `testing` 失败时，不再只做原 task reroute
- 已支持生成显式 remediation task，例如：`T4_FIX_1`
- remediation task 会被写入 queue / plan / runtime / report
- 已支持 `fixVerifyLoop` 配置块：
  - `enabled`
  - `maxRounds`
  - `remediationRole`
  - `remediationModel`
  - `remediationTaskType`
  - `remediationSkills`
  - `remediationTitleTemplate`
  - `remediationDescriptionTemplate`
- runtime 已输出：
  - `dynamicTaskStats`
  - `loopSummaries`

关键文件：

- `src/runtime/failure-policy.ts`
- `src/runtime/team-runtime.ts`
- `src/runtime/task-queue.ts`
- `src/domain/types.ts`

---

## 3. 当前命令用法

### 3.1 查看计划

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" plan "实现登录功能并补测试"
```

### 3.2 dry-run 编排

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" orchestrate --adapter=dry-run --maxConcurrency=2 "实现登录功能并补测试"
```

### 3.3 使用真实 coco-cli

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" orchestrate --adapter=coco-cli --timeoutMs=30000 --maxConcurrency=2 "用一句话说明为什么测试重要"
```

### 3.4 恢复最近一次运行

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" resume --adapter=dry-run
```

### 3.5 指定旧 run 目录继续恢复

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" resume --runDirectory="/绝对路径/.bata-workflow/state/runs/<run-id>" --adapter=dry-run
```

### 3.6 指定旧报告继续恢复

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" resume --reportPath="/绝对路径/report.json" --adapter=dry-run
```

---

## 4. 已验证结果

### 4.1 当前已覆盖的测试

当前测试包括：

- `tests/role-model-config.test.ts`
- `tests/planner-dispatcher.test.ts`
- `tests/run-goal.test.ts`
- `tests/coco-adapter.test.ts`
- `tests/state-store.test.ts`
- `tests/recovery.test.ts`
- `tests/task-queue.test.ts`
- `tests/failure-policy.test.ts`

### 4.2 已验证通过的命令

本轮结束时已通过：

- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" build`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" orchestrate --adapter=dry-run --maxConcurrency=2 "实现登录功能并补测试"`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" resume --adapter=dry-run`

---

## 5. 当前系统能力地图

### 已完成

1. 工程初始化
2. 角色注册
3. skill 注册（仍在 TS 常量中）
4. 目标拆解
5. 任务依赖图
6. 批次调度
7. 模型配置解析
8. 角色 prompt 配置
9. dry-run adapter
10. coco-cli adapter
11. 持久化 `task queue`
12. 持久化 `task store`
13. 原子 queue/task 落盘
14. worker pool
15. `maxConcurrency`
16. queue-based resume
17. runtime worker snapshot
18. mailbox
19. heartbeat
20. claim / release / retry
21. failure fallback
22. retry delay / terminal 判定
23. 显式 `fix/verify loop`
24. 动态任务统计
25. loop 摘要（runtime 层）

### 还没完成

1. `fixVerifyLoop.remediationRole / remediationModel` 的独立解析路径
2. `report.summary` 顶层聚合
3. run / resume 顶层 summary 对齐
4. 更丰富的 loop 策略类型（如单独 verify task）
5. `skills.yaml` 外部化
6. `team-compositions.yaml` 外部化
7. 可配置 queue 调度策略
8. graceful shutdown
9. 长生命周期 worker 会话
10. dashboard / trace 展示层

---

## 6. 下一轮最推荐继续的顺序

### 第一优先级

把 `fixVerifyLoop` 做成真正独立能力：

- remediation task 不再依赖 fallback 路由语义
- 单独解析 remediation role / model / taskType / skills
- 为 loop 增加更清晰的终止语义

### 第二优先级

补 `report.summary` 顶层聚合：

- `generatedTaskCount`
- `loopCount`
- `loopedSourceTaskIds`
- `completedTaskCount`
- `failedTaskCount`
- `retryTaskCount`

### 第三优先级

把配置继续外部化：

- `configs/skills.yaml`
- `src/team/skill-loader.ts`
- `configs/team-compositions.yaml`

---

## 7. 新会话建议阅读顺序

建议顺序：

1. `docs/NEXT_SESSION_ENTRY.md`
2. `docs/NEXT_TASK_CHECKLIST.md`
3. `docs/HANDOFF_STATUS_2026-04-11.md`
4. `src/domain/types.ts`
5. `src/runtime/task-queue.ts`
6. `src/runtime/task-store.ts`
7. `src/runtime/team-runtime.ts`
8. `src/runtime/failure-policy.ts`
9. `src/runtime/recovery.ts`
10. `src/runtime/state-store.ts`
11. `src/dispatcher/dispatcher.ts`
12. `src/cli/index.ts`
13. `configs/failure-policies.yaml`
14. `tests/run-goal.test.ts`
15. `tests/task-queue.test.ts`
16. `tests/failure-policy.test.ts`

---

## 8. 对新会话的一句话提醒

当前不是从零开始，而是已经有一套“**持久化 queue + worker pool + queue-based resume + failure fallback + 显式 fix/verify loop + runtime loop 统计**”的运行骨架；下一步关键是把它继续推进成“**loop 独立路由 + report 顶层 summary + 配置继续外部化**”的系统。
