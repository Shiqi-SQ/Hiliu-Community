import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import {
  AppSettings,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  BubbleState,
  ChatMessage,
  ClipName,
  ConversationRecord,
  McpRuntimeStatus,
  McpServerConfig,
  PermissionDecision,
  PermissionRequest,
  PetMenuAction,
  PetVitals,
  PlayClipOptions,
  ProviderInstance,
  ScreenInfo,
  StopClipOptions,
  TestProviderResult,
  ToolDescriptorView,
  TrayMenuAction,
  TrayMenuState
} from '@shared/types'

const xiaoliuAPI = {
  settings: {
    load: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
    save: (settings: AppSettings): Promise<true> =>
      ipcRenderer.invoke('settings:save', settings),
    testProvider: (provider: ProviderInstance): Promise<TestProviderResult> =>
      ipcRenderer.invoke('settings:test-provider', provider),
    clearAll: (): Promise<true> => ipcRenderer.invoke('settings:clear-all'),
    exportConfig: (): Promise<boolean> => ipcRenderer.invoke('settings:export'),
    importConfig: (): Promise<boolean> => ipcRenderer.invoke('settings:import'),
    onChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    }
  },

  llm: {
    startStream: (messages: ChatMessage[]): void => {
      ipcRenderer.send('llm:stream-start', messages)
    },
    abort: (): void => {
      ipcRenderer.send('llm:stream-abort')
    },
    onChunk: (cb: (text: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, text: string): void => cb(text)
      ipcRenderer.on('llm:chunk', handler)
      return () => ipcRenderer.removeListener('llm:chunk', handler)
    },
    onDone: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('llm:done', handler)
      return () => ipcRenderer.removeListener('llm:done', handler)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, message: string): void => cb(message)
      ipcRenderer.on('llm:error', handler)
      return () => ipcRenderer.removeListener('llm:error', handler)
    },
    onMood: (cb: (mood: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, mood: string): void => cb(mood)
      ipcRenderer.on('llm:mood', handler)
      return () => ipcRenderer.removeListener('llm:mood', handler)
    },
    onTitle: (cb: (title: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, title: string): void => cb(title)
      ipcRenderer.on('llm:title', handler)
      return () => ipcRenderer.removeListener('llm:title', handler)
    },
    onToolDescribe: (
      cb: (toolName: string, args: Record<string, unknown>, describe: string) => void
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        toolName: string,
        args: Record<string, unknown>,
        describe: string
      ): void => cb(toolName, args, describe)
      ipcRenderer.on('llm:tool-describe', handler)
      return () => ipcRenderer.removeListener('llm:tool-describe', handler)
    },
    onToolResult: (
      cb: (toolName: string, ok: boolean, content: string) => void
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        toolName: string,
        ok: boolean,
        content: string
      ): void => cb(toolName, ok, content)
      ipcRenderer.on('llm:tool-result', handler)
      return () => ipcRenderer.removeListener('llm:tool-result', handler)
    }
  },

  // main 推询问，renderer 三按钮回传；reqId 双向匹配
  permission: {
    onRequest: (cb: (req: PermissionRequest) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, req: PermissionRequest): void => cb(req)
      ipcRenderer.on('permission:request', handler)
      return () => ipcRenderer.removeListener('permission:request', handler)
    },
    resolve: (reqId: string, decision: PermissionDecision): void => {
      ipcRenderer.send('permission:resolve', reqId, decision)
    }
  },

  // 模型主动提问工具——与 permission 对称，main 推询问 renderer 渲染后回传
  askUser: {
    onRequest: (cb: (req: AskUserQuestionRequest) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, req: AskUserQuestionRequest): void => cb(req)
      ipcRenderer.on('ask-user:request', handler)
      return () => ipcRenderer.removeListener('ask-user:request', handler)
    },
    resolve: (response: AskUserQuestionResponse): void => {
      ipcRenderer.send('ask-user:resolve', response)
    }
  },

  window: {
    openSettings: (): void => ipcRenderer.send('window:open-settings'),
    closeSettings: (): void => ipcRenderer.send('window:close-settings'),
    quit: (): void => ipcRenderer.send('window:quit-app'),
    relaunch: (): void => ipcRenderer.send('window:relaunch'),
    openExternal: (url: string): void => ipcRenderer.send('window:open-external', url),
    // Pet.tsx 像素 hit-test 后调
    setIgnoreMouse: (ignore: boolean): void =>
      ipcRenderer.send('window:set-ignore-mouse', ignore),
    // 气泡开时 true 让输入框接键盘；关时 false 不抢焦点不进 alt-tab
    setFocusable: (focusable: boolean): void =>
      ipcRenderer.send('window:set-focusable', focusable),
    setTitlebarTheme: (isDark: boolean): void =>
      ipcRenderer.send('window:set-titlebar-theme', isDark)
  },

  // clip IPC——退出动画 playClip('exit',{force:true}) + onClipDone name='exit' → quit
  pet: {
    playClip: (name: ClipName, opts?: PlayClipOptions): void => {
      ipcRenderer.send('pet:play-clip', name, opts ?? {})
    },
    stopClip: (opts?: StopClipOptions): void => {
      ipcRenderer.send('pet:stop-clip', opts ?? {})
    },
    onPlayClip: (
      cb: (name: ClipName, opts: PlayClipOptions) => void
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        name: ClipName,
        opts: PlayClipOptions
      ): void => cb(name, opts)
      ipcRenderer.on('pet:play-clip', handler)
      return () => ipcRenderer.removeListener('pet:play-clip', handler)
    },
    onStopClip: (cb: (opts: StopClipOptions) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, opts: StopClipOptions): void => cb(opts)
      ipcRenderer.on('pet:stop-clip', handler)
      return () => ipcRenderer.removeListener('pet:stop-clip', handler)
    },
    notifyClipDone: (name: ClipName | null): void => {
      ipcRenderer.send('pet:clip-done', name)
    },
    onClipDone: (cb: (name: ClipName | null) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, name: ClipName | null): void => cb(name)
      ipcRenderer.on('pet:clip-done', handler)
      return () => ipcRenderer.removeListener('pet:clip-done', handler)
    },
    // 提供默认锚点 + 当前 size 下 sprite 视觉尺寸，settings:changed 后重拉
    getScreenInfo: (): Promise<ScreenInfo> =>
      ipcRenderer.invoke('pet:get-screen-info'),
    // 拖拽结束持久化；null 重置默认锚点
    savePosition: (pos: { x: number; y: number } | null): void => {
      ipcRenderer.send('pet:save-position', pos)
    },
    // 行走调试（DevPanel 用）：Settings → main → petWindow raf
    startWalk: (speed: number): void => {
      ipcRenderer.send('pet:start-walk', speed)
    },
    stopWalk: (): void => {
      ipcRenderer.send('pet:stop-walk')
    },
    notifyWalkFinished: (): void => {
      ipcRenderer.send('pet:walk-finished')
    },
    onWalkCommand: (
      cb: (cmd: { action: 'start' | 'stop'; speed?: number }) => void
    ): (() => void) => {
      const handler = (
        _e: IpcRendererEvent,
        cmd: { action: 'start' | 'stop'; speed?: number }
      ): void => cb(cmd)
      ipcRenderer.on('pet:walk-command', handler)
      return () => ipcRenderer.removeListener('pet:walk-command', handler)
    },
    // facing 是会话级渲染状态，main 仅转发不持有
    toggleFacing: (): void => {
      ipcRenderer.send('pet:toggle-facing')
    },
    onToggleFacing: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('pet:toggle-facing-cmd', handler)
      return () => ipcRenderer.removeListener('pet:toggle-facing-cmd', handler)
    }
  },

  // tray 菜单 IPC：renderer 拉 getState + 调 action
  trayMenu: {
    getState: (): Promise<TrayMenuState> => ipcRenderer.invoke('tray-menu:get-state'),
    action: (name: TrayMenuAction): void => {
      ipcRenderer.send('tray-menu:action', name)
    }
  },

  // 桌宠右键菜单：无状态，Pet.tsx 传 screenX/Y，main 据此定位窗口
  petMenu: {
    show: (pos: { x: number; y: number }): void => {
      ipcRenderer.send('pet-menu:show', pos)
    },
    action: (name: PetMenuAction): void => {
      ipcRenderer.send('pet-menu:action', name)
    }
  },

  // 工具注册表 IPC + MCP server 管理
  tools: {
    list: (): Promise<ToolDescriptorView[]> => ipcRenderer.invoke('tools:list'),
    listMcpStatus: (): Promise<McpRuntimeStatus[]> =>
      ipcRenderer.invoke('tools:list-mcp-status'),
    addMcpServer: (cfg: McpServerConfig): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('tools:add-mcp-server', cfg),
    removeMcpServer: (id: string): Promise<void> =>
      ipcRenderer.invoke('tools:remove-mcp-server', id),
    toggleMcpServer: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('tools:toggle-mcp-server', id, enabled),
    restartMcpServer: (id: string): Promise<void> =>
      ipcRenderer.invoke('tools:restart-mcp-server', id),
    // server 启停/崩溃/编辑配置都触发；同时需重拉 list()
    onStatusChanged: (
      cb: (statuses: McpRuntimeStatus[]) => void
    ): (() => void) => {
      const handler = (_e: IpcRendererEvent, statuses: McpRuntimeStatus[]): void =>
        cb(statuses)
      ipcRenderer.on('tools:status-changed', handler)
      return () => ipcRenderer.removeListener('tools:status-changed', handler)
    }
  },

  history: {
    list: (): Promise<ConversationRecord[]> => ipcRenderer.invoke('history:list'),
    save: (record: ConversationRecord): Promise<boolean> =>
      ipcRenderer.invoke('history:save', record),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('history:delete', id),
    clear: (): Promise<boolean> => ipcRenderer.invoke('history:clear')
  },

  // renderer 测尺寸 → setState → main 广播给 Pet renderer 布局
  bubble: {
    getState: (): Promise<BubbleState> => ipcRenderer.invoke('bubble:get-state'),
    setState: (state: BubbleState): void => {
      ipcRenderer.send('bubble:set-state', state)
    },
    onStateChanged: (cb: (state: BubbleState) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, state: BubbleState): void => cb(state)
      ipcRenderer.on('bubble:state-changed', handler)
      return () => ipcRenderer.removeListener('bubble:state-changed', handler)
    }
  },

  // pat=摸摸触发；onChanged=30min tick
  vitals: {
    get: (): Promise<PetVitals> => ipcRenderer.invoke('vitals:get'),
    pat: (): void => ipcRenderer.send('vitals:pat'),
    onChanged: (cb: (v: PetVitals) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, v: PetVitals): void => cb(v)
      ipcRenderer.on('vitals:changed', handler)
      return () => ipcRenderer.removeListener('vitals:changed', handler)
    }
  }
}

contextBridge.exposeInMainWorld('xiaoliu', xiaoliuAPI)

export type XiaoliuAPI = typeof xiaoliuAPI
