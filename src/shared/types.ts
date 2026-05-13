export type Vibrancy = 'dnd' | 'quiet' | 'normal' | 'lively'
export type SizePreset = 'compact' | 'standard' | 'large'
export type RemoteSpeed = 'demo' | 'normal' | 'fast'
export type Language = 'system' | 'zh-CN' | 'zh-TW' | 'en'
export type Theme = 'system' | 'light' | 'dark'

// 入睡阈值；'10s' 是开发者专属，普通用户不可见。
export type NapDelay = '10s' | '10min' | '30min' | '1h'

export type ClipName =
  | 'start'
  | 'exit'
  | 'idle-tire'
  | 'idle-playball'
  | 'idle-tire2-start'
  | 'idle-tire2-loop'
  | 'idle-tire2-end'
  | 'walk-start'
  | 'walk-loop'
  | 'walk-end'
  | 'turn'
  | 'learn'
export type ClipKind = 'loop' | 'oneshot'

// 列数 64；WebP 宽限 16383px，69 帧会超，改值须重跑脚本
export const SPRITE_GRID_COLS = 64

// frameCount 必须与 scripts/build-sprites.py 输出一致，末行可能不满不能反算
export interface ClipMeta {
  kind: ClipKind
  frameCount: number
}
export const CLIP_REGISTRY: Record<ClipName, ClipMeta> = {
  start: { kind: 'oneshot', frameCount: 103 },
  exit: { kind: 'oneshot', frameCount: 110 },
  // idle 小动作——单次播完回 idle 静态图
  'idle-tire': { kind: 'oneshot', frameCount: 59 },
  'idle-playball': { kind: 'oneshot', frameCount: 82 },
  // 三段链 start → loop → end，想收尾时 playClip('idle-tire2-end')
  'idle-tire2-start': { kind: 'oneshot', frameCount: 68 },
  'idle-tire2-loop': { kind: 'loop', frameCount: 70 },
  'idle-tire2-end': { kind: 'oneshot', frameCount: 9 },
  // walk 三段链：start → loop → end，桌宠走位用。链式接法同 idle-tire2。
  'walk-start': { kind: 'oneshot', frameCount: 5 },
  'walk-loop': { kind: 'loop', frameCount: 28 },
  'walk-end': { kind: 'oneshot', frameCount: 8 },
  // 单次转身过渡（左↔右）
  turn: { kind: 'oneshot', frameCount: 14 },
  // 阅读动画，ping-pong 003-341，loop
  learn: { kind: 'loop', frameCount: 339 }
}
export const CLIP_NAMES: ClipName[] = Object.keys(CLIP_REGISTRY) as ClipName[]

export interface PlayClipOptions {
  /** 默认 false：等当前 clip 当轮末帧再切；true：立即切 */
  force?: boolean
  /** 当前 clip 自然结束后自动接的下一个 clip（链式过渡） */
  next?: ClipName
  /** 覆盖 clip 默认 kind：true 强制循环、false 强制单次。不传则用 CLIP_REGISTRY 的 kind */
  loop?: boolean
}

export interface StopClipOptions {
  /** 默认 false：等当前 clip 当轮末帧再停；true：立即停 */
  force?: boolean
}

export interface GeneralSettings {
  autoLaunch: boolean
  runAsAdmin: boolean
  summonHotkey: string
  language: Language
  /** 启动时恢复上次拖拽位置；false 时每次启动从默认右下锚点出现 */
  rememberPetPosition: boolean
}

export interface AppearanceSettings {
  size: SizePreset
  theme: Theme
  opacity: number // 20-100，不允许完全透明
  highDpi: boolean
  /** sprite 左上角逻辑像素坐标；null = 用 computeDefaultPetAnchor 算默认锚点 */
  petPosition: { x: number; y: number } | null
}

export interface InteractionSettings {
  vibrancy: Vibrancy
  hideOnFullscreen: boolean
  // 空闲多久后入睡；Director 每秒 getSystemIdleTime 比对
  idleNapAfter: NapDelay
}

