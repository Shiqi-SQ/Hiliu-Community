// Bing SERP HTML 解析——fork 自 open-websearch (engines/bing/parser.ts)。
//
// 不直接装 open-websearch：该包 ESM-only，带 express/MCP SDK 等无用依赖。
// 只 fork 两块：多 selector + fallback link 解析、风控页检测（约 200 行）。
//
// 与上游差异：
// 1) SearchResult 字段改为 {title, url, snippet}
// 2) sanitizeBingUrl 沿用上游版本（识别协议相对、站内跳转、剥 utm）
// 3) 增加 Bing /ck/a?...&u=base64 跳转解码——纯 HTTP 模式无法靠浏览器跳转

import * as cheerio from 'cheerio'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const RESULT_SELECTORS = [
  '#b_results > li.b_algo',
  '#b_results > li.b_ans',
  '#b_results > li:not(.b_ad):not(.b_pag):not(.b_msg)',
  '#b_topw > li.b_algo',
  '#b_topw > li.b_ans',
  '.b_algo',
  '.b_ans'
]

const BOT_DETECTION_KEYWORDS = [
  'captcha',
  'verification',
  'verify you are human',
  'access denied',
  'blocked',
  'rate limit',
  'too many requests',
  '请验证',
  '验证码',
  '人机验证'
]

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Bing 跳转 URL 解码：/ck/a?...&u=a1<base64url(real_url)>
 * a1/a2 前缀是 Bing 版本号，去掉后是标准 base64url。
 */
function unwrapBingRedirect(href: string): string {
  try {
    const u = new URL(href)
    if (!u.hostname.toLowerCase().includes('bing.com')) return href
    if (!u.pathname.startsWith('/ck/')) return href
    const raw = u.searchParams.get('u')
    if (!raw) return href
    const base64 = raw.replace(/^a\d/, '')
    const decoded = Buffer.from(base64, 'base64url').toString('utf-8')
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded
    }
    return href
  } catch {
    return href
  }
}

/**
 * 规范化 Bing href：
 * - 协议相对（//xxx）补 https:
 * - 站内跳转（/search、/ck/a、/newtabredir）尝试 unwrap，失败丢弃
 * - 非 http(s) 丢弃
 * - 剥 utm 等推广参数
 */
function sanitizeBingUrl(rawUrl?: string): string {
  if (!rawUrl) return ''
  let resolved = rawUrl.trim()
  if (!resolved) return ''

  if (resolved.startsWith('//')) {
    resolved = `https:${resolved}`
  } else if (resolved.startsWith('/')) {
    if (
      resolved.startsWith('/search') ||
      resolved.startsWith('/ck/a') ||
      resolved.startsWith('/newtabredir')
    ) {
      const unwrapped = unwrapBingRedirect(`https://cn.bing.com${resolved}`)
      if (unwrapped.startsWith('http')) return unwrapped
      return ''
    }
    resolved = `https://cn.bing.com${resolved}`
  }

  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) return ''

  try {
    // 完整 URL 可能仍是 ck/a 包装，再 unwrap 一次
    const unwrapped = unwrapBingRedirect(resolved)
    const url = new URL(unwrapped)
    const hostname = url.hostname.toLowerCase()
    const pathname = url.pathname.toLowerCase()
    if (
      hostname.endsWith('bing.com') &&
      (pathname.startsWith('/search') ||
        pathname.startsWith('/ck/a') ||
        pathname.startsWith('/newtabredir'))
    ) {
      return ''
    }
    ;['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'].forEach((param) => {
      url.searchParams.delete(param)
    })
    return url.toString()
  } catch {
    return ''
  }
}

function extractTitle($el: cheerio.Cheerio<any>, fallbackUrl: string, index: number): string {
  const candidate = normalizeWhitespace(
    $el.find('h2 a').first().text() ||
      $el.find('.b_tpcn .tptt').first().text() ||
      $el.find('.b_title a').first().text() ||
      $el.find('a').first().text() ||
      $el.find('h2, h3, .b_title, .tptt').first().text()
  )
  if (candidate) return candidate.slice(0, 200)
  if (fallbackUrl) {
    try {
      return `Result from ${new URL(fallbackUrl).hostname}`
    } catch {
      /* noop */
    }
  }
  return normalizeWhitespace($el.text()).slice(0, 50) || `Result ${index + 1}`
}

