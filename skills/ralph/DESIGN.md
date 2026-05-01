# Ralph Skill 设计文档

## 架构概览

Ralph是一个**协议驱动、配置驱动**的多agent编排skill，用于将复杂需求分解为可执行的子任务链，并通过coding/review循环确保质量。

## 设计原则

### 1. 分层架构

```
┌─────────────────────────────────────────────┐
│          用户调用层 (/ralph)                 │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│        运行时层 (Runtime Layer)              │
│  - invoke-ralph.mjs (协调器)                 │
│  - task-executor.mjs (任务执行)              │
│  - agent-runner.mjs (Agent调度)              │
│  - state-manager.mjs (状态持久化)            │
│  - plan-builder.mjs (任务规划)               │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│        协议层 (Protocol Layer)               │
│  - TaskContract Schema                      │
│  - AgentOutput Schema                       │
│  - SessionState Schema                      │
│  - Session/Task State Machine               │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│        配置层 (Config Layer)                 │
│  - prompts.yaml (Prompt模板)                │
│  - task-templates.yaml (任务模板)            │
│  - verification-rules.yaml (验证规则)        │
└─────────────────────────────────────────────┘
```

### 2. 协议驱动

**核心理念**：所有交互都基于明确定义的协议（Schema），而不是隐含的约定。

**TaskContract协议**：
```typescript
{
  id: string                    // 任务唯一标识
  title: string                 // 任务标题
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  phase: 'analysis' | 'implementation' | 'validation'
  deps: string[]               // 依赖任务ID
  
  // 任务契约
  acceptance: string[]         // 验收标准
  verification_cmds: string[]  // 验证命令
  deliverables: string[]       // 交付物
  scopeRules: string[]         // 范围规则
  executionHints: string[]     // 执行提示
  
  // 通信上下文
  channel: {
    codingToReview: string     // Coding → Review 上下文
    reviewToCoding: string     // Review → Coding 反馈
  }
}
```

**AgentOutput协议**：
```typescript
{
  status: 'completed' | 'needs_changes' | 'failed'
  summary: string
  suggestions: string[]
  testSuggestions: string[]
  requiredTests: string[]
  requiredFixes: string[]
  contextForPeer: string
}
```

### 3. 状态机驱动

**Session状态机**：
```
running ──┬─[dryRunPlan]──→ planned
          ├─[allTasksDone]──→ completed
          └─[hasBlocked]──→ partial
                     partial ──[allTasksDone]──→ completed
```

**Task状态机**：
```
pending ──[start]──→ in_progress ──┬─[reviewPass]──→ done
                                     └─[maxRounds]──→ blocked
                     blocked ──[resume]──→ pending
```

### 4. 配置驱动

**Prompt模板配置**：
```yaml
roles:
  coding:
    instruction: "你是 coding agent..."
    rules:
      - "严格实现当前子任务..."
      - "输出可执行的测试建议..."
  
  review:
    instruction: "你是 review agent..."
    rules:
      - "先检查是否严格满足acceptance..."
      - "检查是否过度实现（YAGNI）..."
```

**验证命令配置**：
```yaml
projectTypes:
  nodejs:
    detectors:
      - file: "package.json"
    commands:
      verification: ["npm test", "npm run build"]
      e2e: ["npm run test:e2e"]
```

## 执行流程

### 1. 规划阶段

```
用户输入: /ralph --path docs/spec.md

1. 加载配置 (prompts.yaml, verification-rules.yaml)
2. 分析文档结构
3. 提取任务点 (headings, keyPoints)
4. 生成任务链 (analysis → implementation → validation)
5. 返回规划结果 (requiresConfirmation: true)
```

### 2. 执行阶段

```
用户确认: "开始执行"

1. 加载规划状态 (.ralph/session.json, tasks.json)
2. 初始化状态机
3. 对每个任务:
   a. TaskUpdate(status: 'in_progress')
   b. 构建Prompt (从配置加载模板)
   c. 调用Coding Agent
   d. 解析AgentOutput
   e. 构建Review Prompt
   f. 调用Review Agent
   g. 如果通过 → TaskUpdate(status: 'done')
   h. 如果不通过 → 下一轮review循环
4. 返回执行结果
```

### 3. 恢复阶段

```
用户中断后恢复: /ralph --resume

1. 加载持久化状态
2. 恢复Session状态
3. 恢复Task状态 (in_progress → pending)
4. 从第一个pending任务继续执行
```

## 关键设计决策

### ADR-001: 为什么使用YAML而不是代码配置？

**背景**：需要存储Prompt模板、验证规则等配置。

**决策**：使用YAML格式。

**理由**：
1. **可读性**：非程序员也能理解和修改
2. **版本控制友好**：Git diff清晰
3. **避免重新编译**：修改配置不需要重新构建
4. **支持多行文本**：适合Prompt模板

### ADR-002: 为什么引入显式状态机？

**背景**：Task和Session的状态转换逻辑分散在代码中。

**决策**：使用显式状态机定义。

**理由**：
1. **可预测性**：状态转换规则明确
2. **可测试性**：状态机可独立测试
3. **可调试性**：状态转换有清晰的日志
4. **可扩展性**：新增状态只需修改状态机定义

