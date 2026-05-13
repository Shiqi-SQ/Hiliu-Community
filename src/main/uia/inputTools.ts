// screen_type 走 SendInput KEYEVENTF_UNICODE 绕过 IME——用户开着中文输入法也能直接输出 Unicode。
// daemon 每字符间 sleep 8ms——Chromium / Electron 类应用偶尔丢前几个字符，需要这点喘息空间。

import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from '../system/binPath'
import { uiaCall } from './uiaService'

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function isInt(v: unknown): boolean {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n)
}

const RPC_TIMEOUT = 8000

const screenClickFragment = [
  'screen_click(x?: number, y?: number, button?: "left"|"right"|"middle", clicks?: 1|2|3)',
  '   在屏幕物理坐标 (x, y) 点鼠标。x/y 都不传 = 原位点击当前光标位置。',
  '   button 默认 left；clicks 默认 1，双击传 2。',
  '   场景：UIA ui_act 抓不到的控件（DirectUI / 自绘 / Chromium 渲染区域），',
  '   先 window_capture + screen_ocr 拿到目标文字坐标再点过去。',
  '   坐标系是「全屏物理像素」——多显示器要先用 list_windows 的 bounds 字段定位再换算。'
].join('\n')

const screenClickDescriptor: ToolDescriptor = {
  id: 'builtin:screen_click',
  name: 'screen_click',
  source: 'builtin',
  displayName: 'screen_click',
  description: '在指定屏幕坐标按下鼠标。x/y 缺省 = 原位点击。',
  promptFragment: { appLayer: screenClickFragment, native: screenClickFragment },
  nativeDef: {
    name: 'screen_click',
    description:
      '在屏幕物理坐标 (x,y) 点鼠标。x/y 缺省时原位点击。button: left/right/middle。clicks: 1-3（双击传 2）。坐标系是全屏物理像素。',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标（缺省=原位）' },
        y: { type: 'number', description: '屏幕 Y 坐标（缺省=原位）' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        clicks: { type: 'number', description: '点击次数 1-3，默认 1（双击=2）' }
      }
    }
  },
  extractTarget: (args) => {
    const x = isInt(args.x) ? asInt(args.x, -1) : null
    const y = isInt(args.y) ? asInt(args.y, -1) : null
    const btn = asString(args.button) || 'left'
    const clicks = asInt(args.clicks, 1)
    return x !== null && y !== null
      ? `点击 (${x},${y}) ${btn}${clicks > 1 ? '×' + clicks : ''}`
      : `原位点击 ${btn}${clicks > 1 ? '×' + clicks : ''}`
  },
  executor: async (args) => {
    const params: Record<string, unknown> = {}
    if (isInt(args.x)) params.x = asInt(args.x, 0)
    if (isInt(args.y)) params.y = asInt(args.y, 0)
    if (args.button) params.button = asString(args.button)
    if (isInt(args.clicks)) params.clicks = asInt(args.clicks, 1)
    try {
      const r = (await uiaCall('screen_click', params, RPC_TIMEOUT)) as Record<string, unknown>
      return {
        ok: true,
        content: `已点击 (${r.x},${r.y}) button=${r.button} clicks=${r.clicks}`
      }
    } catch (e) {
      return { ok: false, content: `（系统）screen_click 失败：${(e as Error).message}` }
    }
  }
}

const screenMoveFragment = [
  'screen_move(x: number, y: number)',
  '   把鼠标光标移到屏幕 (x, y)。不点击。',
  '   场景：让某些 hover-only 控件先吃 mouseenter（比如 tooltip / 二级菜单触发）。'
].join('\n')

const screenMoveDescriptor: ToolDescriptor = {
  id: 'builtin:screen_move',
  name: 'screen_move',
  source: 'builtin',
  displayName: 'screen_move',
  description: '把鼠标光标移到指定屏幕坐标（不点击）。',
  promptFragment: { appLayer: screenMoveFragment, native: screenMoveFragment },
  nativeDef: {
    name: 'screen_move',
    description: '把鼠标光标移到屏幕物理坐标 (x,y)。不触发点击。',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' }
      },
      required: ['x', 'y']
    }
  },
  extractTarget: (args) => `移动光标到 (${asInt(args.x, 0)},${asInt(args.y, 0)})`,
  executor: async (args) => {
    if (!isInt(args.x) || !isInt(args.y)) {
      return { ok: false, content: '（系统）screen_move 缺 x / y 参数。' }
    }
    try {
      const r = (await uiaCall(
        'screen_move',
        { x: asInt(args.x, 0), y: asInt(args.y, 0) },
        RPC_TIMEOUT
      )) as Record<string, unknown>
      return { ok: true, content: `已移动光标到 (${r.x},${r.y})` }
    } catch (e) {
      return { ok: false, content: `（系统）screen_move 失败：${(e as Error).message}` }
    }
  }
}

