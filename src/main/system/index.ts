import { bootstrapFileTools } from './fileTools'
import { bootstrapSystemTools } from './systemTools'
import { bootstrapUserActivityTools } from './userActivityTools'
import { bootstrapShellTools } from './shellTools'
import { bootstrapNotifyTools } from './notifyTools'
import { bootstrapClipboardTools } from './clipboardTools'
import { startEverythingService, stopEverythingService } from './everythingService'
import { bootstrapUiaTools } from '../uia/uiaTools'
import { bootstrapInputTools } from '../uia/inputTools'
import { bootstrapOcrTools } from '../uia/ocrTools'
import { bootstrapAppLauncherTools } from '../uia/appLauncherTools'
import { bootstrapWindowMgmtTools } from '../uia/windowMgmtTools'
import { bootstrapAudioWifiTools } from './audioWifiTools'
import { initUiaService, shutdownUiaService } from '../uia/uiaService'

export function bootstrapSystemControlTools(): void {
  bootstrapFileTools()
  bootstrapSystemTools()
  bootstrapUserActivityTools()
  bootstrapShellTools()
  bootstrapNotifyTools()
  bootstrapClipboardTools()
  bootstrapUiaTools()
  bootstrapInputTools()
  bootstrapOcrTools()
  bootstrapAppLauncherTools()
  bootstrapWindowMgmtTools()
  bootstrapAudioWifiTools()
  initUiaService()
}

export { startEverythingService, stopEverythingService, shutdownUiaService }