### ADR-003: 为什么使用Zod Schema？

**背景**：需要验证TaskContract、AgentOutput等数据结构。

**决策**：使用Zod定义Schema。

**理由**：
1. **运行时验证**：防止无效数据
2. **类型推导**：自动生成TypeScript类型
3. **错误友好**：清晰的验证错误信息
4. **组合性**：Schema可组合和扩展

### ADR-004: 为什么分离Coding和Review Agent？

**背景**：可以让单个Agent完成所有工作。

**决策**：分离Coding和Review Agent。

**理由**：
1. **职责分离**：Coding负责实现，Review负责验证
2. **质量保证**：独立的Review避免自我验证
3. **可追溯性**：清晰的责任链
4. **可扩展性**：可以独立优化每个Agent

## 扩展点

### 1. 自定义任务模板

在`config/task-templates.yaml`中添加新的phase：

```yaml
phases:
  security_review:
    acceptanceTemplate:
      - "完成安全审查: {title}"
      - "识别安全漏洞和风险"
    deliverables:
      - "安全审查报告"
      - "漏洞修复建议"
```

### 2. 自定义验证规则

在`config/verification-rules.yaml`中添加新的项目类型：

```yaml
projectTypes:
  flutter:
    detectors:
      - file: "pubspec.yaml"
    commands:
      verification: ["flutter test"]
      e2e: ["flutter drive"]
```

### 3. 自定义Prompt策略

在`config/prompts.yaml`中添加新的角色：

```yaml
roles:
  architect:
    instruction: "你是架构师agent..."
    rules:
      - "从全局视角审视设计..."
      - "确保架构一致性..."
```

## 监控与调试

### 运行时日志

所有事件记录在`.ralph/logs/runtime.jsonl`：

```json
{"ts":"2026-05-01T12:00:00Z","event":"task.start","data":{"taskId":"task-abc"}}
{"ts":"2026-05-01T12:00:05Z","event":"task.coding.finished","data":{"taskId":"task-abc","round":1}}
{"ts":"2026-05-01T12:00:10Z","event":"task.review.finished","data":{"taskId":"task-abc","round":1}}
```

### 状态文件

- `.ralph/session.json` - 会话状态
- `.ralph/tasks.json` - 任务列表
- `.ralph/TODO.md` - 人类可读的进度
- `.ralph/checkpoints/` - 任务执行检查点
- `.ralph/reviews/` - Review建议持久化

### Monitor集成

Ralph支持与monitor skill集成：

```bash
/ralph --goal "实现功能" --monitor
```

监控面板将实时显示：
- 任务执行进度
- Agent调用次数
- Token消耗
- 错误和阻塞

## 最佳实践

### 1. 任务粒度

**推荐**：
- 每个任务1-3个验收标准
- 单个任务可在30分钟内完成
- 任务间依赖清晰

**避免**：
- 过大的任务（多个功能点）
- 过小的任务（单一函数）
- 循环依赖

### 2. 验收标准

**推荐**：
```
- "实现用户登录功能，支持邮箱和密码"
- "添加单元测试，覆盖率>80%"
- "更新API文档"
```

**避免**：
```
- "完成登录"（太模糊）
- "实现login函数，参数包括email: string, password: string, 返回Promise<User>"（过于细节）
```

### 3. 验证命令

**推荐**：
```
- "npm test"
- "npm run lint"
- "手动验证：登录成功后跳转到首页"
```

**避免**：
```
- "测试"（不明确）
- "npm run test:unit -- --coverage --reporter=html"（过于复杂）
```

## 故障排查

### 问题：任务一直blocked

**检查**：
1. Review建议是否清晰？（`.ralph/reviews/task-id.advice.md`）
2. Agent是否返回了可执行的反馈？
3. 是否达到maxReviewRounds上限？

**解决**：
- 调整验收标准，使其更具体
- 增加maxReviewRounds（默认3）
- 手动review并更新任务状态

### 问题：Prompt不符合预期

**检查**：
1. `config/prompts.yaml`中的模板是否正确？
2. 任务的phase是否正确设置？
3. 是否有phase特定的规则？

**解决**：
- 修改YAML配置文件
- 清除`.ralph`目录重新规划
- 使用`--dryRunPlan`查看生成的Prompt

### 问题：状态恢复失败

**检查**：
1. `.ralph/session.json`是否存在？
2. `.ralph/tasks.json`格式是否正确？
3. 是否有多个ralph进程同时运行？

**解决**：
- 确保`--resume`参数正确
- 检查状态文件权限
- 终止其他ralph进程

## 未来演进

### Phase 1: 智能规划
- 基于历史数据优化任务拆分
- 自动识别任务依赖关系
- 预测任务执行时间

### Phase 2: 多模型支持
- 不同任务类型使用不同模型
- 成本/质量权衡优化
- 模型能力自动匹配

### Phase 3: 团队协作
- 多人协作的任务分配
- 代码审查流程集成
- CI/CD管道集成

### Phase 4: 知识管理
- 任务执行经验积累
- 最佳实践推荐
- 代码模式库
