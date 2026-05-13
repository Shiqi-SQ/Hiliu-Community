// 自定义 tray 菜单页面——加载在独立 frameless BrowserWindow 里（main/index.ts createTrayMenuWindow）。
//
// 为什么要自己做：Windows 原生菜单的 checkbox 列宽由系统主题控制，无法收窄；
// 走 React 渲染我们就能：完全控制宽度、把 ✓ 放右边、和 Pet 菜单视觉一致。
//
// 关闭策略（main 端 + renderer 端协同）：
// - 点任意菜单项：renderer 调 action(name)，main 执行后 hide()
// - 点窗口外（失焦）：main 监听 BrowserWindow 'blur' 自动 hide
// - 按 Esc：renderer 这里捕获后调 action('close')，main 端 hide
import { useEffect, useState } from 'react'
import { TrayMenuState } from '@shared/types'
import { MenuItem, MenuSeparator } from '../components/MenuItem'
import { useT } from '../i18n'

export default function TrayMenu(): JSX.Element {
  const t = useT()
  const [state, setState] = useState<TrayMenuState | null>(null)

  // 拉状态 + 监听 Esc。main 每次 show() 前都重置 hash + reload，所以这个 effect 每次打开都会跑。
  useEffect(() => {
    void window.xiaoliu.trayMenu.getState().then(setState)

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.xiaoliu.trayMenu.action('close')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 状态没拿到时渲染空容器——background 仍然透明，外观上不会闪
  if (!state) {
    return <div className="h-screen w-screen" />
  }

  const check = <i className="fa-solid fa-check" />

  // items-end：把菜单贴到窗口「底部」，与 main 端「窗口底边对齐光标」的定位逻辑配合，
  // 避免窗口高度大于实际内容时菜单浮在光标上方一段空白
  return (
    <div className="flex h-screen w-screen items-end justify-start bg-transparent p-1">
      <div className="w-full overflow-hidden rounded-xl border border-zhihu-border bg-zhihu-card/95 py-1 shadow-zhihu-pop backdrop-blur-md">
        <MenuItem
          icon={
            <i
              className={
                state.petVisible ? 'fa-solid fa-eye-slash text-[13px]' : 'fa-solid fa-eye text-[13px]'
              }
            />
          }
          onClick={() => window.xiaoliu.trayMenu.action('toggle-visibility')}
        >
          {state.petVisible ? t('trayMenu.hidePet') : t('trayMenu.showPet')}
        </MenuItem>
        <MenuItem
          icon={<i className="fa-solid fa-moon text-[13px]" />}
          trailing={state.dndMode ? check : null}
          onClick={() => window.xiaoliu.trayMenu.action('toggle-dnd')}
        >
          {t('trayMenu.dndMode')}
        </MenuItem>
        <MenuItem
          icon={<i className="fa-solid fa-brain text-[13px]" />}
          trailing={state.reasoningMode ? check : null}
          onClick={() => window.xiaoliu.trayMenu.action('toggle-reasoning')}
        >
          {t('trayMenu.reasoningMode')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<i className="fa-solid fa-gear text-[13px]" />}
          onClick={() => window.xiaoliu.trayMenu.action('open-settings')}
        >
          {t('trayMenu.openSettings')}
        </MenuItem>
        <MenuItem
          icon={<i className="fa-solid fa-xmark text-[13px]" />}
          tone="danger"
          onClick={() => window.xiaoliu.trayMenu.action('quit')}
        >
          {t('trayMenu.quit')}
        </MenuItem>
      </div>
    </div>
  )
}
