# Monitor Skill Auto-Launch Board Design

## Goal

让 Coco 中的 `/monitor` 在保留现有 `create-or-attach monitor session` 稳定语义的前提下，自动确保本地 `monitor-board` 服务可用，并返回可访问 URL 给用户点击打开浏览器。

本阶段目标是：

1. `/monitor` 继续先执行 monitor session 的 create / attach。
2. `/monitor` 额外启动或复用 `apps/monitor-board` 本地服务。
3. `/monitor` 返回 board URL，但**不自动打开浏览器**。
4. board 启动失败时，不影响 monitor session 主流程结果。

## Non-Goals

本阶段明确不做：

1. 自动打开浏览器。
2. 多 board 实例隔离。
3. board 进程的 stop / restart CLI。
4. 完整 gateway / websocket 事件流接入。
5. 复杂的服务身份校验与进程守护系统。

## User Experience

用户在 Coco 中输入：

```text
/monitor
```

系统行为：

1. 第一次调用：返回 `kind=create`，并附带已启动的 board URL。
2. 重复调用：返回 `kind=attach`，并复用同一个 board 服务 URL。
3. child actor 调用：继续只 attach，不创建嵌套 monitor。

用户可见结果应至少包含：

- monitor session 结果：`kind`、`monitorSessionId`、`message`
- board 结果：`status`、`url`、`message`

示例：

```json
{
  "kind": "attach",
  "monitorSessionId": "monitor:workspace-xxxx",
  "rootSessionId": "workspace-xxxx",
  "requesterActorId": "lead",
  "isRootActor": true,
  "message": "Attached actor lead to existing monitor monitor:workspace-xxxx",
  "board": {
    "status": "reused",
    "url": "http://127.0.0.1:5173/?monitorSessionId=monitor:workspace-xxxx",
    "port": 5173,
    "pid": 12345,
    "message": "monitor-board is already running"
  }
}
```

## Architecture

实现分为三层：

### 1. Session Runtime Layer

保留现有 monitor session 行为：

- `skills/monitor/runtime/context.mjs`
- `skills/monitor/runtime/monitor-session.mjs`
- `skills/monitor/runtime/session-store.mjs`
- `skills/monitor/runtime/invoke-monitor.mjs`

职责：

- 解析上下文
- 计算 `create | attach`
- 持久化 monitor session state
- 输出 monitor session 主结果

该层不负责：

- 启动 Vite
- 端口探测
- 返回 board URL

### 2. Board Launcher Layer

新增：

- `skills/monitor/runtime/board-launcher.mjs`

职责：

- 检查 board 服务是否已在运行
- 启动 `apps/monitor-board` 的本地 dev server
- 等待端口可用
- 构造访问 URL
- 返回标准化 board 结果

建议接口：

```ts
type EnsureBoardOptions = {
  repoRoot: string
  monitorSessionId: string
  preferredPort?: number
  host?: string
}

type EnsureBoardResult = {
  status: 'started' | 'reused' | 'failed'
  url: string | null
  port: number | null
  pid: number | null
  message: string
}
```

### 3. Skill Output Layer

`invoke-monitor.mjs` 作为 orchestrator：

1. 先执行 monitor session create / attach。
2. 再调用 `ensureMonitorBoardRunning(...)`。
3. 将两部分结果拼成最终 skill 输出。

## Board Launch Contract

### Input

- `repoRoot`
- `monitorSessionId`
- `preferredPort`，默认 `5173`
- `host`，默认 `127.0.0.1`

### Output

#### `status=started`

表示本地 board 原本未运行，本次调用已成功启动。

#### `status=reused`

表示本地 board 已在运行，本次复用现有服务。

#### `status=failed`

表示 board 本次未能成功启动，但 monitor session create / attach 不回滚。

## URL Contract

统一返回：

```text
http://127.0.0.1:5173/?monitorSessionId=<monitorSessionId>
```

例如：

```text
http://127.0.0.1:5173/?monitorSessionId=monitor:workspace-d7c38571ec52
```

`monitor-board` 页面后续通过 querystring 读取 `monitorSessionId`。

## Service Discovery and State

launcher 采用“两段式”判断服务可复用性：

### 1. launcher state file

新增状态文件：

