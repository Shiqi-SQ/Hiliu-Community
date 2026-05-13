import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from '../system/binPath'
import { uiaCall } from './uiaService'

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function asInt64(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') {
    // 接受 '12345' 也接受 '0xABCDEF'
    const n = v.trim().toLowerCase().startsWith('0x')
      ? parseInt(v.trim().slice(2), 16)
      : Number(v.trim())
    return Number.isFinite(n) ? Math.trunc(n) : fallback
  }
  return fallback
}

function hwndHex(n: number): string {
  return '0x' + Math.abs(n).toString(16).toUpperCase()
}

interface WindowEntry {
  hwnd: number
  title: string
  processName: string
  pid: number
  isForeground: boolean
  isMinimized: boolean
}

const listWindowsFragment = [
  'list_windows()',
  '   列出当前桌面上所有可见、有标题的顶层窗口。返回每个窗口的 hwnd / 标题 / 进程名 / PID，',
  '   并标记哪一个在最前台、哪些被最小化了。',
  '   典型用法：用户说"帮我打开微信发条消息"——先 list_windows 找到微信的 hwnd，',
  '   再 focus_window 切到前台，再 ui_snapshot 抓 UI 树定位输入框。',
  '   注意：无标题窗口（系统托盘、桌面背景层）会被过滤；隐藏窗口也不会出现。'
].join('\n')

const listWindowsDescriptor: ToolDescriptor = {
  id: 'builtin:list_windows',
  name: 'list_windows',
  source: 'builtin',
  displayName: 'list_windows',
  description: '列出当前桌面所有可见顶层窗口（hwnd / 标题 / 进程名 / PID / 最前台 / 最小化状态）。',
  promptFragment: { appLayer: listWindowsFragment, native: listWindowsFragment },
  nativeDef: {
    name: 'list_windows',
    description:
      '列出桌面所有可见顶层窗口的 hwnd、标题、进程名、PID，标记前台 / 最小化状态。常用于"找到某个 App 的窗口"作为后续 focus_window / ui_snapshot 的入口。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '桌面可见窗口列表',
  executor: async () => {
    try {
      const list = await uiaCall<WindowEntry[]>('list_windows', {}, 5000)
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: true, content: '（当前桌面没有可见的有标题窗口。）' }
      }
      const lines = list.map((w) => {
        const flags: string[] = []
        if (w.isForeground) flags.push('foreground')
        if (w.isMinimized) flags.push('minimized')
        const flagStr = flags.length ? ` (${flags.join(', ')})` : ''
        return `${hwndHex(w.hwnd)}  [${w.processName || '?'} pid=${w.pid}]  "${w.title}"${flagStr}`
      })
      return { ok: true, content: `共 ${list.length} 个窗口：\n${lines.join('\n')}` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `list_windows 失败：${msg}` }
    }
  }
}

interface SnapshotResult {
  scope: string
  maxDepth: number
  refCount: number
  tree: string
}

const uiSnapshotFragment = [
  'ui_snapshot({scope?: "foreground"|"hwnd"|"desktop", hwnd?: number, maxDepth?: number})',
  '   抓某个窗口（或整个桌面）的 UI 控件树，返回缩进文本，每个元素带一个 ref（如 e17），',
  '   后续 ui_inspect / ui_act 都靠这个 ref 锁定元素。',
  '   - scope="foreground"（默认）：当前最前台窗口',
  '   - scope="hwnd"：指定 hwnd 的窗口（先 list_windows 拿到 hwnd）',
  '   - scope="desktop"：整个桌面（很大很慢，maxDepth 强制 ≤ 3，慎用）',
  '   - maxDepth 默认 8，最大 16，太深会截断',
  '',
  '   返回行格式： [eN] 控件类型 "name" (focused, disabled, off-screen, value="...")',
  '   其中 value 仅 edit 类元素带，flags 仅当为真才出现。',
  '',
  '   ⚠️ 关键：每次 ui_snapshot 都会**重置 ref 池**——上一次拿到的 e1/e2 立刻失效。',
  '   抓完应当紧接着 ui_inspect/ui_act，不要"放着隔几轮再用"。'
].join('\n')

