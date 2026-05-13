import { ChatMessage, ModelTier, ProviderInstance, TestProviderResult, ToolPolicy } from '@shared/types'
import { AnthropicMessageInput, postChat, streamChatNative } from './transport'
import {
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicToolDef,
  AnthropicToolUseBlock,
  AnthropicWebSearchToolResultBlock
} from './transform-responses'
import { executeTool, ToolCall, ToolResult } from './tools'
import { abortAllPending, pickRejectReply, requestPermission } from './permission'
import { abortAllPendingAskUser } from './askUser'
import { listEnabledTools } from './registry'
import { loadSettings } from '../store'
import type { PromptMode } from '../promptBuilder'
import { openStreamLog, type StreamLogger } from './streamLog'

export interface StreamHandle {
  abort: () => void
}

export interface UsageDelta {
  inputTokens: number
  outputTokens: number
}

// app-layer 协议：模型输出严格 JSON
export interface AssistantTurn {
  say: string
  mood: string
  tool: ToolCall | null
  tool_describe: string
  // ≤10 字；无主题给空串避免多一轮标题生成
  title: string
}

export interface StreamCallbacks {
  onChunk: (text: string) => void
  onMood: (mood: string) => void
  onToolDescribe: (tool: ToolCall, describe: string) => void
  onToolResult: (result: ToolResult) => void
  onTitle: (title: string) => void
  onUsage: (usage: UsageDelta) => void
  onDone: () => void
  onError: (message: string) => void
  // 用户主动中断：跳过 failover / 延伸阅读
  onAborted: () => void
}

// app-layer 非流式整段拿，前端按打字机节奏吐
const FAKE_STREAM_CHARS_PER_TICK = 2
const FAKE_STREAM_TICK_MS = 40

// 「我去查/稍等/马上」嘴炮——必须含明确指代前缀，避开「我刚才查了…」过去式
const HOLLOW_INTENT_RE =
  /(?:我去|我来查|我来看|我帮你|让我(?:查|搜|看)|查一下|搜一下|看一下|搜搜|稍等|马上|等等|等我)/

const MAX_HOLLOW_CORRECTIONS = 1
const MAX_EMPTY_RESPONSE_CORRECTIONS = 2

// body.tools 挂 31 CC 工具 + system 真 CC 内容 → 模型被诱导走 native tool_use 而非 app-layer JSON；
// 拦截后转译成 hiliu 内置工具走工具循环，回灌时催它换协议。
interface NativeToolMapping {
  hiliuName: string
  transformArgs: (input: unknown) => Record<string, unknown>
}

const NATIVE_TO_HILIU_TOOL_MAP: Record<string, NativeToolMapping> = {
  WebSearch: {
    hiliuName: 'web_search',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return { query: typeof i.query === 'string' ? i.query : String(i.query ?? '') }
    }
  },
  WebFetch: {
    hiliuName: 'fetch_url',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return { url: typeof i.url === 'string' ? i.url : String(i.url ?? '') }
    }
  },
  // 多 question 形态在 hiliu 里没对应物，取 questions[0]
  AskUserQuestion: {
    hiliuName: 'ask_user_question',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const questions = Array.isArray(i.questions) ? i.questions : []
      const q = (questions[0] ?? {}) as Record<string, unknown>
      const opts: string[] = Array.isArray(q.options)
        ? (q.options as Array<unknown>)
            .map((o) => {
              if (typeof o === 'string') return o
              if (o && typeof o === 'object' && 'label' in o) {
                return String((o as Record<string, unknown>).label ?? '')
              }
              return String(o ?? '')
            })
            .filter((s) => s.length > 0)
        : []
      return {
        question: typeof q.question === 'string' ? q.question : '',
        options: opts,
        multiSelect: !!q.multiSelect
      }
    }
  },
  // CC limit 按行算、hiliu maxBytes 按字节算——粗按 200 字节/行折算
  Read: {
    hiliuName: 'read_file',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const out: Record<string, unknown> = {
        path: typeof i.file_path === 'string' ? i.file_path : String(i.file_path ?? '')
      }
      if (typeof i.limit === 'number' && i.limit > 0) {
        out.maxBytes = Math.min(i.limit * 200, 1024 * 1024)
      }
      return out
    }
  },
  // search_file 走 Everything 索引；CC 的 path 限定要翻成 `path:<dir> <pattern>`
  Glob: {
    hiliuName: 'search_file',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const pattern = typeof i.pattern === 'string' ? i.pattern : String(i.pattern ?? '')
      const dir = typeof i.path === 'string' ? i.path.trim() : ''
      const query = dir ? `path:"${dir}" ${pattern}` : pattern
      return { query }
    }
  },
  // hiliu 的 path 必填（CC 默认 cwd），缺时回退家目录
  Grep: {
    hiliuName: 'search_in_files',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const out: Record<string, unknown> = {
        pattern: typeof i.pattern === 'string' ? i.pattern : String(i.pattern ?? ''),
        path: typeof i.path === 'string' && i.path.trim() ? i.path : '~'
      }
      if (typeof i.glob === 'string' && i.glob.trim()) out.glob = i.glob
      return out
    }
  },
  Write: {
    hiliuName: 'write_file',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return {
        path: typeof i.file_path === 'string' ? i.file_path : String(i.file_path ?? ''),
        content: typeof i.content === 'string' ? i.content : String(i.content ?? '')
      }
    }
  },
  Edit: {
    hiliuName: 'edit_file',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return {
        path: typeof i.file_path === 'string' ? i.file_path : String(i.file_path ?? ''),
        old_string: typeof i.old_string === 'string' ? i.old_string : String(i.old_string ?? ''),
        new_string: typeof i.new_string === 'string' ? i.new_string : String(i.new_string ?? ''),
        replace_all: i.replace_all === true
      }
    }
  },
  Bash: {
    hiliuName: 'bash_exec',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const out: Record<string, unknown> = {
        command: typeof i.command === 'string' ? i.command : String(i.command ?? '')
      }
      if (typeof i.timeout === 'number' && i.timeout > 0) out.timeout = i.timeout
      return out
    }
  },
  PowerShell: {
    hiliuName: 'ps_exec',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const out: Record<string, unknown> = {
        command: typeof i.command === 'string' ? i.command : String(i.command ?? '')
      }
      if (typeof i.timeout === 'number' && i.timeout > 0) out.timeout = i.timeout
      return out
    }
  },
  PushNotification: {
    hiliuName: 'push_notification',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return { message: typeof i.message === 'string' ? i.message : String(i.message ?? '') }
    }
  },
  CronCreate: {
    hiliuName: 'cron_create',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      const out: Record<string, unknown> = {
        cron: typeof i.cron === 'string' ? i.cron : String(i.cron ?? ''),
        prompt: typeof i.prompt === 'string' ? i.prompt : String(i.prompt ?? '')
      }
      if (typeof i.recurring === 'boolean') out.recurring = i.recurring
      return out
    }
  },
  CronDelete: {
    hiliuName: 'cron_delete',
    transformArgs: (input) => {
      const i = (input ?? {}) as Record<string, unknown>
      return { id: typeof i.id === 'string' ? i.id : String(i.id ?? '') }
    }
  },
  CronList: {
    hiliuName: 'cron_list',
    transformArgs: () => ({})
  }
}

function pascalToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-+/g, '_')
    .toLowerCase()
}

// 三层 fallback：精确表 → 大小写扫描 → snake_case 查 registry；全 miss 才进软拦截/硬拒绝
function lookupNativeMapping(nativeName: string): NativeToolMapping | null {
  const direct = NATIVE_TO_HILIU_TOOL_MAP[nativeName]
  if (direct) return direct

  const lower = nativeName.toLowerCase()
  for (const k of Object.keys(NATIVE_TO_HILIU_TOOL_MAP)) {
    if (k.toLowerCase() === lower) return NATIVE_TO_HILIU_TOOL_MAP[k]
  }

  const snake = pascalToSnake(nativeName)
  const enabled = listEnabledTools(loadSettings().tools.policies)
  const hit = enabled.find((d) => d.name === snake)
  if (hit) {
    return {
      hiliuName: hit.name,
      transformArgs: (input) => (input ?? {}) as Record<string, unknown>
    }
  }

  return null
}

// 没合理对应物的 native CC 工具——注入中性失败结果让模型换路径，避免卡死
const NATIVE_SOFT_INTERCEPT_REASONS: Record<string, string> = {
  EnterPlanMode:
    '桌宠运行时没有 plan mode 概念——这条工具只对 Claude Code 编辑器生效。如需向用户确认计划，请改用 ask_user_question 列出 2-4 条候选方案让用户选。',
  ExitPlanMode:
    '桌宠运行时没有 plan mode 概念——这条工具只对 Claude Code 编辑器生效。当前对话直接给出回答即可。',
  EnterWorktree:
    '桌宠运行时没有 git worktree 隔离概念。如需在某分支干活，请用 bash_exec 跑 git 命令。',
  ExitWorktree:
    '桌宠运行时没有 git worktree 隔离概念。如需切回某分支，请用 bash_exec 跑 git 命令。',
  Skill: '桌宠运行时不维护 Claude Code 的 skill 注册表。请直接按对话推进，无需 invoke skill。',
  Agent:
    '桌宠运行时不支持 sub-agent 派生（开 agent 等于在 hiliu 里再开一个 hiliu，不合适）。本轮请你自己直接处理，需要研究信息就用 web_search / fetch_url，需要操作系统就用 bash_exec / ps_exec。',
  TaskCreate:
    '桌宠运行时没有 task list UI。如要追踪步骤，写在你 say 里告诉用户即可，无需调用 task 工具。',
  TaskGet: '桌宠运行时没有 task list 状态可查。请直接基于对话上下文回答。',
  TaskList: '桌宠运行时没有 task list 状态可查。请直接基于对话上下文回答。',
  TaskUpdate: '桌宠运行时没有 task list 状态可改。如要标记进度，写在你 say 里告诉用户即可。',
  TaskOutput:
    '桌宠运行时不维护 background task 句柄——bash_exec / ps_exec 永远同步执行并直接返回 stdout/stderr。',
  TaskStop:
    '桌宠运行时不维护 background task 句柄——bash_exec / ps_exec 是同步执行，不存在 task_id 可停。',
  ScheduleWakeup:
    '桌宠运行时没有 /loop 模式。如要定时触发某操作，请用 cron_create（标准 5 字段 cron 语法）。',
  Monitor:
    '桌宠运行时不支持后台流式监控。如要长期观察某状态，每隔几秒用 bash_exec 跑一次 check 命令、或用 cron_create 周期性触发。',
  RemoteTrigger:
    '桌宠运行时不接 claude.ai 的 remote-trigger API——这是 Claude Code 客户端独有能力。',
  LSP:
    '桌宠运行时未集成 Language Server Protocol。如要找符号定义，用 search_in_files 配合 regex 搜（如 `function\\s+myFunc` 或 `class\\s+MyClass`）。',
  NotebookEdit:
    '桌宠运行时不解析 Jupyter notebook 单元结构。如要改 .ipynb，先用 read_file 看内容、再用 edit_file 替换字符串。'
}

