// Anthropic Messages 类型 + ↔ OpenAI Responses 翻译层
// 覆盖 text + image（base64→data URL）；tool_* 块在翻译路径静默丢（OpenAI 协议无对应）

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
  citations?: Array<{
    type: 'web_search_result_location'
    url: string
    title: string
    encrypted_index: string
    cited_text: string
  }>
}

// client-side：main 端 executeTool 跑
export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

// server-side：Anthropic 服务端跑（web_search_20250305），客户端只读
export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicWebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content:
    | Array<{
        type: 'web_search_result'
        url: string
        title: string
        encrypted_content?: string
        page_age?: string
      }>
    | { type: 'web_search_tool_result_error'; error_code: string }
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  // 含图工具（window_capture）走 [{image},{text}] 数组形态；纯文本走 string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}

export interface AnthropicImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
    | { type: 'url'; url: string }
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

// web_search_20260209 支持 dynamic filtering 但要求同时启用 code_execution——暂用 20250305
export interface AnthropicWebSearchToolDef {
  type: 'web_search_20250305'
  name: 'web_search'
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: {
    type: 'approximate'
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
}

export interface AnthropicCustomToolDef {
  type?: 'custom'
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, AnthropicJsonSchemaProp>
    required?: string[]
  }
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicJsonSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: AnthropicJsonSchemaProp
  minItems?: number
  maxItems?: number
}

export type AnthropicToolDef = AnthropicWebSearchToolDef | AnthropicCustomToolDef

export interface AnthropicBody {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | AnthropicTextBlock[]
  temperature?: number
  top_p?: number
  metadata?: { user_id: string }
  // 仅 cc-native 模式挂；翻译路径 anthropicToResponses 会丢
  tools?: AnthropicToolDef[]
  tool_choice?:
    | { type: 'auto'; disable_parallel_tool_use?: boolean }
    | { type: 'any'; disable_parallel_tool_use?: boolean }
    | { type: 'tool'; name: string }
    | { type: 'none' }
  // 真 CC v2.1.112 必发；anthropic-beta 有 context-management 而 body 无此字段 → 网关 403
  context_management?: { edits: Array<{ type: string; keep: string }> }
  // interleaved-thinking-2025-05-14 beta 配套：header 有 / body 无 → 403。haiku 无
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled'; budget_tokens?: number }
  // effort-2025-11-24 beta 配套，常驻字段
  output_config?: { effort?: 'xlow' | 'low' | 'medium' | 'high' | 'xhigh' }
  stream?: boolean
}

export type AnthropicResponseContentBlock = AnthropicContentBlock

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicResponseContentBlock[]
  stop_reason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    server_tool_use?: { web_search_requests?: number }
  }
}

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }

interface ResponsesInputItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: ResponsesInputContent[]
}

interface ResponsesBody {
  model: string
  max_output_tokens: number
  input: ResponsesInputItem[]
  instructions?: string
  temperature?: number
  top_p?: number
  metadata?: { user_id: string }
}

interface ResponsesOutputItem {
  type: string
  role?: string
  content?: { type: string; text?: string }[]
}

interface ResponsesResponse {
  id?: string
  model?: string
  output?: ResponsesOutputItem[]
  output_text?: string
  status?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

// 仅 system / assistant 历史用——user 要保留 image 走 mapUserContent
function flattenText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  const out: string[] = []
  for (const b of content) {
    if (b.type === 'text') out.push(b.text)
  }
  return out.join('')
}

// 兜底空 input_text：全丢后 Responses 会拒空 message
function mapUserContent(content: string | AnthropicContentBlock[]): ResponsesInputContent[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  const out: ResponsesInputContent[] = []
  for (const b of content) {
    if (b.type === 'text') {
      out.push({ type: 'input_text', text: b.text })
    } else if (b.type === 'image') {
      const src = b.source
      const dataUrl =
        src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url
      out.push({ type: 'input_image', image_url: dataUrl, detail: 'auto' })
    }
    // tool_* blocks 在 Responses 协议下无对应 → 静默丢
  }
  if (out.length === 0) out.push({ type: 'input_text', text: '' })
  return out
}

export function anthropicToResponses(body: AnthropicBody): ResponsesBody {
  const instructions =
    body.system === undefined
      ? undefined
      : typeof body.system === 'string'
        ? body.system
        : body.system
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')

  const input: ResponsesInputItem[] = body.messages.map((m) => ({
    type: 'message',
    role: m.role,
    content:
      m.role === 'user'
        ? mapUserContent(m.content)
        : [{ type: 'output_text', text: flattenText(m.content) }]
  }))

  const out: ResponsesBody = {
    model: body.model,
    max_output_tokens: body.max_tokens,
    input
  }
  if (instructions !== undefined) out.instructions = instructions
  if (body.temperature !== undefined) out.temperature = body.temperature
  if (body.top_p !== undefined) out.top_p = body.top_p
  if (body.metadata) out.metadata = body.metadata
  return out
}

// 兜底顶层 output_text：部分 OpenAI 兼容实现不走 output[] 数组
export function responsesToAnthropic(resp: ResponsesResponse, model: string): AnthropicResponse {
  const texts: string[] = []
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type !== 'message') continue
      if (item.role && item.role !== 'assistant') continue
      if (!Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          texts.push(part.text)
        }
      }
    }
  }
  if (texts.length === 0 && typeof resp.output_text === 'string') {
    texts.push(resp.output_text)
  }
  const text = texts.join('')

  return {
    id: resp.id ?? '',
    type: 'message',
    role: 'assistant',
    model: resp.model ?? model,
    content: [{ type: 'text', text }],
    stop_reason: resp.status ?? null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0
    }
  }
}
