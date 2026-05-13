import { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray } from 'electron'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  AppSettings,
  AskUserQuestionResponse,
  BubbleState,
  ChatMessage,
  ClipName,
  ConversationRecord,
  defaultBubbleState,
  McpServerConfig,
  ModelTier,
  PermissionDecision,
  PetMenuAction,
  PetVitals,
  PlayClipOptions,
  ProviderInstance,
  ScreenInfo,
  SIZE_LABELS,
  SizePreset,
  StopClipOptions,
  TrayMenuAction,
  TrayMenuState,
  Vibrancy
} from '@shared/types'
import { getTrayDict } from '@shared/i18n'
import { clearAllData, loadSettings, saveSettings } from './store'
import {
  clearConversations,
  deleteConversation,
  listConversations,
  migrateLegacyHistoryIfNeeded,
  saveConversation,
  trimOldestBeyond
} from './historyStore'
import { director } from './director'
import { streamChat, StreamHandle, testProvider, UsageDelta } from './llm'
import { bumpVitals, getVitals, startVitalsTick } from './vitals'
import { resolvePermission, setPetWebContents } from './llm/permission'
import {
  resolveAskUser,
  setPetWebContents as setAskUserPetWebContents
} from './llm/askUser'
import { bootstrapBuiltinTools, listToolViews } from './llm/registry'
import { pruneStreamLogs } from './llm/streamLog'
import { bootstrapSystemControlTools, startEverythingService, stopEverythingService, shutdownUiaService } from './system'
import {
  startPresenceWatch,
  getCachedPresenceState,
  type PresenceState
} from './system/presence'
import {
  startAllMcpServers,
  stopAllMcpServers,
  addMcpServer,
  removeMcpServer,
  toggleMcpServer,
  restartMcpServer,
  listMcpStatuses
} from './mcp/lifecycle'
import { assembleSystemPrompt, formatNow, PromptMode } from './promptBuilder'

let petWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let trayMenuWindow: BrowserWindow | null = null
let petMenuWindow: BrowserWindow | null = null
let tray: Tray | null = null
let activeStream: StreamHandle | null = null
let topmostTimer: NodeJS.Timeout | null = null
let isQuitting = false
let exitFallbackTimer: NodeJS.Timeout | null = null
let devToolsEnabled = false
// 气泡状态（逻辑像素）：renderer 推过来，main 广播给 Pet renderer 布局
let bubbleState: BubbleState = defaultBubbleState()

const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL']
const PROD_HTML = join(__dirname, '../renderer/index.html')
const APP_ICON = join(__dirname, '../../resources/icon.ico')
const TOPMOST_REASSERT_MS = 1000
// exit 110 帧 / 24fps ≈ 4.58s + 900ms 缓冲
const EXIT_ANIMATION_TIMEOUT_MS = 5500
// tray 菜单：5 项 + 1 分隔
const TRAY_MENU_WIDTH = 200
const TRAY_MENU_HEIGHT = 232
// 桌宠右键：2 项 + 1 分隔
const PET_MENU_WIDTH = 160
const PET_MENU_HEIGHT = 96

function loadRoute(win: BrowserWindow, route: string): void {
  if (RENDERER_DEV_URL) {
    void win.loadURL(`${RENDERER_DEV_URL}#${route}`)
  } else {
    void win.loadFile(PROD_HTML, { hash: route })
  }
}

type Bounds = { x: number; y: number; width: number; height: number }

// sprite 帧逻辑像素（与 renderer 同源）
const SPRITE_FRAME_WIDTH = 240
const SPRITE_FRAME_HEIGHT = 280

