import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Ralph Milestone Detection', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `ralph-milestone-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should detect Task milestone patterns', async () => {
    // 模拟 canvas-ui-component docs 目录结构
    const planContent = `
# Implementation Plan

## Execution Context

Some meta content here.

## Task 1: Add the test harness
- Step 1: Write test
- Step 2: Run test

## Task 2: Build the scene tree
Content for task 2.

## Task 3: Add layout normalization
Content for task 3.

## Task 4: Implement clip analysis
Content for task 4.

## Task 5: Generate paint commands
Content for task 5.

## Task 6: Add Canvas2D backend
Content for task 6.

## Task 7: Add WebGL backend
Content for task 7.

## Task 8: Add validation
Content for task 8.

## Task 9: Migrate the public API
Content for task 9.
`

    await writeFile(join(testDir, 'plan.md'), planContent)

    // 运行 invoke-ralph
    const { defaultTodoBuilder } = await import('../../../skills/ralph/runtime/plan-builder.mjs')
    const tasks = await defaultTodoBuilder({
      dir: testDir,
      cwd: testDir,
    })

    console.log('Generated tasks:', tasks.length)
    console.log('Task titles:', tasks.map(t => t.title))

    // 验证：应该生成大约 19 个任务 (1 analysis + 9 implementation + 9 validation)
    // 而不是之前的 72 个
    expect(tasks.length).toBeLessThan(25)
    expect(tasks.length).toBeGreaterThanOrEqual(10)

    // 验证：应该检测到 Task 1-9 里程碑
    const implTasks = tasks.filter(t => t.title.includes('实现推进'))
    expect(implTasks.length).toBeGreaterThanOrEqual(9)

    // 验证：不应该包含元内容作为任务
    const metaTasks = tasks.filter(t => 
      t.title.includes('Command snippets') || 
      t.title.includes('Execution Context')
    )
    expect(metaTasks.length).toBe(0)

    // 验证：每个任务应该有 reviewContract
    for (const task of tasks) {
      expect(task.reviewContract).toBeDefined()
    }
  })

  it('should detect M1/M2 milestone patterns', async () => {
    const specContent = `
# Design Spec

## 背景与目标
This is background info.

## M1: 重建核心数据结构
- Node Tree
- Render Tree
- LayoutResult

## M2: 打通 Canvas2D 后端
- View/Text/Image nodes
- clip chain

## M3: 接入布局感知优化
- paint bounds
- occlusion culling
`

    await writeFile(join(testDir, 'spec.md'), specContent)

    const { defaultTodoBuilder } = await import('../../../skills/ralph/runtime/plan-builder.mjs')
    const tasks = await defaultTodoBuilder({
      dir: testDir,
      cwd: testDir,
    })

    console.log('Milestone tasks:', tasks.length)

    // 应该检测到 M1-M3 (normalized to Task 1-3 in topics)
    const implTasks = tasks.filter(t => 
      t.title.includes('重建核心数据结构') || 
      t.title.includes('Canvas2D') ||
      t.title.includes('布局感知优化')
    )
    expect(implTasks.length).toBeGreaterThanOrEqual(3)

    // 不应该包含"背景与目标"作为任务
    const bgTasks = tasks.filter(t => t.title.includes('背景'))
    expect(bgTasks.length).toBe(0)
  })

  it('should fallback to keyword detection when no milestones found', async () => {
    const docContent = `
# Feature Document

## 概述
This is overview.

## 实现用户认证
- 登录
- 注册

## 添加权限校验
- 角色管理
- 权限检查

## 优化性能
- 缓存
- 懒加载
`

    await writeFile(join(testDir, 'feature.md'), docContent)

    const { defaultTodoBuilder } = await import('../../../skills/ralph/runtime/plan-builder.mjs')
    const tasks = await defaultTodoBuilder({
      dir: testDir,
      cwd: testDir,
    })

    console.log('Keyword tasks:', tasks.length)

    // 应该检测到包含实现关键词的标题
    const implTasks = tasks.filter(t => 
      t.title.includes('用户认证') || 
      t.title.includes('权限校验') ||
      t.title.includes('性能')
    )
    expect(implTasks.length).toBeGreaterThan(0)

    // 不应该包含"概述"
    const overviewTasks = tasks.filter(t => t.title.includes('概述'))
    expect(overviewTasks.length).toBe(0)
  })
})
