#!/usr/bin/env node

/**
 * Ralph Skill 自验证脚本
 * 
 * 使用ralph自己的能力来验证其功能是否符合预期
 * 这是一种更适合skill特性的测试方式
 */

import { invokeRalph } from './invoke-ralph.mjs'
import { buildStatePaths } from './state-manager.mjs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

let testsPassed = 0
let testsFailed = 0

function pass(message) {
  testsPassed++
  console.log(`${GREEN}✓${RESET} ${message}`)
}

function fail(message) {
  testsFailed++
  console.log(`${RED}✗${RESET} ${message}`)
}

function info(message) {
  console.log(`${YELLOW}ℹ${RESET} ${message}`)
}

function createTestWorkspace() {
  const workspace = resolve(tmpdir(), `ralph-test-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  return workspace
}

function cleanupTestWorkspace(workspace) {
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * 场景1: 验证简单需求能正确拆分
 */
async function testSimpleRequirementDecomposition() {
  info('测试场景1: 简单需求拆分')
  
  const workspace = createTestWorkspace()
  
  try {
    const result = await invokeRalph({
      cwd: workspace,
      goal: '实现一个计数器组件',
      dryRunPlan: true,
      mode: 'independent',
    })

    // 验证1: 应该返回规划结果
    if (result.kind !== 'plan') {
      fail('应该返回plan类型的结果')
      return
    }

    // 验证2: 应该生成至少3个任务
    if (result.tasks.length < 3) {
      fail(`应该生成至少3个任务，实际生成了${result.tasks.length}个`)
      return
    }

    // 验证3: 第一个任务应该包含需求分析
    const firstTask = result.tasks[0]
    if (!firstTask.title.includes('需求') && !firstTask.title.includes('分析')) {
      fail('第一个任务应该包含需求分析')
      return
    }

    // 验证4: 所有任务都应该有验收标准
    const allHaveAcceptance = result.tasks.every(task => 
      task.acceptance && task.acceptance.length > 0
    )
    if (!allHaveAcceptance) {
      fail('所有任务都应该有验收标准')
      return
    }

    pass('简单需求能正确拆分为多个任务')
  } catch (error) {
    fail(`测试失败: ${error.message}`)
  } finally {
    cleanupTestWorkspace(workspace)
  }
}

/**
 * 场景2: 验证文档驱动开发
 */
async function testDocumentDrivenDevelopment() {
  info('测试场景2: 文档驱动开发')
  
  const workspace = createTestWorkspace()
  const docsDir = resolve(workspace, 'docs')
  mkdirSync(docsDir, { recursive: true })
  
  try {
    // 创建测试文档
    writeFileSync(resolve(docsDir, 'spec.md'), `
# 用户认证模块

## 功能点

### 用户注册
- 邮箱验证
- 密码加密存储

### 用户登录
- Session管理
- 记住我功能

## 技术要点

- 使用bcrypt加密
- JWT token有效期7天
`, 'utf8')

    const result = await invokeRalph({
      cwd: workspace,
      path: docsDir,
      dryRunPlan: true,
      mode: 'independent',
    })

    // 验证1: 应该从文档中提取任务
    if (result.tasks.length < 4) {
      fail(`应该从文档中提取至少4个任务，实际生成了${result.tasks.length}个`)
      return
    }

    // 验证2: 任务应该引用源文档
    const tasksWithSourceRefs = result.tasks.filter(task => 
      task.sourceRefs && task.sourceRefs.length > 0
    )
    if (tasksWithSourceRefs.length < result.tasks.length / 2) {
      fail('至少一半的任务应该引用源文档')
      return
    }

    // 验证3: 应该包含文档中的关键功能点
    const taskTitles = result.tasks.map(t => t.title).join(' ')
    const hasRegister = taskTitles.includes('注册') || taskTitles.includes('register')
    const hasLogin = taskTitles.includes('登录') || taskTitles.includes('login')
    
    if (!hasRegister || !hasLogin) {
      fail('应该包含文档中的主要功能点（注册和登录）')
      return
    }

    pass('文档驱动开发能正确提取任务')
  } catch (error) {
    fail(`测试失败: ${error.message}`)
  } finally {
    cleanupTestWorkspace(workspace)
  }
}

/**
 * 场景3: 验证Review循环
 */
async function testReviewLoop() {
  info('测试场景3: Review循环')
  
  const workspace = createTestWorkspace()
  
  try {
    let codingCallCount = 0
    let reviewCallCount = 0

    const result = await invokeRalph({
      cwd: workspace,
      goal: '实现测试功能',
      execute: true,
      mode: 'independent',
      todoBuilder: () => [
        {
          id: 'task-review-test',
          title: '测试review循环',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
          acceptance: ['完成功能', '编写测试'],
          verification_cmds: ['echo "test"'],
        },
      ],
      runAgent: async ({ role }) => {
        if (role === 'coding') {
          codingCallCount++
          return {
            stdout: JSON.stringify({ 
              status: 'completed', 
              summary: `coding round ${codingCallCount}`,
              suggestions: [],
            }),
            stderr: '',
          }
        }

        reviewCallCount++
        // 第一轮review不通过，第二轮通过
        if (reviewCallCount === 1) {
          return {
            stdout: JSON.stringify({
              status: 'needs_changes',
              summary: '需要补充测试',
              suggestions: ['增加边界测试'],
              requiredFixes: ['补充测试用例'],
            }),
            stderr: '',
          }
        }

        return {
          stdout: JSON.stringify({
            status: 'completed',
            summary: 'review passed',
            suggestions: [],
          }),
          stderr: '',
        }
      },
    })

    // 验证1: 应该执行了2轮coding
    if (codingCallCount !== 2) {
      fail(`应该执行2轮coding，实际执行了${codingCallCount}轮`)
      return
    }

    // 验证2: 应该执行了2轮review
    if (reviewCallCount !== 2) {
      fail(`应该执行2轮review，实际执行了${reviewCallCount}轮`)
      return
    }

    // 验证3: 任务应该最终完成
    if (result.tasks[0].status !== 'done') {
      fail(`任务应该最终完成，实际状态是${result.tasks[0].status}`)
      return
    }

    // 验证4: reviewRounds应该记录正确
    if (result.tasks[0].reviewRounds !== 2) {
      fail(`reviewRounds应该为2，实际是${result.tasks[0].reviewRounds}`)
      return
    }

    pass('Review循环工作正常')
  } catch (error) {
    fail(`测试失败: ${error.message}`)
  } finally {
    cleanupTestWorkspace(workspace)
  }
}

/**
 * 场景4: 验证Schema合规性
 */
async function testSchemaCompliance() {
  info('测试场景4: Schema合规性')
  
  const workspace = createTestWorkspace()
  
  try {
    const result = await invokeRalph({
      cwd: workspace,
      goal: '测试schema',
      dryRunPlan: true,
      mode: 'independent',
    })

    // 验证所有任务都有必需字段
    const requiredFields = ['id', 'title', 'status', 'acceptance', 'verification_cmds']
    
    for (const task of result.tasks) {
      for (const field of requiredFields) {
        if (!task[field]) {
          fail(`任务 ${task.id} 缺少必需字段: ${field}`)
          return
        }
      }
    }

    // 验证状态值合法
    const validStatuses = ['pending', 'in_progress', 'done', 'blocked']
    for (const task of result.tasks) {
      if (!validStatuses.includes(task.status)) {
        fail(`任务 ${task.id} 有非法状态: ${task.status}`)
        return
      }
    }

    // 验证deps是数组
    for (const task of result.tasks) {
      if (!Array.isArray(task.deps)) {
        fail(`任务 ${task.id} 的deps应该是数组`)
        return
      }
    }

    pass('所有任务都符合Schema定义')
  } catch (error) {
    fail(`测试失败: ${error.message}`)
  } finally {
    cleanupTestWorkspace(workspace)
  }
}

/**
 * 场景5: 验证状态持久化
 */
async function testStatePersistence() {
  info('测试场景5: 状态持久化')
  
  const workspace = createTestWorkspace()
  
  try {
    const result = await invokeRalph({
      cwd: workspace,
      goal: '测试持久化',
      dryRunPlan: true,
      mode: 'independent',
    })

    const statePaths = buildStatePaths(workspace)

    // 验证状态文件是否创建
    if (!existsSync(statePaths.sessionPath)) {
      fail('应该创建session.json')
      return
    }

    if (!existsSync(statePaths.tasksPath)) {
      fail('应该创建tasks.json')
      return
    }

    if (!existsSync(statePaths.todoMarkdownPath)) {
      fail('应该创建TODO.md')
      return
    }

    // 验证状态文件内容
    const session = JSON.parse(readFileSync(statePaths.sessionPath, 'utf8'))
    if (!session.sessionId || !session.status) {
      fail('session.json应该包含sessionId和status')
      return
    }

    const tasks = JSON.parse(readFileSync(statePaths.tasksPath, 'utf8'))
    if (!Array.isArray(tasks) || tasks.length === 0) {
      fail('tasks.json应该包含任务数组')
      return
    }

    pass('状态持久化正常')
  } catch (error) {
    fail(`测试失败: ${error.message}`)
  } finally {
    cleanupTestWorkspace(workspace)
  }
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('\n=== Ralph Skill 自验证测试 ===\n')
  
  await testSimpleRequirementDecomposition()
  await testDocumentDrivenDevelopment()
  await testReviewLoop()
  await testSchemaCompliance()
  await testStatePersistence()
  
  console.log('\n=== 测试总结 ===')
  console.log(`${GREEN}通过: ${testsPassed}${RESET}`)
  console.log(`${RED}失败: ${testsFailed}${RESET}`)
  
  if (testsFailed > 0) {
    process.exit(1)
  }
}

// 执行测试
runAllTests().catch(error => {
  console.error('测试执行失败:', error)
  process.exit(1)
})
