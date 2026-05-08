# Ralph 提示词增强方案

## 问题：过度代码化

当前实现中，很多判断逻辑是硬编码的，应该用 LLM 的理解能力替代。

---

## 一、复杂度评估 → 提示词

### 当前实现（过度代码化）

```javascript
// 硬编码评分
const complexityKeywords = [/重构|refactor/i, /架构|architecture/i, ...]
if (charCount > 200) score += 3
else if (charCount > 100) score += 2
```

### 建议改为提示词

```markdown
# Role: 复杂度评估专家

请评估以下需求的复杂度，返回 Simple / Medium / Complex 之一。

## 输入
{goal}

## 评估维度
1. **实现难度**: 需要多少代码？涉及多少模块？
2. **技术挑战**: 是否有架构重构、性能优化等难点？
3. **依赖关系**: 是否依赖其他系统或模块？
4. **测试要求**: 需要什么样的测试？
5. **风险程度**: 潜在风险有多少？

## 输出格式
```json
{
  "complexity": "Simple | Medium | Complex",
  "reasoning": "简要说明理由",
  "suggestedTaskCount": "建议任务数量（2-15）",
  "keyRisks": ["风险1", "风险2"]
}
```
```

---

## 二、任务拆分 → 提示词

### 当前实现（过度代码化）

```javascript
// 硬编码拆分逻辑
const maxTopics = complexity === 'simple' ? 2 : complexity === 'medium' ? 3 : 5
const tasks = fragments.slice(0, maxTopics).map(...)
```

### 建议改为提示词

```markdown
# Role: 任务拆分专家

请将以下需求拆分为可执行的任务列表。

## 需求
{requirement}

## 项目背景
{backgroundContext}

## 拆分规则
1. 每个任务 5-15 分钟可完成
2. 任务之间有明确的依赖关系
3. 每个任务有明确的验收标准
4. 遵循 TDD 流程：测试 → 实现 → 验证

## 输出格式
```json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "任务标题",
      "description": "详细描述",
      "dependencies": [],
      "acceptance": ["验收标准1", "验收标准2"],
      "estimatedMinutes": 10,
      "files": ["src/file1.ts", "test/file1.test.ts"]
    }
  ],
  "milestones": ["M1: 第一个里程碑", "M2: 第二个里程碑"],
  "totalEstimatedMinutes": 60
}
```
```

---

## 三、Review 问题检测 → 提示词

### 当前实现（过度代码化）

```javascript
// 硬编码检测逻辑
if (task.description.length < 10) return 'over_split'
if (task.description.includes('和')) return 'under_split'
```

### 建议改为提示词

```markdown
# Role: 计划审查专家

请审查以下实施计划的质量。

## 计划
{plan}

## 审查维度
1. **粒度**: 任务是否过大或过小？
2. **完整性**: 是否覆盖所有需求？
3. **可行性**: 步骤是否可执行？
4. **依赖**: 依赖关系是否合理？

## 输出格式
```json
{
  "status": "pass | revise",
  "score": 85,
  "issues": [
    {
      "type": "granularity | coverage | feasibility | dependency",
      "severity": "critical | major | minor",
      "location": "Task 3",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ],
  "summary": "总体评价"
}
```
```

---

## 四、知识发现 → 提示词

### 当前实现（过度代码化）

```javascript
// 简单字符串匹配
if (!checkRuleExists(existingRules, fix)) {
  // 生成知识条目
}
```

### 建议改为提示词

```markdown
# Role: 知识发现专家

请分析本次 Review 发现的问题，判断是否需要沉淀为知识规则。

## 已有规则
{existingRules}

## 本次发现的问题
{issues}

## 判断标准
1. **通用性**: 这个问题是否可能在其他地方重复出现？
2. **价值**: 沉淀这条规则是否能避免未来问题？
3. **独特性**: 是否与现有规则重复或相似？

## 输出格式
```json
{
  "knowledgeEntries": [
    {
      "shouldAdd": true,
      "reason": "这是一个常见的并发问题，具有通用性",
      "title": "并发安全规则",
      "description": "状态更新必须加锁",
      "category": "concurrency",
      "examples": {
        "wrong": "未加锁的状态更新",
        "right": "使用乐观锁保护"
      },
      "confidence": "high"
    }
  ]
}
```
```

---

## 五、重构建议

### 保留代码实现的部分

| 功能 | 原因 |
|------|------|
| 配置加载 | 需要可靠执行 |
| 文件读写 | 系统操作 |
| Schema 验证 | 数据完整性 |
| 状态持久化 | 可靠性要求 |
| CLI 参数解析 | 用户交互 |

### 改为提示词的部分

| 功能 | 原因 |
|------|------|
| 复杂度评估 | 需要语义理解 |
| 任务拆分 | 需要创造性和判断力 |
| Review 问题检测 | 需要上下文理解 |
| 知识发现 | 需要归纳和推理 |
| 规则生成 | 需要专业性 |

### 架构变化

```
当前架构：
┌─────────────┐
│ 配置文件    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 硬编码逻辑  │ ← 过度代码化
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Agent 执行  │
└─────────────┘

建议架构：
┌─────────────┐
│ 配置文件    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 提示词模板  │ ← 灵活、可理解
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ LLM 判断    │ ← 智能决策
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Agent 执行  │
└─────────────┘
```

---

## 六、实施优先级

| 优先级 | 改动 | 影响 |
|--------|------|------|
| P0 | 知识发现改提示词 | 提高规则质量 |
| P1 | Review 改提示词 | 更好的问题检测 |
| P2 | 任务拆分改提示词 | 更合理的拆分 |
| P3 | 复杂度评估改提示词 | 更准确的评估 |

---

## 七、示例：知识发现提示词集成

### 当前代码（保留）

```javascript
// 只负责调用 LLM 和持久化
const knowledgePrompt = buildKnowledgeDiscoveryPrompt({
  existingRules,
  issues: reviewResult.requiredFixes,
})

const knowledgeResult = await runAgent({
  role: 'knowledge-discovery',
  prompt: knowledgePrompt,
})

// 持久化结果
if (knowledgeResult.knowledgeEntries) {
  await writeToKnowledgeBase(knowledgeResult.knowledgeEntries)
}
```

### 提示词（新增）

在 `config/prompts.yaml` 中：

```yaml
roles:
  knowledge-discovery:
    instruction: 你是知识发现专家，负责分析问题并沉淀可复用规则。
    rules:
      - 只沉淀具有通用性的规则
      - 避免与现有规则重复
      - 给出清晰的错误示例和正确示例
      - 评估规则的置信度
```

---

## 八、总结

**核心原则**：
- 代码负责"怎么做"（执行、持久化、验证）
- 提示词负责"做什么"（判断、推理、创造）

**好处**：
1. 更灵活：LLM 可以理解语义
2. 更智能：LLM 可以处理新情况
3. 更易维护：修改提示词比修改代码简单
4. 更可解释：提示词比代码更容易理解
