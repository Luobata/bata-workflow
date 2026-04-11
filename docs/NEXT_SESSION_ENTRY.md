# 新会话入口

如果你是一个新会话，请按下面步骤直接开始，不要重新从零分析。

## 第一步：先读取这两份文档

1. `docs/HANDOFF_STATUS_2026-04-11.md`
2. `docs/NEXT_TASK_CHECKLIST.md`

## 第二步：再读取这些关键源码

1. `src/domain/types.ts`
2. `src/runtime/team-runtime.ts`
3. `src/runtime/recovery.ts`
4. `src/runtime/state-store.ts`
5. `src/runtime/scheduler.ts`
6. `src/cli/index.ts`

## 第三步：按下面目标继续实现

当前推荐直接进入：

> 实现持久化 `task queue + worker pool + maxConcurrency`，并把 `resume` 从 report 快照恢复升级为 queue 驱动恢复。

## 第四步：执行前检查

- 先看 `git status`
- 确认当前工作区是否只有交接文档改动，还是还存在其他未提交实现
- 如果要继续编码，优先保持在 `harness` 仓库内操作：
  - `/Users/bytedance/luobata/bata-skill/harness`

## 第五步：验证命令

实现完成后至少运行：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" test
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" build
```

如果涉及运行链路，再补：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" orchestrate --adapter=dry-run "实现登录功能并补测试"
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" resume --adapter=dry-run
```

## 给新会话的一句话提示

当前系统已经有：模型配置、角色 prompt、coco-cli、retry、state 持久化、resume；不要重做这些基础，直接往 **task queue / worker pool / maxConcurrency / queue-based resume** 继续推进。
