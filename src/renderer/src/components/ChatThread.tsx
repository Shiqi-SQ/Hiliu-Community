// 气泡对话流：左侧小刘、右侧用户；时间戳挂在最后一条 pet say 消息下方。
import { type ReactNode, useEffect, useRef, useState } from 'react'

export interface ChatMsg {
  /** 稳定 id，用于 React key 和增量更新最后一条 pet 消息 */
  id: string
  role: 'pet' | 'user'
  /**
   * 事件种类——单数组承载完整事件流：
   * - 'say'           小刘正常说的话（默认，会渲染到气泡）
   * - 'tool_describe' 「正在查我自己的资料」之类的状态描述（不渲染到气泡，给浮动状态行用）
   * - 'tool_result'   工具回灌内容（不渲染到气泡，仅作为历史/上下文）
   */
  kind: 'say' | 'tool_describe' | 'tool_result'
  text: string
  /** 'HH:MM' 格式时间戳——目前只有最后一条 pet 消息会真正显示出来 */
  time: string
  /** 显式隐藏——失败的 tool_result、调试事件等不想出现在 UI 里时置 true */
  hidden?: boolean
  /** 触发本条 tool_describe 的工具调用元数据（仅 kind==='tool_describe' 用） */
  tool?: { name: string; args: Record<string, unknown> }
  /** 工具执行结果（仅 kind==='tool_result' 用，便于 UI 后续展开调试） */
  toolResult?: string
}

interface Props {
  messages: ChatMsg[]
  streaming: boolean
  /** 顶部固定结尾时间戳的备用——目前未使用，预留 */
  footer?: ReactNode
}

export function ChatThread(props: Props): JSX.Element {
  const { messages, streaming } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // 顶部渐隐：有内容滚出视野才显示，防止短内容也压灰带
  const [showTopFade, setShowTopFade] = useState(false)

  // isLast 基于过滤后的 say 列表判断，否则末尾 tool_describe 会让时间戳/光标不出
  const visible = messages.filter((m) => m.kind === 'say' && !m.hidden)

  // 消息更新时滚底——流式追加也能平滑跟底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [visible.length, visible[visible.length - 1]?.text])

  // scrollIntoView 后 scrollTop 也跳，需同步刷新顶部渐隐 flag
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setShowTopFade(el.scrollTop > 4)
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child as Element)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [visible.length])

  return (
    <div className="relative">
      {/* 顶部渐隐遮罩——24px 高的白→透明 gradient，提示「上面还有内容」 */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-white/95 to-transparent transition-opacity duration-150 ${showTopFade ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={scrollRef}
        className="font-kangkang chat-scroll flex max-h-[520px] flex-col gap-2 overflow-y-auto text-base leading-snug text-zhihu-ink"
      >
        {visible.map((msg, i) => (
          <Row
            key={msg.id}
            msg={msg}
            isLast={i === visible.length - 1}
            streaming={streaming}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

/**
 * 浮动状态行——streaming 中显示「正在干啥」（来自最近一条 tool_describe）。
 * 显示规则：streaming === true 且最近一条 tool_describe 之后**没有**带文本的 say——
 * 因为只要新一轮 say 已经开始吐字，状态就过时了，应该让位给气泡里的真实内容。
 *
 * 视觉：灰色斜体小字，区别于正常对话流。
 */
export function ToolDescribeRow(props: {
  messages: ChatMsg[]
  streaming: boolean
}): JSX.Element | null {
  const { messages, streaming } = props
  if (!streaming) return null
  let describe: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // 已经有新一轮 say 开始吐字 → 状态过时
    if (m.kind === 'say' && m.text.length > 0 && !m.hidden) return null
    if (m.kind === 'tool_describe' && m.text) {
      describe = m.text
      break
    }
  }
  if (!describe) return null
  return (
    <div className="font-kangkang text-sm italic leading-tight text-zhihu-gray">
      {describe}
      <span className="ml-0.5 animate-pulse">…</span>
    </div>
  )
}

function Row(props: { msg: ChatMsg; isLast: boolean; streaming: boolean }): JSX.Element {
  const { msg, isLast, streaming } = props
  const isPet = msg.role === 'pet'
  const align = isPet ? 'items-start text-left' : 'items-end text-right'
  const label = isPet ? '小刘' : '用户'
  const showTime = isPet && isLast && !streaming && msg.text.length > 0
  const showCaret = isPet && isLast && streaming
  return (
    <div className={`flex flex-col ${align}`}>
      <span className="text-sm leading-tight text-zhihu-gray">{label}</span>
      <span className="max-w-full whitespace-pre-wrap break-words">
        {msg.text}
        {showCaret && <span className="ml-0.5 animate-pulse">...</span>}
      </span>
      {showTime && (
        <span className="text-sm leading-tight text-zhihu-gray">{msg.time}</span>
      )}
    </div>
  )
}