const screenScrollFragment = [
  'screen_scroll(delta: number, x?: number, y?: number)',
  '   滚动鼠标滚轮。delta 正数向上滚，负数向下；120 = 1 notch（一格）。',
  '   x/y 给了就先把光标移过去再滚（让滚动作用在那个区域）；不给就原位滚。',
  '   场景：网页/列表翻页、长 chat 上滑找历史。'
].join('\n')

const screenScrollDescriptor: ToolDescriptor = {
  id: 'builtin:screen_scroll',
  name: 'screen_scroll',
  source: 'builtin',
  displayName: 'screen_scroll',
  description: '滚动鼠标滚轮（120=1 notch，正向上）。可选先移光标到 (x,y) 再滚。',
  promptFragment: { appLayer: screenScrollFragment, native: screenScrollFragment },
  nativeDef: {
    name: 'screen_scroll',
    description: 'mouse_event WHEEL：delta 120=1 notch，正向上、负向下。x/y 给了就先移光标。',
    input_schema: {
      type: 'object',
      properties: {
        delta: { type: 'number', description: '滚动量，120=1格，正上负下' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['delta']
    }
  },
  extractTarget: (args) => {
    const d = asInt(args.delta, 0)
    const where = isInt(args.x) && isInt(args.y) ? ` @(${asInt(args.x, 0)},${asInt(args.y, 0)})` : ''
    return `滚轮 ${d > 0 ? '↑' : '↓'} ${Math.abs(d)}${where}`
  },
  executor: async (args) => {
    if (!isInt(args.delta)) return { ok: false, content: '（系统）screen_scroll 缺 delta 参数。' }
    const params: Record<string, unknown> = { delta: asInt(args.delta, 0) }
    if (isInt(args.x)) params.x = asInt(args.x, 0)
    if (isInt(args.y)) params.y = asInt(args.y, 0)
    try {
      const r = (await uiaCall('screen_scroll', params, RPC_TIMEOUT)) as Record<string, unknown>
      return { ok: true, content: `已滚动 delta=${r.delta}` }
    } catch (e) {
      return { ok: false, content: `（系统）screen_scroll 失败：${(e as Error).message}` }
    }
  }
}

const screenDragFragment = [
  'screen_drag(fromX, fromY, toX, toY, button?)',
  '   按下鼠标从 (fromX,fromY) 拖到 (toX,toY) 再松开。button 默认 left。',
  '   会分 10 段平滑插值——一步跳目标 OS 经常不识别为 drag。',
  '   场景：拖动文件、调整窗口大小、画图涂鸦、地图平移。'
].join('\n')

const screenDragDescriptor: ToolDescriptor = {
  id: 'builtin:screen_drag',
  name: 'screen_drag',
  source: 'builtin',
  displayName: 'screen_drag',
  description: '从 (fromX,fromY) 拖到 (toX,toY)，分 10 段平滑插值。',
  promptFragment: { appLayer: screenDragFragment, native: screenDragFragment },
  nativeDef: {
    name: 'screen_drag',
    description: '鼠标按下从起点拖到终点。10 段平滑插值，OS 才会识别为 drag。',
    input_schema: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right'], description: '默认 left' }
      },
      required: ['fromX', 'fromY', 'toX', 'toY']
    }
  },
  extractTarget: (args) =>
    `拖拽 (${asInt(args.fromX, 0)},${asInt(args.fromY, 0)}) → (${asInt(args.toX, 0)},${asInt(args.toY, 0)})`,
  executor: async (args) => {
    if (!isInt(args.fromX) || !isInt(args.fromY) || !isInt(args.toX) || !isInt(args.toY)) {
      return { ok: false, content: '（系统）screen_drag 缺 fromX/fromY/toX/toY 参数。' }
    }
    const params: Record<string, unknown> = {
      fromX: asInt(args.fromX, 0),
      fromY: asInt(args.fromY, 0),
      toX: asInt(args.toX, 0),
      toY: asInt(args.toY, 0)
    }
    if (args.button) params.button = asString(args.button)
    try {
      const r = (await uiaCall('screen_drag', params, RPC_TIMEOUT)) as Record<string, unknown>
      const from = r.from as { x: number; y: number }
      const to = r.to as { x: number; y: number }
      return {
        ok: true,
        content: `已拖拽 (${from.x},${from.y}) → (${to.x},${to.y}) button=${r.button}`
      }
    } catch (e) {
      return { ok: false, content: `（系统）screen_drag 失败：${(e as Error).message}` }
    }
  }
}

