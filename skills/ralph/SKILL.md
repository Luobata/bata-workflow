---
name: ralph
description: Use this when user invokes /ralph to decompose work into TODOs, run coding/review by separate agents, persist checkpoints, and support resume.
tags:
  - orchestration
  - subagent
  - review-loop
  - resume
---

# Ralph

`/ralph` 把需求拆成完整 TODO，controller（当前 session）直接持有所有任务，通过 Agent tool 派发 coding/review subagent 逐任务推进，支持断点恢复。

**核心原则：** controller 自己创建并管理全部 TodoWrite，不依赖子 agent 代劳。

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
