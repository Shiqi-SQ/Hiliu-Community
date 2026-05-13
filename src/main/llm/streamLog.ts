// 流式诊断日志：每次 streamChat 一份 JSONL → userData/diagnostics/，保留最近 20 份。
// 写盘失败永远不抛；不打 base64 图（hasParts:true 标记即可），单帧 720p ~600KB。

import { app } from 'electron'
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

const KEEP_FILES = 20

let dirCache: string | null = null
function dir(): string {
  if (dirCache) return dirCache
  dirCache = path.join(app.getPath('userData'), 'diagnostics')
  try {
    mkdirSync(dirCache, { recursive: true })
  } catch {
    /* best-effort */
  }
  return dirCache
}

export interface StreamLogger {
  readonly file: string
  event(kind: string, data?: Record<string, unknown>): void
  close(): void
}

let counter = 0

export interface StreamLogMeta {
  providerId: string
  providerName: string
  model: string
  tier: string
  mode: string
}

export function openStreamLog(meta: StreamLogMeta): StreamLogger {
  const start = Date.now()
  const d = new Date(start)
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const hms = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  const sn = (++counter).toString(36)
  const file = path.join(dir(), `stream-${ymd}-${hms}-${sn}.jsonl`)
  let closed = false

  const writeLine = (obj: Record<string, unknown>): void => {
    if (closed) return
    try {
      appendFileSync(file, JSON.stringify(obj) + '\n')
    } catch {
      /* best-effort */
    }
  }

  try {
    writeFileSync(file, JSON.stringify({ t: 0, kind: 'open', ...meta }) + '\n')
  } catch {
    /* best-effort */
  }
  console.log(`[streamLog] ${file}`)

  return {
    file,
    event(kind, data) {
      writeLine({ t: Date.now() - start, kind, ...(data ?? {}) })
    },
    close() {
      if (closed) return
      writeLine({ t: Date.now() - start, kind: 'close' })
      closed = true
    }
  }
}

// 须在 app.whenReady() 后调，userData 路径才可用
export function pruneStreamLogs(): void {
  try {
    const d = dir()
    const items = readdirSync(d)
      .filter((n) => n.startsWith('stream-') && n.endsWith('.jsonl'))
      .map((n) => ({ n, mt: statSync(path.join(d, n)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt)
    for (const item of items.slice(KEEP_FILES)) {
      try {
        unlinkSync(path.join(d, item.n))
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}
