// ClipName → { l, r } 双向 src 映射。src 只能在 renderer 声明，main 是 Node 环境无法 import .webp。
// 资源用 {name}-r.webp 命名（不用 [r]），方括号被 Vite/esbuild 当 glob 字符类会导致 URL 错误。
// idle 不是 clip，单独 export idleSources，Pet.tsx 按 facing 切。
import type { ClipName } from '@shared/types'
import idleLeftSrc from './assets/idle.webp'
import idleRightSrc from './assets/idle-r.webp'
import startLeftSrc from './assets/start.webp'
import startRightSrc from './assets/start-r.webp'
import exitLeftSrc from './assets/exit.webp'
import exitRightSrc from './assets/exit-r.webp'
import idleTireLeftSrc from './assets/idle-tire.webp'
import idleTireRightSrc from './assets/idle-tire-r.webp'
import idlePlayballLeftSrc from './assets/idle-playball.webp'
import idlePlayballRightSrc from './assets/idle-playball-r.webp'
import idleTire2StartLeftSrc from './assets/idle-tire2-start.webp'
import idleTire2StartRightSrc from './assets/idle-tire2-start-r.webp'
import idleTire2LoopLeftSrc from './assets/idle-tire2-loop.webp'
import idleTire2LoopRightSrc from './assets/idle-tire2-loop-r.webp'
import idleTire2EndLeftSrc from './assets/idle-tire2-end.webp'
import idleTire2EndRightSrc from './assets/idle-tire2-end-r.webp'
import walkStartLeftSrc from './assets/walk-start.webp'
import walkStartRightSrc from './assets/walk-start-r.webp'
import walkLoopLeftSrc from './assets/walk-loop.webp'
import walkLoopRightSrc from './assets/walk-loop-r.webp'
import walkEndLeftSrc from './assets/walk-end.webp'
import walkEndRightSrc from './assets/walk-end-r.webp'
import turnLeftSrc from './assets/turn.webp'
import turnRightSrc from './assets/turn-r.webp'
import learnLeftSrc from './assets/learn.webp'
import learnRightSrc from './assets/learn-r.webp'

export const idleSources = { l: idleLeftSrc, r: idleRightSrc } as const

export const CLIP_SOURCES: Record<ClipName, { l: string; r: string }> = {
  start: { l: startLeftSrc, r: startRightSrc },
  exit: { l: exitLeftSrc, r: exitRightSrc },
  'idle-tire': { l: idleTireLeftSrc, r: idleTireRightSrc },
  'idle-playball': { l: idlePlayballLeftSrc, r: idlePlayballRightSrc },
  'idle-tire2-start': { l: idleTire2StartLeftSrc, r: idleTire2StartRightSrc },
  'idle-tire2-loop': { l: idleTire2LoopLeftSrc, r: idleTire2LoopRightSrc },
  'idle-tire2-end': { l: idleTire2EndLeftSrc, r: idleTire2EndRightSrc },
  'walk-start': { l: walkStartLeftSrc, r: walkStartRightSrc },
  'walk-loop': { l: walkLoopLeftSrc, r: walkLoopRightSrc },
  'walk-end': { l: walkEndLeftSrc, r: walkEndRightSrc },
  turn: { l: turnLeftSrc, r: turnRightSrc },
  learn: { l: learnLeftSrc, r: learnRightSrc }
}
