// 路径策略：只接绝对路径或 ~ 开头——相对路径在 main 进程里无有意义的 cwd 语义
// 二进制检测：前 8KB 出现 \0 视为二进制（最便宜的启发式，拒绝回灌 PNG/EXE 乱码）

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { resolveBinPath, binExists } from './binPath'

const execFileAsync = promisify(execFile)

const MAX_READ_BYTES_DEFAULT = 100 * 1024 // 100KB
const MAX_READ_BYTES_HARD = 1024 * 1024 // 1MB 硬上限
const MAX_LIST_ENTRIES = 200
const MAX_SEARCH_FILE_RESULTS = 50
const MAX_SEARCH_IN_FILES_RESULTS = 100
const MAX_LINE_LENGTH = 500 // minified js 等超长行截断展示

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

function asPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

// ~ 展开 + 绝对路径校验；返回 null 表示路径非法
function normalizePath(raw: string): string | null {
  let p = raw.trim()
  if (!p) return null
  if (p === '~') p = os.homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2))
  if (!path.isAbsolute(p)) return null
  return path.normalize(p)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

// 简单 glob → RegExp（支持 *, **, ?），仅给 list_dir 用
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/<<DOUBLESTAR>>/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

const readFileFragment = [
  'read_file(path: string, maxBytes?: number)',
  '   读用户电脑上一个文本文件的内容。path 必须是绝对路径或 ~/ 开头。',
  '   maxBytes 可选，默认 100KB，最大 1MB。文件超长会自动截断并标注。',
  '   会拒绝读二进制文件（PNG / EXE / 压缩包等）——遇到这种直接说"这是二进制我不读"。'
].join('\n')

const readFileDescriptor: ToolDescriptor = {
  id: 'builtin:read_file',
  name: 'read_file',
  source: 'builtin',
  displayName: 'read_file',
  description: '读用户电脑上一个文本文件的完整内容。会拒读二进制文件，超长自动截断。',
  promptFragment: { appLayer: readFileFragment, native: readFileFragment },
  nativeDef: {
    name: 'read_file',
    description: '读取用户电脑上指定文件的文本内容。仅文本文件，遇到二进制会拒绝。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~/ 开头的家目录路径' },
        maxBytes: { type: 'number', description: '可选，最大字节数，默认 100KB，硬上限 1MB' }
      },
      required: ['path']
    }
  },
  extractTarget: (args) => asString(args.path),
  executor: async (args) => {
    const filePath = normalizePath(asString(args.path))
    if (!filePath) {
      return {
        ok: false,
        content: '路径必须是绝对路径或 ~/ 开头（相对路径在系统服务进程里语义不明确）。'
      }
    }
    const maxBytes = Math.min(asPositiveInt(args.maxBytes, MAX_READ_BYTES_DEFAULT), MAX_READ_BYTES_HARD)

    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) {
        return {
          ok: false,
          content: `路径不是文件：${filePath}（这是${stat.isDirectory() ? '目录' : '其他类型'}，目录请用 list_dir）`
        }
      }
      if (stat.size > MAX_READ_BYTES_HARD) {
        return {
          ok: false,
          content: `文件太大（${formatBytes(stat.size)}），超过 1MB 硬上限。试试 search_in_files 直接搜你要的内容。`
        }
      }

      const buf = await fsp.readFile(filePath)
      // 前 8KB 内出现 \0 字节视为二进制
      const sniffLen = Math.min(8192, buf.length)
      let hasNull = false
      for (let i = 0; i < sniffLen; i++) {
        if (buf[i] === 0) { hasNull = true; break }
      }
      if (hasNull) {
        return {
          ok: false,
          content: `「${filePath}」看起来是二进制文件（PNG / EXE / 压缩包等），我不读这种。`
        }
      }

      let text = buf.toString('utf-8')
      let truncated = false
      if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
        const approxChars = Math.floor((maxBytes / 3) * 0.95)
        text = text.slice(0, approxChars)
        truncated = true
      }

      const header = `（${filePath}  ${formatBytes(stat.size)}  修改于 ${formatTime(stat.mtime)}）`
      const trailer = truncated ? `\n\n（注：文件超过 ${formatBytes(maxBytes)} 已截断）` : ''
      return { ok: true, content: `${header}\n\n${text}${trailer}` }
    } catch (e: unknown) {
      return { ok: false, content: formatFsError(e, filePath) }
    }
  }
}

