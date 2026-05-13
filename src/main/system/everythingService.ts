// es.exe 是 Everything 轻量客户端，需要一个 GUI 进程（everything.exe）保持 NTFS USN 索引运行。
// hiliu 启动时 spawn 自己的 everything.exe 实例，退出时 kill，不污染用户机器。
//
// 关键 flag：
//   -startup       后台启动、隐藏托盘图标
//   -instance hiliu 独立实例名，与用户已装的 Everything 完全隔离（支持多实例）

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { resolveBinPath, binExists } from './binPath'

const INSTANCE_NAME = 'hiliu'

let everythingProc: ChildProcess | null = null

// Everything 启动时会做自更新检查，把当前 exe 复制成 everything.exe_<hex>.bak。
// 自带固定版本不需要自更新，这些 bak 是纯垃圾——start 前 + stop 后各清一次。
function cleanupBakFiles(): void {
  try {
    const dir = path.dirname(resolveBinPath('everything.exe'))
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.bak')) {
        try {
          fs.unlinkSync(path.join(dir, name))
          console.log(`[everythingService] 清理 bak：${name}`)
        } catch (e) {
          console.warn(`[everythingService] 清理 bak 失败 ${name}：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  } catch {
    // 清理失败不影响主进程
  }
}

export function startEverythingService(): void {
  if (!binExists('everything.exe')) {
    console.warn('[everythingService] everything.exe 不存在 → 跳过启动（search_file 仍会因 es.exe 也缺而未注册）')
    return
  }
  if (everythingProc && !everythingProc.killed) {
    console.log('[everythingService] 已有进程，跳过')
    return
  }
  cleanupBakFiles()
  const exePath = resolveBinPath('everything.exe')
  try {
    // detached:false——子进程跟父进程绑定，父挂了 Windows 自动收回 process group
    // windowsHide:true——不弹 console 窗口
    everythingProc = spawn(exePath, ['-startup', '-instance', INSTANCE_NAME], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })
    everythingProc.on('error', (e) => {
      console.warn(`[everythingService] 进程出错：${e.message}`)
    })
    everythingProc.on('exit', (code) => {
      console.log(`[everythingService] 进程退出，code=${code}`)
      everythingProc = null
    })
    console.log(`[everythingService] 已启动，instance=${INSTANCE_NAME}, pid=${everythingProc.pid}`)
  } catch (e) {
    console.warn(`[everythingService] 启动失败：${e instanceof Error ? e.message : String(e)}`)
    everythingProc = null
  }
}

// 用 -exit 让 Everything 优雅退出（保存索引），失败兜底 SIGTERM。
export function stopEverythingService(): void {
  if (!everythingProc) return
  try {
    if (binExists('everything.exe')) {
      // 同 instance 名给同一实例发 -exit
      const exePath = resolveBinPath('everything.exe')
      const stopper = spawn(exePath, ['-instance', INSTANCE_NAME, '-exit'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true
      })
      stopper.on('error', () => {
        everythingProc?.kill()
      })
    } else {
      everythingProc.kill()
    }
  } catch {
    try { everythingProc.kill() } catch { /* noop */ }
  }
  everythingProc = null
  // -exit 流程里可能又写 bak，延后 500ms 再扫
  setTimeout(cleanupBakFiles, 500)
}