export interface IntelligenceSettings {
  remoteSpeed: RemoteSpeed
  failoverEnabled: boolean
  reasoningMode: boolean
  // memory 系统留待后续
}

// devMode 关闭时整个 dev 子对象重置为默认值，避免开发者偏好残留
export interface DevSettings {
  devToolsEnabled: boolean
}

/** 工具调用「永远允许」记录，按 toolId 粒度 */
export interface PermissionRecord {
  /** 'tool:target' 规范化键。例：'web_search:python 教程' / 'fetch_url:https://github.com/x/y' */
  key: string
  /** 工具名——便于设置页分组展示 */
  tool: string
  /** 用户决策时看到的目标原文，供设置页展示与撤销 */
  target: string
  /** ms 时间戳 */
  grantedAt: number
}

export interface PermissionsSettings {
  /** 已「永远允许」的清单。空数组表示什么都没授权过 */
  allowed: PermissionRecord[]
}

// 三态：disabled 不出现在 prompt / ask 询问 / alwaysAllow 不询问；exempt 工具永远放行
export type ToolPolicy = 'disabled' | 'ask' | 'alwaysAllow'

// open_web_search 背后 5 引擎 fallback 链，顺序即优先级
export type SearchEngineId = 'bing' | 'baidu' | 'so360' | 'google' | 'custom'

export const SEARCH_ENGINE_ID_LIST: SearchEngineId[] = [
  'bing',
  'baidu',
  'so360',
  'google',
  'custom'
]

export interface SearchEngineConfig {
  id: SearchEngineId
  enabled: boolean
  /** 自定义引擎的 URL 模板，{query} 会被替换成 URL-encoded 关键词。其它引擎忽略此字段。 */
  customUrl?: string
}

export interface OpenWebSearchSettings {
  /** 引擎链——按数组顺序作为 fallback 链；只有 enabled=true 的会被尝试 */
  engines: SearchEngineConfig[]
}

// trustedDomains 白名单直接放行，deniedDomains 黑名单直接拒绝
export interface FetchUrlSettings {
  trustedDomains: string[]
  deniedDomains: string[]
}

export interface ToolPoliciesSettings {
  /** key 是 toolId（'builtin:web_search' / 'mcp:<serverId>:<toolName>'）。缺省按 'ask' 处理。 */
  policies: Record<string, ToolPolicy>
  /** open_web_search 工具的引擎链配置 */
  openWebSearch: OpenWebSearchSettings
  /** fetch_url 工具的域名白/黑名单 */
  fetchUrl: FetchUrlSettings
}

/** 默认引擎链——常用三家开启，360/Google 默认关（避免境外引擎卡顿），自定义留空待用户填 */
export function defaultOpenWebSearch(): OpenWebSearchSettings {
  return {
    engines: [
      { id: 'bing', enabled: true },
      { id: 'baidu', enabled: true },
      { id: 'so360', enabled: false },
      { id: 'google', enabled: false },
      { id: 'custom', enabled: false, customUrl: '' }
    ]
  }
}

export function defaultFetchUrl(): FetchUrlSettings {
  return { trustedDomains: [], deniedDomains: [] }
}

/** 设置页 UI 用的工具元信息——剥掉 ToolDescriptor 里不可序列化的字段 */
export interface ToolDescriptorView {
  id: string
  name: string
  source: 'builtin' | 'mcp'
  displayName: string
  description: string
  /** true 时永远 allow_once，UI segmented 应整组 disabled */
  exempt: boolean
}

// 用户配置的本地 MCP server，main 按 enabled 拉 stdio 子进程

export interface McpServerConfig {
  id: string
  /** 用户给 server 起的展示名 */
  name: string
  /** 可执行文件——'npx' / 'node' / 'uvx' / 绝对路径 */
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  /** 单项总闸——false 时 lifecycle 不会拉起 */
  enabled: boolean
}

/** 运行时状态——non-persistent，启停时由 main 推 'tools:status-changed' 给 renderer */
export interface McpRuntimeStatus {
  serverId: string
  state: 'starting' | 'running' | 'error' | 'stopped'
  /** state==='error' 时填，UI 直接展示给用户 */
  error?: string
  /** 当前注册到 registry 里的子工具数——0 表示 server 还没拉起或失败了 */
  toolCount: number
}

