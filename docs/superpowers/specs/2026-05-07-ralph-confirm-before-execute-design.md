# Ralph 强门禁确认后执行设计

## 背景

当前 Ralph 在“生成计划后是否继续执行”这一点上，行为边界不够硬，导致不同模型下体验不一致：

- 有的模型会先生成 plan，并停下来等待用户确认。
- 有的模型会在生成 plan 后直接推进到执行阶段。
- 用户有时需要输入 `/ralph 确认` 或 `/ralph --resume`，有时又会看到系统直接往下执行，心智模型不稳定。

这类不一致并不是用户需求差异，而是流程控制权部分落在当前会话模型身上。对一个负责编排任务拆解、review loop、subagent 分发的 skill 来说，这种不稳定会直接削弱可预测性和可验证性。

Superpowers 在“先拆解、确认后开始”上的稳定性更高，核心原因不是模型本身更一致，而是它把关键阶段切换做成了显式 gate：设计批准之后才能写计划，计划写完之后要明确选择执行方式，然后才进入实现。Ralph 需要把这一点工程化，而不是继续依赖模型的默认倾向。

---

## 目标

本轮设计的目标是把 Ralph 改造成 **强门禁模式**，使其在不同模型下表现一致：

1. **首次 `/ralph --goal|--path|--dir` 调用永远只生成 plan**，不得直接进入执行。
2. **只有在待确认状态下收到明确确认** 时，才允许进入执行阶段。
3. **自然语言确认可用**，用户回复 `确认`、`继续`、`开始` 即可触发执行，不要求必须再次输入 `/ralph 确认`。
4. **显式命令仍保留兜底路径**：`/ralph --resume` 仍然可以恢复执行。
5. **planning 阶段和 execution 阶段的边界可以从状态文件和日志中直接验证**。
6. **不同模型下 planning 阶段的行为一致**：首次调用必须停在 plan 输出和确认等待，不允许模型自行推进执行。

---

## 非目标

本轮不解决以下问题：

1. 不重写 Ralph 的 review loop、task splitting、knowledge base 机制。
2. 不修改 coding/review agent 的核心 prompt 结构。
3. 不在本轮引入新的命令名（例如 `/ralph-plan`、`/ralph-execute`）。
4. 不彻底重构所有 session/task 状态枚举，只做最小必要收口。
5. 不在本轮修复 agent 输出宽松解析、validation 轮次“只记录不执行”等其他质量问题。
6. 不改变 `subagent` 与 `independent` 两种 mode 的定义；本轮只约束“什么时候允许开始执行”。

---

## 核心原则

### 1. 计划与执行必须是两个阶段

`plan` 不是执行流程的前半段，而是一个必须落地并等待用户确认的独立阶段。

### 2. 用户确认是显式门禁，不是模型推断

是否开始执行，必须由以下条件共同决定：

- 当前存在待确认计划状态。
- 用户发送了明确确认短语，或显式使用 `--resume`。

不能由模型根据语气、上下文或“用户大概已经同意了”的推断来自动推进。

### 3. 确认入口应贴近自然对话

用户在看完计划后，最自然的回复是：

- `确认`
- `继续`
- `开始`

因此系统应该支持自然语言确认，而不是强迫用户重新输入 slash 命令。

### 4. 确认短语只在待确认状态下生效

`确认/继续/开始` 只有在存在待确认 Ralph plan 时才可解释为 resume 信号。离开该状态后，这些普通词语不得误触发 Ralph 执行。

### 5. 先锁入口，再谈执行质量

本轮优先把“什么时候开始执行”锁死。只有入口稳定后，后续才值得继续修正 review loop、validation loop、agent output normalization 等问题。

---

## 目标用户体验

### 场景 1：首次启动 Ralph

用户输入：

```bash
/ralph --path ./PLAN.md
```

系统行为：

1. 生成 plan
2. 持久化 `.ralph/session.json`
3. 持久化 `.ralph/tasks.json`
4. 持久化 `.ralph/confirmation-state.json`
5. 向用户展示任务预览与下一步提示
6. 立即停止

此时不得：

- 调用 coding agent
- 调用 review agent
- 写入任何 task execution 事件
- 自动进入执行循环

### 场景 2：用户自然语言确认

用户在同一会话中直接回复：

```text
确认
```

或：

```text
继续
```

或：

```text
开始
```

若当前处于待确认状态，则系统将其等价转换为 Ralph resume，开始执行。

### 场景 3：显式恢复

用户输入：

```bash
/ralph --resume
```

系统进入执行阶段。

### 场景 4：没有待确认计划时的普通对话

如果当前不存在待确认 Ralph plan，用户说：

- `确认`
- `继续`
- `开始`

这些都不能触发 Ralph 执行，只能作为普通对话输入处理。

---