const listDirFragment = [
  'list_dir(path: string, glob?: string)',
  '   列出某个目录下的内容（文件 + 子目录）。path 必须是绝对路径或 ~/ 开头。',
  '   glob 可选，简单通配（* ? **），如 "*.md" 只列 md 文件。',
  '   超过 200 项会截断；想找具体文件请用 search_file（全盘文件名搜索）。'
].join('\n')

const listDirDescriptor: ToolDescriptor = {
  id: 'builtin:list_dir',
  name: 'list_dir',
  source: 'builtin',
  displayName: 'list_dir',
  description: '列出某个目录的内容。可选 glob 过滤，最多返回 200 项。',
  promptFragment: { appLayer: listDirFragment, native: listDirFragment },
  nativeDef: {
    name: 'list_dir',
    description: '列出指定目录下的文件和子目录。可选 glob 过滤。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~/ 开头的目录' },
        glob: { type: 'string', description: '可选 glob 通配，如 "*.md"' }
      },
      required: ['path']
    }
  },
  extractTarget: (args) => asString(args.path),
  executor: async (args) => {
    const dirPath = normalizePath(asString(args.path))
    if (!dirPath) {
      return { ok: false, content: '路径必须是绝对路径或 ~/ 开头。' }
    }
    const glob = asString(args.glob).trim()
    const re = glob ? globToRegExp(glob) : null

    try {
      const stat = await fsp.stat(dirPath)
      if (!stat.isDirectory()) {
        return { ok: false, content: `路径不是目录：${dirPath}（请用 read_file 读文件）` }
      }
      const entries = await fsp.readdir(dirPath, { withFileTypes: true })
      const filtered = re ? entries.filter((e) => re.test(e.name)) : entries
      const truncated = filtered.length > MAX_LIST_ENTRIES
      const display = filtered.slice(0, MAX_LIST_ENTRIES)

      // 目录加 / 后缀，文件附大小（只对前 50 项查 size，async stat 太慢）
      const lines: string[] = []
      lines.push(`（${dirPath}  共 ${filtered.length} 项${truncated ? '，已截断' : ''}）`)
      lines.push('')

      const dirs = display.filter((e) => e.isDirectory())
      const files = display.filter((e) => e.isFile())
      const others = display.filter((e) => !e.isDirectory() && !e.isFile())

      if (dirs.length > 0) {
        lines.push('目录:')
        for (const d of dirs) lines.push(`  ${d.name}/`)
        lines.push('')
      }
      if (files.length > 0) {
        lines.push('文件:')
        const stats = await Promise.all(
          files.slice(0, 50).map(async (f) => {
            try {
              const s = await fsp.stat(path.join(dirPath, f.name))
              return { name: f.name, size: s.size }
            } catch {
              return { name: f.name, size: -1 }
            }
          })
        )
        for (const f of stats) {
          lines.push(`  ${f.name}${f.size >= 0 ? `  (${formatBytes(f.size)})` : ''}`)
        }
        if (files.length > 50) {
          for (const f of files.slice(50)) lines.push(`  ${f.name}`)
        }
        lines.push('')
      }
      if (others.length > 0) {
        lines.push('其他（链接 / 设备 / 管道）:')
        for (const o of others) lines.push(`  ${o.name}`)
      }
      if (truncated) {
        lines.push(`\n（注：超过 ${MAX_LIST_ENTRIES} 项已截断；想找具体文件用 search_file）`)
      }
      return { ok: true, content: lines.join('\n').trimEnd() }
    } catch (e: unknown) {
      return { ok: false, content: formatFsError(e, dirPath) }
    }
  }
}