// Settings 页推荐卡；id 作去重键，用户点「一键添加」才写入 mcpServers

export interface McpServerTemplate {
  /** 与 McpServerConfig.id 共用命名空间——一旦添加，去重就靠这个 id */
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** 推荐卡上展示的一句话介绍——讲清楚能力 + 首次启动代价 */
  description: string
  /** 推荐卡右上角图标（FontAwesome 类名） */
  icon: string
}

export const RECOMMENDED_MCP_SERVERS: McpServerTemplate[] = [
  {
    id: 'playwright',
    name: 'Playwright（浏览器自动化）',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    description:
      '让小刘自己开浏览器办事——点击/输入/导航/截图都能干。首次启动会下载 Chromium ~120MB，之后秒开。',
    icon: 'fa-solid fa-globe'
  }
]

/** 单条已归档的对话消息——只保留可视文本与角色 */
export interface SavedMessage {
  role: 'user' | 'assistant'
  text: string
  /** ms 时间戳 */
  time: number
}

/** 一段完整对话归档——对应 Pet.tsx 一次「新对话 → 关闭/新对话」周期 */
export interface ConversationRecord {
  id: string
  /** 对话标题——来自 LLM 的 title 字段；为空表示用户只打了招呼，UI 兜底显示「未命名对话」 */
  title: string
  /** 创建时间（首条用户消息的 ms 时间戳） */
  createdAt: number
  /** 最后更新时间——onDone 时刻刷新 */
  updatedAt: number
  /** 已过滤的 say 消息列表 */
  messages: SavedMessage[]
}

export interface HistorySettings {
  /** 上限——超过则按 updatedAt 升序剔除最旧的，避免 history/ 目录无限膨胀 */
  maxKeep: number
}

// 四属性内核 + 结算时间戳；knowledge/bond 只增不减，mood/energy 有上下限
export interface PetVitals {
  /** 心情 0-100，互动 + 时间 -，初始 60 */
  mood: number
  /** 知识 0+，每自然 onDone 一轮 +1，只增不减 */
  knowledge: number
  /** 活力 0-100，互动消耗，进入 sleeping 后醒来恢复；初始 100 */
  energy: number
  /** 亲密度 0+，每自然 onDone +1，每摸摸 +2，只增不减 */
  bond: number
  /** 上次衰减结算时间戳（ms）。lazy 衰减：用 now - lastSettleAt 计算应衰减点数 */
  lastSettleAt: number
}

/** 字段范围——sanitize 写盘前 clamp 用 */
export const VITALS_RANGES = {
  mood: { min: 0, max: 100 },
  knowledge: { min: 0, max: 99999 },
  energy: { min: 0, max: 100 },
  bond: { min: 0, max: 99999 }
} as const

export function defaultPetVitals(): PetVitals {
  return { mood: 60, knowledge: 0, energy: 100, bond: 0, lastSettleAt: Date.now() }
}

/** deny=中止本轮口头禅；deny-disabled=静默回灌让模型换工具，不掐流 */
export type PermissionDecision = 'allow_once' | 'allow_forever' | 'deny' | 'deny-disabled'

/** main → renderer 推送的权限请求。renderer 据此渲染底部 PermissionRow */
export interface PermissionRequest {
  /** 单次请求的关联 id——renderer resolve 时回传 */
  reqId: string
  /** 工具名（'web_search' / 'fetch_url' / 其他） */
  tool: string
  /** 行为目标（query / URL / 等等）——UI 直接展示给用户判断 */
  target: string
  /** 模型给的 tool_describe 文本，例如「正在搜索：python 教程」——UI 优先显示这个 */
  describe: string
}

/** ask_user_question 工具：模型主动向用户提问。
 *  与 PermissionRequest 同构（都是 main → renderer 询问后等回灌），但不是「闸门」而是工具本身——
 *  exempt:true 跳过 permission 闸门，直接由 executor 推 'ask-user:request' 给 renderer。
 *  约束：单问题、2-4 选项；UI 永远在选项下方常驻一个「其他」自由输入框；
 *  multiSelect=true 时允许同时勾选多项（且仍可叠加自由输入）。
 */