const uiSnapshotDescriptor: ToolDescriptor = {
  id: 'builtin:ui_snapshot',
  name: 'ui_snapshot',
  source: 'builtin',
  displayName: 'ui_snapshot',
  description: '抓 Windows UI 控件树文本快照，每元素带 ref（一次性，下次 snapshot 即失效）。',
  promptFragment: { appLayer: uiSnapshotFragment, native: uiSnapshotFragment },
  nativeDef: {
    name: 'ui_snapshot',
    description:
      '抓 Windows UI 控件树。返回缩进文本，每行一个元素带 ref（e1, e2, ...），后续 ui_inspect/ui_act 用 ref 操作。每次调用重置 ref 池，旧 ref 立刻失效。',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['foreground', 'hwnd', 'desktop'],
          description: '抓哪里：foreground=当前前台窗口（默认）；hwnd=指定窗口；desktop=整个桌面（慢）'
        },
        hwnd: { type: 'number', description: 'scope=hwnd 时必填，目标窗口句柄（list_windows 返回里的 hwnd）' },
        maxDepth: {
          type: 'number',
          description: '树最大深度，默认 8，硬上限 16；scope=desktop 时强制 ≤ 3'
        }
      }
    }
  },
  extractTarget: (args) => {
    const scope = asString(args.scope) || 'foreground'
    if (scope === 'hwnd') {
      const h = asInt64(args.hwnd)
      return h ? `窗口 ${hwndHex(h)} UI 树` : '指定窗口 UI 树'
    }
    if (scope === 'desktop') return '整个桌面 UI 树'
    return '前台窗口 UI 树'
  },
  executor: async (args) => {
    const scope = asString(args.scope) || 'foreground'
    const params: Record<string, unknown> = { scope }
    if (scope === 'hwnd') {
      const h = asInt64(args.hwnd)
      if (!h) return { ok: false, content: 'ui_snapshot 缺 hwnd（scope=hwnd 时必填）' }
      params.hwnd = h
    }
    if (typeof args.maxDepth !== 'undefined') {
      params.maxDepth = asInt64(args.maxDepth, 8)
    }
    try {
      // snapshot 偶尔慢（深嵌套 / 远程桌面会话），给宽松超时
      const r = await uiaCall<SnapshotResult>('snapshot', params, 15000)
      const head = `scope=${r.scope} maxDepth=${r.maxDepth} refCount=${r.refCount}`
      return { ok: true, content: `${head}\n\n${r.tree}` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `ui_snapshot 失败：${msg}` }
    }
  }
}

interface InspectResult {
  ref: string
  controlType: string
  name: string
  automationId?: string
  className?: string
  isEnabled?: boolean
  isOffscreen?: boolean
  hasKeyboardFocus?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  patterns?: string[]
  value?: string
}

const uiInspectFragment = [
  'ui_inspect({ref: "eN"})',
  '   查 ui_snapshot 给出的某个 ref 的完整元数据：',
  '   automationId / className / 边界矩形 / 是否启用 / 当前是否聚焦 / 当前 value（如果是 edit 类）',
  '   / **支持的 UIA Patterns 列表**——这一项尤其重要：决定 ui_act 能传什么 kind。',
  '   常用 Pattern → 可用 act kind 对照：',
  '     InvokePattern → invoke   ValuePattern → set_value   TogglePattern → toggle',
  '     ExpandCollapsePattern → expand/collapse   SelectionItemPattern → select',
  '   ref 必须来自最近一次 ui_snapshot——snapshot 后再调一次 snapshot，旧 ref 失效。'
].join('\n')

