import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MONITOR_BOARD_LOG_FILE_NAME } from './types';

const writeMonitorBoardLog = async (
  stateRoot: string,
  event: string,
  data: Record<string, unknown> = {},
): Promise<void> => {
  const logDirectoryPath = resolve(stateRoot, 'monitor-logs');
  const logFilePath = resolve(logDirectoryPath, MONITOR_BOARD_LOG_FILE_NAME);
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    source: 'monitor-board.gateway',
    event,
    data,
  };

  try {
    await mkdir(logDirectoryPath, { recursive: true });
    await appendFile(logFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // Logging is best-effort and should never break live snapshot building.
  }
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    if (error instanceof SyntaxError) {
      console.warn(`[monitor-board] corrupted JSON file detected: ${filePath} (${error.message})`);
      throw error;
    }

    throw error;
  }
};

const writeJsonFileAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempFilePath, filePath);
};

const readJsonLinesFile = async <T>(filePath: string): Promise<T[]> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

export {
  writeMonitorBoardLog,
  readJsonFile,
  writeJsonFileAtomic,
  readJsonLinesFile,
};
