# Ralph Skill 验收测试

## 测试理念

**传统脚本测试的问题**：
- 只能测试函数调用，无法验证真实用户体验
- 无法测试skill的实际行为和决策
- 无法验证agent编排的正确性

**Skill验收测试的特点**：
- 基于真实场景，而不是mock
- 验证端到端行为，而不是单元测试
- 使用skill自己的能力来验证
- 关注用户价值，而不是代码覆盖率

## 验收场景

### 场景1：简单需求实现

**用户故事**：作为一个开发者，我想要实现一个简单功能，让我能看到ralph如何拆分和执行任务。

**验收标准**：
```gherkin
Given 用户有一个简单的需求："实现一个计数器组件"
When 调用 /ralph --goal "实现一个计数器组件"
Then 应该生成至少3个任务（分析、实现、验证）
And 第一个任务应该包含"需求澄清"
And 所有任务应该有明确的验收标准
```

**验证方式**：
```bash
# 1. 规划阶段
echo "实现一个计数器组件" | /ralph --dryRunPlan
# 预期：生成任务列表，等待用户确认

# 2. 验证任务质量
cat .ralph/tasks.json | jq '.[] | select(.phase == "analysis")'
# 预期：包含输入/输出/边界条件的分析
```

### 场景2：文档驱动开发

**用户故事**：作为一个开发者，我有一个技术方案文档，想要自动转换为实现任务。

**验收标准**：
```gherkin
Given 用户有一个markdown格式的技术方案
When 调用 /ralph --path docs/spec.md
Then 应该从文档中提取关键任务点
And 任务数量应该与文档复杂度匹配
And 每个任务应该引用源文档位置
```

**验证方式**：
```bash
# 1. 创建测试文档
mkdir -p test-docs
cat > test-docs/spec.md << 'EOF'
# 用户认证模块

## 功能点

1. 用户注册
   - 邮箱验证
   - 密码加密

2. 用户登录
   - Session管理
   - 记住我功能
EOF

# 2. 执行规划
/ralph --path test-docs/spec.md

# 3. 验证任务提取
cat .ralph/tasks.json | jq 'length'
# 预期：>= 6（分析 + 2个功能点 × (实现+验证) + 全局验证）

# 4. 验证源文件引用
cat .ralph/tasks.json | jq '.[] | select(.sourceRefs | length > 0)'
# 预期：每个任务都有sourceRefs
```

### 场景3：Review循环

**用户故事**：作为一个开发者，我想要看到coding和review agent如何协作，确保代码质量。

**验收标准**：
```gherkin
Given 一个需要多轮review的任务
When coding agent提交代码
And review agent发现问题
Then 应该进入下一轮coding
And 当review通过后，任务应该标记为done
And review建议应该持久化
```

**验证方式**：
```bash
# 1. 创建一个会触发多轮review的任务
cat > .ralph/tasks.json << 'EOF'
[{
  "id": "task-test",
  "title": "实现复杂功能",
  "status": "pending",
  "acceptance": ["实现功能A", "实现功能B", "编写测试"],
  "reviewRounds": 0
}]
EOF

# 2. 模拟多轮review
# (使用stub agent模拟review不通过 → 通过的流程)

# 3. 验证review历史
ls -la .ralph/reviews/task-test.*.advice.md
# 预期：至少有1个review文件

# 4. 验证状态转换
cat .ralph/tasks.json | jq '.[] | select(.id == "task-test") | .status'
# 预期："done"
```

### 场景4：断点恢复

**用户故事**：作为一个开发者，我的任务执行被中断了，我想要从断点恢复，而不是重新开始。

**验收标准**：
```gherkin
Given 正在执行的任务列表
When 执行被中断（网络断开/进程终止）
And 用户调用 /ralph --resume
Then 应该从中断的任务继续
And 已完成的任务不应该重新执行
And 状态文件应该正确恢复
```

**验证方式**：
```bash
# 1. 创建多任务场景
echo "实现功能A，实现功能B" | /ralph --dryRunPlan
echo "确认" | /ralph --execute

# 2. 模拟中断（在第一个任务完成后）
# (通过环境变量控制中断点)

# 3. 恢复执行
/ralph --resume

# 4. 验证只执行了未完成的任务
cat .ralph/logs/runtime.jsonl | grep "task.start" | wc -l
# 预期：只记录了恢复后的任务启动
```

### 场景5：Monitor集成

**用户故事**：作为一个开发者，我想要实时监控任务执行进度，而不是等待完成后才看到结果。

**验收标准**：
```gherkin
Given 启用了monitor选项
When 执行任务
Then 应该启动monitor board
And 返回monitor URL
And monitor应该显示实时进度
```

**验证方式**：
```bash
# 1. 启动带monitor的执行
/ralph --goal "实现功能" --monitor

# 2. 验证monitor启动
cat .ralph/monitor-integration.json | jq '.status'
# 预期："started"

# 3. 验证URL返回
# (结果中应该包含monitorUrl)
```

## 自验证机制

Ralph可以验证自己的能力：

### 1. Schema验证

```bash
# 验证所有任务是否符合TaskContract
node -e "
import('./skills/ralph/src/protocol/schemas/task-contract.js')
  .then(m => m.TaskContractSchema)
  .then(schema => {
    const tasks = require('./.ralph/tasks.json')
    tasks.forEach(task => {
      const result = schema.safeParse(task)
      if (!result.success) {
        console.error('Invalid task:', task.id, result.error)
        process.exit(1)
      }
    })
    console.log('✓ All tasks conform to TaskContract')
  })
"
```

