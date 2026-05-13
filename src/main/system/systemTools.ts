// CPU 利用率：采样两次 os.cpus() tick 差值（idle/(idle+user+nice+sys+irq)）——
// 与 Linux top / Windows 任务管理器同款算法；Windows 的 load average 恒 0 不用

import os from 'node:os'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'

const execFileAsync = promisify(execFile)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

const getSystemInfoFragment = [
  'get_system_info()',
  '   返回用户电脑的静态/半静态信息：操作系统版本、CPU 型号 + 核数、总内存、',
  '   主机名、当前用户名、系统已运行时长。无参数。',
  '   适合开局了解一下机器规格——「我电脑啥配置」「我用的什么系统」之类。'
].join('\n')

const getSystemInfoDescriptor: ToolDescriptor = {
  id: 'builtin:get_system_info',
  name: 'get_system_info',
  source: 'builtin',
  displayName: 'get_system_info',
  description: '获取用户电脑的基本信息（OS / CPU / 内存 / 主机名 / 已开机时长）。',
  promptFragment: { appLayer: getSystemInfoFragment, native: getSystemInfoFragment },
  nativeDef: {
    name: 'get_system_info',
    description: '获取系统硬件 / OS 信息：操作系统版本、CPU 型号 + 核数、总内存、主机名、用户名、运行时长。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '系统基本信息',
  executor: async () => {
    try {
      const cpus = os.cpus()
      const cpuModel = cpus[0]?.model?.trim() ?? '未知'
      const cores = cpus.length
      const totalMem = os.totalmem()
      const hostname = os.hostname()
      const userInfo = os.userInfo()
      const uptime = os.uptime()
      const platform = os.platform()
      const release = os.release()
      const arch = os.arch()

      const platformLabel =
        platform === 'win32' ? `Windows (NT ${release})` :
        platform === 'darwin' ? `macOS (Darwin ${release})` :
        platform === 'linux' ? `Linux (${release})` :
        `${platform} ${release}`

      const lines = [
        `操作系统: ${platformLabel}  ${arch}`,
        `主机名: ${hostname}`,
        `当前用户: ${userInfo.username}`,
        `家目录: ${userInfo.homedir}`,
        `CPU: ${cpuModel}  共 ${cores} 个逻辑核`,
        `总内存: ${formatBytes(totalMem)}`,
        `已开机: ${formatUptime(uptime)}`
      ]
      return { ok: true, content: lines.join('\n') }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `获取系统信息失败：${msg}` }
    }
  }
}

const getResourceUsageFragment = [
  'get_resource_usage()',
  '   返回当前实时资源占用：CPU 利用率 (%)、内存占用 + 剩余、各盘符剩余空间。',
  '   CPU 利用率会采样 200ms 计算差值——所以本工具调用比一般工具略慢，~250ms。',
  '   适合「电脑卡不卡」「内存还够不够」「C 盘还剩多少」这类场景。'
].join('\n')

const getResourceUsageDescriptor: ToolDescriptor = {
  id: 'builtin:get_resource_usage',
  name: 'get_resource_usage',
  source: 'builtin',
  displayName: 'get_resource_usage',
  description: '当前实时资源占用：CPU 利用率、内存占用、各盘剩余空间。',
  promptFragment: { appLayer: getResourceUsageFragment, native: getResourceUsageFragment },
  nativeDef: {
    name: 'get_resource_usage',
    description:
      '获取实时资源占用：CPU 利用率（采样 200ms 算差值）、内存使用 / 剩余、各盘剩余空间。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '当前 CPU / 内存 / 磁盘占用',
  executor: async () => {
    try {
      const cpuPct = await measureCpuPercent(200)
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const memPct = (usedMem / totalMem) * 100

      const lines: string[] = []
      lines.push(`CPU 利用率: ${cpuPct.toFixed(1)} %`)
      lines.push(`内存: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct.toFixed(1)} %)`)
      lines.push('')
      lines.push('磁盘剩余:')

      // 枚举 A:~Z: 盘符
      const drives = await listDriveSpace()
      if (drives.length === 0) {
        lines.push('  （未能枚举到任何盘符）')
      } else {
        for (const d of drives) {
          const usedPct = ((d.total - d.free) / d.total) * 100
          lines.push(`  ${d.drive}  剩 ${formatBytes(d.free)} / 共 ${formatBytes(d.total)}  (用了 ${usedPct.toFixed(1)} %)`)
        }
      }
      return { ok: true, content: lines.join('\n') }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `获取资源占用失败：${msg}` }
    }
  }
}