const uiInspectDescriptor: ToolDescriptor = {
  id: 'builtin:ui_inspect',
  name: 'ui_inspect',
  source: 'builtin',
  displayName: 'ui_inspect',
  description: '查某个 UI 元素的完整元数据，含支持的 Patterns（决定能在它上面执行什么 ui_act）。',
  promptFragment: { appLayer: uiInspectFragment, native: uiInspectFragment },
  nativeDef: {
    name: 'ui_inspect',
    description:
      '查询某个 ref 指向的 UI 元素的详细元数据：automationId、className、边界、enabled、是否聚焦、当前 value、支持的 UIA Patterns（决定 ui_act 能传什么 kind）。',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'ui_snapshot 给出的 ref（如 "e17"）' }
      },
      required: ['ref']
    }
  },
  extractTarget: (args) => {
    const r = asString(args.ref)
    return r ? `元素 ${r}` : '元素详情'
  },
  executor: async (args) => {
    const ref = asString(args.ref).trim()
    if (!ref) return { ok: false, content: 'ui_inspect 缺 ref 参数' }
    try {
      const r = await uiaCall<InspectResult>('inspect', { ref }, 5000)
      const lines: string[] = []
      lines.push(`ref: ${r.ref}`)
      lines.push(`controlType: ${r.controlType}`)
      if (r.name) lines.push(`name: "${r.name}"`)
      if (r.automationId) lines.push(`automationId: ${r.automationId}`)
      if (r.className) lines.push(`className: ${r.className}`)
      if (typeof r.isEnabled === 'boolean') lines.push(`isEnabled: ${r.isEnabled}`)
      if (typeof r.isOffscreen === 'boolean') lines.push(`isOffscreen: ${r.isOffscreen}`)
      if (typeof r.hasKeyboardFocus === 'boolean') lines.push(`hasKeyboardFocus: ${r.hasKeyboardFocus}`)
      if (r.bounds) {
        lines.push(`bounds: x=${r.bounds.x} y=${r.bounds.y} w=${r.bounds.width} h=${r.bounds.height}`)
      }
      if (typeof r.value === 'string') lines.push(`value: "${r.value}"`)
      if (r.patterns && r.patterns.length) {
        lines.push(`patterns: ${r.patterns.join(', ')}`)
      }
      return { ok: true, content: lines.join('\n') }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `ui_inspect 失败：${msg}` }
    }
  }
}

const UI_ACT_KINDS = ['invoke', 'set_value', 'toggle', 'focus', 'expand', 'collapse', 'select'] as const
type UiActKind = (typeof UI_ACT_KINDS)[number]

const uiActFragment = [
  'ui_act({ref: "eN", kind: "invoke"|"set_value"|"toggle"|"focus"|"expand"|"collapse"|"select", value?: string})',
  '   在 ref 指向的元素上执行一个动作。kind 必须与该元素「支持的 Pattern」匹配，',
  '   不确定就先 ui_inspect 看 patterns 列表。',
  '',
  '   动作语义：',
  '     - invoke：按一下（button / link / menuitem 等"按一次就触发"的）',
  '     - set_value：写入文本（仅 edit 类带 ValuePattern；复杂富文本编辑器可能不支持）',
  '     - toggle：开关切换（checkbox / 切换按钮）',
  '     - focus：把键盘焦点放上去（不触发动作，只聚焦）',
  '     - expand / collapse：树节点 / 下拉框展开收起',
  '     - select：选中 list / tree / tab 中的一项',
  '',
  '   set_value 必须配 value 参数；其它 kind 不需要 value。',
  '   常见错误："不支持 ValuePattern"——多半是该 edit 是自绘控件，',
  '   退而求其次：先 ui_act focus 聚焦，未来再用 send_keys 之类输入（暂未实现）。'
].join('\n')

