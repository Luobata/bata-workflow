# Bata-Workflow 中实现 Coco 式 Team Mode 设计

## 背景

当前 `bata-workflow` 已经是一个 Rush monorepo，且具备两个关键前提：

1. 主应用已经下沉到 `apps/bata-workflow/`，并且存在可演进的 runtime、dispatcher、TUI、watch 能力。
2. monorepo 中已经存在一个可复用的 tmux 基础设施包 `packages/tmux-manager/`，并且 `apps/bata-workflow` 已通过 workspace 依赖接入它：`apps/bata-workflow/package.json:16`。

本设计的目标不是先定义最终有哪些 package / app，而是先回答：

1. 如何在 `bata-workflow` 中实现类似 OMC 的 **team mode**；
2. 如何把多 agent 协作做成可管理、可通信、可观测、可视化的 runtime；
3. 应该从 monorepo 的哪里开始落地；
4. 哪些能力应先留在 `apps/bata-workflow` 内部，哪些在实现过程中被证明足够通用后再升格为 package。

一句话原则：

> 先在 `apps/bata-workflow` 中把 team mode 做成一套真实可运行的 runtime；只有在实现过程中确认某部分具备明确跨项目复用价值，才把它抽成独立 package。

---

## 目标

### 目标

在 `bata-workflow` 中实现一套 **Coco 风格的 team mode**，支持：

1. 启动一个包含多个 worker/agent 的 team；
2. leader 统一调度 task、治理 worker 生命周期；
3. leader 与 worker、worker 与运行时之间有稳定的通信模型；
4. 运行时状态可以落盘、恢复、重试、诊断；
5. TUI / watch 能表达 team overview、worker detail、timeline、协作状态；
6. 底层执行容器优先复用 `@luobata/tmux-manager`。
7. 支持类似 OMC 的**对话内展开方式**，例如 `/bata-workflow-team ...` 这样的 slash 命令触发 team mode；
8. 支持为不同子 agent 指定不同执行后端，例如：
   - Coco 自己的模型执行；
   - Claude Code；
   - 本地 `cc` alias（例如通过 ttadk 打开的 alias）。

### 非目标

本轮设计不要求：

1. 先做最终 package/app 终局规划；
2. 先重构 planner / dispatcher 整体架构；
3. 先把 `packages/tmux-manager/src/team/*` 直接作为 bata-workflow runtime 核心接入；
4. 先支持多宿主（Web / IDE / CLI）统一接入；
5. 先解决所有动态子任务、自扩缩容、subteam spawning 等高级能力。

---

## 从 OMC 学什么，而不照搬什么

### 应该迁移的设计原则

从 OMC 中最值得迁移的是以下设计原则，而不是 Claude Code 特定壳层：

1. **team 要有独立状态命名空间**：支持多 team 并存、resume、隔离。
2. **通信不能只靠内存**：需要 durable queue / mailbox / event log。
3. **runtime phase 与业务 workflow phase 分离**：避免状态机混乱。
4. **可视化建立在状态模型上**：UI 不直接读底层散落文件。
5. **worker 生命周期必须可观测**：知道谁在做什么、何时卡住、何时失败。
6. **治理策略要配置化**：不要把 one-team-per-leader、shutdown gate 等硬编码在 runtime 里。

这些原则在原始学习文档中已有对应总结，例如：

- team 状态命名空间：`docs/design/COCO_ORCHESTRATION_LEARNING_FROM_OMC.md:172`
- durable message：`docs/design/COCO_ORCHESTRATION_LEARNING_FROM_OMC.md:181`
- 状态模型驱动可视化：`docs/design/COCO_ORCHESTRATION_LEARNING_FROM_OMC.md:201`
- governance 独立化：`docs/design/COCO_ORCHESTRATION_LEARNING_FROM_OMC.md:219`

### 不应该直接照搬的内容

以下内容不应成为本轮设计主线：

1. Claude Code hook payload 细节；
2. OMC 特有 skill 壳层组织方式；
3. 历史兼容桥接逻辑；
4. 只服务 OMC CLI/HUD 的具体渲染习惯。

Harness 学的是 **运行时方法**，不是迁移 OMC 的宿主实现。

---

## 在 monorepo 中从哪里开始

### 推荐的第一落点

实现 team mode 时，**应该从 `apps/bata-workflow` 开始，而不是从 `packages/` 开始**。

最推荐的第一实施入口是：

1. `apps/bata-workflow/src/runtime/team-runtime.ts:123`
2. `apps/bata-workflow/src/runtime/coco-adapter.ts:1`
3. `apps/bata-workflow/src/runtime/task-queue.ts:1`
4. `apps/bata-workflow/src/cli/index.ts:302`
5. `apps/bata-workflow/src/cli/slash-command-loader.ts:5`
6. `apps/bata-workflow/src/domain/types.ts:75`
7. `apps/bata-workflow/src/tui/watch-state.ts:1`
8. `packages/tmux-manager/src/tmux-session.ts:75`

### 为什么从这里开始

#### 1. `team-runtime.ts` 已经是逻辑 team runtime 的内核

`apps/bata-workflow/src/runtime/team-runtime.ts:123` 已经承担了：

- worker claim task
- batch 执行
- retry / reroute / remediation
- control command 响应
- runtime 事件追加

这意味着当前 bata-workflow 已经有一个"逻辑 worker runtime"，缺的不是从零开始的框架，而是把它升级成"真实多 agent runtime"。

#### 2. `coco-adapter.ts` 是最好的执行接缝

`apps/bata-workflow/src/runtime/coco-adapter.ts:1` 代表当前执行器边界。它现在仍偏单次任务执行，但正因如此，适合先作为第一版的接入 seam：

