# AGENTS

## Scope

These rules apply when testing or modifying the ralph skill:

- `skills/ralph/**`
- `apps/bata-workflow/tests/ralph-*.test.ts`

## Monorepo Support

Ralph 支持在 monorepo 中针对子项目运行。关键行为：

- **状态目录位置**：使用 `--path` 或 `--dir` 时，`.ralph/` 目录放在目标目录下
- **知识库位置**：`knowledge-base/` 同样放在目标目录下
- **确认/恢复**：需要从目标目录发起

### 测试模式

```bash
# 从根目录针对子项目运行
node invoke-ralph.mjs --cwd "$MONOREPO_ROOT" --path packages/app-a/design.md

# 状态文件验证位置
ls packages/app-a/.ralph/session.json
ls packages/app-a/.ralph/tasks.json
```

## E2E Testing Principles

### Isolated State Root

**CRITICAL**: Always use an isolated state root for ralph e2e tests. Never use the repo's default `.ralph` directory.

```bash
# Create isolated temp directory
export RALPH_TEST_STATE_ROOT=$(mktemp -d)

# Run ralph with isolated state
node invoke-ralph.mjs --cwd "$RALPH_TEST_STATE_ROOT" --goal "test goal"
```

### State File Verification

After each ralph invocation, verify the state files are correctly persisted:

1. **Session file**: `.ralph/session.json`
   - Must contain `sessionId`, `status`, `goal/path/dir`, `createdAt`
   - `status` must be one of: `running`, `planned`, `completed`, `partial`

2. **Tasks file**: `.ralph/tasks.json`
   - Each task must have all required fields from `TaskContractSchema`
   - Tasks must have valid `reviewContract` when using `--dir`
   - Channel must be in enhanced format (object, not string)

3. **Todo state**: `.ralph/todo-state.json`
   - Must sync with tasks status

### Testing Modes

#### Plan-Only Mode (dryRunPlan)

Use for testing task generation without agent execution:

```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "test" --dryRunPlan
```

**Verification**:
- `session.status === 'planned'`
- No agent execution logs
- Tasks have valid `reviewContract` and `acceptance`

#### Execution Mode

Use for testing full execution flow:

```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "test" --execute --stubAgent
```

**Verification**:
- Agent is invoked (check logs)
- `task.status === 'done'` or `'blocked'`
- `communicationRounds` and `validationRounds` are tracked

#### Resume Mode

Use for testing state recovery:

```bash
# First run (creates state)
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "test" --dryRunPlan

# Resume from existing state
node invoke-ralph.mjs --cwd "$TEST_DIR" --resume --execute --stubAgent
```

**Verification**:
- Tasks are recovered correctly
- Old channel format is migrated to enhanced format
- `session.resumedAt` is set

## Task Splitting Verification

### Complexity-Based Differentiation

Ralph automatically assesses the complexity of goal descriptions and adjusts task generation strategy:

#### Simple Goal (score < 4)
- **Triggers**: Short descriptions (< 50 chars), few sentences, no complexity keywords
- **Task count**: 1-2 tasks maximum
- **No analysis phase**: Implementation starts directly
- **No global validation**: Skips final regression task
- **No reviewContract**: Lighter weight processing

Example:
```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "修复登录bug" --dryRunPlan
```
Expected: 1-2 tasks, implementation + basic verification

#### Medium Goal (score 4-7)
- **Triggers**: Moderate length (50-200 chars), 2-3 sentences, some technical terms
- **Task count**: Up to 3 topics
- **Full pipeline**: Analysis → Implementation → Validation
- **With reviewContract**: Standard processing

Example:
```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "实现用户认证模块，包括登录、注册、密码重置功能" --dryRunPlan
```
Expected: 5-7 tasks, full pipeline with reviewContract

#### Complex Goal (score >= 8)
- **Triggers**: Long descriptions (> 200 chars), many sentences, complexity keywords
- **Task count**: Up to 5 topics
- **Enhanced pipeline**: Detailed analysis, fine-grained tasks
- **With reviewContract**: Comprehensive processing

Example:
```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "重构支付系统架构，需要集成第三方支付网关，优化并发性能，确保分布式事务一致性，支持多币种和退款流程" --dryRunPlan
```
Expected: 9-11 tasks, enhanced pipeline with detailed reviewContract

### Complexity Assessment Factors

| Factor | Weight | Thresholds |
|--------|--------|------------|
| Character count | 1-3 pts | >50: +1, >100: +2, >200: +3 |
| Fragment count | 1-3 pts | 2+: +1, 3+: +2, 5+: +3 |
| Complexity keywords | 2 pts | refactor, architecture, optimize, etc. |
| Technical terms | 1-2 pts | API, database, cache, queue, protocol |
| Detail indicators | 1 pt | "需要", "要求", "包括", "步骤" |

### Goal-Driven Mode

```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --goal "实现A,优化B,重构C" --dryRunPlan
```

**Expected**:
- Maximum 3 topics extracted
- Each topic generates: implementation + validation tasks
- First task is analysis phase

### Path-Driven Mode

```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --path "./docs/design.md" --dryRunPlan
```

**Expected**:
- Headings and keyPoints extracted from document
- Task count based on complexity estimation
- `sourceRefs` populated with document path

### Dir-Driven Mode (NEW)

```bash
node invoke-ralph.mjs --cwd "$TEST_DIR" --dir "./docs/design" --dryRunPlan
```

**Expected**:
- Scans up to 32 files, depth 4
- Each task has `reviewContract` with:
  - `reviewFocus.primary` - main review points
  - `riskPoints` - identified risks
  - `testRequirements` - test requirements
  - `acceptanceCriteria` - acceptance criteria

## Validation Loop Verification

### Communication Rounds

