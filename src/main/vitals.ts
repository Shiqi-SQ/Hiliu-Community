// 养成属性：四属性 + lazy 结算 + 30min tick 广播。
// lazy 优先：每次读/写前按 now-lastSettleAt 结算，因为电脑休眠后 setInterval 会漂移。
// 不走 store.ts 的 settings:changed 全量广播，避免无关 UI 重渲染。

import { PetVitals, VITALS_RANGES } from '@shared/types'
import { getVitalsFromStore, setVitalsInStore } from './store'

const MOOD_DECAY_INTERVAL_MS = 30 * 60 * 1000
const ENERGY_DECAY_INTERVAL_MS = 60 * 60 * 1000
const SLEEP_RECOVERY_INTERVAL_MS = 5 * 60 * 1000
const VITALS_TICK_INTERVAL_MS = 30 * 60 * 1000

let cached: PetVitals | null = null
let sleepStartAt: number | null = null
let tickTimer: NodeJS.Timeout | null = null

function ensureCached(): PetVitals {
  if (!cached) cached = getVitalsFromStore()
  return cached
}

function clampField(value: number, key: keyof typeof VITALS_RANGES): number {
  const { min, max } = VITALS_RANGES[key]
  return Math.min(max, Math.max(min, Math.round(value)))
}

// lastSettleAt 按 mood 单位（30min）推进——energy 间隔是其 2x，按 mood 推进不会漏算 energy
function settleVitalsLazy(now: number = Date.now()): PetVitals {
  const v = ensureCached()
  const elapsed = now - v.lastSettleAt
  if (elapsed <= 0) return v

  const moodDelta = Math.floor(elapsed / MOOD_DECAY_INTERVAL_MS)
  if (moodDelta === 0) return v

  const energyDelta = Math.floor(elapsed / ENERGY_DECAY_INTERVAL_MS)

  v.mood = clampField(v.mood - moodDelta, 'mood')
  v.energy = clampField(v.energy - energyDelta, 'energy')
  v.lastSettleAt = v.lastSettleAt + moodDelta * MOOD_DECAY_INTERVAL_MS

  setVitalsInStore(v)
  return v
}

// 返回拷贝防外部误改 cache
export function getVitals(): PetVitals {
  return { ...settleVitalsLazy() }
}

export function bumpVitals(delta: Partial<PetVitals>): void {
  settleVitalsLazy()
  const v = ensureCached()
  if (typeof delta.mood === 'number') v.mood = clampField(v.mood + delta.mood, 'mood')
  if (typeof delta.knowledge === 'number')
    v.knowledge = clampField(v.knowledge + delta.knowledge, 'knowledge')
  if (typeof delta.energy === 'number') v.energy = clampField(v.energy + delta.energy, 'energy')
  if (typeof delta.bond === 'number') v.bond = clampField(v.bond + delta.bond, 'bond')
  setVitalsInStore(v)
}

// 立即结算 + 之后 30min 重复，broadcast 由 main/index 注入避免循环依赖
export function startVitalsTick(broadcast: (v: PetVitals) => void): void {
  if (tickTimer) clearInterval(tickTimer)
  broadcast(getVitals())
  tickTimer = setInterval(() => {
    broadcast(getVitals())
  }, VITALS_TICK_INTERVAL_MS)
}

export function onSleepStart(): void {
  sleepStartAt = Date.now()
}

// 每 5min 睡眠 +1 energy
export function onSleepEnd(): void {
  if (sleepStartAt === null) return
  const elapsed = Date.now() - sleepStartAt
  sleepStartAt = null
  const energyGain = Math.floor(elapsed / SLEEP_RECOVERY_INTERVAL_MS)
  if (energyGain > 0) bumpVitals({ energy: energyGain })
}