- runtime 保持调度职责；
- adapter 底层接入 tmux-backed agent session；
- 先不破坏 planner / dispatcher / verification 的上游结构。

#### 3. `task-queue.ts` 是状态中心

如果 team mode 要变成“可通信、可观测、可视化”的 runtime，那么状态必须集中演进，不能让 tmux、自定义 monitor、UI 各自维护一份独立真相源。

所以队列、worker snapshot、event、mailbox、retry 语义，都应该优先收敛到 `apps/bata-workflow/src/runtime/task-queue.ts:1` 所在的 runtime state 模型中。

#### 4. TUI 已有不错的承接能力

`apps/bata-workflow/src/tui/watch-state.ts:30` 已经有 summary、workers、hot tasks、selected task、recent events 等 view model。说明可视化不是要从零新建，而是要为它提供更真实的 runtime telemetry。

#### 5. `tmux-manager` 适合作为执行后端，而不是 team 抽象本体

`packages/tmux-manager/src/tmux-session.ts:75` 已具备：

- 创建 session / pane
- split layout
- send input
- pane liveness
- capture output

这些是非常好的执行基础设施，但并不自动等于 bata-workflow 的 team control-plane。

#### 6. team 命令入口要从 CLI/slash 系统扩出来

当前 slash 命令能力只支持“把名字映射成 `action/composition/teamName/adapter`”，见：

- `apps/bata-workflow/src/cli/slash-command-loader.ts:5`
- `apps/bata-workflow/src/cli/slash-command-loader.ts:68`
- `apps/bata-workflow/configs/slash-commands.yaml:1`

而 `apps/bata-workflow/src/cli/index.ts:302` 当前在 slash 展开后，直接把剩余 positional 拼成 `goal`。这意味着像 `/bata-workflow-team 2:model "xxx"` 这样的成员级覆写语法，不能只靠现有 slash loader 支持，必须在 CLI 中新增一层 team command parser。

---

## Team Mode 的整体能力图

```text
User / CLI / Dashboard
        |
        v
+----------------------+
|   Team Control API   |
| start/status/resume  |
| shutdown/rebalance   |
+----------+-----------+
           |
           v
+----------------------+
|      Team Leader     |
| orchestration/gov    |
| assignment/observe   |
+----+------------+----+
     |            |
     |            |
     v            v
+---------+   +----------------+
|  Tasks  |   | Team Runtime   |
| queue   |   | phase/lifecycle|
+----+----+   +--------+-------+
     |                 |
     |                 |
     +--------+--------+
              |
              v
      +---------------+
      |   Workers     |
      | agent-1..N    |
      +-------+-------+
              |
              v
      +---------------+
      | Execution     |
      | Backend       |
      | tmux-manager  |
      +---------------+
```

### 设计含义

1. **Team Control API** 负责对外控制入口；
2. **Leader** 是 team 的控制核心，而不是普通 worker；
3. **Runtime** 负责 team 的生命周期语义；
4. **Worker** 是执行体；
5. **tmux-manager** 是执行后端，而不是整个 team 抽象本身。

---

## 多 agent 管理模型

### 核心对象

建议在 bata-workflow 中逐步收敛为以下对象模型：

#### Team
- teamId
- goal
- phase
- governance
- createdAt / updatedAt
- leaderSession
- workerIds

#### Leader
- 负责 team 初始化
- 负责任务分配
- 负责治理与干预
- 负责生成 recommendation / next action

#### Worker
- workerId
- slotId（如 `1`、`2`、`3`，用于命令行覆写与 team 视图映射）
- role
- agentType
- executionHandle（如 paneId / sessionName）
- currentTaskId
- status
- lastHeartbeatAt
- lastProgressAt

#### Task
- taskId
- title / description
- role
- taskType
- dependsOn
- attempts / maxAttempts
- status
- summary / error

#### Snapshot
- team summary
- worker summary
- task counts
- recent events
- recommendations

### 生命周期模型

#### Team phase

建议使用：

```text
initializing
-> planning
-> executing
-> fixing
-> completed / failed / shutdown
```

#### Worker lifecycle

建议使用：

```text
created
-> ready
-> assigned
-> running
-> completed / failed / blocked
-> idle / shutdown
```

关键原则：

- worker lifecycle 不等于 team phase；
- runtime phase 不等于业务 workflow phase；
- 状态必须可观测、可恢复、可重试。

### 关于 slot 的补充约束

为了支持 `/bata-workflow-team 2:model "xxx"` 这种对话式展开方式，team mode 需要引入一个比当前 `workerId` 更稳定的概念：`slotId`。

原因是当前 runtime 中的 worker 更像运行时池子，而不是预先定义的“第几个子代理”。如果没有 `slotId`，CLI 中的 `2:model` 无法稳定地映射到某个成员配置。

因此建议：

1. `slotId` 作为 team 组成结构里的静态成员编号；
2. `workerId` 作为运行时实例标识；
3. slash 命令与配置覆写优先面向 `slotId`；
4. watch/TUI 显示时同时展示 `slotId -> workerId -> role/backend/model` 的映射。

---

## 通信模型

### 三类消息

#### 1. 控制消息

方向：`User/CLI/UI -> Control API -> Leader -> Worker`

典型示例：

- `StartTeam`
- `AssignTask`
- `CancelTask`
- `PauseWorker`
- `ShutdownWorker`
- `ResumeTeam`

#### 2. 运行时状态消息

方向：`Worker -> Runtime State`

典型示例：

- `WorkerHeartbeat`
- `TaskClaimed`
- `TaskProgress`
- `TaskCompleted`
- `TaskFailed`
- `TaskBlocked`

#### 3. 观测事件

方向：`Leader/Runtime/Worker -> Event Log`

典型示例：

- `TeamStarted`
- `PhaseChanged`
- `WorkerLaunched`
- `WorkerDied`
- `RetryScheduled`
- `InterventionRequired`

