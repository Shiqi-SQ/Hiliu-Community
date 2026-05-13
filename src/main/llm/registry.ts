// 工具注册表：4 个消费点（promptBuilder / buildNativeTools / executeTool / requestPermission）查同一张 Map。
// 加工具只需 registerTool 一次。exempt:true 工具无视 policy，永远视作 allow_once。

import type { AnthropicToolDef } from './transform-responses'
import type { ToolResultPart } from './tools'
import type { ToolDescriptorView, ToolPolicy } from '@shared/types'
import { lookupLore } from '../lore/lookupLore'
import { webSearch, formatSearchResultsForLLM } from '../web/search'
import { fetchUrl, formatFetchedPageForLLM } from '../web/fetchUrl'
import { requestAskUser } from './askUser'

export interface ToolDescriptor {
  id: string
  // mcp 用 '<serverId>__<toolName>'——Anthropic name 字段 regex 不允许 ':'
  name: string
  source: 'builtin' | 'mcp'
  displayName: string
  description: string
  // appLayer/native 双轨：native 模式 input_schema 已在 body.tools 里告知模型，prompt 段可省参数说明
  promptFragment: { appLayer: string; native: string }
  // null = native 不支持（仅 app-layer 可用）
  nativeDef: AnthropicToolDef | null
  extractTarget: (args: Record<string, unknown>) => string
  // parts 仅带图工具（window_capture）用，纯文本工具不传
  executor: (
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; content: string; parts?: ToolResultPart[] }>
  exempt?: boolean
}

const tools = new Map<string, ToolDescriptor>()

export function registerTool(d: ToolDescriptor): void {
  tools.set(d.id, d)
}

export function unregisterTool(id: string): void {
  tools.delete(id)
}

// MCP server 重启/停止时批量清，如 unregisterToolsBySource('mcp:everything:')
export function unregisterToolsBySource(idPrefix: string): void {
  for (const id of Array.from(tools.keys())) {
    if (id.startsWith(idPrefix)) tools.delete(id)
  }
}

// builtin 裸名 vs mcp 带前缀——name 不会跨 source 冲突
export function getToolByName(name: string): ToolDescriptor | null {
  for (const d of tools.values()) {
    if (d.name === name) return d
  }
  return null
}

export function getToolById(id: string): ToolDescriptor | null {
  return tools.get(id) ?? null
}

export function listTools(): ToolDescriptor[] {
  return Array.from(tools.values())
}

// exempt 工具不可被禁用，永远进列表
export function listEnabledTools(
  policies: Record<string, ToolPolicy>
): ToolDescriptor[] {
  return listTools().filter((d) => {
    if (d.exempt) return true
    const p = policies[d.id] ?? 'ask'
    return p !== 'disabled'
  })
}

export function listToolViews(): ToolDescriptorView[] {
  return listTools().map((d) => ({
    id: d.id,
    name: d.name,
    source: d.source,
    displayName: d.displayName,
    description: d.description,
    exempt: d.exempt === true
  }))
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function asPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

const lookupLoreDescriptor: ToolDescriptor = {
  id: 'builtin:lookup_lore',
  name: 'lookup_lore',
  source: 'builtin',
  displayName: 'lookup_lore',
  description: '查关于「小刘」自己的设定细节（名字由来、家人朋友、外表、家乡等）。纯本地查表，无网络。',
  exempt: true,
  promptFragment: {
    appLayer: [
      '1. lookup_lore(topic: string)',
      '   查关于「我自己」的设定细节，比如名字由来、短尾巴、家人、朋友、外表、家乡。',
      '   topic 是关键词，可以宽泛（"父母"）也可以具体（"燕鸥小姐"）。'
    ].join('\n'),
    native: [
      '1. lookup_lore(topic: string)',
      '   查关于「我自己」的设定细节，比如名字由来、短尾巴、家人、朋友、外表、家乡。',
      '   topic 是关键词，可以宽泛（"父母"）也可以具体（"燕鸥小姐"）。'
    ].join('\n')
  },
  nativeDef: {
    // 真 CC v2.1.112 所有 custom 工具不带 type 字段——带 type:'custom' 是非真 CC 信号
    name: 'lookup_lore',
    description:
      '查关于「小刘」自己的设定细节（名字由来、家人朋友、外表、家乡等）。仅当问到「我自己」时调用。',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: '关键词，可宽泛（如"父母"）也可具体（如"燕鸥小姐"）'
        }
      },
      required: ['topic']
    }
  },
  extractTarget: (args) => asString(args.topic),
  executor: async (args) => {
    const topic = asString(args.topic)
    const content = lookupLore(topic)
    return { ok: true, content }
  }
}

// app-layer 走 open-websearch（有 limit）；native 走 Anthropic 服务端 web_search_20250305（参数仅 query）
const webSearchAppLayerFragment = [
  '2. web_search(query: string, limit?: number)',
  '   联网搜索（按用户配置的引擎链自动尝试，失败自动降级）。返回标题/URL/摘要列表。',
  '   limit 可选，默认 6 条，最大 12。',
  '   摘要看不出全貌时，挑最相关的 1-2 条 URL 用 fetch_url 拉详情。'
].join('\n')

