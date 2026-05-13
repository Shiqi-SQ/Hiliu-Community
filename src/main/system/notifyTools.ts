// cron fire 时只推桌面通知，不回灌给模型——hiliu 没有「主动唤醒模型」协议
// setTimeout 受 32-bit signed int 限制（~24.8 天），超出截到 24 天

import { Notification } from 'electron'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

const pushNotificationFragment = [
  'push_notification(message: string)',
  '   弹一条系统级桌面通知（Windows 10+ 走原生 Toast）。',
  '   适合长任务跑完了 / 监视到关键事件 / 用户离开了一会需要把人拉回来这类场景。',
  '   message 限 200 字以内（系统会截断）；无 status 字段，hiliu 永远当成 proactive 处理。'
].join('\n')

const pushNotificationDescriptor: ToolDescriptor = {
  id: 'builtin:push_notification',
  name: 'push_notification',
  source: 'builtin',
  displayName: 'push_notification',
  description: '弹一条系统桌面通知（Win10+ 原生 Toast）。适合长任务完成、关键事件、把走神的用户喊回来。',
  promptFragment: { appLayer: pushNotificationFragment, native: pushNotificationFragment },
  nativeDef: {
    name: 'push_notification',
    description:
      '弹一条系统级桌面通知。适合长任务完成、需要用户回到屏幕前查看结果时使用。message 限 200 字以内。',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '通知正文，建议一句话，<200 字' }
      },
      required: ['message']
    }
  },
  extractTarget: (args) => asString(args.message),
  executor: async (args) => {
    const message = asString(args.message).trim()
    if (!message) return { ok: false, content: '（系统）push_notification 缺少 message 参数。' }
    if (!Notification.isSupported()) {
      return { ok: false, content: '（系统）当前环境不支持原生通知（Notification.isSupported() = false）。' }
    }
    try {
      const n = new Notification({
        title: '小刘',
        body: message.slice(0, 200),
        silent: false
      })
      n.show()
      return { ok: true, content: `已弹出桌面通知：「${message.slice(0, 200)}」` }
    } catch (e) {
      return { ok: false, content: `（系统）弹通知失败：${(e as Error).message}` }
    }
  }
}

interface CronExpr {
  minute: Set<number>   // 0-59
  hour: Set<number>     // 0-23
  dom: Set<number>      // 1-31
  month: Set<number>    // 1-12
  dow: Set<number>      // 0-6（周日为 0）
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>()
  for (const part of field.split(',')) {
    const p = part.trim()
    if (!p) continue
    const stepMatch = p.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      if (step <= 0) throw new Error(`step <= 0：${p}`)
      for (let v = min; v <= max; v += step) result.add(v)
      continue
    }
    if (p === '*') {
      for (let v = min; v <= max; v++) result.add(v)
      continue
    }
    const rangeMatch = p.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10)
      const b = parseInt(rangeMatch[2], 10)
      if (a < min || b > max || a > b) throw new Error(`范围超界：${p}`)
      for (let v = a; v <= b; v++) result.add(v)
      continue
    }
    if (/^\d+$/.test(p)) {
      const v = parseInt(p, 10)
      if (v < min || v > max) throw new Error(`数值超界：${p}（${min}-${max}）`)
      result.add(v)
      continue
    }
    throw new Error(`无法解析的字段：${p}`)
  }
  if (result.size === 0) throw new Error(`字段空集：${field}`)
  return result
}