### 通信图

```text
                 +------------------+
                 | User / CLI / UI  |
                 +--------+---------+
                          |
                          | control command
                          v
                 +------------------+
                 | Team Control API |
                 +--------+---------+
                          |
                          v
                 +------------------+
                 |  Team Leader     |
                 +---+----------+---+
                     |          |
        assign task  |          | write event/snapshot
                     |          |
                     v          v
              +-------------+   +------------------+
              | Dispatch /  |   | State / Event /  |
              | Mailbox     |   | Snapshot Store   |
              +------+------+   +--------+---------+
                     |                    ^
                     |                    |
                     v                    |
              +-------------+             |
              | Worker Inbox |            |
              +------+------+             |
                     |                    |
                     v                    |
              +-------------+  progress / heartbeat / result
              |   Worker    +------------------------+
              +-------------+
```

### 第一阶段的实际收敛方式

第一阶段不需要上复杂总线，但必须保证：

1. 派发是 durable 的；
2. worker heartbeat / progress 能落到 runtime state；
3. event log 是 append-only；
4. snapshot 可以从 state + event 重建。

因此建议：

- 扩展 `apps/bata-workflow/src/runtime/task-queue.ts:1`
- 扩展 `apps/bata-workflow/src/runtime/event-stream.ts:1`
- 将当前 mailbox 从“日志注记”逐步升级为“结构化消息记录”

### 命令消息与协作消息要分离

为了支持 team 内部更像 OMC 的协作展开方式，建议在现有 mailbox 之上明确区分两类消息：

#### A. Command Message
由控制面发给 slot/worker，表达显式指令：

- `assign`
- `cancel`
- `nudge`
- `shutdown`
- `reroute`

#### B. Collaboration Message
由 worker/leader 之间产生，表达协作上下文：

- handoff
- upstream summary
- review request
- question / answer
- failure note

这样做的好处是：

- 控制面不会被协作文本污染；
- timeline 能区分“系统动作”和“agent 协作”；
- TUI 的 collaboration 面板可以直接建立在结构化消息之上，而不是只能从字符串里猜。

---

## 对话内展开方式：`/bata-workflow-team` 命令模型

### 设计目标

用户希望支持类似 OMC 的用法，在 agent 对话中通过一条 slash 命令直接展开 team mode，例如：

```text
/bata-workflow-team 2:model "xxx" 修复 watch 渲染闪烁
```

这里的精确语法可以后续再调，但它表达的能力必须明确：

1. 一条命令就能触发 team run；
2. 可以指定 team 规模 / composition；
3. 可以按成员（slot）覆写 model/backend；
4. 可以把剩余文本作为 `goal`；
5. 可以与已有 `plan/run/resume/watch` CLI 保持兼容。

### 推荐的最小语法

第一阶段建议先收敛到如下语法：

```text
/bata-workflow-team [team-size] [slot-overrides...] "goal"
```

例如：

```text
/bata-workflow-team 2 "实现 timeline 视图"
/bata-workflow-team 3 2:model=gpt5.4 "给 watch 加团队协作视图"
/bata-workflow-team 3 1:backend=claude-code 2:backend=coco 3:backend=cc "实现 team mode"
/bata-workflow-team 3 2:profile=cc-local 3:model=gpt5.3-codex "修复 runtime 与 TUI"
```

### 语义解释

#### `team-size`
表示要启动几个成员 slot，例如 `2`、`3`。

#### `slot-overrides`
表示对某个 slot 的局部覆写，形式为：

```text
<slotId>:<key>=<value>
```

例如：

- `2:model=gpt5.4`
- `1:backend=claude-code`
- `3:profile=cc-local`
- `2:role=reviewer`

#### `goal`
其余文本最终拼成 goal，仍然进入现有 planner / dispatcher / runtime 主流程。

### 为什么不直接复用现有 slash loader

因为当前 slash loader 只能表达：

- `action`
- `composition`
- `teamName`
- `adapter`

见：

- `apps/bata-workflow/src/cli/slash-command-loader.ts:5`
- `apps/bata-workflow/src/cli/slash-command-loader.ts:24`
- `apps/bata-workflow/configs/slash-commands.yaml:1`

因此推荐做法是：

1. 仍在 `slash-commands.yaml` 注册 `/bata-workflow-team` 这个名字；
2. 但在 `apps/bata-workflow/src/cli/index.ts:302` 之后新增专门 parser；
3. parser 负责把 `2:model=gpt5.4` 这类 token 解析成 team command spec；
4. 解析结果再映射为新的 team run 输入结构。

### 设计结论

`/bata-workflow-team` 应该被当作一套 **team-mode command DSL**，而不是普通 slash alias。

---

## 多后端 subagent 抽象

### 当前问题

当前 bata-workflow 的模型路由只会解析出一个 `model: string`，见：

- `apps/bata-workflow/configs/role-models.yaml:1`
- `apps/bata-workflow/src/domain/types.ts:75`

这对单一后端够用，但不够表达下面这种情况：

- 子代理 A 走 Coco 自己的模型；
- 子代理 B 走 Claude Code；
- 子代理 C 走本地 `cc` alias（ttadk 打开的别名）。

原因是系统现在只能知道“模型名是什么”，却不知道“这个模型名应该交给哪个 backend 执行”。

### 新增抽象：`ExecutionTarget`

建议新增一个高于 `ModelResolution` 的概念：

```ts
type ExecutionBackend = 'coco' | 'claude-code' | 'local-cc'

type ExecutionTarget = {
  backend: ExecutionBackend
  model?: string
  profile?: string
  command?: string
  transport?: 'cli' | 'pty'
  source: 'taskType' | 'skill' | 'role' | 'team' | 'slot-override' | 'fallback' | 'remediation'
  reason: string
}
```