const webSearchNativeFragment = [
  '2. web_search(query: string)',
  '   联网搜索网页（由 Anthropic 服务端执行）。返回若干带 url / title / page_age 的结果，',
  '   有时附正文摘要——摘要看不出全貌就挑最相关的 1-2 条 URL 用 fetch_url 拉详情。'
].join('\n')

const webSearchDescriptor: ToolDescriptor = {
  id: 'builtin:web_search',
  name: 'web_search',
  source: 'builtin',
  displayName: 'web_search',
  description: '联网搜索网页。app-layer 模式走 open-websearch；cc-native 模式走 Anthropic 服务端搜索。',
  promptFragment: {
    appLayer: webSearchAppLayerFragment,
    native: webSearchNativeFragment
  },
  // Anthropic 服务端工具，仅 cc-native 流用得上
  nativeDef: { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
  extractTarget: (args) => asString(args.query),
  executor: async (args) => {
    const query = asString(args.query).trim()
    if (!query) {
      return { ok: false, content: '（系统）web_search 调用缺少 query 参数。' }
    }
    const limit = Math.min(asPositiveInt(args.limit, 6), 12)
    const resp = await webSearch(query, limit)
    return { ok: true, content: formatSearchResultsForLLM(resp) }
  }
}

// 永远走本地搜索：对不支持 Anthropic 服务端 web_search 的上游也可用，与 web_search 通常择一启用
const openWebSearchPromptFragment = [
  '4. open_web_search(query: string, limit?: number)',
  '   免 key 联网搜索：按用户配置的引擎链顺序尝试（Bing/百度/360/Google/自定义），自动降级。',
  '   返回标题/URL/摘要列表。limit 可选，默认 6 条，最大 12。',
  '   适用于上游不支持服务端搜索时——结果摘要看不出全貌时挑 1-2 条 URL 用 fetch_url 拉详情。'
].join('\n')

const openWebSearchDescriptor: ToolDescriptor = {
  id: 'builtin:open_web_search',
  name: 'open_web_search',
  source: 'builtin',
  displayName: 'open_web_search',
  description: '免 key 多引擎搜索（按用户配置的引擎链自动降级）。和 web_search 的区别：永远走本地搜索，对 OpenAI 兼容上游也可用。',
  promptFragment: {
    appLayer: openWebSearchPromptFragment,
    native: openWebSearchPromptFragment
  },
  nativeDef: {
    name: 'open_web_search',
    description:
      '免 key 联网搜索（多引擎自动降级）。返回标题/URL/摘要列表。适用于上游不支持服务端搜索的场景。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: {
          type: 'number',
          description: '返回条数，默认 6，最大 12'
        }
      },
      required: ['query']
    }
  },
  extractTarget: (args) => asString(args.query),
  executor: async (args) => {
    const query = asString(args.query).trim()
    if (!query) {
      return { ok: false, content: '（系统）open_web_search 调用缺少 query 参数。' }
    }
    const limit = Math.min(asPositiveInt(args.limit, 6), 12)
    const resp = await webSearch(query, limit)
    return { ok: true, content: formatSearchResultsForLLM(resp) }
  }
}

const fetchUrlDescriptor: ToolDescriptor = {
  id: 'builtin:fetch_url',
  name: 'fetch_url',
  source: 'builtin',
  displayName: 'fetch_url',
  description: '抓取一个具体网页的标题与正文。自动剥掉 script/导航/广告，只留正文。',
  promptFragment: {
    appLayer: [
      '3. fetch_url(url: string)',
      '   抓取一个具体网页，返回标题和正文文本。',
      '   url 必须是完整的 http/https 地址。会自动剥掉 script/导航/广告，只留正文。'
    ].join('\n'),
    native: [
      '3. fetch_url(url: string)',
      '   抓取一个具体网页，返回标题和正文文本。',
      '   url 必须是完整的 http/https 地址。会自动剥掉 script/导航/广告，只留正文。'
    ].join('\n')
  },
  nativeDef: {
    name: 'fetch_url',
    description:
      '抓取指定网页的正文文本——用于 web_search 摘要看不出全貌时拉详情。返回标题 + 正文。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的 http/https 地址' }
      },
      required: ['url']
    }
  },
  extractTarget: (args) => asString(args.url),
  executor: async (args) => {
    const url = asString(args.url).trim()
    if (!url) {
      return { ok: false, content: '（系统）fetch_url 调用缺少 url 参数。' }
    }
    const page = await fetchUrl(url)
    return { ok: true, content: formatFetchedPageForLLM(page) }
  }
}

