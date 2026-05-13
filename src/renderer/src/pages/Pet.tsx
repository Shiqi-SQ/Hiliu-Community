import { useEffect, useRef, useState } from 'react'
import {
  AskUserQuestionRequest,
  ChatMessage,
  ClipKind,
  CLIP_NAMES,
  CLIP_REGISTRY,
  ClipName,
  PermissionRequest,
  PlayClipOptions,
  SavedMessage,
  ScreenInfo,
  SIZE_LABELS,
  SPRITE_GRID_COLS,
  StopClipOptions
} from '@shared/types'
import { CLIP_SOURCES, idleSources } from '../animations'
import { AskUserPanel } from '../components/AskUserPanel'
import { Bubble as ContentBubble } from '../components/Bubble'
import { ChatThread, ChatMsg, ToolDescribeRow } from '../components/ChatThread'
import { InterruptButton } from '../components/InterruptButton'
import { PermissionRow } from '../components/PermissionRow'
import { RoughCircleButton } from '../components/RoughCircleButton'
import { RoughConfirm } from '../components/RoughConfirm'
import { RoughInput } from '../components/RoughInput'

// null=idle 底图不开 raf；kind 可被 PlayClipOptions.loop 覆盖；next 是链式后继
interface CurrentClip {
  name: ClipName
  kind: ClipKind
  next?: ClipName
}

// 开场白随机轮换让人物更鲜活，与每次都讲一样的话相比体验更佳
const GREETINGS = ['有什么事？', '有什么要帮忙的吗？', '怎么了？']

// 中断时替换半截流式文本，保留兜底口头禅——会进归档/下轮 history，让模型理解"中止"语境
const INTERRUPT_REPLIES = ['听你吩咐', '怎么了？', '有什么要补充的？']

// 系统提示词由 main 端独家产出（src/main/promptBuilder.ts），renderer 不插手

// 单帧 240×280，24fps；帧数从 CLIP_REGISTRY 读（脚本拼图时同步）；64 列网格因 WebP 单图宽度上限 16383px
const FRAME_WIDTH = 240
const FRAME_HEIGHT = 280
const SPRITE_FPS = 24

// alpha < 16/255（≈6%）视为透明像素穿透；能挡边缘抗锯齿但放过完全透明区域
const ALPHA_THRESHOLD = 16

// 超过 5px 才认作拖拽，否则当作 click——容忍手抖又不至于让用户感觉点击无响应
const DRAG_THRESHOLD_PX = 5

// sprite 拖到屏幕外时至少保留这么多像素可见，避免用户丢失桌宠
const MIN_VISIBLE_PX = 80

// walk-loop 帧步幅匹配速度；开发者面板可临时改其它值调试但不持久化
const DEFAULT_WALK_SPEED = 90

/**
 * 气泡相对 sprite 左上角的位置修正（逻辑像素，未乘 scale）。
 * 默认气泡右下贴 sprite 左上 (0,0)；调大这两个值把气泡往 sprite 内挤，让尾巴尖对准角色身体。
 * X 越大→右，Y 越大→下；当前 (110,80) 约在 sprite 上 1/3 中线（头部位置）。
 */
const BUBBLE_OFFSET_X = 110
const BUBBLE_OFFSET_Y = 80

