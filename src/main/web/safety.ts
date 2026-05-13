// URL 安全校验——所有联网工具调外部 URL 前都过这里。
//
// 防 SSRF（模型被 prompt injection 后敲内网），不做业务级白名单。
// 拦截：非 http/https、回环地址、私有 IPv4、含 userinfo、URL > 2000 字符

/** SSRF 校验失败时抛 SafetyError */
export class SafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafetyError'
  }
}

const MAX_URL_LENGTH = 2000

function isPrivateIPv4(host: string): boolean {
  // 字符串匹配私网段——hostname 注入比数字 IP 更常见，精确 IPv4 解析收益有限
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [, a, b] = m.map(Number)
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 回环
  if (a === 0) return true // 0.0.0.0/8
  if (a === 169 && b === 254) return true // 链路本地（含 AWS metadata）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  return false
}

/** 解析+校验外部 URL，返回安全的 URL 对象。失败抛 SafetyError */
export function validateExternalURL(input: string): URL {
  if (!input || typeof input !== 'string') {
    throw new SafetyError('URL 为空')
  }
  if (input.length > MAX_URL_LENGTH) {
    throw new SafetyError(`URL 过长（>${MAX_URL_LENGTH}）`)
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafetyError('URL 格式不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafetyError(`只允许 http/https，拒绝 ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new SafetyError('URL 不能含用户名/密码')
  }
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]'
  ) {
    throw new SafetyError(`拒绝访问回环地址 ${host}`)
  }
  if (isPrivateIPv4(host)) {
    throw new SafetyError(`拒绝访问内网地址 ${host}`)
  }
  return url
}
