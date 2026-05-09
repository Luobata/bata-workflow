---
name: token-usage
description: Query local Coco/Codex token usage. Use for /token, /tokens, /token-usage, today, recent, session, date range, model usage, or checking another agent with --agent coco/codex.
tags:
  - token
  - usage
  - coco
  - codex
---

# Token Usage

统计本机 Coco/Codex 的 token 消耗。默认查当前客户端今天的 token：在 Codex 中默认查 Codex，在 Coco 中默认查 Coco。

## Procedure

Run the runtime once with matching arguments, then summarize JSON output.

Default installed command:

```bash
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" today --format json
```

Repo-local command:

```bash
node "skills/token-usage/runtime/token-usage.mjs" today --format json
```

## Intent Mapping

- 今天/当天 token: `today`
- 最近 token/最近会话: `recent --limit 10`
- 最近 N 个会话: `recent --limit N`
- 指定会话: `session <id>`
- 昨天: `day yesterday`
- 指定日期: `day YYYY-MM-DD`
- 最近 7 天/近一周: `range --days 7 --group day`
- 日期区间: `range --from YYYY-MM-DD --to YYYY-MM-DD --group day`
- 按模型统计: add `--group model`
- Codex: add `--agent codex`
- Coco: add `--agent coco`
- 全部: add `--agent all`
- `--source` is kept as an alias of `--agent`

## Examples

```bash
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" today
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" recent --limit 10
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" session 925e6d25-4b49-47da-be25-3a51fa99e44c
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" day 2026-05-09
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" range --days 7 --group day
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" today --agent all
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" recent --agent codex --limit 10
node "$HOME/.coco/skills/token-usage/runtime/token-usage.mjs" today --agent coco
```

## Output Rules

1. Default to the current client today; detect Codex via `CODEX_*` env, otherwise Coco.
2. Report totals first: sessions, input, output, total.
3. For recent/session output, include session id, time, model, title, and total tokens.
4. Coco data comes from `~/Library/Caches/coco/sessions/*/traces.jsonl` telemetry fields.
5. Codex data comes from `~/.codex/state_5.sqlite` table `threads`.
6. If no data is found, report checked source paths and suggest a broader range or `--agent all`.
7. Report token counts only; do not invent cost.

## Data Sources

- Coco sessions root: `~/Library/Caches/coco/sessions`
- Coco metadata: `session.json`
- Coco telemetry fields: `telemetry.tokens.input`, `telemetry.tokens.output`
- Codex state DB: `~/.codex/state_5.sqlite`

Coco traces can contain repeated telemetry events. The runtime de-duplicates by invocation id and keeps max input/output per invocation before summing.