const globalHotkeyFragment = [
  'global_hotkey(keys: string)',
  '   按一组键盘组合键（全局生效，不需要 focus 任何窗口）。',
  '   keys 用 + 连接，大小写不敏感。常用例子：',
  '     "ctrl+c" / "ctrl+v" / "ctrl+x"   复制 / 粘贴 / 剪切',
  '     "ctrl+s"                          保存',
  '     "ctrl+z" / "ctrl+y"               撤销 / 重做',
  '     "alt+tab" / "alt+f4"              切窗口 / 关窗口',
  '     "win+d"                           显示桌面',
  '     "win+e" / "win+r"                 资源管理器 / 运行框',
  '     "win+l"                           锁屏（小心！这个就锁屏了）',
  '     "ctrl+shift+t"                    重开标签',
  '     "f5" / "f11"                      刷新 / 全屏',
  '   支持的键名：',
  '     修饰：ctrl/control, shift, alt, win/cmd/super',
  '     功能：tab, esc/escape, enter/return, space, backspace, delete, insert',
  '           home, end, pageup/pgup, pagedown/pgdn, up/down/left/right',
  '           f1..f12, capslock, numlock, printscreen/prtsc',
  '     字符：单字母 a-z、单数字 0-9、常用标点 , . / ; \' [ ] \\ - = `'
].join('\n')

const globalHotkeyDescriptor: ToolDescriptor = {
  id: 'builtin:global_hotkey',
  name: 'global_hotkey',
  source: 'builtin',
  displayName: 'global_hotkey',
  description: '按一组组合键（如 ctrl+c / win+d / alt+f4），全局生效。',
  promptFragment: { appLayer: globalHotkeyFragment, native: globalHotkeyFragment },
  nativeDef: {
    name: 'global_hotkey',
    description:
      '发送一组键盘组合键，全局生效（作用于当前焦点窗口）。keys 用 + 连接，例如 "ctrl+c" / "win+d" / "alt+tab" / "ctrl+shift+t"。',
    input_schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description: '键名用 + 连接，如 "ctrl+c" / "alt+f4" / "win+d"'
        }
      },
      required: ['keys']
    }
  },
  extractTarget: (args) => `按键：${asString(args.keys)}`,
  executor: async (args) => {
    const keys = asString(args.keys).trim()
    if (!keys) return { ok: false, content: '（系统）global_hotkey 缺 keys 参数。' }
    try {
      await uiaCall('global_hotkey', { keys }, RPC_TIMEOUT)
      return { ok: true, content: `已按下组合键：${keys}` }
    } catch (e) {
      return { ok: false, content: `（系统）global_hotkey 失败：${(e as Error).message}` }
    }
  }
}

const screenTypeFragment = [
  'screen_type(text: string)',
  '   把 text 字符串当作键盘输入打进当前焦点字段。中英文都支持（Unicode 直接注入）。',
  '   调用前要确保焦点已经在目标输入框上——通常的链路是：window_capture 看到搜索框 →',
  '   screen_click 点搜索框激活焦点 → screen_type 输入文字 → global_hotkey({keys:"enter"}) 提交。',
  '   不会自己按 Enter。一次最多 1000 字符。'
].join('\n')

function previewTypedText(s: string): string {
  // 给 permission 闸门看的预览：超过 20 字截断，单行换行/制表替成 ⏎/→ 避免破环界面
  const collapsed = s.replace(/\r?\n/g, '⏎').replace(/\t/g, '→')
  return collapsed.length <= 20 ? collapsed : collapsed.slice(0, 20) + '…'
}

