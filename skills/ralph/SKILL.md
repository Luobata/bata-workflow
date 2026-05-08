---
name: ralph
description: Use this when user invokes /ralph to decompose work into TODOs, run coding/review by separate agents, persist checkpoints, and support resume.
tags:
  - orchestration
  - subagent
  - review-loop
  - resume
  - lessons-learned
---

# Ralph

`/ralph` 把需求拆成完整 TODO，controller（当前 session）直接持有所有任务，通过 Agent tool 派发 coding/review subagent 逐任务推进，支持断点恢复。

**核心原则：** controller 自己创建并管理全部 TodoWrite，不依赖子 agent 代劳。

---

## 快速开始

### 1. 初始化配置（推荐）

```bash
/ralph init
```

这会在项目目录下创建或更新 `ralph.config.json` 配置文件。

#### 交互流程

**步骤1：检测现有配置**

读取项目目录下的 `ralph.config.json`（如果存在）。

**步骤2：配置项确认**

逐项检查配置，对于缺失或需要确认的字段进行交互式询问：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `models.coding` | string | `gpt-5.3-codex` | Coding Agent 使用的模型 |
| `models.review` | string | `gpt-5.4-pro` | Review Agent 使用的模型 |
| `mode` | string | `subagent` | 执行模式：`independent` 或 `subagent` |
| `maxReviewRounds` | number | `3` | 最大 Review 轮次 (1-10) |
| `validation.maxTotalRounds` | number | `5` | 总轮次上限 (1-20) |
| `validation.maxCommunicationRounds` | number | `3` | 通信轮次上限 |
| `validation.maxValidationRounds` | number | `2` | 校验轮次上限 |
| `validation.enableEarlyStop` | boolean | `true` | 是否启用早停 |
| `monitor.enabled` | boolean | `false` | 是否启用 Monitor |
| `monitor.autoStart` | boolean | `false` | 是否自动启动 Monitor |
| `codingRules` | string[] | `[]` | Coding 自定义规则 |
| `reviewRules` | string[] | `[]` | Review 自定义规则 |
| `backgroundContext` | string | `""` | 项目背景上下文 |
| `rulesDir` | string | `""` | 规则目录路径 |
| `knowledgeBaseDir` | string | `"knowledge-base"` | 知识库目录 |

**步骤3：处理缺失字段**

对于缺失的字段：
1. 显示字段名称、类型、默认值
2. 询问用户是否使用默认值或自定义
3. 如果是数组类型（如 `codingRules`），询问是否要添加项目

**步骤4：输出最终配置**

展示合并后的完整配置，让用户确认后写入文件。

#### 示例交互

```
╔═══════════════════════════════════════════════════════════╗
║              Ralph 配置初始化                              ║
╚═══════════════════════════════════════════════════════════╝

检测到已有配置文件：ralph.config.json

当前配置：
  models.coding: gpt-5.4-pro
  models.review: gpt-5.3-codex
  mode: subagent

缺失字段：
  ❓ codingRules (array) - Coding 自定义规则
     是否添加？[y/N] y
     输入规则（空行结束）：
     > 所有函数必须有类型注解
     > 禁止使用 any
     > 
     
  ❓ backgroundContext (string) - 项目背景
     是否添加？[y/N] n

最终配置预览：
{
  "models": {
    "coding": "gpt-5.3-codex",
    "review": "gpt-5.4-pro"
  },
  "mode": "subagent",
  "codingRules": [
    "所有函数必须有类型注解",
    "禁止使用 any"
  ]
}

确认写入？[Y/n] y
✅ 配置已保存到 ralph.config.json
```

### 2. 执行任务

**强门禁流程：** 首次 `/ralph --goal|--path|--dir` 永远只会生成 plan 并停下，不会直接开始执行。看到 plan 后，需要在待确认状态下回复 `确认` / `继续` / `开始`，或者显式执行 `/ralph --resume`，才会真正进入执行阶段。