// 工具结果回灌时追加在 user 消息尾——给模型「条件分支选一个」而非自由决策
function toolResultFollowupPrompt(toolResult: ToolResult): string {
  const tail = '**任何情况下都不允许**输出 `{"say":"", "tool":null}` 直接收尾——那等于把用户晾着没动静，是断流不是结束。'

  if (!toolResult.ok) {
    return [
      '（系统·下一步）这次工具调用失败了——但**不要急着收手**，下一个 JSON 里立即换个角度再试一次：',
      '- 是 web_search 失败 → 换关键词（中文不行换英文 / 太宽泛改具体 / 加权威源限定词如「百度百科」「yahoo finance」「官网」）再调 web_search。',
      '- 是 fetch_url 失败 → 从上一次搜索结果里换一条更权威的链接，或者干脆改 query 重搜。',
      '- 也别在 say 里写「我搜不到」「这个查不到」就 tool=null 收手——再尝试一次再下结论。',
      tail
    ].join('\n')
  }

  if (toolResult.name === 'web_search' || toolResult.name === 'open_web_search') {
    return [
      '（系统·下一步）拿到搜索结果后请按下面三档**选一个**走：',
      '1. **摘要里就能看到用户要的答案** → 下一个 JSON：`tool=null` + `say` 用一两句话像聊天那样说出来（口语化，别用「为您查询到」这种腔调；可以提一下来源——「我在百度百科看到的」）。',
      '2. **摘要里只看到相关链接、答案要点进去看**（公司地址 / 人物详情 / 产品参数 / 实时数据 / 价格 / 比分 / 天气等） → 下一个 JSON 里**必须**调 `fetch_url`，挑 1-2 条最权威的（百度百科 / 维基百科 / 政府站 / 官方文档 / 雪球 / 雅虎财经 / 知乎专栏），样板：`"tool":{"name":"fetch_url","args":{"url":"https://..."}}`。',
      '3. **结果是首页 / 字典释义 / 商品列表 / 大量重复站 / 与问题不沾边**（弱结果） → 下一个 JSON 里**必须**改 query 再调 `web_search`：换英文 / 换 ticker（如「BYD stock」「002594 现价」）/ 加「百度百科」「官方网站」「yahoo finance」之类限定词。',
      '注意：摘要永远是浓缩版，对「事实查询」不够用——别只看摘要就给「查不到」结论。',
      '查到、查全了再收——别为了"快点结束"凑合。但持续几轮都拿不到关键数据时也要诚实收手，在 say 里告诉用户你试了什么、去哪儿能查到，不要空回。',
      tail
    ].join('\n')
  }

  if (toolResult.name === 'fetch_url') {
    return [
      '（系统·下一步）拿到网页正文后请按下面三档**选一个**走：',
      '1. **正文里能找到答案** → 下一个 JSON：`tool=null` + `say` 用一两句话自然地说出来（不要复读整段正文——抓重点）。',
      '2. **正文只覆盖部分**（用户问多个对象，这页只覆盖了一个；或答案需要多源印证） → 下一个 JSON 里**必须**继续：`fetch_url` 钻另一条权威链接，或者改 query 调 `web_search` 找剩下的对象。',
      '3. **正文是错误页 / 空白 / 主题不对** → 改 query 再调 `web_search`，从新结果里换一条更权威的链接。',
      '上限提醒：本轮最多 5 次工具调用，超了就收手——收手时 say 里告诉用户你试了什么。',
      tail
    ].join('\n')
  }

  // shell 命令最容易"无输出 → 编个成功结论"——副作用类命令必须回读再下结论
  if (toolResult.name === 'ps_exec' || toolResult.name === 'bash_exec') {
    const sawNoOutput = toolResult.content.includes('(命令无 stdout/stderr 输出')
    return [
      '（系统·下一步）拿到 shell 执行结果后请按下面分支**选一个**走：',
      '- **执行的是只读命令**（dir / ls / cat / Get-Process / curl GET 之类，目的就是看结果） → 下一个 JSON：`tool=null` + `say` 把结果用一两句话告诉用户。',
      '- **执行的是改变状态的命令**（音量/进程/窗口/媒体键/SendKeys/setx/注册表写入等） → 下一个 JSON 里**必须**先调一个查询工具回读真实状态（例如改音量后调 `get_volume`，杀进程后调 `ps_exec` 跑 `Get-Process`，按媒体键后等一下再读状态），**确认**生效之后再回 say 给用户结论。',
      sawNoOutput
        ? '- **特别提醒**：本次命令 stdout/stderr 都为空——这**绝不**等于「执行成功」。SendKeys / 媒体键 / 静默改注册表都会无输出，但可能根本没生效。**严禁**直接说"搞定了"——必须按上一条先回读再下结论。'
        : '',
      '- 不允许在没验证的情况下编一个具体数值（比如说"音量已经调到 30%"）——你没读过就不知道。',
      tail
    ].filter((s) => s).join('\n')
  }

  return [
    '（系统·下一步）拿到工具结果后请基于结果继续推进：',
    '- 信息够答 → 下一个 JSON：`tool=null` + `say` 自然回答，口语化、像聊天。',
    '- 还需要更多信息 → 下一个 JSON 里调下一个工具继续。',
    tail
  ].join('\n')
}

