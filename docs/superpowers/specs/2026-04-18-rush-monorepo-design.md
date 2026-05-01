# Rush Monorepo 改造设计

## 背景

当前仓库是单包 TypeScript CLI 项目，应用代码集中在仓库根目录：

- `package.json`
- `src/`
- `tests/`
- `tsconfig.json`
- `vitest.config.ts`
- `configs/`

同时，外部还存在一个独立的 TypeScript 库项目 `tmux-manager`，位于：

- `/Users/bytedance/luobata/tt/global_transation_team_knowledge/ts-runtime/tmux-manager`

用户目标是：

1. 将当前 `bata-workflow` 仓库改造成 Rush monorepo
2. 将 `bata-workflow` 和 `tmux-manager` 都纳入新 monorepo，分别作为子项目管理
3. 使用 `apps/bata-workflow + packages/tmux-manager` 作为目录布局

## 目标

把当前仓库从单包结构改造成一个以 Rush 作为编排入口、以 pnpm workspace 作为包安装机制的 monorepo，并形成如下稳定结构：

```text
bata-workflow/
  apps/
    bata-workflow/
  packages/
    tmux-manager/
  common/
    config/
      rush/
  docs/
    superpowers/
      plans/
      specs/
  rush.json
  pnpm-workspace.yaml
  package.json
  .gitignore
```

## 非目标

本次改造不包含以下范围：

- 不重写 `bata-workflow` 的 CLI、runtime、orchestrator、TUI 架构
- 不重构 `tmux-manager` 的内部 API 与模块边界
- 不顺带统一所有 TypeScript / Vitest 配置为单一超大配置
- 不引入除 `bata-workflow` 与 `tmux-manager` 之外的新应用或新库包
- 不处理发布流水线、版本发布策略、CI 平台接入等后续议题

## 方案选择

本次采用以下方案：

- **直接把当前仓库升级为 monorepo root**，不新建外层容器仓库
- **当前 `bata-workflow` 下沉为 `apps/bata-workflow`**
- **外部 `tmux-manager` 源码迁入 `packages/tmux-manager`**

未采用的方案包括：

- 新建更上层容器仓库后再纳管两个项目
- 仅保留外部 `tmux-manager` 仓库引用而不迁入源码
- 做一个长期并存的兼容过渡层，同时维持旧根目录应用结构

原因是当前目标很明确：本仓库要直接演进为 monorepo，并把两个项目都纳入仓库内部统一维护。

## 目标结构与职责边界

### 仓库根目录

仓库根目录从“应用包根目录”转为“monorepo root”，只负责：

- Rush 项目注册与任务调度
- pnpm workspace 安装与依赖链接
- 仓库级命令入口
- 公共 Rush 配置
- 保留仓库级文档与工作流资产

根目录不再直接承载 `bata-workflow` 应用源码和测试源码。

### apps/bata-workflow

`apps/bata-workflow` 是 monorepo 中的应用项目，承接当前仓库根目录的现有 bata-workflow 内容。它继续负责：

- CLI 入口与命令解析
- planner / dispatcher / orchestrator
- runtime / team / verification / TUI
- 应用测试与运行配置

迁移后，应用源码和测试路径应当落在：

- `apps/bata-workflow/src/`
- `apps/bata-workflow/tests/`
- `apps/bata-workflow/configs/`

应用级构建与测试配置也随应用一起下沉：

- `apps/bata-workflow/package.json`
- `apps/bata-workflow/tsconfig.json`
- `apps/bata-workflow/vitest.config.ts`

### packages/tmux-manager

`packages/tmux-manager` 是 monorepo 中的库项目，承接外部 `tmux-manager` 源码。它继续负责：

- tmux pane / session 管理 API
- tmux 运行环境探测与命令执行
- team / state / monitor 等辅助模块
- 库的独立构建与独立测试

迁移后保留其独立包属性与 TypeScript 输出边界，主要路径为：

- `packages/tmux-manager/src/`
- `packages/tmux-manager/package.json`
- `packages/tmux-manager/tsconfig.json`
- `packages/tmux-manager/vitest.config.ts`

## 包间依赖关系

目标依赖关系是单向的：

```text
apps/bata-workflow  --->  packages/tmux-manager
```

约束如下：