```bash
# 基于目标描述
/ralph --goal "实现用户认证模块"

# 基于设计文档目录
/ralph --dir ./docs/design

# 基于单个文件
/ralph --path ./docs/plan.md

# 查看计划后，在同一目录继续执行
确认
# 或
/ralph --resume
```

---

## Monorepo 支持

Ralph 原生支持 monorepo 结构。当使用 `--path` 或 `--dir` 指定子目录时，状态目录和知识库会自动放在目标目录下：

### 目录结构

```bash
# 在 monorepo 根目录执行
/ralph --path packages/app-a/docs/plan.md

# 状态目录位置
packages/app-a/.ralph/           # ✅ 正确：在子项目下
├── session.json
├── tasks.json
├── reviews/
└── ...

# 知识库位置
packages/app-a/knowledge-base/   # ✅ 正确：在子项目下
├── coding-rules/
├── review-rules/
└── business-rules/
```

### 使用场景

```bash
# 场景1：从根目录启动子项目任务
cd /monorepo
/ralph --path packages/app-a/design.md

# 场景2：在子项目目录启动
cd /monorepo/packages/app-a
/ralph --path ./design.md

# 场景3：确认和恢复（需要在目标目录操作）
cd /monorepo/packages/app-a
/ralph --path ./design.md  # 先生成 plan
确认                    # 从子项目目录自然语言确认
/ralph --resume         # 或显式恢复
```

注意：自然语言 `确认` / `继续` / `开始` 只有在当前目录存在 `awaitingConfirmation === true` 的 Ralph 计划时才会生效；否则不会被解释为 Ralph 恢复指令。

### 状态目录规则

| 启动方式 | 状态目录位置 | 知识库位置 |
|---------|-------------|-----------|
| `--path ./docs/plan.md` | `./docs/.ralph/` | `./docs/knowledge-base/` |
| `--dir ./packages/app-a` | `./packages/app-a/.ralph/` | `./packages/app-a/knowledge-base/` |
| `--goal "..."` (无 path/dir) | `--cwd/.ralph/` | `--cwd/knowledge-base/` |

---

## 配置文件

项目根目录下的 `ralph.config.json`：

### 完整配置 Schema

```json
{
  "version": "1.0",
  "models": {
    "coding": "gpt-5.3-codex",
    "review": "gpt-5.4-pro"
  },
  "mode": "subagent",
  "maxReviewRounds": 3,
  "validation": {
    "maxTotalRounds": 5,
    "maxCommunicationRounds": 3,
    "maxValidationRounds": 2,
    "enableEarlyStop": true
  },
  "monitor": {
    "enabled": false,
    "autoStart": false
  },
  "codingRules": [],
  "reviewRules": [],
  "backgroundContext": "",
  "rulesDir": "",
  "knowledgeBaseDir": "knowledge-base"
}
```

### 配置字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `version` | string | 否 | `"1.0"` | 配置版本 |
| `models.coding` | string | 否 | `"gpt-5.3-codex"` | Coding Agent 模型 |
| `models.review` | string | 否 | `"gpt-5.4-pro"` | Review Agent 模型 |
| `mode` | string | 否 | `"subagent"` | 执行模式 |
| `maxReviewRounds` | number | 否 | `3` | 最大 Review 轮次 |
| `validation.maxTotalRounds` | number | 否 | `5` | 总轮次上限 |
| `validation.maxCommunicationRounds` | number | 否 | `3` | 通信轮次上限 |
| `validation.maxValidationRounds` | number | 否 | `2` | 校验轮次上限 |
| `validation.enableEarlyStop` | boolean | 否 | `true` | 启用早停 |
| `monitor.enabled` | boolean | 否 | `false` | 启用 Monitor |
| `monitor.autoStart` | boolean | 否 | `false` | 自动启动 Monitor |
| `codingRules` | string[] | 否 | `[]` | Coding 自定义规则 |
| `reviewRules` | string[] | 否 | `[]` | Review 自定义规则 |
| `backgroundContext` | string | 否 | `""` | 项目背景上下文 |
| `rulesDir` | string | 否 | `""` | 规则目录路径 |
| `knowledgeBaseDir` | string | 否 | `"knowledge-base"` | 知识库目录 |

