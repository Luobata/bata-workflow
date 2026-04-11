# Harness 交接记录（2026-04-11）

## 1. 当前结论

- 当前仓库路径：`/Users/bytedance/luobata/bata-skill/harness`
- 当前代码状态：**已完成多轮实现，并已完成首个根提交**
- 当前 git 提交：`4e0aadd` (`feat: bootstrap harness multi-role orchestration runtime`)
- 当前 git 状态：交接文档新增后工作区再次出现未提交改动；新 Context 继续前建议先确认是否需要再提交一次文档补充
- 当前目标已经从“空仓规划”推进到“可运行的多角色编排 MVP + coco-cli 接入 + 可恢复 runtime”

---

## 2. 本轮已经完成的能力

### 2.1 工程基础

已完成：

- 初始化 `TypeScript + Node.js + pnpm + vitest` 工程
- 建立最小目录结构：`configs/`、`src/`、`tests/`
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
- `.gitignore`

### 2.2 领域模型与基础编排

已完成：

- 定义 `Goal / Task / Plan / DispatchAssignment / RunReport / RuntimeSnapshot / RuntimeTaskState`
- 支持基于目标的规则化任务拆解
- 支持任务依赖关系建模
- 支持批次调度（拓扑批次）

关键文件：

- `src/domain/types.ts`
- `src/planner/planner.ts`
- `src/dispatcher/dispatcher.ts`
- `src/runtime/scheduler.ts`

### 2.3 角色与模型配置

已完成：

- 角色定义配置化
- 模型路由配置化
- 默认模型策略：
  - `coding` / `testing` / `code-review` -> `gpt5.3-codex`
  - 其他 -> `gpt5.4`
- 模型优先级：`taskType > skill > role > team > global`
- 返回 `model/source/reason`，便于审计模型来源

关键文件：

- `configs/roles.yaml`
- `configs/role-models.yaml`
- `src/team/role-registry.ts`
- `src/role-model-config/schema.ts`
- `src/role-model-config/loader.ts`
- `src/role-model-config/resolver.ts`

### 2.4 角色 prompt 与 skill 信息

已完成：

- 角色 prompt 模板配置化
- 不再把角色 prompt 硬编码在 TS 常量中使用为唯一来源
- `coco` prompt 现在会拼入：
  - 角色 opening
  - 角色职责
  - 角色要求
  - skills 描述
  - 输出约束

关键文件：

- `configs/role-prompts.yaml`
- `src/team/prompt-loader.ts`
- `src/team/prompt-templates.ts`
- `src/team/skill-registry.ts`
- `src/runtime/coco-adapter.ts`

### 2.5 coco-cli 接入

已完成：

- 发现本地可用 `coco` CLI：`/Users/bytedance/.local/bin/coco`
- 使用 `coco -p` 非交互模式作为最小接入方案
- `CocoCliAdapter` 已经可用
- 支持：
  - `--adapter=coco-cli`
  - `--timeoutMs=...`
  - `--allowedTools=...`
  - `--yolo=true`
- 解析 coco 输出 JSON；若不是 JSON，则回退到原始文本 summary

关键文件：

- `src/runtime/coco-adapter.ts`
- `src/cli/index.ts`

### 2.6 runtime / team 协议雏形

已完成：

- worker snapshot
- mailbox
- heartbeat
- batch events
- task state
- claim / release / retry 状态流

当前 runtime 事件类型：

- `batch-start`
- `task-claimed`
- `task-start`
- `task-complete`
- `task-failed`
- `task-retry`
- `task-released`
- `batch-complete`

关键文件：

- `src/runtime/team-runtime.ts`
- `src/domain/types.ts`

### 2.7 失败策略

已完成：

- 失败重试策略配置化
- 目前配置为：
  - `coding` / `code-review` / `testing` 默认 `maxAttempts = 2`
  - 其他默认 `maxAttempts = 1`
- `plan` 生成后会应用 failure policy

关键文件：

- `configs/failure-policies.yaml`
- `src/runtime/failure-policy.ts`
- `src/orchestrator/run-goal.ts`

### 2.8 状态持久化

已完成：

- `.harness/state` 目录落盘
- 保存 latest plan
- 保存 latest run 指针
- 保存每次 run 的 plan / report / task-store

当前落盘结构：

```text
.harness/state/
  latest-run.json
  plans/
    latest-plan.json
  runs/
    <run-id>/
      plan.json
      report.json
      task-store.json
```

关键文件：

- `src/runtime/state-store.ts`
- `.gitignore`

### 2.9 resume / recover

已完成：

- 可以从上一次 run 的 `report.json` 恢复
- 恢复逻辑会：
  - 识别已完成任务
  - 筛出未完成 assignments
  - 按依赖重新生成恢复批次
  - 继续执行未完成任务
- 恢复批次前缀为 `R1`、`R2` 等

关键文件：

- `src/runtime/recovery.ts`
- `src/runtime/scheduler.ts`
- `src/cli/index.ts`

---

## 3. 当前命令用法

### 3.1 查看计划

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" plan "实现登录功能并补测试"
```

### 3.2 dry-run 编排

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate "实现登录功能并补测试"
```

### 3.3 使用真实 coco-cli

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate --adapter=coco-cli --timeoutMs=30000 "用一句话说明为什么测试重要"
```

### 3.4 恢复最近一次运行

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume
```

### 3.5 恢复并指定 adapter

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume --adapter=coco-cli
```

### 3.6 指定旧报告继续恢复

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume --reportPath="/绝对路径/report.json"
```

---

## 4. 已验证结果

### 4.1 通过的测试

当前测试套件全部通过：

