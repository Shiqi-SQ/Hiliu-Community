// 联网搜索统一入口——按用户配置的引擎链顺序逐个降级。
//
// 降级触发：抛异常或返回空数组。
// 不并发多家：避免重复抓、合并逻辑复杂，顺序优先足够用。

import { searchBing, BingBlockedError } from './searchBing'
import { searchBaidu } from './searchBaidu'
import { searchSo360 } from './searchSo360'
import { searchGoogle } from './searchGoogle'
import { searchCustom } from './searchCustom'
import type { SearchResult } from './parsers/bingParser'
import type { SearchEngineConfig, SearchEngineId } from '@shared/types'
import { loadSettings } from '../store'

export type { SearchResult } from './parsers/bingParser'

export type SearchBackend = SearchEngineId

export interface SearchResponse {
  /** 实际命中的后端 */
  backend: SearchBackend
  results: SearchResult[]
  /** 降级原因链，命中第一档时为空 */
  fallbackTrail?: string[]
}

interface EngineRunner {
  id: SearchEngineId
  run: (q: string, limit: number) => Promise<SearchResult[]>
}

function buildRunner(cfg: SearchEngineConfig): EngineRunner | null {
  switch (cfg.id) {
    case 'bing':
      return { id: 'bing', run: (q, n) => searchBing(q, n) }
    case 'baidu':
      return { id: 'baidu', run: (q, n) => searchBaidu(q, n) }
    case 'so360':
      return { id: 'so360', run: (q, n) => searchSo360(q, n) }
    case 'google':
      return { id: 'google', run: (q, n) => searchGoogle(q, n) }
    case 'custom': {
      const tpl = (cfg.customUrl ?? '').trim()
      // 模板未填或缺占位符——跳过，让引擎链继续 fallback
      if (!tpl || !tpl.includes('{query}')) return null
      return { id: 'custom', run: (q, n) => searchCustom(tpl, q, n) }
    }
    default:
      return null
  }
}

function buildEngineChain(): EngineRunner[] {
  const engines = loadSettings().tools.openWebSearch.engines
  const chain: EngineRunner[] = []
  for (const cfg of engines) {
    if (!cfg.enabled) continue
    const runner = buildRunner(cfg)
    if (runner) chain.push(runner)
  }
  return chain
}

export async function webSearch(query: string, limit = 8): Promise<SearchResponse> {
  const q = query.trim()
  if (!q) throw new Error('搜索关键词为空')

  const chain = buildEngineChain()
  if (chain.length === 0) {
    throw new Error('没有可用的搜索引擎——请到「设置 → MCP / tool → open_web_search」启用至少一个引擎')
  }

  const trail: string[] = []
  for (const engine of chain) {
    try {
      const results = await engine.run(q, limit)
      if (results.length > 0) {
        return {
          backend: engine.id,
          results,
          fallbackTrail: trail.length > 0 ? trail : undefined
        }
      }
      trail.push(`${engine.id}：返回空结果`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 风控异常专门标注
      const tag = e instanceof BingBlockedError ? `${engine.id}（风控）` : engine.id
      trail.push(`${tag}：${msg}`)
    }
  }
  throw new Error(`搜索全部引擎失败——${trail.join('；')}`)
}

/** 格式化搜索结果给模型——比塞 JSON 省 token */
export function formatSearchResultsForLLM(resp: SearchResponse): string {
  const labelMap: Record<SearchBackend, string> = {
    bing: 'Bing',
    baidu: '百度',
    so360: '360 搜索',
    google: 'Google',
    custom: '自定义引擎'
  }
  const lines: string[] = []
  lines.push(`（来自 ${labelMap[resp.backend]} 的搜索结果，共 ${resp.results.length} 条）`)
  if (resp.fallbackTrail && resp.fallbackTrail.length > 0) {
    lines.push(`（注：上游引擎不可用，已降级——${resp.fallbackTrail.join('；')}）`)
  }
  lines.push('')
  resp.results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`)
    lines.push(`URL: ${r.url}`)
    if (r.snippet) lines.push(`摘要：${r.snippet}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}
