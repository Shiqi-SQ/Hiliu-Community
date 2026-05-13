// 手绘圆形按钮——桌宠头顶 hover 浮出的三按钮（摸摸/阅读/设置）用这个。
//
// 视觉配方与 RoughConfirm/Bubble 对齐：
// - 双笔触：铅笔阴影（半透明灰、外扩、roughness 高）+ 钢笔主线（黑、内层、roughness 低）
// - 填充：白底 fillStyle:'solid'
// - 圆形 path 由 roughjs.generator.circle() 现算，seed 固定确保同一按钮每次渲染笔触一致
//
// 形态：圆 + 圆下方一行 label——圆内塞 icon+label 太挤，分两层既留圆按钮语义又保留文字提示。
import { useMemo } from 'react'
import rough from 'roughjs'
import { extractRoughPaths } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  /** Font Awesome icon class，例如 'fa-hand-sparkles' */
  icon: string
  /** 按钮下方一行小字 */
  label: string
  onClick: () => void
  /** roughjs seed——同按钮固定 seed 避免笔触每帧抖动 */
  seed: number
  /** 直径，默认 44 */
  diameter?: number
  /** 主描边颜色，默认知乎蓝 */
  strokeColor?: string
}

const PAD = 6 // SVG viewBox 边缘留给笔触溢出的余量

export function RoughCircleButton(props: Props): JSX.Element {
  const D = props.diameter ?? 44
  const stroke = props.strokeColor ?? '#0084FF' // zhihu-blue
  const cx = D / 2
  const cy = D / 2

  // 双笔触：铅笔阴影 + 钢笔主线 + 白底
  const { shadowPath, mainPath, fillPath } = useMemo(() => {
    const shadow = generator.circle(cx, cy, D, {
      roughness: 1.6,
      bowing: 1.2,
      seed: props.seed + 7,
      stroke: 'rgba(140, 140, 145, 0.35)',
      strokeWidth: 2,
      fill: 'none',
      disableMultiStroke: false
    })
    const main = generator.circle(cx, cy, D, {
      roughness: 1.0,
      bowing: 0.8,
      seed: props.seed,
      stroke: stroke,
      strokeWidth: 1.4,
      fill: '#ffffff',
      fillStyle: 'solid',
      disableMultiStroke: false
    })
    const mainPaths = extractRoughPaths(main.sets)
    return {
      shadowPath: extractRoughPaths(shadow.sets).stroke,
      mainPath: mainPaths.stroke,
      fillPath: mainPaths.fill
    }
  }, [D, cx, cy, props.seed, stroke])

  return (
    <button
      type="button"
      data-clickable="true"
      data-hover-target="true"
      onClick={props.onClick}
      title={props.label}
      // 按钮容器：只装一个圆，width=height=D；去掉 flex-col 等多余布局，
      // 居中由内部 i 的 transform 自身负责，避免 flex 在小尺寸下产生 ±0.5px 微抖
      className="group relative block outline-none transition-transform hover:-translate-y-0.5 active:translate-y-0"
      style={{ width: D, height: D, pointerEvents: 'auto', background: 'transparent', border: 'none', padding: 0 }}
    >
      {/* 圆形 SVG 描边层——尺寸比 D 大 2*PAD 容笔触溢出，绝对定位偏 -PAD 校准 */}
      <span
        className="relative block"
        style={{ width: D, height: D }}
      >
        <svg
          width={D + PAD * 2}
          height={D + PAD * 2}
          viewBox={`${-PAD} ${-PAD} ${D + PAD * 2} ${D + PAD * 2}`}
          style={{
            position: 'absolute',
            left: -PAD,
            top: -PAD,
            pointerEvents: 'none',
            overflow: 'visible'
          }}
        >
          {fillPath && <path d={fillPath} fill="#ffffff" stroke="none" />}
          {shadowPath && (
            <path
              d={shadowPath}
              fill="none"
              stroke="rgba(140, 140, 145, 0.35)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {mainPath && (
            <path
              d={mainPath}
              fill="none"
              stroke={stroke}
              strokeWidth={1.4}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
        </svg>
        {/* icon 居中——absolute 撑满 span 后用 transform 严格定位字符到几何中心，
            leading-none 防 FontAwesome ::before 因继承行高产生垂直偏移 */}
        <i
          className={`fa-solid ${props.icon} pointer-events-none absolute left-1/2 top-1/2 text-[16px] leading-none transition-transform group-hover:scale-110`}
          style={{ color: stroke, transform: 'translate(-50%, -50%)' }}
        />
      </span>
    </button>
  )
}