const searchFileFragment = [
  'search_file(query: string, limit?: number)',
  '   全盘文件名 / 路径搜索（基于 Everything 索引，毫秒级）。',
  '   query 是 Everything 语法，常用：',
  '     - "report.docx"  ← 直接关键词',
  '     - "ext:pdf"       ← 按扩展名',
  '     - "C:\\Users\\foo\\*.md"  ← 路径前缀',
  '   limit 可选，默认 30，最大 50。',
  '   注意：只搜文件名 / 路径，不搜内容。要搜内容用 search_in_files。'
].join('\n')

const searchFileDescriptor: ToolDescriptor = {
  id: 'builtin:search_file',
  name: 'search_file',
  source: 'builtin',
  displayName: 'search_file',
  description: 'Everything 文件名全盘搜索（基于 Everything 索引）。仅搜文件名 / 路径，不搜内容。',
  promptFragment: { appLayer: searchFileFragment, native: searchFileFragment },
  nativeDef: {
    name: 'search_file',
    description:
      '基于 Everything 索引的全盘文件名搜索（毫秒级）。query 支持 Everything 语法。仅搜文件名 / 路径，不搜内容。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Everything 搜索语法，如 "report.docx" / "ext:pdf"' },
        limit: { type: 'number', description: '可选，最大返回条数，默认 30，硬上限 50' }
      },
      required: ['query']
    }
  },
  extractTarget: (args) => asString(args.query),
  executor: async (args) => {
    const query = asString(args.query).trim()
    if (!query) return { ok: false, content: '（系统）search_file 缺少 query 参数。' }
    const limit = Math.min(asPositiveInt(args.limit, 30), MAX_SEARCH_FILE_RESULTS)

    const esPath = resolveBinPath('es.exe')
    try {
      // -n N 限制条数；-p 输出完整路径
      const { stdout } = await execFileAsync(esPath, ['-n', String(limit), '-p', query], {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024
      })
      const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      if (lines.length === 0) {
        return { ok: true, content: `Everything 搜索「${query}」没有结果。试试换关键词或加 ext: 前缀。` }
      }
      const out: string[] = []
      out.push(`（搜索 "${query}"，找到 ${lines.length} 项）`)
      out.push('')
      for (const l of lines) out.push(l)
      return { ok: true, content: out.join('\n') }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // binExists 已挡在注册前，ENOENT 此处仅兜底
      if (msg.includes('ENOENT')) {
        return { ok: false, content: 'es.exe 没找到——这工具的二进制缺失，请联系开发者。' }
      }
      // Everything 服务未就绪时 es.exe 退出码非 0
      return {
        ok: false,
        content: `Everything 搜索失败：${msg}\n（如果是首次启动，Everything 服务可能还在建索引，等几秒再试。）`
      }
    }
  }
}

const searchInFilesFragment = [
  'search_in_files(pattern: string, path: string, glob?: string)',
  '   在指定目录下递归搜文件**内容**（基于 ripgrep）。pattern 支持正则。',
  '   path 必须是绝对路径或 ~/ 开头。',
  '   glob 可选，过滤文件名，如 "*.{ts,js}" / "!node_modules"（! 前缀=排除）。',
  '   返回每个命中行的路径 + 行号 + 内容。最多 100 行结果。',
  '   注意：rg 已自动跳过 .gitignore 内容；只想搜文件名用 search_file。'
].join('\n')

