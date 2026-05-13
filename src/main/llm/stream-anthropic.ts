// cc-native 流式：SSE → 事件回调 + 拼装 AnthropicResponse。
// server_tool_use 必须等 content_block_stop 才有完整 input。
import {
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicServerToolUseBlock,
  AnthropicWebSearchToolResultBlock
} from './transform-responses'

export interface StreamHandlers {
  onTextDelta?: (text: string) => void
  onServerToolUse?: (block: AnthropicServerToolUseBlock) => void
  onServerToolResult?: (block: AnthropicWebSearchToolResultBlock) => void
}

interface AccumBlock {
  type: string
  index: number
  textChunks: string[]
  inputPartials: string[]
  id?: string
  name?: string
  toolUseId?: string
  resultContent?: AnthropicWebSearchToolResultBlock['content']
}

interface SSEEvent {
  event: string
  data: unknown
}

async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) {
          const ev = parseEventBlock(buffer)
          if (ev) yield ev
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const ev = parseEventBlock(raw)
        if (ev) yield ev
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEventBlock(raw: string): SSEEvent | null {
  let event = ''
  let dataStr = ''
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
  }
  if (!event || !dataStr) return null
  try {
    return { event, data: JSON.parse(dataStr) }
  } catch {
    return null
  }
}

export async function streamMessages(
  url: string,
  headers: Record<string, string>,
  body: object,
  signal: AbortSignal | undefined,
  handlers: StreamHandlers
): Promise<AnthropicResponse> {
  // 真 CC stream:true 仍发 accept:application/json，不能改 event-stream
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`)
  }
  if (!resp.body) {
    throw new Error('streaming response has no body')
  }

  let id = ''
  let model = ''
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let serverToolStats: { web_search_requests?: number } | undefined

  const blocks = new Map<number, AccumBlock>()

  for await (const { event, data } of parseSSE(resp.body)) {
    const ev = (data ?? {}) as Record<string, any>

    switch (event) {
      case 'message_start': {
        const msg = (ev.message ?? {}) as Record<string, any>
        id = typeof msg.id === 'string' ? msg.id : ''
        model = typeof msg.model === 'string' ? msg.model : ''
        if (msg.usage) {
          inputTokens = typeof msg.usage.input_tokens === 'number' ? msg.usage.input_tokens : 0
          outputTokens = typeof msg.usage.output_tokens === 'number' ? msg.usage.output_tokens : 0
        }
        break
      }

      case 'content_block_start': {
        const idx = ev.index as number
        const cb = (ev.content_block ?? {}) as Record<string, any>
        const acc: AccumBlock = {
          type: typeof cb.type === 'string' ? cb.type : 'unknown',
          index: idx,
          textChunks: [],
          inputPartials: []
        }
        if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          acc.id = typeof cb.id === 'string' ? cb.id : undefined
          acc.name = typeof cb.name === 'string' ? cb.name : undefined
        }
        if (cb.type === 'web_search_tool_result') {
          acc.toolUseId = typeof cb.tool_use_id === 'string' ? cb.tool_use_id : undefined
          acc.resultContent = cb.content
          if (acc.toolUseId !== undefined) {
            handlers.onServerToolResult?.({
              type: 'web_search_tool_result',
              tool_use_id: acc.toolUseId,
              content: acc.resultContent ?? []
            })
          }
        }
        if (cb.type === 'text' && typeof cb.text === 'string' && cb.text) {
          acc.textChunks.push(cb.text)
          handlers.onTextDelta?.(cb.text)
        }
        blocks.set(idx, acc)
        break
      }

      case 'content_block_delta': {
        const idx = ev.index as number
        const acc = blocks.get(idx)
        if (!acc) break
        const delta = (ev.delta ?? {}) as Record<string, any>
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          acc.textChunks.push(delta.text)
          handlers.onTextDelta?.(delta.text)
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          acc.inputPartials.push(delta.partial_json)
        }
        break
      }

      case 'content_block_stop': {
        const idx = ev.index as number
        const acc = blocks.get(idx)
        if (!acc) break
        if (acc.type === 'server_tool_use' && acc.id && acc.name) {
          handlers.onServerToolUse?.({
            type: 'server_tool_use',
            id: acc.id,
            name: acc.name,
            input: parseInputPartials(acc.inputPartials)
          })
        }
        break
      }

      case 'message_delta': {
        const delta = (ev.delta ?? {}) as Record<string, any>
        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason ?? null
        if (ev.usage) {
          if (typeof ev.usage.output_tokens === 'number') outputTokens = ev.usage.output_tokens
          if (typeof ev.usage.input_tokens === 'number') inputTokens = ev.usage.input_tokens
          if (ev.usage.server_tool_use) serverToolStats = ev.usage.server_tool_use
        }
        break
      }

      case 'message_stop':
      case 'ping':
        break

      case 'error':
        throw new Error(`stream error: ${JSON.stringify(ev.error ?? ev)}`)
    }
  }

  const sortedIndices = Array.from(blocks.keys()).sort((a, b) => a - b)
  const content: AnthropicContentBlock[] = []
  for (const idx of sortedIndices) {
    const acc = blocks.get(idx)
    if (!acc) continue
    if (acc.type === 'text') {
      content.push({ type: 'text', text: acc.textChunks.join('') })
    } else if (acc.type === 'tool_use' && acc.id && acc.name) {
      content.push({
        type: 'tool_use',
        id: acc.id,
        name: acc.name,
        input: parseInputPartials(acc.inputPartials)
      })
    } else if (acc.type === 'server_tool_use' && acc.id && acc.name) {
      content.push({
        type: 'server_tool_use',
        id: acc.id,
        name: acc.name,
        input: parseInputPartials(acc.inputPartials)
      })
    } else if (acc.type === 'web_search_tool_result' && acc.toolUseId) {
      content.push({
        type: 'web_search_tool_result',
        tool_use_id: acc.toolUseId,
        content: acc.resultContent ?? []
      })
    }
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(serverToolStats ? { server_tool_use: serverToolStats } : {})
    }
  }
}

function parseInputPartials(partials: string[]): Record<string, unknown> {
  const full = partials.join('')
  if (!full) return {}
  try {
    const parsed = JSON.parse(full)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
