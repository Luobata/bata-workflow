---
name: writing-plans
description: Use when you have an approved spec or clear requirements for a multi-step implementation and need an execution-ready plan before editing code.
tags:
  - planning
  - tdd
  - task-decomposition
---

# Writing Plans

把规格说明转换成**可执行、可验证、低歧义**的实施计划；在输出预算紧张时，优先压缩表达方式，而不是压缩关键信息。

## 何时使用

- 用户已经有 spec、设计文档或明确目标
- 任务需要拆成多个可独立执行的步骤
- 还没开始写代码，先需要落地计划

## 核心原则

1. **压缩形式，不压缩决策信息**
   - 可以压缩：大段实现代码、重复模板、冗长解释
   - 不能压缩：文件路径、依赖顺序、验收标准、验证命令、风险说明
2. **先抽取结构，再生成计划**
   - 先整理目标、约束、里程碑、文件影响面、风险
   - 不要把原始 spec 大段改写到输出里
3. **默认高信息密度**
   - 优先使用任务摘要、接口草图、关键断言、验证命令
   - 不为每个任务重复完整 TDD 长模板
4. **先保可执行，再保完整展开**
   - 预算不足时先输出 skeleton / compact / phased plan
   - 需要时再按任务展开细节

---

## 快速开始

```bash
# 从设计文档目录生成计划
/writing-plans --dir ./docs/design

# 从单个规格文件生成计划
/writing-plans --path ./docs/spec.md

# 从目标描述生成计划
/writing-plans --goal "实现用户认证模块"

# 输出到指定文件
/writing-plans --dir ./docs/design --output ./docs/plans/implementation.md
```

## 默认工作流

1. **识别输入来源**：`--dir` / `--path` / `--goal`
2. **抽取执行上下文**：目标、约束、关键模块、测试要求、风险
3. **评估复杂度 + 输出预算**
4. **选择输出模式**：Direct / Compact / Staged
5. **生成首版计划**
6. **做计划自检**：覆盖、粒度、依赖、占位符、预算
7. **必要时切换到更保守的输出模式**，而不是继续膨胀输出

---

## 质量底线

无论使用哪种输出模式，计划都必须包含：

- ✅ 一句话目标（Goal）
- ✅ 精确文件路径
- ✅ 任务顺序与依赖关系
- ✅ 每个任务的验收标准（Acceptance）
- ✅ 每个任务的验证命令（Verification）
- ✅ 对复杂任务的阶段划分或风险提示

以下内容可以按模式裁剪：

- 可选：完整测试代码块
- 可选：完整实现代码块
- 可选：逐任务重复的 TDD 模板文本
- 可选：冗长自然语言解释

---

## 输出模式选择

### 1. Direct 模式

**适用场景**：小需求、低复杂度、预计任务数少、输出预算安全。

**特征**：

- 2-4 个任务
- 可直接给出完整任务内容
- 只在必要处给短代码片段

### 2. Compact 模式

**默认推荐模式。**

**适用场景**：大多数中等复杂度需求；希望保持计划完整，但避免输出膨胀。

**特征**：

- 保留完整任务列表、文件结构、验收和验证
- 每个任务只给一句“测试 / 实现 / 验证 / 提交”摘要
- 代码只保留**接口草图、关键断言、关键分支**
- 参考代码放入 `<details>`，或缩成 5-15 行核心片段

### 3. Staged 模式

**适用场景**：大规格、跨模块、任务数多、或预测会触发 `max_output_tokens`。

**特征**：

- 先输出计划骨架（skeleton）
- 先给 Phase Overview / Task List / File Structure
- 默认不展开每个任务的详细代码步骤
- 通过 `--expand-task` 或 `--continue` 按需继续

---

## 复杂度与预算评估

在生成前先快速评分：

