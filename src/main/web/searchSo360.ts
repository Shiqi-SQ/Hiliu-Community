// 360 搜索（www.so.com/s）——国内备用引擎。
//
// 选择器（2026-04 时点）：结果块 li.res-list 等，统一用 [class*="res-"] 宽匹配；
// 摘要 .res-desc / .res-rich-desc / [class*="desc"]。
// so.com class 名不稳定，宽 selector + fallback 兜底。

import * as cheerio from 'cheerio'
import { fetchText } from './http'
import type { SearchResult } from './parsers/bingParser'

const SO360_BASE = 'https://www.so.com/s'

export async function searchSo360(query: string, limit = 8): Promise<SearchResult[]> {
  const u = new URL(SO360_BASE)
  u.searchParams.set('q', query)
  u.searchParams.set('ie', 'utf-8')

  const html = await fetchText(u.toString(), { timeoutMs: 12_000 })
  const $ = cheerio.load(html)
  const results: SearchResult[] = []
  const seen = new Set<string>()

  const items = $('li[class*="res-"], .result[class*="res-"]')
  items.each((_, el) => {
    if (results.length >= limit) return false
    const $el = $(el)
    const $a = $el.find('h3 a').first()
    const title = $a.text().trim()
    const url = ($a.attr('href') ?? '').trim()
    if (!title || !url || seen.has(url)) return
    if (!url.startsWith('http://') && !url.startsWith('https://')) return

    let snippet =
      $el.find('.res-desc').first().text().trim() ||
      $el.find('.res-rich-desc').first().text().trim() ||
      $el.find('[class*="desc"]').first().text().trim()
    if (!snippet) {
      snippet = $el.text().replace(/\s+/g, ' ').replace(title, '').trim().slice(0, 200)
    }

    seen.add(url)
    results.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) })
    return
  })

  return results
}
