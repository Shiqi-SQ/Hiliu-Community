// 「小刘主动提问用户」的 IPC 双向匹配——对称于 permission.ts，但绕过权限闸门（exempt:true）
// 按钮内容由模型给（2-4 项），UI 固定追加「其他」输入框

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { AskUserQuestionRequest, AskUserQuestionResponse } from '@shared/types'

let petWC: WebContents | null = null

export function setPetWebContents(wc: WebContents | null): void {
  petWC = wc
}

const pending = new Map<string, (r: AskUserQuestionResponse) => void>()

function cancelResponse(reqId: string): AskUserQuestionResponse {
  return { reqId, canceled: true, selectedOptions: [], otherText: '' }
}

export function resolveAskUser(response: AskUserQuestionResponse): void {
  const r = pending.get(response.reqId)
  if (!r) return
  pending.delete(response.reqId)
  r(response)
}

// 流 abort 时所有悬挂 promise 兑现成 canceled，避免 await 永挂
export function abortAllPendingAskUser(): void {
  const all = Array.from(pending.entries())
  pending.clear()
  for (const [reqId, r] of all) {
    r(cancelResponse(reqId))
  }
}

export async function requestAskUser(
  question: string,
  options: string[],
  multiSelect = false
): Promise<AskUserQuestionResponse> {
  if (!petWC || petWC.isDestroyed()) {
    return cancelResponse('')
  }

  const reqId = randomUUID()
  const req: AskUserQuestionRequest = { reqId, question, options, multiSelect }

  return new Promise<AskUserQuestionResponse>((resolve) => {
    pending.set(reqId, resolve)
    petWC!.send('ask-user:request', req)
  })
}
