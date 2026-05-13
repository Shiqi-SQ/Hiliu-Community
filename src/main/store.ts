import Store from 'electron-store'
import { aggregateToolsFromFiles, splitToolsToFiles } from './toolStore'
import {
  AppSettings,
  defaultSettings,
  defaultPetVitals,
  emptyUsageStats,
  Language,
  LANGUAGE_LIST,
  ConversationRecord,
  defaultFetchUrl,
  defaultOpenWebSearch,
  FetchUrlSettings,
  McpServerConfig,
  ModelTier,
  NAP_DELAY_LIST_DEV,
  NapDelay,
  OpenWebSearchSettings,
  PermissionRecord,
  PetVitals,
  PresetID,
  SavedMessage,
  PROTOCOL_MODE_LIST,
  ProtocolMode,
  PROVIDER_PRESETS,
  ProviderInstance,
  ProviderUsageStats,
  REMOTE_SPEED_LIST,
  RemoteSpeed,
  SearchEngineConfig,
  SearchEngineId,
  SEARCH_ENGINE_ID_LIST,
  SIZE_LIST,
  SizePreset,
  Theme,
  THEME_LIST,
  ToolPolicy,
  VIBRANCY_LIST,
  Vibrancy,
  VITALS_RANGES
} from '@shared/types'

const TOOL_POLICY_LIST: readonly ToolPolicy[] = ['disabled', 'ask', 'alwaysAllow']

const store = new Store<AppSettings>({
  name: 'hiliu-settings',
  defaults: defaultSettings()
})

function pickEnum<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback
}

function sanitizePetPosition(
  raw: unknown
): { x: number; y: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<{ x: unknown; y: unknown }>
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return null
  if (Number.isNaN(r.x) || Number.isNaN(r.y)) return null
  return { x: Math.round(r.x), y: Math.round(r.y) }
}

function clampOpacity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(100, Math.max(20, Math.round(value)))
}

function sanitizeStats(raw: unknown): ProviderUsageStats {
  const base = emptyUsageStats()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<ProviderUsageStats>
  return {
    requests: typeof r.requests === 'number' ? r.requests : 0,
    errors: typeof r.errors === 'number' ? r.errors : 0,
    inputTokens: typeof r.inputTokens === 'number' ? r.inputTokens : 0,
    outputTokens: typeof r.outputTokens === 'number' ? r.outputTokens : 0,
    lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : null
  }
}

// gemini 已退出方案 → null
function migrateLegacyProtocolMode(raw: { apiFormat?: unknown; protocolMode?: unknown }): ProtocolMode | null {
  if (PROTOCOL_MODE_LIST.includes(raw.protocolMode as ProtocolMode)) {
    return raw.protocolMode as ProtocolMode
  }
  if (typeof raw.apiFormat !== 'string') return null
  switch (raw.apiFormat) {
    case 'gemini':
      return null
    case 'openai-chat':
    case 'openai-responses':
      return 'cc-translate-responses'
    case 'kimi':
    case 'deepseek':
    case 'doubao':
    case 'anthropic':
      return 'cc-native'
    default:
      return null
  }
}

function migrateLegacyModels(
  raw: { model?: unknown; models?: unknown },
  presetId: PresetID | undefined
): Record<ModelTier, string> {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)
  const presetDefaults = preset?.defaultModels

  if (raw.models && typeof raw.models === 'object') {
    const m = raw.models as Partial<Record<ModelTier, unknown>>
    return {
      light: typeof m.light === 'string' ? m.light : presetDefaults?.light ?? '',
      daily: typeof m.daily === 'string' ? m.daily : presetDefaults?.daily ?? '',
      reasoning:
        typeof m.reasoning === 'string' ? m.reasoning : presetDefaults?.reasoning ?? ''
    }
  }

  const legacyModel = typeof raw.model === 'string' ? raw.model : ''
  return {
    light: presetDefaults?.light ?? legacyModel,
    daily: legacyModel || presetDefaults?.daily || '',
    reasoning: presetDefaults?.reasoning ?? legacyModel
  }
}

