// 自定义搜索引擎——URL 模板含 {query} 占位符，启发式抽取链接列表。
// 主要给公司内网搜索、自部署 SearXNG 等场景用。

import * as cheerio from 'cheerio'
import { fetchText } from './http'
import type { SearchResult } from './parsers/bingParser'

export async function searchCustom(
  template: string,
  query: string,
  limit = 8
): Promise<SearchResult[]> {
  // 模板必须含 {query}——search.ts 也会校验，此处兜底
  if (!template.includes('{query}')) {
    throw new Error('自定义引擎 URL 模板缺少 {query} 占位符')
  }
  const url = template.replace(/\{query\}/g, encodeURIComponent(query))

  const html = await fetchText(url, { timeoutMs: 12_000 })
  const $ = cheerio.load(html)
  const results: SearchResult[] = []
  const seen = new Set<string>()

  // 解析目标站域名，过滤同站导航链接
  let targetHost = ''
  try {
    targetHost = new URL(url).hostname.toLowerCase()
  } catch {
    /* noop */
  }

  $('a[href]').each((_, el) => {
    if (results.length >= limit) return false
    const $a = $(el)
    const href = ($a.attr('href') ?? '').trim()
    const title = $a.text().trim()
    if (!title || title.length < 8) return
    if (!href.startsWith('http://') && !href.startsWith('https://')) return

    let host: string
    try {
      host = new URL(href).hostname.toLowerCase()
    } catch {
      return
    }
    if (host === targetHost) return
    if (seen.has(href)) return

    const $container = $a.closest('li, article, div')
    const blockText = $container.text().replace(/\s+/g, ' ').trim()
    const snippet = blockText.replace(title, '').trim().slice(0, 200)

    seen.add(href)
    results.push({ title: title.slice(0, 200), url: href, snippet })
    return
  })

  return results
}
