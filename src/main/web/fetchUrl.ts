// fetch_url：抓具体网页并提取正文给模型读。
//
// 提取链（命中即返回）：
//   1) markdown 直通：URL/.md 或 Content-Type text/markdown → 原文直接返回
//   2) Readability：Mozilla 正文抽取器，对博客/新闻/文档命中率最高
//   3) cheerio cascade：按 article/main/#content 等候选选择器兜底
//   4) metadata：仅取 title + description——上面都失败时的最后手段
//
// 长度上限 100KB（约 33K 汉字）。

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import * as cheerio from 'cheerio'
import { fetchPage } from './http'
import { fetchHeadless } from './fetchHeadless'

export type ExtractorMode = 'readability' | 'cheerio' | 'metadata' | 'markdown'

export interface FetchedPage {
  url: string
  /** fetch 跟完所有重定向后的真实 URL */
  finalUrl: string
  title: string
  /** 作者署名——Readability 路径才有 */
  byline?: string
  /** 一句话摘要——Readability 路径才有 */
  excerpt?: string
  /** 站点名——Readability 路径才有 */
  siteName?: string
  text: string
  truncated: boolean
  extractor: ExtractorMode
  /** 给模型的额外提示，如「SPA 壳，纯 HTTP 抓不到」 */
  notice?: string
}

const MAX_TEXT_BYTES = 100 * 1024 // 100KB
const READABILITY_MIN_CHARS = 300 // 低于此视为抽取失败
const CHEERIO_MIN_CHARS = 100

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'footer',
  'aside',
  'header[role=banner]',
  '.advertisement',
  '.ads',
  '#comments',
  '.comments'
]

const CONTENT_CANDIDATES = [
  'article',
  'main',
  '[role=main]',
  '#content',
  '.content',
  '.post',
  '.article',
  '.entry-content',
  '.markdown-body' // GitHub README 等
]

function isMarkdownUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase()
    return /\.(md|markdown|mdx)(?:\?|#|$)/.test(p)
  } catch {
    return false
  }
}

function isMarkdownContentType(ct: string): boolean {
  return (
    ct.includes('text/markdown') ||
    ct.includes('application/markdown') ||
    ct.includes('text/x-markdown')
  )
}

function looksLikeHtml(s: string): boolean {
  // 只看前 2KB——足够判断 doctype/html/body
  const head = s.slice(0, 2048).toLowerCase()
  return /<!doctype html|<html[\s>]|<body[\s>]/.test(head)
}

function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface ReadabilityResult {
  title: string
  text: string
  byline?: string
  excerpt?: string
  siteName?: string
}

function extractByReadability(html: string, baseUrl: string): ReadabilityResult | null {
  let dom: JSDOM
  try {
    // url 选项让 Readability 能解析相对链接；JSDOM 默认不执行 script
    dom = new JSDOM(html, { url: baseUrl })
  } catch {
    return null
  }
  try {
    const article = new Readability(dom.window.document).parse()
    if (!article) return null
    const text = normalizeText(article.textContent ?? '')
    if (text.length < READABILITY_MIN_CHARS) return null
    return {
      title: (article.title ?? '').trim(),
      text,
      byline: (article.byline ?? '').trim() || undefined,
      excerpt: (article.excerpt ?? '').trim() || undefined,
      siteName: (article.siteName ?? '').trim() || undefined
    }
  } catch {
    return null
  } finally {
    // 释放 jsdom 资源
    try {
      dom.window.close()
    } catch {
      /* noop */
    }
  }
}

function extractByCheerio(html: string): { title: string; text: string } | null {
  const $ = cheerio.load(html)
  let title = $('title').first().text().trim()
  if (!title) title = $('h1').first().text().trim()

  for (const sel of NOISE_SELECTORS) $(sel).remove()

  let $container: cheerio.Cheerio<any> | null = null
  for (const sel of CONTENT_CANDIDATES) {
    const $c = $(sel).first()
    if ($c.length && $c.text().trim().length > CHEERIO_MIN_CHARS) {
      $container = $c
      break
    }
  }
  if (!$container) $container = $('body').first()
  if (!$container || !$container.length) return null

  const text = normalizeText($container.text())
  if (text.length < CHEERIO_MIN_CHARS) return null
  return { title, text }
}