function migrateLegacyPresetId(raw: unknown): PresetID | undefined {
  if (typeof raw !== 'string') return undefined
  const remap: Record<string, PresetID> = {
    doubao: 'doubaoseed',
    openai: 'codex',
    anthropic: 'claude-official'
  }
  const mapped = remap[raw] ?? (raw as PresetID)
  return PROVIDER_PRESETS.some((p) => p.id === mapped) ? mapped : undefined
}

function sanitizeProvider(raw: unknown): ProviderInstance | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ProviderInstance> & { apiFormat?: unknown; model?: unknown }
  if (typeof r.id !== 'string' || !r.id) return null
  const protocolMode = migrateLegacyProtocolMode(r)
  if (!protocolMode) return null
  const presetId = migrateLegacyPresetId(r.presetId)
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '未命名',
    note: typeof r.note === 'string' ? r.note : '',
    presetId,
    baseURL: typeof r.baseURL === 'string' ? r.baseURL : '',
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    protocolMode,
    models: migrateLegacyModels(r, presetId),
    stats: sanitizeStats(r.stats),
    inFailoverPool: r.inFailoverPool === true,
    disableExperimentalBetas: r.disableExperimentalBetas === true
  }
}

function sanitizeSavedMessage(raw: unknown): SavedMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SavedMessage>
  if (r.role !== 'user' && r.role !== 'assistant') return null
  if (typeof r.text !== 'string') return null
  const time = typeof r.time === 'number' && Number.isFinite(r.time) ? r.time : Date.now()
  return { role: r.role, text: r.text, time }
}

export function sanitizeConversation(raw: unknown): ConversationRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ConversationRecord>
  if (typeof r.id !== 'string' || !r.id) return null
  if (!Array.isArray(r.messages)) return null
  const messages = r.messages
    .map(sanitizeSavedMessage)
    .filter((m): m is SavedMessage => m !== null)
  if (messages.length === 0) return null
  const now = Date.now()
  return {
    id: r.id,
    title: typeof r.title === 'string' ? r.title : '',
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now,
    messages
  }
}

function sanitizeToolPolicies(raw: unknown): Record<string, ToolPolicy> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, ToolPolicy> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) continue
    if (TOOL_POLICY_LIST.includes(v as ToolPolicy)) {
      out[k] = v as ToolPolicy
    }
  }
  return out
}

function sanitizeOpenWebSearch(raw: unknown): OpenWebSearchSettings {
  const def = defaultOpenWebSearch()
  if (!raw || typeof raw !== 'object') return def
  const r = raw as { engines?: unknown }
  if (!Array.isArray(r.engines)) return def
  const seen = new Set<SearchEngineId>()
  const out: SearchEngineConfig[] = []
  for (const item of r.engines) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<SearchEngineConfig>
    if (!SEARCH_ENGINE_ID_LIST.includes(e.id as SearchEngineId)) continue
    const id = e.id as SearchEngineId
    if (seen.has(id)) continue
    seen.add(id)
    const cfg: SearchEngineConfig = {
      id,
      enabled: e.enabled !== false
    }
    if (id === 'custom' && typeof e.customUrl === 'string') {
      cfg.customUrl = e.customUrl
    }
    out.push(cfg)
  }
  for (const e of def.engines) {
    if (!seen.has(e.id)) out.push(e)
  }
  return { engines: out }
}

function sanitizeDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const v = item.trim().toLowerCase()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function sanitizeFetchUrl(raw: unknown): FetchUrlSettings {
  if (!raw || typeof raw !== 'object') return defaultFetchUrl()
  const r = raw as { trustedDomains?: unknown; deniedDomains?: unknown }
  return {
    trustedDomains: sanitizeDomainList(r.trustedDomains),
    deniedDomains: sanitizeDomainList(r.deniedDomains)
  }
}

function sanitizeMcpServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<McpServerConfig>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.command !== 'string' || !r.command) return null
  const args = Array.isArray(r.args)
    ? r.args.filter((a): a is string => typeof a === 'string')
    : []
  let env: Record<string, string> | undefined
  if (r.env && typeof r.env === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.env)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v
    }
    env = out
  }
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name ? r.name : r.id,
    command: r.command,
    args,
    env,
    cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined,
    enabled: r.enabled !== false
  }
}

function sanitizePermissionRecord(raw: unknown): PermissionRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<PermissionRecord>
  if (typeof r.key !== 'string' || !r.key) return null
  if (typeof r.tool !== 'string' || !r.tool) return null
  if (typeof r.target !== 'string') return null
  const grantedAt = typeof r.grantedAt === 'number' && Number.isFinite(r.grantedAt) ? r.grantedAt : Date.now()
  return { key: r.key, tool: r.tool, target: r.target, grantedAt }
}

function sanitizeVitals(raw: unknown): PetVitals {
  const def = defaultPetVitals()
  if (!raw || typeof raw !== 'object') return def
  const r = raw as Partial<PetVitals>
  const clamp = (v: unknown, key: keyof typeof VITALS_RANGES, fallback: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    const { min, max } = VITALS_RANGES[key]
    return Math.min(max, Math.max(min, Math.round(v)))
  }
  return {
    mood: clamp(r.mood, 'mood', def.mood),
    knowledge: clamp(r.knowledge, 'knowledge', def.knowledge),
    energy: clamp(r.energy, 'energy', def.energy),
    bond: clamp(r.bond, 'bond', def.bond),
    lastSettleAt:
      typeof r.lastSettleAt === 'number' && Number.isFinite(r.lastSettleAt)
        ? r.lastSettleAt
        : Date.now()
  }
}