### 三类典型 backend

#### 1. Coco backend
适用于：

- 使用 Coco CLI / Coco PTY 模式执行
- 仍然沿用当前 `coco-adapter.ts` 的大部分 prompt / result 协议

#### 2. Claude Code backend
适用于：

- 子 agent 实际通过 Claude Code 启动
- model/profile 与 Claude Code 自己的参数体系对齐

#### 3. Local CC backend
适用于：

- 本地已有 `cc` 命令别名
- 可能通过 ttadk 打开的 alias 调起
- command/profile 需要由 bata-workflow 配置指定，而不应硬编码在 runtime 中

### 设计原则

1. **先解析 backend，再解析 model/profile**；
2. `model` 不再是全局唯一真相，而只是某个 backend 的局部参数；
3. slot override 可以覆写 backend，也可以只覆写 model/profile；
4. fallback / remediation 也要返回 `ExecutionTarget`，而不只是新的 model string。

### 对现有代码的影响点

#### 配置层

当前：
- `apps/bata-workflow/configs/role-models.yaml:1`

未来建议演进为：
- `role-models.yaml` 逐步升级为 role/backend target 配置
- 或新增一层 backend target 配置文件，再由 resolver 统一解析

#### 类型层

当前：
- `apps/bata-workflow/src/domain/types.ts:82`

未来：
- `ModelResolution` 保留给模型命中解释
- 新增 `ExecutionTarget`
- `DispatchAssignment` 同时挂 `executionTarget`

#### 执行层

当前：
- `apps/bata-workflow/src/runtime/coco-adapter.ts:20`
- `apps/bata-workflow/src/cli/index.ts:273`

未来：
- 把 `CocoAdapter` 泛化成通用 `TaskExecutor` / `AgentBackend`
- CLI 不再只创建一个 run 级 adapter，而是提供一个 router executor
- router 根据 task / slot 的 `ExecutionTarget` 决定走 Coco / Claude Code / local cc

### 第一阶段不做什么

第一阶段不要求完整实现所有 backend，只要求设计上留出这些位置：

1. `/bata-workflow-team` 语法允许表达 slot/backend/model 覆写；
2. runtime state 能记录 slot/backend/model；
3. 执行接口能容纳多个 backend；
4. 第一版可以只先真正打通 `coco` + `local-cc` 或 `coco` + `claude-code` 两种。

---

## 可视化表达与交互模型

### 状态到 UI 的链路

```text
Raw Runtime Data
  ├─ team state
  ├─ worker state
  ├─ task state
  ├─ event log
  └─ snapshots
         |
         v
+----------------------+
| Observability Mapper |
| aggregate / enrich   |
+----------+-----------+
           |
           +-------------------+
           |                   |
           |                   |
           v                   v
+------------------+   +------------------+
| Overview VM      |   | Team Detail VM   |
+------------------+   +------------------+
           |
           v
+------------------+
| Timeline VM      |
+------------------+
           |
           v
+------------------------------+
| Dashboard / TUI / HUD / CLI  |
+------------------------------+
```

### 三类核心视图

#### Overview

回答：哪些 team 正常，哪些有风险。

建议展示：

- teamId
- 当前 phase
- slot/backend/model 分布摘要
- worker 总数 / alive / busy / idle
- task 总量与进度
- 风险提示
- 推荐动作

#### Team Detail

回答：某个 team 内部到底发生了什么。

建议展示：

- 每个 worker 当前状态
- 每个 slot 的 backend / model / profile
- 当前任务
- 最近 heartbeat / progress
- blocked / failed 原因
- retry 情况
- leader guidance

#### Timeline

回答：为什么系统演化到了现在这个状态。

建议展示：

- team lifecycle
- worker lifecycle
- backend / slot 覆写生效记录
- task transitions
- dispatch / retry / reroute / intervention

### 交互分层

#### CLI / Control Plane
负责：

- start / status / resume / shutdown
- retry / reroute / inspect
- attach / tail / debug

#### TUI / Dashboard / HUD
负责：

- overview
- drill-down
- collaboration 状态
- timeline filter
- failure inspection
- recommendation 展示

### 在当前仓库中的承接位置

建议从以下文件开始演进：

- `apps/bata-workflow/src/tui/watch-state.ts:30`
- `apps/bata-workflow/src/tui/render.ts:1`
- `apps/bata-workflow/src/tui/watch.ts:1`

其中 `watch-state.ts` 应继续承担 view-model reducer 职责，不要让 `render.ts` 直接拼装底层 runtime 数据。

### 与 `/bata-workflow-team` 命令相关的可视化要求

为了让 team mode 在对话中“展开后可观察”，TUI / watch 至少要补三种展示：

1. **slot 映射表**：`slotId -> role -> backend -> model/profile -> workerId/paneId`
2. **backend 状态**：不同 backend 的任务执行状态、失败原因、最后心跳
3. **override 来源**：哪些来自 team 默认配置，哪些来自 `/bata-workflow-team` 命令覆写

没有这三块，用户虽然能输入 `/bata-workflow-team 2:model=xxx`，但运行后无法确认系统到底是否按预期展开。

---

## tmux-manager 的接入边界

### 定位

`@luobata/tmux-manager` 的定位应明确为：

> Bata-workflow team mode 的执行后端 / 适配器候选，而不是 bata-workflow team runtime 本身。

### 接入图

```text
+--------------------------------------+
|          Coco Team Runtime           |
| leader / phase / task / governance   |
+-------------------+------------------+
                    |
                    | execution adapter interface
                    v
+--------------------------------------+
|        Worker Execution Adapter      |
| launch / send / heartbeat / alive    |
+-------------------+------------------+
                    |
                    v
+--------------------------------------+
|      @luobata/tmux-manager           |
| tmux session / pane / team monitor   |
+-------------------+------------------+
                    |
                    v
+--------------------------------------+
|        tmux panes / worker shells    |
+--------------------------------------+
```

