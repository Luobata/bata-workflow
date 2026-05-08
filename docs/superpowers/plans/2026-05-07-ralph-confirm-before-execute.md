# Ralph Confirm-Before-Execute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Ralph 收敛为强门禁模式：首次 `/ralph --goal|--path|--dir` 永远只生成 plan 并停下，只有待确认状态下的 `确认 / 继续 / 开始` 或 `/ralph --resume` 才能进入执行。

**Architecture:** 先在 `apps/bata-workflow` 的 CLI 层拦截“自然语言确认”和非法组合参数，再在 `skills/ralph/runtime/invoke-ralph.mjs` 把 planning 与 execution 的边界锁死，并统一 confirmation-state 语义。最后用 CLI/runtime 两层测试和技能文档同步守住新语义，避免再次漂移到“依赖模型自己决定是否继续”。

**Tech Stack:** TypeScript CLI (`apps/bata-workflow/src/cli/index.ts`)、Node.js ESM runtime (`skills/ralph/runtime/invoke-ralph.mjs`)、Vitest、Markdown skill 文档。

**Complexity:** Medium (9/15)

**Spec:** `docs/superpowers/specs/2026-05-07-ralph-confirm-before-execute-design.md`

---

## Execution Context

- 工作目录默认是仓库根：`/Users/bytedance/luobata/bata-skill/bata-workflow`
- Ralph 相关改动只应触达：
  - `apps/bata-workflow/src/cli/index.ts`
  - `skills/ralph/runtime/invoke-ralph.mjs`
  - `skills/ralph/SKILL.md`
  - `apps/bata-workflow/tests/ralph-cli-command.test.ts`
  - `apps/bata-workflow/tests/ralph-skill-runtime.test.ts`
  - 可选：`skills/ralph/ACCEPTANCE-TESTS.md`
- Monorepo 约束必须保持：`--path` / `--dir` 模式下，`.ralph` 状态目录仍放在目标目录下；自然语言确认也必须从目标目录触发。见 `skills/ralph/AGENTS.md:12-27`。

## Milestone Checklist

- [ ] M1: CLI 只允许“明确确认”触发 resume，并禁止新任务启动与 resume/execute 混用
- [ ] M2: runtime 首次启动统一落在 planning-only，confirmation-state 语义收敛
- [ ] M3: CLI / runtime 测试覆盖新门禁行为
- [ ] M4: Ralph 文档与验收说明同步到新语义

## File Structure

- M `apps/bata-workflow/src/cli/index.ts` — Ralph 入口路由、自然语言确认拦截、auto-resume 门禁、非法参数组合错误
- M `skills/ralph/runtime/invoke-ralph.mjs` — planning-only 边界、统一 confirmation-state、统一 requiresConfirmation / confirmationPrompt
- M `skills/ralph/SKILL.md` — 用户可见语义：首次只 plan、确认词、resume 规则
- M `apps/bata-workflow/tests/ralph-cli-command.test.ts` — CLI 行为测试：确认词、非法组合、auto-resume 避让
- M `apps/bata-workflow/tests/ralph-skill-runtime.test.ts` — runtime 行为测试：统一 confirmation-state、无执行日志、resume 后才执行
- M `skills/ralph/ACCEPTANCE-TESTS.md` — 可选；更新验收场景里的确认方式，去掉过时的 `/ralph 确认` 心智

## Standard Verification Flow

1. 先跑聚焦测试，确认新增 case 先失败
2. 做最小实现，只收紧入口门禁和状态语义，不碰 review/validation 逻辑
3. 先跑 CLI 测试，再跑 runtime 测试
4. 最后检查写出的 `.ralph/confirmation-state.json`、`tasks.json`、`logs/runtime.jsonl` 是否符合 spec 中的不变量

---

### Task 1: 收紧 CLI 入口，识别自然语言确认

