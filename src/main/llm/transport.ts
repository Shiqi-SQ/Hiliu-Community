import { writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { ModelTier, ProtocolMode, ProviderInstance } from '@shared/types'
import {
  buildCCHeaders,
  buildCCMetadata,
  buildCCSystem,
  ccMessagesURL,
  defaultCcEffort,
  isHaikuModel,
  responsesURL
} from './cc-fingerprint'
import {
  AnthropicBody,
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicToolDef,
  anthropicToResponses,
  responsesToAnthropic
} from './transform-responses'
import { CC_BUILTIN_TOOLS } from './cc-builtin-tools'
import { StreamHandlers, streamMessages } from './stream-anthropic'

// haiku→20000 / 其他→64000；按 model 不是按 tier，否则 haiku 配 daily 槽时穿帮
function defaultMaxTokens(model: string): number {
  return isHaikuModel(model) ? 20000 : 64000
}

const FALLBACK_MODELS: Record<
  ProtocolMode,
  Record<ModelTier, string>
> = {
  'cc-native': {
    light: 'claude-haiku-4-5',
    daily: 'claude-sonnet-4-6',
    reasoning: 'claude-opus-4-7'
  },
  'cc-translate-responses': {
    light: 'gpt-4o-mini',
    daily: 'gpt-4o',
    reasoning: 'o3'
  },
  'cc-translate-openai-chat': {
    light: 'claude-haiku-4.5',
    daily: 'claude-sonnet-4.6',
    reasoning: 'claude-sonnet-4.6'
  },
  'cc-translate-gemini': {
    light: 'gemini-3-flash',
    daily: 'gemini-3.1-pro',
    reasoning: 'gemini-3.1-pro'
  }
}

function resolveModel(provider: ProviderInstance, tier: ModelTier): string {
  const configured = provider.models?.[tier]
  if (configured && configured.trim()) return configured
  return FALLBACK_MODELS[provider.protocolMode][tier]
}

// 首条 user 消息纯文本，用于算计费哈希
function pickFirstUserText(messages: AnthropicBody['messages']): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    for (const block of m.content) {
      if (block.type === 'text') return block.text
    }
  }
  return ''
}

function buildAnthropicBody(
  provider: ProviderInstance,
  messages: AnthropicMessageInput[],
  options: ChatOptions
): AnthropicBody {
  const sys = messages.find((m) => m.role === 'system')?.content
  const userSystem = typeof sys === 'string' ? sys : undefined

  const dialogRaw: AnthropicBody['messages'] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

  // 真 CC messages[0] 必为 user；剥离开头连续 assistant（桌宠预注入开场白）
  let firstUserIdx = 0
  while (firstUserIdx < dialogRaw.length && dialogRaw[firstUserIdx].role !== 'user') {
    firstUserIdx++
  }
  const dialog = dialogRaw.slice(firstUserIdx)

  const firstUserText = pickFirstUserText(dialog)

  // 字段插入顺序按真 CC v2.1.112 wire 对齐——JSON.stringify 按插入序输出，错位会被识破
  const body = {
    model: resolveModel(provider, options.tier ?? 'daily'),
    messages: dialog,
    system: buildCCSystem(firstUserText, userSystem)
  } as AnthropicBody
  // cc-native 必发 31 个内置工具 schema 装饰性副本，模型仍走 app-layer JSON 协议
  if (options.tools && options.tools.length > 0) {
    console.warn(
      '[transport] options.tools 已被忽略：cc-native 装饰性挂 31 内置工具以对齐真 CC 指纹'
    )
  }
  if (provider.protocolMode === 'cc-native') {
    body.tools = CC_BUILTIN_TOOLS as unknown as AnthropicToolDef[]
  }
  body.metadata = buildCCMetadata()
  body.max_tokens = options.maxTokens ?? defaultMaxTokens(body.model)
  body.thinking = { type: 'adaptive' }
  body.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }
  const effort = defaultCcEffort(body.model)
  if (effort) body.output_config = { effort }
  if (options.toolChoice) body.tool_choice = options.toolChoice
  return body
}

export interface AnthropicMessageInput {
  role: 'user' | 'assistant' | 'system'
  content: string | AnthropicContentBlock[]
}

export interface ChatOptions {
  maxTokens?: number
  signal?: AbortSignal
  tier?: ModelTier
  tools?: AnthropicToolDef[]
  toolChoice?: AnthropicBody['tool_choice']
}