export interface AskUserQuestionRequest {
  reqId: string
  /** 模型想问用户的具体问题——直接当面板顶部那行文字显示 */
  question: string
  /** 2-4 个候选答案，按钮顺序与传入顺序一致。「其他」是 UI 固定常驻的输入框，不占用候选名额 */
  options: string[]
  /** 是否多选；不传或 false 视为单选。
   *  - 单选：用户至多勾一个选项；勾新项自动取消旧项
   *  - 多选：用户可勾任意子集（含 0 个） + 自由输入并存 */
  multiSelect?: boolean
}

/** renderer → main 的回灌。canceled=true 时 selectedOptions / otherText 必为空（用户关气泡 / 打断）。
 *  非 cancel 路径下两个字段允许并存——多选模式可能「勾了 A、B + 自填了 C」；
 *  单选模式下只会出现「selectedOptions=[1 项]、otherText=''」或「selectedOptions=[]、otherText=非空」。
 *  非 cancel 路径下 selectedOptions 与 otherText 至少有一个非空（UI 用确认按钮的 disabled 守住）。
 */
export interface AskUserQuestionResponse {
  reqId: string
  canceled: boolean
  /** 用户从给定 options 里勾中的项（原文，不是 index）；多选时长度 ≥1，单选时长度 ≤1 */
  selectedOptions: string[]
  /** 用户在常驻「其他」输入框里写的自由文本；trim 过；可空 */
  otherText: string
}

export interface AppSettings {
  activeProviderId: string | null
  providers: ProviderInstance[]
  // devMode 是开发者模式总闸门（控制设置页是否露出 Developer 入口），
  // 与 dev: DevSettings 子对象（具体开发者偏好）分开。
  devMode: boolean

  general: GeneralSettings
  appearance: AppearanceSettings
  interaction: InteractionSettings
  intelligence: IntelligenceSettings
  permissions: PermissionsSettings
  /** 工具三态策略表——内置工具 + MCP 子工具共用同一份。缺省按 'ask' 处理。 */
  tools: ToolPoliciesSettings
  /** 用户配置的 MCP server 列表——main 启动按 enabled 拉起 stdio 子进程 */
  mcpServers: McpServerConfig[]
  history: HistorySettings
  /** 养成属性——四属性内核 + lastSettleAt 时间戳，详见 PetVitals 注释 */
  vitals: PetVitals
  dev: DevSettings
}

export const VIBRANCY_LABELS: Record<
  Vibrancy,
  { label: string; desc: string; icon: string }
> = {
  dnd: { label: '免打扰', desc: '小刘安静地缩在角落，不主动出现，不发声', icon: 'fa-moon' },
  quiet: { label: '安静', desc: '只在被召唤时回应，平时低调存在', icon: 'fa-volume-low' },
  normal: { label: '普通', desc: '日常陪伴，偶尔抬头看看你', icon: 'fa-face-smile' },
  lively: { label: '活泼', desc: '会主动溜达、发出声音、找你互动', icon: 'fa-bolt' }
}

export const VIBRANCY_LIST: Vibrancy[] = ['dnd', 'quiet', 'normal', 'lively']

// 入睡阈值秒数。Director 比对 powerMonitor.getSystemIdleTime() 用。
export const NAP_DELAY_SEC: Record<NapDelay, number> = {
  '10s': 10,
  '10min': 600,
  '30min': 1800,
  '1h': 3600
}
// 普通用户能选的档（开发者模式下额外露出 '10s'）
export const NAP_DELAY_LIST_USER: NapDelay[] = ['10min', '30min', '1h']
export const NAP_DELAY_LIST_DEV: NapDelay[] = ['10s', '10min', '30min', '1h']

// dnd=Infinity 禁止穿插；勿扰只针对主动打扰，入睡不受影响
export const BOREDOM_INTERVAL_MS_BY_VIBRANCY: Record<Vibrancy, number> = {
  dnd: Number.POSITIVE_INFINITY,
  quiet: 10 * 60 * 1000,
  normal: 5 * 60 * 1000,
  lively: 1 * 60 * 1000
}