- `tests/role-model-config.test.ts`
- `tests/planner-dispatcher.test.ts`
- `tests/run-goal.test.ts`
- `tests/coco-adapter.test.ts`
- `tests/state-store.test.ts`
- `tests/recovery.test.ts`

### 4.2 通过的命令

已成功验证：

- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" test`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" build`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" plan "实现登录功能并补测试"`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate --adapter=dry-run "实现登录功能并补测试"`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate --adapter=coco-cli --timeoutMs=30000 "用一句话说明为什么测试重要"`
- `pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume --adapter=dry-run`

### 4.3 临时验证输出文件

调试期间产生过这些临时文件，可作为排查线索，但不是仓库正式产物：

- `/tmp/harness-plan.json`
- `/tmp/harness-run.json`
- `/tmp/harness-plan2.json`
- `/tmp/harness-run2.json`
- `/tmp/harness-live.json`
- `/tmp/harness-live2.json`
- `/tmp/harness-plan3.json`
- `/tmp/harness-run3.json`
- `/tmp/harness-resume2.json`

---

## 5. 当前仓库未提交文件清单

当前 `git status --short` 显示所有文件仍是未跟踪状态。

核心文件包括：

- `.gitignore`
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `vitest.config.ts`
- `configs/role-models.yaml`
- `configs/roles.yaml`
- `configs/role-prompts.yaml`
- `configs/failure-policies.yaml`
- `src/cli/index.ts`
- `src/domain/types.ts`
- `src/planner/planner.ts`
- `src/dispatcher/dispatcher.ts`
- `src/orchestrator/run-goal.ts`
- `src/role-model-config/*`
- `src/runtime/coco-adapter.ts`
- `src/runtime/failure-policy.ts`
- `src/runtime/scheduler.ts`
- `src/runtime/state-store.ts`
- `src/runtime/team-runtime.ts`
- `src/runtime/recovery.ts`
- `src/team/role-registry.ts`
- `src/team/skill-registry.ts`
- `src/team/prompt-loader.ts`
- `src/team/prompt-templates.ts`
- `src/verification/index.ts`
- `tests/*.test.ts`

说明：

- 当前已经完成首个提交：`4e0aadd`
- 本文档及后续入口文档是在该提交之后新增/补充的交接材料
- 如果新 Context 需要继续，建议先决定：
  - 继续开发后再统一提交
  - 还是先把交接文档单独提交一次

---

## 6. 当前系统已经具备的完整能力地图

### 已完成

1. 工程初始化
2. 角色注册
3. skill 注册
4. 目标拆解
5. 任务依赖图
6. 批次调度
7. 模型配置解析
8. 角色 prompt 配置
9. 失败策略配置
10. dry-run adapter
11. coco-cli adapter
12. runtime worker snapshot
13. mailbox
14. heartbeat
15. claim / release
16. retry / attempt
17. `.harness/state` 持久化
18. latest-run 指针
19. task-store 持久化
20. resume / recover

### 还没完成

1. 真正的持久化 task queue（当前 task-store 主要用于快照/恢复，不是原子增量更新队列）
2. worker pool / `maxConcurrency`
3. 可配置的 queue 调度策略
4. 真实多 worker 并发控制
5. resume 时保留更细粒度的 attempts 历史与 worker 重绑定策略
6. 失败策略增强：`fallback-role`、`fallback-model`、`retry-delay`
7. skill 完全配置化（当前 skill registry 还是 TS 常量）
8. MCP / plugin 入口
9. 长生命周期 worker 会话，而不是当前一次 prompt 一次执行
10. 真正接近 OMC team 的 claim-task / release-task / mailbox API 控制面

---

## 7. 建议新 Context 继续的优先顺序

### 第一优先级

实现真正的 **task queue + worker pool + maxConcurrency**：

- 新增持久化 task store 的原子更新 API
- 支持 worker 从 queue 中 claim 下一个 task
- 支持配置 `maxConcurrency`
- 支持 worker 池重复利用，而不是当前 task 和 worker 近似一一对应

### 第二优先级

增强恢复与失败策略：

- resume 时保留历史 attempts 语义
- 把 `lastError` 和历史事件串联到恢复逻辑
- 支持失败策略配置化扩展：
  - `noRetry`
  - `retryUntilMax`
  - `fallbackRole`
  - `fallbackModel`

### 第三优先级

进一步贴近 OMC team：

- `team api claim-task`
- `team api transition-task-status`
- mailbox 查询 / 回执
- heartbeat 定时上报
- graceful shutdown

### 第四优先级

体验和生态：

- 可视化 trace / dashboard
- MCP 接入
- plugin 化接入 coco
- prompts / skills 全量外部配置

---

## 8. 新 Context 最好先读哪些文件

建议阅读顺序：

1. `package.json`
2. `src/domain/types.ts`
3. `src/planner/planner.ts`
4. `src/dispatcher/dispatcher.ts`
5. `src/runtime/scheduler.ts`
6. `src/runtime/team-runtime.ts`
7. `src/runtime/coco-adapter.ts`
8. `src/runtime/state-store.ts`
9. `src/runtime/recovery.ts`
10. `src/cli/index.ts`
11. `configs/role-models.yaml`
12. `configs/role-prompts.yaml`
13. `configs/failure-policies.yaml`
14. `tests/run-goal.test.ts`
15. `tests/recovery.test.ts`

---

## 9. 对新 Context 的一句话提醒

当前不是从零开始，而是已经有一套“**可配置模型 + 可配置角色 prompt + coco-cli 执行 + retry + state 持久化 + resume**”的运行骨架；下一步最关键的是把它从“快照式 runtime”推进成“真正的持久化 task queue / worker pool 系统”。