export async function postChat(
  provider: ProviderInstance,
  messages: AnthropicMessageInput[],
  options: ChatOptions = {}
): Promise<AnthropicResponse> {
  if (!provider.apiKey.trim()) {
    throw new Error('请先在设置中填入 API Key')
  }
  if (!provider.baseURL.trim()) {
    throw new Error('请先在设置中填入服务地址 baseURL')
  }

  const body = buildAnthropicBody(provider, messages, options)
  const headers = buildCCHeaders(provider.apiKey, body.model, provider.disableExperimentalBetas)

  switch (provider.protocolMode) {
    case 'cc-native':
      // 真 CC 永远 stream:true，非流式会被网关识破；用 buffered 累积成等价响应
      return streamNativeBuffered(provider.baseURL, headers, body, options.signal)
    case 'cc-translate-responses':
      return postTranslated(provider.baseURL, headers, body, options.signal)
    case 'cc-translate-openai-chat':
      throw new Error(
        'OpenAI Chat 翻译协议（GitHub Copilot 等）当前版本暂未实现，敬请期待'
      )
    case 'cc-translate-gemini':
      throw new Error('Gemini Native 翻译协议当前版本暂未实现，敬请期待')
    default:
      return assertNever(provider.protocolMode)
  }
}

function assertNever(x: never): never {
  throw new Error(`未知的 protocolMode: ${String(x)}`)
}

async function postNative(
  baseURL: string,
  headers: Record<string, string>,
  body: AnthropicBody,
  signal?: AbortSignal
): Promise<AnthropicResponse> {
  const url = ccMessagesURL(baseURL)
  dumpRequest('postNative', url, headers, body)
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`)
  return JSON.parse(text) as AnthropicResponse
}

// dev-only: 完整 dump 到 last-request.json（UTF-8），终端只打 ASCII 摘要避 GBK 乱码
function dumpRequest(
  tag: string,
  url: string,
  headers: Record<string, string>,
  body: object
): void {
  if (process.env.NODE_ENV === 'production') return
  const safeHeaders = { ...headers }
  if (safeHeaders.authorization) {
    safeHeaders.authorization = safeHeaders.authorization.replace(/(Bearer\s+\S{6})\S+/, '$1***')
  }
  const dumpPath = join(app.getPath('userData'), 'last-request.json')
  const payload = {
    tag,
    timestamp: new Date().toISOString(),
    url,
    headers: safeHeaders,
    body
  }
  try {
    writeFileSync(dumpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
  } catch (err) {
    console.error(`[dumpRequest] write failed: ${(err as Error).message}`)
  }
  const billingBlock = (body as { system?: Array<{ text?: string }> })?.system?.[0]?.text ?? ''
  const cchMatch = billingBlock.match(/cch=([^;]+)/)?.[1] ?? '<none>'
  console.log(
    `\n[dumpRequest] ${tag}\n` +
      `  → file: ${dumpPath}\n` +
      `  → url: ${url}\n` +
      `  → User-Agent: ${headers['user-agent']}\n` +
      `  → cch: ${cchMatch}    (期望 "00000")\n`
  )
}

// 流式发出但累积成等价响应，wire 上保持 stream:true 指纹
async function streamNativeBuffered(
  baseURL: string,
  headers: Record<string, string>,
  body: AnthropicBody,
  signal?: AbortSignal
): Promise<AnthropicResponse> {
  const url = ccMessagesURL(baseURL)
  dumpRequest('streamNativeBuffered', url, headers, { ...body, stream: true })
  return streamMessages(url, headers, body, signal, {})
}

export async function streamChatNative(
  provider: ProviderInstance,
  messages: AnthropicMessageInput[],
  options: ChatOptions,
  handlers: StreamHandlers
): Promise<AnthropicResponse> {
  if (!provider.apiKey.trim()) throw new Error('请先在设置中填入 API Key')
  if (!provider.baseURL.trim()) throw new Error('请先在设置中填入服务地址 baseURL')
  if (provider.protocolMode !== 'cc-native') {
    throw new Error(`streamChatNative 仅支持 cc-native，当前 protocolMode=${provider.protocolMode}`)
  }

  const body = buildAnthropicBody(provider, messages, options)

  const headers = buildCCHeaders(provider.apiKey, body.model, provider.disableExperimentalBetas)
  const url = ccMessagesURL(provider.baseURL)
  dumpRequest('streamChatNative', url, headers, { ...body, stream: true })

  return streamMessages(url, headers, body, options.signal, handlers)
}

async function postTranslated(
  baseURL: string,
  headers: Record<string, string>,
  body: AnthropicBody,
  signal?: AbortSignal
): Promise<AnthropicResponse> {
  const responsesBody = anthropicToResponses(body)
  // 翻译路径剥掉所有 anthropic-* / x-stainless-* 头，否则 OpenAI 端点拒
  const cleanHeaders: Record<string, string> = {
    Authorization: headers.authorization,
    'content-type': 'application/json',
    accept: 'application/json',
    'User-Agent': headers['user-agent']
  }
  const url = responsesURL(baseURL)
  dumpRequest('postTranslated', url, cleanHeaders, responsesBody)
  const resp = await fetch(url, {
    method: 'POST',
    headers: cleanHeaders,
    body: JSON.stringify(responsesBody),
    signal
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`)
  const raw = JSON.parse(text) as Parameters<typeof responsesToAnthropic>[0]
  return responsesToAnthropic(raw, body.model)
}
