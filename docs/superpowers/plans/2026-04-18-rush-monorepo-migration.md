# Rush Monorepo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 `harness` 单包仓库迁移成 Rush monorepo，并把外部 `tmux-manager` 迁入为 `packages/tmux-manager` 子项目，同时保留 `harness` 的 CLI / 测试能力。

**Architecture:** 先把当前应用整体下沉到 `apps/harness`，再在仓库根建立 Rush + pnpm workspace 配置，最后把 `tmux-manager` 迁入并通过 workspace 依赖挂到 `harness` 上。路径敏感逻辑统一收敛到一个新的 monorepo 路径解析模块，确保 `configs/` 在应用包内、`.harness/state` 在仓库根、`docs/` 和 `.claude/` 仍可从 monorepo 根被解析。

**Tech Stack:** Rush 5.175.0、pnpm 9.15.9、TypeScript、Vitest、Node.js 22、现有 `harness` CLI/runtime/test 体系。

---

## File Structure

- Create: `apps/harness/`
  - 承接当前仓库根目录下的应用源码、测试、配置与 app 级 package 配置
- Create: `packages/tmux-manager/`
  - 承接外部 `tmux-manager` 项目源码与其测试/构建配置
- Create: `common/config/rush/`
  - 使用 `rush init` 生成 Rush / pnpm 公共配置
- Create: `pnpm-workspace.yaml`
  - 暴露 `apps/*` 与 `packages/*` 为 workspace 目录
- Modify: `package.json`
  - 改成 monorepo root 命令入口，不再承担 `harness` app 包身份
- Modify: `rush.json`
  - 注册 `harness` 与 `@luobata/tmux-manager` 两个 Rush project
- Modify: `.gitignore`
  - 保留 `.harness/state/` 忽略规则，补充 Rush 临时目录忽略规则
- Create: `apps/harness/src/runtime/repo-paths.ts`
  - 统一解析 `appRoot`、`repoRoot`、`configRoot`、`stateRoot` 与用户输入路径
- Modify: `apps/harness/src/cli/index.ts`
  - 替换现有基于 `../../` 的 root 推导逻辑，并让 `-target/-dir` 支持 repo root fallback
- Modify: `apps/harness/src/runtime/run-session.ts`
  - 把 `workspaceRoot` 传递给 runtime 执行层
- Modify: `apps/harness/src/orchestrator/run-goal.ts`
  - 将 `workspaceRoot` 透传到 `team-runtime`
- Modify: `apps/harness/src/runtime/team-runtime.ts`
  - 在任务产物快照阶段显式使用 monorepo root 作为 git 工作区根
- Modify: `apps/harness/src/runtime/task-artifacts.ts`
  - 让 git 快照捕获函数支持显式传入工作区根目录
- Create: `apps/harness/tests/repo-paths.test.ts`
  - 覆盖 repo root / state root / docs fallback 解析行为
- Modify: `apps/harness/tests/planner-dispatcher.test.ts`
  - 拆分 `appRoot` 和 `repoRoot`，更新 CLI 启动路径推导
- Modify: `apps/harness/tests/watch-command.test.ts`
  - 继续断言 `.harness/state` 在 monorepo 根，而不是 `apps/harness` 下
- Create: `apps/harness/tests/tmux-manager-workspace.test.ts`
  - 覆盖 `harness` 对 `@luobata/tmux-manager` 的 workspace 依赖解析

---

## Task 1: 下沉当前 harness 应用到 `apps/harness`