const searchInFilesDescriptor: ToolDescriptor = {
  id: 'builtin:search_in_files',
  name: 'search_in_files',
  source: 'builtin',
  displayName: 'search_in_files',
  description: 'ripgrep 全文递归搜索。在指定目录下搜文件内容，支持正则 + glob 过滤。',
  promptFragment: { appLayer: searchInFilesFragment, native: searchInFilesFragment },
  nativeDef: {
    name: 'search_in_files',
    description:
      '在指定目录下递归搜索文件内容（基于 ripgrep）。pattern 支持正则，glob 过滤文件名。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜的内容，支持正则' },
        path: { type: 'string', description: '搜索根目录，绝对路径或 ~/ 开头' },
        glob: { type: 'string', description: '可选文件 glob 过滤，如 "*.ts" 或 "!node_modules"' }
      },
      required: ['pattern', 'path']
    }
  },
  extractTarget: (args) => `${asString(args.pattern)}（在 ${asString(args.path)}）`,
  executor: async (args) => {
    const pattern = asString(args.pattern)
    if (!pattern) return { ok: false, content: '（系统）search_in_files 缺少 pattern 参数。' }
    const dirPath = normalizePath(asString(args.path))
    if (!dirPath) return { ok: false, content: '搜索目录必须是绝对路径或 ~/ 开头。' }
    const glob = asString(args.glob).trim()

    const rgPath = resolveBinPath('rg.exe')
    const argv = [
      '--line-number',
      '--no-heading',
      '--max-count', '20', // 单文件最多 20 行命中——避免某文件刷屏
      '--max-columns', String(MAX_LINE_LENGTH),
      '--max-filesize', '2M',
      '--smart-case'
    ]
    if (glob) argv.push('--glob', glob)
    argv.push(pattern, dirPath)

    try {
      const { stdout } = await execFileAsync(rgPath, argv, {
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024
      })
      const lines = stdout.split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) {
        return { ok: true, content: `在 ${dirPath} 下搜「${pattern}」没找到匹配。` }
      }
      const truncated = lines.length > MAX_SEARCH_IN_FILES_RESULTS
      const display = lines.slice(0, MAX_SEARCH_IN_FILES_RESULTS)
      const out: string[] = []
      out.push(`（在 ${dirPath} 下搜「${pattern}」${glob ? ` (glob=${glob})` : ''}，命中 ${lines.length} 行${truncated ? '（已截断）' : ''}）`)
      out.push('')
      for (const l of display) out.push(l)
      if (truncated) out.push(`\n（注：超过 ${MAX_SEARCH_IN_FILES_RESULTS} 行已截断；缩小 path 或加 glob 过滤）`)
      return { ok: true, content: out.join('\n') }
    } catch (e: unknown) {
      // rg 退出码 1 = 没找到结果——execFile 把它当错误抛
      const err = e as { code?: number; stdout?: string; message?: string }
      if (err.code === 1 && (err.stdout ?? '').trim() === '') {
        return { ok: true, content: `在 ${dirPath} 下搜「${pattern}」没找到匹配。` }
      }
      const msg = err.message ?? String(e)
      if (msg.includes('ENOENT')) {
        return { ok: false, content: 'rg.exe 没找到——这工具的二进制缺失，请联系开发者。' }
      }
      return { ok: false, content: `ripgrep 搜索失败：${msg}` }
    }
  }
}

const statFileFragment = [
  'stat_file(path: string)',
  '   查看一个文件 / 目录的元信息：类型、大小、创建时间、修改时间、是否符号链接。',
  '   path 必须是绝对路径或 ~/ 开头。比 read_file 便宜——只看大小日期不读内容时用。'
].join('\n')