const uiActDescriptor: ToolDescriptor = {
  id: 'builtin:ui_act',
  name: 'ui_act',
  source: 'builtin',
  displayName: 'ui_act',
  description: '在某个 UI 元素上执行动作（按一下 / 写文本 / 切换 / 聚焦 / 展开 / 选中）。',
  promptFragment: { appLayer: uiActFragment, native: uiActFragment },
  nativeDef: {
    name: 'ui_act',
    description:
      '在某个 ref 指向的 UI 元素上执行动作。kind 与元素支持的 UIA Pattern 一一对应：invoke=按一下；set_value=写文本（需 value 参数）；toggle=开关；focus=聚焦；expand/collapse=展开收起；select=选中。',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'ui_snapshot 给出的 ref（如 "e17"）' },
        kind: {
          type: 'string',
          enum: [...UI_ACT_KINDS],
          description: '动作类型；需与元素支持的 Pattern 匹配，不确定先 ui_inspect 查 patterns'
        },
        value: { type: 'string', description: '仅 kind=set_value 时必填，要写入的字符串' }
      },
      required: ['ref', 'kind']
    }
  },
  extractTarget: (args) => {
    const ref = asString(args.ref)
    const kind = asString(args.kind)
    if (kind === 'set_value') {
      const v = asString(args.value)
      const truncated = v.length > 30 ? v.slice(0, 30) + '…' : v
      return `${ref} ← 写入 "${truncated}"`
    }
    return `${ref} 执行 ${kind}`
  },
  executor: async (args) => {
    const ref = asString(args.ref).trim()
    const kind = asString(args.kind).trim() as UiActKind
    if (!ref) return { ok: false, content: 'ui_act 缺 ref 参数' }
    if (!UI_ACT_KINDS.includes(kind)) {
      return {
        ok: false,
        content: `ui_act kind 非法：${kind}（可选：${UI_ACT_KINDS.join(' / ')}）`
      }
    }
    const params: Record<string, unknown> = { ref, kind }
    if (kind === 'set_value') {
      if (typeof args.value === 'undefined') {
        return { ok: false, content: 'ui_act kind=set_value 必须带 value 参数' }
      }
      params.value = asString(args.value)
    }
    try {
      const result = await uiaCall<string>('act', params, 5000)
      return { ok: true, content: `${ref} ${kind} → ${result}` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `ui_act 失败：${msg}` }
    }
  }
}

// window_capture 输出双轨：base64 喂给模型 + PNG 落盘 userData/screenshots/（仅追踪用，模型只看 base64）

interface CaptureResult {
  path: string
  width: number
  height: number
  sizeBytes: number
  fallbackUsed: boolean
  scope: string
}

const SCREENSHOT_DIR_NAME = 'screenshots'
const SCREENSHOT_TTL_MS = 5 * 60 * 1000
const SCREENSHOT_CLEAN_INTERVAL_MS = 5 * 60 * 1000

