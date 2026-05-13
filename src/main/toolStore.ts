// 工具配置独立持久化：userData/tool/<bareId>.json 一工具一文件。
// 文件名 ':' → '__'（Windows 文件名不允许冒号）；解析按 '__' 分段，MCP 协议保证 toolName 内无 '__'。
// loadSettings 总优先信本目录；main store 里的老 tools 段是冗余死字段。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  AppSettings,
  defaultFetchUrl,
  defaultOpenWebSearch,
  FetchUrlSettings,
  OpenWebSearchSettings,
  SearchEngineConfig,
  SearchEngineId,
  SEARCH_ENGINE_ID_LIST,
  ToolPolicy
} from '@shared/types'

const TOOL_POLICY_LIST: readonly ToolPolicy[] = ['disabled', 'ask', 'alwaysAllow']
const TOOL_DIR_NAME = 'tool'

interface ToolSettingFile {
  policy: ToolPolicy
  engines?: SearchEngineConfig[] // open_web_search 独占
  trustedDomains?: string[] // fetch_url
  deniedDomains?: string[]
}

function getToolDir(): string {
  const dir = join(app.getPath('userData'), TOOL_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// MCP 协议保证 toolName 字符在 [A-Za-z0-9_-]，只需替换冒号
export function bareIdFromToolId(id: string): string {
  return id.replace(/:/g, '__')
}

export function toolIdFromBareId(bare: string): string | null {
  const i = bare.indexOf('__')
  if (i < 0) return null
  const source = bare.slice(0, i)
  const rest = bare.slice(i + 2)
  if (source === 'builtin') return `builtin:${rest}`
  if (source === 'mcp') {
    const j = rest.indexOf('__')
    if (j < 0) return null
    return `mcp:${rest.slice(0, j)}:${rest.slice(j + 2)}`
  }
  return null
}

function readToolFile(toolId: string): ToolSettingFile | null {
  const path = join(getToolDir(), `${bareIdFromToolId(toolId)}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ToolSettingFile
  } catch {
    return null
  }
}

function writeToolFile(toolId: string, data: ToolSettingFile): void {
  const path = join(getToolDir(), `${bareIdFromToolId(toolId)}.json`)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

function sanitizePolicy(raw: unknown): ToolPolicy {
  return TOOL_POLICY_LIST.includes(raw as ToolPolicy) ? (raw as ToolPolicy) : 'ask'
}

function sanitizeEngines(raw: unknown): SearchEngineConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<SearchEngineId>()
  const out: SearchEngineConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<SearchEngineConfig>
    if (!SEARCH_ENGINE_ID_LIST.includes(e.id as SearchEngineId)) continue
    const id = e.id as SearchEngineId
    if (seen.has(id)) continue
    seen.add(id)
    const cfg: SearchEngineConfig = { id, enabled: e.enabled !== false }
    if (id === 'custom' && typeof e.customUrl === 'string') cfg.customUrl = e.customUrl
    out.push(cfg)
  }
  // 新版引擎补到末尾，避免老文件看不到
  for (const e of defaultOpenWebSearch().engines) {
    if (!seen.has(e.id)) out.push(e)
  }
  return out
}

function sanitizeDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const v = item.trim().toLowerCase()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

interface AggregatedTools {
  policies: Record<string, ToolPolicy>
  openWebSearch: OpenWebSearchSettings
  fetchUrl: FetchUrlSettings
}

export function aggregateToolsFromFiles(): AggregatedTools | null {
  const dir = getToolDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) return null

  const policies: Record<string, ToolPolicy> = {}
  let openWebSearch: OpenWebSearchSettings | null = null
  let fetchUrl: FetchUrlSettings | null = null

  for (const f of files) {
    const bare = f.slice(0, -5)
    const toolId = toolIdFromBareId(bare)
    if (!toolId) continue
    let raw: ToolSettingFile
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ToolSettingFile
    } catch {
      continue
    }
    policies[toolId] = sanitizePolicy(raw.policy)
    if (toolId === 'builtin:open_web_search') {
      const engines = sanitizeEngines(raw.engines)
      if (engines) openWebSearch = { engines }
    } else if (toolId === 'builtin:fetch_url') {
      fetchUrl = {
        trustedDomains: sanitizeDomainList(raw.trustedDomains),
        deniedDomains: sanitizeDomainList(raw.deniedDomains)
      }
    }
  }

  return {
    policies,
    openWebSearch: openWebSearch ?? defaultOpenWebSearch(),
    fetchUrl: fetchUrl ?? defaultFetchUrl()
  }
}

export function splitToolsToFiles(tools: AppSettings['tools']): void {
  // 保证 open_web_search/fetch_url 即使没 policy 也写一份子配置
  const allIds = new Set<string>(Object.keys(tools.policies ?? {}))
  allIds.add('builtin:open_web_search')
  allIds.add('builtin:fetch_url')

  for (const toolId of allIds) {
    const policy: ToolPolicy = tools.policies[toolId] ?? 'ask'
    const data: ToolSettingFile = { policy }
    if (toolId === 'builtin:open_web_search') {
      data.engines = tools.openWebSearch.engines
    } else if (toolId === 'builtin:fetch_url') {
      data.trustedDomains = tools.fetchUrl.trustedDomains
      data.deniedDomains = tools.fetchUrl.deniedDomains
    }
    writeToolFile(toolId, data)
  }
}

// 细粒度 IPC 预留——暂未对接
export function saveOneToolFile(toolId: string, data: ToolSettingFile): void {
  writeToolFile(toolId, {
    policy: sanitizePolicy(data.policy),
    engines: sanitizeEngines(data.engines),
    trustedDomains:
      data.trustedDomains !== undefined ? sanitizeDomainList(data.trustedDomains) : undefined,
    deniedDomains:
      data.deniedDomains !== undefined ? sanitizeDomainList(data.deniedDomains) : undefined
  })
}

export function readOneToolFile(toolId: string): ToolSettingFile | null {
  const raw = readToolFile(toolId)
  if (!raw) return null
  return {
    policy: sanitizePolicy(raw.policy),
    engines: sanitizeEngines(raw.engines),
    trustedDomains:
      raw.trustedDomains !== undefined ? sanitizeDomainList(raw.trustedDomains) : undefined,
    deniedDomains:
      raw.deniedDomains !== undefined ? sanitizeDomainList(raw.deniedDomains) : undefined
  }
}
