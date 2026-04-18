import { appendFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as readline from 'node:readline'

export type RuntimeEventEnvelope = {
  id: string
  seq: number
  createdAt: string
  runId: string
  runDirectory: string
  type: string
  payload: Record<string, unknown>
}

export type RuntimeEventStreamReadResult = {
  events: RuntimeEventEnvelope[]
  nextCursor: number
}

const EVENT_STREAM_FILE_NAME = 'events.ndjson'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function getEventStreamPath(runDirectory: string): string {
  return resolve(runDirectory, EVENT_STREAM_FILE_NAME)
}

export function appendRuntimeEvent(params: {
  runDirectory: string
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt?: string
  id?: string
}): RuntimeEventEnvelope {
  const createdAt = params.createdAt ?? new Date().toISOString()
  const event: RuntimeEventEnvelope = {
    id: params.id ?? randomUUID(),
    seq: params.seq,
    createdAt,
    runId: basename(params.runDirectory),
    runDirectory: params.runDirectory,
    type: params.type,
    payload: params.payload
  }

  const filePath = getEventStreamPath(params.runDirectory)
  ensureDir(dirname(filePath))
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')
  return event
}

export async function readRuntimeEventsSince(runDirectory: string, cursor: number): Promise<RuntimeEventStreamReadResult> {
  const filePath = getEventStreamPath(runDirectory)
  if (!existsSync(filePath)) {
    return { events: [], nextCursor: cursor }
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const events: RuntimeEventEnvelope[] = []
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
      const parsed = JSON.parse(trimmed) as RuntimeEventEnvelope
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        continue
      }
      events.push(parsed)
    } catch {
      continue
    }
  }

  return { events, nextCursor: lineNumber }
}

export async function readAllRuntimeEvents(runDirectory: string): Promise<RuntimeEventEnvelope[]> {
  const { events } = await readRuntimeEventsSince(runDirectory, 0)
  return events
}
