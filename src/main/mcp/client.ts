// MCP 单 server stdio 客户端——子进程意外退出立即 unregister 工具，防模型继续调用失效工具
// 暴露 name 用双下划线（serverId__toolName）避开 Anthropic regex 限制；id 仍用冒号 'mcp:..:..' 内部寻址

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpRuntimeStatus } from '@shared/types'
import {
  registerTool,
  unregisterToolsBySource,
  type ToolDescriptor
} from '../llm/registry'

type McpContentBlock = {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: unknown
  [k: string]: unknown
}

function stringifyContent(content: McpContentBlock[]): string {
  return content
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      // image/audio 不喂模型——base64 噪声
      if (b.type === 'image' || b.type === 'audio') {
        return `[${b.type}: ${b.mimeType ?? 'unknown'}]`
      }
      try {
        return JSON.stringify(b)
      } catch {
        return `[${b.type}]`
      }
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

export class McpClient {
  private cfg: McpServerConfig
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private state: McpRuntimeStatus['state'] = 'stopped'
  private error?: string
  private toolCount = 0
  private onStatusChange?: (s: McpRuntimeStatus) => void

  constructor(cfg: McpServerConfig, onStatusChange?: (s: McpRuntimeStatus) => void) {
    this.cfg = cfg
    this.onStatusChange = onStatusChange
  }

  status(): McpRuntimeStatus {
    return {
      serverId: this.cfg.id,
      state: this.state,
      error: this.error,
      toolCount: this.toolCount
    }
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return
    this.error = undefined
    this.toolCount = 0
    this.setState('starting')
    try {
      this.transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args,
        env: this.cfg.env,
        cwd: this.cfg.cwd
      })
      this.transport.onclose = () => {
        if (this.state === 'running') {
          this.error = 'MCP server 子进程意外退出'
          unregisterToolsBySource(`mcp:${this.cfg.id}:`)
          this.toolCount = 0
          this.setState('error')
        }
      }
      this.transport.onerror = (err) => {
        this.error = err.message
        if (this.state === 'starting' || this.state === 'running') {
          unregisterToolsBySource(`mcp:${this.cfg.id}:`)
          this.toolCount = 0
          this.setState('error')
        }
      }

      this.client = new Client(
        { name: 'hiliu', version: '0.1.25' },
        { capabilities: {} }
      )
      await this.client.connect(this.transport)

      const { tools } = await this.client.listTools()
      for (const tool of tools) {
        registerTool(this.toDescriptor(tool))
      }
      this.toolCount = tools.length
      this.setState('running')
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      // 清掉可能注册了一半的工具
      unregisterToolsBySource(`mcp:${this.cfg.id}:`)
      this.toolCount = 0
      this.setState('error')
      // 子进程可能已 spawn
      try {
        await this.transport?.close()
      } catch {
        // ignore
      }
      this.transport = null
      this.client = null
    }
  }

  // 重复调用安全
  async stop(): Promise<void> {
    unregisterToolsBySource(`mcp:${this.cfg.id}:`)
    this.toolCount = 0
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // ignore
      }
    }
    this.client = null
    this.transport = null
    this.error = undefined
    this.setState('stopped')
  }

  async restart(cfg: McpServerConfig): Promise<void> {
    await this.stop()
    this.cfg = cfg
    if (cfg.enabled) await this.start()
  }

  private setState(state: McpRuntimeStatus['state']): void {
    this.state = state
    this.onStatusChange?.(this.status())
  }

  private toDescriptor(tool: {
    name: string
    description?: string
    inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] }
  }): ToolDescriptor {
    const exposedName = `${this.cfg.id}__${tool.name}`
    const promptText = `- ${exposedName}：${tool.description ?? '（无描述）'}`
    const client = this.client!
    return {
      id: `mcp:${this.cfg.id}:${tool.name}`,
      name: exposedName,
      source: 'mcp',
      displayName: tool.name,
      description: tool.description ?? '',
      promptFragment: { appLayer: promptText, native: promptText },
      nativeDef: {
        // 真 CC custom 工具不带 type 字段
        name: exposedName,
        description: tool.description ?? '',
        input_schema: {
          type: 'object',
          properties: (tool.inputSchema.properties ?? {}) as Record<string, never>,
          required: tool.inputSchema.required
        }
      },
      extractTarget: (args) => {
        try {
          return JSON.stringify(args).slice(0, 80)
        } catch {
          return ''
        }
      },
      executor: async (args) => {
        try {
          const r = await client.callTool({ name: tool.name, arguments: args })
          const content = Array.isArray(r.content)
            ? stringifyContent(r.content as McpContentBlock[])
            : ''
          return { ok: r.isError !== true, content }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { ok: false, content: `MCP server 调用失败：${msg}` }
        }
      }
    }
  }
}
