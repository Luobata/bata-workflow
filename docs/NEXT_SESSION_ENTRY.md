# 新会话入口

如果你是一个新会话，请按下面步骤直接开始，不要重新从零分析。

## 第一步：先读取这三份文档

1. `docs/NEXT_SESSION_ENTRY.md`
2. `docs/NEXT_TASK_CHECKLIST.md`
3. `docs/HANDOFF_STATUS_2026-04-12.md`

## 第二步：再读取这些关键源码

1. `src/tui/watch-state.ts`
2. `src/tui/render.ts`
3. `src/tui/watch.ts`
4. `src/cli/index.ts`
5. `src/runtime/state-store.ts`
6. `src/planner/planner.ts`

## 第三步：按下面目标继续实现

当前推荐直接进入：

> 在现有 watch 基础上，继续做 **detailMode 视图切换（方案 B）、产物/验证证据可视化、结构化执行结果展示**。

## 第四步：执行前检查

- 先看 `git status`
- 确认当前工作区是否只有交接文档改动，还是还存在其他未提交实现
- 如果要继续编码，优先保持在 `bata-workflow` 仓库内操作：
  - `/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow`

## 第五步：验证命令

实现完成后至少运行：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test -- watch-command watch-state
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" build
```

如果涉及运行链路，再补：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev /bata-workflow-debug --adapter=dry-run -dir <docs>
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev watch --reportPath <report.json>
```

## 给新会话的一句话提示

当前系统已经有：`/bata-workflow-debug` 文档驱动入口、`watch` 终端 TUI、任务详情、协作链路面板，以及为方案 B 预留的 `detailMode` 扩展位；不要回头重做 watch 基础，直接往 **detailMode 切换、产物/验证证据可视化、结构化执行结果展示** 继续推进。