**配置优先级**：命令行参数 > 项目配置文件 > 默认值

**命令行覆盖**：
```bash
/ralph --coding-model gpt-5.3-codex --review-model gpt-5.4-pro --mode subagent
```

---

## 配置校验

启动任务前会自动校验配置：

### 校验项

| 配置项 | 校验规则 | 错误处理 |
|--------|---------|---------|
| `models.coding` | 必须在支持列表中 | 警告 + 使用默认值 |
| `models.review` | 必须在支持列表中 | 警告 + 使用默认值 |
| `mode` | 必须是 `independent` 或 `subagent` | 警告 + 使用默认值 |
| `maxReviewRounds` | 1-10 之间的整数 | 警告 + 使用默认值 |
| `validation.maxTotalRounds` | 1-20 之间的整数 | 警告 |

### 支持的模型

```
gpt-5.3-codex    (推荐，代码能力强)
gpt-5.4-pro      (更强推理能力)
gpt-4o           (通用模型)
gpt-4-turbo
gpt-4
claude-sonnet-4
claude-sonnet-3.5
claude-opus-4
claude-3.5-sonnet
claude-3-opus
```

### 自定义模型

支持自定义模型前缀：
- `custom:<model-name>` - 自定义模型
- `local:<model-name>` - 本地模型

### 校验输出示例

```
⚠️  配置校验发现问题：

  ⚠ coding 模型 "nonexistent-model" 不在支持列表中
    → 将使用默认模型: gpt-5.3-codex
  ⚠ 执行模式 "invalid-mode" 不支持
    → 将使用默认模式: independent
```

---

## 新增功能

### 1. 用户自定义规则

Ralph 支持三种方式为 Coding 和 Review Agent 添加自定义规则：

#### 方式一：CLI 参数（优先级最高）

```bash
# 添加 coding 规则（可多次指定）
/ralph --goal "实现支付模块" \
  --coding-rule "所有金额必须使用 BigInt" \
  --coding-rule "支付接口必须幂等" \
  --coding-rule "敏感信息禁止打印日志"

# 添加 review 规则
/ralph --goal "实现支付模块" \
  --review-rule "检查 SQL 注入风险" \
  --review-rule "检查金额计算精度"

# 添加背景上下文
/ralph --goal "实现支付模块" \
  --context "这是电商后台支付系统，需对接微信支付和支付宝。支付超时30分钟，支持最多3次部分退款。"
```

#### 方式二：项目配置文件

在 `ralph.config.json` 中配置：

```json
{
  "version": "1.0",
  "codingRules": [
    "所有函数必须有明确的参数类型和返回类型",
    "禁止使用 any，使用 unknown + 类型守卫",
    "公共 API 必须有 JSDoc 注释",
    "测试覆盖率要求：核心逻辑 > 80%"
  ],
  "reviewRules": [
    "检查是否有重复代码（DRY 原则）",
    "检查函数长度是否超过 50 行",
    "检查是否有 SQL 注入风险",
    "检查是否有敏感信息硬编码"
  ],
  "backgroundContext": "这是电商后台管理系统，使用 React + TypeScript + GraphQL 技术栈。\n\n核心模块：\n- 订单管理：处理订单创建、支付、发货\n- 商品管理：商品CRUD、库存管理\n- 用户管理：权限控制、角色分配\n\n技术约束：\n- 后端 API 使用 GraphQL，需遵循 Relay 规范\n- 前端状态管理使用 Apollo Client"
}
```

#### 方式三：规则目录（推荐大型项目）