function screenshotDir(): string {
  const dir = join(app.getPath('userData'), SCREENSHOT_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const windowCaptureScopes = ['full-window', 'client', 'screen'] as const
type WindowCaptureScope = (typeof windowCaptureScopes)[number]

const windowCaptureFragment = [
  'window_capture({hwnd?: number, scope?: "full-window"|"client"|"screen"})',
  '   截一张窗口或屏幕的位图，作为 image 直接喂给我（多模态）。',
  '   什么时候用：',
  '     - ui_snapshot 抓回空树或只有一两个 pane（DirectUI 如微信/QQ 音乐、Chromium 如 Edge/VSCode/Electron App）',
  '     - 用户明确说"看下我屏幕这个画面/这一段"',
  '     - 需要看视觉布局/颜色/截图里嵌的图，纯文本树覆盖不到',
  '   什么时候**不**用：',
  '     - 能用 ui_snapshot 拿到结构化文本时优先用——截图比 UIA 树贵 5-10 倍 token（一张 720p ≈ 1500 tokens）',
  '   scope 选择：',
  '     - full-window（默认）：整窗含标题栏，适合"这个 App 现在长啥样"',
  '     - client：只 client 区不含标题栏，适合只关心内容区（写代码/正文阅读类）',
  '     - screen：整屏，看多窗口/弹窗整体；不需要 hwnd',
  '   截窗口前必须先 list_windows 拿 hwnd（PrintWindow 不抢焦点，无需 focus_window）；',
  '   想截前台窗口可以 list_windows 找带 foreground 标记那条；只要整屏视图就用 scope=screen。',
  '',
  '   📌 目标窗口被最小化时的判断：',
  '     PrintWindow 对最小化窗口能截，但 Chromium / Electron 类（VSCode/Discord/CCSwitch/Edge）',
  '     最小化后渲染缓存可能为空 → 截出来是黑/白图。最稳的顺序是：',
  '       list_windows → 看 isMinimized → 是的话先 focus_window 把它弹起来 → 再 window_capture',
  '     传统 Win32 窗口（资源管理器、记事本、cmd）最小化时 PrintWindow 通常 OK，可以直接截。'
].join('\n')

const windowCaptureDescriptor: ToolDescriptor = {
  id: 'builtin:window_capture',
  name: 'window_capture',
  source: 'builtin',
  displayName: 'window_capture',
  description: 'UIA 抓不到内容时的视觉降级：截一张窗口/屏幕位图喂给多模态模型。',
  promptFragment: { appLayer: windowCaptureFragment, native: windowCaptureFragment },
  nativeDef: {
    name: 'window_capture',
    description:
      '截窗口或屏幕的位图作为 image 喂给多模态模型。用于 ui_snapshot 拿不到内容（DirectUI/Chromium）或需要看视觉布局时。scope: full-window=整窗（默认）；client=仅 client 区；screen=整屏（无需 hwnd）。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: {
          type: 'number',
          description: '目标窗口句柄（list_windows 返回里的 hwnd）。scope=screen 时忽略；缺省时 daemon 拒绝（请显式传 list_windows 拿到的 hwnd 或 scope=screen）'
        },
        scope: {
          type: 'string',
          enum: [...windowCaptureScopes],
          description: '截图范围：full-window=整窗（默认）；client=仅内容区；screen=整屏（无需 hwnd）'
        }
      }
    }
  },
  extractTarget: (args) => {
    const scope = (asString(args.scope) || 'full-window') as WindowCaptureScope
    if (scope === 'screen') return '截整屏'
    const h = asInt64(args.hwnd)
    return h ? `截窗口 ${hwndHex(h)}（${scope}）` : `截前台窗口（${scope}）`
  },
  executor: async (args) => {
    const scope = ((asString(args.scope) || 'full-window') as WindowCaptureScope)
    if (!windowCaptureScopes.includes(scope)) {
      return { ok: false, content: `window_capture scope 非法：${scope}（可选：${windowCaptureScopes.join(' / ')}）` }
    }
    const params: Record<string, unknown> = { scope }
    if (scope !== 'screen') {
      const h = asInt64(args.hwnd)
      if (!h) {
        return {
          ok: false,
          content: `window_capture scope=${scope} 必须带 hwnd（先 list_windows 拿 hwnd），或改 scope='screen' 截整屏。`
        }
      }
      params.hwnd = h
    }
    const outputPath = join(screenshotDir(), `cap-${Date.now()}.png`)
    params.outputPath = outputPath
    try {
      const r = await uiaCall<CaptureResult>('capture', params, 8000)
      const buf = readFileSync(r.path)
      const base64 = buf.toString('base64')
      const sizeKB = Math.round(r.sizeBytes / 1024)
      const fallbackTag = r.fallbackUsed ? '（PrintWindow 失败，BitBlt 屏幕兜底）' : ''
      return {
        ok: true,
        content: `已截屏 scope=${r.scope} ${r.width}×${r.height} (${sizeKB}KB)${fallbackTag}`,
        parts: [
          {
            type: 'image',
            mediaType: 'image/png',
            base64,
            localPath: r.path
          }
        ]
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `window_capture 失败：${msg}` }
    }
  }
}

function startScreenshotCleanup(): void {
  const tick = (): void => {
    try {
      const dir = screenshotDir()
      const now = Date.now()
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('cap-') || !name.endsWith('.png')) continue
        const fp = join(dir, name)
        try {
          const st = statSync(fp)
          if (now - st.mtimeMs > SCREENSHOT_TTL_MS) unlinkSync(fp)
        } catch {
          // 单文件失败忽略，下一轮 tick 再扫
        }
      }
    } catch {
      // 整轮失败（目录被外部删等）忽略，下一轮再试
    }
  }
  // 起一次延迟 tick——避免 main 启动期 IO 拥堵；之后每 5min 一次
  const handle = setInterval(tick, SCREENSHOT_CLEAN_INTERVAL_MS)
  if (typeof handle.unref === 'function') handle.unref()
}