// 全屏覆盖：窗口 = 整屏 bounds
function computePetWindowBounds(): Bounds {
  const { bounds } = screen.getPrimaryDisplay()
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

// 默认 anchor：右下角脚踩任务栏
function computeDefaultAnchor(size: SizePreset): { x: number; y: number } {
  const scale = SIZE_LABELS[size].scale
  const { workArea, bounds } = screen.getPrimaryDisplay()
  const taskbarHeight = bounds.height - workArea.height
  const width = Math.round(SPRITE_FRAME_WIDTH * scale)
  const height = Math.round(SPRITE_FRAME_HEIGHT * scale)
  // 素材脚部未贴 280 底，要往上抬
  const footOffset = Math.round((71 - 32) * scale)
  const x = workArea.x + workArea.width - width - 32
  const y = bounds.height - taskbarHeight - height + footOffset
  return { x, y }
}

function buildScreenInfo(size: SizePreset): ScreenInfo {
  const scale = SIZE_LABELS[size].scale
  const { workArea, bounds } = screen.getPrimaryDisplay()
  return {
    screen: { width: bounds.width, height: bounds.height },
    workArea: {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height
    },
    defaultAnchor: computeDefaultAnchor(size),
    spriteSize: {
      width: Math.round(SPRITE_FRAME_WIDTH * scale),
      height: Math.round(SPRITE_FRAME_HEIGHT * scale)
    }
  }
}

function createPetWindow(): void {
  const { x, y, width, height } = computePetWindowBounds()

  petWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    icon: APP_ICON,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // focusable:false——不进 alt+tab，不抢桌面焦点
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  petWindow.setAlwaysOnTop(true, 'pop-up-menu', 1)
  // 默认整窗鼠标穿透；forward 让 mousemove 传给 renderer 做 hit-test
  petWindow.setIgnoreMouseEvents(true, { forward: true })
  // 显式再设一次：transparent+alwaysOnTop 下构造器的 skipTaskbar 偶尔失效
  petWindow.setSkipTaskbar(true)
  petWindow.once('ready-to-show', () => {
    petWindow?.show()
    petWindow?.setSkipTaskbar(true)
  })
  // permission.ts 推送权限询问事件
  setPetWebContents(petWindow.webContents)
  // askUser.ts 独立持有 wc
  setAskUserPetWebContents(petWindow.webContents)
  petWindow.on('closed', () => {
    setPetWebContents(null)
    setAskUserPetWebContents(null)
    petWindow = null
  })

  // 显示器变化 → 重设全屏 bounds 并广播 ScreenInfo 重校锚点
  const onDisplayChange = (): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    petWindow.setBounds(computePetWindowBounds())
    petWindow.webContents.send('settings:changed')
  }
  screen.on('display-metrics-changed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)
  petWindow.on('closed', () => {
    screen.off('display-metrics-changed', onDisplayChange)
    screen.off('display-added', onDisplayChange)
    screen.off('display-removed', onDisplayChange)
  })

  loadRoute(petWindow, '/')
}

function startTopmostReassert(): void {
  if (topmostTimer) return
  topmostTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return
    petWindow.setAlwaysOnTop(false)
    petWindow.setAlwaysOnTop(true, 'pop-up-menu', 1)
  }, TOPMOST_REASSERT_MS)
}

function stopTopmostReassert(): void {
  if (topmostTimer) {
    clearInterval(topmostTimer)
    topmostTimer = null
  }
}

// 裸 IPC：只发 clip，不更新 mirror、不 show
function rawSendPlayClip(name: ClipName, opts: PlayClipOptions): void {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.webContents.send('pet:play-clip', name, opts)
}

function togglePetVisibility(): void {
  if (!petWindow) return
  if (petWindow.isVisible()) petWindow.hide()
  else petWindow.show()
}

// 开机自启：写 HKCU\...\Run，仅打包后生效
function applyAutoLaunch(enabled: boolean): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged && enabled) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  })
}

// 透明度：UI 是 20-100 整数，setOpacity 收 0-1
function applyOpacity(opacity: number): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const clamped = Math.max(20, Math.min(100, opacity))
  petWindow.setOpacity(clamped / 100)
}

// size 切换不动窗口，仅广播让 renderer 改 CSS transform
function applySize(_size: SizePreset): void {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.webContents.send('settings:changed')
}

// 气泡展开/收起：窗口不动，广播给 Pet renderer 内部布局
function applyBubbleState(next: BubbleState): void {
  bubbleState = next
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('bubble:state-changed', next)
  }
}

// dnd 或全屏占用时隐藏，unknown 视作可见
function shouldPetBeVisible(): boolean {
  const s = loadSettings()
  if (s.interaction.vibrancy === 'dnd') return false
  if (s.interaction.hideOnFullscreen && getCachedPresenceState() === 'busy') return false
  return true
}

function reconcilePetVisibility(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const want = shouldPetBeVisible()
  if (want && !petWindow.isVisible()) petWindow.show()
  if (!want && petWindow.isVisible()) petWindow.hide()
}

