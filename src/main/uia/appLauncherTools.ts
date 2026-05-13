import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from '../system/binPath'
import { uiaCall } from './uiaService'

const RPC_TIMEOUT = 12000  // Start Menu 首次扫盘可能 1-2s

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

interface AppCandidate {
  name: string
  type: string
  score: number
}

interface LaunchAppResult {
  launched: { name: string; type: string; target: string }
  ambiguous: boolean
  candidates: AppCandidate[]
}

const launchAppFragment = [
  'launch_app(query: string)',
  '   按名字模糊匹配启动一个应用。query 不区分大小写，支持部分匹配。',
  '   匹配优先级：完全匹配 > 前缀匹配 > 包含匹配。',
  '   覆盖范围：Start Menu 所有 .lnk + Microsoft Store / UWP 应用（Get-StartApps）。',
  '   场景：用户说「打开微信」「启动 VSCode」「开个 Edge」。',
  '   注意：',
  '     - 多候选时返回 ambiguous=true 与 top-5 候选名——如果启动的不是用户想要的，',
  '       从候选里挑一个更精确的 name 重试，或追问用户。',
  '     - 启动的是「应用本身」，不是「打开某个文件」——后者用 ps_exec / bash_exec',
  '       的 Start-Process / explorer / open 命令。'
].join('\n')

const launchAppDescriptor: ToolDescriptor = {
  id: 'builtin:launch_app',
  name: 'launch_app',
  source: 'builtin',
  displayName: 'launch_app',
  description: '按名字模糊匹配启动应用（Start Menu + UWP）。',
  promptFragment: { appLayer: launchAppFragment, native: launchAppFragment },
  nativeDef: {
    name: 'launch_app',
    description:
      '按名字模糊匹配启动一个已安装的应用。覆盖 Start Menu 所有 .lnk 和 UWP / Microsoft Store 应用。匹配优先级：完全 > 前缀 > 包含。多候选时返回 candidates 列表。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '应用名（部分匹配，不区分大小写）' }
      },
      required: ['query']
    }
  },
  extractTarget: (args) => `启动应用：${asString(args.query)}`,
  executor: async (args) => {
    const query = asString(args.query).trim()
    if (!query) return { ok: false, content: '（系统）launch_app 缺 query 参数。' }
    try {
      const r = (await uiaCall('launch_app', { query }, RPC_TIMEOUT)) as LaunchAppResult
      const launched = r.launched
      const candidatesText = r.candidates
        .map((c) => `${c.name} (${c.type}, ${c.score})`)
        .join(' / ')
      const note = r.ambiguous
        ? `\n（候选：${candidatesText}——如果启动的不对，换更精确的 query 重试）`
        : ''
      return { ok: true, content: `已启动：${launched.name}（${launched.type}）${note}` }
    } catch (e) {
      return { ok: false, content: `（系统）launch_app 失败：${(e as Error).message}` }
    }
  }
}

const listInstalledAppsFragment = [
  'list_installed_apps(filter?: string, limit?: number)',
  '   列已安装应用（Start Menu + UWP）。',
  '   filter 给了就只返回名字匹配的项；不给返回前 limit 个（默认 50）。',
  '   limit 上限 500——更大没意义，模型也读不过来。',
  '   场景：用户问「我电脑上有哪些 Office 软件」「都装了什么浏览器」。',
  '   返回每项 {name, type}，type=lnk 是传统桌面应用，type=uwp 是商店应用。'
].join('\n')

const listInstalledAppsDescriptor: ToolDescriptor = {
  id: 'builtin:list_installed_apps',
  name: 'list_installed_apps',
  source: 'builtin',
  displayName: 'list_installed_apps',
  description: '列已安装应用（Start Menu + UWP），可按关键词过滤。',
  promptFragment: { appLayer: listInstalledAppsFragment, native: listInstalledAppsFragment },
  nativeDef: {
    name: 'list_installed_apps',
    description:
      '列已安装应用（覆盖 Start Menu .lnk + UWP / Microsoft Store）。可按 filter 过滤、limit 截取。',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '过滤关键词（不区分大小写，部分匹配）' },
        limit: { type: 'number', description: '返回上限，默认 50，最大 500' }
      }
    }
  },
  extractTarget: (args) => {
    const filter = asString(args.filter).trim()
    return filter ? `列应用（过滤：${filter}）` : '列已安装应用'
  },
  executor: async (args) => {
    const params: Record<string, unknown> = {}
    const filter = asString(args.filter).trim()
    if (filter) params.filter = filter
    const limit = asInt(args.limit, 0)
    if (limit > 0) params.limit = limit
    try {
      const r = (await uiaCall('list_installed_apps', params, RPC_TIMEOUT)) as {
        total: number
        returned: number
        filter: string
        items: Array<{ name: string; type: string }>
      }
      if (r.items.length === 0) {
        return {
          ok: true,
          content: filter ? `没有匹配「${filter}」的应用。` : '没找到任何已安装应用。'
        }
      }
      const lines = r.items.map((it) => `  - ${it.name} (${it.type})`).join('\n')
      const head = filter
        ? `匹配「${filter}」共 ${r.returned} 个：`
        : `已安装应用共 ${r.total} 个，列前 ${r.returned} 个：`
      return { ok: true, content: `${head}\n${lines}` }
    } catch (e) {
      return { ok: false, content: `（系统）list_installed_apps 失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapAppLauncherTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[appLauncherTools] uia-daemon.ps1 不存在 → launch_app / list_installed_apps 不注册')
    return
  }
  registerTool(launchAppDescriptor)
  registerTool(listInstalledAppsDescriptor)
}