通过 `rulesDir` 指定规则目录，支持模块化管理：

**配置方式**：

```json
// ralph.config.json
{
  "rulesDir": "./ralph-rules"
}
```

**目录结构**：

```
ralph-rules/
├── coding/
│   ├── typescript.md       # TypeScript 规范
│   ├── react.md            # React 组件规范
│   ├── api-design.md       # API 设计规范
│   └── testing.md          # 测试规范
├── review/
│   ├── code-quality.md     # 代码质量审查
│   ├── security.md         # 安全审查
│   ├── performance.md      # 性能审查
│   └── maintainability.md  # 可维护性审查
└── context.md              # 项目背景（可选）
```

**规则文件格式**：

```markdown
# TypeScript 严格模式规范

- 所有函数必须有明确的参数类型和返回类型
- 禁止使用 any，使用 unknown + 类型守卫
- 优先使用 interface 而非 type
- 使用 const enum 替代静态常量对象

# React 组件规范

- 组件必须使用 FC<Props> 类型定义
- Props 必须可序列化（不能包含函数，事件除外）
- 使用 useCallback 包裹传递给子组件的回调
- 使用 useMemo 缓存计算密集型数据
```

**CLI 方式指定规则目录**：

```bash
/ralph --goal "实现支付模块" --rules-dir ./ralph-rules
```

#### 方式四：任务级配置

在 Markdown 计划文件中嵌入配置：

```markdown
<!-- ralph-config
codingRules:
  - 所有 API 必须返回统一的响应格式 { code, data, message }
  - 错误处理必须区分业务错误（code=1xx）和系统错误（code=5xx）
reviewRules:
  - 检查是否有 N+1 查询问题
  - 检查是否在大循环中使用 await
backgroundContext: |
  当前任务涉及支付流程重构，需要集成微信支付和支付宝。
  
  业务规则：
  - 支付超时时间：30分钟
  - 支持部分退款，最多 3 次
  - 退款需人工审核（金额 > 1000 元）
-->

# 支付模块实现计划

...
```

#### 优先级

```
CLI 参数 > 任务级配置 > 规则目录 > 项目配置文件 > 默认规则
```

**规则合并逻辑**：
- CLI 规则会追加到项目配置规则后
- 规则目录规则会追加到项目配置规则后
- 所有来源的规则最终合并生效

#### 规则示例库

**Coding 规则示例**：

| 场景 | 规则 |
|------|-----|
| TypeScript 严格模式 | `禁止使用 any，使用 unknown + 类型守卫` |
| React 组件规范 | `组件必须使用 FC<Props> 类型定义` |
| API 设计规范 | `所有 API 必须返回统一的响应格式 { code, data, message }` |
| 测试优先 | `先写失败测试，再写实现` |
| 文档要求 | `公共 API 必须有 JSDoc 注释` |

**Review 规则示例**：

| 场景 | 规则 |
|------|-----|
| 代码质量 | `检查函数长度是否超过 50 行` |
| 性能审查 | `检查是否有 N+1 查询问题` |
| 安全审查 | `检查是否有 SQL 注入风险` |
| 可维护性 | `检查命名是否清晰表意` |
| 测试充分性 | `检查边界条件是否有测试` |

---

### 2. 未解决问题记录

在 coding → review 循环中，review 发现但未解决的问题会被记录：

- **记录位置**：`.ralph/unresolved-issues-summary.json`
- **字段包括**：优先级（critical/high/medium/low）、分类、状态（open/deferred/wontfix）、延后原因
- **输出时机**：所有任务完成后，作为结果的一部分输出

### 3. Review 验收机制

**只有 review 明确通过验收才能往下走**：
- Review 状态必须为 `completed` 或 `pass`
- 所有基础规则必须通过（代码能运行、无占位符、验收标准满足）
- 不通过则继续修复循环

### 4. 错误模式沉淀

