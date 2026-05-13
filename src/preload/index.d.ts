import type { XiaoliuAPI } from './index'

declare global {
  interface Window {
    xiaoliu: XiaoliuAPI
  }
}

export {}
