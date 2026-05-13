#!/usr/bin/env node
/**
 * 真 CC 流量重放工具
 * ===================
 * 读取 cc-proxy.mjs 抓的 req-*.json，把同一份请求**字节级重放**到上游，
 * 用于差分定位检测点。
 *
 * 使用流程：
 *   1) 用真 CC 客户端走 cc-proxy 发一次成功请求，得到 dump/req-<ts>.json
 *   2) 第一步 baseline 验证：原样重放，预期 200
 *      node scripts/cc-replay.mjs --dump dump/req-<ts>.json --upstream https://codeapi.xxand.cc --api-key sk-xxx
 *   3) 若 baseline 200：开始逐字段 mutate，向 Hiliu 输出靠拢，找到从 200 翻 403 的字段
 *      node scripts/cc-replay.mjs ... --set body.max_tokens=1024
 *      node scripts/cc-replay.mjs ... --unset body.thinking
 *   4) 若 baseline 也 403：网关有 stateful 检测（nonce/签名/IP 限速等），换思路
 *
 * 关键点：
 *   - dump 里的 Authorization 已脱敏，必须用 --api-key 或 ANTHROPIC_API_KEY 注入
 *   - host header 必须改成上游域名（dump 里是代理本机的）
 *   - content-length 重新计算（替换 key 后长度变了）
 *   - body 重新 JSON.stringify（V8 按对象键插入顺序输出，保留 dump 里的字段顺序）
 *
 * mutation 语法：
 *   --set <path>=<json>     设置字段，value 必须是合法 JSON（字符串要带引号）
 *                           例：--set body.max_tokens=1024
 *                                --set 'body.metadata.user_id="bare-string"'
 *                                --set 'body.system[2].text="hello"'
 *   --unset <path>          删除字段
 *                           例：--unset body.thinking
 *                                --unset headers.anthropic-beta
 *   path 用 dot 分段，数组用 [n] 表示。前缀 body./headers. 区分作用域。
 */
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { URL } from 'node:url'

function parseArgs() {
  const args = process.argv.slice(2)
  let dump = null
  let upstream = null
  let apiKey = process.env.ANTHROPIC_API_KEY || null
  const overrides = []
  const unsets = []
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dump') dump = args[++i]
    else if (a === '--upstream') upstream = args[++i]
    else if (a === '--api-key') apiKey = args[++i]
    else if (a === '--set') {
      const raw = args[++i]
      const eqIdx = raw.indexOf('=')
      if (eqIdx < 0) {
        console.error(`--set 缺少 =：${raw}`)
        process.exit(1)
      }
      const path = raw.slice(0, eqIdx)
      const valueRaw = raw.slice(eqIdx + 1)
      let value
      try {
        value = JSON.parse(valueRaw)
      } catch (e) {
        console.error(`--set 值不是合法 JSON：${valueRaw}（${e.message}）`)
        console.error(`字符串记得带引号，例如：--set 'body.foo="bar"'`)
        process.exit(1)
      }
      overrides.push({ path, value })
    } else if (a === '--unset') unsets.push(args[++i])
    else if (a === '--dry-run') dryRun = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`未知参数：${a}`)
      printHelp()
      process.exit(1)
    }
  }
  if (!dump || !upstream || !apiKey) {
    console.error('错误：--dump、--upstream、--api-key 都必填（或 env ANTHROPIC_API_KEY）')
    printHelp()
    process.exit(1)
  }
  return { dump, upstream, apiKey, overrides, unsets, dryRun }
}

function printHelp() {
  console.log(`真 CC 流量重放工具

用法：
  node scripts/cc-replay.mjs --dump <req-*.json> --upstream <baseURL> --api-key <key>
                             [--set path=<json>]... [--unset path]... [--dry-run]

参数：
  --dump <path>      cc-proxy 抓的 req-<ts>.json 文件
  --upstream <URL>   真实上游（如 https://codeapi.xxand.cc）。dump 里 url 是 path，需要拼 baseURL
  --api-key <key>    真实上游的 API key（dump 里 Authorization 已脱敏）
  --set path=<json>  替换字段，value 必须是合法 JSON
  --unset path       删除字段
  --dry-run          只打印将要发送的 headers/body，不真发`)
}

/** 把 dotted-path（含 [n]）解析成 segments 数组 */
function parsePath(path) {
  const segs = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') {
      i++
      continue
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i)
      segs.push(Number(path.slice(i + 1, end)))
      i = end + 1
    } else {
      let j = i
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
      segs.push(path.slice(i, j))
      i = j
    }
  }
  return segs
}

