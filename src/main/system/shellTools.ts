// bash_exec 在 Windows 找 bash.exe（git bash / WSL），找不到回退 cmd /c
// ps_exec 强制 [Console]::OutputEncoding=utf8——PS 5.1 默认 GBK，不加中文必乱码
// SIGTERM 不一定杀 Windows 子进程组，超时后用 taskkill /F /T 兜底
// 「无输出」不等于「执行成功」——模型容易把 stdout 为空读成成功，此处明确告知

import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 100 * 1024

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function clampTimeout(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(v), MAX_TIMEOUT_MS)
}

function resolveCwd(raw: unknown): { cwd: string; warning?: string } {
  const home = os.homedir()
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return { cwd: home }
  let p = s
  if (p === '~') p = home
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2))
  if (!path.isAbsolute(p)) {
    return { cwd: home, warning: `cwd "${s}" 不是绝对路径，已回退到家目录。` }
  }
  return { cwd: path.normalize(p) }
}

interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
}

// 不走 shell:true——避免命令注入；shell 程序由调用方明确指定
function runShellProcess(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  envExtra?: NodeJS.ProcessEnv
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd,
      env: { ...process.env, ...envExtra },
      windowsHide: true
    })

    const stdoutBufs: Buffer[] = []
    const stderrBufs: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false

    child.stdout.on('data', (d: Buffer) => {
      if (stdoutBytes + d.length > MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - stdoutBytes
        if (room > 0) stdoutBufs.push(d.subarray(0, room))
        stdoutBytes = MAX_OUTPUT_BYTES
        truncated = true
      } else {
        stdoutBufs.push(d)
        stdoutBytes += d.length
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderrBytes + d.length > MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - stderrBytes
        if (room > 0) stderrBufs.push(d.subarray(0, room))
        stderrBytes = MAX_OUTPUT_BYTES
        truncated = true
      } else {
        stderrBufs.push(d)
        stderrBytes += d.length
      }
    })

    const killTimer = setTimeout(() => {
      timedOut = true
      // SIGTERM 不一定杀 Windows 子进程组，taskkill /F /T 兜底
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], { windowsHide: true })
        } catch {
          /* ignore */
        }
      }
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(killTimer)
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString('utf-8'),
        stderr: (Buffer.concat(stderrBufs).toString('utf-8') + '\n' + err.message).trim(),
        exitCode: -1,
        timedOut: false,
        truncated
      })
    })

    child.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({
        stdout: Buffer.concat(stdoutBufs).toString('utf-8'),
        stderr: Buffer.concat(stderrBufs).toString('utf-8'),
        exitCode: code,
        timedOut,
        truncated
      })
    })
  })
}

function formatShellResult(
  command: string,
  cwd: string,
  res: ShellRunResult,
  cwdWarning?: string
): { ok: boolean; content: string } {
  const lines: string[] = []
  lines.push(`$ ${command}`)
  lines.push(`(cwd: ${cwd}${cwdWarning ? '；' + cwdWarning : ''})`)
  if (res.timedOut) {
    lines.push(`(执行超时已被强杀)`)
  }
  if (res.exitCode !== null && res.exitCode !== 0) {
    lines.push(`(exit code: ${res.exitCode})`)
  }
  if (res.stdout) {
    lines.push('--- stdout ---')
    lines.push(res.stdout.replace(/\s+$/, ''))
  }
  if (res.stderr) {
    lines.push('--- stderr ---')
    lines.push(res.stderr.replace(/\s+$/, ''))
  }
  if (!res.stdout && !res.stderr) {
    // 「无输出」不等于「执行成功」——改音量/注册表/进程等命令大多 stdout 空，不允许凭空断言成功
    lines.push('(命令无 stdout/stderr 输出。注意：「无输出」不等于「产生了预期效果」——如果你刚才尝试改变某个状态（音量/进程/窗口/文件/注册表等），下一步必须用对应的查询工具回读真实状态再下结论，不允许凭空说「搞定了」。)')
  }
  if (res.truncated) {
    lines.push(`(输出超过 ${MAX_OUTPUT_BYTES / 1024}KB 已截断)`)
  }
  const ok = !res.timedOut && (res.exitCode === 0 || res.exitCode === null)
  return { ok, content: lines.join('\n') }
}

