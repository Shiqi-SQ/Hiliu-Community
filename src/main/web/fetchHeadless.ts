// SPA 站点抓取兜底——用 Electron 内嵌 Chromium 跑无界面渲染。
//
// 不用 Playwright/Puppeteer：Electron 已自带完整 Chromium，再装一份浪费 120~150MB。
// BrowserWindow show:false 天然 headless，DOM/JS/网络全部正常。
//
// 调用语义：仅在 fetchUrl 主链失败时调用。
// 风险：show:false 某些页面会走移动版/简化版；频繁创建/销毁有 GPU 进程开销。

import { BrowserWindow, session as electronSession } from 'electron'
import { SafetyError, validateExternalURL } from './safety'

export interface HeadlessFetchOptions {
  timeoutMs?: number
  networkIdleMs?: number
  userAgent?: string
}

export interface HeadlessFetchResult {
  html: string
  finalUrl: string
  title: string
}

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_NETWORK_IDLE_MS = 1000

export async function fetchHeadless(
  url: string,
  opts: HeadlessFetchOptions = {}
): Promise<HeadlessFetchResult> {
  let parsed: URL
  try {
    parsed = validateExternalURL(url)
  } catch (e) {
    if (e instanceof SafetyError) throw new Error(`拒绝访问：${e.message}`)
    throw e
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const idleMs = opts.networkIdleMs ?? DEFAULT_NETWORK_IDLE_MS

  // 独立 partition——不与主进程或上次调用共享 cookie/storage
  const partitionName = `fetchHeadless-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const sess = electronSession.fromPartition(partitionName)

  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1280,
    height: 800,
    webPreferences: {
      session: sess,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
      webgl: false,
      backgroundThrottling: false
    }
  })

  if (opts.userAgent) win.webContents.setUserAgent(opts.userAgent)

  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* noop */
    }
    try {
      void sess.clearStorageData().catch(() => undefined)
    } catch {
      /* noop */
    }
  }

  // 总超时——race 同时压住 loadURL 和 networkIdle 等待
  const totalTimeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`headless 渲染超时（${timeoutMs}ms）`)), timeoutMs)
  )

  try {
    // 1) 加载 URL——dom-ready 时 resolve，SPA xhr 还在路上
    await Promise.race([win.loadURL(parsed.toString()), totalTimeout])

    // 2) 等 networkIdle
    await Promise.race([waitForNetworkIdle(win, sess, idleMs), totalTimeout])

    // 3) 取整页 outerHTML
    const html: string = await Promise.race([
      win.webContents.executeJavaScript(
        'document.documentElement && document.documentElement.outerHTML',
        true
      ),
      totalTimeout
    ])
    const finalUrl = win.webContents.getURL() || parsed.toString()
    const title = win.webContents.getTitle() || ''

    if (!html || typeof html !== 'string') {
      throw new Error('headless 渲染完成但 DOM 为空')
    }
    return { html, finalUrl, title }
  } finally {
    destroy()
  }
}

/**
 * 等到「networkIdle」——inflight 请求数持续 idleMs 无变化算空闲。
 * 语义与 Playwright networkidle 对齐。
 * 长连接（websocket/EventSource）会让 inflight 永不归零，总超时兜底。
 */
function waitForNetworkIdle(
  _win: BrowserWindow,
  sess: Electron.Session,
  idleMs: number
): Promise<void> {
  return new Promise((resolve) => {
    let inflight = 0
    let idleTimer: NodeJS.Timeout | null = null
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      // 显式卸载 hook
      try {
        sess.webRequest.onBeforeRequest(null)
        sess.webRequest.onCompleted(null)
        sess.webRequest.onErrorOccurred(null)
      } catch {
        /* noop */
      }
      resolve()
    }

    const onChange = (): void => {
      if (settled) return
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (inflight <= 0) {
        idleTimer = setTimeout(finish, idleMs)
      }
    }

    sess.webRequest.onBeforeRequest((_details, cb) => {
      inflight++
      onChange()
      cb({})
    })
    sess.webRequest.onCompleted(() => {
      inflight = Math.max(0, inflight - 1)
      onChange()
    })
    sess.webRequest.onErrorOccurred(() => {
      inflight = Math.max(0, inflight - 1)
      onChange()
    })

    // 冷启动：还没发任何请求时直接触发空闲
    onChange()
  })
}
