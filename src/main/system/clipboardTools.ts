// clipboard_write_image 接文件路径不接 base64——避免大 payload 走 JSON 上下文
// （base64 一张 720p ~600KB 撑爆模型上下文；模型先 window_capture 落盘再用此工具转手）

import fs from 'node:fs'
import { clipboard, nativeImage } from 'electron'
import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'

const MAX_TEXT_RETURN = 100 * 1024 // 100KB
const MAX_TEXT_WRITE = 1024 * 1024 // 1MB

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

const readFragment = [
  'clipboard_read()',
  '   读当前系统剪贴板内容。无参数。',
  '   返回值自动判断：',
  '     - 有文本 → 返回文本（超过 100KB 截断）',
  '     - 无文本但有图 → 返回 PNG image content block，多模态模型直接看',
  '     - 都没有 → 提示空',
  '   场景：用户复制了一段文字 / 截图后让你解读、翻译、总结、查错。'
].join('\n')

const clipboardReadDescriptor: ToolDescriptor = {
  id: 'builtin:clipboard_read',
  name: 'clipboard_read',
  source: 'builtin',
  displayName: 'clipboard_read',
  description: '读系统剪贴板。文本优先，文本空时返回图（PNG image block）。',
  promptFragment: { appLayer: readFragment, native: readFragment },
  nativeDef: {
    name: 'clipboard_read',
    description:
      '读当前系统剪贴板内容。优先返回文本（超 100KB 截断）；文本为空时返回图（PNG）。无参数。',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  extractTarget: () => '读取系统剪贴板',
  executor: async () => {
    const text = clipboard.readText()
    if (text && text.length > 0) {
      const truncated = text.length > MAX_TEXT_RETURN
      const out = truncated ? text.slice(0, MAX_TEXT_RETURN) : text
      return {
        ok: true,
        content: `剪贴板文本（${text.length} 字${truncated ? '，已截断到 ' + MAX_TEXT_RETURN : ''}）：\n${out}`
      }
    }
    // 文本空 → 看图
    const img = clipboard.readImage()
    if (img && !img.isEmpty()) {
      const buf = img.toPNG()
      const size = img.getSize()
      return {
        ok: true,
        content: `剪贴板图（${size.width}×${size.height}, ${(buf.length / 1024).toFixed(1)}KB PNG）`,
        parts: [
          {
            type: 'image',
            mediaType: 'image/png',
            base64: buf.toString('base64')
          }
        ]
      }
    }
    return { ok: true, content: '剪贴板为空（既无文本也无图）。' }
  }
}

const writeTextFragment = [
  'clipboard_write_text(text: string)',
  '   把 text 写入系统剪贴板。覆盖原内容。',
  '   场景：生成一段代码 / 文案 / 邮件正文给用户，让用户切到目标软件粘贴使用。',
  '   text 上限 1MB（更大没人需要）。'
].join('\n')

const clipboardWriteTextDescriptor: ToolDescriptor = {
  id: 'builtin:clipboard_write_text',
  name: 'clipboard_write_text',
  source: 'builtin',
  displayName: 'clipboard_write_text',
  description: '把文本写入系统剪贴板（覆盖原内容）。',
  promptFragment: { appLayer: writeTextFragment, native: writeTextFragment },
  nativeDef: {
    name: 'clipboard_write_text',
    description: '把文本写入系统剪贴板，覆盖原内容。text 上限 1MB。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的文本' }
      },
      required: ['text']
    }
  },
  extractTarget: (args) => {
    const t = asString(args.text)
    return `写剪贴板（${t.length} 字）：${t.slice(0, 30)}${t.length > 30 ? '…' : ''}`
  },
  executor: async (args) => {
    const text = asString(args.text)
    if (text.length > MAX_TEXT_WRITE) {
      return {
        ok: false,
        content: `（系统）clipboard_write_text 文本过长（${text.length} 字），上限 ${MAX_TEXT_WRITE}。`
      }
    }
    try {
      clipboard.writeText(text)
      return { ok: true, content: `已写入剪贴板（${text.length} 字）。` }
    } catch (e) {
      return { ok: false, content: `（系统）写剪贴板失败：${(e as Error).message}` }
    }
  }
}

const writeImageFragment = [
  'clipboard_write_image(path: string)',
  '   从本地 PNG/JPEG 文件读图写入剪贴板。path 必须是绝对路径。',
  '   场景：window_capture 拿到的 PNG 想交给用户去其他软件粘贴；',
  '   或读取已有截图、二维码、表情包文件后让用户粘贴。',
  '   不接 base64——避免大 payload 走 JSON 上下文。模型自己截图后用此工具转手。'
].join('\n')

const clipboardWriteImageDescriptor: ToolDescriptor = {
  id: 'builtin:clipboard_write_image',
  name: 'clipboard_write_image',
  source: 'builtin',
  displayName: 'clipboard_write_image',
  description: '从本地 PNG/JPEG 文件路径读图写入剪贴板（绝对路径）。',
  promptFragment: { appLayer: writeImageFragment, native: writeImageFragment },
  nativeDef: {
    name: 'clipboard_write_image',
    description:
      '从本地 PNG/JPEG 文件读图并写入剪贴板，覆盖原内容。path 必须是绝对路径。不支持 base64 直传，避免大 payload。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PNG / JPEG 文件的绝对路径' }
      },
      required: ['path']
    }
  },
  extractTarget: (args) => `写剪贴板（图）：${asString(args.path)}`,
  executor: async (args) => {
    const p = asString(args.path).trim()
    if (!p) return { ok: false, content: '（系统）clipboard_write_image 缺少 path 参数。' }
    if (!fs.existsSync(p)) {
      return { ok: false, content: `（系统）路径不存在：${p}` }
    }
    try {
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) {
        return { ok: false, content: `（系统）读图失败（不是有效的 PNG/JPEG）：${p}` }
      }
      clipboard.writeImage(img)
      const size = img.getSize()
      return { ok: true, content: `已把图写入剪贴板（${size.width}×${size.height}）。` }
    } catch (e) {
      return { ok: false, content: `（系统）写图到剪贴板失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapClipboardTools(): void {
  registerTool(clipboardReadDescriptor)
  registerTool(clipboardWriteTextDescriptor)
  registerTool(clipboardWriteImageDescriptor)
}