function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须 5 字段（分 时 日 月 周），得到 ${parts.length} 字段：${expr}`)
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6)
  }
}

// 朴素逐分扫描，最多扫一年兜底死循环
function nextFireTime(cron: CronExpr, after: Date): Date | null {
  const t = new Date(after.getTime() + 60_000)
  t.setSeconds(0, 0)
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (
      cron.minute.has(t.getMinutes()) &&
      cron.hour.has(t.getHours()) &&
      cron.dom.has(t.getDate()) &&
      cron.month.has(t.getMonth() + 1) &&
      cron.dow.has(t.getDay())
    ) {
      return new Date(t)
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

interface CronJob {
  id: string
  cron: string
  parsed: CronExpr
  prompt: string
  recurring: boolean
  createdAt: number
  nextFireAt: number | null
  timer: NodeJS.Timeout | null
}

const cronJobs = new Map<string, CronJob>()

function genJobId(): string {
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function scheduleNext(job: CronJob): void {
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = null
  }
  const next = nextFireTime(job.parsed, new Date())
  if (!next) {
    job.nextFireAt = null
    return
  }
  job.nextFireAt = next.getTime()
  // setTimeout 受 32-bit signed int 限制（~24.8 天），超出截到 24 天
  const delay = Math.min(next.getTime() - Date.now(), 24 * 24 * 60 * 60 * 1000)
  job.timer = setTimeout(() => fireJob(job), Math.max(delay, 0))
}

function fireJob(job: CronJob): void {
  if (Notification.isSupported()) {
    try {
      const n = new Notification({
        title: '小刘 · 定时提醒',
        body: job.prompt.slice(0, 200),
        silent: false
      })
      n.show()
    } catch {
      /* ignore — 通知失败不阻塞调度 */
    }
  }
  if (job.recurring) {
    scheduleNext(job)
  } else {
    cronJobs.delete(job.id)
  }
}

const cronCreateFragment = [
  'cron_create(cron: string, prompt: string, recurring?: boolean)',
  '   注册一个定时任务。cron 是标准 5 字段表达式（分 时 日 月 周），本地时区。',
  '   recurring 默认 true（重复触发）；false 则触发一次后自删。',
  '   触发时弹桌面通知，body 是 prompt 内容——hiliu 不会自动唤醒模型，用户看到通知后自己决定要不要再来找小刘。',
  '   会话级：main 进程重启后所有任务清零，不持久化。',
  '   小刘提醒一句：分钟字段尽量不要写 0 或 30——「整点 / 半点」全网用户撞车严重，写 7 / 23 / 47 这种偏移更友好。'
].join('\n')

const cronCreateDescriptor: ToolDescriptor = {
  id: 'builtin:cron_create',
  name: 'cron_create',
  source: 'builtin',
  displayName: 'cron_create',
  description: '注册一个定时任务（cron 表达式 5 字段，本地时区）。触发时弹桌面通知。会话级、不持久化。',
  promptFragment: { appLayer: cronCreateFragment, native: cronCreateFragment },
  nativeDef: {
    name: 'cron_create',
    description:
      '注册一个会话级定时任务。cron 5 字段（分 时 日 月 周）本地时区。触发时弹桌面通知，body 是 prompt 内容。recurring=true 重复触发，false 触发一次后自删。',
    input_schema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: '5 字段 cron 表达式，例如 "0 9 * * 1-5"（工作日 9:00）' },
        prompt: { type: 'string', description: '触发时通知 body 的文本' },
        recurring: {
          type: 'boolean',
          description: '是否重复触发，默认 true；false 触发一次后自删'
        }
      },
      required: ['cron', 'prompt']
    }
  },
  extractTarget: (args) => `${asString(args.cron)} → ${asString(args.prompt).slice(0, 40)}`,
  executor: async (args) => {
    const cronExpr = asString(args.cron).trim()
    const prompt = asString(args.prompt).trim()
    if (!cronExpr) return { ok: false, content: '（系统）cron_create 缺少 cron 参数。' }
    if (!prompt) return { ok: false, content: '（系统）cron_create 缺少 prompt 参数。' }
    const recurring = args.recurring !== false  // 默认 true
    let parsed: CronExpr
    try {
      parsed = parseCron(cronExpr)
    } catch (e) {
      return { ok: false, content: `（系统）cron 表达式解析失败：${(e as Error).message}` }
    }
    const id = genJobId()
    const job: CronJob = {
      id,
      cron: cronExpr,
      parsed,
      prompt,
      recurring,
      createdAt: Date.now(),
      nextFireAt: null,
      timer: null
    }
    scheduleNext(job)
    cronJobs.set(id, job)
    const nextStr = job.nextFireAt
      ? new Date(job.nextFireAt).toLocaleString('zh-CN')
      : '（无未来匹配时间）'
    return {
      ok: true,
      content: `已注册 cron 任务 ${id}（${cronExpr}），下次触发：${nextStr}，${recurring ? '重复' : '单次'}`
    }
  }
}

const cronDeleteFragment = [
  'cron_delete(id: string)',
  '   按 id 取消已注册的 cron 任务。id 来自 cron_create 的返回内容或 cron_list。'
].join('\n')

const cronDeleteDescriptor: ToolDescriptor = {
  id: 'builtin:cron_delete',
  name: 'cron_delete',
  source: 'builtin',
  displayName: 'cron_delete',
  description: '按 id 取消已注册的 cron 任务。',
  promptFragment: { appLayer: cronDeleteFragment, native: cronDeleteFragment },
  nativeDef: {
    name: 'cron_delete',
    description: '按 id 取消已注册的 cron 任务。id 来自 cron_create 的返回或 cron_list。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'cron 任务 id' }
      },
      required: ['id']
    }
  },
  extractTarget: (args) => asString(args.id),
  executor: async (args) => {
    const id = asString(args.id).trim()
    if (!id) return { ok: false, content: '（系统）cron_delete 缺少 id 参数。' }
    const job = cronJobs.get(id)
    if (!job) return { ok: false, content: `（系统）找不到 id=${id} 的 cron 任务。` }
    if (job.timer) clearTimeout(job.timer)
    cronJobs.delete(id)
    return { ok: true, content: `已取消 cron 任务 ${id}（${job.cron}）` }
  }
}

const cronListFragment = [
  'cron_list()',
  '   列出当前所有已注册的 cron 任务（会话级）。无参数。',
  '   返回每条 id / cron 表达式 / 下次触发时间 / 是否重复 / prompt 摘要。'
].join('\n')

const cronListDescriptor: ToolDescriptor = {
  id: 'builtin:cron_list',
  name: 'cron_list',
  source: 'builtin',
  displayName: 'cron_list',
  description: '列出当前所有已注册的 cron 任务。',
  promptFragment: { appLayer: cronListFragment, native: cronListFragment },
  nativeDef: {
    name: 'cron_list',
    description: '列出当前所有已注册的 cron 任务（会话级）。无参数。',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  extractTarget: () => '当前 cron 任务列表',
  executor: async () => {
    if (cronJobs.size === 0) {
      return { ok: true, content: '当前没有已注册的 cron 任务。' }
    }
    const rows = Array.from(cronJobs.values()).map((j) => {
      const next = j.nextFireAt ? new Date(j.nextFireAt).toLocaleString('zh-CN') : '（无未来时间）'
      const promptShort = j.prompt.length > 40 ? j.prompt.slice(0, 40) + '…' : j.prompt
      return `- ${j.id} | ${j.cron} | 下次：${next} | ${j.recurring ? '重复' : '单次'} | "${promptShort}"`
    })
    return { ok: true, content: `共 ${cronJobs.size} 条 cron 任务：\n${rows.join('\n')}` }
  }
}

export function bootstrapNotifyTools(): void {
  registerTool(pushNotificationDescriptor)
  registerTool(cronCreateDescriptor)
  registerTool(cronDeleteDescriptor)
  registerTool(cronListDescriptor)
}
