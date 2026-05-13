// 桌宠右键菜单页面——加载在独立 frameless BrowserWindow 里（main/index.ts createPetMenuWindow）。
//
// 为什么独立成窗口：桌宠窗口仅 240×280，菜单内嵌会被边缘裁剪——尤其是右下角触发时整个菜单都看不到。
// 独立窗口摆脱主窗 bounds 限制，main 负责把它定位到鼠标 screen 坐标。
//
// 菜单本身无状态（仅「打开设置 / 退出小刘」），所以不需要 getState 接口。
// 关闭策略与 TrayMenu 完全一致：点项 / 失焦 / Esc。
import { useEffect } from 'react'
import { MenuItem, MenuSeparator } from '../components/MenuItem'
import { useT } from '../i18n'

export default function PetMenu(): JSX.Element {
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.xiaoliu.petMenu.action('close')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen w-screen items-start justify-start bg-transparent p-1">
      <div className="w-full overflow-hidden rounded-xl border border-zhihu-border bg-zhihu-card/95 py-1 shadow-zhihu-pop backdrop-blur-md">
        <MenuItem
          icon={<i className="fa-solid fa-gear text-[13px]" />}
          onClick={() => window.xiaoliu.petMenu.action('open-settings')}
        >
          {t('petMenu.settings')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<i className="fa-solid fa-xmark text-[13px]" />}
          tone="danger"
          onClick={() => window.xiaoliu.petMenu.action('quit')}
        >
          {t('petMenu.quit')}
        </MenuItem>
      </div>
    </div>
  )
}
