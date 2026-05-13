import Store from 'electron-store'
import { randomBytes, randomUUID } from 'crypto'

interface IdentityRecord {
  deviceId: string
  accountUuid: string
  sessionId: string
}

const store = new Store<IdentityRecord>({ name: 'hiliu-cc-identity' })

// deviceId=64-hex（UUID 被网关正则识破）；accountUuid 必须恒空；sessionId=UUID 跨重启复用
const HEX64 = /^[a-f0-9]{64}$/

export function getIdentity(): IdentityRecord {
  let deviceId = store.get('deviceId')
  let sessionId = store.get('sessionId')

  // 老 UUID-format deviceId 一次性迁成 64-hex
  if (!deviceId || !HEX64.test(deviceId)) {
    deviceId = randomBytes(32).toString('hex')
    store.set('deviceId', deviceId)
  }
  if (!sessionId) {
    sessionId = randomUUID()
    store.set('sessionId', sessionId)
  }
  // accountUuid 必须空，清掉老残留值
  if (store.get('accountUuid')) {
    store.set('accountUuid', '')
  }
  return { deviceId, accountUuid: '', sessionId }
}
