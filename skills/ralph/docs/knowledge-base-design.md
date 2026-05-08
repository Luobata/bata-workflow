# 知识库维护机制设计

## 概述

在 coding/review 循环中，自动发现并记录项目知识，形成可复用的规则库。

---

## 一、知识库类型

### 1. Coding 规则库（最佳实践）

**来源**：Coding Agent 在实践中发现的有效模式

**示例**：
```markdown
# 支付模块最佳实践

- 金额计算必须使用 BigInt，避免精度丢失
- 支付接口必须幂等，使用唯一请求 ID
- 敏感信息禁止打印到日志
- 超时重试必须有最大次数限制
```

### 2. Review 规则库（问题模式）

**来源**：Review Agent 发现的常见问题

**示例**：
```markdown
# 支付模块常见问题

- SQL 注入风险：金额参数未转义
- 并发问题：订单状态更新缺少锁
- 精度问题：金额使用浮点数计算
- 幂等问题：重复支付未检测
```

### 3. 业务规则库

**来源**：从需求文档和代码中提取的业务约束

**示例**：
```markdown
# 电商业务规则

## 订单
- 订单超时时间：30 分钟
- 自动取消：超时未支付
- 最大商品数量：99 件

## 支付
- 支持部分退款，最多 3 次
- 退款 > 1000 元需人工审核
- 支付方式：微信、支付宝

## 库存
- 扣减时机：支付成功后
- 回滚时机：订单取消/退款
```

### 4. 技术决策记录 (ADR)

**来源**：重要技术选型和架构决策

**示例**：
```markdown
# ADR-001: 支付系统架构选型

## 背景
需要支持微信支付和支付宝，要求高可用、幂等。

## 决策
采用消息队列 + 幂等表方案。

## 理由
1. 消息队列保证最终一致性
2. 幂等表防止重复支付
3. 支持异步回调

## 影响
- 增加消息队列依赖（RabbitMQ）
- 需要维护幂等表
- 支付延迟增加 100-500ms
```

---

## 二、知识库目录结构

```
knowledge-base/
├── coding-rules/
│   ├── typescript.md
│   ├── react.md
│   ├── api-design.md
│   └── payment.md           # 按模块划分
├── review-rules/
│   ├── security.md
│   ├── performance.md
│   └── payment-review.md
├── business-rules/
│   ├── order.md
│   ├── payment.md
│   └── inventory.md
├── adr/                     # Architecture Decision Records
│   ├── 001-payment-architecture.md
│   ├── 002-cache-strategy.md
│   └── index.md
└── README.md
```

---

## 三、自动发现机制

### 3.1 Review 阶段发现问题

**触发条件**：Review Agent 发现新类型问题

```typescript
interface KnowledgeDiscovery {
  type: 'coding_rule' | 'review_rule' | 'business_rule' | 'adr'
  trigger: 'review_finding' | 'coding_pattern' | 'user_request'
  content: {
    title: string
    description: string
    examples: Array<{
      wrong?: string
      right?: string
    }>
    relatedFiles?: string[]
  }
  confidence: 'high' | 'medium' | 'low'
  suggestedPath: string
}
```

**示例输出**：

```json
{
  "type": "review_rule",
  "trigger": "review_finding",
  "content": {
    "title": "支付金额精度问题",
    "description": "金额计算必须使用 BigInt 或 decimal 类型，避免浮点数精度丢失",
    "examples": [
      {
        "wrong": "const total = price * quantity  // 浮点数计算",
        "right": "const total = BigInt(price) * BigInt(quantity)  // BigInt 计算"
      }
    ],
    "relatedFiles": ["src/payment/calculate.ts"]
  },
  "confidence": "high",
  "suggestedPath": "knowledge-base/review-rules/payment-review.md"
}
```

### 3.2 Coding 阶段发现模式

**触发条件**：Coding Agent 使用了可复用的模式

```json
{
  "type": "coding_rule",
  "trigger": "coding_pattern",
  "content": {
    "title": "支付幂等性实现模式",
    "description": "使用唯一请求 ID + 幂等表保证支付接口幂等性",
    "examples": [
      {
        "right": "const requestId = generateUUID()\nconst exists = await checkIdempotentKey(requestId)\nif (exists) return exists.result\n// 执行支付\nawait saveIdempotentKey(requestId, result)"
      }
    ]
  },
  "confidence": "medium",
  "suggestedPath": "knowledge-base/coding-rules/payment.md"
}
```

---

## 四、知识写入流程

### 4.1 自动发现 → 用户确认

```
┌─────────────┐
│ Review 发现 │
│ 新问题模式  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 生成知识条目│
│ 建议        │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 用户确认    │
│ 添加到知识库│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 写入知识库  │
│ 更新规则文件│
└─────────────┘
```

### 4.2 用户交互