const statFileDescriptor: ToolDescriptor = {
  id: 'builtin:stat_file',
  name: 'stat_file',
  source: 'builtin',
  displayName: 'stat_file',
  description: '查看文件 / 目录的元信息（大小、修改时间、类型）。不读内容，比 read_file 便宜。',
  promptFragment: { appLayer: statFileFragment, native: statFileFragment },
  nativeDef: {
    name: 'stat_file',
    description: '获取文件 / 目录的元信息：类型、大小、创建 / 修改时间、是否符号链接。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~/ 开头' }
      },
      required: ['path']
    }
  },
  extractTarget: (args) => asString(args.path),
  executor: async (args) => {
    const filePath = normalizePath(asString(args.path))
    if (!filePath) return { ok: false, content: '路径必须是绝对路径或 ~/ 开头。' }

    try {
      const stat = await fsp.lstat(filePath)
      const isSymlink = stat.isSymbolicLink()
      let symlinkTarget = ''
      if (isSymlink) {
        try {
          symlinkTarget = await fsp.readlink(filePath)
        } catch {
          symlinkTarget = '（无法读取链接目标）'
        }
      }

      const lines: string[] = []
      lines.push(`路径: ${filePath}`)
      lines.push(`类型: ${describeType(stat)}`)
      if (isSymlink) lines.push(`链接指向: ${symlinkTarget}`)
      lines.push(`大小: ${formatBytes(stat.size)}`)
      lines.push(`创建: ${formatTime(stat.birthtime)}`)
      lines.push(`修改: ${formatTime(stat.mtime)}`)
      lines.push(`访问: ${formatTime(stat.atime)}`)
      return { ok: true, content: lines.join('\n') }
    } catch (e: unknown) {
      return { ok: false, content: formatFsError(e, filePath) }
    }
  }
}

function describeType(stat: fs.Stats): string {
  if (stat.isFile()) return '文件'
  if (stat.isDirectory()) return '目录'
  if (stat.isSymbolicLink()) return '符号链接'
  if (stat.isBlockDevice()) return '块设备'
  if (stat.isCharacterDevice()) return '字符设备'
  if (stat.isFIFO()) return 'FIFO 管道'
  if (stat.isSocket()) return 'Socket'
  return '未知'
}

function formatFsError(e: unknown, p: string): string {
  const err = e as { code?: string; message?: string }
  if (err.code === 'ENOENT') return `路径不存在：${p}`
  if (err.code === 'EACCES' || err.code === 'EPERM') return `没有权限访问：${p}`
  if (err.code === 'ENOTDIR') return `路径中有部分不是目录：${p}`
  if (err.code === 'EISDIR') return `路径是目录不是文件：${p}`
  return `操作失败：${err.message ?? String(e)}`
}

const writeFileFragment = [
  'write_file(path: string, content: string)',
  '   把 content 完整写入文件。path 必须是绝对路径或 ~/ 开头。',
  '   文件已存在会**覆盖**整个文件——要修改局部用 edit_file，不要拿这个反复读改写。',
  '   父目录不存在会自动创建。'
].join('\n')

const writeFileDescriptor: ToolDescriptor = {
  id: 'builtin:write_file',
  name: 'write_file',
  source: 'builtin',
  displayName: 'write_file',
  description: '把 content 完整写入文件（覆盖）。父目录不存在会自动创建。',
  promptFragment: { appLayer: writeFileFragment, native: writeFileFragment },
  nativeDef: {
    name: 'write_file',
    description: '把 content 完整写入指定路径的文件。父目录不存在会自动创建。已存在的文件会被覆盖。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~/ 开头' },
        content: { type: 'string', description: '要写入的完整内容（UTF-8）' }
      },
      required: ['path', 'content']
    }
  },
  extractTarget: (args) => asString(args.path),
  executor: async (args) => {
    const filePath = normalizePath(asString(args.path))
    if (!filePath) return { ok: false, content: '路径必须是绝对路径或 ~/ 开头。' }
    const content = asString(args.content)
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true })
      await fsp.writeFile(filePath, content, 'utf-8')
      const size = Buffer.byteLength(content, 'utf-8')
      return { ok: true, content: `已写入 ${filePath}（${formatBytes(size)}）。` }
    } catch (e: unknown) {
      return { ok: false, content: formatFsError(e, filePath) }
    }
  }
}

const editFileFragment = [
  'edit_file(path: string, old_string: string, new_string: string, replace_all?: boolean)',
  '   在文件里把 old_string 替换成 new_string。path 必须是绝对路径或 ~/ 开头。',
  '   默认只替换**唯一一处**——old_string 在文件里出现多次时会**报错**，要么把 old_string',
  '   扩到带前后行的唯一片段，要么传 replace_all=true 全替换。',
  '   适合改局部；要改大半个文件直接用 write_file 重写。'
].join('\n')

