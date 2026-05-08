# Writing-Plans Token 优化方案

## 目标

在不降低计划质量的前提下，避免 `Something went wrong: invalid finish_reason: max_output_tokens`。

这里的“不降质”指的是：

- 不丢文件路径
- 不丢依赖顺序
- 不丢验收标准
- 不丢验证命令
- 不丢复杂任务的阶段结构

真正应该压缩的是：

- 重复模板
- 大段完整代码
- 冗长解释
- 多任务重复示例

---

## 为什么会超限

`max_output_tokens` 通常不是因为需求本身太复杂，而是因为输出方式太“展开”：

1. **每个任务都带完整测试代码**
2. **每个任务都带完整实现代码**
3. **每个任务都重复一整套 TDD 说明**
4. **多个相似任务重复输出相似代码**
5. **先理解 spec，又把 spec 大段复述出来**

---

## 默认决策树

```text
输入规格 → 评估复杂度与预算风险
        ├─ 低风险 → Direct
        ├─ 中风险 → Compact
        └─ 高风险 / 已触发超限 → Staged
```

### 模式定义

- **Direct**：小任务，直接给完整计划
- **Compact**：默认推荐；保留完整计划结构，但压缩代码展示
- **Staged**：先输出 skeleton，再按需展开指定任务或阶段

---

## 最有效的 4 个优化方向

### 1. 先骨架，后展开

这是收益最高的方案。

#### 第一阶段：输出骨架

先输出：

- Goal
- Architecture
- Phase Overview（如需要）
- Milestone Checklist
- File Structure
- Task List

#### 第二阶段：按需展开

再让用户继续：

```bash
/writing-plans --expand-task 1 --from plan.md
/writing-plans --expand-task 2-4 --from plan.md
```

适用场景：

- 任务数多
- 多模块
- 有阶段依赖
- 已接近 token 上限

---

### 2. 用“接口草图 + 关键断言”替代“完整代码”

**不要默认输出**：

- 50 行测试代码
- 100 行实现代码

**优先输出**：

- 函数签名
- 输入/输出结构
- 关键断言
- 关键错误分支
- 验证命令

#### 推荐写法

```markdown
## Task 1: 实现登录
Files: +src/auth/login.ts, test/auth/login.test.ts
Acceptance: 登录成功、失败有明确错误

Steps:
1. 测试：覆盖成功/失败主路径
2. 实现：定义登录入口与返回结构
3. 验证：`pnpm test test/auth/login.test.ts`

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

---

### 3. 全局定义一次 TDD 模板

如果每个任务都重复：

1. 写失败测试
2. 验证失败
3. 写最小实现
4. 验证通过
5. 提交

输出量会被重复结构吃掉。

更好的方式是先全局定义一次：

```markdown
## Standard TDD Workflow
1. 写失败测试
2. 运行确认失败
3. 写最小实现
4. 运行确认通过
5. 提交
```

然后每个任务只保留该任务的：

- Test focus
- Implementation focus
- Verification
- Commit hint

---

### 4. 分批输出，而不是一次性吐完

对于大计划，优先首批输出前 3-5 个任务，然后通过 continuation 输出剩余部分：

```bash
/writing-plans --dir ./docs --max-tasks 5
/writing-plans --continue --from plan.md --offset 5
```

这样可以保留完整计划质量，同时避免一次性超限。

---

## 质量不变时，哪些内容可以压缩

| 必须保留 | 可以压缩 |
|---------|---------|
| Goal | 冗长背景解释 |
| File Structure | 完整实现代码 |
| Acceptance | 完整测试代码 |
| Verification | 重复 TDD 文案 |
| Dependency order | 多任务相似示例 |
| Phase breakdown | spec 原文大段复述 |

---

## 模式选择建议

### Direct

适合：

- 1-3 个任务
- 单文件或单模块
- 不需要阶段拆分

### Compact

适合：

- 4-8 个任务
- 多文件改动
- 需要完整计划但不需要完整代码

### Staged

适合：

- > 8 个任务
- 多文档输入
- 架构/迁移/跨模块需求
- 已经出现 `max_output_tokens`

---

## 推荐命令模式

```bash
# 默认生成
/writing-plans --dir ./docs/design

# 强制紧凑模式
/writing-plans --dir ./docs/design --compact

# 先生成骨架
/writing-plans --dir ./docs/design --skeleton --output plan.md

# 展开指定任务
/writing-plans --expand-task 1 --from plan.md

# 限制首批任务数
/writing-plans --dir ./docs/design --max-tasks 5

# 继续输出后续任务
/writing-plans --continue --from plan.md --offset 5
```

---

## 推荐顺序

对于中大型项目，建议固定采用：

1. **先做复杂度判断**
2. **默认用 Compact**
3. **若仍有超限风险，切 Staged**
4. **先输出 skeleton**
5. **按阶段/任务展开细节**

---

## 不推荐的做法

- ❌ 删除验收标准来省 token
- ❌ 删除验证命令来省 token
- ❌ 用 “TODO / TBD / later” 代替具体步骤
- ❌ 用“参考上一个任务”代替当前任务的关键差异
- ❌ 每个任务都输出完整实现代码
- ❌ 明知会超限还坚持一次性全量展开

---

## 紧凑模板

```markdown
# [Feature] Implementation Plan

**Goal:** 一句话目标
**Architecture:** 2-3 句架构说明
**Complexity:** Medium (8/15)

## Milestone Checklist
- [ ] Task 1: 定义接口
- [ ] Task 2: 实现核心逻辑
- [ ] Task 3: 回归验证

## File Structure
- +`src/file1.ts` — 核心逻辑
- M`src/file2.ts` — 接入修改

## Standard TDD Workflow
1. 写失败测试
2. 运行确认失败
3. 写最小实现
4. 运行确认通过
5. 提交

## Task 1: [标题]
Files: +src/file1.ts, test/file1.test.ts
Acceptance:
- [ ] 验收标准 1
- [ ] 验收标准 2
Verification:
```bash
pnpm test test/file1.test.ts
```
Steps:
1. 测试：一句话
2. 实现：一句话
3. 验证：一句话

<details>
<summary>参考接口</summary>

```typescript
interface Result { success: boolean }
async function main(): Promise<Result>
```

</details>
```

---

## 一句话总结

解决 `max_output_tokens` 的最好方式不是“少规划”，而是：

**先保证计划完整性，再把表达从“全量展开”改成“结构化、分阶段、可按需展开”。**