**Files:**
- Modify: `apps/bata-workflow/src/cli/index.ts`
- Modify: `apps/bata-workflow/tests/ralph-cli-command.test.ts`

**Acceptance:**
- [ ] CLI 能识别 `确认` / `继续` / `开始` / `confirm` / `continue` / `go` 为明确确认短语
- [ ] 只有存在 `awaitingConfirmation === true` 的 Ralph 状态时，这些短语才会被解释为 Ralph resume
- [ ] 普通对话里的确认短语不会在无待确认态时误触发 Ralph

**Verification:**
```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-cli-command.test.ts
```

**Steps:**
1. **测试**：在 `ralph-cli-command.test.ts` 新增“裸消息 `确认`/`继续`/`开始` 在待确认状态下触发 resume”的断言，同时新增“无待确认状态不触发”的反例。
2. **验证失败**：先运行聚焦测试，预期失败点是当前 CLI 只识别 `/ralph 确认` 或 positionals 中的 `确认`，不会在主路由层捕获普通消息。
3. **实现**：在 `index.ts` 中抽出确认短语 helper，并在 `main()` 中 `/ralph` special-case 之前增加“待确认 Ralph 拦截器”，将裸消息路由为 Ralph resume。
4. **验证通过**：重新运行 CLI 聚焦测试，确认自然语言确认路径通过。
5. **提交**：`feat(ralph-cli): allow natural-language confirmation for pending plans`

**Implementation focus:**
- 将确认短语匹配做成完整匹配 helper，避免后续散落多个 regex 版本
- 只在确认态下拦截，不改动其他 slash command 的正常路由

---

### Task 2: 禁止新任务启动与 resume/execute 混用，并封堵 auto-resume 绕门禁

**Files:**
- Modify: `apps/bata-workflow/src/cli/index.ts`
- Modify: `apps/bata-workflow/tests/ralph-cli-command.test.ts`

**Acceptance:**
- [ ] `/ralph --goal|--path|--dir` 与 `--resume` / `--execute` 混用时返回明确错误
- [ ] 当存在 `awaitingConfirmation === true` 时，旧的 todo-state unfinished auto-resume 逻辑不会越过确认门禁
- [ ] 显式 `/ralph --resume` 仍然可用

**Verification:**
```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-cli-command.test.ts
```

**Steps:**
1. **测试**：补三类 case：
   - `--path + --resume` / `--goal + --execute` 混用报错
   - `awaitingConfirmation === true` 时普通 `/ralph` 不能 auto-resume
   - `/ralph --resume` 仍然成功执行
2. **验证失败**：当前行为允许显式 `--execute` 首次直接执行，且 unfinished tasks 可能 auto-enable `--resume`。
3. **实现**：在 `runRalphCommand()` 中先检查“新任务启动 + resume/execute 混用”，再在 auto-resume 分支前增加 `awaitingConfirmation` guard。
4. **验证通过**：聚焦测试全部转绿，并确认 stderr/错误文案能说明“先生成计划，再确认或 resume”。
5. **提交**：`fix(ralph-cli): enforce confirmation gate before execution`

**Implementation focus:**
- 错误文案要指向正确下一步：回复 `确认/继续/开始` 或 `/ralph --resume`
- 不破坏 `resumeForce` 等已有恢复路径的测试覆盖

---

### Task 3: 统一 runtime 的 planning-only 与 confirmation-state 语义

**Files:**
- Modify: `skills/ralph/runtime/invoke-ralph.mjs`
- Modify: `apps/bata-workflow/tests/ralph-skill-runtime.test.ts`

**Acceptance:**
- [ ] 首次新任务启动一律进入 planning 分支并立即返回 `kind: 'plan'`
- [ ] planning 返回始终包含 `requiresConfirmation: true`
- [ ] `confirmation-state.json` 统一写为 `awaitingConfirmation: true` + 单一 reason（如 `plan_ready_waiting_user_confirmation`）
- [ ] planning 阶段不会写出任何 task-level execution 事件

