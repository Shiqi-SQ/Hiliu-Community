// rough.js 给的是 op 数组（move/lineTo/bcurveTo），不是 SVG d 字符串——需要转换
// 才能扔进 React 的 <path d={...} />。这个文件把所有 rough → SVG 的胶水抽出来，
// Bubble、RoughInput 这种"用 rough 画手绘形状"的组件都共用。
import type { Op, OpSet } from 'roughjs/bin/core'

/**
 * 把一组 rough 的 ops 转成 SVG path 的 d 字符串。rough 内部只用三种 op：
 * - move: M x y
 * - lineTo: L x y
 * - bcurveTo: C cx1 cy1, cx2 cy2, x y（三次贝塞尔）
 */
export function opsToSvgPath(ops: Op[]): string {
  const parts: string[] = []
  for (const item of ops) {
    const d = item.data
    switch (item.op) {
      case 'move':
        parts.push(`M${d[0]} ${d[1]}`)
        break
      case 'lineTo':
        parts.push(`L${d[0]} ${d[1]}`)
        break
      case 'bcurveTo':
        parts.push(`C${d[0]} ${d[1]}, ${d[2]} ${d[3]}, ${d[4]} ${d[5]}`)
        break
    }
  }
  return parts.join(' ')
}

/**
 * 从 rough Drawable 的 sets 抽出 stroke / fill 两条 d 字符串。
 * - type==='path' 是骨架描边（multistroke 时包含多笔）
 * - type==='fillPath' 是 fillStyle:'solid' 时的实心填充轮廓
 * - fillSketch（hachure 等斜线填充）我们目前都不用，忽略
 */
export function extractRoughPaths(sets: OpSet[]): { stroke: string; fill: string } {
  let stroke = ''
  let fill = ''
  for (const set of sets) {
    const d = opsToSvgPath(set.ops)
    if (set.type === 'fillPath') fill += ' ' + d
    else if (set.type === 'path') stroke += ' ' + d
  }
  return { stroke: stroke.trim(), fill: fill.trim() }
}

/** 圆角矩形封闭 path（左上 0,0 → 右下 W,H），用于 RoughInput / 其他卡片状元素 */
export function roundedRectPath(W: number, H: number, radius = 8): string {
  const r = Math.min(radius, Math.min(W, H) / 2)
  return [
    `M ${r} 0`,
    `L ${W - r} 0`,
    `Q ${W} 0 ${W} ${r}`,
    `L ${W} ${H - r}`,
    `Q ${W} ${H} ${W - r} ${H}`,
    `L ${r} ${H}`,
    `Q 0 ${H} 0 ${H - r}`,
    `L 0 ${r}`,
    `Q 0 0 ${r} 0`,
    'Z'
  ].join(' ')
}
