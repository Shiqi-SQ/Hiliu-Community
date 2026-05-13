// 「小刘向用户提问」面板：选项两步式（勾→确认，防误点），常驻「其他」自由输入框，单/多选共用。
import { useEffect, useMemo, useRef, useState } from 'react'
import rough from 'roughjs'
import type { AskUserQuestionRequest, AskUserQuestionResponse } from '@shared/types'
import { extractRoughPaths, roundedRectPath } from '../utils/roughSvg'

const generator = rough.generator()

interface Props {
  request: AskUserQuestionRequest
  onResolve: (response: AskUserQuestionResponse) => void
}

export function AskUserPanel(props: Props): JSX.Element {
  const { request, onResolve } = props
  const multiSelect = request.multiSelect === true

  // 勾中索引集合——用 Set<number> 避免 options 文本相同时重复
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set())
  const [otherText, setOtherText] = useState('')

  function toggleOption(idx: number): void {
    setSelectedSet((prev) => {
      const next = new Set(prev)
      if (multiSelect) {
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
      } else {
        // 单选：点已勾项=取消；点新项=切换为只勾它
        if (next.has(idx)) {
          next.clear()
        } else {
          next.clear()
          next.add(idx)
        }
      }
      return next
    })
  }

  // 提交闸门：勾选与自填至少有其一才允许提交（确认按钮 disabled 由此决定）
  const trimmedOther = otherText.trim()
  const canSubmit = selectedSet.size > 0 || trimmedOther.length > 0

  function submit(): void {
    if (!canSubmit) return
    const selectedOptions = Array.from(selectedSet)
      .sort((a, b) => a - b) // 按原选项顺序回灌，模型读起来更自然
      .map((i) => request.options[i])
      .filter((s): s is string => typeof s === 'string')
    onResolve({
      reqId: request.reqId,
      canceled: false,
      selectedOptions,
      otherText: trimmedOther
    })
  }

  // canceled=true 让 cancel 话术引导模型轻描淡写过渡，比直接关气泡更可控
  function decline(): void {
    onResolve({
      reqId: request.reqId,
      canceled: true,
      selectedOptions: [],
      otherText: ''
    })
  }

  // 模式图标——单选用 ○/●，多选用 ☐/☑。Font Awesome Pro 7 支持 fa-regular（已 verify all.css 有）
  const iconUnselected = multiSelect ? 'fa-regular fa-square' : 'fa-regular fa-circle'
  const iconSelected = multiSelect ? 'fa-solid fa-square-check' : 'fa-solid fa-circle-dot'

  return (
    <div data-clickable="true" className="titlebar-no-drag flex w-full flex-col gap-2">
      {/* 问题文本——同 PermissionRow 描述行规范，斜体次级色让用户一眼分清「这是问句」 */}
      <div className="font-kangkang text-sm italic leading-tight text-zhihu-gray">
        {request.question}
      </div>

      {/* 选项列：每个选项独立一行 */}
      <div className="flex flex-col items-stretch gap-2">
        {request.options.map((opt, idx) => {
          const selected = selectedSet.has(idx)
          return (
            <RoughChoiceButton
              key={idx}
              color="#1A1A1A"
              seed={31 + idx * 4}
              selected={selected}
              icon={selected ? iconSelected : iconUnselected}
              onClick={() => toggleOption(idx)}
            >
              {opt}
            </RoughChoiceButton>
          )
        })}
      </div>

      {/* 「其他」常驻输入框——Enter 触发提交（与「确认」按钮等价） */}
      <OtherInput
        value={otherText}
        onChange={setOtherText}
        onSubmitShortcut={submit}
      />

      {/* 底部一行两按钮——左「拒绝回答」次级灰，右「确认答案」知乎蓝。
       *  justify-between 让两端对齐：用户视线天然左→右扫过，否定动作在左、肯定动作在右。 */}
      <div className="flex items-center justify-between">
        <RoughActionButton seed={73} color="#6b7280" onClick={decline}>
          拒绝回答
        </RoughActionButton>
        <RoughActionButton seed={71} color="#0084FF" disabled={!canSubmit} onClick={submit}>
          确认答案
        </RoughActionButton>
      </div>
    </div>
  )
}

/* ========== 选项按钮：整行可点 + 勾中背景 + 模式图标 ========== */

function RoughChoiceButton(props: {
  color: string
  seed: number
  selected: boolean
  icon: string
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
    <div ref={wrapRef} className="relative">
      {/* 勾中态薄背景层——压在描边和按钮文字之下 */}
      {props.selected && (
        <div
          className="pointer-events-none absolute inset-0 rounded-md"
          style={{ backgroundColor: props.color, opacity: 0.08 }}
        />
      )}
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
      {/* 全宽 block 按钮——整行可点；flex 布局让 icon 与文字对齐居左 */}
      <button
        type="button"
        onClick={props.onClick}
        className="font-kangkang relative flex w-full items-center gap-2 bg-transparent px-3 py-1.5 text-left text-sm leading-tight outline-none transition-opacity hover:opacity-75"
        style={{ color: props.color }}
      >
        {/* 固定宽度的图标槽——避免 ○ ↔ ● 切换时文字位移 */}
        <i className={`${props.icon} w-4 flex-shrink-0 text-center`} />
        <span className="flex-1">{props.children}</span>
      </button>
    </div>
  )
}

/* ========== 「其他」常驻输入框 ==========
 * 与 v1 的 OtherInput 区别：
 * - 不再有右侧 paper-plane 提交按钮——提交交给底部统一的「确认」按钮
 * - Enter 仍可触发提交（onSubmitShortcut），符合用户对输入框的肌肉记忆
 * - 取消 autoFocus——常驻可见时强抢焦点反而打扰用户的视线扫描节奏 */

function OtherInput(props: {
  value: string
  onChange: (v: string) => void
  onSubmitShortcut: () => void
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
    const path = roundedRectPath(size.w, size.h, 8)
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
    <div ref={wrapRef} className="titlebar-no-drag relative w-full">
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
      <input
        type="text"
        className="font-kangkang relative block w-full bg-transparent px-3 py-1.5 text-sm leading-tight text-zhihu-ink outline-none placeholder:text-zhihu-gray"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            props.onSubmitShortcut()
          }
        }}
        placeholder="其他答案…"
      />
    </div>
  )
}

/* ========== 底部「拒绝 / 确认」动作按钮 ==========
 * 与选项按钮区别：
 * - 内宽更窄（自适应文字宽度）——两端对齐时不抢空间
 * - disabled 时一律降为次级灰、禁用光标——确认按钮独占此态（拒绝按钮永远可用）
 * - 启用色由 caller 传入（color prop）：拒绝走次级灰 #6b7280、确认走知乎蓝 #0084FF */

function RoughActionButton(props: {
  seed: number
  disabled?: boolean
  color: string
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // disabled 强制覆盖 caller 给的 color——视觉一致性优先
  const isDisabled = props.disabled === true
  const color = isDisabled ? '#9CA3AF' : props.color

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
      stroke: color,
      strokeWidth: 1.2,
      fill: 'none',
      disableMultiStroke: false
    })
    return extractRoughPaths(drawable.sets).stroke
  }, [size.w, size.h, color, props.seed])

  const PAD = 4

  return (
    <div ref={wrapRef} className="relative inline-block">
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
            stroke={color}
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled}
        className="font-kangkang relative block bg-transparent px-3 py-1 text-sm leading-tight outline-none transition-opacity hover:opacity-75 disabled:cursor-not-allowed disabled:hover:opacity-100"
        style={{ color }}
      >
        {props.children}
      </button>
    </div>
  )
}
