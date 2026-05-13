// set_volume 走 Core Audio（绝对值）；media_control 用 VK_VOLUME_* 是相对值（一格 ~2%）
// get_wifi_status 解析 netsh wlan show interfaces——中英文系统均可；无网卡返回 connected=false 不抛错

import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from './binPath'
import { uiaCall } from '../uia/uiaService'

const RPC_TIMEOUT = 6000

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function isNum(v: unknown): boolean {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n)
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

const setVolumeFragment = [
  'set_volume(percent?: number, mute?: boolean)',
  '   控制系统主音量（默认输出设备）。两个参数二选一：',
  '     - percent: 0-100 整数（绝对值，超出会 clamp）',
  '     - mute: true / false（切静音）',
  '   都不传会报错。',
  '   场景：「调到 30%」「静音」「取消静音」。',
  '   想要相对调整（「再大点声」）用 media_control volup / voldown，那个一格 ~2%。'
].join('\n')

const setVolumeDescriptor: ToolDescriptor = {
  id: 'builtin:set_volume',
  name: 'set_volume',
  source: 'builtin',
  displayName: 'set_volume',
  description: '设置系统主音量（绝对 0-100% 或切静音）。',
  promptFragment: { appLayer: setVolumeFragment, native: setVolumeFragment },
  nativeDef: {
    name: 'set_volume',
    description:
      '通过 Core Audio IAudioEndpointVolume 控制默认输出设备主音量。percent 是绝对值 0-100；mute 切静音。两个参数二选一。',
    input_schema: {
      type: 'object',
      properties: {
        percent: { type: 'number', description: '绝对音量 0-100' },
        mute: { type: 'boolean', description: 'true=静音，false=取消静音' }
      }
    }
  },
  extractTarget: (args) => {
    if (typeof args.mute === 'boolean') return args.mute ? '设置静音' : '取消静音'
    if (isNum(args.percent)) return `设置音量 ${asInt(args.percent, 0)}%`
    return '设置音量（参数缺失）'
  },
  executor: async (args) => {
    const params: Record<string, unknown> = {}
    if (typeof args.mute === 'boolean') params.mute = args.mute
    else if (isNum(args.percent)) params.percent = asInt(args.percent, 0)
    else return { ok: false, content: '（系统）set_volume 需要 percent (0-100) 或 mute (bool)。' }
    try {
      const r = (await uiaCall('set_volume', params, RPC_TIMEOUT)) as Record<string, unknown>
      if (typeof r.mute === 'boolean') {
        return { ok: true, content: `已${r.mute ? '静音' : '取消静音'}` }
      }
      return { ok: true, content: `已设置音量为 ${r.percent}%` }
    } catch (e) {
      return { ok: false, content: `（系统）set_volume 失败：${(e as Error).message}` }
    }
  }
}

const getVolumeFragment = [
  'get_volume()',
  '   读当前系统主音量百分比 + 静音状态。无参数。',
  '   场景：用户问「现在多大声」「静音了吗」。'
].join('\n')

const getVolumeDescriptor: ToolDescriptor = {
  id: 'builtin:get_volume',
  name: 'get_volume',
  source: 'builtin',
  displayName: 'get_volume',
  description: '读当前系统主音量 + 静音状态。',
  promptFragment: { appLayer: getVolumeFragment, native: getVolumeFragment },
  nativeDef: {
    name: 'get_volume',
    description: '读当前默认输出设备的主音量百分比（0-100）+ 静音状态。无参数。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '查询当前音量',
  executor: async () => {
    try {
      const r = (await uiaCall('get_volume', {}, RPC_TIMEOUT)) as { percent: number; mute: boolean }
      return { ok: true, content: `当前音量 ${r.percent}%${r.mute ? '（静音）' : ''}` }
    } catch (e) {
      return { ok: false, content: `（系统）get_volume 失败：${(e as Error).message}` }
    }
  }
}

const getWifiStatusFragment = [
  'get_wifi_status()',
  '   读当前 WLAN 接口状态：是否连接、SSID（连的哪个 WiFi）、信号强度（0-100%）。',
  '   场景：用户问「现在连的什么 WiFi」「网络信号怎么样」「为啥网这么慢」。',
  '   注意：',
  '     - 解析 netsh wlan show interfaces 输出，中英文系统都吃',
  '     - 没装无线网卡 / WLAN 服务停的机器返回 connected=false 不抛错',
  '     - 不查有线网络——以太网信息得用其他方式（ipconfig / Get-NetAdapter）'
].join('\n')

const getWifiStatusDescriptor: ToolDescriptor = {
  id: 'builtin:get_wifi_status',
  name: 'get_wifi_status',
  source: 'builtin',
  displayName: 'get_wifi_status',
  description: '查 WLAN 连接状态、SSID、信号强度。',
  promptFragment: { appLayer: getWifiStatusFragment, native: getWifiStatusFragment },
  nativeDef: {
    name: 'get_wifi_status',
    description:
      '查当前 WLAN 接口状态：connected（是否连接）、state（状态文本）、ssid、signalPercent（0-100）。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '查询 WiFi 状态',
  executor: async () => {
    try {
      const r = (await uiaCall('get_wifi_status', {}, RPC_TIMEOUT)) as {
        connected: boolean
        state?: string
        ssid?: string
        signalPercent?: number | null
        reason?: string
      }
      if (!r.connected) {
        const reason = r.reason || asString(r.state) || '未连接'
        return { ok: true, content: `WiFi 未连接（${reason}）` }
      }
      const sig = typeof r.signalPercent === 'number' ? `，信号 ${r.signalPercent}%` : ''
      return {
        ok: true,
        content: `WiFi 已连接：${r.ssid || '未知 SSID'}${sig}`
      }
    } catch (e) {
      return { ok: false, content: `（系统）get_wifi_status 失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapAudioWifiTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[audioWifiTools] uia-daemon.ps1 不存在 → set_volume / get_volume / get_wifi_status 不注册')
    return
  }
  registerTool(setVolumeDescriptor)
  registerTool(getVolumeDescriptor)
  registerTool(getWifiStatusDescriptor)
}