export const SIZE_LABELS: Record<SizePreset, { label: string; scale: number }> = {
  compact: { label: '紧凑', scale: 0.75 },
  standard: { label: '标准', scale: 1.0 },
  large: { label: '醒目', scale: 1.25 }
}

export const SIZE_LIST: SizePreset[] = ['compact', 'standard', 'large']

export const LANGUAGE_LABELS: Record<Language, { label: string }> = {
  system: { label: '跟随系统' },
  'zh-CN': { label: '简体中文' },
  'zh-TW': { label: '繁體中文' },
  en: { label: 'English' }
}

export const LANGUAGE_LIST: Language[] = ['system', 'zh-CN', 'zh-TW', 'en']

export const THEME_LABELS: Record<Theme, { label: string; icon: string }> = {
  system: { label: '跟随系统', icon: 'fa-circle-half-stroke' },
  light: { label: '亮色', icon: 'fa-sun' },
  dark: { label: '暗色', icon: 'fa-moon' }
}

export const THEME_LIST: Theme[] = ['system', 'light', 'dark']

export const REMOTE_SPEED_LABELS: Record<RemoteSpeed, { label: string; desc: string }> = {
  demo: { label: '演示', desc: '光标缓慢移动，方便观察每一步——适合演示和直播' },
  normal: { label: '正常', desc: '接近自然手速，平衡观感与效率' },
  fast: { label: '迅速', desc: '接近瞬时，最少打扰你的工作节奏' }
}

export const REMOTE_SPEED_LIST: RemoteSpeed[] = ['demo', 'normal', 'fast']

// 4 种协议路径；cc-native 直发 Anthropic；其余为本地翻译
export type ProtocolMode =
  | 'cc-native'
  | 'cc-translate-responses'
  | 'cc-translate-openai-chat'
  | 'cc-translate-gemini'

export const PROTOCOL_MODE_LABELS: Record<ProtocolMode, { label: string; desc: string }> = {
  'cc-native': {
    label: 'Anthropic 格式',
    desc: '上游原生支持 Claude Messages 协议，直接以 CC 客户端身份发送'
  },
  'cc-translate-responses': {
    label: 'OpenAI Responses 格式',
    desc: '上游为 OpenAI Responses API，本地把 Claude 请求翻译成 Responses 后再发送'
  },
  'cc-translate-openai-chat': {
    label: 'OpenAI Chat 格式（待支持）',
    desc: '上游为 OpenAI Chat Completions API，需本地翻译；当前版本暂未接入'
  },
  'cc-translate-gemini': {
    label: 'Gemini Native 格式（待支持）',
    desc: '上游为 Google Gemini generateContent API，需本地翻译；当前版本暂未接入'
  }
}

export const PROTOCOL_MODE_LIST: ProtocolMode[] = [
  'cc-native',
  'cc-translate-responses',
  'cc-translate-openai-chat',
  'cc-translate-gemini'
]

export type PresetID =
  | 'zhipu'
  | 'kimi'
  | 'deepseek'
  | 'doubaoseed'
  | 'minimax'
  | 'xiaomi-mimo'
  | 'longcat'
  | 'claude-official'
  | 'codex'
  | 'gemini-native'
  | 'github-copilot'
  | 'openrouter'
  | 'custom'

// 三档模型角色对齐真 CC；haiku beta header 按档分支
export type ModelTier = 'light' | 'daily' | 'reasoning'

export const MODEL_TIER_LABELS: Record<ModelTier, { label: string; hint: string }> = {
  light: { label: '轻量模型', hint: '后台子任务，例如网页摘要、会话自动命名（典型：haiku 系列）' },
  daily: { label: '日常模型', hint: '主对话，最常被调用（典型：sonnet 系列）' },
  reasoning: { label: '推理模型', hint: '复杂规划与重负载推理（典型：opus 系列）' }
}

export const MODEL_TIER_LIST: ModelTier[] = ['light', 'daily', 'reasoning']