Review 发现问题并修复后，系统会：
1. 分析错误类型（逻辑、边界条件、类型、并发、资源、API、配置、测试、文档等）
2. 自动生成错误模式记录
3. 保存到 `.ralph/lessons-learned/` 目录

**沉淀内容**：
- 错误模式名称
- 根本原因
- 修复策略
- 预防建议
- 示例（错误做法 vs 正确做法）

### 5. Monitor 启动

`--monitor` 参数现在支持在所有模式下启动：
- **规划模式**（dryRunPlan）：启动 monitor 方便用户监控规划结果
- **执行模式**：启动 monitor 实时追踪执行进度

### 6. 知识库维护（LLM 驱动）

在 coding/review 过程中，由 LLM 自动判断问题是否值得沉淀为规则，**下次运行自动生效**。

#### 工作流程

```
Review 发现问题
       │
       ▼
┌─────────────────────┐
│ 调用 knowledge-     │
│ discovery agent     │
└──────────┬──────────┘
           │
           ▼
    LLM 判断：
    - 通用性：是否重复出现？
    - 价值：能否避免未来问题？
    - 独特性：是否与已有规则重复？
           │
           ▼
    shouldAdd: true/false
           │
     ┌─────┴─────┐
     │ true      │ false
     ▼           ▼
 自动写入      跳过
 knowledge-base/
```

#### LLM 知识发现 Prompt 示例

```markdown
# 任务：知识发现

你是一个知识发现专家。请分析以下 Review 发现的问题，判断是否需要沉淀为可复用规则。

## 已有规则
1. 所有函数必须有明确的参数类型和返回类型
2. 禁止使用 any，使用 unknown + 类型守卫

## 本次发现的问题
1. 金额计算使用了浮点数，可能导致精度丢失
2. 支付接口缺少幂等性保护

## 判断标准
- 通用性：这个问题是否可能在其他地方重复出现？
- 价值：沉淀这条规则是否能避免未来问题？
- 独特性：是否与已有规则重复或相似？

## 输出
{
  "knowledgeEntries": [
    {
      "shouldAdd": true,
      "reason": "金额精度问题是金融系统的常见陷阱",
      "title": "金额精度保护",
      "description": "金额计算必须使用 BigInt 或 decimal 类型",
      "category": "correctness",
      "confidence": "high"
    }
  ]
}
```

#### 知识库目录结构

```
knowledge-base/
├── coding-rules/        # Coding 最佳实践（自动加载）
│   └── implementation.md
├── review-rules/        # Review 问题模式（自动加载）
│   ├── correctness.md   # 按类别分类
│   ├── security.md
│   ├── performance.md
│   └── concurrency.md
├── business-rules/      # 业务规则（作为上下文加载）
│   └── payment.md
└── adr/                 # 架构决策记录
```

#### 知识文件格式（LLM 生成）

```markdown
# Knowledge Base

## [2024-01-15] 金额精度保护

- 金额计算必须使用 BigInt 或 decimal 类型，避免浮点数精度丢失

```typescript
// ❌ 错误示例
const total = price * quantity  // 浮点数计算可能丢失精度
```

```typescript
// ✅ 正确示例
const total = BigInt(price * 100) * BigInt(quantity) / 100n
```

**相关文件**: src/payment/calculate.ts

## [2024-01-14] 并发安全规则

- 状态更新必须使用锁或原子操作，避免竞态条件
...
```

#### 自动加载与使用

```bash
$ /ralph --goal "实现支付功能"
📚 加载知识库: 5 条规则 (coding: 2, review: 3, business: 0)

# 执行过程中：
# 1. Coding Agent 看到规则 "金额计算必须使用 BigInt"
# 2. 直接使用正确方式实现
# 3. Review 通过，无需修复

📝 知识库已更新: 1 条新规则写入 knowledge-base/
```

#### 配置选项

