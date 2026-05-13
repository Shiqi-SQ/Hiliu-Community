// 联网工具共用的 HTTP 客户端——统一 UA、超时、重定向、错误格式。
//
// 不用 axios：Node 18+ 自带 fetch，少装依赖。
// UA 选 desktop Chrome 串：避免拿到极简 mobile 页面。
// 两个公开入口：fetchText → string；fetchPage → {text, finalUrl, contentType}

import { SafetyError, validateExternalURL } from './safety'

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT_MS = 15_000

export interface FetchTextOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  maxBytes?: number
}

export interface FetchedResource {
  text: string
  /** fetch 跟完所有重定向后的最终 URL */
  finalUrl: string
  contentType: string
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 // 2MB 入口截断

async function fetchResource(
  url: string,
  opts: FetchTextOptions
): Promise<FetchedResource> {
  let parsed: URL
  try {
    parsed = validateExternalURL(url)
  } catch (e) {
    if (e instanceof SafetyError) throw new Error(`拒绝访问：${e.message}`)
    throw e
  }
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
    ...(opts.headers ?? {})
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  let resp: Response
  try {
    resp = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // AbortSignal.timeout 触发时 e.name === 'TimeoutError'
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new Error(`请求超时（${timeoutMs}ms）`)
    }
    throw new Error(`网络错误：${msg}`)
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  }

  // resp.url 是跟完重定向后的最终 URL
  const finalUrl = resp.url || parsed.toString()
  const contentType = (resp.headers.get('content-type') ?? '').toLowerCase().trim()

  // 流式读 + 字节阈值——避免大文件吃光内存
  const reader = resp.body?.getReader()
  if (!reader) {
    return { text: await resp.text(), finalUrl, contentType }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* 忽略 cancel 抖动 */
        }
        break
      }
    }
  }
  // 按 UTF-8 解码——少数 GBK 站点会乱码，可接受
  const buf = new Uint8Array(total)
  let cursor = 0
  for (const c of chunks) {
    buf.set(c, cursor)
    cursor += c.byteLength
  }
  const text = new TextDecoder('utf-8').decode(buf)
  return { text, finalUrl, contentType }
}

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const r = await fetchResource(url, opts)
  return r.text
}

export async function fetchPage(
  url: string,
  opts: FetchTextOptions = {}
): Promise<FetchedResource> {
  return await fetchResource(url, opts)
}