export function loadSettings(): AppSettings {
  const raw = store.store as Partial<AppSettings>
  const base = defaultSettings()

  const providers: ProviderInstance[] = Array.isArray(raw.providers)
    ? raw.providers
        .map(sanitizeProvider)
        .filter((p): p is ProviderInstance => p !== null)
    : []

  const activeProviderId =
    typeof raw.activeProviderId === 'string' &&
    providers.some((p) => p.id === raw.activeProviderId)
      ? raw.activeProviderId
      : null

  const sanitized: AppSettings = {
    activeProviderId,
    providers,
    devMode: raw.devMode === true,
    general: {
      autoLaunch: raw.general?.autoLaunch ?? base.general.autoLaunch,
      runAsAdmin: raw.general?.runAsAdmin ?? base.general.runAsAdmin,
      summonHotkey: raw.general?.summonHotkey ?? base.general.summonHotkey,
      language: pickEnum<Language>(
        raw.general?.language,
        LANGUAGE_LIST,
        base.general.language
      ),
      rememberPetPosition:
        raw.general?.rememberPetPosition ?? base.general.rememberPetPosition
    },
    appearance: {
      size: pickEnum<SizePreset>(raw.appearance?.size, SIZE_LIST, base.appearance.size),
      theme: pickEnum<Theme>(raw.appearance?.theme, THEME_LIST, base.appearance.theme),
      opacity: clampOpacity(raw.appearance?.opacity, base.appearance.opacity),
      highDpi: raw.appearance?.highDpi ?? base.appearance.highDpi,
      petPosition: sanitizePetPosition(raw.appearance?.petPosition)
    },
    interaction: {
      vibrancy: pickEnum<Vibrancy>(
        raw.interaction?.vibrancy,
        VIBRANCY_LIST,
        base.interaction.vibrancy
      ),
      hideOnFullscreen:
        raw.interaction?.hideOnFullscreen ?? base.interaction.hideOnFullscreen,
      // 用 DEV 全集：兼容已存的 '10s'
      idleNapAfter: pickEnum<NapDelay>(
        raw.interaction?.idleNapAfter,
        NAP_DELAY_LIST_DEV,
        base.interaction.idleNapAfter
      )
    },
    intelligence: {
      remoteSpeed: pickEnum<RemoteSpeed>(
        raw.intelligence?.remoteSpeed,
        REMOTE_SPEED_LIST,
        base.intelligence.remoteSpeed
      ),
      failoverEnabled:
        raw.intelligence?.failoverEnabled ?? base.intelligence.failoverEnabled,
      reasoningMode: raw.intelligence?.reasoningMode === true
    },
    permissions: {
      allowed: Array.isArray(raw.permissions?.allowed)
        ? raw.permissions.allowed
            .map(sanitizePermissionRecord)
            .filter((r): r is PermissionRecord => r !== null)
        : []
    },
    tools: {
      // 老 permissions.allowed → 'builtin:<tool>'='alwaysAllow'，现有策略优先
      policies: (() => {
        const policiesSanitized = sanitizeToolPolicies(raw.tools?.policies)
        if (Array.isArray(raw.permissions?.allowed)) {
          for (const r of raw.permissions.allowed) {
            const rec = sanitizePermissionRecord(r)
            if (!rec) continue
            const key = `builtin:${rec.tool}`
            if (!(key in policiesSanitized)) policiesSanitized[key] = 'alwaysAllow'
          }
        }
        return policiesSanitized
      })(),
      openWebSearch: sanitizeOpenWebSearch(raw.tools?.openWebSearch),
      fetchUrl: sanitizeFetchUrl(raw.tools?.fetchUrl)
    },
    mcpServers: Array.isArray(raw.mcpServers)
      ? raw.mcpServers
          .map(sanitizeMcpServer)
          .filter((s): s is McpServerConfig => s !== null)
      : [],
    history: {
      maxKeep:
        typeof raw.history?.maxKeep === 'number' && raw.history.maxKeep > 0
          ? Math.floor(raw.history.maxKeep)
          : base.history.maxKeep
    },
    vitals: sanitizeVitals(raw.vitals),
    dev: {
      devToolsEnabled: raw.dev?.devToolsEnabled === true
    }
  }

  // 工具配置走独立文件 userData/tool/<id>.json；toolStore 优先覆盖
  const aggregated = aggregateToolsFromFiles()
  if (aggregated) {
    sanitized.tools = {
      // 缺失 key 用 main store 兜底，避免早期升级用户丢授权
      policies: { ...sanitized.tools.policies, ...aggregated.policies },
      openWebSearch: aggregated.openWebSearch,
      fetchUrl: aggregated.fetchUrl
    }
  } else {
    splitToolsToFiles(sanitized.tools)
  }
  return sanitized
}

export function saveSettings(settings: AppSettings): void {
  splitToolsToFiles(settings.tools)
  store.set(settings)
}

export function clearAllData(): void {
  store.clear()
}

// 一次性迁移：读老 settings.history.conversations
export function readLegacyHistoryConversations(): ConversationRecord[] {
  const raw = store.store as { history?: { conversations?: unknown } }
  const list = raw.history?.conversations
  if (!Array.isArray(list)) return []
  return list
    .map(sanitizeConversation)
    .filter((c): c is ConversationRecord => c !== null)
}

export function clearLegacyHistoryConversations(): void {
  const current = store.get('history') as { maxKeep?: unknown; conversations?: unknown }
  const maxKeep =
    typeof current?.maxKeep === 'number' && current.maxKeep > 0 ? current.maxKeep : 50
  store.set('history', { maxKeep })
}

// vitals 单字段读写：避开 loadSettings 全量 sanitize 和 settings:changed 广播
export function getVitalsFromStore(): PetVitals {
  return sanitizeVitals((store.store as { vitals?: unknown }).vitals)
}

export function setVitalsInStore(vitals: PetVitals): void {
  store.set('vitals', sanitizeVitals(vitals))
}