### 适合直接复用的部分

第一阶段优先复用：

- `packages/tmux-manager/src/tmux-session.ts:75`
- `packages/tmux-manager/src/tmux-utils.ts:1`

即复用：

- session / pane 创建
- split layout
- send input
- capture output
- pane liveness

### 不建议直接作为 bata-workflow runtime 内核复用的部分

当前不建议直接把 `packages/tmux-manager/src/team/*` 作为 bata-workflow team mode v1 的主模型，因为：

1. 它与 bata-workflow 已有 runtime state 是两套并行模型；
2. task / failed / completed 语义与 bata-workflow 不完全一致；
3. 当前最稳定可复用的是 tmux 基础设施层，而不是其中那套 team 语义层。

因此建议：

- **复用 `tmux-session.ts` 这一层**；
- **不要让 `tmux-manager/team/*` 反过来主导 bata-workflow runtime 模型**。

### 对 `local-cc` backend 的意义

如果本地 `cc` alias 最终通过 tmux pane 运行，那么 `tmux-manager` 的职责依旧不变：

- 创建 pane / session
- 发送命令
- 抓输出
- 探活

变化只在上层 executor：

- 某个 slot 的 `ExecutionTarget.backend = 'local-cc'`
- executor 选择本地命令（例如 `cc` 或某个 ttadk alias）
- 再通过 tmux pane 去承载它

因此 `tmux-manager` 仍然是执行容器层，而不是 backend 语义层。

---

## 哪些先留在 apps/bata-workflow，哪些未来可能包化

### 第一阶段先留在 `apps/bata-workflow` 内部的

1. `apps/bata-workflow/src/runtime/team-runtime.ts`
2. `apps/bata-workflow/src/runtime/task-queue.ts`
3. `apps/bata-workflow/src/runtime/control-channel.ts`
4. `apps/bata-workflow/src/runtime/event-stream.ts`
5. `apps/bata-workflow/src/tui/watch-state.ts`
6. `apps/bata-workflow/src/tui/render.ts`
7. `apps/bata-workflow/src/tui/watch.ts`
8. `apps/bata-workflow/src/team/*` 下的 role / skill / prompt / composition 相关配置与加载器
9. `apps/bata-workflow/src/cli/index.ts` 中 team command parser
10. `apps/bata-workflow/src/cli/slash-command-loader.ts` 的 team-mode 扩展

原因：

- 它们强绑定 bata-workflow 当前的 planner / dispatcher / verification / TUI；
- 这些抽象还处在高频演化阶段；
- 过早包化会把运行时与产品壳层一起冻结。

### 在实现过程中可能升格为 package 的

只有在被证明“稳定、通用、跨项目复用”后，才考虑抽成 package：

1. tmux-backed session / pane lifecycle manager
2. pane telemetry / liveness / incremental output abstraction
3. agent execution backend interface
4. 通用的 session registry / pane metadata registry
5. 通用的 multi-backend agent executor abstraction（前提是脱离 bata-workflow 也成立）

这类东西更像 `tmux-manager` 的延伸，而不是 bata-workflow 专属产品逻辑。

---

## 可执行落地切片（Phase 1-4）

这一节把前面的设计收束成真正可以开工的 implementation slices。原则不是“大重写”，而是基于当前 bata-workflow 已有骨架，按依赖链逐步补足 team mode 缺口。

依赖链应固定为：

```text
team DSL
  -> stable slot model
  -> execution target / backend router
  -> typed telemetry / watch view model
```

不要反过来做。否则容易出现：DSL 已经允许表达 slot/backend，但 runtime 根本没有稳定 slot，也没有能力把 backend 信息贯穿到 watch/TUI。

### Slice 1 / Phase 1：先打通 `/bata-workflow-team` 命令 DSL

#### 目标

让用户能在对话内用一条命令展开 team run，并把命令解析成明确的 `team run spec`。这一步的重点是“表达能力”和“输入建模”，不是一次性打通全部 backend。

#### 现有约束

当前 `apps/bata-workflow/src/cli/slash-command-loader.ts` 只能解析普通 slash alias，schema 只有：

- `action`
- `composition`
- `teamName`
- `adapter`
- `description`

因此 `/bata-workflow-team 3 2:model=gpt5.4 "goal"` 这种 DSL，不能只靠现有 slash loader 完成，必须在 CLI 主入口增加 team-mode parser。

#### 关键文件

- `apps/bata-workflow/src/cli/index.ts`
- `apps/bata-workflow/src/cli/slash-command-loader.ts`
- `apps/bata-workflow/src/domain/types.ts`
- `apps/bata-workflow/configs/slash-commands.yaml`

#### 具体改动

1. 在 `apps/bata-workflow/src/domain/types.ts` 中新增 team-mode 输入层类型：
   - `TeamRunSpec`
   - `TeamSlotSpec`
   - `TeamSlotOverride`
   - `ExecutionTargetOverride`（或等价命名）

2. 明确 `slotId` 与 `workerId` 语义分离：
   - `slotId`：用户可感知、稳定的 team 成员编号；
   - `workerId`：运行时实例编号。

3. 在 `apps/bata-workflow/src/cli/slash-command-loader.ts` 中只做“注册 + 分流”，不要把这里做成完整 DSL parser：
   - `/bata-workflow-team` 仍通过配置注册；
   - loader 只负责把这个名字路由到 team-mode parser；
   - 真正的 token 解析放在 `apps/bata-workflow/src/cli/index.ts`。

