// screen_ocr 只接文件路径不接 base64——base64 一张 720p 图 ~600KB，走 stdin 单行 JSON-RPC 撑爆缓冲
// OCR_TIMEOUT 15s（不是默认 8s）：中文长文本最坏 ~10s；1080p 典型 1-3s

import type { ToolDescriptor } from '../llm/registry'
import { registerTool } from '../llm/registry'
import { binExists } from '../system/binPath'
import { uiaCall } from './uiaService'

const OCR_TIMEOUT = 15000

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  return String(v)
}

const screenOcrFragment = [
  'screen_ocr(path: string, lang?: string, hwnd?: number)',
  '   对一张本地图片做 OCR 识字。path 必须是绝对路径，PNG / JPEG / BMP 都吃。',
  '   lang 可选——不传走系统首选语言（auto，多数情况是 zh-CN 或 en-US）；',
  '   显式传如 "en-US" / "zh-CN" / "ja-JP" 等 BCP-47 代码可强制单语识别。',
  '   hwnd 可选但**强烈推荐**——见下面「点击链路」。',
  '   返回：识别到的全文 + 逐行 bounding box + coordSystem 字段标明坐标系。',
  '',
  '   关键链路：OCR → 点击 三步法',
  '     1) window_capture(hwnd=X, scope="full-window") → 拿到 path',
  '     2) screen_ocr(path, hwnd=X) → bbox 自动是「屏幕坐标」（coordSystem="screen"）',
  '     3) screen_click(line.x + line.w/2, line.y + line.h/2) → 直接点',
  '   不传 hwnd 时 bbox 是「图像坐标」（coordSystem="image"），点击前要自己加窗口位移——',
  '   能传 hwnd 就传，省去坐标换算的脑力开销和出错概率。',
  '   注意：scope="client" 截图时不要传 hwnd——anchor 按 GetWindowRect 算会差一个边框偏移；',
  '   只有 scope="full-window" 截图配合 hwnd 才严格对齐。',
  '',
  '   场景：',
  '     - 截屏后想知道画面里有哪些字（先 window_capture → screen_ocr）',
  '     - 想点屏幕上某段文字但 UIA ui_snapshot 抓不到那个控件（典型 DirectUI）',
  '     - 用户给截图让你读上面写啥',
  '   注意：',
  '     - OCR 不是万能——艺术字、低对比度、超小字号、手写体经常识别不出',
  '     - 中文识别要求系统装了 zh-CN 语言包（设置→时间和语言→语言）',
  '     - 1080p 截图典型 1-3s；超大图可能慢，所以 timeout 15s。'
].join('\n')

interface OcrLine {
  text: string
  x?: number
  y?: number
  w?: number
  h?: number
}

const screenOcrDescriptor: ToolDescriptor = {
  id: 'builtin:screen_ocr',
  name: 'screen_ocr',
  source: 'builtin',
  displayName: 'screen_ocr',
  description: '对一张本地图片做 OCR 识字（Windows 内置引擎）。',
  promptFragment: { appLayer: screenOcrFragment, native: screenOcrFragment },
  nativeDef: {
    name: 'screen_ocr',
    description:
      '对本地图片做 OCR 识字（Windows.Media.Ocr WinRT 引擎）。返回全文 + 逐行 bounding box。传 hwnd 后 bbox 自动转为屏幕坐标，可直接喂 screen_click。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PNG / JPEG / BMP 文件的绝对路径' },
        lang: {
          type: 'string',
          description: 'BCP-47 语言代码如 "zh-CN" / "en-US"。缺省=系统首选语言（auto）'
        },
        hwnd: {
          type: 'number',
          description:
            '截图来源窗口句柄（仅 window_capture scope=full-window 时传）。daemon 会自动把 bbox 加上窗口屏幕位置返回屏幕坐标，方便直接 screen_click。client 区截图请勿传——anchor 会差一个边框偏移。'
        }
      },
      required: ['path']
    }
  },
  extractTarget: (args) => {
    const lang = asString(args.lang).trim()
    const hwnd = typeof args.hwnd === 'number' ? args.hwnd : Number(args.hwnd)
    const tail = [
      lang ? `lang=${lang}` : '',
      Number.isFinite(hwnd) && hwnd > 0 ? `hwnd=0x${hwnd.toString(16)}` : ''
    ].filter(Boolean).join(', ')
    return `OCR 识字：${asString(args.path)}${tail ? ` (${tail})` : ''}`
  },
  executor: async (args) => {
    const path = asString(args.path).trim()
    if (!path) return { ok: false, content: '（系统）screen_ocr 缺 path 参数。' }
    const params: Record<string, unknown> = { path }
    const lang = asString(args.lang).trim()
    if (lang) params.lang = lang
    const hwndNum = typeof args.hwnd === 'number' ? args.hwnd : Number(args.hwnd)
    if (Number.isFinite(hwndNum) && hwndNum > 0) params.hwnd = Math.trunc(hwndNum)
    try {
      const r = (await uiaCall('screen_ocr', params, OCR_TIMEOUT)) as Record<string, unknown>
      const text = asString(r.text).trim()
      const lineCount = typeof r.lineCount === 'number' ? r.lineCount : 0
      const usedLang = asString(r.lang) || 'auto'
      const coordSystem = asString(r.coordSystem) || 'image'
      if (!text) {
        return {
          ok: true,
          content: `OCR 完成但未识别出任何文字（lang=${usedLang}）。可能是图里没字、字号太小、对比度太低，或者系统没装对应语言包。`
        }
      }
      // 行级 box——coordSystem='screen' 时直接喂 screen_click，省去模型坐标换算的脑力开销
      const lines = (Array.isArray(r.lines) ? r.lines : []) as OcrLine[]
      const hasBoxes = lines.some((l) => typeof l.x === 'number')
      let boxesNote = ''
      if (hasBoxes) {
        if (coordSystem === 'screen') {
          boxesNote = `\n（每行附带屏幕坐标 [x,y,w,h]，共 ${lineCount} 行；要点击其中某段文字直接 screen_click(x+w/2, y+h/2)）`
        } else {
          boxesNote = `\n（每行附带图片坐标 [x,y,w,h]，共 ${lineCount} 行；要点击需先用 list_windows 拿窗口位置加上偏移——下次调 screen_ocr 时传 hwnd 参数让 daemon 自动换算更省事）`
        }
      }
      return {
        ok: true,
        content: `识别到 ${lineCount} 行文字（lang=${usedLang}, coords=${coordSystem}）：\n${text}${boxesNote}`
      }
    } catch (e) {
      return { ok: false, content: `（系统）screen_ocr 失败：${(e as Error).message}` }
    }
  }
}

export function bootstrapOcrTools(): void {
  if (!binExists('uia-daemon.ps1')) {
    console.warn('[ocrTools] uia-daemon.ps1 不存在 → screen_ocr 不注册')
    return
  }
  registerTool(screenOcrDescriptor)
}
