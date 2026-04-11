---
name: harndess-debug
description: 使用仓库内软链版 harness debug skill，便于调试全局 Coco 的 /harndess-debug 行为与本地 harness 编排命令。
tags:
  - harness
  - debug
  - orchestration
  - coco
---

# Harndess Debug

## Overview

当用户显式使用 `/harndess-debug` 时，使用这个 skill。

这个 skill 的全局 Coco 安装目录应当是一个软链，指向仓库内目录：

`/Users/bytedance/luobata/bata-skill/harness/agent-skills/harndess-debug`

这样修改当前 `SKILL.md` 后，Coco 读取到的内容会立即更新，便于调试。

## Purpose

这个 skill 用于：

- 调试全局 Coco skill 是否已正确注入
- 调试 `/harness` 与本地 harness CLI 的联动
- 快速跑 `plan` / `run` / `resume` 验证链路
- 检查 slash command、composition、report summary 是否符合预期

## Commands

### 默认调试执行

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" dev /harness "<用户目标>"
```

### 调试仅计划

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" plan "<用户目标>"
```

### 调试恢复

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" dev /resume
```

### 调试特定 composition

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" dev /harness --composition=research-only "<用户目标>"
```

## Operating Instructions

1. 如果用户目标是验证 slash 或 skill 注入是否生效，优先先跑一条 `plan` 或 `run`
2. 如果用户明确说“恢复上次调试”，执行 `dev /resume`
3. 输出时重点总结：
   - 计划任务数
   - 选中的 composition
   - `report.summary`
   - `persisted.runDirectory`
4. 如果怀疑 skill 没刷新，提醒用户重启 Coco 会话后重试 `/harndess-debug`

## Examples

### 用户说

`/harndess-debug 实现登录功能并补测试`

优先执行：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" dev /harness "实现登录功能并补测试"
```

### 用户说

`/harndess-debug 继续上次运行`

优先执行：

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/harness" dev /resume
```
