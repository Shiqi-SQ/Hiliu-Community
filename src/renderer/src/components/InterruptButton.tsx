// 流式回复期间替代输入框的「打断一下」按钮。
//
// 视觉与 RoughInput 共形：手绘描边圆角矩形 + font-kangkang，高度通过 px-3 py-2 + text-base
// 与 RoughInput 完全对齐，避免气泡尺寸在 streaming/idle 切换时跳动。
import { useEffect, useMemo, useRef, useState } from 'react'
import rough from 'roughjs'
import { extractRoughPaths, roundedRectPath } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  onClick: () => void
}

export function InterruptButton(props: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // 抄 RoughInput 的尺寸观测——内层 button 渲染出实际宽高后再生成手绘路径
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const w = Math.round(e.contentRect.width)
      const h = Math.round(e.contentRect.height)
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stroke = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return ''
    const path = roundedRectPath(size.w, size.h, 8)
    // seed 改成 7 让按钮的描边抖动与 RoughInput(seed:5) 不同——切换时视觉上能看出是另一个元素
    const drawable = generator.path(path, {
      roughness: 1.4,
      bowing: 1.0,
      seed: 7,
      stroke: '#1A1A1A',
      strokeWidth: 1.2,
      fill: 'none',
      disableMultiStroke: false
    })
    return extractRoughPaths(drawable.sets).stroke
  }, [size.w, size.h])

  const PAD = 4

  return (
    <div ref={wrapRef} data-clickable="true" className="titlebar-no-drag relative w-full">
      {stroke && (
        <svg
          width={size.w + PAD * 2}
          height={size.h + PAD * 2}
          viewBox={`${-PAD} ${-PAD} ${size.w + PAD * 2} ${size.h + PAD * 2}`}
          style={{
            position: 'absolute',
            left: -PAD,
            top: -PAD,
            pointerEvents: 'none',
            overflow: 'visible'
          }}
        >
          <path
            d={stroke}
            fill="none"
            stroke="#1A1A1A"
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      <button
        type="button"
        onClick={props.onClick}
        className="font-kangkang relative block w-full bg-transparent px-3 py-2 text-base text-zhihu-ink outline-none hover:text-zhihu-blue"
      >
        打断一下
      </button>
    </div>
  )
}
