// MCP server 单例 Map<serverId, McpClient>——任一状态变更广播 'tools:status-changed' 给所有窗口

import { BrowserWindow } from 'electron'
import { McpClient } from './client'
import type { McpServerConfig, McpRuntimeStatus } from '@shared/types'
import { loadSettings, saveSettings } from '../store'

const clients = new Map<string, McpClient>()

function spawnClient(cfg: McpServerConfig): McpClient {
  const c = new McpClient(cfg, () => broadcastStatuses())
  clients.set(cfg.id, c)
  return c
}

// 单个 server 启动失败不影响其他——client 内自捕获
export async function startAllMcpServers(): Promise<void> {
  const settings = loadSettings()
  await Promise.allSettled(
    settings.mcpServers
      .filter((s) => s.enabled)
      .map((cfg) => spawnClient(cfg).start())
  )
  broadcastStatuses()
}

// before-quit 调，等 stop 落地避免子进程残留
export async function stopAllMcpServers(): Promise<void> {
  const all = Array.from(clients.values())
  clients.clear()
  await Promise.allSettled(all.map((c) => c.stop()))
}

export async function addMcpServer(cfg: McpServerConfig): Promise<{ ok: boolean; error?: string }> {
  const settings = loadSettings()
  if (settings.mcpServers.some((s) => s.id === cfg.id)) {
    return { ok: false, error: 'serverId 已存在' }
  }
  saveSettings({ ...settings, mcpServers: [...settings.mcpServers, cfg] })
  broadcastSettingsChanged()
  if (cfg.enabled) {
    const c = spawnClient(cfg)
    await c.start()
  }
  broadcastStatuses()
  return { ok: true }
}

export async function removeMcpServer(id: string): Promise<void> {
  const c = clients.get(id)
  if (c) {
    await c.stop()
    clients.delete(id)
  }
  const settings = loadSettings()
  saveSettings({
    ...settings,
    mcpServers: settings.mcpServers.filter((s) => s.id !== id)
  })
  broadcastSettingsChanged()
  broadcastStatuses()
}

export async function toggleMcpServer(id: string, enabled: boolean): Promise<void> {
  const settings = loadSettings()
  const next = settings.mcpServers.map((s) =>
    s.id === id ? { ...s, enabled } : s
  )
  saveSettings({ ...settings, mcpServers: next })
  broadcastSettingsChanged()

  if (enabled) {
    let c = clients.get(id)
    if (!c) {
      const cfg = next.find((s) => s.id === id)
      if (cfg) c = spawnClient(cfg)
    }
    if (c) await c.start()
  } else {
    const c = clients.get(id)
    if (c) {
      await c.stop()
      clients.delete(id)
    }
  }
  broadcastStatuses()
}

export async function restartMcpServer(id: string): Promise<void> {
  const settings = loadSettings()
  const cfg = settings.mcpServers.find((s) => s.id === id)
  if (!cfg) return
  const c = clients.get(id)
  if (c) {
    await c.restart(cfg)
  } else if (cfg.enabled) {
    await spawnClient(cfg).start()
  }
  broadcastStatuses()
}

export function listMcpStatuses(): McpRuntimeStatus[] {
  const settings = loadSettings()
  return settings.mcpServers.map((cfg) => {
    const c = clients.get(cfg.id)
    return c
      ? c.status()
      : { serverId: cfg.id, state: 'stopped' as const, toolCount: 0 }
  })
}

function broadcastStatuses(): void {
  const statuses = listMcpStatuses()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send('tools:status-changed', statuses)
  }
}

function broadcastSettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send('settings:changed')
  }
}
