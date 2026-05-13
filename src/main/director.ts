import { powerMonitor } from 'electron'
import {
  BOREDOM_INTERVAL_MS_BY_VIBRANCY,
  ClipName,
  NAP_DELAY_SEC,
  NapDelay,
  PlayClipOptions,
  Vibrancy
} from '@shared/types'
import { onSleepEnd, onSleepStart } from './vitals'

// busy=占位 clip / idle=静态图 / falling-asleep=入睡链 / sleeping=睡眠 loop / waking-up=收尾
type Mode = 'busy' | 'idle' | 'falling-asleep' | 'sleeping' | 'waking-up'

interface DirectorDeps {
  sendPlayClip: (name: ClipName, opts: PlayClipOptions) => void
}

class Director {
  // 启动时 Pet 自播 'start'
  private mode: Mode = 'busy'
  private currentClip: ClipName | null = 'start'
  // 已 dispatch 待接上的下一跳；boundary 时抬成 currentClip
  private expectedNext: ClipName | null = null

  private vibrancy: Vibrancy = 'normal'
  private napDelaySec: number = NAP_DELAY_SEC['30min']
  private lastBoredomAt = 0
  private lastBoredomClip: ClipName | null = null

  private deps: DirectorDeps | null = null
  private tickTimer: NodeJS.Timeout | null = null

  init(deps: DirectorDeps): void {
    this.deps = deps
    this.lastBoredomAt = Date.now()
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  applySettings(settings: { vibrancy: Vibrancy; idleNapAfter: NapDelay }): void {
    this.vibrancy = settings.vibrancy
    this.napDelaySec = NAP_DELAY_SEC[settings.idleNapAfter]
  }

  // 唯一对外入口：先更 mirror 再发 IPC，避免认知漂移
  dispatch(name: ClipName, opts: PlayClipOptions = {}): void {
    if (!this.deps) return
    this.notifyDispatched(name, opts)
    this.deps.sendPlayClip(name, opts)
  }

  // Pet onClipBoundary 回调；name=null 表示 stopClip(force) 显式回 idle
  // 注意：loop clip 不发 boundary，sleeping 阶段不会反复调到这里
  notifyClipDone(name: ClipName | null): void {
    if (name === null) {
      this.currentClip = null
      this.expectedNext = null
      return
    }

    this.currentClip = this.expectedNext
    this.expectedNext = null

    // 'exit' 由 main 处理 app.exit
    if (name === 'exit') return

    if (this.mode === 'falling-asleep') {
      this.handleFallingAsleepBoundary(name)
      return
    }
    if (this.mode === 'waking-up') {
      this.mode = 'idle'
      this.lastBoredomAt = Date.now()
      return
    }
    if (this.mode === 'sleeping') {
      // 兜底：sleeping 正常没 boundary，被外部 stopClip 才到这
      this.mode = 'idle'
      onSleepEnd()
      this.lastBoredomAt = Date.now()
      return
    }
    if (this.mode === 'busy') {
      if (this.currentClip === null) {
        this.mode = 'idle'
        this.lastBoredomAt = Date.now()
      }
      return
    }
  }

  private handleFallingAsleepBoundary(name: ClipName): void {
    if (name === 'idle-tire2-start') {
      this.mode = 'sleeping'
      onSleepStart()
      return
    }
    // 兜底：被外部 debug 中断
    this.mode = 'idle'
    this.lastBoredomAt = Date.now()
  }

  private tick(): void {
    const sysIdleSec = powerMonitor.getSystemIdleTime()

    // 醒来：sleeping 下鼠键活动立刻播收尾
    if (this.mode === 'sleeping' && sysIdleSec < 1) {
      this.dispatch('idle-tire2-end', { force: true })
      this.mode = 'waking-up'
      onSleepEnd()
      return
    }

    // 入睡：idle + 系统空闲超阈值
    if (
      this.mode === 'idle' &&
      this.currentClip === null &&
      sysIdleSec >= this.napDelaySec
    ) {
      this.dispatch('idle-tire2-start', { force: true, next: 'idle-tire2-loop' })
      this.mode = 'falling-asleep'
      return
    }

    // 无聊穿插：仅在 idle 且无动作时
    if (this.mode === 'idle' && this.currentClip === null) {
      const interval = BOREDOM_INTERVAL_MS_BY_VIBRANCY[this.vibrancy]
      if (
        interval !== Number.POSITIVE_INFINITY &&
        Date.now() - this.lastBoredomAt >= interval
      ) {
        const pick = this.pickBoredomClip(this.lastBoredomClip)
        if (pick) {
          this.lastBoredomClip = pick
          this.lastBoredomAt = Date.now()
          this.dispatch(pick, { force: true })
          this.mode = 'busy'
        }
      }
    }
  }

  // mirror Pet.tsx playClip 的决策：force/idle 立切，否则排队
  private notifyDispatched(name: ClipName, opts: PlayClipOptions): void {
    const force = opts.force === true
    if (force || this.currentClip === null) {
      this.currentClip = name
      this.expectedNext = opts.next ?? null
    } else {
      this.expectedNext = name
    }
  }

  // 无聊穿插选什么——决定桌宠「性格」；当前是两者交替的占位
  private pickBoredomClip(prev: ClipName | null): ClipName | null {
    if (prev === 'idle-playball') return 'idle-tire'
    return 'idle-playball'
  }
}

export const director = new Director()