// 历史名字保留——所有 vibrancy 变化的调用方都走这一个入口
function applyVibrancy(_v: Vibrancy): void {
  reconcilePetVisibility()
}

// presence watch handle——hideOnFullscreen 切换时启停 loop
let presenceUnwatch: (() => void) | null = null

function applyHideOnFullscreen(enabled: boolean): void {
  if (enabled && !presenceUnwatch) {
    presenceUnwatch = startPresenceWatch((s: PresenceState) => {
      console.log('[presence] state →', s)
      reconcilePetVisibility()
    })
  } else if (!enabled && presenceUnwatch) {
    presenceUnwatch()
    presenceUnwatch = null
    // 停 watch 后 cached 变 unknown，宠物只受 vibrancy 约束
    reconcilePetVisibility()
  }
}

// F12 监听统一在 attachDevToolsHandler 挂，这里只切标志位
function applyDevToolsEnabled(enabled: boolean): void {
  devToolsEnabled = enabled
}

function attachDevToolsHandler(wc: Electron.WebContents): void {
  wc.on('before-input-event', (_event, input) => {
    if (!devToolsEnabled) return
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      wc.toggleDevTools()
    }
  })
}

// 启动时把已存设置物化到窗口/系统
function applyInitialSettings(): void {
  const s = loadSettings()
  applyAutoLaunch(s.general.autoLaunch)
  applyOpacity(s.appearance.opacity)
  applyVibrancy(s.interaction.vibrancy)
  applyHideOnFullscreen(s.interaction.hideOnFullscreen)
  applyDevToolsEnabled(s.dev.devToolsEnabled)
  director.applySettings({
    vibrancy: s.interaction.vibrancy,
    idleNapAfter: s.interaction.idleNapAfter
  })
}

// 保存时按字段差异分发，少做无谓的窗口操作
function applySettingsDiff(prev: AppSettings, next: AppSettings): void {
  if (prev.general.autoLaunch !== next.general.autoLaunch) {
    applyAutoLaunch(next.general.autoLaunch)
  }
  if (prev.appearance.opacity !== next.appearance.opacity) {
    applyOpacity(next.appearance.opacity)
  }
  if (prev.appearance.size !== next.appearance.size) {
    applySize(next.appearance.size)
  }
  if (prev.interaction.vibrancy !== next.interaction.vibrancy) {
    applyVibrancy(next.interaction.vibrancy)
  }
  if (prev.interaction.hideOnFullscreen !== next.interaction.hideOnFullscreen) {
    applyHideOnFullscreen(next.interaction.hideOnFullscreen)
  }
  if (
    prev.interaction.vibrancy !== next.interaction.vibrancy ||
    prev.interaction.idleNapAfter !== next.interaction.idleNapAfter
  ) {
    director.applySettings({
      vibrancy: next.interaction.vibrancy,
      idleNapAfter: next.interaction.idleNapAfter
    })
  }
  if (prev.general.language !== next.general.language) {
    refreshTrayLocale()
  }
  if (prev.dev.devToolsEnabled !== next.dev.devToolsEnabled) {
    applyDevToolsEnabled(next.dev.devToolsEnabled)
  }
}

// 语言切换时同步刷新 tray 工具提示——自定义菜单走 renderer 自己的 i18n，无需在 main 刷
function refreshTrayLocale(): void {
  if (!tray) return
  const settings = loadSettings()
  const dict = getTrayDict(settings.general.language, app.getLocale())
  tray.setToolTip(dict.appName)
}

// 播 exit clip → renderer onClipDone 回执 app.exit；超时强退
function requestQuit(): void {
  if (isQuitting) return
  isQuitting = true

  if (
    petWindow &&
    !petWindow.isDestroyed() &&
    petWindow.webContents &&
    !petWindow.webContents.isDestroyed()
  ) {
    // 走 Director 让 mirror 同步
    director.dispatch('exit', { force: true })
    exitFallbackTimer = setTimeout(() => {
      exitFallbackTimer = null
      app.exit(0)
    }, EXIT_ANIMATION_TIMEOUT_MS)
  } else {
    app.exit(0)
  }
}

function toggleDnd(): void {
  const settings = loadSettings()
  const next: Vibrancy = settings.interaction.vibrancy === 'dnd' ? 'normal' : 'dnd'
  saveSettings({
    ...settings,
    interaction: { ...settings.interaction, vibrancy: next }
  })
  applyVibrancy(next)
  broadcastSettingsChanged()
}