**Verification:**
```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-skill-runtime.test.ts
```

**Steps:**
1. **测试**：在 `ralph-skill-runtime.test.ts` 增加断言：
   - `invokeRalph({ goal|path, ... })` 返回 `requiresConfirmation === true`
   - 读取 `.ralph/confirmation-state.json`，断言 `awaitingConfirmation === true` 和新的统一 reason
   - runtime log 仅有 `session.start` / `session.planned`
2. **验证失败**：当前 `manual_plan_only` 与 `directory_mode_requires_confirm` 会根据入口分叉，`requiresConfirmation` 也依赖 `autoPlanOnly`。
3. **实现**：在 `invoke-ralph.mjs` 中把“首次新任务启动”强制统一为 planning-only；planning 分支统一写 confirmation-state，统一 `requiresConfirmation` 与 `confirmationPrompt`。
4. **验证通过**：runtime 测试转绿，且聚焦断言显示没有 task execution 事件。
5. **提交**：`fix(ralph-runtime): normalize planning confirmation state`

**Implementation focus:**
- 不在本任务中改 review loop / validation loop
- 只收口 planning 与 execution 的阶段边界

---

### Task 4: 验证 resume 后才真正开始执行

**Files:**
- Modify: `apps/bata-workflow/tests/ralph-cli-command.test.ts`
- Modify: `apps/bata-workflow/tests/ralph-skill-runtime.test.ts`

**Acceptance:**
- [ ] 首次调用之后，`.ralph/tasks.json` 中所有任务都保持 `pending`
- [ ] 只有在自然语言确认或 `/ralph --resume` 之后，才出现 `task-start` / `task.completed` 等执行事件
- [ ] `--path` / `--dir` 模式下，确认必须从目标目录生效，保留 monorepo 语义

**Verification:**
```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-cli-command.test.ts
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-skill-runtime.test.ts
```

**Steps:**
1. **测试**：补“首次 path mode 只 plan、随后目标目录内回复 `确认` 才 resume”的双阶段用例；补 runtime log 断言，验证 resume 前无 task-level 事件、resume 后才出现。
2. **验证失败**：当前部分 case 仍允许首次 `--execute` 直接跑任务，或者 confirmation-state 语义不足以证明 resume 边界。
3. **实现**：根据前两任务的入口收口结果，修正测试 fixture、stderr 文案、状态断言，让双阶段流程稳定通过。
4. **验证通过**：CLI 与 runtime 双测试文件均转绿。
5. **提交**：`test(ralph): cover confirm-before-execute flow`

**Implementation focus:**
- 日志断言要基于 `.ralph/logs/runtime.jsonl`，不要只看 stdout 文案
- 保留 `skills/ralph/AGENTS.md` 中“确认/恢复需要从目标目录发起”的约束

---

### Task 5: 同步 Ralph skill 文档与验收说明

**Files:**
- Modify: `skills/ralph/SKILL.md`
- Modify: `skills/ralph/ACCEPTANCE-TESTS.md`

**Acceptance:**
- [ ] `SKILL.md` 明确说明首次 `/ralph --goal|--path|--dir` 只生成 plan，不直接执行
- [ ] `SKILL.md` 明确说明可接受的确认方式：`确认` / `继续` / `开始` / `/ralph --resume`
- [ ] `ACCEPTANCE-TESTS.md` 中的示例与新语义一致，不再暗示 `/ralph 确认` 是唯一入口

**Verification:**
```bash
python3 - <<'PY'
from pathlib import Path
for p in [
  Path('/Users/bytedance/luobata/bata-skill/bata-workflow/skills/ralph/SKILL.md'),
  Path('/Users/bytedance/luobata/bata-skill/bata-workflow/skills/ralph/ACCEPTANCE-TESTS.md'),
]:
    text = p.read_text()
    assert '确认' in text
    assert '继续' in text or '/ralph --resume' in text
print('doc-check: ok')
PY
```