const editFileDescriptor: ToolDescriptor = {
  id: 'builtin:edit_file',
  name: 'edit_file',
  source: 'builtin',
  displayName: 'edit_file',
  description: '在文件里替换 old_string → new_string。多匹配会报错（除非 replace_all=true）。',
  promptFragment: { appLayer: editFileFragment, native: editFileFragment },
  nativeDef: {
    name: 'edit_file',
    description:
      '在指定文件里把 old_string 替换成 new_string。默认要求 old_string 在文件中**唯一**——多匹配会失败并提示扩展上下文；replace_all=true 可全部替换。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~/ 开头' },
        old_string: { type: 'string', description: '要查找的原文（必须 1:1 匹配，含空白）' },
        new_string: { type: 'string', description: '替换后的文本' },
        replace_all: {
          type: 'boolean',
          description: '默认 false。true 时把所有匹配都替换；false 时多匹配视为错误。'
        }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  extractTarget: (args) => asString(args.path),
  executor: async (args) => {
    const filePath = normalizePath(asString(args.path))
    if (!filePath) return { ok: false, content: '路径必须是绝对路径或 ~/ 开头。' }
    const oldStr = asString(args.old_string)
    const newStr = asString(args.new_string)
    const replaceAll = args.replace_all === true
    if (oldStr === '') return { ok: false, content: 'old_string 不能为空——这会无穷匹配。' }
    if (oldStr === newStr) {
      return { ok: false, content: 'old_string 和 new_string 一样，没什么可改的。' }
    }
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) return { ok: false, content: `路径不是文件：${filePath}。` }
      if (stat.size > MAX_READ_BYTES_HARD) {
        return { ok: false, content: `文件太大（${formatBytes(stat.size)}），超过 1MB 硬上限。` }
      }
      const original = await fsp.readFile(filePath, 'utf-8')
      // split 计匹配次数，比 indexOf 循环简洁
      const segments = original.split(oldStr)
      const matchCount = segments.length - 1
      if (matchCount === 0) {
        return {
          ok: false,
          content: `没在 ${filePath} 里找到 old_string——确认空白/缩进/换行 1:1 一致后再试。`
        }
      }
      if (matchCount > 1 && !replaceAll) {
        return {
          ok: false,
          content:
            `old_string 在 ${filePath} 里匹配了 ${matchCount} 处，超过 1 处。\n` +
            '请二选一：(a) 把 old_string 扩到带前后行的唯一片段，(b) 显式传 `replace_all: true` 全替换。'
        }
      }
      const updated = replaceAll ? segments.join(newStr) : original.replace(oldStr, newStr)
      await fsp.writeFile(filePath, updated, 'utf-8')
      const replaced = replaceAll ? matchCount : 1
      return {
        ok: true,
        content: `已在 ${filePath} 替换 ${replaced} 处（${replaceAll ? 'replace_all' : '单次替换'}）。`
      }
    } catch (e: unknown) {
      return { ok: false, content: formatFsError(e, filePath) }
    }
  }
}

// 缺哪个二进制就跳过哪个——模型 prompt 里看不到，避免调了报错
export function bootstrapFileTools(): void {
  registerTool(readFileDescriptor)
  registerTool(listDirDescriptor)
  registerTool(statFileDescriptor)
  registerTool(writeFileDescriptor)
  registerTool(editFileDescriptor)

  if (binExists('es.exe')) {
    registerTool(searchFileDescriptor)
  } else {
    console.warn('[fileTools] es.exe 不存在 → search_file 不注册')
  }
  if (binExists('rg.exe')) {
    registerTool(searchInFilesDescriptor)
  } else {
    console.warn('[fileTools] rg.exe 不存在 → search_in_files 不注册')
  }
}