export default function Pet(): JSX.Element {
  // 启动直接进入 start 动画；图加载完 frameCount > 0 后 Sprite 自动启动
  const [current, setCurrent] = useState<CurrentClip | null>({
    name: 'start',
    kind: CLIP_REGISTRY.start.kind
  })
  // pending: force=false 且有 clip 播时存新意图，等当轮末帧消费
  const [pending, setPending] = useState<CurrentClip | null>(null)
  // pendingStop: 非 force stopClip 时等末帧后回 idle
  const [pendingStop, setPendingStop] = useState(false)
  // 对话消息流；最后一条 pet 'say' 在流式中持续 append
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [streaming, setStreaming] = useState(false)
  const [input, setInput] = useState('')
  // 每 10 条消息由 light 模型生成标题，新对话时清空
  const [chatTitle, setChatTitle] = useState('')
  // 归档元数据——首条用户消息时生成；用 ref 因 onDone 闭包需读最新值，state 在闭包里会陈旧
  const currentConvIdRef = useRef<string | null>(null)
  const convCreatedAtRef = useRef<number>(0)
  // onDone 订阅一次，闭包里用 ref 读最新值避免陈旧
  const chatTitleRef = useRef('')
  const messagesRef = useRef<ChatMsg[]>([])
  // 工具调用待决权限；三按钮回灌后清空
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(
    null
  )
  // 模型主动问用户；优先级低于 pendingPermission（权限是更阻塞的闸门）
  const [pendingAskUser, setPendingAskUser] = useState<AskUserQuestionRequest | null>(null)
  // 暂只记录，供日志/调试；sprite 表情切换在后续任务里接
  const [, setLatestMood] = useState<string>('normal')
  const [chatOpen, setChatOpen] = useState(false)
  // chat 打开时强制 false，避免头顶按钮和气泡叠在一起
  const [hoverActive, setHoverActive] = useState(false)
  // 点新对话先弹确认条，避免一键清空当前上下文
  const [confirmingNewConv, setConfirmingNewConv] = useState(false)
  // drag useEffect([screenInfo]) 里的 onUp 闭包只捕获一次，通过 ref 读最新值避免闭包陈旧
  const chatOpenRef = useRef(false)
  const pendingPermissionRef = useRef<PermissionRequest | null>(null)
  const pendingAskUserRef = useRef<AskUserQuestionRequest | null>(null)
  // 中断后屏蔽迟到 IPC——main 端 aborted=true 之前可能已把最后一段 chunk 推进队列，
  // 不屏蔽会把"听你吩咐"追加成胡言乱语；onDone 到来时清回 false
  const interruptedRef = useRef(false)
  // start clip 任何形式收尾都翻 true；Director 周期内有其他逻辑等待开机收尾
  const [startCompleted, setStartCompleted] = useState(false)
  // Bubble onMeasure 推上来的实际尺寸，父级用于定位并同步推给 main
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 })
  // CSS transform 缩放；窗口尺寸由主进程 setBounds，渲染端用 scale 同步内容
  const [scale, setScale] = useState(1)
  // 图加载完才有真值；在那之前为 0，Sprite 等 > 0 才启动 raf
  const [frameCounts, setFrameCounts] = useState<Record<ClipName, number>>(() => {
    const init = {} as Record<ClipName, number>
    CLIP_NAMES.forEach((n) => (init[n] = 0))
    return init
  })
  // 每次触发播放都自增，传给 Sprite 作为 effect 依赖，支持「再播一次同名 clip」
  const [playKey, setPlayKey] = useState(0)
  // main 按当前 size 档位算好推过来（默认锚点 + 工作区 + sprite 视觉尺寸）
  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null)
  // null = 还没拿到 settings/screenInfo，用 visibility:hidden 暂时藏起来避免 (0,0) 闪烁
  const [petPos, setPetPos] = useState<{ x: number; y: number } | null>(null)
  // 拖拽时记录鼠标相对 sprite 左上的偏移，用于 mousemove 算新位置
  const dragStateRef = useRef<{
    pointerOffsetX: number
    pointerOffsetY: number
    startScreenX: number
    startScreenY: number
    moved: boolean
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  // right 精灵图是 PIL.ImageOps.mirror 的像素级镜像；hit-test 只缓存 left alpha 表，
  // facing=right 时 x = FRAME_WIDTH-1-localX 翻转查同一张表，O(1) 无内存代价
  const [facing, setFacing] = useState<'left' | 'right'>('left')
  const facingRef = useRef<'left' | 'right'>('left')
  useEffect(() => {
    facingRef.current = facing
  }, [facing])
  // walkRafRef: raf id（null=未行走），mousedown 时检查这个值取消 raf
  // walkPosRef: stop 命令到达时读它做最终持久化，避免依赖 React 状态（后者每帧 setPetPos 会重跑 walk effect 取消 raf）
  const walkRafRef = useRef<number | null>(null)
  const walkPosRef = useRef<{ x: number; y: number } | null>(null)
  // onWalkCommand('start') 回调需读当前位置作为种子，但 walk effect 不能把 petPos 列进 deps
  const petPosRef = useRef<{ x: number; y: number } | null>(null)

  // hit-test 两条路径均 O(1)：
  // - idle：整张 idle.webp 解码为 ImageData，按 (x,y) 查 alpha
  // - 播 clip：保留对应 <img> + 1×1 取样画布，按当前帧 drawImage 抠单像素
  // 只缓存 left 资源；facing=right 时翻转 x 坐标查同一张表
  const alphaMapRef = useRef<Uint8ClampedArray | null>(null)
  const clipImgsRef = useRef<Partial<Record<ClipName, HTMLImageElement>>>({})
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const spriteFrameRef = useRef(0) // hit-test 抠像素时用
  const ignoredRef = useRef(false) // 当前是否处于「鼠标穿透」状态（与主进程同步）
  const hoverActiveRef = useRef(false) // onMove 每帧判定时跳过相同值避免触发 setState
  // onPlayClip/onStopClip 回调里读最新值，避免闭包陈旧
  const currentRef = useRef<CurrentClip | null>(current)
  const pendingRef = useRef<CurrentClip | null>(null)
  const pendingStopRef = useRef(false)
  // hit-test 时把视口坐标除以 scale 再查 alpha（alpha 表按原图 240×280 索引）
  const scaleRef = useRef(1)
  // petPos 首次初始化标志；后续 settings:changed 不再重置，避免改 size 档位时桌宠跳回默认锚点
  const initialPosAppliedRef = useRef(false)
  // learn clip 是 loop，无自然结束信号，靠 setTimeout 收尾；锁定期间再点不重新计时
  const readingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 当前时间「HH:MM」，用作 ChatMsg.time 字段
  function nowHM(): string {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // 同分钟内 id 不撞车
  const idCounterRef = useRef(0)
  function newId(): string {
    idCounterRef.current += 1
    return `m${Date.now()}-${idCounterRef.current}`
  }

  // chunk 增量 append 到最后一条 pet 'say' 占位；tool_describe 来了封口、插入描述行、起新占位。
  // 找「最后一条 pet 'say'」而不是末条——末条可能是 tool_describe / tool_result。
  useEffect(() => {
    const findLastSayIdx = (msgs: ChatMsg[]): number => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'pet' && m.kind === 'say') return i
      }
      return -1
    }

    const appendToLastSay = (delta: string): void => {
      // 中断后迟到 chunk 一律丢弃，避免追加到兜底文案后变成胡言乱语
      if (interruptedRef.current) return
      setMessages((msgs) => {
        const idx = findLastSayIdx(msgs)
        if (idx < 0) return msgs
        const next = msgs.slice()
        const target = next[idx]
        next[idx] = { ...target, text: target.text + delta, time: nowHM() }
        return next
      })
    }

    const offChunk = window.xiaoliu.llm.onChunk(appendToLastSay)

    const offMood = window.xiaoliu.llm.onMood((mood) => {
      if (interruptedRef.current) return
      setLatestMood(mood)
    })

    const offToolDescribe = window.xiaoliu.llm.onToolDescribe(
      (toolName, args, describe) => {
        if (interruptedRef.current) return
        setMessages((msgs) => {
          const next = msgs.slice()
          // 空 say 占位标 hidden，避免气泡里出现空白条目
          const idx = findLastSayIdx(next)
          if (idx >= 0 && next[idx].text.length === 0) {
            next[idx] = { ...next[idx], hidden: true }
          }
          // 插一条 tool_describe 事件行
          next.push({
            id: newId(),
            role: 'pet',
            kind: 'tool_describe',
            text: describe,
            time: nowHM(),
            tool: { name: toolName, args }
          })
          // 起新 say 占位，等下一轮 chunk
          next.push({
            id: newId(),
            role: 'pet',
            kind: 'say',
            text: '',
            time: nowHM()
          })
          return next
        })
      }
    )

    const offToolResult = window.xiaoliu.llm.onToolResult((toolName, ok, content) => {
      if (interruptedRef.current) return
      setMessages((msgs) => [
        ...msgs,
        {
          id: newId(),
          role: 'pet',
          kind: 'tool_result',
          text: ok ? '' : `（${toolName} 执行失败）`,
          time: nowHM(),
          hidden: true,
          toolResult: content
        }
      ])
    })

    const offDone = window.xiaoliu.llm.onDone(() => {
      setStreaming(false)
      interruptedRef.current = false // 中断模式收尾
      // 兜底清 UI 待决态——理论上 abortAllPending 已处理，但防止异常路径下 PermissionRow 卡死
      setPendingPermission(null)
      setPendingAskUser(null)
      // 在 setMessages 回调里归档：能拿到刚封口的最终消息列表，避免一帧滞后
      setMessages((msgs) => {
        // 残留空占位也标 hidden
        const idx = findLastSayIdx(msgs)
        let next = msgs
        if (idx >= 0 && msgs[idx].text.length === 0) {
          next = msgs.slice()
          next[idx] = { ...next[idx], hidden: true }
        }
        // 归档：只存非空 say，省略 tool_describe / tool_result 浮动行
        const convId = currentConvIdRef.current
        if (convId) {
          const saved: SavedMessage[] = next
            .filter((m) => m.kind === 'say' && m.text.length > 0)
            .map<SavedMessage>((m) => ({
              role: m.role === 'pet' ? 'assistant' : 'user',
              text: m.text,
              time: Date.now()
            }))
          if (saved.length > 0) {
            void window.xiaoliu.history.save({
              id: convId,
              title: chatTitleRef.current,
              createdAt: convCreatedAtRef.current || Date.now(),
              updatedAt: Date.now(),
              messages: saved
            })
          }
        }
        return next
      })
    })
    const offError = window.xiaoliu.llm.onError((msg) => {
      // 错误作为最后一条 pet 消息呈现，保持气泡里就是对话流的结构
      appendToLastSay(`\n[出错] ${msg}`)
      setStreaming(false)
      setPendingPermission(null)
      setPendingAskUser(null)
    })
    // 工具权限询问——main 推送时填进 state 触发 PermissionRow
    const offPermission = window.xiaoliu.permission.onRequest((req) => {
      setPendingPermission(req)
    })
    // 模型主动问用户——填进 state 渲染 AskUserPanel
    const offAskUser = window.xiaoliu.askUser.onRequest((req) => {
      setPendingAskUser(req)
    })
    // 标题搭载主对话；同值 setState 不触发重渲染，安全
    const offTitle = window.xiaoliu.llm.onTitle((title) => {
      if (interruptedRef.current) return
      setChatTitle(title)
    })
    return () => {
      offChunk()
      offMood()
      offToolDescribe()
      offToolResult()
      offDone()
      offError()
      offPermission()
      offAskUser()
      offTitle()
    }
  }, [])

  // PlayClipOptions.loop 覆盖 CLIP_REGISTRY 默认 kind
  function effectiveKind(name: ClipName, opts: PlayClipOptions): ClipKind {
    if (opts.loop === true) return 'loop'
    if (opts.loop === false) return 'oneshot'
    return CLIP_REGISTRY[name].kind
  }

  // 状态机入口：force/空闲时立即切，否则排队
  function playClip(name: ClipName, opts: PlayClipOptions = {}): void {
    const kind = effectiveKind(name, opts)
    const next: CurrentClip = { name, kind, next: opts.next }
    if (opts.force || currentRef.current === null) {
      // 立即切：清空所有 pending，自增 playKey 让 sprite 重启
      setCurrent(next)
      setPending(null)
      setPendingStop(false)
      setPlayKey((k) => k + 1)
    } else {
      // 排队：等当前 clip 末帧再切
      setPending(next)
      setPendingStop(false)
    }
  }

  // 回 idle（current=null）；force=false 时等末帧
  function stopClip(opts: StopClipOptions = {}): void {
    if (currentRef.current === null) return
    if (opts.force) {
      setCurrent(null)
      setPending(null)
      setPendingStop(false)
      window.xiaoliu.pet.notifyClipDone(null)
    } else {
      setPending(null)
      setPendingStop(true)
    }
  }

  // 社区版裁掉了冷知识气泡抓取；loop:false 把 learn 降级为 oneshot，跑完一轮自然回 idle
  function startReadingSession(): void {
    if (readingTimerRef.current) return // 已在「读」就让它读完，避免重复触发
    playClip('learn', { force: true, loop: false })
    const LEARN_DURATION_MS = Math.ceil((CLIP_REGISTRY.learn.frameCount / SPRITE_FPS) * 1000)
    readingTimerRef.current = setTimeout(() => {
      readingTimerRef.current = null
    }, LEARN_DURATION_MS)
  }

  // 末帧回调：消费 pending → 走 next 链 → 自然回 idle / 继续 loop
  function onClipBoundary(): void {
    const cur = currentRef.current
    if (!cur) return
    const justEnded = cur.name

    // start 任何形式收尾都解锁登录气泡闸门
    if (justEnded === 'start' && !startCompleted) {
      setStartCompleted(true)
    }

    // 1) 优先消费 pending
    if (pendingRef.current) {
      const p = pendingRef.current
      setCurrent({ name: p.name, kind: p.kind, next: p.next })
      setPending(null)
      setPendingStop(false)
      setPlayKey((k) => k + 1)
      window.xiaoliu.pet.notifyClipDone(justEnded)
      return
    }
    // 2) 排队的停止意图
    if (pendingStopRef.current) {
      setCurrent(null)
      setPendingStop(false)
      window.xiaoliu.pet.notifyClipDone(null)
      return
    }
    // 3) loop 且无意图：什么都不做，sprite 自己继续循环
    if (cur.kind === 'loop') return
    // 4) oneshot：走 next 链
    if (cur.next) {
      const nextName = cur.next
      setCurrent({ name: nextName, kind: CLIP_REGISTRY[nextName].kind })
      setPlayKey((k) => k + 1)
      window.xiaoliu.pet.notifyClipDone(justEnded)
      return
    }
    // 5) oneshot 自然结束：回 idle
    setCurrent(null)
    window.xiaoliu.pet.notifyClipDone(justEnded)
  }

  // 主进程发来的播放/停止指令，转给本地状态机
  useEffect(() => {
    const offPlay = window.xiaoliu.pet.onPlayClip((name, opts) => playClip(name, opts))
    const offStop = window.xiaoliu.pet.onStopClip((opts) => stopClip(opts))
    return () => {
      offPlay()
      offStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // setFacing 触发 Sprite 用新 src 重渲染；raf 从 frame 0 重启（切朝向有一闪，调试期可接受）
  useEffect(() => {
    const off = window.xiaoliu.pet.onToggleFacing(() => {
      setFacing((f) => (f === 'left' ? 'right' : 'left'))
    })
    return off
  }, [])

  // 状态机镜像 ref：让 useEffect([]) 闭包内的回调读到最新值
  useEffect(() => {
    currentRef.current = current
  }, [current])
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  useEffect(() => {
    pendingStopRef.current = pendingStop
  }, [pendingStop])
  useEffect(() => {
    scaleRef.current = scale
  }, [scale])
  useEffect(() => {
    chatOpenRef.current = chatOpen
    // chat 打开瞬间立刻收 hover，不等下一帧 mousemove，避免按钮和气泡叠半秒
    if (chatOpen && hoverActiveRef.current) {
      hoverActiveRef.current = false
      setHoverActive(false)
    }
  }, [chatOpen])
  useEffect(() => {
    pendingPermissionRef.current = pendingPermission
  }, [pendingPermission])
  useEffect(() => {
    pendingAskUserRef.current = pendingAskUser
  }, [pendingAskUser])
  useEffect(() => {
    chatTitleRef.current = chatTitle
  }, [chatTitle])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // 单向流（renderer → main），不再订阅反向——本地测量是唯一数据源
  // bubbleVisible 等价 chatOpen；社区版只剩聊天气泡这一种内容
  const bubbleVisible = chatOpen
  useEffect(() => {
    window.xiaoliu.bubble.setState({
      visible: bubbleVisible,
      width: bubbleSize.w,
      height: bubbleSize.h,
      chatOpen
    })
  }, [bubbleVisible, bubbleSize.w, bubbleSize.h, chatOpen])

  function onBubbleMeasure(w: number, h: number): void {
    setBubbleSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
  }

  // 开 → 关 / 关 → 开。setFocusable IPC 比 setChatOpen 更早发出，让 main 切 focusable
  // 与 RoughInput mount 并发跑；RoughInput 内部 autoFocus 还会延一帧兜底
  function toggleChat(): void {
    if (chatOpenRef.current) {
      // 关气泡前兜底 deny 待决权限，避免主进程 await 永久挂起
      const pp = pendingPermissionRef.current
      if (pp) {
        window.xiaoliu.permission.resolve(pp.reqId, 'deny')
        setPendingPermission(null)
      }
      // 兜底清掉 ask_user_question 待决态
      const pa = pendingAskUserRef.current
      if (pa) {
        window.xiaoliu.askUser.resolve({
          reqId: pa.reqId,
          canceled: true,
          selectedOptions: [],
          otherText: ''
        })
        setPendingAskUser(null)
      }
      // 关气泡顺便清掉「新对话」确认条
      setConfirmingNewConv(false)
      window.xiaoliu.window.setFocusable(false)
      setChatOpen(false)
      return
    }
    window.xiaoliu.window.setFocusable(true)
    setChatOpen(true)
    // 只有首次打开 / 历史被清空时插开场白；用函数式更新读最新 messages 避免闭包陈旧
    setMessages((prev) => {
      if (prev.length > 0) return prev
      const greet = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
      return [{ id: newId(), role: 'pet', kind: 'say', text: greet, time: nowHM() }]
    })
  }

  // 用户消息 + 空 pet 占位入队，发起 LLM 流；history 交由 main 注入最新 system prompt
  function sendMessage(raw: string): void {
    const text = raw.trim()
    if (!text || streaming) return
    // 首条用户消息生成对话 id；crypto.randomUUID 在 Electron 33 / Chromium 130+ 直出，无需 polyfill
    if (!currentConvIdRef.current) {
      currentConvIdRef.current = crypto.randomUUID()
      convCreatedAtRef.current = Date.now()
    }
    const userMsg: ChatMsg = {
      id: newId(),
      role: 'user',
      kind: 'say',
      text,
      time: nowHM()
    }
    const petPlaceholder: ChatMsg = {
      id: newId(),
      role: 'pet',
      kind: 'say',
      text: '',
      time: nowHM()
    }
    const nextMsgs = [...messages, userMsg, petPlaceholder]
    setMessages(nextMsgs)
    setInput('')
    setStreaming(true)
    // 历史：跳过空占位和非 say 类；main 端注入最新 system message
    const history: ChatMessage[] = nextMsgs
      .filter((m) => m.kind === 'say' && m.text.length > 0)
      .map<ChatMessage>((m) => ({
        role: m.role === 'pet' ? 'assistant' : 'user',
        content: m.text
      }))
    window.xiaoliu.llm.startStream(history)
  }

  function newConversation(): void {
    if (streaming) window.xiaoliu.llm.abort()
    if (pendingPermission) {
      window.xiaoliu.permission.resolve(pendingPermission.reqId, 'deny')
      setPendingPermission(null)
    }
    if (pendingAskUser) {
      window.xiaoliu.askUser.resolve({
        reqId: pendingAskUser.reqId,
        canceled: true,
        selectedOptions: [],
        otherText: ''
      })
      setPendingAskUser(null)
    }
    setMessages([])
    setStreaming(false)
    setInput('')
    setChatTitle('')
    setConfirmingNewConv(false)
    // 清归档元数据；下条用户消息时重新生成
    currentConvIdRef.current = null
    convCreatedAtRef.current = 0
  }

  // 三步顺序关键：① interruptedRef 先置位屏蔽迟到事件 → ② setMessages 替换文本
  // → ③ abort IPC。若顺序错误：① 晚于 onChunk flush 会追加胡言乱语；③ 早于 ② 则
  // onDone 可能在 reconcile 前到达，提前清 interruptedRef 导致迟到 chunk 不被屏蔽
  function handleInterrupt(): void {
    interruptedRef.current = true
    const reply = INTERRUPT_REPLIES[Math.floor(Math.random() * INTERRUPT_REPLIES.length)]
    setMessages((msgs) => {
      // 整体覆盖最后一条 pet say（半截截断的文字比"听你吩咐"更突兀）
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'pet' && m.kind === 'say') {
          const next = msgs.slice()
          next[i] = { ...m, text: reply, hidden: false, time: nowHM() }
          return next
        }
      }
      // 防御性兜底：streaming=true 时按理一定有 pet 占位
      return [
        ...msgs,
        { id: newId(), role: 'pet' as const, kind: 'say' as const, text: reply, time: nowHM() }
      ]
    })
    window.xiaoliu.llm.abort()
  }

  // 消息为空直接清空，否则弹确认条
  function requestNewConversation(): void {
    const hasContent = messagesRef.current.some(
      (m) => m.kind === 'say' && !m.hidden && m.text.length > 0
    )
    if (!hasContent) {
      newConversation()
      return
    }
    setConfirmingNewConv(true)
  }

  // petPos 只在首次拿到 settings 时初始化一次：
  //   rememberPetPosition=true → 用 appearance.petPosition（无则回落默认锚点）
  //   rememberPetPosition=false → 一律默认锚点
  // 后续 settings:changed（如改 size 档位）不再重置，避免改设置时桌宠跳回默认锚点
  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      const [s, info] = await Promise.all([
        window.xiaoliu.settings.load(),
        window.xiaoliu.pet.getScreenInfo()
      ])
      if (!alive) return
      setScale(SIZE_LABELS[s.appearance.size].scale)
      setScreenInfo(info)
      if (!initialPosAppliedRef.current && !dragStateRef.current) {
        initialPosAppliedRef.current = true
        const start =
          s.general.rememberPetPosition && s.appearance.petPosition
            ? s.appearance.petPosition
            : info.defaultAnchor
        setPetPos(start)
      }
    }
    void refresh()
    const off = window.xiaoliu.settings.onChanged(() => {
      void refresh()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // 资源预热：1) Image.decode() 填 HTMLImageElement 解码缓存；
  // 2) warmup 容器挂 background-image 触发 CSS 解码路径进合成器缓存。
  // idle.webp 同步做整张 alpha 表供 hit-test 使用。
  // 只预热 left 资源；首次切朝向有 1-2 帧解码间隙，turn 动画掩盖，可接受。
  useEffect(() => {
    const warmup = document.createElement('div')
    warmup.setAttribute('aria-hidden', 'true')
    // 视口外但仍是「可见元素」——浏览器照常 paint（含解码），display:none/width:0 会跳过
    warmup.style.position = 'fixed'
    warmup.style.left = '-99999px'
    warmup.style.top = '-99999px'
    warmup.style.width = '1px'
    warmup.style.height = '1px'
    warmup.style.overflow = 'hidden'
    warmup.style.pointerEvents = 'none'
    document.body.appendChild(warmup)

    const idle = new Image()
    idle.src = idleSources.l
    idle
      .decode()
      .then(() => {
        const canvas = document.createElement('canvas')
        canvas.width = FRAME_WIDTH
        canvas.height = FRAME_HEIGHT
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(idle, 0, 0)
        try {
          alphaMapRef.current = ctx.getImageData(
            0,
            0,
            FRAME_WIDTH,
            FRAME_HEIGHT
          ).data
        } catch {
          alphaMapRef.current = null
        }
      })
      .catch(() => {
        alphaMapRef.current = null
      })

    // onload + decode() 双保险：Chromium 对大体积 lossless WebP 偶有 decode() 挂住不 resolve 也不 reject，
    // onload 仍会正常触发；两者 race 取先到者
    CLIP_NAMES.forEach((name) => {
      const img = new Image()
      let settled = false
      const markReady = (): void => {
        if (settled) return
        settled = true
        clipImgsRef.current[name] = img
        setFrameCounts((fc) => ({
          ...fc,
          [name]: CLIP_REGISTRY[name].frameCount
        }))
        const cell = document.createElement('div')
        cell.style.width = '1px'
        cell.style.height = '1px'
        cell.style.backgroundImage = `url(${CLIP_SOURCES[name].l})`
        cell.style.backgroundRepeat = 'no-repeat'
        warmup.appendChild(cell)
      }
      img.onload = markReady
      img.src = CLIP_SOURCES[name].l
      img.decode().then(markReady).catch((err) => {
        console.error(`[clip] decode failed: ${name}`, err)
      })
    })

    // 1×1 取样画布，复用避免每次 mousemove 创建/释放
    const sample = document.createElement('canvas')
    sample.width = 1
    sample.height = 1
    sampleCanvasRef.current = sample

    return () => {
      if (warmup.parentNode) warmup.parentNode.removeChild(warmup)
    }
  }, [])

  // hit-test mousemove 决定窗口穿透：
  // - data-clickable="true" → 不穿透；data-clickable="alpha" → 查精灵图 alpha 判定
  useEffect(() => {
    const setIgnore = (ignore: boolean): void => {
      if (ignore === ignoredRef.current) return
      ignoredRef.current = ignore
      window.xiaoliu.window.setIgnoreMouse(ignore)
    }

    // hover 状态切换：用 ref 跳过相同值，避免每帧 mousemove 都 setState
    const setHover = (next: boolean): void => {
      const v = next && !chatOpenRef.current
      if (v === hoverActiveRef.current) return
      hoverActiveRef.current = v
      setHoverActive(v)
    }

    const isIdleOpaque = (localX: number, localY: number): boolean => {
      const map = alphaMapRef.current
      if (!map) return true // 解码完成前一律视为实体，避免误穿透
      if (localX < 0 || localX >= FRAME_WIDTH || localY < 0 || localY >= FRAME_HEIGHT)
        return false
      // facing=right 时 alpha 表来自 left；x 翻转回 left 坐标系查表 = 等价，O(1) 无内存代价
      const x =
        facingRef.current === 'right' ? FRAME_WIDTH - 1 - localX : localX
      return map[(localY * FRAME_WIDTH + x) * 4 + 3] > ALPHA_THRESHOLD
    }

    const isAnimationFrameOpaque = (
      img: HTMLImageElement | null,
      frame: number,
      localX: number,
      localY: number
    ): boolean => {
      const sample = sampleCanvasRef.current
      if (!img || !sample) return true
      if (localX < 0 || localX >= FRAME_WIDTH || localY < 0 || localY >= FRAME_HEIGHT)
        return false
      const ctx = sample.getContext('2d', { willReadFrequently: true })
      if (!ctx) return true
      // clipImgsRef 只缓存 left；facing=right 时 x 翻转回 left 坐标系再抠像素
      const x =
        facingRef.current === 'right' ? FRAME_WIDTH - 1 - localX : localX
      // frame 索引 → (col, row) → 源像素坐标
      const col = frame % SPRITE_GRID_COLS
      const row = Math.floor(frame / SPRITE_GRID_COLS)
      ctx.clearRect(0, 0, 1, 1)
      ctx.drawImage(
        img,
        col * FRAME_WIDTH + x,
        row * FRAME_HEIGHT + localY,
        1,
        1,
        0,
        0,
        1,
        1
      )
      return ctx.getImageData(0, 0, 1, 1).data[3] > ALPHA_THRESHOLD
    }

    const isCharacterOpaque = (
      rect: DOMRect,
      clientX: number,
      clientY: number
    ): boolean => {
      // rect 是 transform 后的视口尺寸（width = FRAME_WIDTH × scale）；
      // alpha 表按原图 240×280 索引，必须除回 scale 才能查到正确像素
      const s = scaleRef.current || 1
      const localX = Math.floor((clientX - rect.left) / s)
      const localY = Math.floor((clientY - rect.top) / s)
      const cur = currentRef.current
      if (cur === null) {
        return isIdleOpaque(localX, localY)
      }
      const img = clipImgsRef.current[cur.name] ?? null
      return isAnimationFrameOpaque(img, spriteFrameRef.current, localX, localY)
    }

    const onMove = (e: MouseEvent): void => {
      // 拖拽中：强制全窗口不穿透，否则鼠标移到 sprite 透明像素时窗口立刻变透 → 拖拽被中断
      if (dragStateRef.current) {
        setIgnore(false)
        setHover(false)
        return
      }
      // 气泡在 sprite 之后渲染（z 序更高），重叠区最顶层是气泡 div，扫到 clickable=true 立刻不穿透。
      // alpha 分支：chat 关闭 / cursor 不在气泡区时，透明像素继续往下扫，落默认分支 setIgnore(true)，OS 穿透到桌面。
      const stack = document.elementsFromPoint(e.clientX, e.clientY)
      let shouldIgnore = true
      let hoverHit = false
      for (const node of stack) {
        if (!(node instanceof HTMLElement)) continue
        const tag = node.dataset.clickable
        if (tag === 'true') {
          shouldIgnore = false
          // hover 按钮：直接命中 wrapper 或子按钮都算 hover 持续，鼠标从 sprite 滑到按钮不闪
          if (node.dataset.hoverTarget === 'true' || node.closest('[data-hover-target="true"]')) {
            hoverHit = true
          }
          break
        }
        if (tag === 'alpha') {
          const rect = node.getBoundingClientRect()
          if (isCharacterOpaque(rect, e.clientX, e.clientY)) {
            shouldIgnore = false
            hoverHit = true
            break
          }
          // 像素透明：跳过这层，继续看 stack 后面（可能下层是气泡）
        }
      }
      setIgnore(shouldIgnore)
      setHover(hoverHit)
    }

    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      // 卸载时恢复全交互，避免窗口保留穿透状态
      if (ignoredRef.current) {
        window.xiaoliu.window.setIgnoreMouse(false)
        ignoredRef.current = false
      }
    }
  }, [])

  function onContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    // screenX/Y 是屏幕绝对坐标，main 据此定位菜单窗口
    window.xiaoliu.petMenu.show({ x: e.screenX, y: e.screenY })
  }

  // 重叠区由 DOM 渲染顺序兜底——气泡 z 序更高，mousedown 先落到气泡，不触发本函数。
  // 保留 stack 扫描作 defense in depth：未来引入 portal/modal 时 sprite 仍能识别命中气泡并放弃 drag
  function onSpriteMouseDown(e: React.MouseEvent): void {
    if (e.button !== 0) return // 只处理左键
    if (!petPos) return
    const stack = document.elementsFromPoint(e.clientX, e.clientY)
    for (const node of stack) {
      if (!(node instanceof HTMLElement)) continue
      const tag = node.dataset.clickable
      // hit-zone 有 data-drag-passthrough，穿透让拖拽正常工作
      if (tag === 'true' && !node.dataset.dragPassthrough) {
        e.preventDefault() // 阻断文字选中；按钮 onClick 仍正常触发
        return // 命中气泡或按钮——别拖拽、别 toggleChat
      }
      // alpha 是 sprite 自己，继续往下扫看气泡是否被 portal 推到了下层
    }
    e.preventDefault()
    // 行走中拖拽：直接取消 raf，不发 walk-finished——叠 walk-end 反而要「走完才能拖」
    if (walkRafRef.current !== null) {
      cancelAnimationFrame(walkRafRef.current)
      walkRafRef.current = null
      walkPosRef.current = null
    }
    dragStateRef.current = {
      pointerOffsetX: e.clientX - petPos.x,
      pointerOffsetY: e.clientY - petPos.y,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      moved: false
    }
  }

  // 全局拖拽：mousedown 后挂在 window，避免鼠标移出 sprite 区域丢失
  useEffect(() => {
    function dragBoundary(x: number, y: number): { x: number; y: number } {
      if (!screenInfo) return { x, y }
      const { workArea, screen: scr, spriteSize } = screenInfo
      // workArea 不准——用整屏 bounds 因为用户允许 sprite 越过任务栏
      // 至少 MIN_VISIBLE_PX 留在屏幕内：左不能小于 -(width-MIN)、右不能大于 screenWidth-MIN
      const minX = -(spriteSize.width - MIN_VISIBLE_PX)
      const maxX = scr.width - MIN_VISIBLE_PX
      const minY = -(spriteSize.height - MIN_VISIBLE_PX)
      const maxY = scr.height - MIN_VISIBLE_PX
      // workArea 暂未使用；留着方便后续吸附任务栏时再用
      void workArea
      return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y))
      }
    }

    function onMove(e: MouseEvent): void {
      const ds = dragStateRef.current
      if (!ds) return
      const dx = e.clientX - ds.startScreenX
      const dy = e.clientY - ds.startScreenY
      if (!ds.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        ds.moved = true
        setDragging(true)
      }
      if (!ds.moved) return
      const next = dragBoundary(
        e.clientX - ds.pointerOffsetX,
        e.clientY - ds.pointerOffsetY
      )
      setPetPos(next)
    }
    function onUp(e: MouseEvent): void {
      const ds = dragStateRef.current
      if (!ds) return
      dragStateRef.current = null
      if (ds.moved) {
        // 拖拽结束：用 e 的当前坐标算最终位置，避免最后一次 move 漏掉
        const finalPos = dragBoundary(
          e.clientX - ds.pointerOffsetX,
          e.clientY - ds.pointerOffsetY
        )
        setPetPos(finalPos)
        setDragging(false)
        window.xiaoliu.pet.savePosition(finalPos)
      } else {
        // 没动：当 click → 切换气泡
        setDragging(false)
        toggleChat()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenInfo])

  // 行走 raf：不能把 petPos 列进 deps，否则每帧 setPetPos 都会重跑 effect 取消 raf。
  // 当前位置通过 petPosRef / walkPosRef 访问；facing 用 facingRef 快照，行走中途切朝向不影响方向
  useEffect(() => {
    petPosRef.current = petPos
  }, [petPos])

  useEffect(() => {
    function dragBoundary(x: number, y: number): { x: number; y: number } {
      if (!screenInfo) return { x, y }
      const { screen: scr, spriteSize } = screenInfo
      const minX = -(spriteSize.width - MIN_VISIBLE_PX)
      const maxX = scr.width - MIN_VISIBLE_PX
      const minY = -(spriteSize.height - MIN_VISIBLE_PX)
      const maxY = scr.height - MIN_VISIBLE_PX
      return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y))
      }
    }

    function finishWalk(finalPos: { x: number; y: number }): void {
      walkRafRef.current = null
      walkPosRef.current = null
      setPetPos(finalPos)
      window.xiaoliu.pet.savePosition(finalPos)
      window.xiaoliu.pet.notifyWalkFinished()
    }

    const unsubscribe = window.xiaoliu.pet.onWalkCommand((cmd) => {
      if (cmd.action === 'start') {
        // 拖拽中或已在走则拒绝并发
        if (dragStateRef.current || walkRafRef.current !== null) return
        const seed = petPosRef.current
        if (!seed || !screenInfo) return
        const speed = Math.max(10, Math.min(500, cmd.speed ?? DEFAULT_WALK_SPEED))
        // facing 快照——行走中途切朝向不改变本次步行方向
        const direction = facingRef.current === 'right' ? 1 : -1
        const startTime = performance.now()
        const startX = seed.x
        const startY = seed.y
        walkPosRef.current = { x: startX, y: startY }
        const tick = (now: number): void => {
          if (!screenInfo) {
            walkRafRef.current = null
            return
          }
          const elapsed = (now - startTime) / 1000
          const targetX = startX + direction * speed * elapsed
          const clamped = dragBoundary(targetX, startY)
          walkPosRef.current = clamped
          setPetPos(clamped)
          if (clamped.x === targetX) {
            walkRafRef.current = requestAnimationFrame(tick)
          } else {
            // 钳位 = 撞边沿，自停
            finishWalk(clamped)
          }
        }
        walkRafRef.current = requestAnimationFrame(tick)
      } else if (cmd.action === 'stop') {
        if (walkRafRef.current !== null) {
          cancelAnimationFrame(walkRafRef.current)
          const final = walkPosRef.current ?? petPosRef.current ?? { x: 0, y: 0 }
          finishWalk(final)
        }
      }
    })

    return () => {
      unsubscribe()
      if (walkRafRef.current !== null) {
        cancelAnimationFrame(walkRafRef.current)
        walkRafRef.current = null
        walkPosRef.current = null
      }
    }
  }, [screenInfo])

  // 只在气泡可见且已测到尺寸时纳入定位计算，避免先以 (0,0) 渲染再跳
  const bubbleW = bubbleVisible ? bubbleSize.w : 0
  const bubbleH = bubbleVisible ? bubbleSize.h : 0
  const ready = petPos !== null

  return (
    <div
      className="relative h-screen w-screen overflow-hidden"
      onContextMenu={onContextMenu}
      style={{ cursor: dragging ? 'grabbing' : 'default' }}
    >
      {/* 渲染顺序关键：sprite 在气泡之前，气泡 z 序更高，重叠区 mousedown 先落到气泡不触发 drag */}
      {ready && petPos && (
        <div
          style={{
            position: 'absolute',
            left: petPos.x,
            top: petPos.y,
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            cursor: dragging ? 'grabbing' : 'grab'
          }}
          className="flex flex-col items-center justify-end p-3"
          onMouseDown={onSpriteMouseDown}
        >
          <Character
            current={current}
            facing={facing}
            playKey={playKey}
            frameCount={current ? frameCounts[current.name] : 0}
            onClipBoundary={onClipBoundary}
            onSpriteFrame={(f) => {
              spriteFrameRef.current = f
            }}
          />
        </div>
      )}

      {/* hit-zone 常驻渲染（不跟 hoverActive 联动）——若随 hoverActive 出现/消失，
          鼠标首次进入时 hit-zone 不存在，onMove 永远命中不到，按钮永远不显示（鸡蛋问题）。
          代价：头顶小矩形不再穿透桌面，HOVER_HIT_PADDING 紧凑布局把代价压到最小 */}
      {ready && petPos && !chatOpen && !bubbleVisible && (() => {
        const HOVER_BTN_DIAMETER = 44 // 圆按钮直径
        const HOVER_BTN_GAP = 12 // 按钮间距
        const HOVER_BTN_ROW_OFFSET_X = 0 // 整行水平偏移：正→右，负→左
        const HOVER_BTN_ROW_OFFSET_Y = 10 // 整行垂直偏移；负→上，正→下
        const HOVER_BTN_SIDE_DROP = 15 // 左右两侧按钮下沉量（px），排成「∪」弧形
        const HOVER_HIT_PADDING = 16 // hit-zone 余量：含 gap + 过渡区，防鼠标移到 gap 时按钮闪退
        const rowWidth = HOVER_BTN_DIAMETER * 3 + HOVER_BTN_GAP * 2
        const rowHeight = HOVER_BTN_DIAMETER + HOVER_BTN_SIDE_DROP // 含侧边下沉的视觉总高
        const rowLeft = (FRAME_WIDTH - rowWidth) / 2 + HOVER_BTN_ROW_OFFSET_X
        const rowTop = HOVER_BTN_ROW_OFFSET_Y
        // hit-zone 垂直延伸到整个 sprite 高度，消除按钮区到头顶之间的间隙断层
        const hitLeft = rowLeft - HOVER_HIT_PADDING
        const hitWidth = rowWidth + HOVER_HIT_PADDING * 2
        const hitHeight = FRAME_HEIGHT
        return (
          <div
            data-hover-target="true"
            style={{
              position: 'absolute',
              left: petPos.x,
              top: petPos.y,
              width: FRAME_WIDTH,
              height: FRAME_HEIGHT,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              pointerEvents: 'none',
              zIndex: 30
            }}
          >
            {/* hit-zone 常驻，elementsFromPoint 命中后 setHover(true)，无需先碰到 sprite 实体像素 */}
            <div
              data-clickable="true"
              data-hover-target="true"
              data-drag-passthrough="true"
              onMouseDown={onSpriteMouseDown}
              style={{
                position: 'absolute',
                left: hitLeft,
                top: 0,
                width: hitWidth,
                height: hitHeight,
                pointerEvents: 'auto',
                background: 'transparent',
                userSelect: 'none'
              }}
            >
              {/* 按钮仅在 hoverActive 时渲染 */}
              {hoverActive && (
                <div
                  className="absolute flex items-start"
                  style={{ left: HOVER_HIT_PADDING, top: rowTop, gap: HOVER_BTN_GAP, pointerEvents: 'none' }}
                >
                  <div style={{ marginTop: HOVER_BTN_SIDE_DROP }}>
                    <RoughCircleButton
                      icon="fa-baseball-ball"
                      label="玩耍"
                      seed={11}
                      diameter={HOVER_BTN_DIAMETER}
                      onClick={() => playClip('idle-playball', { force: true })}
                    />
                  </div>
                  <RoughCircleButton
                    icon="fa-book-open-reader"
                    label="阅读"
                    seed={23}
                    diameter={HOVER_BTN_DIAMETER}
                    onClick={startReadingSession}
                  />
                  <div style={{ marginTop: HOVER_BTN_SIDE_DROP }}>
                    <RoughCircleButton
                      icon="fa-gear"
                      label="设置"
                      seed={37}
                      diameter={HOVER_BTN_DIAMETER}
                      onClick={() => window.xiaoliu.window.openSettings()}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* 气泡必须在 sprite 之后渲染，否则 z 序被 sprite 盖住，点气泡按钮会触发 toggleChat */}
      {ready && bubbleVisible && petPos && (
        <div
          style={{
            position: 'absolute',
            left:
              facing === 'right'
                ? petPos.x + (FRAME_WIDTH - BUBBLE_OFFSET_X) * scale
                : petPos.x - (bubbleW - BUBBLE_OFFSET_X) * scale,
            top: petPos.y - (bubbleH - BUBBLE_OFFSET_Y) * scale,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        >
          <ContentBubble onMeasure={onBubbleMeasure} maxContentWidth={288} tailSide={facing === 'right' ? 'left' : 'right'}>
              <div className="relative flex w-[256px] flex-col gap-2">
              <div className="flex items-center border-b border-zhihu-ink/10 pb-1.5">
                <button
                  type="button"
                  className="font-kangkang shrink-0 rounded px-1 py-0.5 text-[11px] text-zhihu-gray transition-colors hover:text-zhihu-blue"
                  onClick={requestNewConversation}
                  title="开启新对话"
                >
                  新对话
                </button>
                <span className="flex-1 truncate text-center font-kangkang text-[11px] text-zhihu-gray/60">
                  {chatTitle}
                </span>
                <button
                  type="button"
                  className="font-kangkang shrink-0 rounded px-1 py-0.5 text-[11px] text-zhihu-gray transition-colors hover:text-zhihu-blue"
                  onClick={toggleChat}
                  title="关闭气泡"
                >
                  关闭
                </button>
              </div>
              <ChatThread messages={messages} streaming={streaming} />
              {/* 浮动状态行：streaming 中且 tool_describe 是最新动作时出现 */}
              <ToolDescribeRow messages={messages} streaming={streaming} />
              {/* 底部四态互斥：permission > askUser > streaming > idle 输入 */}
              {pendingPermission ? (
                <PermissionRow
                  request={pendingPermission}
                  onResolve={(decision) => {
                    window.xiaoliu.permission.resolve(
                      pendingPermission.reqId,
                      decision
                    )
                    setPendingPermission(null)
                  }}
                />
              ) : pendingAskUser ? (
                <AskUserPanel
                  request={pendingAskUser}
                  onResolve={(response) => {
                    window.xiaoliu.askUser.resolve(response)
                    setPendingAskUser(null)
                  }}
                />
              ) : streaming ? (
                <InterruptButton onClick={handleInterrupt} />
              ) : (
                <RoughInput
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  placeholder="说点什么…"
                  disabled={false}
                  autoFocus
                />
              )}
              {confirmingNewConv && (
                <RoughConfirm
                  message="开启新对话会清空上下文（全局记忆不会影响）"
                  onCancel={() => setConfirmingNewConv(false)}
                  onConfirm={newConversation}
                />
              )}
              </div>
            </ContentBubble>
        </div>
      )}
    </div>
  )
}


function Character(props: {
  /** null = idle 底图，不开 raf */
  current: CurrentClip | null
  facing: 'left' | 'right'
  /** 每次触发播放自增，Sprite effect 重跑重启动画 */
  playKey: number
  /** 图加载完才有真实值 */
  frameCount: number
  /** 父层在 mouseup-without-drag 时分发；可选是因为当前不走 button onClick */
  onClick?: () => void
  onClipBoundary: () => void
  onSpriteFrame: (frame: number) => void
}): JSX.Element {
  // idle 底图常驻，current=null 时可见；current 非 null 时 Sprite 顶上来，无需多挂层
  const layerStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT
  }
  const idleSrc = props.facing === 'left' ? idleSources.l : idleSources.r
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-clickable="alpha"
      className="titlebar-no-drag relative border-0 bg-transparent p-0 outline-none"
      style={{ width: FRAME_WIDTH, height: FRAME_HEIGHT }}
    >
      <img
        src={idleSrc}
        alt="小刘"
        draggable={false}
        style={{
          ...layerStyle,
          display: 'block',
          visibility: props.current === null ? 'visible' : 'hidden'
        }}
      />
      {props.current && (
        <div style={layerStyle}>
          <Sprite
            src={CLIP_SOURCES[props.current.name][props.facing === 'left' ? 'l' : 'r']}
            frameCount={props.frameCount}
            kind={props.current.kind}
            playKey={props.playKey}
            onBoundary={props.onClipBoundary}
            onFrame={props.onSpriteFrame}
          />
        </div>
      )}
    </button>
  )
}

/**
 * 精灵图播放器。background-position 做帧切换；按墙钟时间推帧，掉帧也不变速。
 * oneshot：末帧停 raf + 调 onBoundary。loop：末帧调 onBoundary + 重置 startedAt 继续循环。
 * frameCount=0 时跳过，onload 回填后 effect 重跑自启动；playKey 自增让同名 clip 重头再播。
 */
function Sprite(props: {
  src: string
  frameCount: number
  kind: ClipKind
  playKey: number
  onBoundary?: () => void
  onFrame?: (frame: number) => void
}): JSX.Element {
  const [frame, setFrame] = useState(0)
  const onBoundaryRef = useRef(props.onBoundary)
  onBoundaryRef.current = props.onBoundary
  const onFrameRef = useRef(props.onFrame)
  onFrameRef.current = props.onFrame

  useEffect(() => {
    if (props.frameCount <= 0) {
      setFrame(0)
      onFrameRef.current?.(0)
      return
    }
    let raf = 0
    let startedAt = 0
    const frameDurationMs = 1000 / SPRITE_FPS
    const lastIndex = props.frameCount - 1

    const tick = (now: number): void => {
      if (startedAt === 0) startedAt = now
      const f = Math.floor((now - startedAt) / frameDurationMs)
      if (f >= lastIndex) {
        if (props.kind === 'oneshot') {
          setFrame(lastIndex)
          onFrameRef.current?.(lastIndex)
          onBoundaryRef.current?.()
          return // 停 raf，画面停在末帧
        }
        // loop：调 onBoundary、重置墙钟基准、回 frame 0 续上
        onBoundaryRef.current?.()
        startedAt = now
        setFrame(0)
        onFrameRef.current?.(0)
        raf = requestAnimationFrame(tick)
        return
      }
      setFrame(f)
      onFrameRef.current?.(f)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [props.src, props.frameCount, props.kind, props.playKey])

  // frame 索引 → (col, row) → background-position 二维偏移
  const col = frame % SPRITE_GRID_COLS
  const row = Math.floor(frame / SPRITE_GRID_COLS)
  return (
    <div
      className="block"
      style={{
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        backgroundImage: `url(${props.src})`,
        backgroundPosition: `-${col * FRAME_WIDTH}px -${row * FRAME_HEIGHT}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'auto'
      }}
    />
  )
}