// 先搜再答：daily/sonnet 抽 query（haiku 无 anthropic-beta，网关返 403），不过 permission gate
async function extractPreSearchQuery(
  provider: ProviderInstance,
  userText: string,
  signal: AbortSignal,
  tier: ModelTier = 'daily'
): Promise<string> {
  const sys = [
    'You extract a search query from a user message.',
    '',
    'Rules:',
    '- Output the query string alone. No quotes, no JSON, no explanation, no preface, no thinking. Bare text only, single line.',
    '- Only emit a query when the answer needs fresh, external, or verifiable facts: prices, dates, news, definitions, people, products, places, events, current state.',
    '- Output an empty line (nothing at all) for: greetings ("hi", "你好"), small talk, emotional check-ins ("I feel tired"), pure coding/writing requests ("write a Python sort"), opinion solicitations the model can answer from itself, or anything else with no factual lookup target.',
    '- Length 5–15 characters. Distill keywords from the user message, do not echo the full sentence.',
    '- The query is the subject the user asks about, not the answer. For "what is X" / "how much is X" / "when is X" questions, emit X itself. Do not pre-fill values you happen to know.',
    '- Preserve original-language terms verbatim: brand names, ticker symbols (NVDA, 002594), product names, English jargon, person names. For zh queries prefer zh keywords; for en queries prefer en. Mixing is fine when the authoritative source is foreign (e.g. "BYD stock price" beats "比亚迪股价" for Yahoo Finance).',
    '- One query only. If multiple angles exist, pick the one most likely to surface an authoritative source (Wikipedia, Baidu Baike, official site, Yahoo Finance, gov page).',
    '',
    'Examples:',
    'User: 你好 → (empty)',
    'User: 我有点烦 → (empty)',
    'User: 帮我写段 Python 排序代码 → (empty)',
    'User: 你觉得这个方案怎么样 → (empty)',
    'User: 光速是多少 → 光速',
    'User: 珠穆朗玛峰多高 → 珠穆朗玛峰 海拔',
    'User: 圆周率是多少 → 圆周率',
    'User: 刘看山是谁 → 刘看山 知乎吉祥物',
    'User: BYD 现在股价多少 → BYD stock price',
    'User: 今天上海天气 → 上海天气',
    'User: Anthropic 最新模型叫什么 → Anthropic Claude latest model',
    'User: 002594 现价 → 002594 股价 雪球',
    'User: 美联储下次议息会议什么时候 → FOMC next meeting date'
  ].join('\n')

  try {
    const resp = await postChat(
      provider,
      [
        { role: 'system', content: sys },
        { role: 'user', content: userText }
      ],
      { signal, tier }
    )
    const out = resp.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    // 超长 = 模型整句复述了，丢弃避免脏 query
    if (out.length > 60) {
      console.warn(`[pre-search] query 过长丢弃 (len=${out.length}): ${out.slice(0, 80)}`)
      return ''
    }
    return out
  } catch (err) {
    console.warn(`[pre-search] keyword extract 失败: ${(err as Error).message}`)
    return ''
  }
}

function emptyResponseCorrectionPrompt(correction: number): string {
  const isLast = correction >= MAX_EMPTY_RESPONSE_CORRECTIONS
  const lines = [
    `（系统·空响应守卫·第 ${correction} 次）你刚才输出了 \`{"say":"", "tool":null}\`——这等于把用户晾在那里没任何回应，是断流不是收尾。前置提示已经给过你三档分支了，你没选任何一档。`,
    '本协议是**单轮闭环**：你这一轮交完 JSON 就结束了，没有"下一轮自动接着干"的机会。',
    '**立即在你的下一个 JSON 里二选一**：',
    '- A) 基于上面已经拿到的工具结果，把能给的最佳回答用口语化的话写到 `say` 里——哪怕只是「我大致看了下，是 XX 那块儿，你想知道更细的我再翻翻」这种程度也行；`tool` 设为 `null`。**注意**：你是小刘（北极狐），不是 AI 助理，别说"为您查询""建议您"这种腔调。',
    '- B) 调下一个工具继续推进：`fetch_url` 钻一条最权威的链接拿详情，或者改 query 调 `web_search` 重搜。样板：`"tool":{"name":"fetch_url","args":{"url":"https://..."}}` 或 `"tool":{"name":"web_search","args":{"query":"换个角度的关键词"}}`。'
  ]
  if (isLast) {
    lines.push(
      `**这是最后一次纠错机会**（已用 ${correction}/${MAX_EMPTY_RESPONSE_CORRECTIONS} 次）——再空响应我就直接告诉用户失败了，那对你这一轮的努力是浪费。`
    )
  }
  return lines.join('\n')
}

export async function testProvider(
  provider: ProviderInstance
): Promise<TestProviderResult> {
  if (!provider.apiKey.trim()) return { ok: false, message: 'API Key 为空' }
  const startedAt = Date.now()
  try {
    await postChat(provider, [{ role: 'user', content: '你好' }], { maxTokens: 16 })
    return { ok: true, message: '连接成功', latencyMs: Date.now() - startedAt }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// cc-native 专用：mood 没信号位 → 固定 'normal'；web_search 由 Anthropic 服务端执行
function buildNativeTools(policies: Record<string, ToolPolicy>): AnthropicToolDef[] {
  return listEnabledTools(policies)
    .map((d) => d.nativeDef)
    .filter((x): x is AnthropicToolDef => x !== null)
}

function describeNativeCall(call: ToolCall): string {
  switch (call.name) {
    case 'web_search':
      return `正在搜索：${stringArg(call.args.query)}`
    case 'fetch_url':
      return `正在打开网页：${stringArg(call.args.url)}`
    case 'lookup_lore':
      return `查一下我自己的设定：${stringArg(call.args.topic)}`
    default:
      return `正在调用 ${call.name}`
  }
}

function stringArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

// server web_search 已在 Anthropic 端消费完计费——这里仅做 UI 展示用，无事前阻拦能力
function formatServerWebSearchResult(
  block: AnthropicWebSearchToolResultBlock
): ToolResult {
  if (Array.isArray(block.content)) {
    const n = block.content.length
    if (n === 0) return { name: 'web_search', ok: true, content: '搜了，但一条也没拿到' }
    const previews = block.content
      .slice(0, 3)
      .map((r) => r.title || r.url)
      .filter(Boolean)
      .join('、')
    return {
      name: 'web_search',
      ok: true,
      content: previews ? `拿到 ${n} 条结果：${previews}${n > 3 ? '…' : ''}` : `拿到 ${n} 条结果`
    }
  }
  return {
    name: 'web_search',
    ok: false,
    content: `搜索失败：${block.content.error_code}`
  }
}

// 救援 3 类模型常见错：```json 围栏 / 前后解释文字 / say 内未转义引号
function stripJsonFence(text: string): string {
  if (!text) return ''
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim()
}

// 利用「say 后必跟 ,"mood":」做结构边界反向定位 say 内未转义引号；tool 一律置空
function recoverFromBrokenJson(jsonStr: string): AssistantTurn | null {
  if (!jsonStr) return null
  const sayMatch = jsonStr.match(/"say"\s*:\s*"([\s\S]*?)"\s*,\s*"mood"\s*:/)
  if (!sayMatch) return null
  const moodMatch = jsonStr.match(/"mood"\s*:\s*"([^"\n]*)"/)
  const say = sayMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  const mood = moodMatch?.[1]?.trim() || 'normal'
  return { say, mood, tool: null, tool_describe: '', title: '' }
}

function tryExtractJsonObject(text: string): string | null {
  if (!text) return null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return null
}

function parseAssistantTurn(text: string): AssistantTurn {
  const fallback: AssistantTurn = {
    say: stripJsonFence(text),
    mood: 'normal',
    tool: null,
    tool_describe: '',
    title: ''
  }
  const jsonStr = tryExtractJsonObject(text)
  if (!jsonStr) return fallback
  let obj: unknown
  try {
    obj = JSON.parse(jsonStr)
  } catch {
    const recovered = recoverFromBrokenJson(jsonStr)
    return recovered ?? fallback
  }
  if (!obj || typeof obj !== 'object') return fallback
  const o = obj as Record<string, unknown>
  const say = typeof o.say === 'string' ? o.say : ''
  const mood = typeof o.mood === 'string' && o.mood.trim() ? o.mood : 'normal'
  const td = typeof o.tool_describe === 'string' ? o.tool_describe : ''
  // 截 10 字防 UI 撑爆
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 10) : ''
  let tool: ToolCall | null = null
  if (o.tool && typeof o.tool === 'object') {
    const t = o.tool as Record<string, unknown>
    if (typeof t.name === 'string' && t.name.trim()) {
      const args =
        t.args && typeof t.args === 'object' ? (t.args as Record<string, unknown>) : {}
      tool = { name: t.name, args }
    }
  }
  return { say, mood, tool, tool_describe: td, title }
}