async function measureCpuPercent(intervalMs: number): Promise<number> {
  const a = sampleCpuTotals()
  await new Promise((r) => setTimeout(r, intervalMs))
  const b = sampleCpuTotals()
  const totalDiff = b.total - a.total
  const idleDiff = b.idle - a.idle
  if (totalDiff <= 0) return 0
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100))
}

function sampleCpuTotals(): { total: number; idle: number } {
  let total = 0
  let idle = 0
  for (const c of os.cpus()) {
    const t = c.times
    total += t.user + t.nice + t.sys + t.idle + t.irq
    idle += t.idle
  }
  return { total, idle }
}

// statfs 在不存在的盘符上抛 ENOENT，正好用来过滤
async function listDriveSpace(): Promise<{ drive: string; free: number; total: number }[]> {
  const out: { drive: string; free: number; total: number }[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      const stat = await fsp.statfs(drive)
      const blockSize = stat.bsize
      out.push({
        drive,
        free: stat.bfree * blockSize,
        total: stat.blocks * blockSize
      })
    } catch {
      // 盘符不存在或不可访问——跳过
    }
  }
  return out
}

const getNetworkFragment = [
  'get_network()',
  '   返回所有网卡的 IPv4 / IPv6 地址、MAC、是否启用。',
  '   适合「我的本机 IP 是多少」「连了几张网卡」之类。',
  '   注意：返回的是**本机 IP**（局域网内的），不是公网出口 IP——后者要联网查。'
].join('\n')

const getNetworkDescriptor: ToolDescriptor = {
  id: 'builtin:get_network',
  name: 'get_network',
  source: 'builtin',
  displayName: 'get_network',
  description: '获取本机所有网卡的 IPv4 / IPv6 / MAC 信息。仅本地，不查公网 IP。',
  promptFragment: { appLayer: getNetworkFragment, native: getNetworkFragment },
  nativeDef: {
    name: 'get_network',
    description: '列出本机所有网络接口的 IP 地址、MAC、是否 internal（环回）。仅本地数据，不联网。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '本机网卡 IP / MAC',
  executor: async () => {
    try {
      const interfaces = os.networkInterfaces()
      const lines: string[] = []
      const names = Object.keys(interfaces)
      if (names.length === 0) {
        return { ok: true, content: '没有找到任何网络接口。' }
      }
      // 实际接口排在环回前面
      const realFirst = [...names].sort((a, b) => {
        const ai = (interfaces[a] ?? []).every((x) => x.internal) ? 1 : 0
        const bi = (interfaces[b] ?? []).every((x) => x.internal) ? 1 : 0
        return ai - bi
      })
      for (const name of realFirst) {
        const addrs = interfaces[name] ?? []
        if (addrs.length === 0) continue
        const isInternal = addrs.every((a) => a.internal)
        lines.push(`[${name}]${isInternal ? '  (环回 / 内部)' : ''}`)
        // MAC 取第一项（同一张卡的所有 family 共享同一 MAC）
        const mac = addrs[0]?.mac
        if (mac && mac !== '00:00:00:00:00:00') lines.push(`  MAC: ${mac}`)
        for (const a of addrs) {
          lines.push(`  ${a.family}: ${a.address}${a.cidr ? `  (${a.cidr})` : ''}`)
        }
        lines.push('')
      }
      return { ok: true, content: lines.join('\n').trimEnd() }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `获取网络信息失败：${msg}` }
    }
  }
}

export function bootstrapSystemTools(): void {
  registerTool(getSystemInfoDescriptor)
  registerTool(getResourceUsageDescriptor)
  registerTool(getNetworkDescriptor)
}