export interface ProviderPreset {
  id: PresetID
  name: string
  /** 图标文件名（位于 resources/providers/，不含路径），preset='custom' 时为空。 */
  iconFile: string
  /** 选中态背景色，用于 ProviderBadge 的 SVG 背景圆角块。 */
  color: string
  protocolMode: ProtocolMode
  defaultBaseURL: string
  defaultModels: Record<ModelTier, string>
  apiKeyHint: string
  docsURL: string
  /**
   * 上游需要 OAuth Token 而非 sk- 风格 API Key（GitHub Copilot、Codex 反代）。
   * 当前版本不实现 OAuth flow，UI 仍按密钥字符串展示，文案里提示用户自行获取 token。
   */
  requiresOAuth?: boolean
  /** UI 上的额外提醒（例如未实现协议、需要 OAuth 等）。 */
  notice?: string
  /** true = 内置 provider 专用预设，不在「添加供应商」选择器里出现。 */
  builtinOnly?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    iconFile: 'zhipu.svg',
    color: '#0F62FE',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://open.bigmodel.cn/api/anthropic',
    defaultModels: { light: 'glm-5', daily: 'glm-5', reasoning: 'glm-5' },
    apiKeyHint: 'sk-...',
    docsURL: 'https://www.bigmodel.cn/claude-code'
  },
  {
    id: 'kimi',
    name: 'Kimi',
    iconFile: 'kimi.svg',
    color: '#6366F1',
    protocolMode: 'cc-native',
    // Moonshot 在 /anthropic 子路径下提供原生 Claude Messages 兼容层。
    defaultBaseURL: 'https://api.moonshot.cn/anthropic',
    // Kimi 当前只对外发 k2.6 一个 SKU，三档同名是 cc-switch 的官方填法。
    defaultModels: { light: 'kimi-k2.6', daily: 'kimi-k2.6', reasoning: 'kimi-k2.6' },
    apiKeyHint: 'sk-...',
    docsURL: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    iconFile: 'deepseek.svg',
    color: '#1E88E5',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://api.deepseek.com/anthropic',
    defaultModels: {
      light: 'deepseek-v4-flash',
      daily: 'deepseek-v4-pro',
      reasoning: 'deepseek-v4-pro'
    },
    apiKeyHint: 'sk-...',
    docsURL: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'doubaoseed',
    name: 'DouBao Seed',
    iconFile: 'doubao.svg',
    color: '#3370FF',
    protocolMode: 'cc-native',
    // 火山方舟把 Anthropic 兼容层挂在 /api/coding（豆包 Seed Code 系列对外 CC 路径）。
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/coding',
    defaultModels: {
      light: 'doubao-seed-2-0-code-preview-latest',
      daily: 'doubao-seed-2-0-code-preview-latest',
      reasoning: 'doubao-seed-2-0-code-preview-latest'
    },
    apiKeyHint: '火山方舟 API Key',
    docsURL: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    iconFile: 'minimax.svg',
    color: '#F64551',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://api.minimaxi.com/anthropic',
    defaultModels: {
      light: 'MiniMax-M2.7',
      daily: 'MiniMax-M2.7',
      reasoning: 'MiniMax-M2.7'
    },
    apiKeyHint: 'MiniMax API Key',
    docsURL: 'https://platform.minimaxi.com/subscribe/coding-plan'
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    iconFile: 'xiaomimimo.svg',
    color: '#FF6900',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://api.xiaomimimo.com/anthropic',
    defaultModels: { light: 'mimo-v2-pro', daily: 'mimo-v2-pro', reasoning: 'mimo-v2-pro' },
    apiKeyHint: '小米 MiMo API Key',
    docsURL: 'https://platform.xiaomimimo.com/#/console/api-keys'
  },
  {
    id: 'longcat',
    name: 'LongCat',
    iconFile: 'longcat.svg',
    color: '#29E154',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://api.longcat.chat/anthropic',
    defaultModels: {
      light: 'LongCat-Flash-Chat',
      daily: 'LongCat-Flash-Chat',
      reasoning: 'LongCat-Flash-Chat'
    },
    apiKeyHint: 'LongCat API Key',
    docsURL: 'https://longcat.chat/platform/api_keys'
  },
  {
    id: 'claude-official',
    name: 'Claude Official',
    iconFile: 'anthropic.svg',
    color: '#D4915D',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://api.anthropic.com',
    defaultModels: {
      light: 'claude-haiku-4-5',
      daily: 'claude-sonnet-4-6',
      reasoning: 'claude-opus-4-7'
    },
    apiKeyHint: 'sk-ant-...',
    docsURL: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'codex',
    name: 'Codex (ChatGPT)',
    iconFile: 'openai.svg',
    color: '#000000',
    // Codex 反代用 OpenAI Responses API 协议（与 cc-switch apiFormat: 'openai_responses' 对齐）。
    protocolMode: 'cc-translate-responses',
    defaultBaseURL: 'https://chatgpt.com/backend-api/codex',
    defaultModels: {
      light: 'gpt-5.4-mini',
      daily: 'gpt-5.4',
      reasoning: 'gpt-5.4'
    },
    apiKeyHint: 'OAuth Access Token',
    docsURL: 'https://openai.com/chatgpt/pricing',
    requiresOAuth: true,
    notice: '需要 ChatGPT Plus/Pro 账号通过 OAuth 获取 token；当前版本暂未实现自动登录，请自行抓取后粘贴。'
  },
  {
    id: 'gemini-native',
    name: 'Gemini Native',
    iconFile: 'gemini.svg',
    color: '#4285F4',
    protocolMode: 'cc-translate-gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    defaultModels: {
      light: 'gemini-3-flash',
      daily: 'gemini-3.1-pro',
      reasoning: 'gemini-3.1-pro'
    },
    apiKeyHint: 'Google AI Studio API Key',
    docsURL: 'https://aistudio.google.com/app/apikey',
    notice: 'Anthropic ↔ Gemini 双向翻译层尚未实现，保存可见，调用会报「暂未支持」。'
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    iconFile: 'githubcopilot.svg',
    color: '#000000',
    // Copilot 走 OpenAI Chat Completions 协议（与 cc-switch apiFormat: 'openai_chat' 对齐）。
    protocolMode: 'cc-translate-openai-chat',
    defaultBaseURL: 'https://api.githubcopilot.com',
    defaultModels: {
      light: 'claude-haiku-4.5',
      daily: 'claude-sonnet-4.6',
      reasoning: 'claude-sonnet-4.6'
    },
    apiKeyHint: 'GitHub OAuth Token',
    docsURL: 'https://github.com/features/copilot',
    requiresOAuth: true,
    notice: 'Copilot 需要 GitHub OAuth 登录后换出 Copilot token；当前版本暂未实现自动登录。'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    iconFile: 'openrouter.svg',
    color: '#6566F1',
    protocolMode: 'cc-native',
    defaultBaseURL: 'https://openrouter.ai/api',
    defaultModels: {
      light: 'anthropic/claude-haiku-4.5',
      daily: 'anthropic/claude-sonnet-4.6',
      reasoning: 'anthropic/claude-opus-4.7'
    },
    apiKeyHint: 'sk-or-v1-...',
    docsURL: 'https://openrouter.ai/keys'
  },
  {
    id: 'custom',
    name: '自定义',
    iconFile: '',
    color: '#6B7280',
    protocolMode: 'cc-native',
    defaultBaseURL: '',
    defaultModels: { light: '', daily: '', reasoning: '' },
    apiKeyHint: 'API Key',
    docsURL: ''
  }
]

