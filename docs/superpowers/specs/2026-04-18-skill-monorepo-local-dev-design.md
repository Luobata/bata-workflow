# Skill Monorepo 本地开发与发布设计

## 背景

当前 `bata-workflow` 已经完成 Rush monorepo 化，仓库中已经存在：

- `apps/bata-workflow/`：主控制面与 CLI
- `apps/monitor-board/`：监控看板应用
- `packages/tmux-manager/`：tmux 基础设施库

同时，团队后续会持续新增大量 skills。对于这些 skills，仓库需要同时满足两类诉求：

1. **本地开发调试**：开发者可以在 monorepo 内迭代 skill，并快速在本机 coco 环境验证。
2. **后续团队分发**：skills 未来需要具备可打包、可安装、可发布、可治理的基础能力，而不是长期停留在手工复制目录的状态。

本设计优先解决 **本地方案跑通**，但接口与目录边界按最终平台方向设计，避免未来返工。

---

## 目标

本设计的目标是建立一套 **skill monorepo 本地开发与本地发布验证模型**，使仓库具备以下能力：

1. skills 的源码统一维护在 monorepo 内，而不是散落在 `~/.coco/skills`。
2. 本地支持两种明确的安装模式：
   - `link`：开发态安装
   - `publish-local`：发布态安装
3. skill 可以从源码目录被校验、打包、安装到本地 coco skill 目录。
4. 本地安装状态可追踪、可诊断、可修复。
5. 第一阶段先用 `monitor` skill 跑通完整闭环，并为未来更多 skills 复用同一套模型。

---

## 非目标

本轮设计不包含以下范围：

1. 不实现远程 registry / hub 发布。
2. 不实现复杂 semver 策略、变更集治理、灰度发布平台。
3. 不做多 skill 依赖图与复杂依赖解析。
4. 不把 skill 生命周期逻辑直接耦合进 coco 本体。
5. 不一次性迁移所有现有 skill，只先定义规则并以 `monitor` 作为样板。
6. 不在本轮解决所有跨平台细节，只要求接口对 darwin/linux 友好并预留扩展点。

---

## 核心原则

### 1. Repo 是源码真相源

skill 的源码必须维护在 monorepo 中；`~/.coco/skills` 是安装目录，而不是开发目录。

### 2. 开发态与发布态分离

本地安装分成两种语义明确的模式：

- `link`：把源码目录以链接方式安装到 `~/.coco/skills`，用于开发调试。
- `publish-local`：把 pack 产物复制到 `~/.coco/skills`，用于本地发布验证。

这两种模式不能混淆，也不能共享模糊语义。

### 3. Pack 是正式中间层

`pack` 不是临时实现细节，而是未来团队分发能力的基础中间层。无论未来走 registry、bundle 还是 git-based 分发，都应站在 `pack` 产物之上演进。

### 4. 文件系统状态与工具记录状态同时建模

本地 skill 管理不能只信任 state 文件，也不能只靠文件系统猜测。任何写操作前都要同时比较：

- 工具记录状态
- 文件系统探测状态

两者不一致时进入 `broken` 分支处理。

### 5. 先按最终平台设计接口，再按阶段收口实现

协议、manifest、状态模型、错误模型一开始就按多 skill、可分发、可治理来设计；实现范围则按阶段收口，只先跑通本地闭环。

---

## 总体架构

建议形成如下结构：

```text
bata-workflow/
  apps/
    bata-workflow/
    monitor-board/
  packages/
    tmux-manager/
    skill-contracts/
    skill-devkit/
  skills/
    monitor/
      SKILL.md
      skill-manifest.json
  .bata-workflow/
    state/
      skills/
        local-installs.json
    skill-packs/
      monitor/
  docs/
    superpowers/
      specs/
      plans/
```

职责边界如下：

### 仓库根目录

继续作为 monorepo root，负责：

- Rush / pnpm workspace 编排
- 仓库级脚本与文档
- 本地状态目录 `.bata-workflow/`

### `apps/bata-workflow`

作为 **CLI shell 与控制面**：

- 提供 `skill validate/link/pack/publish-local/...` 命令入口
- 负责命令参数解析与输出格式
- 不直接承载 skill 生命周期核心逻辑

### `packages/skill-contracts`

作为 **协议层**，负责：

