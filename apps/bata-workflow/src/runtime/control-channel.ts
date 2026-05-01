import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as readline from 'node:readline'

export type RuntimeControlCommand =
  | { id: string; type: 'retry-task'; taskId: string; createdAt: string }
  | { id: string; type: 'abort-run'; createdAt: string }
  | { id: string; type: 'reroute-task'; taskId: string; targetRole: 'reviewer' | 'planner' | 'coder'; createdAt: string }

const CONTROL_FILE_NAME = 'control.ndjson'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function getControlFilePath(runDirectory: string): string {
  return resolve(runDirectory, CONTROL_FILE_NAME)
}

export async function appendControlCommand(runDirectory: string, command: RuntimeControlCommand): Promise<void> {
  const filePath = getControlFilePath(runDirectory)
  ensureDir(dirname(filePath))

  const stream = createWriteStream(filePath, { flags: 'a' })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.once('error', rejectPromise)
    stream.write(JSON.stringify(command) + '\n', (error) => {
      if (error) {
        rejectPromise(error)
      } else {
        resolvePromise()
      }
    })
    stream.end()
  })
}

export interface ControlChannelReadResult {
  commands: RuntimeControlCommand[]
  nextCursor: number
}

/**
 * 从 control.ndjson 读取尚未消费的控制命令。
 * cursor 采用“已消费行数”的简单语义。
 *
 * - 文件不存在时返回空结果，cursor 保持不变；
 * - 非法 JSON 行会被跳过并忽略；
 * - 解析错误不会中断读取，以免影响 runtime 主循环。
 */
export async function readPendingControlCommands(runDirectory: string, cursor: number): Promise<ControlChannelReadResult> {
  const filePath = getControlFilePath(runDirectory)
  if (!existsSync(filePath)) {
    return { commands: [], nextCursor: cursor }
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const commands: RuntimeControlCommand[] = []
  let lineNumber = 0

  for await (const line of rl) {
    lineNumber += 1
    if (lineNumber <= cursor) {
      continue
    }

    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    try {
      const parsed = JSON.parse(trimmed) as RuntimeControlCommand
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        continue
      }
      if (parsed.type === 'retry-task' || parsed.type === 'abort-run' || parsed.type === 'reroute-task') {
        commands.push(parsed)
      }
    } catch {
      // ignore malformed line
      continue
    }
  }

  return { commands, nextCursor: lineNumber }
}
