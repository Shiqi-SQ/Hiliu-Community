// 实现走 PowerShell + Add-Type 调 user32.dll——Windows 上不依赖第三方包拿这类信息的最干净路径
// 每次调用启 powershell.exe + Add-Type 编译 C#，首次 ~800ms-1.2s；后续走 PS 程序集缓存 ~300-500ms
// $pid 是 PowerShell 内置变量（当前 PS 进程 id），用 $procId 接 GetWindowThreadProcessId 的 out 参数避免覆盖
// Environment.TickCount 是 32 位有符号 ms，~24.85 天溢出回绕到负数，需做 uint32 转换

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'

const execFileAsync = promisify(execFile)

const PS_FLAGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-OutputFormat', 'Text'
]

async function runPs(script: string, timeoutMs = 8000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    [...PS_FLAGS, '-Command', script],
    { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }
  )
  if (stderr && stderr.trim()) {
    // PowerShell 偶尔把 warning 写 stderr，仅在 stdout 为空时才视为失败
    if (!stdout.trim()) throw new Error(`PowerShell stderr: ${stderr.trim()}`)
  }
  return stdout.trim()
}

function tryParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

// 注意：$pid 是 PS 内置变量，用 $procId 接 out 参数
const ACTIVE_WINDOW_PS = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class HiliuW {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$hwnd = [HiliuW]::GetForegroundWindow()
$len = [HiliuW]::GetWindowTextLength($hwnd)
$sb = New-Object System.Text.StringBuilder ($len + 2)
[void][HiliuW]::GetWindowText($hwnd, $sb, $sb.Capacity)
$procId = 0
[void][HiliuW]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$exe = ''
try { if ($proc -and $proc.MainModule) { $exe = $proc.MainModule.FileName } } catch {}
$obj = [ordered]@{
    title = $sb.ToString()
    pid = [int]$procId
    processName = if ($proc) { $proc.ProcessName } else { '' }
    exePath = $exe
    hwnd = [int64]$hwnd
}
$obj | ConvertTo-Json -Compress
`.trim()

interface ActiveWindowInfo {
  title: string
  pid: number
  processName: string
  exePath: string
  hwnd: number
}

const getActiveWindowFragment = [
  'get_active_window()',
  '   返回当前用户正在操作的最前台窗口：标题、进程名、PID、EXE 路径。',
  '   适合「我现在干嘛呢」「在用什么 App」之类——结合 get_idle_time 还能判断"在用还是挂着"。',
  '   注意：title 可能为空（系统级窗口、桌面背景），processName 也可能拿不到（受保护进程）。'
].join('\n')

const getActiveWindowDescriptor: ToolDescriptor = {
  id: 'builtin:get_active_window',
  name: 'get_active_window',
  source: 'builtin',
  displayName: 'get_active_window',
  description: '获取当前最前台窗口的标题、进程名、PID。基于 user32.dll GetForegroundWindow。',
  promptFragment: { appLayer: getActiveWindowFragment, native: getActiveWindowFragment },
  nativeDef: {
    name: 'get_active_window',
    description:
      '获取用户当前最前台窗口信息：窗口标题、所属进程名、PID、EXE 路径。基于 Win32 GetForegroundWindow。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '当前最前台窗口',
  executor: async () => {
    try {
      const out = await runPs(ACTIVE_WINDOW_PS)
      const info = tryParseJson<ActiveWindowInfo>(out)
      if (!info) {
        return { ok: false, content: `PowerShell 返回了无法解析的内容：${out.slice(0, 200)}` }
      }
      const lines: string[] = []
      lines.push(`窗口标题: ${info.title || '（无标题或拿不到）'}`)
      lines.push(`进程名: ${info.processName || '（拿不到）'}`)
      lines.push(`PID: ${info.pid}`)
      if (info.exePath) lines.push(`EXE 路径: ${info.exePath}`)
      lines.push(`窗口句柄: 0x${info.hwnd.toString(16).toUpperCase()}`)
      return { ok: true, content: lines.join('\n') }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `读取最前台窗口失败：${msg}` }
    }
  }
}

// Environment.TickCount 32 位有符号 ms，~24.85 天溢出回绕到负数，需 uint32 转换
const IDLE_TIME_PS = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HiliuI {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
}
"@
$lii = New-Object HiliuI+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[void][HiliuI]::GetLastInputInfo([ref]$lii)
$tick = [uint32]([Environment]::TickCount)
$last = [uint32]$lii.dwTime
$idleMs = if ($tick -ge $last) { $tick - $last } else { ([uint32]::MaxValue - $last) + $tick + 1 }
$obj = [ordered]@{ idleMs = [int64]$idleMs }
$obj | ConvertTo-Json -Compress
`.trim()

interface IdleTimeInfo {
  idleMs: number
}

const getIdleTimeFragment = [
  'get_idle_time()',
  '   返回用户键鼠最后一次活动距现在多少毫秒。基于 Win32 GetLastInputInfo。',
  '   适合「他还在不在电脑前」「挂机多久了」——例如 idleMs > 5*60*1000 大概率离开了。',
  '   注意：媒体播放、远程桌面等"活动"不算输入；纯键鼠才计数。'
].join('\n')

const getIdleTimeDescriptor: ToolDescriptor = {
  id: 'builtin:get_idle_time',
  name: 'get_idle_time',
  source: 'builtin',
  displayName: 'get_idle_time',
  description: '用户键鼠最后活动距现在多少毫秒。基于 user32.dll GetLastInputInfo。',
  promptFragment: { appLayer: getIdleTimeFragment, native: getIdleTimeFragment },
  nativeDef: {
    name: 'get_idle_time',
    description: '查用户键鼠最后一次输入距现在的毫秒数。常用于判断"用户是否离开"。',
    input_schema: { type: 'object', properties: {} }
  },
  extractTarget: () => '键鼠空闲时长',
  executor: async () => {
    try {
      const out = await runPs(IDLE_TIME_PS)
      const info = tryParseJson<IdleTimeInfo>(out)
      if (!info) {
        return { ok: false, content: `PowerShell 返回了无法解析的内容：${out.slice(0, 200)}` }
      }
      const ms = info.idleMs
      const human = formatIdle(ms)
      return { ok: true, content: `空闲时长: ${human}\nidleMs: ${ms}` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, content: `读取空闲时长失败：${msg}` }
    }
  }
}

function formatIdle(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m} 分 ${rs} 秒`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h} 小时 ${rm} 分`
}

// powershell.exe + user32.dll 在所有 Windows 上默认存在，无需 binExists 自检
export function bootstrapUserActivityTools(): void {
  registerTool(getActiveWindowDescriptor)
  registerTool(getIdleTimeDescriptor)
}