// 命中任意一条且内容偏短，视为 SPA 壳——走 headless
const SPA_SHELL_PATTERNS = [
  /请启用\s*JavaScript/i,
  /please\s+enable\s+JavaScript/i,
  /您的浏览器(?:版本)?不支持/,
  /浏览器不支持\s*JavaScript/i,
  /JavaScript\s+is\s+(?:required|disabled)/i,
  /^[\s\S]{0,200}(?:加载中|努力加载|正在加载|loading\.\.\.|please\s+wait)/i,
  /(?:在\s*App\s*内打开|打开\s*APP|下载\s*App\s*查看|去\s*App\s*查看|前往\s*App)/i
]

function looksLikeSpaShell(text: string): boolean {
  const t = text.trim()
  if (t.length < 200) return true
  if (t.length < 1500 && SPA_SHELL_PATTERNS.some((re) => re.test(t))) return true
  // 数字密度过低——纯导航/loading 几乎没数字
  if (t.length < 1500) {
    const digitCount = (t.match(/[0-9]/g) ?? []).length
    if (digitCount / t.length < 0.01) return true
  }
  return false
}

function extractByMetadata(html: string): { title: string; text: string } | null {
  const $ = cheerio.load(html)
  const title =
    $('title').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    ''
  const desc =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    ''
  const text = normalizeText(desc)
  if (!title && !text) return null
  return {
    title,
    text: text || '（页面无可读正文，仅取到元数据。）'
  }
}

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const enc = new TextEncoder()
  if (enc.encode(text).byteLength <= maxBytes) return { text, truncated: false }
  // 中文 UTF-8 约 3 字节/字符——留余量按字符截，避免砍在多字节中间
  const approxChars = Math.floor((maxBytes / 3) * 0.95)
  return {
    text: text.slice(0, approxChars) + '\n\n…（后续已截断）',
    truncated: true
  }
}

