/// <reference types="vite/client" />

import type { MonitorApi, WindowControlsApi } from '@shared/types'

declare global {
  interface Window {
    monitor: MonitorApi
    windowControls: WindowControlsApi
  }
}

export {}
