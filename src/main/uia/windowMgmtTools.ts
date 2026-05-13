// SetWindowPos 用 SWP_NOACTIVATE——移动 / 调整大小不抢焦点
// window_close 发 WM_CLOSE 不是 TerminateProcess——让应用走自己的退出流程（可保存数据）

import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from '../system/binPath'
import { uiaCall } from './uiaService'

const RPC_TIMEOUT = 8000

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function isInt(v: unknown): boolean {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n)
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function parseHwnd(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    const n = s.startsWith('0x') ? parseInt(s.slice(2), 16) : Number(s)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  return null
}

const windowMoveFragment = [
  'window_move(hwnd: number, x: number, y: number)',
  '   把窗口左上角移到屏幕坐标 (x,y)。不改变窗口大小、不抢焦点。',
  '   hwnd 用 list_windows 的返回值（数字或 "0x..." 都接）。',
  '   场景：把某个窗口挪到主屏 / 摆到角落 / 用户说「把它放屏幕右边」。'
].join('\n')

const windowMoveDescriptor: ToolDescriptor = {
  id: 'builtin:window_move',
  name: 'window_move',
  source: 'builtin',
  displayName: 'window_move',
  description: '把窗口移到屏幕坐标 (x,y)。不改大小、不抢焦点。',
  promptFragment: { appLayer: windowMoveFragment, native: windowMoveFragment },
  nativeDef: {
    name: 'window_move',
    description: 'SetWindowPos 把窗口左上角移到屏幕 (x,y)。SWP_NOSIZE+NOACTIVATE，不改大小不抢焦点。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄（list_windows 返回的）' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['hwnd', 'x', 'y']
    }
  },
  extractTarget: (args) => {
    const h = parseHwnd(args.hwnd)
    return `移动窗口 0x${(h ?? 0).toString(16)} → (${asInt(args.x, 0)},${asInt(args.y, 0)})`
  },
  executor: async (args) => {
    const hwnd = parseHwnd(args.hwnd)
    if (hwnd === null || hwnd <= 0) return { ok: false, content: '（系统）window_move 缺 hwnd 或非法。' }
    if (!isInt(args.x) || !isInt(args.y)) return { ok: false, content: '（系统）window_move 缺 x/y。' }
    try {
      await uiaCall('window_move', { hwnd, x: asInt(args.x, 0), y: asInt(args.y, 0) }, RPC_TIMEOUT)
      return { ok: true, content: `已移动窗口 0x${hwnd.toString(16)} 到 (${asInt(args.x, 0)},${asInt(args.y, 0)})` }
    } catch (e) {
      return { ok: false, content: `（系统）window_move 失败：${(e as Error).message}` }
    }
  }
}

const windowResizeFragment = [
  'window_resize(hwnd: number, width: number, height: number)',
  '   调整窗口尺寸。不移动位置、不抢焦点。',
  '   注意：有些应用窗口有最小尺寸限制（如 Edge ≥ 500×400），传太小被忽略。',
  '   场景：窗口太小看不清——放大；用户要「半屏并排」自己算尺寸。'
].join('\n')

const windowResizeDescriptor: ToolDescriptor = {
  id: 'builtin:window_resize',
  name: 'window_resize',
  source: 'builtin',
  displayName: 'window_resize',
  description: '调整窗口尺寸（不移动位置）。',
  promptFragment: { appLayer: windowResizeFragment, native: windowResizeFragment },
  nativeDef: {
    name: 'window_resize',
    description: 'SetWindowPos 调整窗口宽高。SWP_NOMOVE+NOACTIVATE，不移动不抢焦点。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'number' },
        width: { type: 'number', description: '新宽度（像素）' },
        height: { type: 'number', description: '新高度（像素）' }
      },
      required: ['hwnd', 'width', 'height']
    }
  },
  extractTarget: (args) => {
    const h = parseHwnd(args.hwnd)
    return `调整窗口 0x${(h ?? 0).toString(16)} → ${asInt(args.width, 0)}×${asInt(args.height, 0)}`
  },
  executor: async (args) => {
    const hwnd = parseHwnd(args.hwnd)
    if (hwnd === null || hwnd <= 0) return { ok: false, content: '（系统）window_resize 缺 hwnd。' }
    if (!isInt(args.width) || !isInt(args.height))
      return { ok: false, content: '（系统）window_resize 缺 width/height。' }
    try {
      await uiaCall(
        'window_resize',
        { hwnd, width: asInt(args.width, 0), height: asInt(args.height, 0) },
        RPC_TIMEOUT
      )
      return {
        ok: true,
        content: `已调整窗口 0x${hwnd.toString(16)} → ${asInt(args.width, 0)}×${asInt(args.height, 0)}`
      }
    } catch (e) {
      return { ok: false, content: `（系统）window_resize 失败：${(e as Error).message}` }
    }
  }
}