**Files:**
- Create: `apps/harness/`
- Move: `package.json` → `apps/harness/package.json`
- Move: `src/` → `apps/harness/src/`
- Move: `tests/` → `apps/harness/tests/`
- Move: `configs/` → `apps/harness/configs/`
- Move: `tsconfig.json` → `apps/harness/tsconfig.json`
- Move: `vitest.config.ts` → `apps/harness/vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: 先验证当前仓库还没有 `apps/harness` 目录**

Run:

```bash
test -d "/Users/bytedance/luobata/bata-skill/harness/apps/harness"
```

Expected: FAIL with exit code `1`.

- [ ] **Step 2: 创建应用目录并移动现有 harness 文件**

Run:

```bash
mkdir -p "/Users/bytedance/luobata/bata-skill/harness/apps/harness" && \
git -C "/Users/bytedance/luobata/bata-skill/harness" mv \
  package.json \
  src \
  tests \
  configs \
  tsconfig.json \
  vitest.config.ts \
  apps/harness/
```

- [ ] **Step 3: 把根 `.gitignore` 扩展为 monorepo 友好版本**

将 `/Users/bytedance/luobata/bata-skill/harness/.gitignore` 更新为：

```gitignore
node_modules/
dist/
coverage/
.harness/state/
.worktrees/
common/temp/
common/autoinstallers/*/node_modules/
*.log
tests/**/*.js
tests/**/*.d.ts
vitest.config.js
vitest.config.d.ts
```

- [ ] **Step 4: 确认 `apps/harness/package.json` 仍保留原始 app 脚本语义**

将 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/package.json` 调整为以下内容；此时先不要加入 `tmux-manager` 依赖：

```json
{
  "name": "harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts",
    "harness": "tsx src/cli/index.ts run --adapter coco-auto",
    "watch": "tsx src/cli/index.ts watch",
    "plan": "tsx src/cli/index.ts plan",
    "orchestrate": "tsx src/cli/index.ts run",
    "resume": "tsx src/cli/index.ts resume"
  },
  "dependencies": {
    "yaml": "^2.8.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.15.30",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 5: 验证 app 目录结构已经成立**

Run:

```bash
test -f "/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/cli/index.ts" && \
test -f "/Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/planner-dispatcher.test.ts" && \
test -f "/Users/bytedance/luobata/bata-skill/harness/apps/harness/configs/roles.yaml"
```

Expected: PASS.

- [ ] **Step 6: 先做轻量结构校验，确认 app 包元数据与编译配置还在新位置**

Run:

```bash
node -e "const fs=require('node:fs'); const pkg=JSON.parse(fs.readFileSync('/Users/bytedance/luobata/bata-skill/harness/apps/harness/package.json','utf8')); const tsconfig=JSON.parse(fs.readFileSync('/Users/bytedance/luobata/bata-skill/harness/apps/harness/tsconfig.json','utf8')); if(pkg.scripts.watch!=='tsx src/cli/index.ts watch') process.exit(1); if(tsconfig.include[0]!=='src/**/*.ts') process.exit(1);"
```

Expected: PASS.

- [ ] **Step 7: 提交当前应用搬迁结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/.gitignore \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness && \
git commit -m "refactor: move harness app into apps workspace"
```

---

## Task 2: 建立 Rush monorepo root 配置

**Files:**
- Create: `rush.json`
- Create: `common/config/rush/*`（由 `rush init` 生成）
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `common/config/rush/command-line.json`
- Modify: `common/config/rush/pnpm-config.json`

- [ ] **Step 1: 先确认仓库根还没有 Rush 配置**

Run:

```bash
test -f "/Users/bytedance/luobata/bata-skill/harness/rush.json"
```

Expected: FAIL with exit code `1`.