const bashFragment = [
  'bash_exec(command: string, cwd?: string, timeout?: number)',
  '   在用户机器上跑一条 bash 命令。Windows 上会找 git bash 或 WSL bash；都没有则回退 cmd。',
  '   cwd 可选，默认 ~（家目录）；要切目录把 cwd 传过去，不要在 command 里 cd。',
  '   timeout 单位毫秒，默认 60000（1min），最大 300000（5min）。',
  '   输出 stdout + stderr 合并返回，超过 100KB 截断。'
].join('\n')

const bashExecDescriptor: ToolDescriptor = {
  id: 'builtin:bash_exec',
  name: 'bash_exec',
  source: 'builtin',
  displayName: 'bash_exec',
  description: '在用户机器上跑 bash 命令（找不到 bash 时回退 cmd）。返回 stdout/stderr/exitCode。',
  promptFragment: { appLayer: bashFragment, native: bashFragment },
  nativeDef: {
    name: 'bash_exec',
    description:
      '执行一条 bash 命令并返回 stdout/stderr/exitCode。Windows 上优先找 git bash / WSL bash，否则回退 cmd /c。命令默认在用户家目录下执行；要切目录请用 cwd 参数。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令字符串' },
        cwd: { type: 'string', description: '可选工作目录，绝对路径或 ~/，缺省家目录' },
        timeout: {
          type: 'number',
          description: '可选超时毫秒，默认 60000，最大 300000'
        }
      },
      required: ['command']
    }
  },
  extractTarget: (args) => asString(args.command),
  executor: async (args) => {
    const command = asString(args.command).trim()
    if (!command) return { ok: false, content: '（系统）bash_exec 缺少 command 参数。' }
    const { cwd, warning } = resolveCwd(args.cwd)
    const timeout = clampTimeout(args.timeout)

    // 优先 PATH 里的 bash；spawn ENOENT 直接降级 cmd，不做预检
    let res = await runShellProcess('bash', ['-lc', command], cwd, timeout)
    if (res.exitCode === -1 && res.stderr.includes('ENOENT')) {
      res = await runShellProcess('cmd', ['/c', command], cwd, timeout)
    }
    return formatShellResult(command, cwd, res, warning)
  }
}

const psFragment = [
  'ps_exec(command: string, cwd?: string, timeout?: number)',
  '   在用户机器上跑一条 PowerShell 命令。优先 pwsh（PS 7+），没有就用 powershell.exe（PS 5.1）。',
  '   cwd 可选，默认 ~；timeout 默认 60000ms 最大 300000ms。',
  '   会强制 OutputEncoding=utf8 避免中文乱码。输出 stdout + stderr 合并返回。'
].join('\n')

const psExecDescriptor: ToolDescriptor = {
  id: 'builtin:ps_exec',
  name: 'ps_exec',
  source: 'builtin',
  displayName: 'ps_exec',
  description: '在用户机器上跑 PowerShell 命令（pwsh 优先，回退 powershell.exe）。',
  promptFragment: { appLayer: psFragment, native: psFragment },
  nativeDef: {
    name: 'ps_exec',
    description:
      '执行一条 PowerShell 命令并返回 stdout/stderr/exitCode。优先 PowerShell 7+ (pwsh)，回退 PS 5.1 (powershell.exe)。强制 UTF-8 输出避免中文乱码。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令字符串' },
        cwd: { type: 'string', description: '可选工作目录，绝对路径或 ~/，缺省家目录' },
        timeout: {
          type: 'number',
          description: '可选超时毫秒，默认 60000，最大 300000'
        }
      },
      required: ['command']
    }
  },
  extractTarget: (args) => asString(args.command),
  executor: async (args) => {
    const command = asString(args.command).trim()
    if (!command) return { ok: false, content: '（系统）ps_exec 缺少 command 参数。' }
    const { cwd, warning } = resolveCwd(args.cwd)
    const timeout = clampTimeout(args.timeout)

    // PS 5.1 默认 GBK 输出，必须强制 UTF8；PS 7+ 已默认 UTF-8 但加也无害
    const wrapped =
      "$OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      command
    const psArgs = ['-NoProfile', '-NonInteractive', '-Command', wrapped]

    let res = await runShellProcess('pwsh', psArgs, cwd, timeout)
    if (res.exitCode === -1 && res.stderr.includes('ENOENT')) {
      res = await runShellProcess('powershell', psArgs, cwd, timeout)
    }
    return formatShellResult(command, cwd, res, warning)
  }
}

export function bootstrapShellTools(): void {
  registerTool(bashExecDescriptor)
  registerTool(psExecDescriptor)
}
