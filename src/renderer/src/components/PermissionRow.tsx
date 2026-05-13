// 工具调用权限询问行：三按钮（本次允许 / 永远允许工具粒度 / 拒绝），rough.js 手绘描边。
// 颜色语义：墨色=日常允许，琥珀=永久承诺，玫红=拒绝（灰=禁用观感，不能用灰）
import { useEffect, useMemo, useRef, useState } from 'react'
import rough from 'roughjs'
import type { PermissionDecision, PermissionRequest } from '@shared/types'
import { extractRoughPaths, roundedRectPath } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  request: PermissionRequest
  onResolve: (decision: PermissionDecision) => void
}

/** 工具名 → 中文友好显示，给「永远允许」按钮的副标题用。未知工具直接回原名。 */
function toolDisplayName(tool: string): string {
  switch (tool) {
    case 'web_search':
      return '搜索'
    case 'fetch_url':
      return '网页抓取'
    default:
      return tool
  }
}

export function PermissionRow(props: Props): JSX.Element {
  const { request, onResolve } = props
  const toolName = toolDisplayName(request.tool)

  return (
    <div data-clickable="true" className="titlebar-no-drag flex w-full flex-col gap-2">
      {/* 描述行——抄 ToolDescribeRow 的字体规范，去掉 pulse 因为在等用户决策不是流式 */}
      <div className="font-kangkang text-sm italic leading-tight text-zhihu-gray">
        {request.describe}
      </div>
      {/* 三按钮横排——本次允许 / 永远允许「工具名」 / 拒绝。
          描边色承载语义：墨色=默认、琥珀=强承诺、玫红=主动拒绝。 */}
      <div className="flex flex-row gap-2">
        <RoughChoiceButton
          color="#1A1A1A"
          seed={31}
          onClick={() => onResolve('allow_once')}
        >
          本次允许
        </RoughChoiceButton>
        <RoughChoiceButton
          color="#b45309"
          seed={37}
          onClick={() => onResolve('allow_forever')}
        >
          永远允许{toolName}
        </RoughChoiceButton>
        <RoughChoiceButton
          color="#dc2626"
          seed={41}
          onClick={() => onResolve('deny')}
        >
          拒绝
        </RoughChoiceButton>
      </div>
    </div>
  )
}

/**
 * 单颗手绘按钮——用 ResizeObserver 监听 flex-1 给的实际宽高，
 * rough.js 路径按 (W, H, color, seed) 缓存，文字内容变化不会重抖。
 *
 * 描边和文字共用一个语义色 `color`，hover 时降一级亮度让用户感到「按下去会有事发生」。
 */
function RoughChoiceButton(props: {
  color: string
  seed: number
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

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
    const path = roundedRectPath(size.w, size.h, 6)
    const drawable = generator.path(path, {
      roughness: 1.4,
      bowing: 1.0,
      seed: props.seed,
      stroke: props.color,
      strokeWidth: 1.2,
      fill: 'none',
      disableMultiStroke: false
    })
    return extractRoughPaths(drawable.sets).stroke
  }, [size.w, size.h, props.color, props.seed])

  const PAD = 4

  return (
    <div ref={wrapRef} className="relative flex-1">
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
            stroke={props.color}
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      <button
        type="button"
        onClick={props.onClick}
        className="font-kangkang relative block w-full bg-transparent px-2 py-1 text-sm leading-tight outline-none transition-opacity hover:opacity-75"
        style={{ color: props.color }}
      >
        {props.children}
      </button>
    </div>
  )
}