| 维度 | Low | Medium | High |
|------|-----|--------|------|
| 输入长度 | < 100 字 | 100-500 字 | > 500 字 / 多文档 |
| 文件影响面 | 1-2 个文件 | 3-8 个文件 | > 8 个文件 |
| 依赖关系 | 几乎无依赖 | 单向依赖 | 多阶段/多模块依赖 |
| 测试要求 | 简单验证 | 单元测试 | 多层测试/迁移验证 |
| 架构跨度 | 局部修改 | 单模块增强 | 架构/迁移/平台级 |

### 模式判定

- **0-6 分** → Direct
- **7-10 分** → Compact
- **11-15 分** → Staged

### 强制降载信号

出现任一信号时，不继续“硬展开”，直接切换到 Compact 或 Staged：

- 预计任务数 > 8
- 原始 spec 很长或有多个文档
- 每个任务都需要完整代码示例才说得清
- 多个任务高度相似，重复代码明显
- 已经出现或高度可能出现 `max_output_tokens`

---

## 输出压缩规则（不降质）

### 1. 全局定义一次 TDD 流程，不逐任务重复

除非用户明确要求“每个任务都写完整 TDD 模板”，否则先在全局定义：

```markdown
## Standard TDD Workflow

1. 写失败测试
2. 运行确认失败
3. 写最小实现
4. 运行确认通过
5. 提交
```

然后每个任务只写：

- Test focus
- Implementation focus
- Verification
- Commit hint

### 2. 用接口草图替代完整实现

优先输出：

- 函数签名
- 输入/输出结构
- 核心断言
- 关键错误分支

不要默认输出：

- 50 行完整测试
- 100 行完整实现
- 多个任务重复的样板代码

### 3. 复用结构而不是复述内容

如果多个任务遵循同一模式，不要每个任务重讲一遍规则；只保留该任务特有的：

- 文件
- 目标
- 风险
- 验收
- 验证

### 4. 复杂任务先给骨架，再按需展开

当计划很大时，先把下面这些信息一次性给全：

- Goal
- Architecture
- Phase Overview
- Milestone Checklist
- File Structure
- Task List

然后再提示用户如何展开指定任务。

---

## 推荐输出模板

### Compact 模板（默认推荐）

```markdown
# [Feature] Implementation Plan

> For agentic workers: use ralph or subagent-driven-development to execute.

**Goal:** 一句话目标
**Architecture:** 2-3 句架构说明
**Tech Stack:** 关键技术栈
**Complexity:** Medium (8/15)

## Execution Context
- Commands default to workspace root
- Keep task order unless dependency review says otherwise

## Milestone Checklist
- [ ] Task 1: 定义接口
- [ ] Task 2: 实现核心逻辑
- [ ] Task 3: 集成与回归

## File Structure
- +`src/auth/login.ts` — 登录逻辑
- +`test/auth/login.test.ts` — 登录测试
- M`src/routes.ts` — 接入路由

## Standard TDD Workflow
1. 写失败测试
2. 运行确认失败
3. 写最小实现
4. 运行确认通过
5. 提交

## Task 1: 定义登录接口
Files: +src/auth/login.ts, +test/auth/login.test.ts
Acceptance:
- [ ] 成功返回 token
- [ ] 失败返回明确错误
Verification:
```bash
pnpm test test/auth/login.test.ts
```
Steps:
1. **测试**: 覆盖成功/失败两个主路径
2. **实现**: 定义返回结构与服务入口
3. **验证**: 运行登录测试
4. **提交**: `feat: add login contract`

<details>
<summary>参考接口</summary>

```typescript
interface LoginResult {
  success: boolean
  token?: string
  error?: string
}

async function login(input: Credentials): Promise<LoginResult>
```

</details>
```

### Staged 模板（大计划默认）

```markdown
# [Feature] Implementation Plan

**Goal:** 一句话目标
**Complexity:** Complex (13/15)
**Mode:** Staged

## Phase Overview
| Phase | Goal | Tasks | Depends On |
|------|------|-------|------------|
| P1 | 基础设施 | 3 | - |
| P2 | 核心功能 | 4 | P1 |
| P3 | 集成验证 | 2 | P2 |

## File Structure
- +`src/...`
- M`src/...`

## Task List
1.1 Task: ...
1.2 Task: ...
2.1 Task: ...

## Expansion Guide
- 展开当前阶段：`/writing-plans --expand-task 1.1-1.3 --from plan.md`
- 继续下一批：`/writing-plans --continue --from plan.md --offset 3`
```