## 总体方案

建议采用 **CLI + runtime 双层强门禁**。

### CLI 层职责

负责识别：

- 首次 `/ralph ...` 是“新任务启动”，只能 plan。
- 裸消息 `确认/继续/开始` 是否应该解释为 Ralph resume。
- 显式 `/ralph --resume` 是否合法。

### runtime 层职责

负责保证：

- 首次新任务调用强制落在 planning 分支。
- 计划输出统一写成待确认状态。
- 未进入 resume 之前不执行任何任务。

这种拆分能把“交互入口识别”和“状态流转执行边界”分别锁住，降低单点失稳风险。

---

## 详细设计

## 一、CLI 路由改造

目标文件：

- `apps/bata-workflow/src/cli/index.ts`

### 1. 统一确认短语集合

引入一个统一 helper，用于判断用户消息是否为明确确认：

- 中文：`确认`、`继续`、`开始`
- 英文：`confirm`、`continue`、`go`

只接受完整短语匹配，不做模糊包含，避免普通对话误触发。

暂不支持以下模糊说法：

- `好`
- `行`
- `ok`
- `可以`

原因是这些词在普通对话中过于常见，误触发风险高。

### 2. 增加待确认 Ralph 拦截器

在 CLI 主入口增加一个前置路由判断：

如果满足以下全部条件：

1. 当前输入不是 `/ralph ...`
2. 当前输入是一个明确确认短语
3. 当前工作目录存在 `.ralph/confirmation-state.json`
4. 且其中 `awaitingConfirmation === true`

则直接将本次输入重定向为 Ralph resume 调用。

这样可以实现：

- 用户回复 `确认`
- 系统自动接续 Ralph 执行

而不要求用户再次显式输入 `/ralph 确认`。

### 3. 新任务启动禁止与 resume/execute 混用

对于以下组合：

- `/ralph --path ./PLAN.md --resume`
- `/ralph --goal "..." --execute`
- `/ralph --dir ./docs --resume`

统一视为非法调用，直接报错。

原因是：

- 新任务启动和恢复执行是两个阶段
- 混用会重新引入“同一次调用到底是先 plan 还是直接 execute”的歧义

### 4. 自动恢复逻辑必须避让确认门禁

当前如果检测到 todo-state 中有未完成任务，CLI 可能会自动设置 `resume = true`。

强门禁模式下必须增加一个前置约束：

- 如果存在 `awaitingConfirmation === true`，则禁止 auto-resume
- 必须等待用户发送明确确认短语或显式 `/ralph --resume`

这一步是为了堵住“有未完成任务就自动继续”绕过确认门禁的路径。

---

## 二、runtime 改造

目标文件：

- `skills/ralph/runtime/invoke-ralph.mjs`

### 1. 首次新任务启动强制 planning-only

只要本次调用满足“新任务启动”条件（例如带 `goal/path/dir`，且不是 resume），就必须：

1. 生成 tasks
2. 持久化 session/tasks/todo-state
3. 写 confirmation-state
4. 返回 plan 结果
5. 终止

不得 fallthrough 到 execution 逻辑。

### 2. 统一 confirmation-state 语义

当前 `confirmation-state.json` 可能出现多种含义不一致的 reason，比如：

- `directory_mode_requires_confirm`
- `manual_plan_only`

本轮统一为单一语义：

```json
{
  "awaitingConfirmation": true,
  "reason": "plan_ready_waiting_user_confirmation",
  "nextAction": "回复“确认”/“继续”/“开始”，或执行 /ralph --resume 开始执行子任务"
}
```

只要 plan 已生成、执行尚未开始，就应该落在这个状态。

### 3. planning 返回结果统一 requiresConfirmation

首次 planning 返回时，应始终包含：

- `requiresConfirmation: true`
- 明确的 `confirmationPrompt`

而不是依据某个内部布尔值决定是否展示确认提示。

### 4. 执行循环只接受 resume 路径

`executeTaskLoop(...)` 只能在以下情况下触发：

1. 显式 `/ralph --resume`
2. CLI 将自然语言确认解释为 resume

普通首次启动路径不能直接进入执行。

---

## 三、状态模型约束

本轮不要求重构完整状态机，但至少要保证以下不变量：

### 1. session 文件不变量

首次 plan 完成后：

- `session.status` 应为 `planned`（本轮沿用现有枚举）
- `updatedAt` 已写入
- 不应出现执行阶段字段变化

### 2. tasks 文件不变量

首次 plan 完成后：

- 所有 task 都为 `pending`
- `history` 为空或不包含执行事件
- 不得出现 `coding-finished`、`task-completed` 等执行痕迹

### 3. log 文件不变量

首次 plan 完成后：

- 允许有 `session.start`
- 允许有 `session.planned`
- 不允许有 task execution 相关事件