const screenTypeDescriptor: ToolDescriptor = {
  id: 'builtin:screen_type',
  name: 'screen_type',
  source: 'builtin',
  displayName: 'screen_type',
  description: '在当前焦点字段输入 Unicode 文本（中英都行，绕过 IME）。',
  promptFragment: { appLayer: screenTypeFragment, native: screenTypeFragment },
  nativeDef: {
    name: 'screen_type',
    description:
      '在当前焦点字段输入文本（SendInput KEYEVENTF_UNICODE，绕过 IME，中英都行）。调用前请用 screen_click 点击目标输入框拿到焦点。不会自动按回车——提交用 global_hotkey({keys:"enter"})。一次最多 1000 字符。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本，1-1000 字符' }
      },
      required: ['text']
    }
  },
  extractTarget: (args) => `输入文本："${previewTypedText(asString(args.text))}"`,
  executor: async (args) => {
    const text = asString(args.text)
    if (!text) return { ok: false, content: '（系统）screen_type 缺 text 参数。' }
    if (text.length > 1000) {
      return {
        ok: false,
        content: `（系统）screen_type text 过长（${text.length} > 1000）。一次性输入这么多通常意味着用错了工具——把文本拆开或者考虑用剪贴板（write_clipboard + ctrl+v）。`
      }
    }
    try {
      const r = (await uiaCall('screen_type', { text }, RPC_TIMEOUT)) as Record<string, unknown>
      const typed = asInt(r.chars_typed, 0)
      const total = asInt(r.total, text.length)
      if (typed < total) {
        return {
          ok: false,
          content: `（系统）screen_type 部分失败：只输入了 ${typed}/${total} 字符。可能焦点丢失或输入框拒绝某些字符。建议先用 window_capture 看一眼现状再决定下一步。`
        }
      }
      return { ok: true, content: `已输入 ${typed} 字符。注意：未自动提交，要回车请下一步调 global_hotkey({keys:"enter"})。` }
    } catch (e) {
      return { ok: false, content: `（系统）screen_type 失败：${(e as Error).message}` }
    }
  }
}

const MEDIA_ACTION_TO_KEY: Record<string, string> = {
  play: 'playpause',
  pause: 'playpause',
  playpause: 'playpause',
  next: 'next',
  prev: 'prev',
  previous: 'prev',
  stop: 'stop',
  volup: 'volumeup',
  volumeup: 'volumeup',
  voldown: 'volumedown',
  volumedown: 'volumedown',
  mute: 'mute',
  volumemute: 'mute'
}

const mediaControlFragment = [
  'media_control(action: string)',
  '   控制系统媒体快捷键——任何识别 VK_MEDIA_* 的播放器都会响应（音乐/视频/浏览器视频）。',
  '   action 取值：',
  '     "play" / "pause" / "playpause"  播放或暂停（这是同一个键）',
  '     "next" / "prev"                  下一首 / 上一首',
  '     "stop"                            停止',
  '     "volup" / "voldown" / "mute"     系统音量上 / 下 / 静音',
  '   场景：用户说「下一首」「调小声」「暂停一下」之类的语义命令。'
].join('\n')

const mediaControlDescriptor: ToolDescriptor = {
  id: 'builtin:media_control',
  name: 'media_control',
  source: 'builtin',
  displayName: 'media_control',
  description: '系统媒体键：play/pause/next/prev/stop/volup/voldown/mute。',
  promptFragment: { appLayer: mediaControlFragment, native: mediaControlFragment },
  nativeDef: {
    name: 'media_control',
    description:
      '发送媒体快捷键。action: play/pause/playpause/next/prev/stop/volup/voldown/mute。任何识别 VK_MEDIA_* 的播放器都会响应。',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'play/pause/playpause/next/prev/stop/volup/voldown/mute'
        }
      },
      required: ['action']
    }
  },
  extractTarget: (args) => `媒体键：${asString(args.action)}`,
  executor: async (args) => {
    const a = asString(args.action).trim().toLowerCase()
    if (!a) return { ok: false, content: '（系统）media_control 缺 action 参数。' }
    const key = MEDIA_ACTION_TO_KEY[a]
    if (!key) {
      return {
        ok: false,
        content: `（系统）未知 action：${a}。可选：${Object.keys(MEDIA_ACTION_TO_KEY).join(' / ')}`
      }
    }
    try {
      await uiaCall('global_hotkey', { keys: key }, RPC_TIMEOUT)
      return { ok: true, content: `已发送媒体键：${a}（VK=${key}）` }
    } catch (e) {
      return { ok: false, content: `（系统）media_control 失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapInputTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[inputTools] uia-daemon.ps1 不存在 → 键鼠/热键工具全部不注册')
    return
  }
  registerTool(screenClickDescriptor)
  registerTool(screenMoveDescriptor)
  registerTool(screenScrollDescriptor)
  registerTool(screenDragDescriptor)
  registerTool(globalHotkeyDescriptor)
  registerTool(screenTypeDescriptor)
  registerTool(mediaControlDescriptor)
}