- [ ] **Step 2: 使用 Rush 官方模板生成基础配置**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 init --overwrite-existing
```

Expected: PASS and generate `rush.json` plus `common/config/rush/*`.

- [ ] **Step 3: 把根 `package.json` 改成 monorepo root 命令入口**

将 `/Users/bytedance/luobata/bata-skill/harness/package.json` 写成：

```json
{
  "name": "harness-monorepo",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "scripts": {
    "build": "npx -y @microsoft/rush@5.175.0 build",
    "test": "npx -y @microsoft/rush@5.175.0 test",
    "update": "npx -y @microsoft/rush@5.175.0 update",
    "install:repo": "npx -y @microsoft/rush@5.175.0 install"
  }
}
```

- [ ] **Step 4: 新增根 `pnpm-workspace.yaml`，让非 Rush 工具也能识别 workspace 边界**

将 `/Users/bytedance/luobata/bata-skill/harness/pnpm-workspace.yaml` 写成：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 5: 把 `rush test` 定义为 bulk command**

将 `/Users/bytedance/luobata/bata-skill/harness/common/config/rush/command-line.json` 改成：

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/command-line.schema.json",
  "commands": [
    {
      "commandKind": "bulk",
      "name": "test",
      "summary": "Run project test scripts",
      "description": "Run each project's test script in dependency order.",
      "enableParallelism": true,
      "ignoreMissingScript": true,
      "incremental": false
    }
  ],
  "parameters": []
}
```

- [ ] **Step 6: 确认 `pnpm-config.json` 继续使用 workspaces 模式**

确保 `/Users/bytedance/luobata/bata-skill/harness/common/config/rush/pnpm-config.json` 至少包含：

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/pnpm-config.schema.json",
  "useWorkspaces": true
}
```

- [ ] **Step 7: 验证 Rush root 配置文件已就位**

Run:

```bash
test -f "/Users/bytedance/luobata/bata-skill/harness/rush.json" && \
test -f "/Users/bytedance/luobata/bata-skill/harness/pnpm-workspace.yaml" && \
test -f "/Users/bytedance/luobata/bata-skill/harness/common/config/rush/command-line.json"
```

Expected: PASS.

- [ ] **Step 8: 提交 monorepo root 初始化结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/package.json \
  /Users/bytedance/luobata/bata-skill/harness/pnpm-workspace.yaml \
  /Users/bytedance/luobata/bata-skill/harness/rush.json \
  /Users/bytedance/luobata/bata-skill/harness/common/config/rush && \
git commit -m "build: initialize Rush monorepo root"
```

---

## Task 3: 让 harness 在 monorepo 中正确解析 `configs/`、`.harness/state`、`docs/` 和 git 工作区

**Files:**
- Create: `apps/harness/src/runtime/repo-paths.ts`
- Modify: `apps/harness/src/cli/index.ts`
- Modify: `apps/harness/src/runtime/run-session.ts`
- Modify: `apps/harness/src/orchestrator/run-goal.ts`
- Modify: `apps/harness/src/runtime/team-runtime.ts`
- Modify: `apps/harness/src/runtime/task-artifacts.ts`
- Create: `apps/harness/tests/repo-paths.test.ts`
- Modify: `apps/harness/tests/planner-dispatcher.test.ts`
- Modify: `apps/harness/tests/watch-command.test.ts`

- [ ] **Step 1: 先写失败测试，覆盖 repo root / state root 解析与 docs fallback**

创建 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/repo-paths.test.ts`：

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHarnessPathRoots, resolveHarnessInputPath } from '../src/runtime/repo-paths.js'

describe('repo paths', () => {
  it('keeps .harness/state at the monorepo root', () => {
    const roots = createHarnessPathRoots(new URL('../src/runtime/repo-paths.ts', import.meta.url).href)

    expect(roots.appRoot.endsWith('/apps/harness')).toBe(true)
    expect(roots.repoRoot.endsWith('/harness')).toBe(true)
    expect(roots.stateRoot.endsWith('/harness/.harness/state')).toBe(true)
  })

  it('falls back to the repo root when a target path does not exist under apps/harness', () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), 'harness-repo-paths-'))
    const appRoot = resolve(repoRoot, 'apps/harness')
    mkdirSync(resolve(repoRoot, 'docs'), { recursive: true })
    mkdirSync(appRoot, { recursive: true })
    writeFileSync(resolve(repoRoot, 'docs/spec.md'), '# spec\n')

    const resolved = resolveHarnessInputPath('docs/spec.md', appRoot, repoRoot)
    expect(resolved).toBe(resolve(repoRoot, 'docs/spec.md'))
  })
})
```

- [ ] **Step 2: 再运行受路径迁移影响的现有测试，确认它们先失败**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness/apps/harness" exec vitest run \
  tests/repo-paths.test.ts \
  tests/planner-dispatcher.test.ts \
  tests/watch-command.test.ts
```

Expected: FAIL, because `repo-paths.ts` does not exist yet and current watch/planner tests still assume pre-monorepo root layout.

- [ ] **Step 3: 新增统一路径解析模块**

创建 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/repo-paths.ts`：

```ts
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HarnessPathRoots = {
  appRoot: string
  repoRoot: string
  configRoot: string
  stateRoot: string
}

export function createHarnessPathRoots(moduleUrl: string): HarnessPathRoots {
  const appRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..')
  const repoRoot = resolve(appRoot, '..', '..')

  return {
    appRoot,
    repoRoot,
    configRoot: resolve(appRoot, 'configs'),
    stateRoot: resolve(repoRoot, '.harness/state')
  }
}

export function resolveHarnessInputPath(inputPath: string, cwd: string, repoRoot: string): string {
  const fromCwd = resolve(cwd, inputPath)
  if (existsSync(fromCwd)) {
    return fromCwd
  }

  return resolve(repoRoot, inputPath)
}
```

- [ ] **Step 4: 在 CLI 中改用统一路径解析，并让 `-target/-dir` 支持 repo root fallback**

把 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/cli/index.ts` 中的 root 相关代码替换为：

```ts
import { createHarnessPathRoots, resolveHarnessInputPath } from '../runtime/repo-paths.js'

const paths = createHarnessPathRoots(import.meta.url)
const roleModelConfigPath = resolve(paths.configRoot, 'role-models.yaml')
const rolesConfigPath = resolve(paths.configRoot, 'roles.yaml')
const rolePromptConfigPath = resolve(paths.configRoot, 'role-prompts.yaml')
const failurePolicyConfigPath = resolve(paths.configRoot, 'failure-policies.yaml')
const skillsConfigPath = resolve(paths.configRoot, 'skills.yaml')
const teamCompositionConfigPath = resolve(paths.configRoot, 'team-compositions.yaml')
const slashCommandConfigPath = resolve(paths.configRoot, 'slash-commands.yaml')
const stateRoot = paths.stateRoot

function readTargetFile(targetPath: string): GoalTargetFile {
  return readTargetFileAtPath(resolveHarnessInputPath(targetPath, process.cwd(), paths.repoRoot))
}

function readTargetDirectories(dirValue: string): GoalTargetFile[] {
  return splitFlagValues(dirValue)
    .flatMap((directoryPath) => collectDirectoryFiles(resolveHarnessInputPath(directoryPath, process.cwd(), paths.repoRoot)))
    .map((filePath) => readTargetFileAtPath(filePath))
}

function writeRunBootstrap(runDirectory: string): void {
  const queuePath = getQueuePath(runDirectory)
  process.stderr.write(`[harness] runDirectory: ${runDirectory}\n`)
  process.stderr.write(`[harness] queuePath: ${queuePath}\n`)
  process.stderr.write(`[harness] watch: pnpm --dir "${paths.appRoot}" watch --runDirectory "${runDirectory}"\n`)
}
```

- [ ] **Step 5: 把 `workspaceRoot` 从 CLI 透传到 runtime 执行链**

依次修改以下文件：

`/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/run-session.ts`

```ts
export function createRunSession(params: {
  stateRoot: string
  workspaceRoot: string
  runDirectory: string
  input: GoalInput
  adapter: CocoAdapter
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  failurePolicyConfig: FailurePolicyConfig
  teamCompositionRegistry: TeamCompositionRegistry
  maxConcurrency?: number
}): RunSession {
  const {
    stateRoot,
    workspaceRoot,
    runDirectory,
    input,
    adapter,
    roleRegistry,
    modelConfig,
    failurePolicyConfig,
    teamCompositionRegistry,
    maxConcurrency = 2
  } = params

  // ...

  runPromise = runGoal({
    input,
    adapter,
    roleRegistry,
    modelConfig,
    failurePolicyConfig,
    teamCompositionRegistry,
    runDirectory,
    workspaceRoot,
    maxConcurrency
  })
```

`/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/orchestrator/run-goal.ts`

```ts
export async function runGoal(params: {
  input: GoalInput
  adapter: CocoAdapter
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  failurePolicyConfig: FailurePolicyConfig
  teamCompositionRegistry: TeamCompositionRegistry
  runDirectory: string
  workspaceRoot: string
  maxConcurrency?: number
}): Promise<RunReport> {
  const { input, adapter, roleRegistry, modelConfig, failurePolicyConfig, teamCompositionRegistry, runDirectory, workspaceRoot, maxConcurrency = 2 } = params

  // ...

  const { runtime, results, artifactsByTaskId } = await runAssignmentsWithRuntime({
    runDirectory,
    workspaceRoot,
    goal: input.goal,
    plan,
    assignments,
    batches,
    adapter,
    workerPool: { maxConcurrency }
  })
```

并在 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/cli/index.ts` 创建 session 的位置传入：

```ts
const session = createRunSession({
  stateRoot,
  workspaceRoot: paths.repoRoot,
  runDirectory,
  input,
  adapter,
  roleRegistry,
  modelConfig,
  failurePolicyConfig,
  teamCompositionRegistry,
  maxConcurrency
})
```

- [ ] **Step 6: 让 task artifact snapshot 始终以 monorepo root 为 git 工作区根**

更新 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/task-artifacts.ts`：

```ts
function runGit(rootDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

export function captureTaskArtifactSnapshot(rootDir: string = process.cwd()): TaskArtifactSnapshot {
  try {
    const root = runGit(rootDir, ['rev-parse', '--show-toplevel']).trim()
    const statusOutput = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    const diffOutput = runGit(root, ['diff', '--numstat', '--relative', 'HEAD'])
    // 其余逻辑保持不变
```

更新 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/team-runtime.ts` 的签名与调用链：

```ts
async function executeClaim(params: {
  queue: PersistentTaskQueue
  claim: QueueClaimResult
  adapter: CocoAdapter
  workspaceRoot: string
}): Promise<void> {
  const { queue, claim, adapter, workspaceRoot } = params
  const artifactSnapshotBefore = captureTaskArtifactSnapshot(workspaceRoot)

  // ...

  queue.updateTaskArtifacts(
    taskId,
    buildTaskArtifacts(taskId, artifactSnapshotBefore, captureTaskArtifactSnapshot(workspaceRoot))
  )
}

export async function runAssignmentsWithRuntime(params: {
  runDirectory: string
  workspaceRoot: string
  adapter: CocoAdapter
  goal?: string
  plan?: Plan
  assignments?: DispatchAssignment[]
  batches?: ExecutionBatch[]
  workerPool?: WorkerPoolConfig
  resume?: boolean
}): Promise<{ runtime: RuntimeSnapshot; results: TaskExecutionResult[]; artifactsByTaskId: Record<string, import('../domain/types.js').TaskArtifacts> }> {
  const { runDirectory, workspaceRoot, adapter, goal, plan, assignments, batches, workerPool, resume = false } = params

  // ...

  await executeBatch(queue, batch, adapter, controlState, workspaceRoot)
```

- [ ] **Step 7: 更新受 monorepo 路径影响的测试常量**

把 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/planner-dispatcher.test.ts` 顶部常量改为：

```ts
const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')
```

把 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/watch-command.test.ts` 顶部常量改为：

```ts
const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')
const stateRoot = resolve(repoRoot, '.harness/state')
```

- [ ] **Step 8: 重新运行路径相关测试，确认通过**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness/apps/harness" exec vitest run \
  tests/repo-paths.test.ts \
  tests/planner-dispatcher.test.ts \
  tests/watch-command.test.ts
```

Expected: PASS.

- [ ] **Step 9: 提交 monorepo 路径修复结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/repo-paths.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/cli/index.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/run-session.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/orchestrator/run-goal.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/team-runtime.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/src/runtime/task-artifacts.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/repo-paths.test.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/planner-dispatcher.test.ts \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/watch-command.test.ts && \
git commit -m "fix: resolve harness paths from the monorepo layout"
```

---

## Task 4: 迁入 `tmux-manager` 并在 Rush 中注册两个项目

**Files:**
- Create: `packages/tmux-manager/`（从外部项目复制）
- Modify: `rush.json`

- [ ] **Step 1: 先确认仓库里还没有 `packages/tmux-manager`**

Run:

```bash
test -f "/Users/bytedance/luobata/bata-skill/harness/packages/tmux-manager/package.json"
```

Expected: FAIL with exit code `1`.

- [ ] **Step 2: 复制外部 `tmux-manager` 代码到 monorepo，并排除局部锁文件与构建产物**

Run:

```bash
mkdir -p "/Users/bytedance/luobata/bata-skill/harness/packages" && \
rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude pnpm-lock.yaml \
  "/Users/bytedance/luobata/tt/global_transation_team_knowledge/ts-runtime/tmux-manager/" \
  "/Users/bytedance/luobata/bata-skill/harness/packages/tmux-manager/"
```

- [ ] **Step 3: 在 `rush.json` 中显式注册两个项目**

把 `/Users/bytedance/luobata/bata-skill/harness/rush.json` 中以下字段改成：

```json
"rushVersion": "5.175.0",
"pnpmVersion": "9.15.9",
"nodeSupportedVersionRange": ">=22.0.0 <23.0.0",
"projectFolderMinDepth": 2,
"projectFolderMaxDepth": 2,
"repository": {
  "url": "git@github.com:Luobata/harness.git",
  "defaultBranch": "main"
},
"projects": [
  {
    "packageName": "harness",
    "projectFolder": "apps/harness",
    "tags": ["app", "tools"]
  },
  {
    "packageName": "@luobata/tmux-manager",
    "projectFolder": "packages/tmux-manager",
    "tags": ["library", "tools"]
  }
]
```

- [ ] **Step 4: 验证 Rush 能正确识别两个项目**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 list
```

Expected: PASS, and stdout contains both `harness` and `@luobata/tmux-manager`.

- [ ] **Step 5: 提交 tmux-manager 迁入与 project 注册结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/packages/tmux-manager \
  /Users/bytedance/luobata/bata-skill/harness/rush.json && \
git commit -m "build: add tmux-manager as a Rush workspace project"
```

---

## Task 5: 让 harness 通过 workspace 依赖接入 `@luobata/tmux-manager`

**Files:**
- Modify: `apps/harness/package.json`
- Create: `apps/harness/tests/tmux-manager-workspace.test.ts`

- [ ] **Step 1: 先写失败测试，证明 `harness` 当前还不能解析 `@luobata/tmux-manager`**

创建 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/tmux-manager-workspace.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

describe('tmux-manager workspace dependency', () => {
  it('resolves @luobata/tmux-manager from the harness workspace', async () => {
    const tmuxManager = await import('@luobata/tmux-manager')

    expect(typeof tmuxManager.detectMultiplexerContext).toBe('function')
    expect(typeof tmuxManager.createSplitLayout).toBe('function')
  })
})
```

- [ ] **Step 2: 运行失败测试，确认当前缺少 workspace 依赖**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness/apps/harness" exec vitest run tests/tmux-manager-workspace.test.ts
```

Expected: FAIL with module resolution error for `@luobata/tmux-manager`.

- [ ] **Step 3: 给 `apps/harness` 增加 workspace 依赖**

把 `/Users/bytedance/luobata/bata-skill/harness/apps/harness/package.json` 的 `dependencies` 更新为：

```json
"dependencies": {
  "@luobata/tmux-manager": "workspace:*",
  "yaml": "^2.8.1",
  "zod": "^3.25.76"
}
```

- [ ] **Step 4: 安装 workspace 依赖并重跑测试**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 update && \
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness/apps/harness" exec vitest run tests/tmux-manager-workspace.test.ts
```

Expected: PASS.

- [ ] **Step 5: 提交 workspace 依赖接线结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/package.json \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness/tests/tmux-manager-workspace.test.ts && \
git commit -m "build: link harness to tmux-manager via workspace dependency"
```

---

## Task 6: 验证完整 monorepo 构建、测试与 CLI 冒烟路径

**Files:**
- Verify: `apps/harness/**`
- Verify: `packages/tmux-manager/**`
- Verify: `rush.json`
- Verify: `common/config/rush/command-line.json`

- [ ] **Step 1: 重新刷新依赖，确保 shrinkwrap 与 workspace 链接一致**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 update
```

Expected: PASS and create/update Rush-managed lock state under `common/config/rush/` and `common/temp/`.

- [ ] **Step 2: 跑全仓构建，确保依赖顺序正确**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 build
```

Expected: PASS, with `@luobata/tmux-manager` building before `harness`.

- [ ] **Step 3: 跑全仓测试，确保 `rush test` 可以覆盖两个项目**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
npx -y @microsoft/rush@5.175.0 test
```

Expected: PASS.

- [ ] **Step 4: 运行 harness CLI 冒烟命令，验证 app 仍可执行**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness/apps/harness" exec tsx src/cli/index.ts plan "验证 Rush monorepo 迁移" > /tmp/harness-monorepo-plan.json
```

Expected: PASS, and `/tmp/harness-monorepo-plan.json` contains a JSON object with `plan`, `assignments`, `batches`, and `verification`.

- [ ] **Step 5: 验证 state root 仍然落在仓库根**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/harness" && \
node --input-type=module -e "import { pathToFileURL } from 'node:url'; const mod = await import(pathToFileURL('/Users/bytedance/luobata/bata-skill/harness/apps/harness/dist/runtime/repo-paths.js').href); const roots = mod.createHarnessPathRoots(pathToFileURL('/Users/bytedance/luobata/bata-skill/harness/apps/harness/dist/runtime/repo-paths.js').href); if (roots.stateRoot !== '/Users/bytedance/luobata/bata-skill/harness/.harness/state') throw new Error(roots.stateRoot);"
```

Expected: PASS.

- [ ] **Step 6: 提交最终 monorepo 验证结果**

```bash
git add \
  /Users/bytedance/luobata/bata-skill/harness/package.json \
  /Users/bytedance/luobata/bata-skill/harness/pnpm-workspace.yaml \
  /Users/bytedance/luobata/bata-skill/harness/rush.json \
  /Users/bytedance/luobata/bata-skill/harness/common/config/rush \
  /Users/bytedance/luobata/bata-skill/harness/apps/harness \
  /Users/bytedance/luobata/bata-skill/harness/packages/tmux-manager && \
git commit -m "feat: migrate harness into a Rush monorepo"
```

---

## Verification Checklist

- `apps/harness/package.json` 保留原 CLI script 语义。
- `rush.json` 注册 `harness` 与 `@luobata/tmux-manager` 两个项目。
- `apps/harness/src/runtime/repo-paths.ts` 成为唯一路径边界定义点。
- `.harness/state` 仍位于仓库根目录。
- `captureTaskArtifactSnapshot()` 对 git 的观察范围是整个 monorepo，而不是 `apps/harness` 子目录。
- `@luobata/tmux-manager` 通过 `workspace:*` 被 `harness` 成功解析。
- `npx -y @microsoft/rush@5.175.0 build` 与 `npx -y @microsoft/rush@5.175.0 test` 都能通过。