---

## 四、文档改造

目标文件：

- `skills/ralph/SKILL.md`

### 需要同步更新的内容

1. 明确写清：首次 `/ralph --goal|--path|--dir` 永远只生成 plan。
2. 明确写清：执行必须等待用户确认。
3. 明确写清：合法确认方式包括：
   - `确认`
   - `继续`
   - `开始`
   - `/ralph --resume`
4. 删除或改写任何可能暗示“plan 后有时会自动继续”的文案。

文档要和实现完全一致，否则后续仍会有人按旧心智使用 Ralph。

---

## 五、测试设计

目标文件：

- `apps/bata-workflow/tests/ralph-cli-command.test.ts`
- `apps/bata-workflow/tests/ralph-skill-runtime.test.ts`

### 1. CLI 测试

至少覆盖以下场景：

#### 场景 A：首次 `/ralph --path` 只出 plan

断言：

- 返回 plan 结果
- 不进入执行

#### 场景 B：裸消息 `确认` 触发 resume

前置：存在待确认状态。

断言：

- 自动解释为 Ralph resume

#### 场景 C：裸消息 `继续` / `开始` 触发 resume

与 `确认` 等价。

#### 场景 D：没有待确认计划时，确认短语不触发 Ralph

断言：

- 不进入执行
- 不错误恢复旧 session

#### 场景 E：新任务启动与 resume/execute 混用时报错

### 2. runtime 测试

至少覆盖以下场景：

#### 场景 F：首次 planning 统一写出待确认状态

断言：

- `requiresConfirmation === true`
- `awaitingConfirmation === true`
- `reason === 'plan_ready_waiting_user_confirmation'`

#### 场景 G：planning 阶段无 task execution 事件

断言 runtime log 不含：

- `task-start`
- `task.coding.finished`
- `task.review.finished`
- `task.completed`

#### 场景 H：resume 之后才出现 task execution 事件

### 3. 跨模型回归验证

至少在 2-3 个不同模型配置下，执行同一套 planning 测试，断言以下结构性不变量：

1. 首次调用只出 plan
2. 必须等待确认
3. 不产生 task execution 事件
4. 回复 `确认/继续/开始` 后才执行

这一层验证的不是输出文案是否完全一致，而是结构性状态和事件是否一致。

---

## 验收标准

本设计落地后，必须同时满足以下条件：

1. 任意模型首次 `/ralph --goal|--path|--dir` 调用只生成 plan，不执行。
2. 生成 plan 后统一进入待确认状态。
3. 只有 `确认/继续/开始` 或 `/ralph --resume` 能触发执行。
4. 没有待确认计划时，这些确认短语不会误触发 Ralph。
5. planning 阶段 runtime log 中绝无 task-level execution 事件。
6. 新任务启动不得与 `--resume/--execute` 混用。
7. 新增 CLI 与 runtime 回归测试通过。

---

## 风险与权衡

### 风险 1：现有用户依赖 auto-resume

一部分用户可能已经习惯 Ralph 在某些情况下自动继续执行。强门禁会改变这一体验。

**处理方式：**

- 在 `SKILL.md` 中明确新语义
- CLI 输出清晰提示下一步确认方式

### 风险 2：自然语言确认可能与普通对话冲突

`继续`、`开始` 这类词如果没有状态门禁，误触发概率很高。

**处理方式：**

- 必须要求 `awaitingConfirmation === true`
- 不做模糊匹配，不支持宽松近义词

### 风险 3：CLI 和 runtime 语义再次漂移

如果只改文档不改测试，后续极易回归。

**处理方式：**

- 以状态文件和 runtime log 为验收真相
- 以回归测试守住 planning/execution 边界

---

## 分阶段实施建议

### Phase 1：入口强门禁（本轮）

1. 修改 CLI 路由
2. 修改 runtime planning 语义
3. 统一 confirmation-state
4. 更新 Ralph skill 文档
5. 补 CLI/runtime 回归测试

### Phase 2：执行质量收口（后续）

1. 收紧 `agent-output` 宽松解析
2. 修正 validation 轮次“只记录不执行”的问题
3. 明确 `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` 的 runtime 分支
4. 进一步对齐 Superpowers 的 review gate 和 subagent dispatch discipline

---

## 结论

Ralph 当前最大的不稳定源不是“某个模型太主动”，而是“计划到执行的阶段切换没有被代码彻底锁住”。本设计通过 CLI 与 runtime 双层强门禁，将首次调用固定为 planning-only，并把开始执行收敛到“待确认状态 + 明确确认信号”这一条件组合上。

这样做之后，模型差异仍然存在，但它们只能体现在文案和局部表达上，不能再决定 Ralph 是否越过 plan gate 直接开始执行。这才是让不同模型下行为稳定的关键。