4. 在 `apps/bata-workflow/src/cli/index.ts` 中新增专门 parser，最小支持：

   ```text
   /bata-workflow-team [team-size] [slot-overrides...] "goal"
   ```

   解析规则收敛为：

   - 第一个纯数字 positional -> `teamSize`
   - `slotId:key=value` -> `slotOverrides`
   - 剩余文本 -> `goal`
   - `composition` / `teamName` 继续沿用已有 flag / slash 默认值

5. 第一版只正式支持以下 slot override key：
   - `backend`
   - `model`
   - `profile`

6. `role` override 可以先只保留在设计上，不在这一 slice 放开执行。原因是当前 runtime 还没有 worker affinity / eligibility 规则，过早支持 `2:role=reviewer` 会让 DSL 表达力超过 runtime 实际能力。

#### 这一阶段明确不做

- 不把 `team-compositions.yaml` 改造成 slot roster 配置；
- 不把 `roles.yaml` 中的 `coordinator` 直接升级成 runtime leader；
- 不要求所有 backend 真正可执行。

#### 验证点

- `/bata-workflow-team 2 "实现 timeline"` 能解析出两个 slot；
- `/bata-workflow-team 3 2:model=gpt5.4 "修复 watch"` 能解析出 slot 2 的 model override；
- 非法输入会明确失败：
  - `0:model=x`
  - `2:foo=bar`
  - 缺少 goal 的无效展开。

---

### Slice 2 / Phase 2：把匿名 worker pool 升级成稳定 slot + session seam

#### 目标

把当前 `W1/W2/...` 式匿名 worker 池，升级成“slot 稳定存在，worker 只是运行时承载”的模型。同时为 tmux-backed 真实 session 执行预留接缝。

#### 为什么必须先做这一步

当前 `apps/bata-workflow/src/runtime/task-queue.ts` 的 worker pool 是按 `taskCount` 与 `maxConcurrency` 截断生成的。这意味着：

- 用户想起 3 个 team 成员，但当前计划只有 2 个任务时，第 3 个成员会直接消失；
- `/bata-workflow-team 3 ...` 的 slot 语义无法在 runtime 中稳定存在；
- watch/TUI 也无法稳定展示“第 2 个成员到底是谁”。

#### 关键文件

- `apps/bata-workflow/src/runtime/task-queue.ts`
- `apps/bata-workflow/src/runtime/team-runtime.ts`
- `apps/bata-workflow/src/runtime/coco-adapter.ts`
- `apps/bata-workflow/src/domain/types.ts`
- `packages/tmux-manager/src/tmux-session.ts`
- `apps/bata-workflow/src/tui/watch-state.ts`

#### 具体改动

1. 扩展 `apps/bata-workflow/src/domain/types.ts` 中的 `WorkerSnapshot`，至少增加：
   - `slotId`
   - `backend`
   - `profile`
   - `sessionName`
   - `paneId`
   - `lastProgressAt`

2. 调整 `apps/bata-workflow/src/runtime/task-queue.ts`：
   - `createWorkerPool()` 不能再只根据 `taskCount` 推导 worker 数量；
   - 显式 team mode 下，worker/slot 池应来自 `TeamRunSpec.slots`；
   - `prepareForResume()` / `resetWorkerPool()` 必须保留 slot 布局，而不是恢复成新的匿名 worker 池。

3. 调整 `apps/bata-workflow/src/runtime/team-runtime.ts` 的 claim 逻辑：
   - 当前逻辑是所有 idle worker 都可以 claim 下一个 ready task；
   - 需要新增 worker eligibility / slot affinity 判断；
   - 至少要给 backend capability 留出过滤位置。

4. 调整 `apps/bata-workflow/src/runtime/coco-adapter.ts` 的执行接口，让它不再只是“一次调用拿一个最终结果”，而要为后续真实 session 留接口位置：
   - `workerContext`
   - `slotContext`
   - `onHeartbeat`
   - `onProgress`

5. 接入 `packages/tmux-manager` 时，复用 session / pane 基础设施即可：
   - create layout
   - send input
   - capture output
   - liveness check

不要让 `tmux-manager` 自带的 team 语义层反向成为 bata-workflow runtime 的真相源。

#### 验证点

- `teamSize=3`、`taskCount=2` 时，runtime snapshot 中仍保留 3 个 slot；
- resume 后 slot 不丢失；
- watch 能看到 `slotId -> workerId` 的稳定映射；
- 同一个 slot 在跨任务运行时仍然保持自身 identity。

---

### Slice 3 / Phase 3：引入 `ExecutionTarget`，把 model string 升级为 backend route

#### 目标

让系统从“任务只拿到一个 `model: string`”升级成“任务 / slot 都有明确执行目标”，从而正式支持：

- Coco backend
- Claude Code backend
- local `cc` backend

#### 为什么这一 slice 不能提前做

如果没有 Slice 2 的稳定 slot 模型，那么 `2:backend=claude-code` 这样的 DSL 就无法可靠落到某个成员上，最终只会变成 assignment 上的一段附加字符串，而不是 runtime 真正可执行的路由信息。

#### 关键文件

- `apps/bata-workflow/src/domain/types.ts`
- `apps/bata-workflow/src/role-model-config/schema.ts`
- `apps/bata-workflow/src/role-model-config/resolver.ts`
- `apps/bata-workflow/src/dispatcher/dispatcher.ts`
- `apps/bata-workflow/src/runtime/coco-adapter.ts`
- `apps/bata-workflow/src/runtime/task-queue.ts`
- `apps/bata-workflow/configs/role-models.yaml`

#### 具体改动

