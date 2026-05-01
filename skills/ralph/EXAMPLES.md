# Ralph Skill 使用示例

## 快速开始

### 1. 简单需求实现

```bash
# 场景：实现一个简单的计数器组件

# 步骤1：规划任务
/ralph --goal "实现一个计数器组件，支持增加、减少和重置功能"

# 输出：
# 📋 规划结果：
# - 子任务1: 需求澄清与影响面分析
# - 子任务2: 实现推进 - 实现一个计数器组件
# - 子任务3: 验证闭环 - 实现一个计数器组件
# - 子任务4: 全局回归验证与e2e检查
#
# ⏸️  等待确认：请回复"确认"或"开始"以开始执行

# 步骤2：确认执行
用户：确认

# 步骤3：查看进度
cat .ralph/TODO.md

# 输出：
# | ID | Status | Title | Deps | Review Rounds |
# | --- | --- | --- | --- | --- |
# | task-abc | done | 子任务1: 需求澄清与影响面分析 | none | 1 |
# | task-def | in_progress | 子任务2: 实现推进 | task-abc | 0 |
# ...
```

### 2. 文档驱动开发

```bash
# 场景：从技术方案文档生成实现任务

# 步骤1：准备文档
cat > docs/api-design.md << 'EOF'
# API设计文档

## 用户认证

### POST /auth/register
**输入**:
- email: string (必填，邮箱格式)
- password: string (必填，至少8位)

**输出**:
- userId: string

**验证**:
- 邮箱唯一性
- 密码强度

### POST /auth/login
**输入**:
- email: string
- password: string

**输出**:
- token: string
- expiresIn: number

**错误处理**:
- 401: 凭证错误
- 404: 用户不存在
EOF

# 步骤2：生成任务
/ralph --path docs/api-design.md

# 输出：
# 📋 从文档中提取了 6 个功能点：
# - 用户认证概述
# - POST /auth/register
# - 邮箱验证
# - 密码强度验证
# - POST /auth/login
# - 错误处理
#
# 生成了 13 个任务：
# - 1个分析任务
# - 6个实现任务
# - 6个验证任务
# - 1个全局回归任务

# 步骤3：执行并监控
/ralph --goal "实现API设计文档中的功能" --monitor

# 输出：
# 🖥️  Monitor已启动：http://127.0.0.1:3939?monitorSessionId=ralph:xxx
# ⏳ 开始执行任务...
```

### 3. 复杂功能分解

```bash
# 场景：实现一个复杂的用户权限系统

# 步骤1：描述复杂需求
/ralph --goal "实现一个基于角色的权限控制系统，支持：
1. 用户管理（CRUD）
2. 角色管理（创建、分配权限）
3. 权限检查（API级别的权限验证）
4. 审计日志（记录所有权限变更）
"

# 步骤2：查看生成的任务链
cat .ralph/tasks.json | jq 'map({id, title, phase, deps})'

# 输出：
# [
#   {
#     "id": "task-1",
#     "title": "子任务1: 需求澄清与影响面分析",
#     "phase": "analysis",
#     "deps": []
#   },
#   {
#     "id": "task-2",
#     "title": "子任务2: 实现推进 - 用户管理（CRUD）",
#     "phase": "implementation",
#     "deps": ["task-1"]
#   },
#   {
#     "id": "task-3",
#     "title": "子任务3: 验证闭环 - 用户管理（CRUD）",
#     "phase": "validation",
#     "deps": ["task-2"]
#   },
#   ...
# ]

# 步骤3：逐步执行
echo "确认" | /ralph --execute

# 步骤4：查看某个任务的详细信息
cat .ralph/tasks.json | jq '.[] | select(.id == "task-2")'

# 输出：
# {
#   "id": "task-2",
#   "title": "子任务2: 实现推进 - 用户管理（CRUD）",
#   "status": "in_progress",
#   "acceptance": [
#     "完成子目标: 用户管理（CRUD）",
#     "提交实现说明、风险与回滚点",
#     "提供可执行测试建议"
#   ],
#   "verification_cmds": ["npm test", "npm run build"],
#   "backgroundContext": "当前功能点: 用户管理（CRUD）...",
#   ...
# }
```

### 4. 断点恢复

```bash
# 场景：任务执行中断后恢复

# 步骤1：开始执行
/ralph --goal "实现三个功能：A、B、C"

# 步骤2：执行过程中被中断（网络断开、Ctrl+C等）
# ⏸️  执行中断，已完成功能A，正在执行功能B

# 步骤3：恢复执行
/ralph --resume

# 输出：
# 🔄 恢复执行：
# - 功能A: ✅ 已完成
# - 功能B: ⏳ 继续执行（之前已完成50%）
# - 功能C: ⏳ 待执行

# 步骤4：查看恢复历史
cat .ralph/tasks.json | jq '.[] | select(.history != null) | {id, history}'

# 输出：
# {
#   "id": "task-b",
#   "history": [
#     {"at": "2026-05-01T10:00:00Z", "event": "task-start"},
#     {"at": "2026-05-01T10:05:00Z", "event": "coding-finished", "round": 1},
#     {"at": "2026-05-01T10:10:00Z", "event": "resume-recover"}
#   ]
# }
```

### 5. 团队协作