const WINDOW_STATE_ACTIONS = ['minimize', 'maximize', 'restore', 'hide', 'show'] as const

const windowStateFragment = [
  'window_state(hwnd: number, action: "minimize"|"maximize"|"restore"|"hide"|"show")',
  '   切换窗口显示状态。',
  '     - minimize：最小化到任务栏',
  '     - maximize：最大化（不是全屏，只是占满工作区）',
  '     - restore：从最小化/最大化还原到普通大小',
  '     - hide：隐藏（不在任务栏显示，跟最小化不同！谨慎，可能让用户找不到）',
  '     - show：显示（hide 之后用 show 恢复）',
  '   场景：「把微信最小化」「全屏 Edge」「窗口最大化看清」。'
].join('\n')

const windowStateDescriptor: ToolDescriptor = {
  id: 'builtin:window_state',
  name: 'window_state',
  source: 'builtin',
  displayName: 'window_state',
  description: 'minimize / maximize / restore / hide / show 窗口。',
  promptFragment: { appLayer: windowStateFragment, native: windowStateFragment },
  nativeDef: {
    name: 'window_state',
    description: 'ShowWindow 切换窗口显示状态。action 取值：minimize/maximize/restore/hide/show。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'number' },
        action: {
          type: 'string',
          enum: ['minimize', 'maximize', 'restore', 'hide', 'show']
        }
      },
      required: ['hwnd', 'action']
    }
  },
  extractTarget: (args) => {
    const h = parseHwnd(args.hwnd)
    return `窗口 0x${(h ?? 0).toString(16)} ${asString(args.action)}`
  },
  executor: async (args) => {
    const hwnd = parseHwnd(args.hwnd)
    if (hwnd === null || hwnd <= 0) return { ok: false, content: '（系统）window_state 缺 hwnd。' }
    const action = asString(args.action).trim().toLowerCase()
    if (!(WINDOW_STATE_ACTIONS as readonly string[]).includes(action)) {
      return {
        ok: false,
        content: `（系统）未知 action：${action}。可选：${WINDOW_STATE_ACTIONS.join(' / ')}`
      }
    }
    try {
      await uiaCall('window_state', { hwnd, action }, RPC_TIMEOUT)
      return { ok: true, content: `已 ${action} 窗口 0x${hwnd.toString(16)}` }
    } catch (e) {
      return { ok: false, content: `（系统）window_state 失败：${(e as Error).message}` }
    }
  }
}

const windowCloseFragment = [
  'window_close(hwnd: number)',
  '   优雅关闭窗口（发 WM_CLOSE 信号，应用走自己的退出流程）。',
  '   注意：',
  '     - 应用未保存内容时会弹「保存吗？」对话框——不是强杀',
  '     - 想强杀进程走 ps_exec："Stop-Process -Id <pid> -Force" 或 taskkill',
  '     - 最常见用途：关掉用户提到的某个具体窗口、清理一堆开着的弹窗'
].join('\n')

const windowCloseDescriptor: ToolDescriptor = {
  id: 'builtin:window_close',
  name: 'window_close',
  source: 'builtin',
  displayName: 'window_close',
  description: '关闭窗口（发 WM_CLOSE，让应用优雅退出）。',
  promptFragment: { appLayer: windowCloseFragment, native: windowCloseFragment },
  nativeDef: {
    name: 'window_close',
    description: 'PostMessage WM_CLOSE 关闭窗口。优雅退出（应用可能弹保存对话框），不是强杀进程。',
    input_schema: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄（list_windows 返回的）' }
      },
      required: ['hwnd']
    }
  },
  extractTarget: (args) => {
    const h = parseHwnd(args.hwnd)
    return `关闭窗口 0x${(h ?? 0).toString(16)}`
  },
  executor: async (args) => {
    const hwnd = parseHwnd(args.hwnd)
    if (hwnd === null || hwnd <= 0) return { ok: false, content: '（系统）window_close 缺 hwnd。' }
    try {
      await uiaCall('window_close', { hwnd }, RPC_TIMEOUT)
      return { ok: true, content: `已发关闭信号给窗口 0x${hwnd.toString(16)}` }
    } catch (e) {
      return { ok: false, content: `（系统）window_close 失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapWindowMgmtTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[windowMgmtTools] uia-daemon.ps1 不存在 → 窗口管理工具不注册')
    return
  }
  registerTool(windowMoveDescriptor)
  registerTool(windowResizeDescriptor)
  registerTool(windowStateDescriptor)
  registerTool(windowCloseDescriptor)
}
