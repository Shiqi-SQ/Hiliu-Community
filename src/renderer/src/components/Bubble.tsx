// 手绘味气泡：rough.js 双层描边（阴影粗糙 + 主线细腻），ResizeObserver 量内容尺寸后生成路径。
// 两套 drawable：shadowLine(roughness=2) 模拟铅笔稿，main(roughness=1.3) 模拟钢笔勾边。
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import rough from 'roughjs'
import { extractRoughPaths } from '../utils/roughSvg'

interface BubbleProps {
  /** 内容自然宽度上限——避免单行无限横向延伸 */
  maxContentWidth?: number
  /** 内容真实尺寸变化时回调（包含 padding，单位逻辑像素）。父级据此同步外层定位 + 推 main */
  onMeasure?: (w: number, h: number) => void
  /** 尾巴朝哪侧——left 时尾尖指向气泡左下（桌宠朝右时用），right 时指向右下（默认，桌宠朝左时用） */
  tailSide?: 'left' | 'right'
  children?: ReactNode
}

const generator = rough.generator()

// 圆角矩形 + 尾巴的几何参数（基于气泡矩形坐标系，0,0 在矩形左上）。
const CORNER_RADIUS = 14
const TAIL_BASE_INSET = 18 // 尾根距离右下角的水平内缩
const TAIL_WIDTH = 16 // 尾根开口宽度
const TAIL_TIP_DX = 10 // 尾尖相对尾根的横向偏移（朝右）
const TAIL_TIP_DY = 14 // 尾尖相对尾根的下伸距离

/**
 * 构造「圆角矩形 + 尾巴」的封闭路径。坐标系原点在气泡矩形左上 (0,0)，矩形右下在 (W,H)。
 * tailSide='right'（默认）：尾巴从右下边缘戳出，尾尖偏右——桌宠朝左时使用。
 * tailSide='left'：尾巴从左下边缘戳出，尾尖偏左——桌宠朝右时使用。
 */
function buildBubblePath(W: number, H: number, tailSide: 'left' | 'right' = 'right'): string {
  const r = Math.min(CORNER_RADIUS, Math.min(W, H) / 2)
  const tipY = H + TAIL_TIP_DY
  if (tailSide === 'right') {
    const tailX1 = W - TAIL_BASE_INSET - TAIL_WIDTH
    const tailX2 = W - TAIL_BASE_INSET
    const tipX = tailX2 + TAIL_TIP_DX
    return [
      `M ${r} 0`, `L ${W - r} 0`, `Q ${W} 0 ${W} ${r}`,
      `L ${W} ${H - r}`, `Q ${W} ${H} ${W - r} ${H}`,
      `L ${tailX2} ${H}`, `L ${tipX} ${tipY}`, `L ${tailX1} ${H}`,
      `L ${r} ${H}`, `Q 0 ${H} 0 ${H - r}`, `L 0 ${r}`, `Q 0 0 ${r} 0`, 'Z'
    ].join(' ')
  } else {
    const tailX1 = TAIL_BASE_INSET
    const tailX2 = TAIL_BASE_INSET + TAIL_WIDTH
    const tipX = tailX1 - TAIL_TIP_DX
    return [
      `M ${r} 0`, `L ${W - r} 0`, `Q ${W} 0 ${W} ${r}`,
      `L ${W} ${H - r}`, `Q ${W} ${H} ${W - r} ${H}`,
      `L ${tailX2} ${H}`, `L ${tipX} ${tipY}`, `L ${tailX1} ${H}`,
      `L ${r} ${H}`, `Q 0 ${H} 0 ${H - r}`, `L 0 ${r}`, `Q 0 0 ${r} 0`, 'Z'
    ].join(' ')
  }
}

export function Bubble(props: BubbleProps): JSX.Element {
  const tailSide = props.tailSide ?? 'right'
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ W: 0, H: 0 })
  // ref 包住回调，避免 ResizeObserver effect 因 onMeasure 变化重订
  const onMeasureRef = useRef(props.onMeasure)
  onMeasureRef.current = props.onMeasure

  // border-box 包含 padding，正好是 SVG 描边要覆盖的范围
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      const W = Math.ceil(rect.width)
      const H = Math.ceil(rect.height)
      setSize((prev) => (prev.W === W && prev.H === H ? prev : { W, H }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (size.W > 0 && size.H > 0) {
      onMeasureRef.current?.(size.W, size.H)
    }
  }, [size.W, size.H])

  // 双层 rough 路径：shadow(roughness=2 铅笔稿) + main(roughness=1.3 钢笔勾边)；seed 固定保证同尺寸稳定
  const { shadowStroke, mainStroke, fillPath } = useMemo(() => {
    if (size.W <= 0 || size.H <= 0) {
      return { shadowStroke: '', mainStroke: '', fillPath: '' }
    }
    const path = buildBubblePath(size.W, size.H, tailSide)
    const shadowLine = generator.path(path, {
      roughness: 2.0,
      bowing: 1.8,
      seed: 11,
      stroke: 'rgba(140, 140, 145, 0.45)',
      strokeWidth: 2.4,
      fill: 'none',
      disableMultiStroke: false
    })
    const main = generator.path(path, {
      roughness: 1.3,
      bowing: 1.2,
      seed: 3,
      stroke: '#1A1A1A',
      strokeWidth: 1.4,
      fill: 'rgba(255, 255, 255, 0.95)',
      fillStyle: 'solid',
      disableMultiStroke: false
    })
    const mainPaths = extractRoughPaths(main.sets)
    return {
      shadowStroke: extractRoughPaths(shadowLine.sets).stroke,
      mainStroke: mainPaths.stroke,
      fillPath: mainPaths.fill
    }
  }, [size.W, size.H, tailSide])

  const PAD = 8 // 给笔触溢出留余量
  const svgW = size.W + PAD * 2
  const svgH = size.H + PAD * 2 + TAIL_TIP_DY

  return (
    <div
      data-clickable="true"
      className="titlebar-no-drag relative inline-block"
      style={{ maxWidth: props.maxContentWidth }}
    >
      {/* SVG 描边 + 填充层：绝对定位、pointerEvents=none，不挡点击 */}
      {size.W > 0 && (
        <svg
          width={svgW}
          height={svgH}
          viewBox={`${-PAD} ${-PAD} ${svgW} ${svgH}`}
          style={{
            position: 'absolute',
            left: -PAD,
            top: -PAD,
            pointerEvents: 'none',
            overflow: 'visible'
          }}
        >
          {fillPath && (
            <path d={fillPath} fill="rgba(255, 255, 255, 0.95)" stroke="none" />
          )}
          {shadowStroke && (
            <path
              d={shadowStroke}
              fill="none"
              stroke="rgba(140, 140, 145, 0.45)"
              strokeWidth={2.4}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {mainStroke && (
            <path
              d={mainStroke}
              fill="none"
              stroke="#1A1A1A"
              strokeWidth={1.4}
              strokeLinejoin="round"
              strokeLinecap="round"
              transform="translate(0.5 -0.3)"
            />
          )}
        </svg>
      )}
      {/* 内容容器——被 ResizeObserver 测，尺寸是 SVG 路径的依据。
          font-kangkang 是 tailwind 注册的"素材集市康康体"——气泡内所有文本统一用此字体。 */}
      <div
        ref={contentRef}
        className="font-kangkang relative px-4 py-2 text-zhihu-ink"
        style={{ maxWidth: props.maxContentWidth }}
      >
        {props.children}
      </div>
    </div>
  )
}
