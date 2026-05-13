#!/usr/bin/env node
/**
 * CC 流量代理抓包工具
 * ===================
 * 监听 127.0.0.1:<port>，把进来的 HTTP 请求**逐字节透传**给上游，同时把请求/响应都
 * 写到 dump 目录，用于跟 Hiliu 的 last-request.json 做字段级对比，定位伪装漏洞。
 *
 * 用法：
 *   node scripts/cc-proxy.mjs --upstream https://codeapi.xxand.cc
 *   node scripts/cc-proxy.mjs --upstream https://api.anthropic.com --port 8787 --dump-dir ./dump
 *
 * 配置真实 CC 走代理：
 *   set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 *   set ANTHROPIC_API_KEY=<上游真实 key>
 *   claude
 *
 * 每次请求生成一对 dump：
 *   <dump>/req-<ts>.json    入站请求快照（method/url/headers/body，Authorization 已脱敏）
 *   <dump>/resp-<ts>.json   出站响应快照（status/headers/body 或 sse 行数组）
 *
 * 设计要点：
 *   - 零依赖，仅用 node:http / node:https / node:zlib / node:fs
 *   - 流式转发：upRes 的 chunk 同步 write 给 client + push 进 buffer，不缓冲后再发
 *   - SSE：按 \n 拆行写入 sse 字段，便于 diff 单事件
 *   - gzip/br/deflate 响应解码后再写 dump，转发给 client 仍是原始压缩字节
 */
import http from 'node:http'
import https from 'node:https'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { URL } from 'node:url'
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib'

function parseArgs() {
  const args = process.argv.slice(2)
  let upstream = null
  let port = 8787
  let dumpDir = './dump'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--upstream') upstream = args[++i]
    else if (a === '--port') port = Number(args[++i])
    else if (a === '--dump-dir') dumpDir = args[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      printHelp()
      process.exit(1)
    }
  }
  if (!upstream) {
    console.error('错误：必须提供 --upstream <URL>')
    printHelp()
    process.exit(1)
  }
  return { upstream, port, dumpDir }
}

function printHelp() {
  console.log(`CC 流量代理抓包工具

用法：
  node scripts/cc-proxy.mjs --upstream <URL> [--port 8787] [--dump-dir ./dump]

参数：
  --upstream <URL>    必填。要转发的真实上游 URL（如 https://codeapi.xxand.cc）
  --port <num>        可选。本地监听端口，默认 8787
  --dump-dir <path>   可选。dump 文件输出目录，默认 ./dump

配置真实 CC：
  set ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  set ANTHROPIC_API_KEY=<上游真实 key>`)
}

const { upstream, port, dumpDir } = parseArgs()
const upstreamURL = new URL(upstream)
const dumpAbs = resolve(dumpDir)
mkdirSync(dumpAbs, { recursive: true })

function tsForFilename() {
  // 文件名安全的 ISO 时间戳：冒号/句点 → 短横线
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function redactAuth(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      const s = String(v)
      out[k] = s.length > 18 ? `${s.slice(0, 14)}***${s.slice(-4)}` : '***'
    } else {
      out[k] = v
    }
  }
  return out
}

