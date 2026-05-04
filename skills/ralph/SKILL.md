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

这会在项目目录下创建 `ralph.config.json` 配置文件，可以配置：
- **Coding Model**：Coding Agent 使用的模型
- **Review Model**：Review Agent 使用的模型
- **执行模式**：independent（独立）或 subagent（子代理）
- **最大 Review 轮次**
- **Monitor 设置**

### 2. 执行任务

```bash
# 基于目标描述
/ralph --goal "实现用户认证模块"

# 基于设计文档目录
/ralph --dir ./docs/design

# 基于单个文件
/ralph --path ./docs/plan.md
```

---

## 配置文件

项目根目录下的 `ralph.config.json`：

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
  }
}
```

**配置优先级**：命令行参数 > 项目配置文件 > 默认值

**命令行覆盖**：
```bash
/ralph --coding-model gpt-5.4-pro --review-model gpt-5.3-codex --mode subagent
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

### 1. 未解决问题记录

在 coding → review 循环中，review 发现但未解决的问题会被记录：

- **记录位置**：`.ralph/unresolved-issues-summary.json`
- **字段包括**：优先级（critical/high/medium/low）、分类、状态（open/deferred/wontfix）、延后原因
- **输出时机**：所有任务完成后，作为结果的一部分输出

### 2. Review 验收机制

**只有 review 明确通过验收才能往下走**：
- Review 状态必须为 `completed` 或 `pass`
- 所有基础规则必须通过（代码能运行、无占位符、验收标准满足）
- 不通过则继续修复循环

### 3. 错误模式沉淀

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

### 4. Monitor 启动

`--monitor` 参数现在支持在所有模式下启动：
- **规划模式**（dryRunPlan）：启动 monitor 方便用户监控规划结果
- **执行模式**：启动 monitor 实时追踪执行进度

---

## 模型配置

subagent 默认使用 `gpt-5.3-codex`。可通过 `--model` 参数覆盖，或修改 runtime 脚本中的默认值。

```bash
# 使用默认模型（gpt-5.3-codex）
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" --cwd "$PWD" --goal "..." --dryRunPlan --output json

# 指定其他模型
node "$HOME/.coco/skills/ralph/runtime/invoke-ralph.mjs" --cwd "$PWD" --goal "..." --model gpt-5.4-pro --dryRunPlan --output json
```

Agent tool 派发 subagent 时，使用 runtime 脚本输出的 `model` 字段作为 `model` 参数传入。

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
2. 调用 **Agent tool（general-purpose）** 派发 coding subagent，把 `task.title`、`task.acceptance`、`task.backgroundContext`、上游依赖摘要全部直接写入 prompt（禁止让 subagent 自己去读文件或计划）
3. 等待 coding subagent 返回，处理其状态（见下方"状态处理"）
4. coding 状态为 DONE 或 DONE_WITH_CONCERNS 后，调用 **Agent tool（general-purpose）** 派发 review subagent
5. review 通过（✅ Spec compliant）后，调用 **TaskUpdate** 将当前任务 `status` 改为 `completed`，再推进下一个任务

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
