// 百度搜索（www.baidu.com/s）。
//
// 为什么选百度：Google 国内不可达；DuckDuckGo 对 desktop UA 经常返回 JS 跳转页；
// 百度 HTML 端点国内最稳。
//
// URL 处理：百度也包了一层跳转（/link?url=xxx），与 Bing 不同是 302 真实跳转，
// 无法离线解码，只能保留跳转形式。
//
// 摘要选择器：百度改版频繁。失效时先检查 .result.c-container 是否还在。

import * as cheerio from 'cheerio'
import { fetchText } from './http'
import type { SearchResult } from './searchBing'

const BAIDU_BASE = 'https://www.baidu.com/s'

export async function searchBaidu(query: string, limit = 8): Promise<SearchResult[]> {
  const u = new URL(BAIDU_BASE)
  u.searchParams.set('wd', query)
  // ie/oe 强制 utf-8——避免百度返回 GBK
  u.searchParams.set('ie', 'utf-8')
  u.searchParams.set('rn', String(Math.max(limit, 10)))

  const html = await fetchText(u.toString(), { timeoutMs: 12_000 })
  const $ = cheerio.load(html)
  const results: SearchResult[] = []

  // 主选择器：.result.c-container 是自然结果块稳定组合；备用 .c-container 含广告
  const items = $('.result.c-container').length
    ? $('.result.c-container')
    : $('.c-container')

  items.each((_, el) => {
    if (results.length >= limit) return false
    const $el = $(el)
    // 广告块通常带 tpl="adv" 等属性
    const tpl = $el.attr('tpl') ?? ''
    if (tpl.includes('ad') || tpl.includes('recommend')) return

    const $a = $el.find('h3 a').first()
    const title = $a.text().trim()
    const url = ($a.attr('href') ?? '').trim()
    if (!title || !url) return

    // 摘要：百度改版多次，按已知顺序找
    let snippet = $el.find('.c-abstract').first().text().trim()
    if (!snippet) snippet = $el.find('[class*="content-right"]').first().text().trim()
    if (!snippet) snippet = $el.find('.c-span-last').first().text().trim()
    if (!snippet) {
      const all = $el.text().replace(/\s+/g, ' ').trim()
      snippet = all.replace(title, '').trim().slice(0, 200)
    }

    results.push({ title, url, snippet })
    return
  })

  return results
}
