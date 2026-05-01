#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { parseAgentOutput } from '../src/protocol/schemas/agent-output.mjs'

const DEFAULT_MODEL = 'gpt-5.3-codex'

/**
 * Run Default Agent By Mode - 按模式运行Agent
 */
export const runDefaultAgentByMode = async ({ role, prompt, mode, model, stubAgent }) => {
  if (stubAgent) {
    return runStubAgent({ role, mode })
  }

  if (mode === 'subagent') {
    try {
      return await runSubagentCocoAgent({ role, prompt, mode, model })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const timeoutLike = /deadline exceeded|timed out|timeout/i.test(message)
      if (!timeoutLike) {
        throw error
      }

      // Fallback: keep role separation but avoid subagent deadlock.
      return await runIndependentCocoAgent({ role, prompt, mode: 'independent-fallback', model })
    }
  }

  return await runIndependentCocoAgent({ role, prompt, mode, model })
}

/**
 * Run Independent Coco Agent - 运行独立Coco Agent
 */
const runIndependentCocoAgent = async ({ role, prompt, mode, model }) => {
  const modelName = model || DEFAULT_MODEL
  const args = ['-c', `model.name=${modelName}`, '--yolo', '--query-timeout', '120s', prompt]
  return await runInteractiveCocoAgent({ role, mode, args })
}

/**
 * Run Subagent Coco Agent - 运行Subagent Coco Agent
 */
const runSubagentCocoAgent = async ({ role, prompt, mode, model }) => {
  const subagentPrompt = [
    '请优先使用 coco 内置 Agent/subAgent 能力完成当前角色目标；若超时可直接给出结构化结果。',
    '如果当前角色是 review，请使用独立 reviewer 子代理进行代码审查并返回结构化结论。',
    prompt,
  ].join('\n\n')

  const modelName = model || DEFAULT_MODEL
  const args = ['-c', `model.name=${modelName}`, '--yolo', '--query-timeout', '120s', subagentPrompt]
  return await runInteractiveCocoAgent({ role, mode, args })
}

/**
 * Run Interactive Coco Agent - 运行交互式Coco Agent
 */
const runInteractiveCocoAgent = async ({ role, mode, args }) => {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('python3', [
      '-c',
      String.raw`import os, pty, select, subprocess, sys, time

timeout_sec = float(sys.argv[1])
args = sys.argv[2:]
master, slave = pty.openpty()
proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

chunks = []
start = time.time()
last_output = start
response_seen = False

while True:
    now = time.time()
    if now - start > timeout_sec:
        break

    readable, _, _ = select.select([master], [], [], 0.2)
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break

        if not data:
            break

        chunks.append(data)
        last_output = time.time()

        if b'\xe2\x8f\xba' in data or b'{"status' in data or b'"summary"' in data:
            response_seen = True

    if proc.poll() is not None:
        break

    if response_seen and now - last_output > 1.0:
        break

if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

sys.stdout.buffer.write(b''.join(chunks))`,
      '130',
      'coco',
      ...args,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RALPH_ROLE: role,
        RALPH_MODE: mode,
        RALPH_AGENT_KIND: mode.includes('subagent') ? 'subagent' : 'independent',
      },
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0) {
        const normalized = extractPtyAssistantOutput(stdout)
        resolvePromise({ stdout: normalized, stderr: stderr.trim() })
        return
      }
      rejectPromise(new Error(stderr.trim() || extractPtyAssistantOutput(stdout) || `coco exited with code ${code}`))
    })
  })
}

/**
 * Run Stub Agent - 运行Stub Agent（用于测试）
 */
const runStubAgent = async ({ role, mode }) => {
  const base = {
    status: 'completed',
    summary: `[stub] ${role} completed in ${mode}`,
    suggestions: [],
  }

  if (role === 'review') {
    base.suggestions = ['[stub] review建议: 在正式运行时补充更严格的断言和边界验证。']
  }

  return {
    stdout: JSON.stringify(base),
    stderr: '',
  }
}

/**
 * Extract Pty Assistant Output - 提取PTY Assistant输出
 */
const extractPtyAssistantOutput = (raw) => {
  const cleaned = stripTerminalControl(raw)
  const lines = cleaned.split('\n')
  const blocks = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const markerIndex = line.indexOf('⏺')
    if (markerIndex < 0) {
      continue
    }

    const block = []
    const firstLine = line.slice(markerIndex + 1).trim()
    if (firstLine) {
      block.push(firstLine)
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const continuation = lines[cursor]
      if (continuation.includes('⏺') || isPtyChromeLine(continuation)) {
        break
      }

      const trimmed = continuation.trim()
      if (trimmed) {
        block.push(trimmed)
      }
    }

    if (block.length > 0) {
      blocks.push(block)
    }
  }

  const lastBlock = blocks.at(-1)
  if (!lastBlock) {
    return cleaned.trim()
  }

  const compact = lastBlock.join('').trim()
  if (compact.startsWith('{') || compact.startsWith('[')) {
    return compact
  }

  return lastBlock.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Strip Terminal Control - 去除终端控制字符
 */
const stripTerminalControl = (raw) => {
  return raw
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
}

/**
 * Is Pty Chrome Line - 判断是否为PTY Chrome行
 */
const isPtyChromeLine = (line) => {
  const trimmed = line.trim()
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('╭') ||
    trimmed.startsWith('╰') ||
    trimmed.startsWith('│ >') ||
    trimmed.startsWith('$/!') ||
    trimmed.startsWith('⬡ ') ||
    trimmed.startsWith('initializing MCP servers') ||
    trimmed.startsWith('upgrading') ||
    trimmed.includes('Thinking...') ||
    trimmed.startsWith('Thought')
  )
}

export { parseAgentOutput }
