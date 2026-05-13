// daemon 按需启动（避免开机常驻），5 分钟无 RPC 自动 stop 释放资源

import { uiaClient } from './uiaClient'
import { binExists } from '../system/binPath'

const IDLE_STOP_MS = 5 * 60 * 1000   // 5 分钟无任何 RPC 就 stop
const WATCHDOG_INTERVAL_MS = 60 * 1000

let watchdogTimer: NodeJS.Timeout | null = null
let initialized = false

export function initUiaService(): void {
  if (initialized) return
  initialized = true
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[uiaService] 缺 uia-daemon.ps1 → 不挂 watchdog（工具注册时也会一并跳过）')
    return
  }
  watchdogTimer = setInterval(() => {
    if (!uiaClient.isRunning()) return
    if (uiaClient.idleMs() > IDLE_STOP_MS) {
      console.log('[uiaService] daemon 空闲 > 5min → stop')
      void uiaClient.stop().catch(() => { /* noop */ })
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdogTimer.unref?.()
}

export async function shutdownUiaService(): Promise<void> {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  initialized = false
  if (uiaClient.isRunning()) {
    await uiaClient.stop().catch(() => { /* noop */ })
  }
}

export async function uiaCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  if (!binExists('uia-daemon.ps1')) {
    throw new Error('UIA 守护脚本（uia-daemon.ps1）不存在——可能是开发环境未捆绑或安装包损坏')
  }
  if (!uiaClient.isRunning()) {
    await uiaClient.start()
  }
  return uiaClient.call<T>(method, params, timeoutMs)
}
