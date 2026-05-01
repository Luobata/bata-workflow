# Bata-Workflow 交接记录（2026-04-12）

## 1. 当前结论

- 当前仓库路径：`/Users/bytedance/luobata/bata-skill/bata-workflow`
- 当前代码状态：**已完成 watch 终端 TUI 的三轮迭代**，从基础运行监控推进到“任务详情 + 协作链路”阶段。
- 当前最重要的新能力：
  - `/bata-workflow-debug` 正式入口与 `--dir/--target` 文档驱动规划
  - `watch` 命令与只读终端 TUI
  - `Workers | Hot Tasks | Task Details | Recent Events` 三栏监控
  - `selectedTask` 排障详情与协作链路（mailbox / upstream / handoff）
- 当前推荐的下一阶段目标：**把 watch 详情面板从 `combined` 升级为可切换的 `overview / collaboration` 模式，并继续补产物/验证证据可视化。**

---

## 2. 本轮已经完成的能力

### 2.1 文档输入驱动规划

已完成：

- `-dir` / `-target` 目录与文件输入
- 文本文件过滤与常见构建目录忽略
- 方案文档 checklist / bullet -> 细粒度任务拆解
- `/bata-workflow-debug` 正式入口与旧拼写 `/harndess-debug` 兼容

关键文件：

- `configs/slash-commands.yaml`
- `src/cli/index.ts`
- `src/planner/planner.ts`
- `tests/planner-dispatcher.test.ts`
- `tests/slash-command-loader.test.ts`

### 2.2 watch TUI 第一版：运行状态监控

已完成：

- `watch` 命令入口
- 从 `.bata-workflow/state/runs/*` 读取最近或显式指定的 run/report
- 顶部总览：`goal / status / batch / counters`
- `Workers`、`Hot Tasks`、`Recent Events` 只读实时监控
- 非 TTY 环境自动退化为单次渲染输出

关键文件：

- `src/tui/watch-state.ts`
- `src/tui/render.ts`
- `src/tui/watch.ts`
- `src/runtime/state-store.ts`
- `tests/watch-state.test.ts`
- `tests/watch-command.test.ts`

### 2.3 watch TUI 第二版：任务详情与选择交互

已完成：

- `selectedTask` 详情聚合
- 三栏布局：`Workers | Hot Tasks | Task Details`
- 交互：`↑/↓/j/k` 选中任务，`q/r/p` 保持可用
- 刷新后选择保持 / 不命中回退第一条 hot task

关键文件：

- `src/tui/watch-state.ts`
- `src/tui/render.ts`
- `src/tui/watch.ts`
- `tests/watch-state.test.ts`
- `tests/watch-command.test.ts`

### 2.4 watch TUI 第三版：协作链路面板

已完成：

- `selectedTask.collaboration` 子结构
- `Mailbox` / `Upstream` / `Handoff` / `Collab Status` 聚合
- `Task Details` 内联追加 `Overview` + `Collaboration` 两个区块
- 预留 `detailMode = 'combined' | 'overview' | 'collaboration'` 扩展位
- 当前仍保持方案 A：合并显示，不做 Tab 切换

关键文件：

- `src/tui/watch-state.ts`
- `src/tui/render.ts`
- `src/tui/watch.ts`
- `tests/watch-state.test.ts`
- `tests/watch-command.test.ts`

---

## 3. 当前命令用法

### 3.1 文档驱动调试入口

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev /bata-workflow-debug --dir /绝对路径/docs
```

### 3.2 观察最近一次运行

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev watch
```

### 3.3 观察指定报告

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev watch --reportPath /绝对路径/report.json
```

### 3.4 watch 快捷键

- `↑` / `k`：上一条 hot task
- `↓` / `j`：下一条 hot task
- `r`：立即刷新
- `p`：暂停 / 恢复自动刷新
- `q`：退出

---

## 4. 当前已验证结果

已通过：

- `npm test -- watch-command watch-state`
- `npm test -- slash-command-loader planner-dispatcher watch-command watch-state`
- `npm run build`
- 真实链路冒烟：
  - `/bata-workflow-debug --adapter=dry-run -dir <docs>`
  - `watch --reportPath <report.json>`

验证结论：

- `watch` 可稳定显示 `Workers / Hot Tasks / Task Details / Recent Events`
- `Task Details` 可显示基础排障字段与协作链路
- 选择交互、非 TTY 退化输出、错误路径与构建均正常

---

## 5. 下一轮推荐迭代方向

### 5.1 watch 方案 B：详情视图切换

目标：

- 把当前 `combined` 详情面板升级为可切换的：
  - `overview`
  - `collaboration`
  - 保留 `combined` 作为默认兼容模式

建议修改：

- `src/tui/watch.ts`
- `src/tui/render.ts`
- `tests/watch-command.test.ts`
- `tests/watch-state.test.ts`

### 5.2 继续补产物/验证证据可视化

当前缺口：

- `watch` 还主要展示 summary 与协作信息
- 尚未把真实 `artifacts / verification / blockers` 做成统一可视化区块

建议方向：

- 扩展 `TaskExecutionResult` 的结构化输出
- 在 `Task Details` 中增加 `Artifacts / Verification / Blockers` 区块
- 让 tester/reviewer 的结果不再只靠 summary 体现

### 5.3 中长期方向：Web Dashboard 或终端 Tab 化

在 `watch` 稳定后再考虑：

- detail tabs
- mailbox 详情页
- artifact drill-down
- Web dashboard

---

## 6. 新会话建议读取顺序

先读：

1. `docs/NEXT_SESSION_ENTRY.md`
2. `docs/NEXT_TASK_CHECKLIST.md`
3. `docs/HANDOFF_STATUS_2026-04-12.md`

再读关键源码：

1. `src/tui/watch-state.ts`
2. `src/tui/render.ts`
3. `src/tui/watch.ts`
4. `src/cli/index.ts`
5. `src/runtime/state-store.ts`
6. `src/planner/planner.ts`

---

## 7. 一句话提示

当前系统已经具备：**文档驱动规划 + team orchestration + watch 终端 TUI + 任务详情 + 协作链路面板**；下一步不要回退重做 watch 基础，而是直接往 **detailMode 切换 / 产物验证可视化 / 结构化执行证据** 推进。
