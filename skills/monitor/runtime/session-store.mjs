import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readMonitorSessionState(stateFilePath) {
  try {
    const raw = await readFile(stateFilePath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function writeMonitorSessionState(stateFilePath, state) {
  await mkdir(dirname(stateFilePath), { recursive: true })

  const tempFilePath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`
  const payload = `${JSON.stringify(state, null, 2)}\n`

  await writeFile(tempFilePath, payload, 'utf8')
  await rename(tempFilePath, stateFilePath)
}