```json
// ralph.config.json
{
  "knowledgeBaseDir": "knowledge-base",  // 默认值
  "autoApplyKnowledge": true             // 是否自动写入（默认 true）
}
```

#### 规则优先级

```
知识库规则 > 项目配置规则 > CLI 规则 > 默认规则
```

---

## 模型配置

Ralph 支持为 Coding 和 Review Agent 分别指定不同的模型。

### 方式一：Subagent 配置文件（推荐）

Ralph 内置了两个专用 subagent 配置：

- **ralph-coding**: 使用 `gpt-5.3-codex`（代码生成优化）
- **ralph-review**: 使用 `gpt-5.4-pro`（更强推理审查）

调用方式：
```
@ralph-coding 实现用户登录功能
@ralph-review 审查上述实现
```

配置文件位置：`skills/ralph/.coco/agents/`

### 方式二：项目配置文件

在项目根目录创建 `ralph.config.json`：

```json
{
  "models": {
    "coding": "gpt-5.3-codex",
    "review": "gpt-5.4-pro"
  }
}
```

**注意**：项目配置仅在脚本模式下生效：

```bash
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" --cwd "$PWD" --goal "..."
```

### 方式三：命令行参数

```bash
node invoke-ralph.mjs --coding-model gpt-5.3-codex --review-model gpt-5.4-pro --goal "..."
```

### 优先级

```
命令行参数 > 项目配置文件 > Subagent 配置文件 > 默认值
```

### 支持的模型

| 模型 | 适用场景 |
|------|---------|
| gpt-5.3-codex | 代码生成（默认 coding） |
| gpt-5.4-pro | 代码审查、复杂推理（默认 review） |
| kimi-k2 | 长上下文任务 |
| claude-sonnet-4 | 通用代码任务 |

---

## 执行流程

### 第一步：生成计划（一次性）

运行 runtime 脚本拿到任务列表：

```bash
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" \
  --cwd "$PWD" --goal "${USER_INPUT}" --mode independent --dryRunPlan --output json
```

当用户提供目录/文件路径时：

```bash
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" \
  --cwd "$PWD" --path "${USER_INPUT}" --mode subagent --dryRunPlan --output json
```

读取返回 JSON 的 `tasks` 数组后，**必须严格按以下顺序操作，不得跳步：**

**⚠️ 禁止在 TaskCreate 完成之前开始任何任务执行。**

1. 遍历 `tasks` 数组，对每一项调用 **TaskCreate**，`status` 设为 `pending`
2. 所有 TaskCreate 完成后，向用户展示完整任务列表
3. 等待用户说"确认"或"开始"后，才进入第二步

此时用户在 coco 界面可看到全部子任务，状态均为 pending。

### 第二步：逐任务执行

**每个任务必须严格按以下 5 步执行，不得合并或跳过：**

1. 调用 **TaskUpdate**，将当前任务 `status` 改为 `in_progress`（用户此时能看到哪个任务正在执行）
2. 调用 **@ralph-coding** 派发 coding subagent，把 `task.title`、`task.acceptance`、`task.backgroundContext`、上游依赖摘要全部直接写入 prompt（禁止让 subagent 自己去读文件或计划）
3. 等待 coding subagent 返回，处理其状态（见下方"状态处理"）
4. coding 状态为 DONE 或 DONE_WITH_CONCERNS 后，调用 **@ralph-review** 派发 review subagent
5. review 通过（✅ Spec compliant）后，调用 **TaskUpdate** 将当前任务 `status` 改为 `completed`，再推进下一个任务

**模型分离说明**：
- `@ralph-coding` 使用 `gpt-5.3-codex`（代码生成优化）
- `@ralph-review` 使用 `gpt-5.4-pro`（更强推理审查）

如需使用其他模型，可通过 `ralph.config.json` 或命令行参数覆盖。

### 第三步：全部完成后

所有任务 completed 后，可选择运行最终持久化收尾（不会重新触发执行）：