- `SkillManifest` schema
- `LocalInstallRecord` schema
- `PackMetadata` schema
- 共享错误类型与枚举

### `packages/skill-devkit`

作为 **skill 生命周期逻辑层**，负责：

- validate
- link / unlink
- pack
- publish-local
- status / doctor
- 文件系统探测
- 本地状态读写

### `skills/*`

作为 **skill 源码层**，负责：

- `SKILL.md`
- prompt / asset / template 等运行内容
- `skill.manifest.json`
- skill 自身测试素材

### `~/.coco/skills`

作为 **运行时安装层**，只存放：

- 开发态链接安装
- 发布态复制安装

不能作为源码目录使用。

---

## Skill 源码目录规范

每个 skill 目录建议采用如下最小结构：

```text
skills/
  <skill-name>/
    SKILL.md
    skill-manifest.json
    prompts/
    assets/
    tests/
```

第一阶段只要求：

- `SKILL.md`
- `skill.manifest.json`

其余目录按需增量引入。

---

## Manifest 设计

每个 skill 目录包含一个 `skill-manifest.json`。第一阶段采用 JSON，而不是 YAML/TS。

推荐结构如下：

```json
{
  "name": "monitor",
  "displayName": "Monitor",
  "entry": "SKILL.md",
  "cocoInstallName": "monitor",
  "version": "0.1.0-local",
  "files": [
    "SKILL.md",
    "prompts/**",
    "assets/**"
  ],
  "dev": {
    "link": true,
    "publishLocal": true
  },
  "metadata": {
    "description": "Open AI coding monitor board from coco",
    "tags": ["monitor", "debug", "visualization"]
  }
}
```

### 字段说明

#### `name`

repo 内 canonical 名称，用于命令与状态记录，例如：`skill link monitor`。

#### `displayName`

给人看的名称，不参与路径与安装决策。

#### `entry`

告诉工具 skill 的 coco 入口文件。默认推荐 `SKILL.md`，但保留字段以支持未来扩展。

#### `cocoInstallName`

安装到 `~/.coco/skills` 时的目录名。`monitor` 的长期稳定公开调用名与安装名统一采用 `monitor`，从第一阶段开始就锁定这个契约；若历史本地环境中残留 `@luobata/monitor` 目录或 state 记录，后续实现应把它识别为旧格式并给出迁移提示，而不是继续把 scoped 名称当成正式长期接口。

#### `version`

第一阶段只作为本地可观测元数据使用，用于 status / pack metadata / 调试输出，不实现完整版本策略。

#### `files`

定义进入 pack 产物的白名单，是 `pack/publish-local` 的核心输入。不得依赖“复制整个目录”。

#### `dev.link` / `dev.publishLocal`

用于声明该 skill 是否允许 link 或 publish-local。

#### `metadata`

只放描述性信息，不承担控制逻辑。

---

## Pack 产物模型

`pack` 的目标是生成一个 **最小可运行 skill 目录**，而不是源码目录的完整镜像。

### 输出目录

统一输出到：

```text
.bata-workflow/skill-packs/<skill-name>/
```

例如：

```text
.bata-workflow/skill-packs/monitor/
```

### Pack 产物内容

pack 目录中应只包含：

- `entry` 指向的入口文件
- `files` 白名单命中的文件
- `skill-manifest.json`
- 可选的 `.skill-pack.json`

推荐结构：

```text
.bata-workflow/skill-packs/monitor/
  SKILL.md
  skill-manifest.json
  prompts/
  assets/
  .skill-pack.json
```

### Pack 校验要求

1. `entry` 必须存在。
2. `files` 中不允许出现绝对路径或 `../` 越界路径。
3. 每个 `files` glob 必须能命中至少一个文件；默认无命中时报错。
4. 不允许通过隐式兜底把整个 skill 目录复制到 pack 中。

---

## 本地安装状态模型

本地安装状态记录统一存放在：

```text
.bata-workflow/state/skills/local-installs.json
```

推荐结构如下：

```json
{
  "skills": {
    "monitor": {
      "installName": "monitor",
      "mode": "link",
      "sourcePath": "/repo/skills/monitor",
      "installedPath": "/Users/name/.coco/skills/monitor",
      "version": "0.1.0-local",
      "updatedAt": "2026-04-18T12:00:00.000Z"
    }
  }
}
```

