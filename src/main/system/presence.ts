// presence_state RPC 底层走 Win32 SHQueryUserNotificationState（shell32.dll）——
// 能识别 D3D 独占全屏 / 任意全屏窗口 / PPT 演示 / Win10+ 系统勿扰时段。
//
// busy 立刻生效（用户开始全屏时桌宠瞬间消失），available 延迟 1.5s（防 alt+tab 闪烁）——
// 单向防抖已与用户确认。

import { uiaCall } from '../uia/uiaService'

export type PresenceState = 'busy' | 'available' | 'unknown'

// 750ms × 2 ≈ 1.5s 的 available 防抖窗口
const POLL_INTERVAL_MS = 750
const RECOVER_DEBOUNCE_MS = 1500
const PROBE_TIMEOUT_MS = 3_000

interface PresenceRpcResult {
  state: 'busy' | 'available'
  raw: number
}

// loop 维护的稳定状态，通过 getCachedPresenceState() 同步读
let stableState: PresenceState = 'unknown'

// 上次探测到 busy 的时刻，available 防抖需要
let lastBusyAt = 0

let pollTimer: NodeJS.Timeout | null = null
let probeInFlight = false // 重入守卫：daemon 慢时不发新 RPC

const listeners = new Set<(s: PresenceState) => void>()

export async function probePresence(): Promise<PresenceState> {
  try {
    const r = await uiaCall<PresenceRpcResult>('presence_state', {}, PROBE_TIMEOUT_MS)
    return r.state
  } catch (e) {
    console.warn('[presence] probePresence 失败:', (e as Error).message)
    return 'unknown'
  }
}

// busy 立刻生效；available 从 busy 恢复需等 RECOVER_DEBOUNCE_MS；unknown 直接采纳
export function decideNextStable(
  rawProbe: PresenceState,
  stable: PresenceState,
  now: number,
  lastBusyTs: number
): PresenceState {
  if (rawProbe === 'busy') return 'busy'
  if (rawProbe === 'unknown') return 'unknown'
  if (stable !== 'busy') return 'available'
  if (now - lastBusyTs >= RECOVER_DEBOUNCE_MS) return 'available'
  return 'busy'
}

async function tick(): Promise<void> {
  if (probeInFlight) return
  probeInFlight = true
  let raw: PresenceState
  try {
    raw = await probePresence()
  } finally {
    probeInFlight = false
  }

  const now = Date.now()
  if (raw === 'busy') lastBusyAt = now

  const next = decideNextStable(raw, stableState, now, lastBusyAt)
  if (next === stableState) return
  stableState = next
  for (const cb of listeners) {
    try { cb(next) } catch (e) {
      console.warn('[presence] listener 抛错:', (e as Error).message)
    }
  }
}

export function startPresenceWatch(cb: (s: PresenceState) => void): () => void {
  listeners.add(cb)
  if (pollTimer) {
    // 已有 loop：同步触发一次，让新订阅者立刻拿到当前状态
    queueMicrotask(() => cb(stableState))
    return () => unsubscribe(cb)
  }
  pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  pollTimer.unref?.()
  void tick()
  return () => unsubscribe(cb)
}

function unsubscribe(cb: (s: PresenceState) => void): void {
  listeners.delete(cb)
  if (listeners.size > 0) return
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
  // 不重置 stableState——下次订阅时能立刻给出缓存值，防抖也能基于此判断
}

// 仅 watch 期间有意义；没人订阅时返回 'unknown'
export function getCachedPresenceState(): PresenceState {
  if (!pollTimer) return 'unknown'
  return stableState
}
