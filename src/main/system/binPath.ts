// electron-builder 把 resources/bin/** 打进 asar，但 asar 内文件不是真实文件，
// child_process.spawn 启不起来。asarUnpack 把 bin 释放到 app.asar.unpacked/resources/bin/。
// 缺二进制时 binExists 返回 false，调用方跳过注册——模型 prompt 里看不到该工具。

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

const isDev = !app.isPackaged

export function resolveBinPath(name: string): string {
  if (isDev) {
    return path.join(app.getAppPath(), 'resources', 'bin', name)
  }
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'bin', name)
}

export function binExists(name: string): boolean {
  try {
    return fs.existsSync(resolveBinPath(name))
  } catch {
    return false
  }
}