- `apps/bata-workflow` 通过包名依赖 `@luobata/tmux-manager`
- `packages/tmux-manager` 不反向依赖 `bata-workflow`
- 不允许 `apps/bata-workflow` 继续通过跨目录相对路径直接 import `tmux-manager` 源文件
- 包间协作以 workspace dependency 与 Rush project graph 为准

这样做可以保证 `tmux-manager` 是真正可复用的内部库，而 `bata-workflow` 保持应用编排角色。

## 迁移清单

### 从仓库根目录移动到 apps/bata-workflow

以下内容应整体迁移到 `apps/bata-workflow/`：

- `package.json`
- `src/`
- `tests/`
- `tsconfig.json`
- `vitest.config.ts`
- `configs/`

迁移后，这些路径分别变为：

- `apps/bata-workflow/package.json`
- `apps/bata-workflow/src/`
- `apps/bata-workflow/tests/`
- `apps/bata-workflow/tsconfig.json`
- `apps/bata-workflow/vitest.config.ts`
- `apps/bata-workflow/configs/`

### 从外部目录迁入 packages/tmux-manager

从外部目录迁入如下内容：

- `src/`
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `README.md`

迁入目标路径为：

- `packages/tmux-manager/src/`
- `packages/tmux-manager/package.json`
- `packages/tmux-manager/tsconfig.json`
- `packages/tmux-manager/vitest.config.ts`
- `packages/tmux-manager/README.md`

### 保留在根目录的内容

以下内容保留在仓库根目录：

- `.gitignore`
- `docs/`
- `.claude/`
- 仓库级说明文档
- 新增的 monorepo 配置文件

`docs/` 保持在仓库根目录，而不是下沉到 `apps/bata-workflow/docs/`。原因是当前 `docs/superpowers/` 明显是仓库工作流资产，不只服务于应用运行时。

### 迁移后应删除或废弃的内容

以下旧结构不应继续保留为有效项目入口：

- 根目录旧应用型 `package.json` 语义
- 根目录旧 `src/`
- 根目录旧 `tests/`
- 根目录旧 `tsconfig.json`
- 根目录旧 `vitest.config.ts`
- 根目录旧 `configs/`
- 根目录 `package-lock.json`
- `packages/tmux-manager/pnpm-lock.yaml`

其中，锁文件要收敛为 monorepo 统一安装机制，不再允许子项目维持独立锁文件。

## 配置策略

### 根目录配置

仓库根目录新增并维护以下配置：

- `rush.json`
- `pnpm-workspace.yaml`
- 根 `package.json`
- `common/config/rush/` 下的 Rush 相关配置

根 `package.json` 不再代表应用身份，只作为仓库级命令入口，例如：

- 统一 build
- 统一 test
- 统一安装 / 更新依赖

### apps/bata-workflow 配置

`apps/bata-workflow/package.json` 保留应用脚本职责，包括但不限于：

- `build`
- `test`
- `dev`
- `watch`
- `plan`
- `orchestrate`
- `resume`

如果迁移过程中需要调整命令路径，应以“不改变现有脚本语义”为原则，只修正工作目录与路径引用。

### packages/tmux-manager 配置

`packages/tmux-manager/package.json` 保持库包身份，继续保留库级脚本，例如：

- `build`
- `test`
- `test:watch`

同时纳入 Rush 项目注册与 workspace 依赖体系。

## 构建策略

### 仓库级构建

由 Rush 统一调度项目构建顺序：

1. 先构建 `packages/tmux-manager`
2. 再构建 `apps/bata-workflow`

这样可以保证如果 `bata-workflow` 依赖 `tmux-manager` 的类型或产物，构建顺序始终正确。

### 项目级构建

每个项目继续保留自己的本地构建能力：

- 可以在 `apps/bata-workflow` 内独立执行应用构建
- 可以在 `packages/tmux-manager` 内独立执行库构建

仓库级编排与单项目开发应同时成立，不能相互排斥。

## 测试策略

### 子项目测试边界

测试归属保持不变：

- `apps/bata-workflow/tests/*` 继续验证 bata-workflow 应用行为
- `packages/tmux-manager` 内部测试继续验证 tmux manager 库行为

本次迁移不把两边 Vitest 配置强行合成一个超级测试配置。