```bash
# 场景：多人协作开发

# 开发者A：实现核心功能
git checkout -b feature/auth
/ralph --goal "实现用户认证核心功能"

# 完成后提交
git add .
git commit -m "feat: implement user authentication"
git push origin feature/auth

# 开发者B：拉取进度并继续
git checkout feature/auth
git pull
/ralph --resume  # 继续1个未完成的验证任务

# 开发者C：查看当前状态
cat .ralph/TODO.md

# 输出：
# | ID | Status | Title | Deps | Review Rounds |
# | task-1 | done | 实现登录功能 | none | 1 |
# | task-2 | done | 实现注册功能 | task-1 | 2 |
# | task-3 | in_progress | 验证权限控制 | task-2 | 0 |
```

## 高级用法

### 1. 自定义验证命令

```bash
# 场景：项目使用自定义的测试命令

# 方法1：修改配置文件
cat > config/verification-rules.yaml << 'EOF'
projectTypes:
  custom:
    detectors:
      - file: "Makefile"
    commands:
      verification: ["make test", "make lint"]
      e2e: ["make test-e2e"]
EOF

# 方法2：在任务中直接指定
/ralph --goal "实现功能" --verification-cmd "pytest tests/"
```

### 2. 调整模型参数

```bash
# 使用不同的模型
/ralph --goal "复杂功能实现" --model gpt-5.4-pro

# 在任务执行中动态调整
/ralph --goal "功能A" --model gpt-5.3-codex
/ralph --resume --model gpt-5.4-pro  # 后续任务使用更强的模型
```

### 3. 集成CI/CD

```yaml
# .github/workflows/ralph-ci.yml
name: Ralph CI
on: [push]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Setup Node
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run Ralph validation
        run: |
          # 验证所有任务是否符合Schema
          node skills/ralph/runtime/self-verify.mjs
          
          # 验证最近的实现是否符合规划
          /ralph --resume --dryRunPlan
```

### 4. 生成项目文档

```bash
# 场景：根据ralph的执行历史生成项目文档

# 步骤1：执行开发任务
/ralph --goal "实现完整功能" --path docs/requirements.md

# 步骤2：生成开发日志
cat .ralph/logs/runtime.jsonl | jq -s 'group_by(.data.taskId) | map({
  task: .[0].data.taskId,
  start: .[0].ts,
  end: .[-1].ts,
  events: length
})'

# 输出：
# [
#   {
#     "task": "task-1",
#     "start": "2026-05-01T10:00:00Z",
#     "end": "2026-05-01T10:05:00Z",
#     "events": 8
#   },
#   ...
# ]

# 步骤3：生成API文档（基于review建议）
cat .ralph/reviews/*.advice.md > docs/review-history.md
```

## 故障排查示例

### 问题1：任务一直blocked

```bash
# 检查review建议
cat .ralph/reviews/task-xyz.advice.md

# 输出：
# ## Required Fixes
# 1. 补充单元测试覆盖率到80%
# 2. 修复并发安全问题

# 手动修复后，标记为ready
/ralph --resume
```

### 问题2：Prompt不符合预期

```bash
# 检查生成的prompt
cat .ralph/logs/runtime.jsonl | grep "buildRolePrompt"

# 修改配置
vi config/prompts.yaml

# 清除状态重新开始
rm -rf .ralph
/ralph --goal "重新开始"
```

### 问题3：Monitor无法启动

```bash
# 检查monitor集成状态
cat .ralph/monitor-integration.json

# 输出：
# {
#   "status": "unavailable",
#   "message": "monitor runtime missing"
# }

# 解决：确保monitor skill已安装
/skill install monitor
/ralph --goal "功能实现" --monitor
```

## 最佳实践

### 1. 任务粒度控制

```bash
# ✅ 好的做法：适当的任务粒度
/ralph --goal "实现用户登录功能，支持邮箱和密码验证"

# ❌ 避免：过于宽泛
/ralph --goal "实现用户系统"

# ❌ 避免：过于细碎
/ralph --goal "实现一个函数"
```

### 2. 文档质量

```bash
# ✅ 好的文档结构
cat > docs/feature.md << 'EOF'
# 功能名称

## 背景
为什么需要这个功能

## 接口设计
- API端点
- 请求/响应格式

## 实现要点
- 关键算法
- 性能考虑
- 安全措施

## 测试计划
- 单元测试场景
- 集成测试场景
EOF

# ❌ 避免模糊的文档
cat > docs/vague.md << 'EOF'
# 实现功能
做一个好用的东西
EOF
```

### 3. 验收标准

```bash
# ✅ 具体可验证的验收标准
acceptance:
  - "API返回200状态码"
  - "响应时间<100ms"
  - "单元测试覆盖率>80%"

# ❌ 模糊的验收标准
acceptance:
  - "功能正常"
  - "性能良好"
```

## 性能优化

### 1. 并行执行

```bash
# 独立任务可以并行
/ralph --goal "实现功能A和功能B（独立）" --mode independent

# 有依赖的任务串行执行
/ralph --goal "实现功能A，然后基于A实现B" --mode subagent
```

### 2. 缓存利用

```bash
# 复用已有的规划结果
/ralph --path docs/spec.md --dryRunPlan
# 检查规划是否满意
cat .ralph/TODO.md

# 确认后再执行
echo "确认" | /ralph --resume
```

### 3. 增量开发

```bash
# 先实现核心功能
/ralph --goal "实现MVP版本"

# 后续增量添加
/ralph --goal "在MVP基础上添加高级功能"
```
