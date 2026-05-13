import { useEffect, useState } from 'react'
import { AppSettings, defaultSettings } from '@shared/types'
import Pet from './pages/Pet'
import PetMenu from './pages/PetMenu'
import Settings from './pages/Settings'
import TrayMenu from './pages/TrayMenu'
import { LocaleProvider } from './i18n'
import { useApplyTheme } from './theme'

type Route = 'pet' | 'settings' | 'tray-menu' | 'pet-menu'

function getRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash.startsWith('settings')) return 'settings'
  if (hash.startsWith('tray-menu')) return 'tray-menu'
  if (hash.startsWith('pet-menu')) return 'pet-menu'
  return 'pet'
}

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(getRoute)
  // 顶层只关心两个偏好：theme 用来切 .dark class，language 用来切 i18n locale
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)

  useEffect(() => {
    const onHashChange = (): void => setRoute(getRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // 启动 + 设置变更时拉一遍偏好。此处只读不写，避免和 Settings 页内的 setAndSave 形成回环
  useEffect(() => {
    let alive = true
    const sync = (): void => {
      void window.xiaoliu.settings.load().then((s) => {
        if (alive) setSettings(s)
      })
    }
    sync()
    const off = window.xiaoliu.settings.onChanged(sync)
    return () => {
      alive = false
      off()
    }
  }, [])

  useApplyTheme(settings.appearance.theme)

  return (
    <LocaleProvider setting={settings.general.language}>
      {route === 'settings' ? (
        <Settings />
      ) : route === 'tray-menu' ? (
        <TrayMenu />
      ) : route === 'pet-menu' ? (
        <PetMenu />
      ) : (
        <Pet />
      )}
    </LocaleProvider>
  )
}