function extractSnippet($el: cheerio.Cheerio<any>, title: string): string {
  const direct = normalizeWhitespace(
    $el.find('.b_caption p').first().text() ||
      $el.find('.b_caption').first().text() ||
      $el.find('.b_snippet, .b_lineclamp2, .b_lineclamp3').first().text()
  )
  if (direct) return direct.slice(0, 400)
  // 整块文本去掉标题——通常剩下的是描述
  const fallback = normalizeWhitespace($el.text()).replace(title, '').trim()
  return fallback.slice(0, 400)
}

/**
 * 主选择器都没命中时——用「找结果区域内所有可能是结果链接的 a」兜底。
 */
function collectFallbackLinks(
  $: cheerio.CheerioAPI,
  limit: number,
  seenUrls: Set<string>,
  results: SearchResult[]
): void {
  const links = $('#b_results a[href], #b_topw a[href], .b_algo a[href], .b_ans a[href]')
  links.each((index, element) => {
    if (results.length >= limit) return false
    const $a = $(element)
    const url = sanitizeBingUrl(
      $a.attr('href') || $a.attr('redirecturl') || $a.attr('data-h')
    )
    if (!url || seenUrls.has(url)) return
    const $container = $a.closest('li, .b_algo, .b_ans')
    const title = extractTitle($container, url, index)
    const snippet = extractSnippet($container, title)
    seenUrls.add(url)
    results.push({ title, url, snippet })
    return
  })
}

export function parseBingResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html)
  const results: SearchResult[] = []
  const seenUrls = new Set<string>()

  for (const selector of RESULT_SELECTORS) {
    $(selector).each((index, node) => {
      if (results.length >= limit) return false
      const $el = $(node)
      if (
        $el.hasClass('b_ad') ||
        $el.closest('.b_ad').length > 0 ||
        $el.hasClass('b_pag') ||
        $el.hasClass('b_msg')
      ) {
        return
      }
      const $title = $el.find('h2 a, .b_title a, a.tilk, a[target="_blank"]').first()
      const url = sanitizeBingUrl(
        $title.attr('href') || $title.attr('redirecturl') || $title.attr('data-h')
      )
      if (!url || seenUrls.has(url)) return
      const title = extractTitle($el, url, index)
      const snippet = extractSnippet($el, title)
      if (!title && !snippet) return
      seenUrls.add(url)
      results.push({ title, url, snippet })
      return
    })
    if (results.length >= limit) break
  }

  if (results.length === 0) {
    collectFallbackLinks($, limit, seenUrls, results)
  }

  return results.slice(0, limit)
}

export interface PageStateAnalysis {
  /** 被风控/验证页拦下——应立即降级 */
  blocked: boolean
  /** 能解析出结果——有结果就不判 blocked */
  hasResults: boolean
  /** 检测到的可疑关键字（仅供日志） */
  detectedKeywords: string[]
  /** 页面 title */
  title: string
}

/**
 * 判断页面是否被风控。
 * blocked = 没有结果 && (有 captcha UI || title 强信号 || 关键字命中 ≥2)
 */
export function analyzeBingPage(html: string): PageStateAnalysis {
  const normalized = html.toLowerCase()
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim().toLowerCase()
  const detectedKeywords = BOT_DETECTION_KEYWORDS.filter((k) => normalized.includes(k))
  const hasStructured =
    $('#b_results .b_algo, #b_results li.b_algo, .b_algo, .b_ans').length > 0
  const hasParsed = parseBingResults(html, 1).length > 0
  const hasResults = hasStructured || hasParsed
  const hasCaptchaUi =
    $(
      [
        'iframe[src*="captcha"]',
        '[id*="captcha"]',
        '[class*="captcha"]',
        'form[action*="validate"]',
        'input[name*="captcha"]',
        '#b_captcha',
        '.b_captcha'
      ].join(',')
    ).length > 0
  const hasStrongTitle = [
    'captcha',
    'verify you are human',
    'access denied',
    'too many requests',
    '验证码',
    '人机验证',
    '请验证'
  ].some((k) => title.includes(k))
  const blocked = !hasResults && (hasCaptchaUi || hasStrongTitle || detectedKeywords.length >= 2)
  return { blocked, hasResults, detectedKeywords, title }
}