如果是 `publish-local`，可额外记录：

- `packedPath`

### 状态记录最少字段

- `installName`
- `mode`：`link | publish-local`
- `sourcePath`
- `installedPath`
- `version`
- `updatedAt`
- `packedPath`（仅 publish-local 可选）

### 状态文件要求

- 运行态 state 不提交 Git
- 写入时使用原子化更新（先写临时文件再 rename）

---

## 本地安装状态机

每个 skill 在本地只允许处于以下 4 种状态：

### `absent`

本地未安装。

### `linked`

开发态安装：

- 安装目录为 link
- state 记录 `mode=link`

### `published-local`

发布态安装：

- 安装目录为 copy
- state 记录 `mode=publish-local`

### `broken`

状态损坏或记录与实际不一致，例如：

- state 说是 link，但目录不存在
- 安装目录存在，但不是当前 skill 的目标
- link 指向错误路径
- installName 冲突

任何写操作前都必须做一次“记录状态 + 文件系统探测状态”的联合判断。

---

## CLI 命令模型

第一阶段建议把命令入口挂在 `apps/bata-workflow` 中，但把逻辑放到 `packages/skill-devkit`。

### 推荐命令集合

- `skill validate <name>`
- `skill link <name>`
- `skill unlink <name>`
- `skill pack <name>`
- `skill publish-local <name>`
- `skill status [name]`
- `skill doctor [name] [--fix]`

### 命令语义

#### `validate`

只做校验，不改文件系统状态。

#### `link`

开发态安装，把 `skills/<name>` 链接到 `~/.coco/skills/<installName>`。

#### `unlink`

只移除 link 安装，不删除 publish-local copy。

#### `pack`

根据 manifest 白名单生成干净 pack 目录，不改安装状态。

#### `publish-local`

先 `validate`，再 `pack`，然后把 pack 产物复制到 `~/.coco/skills/<installName>`。

#### `status`

展示工具记录状态、文件系统探测状态和最终健康度。

#### `doctor`

默认只诊断；`--fix` 才允许执行修复动作。

---

## 状态迁移规则

### `link`

允许：

- `absent -> linked`
- `linked -> linked`（refresh / no-op）
- `published-local -> linked`
- `broken -> linked`（前提是允许修复）

### `unlink`

允许：

- `linked -> absent`
- `broken(link-related) -> absent`

如果当前是 `published-local`，默认拒绝。

### `pack`

不改变安装状态，只写入 pack 产物。

### `publish-local`

允许：

- `absent -> published-local`
- `linked -> published-local`
- `published-local -> published-local`
- `broken -> published-local`

---

## 边界条件与错误处理

以下边界条件必须在实现中显式处理：

### 1. installName 冲突

如果 `~/.coco/skills/<installName>` 已被陌生目录占用，默认失败，不自动覆盖。

### 2. 用户手工修改本地安装目录

任何写操作前都要比较：

- state 中的记录
- 文件系统探测结果

不一致时进入 `broken` 流程，而不是继续正常安装。

### 3. installName 变更

manifest 中 `cocoInstallName` 发生变更时，`validate` 应能提示这是一种 breaking local install change。

### 4. 路径越界

manifest 中所有路径都必须限制在 skill 根目录内部，不允许绝对路径与 `../` 越界。

### 5. 错误 link 目标

不能只判断“是不是 symlink”，还要判断它是否指向当前 skill 的源码目录。

### 6. 平台差异

第一阶段实现优先面向 darwin/linux，但接口应抽象出本地安装器，避免把 Unix-only 语义直接焊死在高层逻辑中。

### 错误输出原则

所有错误输出都应同时包含：

1. 发生了什么
2. 检测依据是什么
3. 下一步建议怎么做

---

## 建议的统一错误类型

建议定义统一错误分类，至少包括：

- `ManifestInvalid`
- `InstallNameConflict`
- `BrokenLocalInstall`
- `PackInputMissing`
- `UnsafePath`
- `InstallTargetOccupied`

这样 CLI、doctor 与未来的团队分发逻辑都可以复用同一套错误语义。

---

## 实施阶段

### Phase 0：协议与目录落位

先定义：

- `skills/*` 目录规范
- `skill.manifest.json` schema
- pack 产物规范
- 本地 state 规范
- CLI 语义

