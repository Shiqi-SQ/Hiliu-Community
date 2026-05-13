import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AppSettings,
  ConversationRecord,
  Language,
  LANGUAGE_LABELS,
  LANGUAGE_LIST,
  McpRuntimeStatus,
  McpServerConfig,
  McpServerTemplate,
  RECOMMENDED_MCP_SERVERS,
  MODEL_TIER_LABELS,
  MODEL_TIER_LIST,
  ModelTier,
  NAP_DELAY_LIST_DEV,
  NAP_DELAY_LIST_USER,
  NapDelay,
  PROTOCOL_MODE_LABELS,
  PROTOCOL_MODE_LIST,
  CLIP_NAMES,
  CLIP_REGISTRY,
  ClipName,
  PROVIDER_PRESETS,
  PresetID,
  ProtocolMode,
  ProviderInstance,
  ProviderPreset,
  REMOTE_SPEED_LABELS,
  REMOTE_SPEED_LIST,
  SIZE_LABELS,
  SIZE_LIST,
  TestProviderResult,
  Theme,
  ToolDescriptorView,
  ToolPolicy,
  THEME_LABELS,
  THEME_LIST,
  VIBRANCY_LABELS,
  VIBRANCY_LIST,
  Vibrancy,
  SearchEngineConfig,
  SearchEngineId,
  OpenWebSearchSettings,
  FetchUrlSettings,
  defaultDevSettings,
  defaultFetchUrl,
  defaultOpenWebSearch,
  defaultSettings,
  emptyUsageStats
} from '@shared/types'
import iconUrl from '@resources/icon.png'
import shiqiAvatar from '@resources/Shiqi.png'
import crysmapleAvatar from '@resources/crysmaple.png'
import { useT, useLocale } from '../i18n'

type Section =
  | 'general'
  | 'appearance'
  | 'interaction'
  | 'intelligence'
  | 'intelligence-provider'
  | 'intelligence-usage'
  | 'intelligence-history'
  | 'intelligence-memory'
  | 'intelligence-tool'
  | 'intelligence-skill'
  | 'intelligence-mcp'
  | 'shortcuts'
  | 'lab'
  | 'developer'
  | 'about'

interface SectionMeta {
  id: Section
  label: string
  icon: string
  pinBottom?: boolean
  children?: SectionMeta[]
}

// label 存 i18n key
const SECTIONS: SectionMeta[] = [
  { id: 'general', label: 'sidebar.general', icon: 'fa-sliders' },
  { id: 'appearance', label: 'sidebar.appearance', icon: 'fa-palette' },
  { id: 'interaction', label: 'sidebar.interaction', icon: 'fa-comments' },
  {
    id: 'intelligence',
    label: 'sidebar.intelligence',
    icon: 'fa-microchip',
    children: [
      { id: 'intelligence-provider', label: 'sidebar.intelligenceProvider', icon: 'fa-server' },
      { id: 'intelligence-usage', label: 'sidebar.intelligenceUsage', icon: 'fa-chart-column' },
      { id: 'intelligence-history', label: 'sidebar.intelligenceHistory', icon: 'fa-clock-rotate-left' },
      { id: 'intelligence-memory', label: 'sidebar.intelligenceMemory', icon: 'fa-brain' },
      { id: 'intelligence-tool', label: 'sidebar.intelligenceTool', icon: 'fa-screwdriver-wrench' },
      { id: 'intelligence-skill', label: 'sidebar.intelligenceSkill', icon: 'fa-wand-magic-sparkles' },
      { id: 'intelligence-mcp', label: 'sidebar.intelligenceMcp', icon: 'fa-plug' }
    ]
  },
  { id: 'shortcuts', label: 'sidebar.shortcuts', icon: 'fa-keyboard' },
  { id: 'lab', label: 'sidebar.lab', icon: 'fa-flask' },
  { id: 'about', label: 'sidebar.about', icon: 'fa-circle-info', pinBottom: true }
]

