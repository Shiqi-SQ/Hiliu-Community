// 主进程极简字典——只给 tray tooltip 用
import { Language } from './types'

interface TrayDict {
  appName: string
}

const TRAY_DICTS: Record<Exclude<Language, 'system'>, TrayDict> = {
  'zh-CN': { appName: '你好，小刘（社区版）' },
  'zh-TW': { appName: '你好，小劉（社區版）' },
  en: { appName: 'Hiliu Community' }
}

export function resolveLocaleFromSystem(systemLocale: string): Exclude<Language, 'system'> {
  const lang = (systemLocale || 'zh-CN').toLowerCase()
  if (lang.startsWith('zh')) {
    if (lang.includes('tw') || lang.includes('hk') || lang.includes('hant')) return 'zh-TW'
    return 'zh-CN'
  }
  return 'en'
}

export function getTrayDict(setting: Language, systemLocale: string): TrayDict {
  const locale = setting === 'system' ? resolveLocaleFromSystem(systemLocale) : setting
  return TRAY_DICTS[locale]
}
