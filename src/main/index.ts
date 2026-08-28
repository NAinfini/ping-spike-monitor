import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import type {
  CollectorMessage,
  CollectorRequest,
  Incident,
  MonitorTarget,
  OverviewSnapshot,
  SeriesPoint,
  SeriesQuery
} from '../shared/types'

const IPC = {
  overview: 'monitor:overview',
  series: 'monitor:series',
  incidents: 'monitor:incidents',
  targets: 'monitor:targets',
  sampleEvent: 'monitor:sample-event',
  overviewEvent: 'monitor:overview-event',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowMaximizedEvent: 'window:maximized-event'
} as const

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let collector: UtilityProcess | null = null
let quitting = false
let suspended = false
let restartTimer: NodeJS.Timeout | null = null
let collectorStartedAt = 0
let restartDelayMs = 2_000
const pending = new Map<string, PendingRequest>()

function collectorDataDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA
  return localAppData ? join(localAppData, 'PingSpikeMonitor') : app.getPath('userData')
}

function createAppIcon(): Electron.NativeImage {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'app-logo.png')
    : join(__dirname, '../../resources/app-logo.png')
  const icon = nativeImage.createFromPath(path)
  if (icon.isEmpty()) throw new Error(`Application icon could not be loaded from ${path}`)
  return icon
}

function createTrayIcon(): Electron.NativeImage {
  return createAppIcon().resize({ width: 16, height: 16, quality: 'best' })
}

function developmentRendererUrl(): string | null {
  const candidate = process.env.ELECTRON_RENDERER_URL
  if (app.isPackaged || !candidate) return null

  const url = new URL(candidate)
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback) {
    throw new Error('ELECTRON_RENDERER_URL must point to a loopback development server')
  }
  return url.toString()
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    frame: false,
    icon: createAppIcon(),
    show: false,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('maximize', () => mainWindow?.webContents.send(IPC.windowMaximizedEvent, true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send(IPC.windowMaximizedEvent, false))
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const rendererUrl = developmentRendererUrl()
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('Ping Spike Monitor')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open monitor', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showWindow)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function handleCollectorMessage(message: CollectorMessage): void {
  if (message.type === 'response') {
    const request = pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timeout)
    pending.delete(message.requestId)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error ?? 'Collector request failed'))
    return
  }

  if (message.event === 'sample') broadcast(IPC.sampleEvent, message.payload)
  if (message.event === 'overview') broadcast(IPC.overviewEvent, message.payload)
}

function rejectPending(reason: string): void {
  for (const request of pending.values()) {
    clearTimeout(request.timeout)
    request.reject(new Error(reason))
  }
  pending.clear()
}

function scheduleCollectorRestart(): void {
  if (quitting || suspended || restartTimer) return
  const delay = restartDelayMs
  restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
  restartTimer = setTimeout(() => {
    restartTimer = null
    startCollector()
  }, delay)
}

function startCollector(): void {
  if (collector || quitting || suspended) return

  try {
    collector = utilityProcess.fork(join(__dirname, 'collector.js'), [], {
      serviceName: 'Ping Spike Collector',
      stdio: 'pipe',
      env: {
        ...process.env,
        PING_SPIKE_DATA_DIR: process.env.PING_SPIKE_DATA_DIR ?? collectorDataDirectory()
      }
    })
    collectorStartedAt = Date.now()
  } catch (error) {
    console.error('[collector] Failed to start', error)
    scheduleCollectorRestart()
    return
  }

  collector.on('message', (message: CollectorMessage) => handleCollectorMessage(message))
  collector.on('exit', (code) => {
    const uptimeMs = Date.now() - collectorStartedAt
    collector = null
    rejectPending(`Collector exited with code ${code}`)
    if (uptimeMs >= 60_000) restartDelayMs = 2_000
    if (!quitting && !suspended) {
      console.error(`[collector] Exited with code ${code}; restart scheduled`)
      scheduleCollectorRestart()
    }
  })
  collector.stderr?.on('data', (chunk) => console.error(`[collector] ${String(chunk).trimEnd()}`))
}

function isSeriesQuery(value: unknown): value is SeriesQuery {
  if (!value || typeof value !== 'object') return false
  const query = value as Partial<SeriesQuery>
  if (!Number.isFinite(query.from) || !Number.isFinite(query.to)) return false
  if ((query.from ?? 0) >= (query.to ?? 0)) return false
  if (!Array.isArray(query.targetIds) || query.targetIds.length > 64) return false
  if (!query.targetIds.every((targetId) => typeof targetId === 'string' && targetId.length <= 128)) {
    return false
  }
  return (
    query.maxPoints === undefined ||
    (Number.isInteger(query.maxPoints) && query.maxPoints >= 10 && query.maxPoints <= 5_000)
  )
}

function callCollector<T>(method: CollectorRequest['method'], args?: unknown): Promise<T> {
  if (!collector) return Promise.reject(new Error('Collector is not available'))

  return new Promise<T>((resolve, reject) => {
    const requestId = randomUUID()
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Collector request timed out: ${method}`))
    }, 10_000)
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout })
    collector?.postMessage({ type: 'request', requestId, method, args } satisfies CollectorRequest)
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.overview, () => callCollector<OverviewSnapshot>('overview'))
  ipcMain.handle(IPC.series, (_event, query: unknown) => {
    if (!isSeriesQuery(query)) throw new Error('Invalid series query')
    return callCollector<SeriesPoint[]>('series', query)
  })
  ipcMain.handle(IPC.incidents, () => callCollector<Incident[]>('incidents'))
  ipcMain.handle(IPC.targets, () => callCollector<MonitorTarget[]>('targets'))
  ipcMain.on(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on(IPC.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => {
    quitting = true
    if (restartTimer) clearTimeout(restartTimer)
    rejectPending('Application is shutting down')
    collector?.kill()
  })

  void app.whenReady().then(() => {
    registerIpc()
    powerMonitor.on('suspend', () => {
      suspended = true
      rejectPending('Collection paused while the computer is suspended')
      collector?.kill()
    })
    powerMonitor.on('resume', () => {
      suspended = false
      startCollector()
    })
    createWindow()
    createTray()
    startCollector()
  })
}