```text
<repoRoot>/.bata-workflow/state/monitor-board/runtime.json
```

最小字段：

```json
{
  "pid": 12345,
  "port": 5173,
  "url": "http://127.0.0.1:5173",
  "startedAt": "2026-04-20T00:00:00.000Z",
  "repoRoot": "/path/to/bata-workflow"
}
```

### 2. port probe

即使存在 state file，仍需检查端口是否可连接：

1. 若端口可用，返回 `reused`。
2. 若端口不可用，视为脏状态，覆盖旧状态并尝试重启。

不把 state file 当作真相来源，只把它当作辅助元数据。

## Process Model

第一阶段直接启动当前 monitor-board dev server：

```bash
pnpm --dir "<repoRoot>/apps/monitor-board" dev -- --host 127.0.0.1 --port 5173
```

约束：

1. 必须以后台子进程方式启动。
2. 启动后轮询端口可用性。
3. 在限定超时时间内成功则返回 `started`。
4. 超时则返回 `failed`。

## Failure Handling

### Case 1: session success + board success

返回：

- `kind=create | attach`
- `board.status=started | reused`
- `board.url` 非空

### Case 2: session success + board failed

返回：

- monitor session 主结果仍然成功
- `board.status=failed`
- `board.url=null`

设计原则：

`/monitor` 的主语义是创建或附着 monitor session，board 只是增强体验，不能反向拖垮主流程。

### Case 3: 端口可达且可复用

直接返回 `reused`，不重复启动新进程。

### Case 4: 端口冲突

第一阶段简化处理：

- 只做“端口是否可达”的复用判断
- 不额外做 monitor-board 服务身份探针

这是刻意的范围控制。更强的服务身份校验放到后续阶段。

## Changes Required

### New Files

- `skills/monitor/runtime/board-launcher.mjs`

### Modified Files

- `skills/monitor/runtime/invoke-monitor.mjs`
- `skills/monitor/SKILL.md`
- `apps/bata-workflow/tests/monitor-skill-runtime.test.ts`
- `apps/bata-workflow/tests/skill-command.test.ts`

### Possibly Modified Files

- `apps/monitor-board/src/App.tsx`

仅当需要显式读取 `monitorSessionId` query 参数时修改。

## Testing Strategy

### Runtime Tests

在 `apps/bata-workflow/tests/monitor-skill-runtime.test.ts` 中新增：

1. 首次 `invokeMonitor()` 返回 `board.status=started`。
2. 重复 `invokeMonitor()` 返回 `board.status=reused`。
3. board 启动失败时，session 结果仍保留，`board.status=failed`。

### Skill Integration Tests

在 `apps/bata-workflow/tests/skill-command.test.ts` 中新增：

1. linked install 下，安装态 runtime 返回 board URL。
2. published-local install 下，返回结构一致。
3. 重复调用不会重复拉起 board，而是复用已有服务。

### Monitor Board Tests

如果 board 读取 URL query 参数，则补一个页面侧测试，验证：

- `monitorSessionId` 能从 querystring 中被读取并用于初始化展示。

## Acceptance Criteria

本阶段完成定义：

1. 在 Coco 中执行 `/monitor` 时，monitor session create / attach 语义保持不变。
2. `/monitor` 会自动启动或复用 `monitor-board` 本地服务。
3. `/monitor` 返回可点击的本地 board URL。
4. `/monitor` 不自动打开浏览器。
5. linked 与 published-local 两种安装形态行为一致。
6. board 启动失败不会破坏 monitor session 主结果。

## Trade-offs

当前方案有意识地选择了较轻的实现：

- 使用 `vite dev` 而不是正式守护进程。
- 使用固定端口复用，而不是多实例隔离。
- 使用基础端口探测，而不是更复杂的服务身份校验。

这些 trade-off 的目标是：

1. 先把 `/monitor -> board URL` 的开发体验打通。
2. 不把第一版做成复杂的本地进程编排器。
3. 给后续正式 gateway / viewer 集成保留升级空间。

## Final Recommendation

采用以下实现方向：

> `/monitor` 自动启动或复用 `monitor-board` 服务，并返回 URL 给用户点击打开浏览器；不自动开浏览器，不改变 monitor session 的既有 create-or-attach 语义。
