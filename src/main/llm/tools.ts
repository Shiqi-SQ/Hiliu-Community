// app-layer 工具派发：模型输出 JSON.tool 命中 registry 里的 descriptor → 执行后回灌成 user 消息
import { getToolByName } from './registry'

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

// 'image' 时 base64 喂模型，localPath 仅 log/追踪用；llm/index.ts 会把消息升级成 blocks 数组
export type ToolResultPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mediaType: 'image/png' | 'image/jpeg'
      base64: string
      localPath?: string
    }

export interface ToolResult {
  name: string
  ok: boolean
  // 即便有 parts 也必填——上层 log / UI 卡片摘要要用
  content: string
  parts?: ToolResultPart[]
}

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const desc = getToolByName(call.name)
  if (!desc) {
    return {
      name: call.name,
      ok: false,
      content: `（系统）工具「${call.name}」不存在或当前版本未接入，请不要再尝试调用它。`
    }
  }
  try {
    const r = await desc.executor(call.args)
    return { name: call.name, ok: r.ok, content: r.content, parts: r.parts }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      name: call.name,
      ok: false,
      content: `（系统）工具「${call.name}」执行出错：${msg}`
    }
  }
}
