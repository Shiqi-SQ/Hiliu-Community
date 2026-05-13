// 气泡里的输入框——用 rough.js 画手绘描边，叠在透明 input 元素之下。
// 形态：圆角矩形描边（无填充——气泡白底已经够），placeholder 走 font-kangkang。
//
// 尺寸自适应：用 ResizeObserver 跟踪外层容器渲染尺寸，rough 路径基于这个尺寸生成；
// useMemo 按 (W, H) 缓存，输入文字时不会触发重抖。
import { useEffect, useMemo, useRef, useState } from 'react'
import rough from 'roughjs'
import { extractRoughPaths, roundedRectPath } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  value: string
  onChange: (v: string) => void
  /** 回车提交。Shift+Enter 暂不支持换行——这一版输入框就一行 */
  onSubmit: (v: string) => void
  placeholder?: string
  /** streaming 中禁用输入，避免上一轮没结束又发新消息 */
  disabled?: boolean
  /** 自动 focus——气泡刚打开时希望光标已经在输入框里 */
  autoFocus?: boolean
}

export function RoughInput(props: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // 外层容器尺寸 → 给 rough 算路径
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

  // 气泡刚打开时聚焦——只在 mount 时触发一次。
  // 但 pet 窗口默认 focusable=false（让桌宠不抢焦点），气泡打开时 Pet.tsx 同 tick 发了
  // setFocusable(true) IPC——还没到 main 端落地。这里直接 focus() 会落空（窗口尚不可聚焦）。
  // 兜底：先延一帧让 IPC 抵达 main 完成 setFocusable，再 focus；如果首次仍失败（极慢 IPC），
  // 再退一次 50ms 重试，覆盖绝大多数情况。
  useEffect(() => {
    if (!props.autoFocus) return
    let cancelled = false
    const focusOnce = (): void => {
      if (cancelled) return
      const el = inputRef.current
      if (!el) return
      el.focus()
      if (document.activeElement !== el) {
        // 主窗口还没翻 focusable=true 时 focus 会被吞——再延 50ms 重试一次
        window.setTimeout(focusOnce, 50)
      }
    }
    const raf = window.requestAnimationFrame(focusOnce)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stroke = useMemo(() => {
    if (size.w <= 0 || size.h <= 0) return ''
    const path = roundedRectPath(size.w, size.h, 8)
    const drawable = generator.path(path, {
      roughness: 1.4,
      bowing: 1.0,
      seed: 5,
      stroke: '#1A1A1A',
      strokeWidth: 1.2,
      fill: 'none',
      disableMultiStroke: false
    })
    return extractRoughPaths(drawable.sets).stroke
  }, [size.w, size.h])

  const PAD = 4 // 给笔触溢出留余量

  return (
    <div
      ref={wrapRef}
      data-clickable="true"
      className="titlebar-no-drag relative w-full"
      // 高度由 input 的 padding 决定，宽度跟父级
    >
      {/* 描边层——绝对定位、不挡点击 */}
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
      {/* 真正的 input——透明背景，让描边层显形。右侧 pr-9 给发送按钮留位 */}
      <input
        ref={inputRef}
        type="text"
        className="font-kangkang relative block w-full bg-transparent py-2 pl-3 pr-9 text-base text-zhihu-ink outline-none placeholder:text-zhihu-gray disabled:opacity-60"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            props.onSubmit(props.value)
          }
        }}
        placeholder={props.placeholder}
        disabled={props.disabled}
      />
      {/* 发送按钮——空内容时禁用，避免误发空消息 */}
      <button
        type="button"
        onClick={() => props.onSubmit(props.value)}
        disabled={props.disabled || props.value.trim().length === 0}
        title="发送"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zhihu-gray transition-colors hover:bg-zhihu-ink/5 hover:text-zhihu-blue disabled:cursor-not-allowed disabled:text-zhihu-gray-2/40 disabled:hover:bg-transparent disabled:hover:text-zhihu-gray-2/40"
      >
        <i className="fa-solid fa-paper-plane text-sm" />
      </button>
    </div>
  )
}