function setByPath(root, path, value) {
  const segs = parsePath(path)
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) {
      console.error(`setByPath: 路径中断于 ${segs.slice(0, i + 1).join('.')}`)
      process.exit(1)
    }
    cur = cur[segs[i]]
  }
  cur[segs[segs.length - 1]] = value
}

function unsetByPath(root, path) {
  const segs = parsePath(path)
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) return
    cur = cur[segs[i]]
  }
  const last = segs[segs.length - 1]
  if (typeof last === 'number') cur.splice(last, 1)
  else delete cur[last]
}

const { dump, upstream, apiKey, overrides, unsets, dryRun } = parseArgs()
const data = JSON.parse(readFileSync(dump, 'utf8'))
const upstreamURL = new URL(upstream)

// === 准备 headers ===
const headers = { ...data.headers }
headers.authorization = `Bearer ${apiKey}`
headers.host = upstreamURL.host
delete headers['transfer-encoding']
delete headers['content-length']
delete headers['accept-encoding']  // 避免上游回 gzip/br，重放调试看不清

// === 准备 body ===
const body = typeof data.body === 'string' ? data.body : JSON.parse(JSON.stringify(data.body))

// === 应用 mutation ===
for (const o of overrides) {
  if (o.path.startsWith('body.')) {
    setByPath(body, o.path.slice(5), o.value)
    console.log(`[mutate] set body.${o.path.slice(5)} = ${JSON.stringify(o.value).slice(0, 80)}`)
  } else if (o.path.startsWith('headers.')) {
    headers[o.path.slice(8).toLowerCase()] = o.value
    console.log(`[mutate] set header ${o.path.slice(8)} = ${o.value}`)
  } else {
    console.error(`--set path 必须以 body. 或 headers. 开头：${o.path}`)
    process.exit(1)
  }
}
for (const p of unsets) {
  if (p.startsWith('body.')) {
    unsetByPath(body, p.slice(5))
    console.log(`[mutate] unset body.${p.slice(5)}`)
  } else if (p.startsWith('headers.')) {
    delete headers[p.slice(8).toLowerCase()]
    console.log(`[mutate] unset header ${p.slice(8)}`)
  } else {
    console.error(`--unset path 必须以 body. 或 headers. 开头：${p}`)
    process.exit(1)
  }
}

// === 序列化 body ===
const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
headers['content-length'] = Buffer.byteLength(bodyText, 'utf8').toString()

if (dryRun) {
  console.log('\n=== DRY RUN ===')
  console.log(`URL: ${upstream.replace(/\/+$/, '')}${data.url}`)
  console.log(`method: ${data.method}`)
  console.log(`headers (${Object.keys(headers).length} 项):`)
  for (const [k, v] of Object.entries(headers)) {
    const vs = String(v)
    console.log(`  ${k}: ${k === 'authorization' ? vs.slice(0, 14) + '***' : vs.slice(0, 200)}`)
  }
  console.log(`body (${bodyText.length} 字节):`)
  console.log(bodyText.slice(0, 1200))
  if (bodyText.length > 1200) console.log(`...（剩余 ${bodyText.length - 1200} 字节省略）`)
  process.exit(0)
}

// === 发送 ===
const transport = upstreamURL.protocol === 'https:' ? httpsRequest : httpRequest
const fullPath = data.url

console.log(`\n→ ${data.method} ${upstream.replace(/\/+$/, '')}${fullPath}`)
console.log(`  body: ${bodyText.length} 字节  headers: ${Object.keys(headers).length} 项`)

const req = transport(
  {
    hostname: upstreamURL.hostname,
    port: upstreamURL.port || (upstreamURL.protocol === 'https:' ? 443 : 80),
    path: fullPath,
    method: data.method,
    headers
  },
  (res) => {
    console.log(`\n← ${res.statusCode} ${res.statusMessage || ''}`)
    console.log(
      `  content-type: ${res.headers['content-type'] || '-'}  content-length: ${
        res.headers['content-length'] || '-'
      }`
    )
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const isSSE = String(res.headers['content-type'] || '').includes('text/event-stream')
      if (isSSE) {
        const lines = text.split(/\r?\n/).filter(Boolean)
        console.log(`\n--- SSE (${lines.length} 行，前 6 行)---`)
        console.log(lines.slice(0, 6).join('\n'))
        if (lines.length > 6) console.log(`...（剩余 ${lines.length - 6} 行省略）`)
      } else {
        console.log(`\n--- response body (${text.length} 字节)---`)
        console.log(text.slice(0, 2000))
        if (text.length > 2000) console.log(`...（剩余 ${text.length - 2000} 字节省略）`)
      }
    })
  }
)
req.on('error', (e) => {
  console.error(`请求错：${e.message}`)
  process.exit(1)
})
req.write(bodyText)
req.end()