### Phase 1：单 skill 本地开发闭环

只用 `monitor` 跑通：

- `validate`
- `link`
- `status`
- `doctor`

### Phase 2：单 skill 本地发布验证闭环

继续只用 `monitor`：

- `pack`
- `publish-local`
- 开发态与发布态切换

### Phase 3：扩展更多 skills

把更多现有 skill 逐步迁到 `skills/*`，并补充批量管理能力。

### Phase 4：演进到团队分发

在 `pack` 产物基础上扩展 registry / bundle / git-based 分发能力。

---

## 第一阶段最小实现范围

第一阶段只实现：

1. 新增 `skills/monitor/`
2. 新增 `packages/skill-contracts/`
3. 新增 `packages/skill-devkit/`
4. 在 `apps/bata-workflow` 中增加 `skill` 子命令入口
5. 新增本地状态目录与 pack 目录
6. 跑通 `monitor` skill 的开发态与发布态闭环

第一阶段明确不做：

- 多 skill 依赖解析
- 远程发布
- 复杂版本策略
- 团队安装/升级/回滚

---

## 测试策略

测试分为 4 层：

### 1. Schema / Contracts 测试

验证：

- `SkillManifest`
- `LocalInstallRecord`
- `PackMetadata`
- 错误分类与枚举

### 2. 纯逻辑单元测试

验证：

- 路径解析
- 文件白名单展开
- 状态探测与状态对比
- broken 状态分类

### 3. 文件系统集成测试

在 fake repo root + fake coco skills root 下验证：

- `validate`
- `link`
- `unlink`
- `pack`
- `publish-local`
- `status`
- `doctor`

### 4. 端到端闭环测试

至少包含两条：

#### 开发态闭环

`validate -> link -> 修改源码 -> 本地安装立即体现变化`

#### 发布态闭环

`pack -> publish-local -> 修改源码 -> 本地安装不发生变化`

---

## 第一阶段验收标准

### 必须满足

1. 仓库中存在 `skills/monitor/`，且能被工具识别。
2. `monitor` 可通过 `validate` 成功校验。
3. `link` 后能正确安装到本地 coco 目录，并被 `status` 识别为 `linked`。
4. 修改 repo 中的 `SKILL.md` 后，开发态安装目录能即时反映变化。
5. `pack` 能生成白名单产物。
6. `publish-local` 后本地安装目录是 copy 而不是 link，并被 `status` 识别为 `published-local`。
7. 修改源码后，publish-local 安装目录不受影响。
8. `doctor` 至少能识别 installName 冲突、丢失目录、错误 link 目标、state 与探测状态不一致。
9. 关键边界条件具备自动化测试。

### 不接受的完成定义

- 只靠手工验证
- 只测 happy path
- `publish-local` 通过复制整个 skill 目录实现
- 没有 broken state 检测
- 没有 installName 冲突保护

---

## Monitor 作为 Coco 可调用 Skill 的追加设计

本节补充说明：在本地 `link / publish-local` 基础设施已经成立后，`monitor` 的下一阶段目标不是停留在“能安装的源码 seed”，而是演进为一个 **可由 Coco 手动调用 `/monitor` 的稳定 skill**，并继续支持本地持续调试、团队分发与后续迭代。

### 长期边界

`monitor` 采用“稳定 skill/runtime + 独立 viewer”边界，而不是把 UI、gateway 和运行时全塞进 skill：

- `skills/monitor/`：Coco 可调用入口、session 生命周期、标准返回协议、运行时状态、后续分发产物真源。
- `apps/monitor-board/`：可视化 viewer，仅消费 monitor session 与事件流，不作为 `/monitor` 的组成部分。

这样设计的原因是：

1. `link` 与 `publish-local` 都能持续复用同一份 skill 源码真源。
2. 没有 viewer 时 skill 仍可工作，团队分发不被 UI 依赖绑死。
3. viewer 可以单独迭代，而不破坏 `/monitor` 的稳定语义。

### 第一阶段用户语义

第一阶段锁定用户入口为：

```text
/monitor
```

其语义固定为 **create-or-attach monitor session**：

- root actor 第一次调用：创建 monitor session。
- 同一个 root session 后续再次调用：附着到已有 monitor session。
- child actor 调用：只能附着到 root session 对应 monitor，不允许创建嵌套 monitor。