**Steps:**
1. **文档审查**：定位 `SKILL.md` 中“执行流程”“Runtime 脚本执行模式说明”“断点恢复”等章节，以及 `ACCEPTANCE-TESTS.md` 中使用 `/ralph 确认` 的示例。
2. **实现**：把文案统一到新语义：首次只 plan；确认方式包括自然语言确认和 `/ralph --resume`；自然语言确认仅在待确认态下生效。
3. **验证**：运行上面的 doc-check，并手动扫一遍是否还保留旧心智模型。
4. **提交**：`docs(ralph): document confirm-before-execute flow`

**Implementation focus:**
- 文档只描述本轮已经实现的行为，不预告未来未实现能力
- 保留与 monorepo / target directory 相关的现有说明

---

### Task 6: 做一轮回归与状态文件核验

**Files:**
- Modify: `apps/bata-workflow/tests/ralph-cli-command.test.ts`（如前面测试收口仍需补断言）
- Modify: `apps/bata-workflow/tests/ralph-skill-runtime.test.ts`（如前面测试收口仍需补断言）

**Acceptance:**
- [ ] CLI 测试和 runtime 测试全部通过
- [ ] planning 阶段状态文件满足 spec 中的不变量
- [ ] 没有占位性测试（只断 stdout，不断 state/log）的遗漏

**Verification:**
```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-cli-command.test.ts
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test tests/ralph-skill-runtime.test.ts
```

**Steps:**
1. **聚焦运行**：分别运行 CLI 与 runtime 测试，记录失败点。
2. **状态核验**：对至少一个 planning fixture 读取：
   - `.ralph/session.json`
   - `.ralph/tasks.json`
   - `.ralph/confirmation-state.json`
   - `.ralph/logs/runtime.jsonl`
   验证它们与 spec 中的 planning-only 不变量一致。
3. **收口修正**：若测试只覆盖文案，补 state/log 断言；若文档与实现不一致，优先修正文档。
4. **提交**：`test(ralph): verify planning gate state invariants`

**Implementation focus:**
- 以状态文件和 runtime log 为真相，不以用户提示文案为唯一依据
- 不在本任务中扩展到 `ralph-real-coco-e2e.test.ts`，除非前述聚焦测试不足以证明边界

---

## Coverage Map

- 需求 1「首次调用永远只生成 plan」→ Task 2, Task 3, Task 6
- 需求 2「只有待确认状态下收到明确确认才执行」→ Task 1, Task 2, Task 4
- 需求 3「自然语言确认可用」→ Task 1, Task 4, Task 5
- 需求 4「`/ralph --resume` 仍然可用」→ Task 2, Task 4
- 需求 5「状态文件与日志可直接验证边界」→ Task 3, Task 4, Task 6
- 需求 6「不同模型下 planning 行为一致」→ Task 3, Task 6（以结构性不变量为主，模型 smoke 作为后续加项）

## Risks

- 当前 `ralph-cli-command.test.ts` 有大量既有 case 使用 `--execute` 直跑；强门禁改造后，这些 case 需要重写为“两阶段路径”或显式说明它们测试的是 resume/execution，不是首次启动。
- `runRalphCommand()` 现有 auto-resume 逻辑与 confirmation gate 有直接冲突，若修正不彻底，最容易出现“有些 case 仍然自动执行”的回归。
- runtime 统一 confirmation-state 后，旧断言里对 `manual_plan_only` / `directory_mode_requires_confirm` 的期待都要一起更新。

## Placeholder Scan

本计划中不允许以下内容残留到最终实现：

- `manual_plan_only` 继续作为用户可见主语义存在
- `确认` 以外的模糊口语（如 `好` / `ok`）被当成确认短语
- 只改文档不改测试
- 只断 stdout 提示，不断 state/log