### 仓库级测试入口

根目录通过 Rush 提供统一测试入口，实现：

- 跑全仓测试
- 按项目筛选测试

这样既能统一编排，又保留每个项目的独立测试边界与故障定位能力。

## TypeScript 策略

本次迁移采用“最小必要改动”原则：

- `apps/bata-workflow/tsconfig.json` 继续服务于 bata-workflow
- `packages/tmux-manager/tsconfig.json` 继续服务于 tmux-manager
- 根目录不立即抽象成统一超大 `tsconfig` 体系

如果后续确实存在高重复配置，再考虑补充共享 base config；但这不作为本次迁移前置条件。

## 依赖管理策略

### 安装与锁文件

monorepo 迁移后，依赖安装入口统一收敛到仓库根目录，使用 Rush / pnpm workspace 机制管理。子项目不再维护独立锁文件。

### 依赖声明

每个子项目仍然在自己的 `package.json` 中声明依赖；但安装、链接、去重、版本解析由 monorepo 负责。

### 内部依赖

`apps/bata-workflow` 通过 workspace dependency 依赖 `@luobata/tmux-manager`，不通过复制代码或跨目录源码引用实现共享。

## 运行方式

迁移完成后，应同时支持两种工作模式：

### 仓库级工作模式

- 在根目录统一执行 build / test
- 使用 Rush 面向整个仓库执行或筛选目标项目

### 子项目级工作模式

- 在 `apps/bata-workflow` 中继续本地开发 CLI 与 watch 流程
- 在 `packages/tmux-manager` 中继续本地开发与运行库测试

monorepo 的引入不能破坏现有单项目开发体验。

## 推荐迁移顺序

推荐按以下顺序执行：

1. 建立 monorepo root 配置
2. 下沉当前 `bata-workflow` 到 `apps/bata-workflow`
3. 迁入外部 `tmux-manager` 到 `packages/tmux-manager`
4. 修复 package 名称、workspace 依赖和脚本路径
5. 统一安装依赖
6. 分别验证两个子项目的 build / test
7. 在根目录验证 Rush 的统一 build / test

此顺序可以把问题分层定位为：

- 仓库配置问题
- 搬迁路径问题
- 子项目脚本问题
- 包间依赖问题

## 验收标准

迁移完成后，以以下标准验收：

### 结构验收

- 根目录是有效的 Rush monorepo root
- `apps/bata-workflow` 存在并承接原 bata-workflow 应用代码
- `packages/tmux-manager` 存在并承载原 tmux-manager 库代码

### 依赖验收

- 仓库只保留一套 monorepo 级依赖安装机制
- `bata-workflow` 已通过 workspace 依赖接入 `tmux-manager`

### 构建验收

- `packages/tmux-manager` 可独立 build
- `apps/bata-workflow` 可独立 build
- 根目录可统一触发构建，且项目顺序正确

### 测试验收

- `tmux-manager` 原有测试可运行
- `bata-workflow` 原有测试可运行
- 根目录可统一触发测试

### 行为验收

- `apps/bata-workflow` 的 CLI 入口仍可启动
- 现有核心脚本语义保留：`watch`、`plan`、`orchestrate`、`resume`
- 仓库不再依赖旧的单包根结构作为正式入口

## 风险与约束

本次改造的主要风险在于：

- 路径迁移可能影响测试文件、脚本文件、配置读取路径
- 根目录角色变化可能影响现有相对路径假设
- `bata-workflow` 若已有待完成改动，搬迁时更容易引入额外冲突
- `tmux-manager` 迁入后若存在发布导向配置，需要判断哪些保留、哪些只在 monorepo 内部使用

缓解策略是：

- 分阶段迁移并在每阶段执行 build / test 验证
- 优先修复路径与 workspace 依赖，不顺带做额外重构
- 先让结构稳定运行，再考虑共享配置抽象或发布治理

## 结论

本设计采用"当前仓库直接升级为 Rush monorepo"的方案，将现有 bata-workflow 应用下沉到 `apps/bata-workflow`，并把外部 `tmux-manager` 迁入 `packages/tmux-manager`。迁移后，仓库根目录专注于 monorepo 编排，子项目分别保留清晰的应用 / 库边界，并通过 workspace 依赖形成稳定的单向关系。
