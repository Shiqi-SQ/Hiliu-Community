// 权限闸门按 toolId 粒度；deny=中止本轮口头禅，deny-disabled=静默回灌让模型换工具
// 三态策略 settings.tools.policies[toolId]: disabled / alwaysAllow / ask（默认）

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { PermissionDecision, PermissionRequest, ToolPolicy } from '@shared/types'
import { loadSettings, saveSettings } from '../store'
import { getToolByName } from './registry'
import type { ToolCall } from './tools'

let petWC: WebContents | null = null

export function setPetWebContents(wc: WebContents | null): void {
  petWC = wc
}

// reqId → resolver，模块作用域贯穿整个 main 生命周期
const pending = new Map<string, (d: PermissionDecision) => void>()

export function resolvePermission(reqId: string, decision: PermissionDecision): void {
  const r = pending.get(reqId)
  if (!r) return
  pending.delete(reqId)
  r(decision)
}

// 流 abort 时把所有悬挂 promise 按 'deny' 兑现，防止 await 永挂
export function abortAllPending(): void {
  const all = Array.from(pending.values())
  pending.clear()
  for (const r of all) r('deny')
}

export async function requestPermission(
  call: ToolCall,
  describe: string
): Promise<PermissionDecision> {
  const desc = getToolByName(call.name)

  // 工具不在 registry → 兜底本次放行（dispatch 会回「工具不存在」错给模型）
  if (!desc) return 'allow_once'
  if (desc.exempt) return 'allow_once'

  const settings = loadSettings()
  const policy: ToolPolicy = settings.tools.policies[desc.id] ?? 'ask'
  if (policy === 'disabled') return 'deny-disabled'
  if (policy === 'alwaysAllow') return 'allow_forever'

  const target = desc.extractTarget(call.args)

  // pet 关了但 stream 在跑：默认拒，安全侧
  if (!petWC || petWC.isDestroyed()) {
    return 'deny'
  }

  const reqId = randomUUID()
  const req: PermissionRequest = {
    reqId,
    tool: desc.name,
    target,
    describe: describe || `正在使用 ${desc.name}：${target}`
  }

  const decision = await new Promise<PermissionDecision>((resolve) => {
    pending.set(reqId, resolve)
    petWC!.send('permission:request', req)
  })

  if (decision === 'allow_forever') {
    setPolicy(desc.id, 'alwaysAllow')
  }

  return decision
}

function setPolicy(toolId: string, policy: ToolPolicy): void {
  const settings = loadSettings()
  saveSettings({
    ...settings,
    tools: {
      ...settings.tools,
      policies: { ...settings.tools.policies, [toolId]: policy }
    }
  })
}

// 拒绝口头禅：不调模型省 token + 避免它解释道歉
const REJECT_REPLIES = [
  '想让我这么做？',
  '有什么要说的吗？',
  '行，那不查了',
  '不查也行，你想聊点别的？',
  '好——那这个先放着',
  '嗯，那就算了'
]

export function pickRejectReply(): string {
  return REJECT_REPLIES[Math.floor(Math.random() * REJECT_REPLIES.length)]
}