这条语义一旦稳定，后续 viewer、gateway、事件流扩展都不能改变 `/monitor` 的基本含义。

### 第一阶段状态机

`/monitor` 第一阶段只需要 4 个概念状态：

1. `created`：首次创建成功。
2. `attached`：已有 monitor session，被当前 actor 附着。
3. `active`：开始真正接收监控事件流（第二阶段接入）。
4. `closed|stale`：session 已结束或过期（先保留状态语义，不在第一阶段暴露 close 命令）。

第一阶段实际可观测行为只要求稳定支持 `create` 与 `attach`，但状态模型必须为后续 `active/closed` 留扩展位。

### Monitor session 标识规则

monitor session 标识固定为：

```text
monitor:<rootSessionId>
```

这样可保证：

- 一个 root session 只有一个 monitor。
- attach 时不需要额外分配 ID 或中心化查找。
- viewer / gateway / 本地调试脚本都能稳定复用同一 ID 规则。

### 第一阶段稳定返回协议

`/monitor` 第一阶段的返回结果固定为结构化协议，而不是自由文本。推荐模型：

```ts
type MonitorInvokeResult = {
  kind: 'create' | 'attach'
  monitorSessionId: string
  rootSessionId: string
  requesterActorId: string
  isRootActor: boolean
  message: string
}
```

兼容策略：后续版本允许增加字段（如 `viewerHint`、`metadata`、`gatewayUrl`），但不删除上述核心字段。

### Skill 内部分层

`skills/monitor` 的长期结构固定为三层：

1. **稳定入口层**：Coco 可见的 skill 入口文件，例如 `SKILL.md`（或 Coco 要求的等价入口）。
2. **运行时适配层**：如 `src/runtime/invoke-monitor.ts`、`src/runtime/session-service.ts`，负责读取上下文、执行 create/attach、输出稳定协议。
3. **核心逻辑层**：`protocol/`、`runtime-store/`、`skill/monitor-command.ts` 等纯逻辑模块，不直接绑定 Coco 或 UI。

这能保证：

- `link` 与 `publish-local` 都使用同一入口契约。
- 内部模块后续可重构或抽成共享包，而不影响 `/monitor`。

### 第一阶段最小持久化

除 skill 安装态之外，第一阶段还需要独立的 monitor runtime state。建议最小字段：

- `rootSessionId`
- `monitorSessionId`
- `ownerActorId`
- `lastAttachedActorId`
- `status`
- `createdAt`
- `updatedAt`

这份状态用于支撑重复 `/monitor` 调用、attach 判定、后续 `doctor` 扩展，以及 viewer/gateway 的无缝接入；它不应与 skill 安装态记录混在一起。

### 第一阶段必须成立的闭环

第一阶段完成的判断标准新增为：

1. `monitor` 具备 Coco 可调用的稳定入口，而不再只是源码导出 seed。
2. 手动 `/monitor` 第一次调用会创建 monitor session。
3. 同一 root session 下再次 `/monitor` 只会 attach，不会重复创建。
4. child actor 调用 `/monitor` 只 attach，不创建嵌套 monitor。
5. `link` 与 `publish-local` 两种安装形态在 `/monitor` 行为上保持一致。

### 第一阶段明确不做

第一阶段仍然不做：

- 自动拉起 `monitor-board`
- 完整 websocket gateway 接线
- 实时 timeline UI
- close / reopen 命令
- bata-workflow CLI 内部 `/monitor` 兼容入口

这些内容进入第二阶段，在不破坏 `/monitor = create-or-attach monitor session` 稳定语义的前提下增量接入。

---

## 最终结论

本设计推荐采用如下方向：

1. **源码目录固定在 `skills/*`**。
2. **本地安装只区分 `link` 与 `publish-local` 两种模式**。
3. **`pack` 作为正式中间层**，未来团队分发能力建立在 pack 产物之上。
4. **`apps/bata-workflow` 只作为 CLI shell**，skill 生命周期逻辑沉淀在 `packages/skill-devkit`。
5. **第一阶段只拿 `monitor` 跑通本地闭环**，但协议、目录和状态模型按最终平台方向设计。

一句话总结：

> 先把本地 skill 开发、校验、link、pack、publish-local 做成稳定的 monorepo 基础设施，再在这套基础设施之上演进团队分发与平台化能力。
