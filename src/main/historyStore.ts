// 对话归档：userData/history/{id}.json 一对话一文件。
// 不放 settings——归档频率高（每轮 onDone），混进去会触发 electron-store 全量写。
// 文件名 == record.id（uuid 形态），防 path traversal。

import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { ConversationRecord } from '@shared/types'
import {
  clearLegacyHistoryConversations,
  readLegacyHistoryConversations,
  sanitizeConversation
} from './store'

let cachedDir: string | null = null

function historyDir(): string {
  if (cachedDir) return cachedDir
  const dir = join(app.getPath('userData'), 'history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  cachedDir = dir
  return dir
}

// path traversal 纵深防御——id 来自 randomUUID 本就符合
function isSafeId(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s) && s.length > 0 && s.length <= 128
}

function pathFor(id: string): string {
  return join(historyDir(), `${id}.json`)
}

export function listConversations(): ConversationRecord[] {
  const dir = historyDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: ConversationRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!isSafeId(id)) continue
    try {
      const text = readFileSync(join(dir, name), 'utf-8')
      const raw = JSON.parse(text)
      const sanitized = sanitizeConversation(raw)
      // 防文件名与 id 不一致导致错位
      if (sanitized && sanitized.id === id) out.push(sanitized)
    } catch {
      // 单条坏不阻断
    }
  }
  return out
}

export function saveConversation(record: ConversationRecord): boolean {
  if (!record || typeof record.id !== 'string' || !isSafeId(record.id)) return false
  if (!Array.isArray(record.messages) || record.messages.length === 0) return false
  try {
    writeFileSync(pathFor(record.id), JSON.stringify(record, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

// 幂等：文件不存在视为成功
export function deleteConversation(id: string): boolean {
  if (typeof id !== 'string' || !isSafeId(id)) return false
  try {
    const p = pathFor(id)
    if (existsSync(p)) unlinkSync(p)
    return true
  } catch {
    return false
  }
}

// 只清 .json，其他文件不动
export function clearConversations(): boolean {
  const dir = historyDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      // 单文件删不掉就继续
    }
  }
  return true
}

// 按 updatedAt 剔除最旧，saveConversation 后跟一次防膨胀
export function trimOldestBeyond(maxKeep: number): void {
  if (maxKeep <= 0) return
  const list = listConversations()
  if (list.length <= maxKeep) return
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  const overflow = list.slice(maxKeep)
  for (const c of overflow) deleteConversation(c.id)
}

// 一次性迁移：老 settings.history.conversations → history/{id}.json
export function migrateLegacyHistoryIfNeeded(): void {
  const legacy = readLegacyHistoryConversations()
  if (legacy.length === 0) return
  for (const c of legacy) saveConversation(c)
  clearLegacyHistoryConversations()
}