// exempt:true 因为「问用户」过 permission 闸门=问用户「我能不能问你」，套娃
const askUserPromptFragment = [
  'N. ask_user_question(question: string, options: string[], multiSelect?: boolean)',
  '   主动向用户发起一次询问。options 必须给 2-4 个具体备选项，',
  '   UI 会在选项下面自动追加一个「其他」自由输入框，用户可在其中自填，',
  '   也可以把「自填」与「勾选」并存（multiSelect=true 时尤其常见）。',
  '',
  '   什么时候该问：',
  '     - 用户的需求里有真正的多选一岔路口，且各分支会导致截然不同的工作产物（写哪个题目、用哪个工具、风格偏哪一边）',
  '     - 即将做一个不可逆 / 代价高的操作（删东西、发消息、提交代码）但你对用户意图不够确定',
  '     - 用户给的信息不足以决策，且本地查表 / web_search 也补不上这个空——只有用户自己能答',
  '',
  '   什么时候不该问：',
  '     - 答案能用 web_search / fetch_url / lookup_lore 拿到时——先查再说，别把本可独立完成的事推回给用户',
  '     - 用户已经在前文给过偏好或边界，再问就是"没在听"',
  '     - 只有"是/否"两个候选——这种用一句 say 直接问就够了，开个面板太重',
  '     - 同一轮对话里你已经问过一次，用户没换话题——别连环追问',
  '',
  '   options 写法：每项必须是用户能直接看懂、自带语义的具体备选项（"用 GPT-4 / 用 Claude 3.5 Sonnet" ✓；"选项 1 / 选项 2" ✗）。',
  '   不要塞「其他」「都行」「不知道」之类的兜底——UI 已经有「其他」输入框，模型再塞反而冗余。',
  '',
  '   multiSelect=true 适用于：清单式收集（"选你想关注的领域，可多选"），用户的回答天然是子集而非二选一。',
  '   默认 false（单选），不确定就走单选——多选要求用户多决策，认知负担更大。'
].join('\n')

const askUserDescriptor: ToolDescriptor = {
  id: 'builtin:ask_user_question',
  name: 'ask_user_question',
  source: 'builtin',
  displayName: 'ask_user_question',
  description: '主动向用户发起一次单选询问。options 给 2-4 个具体备选项；UI 会自动追加「其他...」自由输入。',
  exempt: true,
  promptFragment: {
    appLayer: askUserPromptFragment,
    native: askUserPromptFragment
  },
  nativeDef: {
    name: 'ask_user_question',
    description:
      '主动向用户发起一次询问。options 必须给 2-4 个具体备选项；UI 会在选项下方常驻一个「其他」自由输入框。multiSelect=true 时允许同时勾选多项 + 自由输入并存。回传内容会清晰区分用户「勾选了哪些 / 自填了什么」。',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的具体问题，1 句话即可'
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: '2-4 个具体备选项；不要塞「其他」「都行」之类的兜底——UI 会自动追加自由输入框'
        },
        multiSelect: {
          type: 'boolean',
          description:
            '是否允许多选，默认 false（单选）。仅当用户回答天然是子集（如"选你想关注的领域，可多选"）时才设 true。'
        }
      },
      required: ['question', 'options']
    }
  },
  extractTarget: (args) => asString(args.question),
  executor: async (args) => {
    const question = asString(args.question).trim()
    if (!question) {
      return { ok: false, content: '（系统）ask_user_question 缺少 question 参数。' }
    }
    const rawOpts = Array.isArray(args.options) ? args.options : []
    const options = rawOpts.map(asString).map((s) => s.trim()).filter(Boolean).slice(0, 4)
    if (options.length < 2) {
      return {
        ok: false,
        content: '（系统）ask_user_question 至少需要 2 个候选项；这次只识别到 ' + options.length + ' 个。'
      }
    }
    const multiSelect = args.multiSelect === true
    const resp = await requestAskUser(question, options, multiSelect)
    if (resp.canceled) {
      return {
        ok: true,
        content:
          '（用户跳过了这次提问，没有勾选任何选项也没自填。这通常表示这个问题问得不合时宜或他暂时不想答——别再追问同一问题，用一句轻描淡写的话过渡，或换一个角度推进。）'
      }
    }
    // 区分「勾选既定 options」vs「其他自填」——multiSelect 下两者可能并存
    const parts: string[] = []
    if (resp.selectedOptions.length > 0) {
      const tag = resp.selectedOptions.length === 1 ? '用户选择' : '用户多选勾中'
      parts.push(`${tag}：${resp.selectedOptions.join('、')}`)
    }
    if (resp.otherText) {
      parts.push(`用户自由输入：${resp.otherText}`)
    }
    const content = parts.length > 0 ? parts.join('；') : '（用户没作出有效选择。）'
    return { ok: true, content }
  }
}

// 必须在 loadSettings() 后、其他模块首次查 registry 前调用
export function bootstrapBuiltinTools(): void {
  registerTool(lookupLoreDescriptor)
  registerTool(webSearchDescriptor)
  registerTool(openWebSearchDescriptor)
  registerTool(fetchUrlDescriptor)
  registerTool(askUserDescriptor)
}
