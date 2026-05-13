// Bing 搜索（cn.bing.com，国内可达）。
//
// 走 HTML 端点：Bing Search API 需 Azure 订阅太重；cn.bing.com 国内直连。
// 解析逻辑在 parsers/bingParser.ts（fork 自 open-websearch，多 selector + fallback）。

import { fetchText } from './http'
import { analyzeBingPage, parseBingResults, type SearchResult } from './parsers/bingParser'

export type { SearchResult } from './parsers/bingParser'

const BING_BASE = 'https://cn.bing.com/search'

/** 风控页专属错误——上层收到后立即降级，不重试 */
export class BingBlockedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BingBlockedError'
  }
}

export async function searchBing(query: string, limit = 8): Promise<SearchResult[]> {
  const u = new URL(BING_BASE)
  u.searchParams.set('q', query)
  u.searchParams.set('mkt', 'zh-CN')
  // form=QBLH 模拟从主页搜索——纯 ?q= 有时拿到极简结果
  u.searchParams.set('form', 'QBLH')

  const html = await fetchText(u.toString(), { timeoutMs: 12_000 })

  const state = analyzeBingPage(html)
  if (state.blocked) {
    throw new BingBlockedError(
      `Bing 被风控（title="${state.title}"，关键字=[${state.detectedKeywords.join(',')}]）`
    )
  }

  return parseBingResults(html, limit)
}