---

## 大输出保护策略

当你预测直接完整输出会过大时，按这个顺序处理：

1. **切 Compact**：保留所有任务，但压缩代码展示
2. **切 Staged**：先骨架，后展开
3. **限制首批任务数**：优先输出前 3-5 个任务
4. **提供 continuation 指令**：告诉用户如何继续生成剩余部分

不要做的事：

- ❌ 为了省 token 删除验收标准
- ❌ 为了省 token 删除验证命令
- ❌ 用“TODO / TBD / later”代替具体内容
- ❌ 用“参考上文同模式任务”代替当前任务的关键差异

---

## 常用命令模式

```bash
# 默认生成
/writing-plans --dir ./docs/design

# 强制紧凑模式
/writing-plans --dir ./docs/design --compact

# 只生成骨架
/writing-plans --dir ./docs/design --skeleton

# 限制首批任务数量
/writing-plans --dir ./docs/design --max-tasks 5

# 从已有骨架展开指定任务
/writing-plans --expand-task 1 --from plan.md
/writing-plans --expand-task 2-4 --from plan.md

# 从上次输出继续
/writing-plans --continue --from plan.md --offset 5

# 只做审查
/writing-plans --review ./docs/plans/existing-plan.md
```

---

## 自检清单

生成计划后，至少检查下面 6 项：

1. **覆盖检查**：每条需求都能映射到任务或阶段
2. **粒度检查**：任务是否过粗或过细
3. **依赖检查**：任务顺序是否支持独立执行与验证
4. **占位符检查**：没有 TBD / TODO / vague step
5. **预算检查**：当前模式是否会继续膨胀输出
6. **执行检查**：命令是否可运行，文件路径是否精确

### 占位符扫描

```bash
grep -E "(TBD|TODO|implement later|Add appropriate)" plan.md
# 应返回空
```

### 需求映射示例

```markdown
- [ ] 需求 1 → Task 2
- [ ] 需求 2 → Task 4
- [ ] 需求 3 → Phase 3
```

---

## 审查与迭代

生成计划后，执行一轮轻量 review：

| 维度 | 要检查的问题 |
|------|--------------|
| 粒度 | 任务是否需要合并或拆分 |
| 完整性 | 是否遗漏需求或迁移步骤 |
| 可执行性 | 步骤、命令、文件是否真实可落地 |
| 依赖 | 是否先后顺序颠倒 |
| 冗余 | 是否有重复任务或重复代码块 |
| 预算 | 是否应该降到 Compact/Staged |

### 推荐处理策略

- `pass`：可直接输出
- `revise`：自动收敛粒度或切换模式后再输出
- `escalate`：需求本身冲突或规模不适合一次计划

默认最多迭代 3 轮；超过上限仍不稳定时，明确说明冲突点或建议拆分范围。

---

## 与 Ralph 集成

生成的计划优先兼容 ralph：

- `Task N` / `Task P.N` → ralph 子任务
- `Acceptance` → 验收标准
- `Verification` → 验证命令
- `Phase Overview` → 适合后续分批执行

```bash
# 生成计划
/writing-plans --dir ./docs/design --output ./plan.md

# 交给 ralph 执行
/ralph --path ./plan.md --monitor
```

---

## 红线

- **不输出占位符**：不能用 TBD/TODO 代替执行步骤
- **不跳过质量底线**：始终保留文件、验收、验证
- **不逐任务复制整套长模板**：能全局定义就不局部重复
- **不默认输出完整大段代码**：除非任务很小或用户明确要求
- **不忽略预算风险**：预测会超限时必须切到 Compact/Staged
- **不伪装完整性**：若只输出骨架，必须明确如何继续展开