function tryDecodeBody(buf, contentEncoding) {
  if (!buf || buf.length === 0) return ''
  let raw = buf
  try {
    const enc = String(contentEncoding || '').toLowerCase()
    if (enc.includes('gzip')) raw = gunzipSync(buf)
    else if (enc.includes('br')) raw = brotliDecompressSync(buf)
    else if (enc.includes('deflate')) raw = inflateSync(buf)
  } catch (e) {
    return { _decode_error: e.message, base64: buf.toString('base64') }
  }
  const text = raw.toString('utf8')
  // 试 JSON 解析；失败就当文本
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const server = http.createServer((clientReq, clientRes) => {
  const ts = tsForFilename()
  const reqChunks = []

  clientReq.on('data', (c) => reqChunks.push(c))
  clientReq.on('error', (e) => console.error(`[${ts}] 客户端读错`, e.message))
  clientReq.on('end', () => {
    const reqBody = Buffer.concat(reqChunks)

    // === 写请求 dump ===
    const reqDump = {
      timestamp: new Date().toISOString(),
      method: clientReq.method,
      url: clientReq.url,
      httpVersion: clientReq.httpVersion,
      headers: redactAuth(clientReq.headers),
      body: tryDecodeBody(reqBody, clientReq.headers['content-encoding'])
    }
    try {
      writeFileSync(join(dumpAbs, `req-${ts}.json`), JSON.stringify(reqDump, null, 2), 'utf8')
    } catch (e) {
      console.error(`[${ts}] 写 req dump 失败`, e.message)
    }

    // === 转发到上游 ===
    const fwdHeaders = { ...clientReq.headers }
    fwdHeaders['host'] = upstreamURL.host
    // transfer-encoding: chunked 与我们已知 content-length 互斥；删掉让 Node 用 content-length
    delete fwdHeaders['transfer-encoding']
    if (reqBody.length > 0) fwdHeaders['content-length'] = String(reqBody.length)

    const upOptions = {
      hostname: upstreamURL.hostname,
      port: upstreamURL.port || (upstreamURL.protocol === 'https:' ? 443 : 80),
      path: clientReq.url,
      method: clientReq.method,
      headers: fwdHeaders
    }
    const transport = upstreamURL.protocol === 'https:' ? https : http

    const upReq = transport.request(upOptions, (upRes) => {
      // 立刻把上游响应头透传给 client，让流式响应不被缓冲卡住
      clientRes.writeHead(upRes.statusCode || 502, upRes.headers)

      const respChunks = []
      const isEventStream = String(upRes.headers['content-type'] || '').includes(
        'text/event-stream'
      )

      upRes.on('data', (chunk) => {
        respChunks.push(chunk)
        clientRes.write(chunk)
      })
      upRes.on('end', () => {
        clientRes.end()
        const buf = Buffer.concat(respChunks)

        let bodyField
        if (isEventStream) {
          // SSE 直接当文本拆行（事件流不会用 gzip）
          bodyField = { sse: buf.toString('utf8').split(/\r?\n/) }
        } else {
          bodyField = tryDecodeBody(buf, upRes.headers['content-encoding'])
        }

        const respDump = {
          timestamp: new Date().toISOString(),
          status: upRes.statusCode,
          statusMessage: upRes.statusMessage,
          httpVersion: upRes.httpVersion,
          headers: upRes.headers,
          body: bodyField
        }
        try {
          writeFileSync(
            join(dumpAbs, `resp-${ts}.json`),
            JSON.stringify(respDump, null, 2),
            'utf8'
          )
        } catch (e) {
          console.error(`[${ts}] 写 resp dump 失败`, e.message)
        }

        const ua = clientReq.headers['user-agent'] || '-'
        console.log(
          `[${ts}] ${clientReq.method} ${clientReq.url} → ${upRes.statusCode} (UA=${ua}, ${reqBody.length}B/${buf.length}B)`
        )
      })
      upRes.on('error', (e) => {
        console.error(`[${ts}] 上游响应错`, e.message)
        try {
          clientRes.end()
        } catch {}
      })
    })

    upReq.on('error', (e) => {
      console.error(`[${ts}] 上游请求错`, e.message)
      try {
        clientRes.writeHead(502, { 'content-type': 'application/json' })
        clientRes.end(
          JSON.stringify({
            error: { type: 'proxy_upstream_error', message: e.message }
          })
        )
      } catch {}
    })

    if (reqBody.length > 0) upReq.write(reqBody)
    upReq.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`CC 流量代理已启动`)
  console.log(`  监听：http://127.0.0.1:${port}`)
  console.log(`  上游：${upstream}`)
  console.log(`  Dump：${dumpAbs}`)
  console.log('')
  console.log(`配置真实 CC：`)
  console.log(`  set ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  console.log(`  set ANTHROPIC_API_KEY=<上游真实 key>`)
  console.log('')
  console.log('等待请求……')
})

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，关闭代理。')
  server.close(() => process.exit(0))
})
