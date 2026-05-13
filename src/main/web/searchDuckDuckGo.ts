// DuckDuckGo 搜索——fork 自 open-websearch。
//
// 不需要 API key，匿名访问稳定，作为境外引擎兜底。
// 优先走 preload d.js JSONP（比 HTML SERP 稳定）；失败再走 HTML SERP。
//
// 为什么不走 fetchText：DDG 需要 POST、自定义 Referer，还有 JSONP 解析；
// 直接用全局 fetch + 手动 SSRF 校验。

import * as cheerio from 'cheerio'
import { validateExternalURL } from './safety'
import type { SearchResult } from './parsers/bingParser'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const TIMEOUT_MS = 12_000

export async function searchDuckDuckGo(query: string, limit = 8): Promise<SearchResult[]> {
  try {
    const results = await searchByPreload(query, limit)
    if (results.length > 0) return results
  } catch {
    /* 静默 fallback */
  }
  return await searchByHtml(query, limit)
}

/* ============ 路径 1：preload d.js JSONP ============ */
async function searchByPreload(query: string, limit: number): Promise<SearchResult[]> {
  const homeUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&ia=web`
  validateExternalURL(homeUrl)

  const homeHtml = await fetchTextWithReferer(homeUrl, {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://duckduckgo.com/'
  })

  let preloadBase = ''
  const $ = cheerio.load(homeHtml)
  $('link[rel="preload"]').each((_i, el) => {
    const href = $(el).attr('href')
    if (href && href.includes('links.duckduckgo.com/d.js')) {
      preloadBase = href
      return false
    }
    return undefined
  })
  if (!preloadBase) {
    $('#deep_preload_script').each((_i, el) => {
      const src = $(el).attr('src')
      if (src && src.includes('links.duckduckgo.com/d.js')) {
        preloadBase = src
        return false
      }
      return undefined
    })
  }
  if (!preloadBase) {
    const m = homeHtml.match(/https:\/\/links\.duckduckgo\.com\/d\.js\?[^"']+/i)
    if (m) preloadBase = m[0]
  }
  if (!preloadBase) {
    throw new Error('未找到 DuckDuckGo preload URL')
  }

  const preloadUrl = new URL(preloadBase)
  const results: SearchResult[] = []
  let offset = 0

  while (results.length < limit) {
    preloadUrl.searchParams.set('s', String(offset))
    const dataUrl = preloadUrl.toString()
    validateExternalURL(dataUrl)
    const jsonpText = await fetchTextWithReferer(dataUrl, {
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://duckduckgo.com/'
    })
    const m = jsonpText.match(/DDG\.pageLayout\.load\('d',\s*(\[[\s\S]*?\])\s*\)/)
    if (!m) break
    let items: any[]
    try {
      items = JSON.parse(m[1])
    } catch {
      break
    }
    if (!Array.isArray(items) || items.length === 0) break
    let validInPage = 0
    for (const item of items) {
      // 含 n 字段的是导航/分页项
      if (item?.n) continue
      validInPage++
      if (results.length >= limit) continue
      const title = String(item.t ?? '').trim()
      const url = String(item.u ?? '').trim()
      if (!title || !url) continue
      results.push({
        title: title.slice(0, 200),
        url,
        snippet: stripHtml(String(item.a ?? '')).slice(0, 400)
      })
    }
    if (validInPage === 0) break
    offset += validInPage
  }

  return results.slice(0, limit)
}

/* ============ 路径 2：HTML SERP 兜底 ============ */
async function searchByHtml(query: string, limit: number): Promise<SearchResult[]> {
  const url = 'https://html.duckduckgo.com/html/'
  validateExternalURL(url)
  const body = new URLSearchParams({ q: query }).toString()

  const html = await fetchTextWithReferer(
    url,
    {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://duckduckgo.com/'
    },
    body
  )

  const $ = cheerio.load(html)
  const results: SearchResult[] = []
  $('div.result').each((_i, el) => {
    if (results.length >= limit) return false
    const $el = $(el)
    if ($el.hasClass('result--ad')) return undefined
    const $a = $el.find('a.result__a')
    const title = $a.text().trim()
    const rawUrl = $a.attr('href') ?? ''
    const snippet = $el.find('.result__snippet').text().trim()
    if (!title || !rawUrl) return undefined
    results.push({
      title: title.slice(0, 200),
      url: unwrapDdgRedirect(rawUrl),
      snippet: snippet.slice(0, 400)
    })
    return undefined
  })
  return results
}

/** DDG HTML href 常为 //duckduckgo.com/l/?uddg=<encoded real url> */
function unwrapDdgRedirect(href: string): string {
  try {
    let s = href
    if (s.startsWith('//')) s = `https:${s}`
    if (!s.startsWith('http')) return href
    const u = new URL(s)
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      const real = u.searchParams.get('uddg')
      if (real) return decodeURIComponent(real)
    }
    return s
  } catch {
    return href
  }
}

async function fetchTextWithReferer(
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<string> {
  const resp = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!resp.ok) throw new Error(`DDG HTTP ${resp.status} ${resp.statusText}`)
  return await resp.text()
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}
