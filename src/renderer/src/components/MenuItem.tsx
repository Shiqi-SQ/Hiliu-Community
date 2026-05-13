// 复用菜单项组件——Pet 右键菜单和 Tray 自定义菜单都用这一份。
// trailing 槽留给 ✓（推理/免打扰勾选态）等右侧指示器；不传则保持原 Pet 菜单的紧凑外观。
import React from 'react'

export interface MenuItemProps {
  icon?: React.ReactNode
  trailing?: React.ReactNode
  children: React.ReactNode
  onClick: () => void
  tone?: 'normal' | 'danger'
}

export function MenuItem(props: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        'flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium transition-colors',
        props.tone === 'danger'
          ? 'text-rose-600 hover:bg-rose-50'
          : 'text-zhihu-ink hover:bg-zhihu-blue-light hover:text-zhihu-blue'
      ].join(' ')}
    >
      {props.icon !== undefined && <span className="flex-shrink-0">{props.icon}</span>}
      <span className="flex-1">{props.children}</span>
      {props.trailing !== undefined && (
        <span className="flex-shrink-0 text-[11px] opacity-70">{props.trailing}</span>
      )}
    </button>
  )
}

export function MenuSeparator(): JSX.Element {
  return <div className="my-1 h-px bg-zhihu-border-light" />
}