export interface StreamChatOptions {
  buildSystem?: (mode: PromptMode) => string
  tier?: ModelTier
}

export function streamChat(
  provider: ProviderInstance,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options: StreamChatOptions = {}
): StreamHandle {
  const controller = new AbortController()
  let aborted = false
  let fakeTimer: NodeJS.Timeout | null = null

  const streamLog: StreamLogger = openStreamLog({
    providerId: provider.id,
    providerName: provider.name,
    model: provider.models?.[options.tier ?? 'daily'] ?? '?',
    tier: options.tier ?? 'daily',
    mode: 'app-layer'
  })

  const stopFakeTimer = (): void => {
    if (fakeTimer) {
      clearInterval(fakeTimer)
      fakeTimer = null
    }
  }

  const fakeStream = (text: string): Promise<void> =>
    new Promise((resolve) => {
      if (!text) return resolve()
      let cursor = 0
      fakeTimer = setInterval(() => {
        if (aborted) {
          stopFakeTimer()
          return resolve()
        }
        const next = Math.min(cursor + FAKE_STREAM_CHARS_PER_TICK, text.length)
        callbacks.onChunk(text.slice(cursor, next))
        cursor = next
        if (cursor >= text.length) {
          stopFakeTimer()
          resolve()
        }
      }, FAKE_STREAM_TICK_MS)
    })

  // CC 网关白名单只认 31 个内置工具，自定义工具触发 403 → 恒用 app-layer 协议
  const mode: PromptMode = 'app-layer'

  const withSystemPrompt = <T extends { role: string; content: unknown }>(
    base: T[],
    factory: () => T
  ): T[] => {
    if (!options.buildSystem) return [...base]
    const sysMsg = factory()
    const rest = base.filter((m) => m.role !== 'system')
    return [sysMsg, ...rest]
  }

  const runAppLayer = async (): Promise<void> => {
    // 带图工具回灌：content 升级成 [image, text] 块，ChatMessage 不扩
    const initialChat: AnthropicMessageInput[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
    const working: AnthropicMessageInput[] = withSystemPrompt(initialChat, () => ({
      role: 'system',
      content: options.buildSystem!('app-layer')
    }))
    {
      const sys = working.find((m) => m.role === 'system')
      const sysContent = typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content)
      streamLog.event('init', {
        systemPromptLen: sysContent?.length ?? 0,
        systemPrompt: sysContent ?? '',
        messages: working
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role,
            contentPreview:
              typeof m.content === 'string'
                ? m.content.slice(0, 500)
                : `[blocks×${(m.content as unknown[]).length}]`
          }))
      })
    }
    let hollowCorrections = 0
    let emptyResponseCorrections = 0
    // 仅当注入过工具结果/纠错提示后才触发空响应守卫——首轮直接空响应走兜底文案更友好
    let shouldGuardEmpty = false

    const lastUserMsg = [...working].reverse().find(
      (m) => m.role === 'user' && typeof m.content === 'string' && (m.content as string).trim().length > 0
    )
    const lastUserText = typeof lastUserMsg?.content === 'string' ? (lastUserMsg.content as string).trim() : ''

    const wsPolicy: ToolPolicy = (loadSettings().tools?.policies?.['web_search'] ?? 'ask') as ToolPolicy
    const preSearchEnabled = lastUserText.length >= 2 && wsPolicy !== 'disabled'

    if (preSearchEnabled) {
      streamLog.event('pre-search-start', { userTextPreview: lastUserText.slice(0, 200) })
      const query = await extractPreSearchQuery(provider, lastUserText, controller.signal)
      if (aborted) return

      if (query) {
        streamLog.event('pre-search-query', { query })
        const call: ToolCall = { name: 'web_search', args: { query } }
        const describe = `在网上找「${query}」`
        callbacks.onToolDescribe(call, describe)
        const toolResult = await executeTool(call)
        if (aborted) return
        callbacks.onToolResult(toolResult)
        streamLog.event('pre-search-result', {
          ok: toolResult.ok,
          contentPreview: toolResult.content.slice(0, 500),
          contentLen: toolResult.content.length
        })

        // 用合法 JSON shape 当 fake assistant turn——空串会被上游拒
        const fakeAssistantTurn = JSON.stringify({
          say: '',
          mood: 'normal',
          tool: { name: 'web_search', args: { query } },
          tool_describe: describe,
          title: ''
        })
        working.push({ role: 'assistant', content: fakeAssistantTurn })
        const tag = `（工具「${toolResult.name}」结果）${toolResult.content}`
        const followup = toolResultFollowupPrompt(toolResult)
        working.push({ role: 'user', content: `${tag}\n\n${followup}` })
        shouldGuardEmpty = true
      } else {
        streamLog.event('pre-search-skip', { reason: 'extractor returned empty (闲聊/无需搜索)' })
      }
    }

    try {
      for (let round = 0; ; round++) {
        if (aborted) return
        const resp = await postChat(provider, working, {
          signal: controller.signal,
          tier: options.tier
        })
        if (aborted) return

        callbacks.onUsage({
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens
        })

        const rawText = resp.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')

        streamLog.event('round', {
          round,
          rawText,
          toolUseBlocks: resp.content
            .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
            .map((b) => ({ name: b.name, input: b.input })),
          usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
          stopReason: resp.stop_reason ?? null
        })

        // body.tools 挂 31 CC 工具 + 真 CC system → 模型被诱导吐 native tool_use；拦截转译走工具循环
        const toolUseBlocks = resp.content.filter(
          (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
        )
        const looksLikeJson = rawText.trim().startsWith('{') || rawText.includes('```json')

        if (toolUseBlocks.length > 0 && !looksLikeJson) {
          const firstTool = toolUseBlocks[0]
          const mapping = lookupNativeMapping(firstTool.name)

          console.warn(
            `[streamChat:app-layer] 拦截 native tool_use：name=${firstTool.name} mapped=${mapping?.hiliuName ?? '✗'}`
          )
          streamLog.event('native-intercept', {
            round,
            nativeName: firstTool.name,
            input: firstTool.input,
            mapped: mapping?.hiliuName ?? null
          })

          if (!mapping) {
            // 软拦截表里有就注入中性失败结果换路径；没有才硬拒绝 + 协议纠错
            const softReason = NATIVE_SOFT_INTERCEPT_REASONS[firstTool.name]
            if (softReason) {
              const fakeResult: ToolResult = {
                name: firstTool.name,
                ok: false,
                content: softReason
              }
              callbacks.onToolResult(fakeResult)
              working.push({
                role: 'assistant',
                content: `（已尝试调用 ${firstTool.name}）`
              })
              const tag = `（工具「${firstTool.name}」结果）${softReason}`
              const followup = toolResultFollowupPrompt(fakeResult)
              working.push({ role: 'user', content: `${tag}\n\n${followup}` })
              shouldGuardEmpty = true
              continue
            }
            const enabledNames = listEnabledTools(loadSettings().tools.policies)
              .map((d) => d.name)
              .join(' / ')
            working.push({
              role: 'assistant',
              content: `（试图调用未授权原生工具 ${firstTool.name}）`
            })
            working.push({
              role: 'user',
              content:
                `（hiliu 运行时·协议层提示）你看到的 native CC 工具 schema 是上游网关协议层的装饰字段，` +
                `本运行时只对接 hiliu 自有工具集，\`${firstTool.name}\` 不在白名单内、调用已丢弃。\n` +
                `当前可用工具：${enabledNames}。\n` +
                '请改用 app-layer JSON 协议输出，例如 `{"say":"...","mood":"think","tool":{"name":"<上面任一>","args":{...}},"tool_describe":"...","title":""}`。' +
                '直接输出 JSON 即可，不必解释切换原因。'
            })
            shouldGuardEmpty = true
            continue
          }

          const args = mapping.transformArgs(firstTool.input)
          const call: ToolCall = { name: mapping.hiliuName, args }
          const describe = describeNativeCall(call)

          callbacks.onMood('normal')

          const decision = await requestPermission(call, describe)
          if (aborted) return
          streamLog.event('tool-decision', { round, name: call.name, decision })
          if (decision === 'deny') {
            await fakeStream(pickRejectReply())
            callbacks.onDone()
            return
          }
          if (decision === 'deny-disabled') {
            const fakeResult: ToolResult = {
              name: call.name,
              ok: false,
              content: `（系统）工具 ${call.name} 当前不可用（已被禁用）。请改用其他工具，或者按 app-layer JSON 协议输出 \`{say,mood,tool,tool_describe,title}\` 直接答复用户。`
            }
            callbacks.onToolResult(fakeResult)
            working.push({
              role: 'assistant',
              content: `（已尝试调用 ${firstTool.name}）`
            })
            const tag = `（工具「${call.name}」结果）${fakeResult.content}`
            const followup = toolResultFollowupPrompt(fakeResult)
            working.push({ role: 'user', content: `${tag}\n\n${followup}` })
            shouldGuardEmpty = true
            continue
          }

          callbacks.onToolDescribe(call, describe)
          const toolResult = await executeTool(call)
          if (aborted) return
          console.log(
            `[streamChat:app-layer] (native拦截) toolResult ok=${toolResult.ok} content="${toolResult.content.slice(0, 100).replace(/\n/g, ' ')}"`
          )
          streamLog.event('tool-result', {
            round,
            via: 'native-mapped',
            name: toolResult.name,
            ok: toolResult.ok,
            contentPreview: toolResult.content.slice(0, 800),
            contentLen: toolResult.content.length,
            hasParts: !!(toolResult.parts && toolResult.parts.length)
          })
          callbacks.onToolResult(toolResult)

          // 用 string 占位避免 tool_use block 又诱导下一轮 native
          working.push({
            role: 'assistant',
            content: `（已为用户调用 ${firstTool.name} 并拿到结果）`
          })
          const tag = `（工具「${toolResult.name}」结果）${toolResult.content}`
          const followup = toolResultFollowupPrompt(toolResult)
          const enabledNamesForReminder = listEnabledTools(loadSettings().tools.policies)
            .map((d) => d.name)
            .join(' / ')
          const protocolReminder =
            '\n\n（hiliu 运行时·协议层提示）你刚才已被自动转译成 hiliu 工具 `' +
            mapping.hiliuName +
            '` 并跑通；上游 native CC 工具 schema 仅用于网关协议握手，不是本运行时实际可用的工具。' +
            '下一轮请直接用 app-layer JSON 协议：' +
            '`{"say":"...","mood":"...","tool":null/{...},"tool_describe":"...","title":"..."}`，' +
            `工具名从这里选（snake_case）：${enabledNamesForReminder}。`
          working.push({
            role: 'user',
            content: `${tag}\n\n${followup}${protocolReminder}`
          })
          shouldGuardEmpty = true
          continue
        }

        const turn = parseAssistantTurn(rawText)
        console.log(`[streamChat:app-layer] title="${turn.title}" mood="${turn.mood}" tool=${turn.tool?.name ?? 'null'}`)
        streamLog.event('parsed', {
          round,
          say: turn.say,
          mood: turn.mood,
          title: turn.title,
          tool_describe: turn.tool_describe,
          tool: turn.tool ? { name: turn.tool.name, args: turn.tool.args } : null
        })
        if (turn.tool) {
          console.log(`[streamChat:app-layer] tool.args=${JSON.stringify(turn.tool.args)}`)
        } else if (rawText && /tool|"name"/.test(rawText)) {
          console.log(`[streamChat:app-layer] raw(no-tool-parsed)="${rawText.slice(0, 200)}"`)
        }
        callbacks.onMood(turn.mood)
        if (turn.title) callbacks.onTitle(turn.title)

        // 嘴炮守卫必须前置：否则"我去查..."先吐给用户，下一轮真答复来时 UX 两段割裂
        const sayTrim = turn.say.trim()
        const willTriggerHollow =
          !turn.tool &&
          sayTrim !== '' &&
          HOLLOW_INTENT_RE.test(sayTrim) &&
          hollowCorrections < MAX_HOLLOW_CORRECTIONS

        if (!willTriggerHollow) {
          await fakeStream(turn.say)
        }
        if (aborted) return

        if (!turn.tool) {
          if (willTriggerHollow) {
            hollowCorrections++
            console.warn(
              `[streamChat:app-layer] 嘴炮守卫触发（第 ${hollowCorrections} 次）say="${sayTrim.slice(0, 60)}"`
            )
            streamLog.event('hollow-guard', { round, attempt: hollowCorrections, sayPreview: sayTrim.slice(0, 200) })
            working.push({ role: 'assistant', content: rawText })
            working.push({
              role: 'user',
              content:
                `（系统提醒）你刚才说了"${sayTrim.slice(0, 30)}"但 tool 字段填了 null——这等于打嘴炮。` +
                '本协议是**单轮闭环**，没有下一轮自动接着干的机会。' +
                '**立即在你的下一个 JSON 里**把 tool 字段填好，比如：' +
                '`"tool": {"name":"web_search", "args":{"query":"你要查的关键词"}}`，' +
                '同时 tool_describe 写明你在干啥。' +
                '如果用户问的是「价格 / 股价 / 汇率 / 天气 / 新闻 / 最新动态」等实时信息，就调 web_search。' +
                '**额外注意**：用户**没有**看到你刚才那句"' + sayTrim.slice(0, 20) + '"——它已经被系统吞掉。' +
                '所以下一轮 say 字段如果想说什么，请**直接给最终答复**，不要写"我刚才说要查的，结果是..."这种回顾性开场白。'
            })
            shouldGuardEmpty = true
            continue
          }
          if (
            !sayTrim &&
            shouldGuardEmpty &&
            emptyResponseCorrections < MAX_EMPTY_RESPONSE_CORRECTIONS
          ) {
            emptyResponseCorrections++
            console.warn(
              `[streamChat:app-layer] 空响应守卫触发（第 ${emptyResponseCorrections} 次）`
            )
            streamLog.event('empty-guard', { round, attempt: emptyResponseCorrections })
            working.push({ role: 'assistant', content: rawText })
            working.push({
              role: 'user',
              content: emptyResponseCorrectionPrompt(emptyResponseCorrections)
            })
            continue
          }
          // 兜底：模型违约输出空 say——给用户一句"没动静"也好过完全沉默
          if (!sayTrim) {
            console.warn('[streamChat:app-layer] tool=null && say="" 触发兜底文案')
            streamLog.event('fallback', { kind: 'empty-say', round })
            await fakeStream('这轮没拿到什么有用的信息——你换个角度问我，或者直接搜一下试试？')
          } else {
            streamLog.event('finish', { round, kind: 'normal-say', sayLen: sayTrim.length })
          }
          callbacks.onDone()
          streamLog.close()
          return
        }

        const decision = await requestPermission(turn.tool, turn.tool_describe)
        if (aborted) return
        streamLog.event('tool-decision', { round, name: turn.tool.name, decision })
        if (decision === 'deny') {
          await fakeStream(pickRejectReply())
          callbacks.onDone()
          streamLog.close()
          return
        }
        if (decision === 'deny-disabled') {
          const fakeResult: ToolResult = {
            name: turn.tool.name,
            ok: false,
            content: `（系统）工具 ${turn.tool.name} 当前不可用（已被禁用）。请改用其他工具，或者直接答复用户。`
          }
          callbacks.onToolResult(fakeResult)
          working.push({ role: 'assistant', content: rawText })
          const tag = `（工具「${turn.tool.name}」结果）${fakeResult.content}`
          const followup = toolResultFollowupPrompt(fakeResult)
          working.push({ role: 'user', content: `${tag}\n\n${followup}` })
          shouldGuardEmpty = true
          continue
        }

        callbacks.onToolDescribe(turn.tool, turn.tool_describe)
        const toolResult = await executeTool(turn.tool)
        if (aborted) return
        console.log(
          `[streamChat:app-layer] toolResult ok=${toolResult.ok} content="${toolResult.content.slice(0, 100).replace(/\n/g, ' ')}"`
        )
        streamLog.event('tool-result', {
          round,
          name: toolResult.name,
          ok: toolResult.ok,
          contentPreview: toolResult.content.slice(0, 800),
          contentLen: toolResult.content.length,
          hasParts: !!(toolResult.parts && toolResult.parts.length)
        })
        callbacks.onToolResult(toolResult)

        working.push({ role: 'assistant', content: rawText })
        const tag = `（工具「${toolResult.name}」结果）${toolResult.content}`
        const followup = toolResultFollowupPrompt(toolResult)
        const textTail = `${tag}\n\n${followup}`
        // 带图工具升级成 [image, text] 块——多模态模型偏好图先文后
        const imageParts =
          toolResult.parts?.filter((p): p is { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string; localPath?: string } => p.type === 'image') ?? []
        if (imageParts.length === 0) {
          working.push({ role: 'user', content: textTail })
        } else {
          const blocks: AnthropicContentBlock[] = [
            ...imageParts.map(
              (p): AnthropicContentBlock => ({
                type: 'image',
                source: { type: 'base64', media_type: p.mediaType, data: p.base64 }
              })
            ),
            { type: 'text', text: textTail }
          ]
          working.push({ role: 'user', content: blocks })
        }
        shouldGuardEmpty = true
      }
    } catch (err) {
      if (aborted) return
      const message = err instanceof Error ? err.message : String(err)
      streamLog.event('error', { message })
      streamLog.close()
      callbacks.onError(message)
    }
  }

  // cc-native 协议：server_tool_use 由 Anthropic 端执行不过闸门，client tool_use 走 main 端
  const runNative = async (): Promise<void> => {
    console.log('[streamChat:native] 当前 provider 走原生 tool_use 协议；title 不会自动生成')
    callbacks.onMood('normal')

    const initialChat: AnthropicMessageInput[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }))
    const working: AnthropicMessageInput[] = withSystemPrompt(initialChat, () => ({
      role: 'system',
      content: options.buildSystem!('native')
    }))
    const tools = buildNativeTools(loadSettings().tools.policies)

    try {
      for (let round = 0; ; round++) {
        if (aborted) return

        // SSE 流式让 onChunk 实时上屏，不用 fakeStream（真实流速即打字机节奏）
        const resp: AnthropicResponse = await streamChatNative(
          provider,
          working,
          { signal: controller.signal, tools, tier: options.tier },
          {
            onTextDelta: (text) => {
              if (!aborted) callbacks.onChunk(text)
            },
            onServerToolUse: (block) => {
              if (aborted) return
              const call: ToolCall = {
                name: block.name,
                args: (block.input as Record<string, unknown>) ?? {}
              }
              callbacks.onToolDescribe(call, describeNativeCall(call))
            },
            onServerToolResult: (block) => {
              if (!aborted) callbacks.onToolResult(formatServerWebSearchResult(block))
            }
          }
        )
        if (aborted) return

        callbacks.onUsage({
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens
        })

        const clientToolUses: AnthropicToolUseBlock[] = []
        for (const block of resp.content) {
          if (block.type === 'tool_use') clientToolUses.push(block)
        }

        if (clientToolUses.length === 0) {
          callbacks.onDone()
          return
        }

        working.push({ role: 'assistant', content: resp.content })

        const toolResultBlocks: AnthropicContentBlock[] = []
        for (const tu of clientToolUses) {
          if (aborted) return
          const call: ToolCall = {
            name: tu.name,
            args: (tu.input as Record<string, unknown>) ?? {}
          }
          const describe = describeNativeCall(call)

          const decision = await requestPermission(call, describe)
          if (aborted) return
          if (decision === 'deny') {
            await fakeStream(pickRejectReply())
            callbacks.onDone()
            return
          }
          if (decision === 'deny-disabled') {
            const failContent = `（系统）工具 ${call.name} 当前不可用（已被禁用）。请改用其他工具，或者直接答复用户。`
            const fakeResult: ToolResult = { name: call.name, ok: false, content: failContent }
            callbacks.onToolResult(fakeResult)
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: failContent,
              is_error: true
            })
            continue
          }

          callbacks.onToolDescribe(call, describe)
          const result = await executeTool(call)
          if (aborted) return
          callbacks.onToolResult(result)

          const imageParts =
            result.parts?.filter((p): p is { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string; localPath?: string } => p.type === 'image') ?? []
          if (imageParts.length === 0) {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: result.content,
              is_error: !result.ok
            })
          } else {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: [
                ...imageParts.map((p) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: p.mediaType,
                    data: p.base64
                  }
                })),
                { type: 'text' as const, text: result.content }
              ],
              is_error: !result.ok
            })
          }
        }

        working.push({ role: 'user', content: toolResultBlocks })
      }
    } catch (err) {
      if (aborted) return
      const message = err instanceof Error ? err.message : String(err)
      callbacks.onError(message)
    }
  }

  // mode 恒为 'app-layer'，runNative 留作未来切换
  void runAppLayer()

  return {
    abort: () => {
      if (aborted) return
      aborted = true
      stopFakeTimer()
      controller.abort()
      // 兑现所有悬挂的 permission / ask_user_question，否则 await 永挂
      abortAllPending()
      abortAllPendingAskUser()
      streamLog.event('aborted')
      streamLog.close()
      // 走 onAborted 而非 onDone：跳过 failover / 延伸阅读这两条下游路径
      callbacks.onAborted()
    }
  }
}