1. 在 `apps/bata-workflow/src/domain/types.ts` 中新增：

   ```ts
   type ExecutionBackend = 'coco' | 'claude-code' | 'local-cc'

   type ExecutionTarget = {
     backend: ExecutionBackend
     model?: string
     profile?: string
     command?: string
     transport?: 'cli' | 'pty'
     source: 'taskType' | 'skill' | 'role' | 'team' | 'slot-override' | 'fallback' | 'remediation'
     reason: string
   }
   ```

2. `DispatchAssignment`、`DispatchFallbackTarget`、`DispatchRemediationTarget` 都要开始携带 `executionTarget`，而不是只携带 `modelResolution`。

3. 在 `apps/bata-workflow/src/role-model-config/schema.ts` 中把现有配置从纯 string 升级成兼容 union：
   - 旧写法继续允许：`coding: gpt5.3-codex`
   - 新写法允许 object：`backend/model/profile/command/transport`

4. 在 `apps/bata-workflow/src/role-model-config/resolver.ts` 中保留现有优先级解析逻辑：

   ```text
   taskType -> skill -> role -> team -> global
   ```

   但返回值从“只返回 `ModelResolution`”扩展为“`ModelResolution + ExecutionTarget`”。

5. 在 `apps/bata-workflow/src/dispatcher/dispatcher.ts` 中把 fallback / remediation 也升级为 execution target 级别，而不只是替换 model。

6. 在 `apps/bata-workflow/src/runtime/coco-adapter.ts` 之上补一层 backend router：
   - 现有 Coco prompt / result 协议继续复用；
   - 新增 router 根据 `ExecutionTarget.backend` 选择 Coco / Claude Code / local cc executor；
   - run 级 adapter 不再是假定“整个 run 只有一个 backend”。

#### 兼容性策略

- `role-models.yaml` 旧格式必须继续可用；
- 旧测试不应该因为 schema 扩展而全部失效；
- `modelResolution.model` 仍可保留给 watch / report / summary 使用，但不能再作为唯一执行依据。

#### 验证点

- 旧字符串配置仍可解析；
- 新对象配置能解析出 backend + model/profile；
- fallback / remediation 可以切换 backend；
- runtime snapshot 中能看到任务的 effective execution target。

---

### Slice 4 / Phase 4：把 mailbox / event / watch 升级成结构化 telemetry

#### 目标

让 team mode 真正具备 OMC 风格的可视化基础：控制消息、协作消息、heartbeat、progress、backend 状态，都成为 runtime 内一等公民，而不是继续依赖字符串 + 正则推断。

#### 现有问题

当前 `apps/bata-workflow/src/tui/watch-state.ts` 仍依赖：

- `HANDOFF_SUMMARY_PATTERN`
- `FAILURE_MAILBOX_PATTERN`

来猜测 handoff 与 failure 语义。这在单 backend、单轮执行里还能工作，但一旦有 team slot、跨 backend、tmux session，靠字符串猜测会非常脆弱。

#### 关键文件

- `apps/bata-workflow/src/domain/types.ts`
- `apps/bata-workflow/src/runtime/task-queue.ts`
- `apps/bata-workflow/src/runtime/team-runtime.ts`
- `apps/bata-workflow/src/runtime/event-stream.ts`
- `apps/bata-workflow/src/tui/watch-state.ts`

#### 具体改动

1. 把 `MailboxMessage` 从简单文本升级成带 `kind` 的结构化消息，至少区分：
   - `command`
   - `collaboration`

2. 把 `RuntimeEvent` 从只有 `detail: string`，升级成“typed payload + detail fallback”：
   - `detail` 保留给日志兼容与终端展示；
   - 新增 payload 用于 watch/TUI 读取结构化语义。

3. 在 `WorkerSnapshot` 中补充：
   - `lastHeartbeatAt`
   - `lastProgressAt`
   - `lastMessageAt`
   - `backendStatus`
   - `overrideSource`

4. 在 `apps/bata-workflow/src/runtime/task-queue.ts` 中新增更明确的 API：
   - `appendCommandMessage(...)`
   - `appendCollaborationMessage(...)`
   - `updateWorkerHeartbeat(...)`
   - `updateWorkerProgress(...)`

5. 在 `apps/bata-workflow/src/runtime/team-runtime.ts` 中，不只记录 task claim / start / complete，还要记录：
   - assign
   - progress
   - heartbeat
   - handoff
   - review request
   - failure note

6. 在 `apps/bata-workflow/src/tui/watch-state.ts` 中把当前基于 regex 的推断降级为 fallback，优先读取结构化 telemetry，构建：
   - slot 映射视图
   - backend 状态视图
   - collaboration timeline
   - override 来源说明

#### 验证点

- watch 在没有 regex 命中的情况下仍可展示协作状态；
- event stream 既能保留文本 detail，又能承载 typed payload；
- 恢复旧 run 时，即使老快照没有新字段，也能被 normalize；
- slot/backend/override 来源都能进入 watch view model。

---

## 实现时必须复用与必须避免的边界

### 必须复用

1. `apps/bata-workflow/src/runtime/team-runtime.ts`
   - 继续作为主调度循环；
   - batch / retry / reroute / control loop 不要推倒重写。

2. `apps/bata-workflow/src/runtime/task-queue.ts`
   - 继续作为唯一可信状态中心；
   - worker / slot / mailbox / event / resume 都要收敛在这里。

3. `apps/bata-workflow/src/runtime/coco-adapter.ts`
   - 复用当前 Coco prompt 与结果提取能力；
   - 在其上扩多 backend router，而不是完全替换。

4. `apps/bata-workflow/src/tui/watch-state.ts`
   - 继续做 view-model reducer；
   - 不要把 runtime 到 UI 的聚合逻辑散落到 `render.ts`。

5. `packages/tmux-manager/src/tmux-session.ts`
   - 只复用 tmux 基础设施，不复用其中 team 语义层。

### 必须避免