function toggleReasoningMode(): void {
  const settings = loadSettings()
  saveSettings({
    ...settings,
    intelligence: {
      ...settings.intelligence,
      reasoningMode: !settings.intelligence.reasoningMode
    }
  })
  broadcastSettingsChanged()
}

// exceptSenderId 跳过发起方，避免同帧本地新值被回灌闪烁
function broadcastSettingsChanged(exceptSenderId?: number): void {
  for (const win of [petWindow, settingsWindow]) {
    if (!win || win.isDestroyed()) continue
    if (win.webContents.id === exceptSenderId) continue
    win.webContents.send('settings:changed')
  }
}

// 独立 frameless 窗口：create / show / hide 三函数协议
function createTrayMenuWindow(): void {
  if (trayMenuWindow) return
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: TRAY_MENU_HEIGHT,
    icon: APP_ICON,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  trayMenuWindow.setAlwaysOnTop(true, 'pop-up-menu', 1)

  // devtools 开着时跳过失焦关闭，否则一打开 devtools 菜单就被吞
  trayMenuWindow.on('blur', () => {
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
    if (trayMenuWindow.webContents.isDevToolsOpened()) return
    hideTrayMenu()
  })

  trayMenuWindow.on('closed', () => {
    trayMenuWindow = null
  })
}

function showTrayMenu(cursorPos: { x: number; y: number }): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
    createTrayMenuWindow()
  }
  if (!trayMenuWindow) return

  // 菜单底边对齐鼠标向上弹，工作区夹紧防越界
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.max(
    workArea.x + 4,
    Math.min(cursorPos.x, workArea.x + workArea.width - TRAY_MENU_WIDTH - 4)
  )
  const y = Math.max(
    workArea.y + 4,
    Math.min(
      cursorPos.y - TRAY_MENU_HEIGHT,
      workArea.y + workArea.height - TRAY_MENU_HEIGHT - 4
    )
  )

  trayMenuWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: TRAY_MENU_WIDTH,
    height: TRAY_MENU_HEIGHT
  })

  // 重新 loadRoute 让 renderer 拉最新状态
  loadRoute(trayMenuWindow, '/tray-menu')
  trayMenuWindow.show()
  trayMenuWindow.focus()
}

function hideTrayMenu(): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return
  if (trayMenuWindow.isVisible()) trayMenuWindow.hide()
}

// 桌宠右键菜单——同 tray 菜单模式（避免内嵌被窗口边缘裁剪）
function createPetMenuWindow(): void {
  if (petMenuWindow) return
  petMenuWindow = new BrowserWindow({
    width: PET_MENU_WIDTH,
    height: PET_MENU_HEIGHT,
    icon: APP_ICON,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  petMenuWindow.setAlwaysOnTop(true, 'pop-up-menu', 1)

  petMenuWindow.on('blur', () => {
    if (!petMenuWindow || petMenuWindow.isDestroyed()) return
    if (petMenuWindow.webContents.isDevToolsOpened()) return
    hidePetMenu()
  })

  petMenuWindow.on('closed', () => {
    petMenuWindow = null
  })
}

function showPetMenu(screenPos: { x: number; y: number }): void {
  if (!petMenuWindow || petMenuWindow.isDestroyed()) {
    createPetMenuWindow()
  }
  if (!petMenuWindow) return

  // 鼠标点即菜单左上角，越界向内夹紧
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.max(
    workArea.x + 4,
    Math.min(screenPos.x, workArea.x + workArea.width - PET_MENU_WIDTH - 4)
  )
  const y = Math.max(
    workArea.y + 4,
    Math.min(screenPos.y, workArea.y + workArea.height - PET_MENU_HEIGHT - 4)
  )

  petMenuWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: PET_MENU_WIDTH,
    height: PET_MENU_HEIGHT
  })

  // 暂停 pet 置顶，否则 1Hz reassert 会反复盖住菜单
  stopTopmostReassert()
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(false)
  }

  loadRoute(petMenuWindow, '/pet-menu')
  petMenuWindow.show()
  petMenuWindow.focus()
}

function hidePetMenu(): void {
  // 无条件恢复 pet 置顶，防御 showPetMenu 失败路径
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(true, 'pop-up-menu', 1)
  }
  startTopmostReassert()
  if (!petMenuWindow || petMenuWindow.isDestroyed()) return
  if (petMenuWindow.isVisible()) petMenuWindow.hide()
}