export interface ProviderUsageStats {
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  lastUsedAt: number | null
}

export function emptyUsageStats(): ProviderUsageStats {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null }
}

export interface ProviderInstance {
  id: string
  name: string
  // 用户自填的备注，仅用于在列表里作为 subtitle 提示，不参与请求构造。
  // 可选：旧配置文件没有这个字段，sanitize 时缺失不报错
  note?: string
  // 是否加入故障转移池。仅在 intelligence.failoverEnabled=true 时生效；
  // 未加入的 provider 既不会被作为链头，也不会被故障切换路由到。
  // 与 activeProviderId 互不影响（关闭故障转移时仍按 active 单选模型工作）。
  inFailoverPool?: boolean
  presetId?: PresetID
  baseURL: string
  apiKey: string
  protocolMode: ProtocolMode
  /**
   * 三档模型字段：light（轻量后台子任务）/ daily（主对话）/ reasoning（重推理）。
   * 当前 Hiliu 只用 daily；保留另外两档是为对齐真实 CC 客户端按角色调不同模型的行为，
   * 也方便指纹层按档切 beta header（haiku 类不发 claude-code-20250219 等）。
   */
  models: Record<ModelTier, string>
  stats: ProviderUsageStats
  /**
   * 等价于 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1。
   * 打开后不发 anthropic-beta 头；上游返 400 invalid beta flag 时才开。
   * 默认关闭——真 CC 永远发完整 beta（haiku 除外）。
   */
  disableExperimentalBetas?: boolean
}