Track `task.communicationRounds` increment:

1. Coding agent executes
2. Review agent responds
3. `communicationRounds++`

### Validation Rounds

Track `task.validationRounds` increment:

1. Execute `task.verification_cmds`
2. `validationRounds++`

### Basic Rules Check

Verify basic rules are enforced:

- **basic_correctness**: No error/exception in coding output
- **no_placeholders**: No TODO/FIXME in output
- **acceptance_coverage**: Review status is 'completed' or 'pass'

### Early Stop

When `reviewResult.severity === 'critical'`:

- Task should be blocked immediately
- No further rounds should execute
- `task.history` contains 'early-stop' event

### Round Limits

Default limits:
- `maxTotalRounds = 5`
- `maxCommunicationRounds = 3`
- `maxValidationRounds = 2`

## Channel Format Migration

### Old Format (String)

```json
{
  "channel": {
    "codingToReview": "summary text...",
    "reviewToCoding": "advice text...",
    "lastUpdatedAt": "2024-01-01T00:00:00Z"
  }
}
```

### New Format (Enhanced)

```json
{
  "channel": {
    "codingToReview": {
      "summary": "...",
      "filesModified": [],
      "testsSuggested": [],
      "contextForPeer": "...",
      "risksIdentified": []
    },
    "reviewToCoding": {
      "summary": "...",
      "requiredFixes": [],
      "requiredTests": [],
      "acceptanceStatus": "partial",
      "severity": "none"
    },
    "communicationHistory": [],
    "lastUpdatedAt": "2024-01-01T00:00:00Z",
    "totalRounds": 0
  }
}
```

**Migration**: Old format is automatically converted to new format via `normalizeTasks()`.

## Common Test Patterns

### Pattern 1: Verify Task Generation

```typescript
test('should generate tasks with reviewContract', async () => {
  const result = await invokeRalph({
    cwd: testDir,
    dir: './docs/design',
    dryRunPlan: true,
    execute: false,
  })
  
  expect(result.kind).toBe('plan')
  expect(result.tasks.length).toBeGreaterThan(0)
  
  for (const task of result.tasks) {
    expect(task.reviewContract).toBeDefined()
    expect(task.reviewContract.reviewFocus).toBeDefined()
    expect(task.reviewContract.testRequirements).toBeInstanceOf(Array)
  }
})
```

### Pattern 2: Verify Channel Migration

```typescript
test('should migrate old channel format', async () => {
  // Create old format state
  await writeJson(statePaths.tasksPath, [{
    id: 'task-1',
    title: 'Test',
    status: 'pending',
    channel: {
      codingToReview: 'old string format',
      reviewToCoding: 'old advice',
      lastUpdatedAt: null,
    },
    // ... other fields
  }])
  
  // Resume and verify migration
  const result = await invokeRalph({
    cwd: testDir,
    resume: true,
    stubAgent: true,
    execute: true,
  })
  
  const task = result.tasks[0]
  expect(typeof task.channel.codingToReview).toBe('object')
  expect(task.channel.codingToReview.summary).toBe('old string format')
  expect(task.communicationRounds).toBe(0)
})
```

### Pattern 3: Verify Early Stop

```typescript
test('should early stop on critical issue', async () => {
  const result = await invokeRalph({
    cwd: testDir,
    goal: 'test',
    execute: true,
    stubAgent: true,
    runAgent: async ({ role }) => {
      if (role === 'review') {
        return {
          stdout: JSON.stringify({
            status: 'failed',
            summary: 'critical error',
            severity: 'critical',
          }),
        }
      }
      return { stdout: JSON.stringify({ status: 'completed', summary: 'ok' }) }
    },
  })
  
  const task = result.tasks[0]
  expect(task.status).toBe('blocked')
  expect(task.history.some(h => h.event === 'early-stop')).toBe(true)
})
```

## Anti-Patterns

### ❌ Don't: Use shared state directory

```bash
# WRONG: Pollutes shared state
node invoke-ralph.mjs --cwd . --goal "test"
```

### ✅ Do: Use isolated state

```bash
# RIGHT: Isolated state
node invoke-ralph.mjs --cwd "$RALPH_TEST_STATE_ROOT" --goal "test"
```

### ❌ Don't: Assume channel is string

```typescript
// WRONG: Assumes string format
const summary = task.channel.codingToReview
```

### ✅ Do: Handle both formats

```typescript
// RIGHT: Handle both formats
const summary = typeof task.channel.codingToReview === 'string'
  ? task.channel.codingToReview
  : task.channel.codingToReview.summary
```

### ❌ Don't: Skip normalizeTasks

```typescript
// WRONG: Direct JSON read without normalization
const tasks = await readJson(statePaths.tasksPath)
```

### ✅ Do: Normalize after read

```typescript
// RIGHT: Normalize to ensure migration
const tasks = await readJson(statePaths.tasksPath)
const normalized = normalizeTasks(tasks)
```

## Debug Checklist

### Issue: Tasks don't have reviewContract

1. Check if using `--dir` mode
2. Verify `generateReviewContract()` is called in `buildDirDrivenTasks()`
3. Check `insights` array is not empty

### Issue: Channel not migrated

1. Verify `normalizeTasks()` is called after state load
2. Check `migrateChannelFormat()` logic
3. Ensure task has `channel` field

### Issue: Early stop not triggered

1. Verify `reviewResult.severity === 'critical'`
2. Check `validationConfig.enableEarlyStop === true`
3. Verify `checkBasicRules()` returns `hasCriticalIssue: true`

### Issue: Round limits not enforced

1. Check `task.communicationRounds` and `task.validationRounds` are initialized
2. Verify `totalRounds >= validationConfig.maxTotalRounds` check
3. Ensure counter increments happen after each round