function createTray(): void {
  if (tray) return
  tray = new Tray(APP_ICON)
  const settings = loadSettings()
  const dict = getTrayDict(settings.general.language, app.getLocale())
  tray.setToolTip(dict.appName)
  tray.on('click', () => {
    // TODO: 实现「呼叫小刘」
  })
  tray.on('right-click', () => {
    // 用鼠标坐标定位，与原生 tray 菜单一致
    showTrayMenu(screen.getCursorScreenPoint())
  })
  tray.on('double-click', createSettingsWindow)
}

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 920,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '你好，小刘（社区版） - 设置',
    icon: APP_ICON,
    backgroundColor: '#FFFFFF',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#FFFFFF', symbolColor: '#1A1A1A', height: 40 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  try {
    settingsWindow.setBackgroundMaterial?.('mica')
  } catch {
    // 旧版兜底
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
  })
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  loadRoute(settingsWindow, '/settings')
}

function mutateProviderStats(
  id: string,
  mutator: (stats: ProviderInstance['stats']) => ProviderInstance['stats']
): void {
  const settings = loadSettings()
  const idx = settings.providers.findIndex((p) => p.id === id)
  if (idx === -1) return
  const next: AppSettings = {
    ...settings,
    providers: settings.providers.map((p, i) =>
      i === idx ? { ...p, stats: mutator(p.stats) } : p
    )
  }
  saveSettings(next)
  broadcastSettingsChanged()
}

function bumpProviderRequest(id: string): void {
  mutateProviderStats(id, (s) => ({
    ...s,
    requests: s.requests + 1,
    lastUsedAt: Date.now()
  }))
}

function bumpProviderError(id: string): void {
  mutateProviderStats(id, (s) => ({ ...s, errors: s.errors + 1 }))
}

function bumpProviderUsage(id: string, usage: UsageDelta): void {
  mutateProviderStats(id, (s) => ({
    ...s,
    inputTokens: s.inputTokens + usage.inputTokens,
    outputTokens: s.outputTokens + usage.outputTokens
  }))
}

function buildFailoverChain(settings: AppSettings): ProviderInstance[] {
  const { providers, activeProviderId, intelligence } = settings
  const isUsable = (p: ProviderInstance) => p.apiKey.trim() !== ''

  if (!intelligence.failoverEnabled) {
    // 关闭：只用 active
    const active = providers.find((p) => p.id === activeProviderId)
    return active && isUsable(active) ? [active] : []
  }

  // 开启：pool 取代 active，按列表顺序故障下切
  return providers.filter((p) => p.inFailoverPool && isUsable(p))
}

async function runStreamWithFailover(
  chain: ProviderInstance[],
  messages: ChatMessage[],
  buildSystem: (mode: PromptMode) => string,
  tier: ModelTier,
  send: (channel: string, ...args: unknown[]) => void
): Promise<void> {
  if (chain.length === 0) {
    send('llm:error', '没有可用的供应商，请先在设置中添加并填入 API Key')
    return
  }

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]
    bumpProviderRequest(provider.id)
    let receivedAnyChunk = false

    const result = await new Promise<
      { ok: true } | { ok: false; message: string; partial: boolean } | { ok: 'aborted' }
    >((resolve) => {
      activeStream = streamChat(
        provider,
        messages,
        {
          onChunk: (text) => {
            receivedAnyChunk = true
            send('llm:chunk', text)
          },
          onMood: (mood) => send('llm:mood', mood),
          onToolDescribe: (tool, describe) =>
            send('llm:tool-describe', tool.name, tool.args, describe),
          // 工具结果回灌也算 partial：下一个 provider 没上轮工具上下文，行为会撕裂
          onToolResult: (result) => {
            receivedAnyChunk = true
            send('llm:tool-result', result.name, result.ok, result.content)
          },
          onTitle: (title) => send('llm:title', title),
          onUsage: (u) => bumpProviderUsage(provider.id, u),
          onDone: () => resolve({ ok: true }),
          onError: (message) =>
            resolve({ ok: false, message, partial: receivedAnyChunk }),
          // 用户硬中断：与 onDone/onError 完全分支，不抓延伸、不 failover、不上报
          onAborted: () => resolve({ ok: 'aborted' })
        },
        { buildSystem, tier }
      )
    })

    // 硬中断：不 failover，直接收场
    if (result.ok === 'aborted') {
      send('llm:done')
      activeStream = null
      return
    }

    if (result.ok) {
      // 自然 onDone：学到东西 + 亲密一点（中断/错误不累加）
      bumpVitals({ knowledge: 1, bond: 1 })
      send('llm:done')
      activeStream = null
      return
    }

    bumpProviderError(provider.id)

    // 已发出 chunk，跨 provider 续写会撕裂 → 报错收场
    if (result.partial || i === chain.length - 1) {
      send('llm:error', result.message)
      activeStream = null
      return
    }
    // 否则进入下一 provider 重试（静默 failover）
  }
}