const focusWindowFragment = [
  'focus_window({hwnd: number})',
  '   把指定 hwnd 的窗口拉到前台并恢复显示（最小化的窗口会自动 SW_RESTORE 弹出来）。',
  '',
  '   👀 用户说这些话时——这是首选工具，别犹豫：',
  '     "窗口被最小化了 / 缩到任务栏了" / "拉到前台" / "切过去" / "切到 XX"',
  '     "点不到" / "看不见 XX 应用" / "XX 在哪" / "XX 没显示出来"',
  '     "帮我打开已经在跑的 XX" / "切回 XX"',
  '',
  '   🚫 千万别犯这个错：',
  '     看到窗口最小化就回一句"Windows 不让我强制拉到前台"然后放弃——这种说法等于摆烂。',
  '     正确链路：list_windows → 找到 isMinimized:true 的目标 → focus_window 试一次',
  '     daemon 内部已经先 SW_RESTORE 再 SetForegroundWindow，最小化场景成功率 >90%，先试再说。',
  '',
  '   💥 真的失败了（焦点窃取保护拦截 / SetForegroundWindow 返回 false）的兜底链：',
  '     1) ui_act { action:"click", hwnd:任务栏图标的 hwnd } 模拟点任务栏图标——任务栏窗口名是 "Shell_TrayWnd" 或 "Taskbar"，',
  '        不过更实用的是直接让用户点一下那个任务栏图标，然后你 window_capture',
  '     2) 如果只是想"看一眼"内容（不需要操作），直接 window_capture {hwnd, scope:"full-window"}——',
  '        PrintWindow 不要求窗口在前台，最小化的也能截（虽然 Chromium 类窗口最小化时缓存可能空）',
  '     3) 实在不行才回退到"麻烦你点一下"——但要明确告诉用户「我已经试过 focus_window 了被系统拦了」，别假装没能力'
].join('\n')

const focusWindowDescriptor: ToolDescriptor = {
  id: 'builtin:focus_window',
  name: 'focus_window',
  source: 'builtin',
  displayName: 'focus_window',
  description: '把某个 hwnd 指向的窗口拉到前台（最小化的会自动恢复）。',
  promptFragment: { appLayer: focusWindowFragment, native: focusWindowFragment },
  nativeDef: {
    name: 'focus_window',
    description:
      '把指定 hwnd 的窗口切到前台并恢复显示。常作为 list_windows → ui_snapshot 之间的过渡步骤。可能因 Windows 焦点窃取保护失败。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '目标窗口句柄（list_windows 返回里的 hwnd 字段）' }
      },
      required: ['hwnd']
    }
  },
  extractTarget: (args) => {
    const h = asInt64(args.hwnd)
    return h ? `切到窗口 ${hwndHex(h)}` : '切窗口'
  },
  executor: async (args) => {
    const h = asInt64(args.hwnd)
    if (!h) return { ok: false, content: 'focus_window 缺 hwnd 参数' }
    try {
      const r = await uiaCall<string>('focus_window', { hwnd: h }, 3000)
      return { ok: true, content: `已切到窗口 ${hwndHex(h)}（${r}）` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `focus_window 失败：${msg}` }
    }
  }
}

export function bootstrapUiaTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[uiaTools] resources/bin/uia-daemon.ps1 不存在 → D 组工具全部不注册')
    return
  }
  registerTool(listWindowsDescriptor)
  registerTool(uiSnapshotDescriptor)
  registerTool(uiInspectDescriptor)
  registerTool(uiActDescriptor)
  registerTool(focusWindowDescriptor)
  registerTool(windowCaptureDescriptor)
  // 后台清 5 分钟前的截图缓存——只在 daemon 可用时启，避免没用上工具的人也被起 timer
  startScreenshotCleanup()
}