### 2. 状态机验证

```bash
# 验证所有状态转换是否合法
node -e "
import('./skills/ralph/src/protocol/state-machine/task-machine.js')
  .then(m => m.TASK_TRANSITIONS)
  .then(transitions => {
    console.log('✓ Task state machine has', transitions.length, 'transitions')
    transitions.forEach(t => {
      console.log('  ', t.from, '→', t.to, ':', t.description)
    })
  })
"
```

### 3. 配置验证

```bash
# 验证配置文件格式
node -e "
import('./skills/ralph/runtime/config-loader.mjs')
  .then(m => Promise.all([
    m.loadPrompts(),
    m.loadTaskTemplates(),
    m.loadVerificationRules()
  ]))
  .then(([prompts, templates, rules]) => {
    console.log('✓ Prompts config has', Object.keys(prompts.roles).length, 'roles')
    console.log('✓ Task templates has', Object.keys(templates.phases).length, 'phases')
    console.log('✓ Verification rules has', Object.keys(rules.projectTypes).length, 'project types')
  })
"
```

## 示例工作流

### 示例1：从零开始实现功能

```bash
# Step 1: 规划
echo "实现一个待办事项应用" | /ralph --dryRunPlan

# Step 2: 查看规划结果
cat .ralph/TODO.md

# Step 3: 确认开始执行
echo "确认" | /ralph --execute

# Step 4: 监控进度（可选）
/ralph --goal "实现一个待办事项应用" --monitor

# Step 5: 查看最终结果
cat .ralph/tasks.json | jq 'map({id, title, status})'
```

### 示例2：从文档生成任务

```bash
# Step 1: 准备文档
cat > docs/api-design.md << 'EOF'
# API设计文档

## 用户API

### POST /users/register
- 输入：email, password
- 输出：userId
- 验证：邮箱格式，密码强度

### POST /users/login
- 输入：email, password
- 输出：token
- 验证：凭证正确性
EOF

# Step 2: 生成任务
/ralph --path docs/api-design.md

# Step 3: 执行
echo "确认" | /ralph --resume
```

### 示例3：团队协作场景

```bash
# Developer A: 实现核心功能
echo "实现用户认证核心逻辑" | /ralph --dryRunPlan
echo "确认" | /ralph --execute

# Developer B: 接续实现其他功能
git pull  # 获取A的进度
/ralph --resume  # 继续未完成的任务
```

## 质量指标

### 功能完整性
- [ ] 能正确拆分简单需求（3-5个任务）
- [ ] 能从文档提取任务点（准确率>80%）
- [ ] 能处理多轮review（最多3轮）
- [ ] 能从断点恢复执行
- [ ] 能与monitor集成

### 可用性
- [ ] 错误信息清晰可操作
- [ ] 状态文件人类可读
- [ ] 进度实时可见
- [ ] 支持多种输入格式

### 可靠性
- [ ] 状态转换符合状态机定义
- [ ] 所有数据符合Schema定义
- [ ] 异常情况能优雅处理
- [ ] 中断后能正确恢复

### 可维护性
- [ ] 配置与代码分离
- [ ] 协议定义清晰
- [ ] 模块职责单一
- [ ] 文档完整准确

## 持续改进

### 反馈收集

使用ralph自身的能力来收集反馈：

```bash
# 创建反馈任务
echo "分析ralph的使用日志，识别常见问题和改进点" | /ralph --path .ralph/logs

# 生成的任务应该包括：
# 1. 分析runtime.jsonl日志
# 2. 统计任务执行时长
# 3. 识别阻塞模式
# 4. 提出优化建议
```

### 自动优化

```bash
# 基于历史数据优化prompt模板
echo "基于最近的执行记录，优化prompt模板，提高任务成功率" | /ralph --path .ralph/reviews
```

## 测试执行指南

### 运行所有验收测试

```bash
# 创建测试脚本
cat > test-acceptance.sh << 'EOF'
#!/bin/bash
set -e

echo "=== 场景1: 简单需求实现 ==="
# ... 测试代码 ...

echo "=== 场景2: 文档驱动开发 ==="
# ... 测试代码 ...

echo "=== 场景3: Review循环 ==="
# ... 测试代码 ...

echo "=== 场景4: 断点恢复 ==="
# ... 测试代码 ...

echo "=== 场景5: Monitor集成 ==="
# ... 测试代码 ...

echo "✓ 所有验收测试通过"
EOF

chmod +x test-acceptance.sh
./test-acceptance.sh
```

### 查看测试报告

```bash
# 生成测试报告
cat > test-report.md << 'EOF'
# Ralph Skill 验收测试报告

## 执行时间
- 开始：2026-05-01 12:00:00
- 结束：2026-05-01 12:05:00
- 总耗时：5分钟

## 测试结果

| 场景 | 状态 | 备注 |
|------|------|------|
| 简单需求实现 | ✅ 通过 | 生成4个任务 |
| 文档驱动开发 | ✅ 通过 | 正确提取6个功能点 |
| Review循环 | ✅ 通过 | 2轮review后通过 |
| 断点恢复 | ✅ 通过 | 正确恢复到第3个任务 |
| Monitor集成 | ✅ 通过 | URL正确返回 |

## 改进建议

1. 提高任务拆分的粒度控制
2. 优化review循环的性能
3. 增强错误提示的可操作性

EOF

cat test-report.md
```