export function defaultDevSettings(): DevSettings {
  return {
    devToolsEnabled: false
  }
}

export function defaultSettings(): AppSettings {
  return {
    activeProviderId: null,
    providers: [],
    devMode: false,
    general: {
      autoLaunch: false,
      runAsAdmin: false,
      summonHotkey: 'Alt+Space',
      language: 'system',
      rememberPetPosition: false
    },
    appearance: {
      size: 'standard',
      theme: 'light',
      opacity: 100,
      highDpi: true,
      petPosition: null
    },
    interaction: {
      vibrancy: 'normal',
      hideOnFullscreen: true,
      idleNapAfter: '30min'
    },
    intelligence: {
      remoteSpeed: 'normal',
      failoverEnabled: false,
      reasoningMode: false
    },
    permissions: {
      allowed: []
    },
    tools: {
      policies: {},
      openWebSearch: defaultOpenWebSearch(),
      fetchUrl: defaultFetchUrl()
    },
    mcpServers: [],
    history: {
      maxKeep: 50
    },
    vitals: defaultPetVitals(),
    dev: defaultDevSettings()
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface TestProviderResult {
  ok: boolean
  message: string
  latencyMs?: number
}

// Windows 原生 tray 菜单 checkbox 列宽不可调，走独立 BrowserWindow 渲染
export interface TrayMenuState {
  petVisible: boolean
  dndMode: boolean
  reasoningMode: boolean
}

export type TrayMenuAction =
  | 'toggle-visibility'
  | 'toggle-dnd'
  | 'toggle-reasoning'
  | 'open-settings'
  | 'quit'
  | 'close'

// 菜单若在 pet 窗口内渲染会被边缘裁剪，走独立 frameless BrowserWindow
export type PetMenuAction = 'open-settings' | 'quit' | 'close'

// 气泡是 pet 窗口左上扩展区，sprite 锚定右下不动
export interface BubbleState {
  visible: boolean
  /** 气泡区域逻辑宽度（基准 240×280 坐标系，main 端会按 size scale 同步放大） */
  width: number
  /** 气泡区域逻辑高度 */
  height: number
  /** chat 是否处于打开态。renderer 内部用于互斥占用气泡区，社区版不再有推送通道争用。 */
  chatOpen: boolean
}

export function defaultBubbleState(): BubbleState {
  return { visible: false, width: 0, height: 0, chatOpen: false }
}

// 全屏覆盖方案：sprite 在 renderer 绝对定位，main 实时计算屏幕物理事实透给 renderer
export interface ScreenInfo {
  /** 整屏逻辑像素尺寸（含任务栏） */
  screen: { width: number; height: number }
  /** 工作区（不含任务栏，logical px） */
  workArea: { x: number; y: number; width: number; height: number }
  /**
   * 默认 sprite 锚点：右下贴任务栏（脚踩任务栏视觉对齐 = bottom - footOffset）。
   * 已按当前 size scale 计算（renderer 拿到直接用，不用再乘 scale）。
   */
  defaultAnchor: { x: number; y: number }
  /** sprite 视觉尺寸（FRAME × scale，logical px），renderer 据此算拖拽边界 */
  spriteSize: { width: number; height: number }
}