```markdown
## 🆕 发现潜在知识条目

**类型**: Review 规则
**来源**: Task 3 - 支付计算实现

### 问题
支付金额精度问题：金额计算必须使用 BigInt 或 decimal 类型

### 错误示例
```typescript
const total = price * quantity  // 浮点数计算可能丢失精度
```

### 正确示例
```typescript
const total = BigInt(price * 100) * BigInt(quantity) / 100n
```

**建议路径**: `knowledge-base/review-rules/payment-review.md`

---

是否添加到知识库？
1. ✅ 添加（推荐）
2. ✏️ 编辑后添加
3. ⏸️ 稍后处理
4. ❌ 忽略
```

---

## 五、知识应用机制

### 5.1 自动加载知识库

启动 ralph 时，自动加载知识库作为规则：

```javascript
// 加载流程
const knowledgeBase = await loadKnowledgeBase(knowledgeDir)

const ralphConfig = {
  codingRules: [
    ...defaultCodingRules,
    ...knowledgeBase.codingRules,      // 知识库规则
    ...projectConfig.codingRules,      // 项目配置
    ...cliCodingRules,                 // CLI 参数
  ],
  reviewRules: [
    ...defaultReviewRules,
    ...knowledgeBase.reviewRules,      // 知识库规则
    ...projectConfig.reviewRules,
    ...cliReviewRules,
  ],
  businessContext: knowledgeBase.businessRules,  // 业务规则
}
```

### 5.2 上下文注入

将知识库内容注入 Agent 上下文：

```markdown
# 项目知识库摘要

## 业务规则（支付模块）
- 订单超时时间：30 分钟
- 支持部分退款，最多 3 次
- 退款 > 1000 元需人工审核

## 已知问题模式
1. **金额精度问题**: 使用浮点数计算金额
   - 修复：使用 BigInt 或 decimal
2. **并发问题**: 订单状态更新缺少锁
   - 修复：使用乐观锁或分布式锁

## 最佳实践
1. **幂等性**: 支付接口使用唯一请求 ID
2. **敏感信息**: 禁止打印到日志
```

---

## 六、知识维护操作

### 6.1 CLI 命令

```bash
# 查看知识库状态
/ralph knowledge status

# 列出所有规则
/ralph knowledge list --type coding
/ralph knowledge list --type review

# 添加规则
/ralph knowledge add --type coding --content "规则内容" --file payment.md

# 从 Review 历史提取规则
/ralph knowledge extract --from .ralph/review-history.json

# 验证知识库
/ralph knowledge validate

# 清理重复/过期规则
/ralph knowledge clean
```

### 6.2 Review 后自动建议

在 Review 完成后，如果发现新问题模式，自动提示：

```markdown
## ✅ Review 完成

### 发现的问题
1. 金额精度问题 (已修复)
2. 并发安全问题 (已修复)

### 💡 知识库建议

发现 2 个新问题模式，建议添加到知识库：

1. **金额精度问题**
   - 规则: 金额计算必须使用 BigInt
   - 文件: knowledge-base/review-rules/payment.md

2. **并发安全问题**
   - 规则: 订单状态更新需加锁
   - 文件: knowledge-base/review-rules/concurrency.md

执行 `/ralph knowledge apply` 确认添加。
```

---

## 七、知识演化

### 7.1 规则版本控制

```markdown
# payment.md

## [2024-01-15] 金额精度规则
- 金额计算必须使用 BigInt 或 decimal
- 避免浮点数精度丢失
- 示例文件: src/payment/calculate.ts

## [2024-01-10] 幂等性规则
- 支付接口必须幂等
- 使用唯一请求 ID
- 示例文件: src/payment/gateway.ts

## [2024-01-05] 日志脱敏规则
- 敏感信息禁止打印到日志
- 金额需脱敏显示
- 示例文件: src/utils/logger.ts
```

### 7.2 规则评分

根据使用频率和有效性评分：

```json
{
  "rule": "金额计算必须使用 BigInt",
  "stats": {
    "appliedCount": 15,      // 应用次数
    "preventIssueCount": 3,  // 预防问题数
    "lastAppliedAt": "2024-01-15T10:30:00Z",
    "effectiveness": 0.95    // 有效性评分
  }
}
```

---

## 八、与其他系统集成

### 8.1 与 lessons-learned 集成

```
lessons-learned/       # 错误模式（临时）
       ↓ 确认有效后迁移
knowledge-base/        # 知识库（长期）
```

### 8.2 与 ralph-rules 集成

```
ralph-rules/           # 当前项目规则（强制）
       ↑ 提取自
knowledge-base/        # 知识库（建议）
```

---

## 九、实现优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | Review 发现 → 建议规则 | 最核心，价值最高 |
| P1 | 知识库加载到 Agent | 让知识生效 |
| P2 | CLI 知识管理命令 | 便于维护 |
| P3 | 规则评分系统 | 持续优化 |
| P4 | ADR 自动记录 | 架构决策 |