export default function Settings(): JSX.Element {
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [loaded, setLoaded] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)
  const [toastVisible, setToastVisible] = useState(false)
  const [infoToast, setInfoToast] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: ''
  })
  const [expandedSections, setExpandedSections] = useState<Set<Section>>(new Set())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const infoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 自家保存的回灌判同，避免拖动等同帧操作被旧值盖回
  const lastSavedJsonRef = useRef<string | null>(null)
  const t = useT()

  useEffect(() => {
    document.title = t('app.settingsTitle')
  }, [t])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      if (infoToastTimerRef.current) clearTimeout(infoToastTimerRef.current)
    }
  }, [])

  function showInfoToast(message: string): void {
    setInfoToast({ visible: true, message })
    if (infoToastTimerRef.current) clearTimeout(infoToastTimerRef.current)
    infoToastTimerRef.current = setTimeout(
      () => setInfoToast((prev) => ({ ...prev, visible: false })),
      2400
    )
  }

  // 改即存
  function setAndSave(next: AppSettings): void {
    setSettings(next)
    lastSavedJsonRef.current = JSON.stringify(next)
    void window.xiaoliu.settings.save(next)
    setToastVisible(true)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 1400)
  }

  function toggleExpand(s: Section): void {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  useEffect(() => {
    let mounted = true
    void window.xiaoliu.settings.load().then((s) => {
      if (mounted) {
        setSettings(s)
        setLoaded(true)
      }
    })
    // 监听 main 广播（如托盘切免打扰）
    const off = window.xiaoliu.settings.onChanged(() => {
      void window.xiaoliu.settings.load().then((s) => {
        if (!mounted) return
        // 自家保存触发的回灌，跳过
        const json = JSON.stringify(s)
        if (lastSavedJsonRef.current && lastSavedJsonRef.current === json) {
          lastSavedJsonRef.current = null
          return
        }
        setSettings(s)
      })
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center text-zhihu-gray">
        <i className="fa-solid fa-spinner mr-2 animate-spin text-xl" />
        加载中…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-zhihu-card/70">
      <Titlebar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          section={section}
          expandedSections={expandedSections}
          onChange={setSection}
          onToggleExpand={toggleExpand}
          devMode={settings.devMode}
        />
        <main className="flex-1 overflow-y-auto px-10 py-8">
          {section === 'general' && (
            <GeneralSection
              settings={settings}
              onChange={setAndSave}
              onPromptRestart={() => setRestartOpen(true)}
            />
          )}
          {section === 'appearance' && (
            <AppearanceSection settings={settings} onChange={setAndSave} />
          )}
          {section === 'interaction' && (
            <InteractionSection settings={settings} onChange={setAndSave} />
          )}
          {section === 'intelligence-provider' && (
            <IntelligenceSection settings={settings} onChange={setAndSave} />
          )}
          {section === 'intelligence-usage' && (
            <UsageSection settings={settings} onChange={setAndSave} />
          )}
          {section === 'intelligence-history' && <HistorySection />}
          {section === 'intelligence-memory' && <PlaceholderSection title={t('sidebar.intelligenceMemory')} />}
          {section === 'intelligence-tool' && (
            <McpToolSection mode="tool" settings={settings} onChange={setAndSave} />
          )}
          {section === 'intelligence-skill' && <PlaceholderSection title={t('sidebar.intelligenceSkill')} />}
          {section === 'intelligence-mcp' && (
            <McpToolSection mode="mcp" settings={settings} onChange={setAndSave} />
          )}
          {section === 'shortcuts' && (
            <ShortcutsSection settings={settings} onChange={setAndSave} />
          )}
          {section === 'lab' && <LabSection />}
          {section === 'developer' && <DevSection settings={settings} onChange={setAndSave} onNavigate={setSection} />}
          {section === 'about' && <AboutSection settings={settings} onChange={setAndSave} onNavigate={setSection} onToast={showInfoToast} />}
        </main>
      </div>
      {restartOpen && <RestartConfirmModal onClose={() => setRestartOpen(false)} />}
      <SaveToast visible={toastVisible} />
      <InfoToast visible={infoToast.visible} message={infoToast.message} />
    </div>
  )
}

function Titlebar(): JSX.Element {
  const t = useT()
  return (
    <div className="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-zhihu-border-light bg-zhihu-card/60 px-4">
      <img src={iconUrl} alt="" className="h-4 w-4 object-contain" draggable={false} />
      <span className="text-sm font-medium text-zhihu-ink">{t('app.settingsTitle')}</span>
    </div>
  )
}

const DEVELOPER_SECTION: SectionMeta = {
  id: 'developer',
  label: 'sidebar.developer',
  icon: 'fa-code'
}

function Sidebar(props: {
  section: Section
  expandedSections: Set<Section>
  onChange: (s: Section) => void
  onToggleExpand: (s: Section) => void
  devMode: boolean
}): JSX.Element {
  const top = SECTIONS.filter((s) => !s.pinBottom)
  const bottom = SECTIONS.filter((s) => s.pinBottom)
  const t = useT()

  return (
    <aside className="flex w-[200px] shrink-0 flex-col overflow-hidden border-r border-zhihu-border-light bg-zhihu-card/40">
      <div className="mb-6 mt-6 flex shrink-0 items-center gap-2 px-6">
        <img
          src={iconUrl}
          alt="小刘"
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
          draggable={false}
        />
        <div className="min-w-0 leading-tight">
          <div className="text-sm font-semibold text-zhihu-ink">{t('app.shortName')}</div>
          <div className="text-[11px] text-zhihu-gray-2">{t('app.editionTag')}</div>
          <div className="mt-0.5 text-[11px] text-zhihu-gray">v0.1.25.c</div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3">
        <div className="flex-1 overflow-y-auto">
          <nav className="space-y-1">
            {top.map((s) => (
              <div key={s.id}>
                <SidebarItem
                  meta={s}
                  active={props.section === s.id || (s.children?.some((c) => c.id === props.section) ?? false)}
                  expanded={props.expandedSections.has(s.id)}
                  onClick={() => {
                    if (s.children) {
                      props.onToggleExpand(s.id)
                    } else {
                      props.onChange(s.id)
                    }
                }}
              />
              {s.children && props.expandedSections.has(s.id) && (
                <div className="ml-3 mt-1 space-y-1">
                  {s.children.map((child) => (
                    <SidebarItem
                      key={child.id}
                      meta={child}
                      active={props.section === child.id}
                      isChild
                      onClick={() => props.onChange(child.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
            {props.devMode && (
              <SidebarItem
                meta={DEVELOPER_SECTION}
                active={props.section === 'developer'}
                onClick={() => props.onChange('developer')}
              />
            )}
        </nav>
        </div>

        {bottom.length > 0 && (
          <div className="shrink-0 border-t border-zhihu-border-light py-3">
            <nav className="space-y-1">
              {bottom.map((s) => (
                <SidebarItem key={s.id} meta={s} active={props.section === s.id} onClick={() => props.onChange(s.id)} />
              ))}
            </nav>
          </div>
        )}
      </div>
    </aside>
  )
}

function SidebarItem(props: {
  meta: SectionMeta
  active: boolean
  expanded?: boolean
  isChild?: boolean
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const hasChildren = props.meta.children && props.meta.children.length > 0
  return (
    <button
      onClick={props.onClick}
      className={[
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors titlebar-no-drag',
        props.isChild ? 'text-xs' : '',
        props.active
          ? 'bg-zhihu-blue-light text-zhihu-blue'
          : 'text-zhihu-gray-2 hover:bg-zhihu-bg-soft hover:text-zhihu-ink'
      ].join(' ')}
    >
      <i className={`fa-solid ${props.meta.icon} text-base w-4 text-center`} />
      <span className="flex-1 text-left">{t(props.meta.label)}</span>
      {hasChildren && (
        <i
          className={[
            'fa-solid fa-chevron-down text-xs transition-transform',
            props.expanded ? 'rotate-180' : ''
          ].join(' ')}
        />
      )}
    </button>
  )
}

function GeneralSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onPromptRestart: () => void
}): JSX.Element {
  const { settings, onChange, onPromptRestart } = props
  const [confirming, setConfirming] = useState<'settings' | 'all' | null>(null)
  const t = useT()

  function patchGeneral(p: Partial<AppSettings['general']>): void {
    if (
      p.runAsAdmin !== undefined &&
      p.runAsAdmin !== settings.general.runAsAdmin
    ) {
      onPromptRestart()
    }
    onChange({ ...settings, general: { ...settings.general, ...p } })
  }

  function handleResetSettings(): void {
    const next = { ...defaultSettings(), providers: settings.providers, activeProviderId: settings.activeProviderId }
    onChange(next)
    setConfirming(null)
  }

  async function handleClearAll(): Promise<void> {
    await window.xiaoliu.settings.clearAll()
    setConfirming(null)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('general.title')} />

      <Card title={t('general.startup')}>
        <div className="space-y-4">
          <ToggleRow
            label={t('general.autoLaunch')}
            tip={t('general.autoLaunchTip')}
            value={settings.general.autoLaunch}
            onChange={(v) => patchGeneral({ autoLaunch: v })}
          />
          <ToggleRow
            label={t('general.runAsAdmin')}
            tip={t('general.runAsAdminTip')}
            tipVariant="warn"
            value={settings.general.runAsAdmin}
            onChange={(v) => patchGeneral({ runAsAdmin: v })}
          />
          <ToggleRow
            label={t('general.rememberPetPosition')}
            tip={t('general.rememberPetPositionTip')}
            value={settings.general.rememberPetPosition}
            onChange={(v) => patchGeneral({ rememberPetPosition: v })}
          />
        </div>
      </Card>

      <Card title={t('general.language')}>
        <Dropdown
          value={settings.general.language}
          onChange={(v) => patchGeneral({ language: v as Language })}
          options={LANGUAGE_LIST.map((l) => ({
            value: l,
            label: t(`language.${l}`)
          }))}
        />
      </Card>

      <Card title={t('general.backup')}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={async () => {
              await window.xiaoliu.settings.exportConfig()
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-2 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
          >
            <i className="fa-solid fa-file-export text-sm" />
            {t('common.export')}
          </button>
          <button
            onClick={async () => {
              await window.xiaoliu.settings.importConfig()
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-2 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
          >
            <i className="fa-solid fa-file-import text-sm" />
            {t('common.import')}
          </button>
          <span className="text-[11px] text-zhihu-gray">{t('general.backupNote')}</span>
        </div>
      </Card>

      <Card title={t('general.clear')} tone="danger">
        {confirming === null ? (
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setConfirming('settings')}
              className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-2 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
            >
              <i className="fa-solid fa-rotate-left text-sm" />
              {t('general.resetSettings')}
            </button>
            <button
              onClick={() => setConfirming('all')}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-zhihu-card px-4 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50"
            >
              <i className="fa-solid fa-trash-can text-sm" />
              {t('general.resetAndClear')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
            <i className="fa-solid fa-triangle-exclamation text-base text-rose-600" />
            <span className="flex-1 text-sm text-rose-700">
              {confirming === 'settings' ? t('general.resetSettingsConfirm') : t('general.clearConfirm')}
            </span>
            <button
              onClick={() => setConfirming(null)}
              className="rounded-lg px-3 py-1.5 text-sm text-zhihu-gray-2 hover:text-zhihu-ink"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirming === 'settings' ? handleResetSettings : handleClearAll}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700"
            >
              {confirming === 'settings' ? t('general.resetSettingsButton') : t('general.clearConfirmButton')}
            </button>
          </div>
        )}
      </Card>
    </div>
  )
}

function AppearanceSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings, onChange } = props
  const t = useT()

  function patchAppearance(p: Partial<AppSettings['appearance']>): void {
    onChange({ ...settings, appearance: { ...settings.appearance, ...p } })
  }

  const sizeIndex = SIZE_LIST.indexOf(settings.appearance.size)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('appearance.title')} />

      <Card title={t('appearance.size')}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zhihu-ink">
              {t(`size.${settings.appearance.size}`)}
            </span>
            <span className="font-mono text-xs text-zhihu-gray">
              {SIZE_LABELS[settings.appearance.size].scale}×
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={SIZE_LIST.length - 1}
            step={1}
            value={sizeIndex}
            onChange={(e) => patchAppearance({ size: SIZE_LIST[Number(e.target.value)] })}
            className="zhihu-slider w-full"
            style={{ ['--slider-fill' as string]: `${(sizeIndex / (SIZE_LIST.length - 1)) * 100}%` }}
          />
          <div className="flex justify-between px-1 text-[11px] text-zhihu-gray-2">
            {SIZE_LIST.map((s) => (
              <span
                key={s}
                className={
                  settings.appearance.size === s ? 'font-medium text-zhihu-blue' : ''
                }
              >
                {t(`size.${s}`)}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card title={t('appearance.theme')}>
        <Dropdown
          value={settings.appearance.theme}
          onChange={(v) => patchAppearance({ theme: v as Theme })}
          options={THEME_LIST.map((th) => ({
            value: th,
            label: t(`theme.${th}`),
            icon: THEME_LABELS[th].icon
          }))}
        />
      </Card>

      <Card title={t('appearance.opacity')}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zhihu-gray-2">
              {t('appearance.opacityDesc')}
            </span>
            <span className="font-mono text-sm font-medium text-zhihu-ink">
              {settings.appearance.opacity}%
            </span>
          </div>
          <input
            type="range"
            min={20}
            max={100}
            step={1}
            value={settings.appearance.opacity}
            onChange={(e) => patchAppearance({ opacity: Number(e.target.value) })}
            className="zhihu-slider w-full"
            style={{ ['--slider-fill' as string]: `${((settings.appearance.opacity - 20) / 80) * 100}%` }}
          />
          <div className="flex justify-between px-1 text-[11px] text-zhihu-gray-2">
            <span>{t('appearance.opacityMin')}</span>
            <span>{t('appearance.opacityMax')}</span>
          </div>
        </div>
      </Card>

      <Card title={t('appearance.render')}>
        <ToggleRow
          label={t('appearance.highDpi')}
          tip={t('appearance.highDpiTip')}
          value={settings.appearance.highDpi}
          onChange={(v) => patchAppearance({ highDpi: v })}
        />
      </Card>
    </div>
  )
}

function InteractionSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings, onChange } = props
  const t = useT()

  function setVibrancy(v: Vibrancy): void {
    onChange({ ...settings, interaction: { ...settings.interaction, vibrancy: v } })
  }

  function patchInteraction(p: Partial<AppSettings['interaction']>): void {
    onChange({ ...settings, interaction: { ...settings.interaction, ...p } })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('interaction.title')} />

      <Card title={t('interaction.vibrancy')}>
        <div className="grid grid-cols-4 gap-2">
          {VIBRANCY_LIST.map((v) => {
            const meta = VIBRANCY_LABELS[v]
            const active = settings.interaction.vibrancy === v
            return (
              <button
                key={v}
                onClick={() => setVibrancy(v)}
                className={[
                  'relative flex flex-col gap-1.5 rounded-xl border p-3 text-left transition-all',
                  active
                    ? 'border-zhihu-blue bg-zhihu-blue-light shadow-zhihu-pop'
                    : 'border-zhihu-border bg-zhihu-card hover:border-zhihu-blue/50'
                ].join(' ')}
              >
                {active && (
                  <i className="fa-solid fa-circle-check absolute right-2 top-2 text-sm text-zhihu-blue" />
                )}
                <i
                  className={[
                    'fa-solid',
                    meta.icon,
                    'text-lg leading-none',
                    active ? 'text-zhihu-blue' : 'text-zhihu-gray-2'
                  ].join(' ')}
                />
                <div
                  className={[
                    'text-sm font-medium',
                    active ? 'text-zhihu-blue' : 'text-zhihu-ink'
                  ].join(' ')}
                >
                  {t(`vibrancy.${v}`)}
                </div>
                <div className="text-[11px] leading-snug text-zhihu-gray">
                  {t(`vibrancy.${v}Desc`)}
                </div>
              </button>
            )
          })}
        </div>
      </Card>

      <Card title={t('interaction.idleNapAfter')} subtitle={t('interaction.idleNapAfterDesc')}>
        {(() => {
          const napList = settings.devMode ? NAP_DELAY_LIST_DEV : NAP_DELAY_LIST_USER
          // 退 devMode 时 '10s' 不合法，回退到 0
          const currentIdx = napList.indexOf(settings.interaction.idleNapAfter)
          const napIdx = currentIdx >= 0 ? currentIdx : 0
          return (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zhihu-ink">
                  {t(`napDelay.${napList[napIdx]}`)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={napList.length - 1}
                step={1}
                value={napIdx}
                onChange={(e) =>
                  patchInteraction({ idleNapAfter: napList[Number(e.target.value)] })
                }
                className="zhihu-slider w-full"
                style={{
                  ['--slider-fill' as string]: `${(napIdx / Math.max(1, napList.length - 1)) * 100}%`
                }}
              />
              {/* 刻度文字位置——百分比表示「文字中心」落在滑轨的哪一处。
                  改下面这俩数组就能手动调，按 list 顺序对应。
                  开发模式 4 档：10s / 10min / 30min / 1h
                  普通模式 3 档：10min / 30min / 1h */}
              <div className="relative h-4 text-[11px] text-zhihu-gray-2">
                {napList.map((d, i) => {
                  const NAP_TICK_LEFT_DEV = ['7%', '34%', '66.3%', '97%']
                  const NAP_TICK_LEFT_USER = ['3.5%', '50%', '97%']
                  const left = (settings.devMode ? NAP_TICK_LEFT_DEV : NAP_TICK_LEFT_USER)[i]
                  return (
                    <span
                      key={d}
                      className={[
                        'absolute -translate-x-1/2 whitespace-nowrap',
                        settings.interaction.idleNapAfter === d
                          ? 'font-medium text-zhihu-blue'
                          : ''
                      ].join(' ')}
                      style={{ left }}
                    >
                      {t(`napDelay.${d}`)}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })()}
      </Card>

      <Card title={t('interaction.scene')}>
        <ToggleRow
          label={t('interaction.hideOnFullscreen')}
          tip={t('interaction.hideOnFullscreenTip')}
          value={settings.interaction.hideOnFullscreen}
          onChange={(v) => patchInteraction({ hideOnFullscreen: v })}
        />
      </Card>
    </div>
  )
}

type ProviderView =
  | { kind: 'list' }
  | { kind: 'editor'; id: string | null; draft: ProviderInstance }

function getPresetById(id: PresetID | undefined): ProviderPreset | undefined {
  if (!id) return undefined
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

function createDraftFromPreset(preset: ProviderPreset): ProviderInstance {
  return {
    id: crypto.randomUUID(),
    name: preset.id === 'custom' ? '' : preset.name,
    note: '',
    presetId: preset.id,
    baseURL: preset.defaultBaseURL,
    apiKey: '',
    protocolMode: preset.protocolMode,
    models: { ...preset.defaultModels },
    stats: emptyUsageStats()
  }
}

function protocolModeKey(mode: ProtocolMode): string {
  return mode.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function formatRelativeTime(ts: number | null, locale: string, neverStr: string): string {
  if (!ts) return neverStr
  const diff = Date.now() - ts
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (diff < 60_000) return rtf.format(-Math.floor(diff / 1_000), 'second')
  if (diff < 3_600_000) return rtf.format(-Math.floor(diff / 60_000), 'minute')
  if (diff < 86_400_000) return rtf.format(-Math.floor(diff / 3_600_000), 'hour')
  if (diff < 7 * 86_400_000) return rtf.format(-Math.floor(diff / 86_400_000), 'day')
  return new Date(ts).toLocaleDateString(locale)
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function IntelligenceSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings, onChange } = props
  const [view, setView] = useState<ProviderView>({ kind: 'list' })
  const t = useT()

  function patchIntelligence(p: Partial<AppSettings['intelligence']>): void {
    onChange({ ...settings, intelligence: { ...settings.intelligence, ...p } })
  }

  function setActiveProvider(id: string | null): void {
    onChange({ ...settings, activeProviderId: id })
  }

  function deleteProvider(id: string): void {
    const nextProviders = settings.providers.filter((p) => p.id !== id)
    const nextActive =
      settings.activeProviderId === id ? null : settings.activeProviderId
    onChange({
      ...settings,
      providers: nextProviders,
      activeProviderId: nextActive
    })
  }

  // 切换故障转移池成员，状态独立于 failoverEnabled
  function togglePool(id: string): void {
    const next = settings.providers.map((p) =>
      p.id === id ? { ...p, inFailoverPool: !p.inFailoverPool } : p
    )
    onChange({ ...settings, providers: next })
  }

  // 复制配置：名字加" Copy"，重置统计，不改 activeProviderId
  function duplicateProvider(id: string): void {
    const idx = settings.providers.findIndex((p) => p.id === id)
    if (idx === -1) return
    const src = settings.providers[idx]
    const copy: ProviderInstance = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name} Copy`,
      stats: emptyUsageStats()
    }
    const nextProviders = [...settings.providers]
    nextProviders.splice(idx + 1, 0, copy)
    onChange({ ...settings, providers: nextProviders })
  }

  // 拖拽排序：fromId 在列表中的项移动到 toId 的位置（before）
  function reorderProviders(fromId: string, toId: string): void {
    if (fromId === toId) return
    const list = settings.providers
    const fromIdx = list.findIndex((p) => p.id === fromId)
    const toIdx = list.findIndex((p) => p.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...list]
    const [moved] = next.splice(fromIdx, 1)
    // 语义：drop on X 把拖拽项放到 X 的位置（X 整体右移）。
    // 注意 splice 后 fromIdx<toIdx 时 toIdx 已经左移 1，所以要 -1
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx
    next.splice(insertAt, 0, moved)
    onChange({ ...settings, providers: next })
  }

  function saveDraft(draft: ProviderInstance, originalId: string | null): void {
    const exists = originalId !== null
    const nextProviders = exists
      ? settings.providers.map((p) => (p.id === originalId ? draft : p))
      : [...settings.providers, draft]
    const nextActive =
      settings.activeProviderId ?? (exists ? settings.activeProviderId : draft.id)
    onChange({
      ...settings,
      providers: nextProviders,
      activeProviderId: nextActive
    })
    setView({ kind: 'list' })
  }

  if (view.kind === 'editor') {
    return (
      <ProviderEditor
        view={view}
        onChange={(draft) => setView({ ...view, draft })}
        onCancel={() => setView({ kind: 'list' })}
        onSave={() => saveDraft(view.draft, view.id)}
      />
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('intelligence.provider')} />

      <Card title={t('intelligence.providerList')}>
        <div className="space-y-3">
          {settings.providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isActive={settings.activeProviderId === p.id}
                failoverEnabled={settings.intelligence.failoverEnabled}
                onSetActive={() => setActiveProvider(p.id)}
                onTogglePool={() => togglePool(p.id)}
                onEdit={() =>
                  setView({ kind: 'editor', id: p.id, draft: { ...p } })
                }
                onDelete={() => deleteProvider(p.id)}
                onDuplicate={() => duplicateProvider(p.id)}
                onReorder={reorderProviders}
              />
            ))}
          {settings.providers.length === 0 && (
            <div />
          )}
          <button
            onClick={() => startAdd(setView)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zhihu-border bg-zhihu-card/40 py-3 text-sm font-medium text-zhihu-gray-2 transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
          >
            <i className="fa-solid fa-plus text-base" />
            {t('intelligence.addProvider')}
          </button>
        </div>
      </Card>

      <Card title={t('intelligence.failover')}>
        <ToggleRow
          label={t('intelligence.failoverLabel')}
          tip={t('intelligence.failoverTip')}
          desc={t('intelligence.failoverDesc')}
          value={settings.intelligence.failoverEnabled}
          onChange={(v) => patchIntelligence({ failoverEnabled: v })}
        />
      </Card>

      <Card title={t('intelligence.remoteSpeed')}>
        <div className="grid grid-cols-3 gap-3">
          {REMOTE_SPEED_LIST.map((s) => {
            const active = settings.intelligence.remoteSpeed === s
            return (
              <button
                key={s}
                onClick={() => patchIntelligence({ remoteSpeed: s })}
                className={[
                  'rounded-xl border p-3 text-left transition-all',
                  active
                    ? 'border-zhihu-blue bg-zhihu-blue-light shadow-zhihu-pop'
                    : 'border-zhihu-border bg-zhihu-card hover:border-zhihu-blue/50'
                ].join(' ')}
              >
                <div
                  className={[
                    'text-sm font-medium',
                    active ? 'text-zhihu-blue' : 'text-zhihu-ink'
                  ].join(' ')}
                >
                  {t(`remoteSpeed.${s}`)}
                </div>
                <div className="mt-1 text-[11px] text-zhihu-gray">{t(`remoteSpeed.${s}Desc`)}</div>
              </button>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

function startAdd(setView: (v: ProviderView) => void): void {
  const customPreset = PROVIDER_PRESETS.find((p) => p.id === 'custom')!
  setView({ kind: 'editor', id: null, draft: createDraftFromPreset(customPreset) })
}

function ProviderEmptyState(props: { onAdd: () => void }): JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zhihu-border bg-zhihu-bg-soft/50 px-6 py-12 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zhihu-card text-zhihu-blue/70 shadow-zhihu-card">
        <i className="fa-solid fa-server text-xl" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zhihu-ink">
        {t('intelligence.noProvider')}
      </h3>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-zhihu-gray-2">
        {t('intelligence.noProviderDesc')}
      </p>
      <button
        onClick={props.onAdd}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-zhihu-blue px-5 py-2 text-sm font-medium text-white shadow-zhihu-pop transition-colors hover:bg-zhihu-blue-active"
      >
        <i className="fa-solid fa-plus text-sm" />
        {t('intelligence.addProvider')}
      </button>
    </div>
  )
}

// 构建期把所有 provider 图标 URL 拍平成 basename → hash 路径
const PROVIDER_ICON_URLS: Record<string, string> = (() => {
  const modules = import.meta.glob('@resources/providers/*.svg', {
    eager: true,
    query: '?url',
    import: 'default'
  }) as Record<string, string>
  const map: Record<string, string> = {}
  for (const [path, url] of Object.entries(modules)) {
    const name = path.split('/').pop()
    if (name) map[name] = url
  }
  return map
})()

function ProviderBadge(props: {
  preset: ProviderPreset | undefined
  size?: 'sm' | 'md'
}): JSX.Element {
  const size = props.size ?? 'md'
  const dim = size === 'md' ? 'h-10 w-10' : 'h-7 w-7'
  const inner = size === 'md' ? 'h-6 w-6' : 'h-4 w-4'
  const fallbackText = size === 'md' ? 'text-base' : 'text-xs'
  const preset = props.preset
  const iconUrl = preset?.iconFile ? PROVIDER_ICON_URLS[preset.iconFile] : undefined
  // SVG 自带配色，浅灰底色避免与白色卡片融合；custom 或图标缺失时回退为拼图占位。
  if (iconUrl && preset) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-xl bg-zhihu-bg-soft ${dim}`}
      >
        <img src={iconUrl} alt={preset.name} className={`${inner} object-contain`} />
      </span>
    )
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-xl bg-zhihu-bg-soft font-semibold text-zhihu-gray ${dim} ${fallbackText}`}
    >
      <i className="fa-solid fa-puzzle-piece" />
    </span>
  )
}

function ProviderCard(props: {
  provider: ProviderInstance
  isActive: boolean
  failoverEnabled: boolean
  onSetActive: () => void
  onTogglePool: () => void
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
  onReorder: (fromId: string, toId: string) => void
}): JSX.Element {
  const { provider, isActive, failoverEnabled } = props
  const preset = getPresetById(provider.presetId)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // dragOver 用于显示「即将插入此处」的高亮，不影响数据
  const [dragOver, setDragOver] = useState(false)
  const t = useT()
  // 蓝边 = active；按钮态依 failover 模式切换
  const isOn = failoverEnabled ? provider.inFailoverPool === true : isActive
  const onLabel = failoverEnabled ? t('intelligence.joined') : t('intelligence.inUse')
  const offLabel = failoverEnabled ? t('intelligence.join') : t('intelligence.activate')
  const onToggle = failoverEnabled ? props.onTogglePool : props.onSetActive
  const onCancellable = failoverEnabled

  // HTML5 DnD：grip 按下时才开 draggable
  const [draggable, setDraggable] = useState(false)

  function handleDragStart(e: React.DragEvent<HTMLDivElement>): void {
    e.dataTransfer.setData('text/x-hiliu-provider', provider.id)
    e.dataTransfer.effectAllowed = 'move'
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('text/x-hiliu-provider')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }
  function handleDragLeave(): void {
    setDragOver(false)
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    const fromId = e.dataTransfer.getData('text/x-hiliu-provider')
    if (fromId) props.onReorder(fromId, provider.id)
  }
  function handleDragEnd(): void {
    setDraggable(false)
    setDragOver(false)
  }

  return (
    <div
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
      className={[
        'group rounded-xl border bg-zhihu-card p-4 transition-all',
        isActive
          ? 'border-zhihu-blue shadow-zhihu-pop ring-1 ring-zhihu-blue/20'
          : 'border-zhihu-border-light hover:border-zhihu-blue/40',
        dragOver ? 'ring-2 ring-zhihu-blue/40' : ''
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label={t('intelligence.dragHandle')}
          title={t('intelligence.dragHandle')}
          onMouseDown={() => setDraggable(true)}
          onMouseUp={() => setDraggable(false)}
          className="cursor-grab self-center rounded-md p-1 text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink active:cursor-grabbing"
        >
          <i className="fa-solid fa-grip-vertical text-xs" />
        </button>
        <ProviderBadge preset={preset} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="max-w-[14rem] truncate text-sm font-semibold text-zhihu-ink"
              title={provider.name || t('intelligence.unnamed')}
            >
              {provider.name || t('intelligence.unnamed')}
            </span>
            <span className="shrink-0 rounded-md bg-zhihu-bg-soft px-1.5 py-0.5 font-mono text-[10px] text-zhihu-gray-2">
              {t(`protocolMode.${protocolModeKey(provider.protocolMode)}`)}
            </span>
          </div>
          {provider.note?.trim() && (
            <div className="mt-0.5 truncate text-xs text-zhihu-gray-2">
              {provider.note}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zhihu-gray">
            <span
              className="max-w-[12rem] shrink-0 truncate"
              title={provider.models?.daily || preset?.defaultModels.daily || ''}
            >
              {provider.models?.daily || preset?.defaultModels.daily || t('intelligence.noModel')}
            </span>
            {provider.baseURL && (
              <>
                <span className="shrink-0 text-zhihu-gray/60">·</span>
                <span className="min-w-0 truncate" title={provider.baseURL}>
                  {provider.baseURL}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isOn ? (
            onCancellable ? (
              <button
                onClick={onToggle}
                title={onLabel}
                className="rounded-md bg-zhihu-bg-soft px-3 py-1.5 text-xs font-medium text-zhihu-gray-2 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
              >
                {onLabel}
              </button>
            ) : (
              <span
                className="pointer-events-none rounded-md bg-zhihu-bg-soft px-3 py-1.5 text-xs font-medium text-zhihu-gray-2 opacity-0 transition-opacity group-hover:opacity-100"
                aria-disabled
              >
                {onLabel}
              </span>
            )
          ) : (
            <button
              onClick={onToggle}
              className="rounded-md bg-zhihu-blue-light px-3 py-1.5 text-xs font-medium text-zhihu-blue opacity-0 transition-all hover:bg-zhihu-blue hover:text-white group-hover:opacity-100"
            >
              {offLabel}
            </button>
          )}
          <button
            onClick={props.onDuplicate}
            title={t('intelligence.duplicate')}
            className="rounded-md p-2 text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
          >
            <i className="fa-solid fa-copy text-xs" />
          </button>
          <button
            onClick={props.onEdit}
            title={t('common.edit')}
            className="rounded-md p-2 text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
          >
            <i className="fa-solid fa-pen text-xs" />
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            title={t('common.delete')}
            className="rounded-md p-2 text-zhihu-gray-2 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <i className="fa-solid fa-trash-can text-xs" />
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs">
          <i className="fa-solid fa-triangle-exclamation text-base text-rose-600" />
          <span className="flex-1 text-rose-700">
            {t('intelligence.deletePrefix')}「{provider.name || t('intelligence.unnamed')}」？{t('intelligence.deleteCannotUndo')}
          </span>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="rounded px-2 py-1 text-zhihu-gray-2 hover:text-zhihu-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              setConfirmingDelete(false)
              props.onDelete()
            }}
            className="rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700"
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  )
}

function UsageStat(props: {
  label: string
  value: string
  tone?: 'normal' | 'warn'
}): JSX.Element {
  const tone = props.tone ?? 'normal'
  return (
    <div className="flex flex-col items-center">
      <span
        className={[
          'text-sm font-semibold',
          tone === 'warn' ? 'text-rose-600' : 'text-zhihu-ink'
        ].join(' ')}
      >
        {props.value}
      </span>
      <span className="mt-0.5 text-[10px] text-zhihu-gray-2">{props.label}</span>
    </div>
  )
}

function ProviderEditor(props: {
  view: { kind: 'editor'; id: string | null; draft: ProviderInstance }
  onChange: (draft: ProviderInstance) => void
  onCancel: () => void
  onSave: () => void
}): JSX.Element {
  const { draft, id } = props.view
  const isAdd = id === null
  const [showKey, setShowKey] = useState(false)
  const [testResult, setTestResult] = useState<TestProviderResult | null>(null)
  const [testing, setTesting] = useState(false)
  const preset = getPresetById(draft.presetId)
  const t = useT()

  function patch(p: Partial<ProviderInstance>): void {
    props.onChange({ ...draft, ...p })
    setTestResult(null)
  }

  function applyPreset(presetId: PresetID): void {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    // 换 preset 一律清 apiKey，name 跟随
    const isCustom = p.id === 'custom'
    props.onChange({
      ...draft,
      presetId: p.id,
      name: isCustom ? '' : p.name,
      baseURL: p.defaultBaseURL,
      apiKey: '',
      protocolMode: p.protocolMode,
      models: { ...p.defaultModels }
    })
    setTestResult(null)
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    const r = await window.xiaoliu.settings.testProvider(draft)
    setTestResult(r)
    setTesting(false)
  }

  const canSave = draft.name.trim() && draft.baseURL.trim() && draft.apiKey.trim()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center gap-3">
        <button
          onClick={props.onCancel}
          className="rounded-lg p-2 text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
          title={t('common.back')}
        >
          <i className="fa-solid fa-arrow-left text-base" />
        </button>
        <h1
          className="min-w-0 flex-1 truncate text-2xl font-semibold text-zhihu-ink"
          title={isAdd ? '' : draft.name}
        >
          {isAdd ? t('intelligence.addProvider') : `${t('intelligence.editProvider')}${draft.name ? ` · ${draft.name}` : ''}`}
        </h1>
        <button
          onClick={props.onSave}
          disabled={!canSave}
          className={[
            'rounded-lg px-5 py-2 text-sm font-medium transition-colors',
            canSave
              ? 'bg-zhihu-blue text-white shadow-zhihu-pop hover:bg-zhihu-blue-active'
              : 'cursor-not-allowed bg-zhihu-bg text-zhihu-gray-2'
          ].join(' ')}
        >
          {t('common.save')}
        </button>
      </header>

      {isAdd && (
        <Card title={t('intelligence.selectPreset')} subtitle={t('intelligence.selectPresetSub')}>
          <div className="grid grid-cols-4 gap-2">
            {PROVIDER_PRESETS.filter((p) => !p.builtinOnly).map((p) => {
              const active = draft.presetId === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => applyPreset(p.id)}
                  className={[
                    'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-all',
                    active
                      ? 'border-zhihu-blue bg-zhihu-blue-light shadow-zhihu-pop'
                      : 'border-zhihu-border bg-zhihu-card hover:border-zhihu-blue/50'
                  ].join(' ')}
                >
                  <ProviderBadge preset={p} size="sm" />
                  <span
                    className={[
                      'truncate text-xs font-medium',
                      active ? 'text-zhihu-blue' : 'text-zhihu-ink'
                    ].join(' ')}
                  >
                    {p.name}
                  </span>
                </button>
              )
            })}
          </div>
        </Card>
      )}

      <Card title={t('intelligence.basicInfo')}>
        <div className="space-y-5">
          <div>
            <label className="label-field">{t('intelligence.providerName')}</label>
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={preset?.name ?? '取个好记的名字'}
              className="input-text"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="label-field">{t('intelligence.providerNote')}</label>
            <input
              value={draft.note ?? ''}
              onChange={(e) => patch({ note: e.target.value })}
              placeholder={t('intelligence.providerNotePlaceholder')}
              className="input-text"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="label-field">{t('intelligence.baseUrl')}</label>
            <input
              value={draft.baseURL}
              onChange={(e) => patch({ baseURL: e.target.value })}
              placeholder={preset?.defaultBaseURL ?? 'https://...'}
              className="input-text font-mono"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="label-field">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder={preset?.apiKeyHint ?? 'API Key'}
                className="input-text pr-10 font-mono"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-zhihu-gray hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
              >
                <i className={`fa-solid ${showKey ? 'fa-eye-slash' : 'fa-eye'} text-base`} />
              </button>
            </div>
            {preset?.docsURL && (
              <a
                onClick={(e) => {
                  e.preventDefault()
                  window.xiaoliu.window.openExternal(preset.docsURL)
                }}
                href={preset.docsURL}
                className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs text-zhihu-blue hover:underline"
              >
                {t('intelligence.getApiKey')}{' '}
                <i className="fa-solid fa-arrow-up-right-from-square text-[10px]" />
              </a>
            )}
          </div>

          <div>
            <label className="label-field">{t('intelligence.protocol')}</label>
            <ProtocolModeRadio
              value={draft.protocolMode}
              onChange={(v) => patch({ protocolMode: v })}
            />
            {preset && preset.id !== 'custom' && draft.protocolMode !== preset.protocolMode && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zhihu-gray-2">
                <span>
                  {t('intelligence.protocolDeviated')}
                  {t(`protocolMode.${protocolModeKey(preset.protocolMode)}`)}
                </span>
                <button
                  type="button"
                  onClick={() => patch({ protocolMode: preset.protocolMode })}
                  className="text-zhihu-blue hover:underline"
                >
                  {t('intelligence.revertProtocol')}
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <label className="label-field !mb-0">{t('intelligence.modelTier')}</label>
              <span className="text-[11px] text-zhihu-gray-2">
                {t('intelligence.modelTierNote')}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {MODEL_TIER_LIST.map((tier) => (
                <div key={tier}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-medium text-zhihu-ink">
                      {t(`modelTier.${tier}`)}
                    </span>
                  </div>
                  <input
                    value={draft.models[tier]}
                    onChange={(e) =>
                      patch({ models: { ...draft.models, [tier]: e.target.value } })
                    }
                    placeholder={preset?.defaultModels[tier] || 'model-name'}
                    className="input-text font-mono text-[12px]"
                    spellCheck={false}
                  />
                  <div className="mt-1 text-[10px] leading-snug text-zhihu-gray-2">
                    {t(`modelTier.${tier}Hint`)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-zhihu-border pt-5">
            <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-zhihu-gray-2">
              {t('intelligence.compatibility')}
            </div>
            <ToggleRow
              label={t('intelligence.disableExperimentalBetas')}
              desc={t('intelligence.disableExperimentalBetasDesc')}
              value={draft.disableExperimentalBetas === true}
              onChange={(v) => patch({ disableExperimentalBetas: v })}
            />
          </div>

          {testResult && (
            <div
              className={[
                'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
                testResult.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              ].join(' ')}
            >
              <i
                className={[
                  'fa-solid mt-0.5 shrink-0 text-base',
                  testResult.ok ? 'fa-circle-check' : 'fa-circle-xmark'
                ].join(' ')}
              />
              <div>
                <div className="font-medium">
                  {testResult.ok
                    ? `${t('intelligence.testOk')}${testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : ''}`
                    : t('intelligence.testFail')}
                </div>
                {!testResult.ok && (
                  <div className="mt-0.5 break-all text-xs opacity-80">
                    {testResult.message}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center pt-1">
            <button
              onClick={handleTest}
              disabled={testing || !draft.apiKey.trim()}
              className="btn-ghost"
            >
              <i
                className={[
                  'fa-solid text-base',
                  testing ? 'fa-spinner animate-spin' : 'fa-sparkles'
                ].join(' ')}
              />
              {testing ? t('intelligence.testing') : t('intelligence.testConnection')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function ShortcutsSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings, onChange } = props
  const t = useT()

  function patchGeneral(p: Partial<AppSettings['general']>): void {
    onChange({ ...settings, general: { ...settings.general, ...p } })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('shortcuts.title')} />

      <Card title={t('shortcuts.summonHotkey')}>
        <div className="flex items-center gap-2">
          <input
            value={settings.general.summonHotkey}
            onChange={(e) => patchGeneral({ summonHotkey: e.target.value })}
            placeholder="Alt+Space"
            className="input-text font-mono w-48"
            spellCheck={false}
          />
          <InfoTip text={t('shortcuts.summonTip')} />
        </div>
      </Card>
    </div>
  )
}

function LabSection(): JSX.Element {
  const t = useT()
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('lab.title')} />

      <Card title={t('lab.comingSoon')}>
        <ul className="space-y-3">
          <LabItem
            icon="fa-eye"
            title={t('lab.eyeTracking')}
            desc={t('lab.eyeTrackingDesc')}
          />
          <LabItem
            icon="fa-shoe-prints"
            title={t('lab.wandering')}
            desc={t('lab.wanderingDesc')}
          />
          <LabItem
            icon="fa-hand-pointer"
            title={t('lab.clickMode')}
            desc={t('lab.clickModeDesc')}
          />
          <LabItem
            icon="fa-comment-dots"
            title={t('lab.proactive')}
            desc={t('lab.proactiveDesc')}
          />
        </ul>
      </Card>
    </div>
  )
}

function LabItem(props: {
  icon: string
  title: string
  desc: string
}): JSX.Element {
  const t = useT()
  return (
    <li className="flex items-start gap-3 rounded-lg border border-dashed border-zhihu-border-light bg-zhihu-card/60 p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zhihu-blue-light text-zhihu-blue">
        <i className={`fa-solid ${props.icon} text-sm`} />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium text-zhihu-ink">{props.title}</div>
        <p className="mt-0.5 text-xs text-zhihu-gray-2">{props.desc}</p>
      </div>
      <span className="rounded-md bg-zhihu-bg px-2 py-0.5 text-[11px] text-zhihu-gray">
        {t('common.comingSoon')}
      </span>
    </li>
  )
}

function formatAbsoluteTime(ts: number | null, locale: string): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString(locale, { hour12: false })
}

function UsageSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { providers, activeProviderId } = props.settings
  const [confirmingResetAll, setConfirmingResetAll] = useState(false)
  const t = useT()
  const locale = useLocale()

  const total = providers.reduce(
    (acc, p) => ({
      requests: acc.requests + p.stats.requests,
      errors: acc.errors + p.stats.errors,
      inputTokens: acc.inputTokens + p.stats.inputTokens,
      outputTokens: acc.outputTokens + p.stats.outputTokens,
      lastUsedAt: Math.max(acc.lastUsedAt, p.stats.lastUsedAt ?? 0)
    }),
    { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0 }
  )
  const totalTokens = total.inputTokens + total.outputTokens
  const totalErrorRate = total.requests > 0 ? (total.errors / total.requests) * 100 : 0

  // active 优先，其余按最近使用倒序，未使用的排最后
  const sorted = [...providers].sort((a, b) => {
    if (a.id === activeProviderId) return -1
    if (b.id === activeProviderId) return 1
    return (b.stats.lastUsedAt ?? 0) - (a.stats.lastUsedAt ?? 0)
  })

  function resetStats(id: string): void {
    props.onChange({
      ...props.settings,
      providers: providers.map((p) =>
        p.id === id ? { ...p, stats: emptyUsageStats() } : p
      )
    })
  }

  function resetAll(): void {
    props.onChange({
      ...props.settings,
      providers: providers.map((p) => ({ ...p, stats: emptyUsageStats() }))
    })
    setConfirmingResetAll(false)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-10">
      <PageHeader
        title={t('intelligence.usageTitle')}
        subtitle={t('intelligence.usageSubtitle')}
      />

      <Card title={t('intelligence.usageOverview')}>
        <div className="grid grid-cols-4 gap-4">
          <UsageBigStat label={t('intelligence.totalRequests')} value={String(total.requests)} />
          <UsageBigStat
            label={t('intelligence.errors')}
            value={String(total.errors)}
            hint={total.requests > 0 ? `${totalErrorRate.toFixed(1)}%` : undefined}
            tone={total.errors > 0 ? 'warn' : 'normal'}
          />
          <UsageBigStat label={t('intelligence.inputTokens')} value={formatTokens(total.inputTokens)} />
          <UsageBigStat label={t('intelligence.outputTokens')} value={formatTokens(total.outputTokens)} />
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-zhihu-border-light pt-3 text-xs">
          <div className="flex gap-4 text-zhihu-gray-2">
            <span>
              <span className="font-medium text-zhihu-ink">{providers.length}</span> {t('intelligence.providers')}
            </span>
            <span>
              <span className="font-medium text-zhihu-ink">{formatTokens(totalTokens)}</span> {t('intelligence.tokensAccum')}
            </span>
            <span title={formatAbsoluteTime(total.lastUsedAt || null, locale)}>
              {t('intelligence.lastUsed')} <span className="font-medium text-zhihu-ink">{formatRelativeTime(total.lastUsedAt || null, locale, t('intelligence.neverUsed'))}</span>
            </span>
          </div>
          {providers.length > 0 && (
            confirmingResetAll ? (
              <div className="flex items-center gap-2 text-rose-700">
                <span>{t('intelligence.confirmResetAll')}</span>
                <button
                  onClick={() => setConfirmingResetAll(false)}
                  className="rounded px-2 py-1 text-zhihu-gray-2 hover:text-zhihu-ink"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={resetAll}
                  className="rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700"
                >
                  {t('intelligence.confirmResetAllBtn')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingResetAll(true)}
                className="text-zhihu-gray hover:text-rose-600"
              >
                {t('intelligence.resetAll')}
              </button>
            )
          )}
        </div>
      </Card>

      {sorted.length === 0 ? (
        <Card title={t('intelligence.provider')}>
          <div className="flex flex-col items-center py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zhihu-bg-soft">
              <i className="fa-solid fa-chart-column text-2xl text-zhihu-gray" />
            </div>
            <p className="mt-3 text-sm text-zhihu-gray-2">{t('intelligence.noUsageProvider')}</p>
            <p className="mt-0.5 text-xs text-zhihu-gray">{t('intelligence.noUsageProviderHint')}</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((p) => (
            <ProviderUsageCard
              key={p.id}
              provider={p}
              isActive={p.id === activeProviderId}
              onReset={() => resetStats(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProviderUsageCard(props: {
  provider: ProviderInstance
  isActive: boolean
  onReset: () => void
}): JSX.Element {
  const { provider, isActive } = props
  const preset = getPresetById(provider.presetId)
  const totalTokens = provider.stats.inputTokens + provider.stats.outputTokens
  const errorRate =
    provider.stats.requests > 0 ? (provider.stats.errors / provider.stats.requests) * 100 : 0
  const avgIn =
    provider.stats.requests > 0
      ? Math.round(provider.stats.inputTokens / provider.stats.requests)
      : 0
  const avgOut =
    provider.stats.requests > 0
      ? Math.round(provider.stats.outputTokens / provider.stats.requests)
      : 0
  const [confirming, setConfirming] = useState(false)
  const t = useT()
  const locale = useLocale()

  return (
    <div className="rounded-xl border border-zhihu-border-light bg-zhihu-card p-5 shadow-zhihu-card">
      <div className="flex items-start gap-3">
        <ProviderBadge preset={preset} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="max-w-[14rem] truncate text-sm font-semibold text-zhihu-ink"
              title={provider.name || t('intelligence.unnamed')}
            >
              {provider.name || t('intelligence.unnamed')}
            </span>
            {isActive && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zhihu-blue-light px-2 py-0.5 text-[11px] font-medium text-zhihu-blue">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-zhihu-blue" />
                {t('intelligence.activeProvider')}
              </span>
            )}
            <span className="shrink-0 rounded-md bg-zhihu-bg-soft px-1.5 py-0.5 font-mono text-[10px] text-zhihu-gray-2">
              {t(`protocolMode.${protocolModeKey(provider.protocolMode)}`)}
            </span>
          </div>
          {provider.note?.trim() && (
            <div className="mt-0.5 truncate text-xs text-zhihu-gray-2">
              {provider.note}
            </div>
          )}
          <div
            className="mt-1 truncate font-mono text-[11px] text-zhihu-gray"
            title={provider.models?.daily || preset?.defaultModels.daily || ''}
          >
            {provider.models?.daily || preset?.defaultModels.daily || t('intelligence.noModel')}
          </div>
        </div>
        {!confirming && (provider.stats.requests > 0 || provider.stats.errors > 0) && (
          <button
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-md p-2 text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
            title={t('intelligence.resetStatsTitle')}
          >
            <i className="fa-solid fa-arrow-rotate-left text-xs" />
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <UsageBigStat label={t('intelligence.requestCount')} value={String(provider.stats.requests)} />
        <UsageBigStat
          label={t('intelligence.errorCount')}
          value={String(provider.stats.errors)}
          hint={provider.stats.requests > 0 ? `${errorRate.toFixed(1)}%` : undefined}
          tone={provider.stats.errors > 0 ? 'warn' : 'normal'}
        />
        <UsageBigStat
          label={t('intelligence.lastUsed')}
          value={formatRelativeTime(provider.stats.lastUsedAt, locale, t('intelligence.neverUsed'))}
          title={formatAbsoluteTime(provider.stats.lastUsedAt, locale)}
        />
        <UsageBigStat label={t('intelligence.inputTokens')} value={formatTokens(provider.stats.inputTokens)} />
        <UsageBigStat label={t('intelligence.outputTokens')} value={formatTokens(provider.stats.outputTokens)} />
        <UsageBigStat label={t('intelligence.totalTokens')} value={formatTokens(totalTokens)} />
      </div>

      {provider.stats.requests > 0 && (
        <div className="mt-3 border-t border-zhihu-border-light pt-3 text-xs text-zhihu-gray">
          {t('intelligence.avgPerRequest')} ·{' '}
          <span className="font-medium text-zhihu-ink">{t('intelligence.avgInput')} {avgIn}</span> /{' '}
          <span className="font-medium text-zhihu-ink">{t('intelligence.avgOutput')} {avgOut}</span> tokens
        </div>
      )}

      {confirming && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs">
          <i className="fa-solid fa-triangle-exclamation text-base text-rose-600" />
          <span className="flex-1 text-rose-700">
            {t('intelligence.resetStatsPrefix')}「{provider.name || t('intelligence.unnamed')}」{t('intelligence.resetStatsSuffix')}
          </span>
          <button
            onClick={() => setConfirming(false)}
            className="rounded px-2 py-1 text-zhihu-gray-2 hover:text-zhihu-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              setConfirming(false)
              props.onReset()
            }}
            className="rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700"
          >
            {t('intelligence.reset')}
          </button>
        </div>
      )}
    </div>
  )
}

function UsageBigStat(props: {
  label: string
  value: string
  hint?: string
  tone?: 'normal' | 'warn'
  title?: string
}): JSX.Element {
  const tone = props.tone ?? 'normal'
  return (
    <div
      className="flex flex-col rounded-lg bg-zhihu-bg-soft/60 px-3 py-2.5"
      title={props.title}
    >
      <span className="text-[10px] uppercase tracking-wide text-zhihu-gray-2">
        {props.label}
      </span>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={[
            'text-lg font-semibold leading-tight',
            tone === 'warn' ? 'text-rose-600' : 'text-zhihu-ink'
          ].join(' ')}
        >
          {props.value}
        </span>
        {props.hint && (
          <span className="text-[11px] text-zhihu-gray-2">{props.hint}</span>
        )}
      </div>
    </div>
  )
}

function HistorySection(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [list, setList] = useState<ConversationRecord[]>([])
  // 左栏选中的对话——单选；选中后右栏渲染该对话的完整消息流
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const records = await window.xiaoliu.history.list()
    // 最新的对话排前面
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    setList(records)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 打开历史分区或窗口获焦时刷新——不支持实时通知
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // 选中对话被外部删掉（或从列表中消失）时把右栏空出来——避免显示已删除的内容
  useEffect(() => {
    if (selectedId && !list.some((c) => c.id === selectedId)) {
      setSelectedId(null)
      setConfirmingDeleteId(null)
    }
  }, [list, selectedId])

  const selected = list.find((c) => c.id === selectedId) ?? null

  const handleDelete = async (id: string): Promise<void> => {
    await window.xiaoliu.history.delete(id)
    setConfirmingDeleteId(null)
    if (selectedId === id) setSelectedId(null)
    await refresh()
  }

  const handleClearAll = async (): Promise<void> => {
    await window.xiaoliu.history.clear()
    setConfirmingClear(false)
    setSelectedId(null)
    await refresh()
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('history.title')} subtitle={t('history.subtitle')} />

      {list.length === 0 ? (
        <Card title={t('history.empty')} subtitle={t('history.emptyHint')}>
          <div className="flex items-center justify-center py-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-zhihu-bg-soft">
              <i className="fa-solid fa-comments text-2xl text-zhihu-gray" />
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid h-[640px] grid-cols-[280px_1fr] gap-4">
          <aside className="flex min-h-0 flex-col rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 shadow-zhihu-card backdrop-blur-sm">
            <div className="flex-1 overflow-y-auto p-2">
              <ul className="space-y-1">
                {list.map((conv) => {
                  const isSelected = selectedId === conv.id
                  const titleText = conv.title.trim() || t('history.untitled')
                  return (
                    <li key={conv.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(conv.id)
                          setConfirmingDeleteId(null)
                        }}
                        className={[
                          'group block w-full rounded-lg px-3 py-2 text-left transition-colors',
                          isSelected
                            ? 'bg-zhihu-blue/10 text-zhihu-ink'
                            : 'text-zhihu-ink hover:bg-zhihu-bg-soft'
                        ].join(' ')}
                      >
                        <h3 className="truncate text-sm font-medium">{titleText}</h3>
                        <p className="mt-0.5 truncate text-xs text-zhihu-gray-2">
                          {formatRelativeTime(conv.updatedAt, locale, '')}
                          <span className="mx-1.5">·</span>
                          {conv.messages.length} {t('history.messageCount')}
                        </p>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
            <div className="border-t border-zhihu-border-light p-2">
              {confirmingClear ? (
                <div className="space-y-1.5 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs">
                  <p className="text-rose-700">{t('history.confirmClearAll')}</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setConfirmingClear(false)}
                      className="flex-1 rounded px-2 py-1 text-zhihu-gray-2 hover:text-zhihu-ink"
                    >
                      {t('history.cancel')}
                    </button>
                    <button
                      onClick={() => void handleClearAll()}
                      className="flex-1 rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700"
                    >
                      {t('history.confirmClearAllBtn')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingClear(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50"
                >
                  <i className="fa-solid fa-trash-can text-xs" />
                  {t('history.clearAll')}
                </button>
              )}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 shadow-zhihu-card backdrop-blur-sm">
            {selected ? (
              <>
                <header className="flex items-start gap-3 border-b border-zhihu-border-light p-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-zhihu-ink">
                      {selected.title.trim() || t('history.untitled')}
                    </h3>
                    <p className="mt-0.5 text-xs text-zhihu-gray-2">
                      {formatRelativeTime(selected.updatedAt, locale, '')}
                      <span className="mx-2">·</span>
                      {selected.messages.length} {t('history.messageCount')}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfirmingDeleteId(selected.id)}
                    className="rounded-md p-2 text-zhihu-gray-2 transition-colors hover:bg-rose-50 hover:text-rose-600"
                    title={t('history.delete')}
                  >
                    <i className="fa-solid fa-trash-can text-xs" />
                  </button>
                </header>

                {confirmingDeleteId === selected.id && (
                  <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs">
                    <i className="fa-solid fa-triangle-exclamation text-base text-rose-600" />
                    <span className="flex-1 text-rose-700">{t('history.confirmDelete')}</span>
                    <button
                      onClick={() => setConfirmingDeleteId(null)}
                      className="rounded px-2 py-1 text-zhihu-gray-2 hover:text-zhihu-ink"
                    >
                      {t('history.cancel')}
                    </button>
                    <button
                      onClick={() => void handleDelete(selected.id)}
                      className="rounded bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-700"
                    >
                      {t('history.confirmDeleteBtn')}
                    </button>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-4">
                  <div className="space-y-3">
                    {selected.messages.map((msg, idx) => (
                      <div key={idx} className="flex gap-3">
                        <span
                          className={[
                            'shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium',
                            msg.role === 'user'
                              ? 'bg-zhihu-blue/10 text-zhihu-blue'
                              : 'bg-zhihu-bg-soft text-zhihu-gray'
                          ].join(' ')}
                        >
                          {msg.role === 'user' ? t('history.you') : t('history.pet')}
                        </span>
                        <p className="flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zhihu-ink">
                          {msg.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zhihu-bg-soft">
                  <i className="fa-solid fa-comments text-xl text-zhihu-gray" />
                </div>
                <p className="text-sm font-medium text-zhihu-ink">
                  {t('history.selectPrompt')}
                </p>
                <p className="text-xs text-zhihu-gray-2">{t('history.selectPromptHint')}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function PlaceholderSection(props: { title: string }): JSX.Element {
  const t = useT()
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={props.title} />
      <div className="mt-20 flex flex-col items-center justify-center text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-zhihu-bg-soft">
          <i className="fa-solid fa-hammer text-3xl text-zhihu-gray" />
        </div>
        <p className="mt-4 text-sm text-zhihu-gray-2">{t('placeholder.wip')}</p>
      </div>
    </div>
  )
}

const TOOL_POLICY_LIST: ToolPolicy[] = ['disabled', 'ask', 'alwaysAllow']

const POLICY_ICON: Record<ToolPolicy, string> = {
  disabled: 'fa-ban',
  ask: 'fa-circle-question',
  alwaysAllow: 'fa-shield-halved'
}

function McpToolSection(props: {
  // 'tool' 只渲内置工具，'mcp' 只渲 MCP server 区
  mode: 'tool' | 'mcp'
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { mode, settings, onChange } = props
  const t = useT()
  // 旧配置兜底，缺字段不白屏
  const policies = settings.tools?.policies ?? {}
  const mcpServers = settings.mcpServers ?? []
  const [tools, setTools] = useState<ToolDescriptorView[]>([])
  const [statuses, setStatuses] = useState<McpRuntimeStatus[]>([])
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())
  // null = 列表；string = tool id
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)

  // status 变化时同步刷新工具集
  useEffect(() => {
    let alive = true
    async function refresh(): Promise<void> {
      const [list, st] = await Promise.all([
        window.xiaoliu.tools.list(),
        window.xiaoliu.tools.listMcpStatus()
      ])
      if (!alive) return
      setTools(list)
      setStatuses(st)
    }
    void refresh()
    const off = window.xiaoliu.tools.onStatusChanged(() => {
      void refresh()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const builtinTools = tools.filter((tool) => tool.source === 'builtin')
  const mcpTools = tools.filter((tool) => tool.source === 'mcp')

  function setPolicy(toolId: string, policy: ToolPolicy): void {
    onChange({
      ...settings,
      tools: {
        ...(settings.tools ?? { policies: {} }),
        policies: { ...policies, [toolId]: policy }
      }
    })
  }

  function toggleExpand(serverId: string): void {
    setExpandedServers((prev) => {
      const next = new Set(prev)
      if (next.has(serverId)) next.delete(serverId)
      else next.add(serverId)
      return next
    })
  }

  async function handleAddServer(cfg: McpServerConfig): Promise<{ ok: boolean; error?: string }> {
    const result = await window.xiaoliu.tools.addMcpServer(cfg)
    if (result.ok) {
      setAddModalOpen(false)
      // server 出现 → 默认展开方便看工具
      setExpandedServers((prev) => new Set(prev).add(cfg.id))
    }
    return result
  }

  async function handleRemoveServer(id: string): Promise<void> {
    await window.xiaoliu.tools.removeMcpServer(id)
  }

  async function handleToggleServer(id: string, enabled: boolean): Promise<void> {
    await window.xiaoliu.tools.toggleMcpServer(id, enabled)
  }

  async function handleRestartServer(id: string): Promise<void> {
    await window.xiaoliu.tools.restartMcpServer(id)
  }

  const selectedTool = selectedToolId ? tools.find((tool) => tool.id === selectedToolId) : null
  if (selectedTool) {
    return (
      <ToolDetailPage
        tool={selectedTool}
        settings={settings}
        onChange={onChange}
        onBack={() => setSelectedToolId(null)}
      />
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t(mode === 'tool' ? 'mcpTool.toolTitle' : 'mcpTool.mcpTitle')}
        subtitle={t(mode === 'tool' ? 'mcpTool.toolSubtitle' : 'mcpTool.mcpSubtitle')}
      />

      {mode === 'mcp' && (
        <div className="space-y-3">
          {(() => {
            const pendingRecs = RECOMMENDED_MCP_SERVERS.filter(
              (tpl) => !mcpServers.some((s) => s.id === tpl.id)
            )
            if (pendingRecs.length === 0) return null
            return (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-zhihu-ink">
                  {t('mcpTool.recommendedSection')}
                </h3>
                {pendingRecs.map((tpl) => (
                  <RecommendedMcpCard
                    key={tpl.id}
                    template={tpl}
                    onAdd={() =>
                      handleAddServer({
                        id: tpl.id,
                        name: tpl.name,
                        command: tpl.command,
                        args: tpl.args,
                        env: tpl.env,
                        enabled: true
                      })
                    }
                    addLabel={t('mcpTool.recommendedAdd')}
                    badgeLabel={t('mcpTool.recommendedBadge')}
                  />
                ))}
              </div>
            )
          })()}

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zhihu-ink">
              {t('mcpTool.serverSection')}
            </h3>
            <button
              onClick={() => setAddModalOpen(true)}
              className="rounded-full bg-zhihu-blue px-4 py-1.5 text-xs font-medium text-white shadow-zhihu-pop hover:bg-zhihu-blue/90"
            >
              <i className="fa-solid fa-plus mr-1.5" />
              {t('mcpTool.addServer')}
            </button>
          </div>

          {mcpServers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zhihu-border bg-zhihu-bg-soft/50 px-6 py-12 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zhihu-card text-zhihu-gray-2">
                <i className="fa-solid fa-server text-xl" />
              </div>
              <p className="mt-4 text-xs text-zhihu-gray-2">{t('mcpTool.mcpEmpty')}</p>
            </div>
          ) : (
            mcpServers.map((cfg) => {
              const status =
                statuses.find((s) => s.serverId === cfg.id) ??
                ({ serverId: cfg.id, state: 'stopped', toolCount: 0 } as McpRuntimeStatus)
              const expanded = expandedServers.has(cfg.id)
              const serverTools = mcpTools.filter((tool) => tool.id.startsWith(`mcp:${cfg.id}:`))
              return (
                <McpServerCard
                  key={cfg.id}
                  cfg={cfg}
                  status={status}
                  tools={serverTools}
                  expanded={expanded}
                  policies={policies}
                  onToggleExpand={() => toggleExpand(cfg.id)}
                  onRestart={() => handleRestartServer(cfg.id)}
                  onRemove={() => handleRemoveServer(cfg.id)}
                  onToggleEnabled={(enabled) => handleToggleServer(cfg.id, enabled)}
                  onPolicyChange={setPolicy}
                  onOpenDetail={setSelectedToolId}
                />
              )
            })
          )}
        </div>
      )}

      {mode === 'tool' && (
        <div className="space-y-3">
          <PolicyLegend />
          {builtinTools.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zhihu-border bg-zhihu-bg-soft/50 px-6 py-12 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zhihu-card text-zhihu-gray-2">
                <i className="fa-solid fa-plug text-xl" />
              </div>
              <p className="mt-4 text-xs text-zhihu-gray-2">{t('mcpTool.empty')}</p>
            </div>
          ) : (
            builtinTools.map((tool) => {
              const currentPolicy: ToolPolicy = policies[tool.id] ?? 'ask'
              return (
                <ToolPolicyRow
                  key={tool.id}
                  tool={tool}
                  policy={currentPolicy}
                  onPolicyChange={(p) => setPolicy(tool.id, p)}
                  onOpenDetail={() => setSelectedToolId(tool.id)}
                />
              )
            })
          )}
        </div>
      )}

      {addModalOpen && (
        <McpAddServerModal
          existingIds={mcpServers.map((s) => s.id)}
          onCancel={() => setAddModalOpen(false)}
          onSubmit={handleAddServer}
        />
      )}
    </div>
  )
}

function RecommendedMcpCard(props: {
  template: McpServerTemplate
  onAdd: () => Promise<{ ok: boolean; error?: string }>
  addLabel: string
  badgeLabel: string
}): React.ReactElement {
  const { template, onAdd, addLabel, badgeLabel } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="rounded-2xl border border-zhihu-border bg-zhihu-card p-4 shadow-zhihu-soft">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-zhihu-blue/10 text-zhihu-blue">
          <i className={template.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zhihu-ink">{template.name}</span>
            <span className="rounded-full bg-zhihu-blue/10 px-2 py-0.5 text-[10px] font-medium text-zhihu-blue">
              {badgeLabel}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-zhihu-gray-2">{template.description}</p>
          <p className="mt-2 font-mono text-[10px] text-zhihu-gray-3 truncate">
            {template.command} {template.args.join(' ')}
          </p>
          {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            const result = await onAdd()
            setBusy(false)
            if (!result.ok) setError(result.error ?? '启用失败')
          }}
          className="flex-shrink-0 rounded-full bg-zhihu-blue px-3 py-1.5 text-xs font-medium text-white shadow-zhihu-pop hover:bg-zhihu-blue/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <i className="fa-solid fa-spinner fa-spin" /> : (
            <>
              <i className="fa-solid fa-plus mr-1" />
              {addLabel}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function McpServerCard(props: {
  cfg: McpServerConfig
  status: McpRuntimeStatus
  tools: ToolDescriptorView[]
  expanded: boolean
  policies: Record<string, ToolPolicy>
  onToggleExpand: () => void
  onRestart: () => void
  onRemove: () => void
  onToggleEnabled: (enabled: boolean) => void
  onPolicyChange: (toolId: string, policy: ToolPolicy) => void
  onOpenDetail: (toolId: string) => void
}): JSX.Element {
  const t = useT()
  const { cfg, status, tools, expanded, policies } = props
  const [confirmRemove, setConfirmRemove] = useState(false)

  const stateLabel: Record<McpRuntimeStatus['state'], string> = {
    running: t('mcpTool.serverStateRunning'),
    starting: t('mcpTool.serverStateStarting'),
    error: t('mcpTool.serverStateError'),
    stopped: t('mcpTool.serverStateStopped')
  }

  const dotColor: Record<McpRuntimeStatus['state'], string> = {
    running: 'bg-emerald-500',
    starting: 'bg-amber-400 animate-pulse',
    error: 'bg-rose-500',
    stopped: 'bg-zhihu-gray'
  }

  return (
    <section className="rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 shadow-zhihu-card backdrop-blur-sm">
      <div className="flex items-start gap-3 p-5">
        <button
          onClick={props.onToggleExpand}
          className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center text-zhihu-gray-2 hover:text-zhihu-ink"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <i
            className={`fa-solid fa-chevron-${expanded ? 'down' : 'right'} text-xs`}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${dotColor[status.state]}`} />
            <h4 className="text-sm font-semibold text-zhihu-ink">{cfg.name || cfg.id}</h4>
            <span className="text-[10px] text-zhihu-gray-2">{stateLabel[status.state]}</span>
            <span className="text-[10px] text-zhihu-gray">
              · {status.toolCount} {t('mcpTool.serverToolCount')}
            </span>
          </div>
          <p className="mt-1 font-mono text-[10px] text-zhihu-gray break-all">
            {cfg.command} {cfg.args.join(' ')}
          </p>
          {status.state === 'error' && status.error && (
            <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-[10px] text-rose-600">
              {status.error}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            onClick={() => props.onToggleEnabled(!cfg.enabled)}
            className="rounded-md border border-zhihu-border bg-zhihu-card px-2 py-1 text-[10px] text-zhihu-gray-2 hover:border-zhihu-blue/50 hover:text-zhihu-blue"
            title={cfg.enabled ? t('mcpTool.disableServer') : t('mcpTool.enableServer')}
          >
            <i className={`fa-solid fa-power-off ${cfg.enabled ? 'text-emerald-500' : ''}`} />
          </button>
          <button
            onClick={props.onRestart}
            disabled={!cfg.enabled}
            className="rounded-md border border-zhihu-border bg-zhihu-card px-2 py-1 text-[10px] text-zhihu-gray-2 hover:border-zhihu-blue/50 hover:text-zhihu-blue disabled:cursor-not-allowed disabled:opacity-40"
            title={t('mcpTool.restartServer')}
          >
            <i className="fa-solid fa-arrow-rotate-right" />
          </button>
          {confirmRemove ? (
            <>
              <button
                onClick={props.onRemove}
                className="rounded-md bg-rose-500 px-2 py-1 text-[10px] text-white hover:bg-rose-600"
              >
                {t('mcpTool.removeServer')}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="rounded-md border border-zhihu-border bg-zhihu-card px-2 py-1 text-[10px] text-zhihu-gray-2"
              >
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="rounded-md border border-zhihu-border bg-zhihu-card px-2 py-1 text-[10px] text-zhihu-gray-2 hover:border-rose-300 hover:text-rose-500"
              title={t('mcpTool.removeServer')}
            >
              <i className="fa-solid fa-trash" />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zhihu-border-light bg-zhihu-bg-soft/40 px-5 py-4">
          {tools.length === 0 ? (
            <p className="text-center text-[11px] text-zhihu-gray">
              {status.state === 'running'
                ? '(server 运行中但未暴露工具)'
                : '(server 未运行，启用后会列出工具)'}
            </p>
          ) : (
            <div className="space-y-2">
              <PolicyLegend />
              {tools.map((tool) => {
                const currentPolicy: ToolPolicy = policies[tool.id] ?? 'ask'
                return (
                  <ToolPolicyRow
                    key={tool.id}
                    tool={tool}
                    policy={currentPolicy}
                    onPolicyChange={(p) => props.onPolicyChange(tool.id, p)}
                    onOpenDetail={() => props.onOpenDetail(tool.id)}
                  />
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function McpAddServerModal(props: {
  existingIds: string[]
  onCancel: () => void
  onSubmit: (cfg: McpServerConfig) => Promise<{ ok: boolean; error?: string }>
}): JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1)
    }
    return env
  }

  function genId(label: string): string {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
    let id = slug || `mcp-${Date.now().toString(36)}`
    let i = 1
    while (props.existingIds.includes(id)) {
      id = `${slug || 'mcp'}-${i++}`
    }
    return id
  }

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!name.trim()) {
      setError('名称不能为空')
      return
    }
    if (!command.trim()) {
      setError('命令不能为空')
      return
    }
    const args = argsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const env = parseEnv(envText)
    const cfg: McpServerConfig = {
      id: genId(name.trim()),
      name: name.trim(),
      command: command.trim(),
      args,
      env: Object.keys(env).length ? env : undefined,
      cwd: cwd.trim() || undefined,
      enabled: true
    }
    setSubmitting(true)
    const result = await props.onSubmit(cfg)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error ?? '添加失败')
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-zhihu-card p-6 shadow-zhihu-pop">
        <h3 className="text-base font-semibold text-zhihu-ink">{t('mcpTool.addServerTitle')}</h3>

        <div className="mt-4 space-y-4">
          <label className="label-field">
            <span>{t('mcpTool.fieldServerName')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mcpTool.fieldServerNamePlaceholder')}
              className="input-text"
            />
          </label>

          <label className="label-field">
            <span>{t('mcpTool.fieldCommand')}</span>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('mcpTool.fieldCommandPlaceholder')}
              className="input-text font-mono"
            />
          </label>

          <label className="label-field">
            <span>
              {t('mcpTool.fieldArgs')}
              <span className="ml-2 text-[10px] font-normal text-zhihu-gray">
                {t('mcpTool.fieldArgsHint')}
              </span>
            </span>
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={t('mcpTool.fieldArgsPlaceholder')}
              rows={4}
              className="input-text font-mono text-xs"
            />
          </label>

          <label className="label-field">
            <span>
              {t('mcpTool.fieldEnv')}
              <span className="ml-2 text-[10px] font-normal text-zhihu-gray">
                {t('mcpTool.fieldEnvHint')}
              </span>
            </span>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={t('mcpTool.fieldEnvPlaceholder')}
              rows={3}
              className="input-text font-mono text-xs"
            />
          </label>

          <label className="label-field">
            <span>{t('mcpTool.fieldCwd')}</span>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t('mcpTool.fieldCwdPlaceholder')}
              className="input-text font-mono"
            />
          </label>

          {error && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={props.onCancel} className="btn-ghost" disabled={submitting}>
            {t('mcpTool.addServerCancel')}
          </button>
          <button onClick={handleSubmit} className="btn-primary" disabled={submitting}>
            {submitting ? t('intelligence.testing') : t('mcpTool.addServerSubmit')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function PolicyLegend(): JSX.Element {
  const t = useT()
  return (
    <p className="text-[11px] leading-relaxed text-zhihu-gray-2">
      <i className="fa-solid fa-circle-info mr-1.5 text-zhihu-blue/70" />
      {t('mcpTool.policyLegend')}
    </p>
  )
}

function ToolPolicyRow(props: {
  tool: ToolDescriptorView
  policy: ToolPolicy
  onPolicyChange: (p: ToolPolicy) => void
  onOpenDetail: () => void
}): JSX.Element {
  const { tool, policy, onPolicyChange, onOpenDetail } = props
  const t = useT()
  const sourceBadgeKey =
    tool.source === 'builtin' ? 'mcpTool.sourceBadgeBuiltin' : 'mcpTool.sourceBadgeMcp'

  return (
    <section className="rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 p-4 shadow-zhihu-card backdrop-blur-sm">
      <div className="flex items-center gap-4">
        {/* 左：工具元信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-zhihu-ink">
              {tool.displayName}
            </h3>
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                tool.source === 'builtin'
                  ? 'bg-zhihu-blue-light text-zhihu-blue'
                  : 'bg-emerald-50 text-emerald-600'
              ].join(' ')}
            >
              {t(sourceBadgeKey)}
            </span>
            {tool.exempt && (
              <span className="rounded-full bg-zhihu-bg-soft px-2 py-0.5 text-[10px] font-medium text-zhihu-gray-2">
                {t('mcpTool.exemptBadge')}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-zhihu-gray-2">
            {tool.description}
          </p>
          <p className="mt-1 font-mono text-[10px] text-zhihu-gray">{tool.name}</p>
        </div>

        {/* 右：segmented + 齿轮——shrink-0 防止被左侧描述挤压 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-zhihu-border bg-zhihu-bg-soft p-0.5">
            {TOOL_POLICY_LIST.map((p) => {
              const active = policy === p
              const disabled = tool.exempt
              return (
                <button
                  key={p}
                  disabled={disabled}
                  onClick={() => onPolicyChange(p)}
                  title={t(`mcpTool.policy${capitalize(p)}Hint`)}
                  className={[
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                    disabled
                      ? 'cursor-not-allowed text-zhihu-gray-3'
                      : active
                        ? 'bg-zhihu-card text-zhihu-blue shadow-zhihu-card'
                        : 'text-zhihu-gray-2 hover:text-zhihu-ink'
                  ].join(' ')}
                >
                  <i className={`fa-solid ${POLICY_ICON[p]} text-[11px]`} />
                  <span>{t(`mcpTool.policy${capitalize(p)}`)}</span>
                </button>
              )
            })}
          </div>

          {/* 齿轮——直接进入工具详情页；exempt 工具无可配置项故隐藏 */}
          {!tool.exempt && (
            <button
              onClick={onOpenDetail}
              title={t('mcpTool.policyMoreLabel')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-zhihu-gray-2 transition-colors hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
            >
              <i className="fa-solid fa-gear text-xs" />
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function ToolDetailPage(props: {
  tool: ToolDescriptorView
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onBack: () => void
}): JSX.Element {
  const { tool, settings, onChange, onBack } = props
  const t = useT()
  const sourceBadgeKey =
    tool.source === 'builtin' ? 'mcpTool.sourceBadgeBuiltin' : 'mcpTool.sourceBadgeMcp'

  function renderBody(): JSX.Element {
    switch (tool.id) {
      case 'builtin:open_web_search':
        return <ToolDetailOpenWebSearch settings={settings} onChange={onChange} />
      case 'builtin:fetch_url':
        return <ToolDetailFetchUrl settings={settings} onChange={onChange} />
      default:
        return (
          <div className="rounded-2xl border border-dashed border-zhihu-border bg-zhihu-bg-soft/50 px-6 py-10 text-center">
            <p className="text-xs text-zhihu-gray-2">{t('mcpTool.detailEmpty')}</p>
          </div>
        )
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-zhihu-gray-2 transition-colors hover:text-zhihu-blue"
      >
        <i className="fa-solid fa-arrow-left text-[11px]" />
        {t('mcpTool.detailBack')}
      </button>

      <section className="rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 p-5 shadow-zhihu-card backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-zhihu-ink">{tool.displayName}</h2>
          <span
            className={[
              'rounded-full px-2 py-0.5 text-[10px] font-medium',
              tool.source === 'builtin'
                ? 'bg-zhihu-blue-light text-zhihu-blue'
                : 'bg-emerald-50 text-emerald-600'
            ].join(' ')}
          >
            {t(sourceBadgeKey)}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zhihu-gray-2">{tool.description}</p>
        <p className="mt-1 font-mono text-[10px] text-zhihu-gray">{tool.name}</p>
      </section>

      {renderBody()}
    </div>
  )
}

// 搜索引擎链：启用 + 排序 + custom URL 模板
function ToolDetailOpenWebSearch(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings, onChange } = props
  const t = useT()
  const cfg = settings.tools?.openWebSearch ?? defaultOpenWebSearch()

  function commit(next: SearchEngineConfig[]): void {
    onChange({
      ...settings,
      tools: {
        ...settings.tools,
        openWebSearch: { engines: next }
      }
    })
  }

  function toggleEnabled(idx: number): void {
    const next = cfg.engines.map((e, i) => (i === idx ? { ...e, enabled: !e.enabled } : e))
    commit(next)
  }

  function move(idx: number, dir: -1 | 1): void {
    const target = idx + dir
    if (target < 0 || target >= cfg.engines.length) return
    const next = cfg.engines.slice()
    ;[next[idx], next[target]] = [next[target], next[idx]]
    commit(next)
  }

  function setCustomUrl(idx: number, url: string): void {
    const next = cfg.engines.map((e, i) => (i === idx ? { ...e, customUrl: url } : e))
    commit(next)
  }

  const labelMap: Record<SearchEngineId, { label: string; hint: string }> = {
    bing: { label: t('mcpTool.engineBing'), hint: t('mcpTool.engineBingHint') },
    baidu: { label: t('mcpTool.engineBaidu'), hint: t('mcpTool.engineBaiduHint') },
    so360: { label: t('mcpTool.engineSo360'), hint: t('mcpTool.engineSo360Hint') },
    google: { label: t('mcpTool.engineGoogle'), hint: t('mcpTool.engineGoogleHint') },
    custom: { label: t('mcpTool.engineCustom'), hint: t('mcpTool.engineCustomHint') }
  }

  return (
    <section className="rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 p-5 shadow-zhihu-card backdrop-blur-sm">
      <h3 className="text-sm font-semibold text-zhihu-ink">{t('mcpTool.openWebSearchTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-zhihu-gray-2">
        {t('mcpTool.openWebSearchSubtitle')}
      </p>

      <ul className="mt-4 space-y-2">
        {cfg.engines.map((engine, idx) => {
          const meta = labelMap[engine.id]
          const isFirst = idx === 0
          const isLast = idx === cfg.engines.length - 1
          return (
            <li
              key={engine.id}
              className="flex flex-col gap-2 rounded-xl border border-zhihu-border-light bg-zhihu-bg-soft/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="flex w-5 select-none items-center justify-center text-[11px] font-medium tabular-nums text-zhihu-gray-3">
                  {idx + 1}
                </span>
                <label className="flex flex-1 cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={engine.enabled}
                    onChange={() => toggleEnabled(idx)}
                    className="h-3.5 w-3.5 rounded border-zhihu-border accent-zhihu-blue"
                    aria-label={t('mcpTool.engineEnabled')}
                  />
                  <span className="flex flex-col">
                    <span className="text-xs font-medium text-zhihu-ink">{meta.label}</span>
                    <span className="text-[11px] leading-tight text-zhihu-gray-3">{meta.hint}</span>
                  </span>
                </label>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={isFirst}
                    title={t('mcpTool.engineMoveUp')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zhihu-gray-2 transition-colors hover:bg-zhihu-card hover:text-zhihu-ink disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <i className="fa-solid fa-chevron-up text-[10px]" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={isLast}
                    title={t('mcpTool.engineMoveDown')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zhihu-gray-2 transition-colors hover:bg-zhihu-card hover:text-zhihu-ink disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <i className="fa-solid fa-chevron-down text-[10px]" />
                  </button>
                </div>
              </div>

              {engine.id === 'custom' && (
                <input
                  type="text"
                  value={engine.customUrl ?? ''}
                  onChange={(e) => setCustomUrl(idx, e.target.value)}
                  placeholder={t('mcpTool.engineCustomPlaceholder')}
                  className="ml-8 rounded-md border border-zhihu-border bg-zhihu-card px-2.5 py-1.5 text-[11px] text-zhihu-ink placeholder:text-zhihu-gray-3 focus:border-zhihu-blue focus:outline-none"
                  spellCheck={false}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ToolDetailFetchUrl(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
}): JSX.Element {
  const { settings } = props
  const t = useT()
  const cfg = settings.tools?.fetchUrl ?? defaultFetchUrl()
  void cfg

  return (
    <section className="rounded-2xl border border-zhihu-border-light bg-zhihu-card/80 p-5 shadow-zhihu-card backdrop-blur-sm">
      <h3 className="text-sm font-semibold text-zhihu-ink">{t('mcpTool.fetchUrlTitle')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-zhihu-gray-2">
        {t('mcpTool.fetchUrlSubtitle')}
      </p>
      <p className="mt-4 text-[11px] text-zhihu-gray-3">{t('placeholder.wip')}</p>
    </section>
  )
}

interface Author {
  name: string
  avatar: string
  email?: string
}

const AUTHORS: Author[] = [
  { name: 'Shiqi', avatar: shiqiAvatar, email: '3056256780@qq.com' },
  { name: '山原枫月', avatar: crysmapleAvatar }
]

interface OssDep {
  name: string
  note: string
  url: string
  planned?: boolean
}

const OSS_DEPS: OssDep[] = [
  { name: 'Electron', note: '跨平台桌面框架', url: 'https://www.electronjs.org' },
  { name: 'React', note: 'UI 框架', url: 'https://react.dev' },
  { name: 'TypeScript', note: '类型系统', url: 'https://www.typescriptlang.org' },
  { name: 'Vite', note: '构建工具', url: 'https://vitejs.dev' },
  { name: 'Tailwind CSS', note: '样式系统', url: 'https://tailwindcss.com' },
  { name: 'Font Awesome', note: '图标字体', url: 'https://fontawesome.com' },
  { name: 'Rough.js', note: '手绘风格图形库', url: 'https://roughjs.com' },
  { name: 'CC Switch', note: '请求协议翻译参考实现', url: 'https://github.com/farion1231/cc-switch' }
]

const EGG_SEQUENCE = [0, 1, 0, 0, 1] // Shiqi, crysmaple, Shiqi, Shiqi, crysmaple

function AboutSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onNavigate: (s: Section) => void
  onToast: (message: string) => void
}): JSX.Element {
  const t = useT()
  const [eggProgress, setEggProgress] = useState(0)
  const [updateChecking, setUpdateChecking] = useState(false)

  function handleCheckUpdate(): void {
    if (updateChecking) return
    setUpdateChecking(true)
    setTimeout(() => {
      setUpdateChecking(false)
      props.onToast(t('about.upToDate'))
    }, 1500)
  }

  function open(url: string) {
    return (e: React.MouseEvent): void => {
      e.preventDefault()
      window.xiaoliu.window.openExternal(url)
    }
  }

  function handleAvatarClick(authorIndex: number): void {
    if (EGG_SEQUENCE[eggProgress] === authorIndex) {
      const next = eggProgress + 1
      if (next === EGG_SEQUENCE.length) {
        props.onChange({ ...props.settings, devMode: true })
        props.onNavigate('developer')
        setEggProgress(0)
      } else {
        setEggProgress(next)
      }
    } else {
      setEggProgress(authorIndex === EGG_SEQUENCE[0] ? 1 : 0)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col">
      <div className="flex-1 space-y-6 pb-10">
        <section className="rounded-2xl border border-zhihu-border-light bg-gradient-to-br from-zhihu-blue-light to-zhihu-card p-8 shadow-zhihu-card">
          <div className="flex items-center gap-5">
            <img
              src={iconUrl}
              alt="小刘"
              className="h-20 w-20 shrink-0 rounded-2xl object-contain"
              draggable={false}
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold text-zhihu-ink">{t('app.name')}</h2>
              <div className="mt-1.5 flex items-center gap-3 text-sm text-zhihu-gray-2">
                <span className="font-mono">v0.1.25.c</span>
                <span className="text-zhihu-gray/60">·</span>
                <span>{t('about.tagline')}</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <button
                onClick={handleCheckUpdate}
                disabled={updateChecking}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors ${
                  updateChecking
                    ? 'cursor-wait border-zhihu-border bg-zhihu-card text-zhihu-gray-2'
                    : 'border-zhihu-border bg-zhihu-card text-zhihu-ink hover:border-zhihu-blue hover:text-zhihu-blue'
                }`}
              >
                {updateChecking && (
                  <i className="fa-solid fa-spinner fa-spin text-[12px]" aria-hidden />
                )}
                {updateChecking ? t('about.checking') : t('about.checkUpdate')}
              </button>
              <label className="group relative flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-1.5 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue">
                <div className="relative flex items-center justify-center">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="peer h-4 w-4 cursor-pointer appearance-none rounded border-2 border-zhihu-border bg-zhihu-card transition-all checked:border-zhihu-blue checked:bg-zhihu-blue focus:ring-2 focus:ring-zhihu-blue focus:ring-offset-0"
                  />
                  <svg
                    className="pointer-events-none absolute h-4 w-4 text-white opacity-0 transition-opacity peer-checked:opacity-100"
                    viewBox="0 0 16 16"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
                {t('about.autoUpdate')}
              </label>
            </div>
          </div>
        </section>

        <Card title={t('about.authors')}>
          <div className="grid grid-cols-2 gap-3">
            {AUTHORS.map((a, idx) => (
              <div
                key={a.name}
                onClick={() => handleAvatarClick(idx)}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-zhihu-border-light bg-zhihu-card px-4 py-3 transition-colors hover:border-zhihu-blue/40"
              >
                <img
                  src={a.avatar}
                  alt={a.name}
                  className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-zhihu-border-light"
                  draggable={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zhihu-ink">{a.name}</div>
                  {a.email && (
                    <div className="truncate text-[11px] text-zhihu-gray" title={a.email}>
                      {a.email}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title={t('about.project')}>
          <ul className="-my-1 divide-y divide-zhihu-border-light">
            <LinkRow
              icon="fa-solid fa-globe"
              label={t('about.website')}
              display="hiliu.chat"
              url="https://hiliu.chat"
              onOpen={open}
            />
            <LinkRow
              icon="fa-brands fa-github"
              label={t('about.sourceCode')}
              display="github.com/Shiqi-SQ/Hiliu-Community"
              url="https://github.com/Shiqi-SQ/Hiliu-Community"
              onOpen={open}
            />
            <LinkRow
              icon="fa-solid fa-scale-balanced"
              label={t('about.license')}
              display="MIT License"
              url="https://github.com/Shiqi-SQ/Hiliu-Community/blob/main/LICENSE"
              onOpen={open}
            />
          </ul>
        </Card>

        <Card title={t('about.ossCredits')}>
          <div className="flex flex-wrap gap-2">
            {OSS_DEPS.map((d) => (
              <a
                key={d.name}
                href={d.url}
                onClick={open(d.url)}
                title={d.planned ? `${d.note} · ${t('common.planned')}` : d.note}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                  d.planned
                    ? 'border-dashed border-zhihu-border bg-zhihu-card/40 text-zhihu-gray-2 hover:border-zhihu-blue hover:text-zhihu-blue'
                    : 'border-zhihu-border-light bg-zhihu-card text-zhihu-ink hover:border-zhihu-blue hover:text-zhihu-blue'
                ].join(' ')}
              >
                <span className="font-medium">{d.name}</span>
                {d.planned && (
                  <span className="text-[10px] text-zhihu-gray">{t('common.planned')}</span>
                )}
              </a>
            ))}
          </div>
        </Card>

        <Card title={t('about.acknowledgements')}>
          <ul className="space-y-2.5">
            <ThanksItem
              icon="fa-brands fa-zhihu"
              accent="#1772F6"
              name="知乎"
              note="提供刘看山 IP 授权、知乎 API 支持，以及本次 Hackathon 舞台"
            />
            <ThanksItem
              icon="fa-solid fa-heart"
              accent="#EC4899"
              name="正在使用小刘的你"
              note="谢谢你愿意把它留在桌面"
            />
          </ul>
        </Card>
      </div>

      <footer className="pt-4 pb-2 text-center">
        <span className="text-[11px] text-zhihu-gray">
          知乎 AI Hackathon 2026 参赛作品
        </span>
      </footer>
    </div>
  )
}

function LinkRow(props: {
  icon: string
  label: string
  display: string
  url: string
  onOpen: (url: string) => (e: React.MouseEvent) => void
}): JSX.Element {
  return (
    <li>
      <a
        href={props.url}
        onClick={props.onOpen(props.url)}
        className="group flex items-center gap-3 py-2.5"
      >
        <i
          className={`${props.icon} w-5 text-center text-base text-zhihu-gray-2 group-hover:text-zhihu-blue`}
        />
        <span className="text-sm text-zhihu-ink">{props.label}</span>
        <span className="flex-1" />
        <span className="text-xs text-zhihu-gray-2 group-hover:text-zhihu-blue">
          {props.display}
        </span>
        <i className="fa-solid fa-arrow-up-right-from-square text-[10px] text-zhihu-gray group-hover:text-zhihu-blue" />
      </a>
    </li>
  )
}

function ThanksItem(props: {
  icon: string
  accent: string
  name: string
  note: string
  muted?: boolean
}): JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: props.muted ? '#E5E7EB' : props.accent }}
      >
        <i className={`${props.icon} text-xs`} />
      </div>
      <div className="flex-1">
        <div
          className={[
            'text-sm font-medium',
            props.muted ? 'italic text-zhihu-gray-2' : 'text-zhihu-ink'
          ].join(' ')}
        >
          {props.name}
        </div>
        <div className="mt-0.5 text-[11px] text-zhihu-gray-2">{props.note}</div>
      </div>
    </li>
  )
}

function DevSection(props: {
  settings: AppSettings
  onChange: (s: AppSettings) => void
  onNavigate: (s: Section) => void
}): JSX.Element {
  const t = useT()
  // 当前选中预览的 clip + 是否循环——纯 UI 状态，不持久化
  const [previewClip, setPreviewClip] = useState<ClipName>('start')
  const [loopOverride, setLoopOverride] = useState(false)
  // 调试用，不进 settings；90 px/s 与 walk-loop 步幅匹配
  const [walkSpeed, setWalkSpeed] = useState('90')
  // 桌宠端是否正在播——按钮显「播放/停止」
  const [playing, setPlaying] = useState(false)
  // 内容容器气泡预览——开发者用来调几何/抖度参数。逻辑像素，不持久化。
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [bubbleW, setBubbleW] = useState(220)
  const [bubbleH, setBubbleH] = useState(80)

  // 订阅桌宠回执，把按钮从「停止」翻回「播放」
  useEffect(() => {
    const off = window.xiaoliu.pet.onClipDone(() => {
      setPlaying(false)
    })
    return off
  }, [])

  // 启动时拉一次气泡当前状态——避免离开/回来时本地 UI 与 main 端不同步
  useEffect(() => {
    void window.xiaoliu.bubble.getState().then((s) => {
      setBubbleVisible(s.visible)
      if (s.width > 0) setBubbleW(s.width)
      if (s.height > 0) setBubbleH(s.height)
    })
  }, [])

  function pushBubble(visible: boolean, w: number, h: number): void {
    // 开发者面板预览，无真实 chat，chatOpen=false
    window.xiaoliu.bubble.setState({ visible, width: w, height: h, chatOpen: false })
  }

  // 退出开发者模式：闸门标志关掉，并把 dev 子对象重置为默认，
  // 避免开发者偏好（如 F12 调试）残留到普通用户
  function handleExit(): void {
    props.onChange({ ...props.settings, devMode: false, dev: defaultDevSettings() })
    props.onNavigate('about')
  }

  // 「<入场>（start, oneshot）」这种 label 直接拼，不绕 i18n key
  function clipLabel(name: ClipName): string {
    const kindHint = CLIP_REGISTRY[name].kind
    switch (name) {
      case 'start':
        return t('developer.clipStart')
      case 'exit':
        return t('developer.clipExit')
      case 'idle-tire':
        return t('developer.clipIdleTire')
      case 'idle-playball':
        return t('developer.clipIdlePlayball')
      case 'idle-tire2-start':
        return t('developer.clipIdleTire2Start')
      case 'idle-tire2-loop':
        return t('developer.clipIdleTire2Loop')
      case 'idle-tire2-end':
        return t('developer.clipIdleTire2End')
      default:
        return `${name} (${kindHint})`
    }
  }

  function handleTogglePlay(): void {
    if (playing) {
      // 用户主动停：force=true 立即停回 idle
      window.xiaoliu.pet.stopClip({ force: true })
      setPlaying(false)
      return
    }
    // 调试用绝对开关，loop 必须传 boolean
    window.xiaoliu.pet.playClip(previewClip, {
      force: true,
      loop: loopOverride
    })
    setPlaying(true)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('developer.title')} />

      <Card title={t('developer.title')}>
        <ToggleRow
          label={t('developer.devTools')}
          tip={t('developer.devToolsTip')}
          value={props.settings.dev.devToolsEnabled}
          onChange={(v) =>
            props.onChange({
              ...props.settings,
              dev: { ...props.settings.dev, devToolsEnabled: v }
            })
          }
        />
      </Card>

      <Card title={t('developer.playAnim')} subtitle={t('developer.playAnimDesc')}>
        <div className="flex items-center gap-3">
          <select
            aria-label={t('developer.playAnimSelectAria')}
            value={previewClip}
            onChange={(e) => setPreviewClip(e.target.value as ClipName)}
            className="flex-1 rounded-lg border border-zhihu-border bg-zhihu-card px-3 py-2 text-sm text-zhihu-ink outline-none transition-colors hover:border-zhihu-blue/40 focus:border-zhihu-blue"
          >
            {CLIP_NAMES.map((name) => (
              <option key={name} value={name}>
                {clipLabel(name)}
              </option>
            ))}
          </select>
          <label
            className="inline-flex cursor-pointer select-none items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-3 py-2 text-sm text-zhihu-ink transition-colors hover:border-zhihu-blue/40"
            title={t('developer.loopAnimTip')}
          >
            <input
              type="checkbox"
              checked={loopOverride}
              onChange={(e) => setLoopOverride(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-zhihu-blue"
            />
            {t('developer.loopAnim')}
          </label>
          <button
            onClick={handleTogglePlay}
            className={[
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
              playing
                ? 'bg-rose-500 hover:bg-rose-600'
                : 'bg-zhihu-blue hover:bg-zhihu-blue-hover'
            ].join(' ')}
          >
            <i className={`fa-solid ${playing ? 'fa-stop' : 'fa-play'} text-xs`} />
            {playing ? t('developer.stopAnimButton') : t('developer.playAnimButton')}
          </button>
          {/* 朝向是渲染层会话级状态，按一下翻转——turn 调试不携带切换（与 exit 调试不退出同理），
              生产路径在撞墙 / 自由游荡时显式调 toggleFacing 与 turn 配对。 */}
          <button
            onClick={() => window.xiaoliu.pet.toggleFacing()}
            className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-3 py-2 text-sm text-zhihu-ink transition-colors hover:border-zhihu-blue/40"
          >
            <i className="fa-solid fa-arrows-left-right text-xs" />
            {t('developer.toggleFacing')}
          </button>
        </div>
      </Card>

      <Card title={t('developer.walkControl')} subtitle={t('developer.walkControlDesc')}>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zhihu-ink">
            <span>{t('developer.walkSpeed')}</span>
            <input
              type="number"
              min={10}
              max={500}
              value={walkSpeed}
              onChange={(e) => setWalkSpeed(e.target.value)}
              className="w-24 rounded-lg border border-zhihu-border bg-zhihu-card px-3 py-2 text-sm text-zhihu-ink outline-none transition-colors hover:border-zhihu-blue/40 focus:border-zhihu-blue"
            />
            <span className="text-xs text-zhihu-ink-light">px/s</span>
          </label>
          <button
            onClick={() => {
              const parsed = parseFloat(walkSpeed)
              const valid = Number.isFinite(parsed) ? parsed : 90
              window.xiaoliu.pet.startWalk(valid)
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-zhihu-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zhihu-blue-hover"
          >
            <i className="fa-solid fa-play text-xs" />
            {t('developer.walkStart')}
          </button>
          <button
            onClick={() => window.xiaoliu.pet.stopWalk()}
            className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-2 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue/40"
          >
            <i className="fa-solid fa-stop text-xs" />
            {t('developer.walkStop')}
          </button>
        </div>
      </Card>

      {/* 内容容器气泡预览——MVP α 阶段：先验证窗口能正确从右下扩展并保留 sprite 锚点。 */}
      {/* 后续真实场景（小刘说话/推送/对话）会按内容自动测量尺寸再 setState；这里手动调是 dev 调试用。 */}
      <Card title="内容气泡预览（开发者）" subtitle="测试动态尺寸与窗口扩展（逻辑像素，会按 size 档位放大）">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-zhihu-ink-light">
              <span className="w-10">宽度</span>
              <input
                type="number"
                min={60}
                max={600}
                step={10}
                value={bubbleW}
                onChange={(e) => setBubbleW(Math.max(0, Number(e.target.value) || 0))}
                className="w-20 rounded-lg border border-zhihu-border bg-zhihu-card px-2 py-1 text-sm text-zhihu-ink outline-none focus:border-zhihu-blue"
              />
              <span>px</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-zhihu-ink-light">
              <span className="w-10">高度</span>
              <input
                type="number"
                min={40}
                max={400}
                step={10}
                value={bubbleH}
                onChange={(e) => setBubbleH(Math.max(0, Number(e.target.value) || 0))}
                className="w-20 rounded-lg border border-zhihu-border bg-zhihu-card px-2 py-1 text-sm text-zhihu-ink outline-none focus:border-zhihu-blue"
              />
              <span>px</span>
            </label>
            <button
              onClick={() => pushBubble(true, bubbleW, bubbleH)}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-3 py-1.5 text-sm text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
              title="把当前宽高推到桌宠窗口"
            >
              <i className="fa-solid fa-arrows-left-right text-xs" />
              应用尺寸
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const next = !bubbleVisible
                setBubbleVisible(next)
                pushBubble(next, bubbleW, bubbleH)
              }}
              className={[
                'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
                bubbleVisible
                  ? 'bg-rose-500 hover:bg-rose-600'
                  : 'bg-zhihu-blue hover:bg-zhihu-blue-hover'
              ].join(' ')}
            >
              <i className={`fa-solid ${bubbleVisible ? 'fa-eye-slash' : 'fa-eye'} text-xs`} />
              {bubbleVisible ? '隐藏气泡' : '显示气泡'}
            </button>
            <span className="text-xs text-zhihu-ink-light">
              当前：{bubbleVisible ? `可见 ${bubbleW}×${bubbleH}` : '隐藏'}
            </span>
          </div>
        </div>
      </Card>

      <Card title={t('developer.exitDevMode')}>
        <button
          onClick={handleExit}
          className="inline-flex items-center gap-2 rounded-lg border border-zhihu-border bg-zhihu-card px-4 py-2 text-sm font-medium text-zhihu-ink transition-colors hover:border-zhihu-blue hover:text-zhihu-blue"
        >
          <i className="fa-solid fa-code-branch text-sm" />
          {t('developer.exitDevMode')}
        </button>
      </Card>
    </div>
  )
}

/* ========== 重启确认弹窗 ========== */

function RestartConfirmModal(props: { onClose: () => void }): JSX.Element {
  const t = useT()
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  function handleRestart(): void {
    window.xiaoliu.window.relaunch()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zhihu-ink/30 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        className="w-[420px] overflow-hidden rounded-2xl bg-zhihu-card shadow-zhihu-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zhihu-border-light px-5 py-3">
          <div className="flex items-center gap-2">
            <i className="fa-solid fa-rotate-right text-sm text-zhihu-blue" />
            <span className="text-sm font-medium text-zhihu-ink">{t('restart.title')}</span>
          </div>
          <button
            onClick={props.onClose}
            className="rounded p-1 text-zhihu-gray hover:bg-zhihu-bg-soft hover:text-zhihu-ink"
            aria-label={t('common.close')}
          >
            <i className="fa-solid fa-xmark text-base" />
          </button>
        </div>
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
              <i className="fa-solid fa-triangle-exclamation text-lg" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-zhihu-ink">
                {t('restart.heading')}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-zhihu-gray-2">
                {t('restart.body')}
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-zhihu-border-light bg-zhihu-bg-soft px-5 py-3">
          <button
            onClick={props.onClose}
            className="rounded-lg px-4 py-1.5 text-sm font-medium text-zhihu-gray-2 hover:text-zhihu-ink"
          >
            {t('common.restartLater')}
          </button>
          <button
            onClick={handleRestart}
            className="rounded-lg bg-zhihu-blue px-4 py-1.5 text-sm font-medium text-white hover:bg-zhihu-blue-active"
          >
            {t('common.restart')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ========== Toast 提示 ========== */

function SaveToast(props: { visible: boolean }): JSX.Element {
  const t = useT()
  return (
    <div
      className={[
        'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zhihu-ink px-4 py-2 text-sm text-zhihu-page shadow-zhihu-pop transition-all duration-200',
        props.visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-2 opacity-0'
      ].join(' ')}
    >
      <i className="fa-solid fa-circle-check text-base" />
      {t('common.savedToast')}
    </div>
  )
}

function InfoToast(props: { visible: boolean; message: string }): JSX.Element {
  return (
    <div
      className={[
        'fixed left-1/2 top-12 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zhihu-ink px-4 py-2 text-sm text-zhihu-page shadow-zhihu-pop transition-all duration-200',
        props.visible
          ? 'pointer-events-auto translate-y-0 opacity-100'
          : 'pointer-events-none -translate-y-2 opacity-0'
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      <i className="fa-solid fa-circle-check text-base text-emerald-400" />
      {props.message}
    </div>
  )
}

/* ========== 通用积木 ========== */

function PageHeader(props: { title: string; subtitle?: string }): JSX.Element {
  return (
    <header>
      <h1 className="text-2xl font-semibold text-zhihu-ink">{props.title}</h1>
      {props.subtitle && (
        <p className="mt-1 text-sm text-zhihu-gray">{props.subtitle}</p>
      )}
    </header>
  )
}

function Card(props: {
  title: string
  subtitle?: string
  tone?: 'normal' | 'danger'
  children: React.ReactNode
}): JSX.Element {
  const tone = props.tone ?? 'normal'
  return (
    <section
      className={[
        'rounded-2xl border bg-zhihu-card/80 p-6 shadow-zhihu-card backdrop-blur-sm',
        tone === 'danger' ? 'border-rose-200/60' : 'border-zhihu-border-light'
      ].join(' ')}
    >
      <h2
        className={[
          'text-base font-semibold',
          tone === 'danger' ? 'text-rose-700' : 'text-zhihu-ink'
        ].join(' ')}
      >
        {props.title}
      </h2>
      {props.subtitle && (
        <p className="mt-0.5 text-xs text-zhihu-gray">{props.subtitle}</p>
      )}
      <div className="mt-5">{props.children}</div>
    </section>
  )
}

function ToggleRow(props: {
  label: string
  desc?: string
  tip?: string
  tipVariant?: 'info' | 'warn'
  value: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-zhihu-ink">{props.label}</span>
          {props.tip && <InfoTip text={props.tip} variant={props.tipVariant} />}
        </div>
        {props.desc && (
          <p className="mt-0.5 text-xs text-zhihu-gray">{props.desc}</p>
        )}
      </div>
      <Switch value={props.value} onChange={props.onChange} />
    </div>
  )
}

function InfoTip(props: { text: string; variant?: 'info' | 'warn' }): JSX.Element {
  const isWarn = props.variant === 'warn'
  const iconClass = isWarn ? 'fa-triangle-exclamation' : 'fa-circle-exclamation'
  const colorClass = isWarn
    ? 'text-amber-500 hover:text-amber-600'
    : 'text-zhihu-gray-2 hover:text-zhihu-blue'
  return (
    <span className="group relative inline-flex items-center">
      <i className={`fa-solid ${iconClass} cursor-help text-xs ${colorClass}`} />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 w-max max-w-xs -translate-x-1/2 rounded-md bg-zhihu-ink px-2 py-1 text-[11px] leading-snug text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100"
      >
        {props.text}
      </span>
    </span>
  )
}

function Switch(props: { value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.value}
      onClick={() => props.onChange(!props.value)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        props.value ? 'bg-zhihu-blue' : 'bg-zhihu-gray/30'
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
          props.value ? 'translate-x-5' : 'translate-x-0.5'
        ].join(' ')}
      />
    </button>
  )
}

interface DropdownOption {
  value: string
  label: string
  icon?: string
}

function ProtocolModeRadio(props: {
  value: ProtocolMode
  onChange: (v: ProtocolMode) => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="grid grid-cols-2 gap-2">
      {PROTOCOL_MODE_LIST.map((mode) => {
        const active = props.value === mode
        const key = protocolModeKey(mode)
        return (
          <button
            key={mode}
            type="button"
            onClick={() => props.onChange(mode)}
            className={[
              'flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors',
              active
                ? 'border-zhihu-blue bg-zhihu-blue-light/40 text-zhihu-blue'
                : 'border-zhihu-border-light bg-zhihu-card text-zhihu-ink hover:border-zhihu-blue/60'
            ].join(' ')}
            title={t(`protocolMode.${key}Desc`)}
          >
            <span className="text-sm font-medium">{t(`protocolMode.${key}`)}</span>
            <span className="mt-0.5 text-[11px] leading-snug text-zhihu-gray-2">
              {mode === 'cc-native' ? 'Anthropic Messages' : 'OpenAI Responses'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Dropdown(props: {
  value: string
  options: DropdownOption[]
  onChange: (v: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const current = props.options.find((o) => o.value === props.value)

  function toggle(): void {
    if (!open && triggerRef.current) {
      setRect(triggerRef.current.getBoundingClientRect())
    }
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      const t = e.target as Node
      if (
        triggerRef.current &&
        !triggerRef.current.contains(t) &&
        panelRef.current &&
        !panelRef.current.contains(t)
      ) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    function reposition(): void {
      if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect())
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={[
          'flex w-full items-center justify-between rounded-lg border bg-zhihu-card px-4 py-2.5 text-sm text-zhihu-ink transition-colors',
          open
            ? 'border-zhihu-blue ring-2 ring-zhihu-blue/20'
            : 'border-zhihu-border hover:border-zhihu-blue/50'
        ].join(' ')}
      >
        <span className="flex items-center gap-2">
          {current?.icon && (
            <i className={`fa-solid ${current.icon} w-4 text-center text-zhihu-gray-2`} />
          )}
          <span className="font-medium">{current?.label ?? '请选择'}</span>
        </span>
        <i
          className={[
            'fa-solid fa-chevron-down text-xs text-zhihu-gray-2 transition-transform',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>
      {open && rect &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: rect.bottom + 6,
              left: rect.left,
              width: rect.width,
              zIndex: 1000
            }}
            className="overflow-hidden rounded-lg border border-zhihu-border-light bg-zhihu-card py-1 shadow-zhihu-pop"
          >
            {props.options.map((opt) => {
              const active = opt.value === props.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    props.onChange(opt.value)
                    setOpen(false)
                  }}
                  className={[
                    'flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors',
                    active
                      ? 'bg-zhihu-blue-light text-zhihu-blue'
                      : 'text-zhihu-ink hover:bg-zhihu-bg-soft'
                  ].join(' ')}
                >
                  {opt.icon && (
                    <i
                      className={[
                        'fa-solid w-4 text-center',
                        opt.icon,
                        active ? 'text-zhihu-blue' : 'text-zhihu-gray-2'
                      ].join(' ')}
                    />
                  )}
                  <span className="flex-1 font-medium">{opt.label}</span>
                  {active && <i className="fa-solid fa-check text-xs text-zhihu-blue" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