```bash
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" \
  --cwd "$PWD" --resume --output json
```

---

## ⚠️ Runtime 脚本执行模式说明

脚本有三种调用方式，**不加任何执行标志时默认只规划，不执行**：

| 命令 | 行为 |
|------|------|
| `--dryRunPlan` 或不加标志 | 只生成任务列表，不执行任何 agent，输出 JSON 后退出 |
| `--resume` | 从已有断点恢复，继续未完成任务（会真正执行 agent） |
| `--execute` | 强制从头执行（通常不用，由 controller 接管执行逻辑） |

**controller（当前 session）负责执行循环，不应让 runtime 脚本替代 controller 跑 agent。**

## Coding Subagent Prompt 模板

```
你正在实现子任务：[任务标题]

## 任务描述

[把 task.acceptance + task.backgroundContext 全文粘贴在这里，不让 subagent 自己读文件]

## 验收标准

[task.acceptance 列表]

## 验证命令

[task.verification_cmds 列表]

## 上下文

[上游任务摘要、架构背景、依赖关系]

## 你的工作

1. 严格实现当前任务，不跨任务、不额外扩展
2. 写测试（遵循 TDD）
3. 运行验证命令确认通过
4. commit 你的改动
5. 自审后上报

## 自审清单

- 完整覆盖了所有验收标准？
- 没有过度实现（YAGNI）？
- 测试真正验证了行为，不是 mock？

## 上报格式

status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
summary: 实现了什么
files_changed: [文件列表]
concerns: 如有疑虑列在这里
```

---

## Review Subagent Prompt 模板

```
你在审查子任务的实现是否符合规格。

## 原始要求

[task.acceptance 全文]

## 实现者声称完成了什么

[coding subagent 的 summary + files_changed]

## 关键：不要信任报告

必须自己读代码，逐条对照验收标准核实。

检查：
- 是否实现了全部要求的内容？
- 是否有未请求的额外实现？
- 是否存在误解规格的情况？

上报：
- ✅ Spec compliant
- ❌ Issues: [具体缺失/多余内容，附 file:line]
```

---

## 状态处理

**DONE：** 进入 review 流程。

**DONE_WITH_CONCERNS：** 先读 concerns，若涉及正确性先处理，再进 review。

**NEEDS_CONTEXT：** 提供缺失上下文，重新派发同任务。

**BLOCKED：**
1. 补充上下文后重派 → 若仍 BLOCKED
2. 换更强模型重派 → 若仍 BLOCKED
3. 拆分任务 → 若无法拆分
4. 暂停并告知用户，等待人工介入

**永远不要：** 忽略 escalation / 强迫同一 subagent 无变化重试。

---

## Review 循环规则

- spec review ❌ → coding subagent 修复 → 重新 spec review
- spec review ✅ 后才能进 code quality review
- 任何一轮 review 有未修复问题 → 不能 TaskUpdate completed
- 最多 3 轮 review，仍 BLOCKED 则暂停报告用户

---

## 断点恢复

执行被中断后，用户可以继续：

```bash
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" \
  --cwd "$PWD" --resume --output json
```

读取返回的 tasks，找出 `status != "done"` 的任务，从第一个 pending 任务继续执行第二步。

---

## 红线

- **不在 main/master 分支直接开始实现**，先用 git worktree 隔离
- **不让 subagent 自己读计划文件**，controller 提供全文
- **不跳过 spec review 直接进 code quality review**
- **不同时派发多个 coding subagent**（会产生冲突）
- **不接受"差不多"通过 spec review**（发现问题 = 未完成）
- **TodoWrite 由 controller 自己操作**，不依赖 subagent 代劳

---

## 与其他 skill 的配合

- **using-git-worktrees**：开始前必须隔离工作区
- **writing-plans**：为 ralph 提供更精确的计划输入
- **requesting-code-review**：code quality review 阶段使用
- **finishing-a-development-branch**：全部任务完成后收尾
