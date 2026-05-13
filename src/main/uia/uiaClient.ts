// JSON-RPC over stdin/stdout line-delimited——每行一个 JSON 对象，id 自增，响应可乱序。

import { spawn, type ChildProcess } from 'node:child_process'
import { resolveBinPath } from '../system/binPath'

export interface UiaRequest {
  method: string
  params?: Record<string, unknown>
  timeoutMs?: number
}

export interface UiaResponse<T = unknown> {
  ok: true
  result: T
}

export interface UiaError {
  ok: false
  error: string
}

export type UiaCallResult<T = unknown> = UiaResponse<T> | UiaError

const DEFAULT_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export class UiaClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stdoutBuffer = ''
  private banner: { ready: true; pid: number; protocol: string } | null = null
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((e: Error) => void) | null = null
  private lastActivityAt = Date.now()

  async start(): Promise<void> {
    if (this.proc && !this.proc.killed) return this.readyPromise ?? Promise.resolve()
    const scriptPath = resolveBinPath('uia-daemon.ps1')
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // -ExcludePid 把 hiliu 主进程 PID 喂进去——daemon 会按"该 pid + 它整棵子进程树"
    // 过滤窗口（Electron 4 个 BrowserWindow 各属不同 renderer 子进程，单 PID 不够）。
    // 这样：用户哪怕焦点在 hiliu 气泡上调 ui_snapshot foreground，daemon 也会立即报错
    // 让模型走 list_windows + scope=hwnd 的正路，而不是抓一棵自家 UI 树回来。
    this.proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-OutputFormat', 'Text',
        '-File', scriptPath,
        '-ExcludePid', String(process.pid)
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    if (!this.proc.stdout || !this.proc.stdin) {
      this.readyReject?.(new Error('uia daemon: spawn 后 stdio 不可用'))
      this.proc = null
      return Promise.reject(new Error('uia daemon: spawn 后 stdio 不可用'))
    }
    // PS 输出已强制 UTF-8（脚本头），Node 这边按 utf8 解
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr?.setEncoding('utf8')

    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr?.on('data', (chunk: string) => {
      // PS 把警告写 stderr 不算致命；记日志即可
      console.warn('[uiaClient] stderr:', chunk.trim())
    })
    this.proc.on('exit', (code, signal) => {
      console.log(`[uiaClient] daemon 退出 code=${code} signal=${signal}`)
      this.handleExit(code, signal)
    })
    this.proc.on('error', (err) => {
      console.warn('[uiaClient] proc 错误：', err.message)
      this.readyReject?.(err)
      this.handleExit(null, null)
    })
    return this.readyPromise
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc || proc.killed) {
      this.proc = null
      return
    }
    try {
      // 留 1.5s 让 daemon 自己退出
      await Promise.race([
        this.call('shutdown', undefined, 1500),
        new Promise<void>((r) => setTimeout(r, 1500))
      ])
    } catch {
      /* 忽略——下面要 kill */
    }
    if (proc && !proc.killed) {
      try { proc.kill() } catch { /* noop */ }
    }
    this.proc = null
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed && !!this.banner
  }

  idleMs(): number {
    return Date.now() - this.lastActivityAt
  }

  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    if (!this.proc || this.proc.killed) throw new Error('uia daemon 未运行——请先 start()')
    if (!this.banner) {
      if (this.readyPromise) await this.readyPromise
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params: params ?? {} })
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`uia call '${method}' 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        method
      })
      try {
        this.proc!.stdin!.write(payload + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let nl = this.stdoutBuffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
      if (line) this.handleLine(line)
      nl = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(line) as Record<string, unknown> } catch {
      console.warn('[uiaClient] 收到非 JSON 行：', line.slice(0, 200))
      return
    }
    if (!parsed) return

    // banner 行（无 id，有 ready=true）
    if (parsed.ready === true && this.banner === null) {
      this.banner = parsed as { ready: true; pid: number; protocol: string }
      console.log(`[uiaClient] daemon ready pid=${this.banner.pid} protocol=${this.banner.protocol}`)
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      return
    }

    const id = typeof parsed.id === 'number' ? parsed.id : null
    if (id == null) {
      console.warn('[uiaClient] 收到无 id 的响应：', line.slice(0, 200))
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      console.warn(`[uiaClient] 收到孤儿响应 id=${id}`)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(id)
    this.lastActivityAt = Date.now()

    if (typeof parsed.error === 'string') {
      pending.reject(new Error(parsed.error))
    } else {
      pending.resolve(parsed.result)
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    // daemon 死了——把所有 pending 全 reject，外层 service 决定要不要重启
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`uia daemon 异常退出 code=${code} signal=${signal} 进行中：${p.method}`))
    }
    this.pending.clear()
    this.proc = null
    this.banner = null
    this.stdoutBuffer = ''
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
  }
}

// 模块单例——main 进程只跑一个 daemon
export const uiaClient = new UiaClient()
