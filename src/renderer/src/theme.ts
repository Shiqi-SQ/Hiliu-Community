import { useEffect } from 'react'
import { Theme } from '@shared/types'

// 把主题档位翻译成 <html> 元素是否带 .dark class
// system → 跟随 prefers-color-scheme，并订阅它的变化
export function useApplyTheme(theme: Theme): void {
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')

    const compute = (): boolean => {
      if (theme === 'dark') return true
      if (theme === 'light') return false
      return mql.matches
    }

    const apply = (): void => {
      const isDark = compute()
      document.documentElement.classList.toggle('dark', isDark)
      window.xiaoliu.window.setTitlebarTheme(isDark)
    }

    apply()
    if (theme === 'system') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])
}