1. 不要把 `workerId` 直接当成 `slotId`。
2. 不要把 `team-compositions.yaml` 强行改成 slot roster 配置。
3. 不要继续把 `modelResolution.model` 当成唯一执行路由依据。
4. 不要让 `tmux-manager/team/*` 成为 bata-workflow runtime 的主状态模型。
5. 不要让 watch 长期依赖 regex 作为协作真相源。

---

## 关键风险与前置处理

### Risk 1：claim 机制没有 worker affinity

当前 `apps/bata-workflow/src/runtime/team-runtime.ts` 中，所有 idle worker 都可以 claim 任意 ready task。这意味着如果不先补 eligibility 规则，slot/backend 配置只会停留在展示层，而不会真正影响派发。

**处理要求：** Slice 2 就必须补 worker eligibility / slot affinity 接口。

### Risk 2：worker pool 被 taskCount 截断

当前 `apps/bata-workflow/src/runtime/task-queue.ts` 中，worker pool 会被 `taskCount` 和 `maxConcurrency` 共同截断。这与显式 team size 的语义直接冲突。

**处理要求：** team mode 下，worker/slot 数量由 `TeamRunSpec.slots` 决定，而不是由任务数量推导。

### Risk 3：`GoalInput` 与 runtime 输入耦合

如果把 slot/backend/profile 等运行时概念直接塞进 `GoalInput`，会污染 planner 输入层。

**处理要求：** `GoalInput` 继续只表达 goal / targets / teamName / compositionName；team 展开参数通过独立的 `TeamRunSpec` 在 CLI -> run session -> runtime 链路中传递。

### Risk 4：`role-models.yaml` 只有 string schema

如果不做兼容 union，而是直接破坏现有 schema，旧配置和旧测试会一起碎掉。

**处理要求：** 先做 `string | object` 兼容扩展，再逐步推广 object 写法。

### Risk 5：`CocoAdapter.execute()` 只有最终结果接口

如果不尽早给执行接口加 heartbeat / progress seam，后面接 tmux session 时会被迫大改 runtime。

**处理要求：** Slice 2 就要把 callback/context 接缝补上，即使第一版 backend 仍然主要返回最终结果。

---

## 实施顺序建议

### Phase 0：确定第一战场

从以下位置开始，而不是从 package 规划开始：

1. `apps/bata-workflow/src/runtime/team-runtime.ts:123`
2. `apps/bata-workflow/src/runtime/coco-adapter.ts:1`
3. `apps/bata-workflow/src/runtime/task-queue.ts:1`
4. `apps/bata-workflow/src/cli/index.ts:302`
5. `apps/bata-workflow/src/cli/slash-command-loader.ts:5`

### Phase 1：先打通 `/bata-workflow-team` 命令 DSL 与 slot 覆写

目标：

- 注册 `/bata-workflow-team` 命令名；
- 在 CLI 中新增 team-mode parser；
- 支持 `slotId:key=value` 覆写；
- 先把解析结果转成 team run spec，但不急着一次实现全部 backend。

### Phase 2：把“逻辑 worker”升级成“真实 worker session”

目标：

- runtime 仍负责调度；
- adapter 底层通过 tmux pane / session 驱动真实 agent 执行；
- worker snapshot 开始记录 pane/session 信息。

### Phase 3：引入 `ExecutionTarget`，支持多 backend

目标：

- 从纯 `model: string` 演进为 `backend + model/profile/command`；
- 每个 slot / task 都能得到明确执行目标；
- 第一版至少打通两类 backend。

### Phase 4：扩展 runtime state 与通信模型

目标：

- mailbox 结构化
- event typed payload 化
- heartbeat / progress / last message 明确入模
- state / snapshot / event 形成统一链路

### Phase 5：升级 watch / TUI 可视化

目标：

- 真正表达 team overview
- worker detail drill-down
- slot/backend/model 映射展示
- 协作视图
- timeline 视图
- failure / reroute / intervention 展示

### Phase 6：回头识别哪些东西足够通用

只在这一阶段之后，才讨论：

- 哪些抽象值得抽到 `packages/`
- 是否要扩展 `tmux-manager`
- 是否需要新建 execution backend package

---

## 最终结论

在当前 monorepo 中，实现 Coco 式 team mode 的正确起点是：

1. **从 `apps/bata-workflow/src/runtime/team-runtime.ts` 开始**，把现有逻辑 worker runtime 升级为真实多 agent runtime；
2. **从 `apps/bata-workflow/src/cli/index.ts` 与 `slash-command-loader.ts` 开始扩出 `/bata-workflow-team` 命令 DSL**，让 team mode 能在对话中一条命令展开；
3. **通过 `apps/bata-workflow/src/runtime/coco-adapter.ts` 接入 `packages/tmux-manager/src/tmux-session.ts`**，让 tmux 成为 worker execution backend；
4. **把当前“纯 model string”升级为 `ExecutionTarget` 抽象**，以支持 Coco / Claude Code / 本地 `cc` alias 等多后端子 agent；
5. **用 `apps/bata-workflow/src/runtime/task-queue.ts` 继续作为唯一可信状态中心**，承载通信、事件、snapshot、worker telemetry 的演进；
6. **用 `apps/bata-workflow/src/tui/watch-state.ts` 和相关 TUI 文件承接可视化表达**；
7. **不要一开始就把 team mode 设计成 package 规划问题**，而是先在 app 内跑通 runtime，再在实现过程中识别真正通用的抽象。

一句话收束：

> 起点是 `apps/bata-workflow` 的 runtime 与 CLI DSL，不是 monorepo 的 package 图；`tmux-manager` 是执行后端，不是 team mode 本体；`/bata-workflow-team` 应该展开成 slot + backend + model/profile 的 team spec；package 拆分是实现结果，不是前提条件。
