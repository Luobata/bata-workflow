# 新会话入口

如果你是一个新会话，请按下面步骤直接开始，不要重新从零分析。

## 第一步：先读取这三份文档

1. `docs/NEXT_SESSION_ENTRY.md`
2. `docs/NEXT_TASK_CHECKLIST.md`
3. `docs/HANDOFF_STATUS_2026-04-11.md`

## 第二步：再读取这些关键源码

1. `src/domain/types.ts`
2. `src/runtime/task-queue.ts`
3. `src/runtime/task-store.ts`
4. `src/runtime/team-runtime.ts`
5. `src/runtime/failure-policy.ts`
6. `src/runtime/recovery.ts`
7. `src/runtime/state-store.ts`
8. `src/runtime/scheduler.ts`
9. `src/dispatcher/dispatcher.ts`
10. `src/cli/index.ts`

## 第三步：按下面目标继续实现

当前推荐直接进入：

> 在现有 queue-based runtime 基础上，继续做 **fix/verify loop 独立 role/model 解析、report 顶层 summary 聚合、skill/team composition 配置化**。

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

当前系统已经有：`task queue`、`task store`、`worker pool`、`maxConcurrency`、`queue-based resume`、failure fallback、显式 `fix/verify loop`、runtime 动态任务统计；不要回头重做这些基础，直接往 **loop 独立 role/model 解析、report summary 聚合、skill/team composition 配置化** 继续推进。
