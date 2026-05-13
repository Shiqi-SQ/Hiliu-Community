import { createContext, ReactNode, useContext, useEffect, useMemo } from 'react'
import { Language } from '@shared/types'
import zhCN from './locales/zh-CN'
import zhTW from './locales/zh-TW'
import en from './locales/en'

type Dict = typeof zhCN

const DICTS: Record<Exclude<Language, 'system'>, Dict> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en
}

// navigator.language 形如 zh-CN / zh-TW / zh-HK / en-US
function resolveSystemLocale(): Exclude<Language, 'system'> {
  const lang = (navigator.language || 'zh-CN').toLowerCase()
  if (lang.startsWith('zh')) {
    if (lang.includes('tw') || lang.includes('hk') || lang.includes('hant')) return 'zh-TW'
    return 'zh-CN'
  }
  return 'en'
}

export function resolveLocale(setting: Language): Exclude<Language, 'system'> {
  return setting === 'system' ? resolveSystemLocale() : setting
}

// 点号路径取值，缺 key 由调用方走 fallback 字典再试一次
function pick(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return typeof cur === 'string' ? cur : undefined
}

interface I18nContextValue {
  locale: Exclude<Language, 'system'>
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  t: (key) => key
})

export function LocaleProvider(props: {
  setting: Language
  children: ReactNode
}): JSX.Element {
  const locale = resolveLocale(props.setting)

  const value = useMemo<I18nContextValue>(() => {
    const dict = DICTS[locale]
    const fallback = DICTS['zh-CN']
    return {
      locale,
      t: (key) => pick(dict, key) ?? pick(fallback, key) ?? key
    }
  }, [locale])

  // 同步 <html lang>，让原生剪贴板/拼写检查/CSS :lang() 都能识别
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useT(): (key: string) => string {
  return useContext(I18nContext).t
}

export function useLocale(): Exclude<Language, 'system'> {
  return useContext(I18nContext).locale
}