function registerIPC(): void {
  ipcMain.handle('settings:load', () => loadSettings())

  ipcMain.handle('settings:save', (e, payload: AppSettings) => {
    const prev = loadSettings()
    saveSettings(payload)
    applySettingsDiff(prev, payload)
    // 跳过发起方，避免本地状态被回灌覆盖
    broadcastSettingsChanged(e.sender.id)
    return true
  })

  ipcMain.handle('settings:clear-all', () => {
    clearAllData()
    broadcastSettingsChanged()
    return true
  })

  ipcMain.handle('settings:export', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow ?? petWindow
    const result = await dialog.showSaveDialog(owner ?? undefined!, {
      title: '导出设置',
      defaultPath: 'hiliu-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, JSON.stringify(loadSettings(), null, 2), 'utf8')
    return true
  })

  ipcMain.handle('settings:import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? settingsWindow ?? petWindow
    const result = await dialog.showOpenDialog(owner ?? undefined!, {
      title: '导入设置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return false
    try {
      const text = readFileSync(result.filePaths[0], 'utf8')
      const data = JSON.parse(text) as AppSettings
      saveSettings(data)
      broadcastSettingsChanged()
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(
    'settings:test-provider',
    async (_e, provider: ProviderInstance) => {
      return testProvider(provider)
    }
  )

  // 工具注册表：仅可序列化字段
  ipcMain.handle('tools:list', () => listToolViews())

  // MCP status：设置页拉初始状态，'tools:status-changed' 增量更新
  ipcMain.handle('tools:list-mcp-status', () => listMcpStatuses())

  ipcMain.handle('tools:add-mcp-server', async (_e, cfg: McpServerConfig) => {
    return addMcpServer(cfg)
  })

  ipcMain.handle('tools:remove-mcp-server', async (_e, id: string) => {
    await removeMcpServer(id)
  })

  ipcMain.handle('tools:toggle-mcp-server', async (_e, id: string, enabled: boolean) => {
    await toggleMcpServer(id, enabled)
  })

  ipcMain.handle('tools:restart-mcp-server', async (_e, id: string) => {
    await restartMcpServer(id)
  })

  // 对话归档走独立文件，不混 settings（写频高，避免全量广播）
  ipcMain.handle('history:list', () => {
    return listConversations()
  })

  // 保存后做一次限长 trim
  ipcMain.handle('history:save', (_e, record: ConversationRecord) => {
    const ok = saveConversation(record)
    if (ok) {
      const settings = loadSettings()
      trimOldestBeyond(settings.history.maxKeep)
    }
    return ok
  })

  ipcMain.handle('history:delete', (_e, id: string) => {
    return deleteConversation(id)
  })

  ipcMain.handle('history:clear', () => {
    return clearConversations()
  })

  ipcMain.on('window:set-titlebar-theme', (_e, isDark: boolean) => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return
    const bgColor = isDark ? '#202024' : '#FFFFFF'
    settingsWindow.setBackgroundColor(bgColor)
    settingsWindow.setTitleBarOverlay?.({
      color: bgColor,
      symbolColor: isDark ? '#EBEBF0' : '#1A1A1A',
      height: 40
    })
  })

  ipcMain.on('window:open-settings', () => createSettingsWindow())
  ipcMain.on('window:close-settings', () => settingsWindow?.close())
  ipcMain.on('window:quit-app', () => requestQuit())

  ipcMain.on('window:relaunch', () => {
    const settings = loadSettings()
    // 管理员模式 + 打包 → 走 UAC 提权重启
    if (
      settings.general.runAsAdmin &&
      process.platform === 'win32' &&
      app.isPackaged
    ) {
      const exePath = process.execPath.replace(/'/g, "''")
      try {
        spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `Start-Process -FilePath '${exePath}' -Verb RunAs`
          ],
          { detached: true, stdio: 'ignore' }
        ).unref()
        app.exit(0)
        return
      } catch {
        // 提权失败兜底为普通重启，避免应用永久无法重启
      }
    }
    app.relaunch()
    app.exit(0)
  })

  // 设置→桌宠：播放 clip。DnD 时强 show，走 Director 保持 mirror 一致
  ipcMain.on('pet:play-clip', (_e, name: ClipName, opts: PlayClipOptions) => {
    if (!petWindow || petWindow.isDestroyed()) return
    if (!petWindow.isVisible()) petWindow.show()
    director.dispatch(name, opts ?? {})
  })

  // 设置窗→桌宠窗的「停止 clip」转发
  ipcMain.on('pet:stop-clip', (_e, opts: StopClipOptions) => {
    if (!petWindow || petWindow.isDestroyed()) return
    petWindow.webContents.send('pet:stop-clip', opts ?? {})
  })

  // 行走调试三件套：start / stop / walk-finished
  ipcMain.on('pet:start-walk', (_e, speed: number) => {
    if (!petWindow || petWindow.isDestroyed()) return
    if (!petWindow.isVisible()) petWindow.show()
    director.dispatch('walk-start', { next: 'walk-loop' })
    petWindow.webContents.send('pet:walk-command', { action: 'start', speed })
  })
  ipcMain.on('pet:stop-walk', () => {
    if (!petWindow || petWindow.isDestroyed()) return
    petWindow.webContents.send('pet:walk-command', { action: 'stop' })
  })
  ipcMain.on('pet:walk-finished', () => {
    director.dispatch('walk-end', { force: true })
  })

  // facing 是渲染层会话状态，main/director 不需感知
  ipcMain.on('pet:toggle-facing', () => {
    if (!petWindow || petWindow.isDestroyed()) return
    petWindow.webContents.send('pet:toggle-facing-cmd')
  })

  // exit clip 结束 → app.exit；同步通知 Director 和设置窗
  ipcMain.on('pet:clip-done', (_e, name: ClipName | null) => {
    director.notifyClipDone(name)
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('pet:clip-done', name)
    }
    if (name === 'exit' && isQuitting) {
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer)
        exitFallbackTimer = null
      }
      app.exit(0)
    }
  })

  ipcMain.on('window:open-external', (_e, url: string) => {
    void shell.openExternal(url)
  })

  // 养成属性：pat = mood+5/bond+2，触发 idle-playball
  ipcMain.handle('vitals:get', () => getVitals())
  ipcMain.on('vitals:pat', () => {
    bumpVitals({ mood: 5, bond: 2 })
    director.dispatch('idle-playball', { force: true })
  })

  // 像素穿透由 renderer hit-test 决定。forward:true 让 mousemove 仍传给 renderer
  ipcMain.on('window:set-ignore-mouse', (event, ignore: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === petWindow && win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: ignore })
    }
  })

  // 气泡输入框需要焦点：临时翻 focusable=true 并 focus，关闭后翻回
  ipcMain.on('window:set-focusable', (event, focusable: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === petWindow && win && !win.isDestroyed()) {
      win.setFocusable(focusable)
      if (focusable) win.focus()
    }
  })

  ipcMain.on('llm:stream-start', (event, messages: ChatMessage[]) => {
    activeStream?.abort()
    const settings = loadSettings()
    const chain = buildFailoverChain(settings)
    const conversation = messages.filter((m) => m.role !== 'system')
    const buildSystem = (mode: PromptMode): string =>
      assembleSystemPrompt({ now: formatNow(), settings, mode })
    const tier: ModelTier = settings.intelligence.reasoningMode ? 'reasoning' : 'daily'
    void runStreamWithFailover(chain, conversation, buildSystem, tier, (channel, ...args) =>
      event.sender.send(channel, ...args)
    )
  })

  ipcMain.on('llm:stream-abort', () => {
    activeStream?.abort()
    activeStream = null
  })

  // 权限决议：按 reqId 兑现 promise
  ipcMain.on(
    'permission:resolve',
    (_e, reqId: string, decision: PermissionDecision) => {
      resolvePermission(reqId, decision)
    }
  )

  // ask_user 决议，与 permission 对称
  ipcMain.on('ask-user:resolve', (_e, response: AskUserQuestionResponse) => {
    resolveAskUser(response)
  })

  // 自定义 tray 菜单：renderer 拉状态、点击后 main 执行并隐藏
  ipcMain.handle('tray-menu:get-state', () => {
    const settings = loadSettings()
    const result: TrayMenuState = {
      petVisible: petWindow?.isVisible() ?? false,
      dndMode: settings.interaction.vibrancy === 'dnd',
      reasoningMode: settings.intelligence.reasoningMode
    }
    return result
  })

  ipcMain.on('tray-menu:action', (_e, action: TrayMenuAction) => {
    switch (action) {
      case 'toggle-visibility':
        togglePetVisibility()
        break
      case 'toggle-dnd':
        toggleDnd()
        break
      case 'toggle-reasoning':
        toggleReasoningMode()
        break
      case 'open-settings':
        createSettingsWindow()
        break
      case 'quit':
        requestQuit()
        break
      case 'close':
        // Esc 触发，仅隐藏菜单
        break
    }
    hideTrayMenu()
  })

  // 桌宠右键菜单：Pet 端把鼠标 screen 坐标透过来，main 据此定位独立菜单窗口
  ipcMain.on('pet-menu:show', (_e, pos: { x: number; y: number }) => {
    showPetMenu(pos)
  })

  // 内容容器气泡：renderer 测量内容尺寸后推过来，main 广播给 Pet renderer 做内部布局。
  // 全屏窗口方案下不再 setBounds，气泡尺寸变化只影响 renderer DOM。
  // 启动时拿一次快照，避免 race
  ipcMain.handle('bubble:get-state', () => bubbleState)
  ipcMain.on('bubble:set-state', (_e, next: BubbleState) => {
    applyBubbleState({
      visible: !!next.visible,
      width: Math.max(0, Math.round(next.width || 0)),
      height: Math.max(0, Math.round(next.height || 0)),
      chatOpen: !!next.chatOpen
    })
  })

  // 屏幕信息：renderer 启动/拖拽时拉一次
  ipcMain.handle('pet:get-screen-info', () => {
    const settings = loadSettings()
    return buildScreenInfo(settings.appearance.size)
  })

  // 拖拽位置持久化：直接存，不广播（renderer 已经自行更新位置）
  ipcMain.on('pet:save-position', (_e, pos: { x: number; y: number } | null) => {
    const settings = loadSettings()
    const next: AppSettings = {
      ...settings,
      appearance: {
        ...settings.appearance,
        petPosition:
          pos &&
          typeof pos.x === 'number' &&
          typeof pos.y === 'number' &&
          !Number.isNaN(pos.x) &&
          !Number.isNaN(pos.y)
            ? { x: Math.round(pos.x), y: Math.round(pos.y) }
            : null
      }
    }
    saveSettings(next)
    // 拖拽由 renderer 主导，不广播 settings:changed
  })

  ipcMain.on('pet-menu:action', (_e, action: PetMenuAction) => {
    switch (action) {
      case 'open-settings':
        createSettingsWindow()
        break
      case 'quit':
        requestQuit()
        break
      case 'close':
        // Esc 触发，仅隐藏菜单
        break
    }
    hidePetMenu()
  })
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('chat.hiliu.community')
  }
  // createPetWindow 前拦截 web-contents
  app.on('web-contents-created', (_e, wc) => attachDevToolsHandler(wc))
  migrateLegacyHistoryIfNeeded()
  pruneStreamLogs()
  bootstrapBuiltinTools()
  bootstrapSystemControlTools()
  // -instance hiliu 与用户已装 Everything 隔离
  startEverythingService()
  registerIPC()
  void startAllMcpServers()
  createPetWindow()
  startVitalsTick((v) => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send('vitals:changed', v)
    }
  })
  // Director 必须在 applySettings 前 init
  director.init({ sendPlayClip: rawSendPlayClip })
  applyInitialSettings()
  createTray()
  startTopmostReassert()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
  })
})

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  stopTopmostReassert()
  director.stop()
  tray?.destroy()
  tray = null
  // 退订 presence，避免 shutdown 期间继续发 RPC
  presenceUnwatch?.()
  presenceUnwatch = null
  void stopAllMcpServers()
  stopEverythingService()
  void shutdownUiaService()
})
