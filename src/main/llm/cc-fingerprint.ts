import { createHash } from 'crypto'
import { getIdentity } from './identity'
import { CC_STANDARD_SYSTEM } from './cc-standard-system'

// 与 CC v2.1.112 / SDK 0.81.0 / Node 24.11.1 对齐；各字段互相绑定，改一处必全改
export const CC_VERSION = '2.1.112'
export const SDK_VERSION = '0.81.0'
export const NODE_VERSION = 'v24.11.1'
// haiku 不发 beta（不支持 interleaved thinking）；其余 7 项以抓包为准
export const CC_BETAS_FULL =
  'claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24'
export const CC_BETAS_HAIKU = ''
export const ANTHROPIC_VERSION = '2023-06-01'
// 真 CC 启动时设 env，请求时永远是 'cli'/'sdk-cli'，'unknown' 是死分支
export const CC_ENTRYPOINT = 'cli'
export const CC_USER_AGENT = `claude-cli/${CC_VERSION} (external, cli)`
export const CC_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING_SALT = '59cf53e54c78'
// 真 CC wire 上就发字面 "00000"，不是签名
const BILLING_CCH = '00000'

// 纯字符串匹配，对齐真 CC 内部判断
export function isHaikuModel(model: string): boolean {
  return model.toLowerCase().includes('haiku')
}

export function isOpusModel(model: string): boolean {
  return model.toLowerCase().includes('opus')
}

// effort 必须按实际 model 名而不是 tier：opus→xhigh / sonnet→high / haiku→不发
export function defaultCcEffort(model: string): 'xhigh' | 'high' | undefined {
  if (isHaikuModel(model)) return undefined
  if (isOpusModel(model)) return 'xhigh'
  return 'high'
}

// chars=text[4,7,20]（缺位用"0"）→ SHA-256(SALT+chars+VERSION) 前 3 hex
// 注意 seed 顺序 SALT+chars+VERSION，写反 hash 全错
function computeBillingHash(firstUserText: string): string {
  const pickAt = (i: number): string => (firstUserText.length > i ? firstUserText[i] : '0')
  const chars = pickAt(4) + pickAt(7) + pickAt(20)
  const seed = BILLING_SALT + chars + CC_VERSION
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 3)
}

// 作为 system[0] 文本塞进 body，不挂 HTTP header
function buildBillingHeader(firstUserText: string): string {
  const h = computeBillingHash(firstUserText)
  return `x-anthropic-billing-header: cc_version=${CC_VERSION}.${h}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${BILLING_CCH};`
}

// 按真 CC v2.1.112 实抓顺序排列；header 顺序也是指纹
// disableExperimentalBetas=CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 等价开关
export function buildCCHeaders(
  apiKey: string,
  model: string,
  disableExperimentalBetas?: boolean
): Record<string, string> {
  const { sessionId } = getIdentity()
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'x-stainless-lang': 'js',
    'x-stainless-package-version': SDK_VERSION,
    'x-stainless-os': 'Windows',
    'x-stainless-arch': 'x64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': NODE_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-app': 'cli',
    'user-agent': CC_USER_AGENT,
    'x-claude-code-session-id': sessionId,
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  }
  if (!isHaikuModel(model) && !disableExperimentalBetas) {
    headers['anthropic-beta'] = CC_BETAS_FULL
  }
  // 这三项放最末，对齐真 CC 顺序
  headers['accept-language'] = '*'
  headers['sec-fetch-mode'] = 'cors'
  headers['accept-encoding'] = 'gzip, deflate'
  return headers
}

interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

// 3 块固定顺序：billing header / CC 前缀 / 标准模板+用户 prompt。
// system[2] 必须以 CC 标准模板起头（网关用 Sørensen-Dice ≥0.5 校验），
// 用户人设拼在后面靠 LLM 后置覆盖改写身份。两块都挂 cache_control。
export function buildCCSystem(firstUserText: string, userSystem?: string): SystemBlock[] {
  const sys2Text =
    userSystem && userSystem.trim()
      ? `${CC_STANDARD_SYSTEM}\n\n${userSystem}`
      : CC_STANDARD_SYSTEM
  return [
    { type: 'text', text: buildBillingHeader(firstUserText) },
    { type: 'text', text: CC_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: sys2Text, cache_control: { type: 'ephemeral' } }
  ]
}

// CC 2.1.78+ JSON 格式：device_id=64-hex / account_uuid=空 / session_id=UUID。
// 三个字段形状一个都不能错，网关会拒。
export function buildCCMetadata(): { user_id: string } {
  const { deviceId, sessionId } = getIdentity()
  return {
    user_id: JSON.stringify({
      device_id: deviceId,
      account_uuid: '',
      session_id: sessionId
    })
  }
}

// CC 专属 beta 字段
export function ccMessagesURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return `${trimmed}/v1/messages?beta=true`
}

export function responsesURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return `${trimmed}/v1/responses`
}
