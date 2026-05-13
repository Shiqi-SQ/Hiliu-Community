// Google 搜索（www.google.com/search）——需自备网络，国内默认不可达。
// 保留给海外/有梯子用户；是否参与由 settings 引擎链决定。
//
// 选择器（2026-04 时点）：结果块 div.g / div.tF2Cxc / div.MjjYud；
// 摘要 .VwiC3b / .yXK7lf / [data-sncf]——Google 改版时主要变这里。
// hl=en + gl=us 强制英文界面——中文界面有时塞知识图谱影响选择器。

import * as cheerio from 'cheerio'
import { fetchText } from './http'
import type { SearchResult } from './parsers/bingParser'

const GOOGLE_BASE = 'https://www.google.com/search'

export async function searchGoogle(query: string, limit = 8): Promise<SearchResult[]> {
  const u = new URL(GOOGLE_BASE)
  u.searchParams.set('q', query)
  u.searchParams.set('hl', 'en')
  u.searchParams.set('gl', 'us')
  u.searchParams.set('num', String(Math.max(limit, 10)))

  const html = await fetchText(u.toString(), { timeoutMs: 12_000 })
  const $ = cheerio.load(html)
  const results: SearchResult[] = []
  const seen = new Set<string>()

  const items = $('div.g, div.tF2Cxc, div.MjjYud')
  items.each((_, el) => {
    if (results.length >= limit) return false
    const $el = $(el)
    const $h3 = $el.find('h3').first()
    if ($h3.length === 0) return
    const title = $h3.text().trim()
    const $a = $h3.closest('a')
    const url = ($a.attr('href') ?? '').trim()
    if (!title || !url || seen.has(url)) return
    if (!url.startsWith('http://') && !url.startsWith('https://')) return

    let snippet =
      $el.find('.VwiC3b').first().text().trim() ||
      $el.find('.yXK7lf').first().text().trim() ||
      $el.find('[data-sncf]').first().text().trim()
    if (!snippet) {
      snippet = $el.text().replace(/\s+/g, ' ').replace(title, '').trim().slice(0, 200)
    }

    seen.add(url)
    results.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) })
    return
  })

  return results
}