export async function fetchUrl(url: string, maxBytes = MAX_TEXT_BYTES): Promise<FetchedPage> {
  const { text: raw, finalUrl, contentType } = await fetchPage(url, { timeoutMs: 15_000 })

  // 1) markdown 直通
  if (isMarkdownContentType(contentType) || isMarkdownUrl(finalUrl) || isMarkdownUrl(url)) {
    const text = normalizeText(raw)
    const trunc = truncateBytes(text, maxBytes)
    const m = text.match(/^#+\s+(.+)$/m)
    return {
      url,
      finalUrl,
      title: m ? m[1].trim() : '',
      text: trunc.text,
      truncated: trunc.truncated,
      extractor: 'markdown'
    }
  }

  // 2) 非 HTML（纯文本/JSON）——当纯文本处理
  if (!looksLikeHtml(raw)) {
    const text = normalizeText(raw)
    const trunc = truncateBytes(text, maxBytes)
    return {
      url,
      finalUrl,
      title: '',
      text: trunc.text,
      truncated: trunc.truncated,
      extractor: 'metadata'
    }
  }

  // 3) Readability 优先
  const r = extractByReadability(raw, finalUrl)
  if (r) {
    const trunc = truncateBytes(r.text, maxBytes)
    return {
      url,
      finalUrl,
      title: r.title,
      byline: r.byline,
      excerpt: r.excerpt,
      siteName: r.siteName,
      text: trunc.text,
      truncated: trunc.truncated,
      extractor: 'readability'
    }
  }

  // 4) cheerio 兜底——需做 SPA 壳检测。
  // 旧 bug：腾讯财经等 SPA 站 HTTP 拉到的是壳，cheerio 能抽到「打开APP/loading」
  // 几百字，直接 return 导致走不到 headless。
  const c = extractByCheerio(raw)
  if (c && !looksLikeSpaShell(c.text)) {
    const trunc = truncateBytes(c.text, maxBytes)
    return {
      url,
      finalUrl,
      title: c.title,
      text: trunc.text,
      truncated: trunc.truncated,
      extractor: 'cheerio'
    }
  }
  if (c && looksLikeSpaShell(c.text)) {
    console.log(
      `[fetchUrl] cheerio 抽到内容但疑似 SPA 壳 → headless fallback：${finalUrl} (text=${c.text.length}字)`
    )
  }

  // 5) Headless 兜底——开隐藏 BrowserWindow 跑 JS 再抽一次
  if (!c) {
    console.log(`[fetchUrl] HTTP 主链抽取失败 → headless fallback：${finalUrl}`)
  }
  let headlessHtml: string | null = null
  let headlessFinalUrl = finalUrl
  let headlessTitle = ''
  try {
    const h = await fetchHeadless(finalUrl)
    headlessHtml = h.html
    headlessFinalUrl = h.finalUrl || finalUrl
    headlessTitle = h.title || ''
  } catch (e) {
    console.warn(
      `[fetchUrl] headless fallback 失败：${e instanceof Error ? e.message : String(e)}`
    )
    headlessHtml = null
  }

  if (headlessHtml) {
    // 5a) headless 后再走 Readability
    const rh = extractByReadability(headlessHtml, headlessFinalUrl)
    if (rh) {
      const trunc = truncateBytes(rh.text, maxBytes)
      return {
        url,
        finalUrl: headlessFinalUrl,
        title: rh.title || headlessTitle,
        byline: rh.byline,
        excerpt: rh.excerpt,
        siteName: rh.siteName,
        text: trunc.text,
        truncated: trunc.truncated,
        extractor: 'readability',
        notice: '此页面是 SPA 应用——HTTP 主链抓不到，已用 headless 渲染后重新提取。'
      }
    }
    // 5b) headless 后 cheerio 兜底
    const ch = extractByCheerio(headlessHtml)
    if (ch && !looksLikeSpaShell(ch.text)) {
      const trunc = truncateBytes(ch.text, maxBytes)
      return {
        url,
        finalUrl: headlessFinalUrl,
        title: ch.title || headlessTitle,
        text: trunc.text,
        truncated: trunc.truncated,
        extractor: 'cheerio',
        notice: '此页面是 SPA 应用——HTTP 主链抓不到，已用 headless 渲染后重新提取。'
      }
    }
    // 5c) headless 后 cheerio 仍是 SPA 壳——JS 渲染未成功（反爬/需登录/数据来自交互）
    if (ch) {
      const trunc = truncateBytes(ch.text, maxBytes)
      return {
        url,
        finalUrl: headlessFinalUrl,
        title: ch.title || headlessTitle,
        text: trunc.text,
        truncated: trunc.truncated,
        extractor: 'cheerio',
        notice:
          '⚠️ 此页面是 SPA 应用，且 headless 渲染后仍未抽到有效正文——可能因为：' +
          '（a）站点检测到无界面环境拒绝渲染；（b）数据需登录/Cookie；（c）正文靠用户点击后才加载。' +
          '建议**换一个权威源**重试（实时数据可换 Yahoo Finance / Google Finance 英文站，或政府/官方静态页）。'
      }
    }
  }

  // 6) 最后兜底——仅 metadata
  const m = extractByMetadata(raw)
  if (m) {
    const trunc = truncateBytes(m.text, maxBytes)
    return {
      url,
      finalUrl,
      title: m.title,
      text: trunc.text,
      truncated: trunc.truncated,
      extractor: 'metadata',
      notice:
        'HTTP 主链 + headless 渲染都没能抽到正文——这页可能是受身份/Cookie 保护、或正文完全靠后续交互渲染。建议告诉用户「这类页面我抓不到」。'
    }
  }

  throw new Error('页面无法提取正文（HTTP + headless 都失败）')
}

export function formatFetchedPageForLLM(page: FetchedPage): string {
  const lines: string[] = []

  if (page.finalUrl && page.finalUrl !== page.url) {
    lines.push(`（已抓取 ${page.url} → ${page.finalUrl}）`)
  } else {
    lines.push(`（已抓取 ${page.url}）`)
  }
  if (page.title) lines.push(`标题：${page.title}`)
  if (page.byline) lines.push(`作者：${page.byline}`)
  if (page.siteName) lines.push(`站点：${page.siteName}`)
  if (page.excerpt) lines.push(`摘要：${page.excerpt}`)
  lines.push(`（提取方式：${extractorLabel(page.extractor)}）`)
  if (page.notice) lines.push(`（提示：${page.notice}）`)
  lines.push('')
  lines.push(page.text)
  if (page.truncated) {
    lines.push('')
    lines.push('（注：内容超过长度上限已截断；如需后段，请改用更具体的 URL 或缩小提问范围）')
  }
  return lines.join('\n')
}

function extractorLabel(m: ExtractorMode): string {
  switch (m) {
    case 'readability':
      return 'Readability 正文抽取'
    case 'cheerio':
      return 'CSS 选择器兜底'
    case 'metadata':
      return '仅元数据'
    case 'markdown':
      return 'Markdown 直通'
  }
}
